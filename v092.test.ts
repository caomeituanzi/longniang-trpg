// V0.9.2：一键投稿。剧本编辑器里写好的剧本直接投稿（不用先开一局，整份剧本先检查内容）；
// 对局里投稿不写分区、简介就用剧本自己写的；投稿的情况按标题找（编辑器里投过的，开一局再投算重复；换了剧本的，新剧本照样能投）；
// 自己玩完了的对局也能投。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS } from '../server/db';
import { RELEASE_NOTES } from '../server/release-notes';
import { SOURCE_LABEL } from '../server/safety';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { USAGE_RULES } from '../shared/usage-rules';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4] = TEST_ACCOUNTS;
const now = Date.UTC(2026, 9, 30, 6, 0, 0);

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
const one = (sql: string, ...args: (string | number | null)[]) => Object.values(t.app.db.prepare(sql).get(...args) as Record<string, unknown>)[0];
const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));

/** 一份剧本（测试剧本《雾港旅店》写了简介，没写分区）：换个标题，再改几项。 */
const scenario = (title: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(fog), title, ...extra });

/** 建一局，导入一份剧本（来源是「导入的」，可以投稿）。 */
async function importedRoom(cookie: string, data: Record<string, unknown>) {
  const room = (await as(cookie)('POST', '/api/rooms', { name: `${String(data.title)}的局`, maxPlayers: 4 })).data.room;
  const r = await as(cookie)('POST', `/api/rooms/${room.id}/scenario`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return room.id as number;
}

test('剧本编辑器里直接投稿：游客不能投；剧本有错、没选分区、没写简介的投不了；投上了等管理员审核（不属于哪一局），AI 先看一遍', async () => {
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await as(guest)('POST', '/api/editor/submission', { data: scenario('游客写的', { category: 'puzzle' }) })).status, 403);
  assert.equal((await as(guest)('GET', '/api/submissions')).status, 403);

  let r = await as(t1)('POST', '/api/editor/submission', { data: scenario('有错的', { category: 'puzzle', roles: [] }) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^剧本还有 \d+ 个错误，改好了再投：/);
  r = await as(t1)('POST', '/api/editor/submission', { data: scenario('没选分区的') });
  assert.deepEqual([r.status, r.data.error], [400, '投稿前在「基本信息」里选一个分区']);
  r = await as(t1)('POST', '/api/editor/submission', { data: scenario('没写简介的', { category: 'puzzle', intro: ' ' }) });
  assert.deepEqual([r.status, r.data.error], [400, '投稿前在「基本信息」里写一段简介']);
  assert.equal(one('SELECT COUNT(*) FROM scenario_submissions'), 0);

  r = await as(t1)('POST', '/api/editor/submission', { data: scenario('雾港·编辑器里写的', { category: 'puzzle', author: '剧本里写的作者' }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sub = r.data.submission;
  assert.deepEqual([sub.title, sub.category, sub.intro, sub.status, sub.roomId], ['雾港·编辑器里写的', 'puzzle', fog.intro, 'pending', null]);
  const data = JSON.parse(one('SELECT data FROM scenario_submissions WHERE id = ?', sub.id) as string);
  assert.equal(data.title, '雾港·编辑器里写的');
  assert.equal(data.author, undefined, '作者另外记：通过的时候写投稿的人的名字');
  // 同一个标题不能重复投
  r = await as(t1)('POST', '/api/editor/submission', { data: scenario('雾港·编辑器里写的', { category: 'horror' }) });
  assert.deepEqual([r.status, r.data.error], [409, '《雾港·编辑器里写的》已经投稿了，等管理员审核']);
  // 我的投稿里有它；管理员那边多了一份，AI 先看过一遍
  assert.deepEqual(
    (await as(t1)('GET', '/api/submissions')).data.submissions.map((s: { title: string; status: string }) => [s.title, s.status]),
    [['雾港·编辑器里写的', 'pending']],
  );
  assert.equal((await as(admin)('GET', '/api/me/badges')).data.adminSubmissions, 1);
  await t.app.reviewer.idle();
  const listed = (await as(admin)('GET', '/api/admin/submissions')).data.submissions.find((s: { id: number }) => s.id === sub.id);
  assert.equal(listed.roomId, null);
  assert.equal(listed.aiReview.status, 'done');
  // 通过了：放进剧本大厅，作者是投稿的人
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${sub.id}/approve`)).status, 200);
  const hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios;
  const work = hall.find((s: { title: string }) => s.title === '雾港·编辑器里写的');
  assert.equal(work.authorUser.self, true);
  assert.equal(work.category, 'puzzle');
  r = await as(t1)('POST', '/api/editor/submission', { data: scenario('雾港·编辑器里写的', { category: 'puzzle' }) });
  assert.deepEqual([r.status, r.data.error], [409, '《雾港·编辑器里写的》已经通过审核，放进剧本大厅了']);
});

test('编辑器里投的整份剧本发出去之前检查内容：违规的第一次警告，记成「投稿的剧本」，没投上', async () => {
  const t4 = await t.login(TESTER4.username, TESTER4.password);
  const r = await as(t4)('POST', '/api/editor/submission', { data: scenario('雾港', { category: 'puzzle', intro: '海边的旅店里，测试违规。' }) });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /这是警告/);
  const v = t.app.db.prepare("SELECT source, room_id FROM violations WHERE user_id = (SELECT id FROM users WHERE username = ?)").get(TESTER4.username) as { source: string; room_id: number | null };
  assert.deepEqual({ ...v }, { source: 'draft', room_id: null });
  assert.equal(SOURCE_LABEL.draft, '投稿的剧本');
  assert.equal(one("SELECT COUNT(*) FROM scenario_submissions WHERE title = '雾港'"), 0);
  // 使用规则里写着投稿的剧本也会检查
  assert.ok(USAGE_RULES.some((rule) => rule.text.includes('投稿的剧本和简介')));
});

test('对局里一键投稿：不写分区、简介就用剧本自己写的（剧本里没写的还是要填）；自己玩完了、结束了的对局也能投', async () => {
  const t2 = await t.login(TESTER2.username, TESTER2.password);
  // 剧本没写分区：要选
  const noCategory = await importedRoom(t2, scenario('没写分区的雾港'));
  let r = await as(t2)('POST', `/api/rooms/${noCategory}/submission`, {});
  assert.deepEqual([r.status, r.data.error], [400, '请选一个分区']);
  // 只给了分区：简介用剧本的
  r = await as(t2)('POST', `/api/rooms/${noCategory}/submission`, { category: 'adventure' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.submission.category, r.data.submission.intro], ['adventure', fog.intro]);
  // 剧本没写简介：要写
  const noIntro = await importedRoom(t2, scenario('没写简介的雾港', { category: 'puzzle', intro: '' }));
  r = await as(t2)('POST', `/api/rooms/${noIntro}/submission`, {});
  assert.deepEqual([r.status, r.data.error], [400, '简介要在1～300个字之间']);
  // 写全了的：自己玩一遍，结束以后一键投稿
  const played = await importedRoom(t2, scenario('玩过一遍的雾港', { category: 'horror' }));
  assert.equal((await as(t2)('PUT', `/api/rooms/${played}/character`, { roleKey: 'doctor', name: '许医生' })).status, 200);
  assert.equal((await as(t2)('POST', `/api/rooms/${played}/status`, { status: 'running' })).status, 200);
  assert.equal((await as(t2)('POST', `/api/rooms/${played}/status`, { status: 'ended' })).status, 200);
  assert.deepEqual((await as(t2)('GET', `/api/rooms/${played}/submission`)).data.submission, { canSubmit: true, latest: null });
  r = await as(t2)('POST', `/api/rooms/${played}/submission`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.submission.category, r.data.submission.intro, r.data.submission.roomId], ['horror', fog.intro, played]);
  assert.equal(r.data.state.latest.id, r.data.submission.id);
  // 写了的照样按写的投（以前的投法）
  assert.equal((await as(t2)('POST', `/api/rooms/${played}/submission`, {})).data.error, '这一局的剧本已经投稿了，等管理员审核');
});

test('投稿的情况按标题找：编辑器里投过的，开一局再投算重复；换了剧本的，新剧本照样能投；退回了的能再投', async () => {
  const t3 = await t.login(TESTER3.username, TESTER3.password);
  let r = await as(t3)('POST', '/api/editor/submission', { data: scenario('雾港·两边投', { category: 'puzzle' }) });
  assert.equal(r.status, 201);
  const fromEditor = r.data.submission.id as number;
  // 用同一个剧本开了一局：看得到编辑器里投的那一份，不能再投
  const room = await importedRoom(t3, scenario('雾港·两边投', { category: 'puzzle' }));
  let state = (await as(t3)('GET', `/api/rooms/${room}/submission`)).data.submission;
  assert.deepEqual([state.latest.id, state.latest.roomId, state.latest.status], [fromEditor, null, 'pending']);
  r = await as(t3)('POST', `/api/rooms/${room}/submission`, {});
  assert.deepEqual([r.status, r.data.error], [409, '《雾港·两边投》已经投稿了，等管理员审核']);
  // 这一局换了一个剧本：看的是新剧本的，照样能投
  assert.equal((await as(t3)('POST', `/api/rooms/${room}/scenario`, { data: scenario('雾港·换过的', { category: 'social' }) })).status, 200);
  assert.equal((await as(t3)('GET', `/api/rooms/${room}/submission`)).data.submission.latest, null);
  r = await as(t3)('POST', `/api/rooms/${room}/submission`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.category, 'social');
  // 再换回来：又看到编辑器里那一份
  assert.equal((await as(t3)('POST', `/api/rooms/${room}/scenario`, { data: scenario('雾港·两边投', { category: 'puzzle' }) })).status, 200);
  state = (await as(t3)('GET', `/api/rooms/${room}/submission`)).data.submission;
  assert.equal(state.latest.id, fromEditor);
  // 管理员退回编辑器里那一份：在这一局里能再投
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${fromEditor}/reject`, { reason: '结局写得太仓促' })).status, 200);
  state = (await as(t3)('GET', `/api/rooms/${room}/submission`)).data.submission;
  assert.deepEqual([state.latest.status, state.latest.reason], ['rejected', '结局写得太仓促']);
  r = await as(t3)('POST', `/api/rooms/${room}/submission`, { category: 'puzzle', intro: '改过的简介：雾里的旅店。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // 别人投同一个标题不受影响
  const t1 = await t.login(TESTER1.username, TESTER1.password);
  assert.equal((await as(t1)('POST', '/api/editor/submission', { data: scenario('雾港·两边投', { category: 'puzzle' }) })).status, 201);
  // 我的投稿：新的在前
  assert.deepEqual(
    (await as(t3)('GET', '/api/submissions')).data.submissions.map((s: { title: string; status: string }) => [s.title, s.status]),
    [
      ['雾港·两边投', 'pending'],
      ['雾港·换过的', 'pending'],
      ['雾港·两边投', 'rejected'],
    ],
  );
});

test('V0.9.2 没有升级数据库（还是第 22 版）；V0.9.2 的更新公告', () => {
  assert.ok(MIGRATIONS.length >= 22);
  assert.match(MIGRATIONS[21], /ALTER TABLE ai_calls ADD COLUMN tools TEXT/);
  const note = RELEASE_NOTES.find((n) => n.version === '0.9.2')!;
  assert.ok(note && [...note.title].length <= 40 && [...note.body].length <= 2000);
  for (const word of [/剧本编辑器/, /开团准备/, /结束/, /分区和简介/]) assert.match(note.body, word);
  assert.doesNotMatch(note.body, /DeepSeek|Claude|管理页/);
});
