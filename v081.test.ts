process.env.TZ = 'Asia/Shanghai';
// V0.8.1：宠物、装扮挪进头像菜单（「我的宠物」「我的装扮」，只改了网页）；个人主页展示角色卡（每张卡可以选展不展示，默认展示）；
// 有封号权限的管理员在别人的主页上封号、解封。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS, openDatabase, schemaVersion } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;
const SHEET = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin: string;
let t1: string;
let t2: string;
let t3: string;
let now = Date.parse('2026-10-28T10:00:00+08:00');

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0, now: () => now });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userOf = (username: string) => t.app.db.prepare('SELECT id, public_id FROM users WHERE username = ?').get(username) as { id: number; public_id: string };
const profile = async (cookie: string, username: string) => {
  const r = await as(cookie)('GET', `/api/users/${userOf(username).public_id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test('第 20 版：角色卡多了「在不在主页展示」，默认展示；从第 19 版升级上来的卡都展示', () => {
  assert.ok(MIGRATIONS.length >= 20);
  const columns = (t.app.db.prepare('PRAGMA table_info(character_cards)').all() as { name: string; dflt_value: string | null }[]).map((c) => [c.name, c.dflt_value]);
  assert.deepEqual(columns.find(([n]) => n === 'on_profile'), ['on_profile', '1']);

  // 一个停在第 19 版的数据库，里面有一张卡：升级以后这张卡在主页上展示
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v081-'));
  try {
    const file = path.join(dir, 'game.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (19);');
    for (const sql of MIGRATIONS.slice(0, 19)) old.exec(sql);
    old.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('veteran', '老玩家', 'x', 0)").run();
    old
      .prepare("INSERT INTO character_cards (user_id, name, attributes, specialties, created_at, updated_at) VALUES (1, '老卡', '{}', '[]', 0, 0)")
      .run();
    old.close();
    const backups: number[] = [];
    const db = openDatabase(file, { onBackup: (_f, from) => backups.push(from), upTo: BEFORE_WIPE });
    assert.equal(schemaVersion(db), BEFORE_WIPE);
    assert.deepEqual(backups, [19], '升级前先备份');
    assert.equal((db.prepare("SELECT on_profile FROM character_cards WHERE name = '老卡'").get() as { on_profile: number }).on_profile, 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('个人主页：展示他的角色卡（名字、战力、属性、生命精神防御、专长、技能、装备、切磋和通关次数），背景、成长点不给别人看', async () => {
  // 游客、没卡的人：空的
  assert.deepEqual((await profile(t1, TESTER1.username)).cards, []);
  const made = await as(t1)('POST', '/api/cards', { name: '阿猎', appearance: '黑脸膛，背一张短弓', background: '小时候在山里迷过路', ...SHEET });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const card = made.data.card;
  assert.equal(card.onProfile, true, '新卡默认在主页展示');
  // 通关过一次地下城（结算写的经历）
  t.app.db
    .prepare("INSERT INTO card_history (card_id, room_id, room_created_at, scenario_title, points, result, level, created_at) VALUES (?, 0, 0, '废矿夜灯', 2, 'clear', 1, ?)")
    .run(card.id, now);
  t.app.db.prepare("UPDATE character_cards SET skills = '[\"pojun\"]' WHERE id = ?").run(card.id);

  const seen = (await profile(t2, TESTER1.username)).cards;
  assert.equal(seen.length, 1);
  const c = seen[0];
  assert.equal(c.name, '阿猎');
  assert.equal(c.appearance, '黑脸膛，背一张短弓');
  assert.deepEqual(c.attributes, SHEET.attributes);
  assert.deepEqual(c.specialties, SHEET.specialties);
  assert.equal(c.power, card.power);
  assert.equal(c.hpMax, card.hpMax);
  assert.equal(c.mpMax, card.mpMax);
  assert.equal(c.defense, card.defense);
  assert.deepEqual(c.duel, { wins: 0, losses: 0 });
  assert.equal(c.clears, 1);
  assert.deepEqual(c.skills.map((s: { name: string }) => s.name), ['破军一击']);
  assert.ok(c.skills[0].text);
  // 第一张卡送的普通装备穿在身上
  assert.ok(Object.keys(c.equipped).length >= 3, JSON.stringify(c.equipped));
  for (const key of ['background', 'points', 'spent', 'history', 'inRoom', 'onProfile']) assert.ok(!(key in c), `${key} 不该给别人看`);
  // 游客也能看他的主页和卡
  const guest = await t.call('POST', '/api/auth/guest', {});
  assert.equal(guest.status, 201, JSON.stringify(guest.data));
  const asGuest = await t.call('GET', `/api/users/${userOf(TESTER1.username).public_id}`, undefined, guest.cookie!);
  assert.equal(asGuest.status, 200);
  assert.equal(asGuest.data.cards.length, 1);
  // 游客自己的主页：没有卡
  const guestRow = t.app.db.prepare('SELECT public_id FROM users WHERE is_guest = 1 ORDER BY id DESC LIMIT 1').get() as { public_id: string };
  assert.deepEqual((await as(t2)('GET', `/api/users/${guestRow.public_id}`)).data.cards, []);
});

test('每张卡选展不展示：不展示的不在主页上（/api/users/:ref/cards 也一样），我的角色里照旧有；只能改自己的卡', async () => {
  const mine = (await as(t1)('GET', '/api/cards')).data.cards;
  const id = mine[0].id;
  const second = await as(t1)('POST', '/api/cards', { name: '二号', ...SHEET });
  assert.equal(second.status, 200);
  assert.deepEqual((await profile(t2, TESTER1.username)).cards.map((c: { name: string }) => c.name), ['阿猎', '二号']);

  let r = await as(t1)('PUT', `/api/cards/${id}`, { onProfile: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.onProfile, false);
  assert.equal(r.data.card.name, '阿猎', '别的不变');
  assert.deepEqual((await profile(t2, TESTER1.username)).cards.map((c: { name: string }) => c.name), ['二号']);
  assert.deepEqual((await profile(t1, TESTER1.username)).cards.map((c: { name: string }) => c.name), ['二号'], '自己看自己的主页也是别人看到的样子');
  assert.deepEqual((await as(t2)('GET', `/api/users/${userOf(TESTER1.username).public_id}/cards`)).data.cards.map((c: { name: string }) => c.name), ['二号']);
  const page = (await as(t1)('GET', '/api/cards')).data.cards as { id: number; onProfile: boolean }[];
  assert.deepEqual(page.map((c) => c.onProfile), [false, true]);
  // 排行照旧有它（排行是另一回事）
  assert.ok((await as(t2)('GET', '/api/rankings/cards')).data.power.some((row: { cardId: number }) => row.cardId === id));

  // 别人改不了；格式不对不行
  assert.equal((await as(t2)('PUT', `/api/cards/${id}`, { onProfile: true })).status, 404);
  assert.equal((await as(t1)('PUT', `/api/cards/${id}`, { onProfile: 'yes' })).status, 400);
  // 打过地下城、在地下城里也能改（只是展不展示）
  r = await as(t1)('PUT', `/api/cards/${id}`, { onProfile: true });
  assert.equal(r.status, 200);
  assert.deepEqual((await profile(t2, TESTER1.username)).cards.map((c: { name: string }) => c.name), ['阿猎', '二号']);
  // 改名字时不带 onProfile：不变
  r = await as(t1)('PUT', `/api/cards/${second.data.card.id}`, { name: '二号卡' });
  assert.equal(r.data.card.onProfile, true);
  await as(t1)('DELETE', `/api/cards/${second.data.card.id}`);
});

test('主页上的封号信息只给有封号权限的管理员：能不能封他（自己、站长、管理员不能），封着的写着什么时候、为什么、到什么时候', async () => {
  // 普通玩家看：没有
  assert.equal((await profile(t2, TESTER1.username)).moderation, null);
  // 站长（有所有权限）看普通玩家：能封
  const target = userOf(TESTER1.username);
  assert.deepEqual((await profile(admin, TESTER1.username)).moderation, { id: target.id, banned: null, canBan: true });
  // 看自己：不能封
  assert.equal((await profile(admin, ADMIN.username)).moderation.canBan, false);

  // tester2 当管理员、只有「发放额度」：没有封号权限，看不到
  assert.equal((await as(admin)('PUT', `/api/admin/users/${userOf(TESTER2.username).id}/role`, { role: 'admin', permissions: ['credit'] })).status, 200);
  assert.equal((await profile(t2, TESTER1.username)).moderation, null);
  // 给了封号权限：看得到；站长、别的管理员不能封
  assert.equal((await as(admin)('PUT', `/api/admin/users/${userOf(TESTER2.username).id}/role`, { role: 'admin', permissions: ['ban'] })).status, 200);
  assert.equal((await profile(t2, TESTER1.username)).moderation.canBan, true);
  assert.equal((await profile(t2, ADMIN.username)).moderation.canBan, false);
  assert.equal((await profile(admin, TESTER2.username)).moderation.canBan, false, '管理员要先撤销身份才能封');

  // 管理员 tester2 在主页上封 tester1 一天（用的是管理页同一个接口）
  const r = await as(t2)('POST', `/api/admin/users/${target.id}/ban`, { reason: '刷屏', hours: 24 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let mod = (await profile(t2, TESTER1.username)).moderation;
  assert.deepEqual(mod.banned, { at: now, reason: '管理员封禁：刷屏', until: now + 24 * 3_600_000 });
  assert.equal(mod.canBan, true);
  // 封了以后普通玩家打不开他的主页
  assert.equal((await as(t3)('GET', `/api/users/${target.public_id}`)).status, 404);
  // 解封
  assert.equal((await as(t2)('POST', `/api/admin/users/${target.id}/unban`)).status, 200);
  assert.equal((await profile(t2, TESTER1.username)).moderation.banned, null);
  assert.equal((await as(t3)('GET', `/api/users/${target.public_id}`)).status, 200);

  // 永久封禁：until 是 null；时长到了的打开主页时先解封
  await as(t2)('POST', `/api/admin/users/${target.id}/ban`, {});
  mod = (await profile(t2, TESTER1.username)).moderation;
  assert.equal(mod.banned.until, null);
  assert.equal(mod.banned.reason, '管理员封禁');
  await as(t2)('POST', `/api/admin/users/${target.id}/unban`);
  await as(t2)('POST', `/api/admin/users/${target.id}/ban`, { reason: '冷静一下', hours: 1 });
  now += 2 * 3_600_000;
  assert.equal((await profile(t2, TESTER1.username)).moderation.banned, null, '到时间了，打开主页时先解封');
  assert.equal((await as(t3)('GET', `/api/users/${target.public_id}`)).status, 200);

  await as(admin)('PUT', `/api/admin/users/${userOf(TESTER2.username).id}/role`, { role: 'user' });
  // 重新登录（封号让 tester1 的登录失效了）
  t1 = await t.login(TESTER1.username, TESTER1.password);
});
