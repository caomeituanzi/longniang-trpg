process.env.TZ = 'Asia/Shanghai';
// V0.8.0 AI 补位：剧本的身份比来的人多时，房主把没人选的身份交给 AI 演——主持 AI 顺带演，当作跟着大家的队友。
// 不建角色、不建账号：给主持 AI 的那份剧本里这个身份变成标着「AI 队友」的 NPC，数据库里存的剧本不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FakeProvider, say, useTools } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse, TextBlock, ToolResultBlock } from '../server/ai/types';
import {
  COMPANION_ATTITUDE,
  companionsOf,
  companionsStartText,
  SEAT_LOG_MERGE_MS,
  seatLogChange,
  seatLogMerge,
  seatLogText,
  takeoverOf,
  takeoverText,
  withCompanions,
} from '../server/game/companions';
import { hasInvisibleChars, INVISIBLE_NAME_MESSAGE } from '../server/util';
import { buildCatchupContext, buildStorySummaryContext, COMPANION_RULE, DM_RULES, DM_RULES_V2 } from '../server/game/prompts';
import { validateScenario, type Scenario } from '../server/game/scenario';
import { emptyWorld } from '../server/game/world';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp, type Res } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 28, 3, 0, 0);

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
const REPORTER = FIXTURE.roles.find((r: { key: string }) => r.key === 'reporter') as { name: string; public: string; secret: string; goal: string };

/** 发给 AI 的第一条消息（结算时是整段局面，估时、问答、摘要就是那一条）。 */
function firstUserText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 假主持人：结算时按行动里的 [NPC key 地点] 调用 update_npc，[结局 key] 调用 end_game；别的都给固定的回复。 */
async function scriptedDm(req: MessagesRequest): Promise<MessagesResponse> {
  if (req.output_config?.format) return say(JSON.stringify({ minutes: 10, reason: '测试', kind: 'action' }));
  const system = req.system?.[0]?.text ?? '';
  if (!req.tools?.length) {
    if (system.includes('补课')) return say('摘要：测试');
    if (system.includes('整理笔记')) return say('笔记：测试');
    return say('回答：测试');
  }
  const last = req.messages[req.messages.length - 1];
  const results = last.role === 'user' && Array.isArray(last.content) ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  if (results.length) return say('叙述：测试用的假主持人写的叙述，雾气贴着窗户慢慢流动。');
  const block = firstUserText(req).slice(firstUserText(req).indexOf('# 这次要结算的行动'));
  const quotes = [...block.matchAll(/「([^」]*)」/g)];
  const text = quotes[quotes.length - 1]?.[1] ?? '';
  const calls: { name: string; input: unknown }[] = [];
  for (const [, cmd, a, b] of text.matchAll(/\[(NPC|结局) ([^\] ]+) ?([^\]]*)\]/g)) {
    if (cmd === 'NPC') calls.push({ name: 'update_npc', input: { npc: a, location: b } });
    if (cmd === '结局') calls.push({ name: 'end_game', input: { ending: a, epilogue: '雾散了，一切尘埃落定。' } });
  }
  return calls.length ? useTools(...calls) : say(`叙述：${text}`);
}

const fake = new FakeProvider(scriptedDm);
let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0 });
  for (const a of [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5]) cookies[a.username] = await t.login(a.username, a.password);
});

after(async () => {
  await t.close();
});

type Who = 'admin' | 'tester1' | 'tester2' | 'tester3' | 'tester4' | 'tester5';
const as = (who: Who) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookies[who]);
const seat = (who: Who, roomId: number, roleKey: string, name?: string) =>
  as(who)('PUT', `/api/rooms/${roomId}/ai-seats/${roleKey}`, name === undefined ? {} : { name });
const unseat = (who: Who, roomId: number, roleKey: string) => as(who)('DELETE', `/api/rooms/${roomId}/ai-seats/${roleKey}`);
const pick = (who: Who, roomId: number, roleKey: string, name: string) => as(who)('PUT', `/api/rooms/${roomId}/character`, { roleKey, name });
const game = async (roomId: number, who: Who) => (await as(who)('GET', `/api/rooms/${roomId}/game`)).data;
const logTexts = async (roomId: number, who: Who) => ((await as(who)('GET', `/api/rooms/${roomId}/log`)).data.entries as { text: string }[]).map((e) => e.text);

