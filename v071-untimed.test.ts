// 时间按东京算
process.env.TZ = 'Asia/Tokyo';
// V0.7.1：去掉「始终计时」，加「不计时」：人不齐时，在线的人也照样一轮一轮结算（不等不在线的人，也不等现实时间）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { FakeProvider, say } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse, TextBlock } from '../server/ai/types';
import { MIGRATIONS, openDatabase } from '../server/db';
import { UNTIMED_RECONNECT_GRACE_MS, UNTIMED_STARTUP_GRACE_MS } from '../server/game/engine';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, sleep, startTestApp } from './helpers';

const [ADMIN, T1, T2, T3] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 28, 3, 0, 0);

function userText(req: MessagesRequest): string {
  const c = req.messages[0].content as string | TextBlock[];
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 假主持人：估时看行动里写的 [分钟 N]；结算只写一句叙述。 */
const fake = new FakeProvider(async (req): Promise<MessagesResponse> => {
  if (req.output_config?.format) {
    const minutes = Number(userText(req).match(/\[分钟 (\d+)\]/)?.[1] ?? 30);
    return say(JSON.stringify({ minutes, reason: '测试' }));
  }
  return say('叙述：照做了。');
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let c: Record<'admin' | 't1' | 't2' | 't3', string>;
type Who = keyof typeof c;

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

// 《雾港旅店》：记者在大堂，侦探在二楼客房
const reporter = { name: '林小满', roleKey: 'reporter' };
const detective = { name: '沈探', roleKey: 'detective' };
const doctor = { name: '许医生', roleKey: 'doctor' };

/** 建一局《雾港旅店》、建好角色、开始。第一个人是房主；body 是建对局时多发的内容。 */
async function startedRoom(players: [Who, { name: string; roleKey: string }][], body: Record<string, unknown> = {}) {
  const host = players[0][0];
  const r = await t.call('POST', '/api/rooms', { name: '不计时测试', maxPlayers: 4, ...body }, c[host]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.room.id as number;
  for (const [who] of players.slice(1)) assert.equal((await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, c[who])).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, c[host])).status, 200);
  for (const [who, ch] of players) assert.equal((await t.call('PUT', `/api/rooms/${id}/character`, ch, c[who])).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, c[host])).status, 200);
  return id;
}

const game = async (id: number, who: Who) => (await t.call('GET', `/api/rooms/${id}/game`, undefined, c[who])).data;
const detail = async (id: number, who: Who) => (await t.call('GET', `/api/rooms/${id}`, undefined, c[who])).data;
const log = async (id: number, who: Who) => (await t.call('GET', `/api/rooms/${id}/log`, undefined, c[who])).data.entries as any[];
const act = (id: number, who: Who, content: string) => t.call('POST', `/api/rooms/${id}/actions`, { content }, c[who]);
const setUntimed = (id: number, who: Who, untimed: unknown) => t.call('PUT', `/api/rooms/${id}/untimed`, { untimed }, c[who]);
/** 服务器记下的这个人离开这一局页面的时间（服务器知道他下线了才有）。 */
const leftAt = (id: number, username: string) =>
  (t.app.db.prepare('SELECT p.left_at FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? AND u.username = ?').get(id, username) as { left_at: number | null })
    .left_at;

/** 等服务器那边的情况变过来（关掉推送以后，服务器过一会儿才知道这个人下线了），再等结算做完。 */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200 && !(await check()); i++) await sleep(10);
  await t.app.engine.idle();
}

/** 让现实时间过去 minutes 分钟，把到期的计时行动结算完。 */
async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

