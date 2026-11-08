// V0.8.0：名场面（收藏对局记录）和战报卡片的数据。
// 看得到的规矩必须和对局记录接口一样：别人的私密记录、悄悄做的行动、不在场时的叙述、悄悄话都收藏不了，报错也不透露它存在。
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeProvider, say, useTools } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse, TextBlock, ToolResultBlock } from '../server/ai/types';
import { insertLog } from '../server/game/log';
import { reportData, type ReportCache } from '../server/highlights';
import { HIGHLIGHT_TOGGLES_PER_MINUTE, REPORTS_PER_MINUTE } from '../server/routes/highlights';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { defaultReportPicks, HIGHLIGHT_LIMIT } from '../shared/highlights';
import { reportFileName, wrapText } from '../web/src/room/report-card';
import { sleep, startTestApp } from './helpers';

const [, TESTER1, TESTER2, TESTER3, TESTER4] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 28, 11, 0, 0);
const dice: number[] = [];

function userText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 假主持人：估时看 [分钟 N]；结算按 [检定 属性] [暗骰] [私信 内容] [结局 key] 调用工具，叙述是「叙述：行动」。 */
function scriptedDm(req: MessagesRequest): MessagesResponse {
  const context = userText(req);
  if (req.output_config?.format) return say(JSON.stringify({ minutes: Number(context.match(/\[分钟 (\d+)\]/)?.[1] ?? 15), reason: '测试', kind: 'action' }));
  if (!req.tools?.length) return say('（测试）');
  const block = context.slice(context.indexOf('# 这次要结算的行动'));
  const quotes = [...block.matchAll(/「([^」]*)」/g)];
  const text = quotes[quotes.length - 1]?.[1] ?? '';
  const actorId = Number(block.match(/编号 (\d+)/)?.[1]);
  const last = req.messages[req.messages.length - 1];
  const results = last.role === 'user' && Array.isArray(last.content) ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  if (results.length) return say(`叙述：${text}`);
  const calls: { name: string; input: unknown }[] = [];
  for (const [, cmd, arg] of text.matchAll(/\[(检定|暗骰|私信|结局) ?([^\]]*)\]/g)) {
    if (cmd === '检定') calls.push({ name: 'roll_check', input: { character: actorId, attribute: arg || 'perception', modifier: 0, reason: '测试检定' } });
    if (cmd === '暗骰') calls.push({ name: 'roll_check', input: { character: actorId, attribute: 'perception', modifier: 0, reason: '暗中察觉', hidden: true } });
    if (cmd === '私信') calls.push({ name: 'private_message', input: { character: actorId, text: arg } });
    if (cmd === '结局') calls.push({ name: 'end_game', input: { ending: arg, epilogue: '雾散了，一切尘埃落定。' } });
  }
  return calls.length ? useTools(...calls) : say(`叙述：${text}`);
}

let t: Awaited<ReturnType<typeof startTestApp>>;
type Who = 'tester1' | 'tester2' | 'tester3' | 'tester4' | 'guest';
let cookies: Record<Who, string>;

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(scriptedDm), now: () => now, rng: () => dice.shift() ?? 3, tickMs: 0 });
  cookies = {
    tester1: await t.login(TESTER1.username, TESTER1.password),
    tester2: await t.login(TESTER2.username, TESTER2.password),
    tester3: await t.login(TESTER3.username, TESTER3.password),
    tester4: await t.login(TESTER4.username, TESTER4.password),
    guest: (await t.call('POST', '/api/auth/guest')).cookie!,
  };
});

after(async () => {
  await t.close();
});

beforeEach(() => {
  dice.length = 0;
});

const call = (who: Who, method: string, url: string, body?: unknown) => t.call(method, url, body, cookies[who]);

const ROLES = {
  reporter: { name: '林小满', roleKey: 'reporter' }, // 大堂
  doctor: { name: '许医生', roleKey: 'doctor' }, // 大堂
  detective: { name: '沈探', roleKey: 'detective' }, // 二楼客房
};