/** 建一局、别的人加入、选好剧本。 */
async function createRoom(host: Who, scenarioKey: string, members: Who[] = []) {
  const r = await as(host)('POST', '/api/rooms', { name: 'AI 补位测试', maxPlayers: 6 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const roomId = r.data.room.id as number;
  for (const m of members) assert.equal((await as(m)('POST', '/api/rooms/join', { code: r.data.room.joinCode })).status, 200);
  const s = await as(host)('POST', `/api/rooms/${roomId}/scenario`, { key: scenarioKey });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return roomId;
}

async function start(roomId: number, who: Who) {
  const r = await as(who)('POST', `/api/rooms/${roomId}/status`, { status: 'running' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

/** 交一个行动，等估时，让时间过去，等它结算完（没人开着页面：计时模式）。 */
async function act(roomId: number, who: Who, content: string) {
  const r = await as(who)('POST', `/api/rooms/${roomId}/actions`, { content });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.engine.idle();
  now += 6 * 60 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

const dmRequests = () => fake.requests.filter((r) => r.tools?.length);
const scenarioOf = (req: MessagesRequest) => {
  const text = req.system?.[1]?.text ?? '';
  return JSON.parse(text.slice(text.indexOf('{'))) as Scenario;
};

test('房主能把没人选的身份交给 AI、改名字、取消；普通成员、不在这一局的人、游客不行', async () => {
  const roomId = await createRoom('tester1', 'fog-harbor-inn', ['tester2']);
  assert.equal((await seat('tester2', roomId, 'reporter')).status, 403, '普通成员不能标');
  assert.equal((await seat('tester3', roomId, 'reporter')).status, 404, '不在这一局里');
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await t.call('PUT', `/api/rooms/${roomId}/ai-seats/reporter`, {}, guest)).status, 403, '游客');

  // 不起名字：用身份的名字。别人选身份时这个身份算有人了
  let r = await seat('tester1', roomId, 'reporter');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.companions, [{ roleKey: 'reporter', roleName: REPORTER.name, name: REPORTER.name, class5e: null, persona: null }]);
  assert.equal(r.data.scenario.roles.find((x: { key: string }) => x.key === 'reporter').takenBy, REPORTER.name);

  // 改名字：新名字会写进给主持 AI 的提示词，先检查内容
  let guards = fake.guardRequests.length;
  r = await seat('tester1', roomId, 'reporter', '  林小满 ');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.companions[0].name, '林小满');
  assert.ok(fake.guardRequests.slice(guards).some((q) => JSON.stringify(q).includes('AI 队友的名字：林小满')), '名字检查过内容');
  // 一样的名字：不再检查、不再写记录
  guards = fake.guardRequests.length;
  assert.equal((await seat('tester1', roomId, 'reporter', '林小满')).status, 200);
  assert.equal(fake.guardRequests.length, guards);

  // 输入不对
  assert.equal((await seat('tester1', roomId, 'reporter', '名'.repeat(21))).status, 400);
  // 看不见的字符：换行、把后面的字倒过来的 U+202E、零宽、BOM、方向隔离、软连字符、AI 读得到的标签字符
  for (const bad of ['林\n小满', '林\u202e满小', '林\u200b小满', '林\ufeff小满', '林\u2066小满', '林\u00ad小满', '林\u{e0041}小满']) {
    const r = await seat('tester1', roomId, 'reporter', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.error, '名字里有看不见的字符（换行、零宽字符、改文字方向的字符），删掉再试');
  }
  assert.equal((await as('tester1')('PUT', `/api/rooms/${roomId}/ai-seats/reporter`, { name: 42 })).status, 400);
  assert.equal((await seat('tester1', roomId, 'nobody')).status, 404);
  assert.equal((await seat('tester1', roomId, 'Bad_Key')).status, 404);

  // 别的成员看到的游戏状态里也有
  const g = await game(roomId, 'tester2');
  assert.deepEqual(g.companions, [{ roleKey: 'reporter', roleName: REPORTER.name, name: '林小满', persona: null, class5e: null }]);
  assert.equal(g.scenario.roles.find((x: { key: string }) => x.key === 'reporter').takenBy, '林小满');

  // 普通成员不能取消；站长（能管所有对局）可以标
  assert.equal((await unseat('tester2', roomId, 'reporter')).status, 403);
  assert.equal((await seat('admin', roomId, 'sailor')).status, 200);

  // 取消：这个身份又可以选了
  r = await unseat('tester1', roomId, 'reporter');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(
    r.data.companions.map((c: { roleKey: string }) => c.roleKey),
    ['sailor'],
  );
  assert.equal(r.data.scenario.roles.find((x: { key: string }) => x.key === 'reporter').takenBy, null);
  assert.equal((await unseat('tester1', roomId, 'reporter')).status, 404);

  const texts = await logTexts(roomId, 'tester2');
  // 交给 AI 以后马上改了名字：两条记录合并成一条
  assert.ok(texts.includes(`房主把「${REPORTER.name}」交给 AI 来演：林小满`), texts.join('\n'));
  assert.ok(!texts.some((x) => x.includes('改了名字')), texts.join('\n'));
  assert.ok(texts.includes('站长把「顺风号的水手」交给 AI 来演'));
  assert.ok(texts.includes(`房主不再让 AI 演「${REPORTER.name}」，这个身份可以选了`));
});

test('已经有人选的身份不能标；标了的身份玩家选不了（取消以后才能选）；名字不能和角色、别的 AI 队友撞', async () => {
  const roomId = await createRoom('tester1', 'fog-harbor-inn', ['tester2', 'tester3']);
  assert.equal((await pick('tester2', roomId, 'doctor', '许医生')).status, 200);
  let r = await seat('tester1', roomId, 'doctor');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个身份已经有人选了，不能交给 AI');
  r = await seat('tester1', roomId, 'reporter', '许医生');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个名字已经有角色在用了，换一个吧');

  assert.equal((await seat('tester1', roomId, 'reporter', '林小满')).status, 200);
  r = await seat('tester1', roomId, 'sailor', '林小满');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个名字已经给别的 AI 队友用了，换一个吧');

  r = await pick('tester3', roomId, 'reporter', '林二');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个身份交给 AI 演了，房主取消以后才能选');
  r = await pick('tester3', roomId, 'customs', '林小满');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个名字已经给 AI 队友用了，换一个吧');
  // 已经选好的人改自己的名字不受影响
  assert.equal((await pick('tester2', roomId, 'doctor', '许大夫')).status, 200);

  assert.equal((await unseat('tester1', roomId, 'reporter')).status, 200);
  assert.equal((await pick('tester3', roomId, 'reporter', '林二')).status, 200, '取消以后能选');
});

test('同一个身份短时间里来回改：记录合并，不刷屏（安全审查）', async () => {
  const roomId = await createRoom('tester1', 'fog-harbor-inn', ['tester2']);
  const seatLogs = async () => (await logTexts(roomId, 'tester2')).filter((x) => x.includes('AI 来演') || x.includes('AI 演「'));
  const stream = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  // 来回切 15 次：交给 AI 又马上取消的，两条都不留
  for (let i = 0; i < 15; i++) {
    assert.equal((await seat('tester1', roomId, 'detective')).status, 200);
    assert.equal((await unseat('tester1', roomId, 'detective')).status, 200);
  }
  assert.deepEqual(await seatLogs(), []);
  // 撤掉的记录推给开着这一局的人，网页上去掉
  assert.equal((await stream.waitFor((e) => e.event === 'log-removed')).data.ids.length, 1);
  stream.close();

  // 交给 AI 以后改了两次名字：只留最后一条
  assert.equal((await seat('tester1', roomId, 'detective')).status, 200);
  assert.equal((await seat('tester1', roomId, 'detective', '沈二')).status, 200);
  assert.equal((await seat('tester1', roomId, 'detective', '沈三')).status, 200);
  assert.deepEqual(await seatLogs(), ['房主把「私家侦探」交给 AI 来演：沈三']);
  // 中间有别的记录（场外聊天）：不合并
  assert.equal((await as('tester2')('POST', `/api/rooms/${roomId}/chat`, { text: '我来晚了' })).status, 201);
  assert.equal((await seat('tester1', roomId, 'detective', '沈四')).status, 200);
  assert.deepEqual(await seatLogs(), ['房主把「私家侦探」交给 AI 来演：沈三', '房主给 AI 来演的「私家侦探」改了名字：沈四']);
  // 过了合并时间也不合并
  now += SEAT_LOG_MERGE_MS + MIN;
  assert.equal((await unseat('tester1', roomId, 'detective')).status, 200);
  assert.deepEqual(await seatLogs(), [
    '房主把「私家侦探」交给 AI 来演：沈三',
    '房主给 AI 来演的「私家侦探」改了名字：沈四',
    '房主不再让 AI 演「私家侦探」，这个身份可以选了',
  ]);
  // 别人（站长）接着改：不和房主的那条合并
  assert.equal((await seat('admin', roomId, 'detective')).status, 200);
  assert.equal((await seatLogs()).length, 4);

  // 取消了又交给 AI：两条都留；再取消，只撤掉后来那条「交给 AI」——记录里最后说的一直和现在一样
  const customs = async () => (await seatLogs()).filter((x) => x.includes('海关稽查员'));
  assert.equal((await seat('tester1', roomId, 'customs')).status, 200);
  now += SEAT_LOG_MERGE_MS + MIN;
  assert.equal((await unseat('tester1', roomId, 'customs')).status, 200);
  assert.equal((await seat('tester1', roomId, 'customs')).status, 200);
  assert.deepEqual(await customs(), ['房主把「海关稽查员」交给 AI 来演', '房主不再让 AI 演「海关稽查员」，这个身份可以选了', '房主把「海关稽查员」交给 AI 来演']);
  for (let i = 0; i < 5; i++) {
    assert.equal((await unseat('tester1', roomId, 'customs')).status, 200);
    assert.equal((await seat('tester1', roomId, 'customs')).status, 200);
  }
  assert.equal((await unseat('tester1', roomId, 'customs')).status, 200);
  assert.deepEqual(await customs(), ['房主把「海关稽查员」交给 AI 来演', '房主不再让 AI 演「海关稽查员」，这个身份可以选了']);
  assert.ok(!(await game(roomId, 'tester1')).companions.some((c: { roleKey: string }) => c.roleKey === 'customs'));

  // 合并的规则
  assert.equal(seatLogChange(seatLogText('房主', 'added', '记者', '林小满'), '房主', '记者'), 'added');
  assert.equal(seatLogChange(seatLogText('房主', 'added', '记者', '记者'), '房主', '记者'), 'added');
  assert.equal(seatLogChange(seatLogText('房主', 'renamed', '记者', '林小满'), '房主', '记者'), 'renamed');
  assert.equal(seatLogChange(seatLogText('房主', 'removed', '记者', '林小满'), '房主', '记者'), 'removed');
  assert.equal(seatLogChange(seatLogText('站长', 'added', '记者', '林小满'), '房主', '记者'), null, '不是同一个人');
  assert.equal(seatLogChange(seatLogText('房主', 'added', '记者', '林小满'), '房主', '船夫'), null, '不是同一个身份');
  assert.deepEqual(seatLogMerge('added', 'removed'), { replace: true, write: null });
  assert.deepEqual(seatLogMerge('added', 'renamed'), { replace: true, write: 'added' });
  assert.deepEqual(seatLogMerge('renamed', 'renamed'), { replace: true, write: 'renamed' });
  assert.deepEqual(seatLogMerge('renamed', 'removed'), { replace: true, write: 'removed' });
  assert.deepEqual(seatLogMerge('removed', 'added'), { replace: false, write: 'added' });
});

test('每人每分钟最多改 20 次，超了 429 说清楚；按账号算（安全审查）', async () => {
  const limited = await startTestApp({ ai: new FakeProvider(scriptedDm), tickMs: 0, rateLimits: true });
  try {
    const c1 = await limited.login(TESTER1.username, TESTER1.password);
    const c2 = await limited.login(TESTER2.username, TESTER2.password);
    const make = async (cookie: string) => {
      const r = await limited.call('POST', '/api/rooms', { name: '限频率', maxPlayers: 4 }, cookie);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal((await limited.call('POST', `/api/rooms/${r.data.room.id}/scenario`, { key: 'fog-harbor-inn' }, cookie)).status, 200);
      return r.data.room.id as number;
    };
    const mine = await make(c1);
    for (let i = 0; i < 10; i++) {
      assert.equal((await limited.call('PUT', `/api/rooms/${mine}/ai-seats/detective`, {}, c1)).status, 200, `第 ${2 * i + 1} 次`);
      assert.equal((await limited.call('DELETE', `/api/rooms/${mine}/ai-seats/detective`, undefined, c1)).status, 200, `第 ${2 * i + 2} 次`);
    }
    for (const [method, body] of [['PUT', {}], ['DELETE', undefined]] as const) {
      const r = await limited.call(method, `/api/rooms/${mine}/ai-seats/detective`, body, c1);
      assert.equal(r.status, 429, method);
      assert.equal(r.data.error, '交给 AI 的身份改得太频繁了，过一分钟再改');
    }
    const theirs = await make(c2);
    assert.equal((await limited.call('PUT', `/api/rooms/${theirs}/ai-seats/detective`, {}, c2)).status, 200, '别人不受影响');
  } finally {
    await limited.close();
  }
});

test('看不见的字符：名字这类短文字用 hasInvisibleChars 挡掉', () => {
  for (const bad of ['a\nb', 'a\tb', 'a\u0085b', 'a\u200bb', 'a\u200cb', 'a\u200db', 'a\u200eb', 'a\u200fb', 'a\u061cb', 'a\u202ab', 'a\u202eb', 'a\u2060b', 'a\u2066b', 'a\u2069b', 'a\ufeffb', 'a\u00adb', 'a\u180eb', 'a\u{e0001}b', 'a\u{e007f}b']) {
    assert.equal(hasInvisibleChars(bad), true, JSON.stringify(bad));
  }
  for (const ok of ['林小满', 'Lin Xiaoman', '阿海（顺风号）', '小满🌸', '❤️', 'ナナミ', '김민지', 'سارة']) {
    assert.equal(hasInvisibleChars(ok), false, ok);
  }
});

test('别人看得到的名字：新起的、改了的不能有看不见的字符，正常的中文、日文、emoji 照样能用；以前存的照常（安全审查）', async () => {
  // 看不见的字符用码位拼出来，源文件里不放这些字符本身
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);
  const ZWJ = String.fromCodePoint(0x200d);
  const ISOLATE = String.fromCodePoint(0x2066);
  const db = t.app.db;
  const bad = (r: Res, what: string) => {
    assert.equal(r.status, 400, `${what}：${JSON.stringify(r.data)}`);
    assert.equal(r.data.error, INVISIBLE_NAME_MESSAGE, what);
  };

  // 显示名：注册、改资料、管理员新建账号
  bad(await t.call('POST', '/api/auth/register', { inviteCode: t.inviteCode, username: 'zerowidth', displayName: `新${ZWSP}人`, password: 'zero-width-1', agreeRules: true }), '注册');
  const registered = await t.call('POST', '/api/auth/register', { inviteCode: t.inviteCode, username: 'nanami', displayName: 'ナナミ🌸', password: 'nanami-pass-1', agreeRules: true });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  bad(await as('tester3')('PUT', '/api/me/profile', { displayName: `测试${RLO}三` }), '改显示名');
  assert.equal((await as('tester3')('PUT', '/api/me/profile', { displayName: '测试玩家三😀' })).status, 200);
  db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run(`旧名${ZWSP}字`, 'tester3');
  assert.equal((await as('tester3')('PUT', '/api/me/profile', { displayName: `旧名${ZWSP}字`, bio: '照常' })).status, 200, '以前存的显示名没改：照常');
  db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run('测试玩家三', 'tester3');
  bad(await as('admin')('POST', '/api/admin/users', { username: 'rlo_user', displayName: `管${RLO}理` }), '管理员新建账号');
  assert.equal((await as('admin')('POST', '/api/admin/users', { username: 'emoji_user', displayName: '小龙🐉' })).status, 201);

  // 角色名
  const roomId = await createRoom('tester3', 'fog-harbor-inn');
  bad(await pick('tester3', roomId, 'reporter', `林${ZWSP}小满`), '角色名');
  assert.equal((await pick('tester3', roomId, 'reporter', '林小満🌙')).status, 200);
  db.prepare('UPDATE characters SET name = ? WHERE room_id = ?').run(`林${ZWSP}旧`, roomId);
  assert.equal((await pick('tester3', roomId, 'reporter', `林${ZWSP}旧`)).status, 200, '以前存的角色名没改：照常');

  // 宠物名：养的时候、改名的时候（先查名字，不白用掉改名卡）
  bad(await as('tester5')('POST', '/api/pet', { name: `小${ISOLATE}龙` }), '宠物名');
  assert.equal((await as('tester5')('POST', '/api/pet', { name: 'たま🐱' })).status, 201);
  bad(await as('tester5')('PUT', '/api/pet', { name: `た${ZWSP}ま` }), '宠物改名');
  db.prepare('UPDATE pets SET name = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(`旧${ZWSP}宠`, 'tester5');
  assert.equal((await as('tester5')('PUT', '/api/pet', { name: `旧${ZWSP}宠`, description: '换个介绍' })).status, 200, '以前存的宠物名没改：照常');

  // 角色卡名：建卡、改卡
  const sheet = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };
  bad(await as('tester5')('POST', '/api/cards', { name: `卡${RLO}片`, ...sheet }), '角色卡名');
  const card = await as('tester5')('POST', '/api/cards', { name: 'ハヤテ⚔️', ...sheet });
  assert.equal(card.status, 200, JSON.stringify(card.data));
  bad(await as('tester5')('PUT', `/api/cards/${card.data.card.id}`, { name: `ハ${ZWJ}ヤテ` }), '角色卡改名');

  // 群名：建群、改群名
  assert.equal((await as('tester1')('POST', '/api/friends', { username: 'tester2' })).status, 201);
  assert.equal((await as('tester2')('POST', '/api/friends', { username: 'tester1' })).status, 200);
  const friend = (db.prepare('SELECT public_id FROM users WHERE username = ?').get('tester2') as { public_id: string }).public_id;
  bad(await as('tester1')('POST', '/api/groups', { name: `跑团${ZWSP}群`, members: [friend] }), '群名');
  const group = await as('tester1')('POST', '/api/groups', { name: '跑団の仲間🎲', members: [friend] });
  assert.equal(group.status, 201, JSON.stringify(group.data));
  bad(await as('tester1')('PUT', `/api/groups/${group.data.group.id}`, { name: `跑${RLO}团` }), '改群名');

  // 管理员上架的称号：上架、改名
  bad(await as('admin')('POST', '/api/admin/shop/listings', { kind: 'title', name: `夜${ZWSP}行`, price: 300 }), '称号');
  const listed = await as('admin')('POST', '/api/admin/shop/listings', { kind: 'title', name: '夜行🌙', price: 300 });
  assert.equal(listed.status, 201, JSON.stringify(listed.data));
  const title = (listed.data.listings as { id: number; name: string }[]).find((l) => l.name === '夜行🌙')!;
  bad(await as('admin')('PUT', `/api/admin/shop/listings/${title.id}`, { name: `夜${RLO}行` }), '称号改名');
  assert.equal((await as('admin')('PUT', `/api/admin/shop/listings/${title.id}`, { name: '夜行🌙', price: 320 })).status, 200, '名字没改，只改价钱');
});

test('地下城不能交给 AI；没人建角色时至少留一个身份给玩家', async () => {
  const mine = await createRoom('tester1', 'dungeon-abandoned-mine');
  const r = await seat('tester1', mine, 'hired-hand');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /^地下城的身份不能交给 AI：/);

  // 清溪灯会：三个身份
  const roomId = await createRoom('tester1', 'qingxi-lantern-night');
  assert.equal((await seat('tester1', roomId, 'scholar')).status, 200);
  assert.equal((await seat('tester1', roomId, 'constable')).status, 200);
  const last = await seat('tester1', roomId, 'herbalist');
  assert.equal(last.status, 409);
  assert.equal(last.data.error, '至少留一个身份给玩家自己选');
  // 有人建了角色就不用留
  assert.equal((await pick('tester1', roomId, 'herbalist', '采药的阿青')).status, 200);
  assert.equal((await unseat('tester1', roomId, 'constable')).status, 200);
  assert.equal((await seat('tester1', roomId, 'constable')).status, 200);
});

