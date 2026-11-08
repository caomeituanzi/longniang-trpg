import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { CATEGORY_ATTRIBUTE, SITE_AUTHOR } from '../shared/game';
import { startTestApp, sleep } from './helpers';

// V0.5.0：剧本分区、剧本大厅（用这个剧本开局、新建对局只在剧本大厅）、投稿和审核、关注作者；大厅聊天的发言间隔和撤回。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
let now = Date.UTC(2026, 9, 28, 3, 0, 0);

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
const scenarioDir = () => t.app.engine.scenarioFolder;

/** 建一局，导入一份剧本（来源是「导入的」，可以投稿）。 */
async function importedRoom(cookie: string, title: string) {
  const room = (await as(cookie)('POST', '/api/rooms', { name: `${title}的局`, maxPlayers: 4 })).data.room;
  const data = { ...structuredClone(fog), title };
  const r = await as(cookie)('POST', `/api/rooms/${room.id}/scenario`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return room.id as number;
}

test('第 15 版的数据库；自带的剧本都标了分区、写了简介，作者是龙娘跑团', () => {
  assert.match(MIGRATIONS[14], /CREATE TABLE scenario_submissions/);
  assert.match(MIGRATIONS[14], /CREATE TABLE pets/);
  const cats: Record<string, string> = {};
  const perCategory: Record<string, number> = {};
  for (const f of fs.readdirSync(path.resolve(import.meta.dirname, '..', 'scenarios'))) {
    const s = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', f), 'utf8'));
    cats[s.title] = s.category;
    perCategory[s.category] = (perCategory[s.category] ?? 0) + 1;
    assert.equal(s.author, SITE_AUTHOR);
    assert.ok(s.intro.length >= 40, `${f} 有简介`);
  }
  assert.deepEqual([cats['青溪灯夜'], cats['垭口的第五个人'], cats['盟主令']], ['puzzle', 'horror', 'social']);
  // V0.7.0：五个分区各两个，再加五个地下城；V0.9.0 冒险分区多了一个 5E 入门模组
  assert.deepEqual(perCategory, { puzzle: 2, horror: 2, combat: 2, adventure: 3, social: 2, dungeon: 5 });
  assert.equal(CATEGORY_ATTRIBUTE.puzzle, 'intellect');
  assert.equal(CATEGORY_ATTRIBUTE.combat, 'body');
});

test('剧本大厅：列出能用的剧本，带分区、简介、作者；游客也能看；下架的不列', async () => {
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  const hall = (await as(t1)('GET', '/api/scenario-hall')).data;
  const qingxi = hall.scenarios.find((s: { key: string }) => s.key === 'qingxi-lantern-night');
  assert.equal(qingxi.category, 'puzzle');
  assert.equal(qingxi.author, SITE_AUTHOR);
  assert.equal(qingxi.authorUser, null);
  assert.ok(qingxi.intro.includes('青溪镇'));
  assert.equal(qingxi.plays, 0);
  assert.deepEqual(hall.submissions, []);
  // 游客
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await as(guest)('GET', '/api/scenario-hall')).status, 200);
  // 下架
  assert.equal((await as(admin)('PUT', '/api/admin/scenarios/yakou-fifth-man/hidden', { hidden: true })).status, 200);
  let keys = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios.map((s: { key: string }) => s.key);
  assert.ok(!keys.includes('yakou-fifth-man'));
  assert.equal((await as(admin)('PUT', '/api/admin/scenarios/yakou-fifth-man/hidden', { hidden: false })).status, 200);
  keys = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios.map((s: { key: string }) => s.key);
  assert.ok(keys.includes('yakou-fifth-man'));
});

