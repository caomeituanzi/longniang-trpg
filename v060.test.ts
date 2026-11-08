// 时间按东京算（隐藏成就看几点玩完）：要在用到 Date 之前设好
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { DEFAULT_AI_SETTINGS } from '../server/ai/client';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS, transaction } from '../server/db';
import { HIDDEN_ACHIEVEMENTS } from '../server/hidden-achievements';
import { LEGENDARY_GEAR } from '../server/legendary';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { ACHIEVEMENTS, HIDDEN_ACHIEVEMENT_COUNT } from '../shared/achievements';
import { GUIDE_DECLINE } from '../server/guide';
import { ALL_PLACES } from '../shared/postcards';
import { PET_SHOP } from '../shared/pets';
import { startTestApp } from './helpers';

// V0.6.0：网站向导、隐藏成就、图鉴、站长一键全开、整局排查包、评分和作品数据、排行、给作者的反馈、AI 审核、
// 公告模板（全服发额度、发龙晶）、封号可以不写原因、限时活动、宠物远行和日记、串门和留言、宠物出手、主持风格。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-10-31 03:00（东京）：凌晨 2～5 点，又是万圣节。 */
let now = new Date(2026, 9, 31, 3, 0, 0).getTime();

/** 骰子：排好的点数先用，用完了都是 4（4+4 再加属性，不会失败）。 */
const dice: number[] = [];
const rng = (sides: number) => (dice.length ? dice.shift()! : Math.min(4, sides));

const fake = new FakeProvider(demoHandler);
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';
let t4 = '';

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0, rng, petRng: () => 0, hiddenAchievements: true });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
  t4 = await t.login(TESTER4.username, TESTER4.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const one = (sql: string, ...params: (string | number)[]) => Object.values(t.app.db.prepare(sql).get(...params) as Record<string, unknown>)[0];
const achieved = (username: string) =>
  (t.app.db.prepare('SELECT key FROM achievements WHERE user_id = ? ORDER BY key').all(userId(username)) as { key: string }[]).map((r) => r.key);
const lastAudit = () => t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string };

/** 交一个行动，等它到点结算完（计时模式：游戏里 10 分钟的行动等 15 分钟）。 */
async function act(roomId: number, cookie: string, content: string, opts: { petHelp?: boolean; wait?: number } = {}) {
  const r = await as(cookie)('POST', `/api/rooms/${roomId}/actions`, { content, ...(opts.petHelp ? { petHelp: true } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.engine.idle();
  now += (opts.wait ?? 16) * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

/** 一个人用剧本大厅里的《雾港旅店》开一局、建角色、开局。 */
async function soloRoom(cookie: string, character: Record<string, unknown>, name = '测试局') {
  const room = (await as(cookie)('POST', '/api/rooms', { name, maxPlayers: 4, scenarioKey: 'fog-harbor-inn' })).data.room;
  let r = await as(cookie)('PUT', `/api/rooms/${room.id}/character`, character);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await as(cookie)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return room.id as number;
}

/** 解压排查包（测试自己读 ZIP 的中央目录）。 */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const data = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// ==================== 定义 ====================

test('第 16 版的数据库；AI 多了「向导」「审核」两项，默认 DeepSeek V4.1 Flash 1017', () => {
  const m16 = MIGRATIONS[15];
  for (const table of ['guide_messages', 'scenario_finishes', 'scenario_feedback', 'ai_reviews', 'endings_reached', 'achievements', 'events', 'pet_diary']) {
    assert.match(m16, new RegExp(`CREATE TABLE ${table}`), table);
  }
  assert.equal(DEFAULT_AI_SETTINGS.models.guide, 'deepseek-flash');
  assert.equal(DEFAULT_AI_SETTINGS.models.review, 'deepseek-flash');
  assert.equal(HIDDEN_ACHIEVEMENTS.length, HIDDEN_ACHIEVEMENT_COUNT);
  assert.equal(ALL_PLACES.length, 20);
});

test('隐藏成就、传奇装备的名字和条件只在服务器上：共用代码和网页代码里都没有', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
    }
  };
  walk(path.join(root, 'shared'));
  walk(path.join(root, 'web', 'src'));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const a of HIDDEN_ACHIEVEMENTS) {
    assert.ok(!text.includes(a.title), `隐藏成就「${a.title}」不在网页代码里`);
    assert.ok(!text.includes(a.how), `隐藏成就「${a.title}」的条件不在网页代码里`);
  }
  for (const g of LEGENDARY_GEAR) assert.ok(!text.includes(g.name), `传奇装备「${g.name}」不在网页代码里`);
  // 网站向导的说明里也没有
  const guide = fs.readFileSync(path.join(root, 'server', 'guide.ts'), 'utf8');
  for (const a of HIDDEN_ACHIEVEMENTS) assert.ok(!guide.includes(a.title));
});

test('每条接口都轮得到：没有被前面登记的同名接口挡住的（限时活动以前和大厅的实时推送撞了 /api/events）', () => {
  assert.deepEqual(t.app.router.shadowed(), []);
});

test('事务里再开事务（串门喂食以前就是这样出错的）：里面那层出错只撤里面的，外面出错全撤', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE x (v INTEGER)');
  const values = () => (db.prepare('SELECT v FROM x ORDER BY v').all() as { v: number }[]).map((r) => r.v);
  const put = (v: number) => db.prepare('INSERT INTO x VALUES (?)').run(v);
  transaction(db, () => {
    put(1);
    assert.throws(
      () =>
        transaction(db, () => {
          put(2);
          throw new Error('里面');
        }),
      /里面/,
    );
    transaction(db, () => put(3));
  });
  assert.deepEqual(values(), [1, 3]);
  assert.throws(
    () =>
      transaction(db, () => {
        put(4);
        transaction(db, () => put(5));
        throw new Error('外面');
      }),
    /外面/,
  );
  assert.deepEqual(values(), [1, 3]);
  // 出过错以后还能照常开事务
  transaction(db, () => put(6));
  assert.deepEqual(values(), [1, 3, 6]);
  db.close();
});

// ==================== 网站向导 ====================