test('换剧本时交给 AI 的身份清掉', async () => {
  const roomId = await createRoom('tester1', 'fog-harbor-inn');
  assert.equal((await seat('tester1', roomId, 'reporter', '林小满')).status, 200);
  const r = await as('tester1')('POST', `/api/rooms/${roomId}/scenario`, { key: 'qingxi-lantern-night' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.companions, []);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM ai_seats WHERE room_id = ?').get(roomId) as { n: number }).n, 0);
  assert.ok((await logTexts(roomId, 'tester1')).some((x) => x.endsWith('，交给 AI 演的身份也取消了')));
  // 导入剧本也一样
  assert.equal((await seat('tester1', roomId, 'scholar')).status, 200);
  const imported = await as('tester1')('POST', `/api/rooms/${roomId}/scenario`, { data: { ...FIXTURE, title: '自己写的雾港' } });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.deepEqual(imported.data.companions, []);
});

test('开局写系统记录、开始以后不能改；结算时主持 AI 的剧本里有队友和那条规则；update_npc 记得住他；存的剧本不变', async () => {
  const roomId = await createRoom('tester1', 'fog-harbor-inn');
  assert.equal((await seat('tester1', roomId, 'reporter', '林小满')).status, 200);
  assert.equal((await seat('tester1', roomId, 'sailor')).status, 200);
  // 开局还是要至少一个真人角色
  const early = await as('tester1')('POST', `/api/rooms/${roomId}/status`, { status: 'running' });
  assert.equal(early.status, 409);
  assert.equal((await pick('tester1', roomId, 'detective', '沈探')).status, 200);
  await start(roomId, 'tester1');
  const texts = await logTexts(roomId, 'tester1');
  assert.ok(texts.includes(`这几个身份由 AI 来演：「${REPORTER.name}」林小满、「顺风号的水手」。`), texts.join('\n'));
  assert.equal(companionsStartText([{ roleName: '记者', name: '林小满' }]), '「记者」由 AI 来演：林小满。');
  assert.equal(companionsStartText([{ roleName: '记者', name: '记者' }]), '「记者」由 AI 来演。');

  // 开始以后不能改
  let r = await seat('tester1', roomId, 'customs');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '对局已经开始了，交给 AI 的身份不能再改');
  assert.equal((await unseat('tester1', roomId, 'reporter')).status, 409);
  // 游戏状态里有队友
  assert.deepEqual((await game(roomId, 'tester1')).companions, [
    { roleKey: 'reporter', roleName: REPORTER.name, name: '林小满', class5e: null, persona: null },
    { roleKey: 'sailor', roleName: '顺风号的水手', name: '顺风号的水手', class5e: null, persona: null },
  ]);

  fake.requests.length = 0;
  await act(roomId, 'tester1', '带着林小满去码头看看 [NPC ai-reporter pier]');
  // 估时的 AI 也知道队友是谁
  const estimate = fake.requests.find((q) => q.output_config?.format);
  assert.ok(estimate);
  assert.match(firstUserText(estimate), new RegExp(`跟着大家的 AI 队友（主持人顺带演的 NPC，不是玩家的角色）：林小满（${REPORTER.name}）、顺风号的水手（顺风号的水手）`));

  const dm = dmRequests()[0];
  assert.ok(dm, '结算调用了主持 AI');
  assert.equal(dm.system?.[0]?.text, DM_RULES, '第一版规则');
  assert.ok(DM_RULES.includes(COMPANION_RULE));
  assert.match(COMPANION_RULE, /没人玩的身份，房主可以交给你顺带演/);
  assert.match(COMPANION_RULE, /换了地方用 update_npc 记下位置/);
  assert.doesNotMatch(COMPANION_RULE, /比如/);
  const played = scenarioOf(dm);
  const npc = played.npcs.find((n) => n.key === 'ai-reporter');
  assert.ok(npc, '队友是剧本里的一个 NPC');
  assert.equal(npc.name, '林小满');
  assert.match(npc.identity, new RegExp(`^AI 队友（没人玩的身份「${REPORTER.name}」，由你顺带演）：`));
  assert.ok(npc.identity.includes(REPORTER.public));
  assert.ok(npc.knows[0].startsWith(REPORTER.secret), '他知道身份的秘密（只有主持 AI 看得到）');
  assert.ok(npc.wants.startsWith(REPORTER.goal));
  assert.equal(npc.location, 'lobby');
  assert.equal(npc.attitude, COMPANION_ATTITUDE.secrets, '各有秘密的剧本');
  assert.ok(played.npcs.some((n) => n.key === 'ai-sailor' && n.name === '顺风号的水手'));
  assert.deepEqual(
    played.roles.map((x) => x.key).sort(),
    ['customs', 'detective', 'doctor', 'young-master'],
    '交给 AI 的身份不在 roles 里',
  );
  const context = firstUserText(dm);
  assert.match(context, new RegExp(`跟着大家的 AI 队友（你顺带演，在 npcs 里）：林小满（ai-reporter，身份「${REPORTER.name}」），现在在 大堂（lobby）`));
  assert.ok(context.includes('AI 队友在场时发生的事，他也知道（「知道的人」里只列玩家的角色，不会列出 AI 队友）。'), '「知道的人」不列队友，说一句他在场时的事他也知道');
  const unchosen = context.match(/这一局没人选的身份：([^\n]*)/)?.[1] ?? '';
  assert.ok(unchosen.includes('海关稽查员') && !unchosen.includes(REPORTER.name) && !unchosen.includes('顺风号的水手'), unchosen);

  // update_npc 改了队友的位置，下一次结算时主持 AI 知道他在码头
  const world = JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string }).world);
  assert.equal(world.npcs['ai-reporter'].location, 'pier');
  fake.requests.length = 0;
  await act(roomId, 'tester1', '四处看看');
  assert.match(firstUserText(dmRequests()[0]), /林小满（ai-reporter，身份「[^」]+」），现在在 码头（pier）/);

  // 数据库里存的剧本没有被改
  const stored = JSON.parse((t.app.db.prepare('SELECT data FROM scenarios WHERE room_id = ?').get(roomId) as { data: string }).data) as Scenario;
  assert.ok(stored.roles.some((x) => x.key === 'reporter'));
  assert.ok(!stored.npcs.some((n) => n.key.startsWith('ai-') || n.name === '林小满'));

  // 场外提问：知道队友是谁、公开的介绍，但不知道他的秘密
  fake.requests.length = 0;
  assert.equal((await as('tester1')('POST', `/api/rooms/${roomId}/ask`, { question: '林小满是谁？' })).status, 202);
  await t.app.engine.idle();
  const answer = fake.requests.find((q) => q.system?.[0]?.text.includes('场外问你问题'));
  assert.ok(answer);
  const asked = firstUserText(answer);
  assert.ok(asked.includes(`林小满（${REPORTER.name}：`), asked);
  assert.ok(!asked.includes(REPORTER.secret.slice(0, 16)), '场外问答看不到队友的秘密');

  // 「你不在时」摘要：他离开以后又说了好几句话
  const lastId = (t.app.db.prepare('SELECT MAX(id) AS id FROM log_entries WHERE room_id = ?').get(roomId) as { id: number }).id;
  const me = (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get('tester1') as { id: number }).id;
  t.app.db.prepare('UPDATE players SET seen_log_id = ?, left_at = ? WHERE room_id = ? AND user_id = ?').run(lastId, now, roomId, me);
  for (let i = 0; i < 14; i++) assert.equal((await as('tester1')('POST', `/api/rooms/${roomId}/say`, { text: `第${i + 1}句话` })).status, 201);
  fake.requests.length = 0;
  const catchup = (await as('tester1')('GET', `/api/rooms/${roomId}/catchup`)).data;
  assert.equal(catchup.summarizing, true, JSON.stringify(catchup));
  await t.app.engine.idle();
  const recap = fake.requests.find((q) => q.system?.[0]?.text.includes('补课'));
  assert.ok(recap);
  assert.match(firstUserText(recap), /跟着大家的 AI 队友（主持人顺带演的 NPC，不是玩家的角色）：林小满/);

  // 剧情笔记：没并进笔记的经历攒够了，结算完在后台写
  fake.requests.length = 0;
  await act(roomId, 'tester1', '再看看');
  const notes = fake.requests.find((q) => q.system?.[0]?.text.includes('整理笔记'));
  assert.ok(notes, '写了剧情笔记');
  assert.match(firstUserText(notes), /^跟着大家的 AI 队友（主持人顺带演的 NPC，不是玩家的角色）：林小满（[^）]+）、顺风号的水手（顺风号的水手）。「知道的人」里只列玩家的角色/);
});

