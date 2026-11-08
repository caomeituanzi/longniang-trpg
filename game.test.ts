import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeProvider, reply, say, useTools } from '../server/ai/fake';
import { GUARD_MARK } from '../server/ai/moderation';
import { AiError, type MessagesRequest, type MessagesResponse, type TextBlock, type ToolResultBlock } from '../server/ai/types';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { sleep, startTestApp } from './helpers';

// 跑团流程：选剧本、车卡、开局、行动、计时、回合、AI结算、谁能看到什么。
// 用假的主持人代替 Claude：玩家行动里写的 [指令] 决定假主持人调用哪些工具。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;

let now = Date.UTC(2026, 9, 25, 3, 0, 0);
const dice: number[] = [];
/** 行动里写了 [会出错] 时，接下来几次结算要模拟的错误。 */
let failures: AiError[] = [];
/** 行动里写了 [等一下] 时，主持人要等这个闸门打开才回复（模拟 AI 正在思考的那段时间）。 */
let gate: Promise<void> | null = null;

function lastUserText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function actionOf(context: string): { actorId: number; text: string } {
  const block = context.slice(context.indexOf('# 这次要结算的行动'));
  const quotes = [...block.matchAll(/「([^」]*)」/g)];
  return { actorId: Number(block.match(/编号 (\d+)/)?.[1]), text: quotes[quotes.length - 1]?.[1] ?? '' };
}

/** 模拟 Anthropic 的安全机制拒绝了这次请求。 */
const refusal = (): MessagesResponse => ({
  ...reply([], 'refusal'),
  stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
});

/**
 * 假主持人：估时看 [分钟 N]；结算时按 [检定 属性] [移动 地点] [线索 key] [受伤 N] [私信 内容] [结局 key] 调用工具。
 * [估时被拒] 让估时被安全机制拒绝，[会被拒] 让结算或场外提问被拒绝。
 */
async function scriptedDm(req: MessagesRequest): Promise<MessagesResponse> {
  const context = lastUserText(req);
  if (req.output_config?.format) {
    if (context.includes('[估时被拒]')) return refusal();
    const minutes = Number(context.match(/\[分钟 (\d+)\]/)?.[1] ?? 30);
    return say(JSON.stringify({ minutes, reason: '测试' }));
  }
  if (!req.tools?.length) {
    if (context.includes('[会被拒]')) return refusal();
    // “你不在时”的摘要
    if (req.system?.[0]?.text.includes('补课')) {
      const failure = failures.shift();
      if (failure) throw failure;
      return say(`摘要：离开期间发生了${context.split('\n\n').length - 1}件事`);
    }
    // 主持人的剧情笔记：之前笔记里的事，加上这次材料里的行动
    if (req.system?.[0]?.text.includes('整理笔记')) {
      const failure = failures.shift();
      if (failure) throw failure;
      const previous = context.match(/# 之前的笔记\n笔记：([^\n]*)/)?.[1]?.split('、') ?? [];
      const actions = [...context.matchAll(/行动：「([^」]*)」/g)].map((m) => m[1].replace(/ ?\[[^\]]*\]/g, ''));
      return say(`笔记：${[...previous, ...actions].join('、')}`);
    }
    return say(`回答：${context.match(/# 玩家的问题[^\n]*\n「([^」]*)」/)?.[1] ?? ''}`);
  }

  const last = req.messages[req.messages.length - 1];
  const results = last.role === 'user' && Array.isArray(last.content) ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  const { actorId, text } = actionOf(context);
  if (results.length) {
    const roll = results.map((r) => JSON.parse(r.content)).find((r) => r.outcome_label);
    return say(`叙述：${text}${roll ? `（${roll.outcome_label}）` : ''}`);
  }
  if (text.includes('[会被拒]')) return refusal();
  // 「推理提取」类的拒绝：是网站提示词的问题，不算玩家违规
  if (text.includes('[推理被拒]')) return { ...reply([], 'refusal'), stop_details: { type: 'refusal', category: 'reasoning_extraction', explanation: null } };
  if (text.includes('[等一下]') && gate) await gate;
  if (text.includes('[会出错]')) {
    const failure = failures.shift();
    if (failure) throw failure;
  }

  const calls: { name: string; input: unknown }[] = [];
  for (const [, cmd, arg] of text.matchAll(/\[(检定|移动|线索|受伤|私信|结局|NPC) ?([^\]]*)\]/g)) {
    if (cmd === '检定') calls.push({ name: 'roll_check', input: { character: actorId, attribute: arg || 'perception', modifier: 0, reason: '测试检定' } });
    if (cmd === '移动') calls.push({ name: 'move_character', input: { character: actorId, location: arg } });
    if (cmd === '线索') calls.push({ name: 'give_clue', input: { clue: arg, characters: [actorId] } });
    if (cmd === '受伤') calls.push({ name: 'update_character', input: { character: actorId, wounds: Number(arg), reason: '测试' } });
    if (cmd === '私信') calls.push({ name: 'private_message', input: { character: actorId, text: arg } });
    if (cmd === '结局') calls.push({ name: 'end_game', input: { ending: arg, epilogue: '雾散了，一切尘埃落定。' } });
    if (cmd === 'NPC') calls.push({ name: 'update_npc', input: { npc: arg, attitude: '起了疑心' } });
  }
  return calls.length ? useTools(...calls) : say(`叙述：${text}`);
}

const fake = new FakeProvider(scriptedDm);
// 发给 AI 之前的内容检查：写了 [违规] 的算违规，其他的都放行
fake.guard = (text) =>
  text.includes('[违规]') ? { violation: true, category: 'other', reason: '测试用的违规' } : { violation: false, category: 'none', reason: '' };
let t: Awaited<ReturnType<typeof startTestApp>>;
let cookies: Record<'admin' | 'tester1' | 'tester2' | 'tester3' | 'tester4' | 'tester5', string>;

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, rng: () => dice.shift() ?? 3, tickMs: 0 });
  cookies = {
    admin: await t.login(ADMIN.username, ADMIN.password),
    tester1: await t.login(TESTER1.username, TESTER1.password),
    tester2: await t.login(TESTER2.username, TESTER2.password),
    tester3: await t.login(TESTER3.username, TESTER3.password),
    tester4: await t.login(TESTER4.username, TESTER4.password),
    tester5: await t.login(TESTER5.username, TESTER5.password),
  };
});

after(async () => {
  await t.close();
});

beforeEach(() => {
  failures = [];
  dice.length = 0;
  gate = null;
});

const reporter = {
  name: '林小满',
  roleKey: 'reporter',
  attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 },
  specialties: ['打听消息', '速记'],
  appearance: '短头发，挂着相机',
  goal: '登上头版',
};
const detective = {
  name: '沈探',
  roleKey: 'detective',
  attributes: { body: 1, agility: 2, intellect: 1, perception: 0, charm: -1 },
  specialties: ['跟踪', '开锁'],
  appearance: '',
  goal: '',
};
const doctor = {
  name: '许医生',
  roleKey: 'doctor',
  attributes: { body: -1, agility: 0, intellect: 2, perception: 1, charm: 1 },
  specialties: ['医生', '日语'],
  appearance: '',
  goal: '',
};

const customs = {
  name: '顾一鸣',
  roleKey: 'customs',
  attributes: { body: 1, agility: 1, intellect: 0, perception: 2, charm: -1 },
  specialties: ['查验货物', '枪械'],
  appearance: '',
  goal: '',
};
const youngMaster = {
  name: '白少卿',
  roleKey: 'young-master',
  attributes: { body: -1, agility: 1, intellect: 0, perception: 1, charm: 2 },
  specialties: ['察言观色', '赌术'],
  appearance: '',
  goal: '',
};
const sailor = {
  name: '阿海',
  roleKey: 'sailor',
  attributes: { body: 2, agility: 1, intellect: -1, perception: 1, charm: 0 },
  specialties: ['驾船', '水性'],
  appearance: '',
  goal: '',
};

async function createRoom(host: keyof typeof cookies, opts: { maxPlayers?: number; name?: string } = {}) {
  const r = await t.call(
    'POST',
    '/api/rooms',
    { name: opts.name ?? '测试局', maxPlayers: opts.maxPlayers ?? 4 },
    cookies[host],
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { id: r.data.room.id as number, code: r.data.room.joinCode as string };
}

/** 建一局、选好剧本、建好角色、开始。没有人打开这一局的页面（都不在线）时是计时模式。 */
async function startedRoom(players: { who: keyof typeof cookies; character: typeof reporter }[]) {
  const room = await createRoom(players[0].who, { maxPlayers: Math.max(4, players.length) });
  for (const p of players.slice(1)) assert.equal((await t.call('POST', '/api/rooms/join', { code: room.code }, cookies[p.who])).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, cookies[players[0].who])).status, 200);
  for (const p of players) {
    const r = await t.call('PUT', `/api/rooms/${room.id}/character`, p.character, cookies[p.who]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const started = await t.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, cookies[players[0].who]);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  return room.id;
}

const game = async (roomId: number, who: keyof typeof cookies) => (await t.call('GET', `/api/rooms/${roomId}/game`, undefined, cookies[who])).data;
const log = async (roomId: number, who: keyof typeof cookies) =>
  (await t.call('GET', `/api/rooms/${roomId}/log`, undefined, cookies[who])).data.entries as any[];
const act = (roomId: number, who: keyof typeof cookies, content: string) => t.call('POST', `/api/rooms/${roomId}/actions`, { content }, cookies[who]);
const share = (roomId: number, who: keyof typeof cookies, key: string, to: number[] | 'all') =>
  t.call('POST', `/api/rooms/${roomId}/clues/${key}/share`, { to }, cookies[who]);
/** 计时模式下让时间过去 minutes 分钟，并把到期的行动结算完。 */
async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