test('不计时：人不齐也是回合模式，在线的人交了马上结算（不等不在线的人、不等现实时间），时钟按行动的耗时往前跳；不在线的人交的行动照样结算', async () => {
  const id = await startedRoom(
    [
      ['t1', reporter],
      ['t2', detective],
    ],
    { untimed: true },
  );
  assert.equal((await detail(id, 't1')).room.untimed, true);
  assert.ok((await log(id, 't1')).some((e) => e.kind === 'system' && e.text.endsWith('创建了这一局，不计时')));

  // 只有林小满打开了页面
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const presence = await s1.waitFor((e) => e.event === 'presence' && e.data.online.length === 1);
  assert.deepEqual([presence.data.allOnline, presence.data.untimed, presence.data.mode], [false, true, 'round']);
  const start = await game(id, 't1');
  assert.equal(start.mode, 'round');
  assert.equal(start.clock.running, false, '时钟不跟着现实时间走');
  assert.deepEqual(start.round.waitingFor, [start.me.id], '只等在线的人');
  const clock0 = start.clock.minutes;

  const first = await act(id, 't1', '翻看大堂的住客登记簿 [分钟 20]');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.action.mode, 'round');
  await t.app.engine.idle();
  const after1 = await game(id, 't1');
  assert.equal(after1.myAction, null, '没等不在线的沈探，也没等现实时间，马上结算了');
  assert.equal(Math.round(after1.clock.minutes - clock0), 20, '时钟跳过这个行动的耗时');
  assert.equal(after1.round.number, 2);
  assert.ok((await log(id, 't1')).some((e) => e.data?.type === 'resolution' && e.data.action.startsWith('翻看大堂的住客登记簿')));

  // 沈探没打开这一局的页面也交了行动：等在线的林小满也交了，一起结算
  const late = await act(id, 't2', '在二楼客房翻刘贵的行李 [分钟 40]');
  assert.equal(late.status, 201, JSON.stringify(late.data));
  assert.equal(late.data.action.mode, 'round');
  await t.app.engine.idle();
  const waiting = await game(id, 't2');
  assert.equal(waiting.myAction.status, 'waiting');
  assert.deepEqual(waiting.round.waitingFor, [start.me.id]);
  assert.equal((await act(id, 't1', '和老板娘聊聊天气 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  const after2 = await game(id, 't2');
  assert.equal(after2.myAction, null);
  assert.equal(Math.round(after2.clock.minutes - clock0), 20 + 40, '时钟跳过这一轮最长的行动');
  assert.ok((await log(id, 't2')).some((e) => e.data?.type === 'resolution' && e.data.action.startsWith('在二楼客房翻刘贵的行李')));

  // 沈探又交了一个，林小满没交就离开了：没有人在线，交了的行动照样结算
  assert.equal((await act(id, 't2', '下楼看看 [分钟 15]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't2')).myAction.status, 'waiting', '林小满还在：等他');
  s1.close();
  await until(async () => leftAt(id, T1.username) === now);
  // 刚断线（刷新页面、网络抖一下）：宽限期里照样等他（V0.7.1 审查）
  assert.equal((await game(id, 't2')).myAction.status, 'waiting', '刚断线的人宽限期里照样等');
  // 宽限期过了他还没回来：不等了（服务器到时候自己再看一次，这里直接叫它看）
  now += UNTIMED_RECONNECT_GRACE_MS + 1000;
  t.app.engine.syncRoom(id);
  await until(async () => (await game(id, 't2')).myAction === null);
  const after3 = await game(id, 't2');
  assert.equal(after3.myAction, null, '林小满走了，不等他');
  assert.equal(after3.mode, 'round');
  assert.equal(Math.round(after3.clock.minutes - clock0), 20 + 40 + 15);
  // 现实时间过去了，游戏时间也不动
  now += 60 * MIN;
  assert.equal(Math.round((await game(id, 't2')).clock.minutes - clock0), 20 + 40 + 15);
});

test('不计时：交了行动又离开的人，行动跟着这一轮结算；没交就离开的不等', async () => {
  const id = await startedRoom(
    [
      ['t1', reporter],
      ['t2', detective],
    ],
    { untimed: true },
  );
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s2 = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await s1.waitFor((e) => e.event === 'presence' && e.data.allOnline);

  // 两个人都在：林小满交了，等沈探
  assert.equal((await act(id, 't1', '去后厨找阿福 [分钟 20]')).status, 201);
  await t.app.engine.idle();
  const g = await game(id, 't1');
  assert.equal(g.myAction.status, 'waiting');
  const detectiveId = g.others[0].id;
  assert.deepEqual(g.round.waitingFor, [detectiveId]);

  // 林小满离开了：他的行动留在这一轮里，接着等还在线、还没交的沈探
  let mark = s2.events.length;
  s1.close();
  await s2.waitFor((e) => e.event === 'presence' && e.data.online.length === 1, mark);
  await t.app.engine.idle();
  const alone = await game(id, 't2');
  assert.equal(alone.mode, 'round');
  assert.deepEqual(alone.round.waitingFor, [detectiveId]);
  assert.deepEqual(alone.round.submitted, [g.me.id]);
  assert.equal((await game(id, 't1')).myAction.status, 'waiting');
  assert.equal((await act(id, 't2', '搜查刘贵的房间 [分钟 40]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't1')).myAction, null, '离开了的人交的行动也结算了');
  assert.equal((await game(id, 't2')).myAction, null);

  // 林小满回来了；沈探交了，在等林小满；林小满没交就又离开了：不等他
  mark = s2.events.length;
  const back = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  await s2.waitFor((e) => e.event === 'presence' && e.data.allOnline, mark);
  assert.equal((await act(id, 't2', '下楼看看 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't2')).myAction.status, 'waiting');
  back.close();
  await until(async () => leftAt(id, T1.username) === now);
  assert.equal((await game(id, 't2')).myAction.status, 'waiting', '刚断线：宽限期里还等他');
  now += UNTIMED_RECONNECT_GRACE_MS + 1000;
  t.app.engine.syncRoom(id);
  await until(async () => (await game(id, 't2')).myAction === null);
  assert.equal((await game(id, 't2')).myAction, null);
  s2.close();
});

test('不计时：刷新页面不算走（宽限期里连回来，这一轮照样等他）；服务器刚启动时，等关服务器那会儿还开着页面的人连回来', async () => {
  const id = await startedRoom(
    [
      ['t1', reporter],
      ['t2', detective],
    ],
    { untimed: true },
  );
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s2 = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await s1.waitFor((e) => e.event === 'presence' && e.data.allOnline);
  assert.equal((await act(id, 't1', '去后厨找阿福 [分钟 20]')).status, 201);
  await t.app.engine.idle();
  // 沈探刷新页面：断开又连上；宽限期里林小满的行动不会自己结算
  s2.close();
  await until(async () => leftAt(id, T2.username) === now);
  now += 10_000;
  t.app.engine.syncRoom(id);
  await t.app.engine.idle();
  assert.equal((await game(id, 't1')).myAction.status, 'waiting', '刷新页面的人还在宽限期里');
  const s2b = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await s1.waitFor((e) => e.event === 'presence' && e.data.allOnline);
  assert.equal((await game(id, 't1')).myAction.status, 'waiting', '连回来了：照样等他交');
  assert.equal((await act(id, 't2', '搜查刘贵的房间 [分钟 40]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't1')).myAction, null, '两个人都交了，一起结算');
  s1.close();
  s2b.close();
  await until(async () => leftAt(id, T1.username) === now && leftAt(id, T2.username) === now);

  // 服务器刚启动：关服务器那会儿沈探还开着页面（最后在线比最后离开晚），林小满交了行动
  now += UNTIMED_RECONNECT_GRACE_MS + 1000;
  assert.equal((await act(id, 't1', '和老板娘聊聊天气 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't1')).myAction, null, '两个人都走了很久：交了的照样结算');
  t.app.db.prepare('UPDATE players SET last_seen_at = ? WHERE room_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)').run(now - 1000, id, T2.username);
  const engine = t.app.engine as unknown as { startedAt: number };
  engine.startedAt = now;
  assert.equal((await act(id, 't1', '回大堂坐着 [分钟 10]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't1')).myAction.status, 'waiting', '刚启动：等沈探连回来');
  now += UNTIMED_STARTUP_GRACE_MS + 1000;
  t.app.engine.syncRoom(id);
  await until(async () => (await game(id, 't1')).myAction === null);
  assert.equal((await game(id, 't1')).myAction, null, '过了启动的宽限期还没回来：不等了');
});

test('取消不计时：人不齐时又是计时模式，等着的回合行动转成计时行动，时钟跟着现实时间走；房主和管理员能改，记录里写一句', async () => {
  const id = await startedRoom(
    [
      ['t1', reporter],
      ['t2', detective],
    ],
    { untimed: true },
  );
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  await s1.waitFor((e) => e.event === 'presence' && e.data.online.length === 1);
  // 不在线的沈探交了行动：在等林小满
  assert.equal((await act(id, 't2', '在二楼找东西 [分钟 30]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't2')).myAction.mode, 'round');

  // 普通成员不能改；格式不对的不收
  const denied = await setUntimed(id, 't2', false);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, '只有房主能改计时');
  assert.equal((await setUntimed(id, 't1', 'no')).status, 400);
  assert.equal((await detail(id, 't1')).room.untimed, true);

  const mark = s1.events.length;
  const off = await setUntimed(id, 't1', false);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.room.untimed, false);
  assert.equal(off.data.presence.mode, 'timed');
  const pushed = await s1.waitFor((e) => e.event === 'presence' && e.data.mode === 'timed', mark);
  assert.equal(pushed.data.untimed, false);
  await s1.waitFor((e) => e.event === 'room' && e.data.untimed === false, mark);
  assert.ok((await log(id, 't2')).some((e) => e.kind === 'system' && e.text === '房主取消了不计时：人不齐时按现实时间计时'));
  // 没改的时候不重复记
  assert.equal((await setUntimed(id, 't1', false)).status, 200);
  assert.equal((await log(id, 't2')).filter((e) => e.kind === 'system' && e.text.startsWith('房主取消了不计时')).length, 1);

  const timed = await game(id, 't2');
  assert.equal(timed.mode, 'timed');
  assert.equal(timed.round, null);
  assert.equal(timed.clock.running, true, '时钟又跟着现实时间走了');
  assert.equal(timed.myAction.mode, 'timed', '等着的回合行动转成了计时行动');
  assert.equal(timed.myAction.dueAt - timed.myAction.submittedAt, 30 * MIN, '从交的时候算起');

  // 在线的林小满交的行动也要等现实时间
  const mine = await act(id, 't1', '在大堂里四处看看 [分钟 15]');
  assert.equal(mine.data.action.mode, 'timed');
  await pass(14);
  assert.equal((await game(id, 't1')).myAction.status, 'waiting');
  assert.equal((await game(id, 't2')).myAction.status, 'waiting');
  await pass(17);
  assert.equal((await game(id, 't1')).myAction, null);
  assert.equal((await game(id, 't2')).myAction, null);

  // 管理员（测试管理员是站长）也能改，记录里写站长、后台记一笔；打开以后又是回合模式，时钟停下
  const on = await setUntimed(id, 'admin', true);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.ok((await log(id, 't1')).some((e) => e.kind === 'system' && e.text === '站长把这一局设成了不计时：人不齐也照样结算'));
  const audit = t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string };
  assert.equal(audit.action, '把对局设成不计时');
  const round = await game(id, 't1');
  assert.equal(round.mode, 'round');
  assert.equal(round.clock.running, false);
  s1.close();

  // 结束了的对局不能再改
  assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'ended' }, c.t1)).status, 200);
  assert.equal((await setUntimed(id, 't1', false)).status, 409);
});

test('不计时的公开对局：大厅里标着；「再刷一次」照样不计时', async () => {
  const id = await startedRoom([['t3', doctor]], { untimed: true, isPublic: true });
  const hall = (await t.call('GET', '/api/hall', undefined, c.t1)).data.rooms as any[];
  assert.equal(hall.find((r) => r.id === id)?.untimed, true);
  assert.equal(hall.some((r) => 'alwaysTimed' in r), false);

  assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'ended' }, c.t3)).status, 200);
  const again = await t.call('POST', `/api/rooms/${id}/replay`, undefined, c.t3);
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(again.data.room.untimed, true);
  assert.equal(again.data.room.isPublic, true);
});

test('旧版网页建对局时发来的「始终计时」不管用：和默认的对局一样，人齐了是回合模式，人不齐是计时模式', async () => {
  const id = await startedRoom([['t3', doctor]], { alwaysTimed: true });
  assert.deepEqual({ ...(t.app.db.prepare('SELECT always_timed, untimed FROM rooms WHERE id = ?').get(id) as object) }, { always_timed: 0, untimed: 0 });
  const before = await detail(id, 't3');
  assert.equal(before.room.untimed, false);
  assert.equal('alwaysTimed' in before.room, false);
  assert.equal(before.presence.mode, 'timed', '没人打开页面：计时模式');

  const s = await t.openStream(`/api/rooms/${id}/events`, c.t3);
  const presence = await s.waitFor((e) => e.event === 'presence' && e.data.allOnline);
  assert.equal(presence.data.mode, 'round', '人齐了就是回合模式');
  assert.equal((await act(id, 't3', '在大堂里坐一会儿 [分钟 20]')).status, 201);
  await t.app.engine.idle();
  assert.equal((await game(id, 't3')).myAction, null, '马上结算了');
  s.close();
  await until(async () => (await detail(id, 't3')).presence.mode === 'timed');
  assert.equal((await detail(id, 't3')).presence.mode, 'timed');
});

test('第 18 版的数据库：升级时以前设了「始终计时」的对局都取消了，多了「不计时」（默认不开）', () => {
  assert.match(MIGRATIONS[17], /UPDATE rooms SET always_timed = 0/);
  assert.match(MIGRATIONS[17], /ALTER TABLE rooms ADD COLUMN untimed INTEGER NOT NULL DEFAULT 0/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-untimed-'));
  try {
    // 停在第 17 版（V0.7.0）的旧数据库：一局开了「始终计时」，一局没开
    const file = path.join(dir, 'game.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (17);');
    for (const sql of MIGRATIONS.slice(0, 17)) old.exec(sql);
    const host = old.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('old', '老玩家', 'x', 0)").run().lastInsertRowid;
    const addRoom = old.prepare("INSERT INTO rooms (name, host_user_id, join_code, max_players, model, always_timed, created_at) VALUES (?, ?, ?, 4, 'claude', ?, 0)");
    const timedId = Number(addRoom.run('始终计时的局', host, 'OLD001', 1).lastInsertRowid);
    const plainId = Number(addRoom.run('普通的局', host, 'OLD002', 0).lastInsertRowid);
    assert.throws(() => old.prepare('SELECT untimed FROM rooms').all(), /no such column/);
    old.close();

    const db = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
    try {
      const rows = (db.prepare('SELECT id, always_timed, untimed FROM rooms ORDER BY id').all() as object[]).map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { id: timedId, always_timed: 0, untimed: 0 },
        { id: plainId, always_timed: 0, untimed: 0 },
      ]);
      const column = db.prepare(`SELECT "notnull" AS required, dflt_value FROM pragma_table_info('rooms') WHERE name = 'untimed'`).get() as object;
      assert.deepEqual({ ...column }, { required: 1, dflt_value: '0' });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