test('自带的普通剧本（规则第二版）结算时也有那条主持规则', async () => {
  const roomId = await createRoom('tester5', 'qingxi-lantern-night');
  assert.equal((await seat('tester5', roomId, 'constable', '赵捕头')).status, 200);
  assert.equal((await pick('tester5', roomId, 'scholar', '柳书生')).status, 200);
  await start(roomId, 'tester5');
  fake.requests.length = 0;
  await act(roomId, 'tester5', '在茶馆里坐一会儿 [NPC ai-constable teahouse]');
  const dm = dmRequests()[0];
  assert.ok(dm);
  assert.equal(dm.system?.[0]?.text, DM_RULES_V2);
  assert.ok(DM_RULES_V2.includes(COMPANION_RULE));
  const npc = scenarioOf(dm).npcs.find((n) => n.key === 'ai-constable');
  assert.equal(npc?.name, '赵捕头');
  assert.equal(npc?.attitude, COMPANION_ATTITUDE.coop, '合作的剧本');
  const world = JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string }).world);
  assert.equal(world.npcs['ai-constable'].location, 'teahouse');
});

test('投稿拿到的是存的那份剧本（没有 AI 队友）', async () => {
  const r = await as('tester2')('POST', '/api/rooms', { name: '导入的雾港', maxPlayers: 6 });
  const roomId = r.data.room.id as number;
  const data = { ...FIXTURE, title: '自己写的雾港旅店' };
  delete data.author;
  assert.equal((await as('tester2')('POST', `/api/rooms/${roomId}/scenario`, { data })).status, 200);
  assert.equal((await seat('tester2', roomId, 'reporter', '林小满')).status, 200);
  assert.equal((await pick('tester2', roomId, 'detective', '沈探')).status, 200);
  await start(roomId, 'tester2');
  const sub = await as('tester2')('POST', `/api/rooms/${roomId}/submission`, { category: 'puzzle', intro: '海边小镇的旅店里出了命案。' });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const full = (await as('admin')('GET', `/api/admin/submissions/${sub.data.submission.id}`)).data.scenario as Scenario;
  assert.ok(full.roles.some((x) => x.key === 'reporter'), '身份还在');
  assert.ok(!full.npcs.some((n) => n.key.startsWith('ai-') || n.name === '林小满'), '没有 AI 队友');
  // 管理页看得到这一局的 AI 队友
  const detail = (await as('admin')('GET', `/api/admin/rooms/${roomId}`)).data;
  assert.deepEqual(detail.companions, [{ roleKey: 'reporter', roleName: REPORTER.name, name: '林小满', npcKey: 'ai-reporter' }]);
});