/** 建一局《雾港旅店》、建好角色、开局。没人开着页面：计时模式。第一个人是房主。 */
async function startedRoom(players: [Who, keyof typeof ROLES][], name = '名场面测试') {
  const host = players[0][0];
  const created = await call(host, 'POST', '/api/rooms', { name, maxPlayers: 4 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.room.id as number;
  for (const [who] of players.slice(1)) assert.equal((await call(who, 'POST', '/api/rooms/join', { code: created.data.room.joinCode })).status, 200);
  assert.equal((await call(host, 'POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' })).status, 200);
  for (const [who, role] of players) assert.equal((await call(who, 'PUT', `/api/rooms/${id}/character`, ROLES[role])).status, 200);
  assert.equal((await call(host, 'POST', `/api/rooms/${id}/status`, { status: 'running' })).status, 200);
  return id;
}

/** 交一个行动，让时间过去，等它结算完。 */
async function act(roomId: number, who: Who, text: string, secret = false) {
  const r = await call(who, 'POST', `/api/rooms/${roomId}/act`, { text, as: 'action', secret });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.engine.idle();
  now += 16 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

const log = async (roomId: number, who: Who) => (await call(who, 'GET', `/api/rooms/${roomId}/log`)).data.entries as any[];
const star = (roomId: number, who: Who, logId: number) => call(who, 'POST', `/api/rooms/${roomId}/highlights`, { logId });
const list = async (roomId: number, who: Who) => (await call(who, 'GET', `/api/rooms/${roomId}/highlights`)).data.highlights as any[];
const report = async (roomId: number, who: Who) => {
  const r = await call(who, 'GET', `/api/rooms/${roomId}/report`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
/** 数据库里这个人在这一局存着几条收藏。 */
const savedRows = (userId: number, roomId: number) =>
  (t.app.db.prepare('SELECT COUNT(*) AS n FROM highlights WHERE user_id = ? AND room_id = ?').get(userId, roomId) as { n: number }).n;
const userId = (who: Who) => {
  const username = { tester1: TESTER1, tester2: TESTER2, tester3: TESTER3, tester4: TESTER4 }[who as 'tester1'].username;
  return (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
};

test('收藏、取消：重复收藏不重复，列表按记录的先后，内容是自己看得到的样子', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'],
    ['tester4', 'doctor'],
  ]);
  dice.push(5, 4);
  await act(roomId, 'tester1', '在大堂里四处看看 [检定 perception]');
  const entries = await log(roomId, 'tester1');
  const opening = entries.find((e) => e.data?.type === 'opening');
  const turn = entries.find((e) => e.data?.type === 'resolution');
  assert.ok(opening && turn);

  // 先收藏后面的，再收藏前面的：列表按记录的先后
  let r = await star(roomId, 'tester1', turn.id);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(
    { type: r.data.highlight.type, label: r.data.highlight.label, who: r.data.highlight.who, text: r.data.highlight.text, onlyMe: r.data.highlight.onlyMe },
    { type: 'resolution', label: '林小满', who: '林小满', text: '叙述：在大堂里四处看看 [检定 perception]', onlyMe: false },
  );
  assert.ok(r.data.highlight.action.includes('在大堂里四处看看'));
  assert.equal(r.data.highlight.savedAt, now);
  r = await star(roomId, 'tester1', opening.id);
  assert.equal(r.status, 201);
  assert.equal(r.data.highlight.label, '开场：雾港旅店');

  // 再收藏一次：不重复，还是原来那一条
  r = await star(roomId, 'tester1', opening.id);
  assert.equal(r.status, 200);
  assert.equal(savedRows(userId('tester1'), roomId), 2);
  assert.deepEqual((await list(roomId, 'tester1')).map((h) => h.logId), [opening.id, turn.id]);

  // 收藏是私人的：同一局的人看不到
  assert.deepEqual(await list(roomId, 'tester4'), []);

  // 取消；再取消一次也不出错
  r = await call('tester1', 'DELETE', `/api/rooms/${roomId}/highlights/${turn.id}`);
  assert.deepEqual([r.status, r.data.removed], [200, true]);
  r = await call('tester1', 'DELETE', `/api/rooms/${roomId}/highlights/${turn.id}`);
  assert.deepEqual([r.status, r.data.removed], [200, false]);
  assert.deepEqual((await list(roomId, 'tester1')).map((h) => h.logId), [opening.id]);

  // 对白能收藏；系统提示、场外聊天不能
  assert.equal((await call('tester4', 'POST', `/api/rooms/${roomId}/say`, { text: '这雾怕是要到天亮才散。' })).status, 201);
  const said = (await log(roomId, 'tester1')).find((e) => e.data?.type === 'say');
  r = await star(roomId, 'tester1', said.id);
  assert.equal(r.status, 201);
  assert.equal(r.data.highlight.label, '许医生说');
  assert.equal(r.data.highlight.who, '许医生');
  const system = entries.find((e) => e.kind === 'system');
  r = await star(roomId, 'tester1', system.id);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /不能收藏/);
  const chat = await call('tester4', 'POST', `/api/rooms/${roomId}/chat`, { text: '我先去倒杯水' });
  r = await star(roomId, 'tester1', chat.data.entry.id);
  assert.equal(r.status, 400);
  // 请求不对
  assert.equal((await call('tester1', 'POST', `/api/rooms/${roomId}/highlights`, { logId: 'abc' })).status, 400);
  assert.equal((await call('tester1', 'POST', `/api/rooms/${roomId}/highlights`, {})).status, 400);
});

test('不是成员的人（包括在大厅里观看的人）、游客都不能收藏，也拿不到列表和战报', async () => {
  const roomId = await startedRoom([['tester1', 'reporter']]);
  assert.equal((await call('tester1', 'PUT', `/api/rooms/${roomId}/public`, { isPublic: true })).status, 200);
  const opening = (await log(roomId, 'tester1')).find((e) => e.data?.type === 'opening');
  // 公开的对局：tester3 能观看，看得到开场
  assert.ok((await log(roomId, 'tester3')).some((e) => e.id === opening.id));
  for (const [who, status] of [
    ['tester3', 404],
    ['guest', 403],
  ] as const) {
    assert.equal((await star(roomId, who, opening.id)).status, status, who);
    assert.equal((await call(who, 'GET', `/api/rooms/${roomId}/highlights`)).status, status, who);
    assert.equal((await call(who, 'DELETE', `/api/rooms/${roomId}/highlights/${opening.id}`)).status, status, who);
    assert.equal((await call(who, 'GET', `/api/rooms/${roomId}/report`)).status, status, who);
  }
  assert.equal(savedRows(userId('tester3'), roomId), 0);
  assert.equal((await call('tester1', 'GET', '/api/rooms/999999/highlights')).status, 404);
});

test('看不到的条目收藏不了：别人的身份、悄悄做的行动、私下告诉别人的事、不在场时的叙述、别人的悄悄话；报错和不存在的一样', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'], // 大堂
    ['tester2', 'detective'], // 二楼客房
    ['tester4', 'doctor'], // 大堂
  ]);
  const other = await startedRoom([['tester2', 'detective']], '别的对局');
  await act(roomId, 'tester1', '翻看登记簿 [检定 intellect] [私信 你注意到柜台下面有一滩水]');
  await act(roomId, 'tester1', '悄悄撬开柜台的锁 [检定 agility]', true);
  const docCharacter = (await call('tester4', 'GET', `/api/rooms/${roomId}/game`)).data.me.id;
  assert.equal((await call('tester1', 'POST', `/api/rooms/${roomId}/say`, { text: '待会儿去地窖看看', to: docCharacter })).status, 201);

  const mine = await log(roomId, 'tester1');
  const role = mine.find((e) => e.data?.type === 'role');
  const privateNote = mine.find((e) => e.data?.type === 'private');
  const [openTurn, secretTurn] = mine.filter((e) => e.data?.type === 'resolution');
  const whisper = mine.find((e) => e.data?.type === 'say');
  assert.ok(role && privateNote && openTurn && secretTurn && whisper);
  assert.equal(secretTurn.data.secret, true);
  const elsewhere = (await log(other, 'tester2')).find((e) => e.data?.type === 'opening');

  const missing = await star(roomId, 'tester2', 99_999_999);
  assert.equal(missing.status, 404);
  const cases: [Who, number, string][] = [
    ['tester2', role.id, '别人的身份'],
    ['tester4', role.id, '同一地点的人的身份'],
    ['tester2', privateNote.id, '主持人私下告诉别人的事'],
    ['tester4', privateNote.id, '在场的人也看不到私下告诉别人的事'],
    ['tester2', openTurn.id, '不在场时的叙述'],
    ['tester4', secretTurn.id, '在场的人看不到悄悄做的行动'],
    ['tester2', whisper.id, '别人的悄悄话'],
    ['tester1', elsewhere.id, '别的对局的记录'],
  ];
  for (const [who, logId, what] of cases) {
    const r = await star(roomId, who, logId);
    assert.deepEqual([r.status, r.data.error], [missing.status, missing.data.error], what);
  }
  for (const who of ['tester2', 'tester4'] as const) assert.equal(savedRows(userId(who), roomId), 0);

  // 看得到的照样能收藏：在场的人看得到公开做的行动、说给自己的悄悄话
  assert.equal((await star(roomId, 'tester4', openTurn.id)).status, 201);
  const heard = await star(roomId, 'tester4', whisper.id);
  assert.equal(heard.status, 201);
  assert.equal(heard.data.highlight.label, '林小满悄悄对许医生说');
  for (const e of [role, privateNote, openTurn, secretTurn, whisper]) assert.equal((await star(roomId, 'tester1', e.id)).status, 201);
  const saved = await list(roomId, 'tester1');
  const labels = saved.map((h) => h.label);
  assert.ok(labels.includes('你的身份') && labels.includes('只有你察觉到'));
  // 只有你知道：身份、只有你察觉到的事、悄悄做的行动；在场的人都看得到的行动、两个人的悄悄话不算
  const onlyMe = (id: number) => saved.find((h) => h.logId === id).onlyMe;
  assert.deepEqual([role, privateNote, secretTurn, openTurn, whisper].map((e) => onlyMe(e.id)), [true, true, true, false, false]);
  assert.deepEqual([role, privateNote, secretTurn, openTurn, whisper].map((e) => saved.find((h) => h.logId === e.id).whisper), [false, false, false, false, true]);
  // 战报默认放的：按先后、跳过只有你知道的和悄悄话，不够 3 条就少放
  assert.deepEqual(defaultReportPicks(saved), [openTurn.id]);

  // 列表和对局记录用同一套规矩：看不到了（知情表里没有他了）的就不在列表里
  t.app.db.prepare("DELETE FROM knowledge WHERE content_type = 'log' AND content_id = ?").run(privateNote.id);
  assert.ok(!(await list(roomId, 'tester1')).some((h) => h.logId === privateNote.id));
});