test('剧本列表和选剧本：只有房主能选，导入有错的剧本会说明错在哪', async () => {
  const list = await t.call('GET', '/api/scenarios', undefined, cookies.tester1);
  assert.ok(list.data.scenarios.some((s: any) => s.key === 'fog-harbor-inn' && s.title === '雾港旅店'));

  const room = await createRoom('tester1');
  assert.equal((await t.call('POST', '/api/rooms/join', { code: room.code }, cookies.tester2)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester2)).status, 403, '普通成员不能选');
  assert.equal((await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'no-such-thing' }, cookies.tester1)).status, 404);
  const bad = await t.call('POST', `/api/rooms/${room.id}/scenario`, { data: { format: 'x' } }, cookies.tester1);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /剧本有\d+处错误/);

  const chosen = await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester1);
  assert.equal(chosen.status, 200);
  assert.equal(chosen.data.scenario.title, '雾港旅店');
  assert.equal(chosen.data.scenario.roles.length, 6);
  // 发给网页的剧本信息里没有真相、NPC、线索
  const raw = JSON.stringify(chosen.data);
  assert.ok(!raw.includes('刘疤子') && !raw.includes('鸦片'), '剧本的秘密不能发给网页');
});

test('车卡：选身份、起名字；属性、专长、外貌按身份固定，不能改；身份不能重复、选定不能换，名字不能重复；没人建角色不能开始', async () => {
  const room = await createRoom('tester1');
  assert.equal((await t.call('POST', '/api/rooms/join', { code: room.code }, cookies.tester2)).status, 200);
  assert.equal((await t.call('PUT', `/api/rooms/${room.id}/character`, reporter, cookies.tester1)).status, 409); // 还没选剧本
  const chosen = await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester1);
  assert.equal(
    (await t.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, cookies.tester1)).data.error,
    '还没有人选身份建角色，至少要有一个角色才能开局',
  );

  // 选身份时就看得到每个身份固定的属性、专长、外貌；秘密和目标看不到
  const roles = chosen.data.scenario.roles as any[];
  const reporterRole = roles.find((r) => r.key === 'reporter');
  assert.deepEqual(reporterRole.attributes, { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 });
  assert.deepEqual(reporterRole.specialties, ['打听消息', '速记']);
  assert.ok(reporterRole.appearance.length > 0);
  assert.ok(!JSON.stringify(chosen.data).includes('线人'), '没选之前看不到身份的秘密');

  // 自己写的属性、专长不算数，一律用身份定好的
  const cheating = await t.call(
    'PUT',
    `/api/rooms/${room.id}/character`,
    { ...reporter, attributes: { body: 2, agility: 2, intellect: 2, perception: 2, charm: 2 }, specialties: ['万能'] },
    cookies.tester1,
  );
  assert.equal(cheating.status, 200);
  assert.deepEqual(cheating.data.me.attributes, reporterRole.attributes);
  assert.deepEqual(cheating.data.me.specialties, ['打听消息', '速记']);
  assert.equal(cheating.data.me.name, '林小满');
  assert.equal(cheating.data.me.roleSecret.includes('线人'), true, '选了以后自己能看到身份的秘密');
  assert.ok(cheating.data.me.roleGoal.length > 0, '选了以后能看到目标');

  assert.equal((await t.call('PUT', `/api/rooms/${room.id}/character`, { ...detective, roleKey: 'reporter' }, cookies.tester2)).status, 409);
  assert.equal((await t.call('PUT', `/api/rooms/${room.id}/character`, { ...detective, name: '林小满' }, cookies.tester2)).status, 409);
  assert.equal((await t.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'no-such-role', name: '谁' }, cookies.tester2)).status, 400);
  const other = await t.call('PUT', `/api/rooms/${room.id}/character`, detective, cookies.tester2);
  assert.equal(other.status, 200);
  // 别人只看得到公开的部分
  const seen = other.data.others.find((c: any) => c.name === '林小满');
  assert.equal(seen.roleName, '上海来的记者');
  assert.equal(JSON.stringify(other.data).includes('线人'), false);
  assert.equal(other.data.scenario.roles.find((r: any) => r.key === 'reporter').takenBy, '林小满');

  // 准备阶段可以改名字；身份选定了不能换
  assert.equal((await t.call('PUT', `/api/rooms/${room.id}/character`, { ...reporter, name: '林小雨' }, cookies.tester1)).data.me.name, '林小雨');
  const switched = await t.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'doctor', name: '林小雨' }, cookies.tester1);
  assert.equal(switched.status, 409);
  assert.match(switched.data.error, /身份选定以后不能换/);
});

test('开局：所有人看到开场，身份秘密只有本人看到，角色站在各自的起点', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'admin', character: detective },
  ]);
  const mine = await game(roomId, 'tester1');
  assert.equal(mine.me.location.key, 'lobby');
  assert.ok(mine.me.location.exits.some((e: any) => e.key === 'kitchen'));
  assert.equal(Math.round(mine.clock.minutes), 22 * 60); // 第1天 22:00
  assert.equal((await game(roomId, 'admin')).me.location.key, 'guest-rooms');

  const entries = await log(roomId, 'tester1');
  assert.ok(entries.some((e) => e.data?.type === 'opening' && !e.private));
  const role = entries.find((e) => e.data?.type === 'role');
  assert.ok(role.private && role.text.includes('线人'));
  const adminEntries = await log(roomId, 'admin');
  assert.equal(adminEntries.filter((e) => e.data?.type === 'role').length, 1);
  assert.ok(!adminEntries.some((e) => e.text.includes('线人')), '别人的身份秘密看不到');
  // 开场时刻的时间线事件已经算发生过
  const world = JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string }).world);
  assert.equal(world.events['body-found'].happened, true);
});

test('回合模式：在线时提交行动，估时后马上结算；掷骰、移动、线索都由程序记下', async () => {
  const roomId = await startedRoom([{ who: 'tester2', character: reporter }]);
  const stream = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await stream.waitFor((e) => e.event === 'presence' && e.data.mode === 'round');

  fake.requests.length = 0;
  dice.push(5, 6);
  const submitted = await act(roomId, 'tester2', '我去地窖仔细检查周墨后脑的伤口 [分钟 20] [检定 intellect] [移动 cellar] [线索 head-wound]');
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.equal(submitted.data.action.mode, 'round');
  await t.app.engine.idle();

  const state = await game(roomId, 'tester2');
  assert.equal(state.myAction, null);
  assert.equal(state.me.location.key, 'cellar');
  // 地图（V1.0.x）：从大堂去地窖要穿过后厨，路过的地方也算去过
  assert.deepEqual(state.me.visited.map((p: any) => p.key).sort(), ['cellar', 'kitchen', 'lobby']);
  assert.deepEqual(state.clues.map((c: any) => c.key), ['head-wound']);
  assert.ok(state.clues[0].content.includes('凹陷'));
  assert.equal(Math.round(state.clock.minutes), 22 * 60 + 20, '回合模式下游戏时间按行动耗时往前跳');

  const narration = (await log(roomId, 'tester2')).find((e) => e.data?.type === 'resolution');
  assert.ok(narration.text.startsWith('叙述：'));
  assert.equal(narration.data.actor, '林小满');
  assert.deepEqual(narration.data.rolls[0].dice, [5, 6]);
  assert.equal(narration.data.rolls[0].total, 13); // 5+6 + 智识2
  assert.equal(narration.data.rolls[0].outcome, 'success');
  assert.deepEqual(narration.data.clues, [{ key: 'head-wound', title: '后脑的伤' }]);
  assert.ok(narration.data.changes.includes('来到：地窖（路过后厨和后院）'));
  await stream.waitFor((e) => e.event === 'log' && e.data.data?.type === 'resolution');

  // 发给主持AI的请求：规则和剧本走1小时缓存，工具都在，行动内容在最后
  const dm = fake.requests.find((r) => r.tools?.length)!;
  assert.equal(dm.system?.[0].cache_control?.ttl, '1h');
  assert.equal(dm.system?.[1].cache_control?.ttl, '1h');
  assert.ok(dm.system?.[1].text.includes('"truth"'));
  assert.deepEqual(
    dm.tools!.map((x) => x.name).sort(),
    ['end_game', 'give_clue', 'move_character', 'noise', 'private_message', 'reveal_exit', 'roll_check', 'roll_opposed', 'set_spot', 'trigger_event', 'update_character', 'update_npc'],
  );
  assert.ok(lastUserText(dm).includes('我去地窖仔细检查周墨后脑的伤口'));
  const second = fake.requests.filter((r) => r.tools?.length)[1];
  assert.equal(second.messages.length, 3, '第二轮带着第一轮的回复和工具结果');
  const lastMsg = second.messages[2];
  assert.ok(Array.isArray(lastMsg.content) && (lastMsg.content[0] as ToolResultBlock).type === 'tool_result');
  assert.deepEqual((lastMsg.content as ToolResultBlock[]).at(-1)?.cache_control, { type: 'ephemeral' });

  const rolls = t.app.db.prepare('SELECT die1, die2, total, outcome FROM rolls WHERE room_id = ?').all(roomId) as any[];
  assert.deepEqual({ ...rolls[0] }, { die1: 5, die2: 6, total: 13, outcome: 'success' });
  const calls = t.app.db.prepare('SELECT purpose FROM ai_calls WHERE room_id = ? ORDER BY id').all(roomId) as { purpose: string }[];
  // 角色设定和行动发给主持 AI 之前，各先检查了一次内容
  assert.deepEqual(calls.map((c) => c.purpose), ['moderation', 'moderation', 'estimate', 'resolve', 'resolve']);
  assert.ok(fake.guardRequests.some((r) => r.messages[0].content.toString().includes('我去地窖仔细检查周墨后脑的伤口')));
  assert.ok(fake.guardRequests.every((r) => r.system?.[0]?.text.startsWith(GUARD_MARK) && r.model === 'deepseek-flash'), '内容检查默认用 DeepSeek V4.1 Flash 1017');
  stream.close();
});

