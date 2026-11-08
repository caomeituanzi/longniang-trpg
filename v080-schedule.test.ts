// V0.8.0 约团：房主列候选时间、成员勾能不能来、房主定下、开始前 30 分钟提醒（只提醒一次，重启也不重复）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { scheduleTimeText } from '../shared/schedule';
import { sleep, startTestApp, type Event } from './helpers';

const [ADMIN, T1, T2, T3] = TEST_ACCOUNTS;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 从一个整分钟开始，测试里的时间都按它算
let now = Math.floor(Date.now() / MIN) * MIN;
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';
let guest = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  // 推送的合并时间改短一点，测试不用等那么久（专门测合并的测试自己再改）
  t.app.schedule.throttleMs = 50;
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(T1.username, T1.password);
  t2 = await t.login(T2.username, T2.password);
  t3 = await t.login(T3.username, T3.password);
  guest = (await t.call('POST', '/api/auth/guest')).cookie!;
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);

/** 建一局：host 是房主，members 用对局码加入。 */
async function makeRoom(host: string, members: string[], name = '约团测试') {
  const r = await as(host)('POST', '/api/rooms', { name, maxPlayers: 6 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  for (const m of members) {
    const j = await as(m)('POST', '/api/rooms/join', { code: r.data.room.joinCode });
    assert.equal(j.status, 200, JSON.stringify(j.data));
  }
  return r.data.room.id as number;
}

const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;

/** 某人收到的某一种通知（新的在前）。 */
async function notices(cookie: string, kind: string, roomId?: number) {
  const r = await as(cookie)('GET', '/api/notifications');
  assert.equal(r.status, 200);
  return (r.data.items as { kind: string; data: Record<string, any>; read: boolean }[]).filter((n) => n.kind === kind && (roomId === undefined || n.data.roomId === roomId));
}

test('只有房主能列、定、取消；不是成员的看不到、勾不了；游客不行', async () => {
  const roomId = await makeRoom(admin, [t1, t2]);
  const slots = [now + DAY, now + 2 * DAY];

  // 成员（不是房主）列不了
  let r = await as(t1)('POST', `/api/rooms/${roomId}/schedule`, { slots });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '只有房主能约时间');

  // 还没约：是 null
  r = await as(t1)('GET', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 200);
  assert.equal(r.data.schedule, null);
  assert.equal(r.data.now, now);

  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots, note: '  周末\n打完第二幕  ' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.schedule;
  assert.equal(s.status, 'open');
  assert.equal(s.note, '周末 打完第二幕', '换行和多余的空格合成一个');
  assert.deepEqual(
    s.slots.map((x: { startsAt: number }) => x.startsAt),
    slots,
  );
  assert.equal(s.canManage, true);
  assert.equal(s.createdBy.displayName, ADMIN.displayName);
  assert.equal(s.members, 3);
  assert.equal(s.answered, 0);

  // 成员看得到，但不能定、不能取消
  r = await as(t1)('GET', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.data.schedule.id, s.id);
  assert.equal(r.data.schedule.canManage, false);
  r = await as(t1)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '只有房主能定时间');
  r = await as(t1)('DELETE', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '只有房主能取消约团');

  // 不是成员：和对局的其他接口一样，不说这一局在不在
  for (const [method, url, body] of [
    ['GET', `/api/rooms/${roomId}/schedule`, undefined],
    ['PUT', `/api/rooms/${roomId}/schedule/votes`, { votes: { [s.slots[0].id]: 'yes' } }],
    ['POST', `/api/rooms/${roomId}/schedule`, { slots }],
    ['POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id }],
    ['DELETE', `/api/rooms/${roomId}/schedule`, undefined],
  ] as const) {
    r = await as(t3)(method, url, body);
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.equal(r.data.error, '对局不存在，或者你不在这一局里');
  }
  r = await as(t3)('GET', '/api/rooms/999999/schedule');
  assert.equal(r.status, 404);
  // 游客
  r = await as(guest)('GET', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 403);
  r = await as(guest)('GET', '/api/schedule/mine');
  assert.equal(r.status, 403);
  // 没登录
  r = await t.call('GET', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 401);
  // 不是成员的人勾的没有记下
  const votes = t.app.db.prepare('SELECT COUNT(*) AS n FROM schedule_votes v JOIN schedule_slots s ON s.id = v.slot_id WHERE s.poll_id = ?').get(s.id) as { n: number };
  assert.equal(votes.n, 0);

  // 房主能取消（还在勾的：不通知）
  r = await as(admin)('DELETE', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 200);
  assert.equal(r.data.schedule, null);
  r = await as(admin)('DELETE', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 200, '再取消一次也行（点了两次）');
});

test('时间校验：过去的、不到 10 分钟的、超过 60 天的、超过 6 个、重复的、格式不对的都不行', async () => {
  const roomId = await makeRoom(admin, [t1]);
  const post = (body: unknown) => as(admin)('POST', `/api/rooms/${roomId}/schedule`, body);
  const cases: [unknown, string][] = [
    [{ slots: [now - HOUR] }, '每个时间都要比现在晚至少 10 分钟'],
    [{ slots: [now + 9 * MIN] }, '每个时间都要比现在晚至少 10 分钟'],
    [{ slots: [now + DAY, now + 61 * DAY] }, '时间要在 60 天以内'],
    [{ slots: [1, 2, 3, 4, 5, 6, 7].map((i) => now + i * DAY) }, '候选时间要列 1～6 个'],
    [{ slots: [] }, '候选时间要列 1～6 个'],
    [{}, '候选时间要列 1～6 个'],
    [{ slots: 'tomorrow' }, '候选时间要列 1～6 个'],
    // 同一分钟（秒数不算）
    [{ slots: [now + DAY, now + DAY + 30_000] }, '有两个时间是同一分钟，删掉一个再发'],
    [{ slots: ['2026-10-30T20:00'] }, '时间的格式不对，刷新一下再试'],
    [{ slots: [now + DAY + 0.5] }, '时间的格式不对，刷新一下再试'],
    [{ slots: [null] }, '时间的格式不对，刷新一下再试'],
    [{ slots: [now + DAY], note: 'x'.repeat(101) }, '附言最多 100 个字'],
    [{ slots: [now + DAY], note: 42 }, '附言的格式不对'],
  ];
  for (const [body, error] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, error, JSON.stringify(body));
  }
  // 什么都没建
  assert.equal((await as(admin)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule, null);

  // 正好 10 分钟以后、正好 60 天以内、6 个、附言正好 100 个字（中文按字数）：都行；秒数去掉，按时间先后排好
  const ok = [now + 60 * DAY, now + 10 * MIN, now + DAY + 45_000, now + 2 * DAY, now + 3 * DAY, now + 4 * DAY];
  const r = await post({ slots: ok, note: '龙'.repeat(100) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(
    r.data.schedule.slots.map((x: { startsAt: number }) => x.startsAt),
    [now + 10 * MIN, now + DAY, now + 2 * DAY, now + 3 * DAY, now + 4 * DAY, now + 60 * DAY],
  );
  assert.equal(r.data.schedule.note.length, 100);
});

test('勾选：三选一、能改、能不勾；统计对；只算现在的成员；定下以后不能再改', async () => {
  const roomId = await makeRoom(admin, [t1, t2]);
  const s = (await as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots: [now + DAY, now + 2 * DAY] })).data.schedule;
  const [a, b] = s.slots.map((x: { id: number }) => x.id);
  const put = (cookie: string, votes: unknown) => as(cookie)('PUT', `/api/rooms/${roomId}/schedule/votes`, { votes });

  let r = await put(t1, { [a]: 'yes', [b]: 'maybe' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await put(t2, { [a]: 'no' });
  assert.equal(r.status, 200);
  let view = r.data.schedule;
  assert.deepEqual(view.slots[0].counts, { yes: 1, maybe: 0, no: 1 });
  assert.deepEqual(view.slots[1].counts, { yes: 0, maybe: 1, no: 0 });
  assert.equal(view.slots[0].mine, 'no', '我（tester2）勾的');
  assert.equal(view.slots[1].mine, null);
  assert.deepEqual(
    view.slots[0].votes.map((v: { user: { displayName: string }; answer: string }) => [v.user.displayName, v.answer]),
    [
      [T1.displayName, 'yes'],
      [T2.displayName, 'no'],
    ],
  );
  assert.equal(view.answered, 2);
  assert.deepEqual(
    view.waiting.map((u: { displayName: string }) => u.displayName),
    [ADMIN.displayName],
    '房主还没勾',
  );

  // 改：能来 → 来不了；也许 → 不勾了
  r = await put(t1, { [a]: 'no', [b]: null });
  view = r.data.schedule;
  assert.deepEqual(view.slots[0].counts, { yes: 0, maybe: 0, no: 2 });
  assert.deepEqual(view.slots[1].counts, { yes: 0, maybe: 0, no: 0 });
  assert.equal(view.slots[0].mine, 'no');
  assert.equal(view.slots[1].mine, null);
  // 房主也能勾
  r = await put(admin, { [b]: 'yes' });
  assert.deepEqual(r.data.schedule.slots[1].counts, { yes: 1, maybe: 0, no: 0 });
  assert.equal(r.data.schedule.answered, 3);
  assert.deepEqual(r.data.schedule.waiting, []);

  // 不对的：不认识的答案、不是这一次的时间、空的、格式不对
  r = await put(t1, { [a]: 'sure' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '只能勾能来、也许或者来不了');
  r = await put(t1, { 999999: 'yes' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这个时间已经不在了（可能房主重新列了时间），刷新一下再试');
  r = await put(t1, { abc: 'yes' });
  assert.equal(r.status, 409);
  r = await put(t1, {});
  assert.equal(r.status, 400);
  r = await put(t1, [a]);
  assert.equal(r.status, 400);
  r = await as(t1)('PUT', `/api/rooms/${roomId}/schedule/votes`, { votes: 'yes' });
  assert.equal(r.status, 400);

  // 成员离开了对局（直接改数据库模拟）：他勾的不算了
  t.app.db.prepare('DELETE FROM players WHERE room_id = ? AND user_id = ?').run(roomId, userId(T2.username));
  view = (await as(t1)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule;
  assert.deepEqual(view.slots[0].counts, { yes: 0, maybe: 0, no: 1 });
  assert.equal(view.members, 2);
  assert.equal(view.answered, 2);
  r = await as(t2)('GET', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 404, '离开了就看不到了');

  // 定下以后不能再改
  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: b });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await put(t1, { [a]: 'yes' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '时间已经定下了，不能再改');
});

test('列新的 → 除房主外的成员收到 schedule_poll；定下 → schedule_confirmed（房主没有）；推送 schedule 给开着页面的人', async () => {
  const roomId = await makeRoom(admin, [t1, t2], '通知测试局');
  const stream = await t.openStream(`/api/rooms/${roomId}/events`, t1);
  const lobby = await t.openStream('/api/events', t2);
  const from = stream.events.length;
  const slots = [now + 3 * DAY, now + 4 * DAY, now + 5 * DAY];
  let r = await as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots });
  assert.equal(r.status, 201);
  await stream.waitFor((e) => e.event === 'schedule' && e.data.roomId === roomId, from);
  await lobby.waitFor((e) => e.event === 'schedule' && e.data.roomId === roomId);

  const me = (await as(admin)('GET', '/api/auth/me')).data.user;
  for (const cookie of [t1, t2]) {
    const [n, ...rest] = await notices(cookie, 'schedule_poll', roomId);
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(n.data).sort(), ['count', 'from', 'roomId', 'roomName']);
    assert.equal(n.data.roomName, '通知测试局');
    assert.equal(n.data.count, 3);
    assert.equal(n.data.from.publicId, me.publicId);
    assert.equal(n.data.from.displayName, ADMIN.displayName);
  }
  assert.equal((await notices(admin, 'schedule_poll', roomId)).length, 0, '房主自己不收');

  // 勾了：这条「列了时间」算看过了
  const s = r.data.schedule;
  r = await as(t1)('PUT', `/api/rooms/${roomId}/schedule/votes`, { votes: { [s.slots[1].id]: 'yes' } });
  assert.equal(r.status, 200);
  assert.equal((await notices(t1, 'schedule_poll', roomId))[0].read, true);
  assert.equal((await notices(t2, 'schedule_poll', roomId))[0].read, false);

  // 定下（不一定要大家都勾过）
  const mark = stream.events.length;
  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[2].id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.schedule.status, 'confirmed');
  assert.equal(r.data.schedule.confirmedSlotId, s.slots[2].id);
  assert.equal(r.data.schedule.startsAt, slots[2]);
  assert.equal(r.data.schedule.past, false);
  await stream.waitFor((e) => e.event === 'schedule' && e.data.roomId === roomId, mark);
  for (const cookie of [t1, t2]) {
    const list = await notices(cookie, 'schedule_confirmed', roomId);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].data, { roomId, roomName: '通知测试局', startsAt: slots[2] });
  }
  assert.equal((await notices(admin, 'schedule_confirmed', roomId)).length, 0, '房主自己不收');
  // 定过了，「列了时间」也不用看了
  assert.equal((await notices(t2, 'schedule_poll', roomId))[0].read, true);

  // 再点一次同一个：照样返回、不再通知；换别的：要先取消
  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[2].id });
  assert.equal(r.status, 200);
  assert.equal((await notices(t1, 'schedule_confirmed', roomId)).length, 1);
  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '已经定下了别的时间；要换，先取消再重新约');
  r = await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: 'x' });
  assert.equal(r.status, 400);
  stream.close();
  lobby.close();
});

