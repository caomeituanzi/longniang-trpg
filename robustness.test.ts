import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AiClient } from '../server/ai/client';
import { FakeProvider, reply, say, useTools, type FakeGuard } from '../server/ai/fake';
import { AiError, type MessagesRequest, type MessagesResponse, type TextBlock, type ToolResultBlock } from '../server/ai/types';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { setSetting } from '../server/settings';
import { sleep, startTestApp } from './helpers';

// 容易出错的边角：一轮结算到一半关掉 AI、额度用完、撤回时编号被重用、房主自己也在玩时的隐私、
// 被拒绝和封号的分寸、重新结算和重试的额度、估时不重复做。

const [ADMIN, T1, T2, T3] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 25, 3, 0, 0);
/** 估时里写了 [慢估时] 的，要等这个闸门打开才回复。 */
let estimateGate: Promise<void> | null = null;

function userText(req: MessagesRequest): string {
  const c = req.messages[0].content as string | TextBlock[];
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function actionOf(context: string) {
  const block = context.slice(context.indexOf('# 这次要结算的行动'));
  const quotes = [...block.matchAll(/「([^」]*)」/g)];
  return { actorId: Number(block.match(/编号 (\d+)/)?.[1]), text: quotes[quotes.length - 1]?.[1] ?? '' };
}

const refusal = (category: string | null = 'general_harms'): MessagesResponse => ({
  ...reply([], 'refusal'),
  stop_details: { type: 'refusal', category, explanation: null },
});

let t: Awaited<ReturnType<typeof startTestApp>>;

/**
 * 假主持人：[分钟 N] 估时；[移动 地点] [线索 key] [结局 key] 调用工具；[关AI] 结算时管理员按下紧急开关；
 * [会出错] 结算出错；[问答被拒] 出现在场外问答的材料里时，问答被安全机制拒绝。
 */
async function dm(req: MessagesRequest): Promise<MessagesResponse> {
  const context = userText(req);
  if (req.output_config?.format) {
    if (context.includes('[慢估时]') && estimateGate) await estimateGate;
    const minutes = Number(context.match(/\[分钟 (\d+)\]/)?.[1] ?? 30);
    return say(JSON.stringify({ minutes, reason: '测试' }));
  }
  if (!req.tools?.length) {
    if (context.includes('[问答被拒]')) return refusal();
    return say('回答');
  }
  const last = req.messages[req.messages.length - 1];
  const results = last.role === 'user' && Array.isArray(last.content) ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  const { actorId, text } = actionOf(context);
  if (results.length) return say(`叙述：${text}`);
  if (text.includes('[关AI]')) setSetting(t.app.db, 'ai_enabled', '0');
  if (text.includes('[会出错]')) throw new AiError('测试用的错误', false);
  const calls: { name: string; input: unknown }[] = [];
  for (const [, cmd, arg] of text.matchAll(/\[(移动|线索|结局) ?([^\]]*)\]/g)) {
    if (cmd === '移动') calls.push({ name: 'move_character', input: { character: actorId, location: arg } });
    if (cmd === '线索') calls.push({ name: 'give_clue', input: { clue: arg, characters: [actorId] } });
    if (cmd === '结局') calls.push({ name: 'end_game', input: { ending: arg, epilogue: '尘埃落定。' } });
  }
  return calls.length ? useTools(...calls) : say(`叙述：${text}`);
}

const fake = new FakeProvider(dm);
const passGuard: FakeGuard = () => ({ violation: false, category: 'none', reason: '' });
let c: Record<'admin' | 't1' | 't2' | 't3', string>;

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, rng: () => 3, tickMs: 0 });
  c = {
    admin: await t.login(ADMIN.username, ADMIN.password),
    t1: await t.login(T1.username, T1.password),
    t2: await t.login(T2.username, T2.password),
    t3: await t.login(T3.username, T3.password),
  };
});
after(async () => t.close());
beforeEach(() => {
  fake.guard = passGuard;
  fake.priced = false;
  estimateGate = null;
});

const chars = {
  reporter: { name: '林小满', roleKey: 'reporter', attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 }, specialties: ['打听消息', '速记'], appearance: '', goal: '' },
  detective: { name: '沈探', roleKey: 'detective', attributes: { body: 1, agility: 2, intellect: 1, perception: 0, charm: -1 }, specialties: ['跟踪', '开锁'], appearance: '', goal: '' },
  doctor: { name: '许医生', roleKey: 'doctor', attributes: { body: -1, agility: 0, intellect: 2, perception: 1, charm: 1 }, specialties: ['医生', '日语'], appearance: '', goal: '' },
};