test('计时模式：要等到时间才结算，游戏时钟跟着现实时间走', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  const submitted = await act(roomId, 'tester1', '翻看大堂的住客登记簿 [分钟 50]');
  assert.equal(submitted.data.action.mode, 'timed');
  // 每个角色同一时间只能有一个行动
  assert.equal((await act(roomId, 'tester1', '再做一件事')).status, 409);
  await t.app.engine.idle(); // 估时
  const waiting = (await game(roomId, 'tester1')).myAction;
  assert.equal(waiting.gameMinutes, 50);
  assert.equal(waiting.dueAt, waiting.submittedAt + 50 * MIN);

  now += 49 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester1')).myAction.status, 'waiting');

  now += 2 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const resolved = await game(roomId, 'tester1');
  assert.equal(resolved.myAction, null);
  assert.equal(Math.round(resolved.clock.minutes), 22 * 60 + 51);
  assert.ok(resolved.clock.running);
  assert.ok((await log(roomId, 'tester1')).some((e) => e.data?.type === 'resolution'));

  // 很短的行动也至少等15分钟；很长的行动最多等2小时，结算后时钟跳到行动结束的时间
  await act(roomId, 'tester1', '睡一觉 [分钟 480]');
  await t.app.engine.idle();
  const sleepy = (await game(roomId, 'tester1')).myAction;
  assert.equal(sleepy.dueAt - sleepy.submittedAt, 120 * MIN);
  now += 121 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  assert.equal(Math.round((await game(roomId, 'tester1')).clock.minutes), 22 * 60 + 51 + 480);
});

test('谁能看到什么：叙述只给同一地点的人，线索卡片只给拿到的人', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter }, // 大堂
    { who: 'tester2', character: detective }, // 二楼客房
  ]);
  await act(roomId, 'tester1', '在大堂里四处看看 [分钟 15] [线索 missing-lantern] [私信 你注意到柜台下面有一滩水]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  assert.ok((await log(roomId, 'tester1')).some((e) => e.text === '你注意到柜台下面有一滩水'));
  assert.ok(!(await log(roomId, 'tester2')).some((e) => e.data?.type === 'resolution' || e.data?.type === 'private'), '不在场的人看不到');

  // 侦探下楼到大堂
  await act(roomId, 'tester2', '下楼去大堂 [分钟 15] [移动 lobby]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  // 记者在大堂，看到侦探下楼的叙述
  assert.ok((await log(roomId, 'tester1')).some((e) => e.data?.actor === '沈探'));

  await act(roomId, 'tester1', '翻登记簿 [分钟 15] [线索 register]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const seenByDetective = (await log(roomId, 'tester2')).find((e) => e.data?.action?.startsWith('翻登记簿'));
  assert.ok(seenByDetective, '同一地点的人看得到叙述');
  assert.deepEqual(seenByDetective.data.clues, [], '但线索卡片只给拿到的人');
  assert.deepEqual((await game(roomId, 'tester2')).clues, []);
  const reporterEntry = (await log(roomId, 'tester1')).find((e) => e.data?.action?.startsWith('翻登记簿'));
  assert.deepEqual(reporterEntry.data.clues, [{ key: 'register', title: '登记簿上的刘贵' }]);

  // 走到别处（V0.7.1）：叙述只给到了的那个地点的人；留在原地的侦探只知道记者往哪去了，不知道她在那边发现了什么
  await act(roomId, 'tester1', '去地窖翻翻 [分钟 15] [移动 cellar] [线索 lantern]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const detectiveLog = await log(roomId, 'tester2');
  assert.ok(!detectiveLog.some((e) => e.data?.action?.startsWith('去地窖翻翻')), '原地的人看不到到了那边的叙述');
  // 地窖不是大堂的出口：只说往路上第一站（后厨）那边去了，不把还没到过的地方说出来（V0.7.1 审查）
  assert.ok(detectiveLog.some((e) => e.data?.type === 'private' && e.text === '林小满离开了「大堂」，往「后厨和后院」那边去了。'));
  assert.ok((await log(roomId, 'tester1')).some((e) => e.data?.action?.startsWith('去地窖翻翻')));
  // 另一个人打开推送时，看不到不该看的
  const stream = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await stream.waitFor((e) => e.event === 'presence');
  stream.close();
});

test('全员到齐时转成回合模式，等所有人都交了一起结算；有人离开再转回计时', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'admin', character: detective },
  ]);
  const a = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  await a.waitFor((e) => e.event === 'presence');
  // 只有一个人在线：计时模式
  const first = await act(roomId, 'tester1', '去后厨找阿福 [分钟 20] [移动 kitchen]');
  assert.equal(first.data.action.mode, 'timed');
  await t.app.engine.idle();

  // 另一个人也来了：转成回合模式，要等他也提交
  const b = await t.openStream(`/api/rooms/${roomId}/events`, cookies.admin);
  await b.waitFor((e) => e.event === 'presence' && e.data.mode === 'round');
  const waitingRound = await game(roomId, 'tester1');
  assert.equal(waitingRound.mode, 'round');
  assert.equal(waitingRound.myAction.mode, 'round');
  assert.equal(waitingRound.round.waitingFor.length, 1);
  assert.equal(waitingRound.clock.running, false, '回合模式下时钟停着');

  await act(roomId, 'admin', '搜查刘贵的房间 [分钟 40]');
  await t.app.engine.idle();
  const done = await game(roomId, 'tester1');
  assert.equal(done.myAction, null);
  assert.equal(Math.round(done.clock.minutes), 22 * 60 + 40, '一轮结束后时钟跳过这一轮最长的行动');
  assert.equal(done.round.number, 2);

  // 有人离开：转回计时模式，已经提交的回合行动变成计时行动
  await act(roomId, 'tester1', '和阿福聊聊 [分钟 10]');
  await t.app.engine.idle();
  const mark = a.events.length;
  b.close();
  await a.waitFor((e) => e.event === 'presence' && e.data.mode === 'timed', mark);
  const timed = await game(roomId, 'tester1');
  assert.equal(timed.myAction.mode, 'timed');
  assert.equal(timed.myAction.dueAt - timed.myAction.submittedAt, 15 * MIN);
  a.close();
  // 收尾：结束这一局，免得留下的行动影响后面的测试
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
  assert.equal((await game(roomId, 'tester1')).myAction, null, '结束时等待中的行动一起取消');
});

test('AI出错：可以重试的错误自动重试，重试几次还不行就标成失败，玩家可以手动重试', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  await act(roomId, 'tester1', '撬开账房的铁皮柜 [分钟 20] [会出错]');
  await t.app.engine.idle();
  failures = [new AiError('Claude 那边限流了', true), new AiError('Claude 那边限流了', true), new AiError('Claude 那边限流了', true)];
  now += 21 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  let mine = (await game(roomId, 'tester1')).myAction;
  assert.equal(mine.status, 'waiting');
  assert.equal(mine.error, 'Claude 那边限流了');

  now += 2 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  now += 6 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  mine = (await game(roomId, 'tester1')).myAction;
  assert.equal(mine.status, 'failed');
  assert.ok((await log(roomId, 'tester1')).some((e) => e.kind === 'system' && e.private && e.text.includes('没能结算')));
  // 失败的行动挡着，不能直接交新的
  assert.equal((await act(roomId, 'tester1', '换个做法')).status, 409);

  const retried = await t.call('POST', `/api/rooms/${roomId}/actions/${mine.id}/retry`, undefined, cookies.tester1);
  assert.equal(retried.status, 200);
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester1')).myAction, null);

  // 不能重试的错误（比如密钥不对）直接标成失败；可以撤回
  await act(roomId, 'tester1', '再去一次账房 [分钟 20] [会出错]');
  await t.app.engine.idle();
  failures = [new AiError('Claude 的 API 密钥不对', false)];
  now += 21 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  mine = (await game(roomId, 'tester1')).myAction;
  assert.equal(mine.status, 'failed');
  assert.equal((await t.call('DELETE', `/api/rooms/${roomId}/actions/${mine.id}`, undefined, cookies.tester1)).status, 200);
  assert.equal((await game(roomId, 'tester1')).myAction, null);
});

test('暂停时时间不走，继续以后等待中的行动顺延', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  await act(roomId, 'tester1', '去码头 [分钟 30]');
  await t.app.engine.idle();
  now += 10 * MIN;
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'paused' }, cookies.tester1)).status, 200);
  assert.equal((await act(roomId, 'tester1', '暂停时行动')).status, 409);
  const frozen = (await game(roomId, 'tester1')).clock;
  now += 60 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const paused = await game(roomId, 'tester1');
  assert.equal(paused.myAction.status, 'waiting');
  assert.equal(paused.clock.minutes, frozen.minutes);

  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, cookies.tester1)).status, 200);
  const resumed = (await game(roomId, 'tester1')).myAction;
  assert.equal(resumed.dueAt - resumed.submittedAt, 90 * MIN);
  now += 19 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester1')).myAction.status, 'waiting');
  now += 2 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester1')).myAction, null);
});

test('受伤到死亡；主持AI宣布结局后对局结束，所有人看到结局和真相', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
  ]);
  await act(roomId, 'tester2', '和刘贵打一架 [分钟 15] [受伤 2] [NPC liu]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const hurt = await game(roomId, 'tester2');
  assert.equal(hurt.me.wounds, 2);
  assert.ok((await log(roomId, 'tester2')).find((e) => e.data?.type === 'resolution').data.changes.includes('伤势：没受伤 → 重伤'));
  const world = JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string }).world);
  assert.equal(world.npcs.liu.attitude, '起了疑心');

  await act(roomId, 'tester2', '再打一架 [分钟 15] [受伤 2]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const dead = await game(roomId, 'tester2');
  assert.equal(dead.me.dead, true);
  assert.equal(dead.me.blocked, '这个角色已经死了');
  assert.equal((await act(roomId, 'tester2', '我还想动')).status, 409);

  await act(roomId, 'tester1', '把证据交给陆探长 [分钟 30] [结局 truth]');
  await t.app.engine.idle();
  now += 31 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const ended = await game(roomId, 'tester2');
  assert.equal(ended.ending.title, '真相大白');
  assert.ok(ended.ending.truth.includes('刘疤子'));
  const room = await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.tester2);
  assert.equal(room.data.room.status, 'ended');
  const endingEntry = (await log(roomId, 'tester2')).find((e) => e.data?.type === 'ending');
  assert.ok(endingEntry && !endingEntry.private);
});