test('取消定下的 → schedule_cancelled；只取消还在勾的不通知；重新列时间：旧的作废，一局只有一个', async () => {
  const roomId = await makeRoom(admin, [t1], '取消测试局');
  const post = (slots: number[]) => as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots });

  // 还在勾的：取消不通知
  await post([now + DAY]);
  let r = await as(admin)('DELETE', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 200);
  assert.equal((await notices(t1, 'schedule_cancelled', roomId)).length, 0);
  assert.equal((await notices(t1, 'schedule_poll', roomId))[0].read, true, '取消了，没看的「列了时间」标成看过');

  // 定下的：取消要通知
  let s = (await post([now + DAY, now + 2 * DAY])).data.schedule;
  await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id });
  r = await as(admin)('DELETE', `/api/rooms/${roomId}/schedule`);
  assert.equal(r.status, 200);
  let cancelled = await notices(t1, 'schedule_cancelled', roomId);
  assert.equal(cancelled.length, 1);
  assert.deepEqual(cancelled[0].data, { roomId, roomName: '取消测试局' });
  assert.equal((await notices(admin, 'schedule_cancelled', roomId)).length, 0);
  assert.equal((await as(t1)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule, null);

  // 定下了再重新列：旧的作废（通知取消了），新的通知「列了时间」
  s = (await post([now + DAY])).data.schedule;
  await as(admin)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id });
  r = await post([now + 3 * DAY, now + 4 * DAY]);
  assert.equal(r.status, 201);
  assert.equal(r.data.schedule.status, 'open');
  assert.notEqual(r.data.schedule.id, s.id);
  cancelled = await notices(t1, 'schedule_cancelled', roomId);
  assert.equal(cancelled.length, 2);
  const polls = await notices(t1, 'schedule_poll', roomId);
  assert.equal(polls[0].data.count, 2);
  assert.equal(polls.filter((n) => !n.read).length, 1, '以前的「列了时间」标成看过，只留最新的一条没读');
  const rows = t.app.db.prepare('SELECT status FROM schedule_polls WHERE room_id = ? ORDER BY id').all(roomId) as { status: string }[];
  assert.deepEqual(
    rows.map((x) => x.status),
    ['cancelled', 'cancelled', 'cancelled', 'open'],
  );
  // 还在勾的被换掉：不发「取消了」
  await post([now + 5 * DAY]);
  assert.equal((await notices(t1, 'schedule_cancelled', roomId)).length, 2);
  const active = t.app.db.prepare("SELECT COUNT(*) AS n FROM schedule_polls WHERE room_id = ? AND status IN ('open', 'confirmed')").get(roomId) as { n: number };
  assert.equal(active.n, 1);

  // 对局删了：约团跟着删
  r = await as(admin)('DELETE', `/api/rooms/${roomId}`);
  assert.equal(r.status, 200);
  const left = t.app.db.prepare('SELECT COUNT(*) AS n FROM schedule_polls WHERE room_id = ?').get(roomId) as { n: number };
  assert.equal(left.n, 0);
});