/** 建一局、选《雾港旅店》、建角色、开始。第一个人是房主。没有人打开这一局的页面（都不在线）时是计时模式，用 pass 让时间过去。 */
async function room(players: [string, keyof typeof chars][]) {
  const r = await t.call('POST', '/api/rooms', { name: '边角测试', maxPlayers: 4 }, cookie(players[0][0]));
  const id = r.data.room.id as number;
  for (const [who] of players.slice(1)) assert.equal((await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, cookie(who))).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, cookie(players[0][0]))).status, 200);
  for (const [who, ch] of players) assert.equal((await t.call('PUT', `/api/rooms/${id}/character`, chars[ch], cookie(who))).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, cookie(players[0][0]))).status, 200);
  return id;
}

const extra = new Map<string, string>();
const cookie = (who: string) => (c as Record<string, string>)[who] ?? extra.get(who)!;
const act = (id: number, who: string, content: string) => t.call('POST', `/api/rooms/${id}/actions`, { content }, cookie(who));
const game = async (id: number, who: string) => (await t.call('GET', `/api/rooms/${id}/game`, undefined, cookie(who))).data;
const log = async (id: number, who: string) => (await t.call('GET', `/api/rooms/${id}/log`, undefined, cookie(who))).data.entries as any[];
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const statuses = (id: number) =>
  (t.app.db.prepare('SELECT content, status FROM actions WHERE room_id = ? ORDER BY id').all(id) as { content: string; status: string }[]).map((r) => ({ ...r }));

async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

/** 新注册一个账号（会被封号的测试用新账号，不连累共用的测试账号）。 */
async function newUser(username: string) {
  const invite = await t.call('POST', '/api/admin/invites', { note: username }, c.admin);
  const r = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username,
    displayName: username,
    password: `${username}-pass-1`,
    agreeRules: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  extra.set(username, r.cookie!);
  return r.cookie!;
}

const setCredit = async (username: string, amount: number) =>
  assert.equal((await t.call('POST', `/api/admin/users/${userId(username)}/credit`, { amount }, c.admin)).status, 200);

// ==================== 回合 ====================