test('场外问主持人：问题和回答只有自己看得到，不消耗时间', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
  ]);
  const before = (await game(roomId, 'tester1')).clock.minutes;
  const asked = await t.call('POST', `/api/rooms/${roomId}/ask`, { question: '大堂有几扇门？' }, cookies.tester1);
  assert.equal(asked.status, 202);
  await t.app.engine.idle();
  const mine = await log(roomId, 'tester1');
  assert.ok(mine.some((e) => e.data?.type === 'question' && e.private && e.text === '大堂有几扇门？'));
  assert.ok(mine.some((e) => e.data?.type === 'answer' && e.text === '回答：大堂有几扇门？'));
  assert.ok(!(await log(roomId, 'tester2')).some((e) => e.data?.type === 'question' || e.data?.type === 'answer'));
  assert.equal((await game(roomId, 'tester1')).clock.minutes, before);
  // 问答用的是玩家已知的信息，不带剧本真相
  const request = fake.requests.findLast((r) => !r.tools?.length && !r.output_config?.format)!;
  assert.ok(!JSON.stringify(request).includes('刘疤子'));
});

test('中途加入：对局开始后新成员建角色，直接进入故事', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  const room = await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.tester1);
  assert.equal((await t.call('POST', '/api/rooms/join', { code: room.data.room.joinCode }, cookies.tester2)).status, 200);
  const created = await t.call('PUT', `/api/rooms/${roomId}/character`, detective, cookies.tester2);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.me.location.key, 'guest-rooms');
  assert.ok((await log(roomId, 'tester2')).some((e) => e.data?.type === 'role'));
  // 开始以后不能再改
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/character`, { ...detective, name: '改名' }, cookies.tester2)).status, 409);
});

test('回合进行中有人的行动结算失败，其他人不会一直等下去', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
  ]);
  const a = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  await a.waitFor((e) => e.event === 'presence');
  // B 不在线时交了一个计时行动；到时间开始结算，AI 还在“思考”
  await act(roomId, 'tester2', '去码头找船老大 [分钟 20] [等一下] [会出错]');
  await t.app.engine.idle();
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  failures = [new AiError('Claude 的 API 密钥不对', false)];
  now += 21 * MIN;
  t.app.engine.tick();
  // 这时 B 打开了页面：全员在线，变成回合模式；A 交了行动，在等 B
  const b = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await b.waitFor((e) => e.event === 'presence' && e.data.mode === 'round');
  const mark = a.events.length;
  await act(roomId, 'tester1', '在大堂等着 [分钟 10]');
  await a.waitFor((e) => e.event === 'game', mark);
  assert.equal((await game(roomId, 'tester1')).myAction.status, 'waiting');
  // B 的行动结算失败：B 不再算这一轮的参与者，A 的行动应该马上结算
  open();
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester2')).myAction.status, 'failed');
  assert.equal((await game(roomId, 'tester1')).myAction, null, 'A 不用一直等');
  a.close();
  b.close();
  await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1);
});

test('房主删除对局时，几个人都开着页面也不会出错', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
    { who: 'admin', character: { ...detective, name: '老马', roleKey: 'customs' } },
  ]);
  const streams = await Promise.all(
    (['tester1', 'tester2', 'admin'] as const).map((who) => t.openStream(`/api/rooms/${roomId}/events`, cookies[who])),
  );
  await Promise.all(streams.map((s) => s.waitFor((e) => e.event === 'presence')));
  const errors: unknown[] = [];
  const onError = (err: unknown) => errors.push(err);
  process.on('uncaughtException', onError);
  try {
    assert.equal((await t.call('DELETE', `/api/rooms/${roomId}`, undefined, cookies.tester1)).status, 200);
    await Promise.all(streams.map((s) => s.waitFor((e) => e.event === 'deleted')));
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.off('uncaughtException', onError);
  }
  assert.deepEqual(errors, []);
});

test('被 Claude 安全机制拒绝的内容不再发（多人局）：不能重试只能撤回，估时被拒就不交给主持AI，标给管理员但不封号；调用带上匿名编号', async () => {
  const roomId = await startedRoom([
    { who: 'tester2', character: reporter },
    { who: 'tester3', character: detective },
  ]);
  const withdraw = (id: number) => t.call('DELETE', `/api/rooms/${roomId}/actions/${id}`, undefined, cookies.tester2);
  const flagged = () =>
    t.app.db.prepare("SELECT source, outcome, category FROM violations WHERE room_id = ? AND kind = 'refusal' ORDER BY id").all(roomId) as any[];

  // 结算时被拒绝：不自动重试，也不能手动重试，只能撤回
  fake.requests.length = 0;
  assert.equal((await act(roomId, 'tester2', '一件不该写的事 [分钟 10] [会被拒]')).status, 201);
  await pass(30);
  let state = await game(roomId, 'tester2');
  assert.equal(state.myAction.status, 'failed');
  assert.equal(state.myAction.refused, true);
  assert.equal(fake.requests.filter((r) => r.tools?.length).length, 1, '被拒绝以后不自动重试');
  const retry = await t.call('POST', `/api/rooms/${roomId}/actions/${state.myAction.id}/retry`, undefined, cookies.tester2);
  assert.equal(retry.status, 409);
  assert.match(retry.data.error, /不能重试/);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.kind === 'system' && e.text.includes('安全机制') && e.text.includes('撤回')));
  assert.equal((await withdraw(state.myAction.id)).status, 200);
  // 多人局里发给 AI 的内容混着别人的：只标给管理员看，不封号
  assert.deepEqual(flagged().map((v) => [v.source, v.outcome, v.category]), [['action', 'flagged', 'refusal:general_harms']]);

  // 估时这一步就被拒绝：同样的内容不再交给主持AI
  fake.requests.length = 0;
  assert.equal((await act(roomId, 'tester2', '另一件不该写的事 [估时被拒]')).status, 201);
  await t.app.engine.idle();
  state = await game(roomId, 'tester2');
  assert.equal(state.myAction.refused, true);
  assert.equal(fake.requests.length, 1, '只有估时那一次请求');
  assert.equal((await withdraw(state.myAction.id)).status, 200);
  assert.equal(flagged().length, 2);

  // 正常的行动照常结算，账号也没被封
  assert.equal((await act(roomId, 'tester2', '在大堂里四处看看 [分钟 10]')).status, 201);
  await pass(30);
  assert.equal((await game(roomId, 'tester2')).myAction, null);

  // 每次调用都带上这个玩家的匿名编号（随机的，不是用户名），AI 调用记录里也记下是替谁做的
  const user = t.app.db.prepare("SELECT id, ai_ref FROM users WHERE username = 'tester2'").get() as { id: number; ai_ref: string };
  assert.match(user.ai_ref, /^[0-9a-f]{32}$/);
  const sent = fake.requests.map((r) => r.metadata?.user_id);
  assert.ok(sent.length >= 2 && sent.every((id) => id === user.ai_ref), JSON.stringify(sent));
  const calls = t.app.db
    .prepare("SELECT user_id, stop_reason FROM ai_calls WHERE room_id = ? AND purpose != 'moderation'")
    .all(roomId) as { user_id: number; stop_reason: string }[];
  assert.ok(calls.every((c) => c.user_id === user.id));
  assert.equal(calls.filter((c) => c.stop_reason === 'refusal').length, 2);
});

/** 注册一个新账号（用管理员发的邀请码），返回登录用的 cookie。封号的测试用它，免得影响别的测试。 */
async function newUser(username: string): Promise<string> {
  const invite = await t.call('POST', '/api/admin/invites', { note: username }, cookies.admin);
  const r = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username,
    displayName: username,
    password: `${username}-pass-1`,
    agreeRules: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.cookie!;
}

test('违规：第一次警告、第二次封号（内容检查查出违规、单人局的行动被拒、场外提问被拒都算）；管理员标成误判的不算；管理员只拦下', async () => {
  const banned = (username: string) =>
    t.app.db.prepare('SELECT banned_at, ban_reason FROM users WHERE username = ?').get(username) as { banned_at: number | null; ban_reason: string | null };
  const violations = (username: string) =>
    (t.app.db.prepare('SELECT v.kind, v.source, v.outcome FROM violations v JOIN users u ON u.id = v.user_id WHERE u.username = ? ORDER BY v.id').all(username) as any[]).map(
      (v) => ({ ...v }),
    );
  const warnings = (cookie: string) =>
    t.call('GET', '/api/notifications', undefined, cookie).then((r) => (r.data.items as any[]).filter((n) => n.kind === 'violation_warning'));

  // 1. 发给 AI 之前的检查查出违规：不发给主持 AI。第一次警告（通知里也有），登录还在、在等的行动照常
  const c1 = await newUser('rulebreaker1');
  const room1 = await t.call('POST', '/api/rooms', { name: '违规测试一', maxPlayers: 2 }, c1);
  const r1 = room1.data.room.id;
  // 同一局里还有一个人一直不在线：他自己打开页面时也是计时模式，在等的行动不会马上结算
  const bystander = await newUser('bystander1');
  assert.equal((await t.call('POST', '/api/rooms/join', { code: room1.data.room.joinCode }, bystander)).status, 200);
  await t.call('POST', `/api/rooms/${r1}/scenario`, { key: 'fog-harbor-inn' }, c1);
  assert.equal((await t.call('PUT', `/api/rooms/${r1}/character`, reporter, c1)).status, 200);
  assert.equal((await t.call('PUT', `/api/rooms/${r1}/character`, detective, bystander)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${r1}/status`, { status: 'running' }, c1)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${r1}/actions`, { content: '在大堂里坐一会儿 [分钟 60]' }, c1)).status, 201);
  await t.app.engine.idle();
  const events = await t.openStream(`/api/rooms/${r1}/events`, c1);
  fake.requests.length = 0;
  const first = await t.call('POST', `/api/rooms/${r1}/ask`, { question: '一个不该问的问题 [违规]' }, c1);
  assert.equal(first.status, 403);
  assert.equal(first.data.error, '这段内容违反使用规则（其他违反使用政策的内容），没有发给 AI。这是警告，再违反一次账号会被封禁。');
  assert.equal(fake.requests.length, 0, '违规的内容没有发给主持 AI');
  assert.equal(banned('rulebreaker1').banned_at, null, '第一次不封号');
  assert.deepEqual(violations('rulebreaker1'), [{ kind: 'precheck', source: 'question', outcome: 'warned' }]);
  assert.equal((await warnings(c1)).length, 1, '通知里有一条警告');
  assert.equal((await t.call('GET', '/api/auth/me', undefined, c1)).data.user.username, 'rulebreaker1', '登录还在');

  // 第二次：封号，登录失效，在等的行动撤回，推送断开
  const second = await t.call('POST', `/api/rooms/${r1}/ask`, { question: '又一个不该问的问题 [违规]' }, c1);
  assert.equal(second.status, 403);
  assert.match(second.data.error, /违反使用规则.*封禁/);
  assert.ok(banned('rulebreaker1').banned_at);
  assert.match(banned('rulebreaker1').ban_reason!, /场外提问.*第二次违规/);
  assert.deepEqual(violations('rulebreaker1'), [
    { kind: 'precheck', source: 'question', outcome: 'warned' },
    { kind: 'precheck', source: 'question', outcome: 'banned' },
  ]);
  assert.equal((await t.call('GET', '/api/auth/me', undefined, c1)).data.user, null, '登录失效了');
  assert.equal((await t.call('GET', `/api/rooms/${r1}/game`, undefined, c1)).status, 401);
  const relogin = await t.call('POST', '/api/auth/login', { username: 'rulebreaker1', password: 'rulebreaker1-pass-1' });
  assert.equal(relogin.status, 403);
  assert.match(relogin.data.error, /封禁/);
  const wrongPassword = await t.call('POST', '/api/auth/login', { username: 'rulebreaker1', password: 'wrong-password' });
  assert.equal(wrongPassword.status, 401, '密码不对时不说被封了');
  const action = t.app.db
    .prepare(
      `SELECT a.status FROM actions a JOIN characters ch ON ch.id = a.character_id JOIN players p ON p.id = ch.player_id JOIN users u ON u.id = p.user_id
       WHERE a.room_id = ? AND u.username = 'rulebreaker1'`,
    )
    .get(r1) as { status: string };
  assert.equal(action.status, 'withdrawn', '在等的行动撤回了');
  assert.equal(t.app.hub.isOnline(r1, (t.app.db.prepare("SELECT id FROM users WHERE username = 'rulebreaker1'").get() as { id: number }).id), false, '推送断开了');
  events.close();

  // 2. 单人局的行动被 Claude 拒绝：内容只来自他一个人，算一次（他多半不在场，用通知告诉他）；再被拒绝一次，封号
  const c2 = await newUser('rulebreaker2');
  const room2 = (await t.call('POST', '/api/rooms', { name: '违规测试二', maxPlayers: 1 }, c2)).data.room.id;
  await t.call('POST', `/api/rooms/${room2}/scenario`, { key: 'fog-harbor-inn' }, c2);
  await t.call('PUT', `/api/rooms/${room2}/character`, reporter, c2);
  await t.call('POST', `/api/rooms/${room2}/status`, { status: 'running' }, c2);
  assert.equal((await t.call('POST', `/api/rooms/${room2}/actions`, { content: '一件不该写的事 [分钟 10] [会被拒]' }, c2)).status, 201);
  await pass(30);
  assert.equal(banned('rulebreaker2').banned_at, null);
  assert.deepEqual(violations('rulebreaker2'), [{ kind: 'refusal', source: 'action', outcome: 'warned' }]);
  assert.match((await warnings(c2))[0].data.message, /角色的行动被 AI 的安全机制拒绝了，算一次违规。这是警告/);
  const refused = (await t.call('GET', `/api/rooms/${room2}/game`, undefined, c2)).data.myAction;
  assert.equal((await t.call('DELETE', `/api/rooms/${room2}/actions/${refused.id}`, undefined, c2)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${room2}/actions`, { content: '又一件不该写的事 [分钟 10] [会被拒]' }, c2)).status, 201);
  await pass(30);
  assert.ok(banned('rulebreaker2').banned_at);
  assert.equal(violations('rulebreaker2')[1].outcome, 'banned');
  assert.equal((await t.call('GET', '/api/auth/me', undefined, c2)).data.user, null);

  // 3. 场外提问被 Claude 拒绝：问题只有他自己写的内容，算一次；管理员标成误判以后不算，下一次还是警告
  const c3 = await newUser('rulebreaker3');
  const room3 = (await t.call('POST', '/api/rooms', { name: '违规测试三', maxPlayers: 2 }, c3)).data.room.id;
  await t.call('POST', `/api/rooms/${room3}/scenario`, { key: 'fog-harbor-inn' }, c3);
  await t.call('PUT', `/api/rooms/${room3}/character`, reporter, c3);
  await t.call('POST', `/api/rooms/${room3}/status`, { status: 'running' }, c3);
  assert.equal((await t.call('POST', `/api/rooms/${room3}/ask`, { question: '问一个不该问的 [会被拒]' }, c3)).status, 202);
  await t.app.engine.idle();
  assert.equal(banned('rulebreaker3').banned_at, null);
  assert.deepEqual(violations('rulebreaker3'), [{ kind: 'refusal', source: 'question', outcome: 'warned' }]);
  const record = (await t.call('GET', '/api/admin/violations', undefined, cookies.admin)).data.violations.find((v: any) => v.user?.username === 'rulebreaker3');
  assert.equal((await t.call('POST', `/api/admin/violations/${record.id}/review`, { dismiss: true }, cookies.admin)).status, 200);
  assert.equal((await t.call('GET', '/api/admin/violations', undefined, cookies.admin)).data.violations.find((v: any) => v.id === record.id).dismissed, true);
  const again = await t.call('POST', `/api/rooms/${room3}/ask`, { question: '再问一个 [违规]' }, c3);
  assert.equal(again.status, 403);
  assert.match(again.data.error, /这是警告/);
  assert.equal(banned('rulebreaker3').banned_at, null, '误判的那一次不算，这一次还是警告');

  // 3b. 被拒绝的类别是「推理提取」：是网站提示词的问题，单人局也不算违规，只标给管理员看
  const c4 = await newUser('promptissue');
  const room4 = (await t.call('POST', '/api/rooms', { name: '提示词问题', maxPlayers: 1 }, c4)).data.room.id;
  await t.call('POST', `/api/rooms/${room4}/scenario`, { key: 'fog-harbor-inn' }, c4);
  await t.call('PUT', `/api/rooms/${room4}/character`, reporter, c4);
  await t.call('POST', `/api/rooms/${room4}/status`, { status: 'running' }, c4);
  assert.equal((await t.call('POST', `/api/rooms/${room4}/actions`, { content: '想一想 [分钟 10] [推理被拒]' }, c4)).status, 201);
  await pass(30);
  assert.equal(banned('promptissue').banned_at, null);
  assert.deepEqual(violations('promptissue'), [{ kind: 'refusal', source: 'action', outcome: 'flagged' }]);
  assert.equal((await t.call('GET', `/api/rooms/${room4}/game`, undefined, c4)).data.myAction.refused, true);
  assert.equal((await warnings(c4)).length, 0, '不算违规，不警告');

  // 4. 管理员写了违规内容：照样拦下、记下，但不警告、不封号
  const adminRoom = await startedRoom([{ who: 'admin', character: doctor }]);
  const blocked = await act(adminRoom, 'admin', '违规的行动 [违规]');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, '这段内容违反使用规则（其他违反使用政策的内容），没有发给 AI');
  assert.equal(banned('admin').banned_at, null);
  assert.deepEqual(violations('admin'), [{ kind: 'precheck', source: 'action', outcome: 'blocked' }]);
  assert.equal((await game(adminRoom, 'admin')).me.name, '许医生', '管理员的登录还在');

  // 5. 角色名起得违规：同样拦下，算一次；名字没变的不用再检查
  const c5 = await newUser('rulebreaker5');
  const room5 = (await t.call('POST', '/api/rooms', { name: '违规测试五', maxPlayers: 2 }, c5)).data.room.id;
  await t.call('POST', `/api/rooms/${room5}/scenario`, { key: 'fog-harbor-inn' }, c5);
  const checksBefore = fake.guardRequests.length;
  assert.equal((await t.call('PUT', `/api/rooms/${room5}/character`, reporter, c5)).status, 200);
  assert.equal((await t.call('PUT', `/api/rooms/${room5}/character`, reporter, c5)).status, 200);
  assert.equal(fake.guardRequests.length, checksBefore + 1, '名字没变的不用再检查');
  const badSheet = await t.call('PUT', `/api/rooms/${room5}/character`, { ...reporter, name: '[违规]' }, c5);
  assert.equal(badSheet.status, 403);
  assert.equal(banned('rulebreaker5').banned_at, null);
  assert.deepEqual(violations('rulebreaker5')[0], { kind: 'precheck', source: 'character', outcome: 'warned' });
});