test('提醒：开始前 30 分钟发给所有成员（包括房主），只发一次；定的时间已经过了的不能定；过了 6 小时算过去了', async () => {
  const start = now;
  try {
    const roomId = await makeRoom(t1, [admin, t2], '提醒测试局');
    const at = now + 2 * HOUR;
    const s = (await as(t1)('POST', `/api/rooms/${roomId}/schedule`, { slots: [now + HOUR, at] })).data.schedule;
    let r = await as(t1)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[1].id });
    assert.equal(r.status, 200);

    assert.equal(t.app.schedule.sweepReminders(), 0);
    now = at - 31 * MIN;
    assert.equal(t.app.schedule.sweepReminders(), 0, '还没到 30 分钟');
    now = at - 30 * MIN;
    assert.equal(t.app.schedule.sweepReminders(), 1);
    for (const cookie of [admin, t1, t2]) {
      const list = await notices(cookie, 'schedule_reminder', roomId);
      assert.equal(list.length, 1, '房主也收');
      assert.deepEqual(list[0].data, { roomId, roomName: '提醒测试局', startsAt: at });
    }
    // 再查一次、过一会儿再查：不重复
    assert.equal(t.app.schedule.sweepReminders(), 0);
    now = at - 5 * MIN;
    assert.equal(t.app.schedule.sweepReminders(), 0);
    assert.equal((await notices(t2, 'schedule_reminder', roomId)).length, 1);

    // 「我的对局」和对局页：开始以后 6 小时之内还算「下次」，过了就不算了，房主可以再约
    now = at + 6 * HOUR - MIN;
    let mine = (await as(t2)('GET', '/api/schedule/mine')).data.rooms.find((x: { roomId: number }) => x.roomId === roomId);
    assert.equal(mine.startsAt, at);
    assert.equal((await as(t2)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule.past, false);
    now = at + 6 * HOUR;
    mine = (await as(t2)('GET', '/api/schedule/mine')).data.rooms.find((x: { roomId: number }) => x.roomId === roomId);
    assert.equal(mine.startsAt, null);
    assert.equal((await as(t2)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule.past, true);
    r = await as(t1)('POST', `/api/rooms/${roomId}/schedule`, { slots: [now + DAY] });
    assert.equal(r.status, 201);
    assert.equal((await notices(t2, 'schedule_cancelled', roomId)).length, 0, '已经开始过的不算取消');

    // 候选时间到了还没定：不能再定这个时间
    const s2 = r.data.schedule;
    now += DAY;
    r = await as(t1)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s2.slots[0].id });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, '这个时间已经过了，选别的时间，或者重新约');

    // 定得晚、离开始已经不到 30 分钟：马上提醒
    const soon = now + 15 * MIN;
    const s3 = (await as(t1)('POST', `/api/rooms/${roomId}/schedule`, { slots: [soon] })).data.schedule;
    r = await as(t1)('POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s3.slots[0].id });
    assert.equal(r.status, 200);
    const reminders = await notices(admin, 'schedule_reminder', roomId);
    assert.equal(reminders.length, 2);
    assert.equal(reminders[0].data.startsAt, soon);
    assert.equal(t.app.schedule.sweepReminders(), 0);
  } finally {
    now = start;
  }
});