test('一轮结算到一半管理员关掉 AI：打开以后接着结算这一轮剩下的行动，不用再等别人交', async () => {
  const id = await room([['t1', 'reporter'], ['t2', 'doctor']]);
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s2 = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await sleep(30);
  assert.equal((await game(id, 't1')).mode, 'round');
  assert.equal((await act(id, 't1', '第一个行动 [分钟 10] [关AI]')).status, 201);
  now += 1000;
  assert.equal((await act(id, 't2', '第二个行动 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.deepEqual(
    statuses(id).map((a) => a.status),
    ['done', 'waiting'],
    '第一个结算完了，第二个放回去等着',
  );

  assert.equal((await t.call('PUT', '/api/admin/ai', { enabled: true }, c.admin)).status, 200);
  await t.app.engine.idle();
  assert.deepEqual(
    statuses(id).map((a) => a.status),
    ['done', 'done'],
    '打开以后接着结算，不等第一个人再交',
  );
  // 下一轮照常：两个人都要交
  const g = await game(id, 't1');
  assert.deepEqual([...g.round.waitingFor].sort(), [g.me.id, g.others[0].id].sort());
  s1.close();
  s2.close();
  await sleep(30);
});

test('AI 额度用完的人不算这一轮的参与者：别人不用一直等他；发了额度以后又要等他', async () => {
  const id = await room([['t1', 'reporter'], ['t3', 'doctor']]);
  await setCredit(T3.username, -5);
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s3 = await t.openStream(`/api/rooms/${id}/events`, c.t3);
  await sleep(30);
  const before = await game(id, 't1');
  assert.equal(before.mode, 'round');
  const doctorId = before.others[0].id;
  assert.deepEqual(before.round.noCredit, [doctorId]);
  assert.deepEqual(before.round.waitingFor, [before.me.id]);

  assert.equal((await act(id, 't1', '不等他 [分钟 10]')).status, 201);
  const blocked = await act(id, 't3', '我也想行动 [分钟 10]');
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /额度用完了/);
  await t.app.engine.idle();
  assert.deepEqual(statuses(id).map((a) => a.status), ['done'], '额度用完的人不交，这一轮照样结算');

  // 管理员发了额度：他又算参与者了
  await setCredit(T3.username, 5);
  assert.equal((await act(id, 't1', '这回要等他 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  const g = await game(id, 't1');
  assert.equal(g.myAction.status, 'waiting');
  assert.deepEqual(g.round.waitingFor, [doctorId]);
  assert.equal((await act(id, 't3', '我来了 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.deepEqual(statuses(id).map((a) => a.status), ['done', 'done', 'done']);
  s1.close();
  s3.close();
  await sleep(30);
});

test('撤回达成结局的结算：同一轮里被撤下的行动接着结算，不用再等', async () => {
  const id = await room([['t1', 'reporter'], ['t2', 'doctor']]);
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s2 = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await sleep(30);
  assert.equal((await act(id, 't1', '揭穿凶手 [分钟 10] [结局 truth]')).status, 201);
  now += 1000;
  assert.equal((await act(id, 't2', '在一旁看着 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await t.call('GET', `/api/rooms/${id}`, undefined, c.t1)).data.room.status, 'ended');
  assert.deepEqual(statuses(id).map((a) => a.status), ['done', 'withdrawn']);

  assert.equal((await t.call('POST', `/api/rooms/${id}/host/undo`, {}, c.t1)).status, 200);
  await t.app.engine.idle();
  assert.equal((await t.call('GET', `/api/rooms/${id}`, undefined, c.t1)).data.room.status, 'running');
  assert.deepEqual(statuses(id).map((a) => a.status), ['withdrawn', 'done'], '撤下的那个接着结算了');
  s1.close();
  s2.close();
  await sleep(30);
});

// ==================== 撤回 ====================

test('撤回只动这一局：线索的编号被别的局重用了，也不会删掉别人的线索', async () => {
  const x = await room([['t1', 'reporter']]);
  const y = await room([['t2', 'detective']]);
  await act(x, 't1', '找灯 [分钟 10] [线索 missing-lantern]');
  await pass(16);
  // X 的房主把这条线索设成没人知道（线索那一行删掉了，编号空出来）
  assert.equal((await t.call('PUT', `/api/rooms/${x}/host/clues/missing-lantern`, { characterIds: [] }, c.t1)).status, 200);
  // Y 找到一条线索，用上了空出来的编号
  await act(y, 't2', '翻登记簿 [分钟 10] [线索 register]');
  await pass(16);
  assert.deepEqual((await game(y, 't2')).clues.map((k: any) => k.key), ['register']);
  // X 撤回那次结算
  assert.equal((await t.call('POST', `/api/rooms/${x}/host/undo`, {}, c.t1)).status, 200);
  assert.deepEqual((await game(y, 't2')).clues.map((k: any) => k.key), ['register'], '别的局的线索没被删');
});

test('撤回时，之后把这条线索分享出去的记录也一起撤掉；别人分享的别的线索不受影响', async () => {
  const id = await room([['t1', 'reporter'], ['t2', 'detective'], ['t3', 'doctor']]);
  await act(id, 't3', '翻登记簿 [分钟 10] [线索 register]');
  await pass(16);
  await act(id, 't1', '找灯 [分钟 10] [线索 missing-lantern]');
  await pass(16);
  const detectiveId = (await game(id, 't2')).me.id;
  assert.equal((await t.call('POST', `/api/rooms/${id}/clues/missing-lantern/share`, { to: [detectiveId] }, c.t1)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/clues/register/share`, { to: [detectiveId] }, c.t3)).status, 200);
  assert.deepEqual((await game(id, 't2')).clues.map((k: any) => k.key).sort(), ['missing-lantern', 'register']);

  assert.equal((await t.call('POST', `/api/rooms/${id}/host/undo`, {}, c.t1)).status, 200);
  assert.deepEqual((await game(id, 't2')).clues.map((k: any) => k.key), ['register'], '撤掉的线索没了，别人分享的还在');
  const shares = (await log(id, 't2')).filter((e) => e.data?.type === 'share').map((e) => e.text);
  assert.deepEqual(shares, ['许医生把线索「登记簿上的刘贵」告诉了沈探']);
});

test('重新结算：钱记给按按钮的房主；角色已经交了新的行动时不能重新结算，只能撤回', async () => {
  fake.priced = true;
  const original = fake.handler;
  // 每次回复都带上用量，才会记钱
  fake.handler = async (req) => ({ ...(await original(req)), usage: { input_tokens: 1000, output_tokens: 100 } });
  try {
    const id = await room([['t1', 'reporter'], ['t2', 'detective']]);
    await act(id, 't2', '在楼上转转 [分钟 10]');
    await pass(16);
    const actionId = (t.app.db.prepare('SELECT id FROM actions WHERE room_id = ?').get(id) as { id: number }).id;
    assert.equal((await t.call('POST', `/api/rooms/${id}/host/undo`, { regenerate: true }, c.t1)).status, 200);
    await t.app.engine.idle();
    const payers = (
      t.app.db
        .prepare(
          `SELECT u.username FROM ai_calls a JOIN ai_call_shares s ON s.call_id = a.id JOIN users u ON u.id = s.user_id
           WHERE a.action_id = ? AND a.purpose = 'resolve' ORDER BY a.id`,
        )
        .all(actionId) as { username: string }[]
    ).map((r) => r.username);
    assert.deepEqual(payers, [T2.username, T1.username], '第一次记给行动的主人，重新结算记给房主');

    // 他已经交了新的行动：不能再把上一个放回去重新结算
    assert.equal((await act(id, 't2', '接着转 [分钟 10]')).status, 201);
    await t.app.engine.idle();
    const again = await t.call('POST', `/api/rooms/${id}/host/undo`, { regenerate: true }, c.t1);
    assert.equal(again.status, 409);
    assert.match(again.data.error, /新的行动/);
    assert.equal((await t.call('POST', `/api/rooms/${id}/host/undo`, {}, c.t1)).status, 200, '只撤回可以');
    await pass(16);
  } finally {
    fake.handler = original;
  }
});

// ==================== 房主自己也在玩 ====================

test('房主自己也在玩：最近一次结算他不在场时看不到行动内容；管理员看得到', async () => {
  const id = await room([['t1', 'reporter'], ['t2', 'detective']]);
  // 侦探在二楼、记者在大堂：这次结算只有侦探知道
  await act(id, 't2', '悄悄把信藏进枕头里 [分钟 10]');
  await pass(16);
  assert.ok(!(await log(id, 't1')).some((e) => e.text.includes('枕头')));
  const view = (await t.call('GET', `/api/rooms/${id}/host`, undefined, c.t1)).data;
  assert.equal(view.last.actor, '沈探');
  assert.equal(view.last.action, null, '房主看不到他没在场的行动');
  assert.ok(!JSON.stringify(view).includes('枕头'));
  const admin = (await t.call('GET', `/api/rooms/${id}/host?full=1`, undefined, c.admin)).data;
  assert.match(admin.last.action, /枕头/);
  // 自己的行动看得到
  await act(id, 't1', '在大堂坐着 [分钟 10]');
  await pass(16);
  assert.match((await t.call('GET', `/api/rooms/${id}/host`, undefined, c.t1)).data.last.action, /大堂/);
});

// ==================== 额度 ====================

test('重试要再调用一次 AI：额度用完了不能重试', async () => {
  const id = await room([['t3', 'doctor']]);
  await act(id, 't3', '这次会出错 [分钟 10] [会出错]');
  await pass(16);
  const g = await game(id, 't3');
  assert.equal(g.myAction.status, 'failed');
  await setCredit(T3.username, -5);
  const retry = await t.call('POST', `/api/rooms/${id}/actions/${g.myAction.id}/retry`, {}, c.t3);
  assert.equal(retry.status, 403);
  assert.match(retry.data.error, /额度用完了/);
  await setCredit(T3.username, 5);
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions/${g.myAction.id}/retry`, {}, c.t3)).status, 200);
  await t.app.engine.idle();
});

test('还没输出就被拒绝：不收费的类别记 0 元，收费的类别照常记', async () => {
  let currentCategory: string | null = 'general_harms';
  const provider = new FakeProvider(() => ({ ...refusal(currentCategory), usage: { input_tokens: 5000, output_tokens: 0 } }));
  provider.priced = true;
  const client = new AiClient(t.app.db, provider);
  const cost = async () => {
    await client.send('answer', { max_tokens: 10, messages: [{ role: 'user', content: '测试' }] }, { roomId: null, userId: userId(T1.username) });
    return t.app.db.prepare('SELECT cost_usd, error FROM ai_calls ORDER BY id DESC LIMIT 1').get() as { cost_usd: number; error: string | null };
  };
  const free = await cost();
  assert.equal(free.cost_usd, 0);
  assert.match(free.error!, /不收费/);
  currentCategory = null;
  assert.equal((await cost()).cost_usd, 0, '没有类别的也不收费');
  currentCategory = 'bio';
  assert.ok((await cost()).cost_usd > 0, 'bio 类别照常收费');
});

// ==================== 拒绝和封号 ====================

test('多人局里场外提问被拒绝：材料里混着别人的行动，只标给管理员看，不封号', async () => {
  await newUser('asker1');
  await newUser('loud1');
  const r = await t.call('POST', '/api/rooms', { name: '提问被拒', maxPlayers: 2 }, cookie('asker1'));
  const id = r.data.room.id as number;
  await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, cookie('loud1'));
  await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, cookie('asker1'));
  await t.call('PUT', `/api/rooms/${id}/character`, chars.reporter, cookie('asker1'));
  await t.call('PUT', `/api/rooms/${id}/character`, chars.doctor, cookie('loud1'));
  await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, cookie('asker1'));
  // 两个人都在大堂：另一个人的行动会出现在提问的材料里
  assert.equal((await act(id, 'loud1', '在大堂里大声嚷嚷 [分钟 10] [问答被拒]')).status, 201);
  await pass(16);
  assert.equal((await t.call('POST', `/api/rooms/${id}/ask`, { question: '老板娘刚才去哪了？' }, cookie('asker1'))).status, 202);
  await t.app.engine.idle();
  const user = t.app.db.prepare("SELECT banned_at FROM users WHERE username = 'asker1'").get() as { banned_at: number | null };
  assert.equal(user.banned_at, null, '没有封提问的人');
  const v = t.app.db.prepare("SELECT v.source, v.outcome FROM violations v JOIN users u ON u.id = v.user_id WHERE u.username = 'asker1'").all() as any[];
  assert.deepEqual(v.map((x) => ({ ...x })), [{ source: 'question', outcome: 'flagged' }]);
});

test('内容检查本身被拒绝：和别的违规一样，第一次警告、第二次封号；管理员只拦下', async () => {
  fake.guard = (text) => (text.includes('[查拒]') ? 'refusal' : { violation: false, category: 'none', reason: '' });
  await newUser('checked1');
  const r = await t.call('POST', '/api/rooms', { name: '检查被拒', maxPlayers: 1 }, cookie('checked1'));
  const id = r.data.room.id as number;
  await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, cookie('checked1'));
  await t.call('PUT', `/api/rooms/${id}/character`, chars.reporter, cookie('checked1'));
  await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, cookie('checked1'));

  const first = await act(id, 'checked1', '第一次 [查拒]');
  assert.equal(first.status, 403);
  assert.equal(first.data.error, '这段内容没有通过内容检查（被 AI 的安全机制拒绝了），没有发给 AI。这是警告，再违反一次账号会被封禁。');
  assert.equal(statuses(id).length, 0, '没有提交');
  const banned = () => (t.app.db.prepare("SELECT banned_at FROM users WHERE username = 'checked1'").get() as { banned_at: number | null }).banned_at;
  assert.equal(banned(), null);
  assert.equal((await act(id, 'checked1', '正常的行动 [分钟 10]')).status, 201, '还能接着玩');
  await pass(16);

  const second = await act(id, 'checked1', '第二次 [查拒]');
  assert.equal(second.status, 403);
  assert.match(second.data.error, /封禁/);
  assert.ok(banned());
  const v = t.app.db.prepare("SELECT v.category, v.outcome FROM violations v JOIN users u ON u.id = v.user_id WHERE u.username = 'checked1' ORDER BY v.id").all() as any[];
  assert.deepEqual(
    v.map((x) => ({ ...x })),
    [
      { category: 'refusal:general_harms', outcome: 'warned' },
      { category: 'refusal:general_harms', outcome: 'banned' },
    ],
  );

  // 管理员：拦下，不封号
  const adminRoom = await room([['admin', 'doctor']]);
  for (let i = 0; i < 2; i++) assert.equal((await act(adminRoom, 'admin', `管理员第${i + 1}次 [查拒]`)).status, 403);
  assert.equal((t.app.db.prepare("SELECT banned_at FROM users WHERE username = ?").get(ADMIN.username) as { banned_at: number | null }).banned_at, null);
});

test('检查内容的这一会儿里账号被封了：行动不再提交', async () => {
  await newUser('racer1');
  const r = await t.call('POST', '/api/rooms', { name: '检查时被封', maxPlayers: 1 }, cookie('racer1'));
  const id = r.data.room.id as number;
  await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, cookie('racer1'));
  await t.call('PUT', `/api/rooms/${id}/character`, chars.reporter, cookie('racer1'));
  await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, cookie('racer1'));
  fake.guard = (text) => {
    if (text.includes('[查时被封]')) t.app.safety.ban(userId('racer1'), '测试：检查期间被管理员封了', 1);
    return { violation: false, category: 'none', reason: '' };
  };
  const res = await act(id, 'racer1', '一个正常的行动 [查时被封]');
  assert.equal(res.status, 403);
  assert.match(res.data.error, /封禁/);
  assert.equal(statuses(id).length, 0);
});

// ==================== 估时 ====================

test('同一个行动的估时不会重复做（重复估要多花钱，还会改掉出结果的时间）', async () => {
  const id = await room([['t1', 'reporter']]);
  let open!: () => void;
  estimateGate = new Promise((resolve) => (open = resolve));
  const before = fake.requests.length;
  assert.equal((await act(id, 't1', '想很久 [分钟 20] [慢估时]')).status, 201);
  await sleep(20);
  t.app.engine.resumeRoom(id);
  t.app.engine.resumeRoom(id);
  await sleep(20);
  const estimates = fake.requests.slice(before).filter((r) => r.output_config?.format && userText(r).includes('[慢估时]'));
  assert.equal(estimates.length, 1);
  open();
  await pass(21);
  assert.equal(statuses(id)[0].status, 'done');
});

// ==================== 自带的三个新剧本 ====================

test('三个新剧本都能开局：开场、身份、移动、拿线索、达成结局都对得上', async () => {
  const cases = [
    { key: 'qingxi-lantern-night', title: '青溪灯夜', players: ['t1'], move: 'street', clue: 'watchman', clueTitle: '更夫看见的人', ending: 'moon-full', endingTitle: '月圆人安' },
    { key: 'yakou-fifth-man', title: '垭口的第五个人', players: ['t1'], move: 'dorm', clue: 'luo-room', clueTitle: '罗小川的草图', ending: 'after-snow', endingTitle: '雪停之后' },
    { key: 'mengzhu-ling', title: '盟主令', players: ['t1', 't2'], move: 'hall', clue: 'armory-record', clueTitle: '兵器簿上的一笔', ending: 'sheathed', endingTitle: '剑归鞘' },
  ];
  const attributes = { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 };
  for (const s of cases) {
    const host = s.players[0];
    const r = await t.call('POST', '/api/rooms', { name: s.title, maxPlayers: s.players.length }, cookie(host));
    const id = r.data.room.id as number;
    for (const who of s.players.slice(1)) await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, cookie(who));
    const picked = await t.call('POST', `/api/rooms/${id}/scenario`, { key: s.key }, cookie(host));
    assert.equal(picked.status, 200, JSON.stringify(picked.data));
    const roles = picked.data.scenario.roles as { key: string; name: string; suggestedSpecialties: string[] }[];
    for (const [i, who] of s.players.entries()) {
      const role = roles[i];
      const made = await t.call(
        'PUT',
        `/api/rooms/${id}/character`,
        { name: `角色${i + 1}`, roleKey: role.key, attributes, specialties: role.suggestedSpecialties.slice(0, 2), appearance: '', goal: '' },
        cookie(who),
      );
      assert.equal(made.status, 200, JSON.stringify(made.data));
    }
    assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, cookie(host))).status, 200);
    const opening = (await log(id, host)).find((e) => e.data?.type === 'opening');
    assert.equal(opening.data.title, s.title);
    const me = (await game(id, host)).me;
    assert.ok(me.roleSecret.length > 0, '身份的秘密只给本人');

    assert.equal((await act(id, host, `四处走走 [分钟 10] [移动 ${s.move}] [线索 ${s.clue}]`)).status, 201);
    await pass(16);
    const after = await game(id, host);
    assert.equal(after.me.location.key, s.move);
    assert.deepEqual(after.clues.map((k: any) => k.title), [s.clueTitle]);

    assert.equal((await act(id, host, `了结这一切 [分钟 10] [结局 ${s.ending}]`)).status, 201);
    await pass(16);
    const ended = await game(id, host);
    assert.equal(ended.ending?.title, s.endingTitle, s.title);
    assert.equal((await t.call('GET', `/api/rooms/${id}`, undefined, cookie(host))).data.room.status, 'ended');
  }
});