test('分享线索：不在同一个地点也能告诉别人，记录只有当事人看得到，主持AI也知道他们知道了', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter }, // 大堂
    { who: 'tester2', character: detective }, // 二楼客房
    { who: 'admin', character: doctor }, // 大堂
  ]);
  await act(roomId, 'tester1', '在大堂里四处看看 [分钟 15] [线索 missing-lantern]');
  await pass(16);
  const mine = await game(roomId, 'tester1');
  assert.deepEqual(
    mine.clues.map((c: any) => [c.key, c.from]),
    [['missing-lantern', null]],
  );
  const detectiveId = mine.others.find((o: any) => o.name === '沈探').id;

  // 不知道的线索不能分享，只能告诉这一局里的其他角色
  assert.equal((await share(roomId, 'tester1', 'register', [detectiveId])).status, 404);
  assert.equal((await share(roomId, 'tester1', 'missing-lantern', [mine.me.id])).status, 400);
  assert.equal((await share(roomId, 'tester1', 'missing-lantern', [])).status, 400);
  assert.equal((await share(roomId, 'tester2', 'missing-lantern', [mine.me.id])).status, 404, '侦探还不知道这条线索');

  // 记者在大堂、侦探在二楼：不在一起也能告诉他，不算行动
  const shared = await share(roomId, 'tester1', 'missing-lantern', [detectiveId]);
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  assert.deepEqual(shared.data.sharedWith, ['沈探']);
  assert.equal((await game(roomId, 'tester1')).myAction, null);
  assert.deepEqual(
    (await game(roomId, 'tester2')).clues.map((c: any) => [c.key, c.from]),
    [['missing-lantern', '林小满']],
  );
  assert.deepEqual((await game(roomId, 'admin')).clues, [], '没告诉的人不知道');
  const shareEntry = async (who: keyof typeof cookies) => (await log(roomId, who)).find((e) => e.data?.type === 'share');
  assert.equal((await shareEntry('tester1')).text, '林小满把线索「少了一盏马灯」告诉了沈探');
  assert.ok(await shareEntry('tester2'));
  assert.equal(await shareEntry('admin'), undefined, '这条记录只有分享的人和收到的人看得到');

  // 告诉全队：所有还活着的其他角色
  const toAll = await share(roomId, 'tester2', 'missing-lantern', 'all');
  assert.deepEqual([...toAll.data.sharedWith].sort(), ['林小满', '许医生'].sort());
  assert.deepEqual(
    (await game(roomId, 'admin')).clues.map((c: any) => [c.key, c.from]),
    [['missing-lantern', '沈探']],
  );
  assert.deepEqual(
    (await game(roomId, 'tester1')).clues.map((c: any) => c.from),
    [null],
    '自己找到的还是算自己找到的',
  );

  // 主持AI结算下一个行动时，知道三个人都知道这条线索
  fake.requests.length = 0;
  await act(roomId, 'tester2', '回房间想想 [分钟 15]');
  await pass(16);
  const context = lastUserText(fake.requests.find((r) => r.tools?.length)!);
  const line = context.split('\n').find((l) => l.includes('missing-lantern「')) ?? '';
  for (const name of ['林小满', '沈探', '许医生']) assert.ok(line.includes(name), line);

  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
  assert.equal((await share(roomId, 'tester1', 'missing-lantern', 'all')).status, 409, '结束以后不能再分享');
});