test('玩完以后只有真人得到成长和结局记录', async () => {
  const users = (t.app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const roomId = await createRoom('tester4', 'fog-harbor-inn');
  assert.equal((await seat('tester4', roomId, 'reporter', '林小满')).status, 200);
  assert.equal((await pick('tester4', roomId, 'detective', '沈探')).status, 200);
  await start(roomId, 'tester4');
  await act(roomId, 'tester4', '问问林小满打听到了什么');
  await act(roomId, 'tester4', '和林小满一起去码头');
  await act(roomId, 'tester4', '揭开真相 [结局 truth]');
  assert.equal((await game(roomId, 'tester4')).ending?.title, FIXTURE.endings.find((e: { key: string }) => e.key === 'truth').title);

  const me = (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get('tester4') as { id: number }).id;
  const grown = t.app.db.prepare('SELECT user_id FROM pet_growth WHERE room_id = ?').all(roomId) as { user_id: number }[];
  assert.deepEqual(
    grown.map((g) => g.user_id),
    [me],
    '宠物成长只给真人',
  );
  const endings = t.app.db.prepare("SELECT user_id FROM endings_reached WHERE scenario_key = 'fog-harbor-inn'").all() as { user_id: number }[];
  assert.deepEqual(
    endings.map((e) => e.user_id),
    [me],
    '结局图鉴只给真人',
  );
  assert.equal((t.app.db.prepare('SELECT players FROM scenario_finishes WHERE room_id = ?').get(roomId) as { players: number }).players, 1);
  // 没有为 AI 队友建账号、成员、角色
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, users);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM players WHERE room_id = ?').get(roomId) as { n: number }).n, 1);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM characters WHERE room_id = ?').get(roomId) as { n: number }).n, 1);
});