test('每人每局最多收藏 200 条；别的对局、别人不受影响', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'],
    ['tester4', 'doctor'],
  ]);
  const insert = t.app.db.prepare(
    `INSERT INTO log_entries (room_id, kind, visibility, text, data, game_time, created_at)
     VALUES (?, 'narration', 'all', ?, '{"type":"say","speaker":"林小满","to":null}', 1320, ?)`,
  );
  const ids: number[] = [];
  for (let i = 0; i < HIGHLIGHT_LIMIT + 2; i++) ids.push(Number(insert.run(roomId, `第${i}句`, now).lastInsertRowid));
  const me = userId('tester1');
  const save = t.app.db.prepare('INSERT INTO highlights (user_id, room_id, log_id, created_at) VALUES (?, ?, ?, ?)');
  for (const id of ids.slice(0, HIGHLIGHT_LIMIT - 1)) save.run(me, roomId, id, now);

  assert.equal((await star(roomId, 'tester1', ids[HIGHLIGHT_LIMIT - 1])).status, 201);
  const full = await star(roomId, 'tester1', ids[HIGHLIGHT_LIMIT]);
  assert.equal(full.status, 409);
  assert.match(full.data.error, /最多收藏200条/);
  // 收藏过的再收藏一次不算超
  assert.equal((await star(roomId, 'tester1', ids[0])).status, 200);
  assert.equal((await list(roomId, 'tester1')).length, HIGHLIGHT_LIMIT);
  // 取消一条就又能收藏了；别人、别的对局不受影响
  assert.equal((await call('tester1', 'DELETE', `/api/rooms/${roomId}/highlights/${ids[0]}`)).status, 200);
  assert.equal((await star(roomId, 'tester1', ids[HIGHLIGHT_LIMIT])).status, 201);
  assert.equal((await star(roomId, 'tester4', ids[HIGHLIGHT_LIMIT + 1])).status, 201);
  const other = await startedRoom([['tester1', 'reporter']], '另一局');
  const opening = (await log(other, 'tester1')).find((e) => e.data?.type === 'opening');
  assert.equal((await star(other, 'tester1', opening.id)).status, 201);
});