test('你不在时发生了什么：离开以后自己角色知道的事，回来先看到；事情多了AI写摘要，写过的不重写', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter }, // 大堂
    { who: 'tester2', character: detective }, // 二楼客房
  ]);
  const catchup = async () => (await t.call('GET', `/api/rooms/${roomId}/catchup`, undefined, cookies.tester1)).data;
  assert.equal((await catchup()).afterId, null, '还没离开过，没有要补的');

  // 记者打开页面、交了一个行动，然后离开
  const first = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  await first.waitFor((e) => e.event === 'presence');
  await act(roomId, 'tester1', '翻看大堂的登记簿 [分钟 15]');
  await t.app.engine.idle();
  first.close();
  const seen = () => t.app.db.prepare('SELECT seen_log_id FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? AND u.username = ?').get(roomId, 'tester1') as { seen_log_id: number | null };
  for (let i = 0; i < 50 && seen().seen_log_id === null; i++) await sleep(10);
  assert.notEqual(seen().seen_log_id, null);

  // 他不在的时候：自己的行动出了结果；侦探在二楼行动（他看不到）、在场外说了话
  await act(roomId, 'tester2', '在二楼翻刘贵的行李 [分钟 15]');
  await pass(16);
  await t.call('POST', `/api/rooms/${roomId}/chat`, { text: '我在二楼' }, cookies.tester2);
  const few = await catchup();
  assert.equal(few.items.length, 1);
  assert.match(few.items[0].label, /^林小满：翻看大堂的登记簿/);
  assert.equal(few.chatCount, 1);
  assert.equal(few.summary, null);
  assert.equal(few.summarizing, false, '事情少就直接列出来，不用AI写摘要');
  assert.ok(few.since !== null);

  // 又过了好几件事：AI写摘要，写好推过来
  for (let i = 0; i < 6; i++) {
    await act(roomId, 'tester1', `在大堂里转转，第${i + 1}次 [分钟 15]`);
    await pass(16);
  }
  const stream = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  await stream.waitFor((e) => e.event === 'presence');
  fake.requests.length = 0;
  const many = await catchup();
  assert.equal(many.items.length, 6, '只列最近几件');
  assert.equal(many.more, 1);
  assert.equal(many.summarizing, true);
  const pushed = await stream.waitFor((e) => e.event === 'catchup');
  assert.equal(pushed.data.summary, '摘要：离开期间发生了7件事');
  const asked = fake.requests.filter((r) => r.system?.[0]?.text.includes('补课'));
  assert.equal(asked.length, 1);
  const material = lastUserText(asked[0]);
  assert.ok(material.includes('翻看大堂的登记簿'));
  assert.ok(!material.includes('翻刘贵的行李'), '摘要只用他自己角色知道的事');
  assert.equal(asked[0].metadata?.user_id?.length, 32, '摘要算他自己的调用');

  // 同一段不重写
  const summaries = () => fake.requests.filter((r) => r.system?.[0]?.text.includes('补课')).length;
  const again = await catchup();
  assert.equal(again.summary, '摘要：离开期间发生了7件事');
  assert.equal(again.summarizing, false);
  assert.equal(summaries(), 1);

  // 回来以后他在线看着又出了结果：页面带着 until 再问，还是原来那一段，不把在线看到的算进去，也不重写
  await act(roomId, 'tester1', '在大堂里再转一圈 [分钟 15]');
  await pass(16);
  const pinned = (await t.call('GET', `/api/rooms/${roomId}/catchup?until=${many.untilId}`, undefined, cookies.tester1)).data;
  assert.equal(pinned.untilId, many.untilId);
  assert.equal(pinned.summary, '摘要：离开期间发生了7件事');
  assert.equal(summaries(), 1);

  // 再离开一次：分界线挪到离开那一刻；这次摘要写不成，同一段不再重试，只给列表
  const lastSeen = seen().seen_log_id;
  stream.close();
  for (let i = 0; i < 50 && seen().seen_log_id === lastSeen; i++) await sleep(10);
  assert.ok(seen().seen_log_id! > lastSeen!);
  assert.equal((await catchup()).items.length, 0, '离开以前在线看到的不算');
  for (let i = 0; i < 7; i++) {
    await act(roomId, 'tester1', `去后院转转，第${i + 1}次 [分钟 15]`);
    await pass(16);
  }
  failures = [new AiError('模拟摘要失败', false)];
  assert.equal((await catchup()).summarizing, true);
  await t.app.engine.idle();
  const failed = await catchup();
  assert.equal(failed.summarizing, false);
  assert.equal(failed.summary, null);
  assert.equal(failed.items.length, 6);
  assert.equal(summaries(), 2, '失败过的那一段不再重试');
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
});