test('网站向导：正式用户问网站的事，花自己的额度；接着问带上前面的对话；跑题的婉拒不算违规；违规照样警告；能清空', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await as(guest)('GET', '/api/guide')).status, 403);

  let page = (await as(t1)('GET', '/api/guide')).data;
  assert.deepEqual(page, { messages: [], ready: true, message: null });

  fake.requests.length = 0;
  page = (await as(t1)('POST', '/api/guide', { question: '龙晶怎么换额度？' })).data;
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].role, 'user');
  assert.equal(page.messages[0].text, '龙晶怎么换额度？');
  assert.match(page.messages[1].text, /测试用的假向导/);
  const req = fake.requests[fake.requests.length - 1];
  assert.match(req.system![0].text, /^你是线上跑团网站「龙娘跑团」的网站向导。/);
  assert.match(req.system![0].text, /# 网站说明/);
  assert.match(req.system![1].text, /# 提问的人/);
  // 花的是他自己的额度
  const call = t.app.db.prepare("SELECT id, user_id FROM ai_calls WHERE purpose = 'guide' ORDER BY id DESC LIMIT 1").get() as { id: number; user_id: number };
  assert.equal(call.user_id, userId(TESTER1.username));
  // 接着问：带上前面的一问一答
  fake.requests.length = 0;
  page = (await as(t1)('POST', '/api/guide', { question: '那每个月最多换多少？' })).data;
  assert.equal(page.messages.length, 4);
  assert.equal(fake.requests[fake.requests.length - 1].messages.length, 3);

  // 跑题的：婉拒，不记违规
  const before = one('SELECT COUNT(*) FROM violations');
  let r = await as(t1)('POST', '/api/guide', { question: '帮我写作业 测试无关' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, GUIDE_DECLINE);
  assert.equal(one('SELECT COUNT(*) FROM violations'), before);
  // 违规的：和别处一样第一次警告
  r = await as(t1)('POST', '/api/guide', { question: '测试违规' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /这是警告/);
  assert.equal(one('SELECT source FROM violations ORDER BY id DESC LIMIT 1'), 'guide');
  t.app.db.prepare('UPDATE violations SET dismissed = 1 WHERE user_id = ?').run(userId(TESTER1.username));
  // 太长的不收
  assert.equal((await as(t1)('POST', '/api/guide', { question: '问'.repeat(301) })).status, 400);
  // 清空
  page = (await as(t1)('DELETE', '/api/guide')).data;
  assert.deepEqual(page.messages, []);
  // 额度用完了不能问
  t.app.db.prepare('UPDATE users SET ai_credit_usd = 0 WHERE id = ?').run(userId(TESTER2.username));
  t.app.db.prepare('INSERT INTO ai_call_shares (call_id, user_id, cost_usd) VALUES (?, ?, 1)').run(call.id, userId(TESTER2.username));
  r = await as(t2)('POST', '/api/guide', { question: '额度怎么用完了' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /额度用完了/);
  t.app.db.prepare('DELETE FROM ai_call_shares WHERE call_id = ? AND user_id = ?').run(call.id, userId(TESTER2.username));
  t.app.db.prepare('UPDATE users SET ai_credit_usd = 5 WHERE id = ?').run(userId(TESTER2.username));
});

// ==================== 隐藏成就、图鉴 ====================

test('隐藏成就：凌晨玩完（夜猫子）、万圣节玩完、开场一小时内走到结局（速战速决）；通知里标着隐藏；主页上只给达成了的', async () => {
  // tester3 养一只宠物，带着它玩
  assert.equal((await as(t3)('POST', '/api/pet', { name: '小雾' })).status, 201);
  const roomId = await soloRoom(t3, { roleKey: 'doctor', name: '许医生', withPet: true });
  await act(roomId, t3, '我在原地等一会儿');
  await act(roomId, t3, '我继续等着');
  await act(roomId, t3, '真相大白 测试结局');
  assert.equal((await as(t3)('GET', `/api/rooms/${roomId}`)).data.room.status, 'ended');
  const keys = achieved(TESTER3.username);
  for (const k of ['first-game', 'with-pet', 'night-owl', 'halloween', 'speedrun']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('midnight-horror'), '不是恐怖剧本');
  // 通知：隐藏的标着 hidden
  const notes = (await as(t3)('GET', '/api/notifications')).data.items as { kind: string; data: { key: string; hidden?: boolean } }[];
  const owl = notes.find((n) => n.kind === 'achievement' && n.data.key === 'night-owl')!;
  assert.equal(owl.data.hidden, true);
  assert.equal(notes.find((n) => n.kind === 'achievement' && n.data.key === 'first-game')!.data.hidden, undefined);
  // 主页：达成了的隐藏成就带着名字和条件，没达成的不给
  const profile = (await as(t1)('GET', `/api/users/${publicId(TESTER3.username)}`)).data;
  const hidden = profile.collection.achievements.filter((a: { hidden?: boolean }) => a.hidden);
  assert.deepEqual(hidden.map((a: { key: string }) => a.key).sort(), ['halloween', 'night-owl', 'speedrun']);
  assert.equal(hidden.find((a: { key: string }) => a.key === 'night-owl').title, '夜猫子');
  assert.equal(profile.collection.titles, null, '别人的主页不给能戴的称号');
  // 隐藏成就也是称号
  const titles = (await as(t3)('GET', '/api/me/titles')).data;
  assert.ok(titles.options.some((o: { key: string; name: string }) => o.key === 'night-owl' && o.name === '夜猫子'));
  assert.equal((await as(t3)('PUT', '/api/me/title', { title: 'night-owl' })).status, 200);
  assert.equal((await as(t1)('GET', `/api/users/${publicId(TESTER3.username)}`)).data.title, '夜猫子');
  // 白天、慢慢玩：这几个都不会有
  now = new Date(2026, 10, 2, 14, 0, 0).getTime();
  const slow = await soloRoom(t4, { roleKey: 'sailor', name: '老水手' });
  await act(slow, t4, '我在原地等一会儿', { wait: 40 });
  await act(slow, t4, '我继续等着', { wait: 40 });
  await act(slow, t4, '真相大白 测试结局');
  assert.deepEqual(
    achieved(TESTER4.username).filter((k) => HIDDEN_ACHIEVEMENTS.some((h) => h.key === k)),
    [],
  );
});

test('隐藏成就：一局里大成功、大失败都掷出过（大起大落）；两次大失败（祸不单行）；宠物出手掷出大成功（神来一爪）；吃饱了还喂（吃撑了）', async () => {
  assert.equal((await as(t1)('POST', '/api/pet', { name: '团子' })).status, 201);
  const roomId = await soloRoom(t1, { roleKey: 'reporter', name: '林小满', withPet: true });
  let game = (await as(t1)('GET', `/api/rooms/${roomId}/game`)).data;
  assert.equal(game.me.petHelp, 'ready');
  // 两个 6
  dice.push(6, 6);
  await act(roomId, t1, '我在原地等一会儿');
  // 两个 1，勾了宠物出手：宠物帮着再掷，又是两个 6
  dice.push(1, 1, 6, 6);
  await act(roomId, t1, '我继续等着', { petHelp: true });
  game = (await as(t1)('GET', `/api/rooms/${roomId}/game`)).data;
  assert.equal(game.me.petHelp, 'used');
  assert.equal(one('SELECT COUNT(*) FROM rolls WHERE room_id = ? AND pet_help = 1', roomId), 1);
  // 宠物这一局帮过了：再勾不行
  const r = await as(t1)('POST', `/api/rooms/${roomId}/actions`, { content: '再来', petHelp: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '团子这一局已经帮过忙了');
  // 再两个 1
  dice.push(1, 1);
  await act(roomId, t1, '我又等着');
  const keys = achieved(TESTER1.username);
  for (const k of ['fumble', 'pet-save', 'pet-crit', 'swing']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('double-fumble'), '宠物救回来的那次最后是大成功，只算一次大失败');
  dice.push(1, 1);
  await act(roomId, t1, '我还在等');
  assert.ok(achieved(TESTER1.username).includes('double-fumble'));
  // 吃撑了：饱食度满了还喂
  t.app.db.prepare('UPDATE pets SET satiety = 100, state_at = ? WHERE user_id = ?').run(now, userId(TESTER1.username));
  await as(admin)('POST', `/api/admin/users/${userId(TESTER1.username)}/crystals`, { amount: 100, note: '测试' });
  await as(t1)('POST', '/api/shop/buy', { item: 'fish' });
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'fish' })).status, 409);
  assert.ok(achieved(TESTER1.username).includes('overfed'));
});