test('条目没了收藏也没了：撤回结算删掉的记录、删掉的对局', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'],
    ['tester4', 'doctor'],
  ]);
  await act(roomId, 'tester1', '推开后门 [检定 body] [私信 门外的泥地上有一串脚印]');
  const entries = await log(roomId, 'tester1');
  const turn = entries.find((e) => e.data?.type === 'resolution');
  const note = entries.find((e) => e.data?.type === 'private');
  const opening = entries.find((e) => e.data?.type === 'opening');
  for (const e of [turn, note, opening]) assert.equal((await star(roomId, 'tester1', e.id)).status, 201);
  assert.equal((await star(roomId, 'tester4', turn.id)).status, 201);

  assert.deepEqual((await report(roomId, 'tester1')).actions, { total: 1, mine: 1 });
  const undo = await call('tester1', 'POST', `/api/rooms/${roomId}/host/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  // 战报数过的结果缓存着：撤回以后记录变了，要重新数
  assert.deepEqual((await report(roomId, 'tester1')).actions, { total: 0, mine: 0 });
  assert.equal((await report(roomId, 'tester1')).rolls.all.total, 0);
  assert.deepEqual((await list(roomId, 'tester1')).map((h) => h.logId), [opening.id], '撤回的那次结算的记录跟着没了');
  assert.deepEqual(await list(roomId, 'tester4'), []);
  assert.equal(savedRows(userId('tester1'), roomId), 1);
  assert.equal(savedRows(userId('tester4'), roomId), 0);

  assert.equal((await call('tester1', 'DELETE', `/api/rooms/${roomId}`)).status, 200);
  assert.equal(savedRows(userId('tester1'), roomId), 0, '对局删了收藏一起删');
});

test('收藏只推给自己开着这一局的页面', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'],
    ['tester4', 'doctor'],
  ]);
  const opening = (await log(roomId, 'tester1')).find((e) => e.data?.type === 'opening');
  const mine = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  const theirs = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester4);
  await star(roomId, 'tester1', opening.id);
  const added = await mine.waitFor((e) => e.event === 'highlights');
  assert.deepEqual([added.data.roomId, added.data.logId, added.data.on, added.data.item.label], [roomId, opening.id, true, '开场：雾港旅店']);
  await call('tester1', 'DELETE', `/api/rooms/${roomId}/highlights/${opening.id}`);
  await mine.waitFor((e) => e.event === 'highlights' && !e.data.on);
  await sleep(100);
  assert.ok(!theirs.events.some((e) => e.event === 'highlights'), '别人收不到');
  mine.close();
  theirs.close();
});

test('战报数据：只算自己看得到的（暗骰、别人的私密内容不算），角色只有成员的，结局要结束了才给', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'], // 大堂，感知 +1
    ['tester2', 'detective'], // 二楼客房
  ]);
  const start = (await log(roomId, 'tester1')).find((e) => e.data?.type === 'opening').createdAt;
  // AI 演的队友（AI 补位）不是成员，不在角色里
  if (t.app.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_seats'").get()) {
    t.app.db.prepare("INSERT INTO ai_seats (room_id, role_key, name, created_at) VALUES (?, 'doctor', '队友许医生', ?)").run(roomId, now);
  }

  let r = await report(roomId, 'tester1');
  assert.equal(r.room.name, '名场面测试');
  assert.deepEqual(r.scenario, { title: '雾港旅店', category: null });
  assert.deepEqual(
    r.characters,
    [
      { name: '林小满', roleName: '上海来的记者', playerName: '测试玩家一', mine: true, dead: false },
      { name: '沈探', roleName: '私家侦探', playerName: '测试玩家二', mine: false, dead: false },
    ],
  );
  assert.equal(r.startedAt, start);
  assert.deepEqual([r.endedAt, r.rounds, r.actions, r.rolls.all.total, r.rolls.mine.total, r.ending], [null, 0, { total: 0, mine: 0 }, 0, 0, null]);

  // 林小满：一次看得到的检定（两个 6，大成功）、一次暗骰（两个 1）；私下得知一件事
  dice.push(6, 6, 1, 1);
  await act(roomId, 'tester1', '盯着楼梯口 [检定 perception] [暗骰] [私信 楼梯口有人影一闪]');
  // 沈探在二楼：他的检定（两个 1，大失败）林小满看不到
  dice.push(1, 1);
  await act(roomId, 'tester2', '在客房里翻找 [检定 perception]');
  // 林小满悄悄做的：只有他自己看得到（3+3+1=7，有代价的成功）
  dice.push(3, 3);
  await act(roomId, 'tester1', '偷偷翻老板娘的抽屉 [检定 perception]', true);

  const own = (await log(roomId, 'tester1')).filter((e) => e.data?.type === 'resolution' || e.data?.type === 'private');
  for (const e of own) assert.equal((await star(roomId, 'tester1', e.id)).status, 201);

  r = await report(roomId, 'tester1');
  assert.deepEqual(r.rolls.all, { total: 2, counts: { critical: 1, success: 0, partial: 1, failure: 0, fumble: 0 } }, '暗骰、别处的检定不算');
  assert.deepEqual(r.highlights.map((h: any) => h.onlyMe), [false, true, true]);
  assert.deepEqual(defaultReportPicks(r.highlights), [r.highlights[0].logId], '只有你知道的默认不放');
  assert.deepEqual(r.rolls.mine, r.rolls.all);
  assert.deepEqual(r.actions, { total: 2, mine: 2 });
  assert.equal(r.highlights.length, 3);

  const theirs = await report(roomId, 'tester2');
  assert.deepEqual(theirs.rolls.all, { total: 1, counts: { critical: 0, success: 0, partial: 0, failure: 0, fumble: 1 } });
  assert.deepEqual(theirs.actions, { total: 1, mine: 1 });
  assert.deepEqual(theirs.highlights, [], '别人的收藏不给');
  const text = JSON.stringify(theirs);
  for (const secret of ['楼梯口有人影一闪', '偷偷翻老板娘的抽屉', '盯着楼梯口', '线人']) assert.ok(!text.includes(secret), `不能出现：${secret}`);
  assert.equal(theirs.characters.find((c: any) => c.name === '沈探').mine, true);

  // 世界里有了结局、对局还没结束（不该有的情况）：照样不给
  t.app.db
    .prepare("UPDATE rooms SET world = json_set(world, '$.ending', json(?)) WHERE id = ?")
    .run(JSON.stringify({ key: 'truth', title: '真相大白', epilogue: '提前写好的', at: 0 }), roomId);
  assert.equal((await report(roomId, 'tester1')).ending, null);
  t.app.db.prepare("UPDATE rooms SET world = json_remove(world, '$.ending') WHERE id = ?").run(roomId);

  // 走到结局：结束了才给结局的标题和收尾，不给真相
  const before = now;
  await act(roomId, 'tester1', '把证据摆在大家面前 [结局 truth]');
  r = await report(roomId, 'tester1');
  assert.equal(r.room.status, 'ended');
  assert.deepEqual(r.ending, { title: '真相大白', epilogue: '雾散了，一切尘埃落定。' });
  assert.ok(r.endedAt >= before && r.endedAt <= now);
  assert.ok(!JSON.stringify(r).includes('鸦片'), '不给真相');
  assert.deepEqual((await report(roomId, 'tester2')).ending, r.ending, '结局大家都看得到');
  const endingEntry = (await log(roomId, 'tester1')).find((e) => e.data?.type === 'ending');
  assert.equal((await star(roomId, 'tester1', endingEntry.id)).status, 201);
  const withEnding = (await report(roomId, 'tester1')).highlights;
  assert.equal(withEnding[withEnding.length - 1].type, 'ending');
  assert.deepEqual(defaultReportPicks(withEnding), [withEnding[0].logId], '结局（剧透）默认也不放');

  // 房主直接结束、没走到结局的：没有结局
  const plain = await startedRoom([['tester1', 'reporter']], '没走到结局');
  now += 5 * MIN;
  assert.equal((await call('tester1', 'POST', `/api/rooms/${plain}/status`, { status: 'ended' })).status, 200);
  const ended = await report(plain, 'tester1');
  assert.equal(ended.ending, null);
  assert.equal(ended.endedAt, now);
  assert.equal(ended.endedAt - ended.startedAt, 5 * MIN);
});

test('战报卡片的折行（canvas 不会自己折行）：按字折、句读不放行首、开括号不留行尾、英文单词不断开、放不下截断加省略号', () => {
  const width = (s: string) => [...s].length; // 一个字算 1
  assert.deepEqual(wrapText(width, '一二三四五六七八九十', 4), ['一二三四', '五六七八', '九十']);
  assert.deepEqual(wrapText(width, '一二三四，五六', 4), ['一二三四，', '五六'], '逗号挂在上一行末尾');
  assert.deepEqual(wrapText(width, '一二三「四五」六', 4), ['一二三', '「四五」', '六']);
  assert.deepEqual(wrapText(width, 'ab hello world', 7), ['ab ', 'hello ', 'world']);
  assert.deepEqual(wrapText(width, 'abcdefghij', 4), ['abcd', 'efgh', 'ij'], '一个词比一行还长才按字断开');
  assert.deepEqual(wrapText(width, '第一段\n第二段', 10), ['第一段', '第二段']);
  assert.deepEqual(wrapText(width, '一二三四五六七八九十', 4, 2), ['一二三四', '五六……']);
  assert.deepEqual(wrapText(width, '一二三四五六七。八九十', 4, 2), ['一二三四', '五六……']);
  assert.equal(reportFileName('雾港/旅店 周五团'), '龙娘跑团战报-雾港_旅店_周五团.png');
});

test('战报要把一整局数一遍：同样的情况第二次直接用缓存；有了新记录就重新数；敌人的攻击不算检定', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter'],
    ['tester4', 'doctor'],
  ], '战报缓存');
  const me = userId('tester1');
  const cache: ReportCache = new Map();
  assert.deepEqual(reportData(t.app.db, roomId, me, now, cache).actions, { total: 0, mine: 0 });
  // 一条大家都看得到的行动结果：林小满一次成功；地下城里敌人打他的那一下（大成功）不是角色的检定
  const card = (who: string, outcome: string, enemy = false) => ({
    who,
    reason: '测试',
    attribute: '感知',
    dice: [5, 5],
    parts: [{ label: '骰子', value: 10 }],
    total: 11,
    outcome,
    ...(enemy ? { combat: { kind: 'enemy', target: '林小满', defense: 8, hit: true, damage: 2 } } : {}),
  });
  const data = { type: 'resolution', actor: '林小满', action: '测试', gameStart: 1320, gameEnd: 1330, rolls: [card('林小满', 'success'), card('老鼠', 'critical', true)], clues: [], changes: [] };
  const logId = insertLog(t.app.db, { roomId, kind: 'narration', text: '叙述', data: data as never, gameTime: 1330, now });
  let r = reportData(t.app.db, roomId, me, now, cache);
  assert.deepEqual(r.actions, { total: 1, mine: 1 });
  assert.deepEqual(r.rolls.all, { total: 1, counts: { critical: 0, success: 1, partial: 0, failure: 0, fumble: 0 } }, '敌人的攻击不算');
  assert.deepEqual(r.rolls.mine, r.rolls.all);
  assert.equal(reportData(t.app.db, roomId, userId('tester4'), now, cache).rolls.mine!.total, 0, '许医生自己没掷过');
  // 记录没变（同样的情况）：直接用缓存，不再数
  t.app.db.prepare('UPDATE log_entries SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, rolls: [] }), logId);
  assert.equal(reportData(t.app.db, roomId, me, now, cache).rolls.all.total, 1, '同样的情况直接用缓存');
  assert.equal(reportData(t.app.db, roomId, me, now).rolls.all.total, 0, '不给缓存就每次都数');
  // 有了新记录：重新数
  insertLog(t.app.db, { roomId, kind: 'system', text: '新的一条', now });
  r = reportData(t.app.db, roomId, me, now, cache);
  assert.deepEqual([r.actions.total, r.rolls.all.total], [1, 0]);
});

test('战报、收藏按账号限频率：战报每分钟 10 次，收藏和取消每分钟 60 次；超了 429 说清楚，别人不受影响，过一分钟又能用', async () => {
  let clock = Date.UTC(2026, 9, 28, 12, 0, 0);
  const limited = await startTestApp({ ai: new FakeProvider(scriptedDm), now: () => clock, rateLimits: true, tickMs: 0 });
  try {
    const c1 = await limited.login(TESTER1.username, TESTER1.password);
    const c4 = await limited.login(TESTER4.username, TESTER4.password);
    const created = await limited.call('POST', '/api/rooms', { name: '限频率', maxPlayers: 4 }, c1);
    const id = created.data.room.id as number;
    assert.equal((await limited.call('POST', '/api/rooms/join', { code: created.data.room.joinCode }, c4)).status, 200);
    assert.equal((await limited.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, c1)).status, 200);
    assert.equal((await limited.call('PUT', `/api/rooms/${id}/character`, ROLES.reporter, c1)).status, 200);
    assert.equal((await limited.call('PUT', `/api/rooms/${id}/character`, ROLES.doctor, c4)).status, 200);
    assert.equal((await limited.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, c1)).status, 200);

    const url = `/api/rooms/${id}/report`;
    for (let i = 0; i < REPORTS_PER_MINUTE; i++) assert.equal((await limited.call('GET', url, undefined, c1)).status, 200);
    let over = await limited.call('GET', url, undefined, c1);
    assert.equal(over.status, 429);
    assert.match(over.data.error, /战报生成得太频繁了/);
    assert.equal((await limited.call('GET', url, undefined, c4)).status, 200, '别人不受影响');

    const opening = ((await limited.call('GET', `/api/rooms/${id}/log`, undefined, c1)).data.entries as any[]).find((e) => e.data?.type === 'opening');
    for (let i = 0; i < HIGHLIGHT_TOGGLES_PER_MINUTE; i++) {
      const r =
        i % 2 === 0
          ? await limited.call('POST', `/api/rooms/${id}/highlights`, { logId: opening.id }, c1)
          : await limited.call('DELETE', `/api/rooms/${id}/highlights/${opening.id}`, undefined, c1);
      assert.ok(r.status < 300, JSON.stringify(r.data));
    }
    over = await limited.call('POST', `/api/rooms/${id}/highlights`, { logId: opening.id }, c1);
    assert.equal(over.status, 429);
    assert.match(over.data.error, /收藏点得太快了/);
    assert.equal((await limited.call('DELETE', `/api/rooms/${id}/highlights/${opening.id}`, undefined, c1)).status, 429, '取消也算');
    assert.equal((await limited.call('POST', `/api/rooms/${id}/highlights`, { logId: opening.id }, c4)).status, 201, '别人不受影响');

    clock += 61_000;
    assert.equal((await limited.call('GET', url, undefined, c1)).status, 200);
    assert.equal((await limited.call('POST', `/api/rooms/${id}/highlights`, { logId: opening.id }, c1)).status, 201);
  } finally {
    await limited.close();
  }
});