test('合并队友的函数：NPC key 不和剧本里的撞，不改原来的剧本；摘要、笔记的提示词里说清他们是谁', () => {
  const base = validateScenario(FIXTURE).scenario as Scenario;
  const scenario: Scenario = { ...base, npcs: [...base.npcs, { ...base.npcs[0], key: 'ai-reporter', name: '冒名的人' }] };
  const before = JSON.stringify(scenario);
  const companions = companionsOf(scenario, [
    { roleKey: 'sailor', name: '阿海' },
    { roleKey: 'reporter', name: '林小满' },
    { roleKey: 'nobody', name: '没有这个身份' },
  ]);
  // 按剧本里身份的顺序；ai-reporter 剧本里已经有了，接 -2
  assert.deepEqual(
    companions.map((c) => [c.roleKey, c.npcKey, c.name]),
    [
      ['reporter', 'ai-reporter-2', '林小满'],
      ['sailor', 'ai-sailor', '阿海'],
    ],
  );
  // 已经有人选了的身份不算
  assert.deepEqual(
    companionsOf(scenario, [{ roleKey: 'reporter', name: '林小满' }], ['reporter']),
    [],
  );
  const played = withCompanions(scenario, companions);
  assert.equal(JSON.stringify(scenario), before, '原来的剧本没被改');
  assert.equal(played.npcs.length, scenario.npcs.length + 2);
  assert.equal(played.roles.length, scenario.roles.length - 2);
  assert.match(played.npcs.find((n) => n.key === 'ai-reporter-2')!.knows[0], /（这里的「你」就是他）$/);
  // 地下城没有 AI 队友
  assert.deepEqual(companionsOf({ ...scenario, dungeon: {} as Scenario['dungeon'] }, [{ roleKey: 'reporter', name: '林小满' }]), []);

  const team = [{ name: '林小满', roleName: '上海来的记者' }];
  assert.match(buildStorySummaryContext('', [], team), /^跟着大家的 AI 队友（主持人顺带演的 NPC，不是玩家的角色）：林小满（上海来的记者）/);
  assert.match(buildCatchupContext('沈探', [], team), /^玩家的角色：沈探\n跟着大家的 AI 队友/);
  // 没有队友时和以前一样
  assert.equal(buildStorySummaryContext('', []), buildStorySummaryContext('', [], []));
  assert.ok(buildStorySummaryContext('', []).startsWith('# 之前的笔记'));
  assert.ok(buildCatchupContext('沈探', []).startsWith('玩家的角色：沈探\n\n'));
});