test('图鉴：剧本大厅里每个剧本的结局（没达成的只算个数）、去过的地方、装扮、骰子、成就；游客没有', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  // V0.7.1：游客能打开看看，什么都还没收集到
  assert.deepEqual((await as(guest)('GET', '/api/collection')).data.achievements, []);
  const book = (await as(t3)('GET', '/api/collection')).data;
  const fog = book.endings.find((e: { key: string }) => e.key === 'fog-harbor-inn');
  assert.equal(fog.total, 3);
  assert.deepEqual(fog.reached.map((e: { key: string }) => e.key), ['truth']);
  assert.ok(book.endings.some((e: { key: string; reached: unknown[] }) => e.key === 'qingxi-lantern-night' && e.reached.length === 0));
  assert.deepEqual(book.places, []);
  assert.deepEqual(book.outfits, []);
  assert.ok(book.achievements.some((a: { key: string; hidden?: boolean }) => a.key === 'night-owl' && a.hidden));
  assert.equal('gear' in book, false, '装备 V0.7.0 才有');
});

test('站长给自己全部解锁：别人不行；商店里每样东西放一个、结局、明信片、成就全记上，不发龙晶；记进操作记录', async () => {
  assert.equal((await as(t1)('POST', '/api/admin/unlock-all')).status, 403);
  const ownerId = userId(ADMIN.username);
  const crystals = one('SELECT crystals FROM users WHERE id = ?', ownerId);
  const book = (await as(admin)('POST', '/api/admin/unlock-all')).data;
  assert.equal(one('SELECT crystals FROM users WHERE id = ?', ownerId), crystals, '不发龙晶');
  assert.equal(book.places.length, ALL_PLACES.length);
  assert.equal(book.outfits.length, PET_SHOP.filter((i) => i.kind === 'outfit').length);
  assert.equal(book.dice.length, PET_SHOP.filter((i) => i.kind === 'dice').length);
  assert.equal(book.achievements.filter((a: { hidden?: boolean }) => a.hidden).length, HIDDEN_ACHIEVEMENT_COUNT);
  assert.equal(book.achievements.filter((a: { hidden?: boolean; key: string }) => !a.hidden && !a.key.startsWith('event-')).length, ACHIEVEMENTS.length);
  for (const e of book.endings) assert.equal(e.reached.length, e.total, e.key);
  const items = t.app.db.prepare('SELECT item, count FROM pet_items WHERE user_id = ?').all(ownerId) as { item: string; count: number }[];
  for (const i of PET_SHOP) assert.ok(items.some((x) => x.item === i.key && x.count >= 1), i.key);
  // V0.7.0 起地下城的道具、秘籍、宝箱也各放一个；装备记在 gear_items 里，不在这张表
  assert.ok(items.some((x) => x.item === 'chest'), '宝箱也放一个');
  assert.ok(!items.some((x) => x.item.startsWith('gear-')), '装备不在背包表里');
  assert.equal(lastAudit().action, '给自己全部解锁');
  // 再按一次也不会重复
  const again = (await as(admin)('POST', '/api/admin/unlock-all')).data;
  assert.equal(again.places.length, ALL_PLACES.length);
  assert.equal(one("SELECT COUNT(*) FROM pet_diary WHERE user_id = ? AND kind = 'postcard'", ownerId), ALL_PLACES.length);
});

// ==================== 整局排查包 ====================