test('我的对局的待办：开局前该谁做什么、行动倒计时和出结果、离开以后的新进展和聊天，有动静会通知', async () => {
  const todoOf = async (who: keyof typeof cookies, roomId: number) => {
    const r = await t.call('GET', '/api/rooms', undefined, cookies[who]);
    assert.equal(r.data.now, now, '带上服务器时间，倒计时用');
    return r.data.rooms.find((x: any) => x.id === roomId).todo;
  };
  const room = await createRoom('tester1', { name: '待办' });
  assert.equal((await t.call('POST', '/api/rooms/join', { code: room.code }, cookies.tester2)).status, 200);
  assert.equal((await todoOf('tester1', room.id)).setup, 'pick-scenario');
  assert.equal((await todoOf('tester2', room.id)).setup, 'wait-scenario');
  await t.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester1);
  assert.equal((await todoOf('tester1', room.id)).setup, 'make-character');
  await t.call('PUT', `/api/rooms/${room.id}/character`, reporter, cookies.tester1);
  assert.equal((await todoOf('tester1', room.id)).setup, 'start');
  assert.equal((await todoOf('tester2', room.id)).setup, 'make-character');
  await t.call('PUT', `/api/rooms/${room.id}/character`, detective, cookies.tester2);
  assert.equal((await todoOf('tester2', room.id)).setup, 'wait-start');
  assert.equal((await t.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, cookies.tester1)).status, 200);

  let todo = await todoOf('tester1', room.id);
  assert.equal(todo.setup, null);
  assert.equal(todo.canAct, true);
  assert.equal(todo.action, null);

  // 打开过这一局再离开，之后的才算“没看过的”
  const visit = await t.openStream(`/api/rooms/${room.id}/events`, cookies.tester1);
  await visit.waitFor((e) => e.event === 'presence');
  visit.close();
  const seen = () => t.app.db.prepare('SELECT seen_log_id FROM players WHERE room_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)').get(room.id, 'tester1') as { seen_log_id: number | null };
  for (let i = 0; i < 50 && seen().seen_log_id === null; i++) await sleep(10);

  // 交了行动：显示什么时候出结果
  await act(room.id, 'tester1', '翻看大堂的登记簿 [分钟 15]');
  await t.app.engine.idle();
  todo = await todoOf('tester1', room.id);
  assert.equal(todo.canAct, false);
  assert.equal(todo.action.status, 'waiting');
  assert.equal(todo.action.mode, 'timed');
  assert.ok(todo.action.dueAt > now);

  // 他在“我的对局”页面：行动出了结果会通知
  const lobby = await t.openStream('/api/events', cookies.tester1);
  await sleep(50);
  const from = lobby.events.length;
  await t.call('POST', `/api/rooms/${room.id}/chat`, { text: '我先去二楼' }, cookies.tester2);
  await act(room.id, 'tester2', '在二楼翻刘贵的行李 [分钟 15]');
  await pass(16);
  await lobby.waitFor((e) => e.event === 'room-activity' && e.data.roomId === room.id, from);
  lobby.close();

  todo = await todoOf('tester1', room.id);
  assert.equal(todo.action, null);
  assert.equal(todo.canAct, true);
  assert.equal(todo.newResults, 1);
  assert.equal(todo.newStory, 1, '侦探在二楼的行动他看不到，不算');
  assert.equal(todo.newChat, 1);
  assert.equal((await todoOf('tester2', room.id)).newChat, 0, '自己发的聊天不算');

  // 打开这一局的页面时，新消息都看着呢
  const back = await t.openStream(`/api/rooms/${room.id}/events`, cookies.tester1);
  await back.waitFor((e) => e.event === 'presence');
  todo = await todoOf('tester1', room.id);
  assert.equal(todo.newResults + todo.newStory + todo.newChat, 0);
  back.close();

  // 出错的行动要他处理
  failures = [new AiError('模拟出错', false)];
  await act(room.id, 'tester1', '再翻一遍 [会出错] [分钟 15]');
  await pass(16);
  todo = await todoOf('tester1', room.id);
  assert.equal(todo.action.status, 'failed');
  assert.equal(todo.canAct, false);
  assert.equal((await t.call('POST', `/api/rooms/${room.id}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
});

test('主持人的长期记忆：经历多了把早的并进笔记，结算时看笔记加笔记之后的原文；写不成下次再试', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  const room = () =>
    t.app.db.prepare('SELECT story_summary, summary_until_log_id FROM rooms WHERE id = ?').get(roomId) as { story_summary: string; summary_until_log_id: number };
  const notes = () => fake.requests.filter((r) => r.system?.[0]?.text.includes('整理笔记'));
  const dmContexts = () => fake.requests.filter((r) => r.tools?.length && r.messages.length === 1).map(lastUserText);
  const doThing = async (i: number) => {
    assert.equal((await act(roomId, 'tester1', `第${i}件事 [分钟 15]`)).status, 201);
    await pass(16);
  };
  fake.requests.length = 0;

  // 攒到13条还不并：主持AI看到的是全部原文
  for (let i = 1; i <= 13; i++) await doThing(i);
  assert.equal(notes().length, 0);
  assert.equal(room().story_summary, '');
  const thirteenth = dmContexts().at(-1)!;
  assert.ok(thirteenth.includes('行动：「第1件事') && thirteenth.includes('行动：「第12件事'));
  assert.ok(!thirteenth.includes('# 更早的剧情'));

  // 第14条：最近8条以外的（第1～6件）并进笔记，笔记里写着谁知道
  await doThing(14);
  assert.equal(notes().length, 1);
  assert.equal(room().story_summary, '笔记：第1件事、第2件事、第3件事、第4件事、第5件事、第6件事');
  const material = lastUserText(notes()[0]);
  assert.ok(material.includes('知道的人：林小满'));
  assert.ok(material.includes('# 之前的笔记\n（还没有）'));
  assert.ok(!material.includes('第7件事'));
  assert.equal(notes()[0].metadata, undefined, '大家共用的调用，不带某个玩家的编号');

  // 下一次结算：笔记加上第7件以后的原文
  fake.requests.length = 0;
  await doThing(15);
  const next = dmContexts()[0];
  assert.ok(next.includes('# 更早的剧情（主持人的笔记，从早到晚）\n笔记：第1件事'));
  assert.ok(!next.includes('行动：「第1件事') && !next.includes('行动：「第6件事'));
  assert.ok(next.includes('行动：「第7件事') && next.includes('行动：「第14件事'));

  // 又攒够了，但这次写笔记失败：笔记不变，原文一条不少
  fake.requests.length = 0;
  failures = [new AiError('模拟写笔记失败', false)];
  for (let i = 16; i <= 20; i++) await doThing(i);
  assert.equal(notes().length, 1);
  assert.equal(room().story_summary, '笔记：第1件事、第2件事、第3件事、第4件事、第5件事、第6件事');
  await doThing(21);
  const afterFailure = dmContexts().at(-1)!;
  assert.ok(afterFailure.includes('行动：「第7件事') && afterFailure.includes('行动：「第20件事'));

  // 过了一阵再结算时重试：这次成了，并进去的是最近8条以外的全部
  assert.equal(notes().length, 2);
  assert.equal(
    room().story_summary,
    '笔记：第1件事、第2件事、第3件事、第4件事、第5件事、第6件事、第7件事、第8件事、第9件事、第10件事、第11件事、第12件事、第13件事',
  );
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
});

test('六人满员：全员在线是回合模式，六个人都交了才一起结算，各自只看到同一地点的；有人掉线转计时，回来再转回合', async () => {
  const six = [
    { who: 'admin', character: reporter }, // 大堂
    { who: 'tester1', character: doctor }, // 大堂
    { who: 'tester2', character: detective }, // 二楼客房
    { who: 'tester3', character: customs }, // 大堂
    { who: 'tester4', character: youngMaster }, // 二楼客房
    { who: 'tester5', character: sailor }, // 大堂
  ] as const;
  const roomId = await startedRoom([...six]);

  // 满员了：第七个人进不来
  const code = (await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.admin)).data.room.joinCode;
  const seventh = await t.call('POST', '/api/auth/register', {
    inviteCode: t.inviteCode,
    username: 'seventh',
    displayName: '第七个人',
    password: 'seventh-pass-1',
    agreeRules: true,
  });
  assert.equal(seventh.status, 201, JSON.stringify(seventh.data));
  const seventhCookie = await t.login('seventh', 'seventh-pass-1');
  const full = await t.call('POST', '/api/rooms/join', { code }, seventhCookie);
  assert.equal(full.status, 409);
  assert.match(full.data.error, /满员/);

  // 六个人都打开页面：回合模式
  const streams = [];
  for (const p of six) streams.push(await t.openStream(`/api/rooms/${roomId}/events`, cookies[p.who]));
  await streams[0].waitFor((e) => e.event === 'presence' && e.data.mode === 'round' && e.data.online.length === 6);
  const state = await game(roomId, 'admin');
  assert.equal(state.mode, 'round');
  assert.equal(state.others.length, 5);
  const sailorId = state.others.find((c: any) => c.name === '阿海').id;

  // 前五个人交了行动：都在等第六个人，时钟停着
  for (const [i, p] of six.slice(0, 5).entries()) {
    const r = await act(roomId, p.who, `第${i + 1}个人的行动 [分钟 ${10 + i * 5}] [检定]`);
    assert.equal(r.status, 201);
    assert.equal(r.data.action.mode, 'round');
  }
  await t.app.engine.idle();
  const waiting = await game(roomId, 'tester3');
  assert.deepEqual(waiting.round.waitingFor, [sailorId]);
  assert.equal(waiting.round.submitted.length, 5);
  assert.equal(waiting.myAction.status, 'waiting');
  assert.equal(waiting.clock.running, false);
  assert.equal((await log(roomId, 'admin')).filter((e) => e.data?.type === 'resolution').length, 0);

  // 第六个人交了：一起结算，时钟跳过这一轮最长的行动
  await act(roomId, 'tester5', '第6个人的行动 [分钟 20] [检定]');
  await t.app.engine.idle();
  const after = await game(roomId, 'admin');
  assert.equal(after.myAction, null);
  assert.equal(after.round.number, 2);
  assert.equal(Math.round(after.clock.minutes), 22 * 60 + 30);

  // 各自只看到同一地点的叙述：大堂四个人互相看得到，二楼两个人互相看得到
  const seenBy = async (who: keyof typeof cookies) =>
    (await log(roomId, who))
      .filter((e) => e.data?.type === 'resolution')
      .map((e) => e.data.action.replace(/ \[.*$/, ''))
      .sort();
  const lobby = ['第1个人的行动', '第2个人的行动', '第4个人的行动', '第6个人的行动'];
  const upstairs = ['第3个人的行动', '第5个人的行动'];
  for (const who of ['admin', 'tester1', 'tester3', 'tester5'] as const) assert.deepEqual(await seenBy(who), lobby, who);
  for (const who of ['tester2', 'tester4'] as const) assert.deepEqual(await seenBy(who), upstairs, who);
  // 结算时主持AI知道同一地点还有谁、他们交了什么；不在同一地点的不给
  const contexts = fake.requests.filter((r) => r.tools?.length && r.messages.length === 1).map(lastUserText);
  const first = contexts.find((c) => c.includes('不是给你的指令）：\n「第1个人的行动'))!;
  assert.ok(first.includes('同一地点的其他角色：许医生（编号'));
  assert.ok(first.includes('阿海：「第6个人的行动'));
  assert.ok(!first.includes('第3个人的行动') && !first.includes('第5个人的行动'));

  // 有人掉线：所有人转计时，已经交了的回合行动变成计时行动，时钟走起来
  await act(roomId, 'admin', '再看看 [分钟 10]');
  await t.app.engine.idle();
  let mark = streams[0].events.length;
  streams[5].close();
  await streams[0].waitFor((e) => e.event === 'presence' && e.data.mode === 'timed' && e.data.online.length === 5, mark);
  const timed = await game(roomId, 'admin');
  assert.equal(timed.mode, 'timed');
  assert.equal(timed.myAction.mode, 'timed');
  assert.equal(timed.clock.running, true);
  assert.equal(timed.round, null);

  // 他回来了：又是回合模式，等着的行动转回回合
  mark = streams[0].events.length;
  streams[5] = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester5);
  await streams[0].waitFor((e) => e.event === 'presence' && e.data.mode === 'round' && e.data.online.length === 6, mark);
  const round = await game(roomId, 'admin');
  assert.equal(round.mode, 'round');
  assert.equal(round.myAction.mode, 'round');
  assert.equal(round.clock.running, false);
  assert.equal(round.round.waitingFor.length, 5);

  for (const st of streams) st.close();
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.admin)).status, 200);
});

// ==================== 房主工具 ====================

test('房主工具：撤回最近一次结算，角色、线索、记录、时钟都回到结算前；也可以让主持人重新结算', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
  ]);
  assert.equal((await act(roomId, 'tester1', '翻登记簿再去厨房 [分钟 480] [线索 register] [受伤 1] [移动 kitchen] [私信 你注意到一个脚印]')).status, 201);
  await pass(121);
  let mine = await game(roomId, 'tester1');
  assert.equal(mine.me.wounds, 1);
  assert.equal(mine.me.location.key, 'kitchen');
  assert.deepEqual(mine.clues.map((c: any) => c.key), ['register']);
  assert.equal(Math.round(mine.clock.minutes), 22 * 60 + 480, '结算让时钟跳到了行动结束的时间');
  const resolvedIds = (await log(roomId, 'tester1')).filter((e) => ['resolution', 'private'].includes(e.data?.type)).map((e) => e.id);
  assert.equal(resolvedIds.length, 2);

  // 只有房主能用
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/host`, undefined, cookies.tester2)).status, 403);
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/host/undo`, {}, cookies.tester2)).status, 403);
  const view = (await t.call('GET', `/api/rooms/${roomId}/host`, undefined, cookies.tester1)).data;
  assert.equal(view.last.actor, '林小满');
  assert.equal(view.last.blocked, null);

  const stream = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/host/undo`, {}, cookies.tester1)).status, 200);
  const removed = await stream.waitFor((e) => e.event === 'log-removed');
  assert.deepEqual(removed.data.ids, resolvedIds, '开着页面的人那里也去掉了');
  mine = await game(roomId, 'tester1');
  assert.equal(mine.me.wounds, 0);
  assert.equal(mine.me.location.key, 'lobby');
  assert.deepEqual(mine.clues, []);
  assert.equal(mine.myAction, null, '撤回以后这个行动不算了，可以重新写');
  assert.equal(Math.round(mine.clock.minutes), 22 * 60 + 121, '跳过的时间退回去了，现实里过去的照样算');
  const entries = await log(roomId, 'tester1');
  assert.ok(!entries.some((e) => resolvedIds.includes(e.id)));
  assert.ok(entries.some((e) => e.kind === 'system' && e.text.includes('房主撤回了「林小满」上一次行动的结果')));
  assert.equal(t.app.db.prepare('SELECT COUNT(*) AS n FROM clues WHERE room_id = ?').get(roomId)!.n, 0);
  // 没有可以撤回的了
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/host`, undefined, cookies.tester1)).data.last, null);
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/host/undo`, {}, cookies.tester1)).status, 409);

  // 重新结算：按原来的行动再结算一次
  await act(roomId, 'tester1', '在大堂里四处看看 [分钟 15] [线索 missing-lantern]');
  await pass(16);
  fake.requests.length = 0;
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/host/undo`, { regenerate: true }, cookies.tester1)).status, 200);
  await t.app.engine.idle();
  assert.ok(fake.requests.some((r) => r.tools?.length), '又找主持人结算了一次');
  mine = await game(roomId, 'tester1');
  assert.deepEqual(mine.clues.map((c: any) => c.key), ['missing-lantern']);
  const after = await log(roomId, 'tester1');
  assert.equal(after.filter((e) => e.data?.type === 'resolution').length, 1, '只剩重新结算的那一次');
  assert.ok(after.some((e) => e.text.includes('让主持人重新结算')));

  // 结算进行中不能撤回
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  await act(roomId, 'tester1', '慢慢想一想 [分钟 15] [等一下]');
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await sleep(20);
  const busy = await t.call('POST', `/api/rooms/${roomId}/host/undo`, {}, cookies.tester1);
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /正在结算/);
  open();
  await t.app.engine.idle();
  stream.close();
});

test('房主工具：达成结局的结算也能撤回，对局回到进行中', async () => {
  const roomId = await startedRoom([{ who: 'tester1', character: reporter }]);
  await act(roomId, 'tester1', '把证据交给陆探长 [分钟 30] [结局 truth]');
  await pass(31);
  assert.equal((await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.tester1)).data.room.status, 'ended');
  const view = (await t.call('GET', `/api/rooms/${roomId}/host`, undefined, cookies.tester1)).data;
  assert.equal(view.last.ended, true);
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/host/undo`, {}, cookies.tester1)).status, 200);
  assert.equal((await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.tester1)).data.room.status, 'running');
  const state = await game(roomId, 'tester1');
  assert.equal(state.ending, null);
  assert.ok(!(await log(roomId, 'tester1')).some((e) => e.data?.type === 'ending' || e.text === '对局结束了'));
  assert.equal((await act(roomId, 'tester1', '在大堂里等一会儿 [分钟 15]')).status, 201, '又能交行动了');
  await pass(16);
});