test('提醒只发一次：模拟重启（新的服务器打开同一个数据库）不重复；关着时到了提醒的点、开起来还没开始的补发；已经开始了的不补', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-schedule-'));
  const dbPath = path.join(dir, 'test.db');
  let clock = now;
  const boot = () => startTestApp({ ai: new FakeProvider(demoHandler), now: () => clock, tickMs: 0, dbPath });
  try {
    let app = await boot();
    const hostCookie = await app.login(ADMIN.username, ADMIN.password);
    const memberCookie = await app.login(T1.username, T1.password);
    const create = async (name: string, startsAt: number) => {
      const room = (await app.call('POST', '/api/rooms', { name, maxPlayers: 4 }, hostCookie)).data.room;
      assert.equal((await app.call('POST', '/api/rooms/join', { code: room.joinCode }, memberCookie)).status, 200);
      const s = (await app.call('POST', `/api/rooms/${room.id}/schedule`, { slots: [startsAt] }, hostCookie)).data.schedule;
      assert.equal((await app.call('POST', `/api/rooms/${room.id}/schedule/confirm`, { slotId: s.slots[0].id }, hostCookie)).status, 200);
      return room.id as number;
    };
    const A = await create('重启局甲', clock + 2 * HOUR);
    const B = await create('重启局乙', clock + 3 * HOUR);
    const C = await create('重启局丙', clock + 4 * HOUR);
    const count = (roomId: number) =>
      (app.app.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'schedule_reminder' AND json_extract(data, '$.roomId') = ?").get(roomId) as { n: number }).n;

    // 甲：开着的时候到点提醒
    clock += 2 * HOUR - 20 * MIN;
    assert.equal(app.app.schedule.sweepReminders(), 1);
    assert.equal(count(A), 2, '房主和成员各一条');
    await app.close();

    // 重启：甲不再提醒；乙还没到点
    app = await boot();
    assert.equal(count(A), 2, '重启以后不重复');
    assert.equal(app.app.schedule.sweepReminders(), 0);
    await app.close();

    // 关着的时候乙到了提醒的点（开始前 30 分钟），开起来时还没开始：一开起来就补发
    clock += HOUR + 10 * MIN; // 乙开始前 10 分钟
    app = await boot();
    assert.equal(count(B), 2, '开起来就补发了');
    assert.equal(app.app.schedule.sweepReminders(), 0);
    await app.close();

    // 丙：关着的时候已经过了开始时间才开起来：不补
    clock += 2 * HOUR; // 丙开始以后 10 分钟
    app = await boot();
    assert.equal(count(C), 0);
    assert.equal(app.app.schedule.sweepReminders(), 0);
    assert.equal(count(B), 2);
    await app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('已结束的对局：不能列、不能勾、不能定、不能取消；不提醒；「我的对局」里没有它', async () => {
  const roomId = await makeRoom(admin, [t1], '结束测试局');
  const at = now + 20 * MIN;
  const s = (await as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots: [at, now + DAY] })).data.schedule;
  let r = await as(admin)('POST', `/api/rooms/${roomId}/status`, { status: 'ended' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const ended = '这一局已经结束了，不能再约时间';
  for (const [cookie, method, url, body] of [
    [admin, 'POST', `/api/rooms/${roomId}/schedule`, { slots: [now + DAY] }],
    [t1, 'PUT', `/api/rooms/${roomId}/schedule/votes`, { votes: { [s.slots[0].id]: 'yes' } }],
    [admin, 'POST', `/api/rooms/${roomId}/schedule/confirm`, { slotId: s.slots[0].id }],
    [admin, 'DELETE', `/api/rooms/${roomId}/schedule`, undefined],
  ] as const) {
    r = await as(cookie)(method, url, body);
    assert.equal(r.status, 409, `${method} ${url}`);
    assert.equal(r.data.error, ended);
  }
  // 看还能看
  assert.equal((await as(t1)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule.id, s.id);
  const mine = (await as(t1)('GET', '/api/schedule/mine')).data.rooms as { roomId: number }[];
  assert.ok(!mine.some((x) => x.roomId === roomId));

  // 结束以前定下的，结束以后不提醒
  const other = await makeRoom(admin, [t1], '结束前定下的局');
  const later = now + 2 * HOUR;
  const s2 = (await as(admin)('POST', `/api/rooms/${other}/schedule`, { slots: [later] })).data.schedule;
  assert.equal((await as(admin)('POST', `/api/rooms/${other}/schedule/confirm`, { slotId: s2.slots[0].id })).status, 200);
  await as(admin)('POST', `/api/rooms/${other}/status`, { status: 'ended' });
  const start = now;
  now = later - 10 * MIN;
  try {
    assert.equal(t.app.schedule.sweepReminders(), 0);
  } finally {
    now = start;
  }
  assert.equal((await notices(t1, 'schedule_reminder', other)).length, 0);
});

test('GET /api/schedule/mine：每一局的下次时间、要不要我勾', async () => {
  const fresh = await makeRoom(t1, [t2, admin], '我的对局测试');
  const quiet = await makeRoom(t2, [], '没约的局');
  const get = async (cookie: string) => {
    const r = await as(cookie)('GET', '/api/schedule/mine');
    assert.equal(r.status, 200);
    return new Map((r.data.rooms as { roomId: number; startsAt: number | null; needsVote: boolean }[]).map((x) => [x.roomId, x]));
  };
  let m = await get(t2);
  assert.deepEqual(m.get(fresh), { roomId: fresh, startsAt: null, needsVote: false });
  assert.deepEqual(m.get(quiet), { roomId: quiet, startsAt: null, needsVote: false });
  assert.ok(!(await get(t3)).has(fresh), '不在的局没有');

  const s = (await as(t1)('POST', `/api/rooms/${fresh}/schedule`, { slots: [now + DAY, now + 2 * DAY] })).data.schedule;
  m = await get(t2);
  assert.equal(m.get(fresh)!.needsVote, true);
  assert.equal(m.get(fresh)!.startsAt, null);
  assert.equal((await get(t1)).get(fresh)!.needsVote, true, '房主自己也没勾');

  // 勾了一个就不算要勾了；全取消掉又算
  await as(t2)('PUT', `/api/rooms/${fresh}/schedule/votes`, { votes: { [s.slots[0].id]: 'maybe' } });
  assert.equal((await get(t2)).get(fresh)!.needsVote, false);
  await as(t2)('PUT', `/api/rooms/${fresh}/schedule/votes`, { votes: { [s.slots[0].id]: null } });
  assert.equal((await get(t2)).get(fresh)!.needsVote, true);
  // 「来不了」也算勾过了
  await as(t2)('PUT', `/api/rooms/${fresh}/schedule/votes`, { votes: { [s.slots[0].id]: 'no', [s.slots[1].id]: 'no' } });
  assert.equal((await get(t2)).get(fresh)!.needsVote, false);

  // 定下了：下次的时间；没勾的人也不用勾了
  await as(t1)('POST', `/api/rooms/${fresh}/schedule/confirm`, { slotId: s.slots[1].id });
  for (const cookie of [t1, t2, admin]) assert.deepEqual((await get(cookie)).get(fresh), { roomId: fresh, startsAt: now + 2 * DAY, needsVote: false });
  // 取消了：都没有了
  await as(t1)('DELETE', `/api/rooms/${fresh}/schedule`);
  assert.deepEqual((await get(admin)).get(fresh), { roomId: fresh, startsAt: null, needsVote: false });
});

const scheduleEvents = (events: Event[], roomId: number) => events.filter((e) => e.event === 'schedule' && e.data.roomId === roomId).length;

test('勾的没变：不写、不推；推送只给成员（观看的人收不到）；一下子变好几次合成一次，最后的变化一定推出去', async () => {
  const roomId = await makeRoom(admin, [t1, t2], '推送测试局');
  assert.equal((await as(admin)('PUT', `/api/rooms/${roomId}/public`, { isPublic: true })).status, 200);
  const s = (await as(admin)('POST', `/api/rooms/${roomId}/schedule`, { slots: [now + DAY, now + 2 * DAY] })).data.schedule;
  const [a, b] = s.slots.map((x: { id: number }) => x.id);
  const url = `/api/rooms/${roomId}/schedule/votes`;
  const start = now;
  t.app.schedule.throttleMs = 200;
  try {
    await sleep(250); // 列时间那次推送的合并时间过去
    const member = await t.openStream(`/api/rooms/${roomId}/events`, t2);
    // 公开的对局：不是成员的 tester3 在观看
    const watcher = await t.openStream(`/api/rooms/${roomId}/events`, t3);
    await watcher.waitFor((e) => e.event === 'presence');

    // 勾一下：成员马上收到
    assert.equal((await as(t1)('PUT', url, { votes: { [a]: 'yes' } })).status, 200);
    await member.waitFor((e) => e.event === 'schedule' && e.data.roomId === roomId);
    const row = () => t.app.db.prepare('SELECT answer, updated_at FROM schedule_votes WHERE slot_id = ? AND user_id = ?').get(a, userId(T1.username));
    const first = row();
    await sleep(300);
    assert.equal(scheduleEvents(member.events, roomId), 1);

    // 和原来一样（勾的一样、没勾的说不勾）：照样返回，但不写、不推
    now += MIN;
    const r = await as(t1)('PUT', url, { votes: { [a]: 'yes', [b]: null } });
    assert.equal(r.status, 200);
    assert.equal(r.data.schedule.slots[0].mine, 'yes');
    await sleep(300);
    assert.equal(scheduleEvents(member.events, roomId), 1, '没变：不推');
    assert.deepEqual(row(), first, '没变：不写');

    // 一下子变好几次：第一次马上推，后面的在合并时间结束时补推一次
    const t0 = Date.now();
    for (const answer of ['no', 'maybe', 'yes', 'no']) assert.equal((await as(t1)('PUT', url, { votes: { [b]: answer } })).status, 200);
    const elapsed = Date.now() - t0;
    await sleep(450);
    const pushed = scheduleEvents(member.events, roomId) - 1;
    assert.ok(pushed >= 2, `第一次马上推、最后的补推：${pushed}`);
    assert.ok(pushed <= 2 + Math.floor(elapsed / 200), `4 次变化合成了几次推送：${pushed}（用了 ${elapsed} 毫秒）`);
    // 最后补推以后拉到的是最后的样子
    const view = (await as(t2)('GET', `/api/rooms/${roomId}/schedule`)).data.schedule;
    assert.deepEqual(view.slots[1].counts, { yes: 0, maybe: 0, no: 1 });

    // 观看的人一次都没收到（推送连接是通的：开的时候收到了在线情况）
    assert.equal(scheduleEvents(watcher.events, roomId), 0);
    member.close();
    watcher.close();
  } finally {
    t.app.schedule.throttleMs = 50;
    now = start;
  }
});

test('狂勾被限：每人每分钟最多勾 30 次（超了 429）；同一局别人只收到合并以后的几次推送', async () => {
  const start = now;
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0, rateLimits: true });
  try {
    app.app.schedule.throttleMs = 300;
    const host = await app.login(ADMIN.username, ADMIN.password);
    const spammer = await app.login(T1.username, T1.password);
    const victim = await app.login(T2.username, T2.password);
    const room = (await app.call('POST', '/api/rooms', { name: '狂勾测试局', maxPlayers: 4 }, host)).data.room;
    for (const cookie of [spammer, victim]) assert.equal((await app.call('POST', '/api/rooms/join', { code: room.joinCode }, cookie)).status, 200);
    const slot = (await app.call('POST', `/api/rooms/${room.id}/schedule`, { slots: [now + DAY] }, host)).data.schedule.slots[0].id;
    const url = `/api/rooms/${room.id}/schedule/votes`;
    await sleep(350);
    // 受害的成员开着对局页和「我的对局」
    const roomStream = await app.openStream(`/api/rooms/${room.id}/events`, victim);
    const lobbyStream = await app.openStream('/api/events', victim);

    const statuses: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      const r = await app.call('PUT', url, { votes: { [slot]: i % 2 ? 'no' : 'yes' } }, spammer);
      statuses.push(r.status);
      if (r.status === 429) assert.equal(r.data.error, '勾得太快了，歇一会儿再勾');
    }
    const elapsed = Date.now() - t0;
    assert.equal(statuses.filter((x) => x === 200).length, 30);
    assert.equal(statuses.filter((x) => x === 429).length, 10);
    assert.deepEqual(statuses.slice(30), Array(10).fill(429), '超了以后都是 429');
    await sleep(700);
    for (const stream of [roomStream, lobbyStream]) {
      const n = scheduleEvents(stream.events, room.id);
      assert.ok(n >= 1 && n <= 2 + Math.ceil(elapsed / 300), `30 次变化只推了几次：${n}（用了 ${elapsed} 毫秒）`);
    }
    // 最后一次变化（第 30 次是「来不了」）推出去了
    const view = (await app.call('GET', `/api/rooms/${room.id}/schedule`, undefined, victim)).data.schedule;
    assert.deepEqual(view.slots[0].counts, { yes: 0, maybe: 0, no: 1 });
    // 按账号限：别人照样能勾；过了一分钟，他也又能勾了
    assert.equal((await app.call('PUT', url, { votes: { [slot]: 'maybe' } }, victim)).status, 200);
    now += 61_000;
    assert.equal((await app.call('PUT', url, { votes: { [slot]: 'yes' } }, spammer)).status, 200);
  } finally {
    await app.close();
    now = start;
  }
});

test('约团的时间按本地时间写成「10月30日 周五 20:00」', () => {
  const at = new Date(2026, 9, 30, 20, 0).getTime();
  assert.equal(scheduleTimeText(at), '10月30日 周五 20:00');
  assert.equal(scheduleTimeText(new Date(2026, 0, 4, 9, 5).getTime()), '1月4日 周日 09:05');
});

test('新加的接口没有被别的路由挡住', () => {
  assert.deepEqual(
    t.app.router.shadowed().filter((x) => x.includes('schedule')),
    [],
  );
});