test('整局排查包：要「管理所有对局」权限；zip 里有说明、诊断、时间线、原始数据；没有密码；笔记只有长度；记进操作记录', async () => {
  const roomId = Number(one("SELECT id FROM rooms WHERE name = '测试局' ORDER BY id LIMIT 1"));
  // 写一条笔记：排查包里只带长度
  assert.equal((await as(t3)('PUT', `/api/rooms/${roomId}/note`, { content: '这是我的私人笔记' })).status, 200);
  const url = `/api/admin/rooms/${roomId}/debug-package`;
  assert.equal((await as(t1)('GET', url)).status, 403);
  // 没有「管理所有对局」权限的管理员也不行
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["announce"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('GET', url)).status, 403);
  const res = await fetch(t.base + url, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="debug-room-\d+\.zip"; filename\*=UTF-8''/);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual([...files.keys()], ['说明.txt', '诊断.txt', '时间线.txt', '数据.json']);
  const diagnosis = files.get('诊断.txt')!.toString('utf8');
  assert.match(diagnosis, /整局排查包：对局 \d+「测试局」/);
  assert.match(diagnosis, /# 自动检查/);
  assert.match(diagnosis, /# 花费：按用途/);
  const timeline = files.get('时间线.txt')!.toString('utf8');
  assert.match(timeline, /行动 #\d+ 许医生 提交/);
  assert.match(timeline, /掷骰 #\d+ 许医生/);
  assert.match(timeline, /AI #\d+ resolve/);
  const raw = files.get('数据.json')!.toString('utf8');
  const data = JSON.parse(raw);
  assert.equal(data.room.id, roomId);
  assert.equal(data.scenario.data.title, '雾港旅店');
  assert.ok(data.actions.length >= 3);
  assert.ok(data.aiCalls.length >= 3);
  assert.ok(!raw.includes('password_hash'));
  assert.ok(!raw.includes('这是我的私人笔记'), '笔记不带内容');
  assert.equal(data.notes[0].content_length, 8);
  assert.equal(lastAudit().action, '导出排查包');
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);
});

// ==================== 评分、作品、排行、给作者的反馈、AI 审核 ====================

const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
let workKey = '';

test('投稿交上来 AI 先审一遍（意见给管理员，不自己动手）；写了违规内容的建议退回；能重新审核；AI 关了说明没审成', async () => {
  // tester4 导入一份剧本，投稿
  const room = (await as(t4)('POST', '/api/rooms', { name: '作者的局', maxPlayers: 4 })).data.room;
  assert.equal((await as(t4)('POST', `/api/rooms/${room.id}/scenario`, { data: { ...structuredClone(fog), title: '雾中客栈' } })).status, 200);
  let r = await as(t4)('POST', `/api/rooms/${room.id}/submission`, { category: 'puzzle', intro: '海边客栈里的一桩命案。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const subId = r.data.submission.id as number;
  await t.app.reviewer.idle();
  let list = (await as(admin)('GET', '/api/admin/submissions')).data.submissions;
  let sub = list.find((s: { id: number }) => s.id === subId);
  assert.equal(sub.aiReview.status, 'done');
  assert.equal(sub.aiReview.verdict, 'approve');
  assert.equal(sub.aiReview.details.quality.score, 4);
  assert.equal(sub.aiReview.model, 'DeepSeek V4.1 Flash 1017', '给管理员看的是模型的名字，不是代号');
  assert.equal(sub.status, 'pending', 'AI 不会自己通过');
  // 审核的钱算网站的：不记在谁头上
  assert.equal(one("SELECT COUNT(*) FROM ai_calls c JOIN ai_call_shares s ON s.call_id = c.id WHERE c.purpose = 'review'"), 0);
  // 重新审核：要「剧本管理」权限
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["reports"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('POST', '/api/admin/ai-reviews', { target: 'submission', id: subId })).status, 403);
  r = await as(admin)('POST', '/api/admin/ai-reviews', { target: 'submission', id: subId });
  assert.equal(r.status, 200);
  await t.app.reviewer.idle();
  assert.equal(one("SELECT COUNT(*) FROM ai_reviews WHERE target_type = 'submission' AND target_id = ?", subId), 2);
  // 管理员通过
  r = await as(admin)('POST', `/api/admin/submissions/${subId}/approve`);
  assert.equal(r.status, 200);
  workKey = one('SELECT scenario_key FROM scenario_submissions WHERE id = ?', subId) as string;
  // 写了违规内容的（内容检查漏过去了）：AI 建议退回
  const room2 = (await as(t4)('POST', '/api/rooms', { name: '第二份', maxPlayers: 4 })).data.room;
  const guard = fake.guard;
  fake.guard = () => ({ violation: false, category: 'none', reason: '' });
  await as(t4)('POST', `/api/rooms/${room2.id}/scenario`, { data: { ...structuredClone(fog), title: '雾港测试违规' } });
  r = await as(t4)('POST', `/api/rooms/${room2.id}/submission`, { category: 'puzzle', intro: '海边客栈。' });
  fake.guard = guard;
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.reviewer.idle();
  list = (await as(admin)('GET', '/api/admin/submissions')).data.submissions;
  sub = list.find((s: { id: number }) => s.id === r.data.submission.id);
  assert.equal(sub.aiReview.verdict, 'reject');
  assert.equal(sub.aiReview.details.content.ok, false);
  // AI 关了：重新审核记成没审成，说明原因
  await as(admin)('POST', `/api/admin/submissions/${sub.id}/reject`, { reason: '测试' });
  t.app.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  r = await as(admin)('POST', '/api/admin/ai-reviews', { target: 'submission', id: sub.id });
  assert.equal(r.data.review.status, 'failed');
  assert.ok(r.data.review.error);
  t.app.db.prepare("UPDATE settings SET value = '1' WHERE key = 'ai_enabled'").run();
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);
});

test('作品：玩完的局数、评分和短评（作者收到通知）、我的作品（结局分布只有作者看得到）、排行（评分榜至少 3 人评过）', async () => {
  assert.ok(workKey);
  const players = [
    [t1, TESTER1, 'reporter', '林小满'],
    [t2, TESTER2, 'doctor', '许医生'],
    [t3, TESTER3, 'detective', '沈探'],
  ] as const;
  for (const [cookie, , roleKey, name] of players) {
    const room = (await as(cookie)('POST', '/api/rooms', { name: '玩作品', maxPlayers: 4, scenarioKey: workKey })).data.room;
    assert.equal((await as(cookie)('PUT', `/api/rooms/${room.id}/character`, { roleKey, name })).status, 200);
    await as(cookie)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
    await act(room.id, cookie, '我在原地等一会儿');
    await act(room.id, cookie, '我继续等着');
    await act(room.id, cookie, cookie === t3 ? '另一个结局 测试结局2' : '真相大白 测试结局');
  }
  let hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios;
  let work = hall.find((s: { key: string }) => s.key === workKey);
  assert.equal(work.finishes, 3);
  assert.equal(work.plays, 3);
  assert.equal(work.authorUser.displayName, TESTER4.displayName ?? work.authorUser.displayName);
  // 评分：玩完的人才能评；写了短评告诉作者
  assert.equal((await as(admin)('PUT', `/api/scenario-hall/${workKey}/rating`, { stars: 5, comment: '' })).status, 403);
  for (const [cookie, , , , stars] of players.map((p, i) => [...p, [5, 4, 3][i]] as const)) {
    const r = await as(cookie)('PUT', `/api/scenario-hall/${workKey}/rating`, { stars, comment: `${stars} 星的短评` });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const notes = (await as(t4)('GET', '/api/notifications')).data.items as { kind: string; data: { stars: number } }[];
  assert.equal(notes.filter((n) => n.kind === 'work_review').length, 3);
  assert.equal(notes.filter((n) => n.kind === 'author_reward').length, 3);
  // 只改星不改短评：不再通知
  await as(t1)('PUT', `/api/scenario-hall/${workKey}/rating`, { stars: 4, comment: '5 星的短评' });
  assert.equal(((await as(t4)('GET', '/api/notifications')).data.items as { kind: string }[]).filter((n) => n.kind === 'work_review').length, 3);
  hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios;
  work = hall.find((s: { key: string }) => s.key === workKey);
  assert.deepEqual(work.rating, { average: 3.7, count: 3 });
  // 我的作品：只有作者自己的
  const mine = (await as(t4)('GET', '/api/my-works')).data.works;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].finishes, 3);
  assert.equal(mine[0].players, 3);
  assert.deepEqual(
    mine[0].endings.map((e: { title: string; count: number }) => e.count),
    [2, 1, 0],
  );
  assert.equal(mine[0].comments.length, 3);
  assert.deepEqual((await as(t1)('GET', '/api/my-works')).data.works, []);
  // 排行（V0.7.0 挪到「排行」页）：好评榜（3 人评过才上）、游玩次数榜、作者榜
  const rating = (await as(t1)('GET', '/api/rankings/works?by=rating')).data;
  assert.deepEqual(
    rating.rows.map((r: { key: string; value: number; count: number; rank: number }) => [r.key, r.value, r.count, r.rank]),
    [[workKey, 3.7, 3, 1]],
  );
  const plays = (await as(t1)('GET', '/api/rankings/works?by=plays')).data;
  assert.equal(plays.rows[0].key, workKey);
  assert.equal(plays.rows[0].value, 3);
  assert.ok(plays.rows.some((r: { key: string }) => r.key === 'fog-harbor-inn'));
  const authors = (await as(t1)('GET', '/api/rankings/authors')).data.rows;
  assert.equal(authors.length, 1);
  assert.equal(authors[0].finishes, 3);
  assert.equal(authors[0].works, 1);
  assert.equal(authors[0].me, false);
  assert.equal((await as(t1)('GET', '/api/scenario-hall/rankings')).status, 404);
});

test('给作者的反馈：玩过的人才能写（作者自己、没玩过的不行）；作者收到通知、回复、能删、能举报；写的人看得到回复', async () => {
  let detail = (await as(t1)('GET', `/api/scenario-hall/${workKey}`)).data;
  assert.deepEqual(detail.feedback, { canSend: true, mine: [] });
  // 没玩过的
  const guestless = (await as(admin)('GET', `/api/scenario-hall/${workKey}`)).data;
  assert.equal(guestless.feedback.canSend, false);
  assert.equal((await as(admin)('POST', `/api/scenario-hall/${workKey}/feedback`, { text: '没玩过' })).status, 403);
  // 作者自己
  assert.equal((await as(t4)('GET', `/api/scenario-hall/${workKey}`)).data.feedback.canSend, false);
  // 自带的剧本没有作者，不能写
  assert.equal((await as(t1)('GET', '/api/scenario-hall/fog-harbor-inn')).data.feedback, null);
  assert.equal((await as(t1)('POST', '/api/scenario-hall/fog-harbor-inn/feedback', { text: '写给谁' })).status, 404);
  // 写
  assert.equal((await as(t1)('POST', `/api/scenario-hall/${workKey}/feedback`, { text: '' })).status, 400);
  let r = await as(t1)('POST', `/api/scenario-hall/${workKey}/feedback`, { text: '第二个结局的线索有点难找。' });
  assert.equal(r.status, 201);
  assert.equal(r.data.mine[0].text, '第二个结局的线索有点难找。');
  assert.equal(r.data.mine[0].from, null);
  const fbId = r.data.mine[0].id as number;
  const n = ((await as(t4)('GET', '/api/notifications')).data.items as { kind: string; data: { title: string } }[]).find((x) => x.kind === 'work_feedback')!;
  assert.equal(n.data.title, '雾中客栈');
  // 作者看得到是谁写的，回复
  let mine = (await as(t4)('GET', '/api/my-works')).data.works[0];
  assert.equal(mine.feedback[0].from.displayName, (await as(t1)('GET', '/api/auth/me')).data.user.displayName);
  assert.equal((await as(t2)('PUT', `/api/feedback/${fbId}/reply`, { text: '不是你的' })).status, 404);
  r = await as(t4)('PUT', `/api/feedback/${fbId}/reply`, { text: '谢谢，下个版本多给一条线索。' });
  assert.equal(r.status, 200);
  assert.equal(r.data.works[0].feedback[0].reply, '谢谢，下个版本多给一条线索。');
  assert.ok(((await as(t1)('GET', '/api/notifications')).data.items as { kind: string }[]).some((x) => x.kind === 'feedback_reply'));
  detail = (await as(t1)('GET', `/api/scenario-hall/${workKey}`)).data;
  assert.equal(detail.feedback.mine[0].reply, '谢谢，下个版本多给一条线索。');
  // 举报：只有收到的作者能举报
  assert.equal((await as(t2)('POST', '/api/reports', { kind: 'report', body: '乱写', target: { type: 'feedback', id: fbId } })).status, 404);
  r = await as(t4)('POST', '/api/reports', { kind: 'report', body: '骚扰', target: { type: 'feedback', id: fbId } });
  assert.equal(r.status, 201);
  // 作者删掉：写的人那边也没了
  assert.equal((await as(t4)('DELETE', `/api/feedback/${fbId}`)).status, 200);
  mine = (await as(t4)('GET', '/api/my-works')).data.works[0];
  assert.deepEqual(mine.feedback, []);
  assert.deepEqual((await as(t1)('GET', `/api/scenario-hall/${workKey}`)).data.feedback.mine, []);
});

test('举报交上来 AI 先看一遍：违规的、不违规的、建议怎么处理；意见只给管理员；要「处理举报」权限才能重新审', async () => {
  // 大厅聊天里一句违规的话、一句正常的话
  const bad = (await as(t2)('POST', '/api/lobby/chat', { text: '测试违规 你这个人' })).data.message;
  const fine = (await as(t2)('POST', '/api/lobby/chat', { text: '大家好' })).data.message;
  let r = await as(t1)('POST', '/api/reports', { kind: 'report', body: '他骂人', target: { type: 'lobby', id: bad.id } });
  assert.equal(r.status, 201);
  const badReport = r.data.id;
  r = await as(t1)('POST', '/api/reports', { kind: 'report', body: '看着不舒服', target: { type: 'lobby', id: fine.id } });
  const fineReport = r.data.id;
  // 意见和 bug 反馈不审
  await as(t1)('POST', '/api/reports', { kind: 'feedback', body: '加个夜间模式' });
  await t.app.reviewer.idle();
  const reports = (await as(admin)('GET', '/api/admin/reports')).data.reports as { id: number; kind: string; aiReview: { verdict: string; details: { action: string; category: string } } | null }[];
  const b = reports.find((x) => x.id === badReport)!;
  assert.equal(b.aiReview!.verdict, 'violation');
  assert.equal(b.aiReview!.details.action, 'warn');
  assert.equal(b.aiReview!.details.category, 'harassment');
  assert.equal(reports.find((x) => x.id === fineReport)!.aiReview!.verdict, 'no_violation');
  assert.equal(reports.find((x) => x.kind === 'feedback')!.aiReview, null);
  // AI 只给意见：没有封号、没有删消息
  assert.equal(one('SELECT banned_at FROM users WHERE id = ?', userId(TESTER2.username)), null);
  assert.equal(one('SELECT deleted_at FROM lobby_messages WHERE id = ?', bad.id), null);
  // 审举报时告诉 AI 他以前被警告过几次
  const reviewReq = fake.requests.filter((q) => q.system?.[0]?.text.includes('初审一条用户举报'));
  assert.ok(JSON.stringify(reviewReq[0].messages).includes('被举报的人以前被警告、封号过'));
  // 重新审：要「处理举报」权限
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["scenarios"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('POST', '/api/admin/ai-reviews', { target: 'report', id: badReport })).status, 403);
  assert.equal((await as(admin)('POST', '/api/admin/ai-reviews', { target: 'report', id: badReport })).status, 200);
  await t.app.reviewer.idle();
  assert.equal((await as(admin)('GET', `/api/admin/ai-reviews/report/${badReport}`)).data.review.verdict, 'violation');
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);
});

