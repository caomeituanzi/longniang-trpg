process.env.TZ = 'Asia/Shanghai';
// V0.8.2：个人主页上的四个数换成玩完的剧本、通关的地下城、达成的结局、成就（下面几块的顺序和头像菜单的顺序只改了网页）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { RELEASE_NOTES } from '../server/release-notes';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

const [, TESTER1, TESTER2] = TEST_ACCOUNTS;
const SHEET = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };

let t: Awaited<ReturnType<typeof startTestApp>>;
let t1: string;
let t2: string;

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
});

after(async () => {
  await t.close();
});

const userOf = (username: string) => t.app.db.prepare('SELECT id, public_id FROM users WHERE username = ?').get(username) as { id: number; public_id: string };
const statsSeenBy = async (cookie: string, username: string) => {
  const r = await t.call('GET', `/api/users/${userOf(username).public_id}`, undefined, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.stats;
};

test('主页上的四个数：一开始都是 0', async () => {
  assert.deepEqual(await statsSeenBy(t2, TESTER1.username), { scenarios: 0, dungeons: 0, endings: 0, achievements: 0 });
});

test('玩完的剧本只算剧本大厅里的、不算地下城，重复玩也算；通关的地下城重复刷也算，自己的卡死在里面的、逃出来的不算；成就和成就那一块一样算', async () => {
  const db = t.app.db;
  const me = userOf(TESTER1.username).id;
  const other = userOf(TESTER2.username).id;
  const card = (await t.call('POST', '/api/cards', { name: '刷子', ...SHEET }, t1)).data.card;
  assert.ok(card?.id);
  const growth = db.prepare('INSERT INTO pet_growth (user_id, room_id, room_created_at, attribute, scenario_title, created_at) VALUES (?, ?, ?, ?, ?, 1)');
  const finish = db.prepare("INSERT INTO scenario_finishes (room_id, room_created_at, scenario_key, ending_key, ending_title, players, created_at) VALUES (?, ?, ?, 'end', '结局', 1, 1)");
  const run = db.prepare(
    "INSERT INTO dungeon_runs (room_id, room_created_at, scenario_key, scenario_title, level, size, result, players, members, real_minutes, game_minutes, created_at) VALUES (?, ?, 'dungeon-abandoned-mine', '废矿夜灯', 1, 'small', ?, 1, ?, 30, 60, 1)",
  );
  const members = (...users: number[]) => JSON.stringify(users.map((u) => ({ userId: u, cardId: u === me ? card.id : 999, name: '卡' })));

  // 剧本大厅里的《青溪灯夜》玩完两次（重复玩也算）
  growth.run(me, 101, 1, 'intellect', '青溪灯夜');
  finish.run(101, 1, 'qingxi-lantern-night');
  growth.run(me, 102, 2, 'intellect', '青溪灯夜');
  finish.run(102, 2, 'qingxi-lantern-night');
  // 自己导入的剧本玩完了：不是剧本大厅里的，不算
  growth.run(me, 103, 3, null, '自己写的');
  // 别人玩完的：不算我的
  growth.run(other, 104, 4, 'charm', '望江楼和头酒');
  finish.run(104, 4, 'teahouse-truce');
  // 地下城：通关两次（一次走到结局记进了剧本大厅的玩完局数，也不算进「玩完的剧本」）
  growth.run(me, 201, 11, 'body', '废矿夜灯');
  finish.run(201, 11, 'dungeon-abandoned-mine');
  run.run(201, 11, 'clear', members(me, other));
  run.run(202, 12, 'clear', members(me));
  // 逃出来的、失败的不算
  run.run(203, 13, 'escape', members(me));
  run.run(204, 14, 'fail', members(me));
  // 队伍通关了，自己的卡死在里面：不算
  run.run(205, 15, 'clear', members(me, other));
  db.prepare("INSERT INTO card_history (card_id, room_id, room_created_at, scenario_title, points, result, level, created_at) VALUES (?, 205, 15, '废矿夜灯', 0, 'dead', 1, 1)").run(card.id);
  // 没有我的
  run.run(206, 16, 'clear', members(other));

  // 结局：三个不同的
  const ending = db.prepare("INSERT INTO endings_reached (user_id, scenario_key, ending_key, ending_title, scenario_title, created_at) VALUES (?, ?, ?, '结局', '剧本', 1)");
  ending.run(me, 'qingxi-lantern-night', 'a');
  ending.run(me, 'qingxi-lantern-night', 'b');
  ending.run(me, 'dungeon-abandoned-mine', 'clear');
  // 成就：一个看得到的、一个隐藏的算；活动称号、早就没有了的成就不算
  const ach = db.prepare('INSERT INTO achievements (user_id, key, title, created_at) VALUES (?, ?, ?, 1)');
  ach.run(me, 'first-game', '初入江湖');
  ach.run(me, 'night-owl', '夜猫子');
  ach.run(me, 'event-halloween-2026', '南瓜灯');
  ach.run(me, 'some-old-achievement', '以前的');

  const stats = await statsSeenBy(t2, TESTER1.username);
  assert.deepEqual(stats, { scenarios: 2, dungeons: 2, endings: 3, achievements: 2 });
  // 成就和成就那一块标题旁边的数一样：看得到的里达成了几个 + 达成了的隐藏成就
  const profile = (await t.call('GET', `/api/users/${userOf(TESTER1.username).public_id}`, undefined, t2)).data;
  const earned = profile.collection.achievements as { key: string; hidden?: boolean }[];
  assert.equal(earned.filter((a) => a.key === 'first-game' || a.hidden).length, stats.achievements);
  // 别人的数不变
  assert.deepEqual(await statsSeenBy(t1, TESTER2.username), { scenarios: 1, dungeons: 3, endings: 0, achievements: 0 });
});

test('不展示对局和战绩：别人看不到这四个数，自己看得到', async () => {
  assert.equal((await t.call('PUT', '/api/me/profile', { showRooms: false }, t1)).status, 200);
  assert.equal(await statsSeenBy(t2, TESTER1.username), null);
  assert.equal((await statsSeenBy(t1, TESTER1.username)).scenarios, 2);
  await t.call('PUT', '/api/me/profile', { showRooms: true }, t1);
  assert.equal((await statsSeenBy(t2, TESTER1.username)).dungeons, 2);
});

test('V0.8.2 的更新公告写给玩家：头像菜单的顺序、主页上的四个数', () => {
  const note = RELEASE_NOTES.find((n) => n.version === '0.8.2');
  assert.ok(note);
  assert.match(note.body, /我的角色.*我的宠物.*我的背包.*我的装扮/);
  assert.match(note.body, /玩完的剧本/);
  assert.match(note.body, /通关的地下城/);
});