test('用这个剧本开局：建好就选上剧本；人数上限不能超过剧本的；下架的、没有的开不了', async () => {
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  let r = await as(t1)('POST', '/api/rooms', { name: '灯会', maxPlayers: 3, scenarioKey: 'qingxi-lantern-night' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '《青溪灯夜》最多2个人玩，人数上限不能超过2');
  r = await as(t1)('POST', '/api/rooms', { name: '灯会', maxPlayers: 2, scenarioKey: 'qingxi-lantern-night' });
  assert.equal(r.status, 201);
  const game = (await as(t1)('GET', `/api/rooms/${r.data.room.id}/game`)).data;
  assert.equal(game.scenario.title, '青溪灯夜');
  assert.equal(game.scenario.source, 'builtin');
  assert.equal(game.scenario.category, 'puzzle');
  const hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios;
  assert.equal(hall.find((s: { key: string }) => s.key === 'qingxi-lantern-night').plays, 1);
  assert.equal((await as(t1)('POST', '/api/rooms', { name: 'x', maxPlayers: 2, scenarioKey: 'no-such-thing' })).status, 404);
  await as(admin)('PUT', '/api/admin/scenarios/mengzhu-ling/hidden', { hidden: true });
  assert.equal((await as(t1)('POST', '/api/rooms', { name: 'x', maxPlayers: 2, scenarioKey: 'mengzhu-ling' })).status, 409);
  await as(admin)('PUT', '/api/admin/scenarios/mengzhu-ling/hidden', { hidden: false });
  // 不带剧本照样能新建
  assert.equal((await as(t1)('POST', '/api/rooms', { name: '空的', maxPlayers: 4 })).status, 201);
});

test('AI 生成、导入文本剧本时选分区：生成的剧本带着分区和简介', async () => {
  const t2 = await t.login(TESTER2.username, TESTER2.password);
  const room = (await as(t2)('POST', '/api/rooms', { name: '生成恐怖剧本', maxPlayers: 2 })).data.room;
  let r = await as(t2)('POST', `/api/rooms/${room.id}/scenario/generate`, { category: 'nope', genre: '恐怖', players: 2, days: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '分区不对');
  r = await as(t2)('POST', `/api/rooms/${room.id}/scenario/generate`, { category: 'horror', genre: '民国恐怖', players: 2, days: 2 });
  assert.equal(r.status, 202);
  for (let i = 0; i < 200; i++) {
    const job = (await as(t2)('GET', `/api/rooms/${room.id}/scenario/job`)).data.job;
    if (job.status !== 'running') break;
    await sleep(20);
  }
  const game = (await as(t2)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.scenario.source, 'generated');
  assert.equal(game.scenario.category, 'horror');
  assert.ok(game.scenario.intro.length > 10);
  // 没传分区的（老网页）按解谜
  const old = (await as(t2)('POST', '/api/rooms', { name: '老网页', maxPlayers: 2 })).data.room;
  assert.equal((await as(t2)('POST', `/api/rooms/${old.id}/scenario/generate`, { genre: '武侠', players: 2, days: 1 })).status, 202);
  for (let i = 0; i < 200; i++) {
    const job = (await as(t2)('GET', `/api/rooms/${old.id}/scenario/job`)).data.job;
    if (job.status !== 'running') break;
    await sleep(20);
  }
  assert.equal((await as(t2)('GET', `/api/rooms/${old.id}/game`)).data.scenario.category, 'puzzle');
});

test('投稿：只有房主、只有 AI 生成或导入的剧本；简介也检查内容；等审核的不能重复投', async () => {
  const t3 = await t.login(TESTER3.username, TESTER3.password);
  const t4 = await t.login(TESTER4.username, TESTER4.password);
  const roomId = await importedRoom(t3, '海雾');
  // 别人不能投（还不是成员也不行）
  assert.equal((await as(t4)('POST', `/api/rooms/${roomId}/submission`, { category: 'puzzle', intro: '一段简介' })).status, 403);
  assert.equal((await as(t4)('GET', `/api/rooms/${roomId}/submission`)).data.submission, null);
  // 房主：分区、简介要填对
  assert.equal((await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'x', intro: '一段简介' })).status, 400);
  assert.equal((await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'puzzle', intro: ' ' })).status, 400);
  // 简介违规：第一次警告
  let r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'puzzle', intro: '测试违规' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /这是警告/);
  assert.equal((t.app.db.prepare("SELECT source FROM violations WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId(TESTER3.username)) as { source: string }).source, 'submission');
  t.app.db.prepare('UPDATE violations SET dismissed = 1 WHERE user_id = ?').run(userId(TESTER3.username));
  // 投成功
  r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '海边小镇起了大雾，旅店里出了事。' });
  assert.equal(r.status, 201);
  assert.equal(r.data.submission.status, 'pending');
  assert.equal(r.data.state.latest.id, r.data.submission.id);
  assert.equal((await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '再投一次' })).data.error, '这一局的剧本已经投稿了，等管理员审核');
  // 管理员的数字
  assert.equal((await as(admin)('GET', '/api/me/badges')).data.adminSubmissions, 1);
  // 剧本大厅里自己能看到进度
  const mine = (await as(t3)('GET', '/api/scenario-hall')).data.submissions;
  assert.deepEqual(mine.map((s: { title: string; status: string; category: string }) => [s.title, s.status, s.category]), [['海雾', 'pending', 'adventure']]);
  // 剧本大厅里的剧本不用投
  const builtin = (await as(t3)('POST', '/api/rooms', { name: '现成的', maxPlayers: 2, scenarioKey: 'qingxi-lantern-night' })).data.room;
  assert.equal((await as(t3)('GET', `/api/rooms/${builtin.id}/submission`)).data.submission.canSubmit, false);
  assert.equal((await as(t3)('POST', `/api/rooms/${builtin.id}/submission`, { category: 'puzzle', intro: '简介' })).status, 409);
});