// ==================== 公告模板、封号 ====================

test('公告模板「全服发额度」「全服发龙晶」：要同时有发公告、发放额度的权限；真的发给收到公告的正式账号；{数额}换成实际的数额；记进操作记录', async () => {
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["announce"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  const body = { title: '全服发放 AI 额度', body: '庆祝上线，每个正式账号都发了 {数额} AI 额度。', audience: 'user', grant: { kind: 'credit', amount: 1, currency: 'USD' } };
  let r = await as(t5)('POST', '/api/admin/announcements', body);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /发放额度/);
  const formal = t.app.db.prepare("SELECT id, ai_credit_usd FROM users WHERE is_guest = 0 AND deleted_at IS NULL AND banned_at IS NULL AND is_admin = 0 AND is_owner = 0").all() as { id: number; ai_credit_usd: number }[];
  r = await as(admin)('POST', '/api/admin/announcements', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.recipients, formal.length);
  for (const u of formal) assert.equal(one('SELECT ai_credit_usd FROM users WHERE id = ?', u.id), u.ai_credit_usd + 1);
  assert.equal(one("SELECT COUNT(*) FROM credit_grants WHERE note = '公告「全服发放 AI 额度」'"), formal.length);
  const ann = t.app.db.prepare('SELECT body FROM announcements ORDER BY id DESC LIMIT 1').get() as { body: string };
  assert.match(ann.body, /每个正式账号都发了 1\.00 美元 AI 额度/);
  assert.ok(!ann.body.includes('{数额}'));
  const audits = t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 2').all() as { action: string; detail: string }[];
  assert.equal(audits[0].action, '全服发额度');
  assert.match(audits[0].detail, new RegExp(`一共 ${formal.length} 个账号`));
  // 龙晶：发给指定的人
  const c3 = one('SELECT crystals FROM users WHERE id = ?', userId(TESTER3.username)) as number;
  r = await as(admin)('POST', '/api/admin/announcements', {
    title: '补偿',
    body: '给你发了 {数额}。',
    audience: 'users',
    usernames: [TESTER3.username],
    grant: { kind: 'crystals', amount: 50 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.recipients, 1);
  assert.equal(one('SELECT crystals FROM users WHERE id = ?', userId(TESTER3.username)), c3 + 50);
  assert.equal(lastAudit().action, '全服发龙晶');
  // 和单独发龙晶的规矩一样：不给自己发；管理员、站长的号只有站长能发
  const crystalsOf = (a: { username: string }) => one('SELECT crystals FROM users WHERE id = ?', userId(a.username)) as number;
  const owner0 = crystalsOf(ADMIN);
  r = await as(admin)('POST', '/api/admin/announcements', { title: '全服龙晶', body: '每人 {数额}。', audience: 'all', grant: { kind: 'crystals', amount: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(crystalsOf(ADMIN), owner0, '站长不给自己发');
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["announce","credit"]' WHERE username = ?`).run(TESTER5.username);
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["rooms"]' WHERE username = ?`).run(TESTER4.username);
  const t5b = await t.login(TESTER5.username, TESTER5.password);
  const before = new Map([ADMIN, TESTER1, TESTER4, TESTER5].map((a) => [a.username, crystalsOf(a)]));
  r = await as(t5b)('POST', '/api/admin/announcements', { title: '全服龙晶二', body: '每人 {数额}。', audience: 'all', grant: { kind: 'crystals', amount: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  for (const a of [ADMIN, TESTER4, TESTER5]) assert.equal(crystalsOf(a), before.get(a.username), `${a.username} 没收到`);
  assert.equal(crystalsOf(TESTER1), before.get(TESTER1.username)! + 5);
  // 只发给管理员：一个能收的都没有
  r = await as(t5b)('POST', '/api/admin/announcements', { title: '管理员龙晶', body: '每人 {数额}。', audience: 'admin', grant: { kind: 'crystals', amount: 5 } });
  assert.equal(r.status, 400);
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER4.username);
  t.app.db.prepare(`UPDATE users SET admin_perms = '["announce"]' WHERE username = ?`).run(TESTER5.username);
  // 游客没有额度、龙晶
  assert.equal((await as(admin)('POST', '/api/admin/announcements', { ...body, audience: 'guest' })).status, 400);
  // 不带 grant 的公告照旧
  assert.equal((await as(t5)('POST', '/api/admin/announcements', { title: '停机维护通知', body: '今晚维护。', audience: 'all' })).status, 201);
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);
});

test('封号可以不写原因：操作记录里写「没写原因」；被封的人登录只说被封了', async () => {
  const id = userId(TESTER5.username);
  let r = await as(admin)('POST', `/api/admin/users/${id}/ban`, { hours: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(lastAudit().detail, /没写原因/);
  r = await t.call('POST', '/api/auth/login', { username: TESTER5.username, password: TESTER5.password });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /^账号已被封禁（管理员封禁），1 小时后自动解封/);
  assert.equal((await as(admin)('POST', `/api/admin/users/${id}/unban`)).status, 200);
  // 批量封号也一样
  r = await as(admin)('POST', '/api/admin/users/batch', { ids: [id], op: 'ban', hours: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await as(admin)('POST', `/api/admin/users/${id}/unban`);
});

// ==================== 限时活动 ====================

test('限时活动：自带一个万圣节（10 月 28 日到 11 月 4 日）；活动期间卖限时商品；翻倍分区的剧本玩完龙晶翻倍、得活动称号；管理员开、改、删', async () => {
  // 现在是 11 月 2 日
  const events = (await as(t1)('GET', '/api/limited-events')).data.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].name, '万圣节');
  assert.deepEqual(events[0].categories, ['horror']);
  assert.equal(events[0].title, '南瓜灯');
  // 限时商品在商城的「限时」里（V0.7.0）
  let page = (await as(t1)('GET', '/api/shop')).data;
  assert.deepEqual(
    page.items.filter((i: { limited: boolean }) => i.limited).map((i: { key: string }) => i.key),
    ['outfit-pumpkin', 'outfit-ghost', 'dice-pumpkin'],
  );
  await as(admin)('POST', `/api/admin/users/${userId(TESTER1.username)}/crystals`, { amount: 500, note: '测试' });
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'outfit-pumpkin' })).status, 200);
  // 恐怖分区的剧本：龙晶翻倍、得到活动称号
  const room = (await as(t1)('POST', '/api/rooms', { name: '万圣节的局', maxPlayers: 4 })).data.room;
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { data: { ...structuredClone(fog), title: '雾港鬼事', category: 'horror' } })).status, 200);
  await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小满' });
  await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  await act(room.id, t1, '我在原地等一会儿');
  await act(room.id, t1, '我继续等着');
  await act(room.id, t1, '真相大白 测试结局');
  page = (await as(t1)('GET', '/api/shop')).data;
  const game = page.ledger.find((l: { kind: string }) => l.kind === 'game');
  assert.equal(game.delta, 40);
  assert.match(game.detail, /万圣节翻倍/);
  const eventId = events[0].id;
  assert.ok(achieved(TESTER1.username).includes(`event-${eventId}`));
  assert.ok((await as(t1)('GET', '/api/me/titles')).data.options.some((o: { name: string }) => o.name === '南瓜灯'));

  // 管理员：要「发放额度」权限
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["announce"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('GET', '/api/admin/limited-events')).status, 403);
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);
  const start = new Date(2026, 11, 20, 0, 0, 0).getTime();
  let r = await as(admin)('POST', '/api/admin/limited-events', { name: '圣诞节', startsAt: start, endsAt: start + 7 * 24 * HOUR, categories: ['adventure'], items: ['outfit-santa'], title: '雪夜旅人' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(lastAudit().action, '开活动');
  const xmas = r.data.events.find((e: { name: string }) => e.name === '圣诞节');
  // 还没开始：不卖
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'outfit-santa' })).status, 409);
  r = await as(admin)('PUT', `/api/admin/limited-events/${xmas.id}`, { name: '圣诞节', startsAt: start, endsAt: start + 3 * 24 * HOUR, categories: ['adventure'], items: ['outfit-santa'], title: '' });
  assert.equal(r.status, 200);
  assert.equal(lastAudit().action, '改活动');
  // 称号要有翻倍的分区
  r = await as(admin)('POST', '/api/admin/limited-events', { name: '空的', startsAt: start, endsAt: start + HOUR, categories: [], items: [], title: '称号' });
  assert.equal(r.status, 400);
  assert.equal((await as(admin)('DELETE', `/api/admin/limited-events/${xmas.id}`)).status, 200);
  assert.equal(lastAudit().action, '删活动');
  // 万圣节过了：不卖了，买过的留着
  now = new Date(2026, 10, 5, 12, 0, 0).getTime();
  assert.deepEqual((await as(t1)('GET', '/api/limited-events')).data.events, []);
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'outfit-ghost' })).status, 409);
  assert.ok(!(await as(t1)('GET', '/api/shop')).data.items.some((i: { key: string }) => i.key === 'outfit-ghost'));
  assert.ok((await as(t1)('GET', '/api/wardrobe')).data.outfits.includes('outfit-pumpkin'));
});