test('开局以后中途加入的玩家能接替 AI 演的身份：放在队友现在的位置，记录里写清楚，主持 AI 不再看到这个队友', async () => {
  const roomId = await createRoom('tester2', 'fog-harbor-inn', ['tester3']);
  assert.equal((await pick('tester2', roomId, 'detective', '沈探')).status, 200);
  assert.equal((await seat('tester2', roomId, 'reporter', '林小满')).status, 200);
  assert.equal((await seat('tester2', roomId, 'sailor', '阿海')).status, 200);
  for (const k of ['doctor', 'customs', 'young-master']) assert.equal((await seat('tester2', roomId, k)).status, 200);
  // 准备阶段照旧：选不了，房主取消以后才能选
  let r = await pick('tester3', roomId, 'reporter', '阿青');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个身份交给 AI 演了，房主取消以后才能选');
  await start(roomId, 'tester2');
  assert.equal((await unseat('tester2', roomId, 'reporter')).status, 409, '开局以后房主还是不能取消');
  await act(roomId, 'tester2', '让林小满先去码头等着 [NPC ai-reporter pier]');
  const worldOf = () => JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string }).world);
  assert.equal(worldOf().npcs['ai-reporter'].location, 'pier');

  // 名字不能用别的 AI 队友的（接替的那个除外，见下面的阿海）
  r = await pick('tester3', roomId, 'reporter', '阿海');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个名字已经给 AI 队友用了，换一个吧');
  r = await pick('tester3', roomId, 'reporter', '阿青');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const seatsLeft = () => (t.app.db.prepare('SELECT role_key FROM ai_seats WHERE room_id = ? ORDER BY role_key').all(roomId) as { role_key: string }[]).map((x) => x.role_key);
  assert.deepEqual(seatsLeft(), ['customs', 'doctor', 'sailor', 'young-master'], '这个身份不再交给 AI');
  const placed = (who: Who) =>
    ({ ...(t.app.db.prepare('SELECT c.name, c.location FROM characters c JOIN players p ON p.id = c.player_id JOIN users u ON u.id = p.user_id WHERE c.room_id = ? AND u.username = ?').get(roomId, who) as object) });
  assert.deepEqual(placed('tester3'), { name: '阿青', location: 'pier' }, '放在队友现在的位置');
  const nameOf = (who: Who) => (t.app.db.prepare('SELECT display_name FROM users WHERE username = ?').get(who) as { display_name: string }).display_name;
  let texts = await logTexts(roomId, 'tester3');
  assert.ok(texts.includes(`${nameOf('tester3')} 的角色「阿青」接替了 AI 演的「${REPORTER.name}」（原来叫林小满）`), texts.join('\n'));
  assert.ok(texts.some((x) => x.startsWith(`你是阿青，${REPORTER.name}。`) && x.endsWith('你现在在「码头」。')), '私下告诉他身份和位置');
  const g = await game(roomId, 'tester3');
  assert.deepEqual(g.companions.map((c: { roleKey: string }) => c.roleKey), ['doctor', 'customs', 'young-master', 'sailor']);
  assert.equal(g.scenario.roles.find((x: { key: string }) => x.key === 'reporter').takenBy, '阿青');

  // 主持 AI：剧本里没有这个队友了，身份回到 roles 里；他原来的状态还在 world.npcs 里，但局面里不列
  fake.requests.length = 0;
  await act(roomId, 'tester3', '在码头四处看看');
  const dm = dmRequests()[0];
  const played = scenarioOf(dm);
  assert.ok(!played.npcs.some((n) => n.key === 'ai-reporter'));
  assert.ok(played.roles.some((x) => x.key === 'reporter'));
  assert.ok(played.npcs.some((n) => n.key === 'ai-sailor' && n.name === '阿海'), '别的队友还在，key 不变');
  const context = firstUserText(dm);
  assert.ok(worldOf().npcs['ai-reporter'], '原来的状态留着');
  const npcSection = context.slice(context.indexOf('## NPC 的变化'), context.indexOf('## 已处理的时间线事件'));
  assert.ok(!npcSection.includes('ai-reporter'), npcSection);
  const team = context.match(/跟着大家的 AI 队友（你顺带演，在 npcs 里）：([^\n]*)/)?.[1] ?? '';
  assert.ok(!team.includes('林小满') && team.includes('阿海（ai-sailor，'), team);
  // 换了名字：主持 AI 在角色那几行里看得到他之前叫什么（之前的叙述里写的是林小满）
  const formerLine = '  之前叫「林小满」：这个身份原来是你顺带演的 AI 队友，现在换成玩家来演，改了名字；之前故事里的「林小满」就是他';
  assert.match(context, new RegExp(`\\] 阿青｜身份：${REPORTER.name}（reporter）｜所在：码头（pier）\\n${formerLine}\\n`));
  const formerOf = (who: Who) =>
    (t.app.db.prepare('SELECT c.former_name FROM characters c JOIN players p ON p.id = c.player_id JOIN users u ON u.id = p.user_id WHERE c.room_id = ? AND u.username = ?').get(roomId, who) as { former_name: string | null }).former_name;
  assert.equal(formerOf('tester3'), '林小满');

  // 开局以后才加入的人也能接替；可以接着用队友的名字，括号就不写了；队友没记过位置的，放在身份的起点
  const code = (t.app.db.prepare('SELECT join_code FROM rooms WHERE id = ?').get(roomId) as { join_code: string }).join_code;
  assert.equal((await as('tester5')('POST', '/api/rooms/join', { code })).status, 200);
  r = await pick('tester5', roomId, 'sailor', '回乡的留洋医生');
  assert.equal(r.status, 409, '别的队友的名字（没起名字的就是身份名）还是不行');
  r = await pick('tester5', roomId, 'sailor', '阿海');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(placed('tester5'), { name: '阿海', location: 'lobby' });
  texts = await logTexts(roomId, 'tester5');
  assert.ok(texts.includes(`${nameOf('tester5')} 的角色「阿海」接替了 AI 演的「顺风号的水手」`), texts.join('\n'));
  assert.deepEqual(seatsLeft(), ['customs', 'doctor', 'young-master']);
  // 名字没变的不用记；换了名字的那条每次结算都在
  assert.equal(formerOf('tester5'), null);
  fake.requests.length = 0;
  await act(roomId, 'tester5', '在大堂歇歇脚');
  const later = firstUserText(dmRequests()[0]);
  assert.ok(later.includes(`\n${formerLine}\n`), later);
  assert.ok(!later.includes('之前叫「阿海」'));

  // 接替的位置：死了的、不在任何地点的、地点不对的，放在身份的起点；不是交给 AI 的身份没有
  const at = (state: object) => takeoverOf(t.app.db, roomId, 'doctor', { ...emptyWorld(), npcs: { 'ai-doctor': state } })?.location;
  assert.equal(at({ location: 'pier' }), 'pier');
  assert.equal(at({ location: 'pier', dead: true }), 'lobby');
  assert.equal(at({ location: null }), 'lobby');
  assert.equal(at({ location: 'moon' }), 'lobby');
  assert.equal(takeoverOf(t.app.db, roomId, 'detective', emptyWorld()), null);
  assert.equal(takeoverText('小明', '阿青', '记者', '记者'), '小明 的角色「阿青」接替了 AI 演的「记者」');
});