test('房主工具：手动改角色的数值、游戏时间、线索归属；导出团录', async () => {
  const roomId = await startedRoom([
    { who: 'tester1', character: reporter },
    { who: 'tester2', character: detective },
  ]);
  await act(roomId, 'tester1', '去厨房看看 [分钟 15] [移动 kitchen] [线索 missing-lantern] [私信 柜台下面有张纸条]');
  await pass(16);
  const reporterId = (await game(roomId, 'tester1')).me.id;
  const detectiveId = (await game(roomId, 'tester2')).me.id;
  const edit = (who: keyof typeof cookies, id: number, body: unknown) => t.call('PUT', `/api/rooms/${roomId}/host/characters/${id}`, body, cookies[who]);

  // 角色的数值：只有房主能改
  assert.equal((await edit('tester2', detectiveId, { wounds: 1 })).status, 403);
  assert.equal((await edit('tester1', detectiveId, { wounds: 5 })).status, 400);
  const edited = await edit('tester1', detectiveId, { wounds: 2, items: ['手电筒'], conditions: [{ name: '发烧', effect: '头昏脑涨', penalty: -1 }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const det = (await game(roomId, 'tester2')).me;
  assert.equal(det.wounds, 2);
  assert.deepEqual(det.items, ['手电筒']);
  assert.equal(det.conditions[0].name, '发烧');
  // 具体改了什么只告诉角色的主人
  assert.ok((await log(roomId, 'tester2')).some((e) => e.text === '房主调整了你的角色：伤势：没受伤 → 重伤；得到：手电筒；状态：发烧'));
  const othersSee = await log(roomId, 'tester1');
  assert.ok(othersSee.some((e) => e.text === '房主调整了「沈探」的状态'));
  assert.ok(!othersSee.some((e) => e.text.includes('手电筒')));
  // 房主自己的角色直接看得到；别人的角色要点“查看”，记录里会告诉大家（一段时间里只记一次）
  const hostView = (await t.call('GET', `/api/rooms/${roomId}/host`, undefined, cookies.tester1)).data;
  assert.equal(hostView.characters.find((c: any) => c.id === detectiveId).state, null, '别人的状态不直接给');
  assert.ok(!JSON.stringify(hostView).includes('手电筒'));
  for (let i = 0; i < 2; i++) {
    const peek = (await t.call('GET', `/api/rooms/${roomId}/host?reveal=${detectiveId}`, undefined, cookies.tester1)).data;
    assert.deepEqual(peek.characters.find((c: any) => c.id === detectiveId).state.items, ['手电筒']);
  }
  const peekLogs = (await log(roomId, 'tester2')).filter((e) => e.text === '房主查看了「沈探」的状态');
  assert.equal(peekLogs.length, 1, '反复查看只记一次');
  // 位置：房主只能选这个角色去过的地方（列出所有地点会剧透）
  const places = hostView.characters.find((c: any) => c.id === reporterId).state.places;
  assert.deepEqual(places.map((p: any) => p.key), ['lobby', 'kitchen']);
  assert.equal((await edit('tester1', reporterId, { location: 'cellar' })).status, 400);
  assert.equal((await edit('tester1', reporterId, { location: 'lobby' })).status, 200);
  assert.equal((await game(roomId, 'tester1')).me.location.key, 'lobby');
  // 管理员（?full=1）可以挪到任何地方；测试管理员是站长，记录里写站长
  const admin = await t.call('PUT', `/api/rooms/${roomId}/host/characters/${reporterId}?full=1`, { location: 'cellar' }, cookies.admin);
  assert.equal(admin.status, 200);
  assert.ok((await log(roomId, 'tester1')).some((e) => e.text.includes('站长调整了你的角色：位置：大堂 → 地窖')));
  // 新写的物品、状态以后会发给主持 AI：同样先检查内容（管理员写了违规的也拦下，只是不封号）
  const badItem = await t.call('PUT', `/api/rooms/${roomId}/host/characters/${reporterId}?full=1`, { items: ['[违规]的东西'] }, cookies.admin);
  assert.equal(badItem.status, 403);
  assert.ok(!(await game(roomId, 'tester1')).me.items.includes('[违规]的东西'));

  // 游戏时间
  const clock = await t.call('PUT', `/api/rooms/${roomId}/host/clock`, { day: 2, time: '08:30' }, cookies.tester1);
  assert.equal(clock.status, 200);
  assert.equal(Math.round((await game(roomId, 'tester1')).clock.minutes), 1440 + 510);
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/host/clock`, { day: 2, time: '25:00' }, cookies.tester1)).status, 400);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.text === '房主把游戏时间调到了第2天 08:30'));

  // 线索归属：房主只看得到已经被找到的线索，而且要先点“查看”，记录里会告诉大家
  const hidden = (await t.call('GET', `/api/rooms/${roomId}/host/clues`, undefined, cookies.tester1)).data;
  assert.deepEqual(hidden, { clues: null, count: 1 });
  const clues = (await t.call('GET', `/api/rooms/${roomId}/host/clues?reveal=1`, undefined, cookies.tester1)).data.clues;
  assert.deepEqual(clues.map((c: any) => [c.key, c.holders]), [['missing-lantern', [reporterId]]]);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.text === '房主查看了已经找到的线索和它们的归属'));
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/host/clues/register`, { characterIds: [detectiveId] }, cookies.tester1)).status, 404, '没被找到的线索房主不能给');
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/host/clues/missing-lantern`, { characterIds: [detectiveId] }, cookies.tester1)).status, 200);
  assert.deepEqual((await game(roomId, 'tester1')).clues, []);
  assert.deepEqual((await game(roomId, 'tester2')).clues.map((c: any) => c.key), ['missing-lantern']);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.text.startsWith('房主让你的角色「沈探」知道了线索「')));
  assert.ok((await log(roomId, 'tester1')).some((e) => e.text.startsWith('房主让你的角色「林小满」不再知道线索「')));
  // 管理员能看到、给出剧本里的全部线索（不用点查看，也不记）
  const all = (await t.call('GET', `/api/rooms/${roomId}/host/clues?full=1`, undefined, cookies.admin)).data.clues;
  assert.equal(all.length, 14);
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/host/clues/register?full=1`, { characterIds: [reporterId] }, cookies.admin)).status, 200);
  assert.deepEqual((await game(roomId, 'tester1')).clues.map((c: any) => c.key), ['register']);
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/host/clues?full=1`, undefined, cookies.tester1)).status, 403);

  // 团录：玩家导出自己能看到的；管理员导出全部，注明谁看得到
  const mine = (await t.call('GET', `/api/rooms/${roomId}/export`, undefined, cookies.tester2)).data;
  assert.match(mine.filename, /^团录-测试局-\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(mine.content.startsWith('# 《雾港旅店》团录：测试局'));
  assert.ok(!mine.content.includes('柜台下面有张纸条'), '别人的私密内容不在里面');
  assert.ok(!mine.content.includes('线人'), '别人的身份秘密不在里面');
  const full = (await t.call('GET', `/api/rooms/${roomId}/export?full=1`, undefined, cookies.admin)).data;
  assert.ok(full.content.includes('柜台下面有张纸条'));
  assert.ok(full.content.includes('（只有林小满看得到）'));
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/export?full=1`, undefined, cookies.tester1)).status, 403);
});