// ==================== 宠物：远行、日记、装扮、骰子、串门、留言、排行 ====================

test('宠物远行：花精力和饱食度，到点带回龙晶和一张明信片（记在日记和图鉴里）；中途叫回来什么也没有；打工、远行不能同时', async () => {
  t.app.db.prepare('UPDATE pets SET energy = 100, satiety = 100, state_at = ? WHERE user_id = ?').run(now, userId(TESTER1.username));
  let page = (await as(t1)('POST', '/api/pet/trip', { kind: 'near' })).data;
  assert.equal(page.pet.trip.kind, 'near');
  assert.equal(page.pet.energy, 85);
  assert.equal(page.pet.satiety, 90);
  // 远行时不能打工、不能再出门
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'porter' })).status, 409);
  assert.equal((await as(t1)('POST', '/api/pet/trip', { kind: 'far' })).status, 409);
  const crystals = (await as(t1)('GET', '/api/shop')).data.crystals as number;
  now += 2 * HOUR + MIN;
  page = (await as(t1)('GET', '/api/pet')).data;
  assert.equal(page.pet.trip, null);
  const shop = (await as(t1)('GET', '/api/shop')).data;
  const trip = shop.ledger.find((l: { kind: string }) => l.kind === 'trip');
  assert.ok(trip.delta >= 5 && trip.delta <= 15);
  assert.ok(shop.crystals >= crystals + 5);
  const diary = (await as(t1)('GET', '/api/pet/diary')).data.entries;
  const postcard = diary.find((d: { kind: string }) => d.kind === 'postcard');
  assert.ok(postcard);
  assert.ok(ALL_PLACES.includes(postcard.title));
  assert.match(postcard.text, /团子/);
  const notice = ((await as(t1)('GET', '/api/notifications')).data.items as { kind: string; data: { place: string } }[]).find((n) => n.kind === 'pet_trip_done')!;
  assert.equal(notice.data.place, postcard.title);
  assert.deepEqual((await as(t1)('GET', '/api/collection')).data.places, [postcard.title]);
  // 叫回来：什么也没有
  page = (await as(t1)('POST', '/api/pet/trip', { kind: 'far' })).data;
  const before = (await as(t1)('GET', '/api/shop')).data.crystals;
  page = (await as(t1)('DELETE', '/api/pet/trip')).data;
  assert.equal(page.pet.trip, null);
  assert.equal((await as(t1)('GET', '/api/shop')).data.crystals, before);
  assert.equal((await as(t1)('DELETE', '/api/pet/trip')).status, 409);
});