test('审核：不通过要写原因、通知投稿的人；撤回；通过的放进剧本大厅（排在前面，写着作者），关注作者的人收到新作品通知', async () => {
  const t3 = await t.login(TESTER3.username, TESTER3.password);
  const t4 = await t.login(TESTER4.username, TESTER4.password);
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  // tester4、tester1 关注 tester3
  assert.equal((await as(t4)('POST', `/api/users/${publicId(TESTER3.username)}/follow`)).data.followers, 1);
  assert.equal((await as(t1)('POST', `/api/users/${publicId(TESTER3.username)}/follow`)).data.followers, 2);
  assert.equal((await as(t3)('POST', `/api/users/${publicId(TESTER3.username)}/follow`)).data.error, '不能关注自己');
  // tester1 取消关注
  assert.equal((await as(t1)('DELETE', `/api/users/${publicId(TESTER3.username)}/follow`)).data.followers, 1);

  let list = (await as(admin)('GET', '/api/admin/submissions')).data.submissions;
  const first = list.find((s: { title: string }) => s.title === '海雾');
  assert.equal(first.author.displayName, '测试玩家三');
  // 看全文（包括真相）
  const full = (await as(admin)('GET', `/api/admin/submissions/${first.id}`)).data;
  assert.equal(full.scenario.title, '海雾');
  assert.equal(full.scenario.category, 'adventure');
  assert.ok(full.scenario.truth.summary);
  // 不通过：要写原因
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${first.id}/reject`, { reason: '' })).status, 400);
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${first.id}/reject`, { reason: '真相和线索对不上' })).status, 200);
  let notes = (await as(t3)('GET', '/api/notifications')).data.items;
  assert.deepEqual(
    { kind: notes[0].kind, approved: notes[0].data.approved, reason: notes[0].data.reason },
    { kind: 'submission_result', approved: false, reason: '真相和线索对不上' },
  );
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${first.id}/approve`)).data.error, '这份投稿已经审核过了');
  // 没通过的可以再投；撤回
  const roomId = first.roomId as number;
  let r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '改过的简介：海边小镇起了大雾。' });
  assert.equal(r.status, 201);
  assert.equal((await as(t4)('DELETE', `/api/submissions/${r.data.submission.id}`)).status, 404);
  assert.equal((await as(t3)('DELETE', `/api/submissions/${r.data.submission.id}`)).data.submission.status, 'withdrawn');
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${r.data.submission.id}/approve`)).data.error, '投稿的人已经撤回了');
  // 再投，通过
  r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '海边小镇起了大雾，旅店里出了事，你们得在雾散之前查清楚。' });
  const id = r.data.submission.id as number;
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${id}/approve`)).status, 200);
  const key = `sub-${id}`;
  assert.ok(fs.existsSync(path.join(scenarioDir(), `${key}.json`)), '存成了剧本文件');
  const file = JSON.parse(fs.readFileSync(path.join(scenarioDir(), `${key}.json`), 'utf8'));
  assert.deepEqual([file.title, file.category, file.author], ['海雾', 'adventure', '测试玩家三']);
  // 剧本大厅：排在最前面，写着作者，关注的人看得到「已关注」
  const hall4 = (await as(t4)('GET', '/api/scenario-hall')).data.scenarios;
  assert.equal(hall4[0].key, key);
  assert.deepEqual(
    { name: hall4[0].authorUser.displayName, following: hall4[0].authorUser.following, self: hall4[0].authorUser.self, at: hall4[0].publishedAt },
    { name: '测试玩家三', following: true, self: false, at: now },
  );
  assert.equal((await as(t3)('GET', '/api/scenario-hall')).data.scenarios[0].authorUser.self, true);
  // 通知：作者知道通过了（V0.6.0 还达成了成就「执笔人」），关注的人知道有新作品，取消关注的人没有
  notes = (await as(t3)('GET', '/api/notifications')).data.items;
  assert.deepEqual({ kind: notes[0].kind, title: notes[0].data.title }, { kind: 'achievement', title: '执笔人' });
  assert.deepEqual({ kind: notes[1].kind, approved: notes[1].data.approved, key: notes[1].data.key }, { kind: 'submission_result', approved: true, key });
  const n4 = (await as(t4)('GET', '/api/notifications')).data.items;
  assert.deepEqual({ kind: n4[0].kind, title: n4[0].data.title, from: n4[0].data.from.displayName }, { kind: 'new_work', title: '海雾', from: '测试玩家三' });
  assert.ok(!(await as(t1)('GET', '/api/notifications')).data.items.some((n: { kind: string }) => n.kind === 'new_work'));
  assert.equal((await as(admin)('GET', '/api/me/badges')).data.adminSubmissions, 0);
  // 主页：作品、关注的人数、我关注了没有
  const profile = (await as(t4)('GET', `/api/users/${publicId(TESTER3.username)}`)).data;
  assert.deepEqual(profile.works.map((w: { key: string }) => w.key), [key]);
  assert.equal(profile.followers, 1);
  assert.equal(profile.following, true);
  // 别人用它开局
  const room = (await as(t4)('POST', '/api/rooms', { name: '用海雾开局', maxPlayers: 4, scenarioKey: key })).data.room;
  assert.equal((await as(t4)('GET', `/api/rooms/${room.id}/game`)).data.scenario.title, '海雾');
  assert.equal((await as(t4)('GET', '/api/scenario-hall')).data.scenarios[0].plays, 1);
  // 这一局的剧本已经通过了，不能再投
  assert.equal((await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '又一次' })).data.error, '这一局的剧本已经通过审核了');
  // 管理员删掉这个剧本：剧本大厅、主页里都没有了
  assert.equal((await as(admin)('DELETE', `/api/admin/scenarios/${key}`)).status, 200);
  assert.ok(!(await as(t4)('GET', '/api/scenario-hall')).data.scenarios.some((s: { key: string }) => s.key === key));
  assert.deepEqual((await as(t4)('GET', `/api/users/${publicId(TESTER3.username)}`)).data.works, []);
});

test('同时等审核的投稿最多 3 份；账号删掉以后，还没审的投稿撤回、关注都清掉', async () => {
  const t2 = await t.login(TESTER2.username, TESTER2.password);
  const ids: number[] = [];
  for (const title of ['一', '二', '三']) {
    const roomId = await importedRoom(t2, `第${title}份`);
    const r = await as(t2)('POST', `/api/rooms/${roomId}/submission`, { category: 'social', intro: `第${title}份的简介` });
    assert.equal(r.status, 201);
    ids.push(r.data.submission.id);
  }
  const fourth = await importedRoom(t2, '第四份');
  const r = await as(t2)('POST', `/api/rooms/${fourth}/submission`, { category: 'social', intro: '第四份的简介' });
  assert.equal(r.status, 429);
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  await as(t1)('POST', `/api/users/${publicId(TESTER2.username)}/follow`);
  const id2 = userId(TESTER2.username);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE author_id = ?').get(id2) as { n: number }).n, 1);
  assert.equal((await as(admin)('DELETE', `/api/admin/users/${id2}`)).status, 200);
  const statuses = t.app.db.prepare(`SELECT status FROM scenario_submissions WHERE id IN (${ids.join(',')})`).all() as { status: string }[];
  assert.deepEqual(statuses.map((s) => s.status), ['withdrawn', 'withdrawn', 'withdrawn']);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE author_id = ? OR follower_id = ?').get(id2, id2) as { n: number }).n, 0);
  assert.equal((await as(admin)('GET', '/api/me/badges')).data.adminSubmissions, 0);
});

test('大厅聊天防刷屏：每人每 5 秒一句、不能连着发一样的话；管理员不受限、能改间隔', async () => {
  // 测试工具默认把间隔关掉了：回到默认的 5 秒
  t.app.db.prepare("DELETE FROM settings WHERE key = 'lobby_slow_seconds'").run();
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  assert.equal((await as(t1)('GET', '/api/lobby/chat')).data.slowSeconds, 5);
  assert.equal((await as(admin)('GET', '/api/lobby/chat')).data.slowSeconds, 0, '管理员不受限');
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第一句' })).status, 201);
  let r = await as(t1)('POST', '/api/lobby/chat', { text: '第二句' });
  assert.deepEqual([r.status, r.data.error], [429, '发得太快了，5 秒后再发']);
  now += 3000;
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第二句' })).data.error, '发得太快了，2 秒后再发');
  now += 2000;
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第二句' })).status, 201);
  now += 5000;
  r = await as(t1)('POST', '/api/lobby/chat', { text: '第二句' });
  assert.deepEqual([r.status, r.data.error], [409, '和你上一句一样，不用再发一遍']);
  now += 10 * 60_000;
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第二句' })).status, 201, '隔了十分钟可以再说一样的');
  // 管理员连着发不受限
  for (const text of ['管理员一', '管理员二', '管理员二']) assert.equal((await as(admin)('POST', '/api/lobby/chat', { text })).status, 201);

  // 改间隔：要有「举报和大厅聊天」权限；0～600 秒；记操作记录
  assert.equal((await as(t1)('PUT', '/api/admin/lobby', { slowSeconds: 0 })).status, 403);
  assert.equal((await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 601 })).status, 400);
  assert.equal((await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 1.5 })).status, 400);
  assert.equal((await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 30 })).data.slowSeconds, 30);
  assert.equal((await as(admin)('GET', '/api/admin/lobby')).data.slowSeconds, 30);
  const audit = t.app.db.prepare("SELECT detail FROM admin_audit WHERE action = '改大厅发言间隔' ORDER BY id DESC LIMIT 1").get() as { detail: string };
  assert.equal(audit.detail, '5 秒 → 30 秒');
  now += 5000;
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第三句' })).data.error, '发得太快了，25 秒后再发');
  // 0 是不限：连着发、发一样的都行
  await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 0 });
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第三句' })).status, 201);
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '第三句' })).status, 201);
  await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 5 });
});

test('大厅聊天撤回：自己的随时能撤回；管理员撤回别人的（站长的只有站长能撤回）、一下撤回一个人最近一小时的；撤回的不能再举报', async () => {
  await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 0 });
  const t3 = await t.login(TESTER3.username, TESTER3.password);
  const t4 = await t.login(TESTER4.username, TESTER4.password);
  const lobby = await t.openStream('/api/events', t3);
  const list = async (cookie: string) => (await as(cookie)('GET', '/api/lobby/chat')).data.messages as { id: number; deleted: boolean; byAdmin: boolean; text: string }[];

  // 自己撤回
  const mine = (await as(t3)('POST', '/api/lobby/chat', { text: '说错了' })).data.message;
  assert.equal((await as(t4)('DELETE', `/api/lobby/chat/${mine.id}`)).data.error, '只能撤回自己的消息');
  assert.equal((await as(t3)('DELETE', `/api/lobby/chat/${mine.id}`)).status, 200);
  let seen = (await list(t4)).find((m) => m.id === mine.id)!;
  assert.deepEqual([seen.deleted, seen.byAdmin, seen.text], [true, false, '']);
  const e1 = await lobby.waitFor((e) => e.event === 'lobby-chat-deleted' && e.data.ids?.includes(mine.id));
  assert.equal(e1.data.byAdmin, false);

  // 管理员撤回别人的
  const theirs = (await as(t4)('POST', '/api/lobby/chat', { text: '不该说的话' })).data.message;
  assert.equal((await as(admin)('DELETE', `/api/lobby/chat/${theirs.id}`)).status, 200);
  seen = (await list(t3)).find((m) => m.id === theirs.id)!;
  assert.deepEqual([seen.deleted, seen.byAdmin], [true, true]);
  assert.equal((await lobby.waitFor((e) => e.event === 'lobby-chat-deleted' && e.data.ids?.includes(theirs.id))).data.byAdmin, true);
  // 管理员撤回的不能再举报；自己撤回的照样能举报，管理员在举报里看得到原文
  const report = await as(t3)('POST', '/api/reports', { kind: 'report', body: '刷屏', target: { type: 'lobby', id: theirs.id } });
  assert.deepEqual([report.status, report.data.error], [409, '这条消息已经被管理员撤回了']);
  const said = (await as(t4)('POST', '/api/lobby/chat', { text: '难听的话' })).data.message;
  await as(t4)('DELETE', `/api/lobby/chat/${said.id}`);
  assert.equal((await as(t3)('POST', '/api/reports', { kind: 'report', body: '骂人以后撤回了', target: { type: 'lobby', id: said.id } })).status, 201);
  const reports = (await as(admin)('GET', '/api/admin/reports')).data.reports as { target: { id: number; text: string } | null }[];
  assert.equal(reports.find((x) => x.target?.id === said.id)?.target?.text, '难听的话');

  // 撤回一个人最近一小时的：一小时以前的不动
  const old = (await as(t4)('POST', '/api/lobby/chat', { text: '两小时前说的' })).data.message;
  now += 2 * 60 * 60_000;
  const spam: number[] = [];
  for (let i = 0; i < 3; i++) {
    spam.push((await as(t4)('POST', '/api/lobby/chat', { text: `刷屏${i}` })).data.message.id);
    now += 1000;
  }
  assert.equal((await as(t3)('POST', '/api/lobby/chat/recall-recent', { user: publicId(TESTER4.username) })).status, 403);
  const r = await as(admin)('POST', '/api/lobby/chat/recall-recent', { user: publicId(TESTER4.username) });
  assert.equal(r.data.recalled, 3);
  const after = await list(t3);
  assert.ok(spam.every((id) => after.find((m) => m.id === id)?.deleted && after.find((m) => m.id === id)?.byAdmin));
  assert.equal(after.find((m) => m.id === old.id)?.deleted, false, '一小时以前的不动');
  const batch = await lobby.waitFor((e) => e.event === 'lobby-chat-deleted' && e.data.ids?.length === 3);
  assert.deepEqual(batch.data.ids, spam);
  assert.ok(
    (t.app.db.prepare("SELECT detail FROM admin_audit WHERE action = '撤回大厅聊天' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail.endsWith('最近一小时的 3 条'),
  );
  assert.equal((await as(admin)('POST', '/api/lobby/chat/recall-recent', { user: 'nobody' })).status, 404);

  // 只有「举报和大厅聊天」权限的管理员：能撤回别人的，撤回不了站长的
  const id5 = userId(TESTER5.username);
  assert.equal((await as(admin)('PUT', `/api/admin/users/${id5}/role`, { role: 'admin', permissions: ['reports'] })).status, 200);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  const ownerSays = (await as(admin)('POST', '/api/lobby/chat', { text: '站长说话' })).data.message;
  assert.equal((await as(t5)('DELETE', `/api/lobby/chat/${ownerSays.id}`)).data.error, '站长的消息只有站长自己能撤回');
  assert.equal((await as(t5)('POST', '/api/lobby/chat/recall-recent', { user: publicId(ADMIN.username) })).data.error, '站长的消息只有站长自己能撤回');
  assert.equal((await as(t5)('GET', '/api/lobby/chat')).data.slowSeconds, 0, '有这项权限的管理员不受发言间隔限制');
  await as(admin)('PUT', `/api/admin/users/${id5}/role`, { role: 'user' });
  lobby.close();
  await as(admin)('PUT', '/api/admin/lobby', { slowSeconds: 5 });
});

test('HTTPS：经过 Cloudflare 用 https 来的，登录 Cookie 带 Secure、响应带 HSTS；用 http 来的跳到 https；本机 http 的照旧；以点开头的路径 404', async () => {
  const login = (headers: Record<string, string>) =>
    fetch(t.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ username: TESTER3.username, password: TESTER3.password }),
    });
  const sid = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith('trpg_sid='))!;
  // 本机用 http:// 打开：不带 Secure（带了就登录不上），也不发 HSTS
  let r = await login({});
  assert.equal(r.status, 200);
  assert.match(sid(r), /; HttpOnly/);
  assert.match(sid(r), /; SameSite=Lax/);
  assert.doesNotMatch(sid(r), /Secure/);
  assert.equal(r.headers.get('strict-transport-security'), null);
  // 经过 Cloudflare、访问者用 https：带 Secure，发 HSTS；游客、退出登录的 Cookie 也一样
  const viaCloudflare = { 'X-Forwarded-Proto': 'https', 'CF-Visitor': '{"scheme":"https"}', 'CF-Connecting-IP': '203.0.113.9' };
  r = await login(viaCloudflare);
  assert.equal(r.status, 200);
  assert.match(sid(r), /^trpg_sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=15552000');
  const cookie = sid(r).split(';')[0];
  const out = await fetch(t.base + '/api/auth/logout', { method: 'POST', headers: { ...viaCloudflare, cookie } });
  assert.match(sid(out), /Max-Age=0; Secure$/);
  const guest = await fetch(t.base + '/api/auth/guest', { method: 'POST', headers: { 'CF-Visitor': '{"scheme":"https"}' } });
  assert.match(sid(guest), /; Secure$/);
  // 经过 Cloudflare、访问者用 http：跳到 https，网页和接口都一样，不发 HSTS
  for (const p of ['/scenarios?c=puzzle', '/api/auth/me']) {
    const page = await fetch(t.base + p, { headers: { 'CF-Visitor': '{"scheme":"http"}', 'CF-Connecting-IP': '203.0.113.9' }, redirect: 'manual' });
    assert.equal(page.status, 308);
    assert.equal(page.headers.get('location'), `https://${new URL(t.base).host}${p}`);
    assert.equal(page.headers.get('strict-transport-security'), null);
  }
  const posted = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'http', 'CF-Connecting-IP': '203.0.113.9' }, redirect: 'manual' });
  assert.equal(posted.status, 308, '没有 CF-Visitor 时按 X-Forwarded-Proto 认');
  // 以点开头的路径：404，不返回首页
  for (const p of ['/.env', '/.git/HEAD', '/.well-known/security.txt', '/web/.env']) {
    const res = await fetch(t.base + p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /<html/i);
  }
});

test('下架已经通过审核的投稿：删掉审核已过记录，作者可以重新投稿', async () => {
  const t3 = await t.login(TESTER3.username, TESTER3.password);
  const roomId = await importedRoom(t3, '下架重投测试');
  let r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '下架以后还能再投的测试简介。' });
  assert.equal(r.status, 201);
  const id = r.data.submission.id as number;
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${id}/approve`)).status, 200);
  const key = `sub-${id}`;
  const approved = t.app.db.prepare("SELECT status FROM scenario_submissions WHERE id = ?").get(id) as { status: string };
  assert.equal(approved.status, 'approved');

  assert.equal((await as(admin)('PUT', `/api/admin/scenarios/${key}/hidden`, { hidden: true })).status, 200);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM scenario_submissions WHERE id = ?').get(id) as { n: number }).n, 0, '审核已过记录删掉了');
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM scenario_authors WHERE scenario_key = ?').get(key) as { n: number }).n, 0, '作者关联也清掉');

  r = await as(t3)('POST', `/api/rooms/${roomId}/submission`, { category: 'adventure', intro: '下架以后重新投稿的简介。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.status, 'pending');
  await as(t3)('DELETE', `/api/submissions/${r.data.submission.id}`);
});