test('AI 队友不能用剧本里别的身份的名字；和 NPC 重名不拦，主持 AI 靠 key 和「AI 队友」的标记分得清', async () => {
  const roomId = await createRoom('tester4', 'fog-harbor-inn');
  let r = await seat('tester4', roomId, 'doctor', '海关稽查员');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这是剧本里别的身份的名字，换一个吧');
  assert.equal((await seat('tester4', roomId, 'doctor', '回乡的留洋医生')).status, 200, '自己身份的名字可以');
  r = await seat('tester4', roomId, 'doctor', '私家侦探');
  assert.equal(r.status, 409, '改名字也一样');
  assert.equal((await seat('tester4', roomId, 'detective', '沈三娘')).status, 200, '和 NPC 重名不拦');
  assert.equal((await pick('tester4', roomId, 'reporter', '林记者')).status, 200);
  await start(roomId, 'tester4');
  fake.requests.length = 0;
  await act(roomId, 'tester4', '找沈三娘聊聊');
  const dm = dmRequests()[0];
  const same = scenarioOf(dm).npcs.filter((n) => n.name === '沈三娘');
  assert.deepEqual(same.map((n) => n.key), ['shen', 'ai-detective']);
  assert.ok(!same[0].identity.startsWith('AI 队友'));
  assert.ok(same[1].identity.startsWith('AI 队友（没人玩的身份「私家侦探」'));
  assert.match(firstUserText(dm), /跟着大家的 AI 队友（你顺带演，在 npcs 里）：[^\n]*；沈三娘（ai-detective，身份「私家侦探」），现在在 二楼客房/);
  assert.match(COMPANION_RULE, /和剧本里的 NPC 重名时，认 key/);
});

test('AI 队友的态度照剧本的玩家关系；主持规则把三种关系都写了', async () => {
  const base = validateScenario(FIXTURE).scenario as Scenario;
  const companions = companionsOf(base, [{ roleKey: 'reporter', name: '林小满' }]);
  for (const relation of ['coop', 'secrets', 'versus'] as const) {
    const npc = withCompanions({ ...base, relation }, companions).npcs.find((n) => n.key === 'ai-reporter');
    assert.equal(npc?.attitude, COMPANION_ATTITUDE[relation], relation);
  }
  assert.match(COMPANION_ATTITUDE.coop, /一伙的/);
  assert.equal(COMPANION_ATTITUDE.secrets, '和大家同行，但有自己的秘密和目标');
  assert.equal(COMPANION_ATTITUDE.versus, '有自己的立场，可能和别人对着干');
  assert.match(COMPANION_RULE, /合作的剧本里他和大家是一伙的；各有秘密的，他和大家同行，但有自己的秘密和目标；互相对立的，他有自己的立场，可能和别人对着干。不管哪种，都只在玩家的行动牵扯到他/);
  assert.match(COMPANION_RULE, /不抢玩家的戏，不替玩家做决定/);
  assert.match(COMPANION_RULE, /他开场时知道的事照 knows 来，之后他在场时发生的事他也知道/);
  assert.doesNotMatch(COMPANION_RULE, /比如/);

  // 《盟主令》是互相对立的剧本
  const roomId = await createRoom('tester3', 'mengzhu-ling');
  assert.equal((await seat('tester3', roomId, 'healer', '苏回春')).status, 200);
  assert.equal((await pick('tester3', roomId, 'snow-sword', '叶听雪')).status, 200);
  await start(roomId, 'tester3');
  fake.requests.length = 0;
  await act(roomId, 'tester3', '在东院练剑');
  const npc = scenarioOf(dmRequests()[0]).npcs.find((n) => n.key === 'ai-healer');
  assert.equal(npc?.name, '苏回春');
  assert.equal(npc?.attitude, COMPANION_ATTITUDE.versus);
});

test('NPC key 按剧本里所有的身份排：有人接替了一个队友，别的队友的 key 不变', () => {
  const base = validateScenario(FIXTURE).scenario as Scenario;
  const scenario: Scenario = {
    ...base,
    roles: [...base.roles, { ...base.roles[0], key: 'reporter-2', name: '另一个记者' }],
    npcs: [...base.npcs, { ...base.npcs[0], key: 'ai-reporter', name: '冒名的人' }],
  };
  const seats = [
    { roleKey: 'reporter', name: '林小满' },
    { roleKey: 'reporter-2', name: '林大满' },
  ];
  assert.deepEqual(
    companionsOf(scenario, seats).map((c) => [c.roleKey, c.npcKey]),
    [
      ['reporter', 'ai-reporter-2'],
      ['reporter-2', 'ai-reporter-2-2'],
    ],
  );
  assert.deepEqual(
    companionsOf(scenario, seats, ['reporter']).map((c) => [c.roleKey, c.npcKey]),
    [['reporter-2', 'ai-reporter-2-2']],
  );
});