test('带着宠物玩完一局，宠物写一篇日记（只有主人看得到）', async () => {
  // tester3 带着小雾玩完了一局（隐藏成就那一项）；tester1 带着团子的那局没走到结局，没有日记
  await t.app.diary.idle();
  const entries = (await as(t3)('GET', '/api/pet/diary')).data.entries as { kind: string; title: string; text: string; writing: boolean }[];
  const diary = entries.filter((e) => e.kind === 'diary');
  assert.equal(diary.length, 1);
  assert.equal(diary[0].writing, false);
  assert.match(diary[0].text, /小雾/);
  assert.ok(!(await as(t1)('GET', '/api/pet/diary')).data.entries.some((e: { kind: string }) => e.kind === 'diary'));
  // 别人看不到：日记只在自己的宠物页
  assert.ok(!(await as(t2)('GET', '/api/pet/diary')).data.entries.some((e: { text: string }) => e.text === diary[0].text));
});

test('骰子皮肤和装扮：买了才能用；掷骰的卡片上带着皮肤；主页上看得到装扮', async () => {
  assert.equal((await as(t1)('PUT', '/api/pet/dice', { dice: 'dice-jade' })).status, 409);
  await as(t1)('POST', '/api/shop/buy', { item: 'dice-jade' });
  let page = (await as(t1)('PUT', '/api/pet/dice', { dice: 'dice-jade' })).data;
  assert.equal(page.diceSkin, 'dice-jade');
  assert.equal((await as(t1)('PUT', '/api/pet/outfit', { outfit: 'outfit-scarf' })).status, 409);
  page = (await as(t1)('PUT', '/api/pet/outfit', { outfit: 'outfit-pumpkin' })).data;
  assert.equal(page.outfit, 'outfit-pumpkin');
  assert.equal((await as(t1)('GET', '/api/pet')).data.pet.outfit, 'outfit-pumpkin');
  assert.equal((await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data.pet.outfit, 'outfit-pumpkin');
  // 掷骰的卡片带着皮肤
  const roomId = await soloRoom(t1, { roleKey: 'reporter', name: '林小满' }, '皮肤局');
  await act(roomId, t1, '我在原地等一会儿');
  const log = (await as(t1)('GET', `/api/rooms/${roomId}/log`)).data.entries as { data: { type: string; rolls?: { skin?: string | null }[] } | null }[];
  const turn = log.find((e) => e.data?.type === 'resolution')!;
  assert.equal(turn.data!.rolls![0].skin, 'dice-jade');
  // 换回普通的
  assert.equal((await as(t1)('PUT', '/api/pet/dice', { dice: null })).data.diceSkin, null);
});

test('串门（好友才能）：摸摸头、喂一口；每天第一次两边各得龙晶（V0.7.0 去掉了宠物留言和宠物排行）', async () => {
  // 还不是好友
  assert.equal((await as(t2)('POST', `/api/pets/${publicId(TESTER1.username)}/visit`, { kind: 'pat' })).status, 403);
  assert.equal((await as(t1)('POST', '/api/friends', { username: TESTER2.username })).status, 201);
  assert.equal((await as(t2)('POST', `/api/friends/${publicId(TESTER1.username)}/accept`)).status, 200);
  const c1 = one('SELECT crystals FROM users WHERE id = ?', userId(TESTER1.username)) as number;
  const c2 = one('SELECT crystals FROM users WHERE id = ?', userId(TESTER2.username)) as number;
  let r = await as(t2)('POST', `/api/pets/${publicId(TESTER1.username)}/visit`, { kind: 'pat' });
  assert.deepEqual(r.data, { pet: '团子', rewarded: 3 });
  assert.equal(one('SELECT crystals FROM users WHERE id = ?', userId(TESTER1.username)), c1 + 3);
  assert.equal(one('SELECT crystals FROM users WHERE id = ?', userId(TESTER2.username)), c2 + 3);
  // 今天第二次：不再给
  r = await as(t2)('POST', `/api/pets/${publicId(TESTER1.username)}/visit`, { kind: 'pat' });
  assert.equal(r.data.rewarded, 0);
  // 喂一口：东西从自己的背包里出
  await as(admin)('POST', `/api/admin/users/${userId(TESTER2.username)}/crystals`, { amount: 50, note: '测试' });
  await as(t2)('POST', '/api/shop/buy', { item: 'fish' });
  t.app.db.prepare('UPDATE pets SET satiety = 50, state_at = ? WHERE user_id = ?').run(now, userId(TESTER1.username));
  r = await as(t2)('POST', `/api/pets/${publicId(TESTER1.username)}/visit`, { kind: 'feed', item: 'fish' });
  assert.equal(r.status, 200);
  assert.equal(one("SELECT count FROM pet_items WHERE user_id = ? AND item = 'fish'", userId(TESTER2.username)), 0);
  assert.equal((await as(t1)('GET', '/api/pet')).data.pet.satiety, 70);
  // 主页上的串门信息（V0.7.0 起没有留言）
  const profile = (await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data;
  assert.equal(profile.pet.visit.allowed, true);
  assert.equal(profile.pet.visit.visitedToday, true);
  assert.equal('notes' in profile.pet, false);
  // 留言、宠物排行的接口没有了
  assert.equal((await as(t2)('POST', `/api/pets/${publicId(TESTER1.username)}/notes`, { text: '团子好可爱' })).status, 404);
  assert.equal((await as(t1)('DELETE', '/api/pet-notes/1')).status, 404);
  assert.equal((await as(t1)('GET', '/api/pet/rankings')).status, 404);
});

// ==================== 对局：主持风格、宠物出手的规则 ====================

test('主持风格：房主才能改；改了写进记录；主持 AI 的材料里有这一段；全是默认的不写；主持 AI 的检定工具里没有装备', async () => {
  const roomId = await soloRoom(t2, { roleKey: 'doctor', name: '许大夫' }, '风格局');
  const style = { voice: 'classical', difficulty: 'hard', death: false, language: 'ja' };
  // 不是这一局的人：这一局对他来说不存在
  assert.equal((await as(t3)('PUT', `/api/rooms/${roomId}/style`, style)).status, 404);
  // 一起玩的人也不行（tester1、tester2 上面串门时成了好友，邀请进来）
  assert.equal((await as(t2)('POST', `/api/rooms/${roomId}/invites`, { user: publicId(TESTER1.username) })).status, 201);
  assert.equal((await as(t1)('POST', `/api/rooms/${roomId}/invites/accept`)).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${roomId}/style`, style)).status, 403);
  assert.equal((await as(t2)('PUT', `/api/rooms/${roomId}/style`, { ...style, voice: 'nope' })).status, 400);
  const game = (await as(t2)('PUT', `/api/rooms/${roomId}/style`, style)).data;
  assert.deepEqual(game.style, style);
  const log = (await as(t2)('GET', `/api/rooms/${roomId}/log`)).data.entries as { kind: string; text: string }[];
  assert.ok(log.some((e) => e.kind === 'system' && e.text.includes('文风古风，难度严酷，角色不会死，用日语主持')));
  fake.requests.length = 0;
  await act(roomId, t2, '我在原地等一会儿');
  const resolve = fake.requests.find((q) => q.tools?.length)!;
  const system = resolve.system!.map((b) => b.text).join('\n');
  assert.match(system, /# 这一局的主持风格/);
  assert.match(system, /古风/);
  assert.match(system, /用日语写叙述/);
  assert.match(system, /角色不会死/);
  const check = resolve.tools!.find((x) => x.name === 'roll_check')!;
  assert.equal('gear' in (check.input_schema as { properties: Record<string, unknown> }).properties, false);
  // 改回默认：材料里没有这一段
  await as(t2)('PUT', `/api/rooms/${roomId}/style`, { voice: 'default', difficulty: 'normal', death: true, language: 'zh' });
  fake.requests.length = 0;
  await act(roomId, t2, '我继续等着');
  const again = fake.requests.find((q) => q.tools?.length)!;
  assert.doesNotMatch(again.system!.map((b) => b.text).join('\n'), /# 这一局的主持风格/);
});
