import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { adaptRequest, DeepSeekProvider, extractJson, TOOL_ERROR_PREFIX } from '../server/ai/deepseek';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { costOf, deepSeekPeak } from '../server/ai/pricing';
import { textOf, type AiProvider, type MessagesRequest } from '../server/ai/types';
import { verifyPassword } from '../server/auth';
import { listBackups } from '../server/backup';
import { MIGRATIONS, openDatabase, schemaVersion } from '../server/db';
import { resetData } from '../server/reset-data';
import { BUILTIN_SCENARIO_FILES } from '../scripts/builtin-scenarios.mjs';
import { ALL_PERMISSIONS } from '../shared/admin';
import { seedTestData, TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, OPUS_SETTINGS, startTestApp, testScenarioDir } from './helpers';

// V0.3.0：本机测试不限频率、游客退出就删掉、站长删除账号、剧本管理、DeepSeek、内容检查默认 Opus。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 26, 9, 0, 0);
const fake = new FakeProvider(demoHandler);

let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0 });
  for (const a of [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5]) cookies[a.username] = await t.login(a.username, a.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, who: string | null, body?: unknown) => t.call(method, url, body, who ? (cookies[who] ?? who) : undefined);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined)?.id ?? 0;
const game = async (roomId: number, who: string) => (await call('GET', `/api/rooms/${roomId}/game`, who)).data;

async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

async function befriend(a: string, b: string) {
  const r = await call('POST', '/api/friends', a, { username: b });
  if (r.data.relation !== 'friends') assert.equal((await call('POST', `/api/friends/${a}/accept`, b)).status, 200);
}

/** 建一局《雾港旅店》；characters：[谁, 身份, 名字]；members：只加入、不建角色的人；start：要不要开局。 */
async function room(characters: [string, string, string][], opts: { members?: string[]; start?: boolean; name?: string } = {}) {
  const [host] = characters[0];
  const created = await call('POST', '/api/rooms', host, { name: opts.name ?? '测试局', maxPlayers: 6 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.room.id as number;
  for (const who of [...characters.slice(1).map((c) => c[0]), ...(opts.members ?? [])]) {
    assert.equal((await call('POST', '/api/rooms/join', who, { code: created.data.room.joinCode })).status, 200);
  }
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, host, { key: 'fog-harbor-inn' })).status, 200);
  for (const [who, roleKey, name] of characters) assert.equal((await call('PUT', `/api/rooms/${roomId}/character`, who, { roleKey, name })).status, 200);
  if (opts.start !== false) assert.equal((await call('POST', `/api/rooms/${roomId}/status`, host, { status: 'running' })).status, 200);
  return roomId;
}

test('游客点「退出登录」：这个游客账号直接删掉；他提交的反馈留着', async () => {
  const g = await t.call('POST', '/api/auth/guest');
  assert.equal(g.status, 201);
  const id = g.data.user.id as number;
  assert.equal((await t.call('POST', '/api/reports', { kind: 'feedback', body: '游客的意见' }, g.cookie!)).status, 201);
  assert.equal((await t.call('POST', '/api/auth/logout', undefined, g.cookie!)).status, 200);
  assert.equal(t.app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), undefined, '游客账号删掉了');
  const report = t.app.db.prepare("SELECT reporter_id FROM reports WHERE body = '游客的意见'").get() as { reporter_id: number | null };
  assert.equal(report.reporter_id, null, '反馈留着，只是不再记是谁交的');
  // 正式账号退出登录不会删
  const again = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await t.call('POST', '/api/auth/logout', undefined, again)).status, 200);
  assert.ok(userId('tester5'));
});

test('站长删除账号：登录不了、用户名放出来；当房主的对局交给别的成员（没人就删掉）；好友、私信、笔记清掉；对局里的角色还在', async () => {
  // tester2 当房主的两局：一局有 tester3，一局只有他自己；他在 tester1 的局里有角色、有在等的行动
  const handed = await room([['tester2', 'reporter', '许当家']], { members: ['tester3'], start: false, name: '要交出去的局' });
  const alone = await room([['tester2', 'reporter', '许独行']], { start: false, name: '只有他的局' });
  const playing = await room([
    ['tester1', 'reporter', '林一'],
    ['tester2', 'doctor', '许二'],
  ]);
  assert.equal((await call('POST', `/api/rooms/${playing}/act`, 'tester2', { text: '在大堂里四处看看', as: 'action' })).status, 201);
  await befriend('tester2', 'tester4');
  assert.equal((await call('POST', '/api/friends/tester4/messages', 'tester2', { text: '在吗' })).status, 201);
  assert.equal((await call('PUT', `/api/rooms/${playing}/note`, 'tester2', { content: '我的笔记' })).status, 200);
  const before = t.app.db.prepare("SELECT uid FROM users WHERE username = 'tester2'").get() as { uid: number };
  const id = userId('tester2');

  // 只有站长能删正式账号；不能删自己、不能删站长
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['users'] })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/users/${id}`, 'tester3')).status, 403);
  assert.equal((await call('POST', '/api/admin/users/batch', 'tester3', { ids: [id], op: 'delete' })).status, 403);
  assert.equal((await call('DELETE', `/api/admin/users/${userId('admin')}`, 'admin')).status, 400);
  assert.equal((await call('DELETE', `/api/admin/users/${userId('admin')}`, 'tester3')).status, 403);
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'user' });

  const stream = await t.openStream('/api/events', cookies.tester2);
  await stream.waitFor((e) => e.event === 'badges');
  assert.equal((await call('DELETE', `/api/admin/users/${id}`, 'admin')).status, 200);
  await stream.waitEnded();

  // 登录不了；原来的登录失效；账号列表里没有了
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'tester2', password: TESTER2.password })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', 'tester2')).data.user, null);
  assert.ok(!(await call('GET', '/api/admin/users', 'admin')).data.users.some((u: any) => u.id === id));
  const row = t.app.db.prepare('SELECT username, display_name, uid, deleted_at FROM users WHERE id = ?').get(id) as any;
  assert.equal(row.display_name, '已删除的账号');
  assert.match(row.username, /^deleted-[0-9a-f]{12}$/, '用户名换成 deleted- 加随机字符，不带 UID');
  assert.equal(row.uid, null, 'UID 空出来了');
  assert.ok(row.deleted_at);

  // 当房主的对局：交给 tester3；只有他的那一局删掉了
  const detail = (await call('GET', `/api/rooms/${handed}`, 'tester3')).data;
  assert.equal(detail.viewer.role, 'host');
  assert.ok((await call('GET', `/api/rooms/${handed}/log`, 'tester3')).data.entries.some((e: any) => e.text.includes('房主换成了')));
  assert.equal(t.app.db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(alone), undefined);

  // 好友、私信、笔记清掉了
  const friendsOf4 = (await call('GET', '/api/friends', 'tester4')).data;
  assert.ok(!friendsOf4.friends.some((f: any) => f.displayName === '已删除的账号'));
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ? OR addressee_id = ?').get(id, id) as { n: number }).n, 0);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE sender_id = ? OR recipient_id = ?').get(id, id) as { n: number }).n, 0);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE author_user_id = ?').get(id) as { n: number }).n, 0);

  // 在别人的局里：角色还在，在等的行动撤回了，名字写成「已删除的账号」
  const view = await game(playing, 'tester1');
  const doctor = view.others.find((o: any) => o.name === '许二');
  assert.ok(doctor, '角色还在');
  assert.equal(doctor.playerName, '已删除的账号');
  assert.ok(!view.nearby.find((n: any) => n.name === '许二')?.action, '在等的行动撤回了');

  // 用户名放出来了：可以重新注册
  const invite = await call('POST', '/api/admin/invites', 'admin', { note: '重新注册' });
  const reg = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username: 'tester2',
    displayName: '新的二号',
    password: 'new-tester2-pass',
    agreeRules: true,
  });
  assert.equal(reg.status, 201);
  const fresh = t.app.db.prepare("SELECT uid FROM users WHERE username = 'tester2'").get() as { uid: number };
  assert.equal(fresh.uid, before.uid, '新账号用上了空出来的号');
});

test('批量删除：站长勾选几个账号一起删；没有站长身份的管理员只能删游客', async () => {
  const g = (await t.call('POST', '/api/auth/guest')).data.user;
  const invite = await call('POST', '/api/admin/invites', 'admin', { note: '批量删除' });
  const reg = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username: 'batchdel',
    displayName: '要删的',
    password: 'batchdel-pass-1',
    agreeRules: true,
  });
  assert.equal(reg.status, 201);
  const regular = userId('batchdel');
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['users'] })).status, 200);
  const limited = await call('POST', '/api/admin/users/batch', 'tester3', { ids: [g.id, regular], op: 'delete-guests' });
  assert.deepEqual(limited.data.done, [g.id]);
  assert.equal(limited.data.skipped[0].id, regular);
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'user' });
  const owner = await call('POST', '/api/admin/users/batch', 'admin', { ids: [regular, userId('admin')], op: 'delete' });
  assert.deepEqual(owner.data.done, [regular]);
  assert.match(owner.data.skipped[0].reason, /自己/);
  assert.equal((t.app.db.prepare('SELECT display_name FROM users WHERE id = ?').get(regular) as { display_name: string }).display_name, '已删除的账号');
});

test('升级到 V0.3.0：有「管理所有对局」权限的管理员一起拿到「剧本管理」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-mig10-'));
  const file = path.join(dir, 'game.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (9);');
  const add = db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_admin, admin_perms) VALUES (?, ?, 'x', 1, 1, ?)");
  add.run('rooms_admin', 'a', JSON.stringify(['users', 'rooms']));
  add.run('plain_admin', 'b', JSON.stringify(['announce']));
  db.close();
  const upgraded = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
  const perms = (u: string) => JSON.parse((upgraded.prepare('SELECT admin_perms FROM users WHERE username = ?').get(u) as { admin_perms: string }).admin_perms);
  assert.deepEqual(perms('rooms_admin'), ['users', 'rooms', 'scenarios']);
  assert.deepEqual(perms('plain_admin'), ['announce']);
  upgraded.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 剧本管理 ----------

const scenarioFile = (key: string) => path.join(t.app.engine.scenarioFolder, `${key}.json`);
const roomScenarios = async (who: string) => ((await call('GET', '/api/scenarios', who)).data.scenarios as { key: string }[]).map((s) => s.key);
/** 一份能用的剧本：拿《青溪灯夜》改个名字。 */
function storyData(title: string, extra = '') {
  const data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'scenarios', 'qingxi-lantern-night.json'), 'utf8'));
  data.title = title;
  if (extra) data.tone = `${data.tone}${extra}`.slice(0, 60);
  return data;
}
const audits = (action: string) =>
  (t.app.db.prepare('SELECT detail FROM admin_audit WHERE action = ? ORDER BY id').all(action) as { detail: string }[]).map((r) => r.detail);

test('剧本管理：要有「剧本管理」权限；列出自带的三个剧本（测试剧本《雾港旅店》不是自带的）；能看全文', async () => {
  assert.equal((await call('GET', '/api/admin/scenarios', 'tester1')).status, 403);
  // 只有「发公告」权限的管理员看不到
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'admin', permissions: ['announce'] })).status, 200);
  assert.equal((await call('GET', '/api/admin/scenarios', 'tester4')).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'admin', permissions: ['scenarios'] })).status, 200);
  const list = await call('GET', '/api/admin/scenarios', 'tester4');
  assert.equal(list.status, 200);
  const byKey = new Map((list.data.scenarios as { key: string; builtin: boolean; hidden: boolean; summary: { title: string } | null }[]).map((s) => [s.key, s]));
  for (const [key, title] of [
    ['qingxi-lantern-night', '青溪灯夜'],
    ['yakou-fifth-man', '垭口的第五个人'],
    ['mengzhu-ling', '盟主令'],
  ] as const) {
    assert.equal(byKey.get(key)?.builtin, true, key);
    assert.equal(byKey.get(key)?.summary?.title, title);
  }
  assert.equal(byKey.get('fog-harbor-inn')?.builtin, false, '测试剧本不算自带的');

  const full = await call('GET', '/api/admin/scenarios/yakou-fifth-man', 'tester4');
  assert.equal(full.status, 200);
  assert.ok(full.data.scenario.truth.summary.length > 0, '全文里有真相');
  assert.equal((await call('GET', '/api/admin/scenarios/yakou-fifth-man', 'tester1')).status, 403);
  assert.equal((await call('GET', '/api/admin/scenarios/no-such-story', 'tester4')).status, 404);
  assert.equal((await call('GET', '/api/admin/scenarios/..%2F..%2Fpackage', 'tester4')).status, 404, '文件名里不能有路径');
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'user' })).status, 200);
});

test('剧本管理：下架的剧本建对局时选不到、已经选了的照常玩，再上架又能选；自带的不能删除', async () => {
  const roomId = await (async () => {
    const created = await call('POST', '/api/rooms', 'tester1', { name: '下架前选好的局', maxPlayers: 4 });
    const id = created.data.room.id as number;
    assert.equal((await call('POST', `/api/rooms/${id}/scenario`, 'tester1', { key: 'yakou-fifth-man' })).status, 200);
    return id;
  })();
  const hide = await call('PUT', '/api/admin/scenarios/yakou-fifth-man/hidden', 'admin', { hidden: true });
  assert.equal(hide.status, 200);
  assert.equal(hide.data.scenarios.find((s: { key: string }) => s.key === 'yakou-fifth-man').hidden, true);
  assert.ok(!(await roomScenarios('tester5')).includes('yakou-fifth-man'), '列表里没有了');
  const other = await call('POST', '/api/rooms', 'tester5', { name: '下架以后建的局', maxPlayers: 4 });
  const r = await call('POST', `/api/rooms/${other.data.room.id}/scenario`, 'tester5', { key: 'yakou-fifth-man' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /下架/);
  assert.equal((await game(roomId, 'tester1')).scenario.title, '垭口的第五个人', '已经选了的照常用');
  assert.equal((await call('PUT', '/api/admin/scenarios/yakou-fifth-man/hidden', 'admin', { hidden: true })).status, 409);

  const del = await call('DELETE', '/api/admin/scenarios/yakou-fifth-man', 'admin');
  assert.equal(del.status, 409);
  assert.match(del.data.error, /自带的剧本不能删除/);
  assert.ok(fs.existsSync(scenarioFile('yakou-fifth-man')));

  assert.equal((await call('PUT', '/api/admin/scenarios/yakou-fifth-man/hidden', 'admin', { hidden: false })).status, 200);
  assert.ok((await roomScenarios('tester5')).includes('yakou-fifth-man'));
  assert.equal((await call('POST', `/api/rooms/${other.data.room.id}/scenario`, 'tester5', { key: 'yakou-fifth-man' })).status, 200);
  assert.deepEqual(audits('下架剧本'), ['《垭口的第五个人》（yakou-fifth-man）']);
  assert.deepEqual(audits('上架剧本'), ['《垭口的第五个人》（yakou-fifth-man）']);
});

test('剧本管理：上传剧本（检查格式和内容）、同名要确认替换、不能和自带的重名；删除上传的，已经选了它的对局照常玩', async () => {
  // 格式不对、文件名不对、和自带的重名
  const bad = storyData('坏剧本');
  bad.roles = [];
  let r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'bad-story', data: bad });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /剧本有\d+处错误/);
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: '我的 剧本', data: storyData('我的剧本') });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'qingxi-lantern-night', data: storyData('冒名的剧本') });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /自带的剧本重名/);
  // 以前的版本自带的测试剧本用过的名字：升级时不会复制，不能用
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'fog-harbor-inn', data: storyData('雾港旅店新版'), replace: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /以前的版本自带的测试剧本/);
  assert.equal((await call('POST', '/api/admin/scenarios', 'tester1', { key: 'my-story', data: storyData('我的剧本') })).status, 403);
  // 自己放进文件夹、文件名不合规矩的：建对局和管理页都不列
  fs.copyFileSync(scenarioFile('qingxi-lantern-night'), path.join(t.app.engine.scenarioFolder, 'My Story.json'));
  try {
    assert.ok(!(await roomScenarios('tester1')).some((key) => key === 'My Story'));
    assert.ok(!(await call('GET', '/api/admin/scenarios', 'admin')).data.scenarios.some((s: { key: string }) => s.key === 'My Story'));
  } finally {
    fs.rmSync(path.join(t.app.engine.scenarioFolder, 'My Story.json'));
  }

  // 上传成功：列表里有，建对局时能选
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'my-story', data: storyData('我的剧本') });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mine = r.data.scenarios.find((s: { key: string }) => s.key === 'my-story');
  assert.equal(mine.builtin, false);
  assert.equal(mine.summary.title, '我的剧本');
  assert.ok(fs.existsSync(scenarioFile('my-story')));
  assert.ok((await roomScenarios('tester1')).includes('my-story'));

  // 同名：不说替换不行；说了就替换
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'my-story', data: storyData('我的剧本第二版') });
  assert.equal(r.status, 409);
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'my-story', data: storyData('我的剧本第二版'), replace: true });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(scenarioFile('my-story'), 'utf8')).title, '我的剧本第二版');

  // 有人选了它，再删掉：对局里存着一份，照常玩；列表里写着用过几局
  const created = await call('POST', '/api/rooms', 'tester3', { name: '用上传剧本的局', maxPlayers: 2 });
  const roomId = created.data.room.id as number;
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, 'tester3', { key: 'my-story' })).status, 200);
  const listed = (await call('GET', '/api/admin/scenarios', 'admin')).data.scenarios.find((s: { key: string }) => s.key === 'my-story');
  assert.equal(listed.usedBy, 1);
  assert.equal((await call('PUT', '/api/admin/scenarios/my-story/hidden', 'admin', { hidden: true })).status, 200);
  r = await call('DELETE', '/api/admin/scenarios/my-story', 'admin');
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(scenarioFile('my-story')));
  assert.ok(!r.data.scenarios.some((s: { key: string }) => s.key === 'my-story'));
  assert.equal((await game(roomId, 'tester3')).scenario.title, '我的剧本第二版');
  assert.equal(t.app.db.prepare("SELECT value FROM settings WHERE key = 'scenarios_hidden'").get() !== undefined, true);
  assert.ok(!JSON.parse((t.app.db.prepare("SELECT value FROM settings WHERE key = 'scenarios_hidden'").get() as { value: string }).value).includes('my-story'), '下架记录也清掉');
  assert.deepEqual(audits('上传剧本'), ['《我的剧本》（my-story）']);
  assert.deepEqual(audits('替换剧本'), ['《我的剧本第二版》（my-story）']);
  assert.deepEqual(audits('删除剧本'), ['《我的剧本第二版》（my-story）']);
});

test('剧本管理：内容检查的这一会儿里，上传的人的「剧本管理」权限被收回了：不保存', async () => {
  let duringCheck: (() => void) | null = null;
  const inner = new FakeProvider(demoHandler);
  const provider: AiProvider = {
    name: 'fake',
    status: inner.status,
    async send(request, signal, hooks) {
      const response = await inner.send(request, signal, hooks);
      duringCheck?.();
      return response;
    },
  };
  const app = await startTestApp({ ai: provider, tickMs: 0 });
  try {
    const owner = await app.login(ADMIN.username, ADMIN.password);
    const id = (app.app.db.prepare('SELECT id FROM users WHERE username = ?').get(TESTER4.username) as { id: number }).id;
    assert.equal((await app.call('PUT', `/api/admin/users/${id}/role`, { role: 'admin', permissions: ['scenarios'] }, owner)).status, 200);
    const helper = await app.login(TESTER4.username, TESTER4.password);
    duringCheck = () => app.app.db.prepare(`UPDATE users SET admin_perms = '["announce"]' WHERE id = ?`).run(id);
    const r = await app.call('POST', '/api/admin/scenarios', { key: 'slow-story', data: storyData('等检查的时候') }, helper);
    assert.equal(r.status, 403);
    assert.match(r.data.error, /「剧本管理」权限刚刚被收回了/);
    assert.ok(!fs.existsSync(path.join(app.app.engine.scenarioFolder, 'slow-story.json')));
    // 没被收回：照常保存
    duringCheck = null;
    assert.equal((await app.call('POST', '/api/admin/scenarios', { key: 'slow-story', data: storyData('等检查的时候') }, owner)).status, 201);
  } finally {
    await app.close();
  }
});

test('剧本管理：上传的剧本先做内容检查，违规的不收（管理员不封号）；AI 关着时检查不了、不收', async () => {
  let r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'bad-words', data: storyData('有问题的剧本', '测试违规') });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(scenarioFile('bad-words')));
  const v = t.app.db.prepare("SELECT outcome, source FROM violations WHERE user_id = ? ORDER BY id DESC").get(userId('admin')) as { outcome: string; source: string };
  assert.deepEqual({ ...v }, { outcome: 'blocked', source: 'scenario' });
  assert.equal((t.app.db.prepare('SELECT banned_at FROM users WHERE username = ?').get('admin') as { banned_at: number | null }).banned_at, null);

  assert.equal((await call('PUT', '/api/admin/ai', 'admin', { enabled: false })).status, 200);
  r = await call('POST', '/api/admin/scenarios', 'admin', { key: 'while-off', data: storyData('AI 关着时上传') });
  assert.equal(r.status, 503);
  assert.ok(!fs.existsSync(scenarioFile('while-off')));
  assert.equal((await call('PUT', '/api/admin/ai', 'admin', { enabled: true })).status, 200);
  assert.equal((await call('POST', '/api/admin/scenarios', 'admin', { key: 'while-off', data: storyData('AI 关着时上传') })).status, 201);
});

// ---------- DeepSeek ----------

test('DeepSeek 的接口：发到 api.deepseek.com/anthropic，用 DEEPSEEK_API_KEY；结构化输出改成写在提示里，回复里取出 JSON；不发自适应思考', async () => {
  const sent: { url: string; headers: Record<string, string>; body: MessagesRequest }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: 'msg_ds',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [
          { type: 'thinking', thinking: '想一想', signature: '' },
          { type: 'text', text: '好的，结果如下：\n```json\n{"violation": false, "category": "none", "reason": "没问题"}\n```' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const ds = new DeepSeekProvider({ apiKey: 'sk-test-deepseek', fetchImpl });
  assert.equal(ds.name, 'deepseek');
  assert.equal(ds.status.ready, true);
  const schema = { type: 'object', properties: { violation: { type: 'boolean' } }, required: ['violation'] };
  const response = await ds.send({
    model: 'deepseek-flash',
    max_tokens: 1000,
    system: [{ type: 'text', text: '你是审核员', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '待检查的内容' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    metadata: { user_id: 'abc' },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(sent[0].headers['x-api-key'], 'sk-test-deepseek');
  assert.equal(sent[0].headers['anthropic-workspace-id'], undefined);
  const body = sent[0].body;
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.thinking, undefined, '自适应思考不发（DeepSeek 默认会思考）');
  assert.deepEqual(body.output_config, { effort: 'medium' }, '只留思考强度');
  assert.deepEqual(body.metadata, { user_id: 'abc' });
  const last = body.messages[body.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(String(last.content), /^待检查的内容\n\n# 输出格式\n只输出一个 JSON 对象/);
  assert.ok(String(last.content).includes(JSON.stringify(schema)));
  assert.deepEqual(JSON.parse(textOf(response)), { violation: false, category: 'none', reason: '没问题' }, '代码块和前后的话去掉了');
  assert.equal(response.content[0].type, 'thinking', '思考的内容留着');

  // 不要求 JSON 的请求：回复原样
  const plain = await ds.send({ model: 'deepseek-v4-pro', max_tokens: 100, messages: [{ role: 'user', content: '讲个故事' }] });
  assert.match(textOf(plain), /好的，结果如下/);
  assert.equal(sent[1].body.output_config, undefined);

  // 没设置密钥：用不了，说清楚是哪一项；密钥不对：说清楚去哪儿改
  const none = new DeepSeekProvider({ apiKey: undefined });
  assert.equal(none.status.ready, false);
  assert.match(none.status.message!, /DEEPSEEK_API_KEY/);
  const bad = new DeepSeekProvider({
    apiKey: 'sk-wrong',
    fetchImpl: (async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }), { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    bad.send({ model: 'deepseek-flash', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    /DeepSeek 的 API 密钥不对，请检查 \.env 文件里的 DEEPSEEK_API_KEY/,
  );

  // 取 JSON：整段是 JSON、代码块里的、前后有话的；前面的话里有括号、字符串里有括号也不乱；被截断的取不出来
  assert.equal(extractJson('  {"a": 1}\n'), '{"a": 1}');
  assert.equal(extractJson('前面的话 {"a": {"b": 1}} 后面的话'), '{"a": {"b": 1}}');
  assert.equal(extractJson('按 {要求} 输出：\n```json\n{"a": "x}"}\n```\n以上'), '{"a": "x}"}');
  assert.equal(extractJson('按 {要求} 输出：{"a": "{b", "c": [1, {"d": 2}]} 完'), '{"a": "{b", "c": [1, {"d": 2}]}');
  assert.equal(extractJson('{"a": {"b": 1}, "c": "没写完'), null, '被截断的不取里面的一小块');
  assert.equal(extractJson('[1, 2]'), null, '只要对象');
  assert.equal(extractJson('没有 JSON'), null);
  // 很长、被截断的回复也很快
  const long = `{"items": [${Array.from({ length: 5000 }, (_, i) => `{"n": ${i}}`).join(', ')}`;
  const started = Date.now();
  assert.equal(extractJson(long), null);
  assert.ok(Date.now() - started < 1000);

  // 出错的工具结果：开头写明失败了（DeepSeek 不看 is_error）
  const adapted = adaptRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'roll', input: {} }, { type: 'tool_use', id: 't2', name: 'give', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 't2', content: '没有这个线索', is_error: true },
        ],
      },
    ],
  }).body;
  const results = adapted.messages[2].content as { content: string }[];
  assert.deepEqual(
    results.map((b) => b.content),
    ['{"ok":true}', `${TOOL_ERROR_PREFIX}没有这个线索`],
  );

  // 价格：高峰时段（周一到周五 UTC 1～4 点、6～10 点）全价，别的时段半价；不知道时间按高峰算
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  const usd = (model: string, at?: number) => Math.round(costOf(model, usage, at) * 1000) / 1000;
  assert.equal(usd('deepseek-flash'), 1.506);
  assert.equal(usd('deepseek-v4-pro'), 5.324);
  const monday = (h: number, m = 0) => Date.UTC(2026, 9, 26, h, m);
  assert.equal(usd('deepseek-flash', monday(2)), 1.506, '周一 UTC 2 点是高峰');
  assert.equal(usd('deepseek-flash', monday(3, 59)), 1.506);
  assert.equal(usd('deepseek-flash', monday(4)), 0.753, 'UTC 4 点起不是高峰');
  assert.equal(usd('deepseek-v4-pro', monday(9, 30)), 5.324);
  assert.equal(usd('deepseek-v4-pro', monday(12)), 2.662);
  assert.equal(usd('deepseek-flash', Date.UTC(2026, 9, 24, 2)), 0.753, '周六整天不是高峰');
  assert.equal(usd('claude-opus-5-5', monday(12)), usd('claude-opus-5-5'), 'Claude 不分时段');
  assert.ok(deepSeekPeak(monday(1)) && !deepSeekPeak(monday(0, 59)) && !deepSeekPeak(monday(5)) && deepSeekPeak(monday(6)));
});

test('DeepSeek 的流式回复：开头没带用量也能记账；中途断开的那次按收到的字数估算', async () => {
  const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const full = sse([
    { type: 'message_start', message: { id: 'msg_d', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '门开了，大堂里空无一人。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: null } },
    { type: 'message_stop' },
  ]);
  const bodies = [full.slice(0, full.indexOf('event: message_delta')), full];
  const ds = new DeepSeekProvider({
    apiKey: 'sk-test-deepseek',
    fetchImpl: (async () => new Response(bodies.shift()!, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
    sleep: async () => {},
  });
  const res = await ds.send({ model: 'deepseek-v4-pro', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: '推门' }] });
  assert.equal(textOf(res), '门开了，大堂里空无一人。');
  assert.deepEqual(res.usage, { input_tokens: 120, output_tokens: 30 });
  assert.ok(res.wasted_usage && res.wasted_usage.output_tokens > 0, '断开的那次也记上了');
});

test('DeepSeek：没设置密钥时管理页和开局都选不了 DeepSeek 的模型；设置了以后选了的那一项交给 DeepSeek，记账写 deepseek', async () => {
  const claude = new FakeProvider(demoHandler);
  const inner = new FakeProvider(demoHandler);
  let dsStatus: { ready: boolean; message: string | null } = { ready: false, message: '还没有设置 DeepSeek 的 API 密钥（项目文件夹里 .env 文件的 DEEPSEEK_API_KEY），DeepSeek 的模型暂时用不了。' };
  // 主持 AI 第一轮（调用工具）的时候做点什么：模拟结算到一半房主换了主持模型
  let onDmTurn: (() => void) | null = null;
  const deepseek: AiProvider = {
    name: 'deepseek',
    get status() {
      return dsStatus;
    },
    send: (request, signal, hooks) => {
      if (request.tools?.length) onDmTurn?.();
      return inner.send(request, signal, hooks);
    },
  };
  let at = Date.UTC(2026, 9, 26, 12, 0, 0);
  // 网站的设置是 Claude 的模型（V0.4.1 以前的默认），看选了 DeepSeek 的那一项怎么走
  const app = await startTestApp({ ai: claude, deepseek, now: () => at, tickMs: 0, aiSettings: OPUS_SETTINGS });
  try {
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const player = await app.login(TESTER1.username, TESTER1.password);
    let info = await app.call('GET', '/api/admin/ai', undefined, admin);
    assert.deepEqual(
      info.data.providers.map((p: { label: string; ready: boolean }) => [p.label, p.ready]),
      [
        ['测试用的假主持人', true],
        ['DeepSeek', false],
      ],
    );
    assert.equal(info.data.options.find((o: { model: string }) => o.model === 'deepseek-flash').available, false);
    let r = await app.call('PUT', '/api/admin/ai/models', { models: { dm: 'claude-sonnet-5-5', misc: 'deepseek-flash' } }, admin);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /DEEPSEEK_API_KEY/);
    assert.equal(app.app.ai.models.dm, 'claude-opus-5-5', '有一项不行就一项都不改');

    const created = await app.call('POST', '/api/rooms', { name: 'DeepSeek 局', maxPlayers: 2 }, player);
    const roomId = created.data.room.id as number;
    assert.equal((await app.call('POST', `/api/rooms/${roomId}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'reporter', name: '林记者' }, player)).status, 200);
    r = await app.call('PUT', `/api/rooms/${roomId}/model`, { dmModel: 'deepseek-v4-pro' }, player);
    assert.equal(r.status, 409);

    // 设置了密钥：杂活交给 DeepSeek Flash，这一局的主持交给 DeepSeek V4 Pro，内容检查照旧
    dsStatus = { ready: true, message: null };
    info = await app.call('PUT', '/api/admin/ai/models', { models: { misc: 'deepseek-flash' } }, admin);
    assert.equal(info.status, 200);
    assert.equal(info.data.models.misc, 'deepseek-flash');
    r = await app.call('PUT', `/api/rooms/${roomId}/model`, { dmModel: 'deepseek-v4-pro' }, player);
    assert.equal(r.status, 200);
    assert.equal(r.data.dmModel.current, 'deepseek-v4-pro');
    assert.equal((await app.call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, player)).status, 200);
    onDmTurn = () => {
      app.app.db.prepare('UPDATE rooms SET dm_model = ? WHERE id = ?').run('claude-sonnet-5-5', roomId);
      onDmTurn = null;
    };
    const acted = await app.call('POST', `/api/rooms/${roomId}/act`, { text: '我推开旅店的门，看看大堂里有谁。', as: 'action' }, player);
    assert.equal(acted.status, 201, JSON.stringify(acted.data));
    for (let i = 0; i < 6; i++) {
      await app.app.engine.idle();
      at += 30 * 60_000;
      app.app.engine.tick();
    }
    await app.app.engine.idle();
    const calls = app.app.db.prepare('SELECT purpose, provider, model FROM ai_calls WHERE room_id = ? OR room_id IS NULL ORDER BY id').all(roomId) as {
      purpose: string;
      provider: string;
      model: string;
    }[];
    const by = (purpose: string) => calls.filter((c) => c.purpose === purpose).map((c) => `${c.provider}/${c.model}`);
    assert.ok(by('estimate').length > 0 && by('estimate').every((c) => c === 'deepseek/deepseek-flash'), JSON.stringify(calls));
    // 结算到一半换了主持模型：这一次结算从头到尾还是 DeepSeek（前面几轮的思考、工具调用不交给另一家）
    assert.ok(by('resolve').length >= 2 && by('resolve').every((c) => c === 'deepseek/deepseek-v4-pro'), JSON.stringify(calls));
    assert.equal((app.app.db.prepare('SELECT dm_model FROM rooms WHERE id = ?').get(roomId) as { dm_model: string }).dm_model, 'claude-sonnet-5-5');
    assert.ok(by('moderation').every((c) => c === 'fake/claude-opus-5-5'), '内容检查照旧');

    // 内容检查交给 DeepSeek、密钥又没了：行动、提问、对白都交不了，说清楚原因
    info = await app.call('PUT', '/api/admin/ai/models', { models: { misc: 'claude-opus-5-5', guard: 'deepseek-flash' } }, admin);
    assert.equal(info.status, 200);
    dsStatus = { ready: false, message: '还没有设置 DeepSeek 的 API 密钥（项目文件夹里 .env 文件的 DEEPSEEK_API_KEY），DeepSeek 的模型暂时用不了。' };
    let state = (await app.call('GET', `/api/rooms/${roomId}/game`, undefined, player)).data;
    assert.equal(state.ai.ready, false, '只有内容检查用不了，也算用不了');
    assert.match(state.ai.message, /DeepSeek/);
    for (const [url, body] of [
      [`/api/rooms/${roomId}/act`, { text: '我看看柜台。', as: 'action' }],
      [`/api/rooms/${roomId}/act`, { text: '旅店有几层？', as: 'question' }],
      [`/api/rooms/${roomId}/say`, { text: '有人吗？' }],
    ] as const) {
      r = await app.call('POST', url, body, player);
      assert.equal(r.status, 503, `${url} ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /DEEPSEEK_API_KEY/);
    }
    assert.equal(inner.guardRequests.length, 0, '没有发出去检查');

    // 杂活也交给 DeepSeek：估时用不了
    dsStatus = { ready: true, message: null };
    info = await app.call('PUT', '/api/admin/ai/models', { models: { misc: 'deepseek-flash', guard: 'claude-opus-5-5' } }, admin);
    assert.equal(info.status, 200);
    dsStatus = { ready: false, message: '还没有设置 DeepSeek 的 API 密钥（项目文件夹里 .env 文件的 DEEPSEEK_API_KEY），DeepSeek 的模型暂时用不了。' };
    state = (await app.call('GET', `/api/rooms/${roomId}/game`, undefined, player)).data;
    assert.equal(state.ai.ready, false);
    assert.match(state.ai.message, /DeepSeek/);
    r = await app.call('POST', `/api/rooms/${roomId}/act`, { text: '我再看看柜台。', as: 'action' }, player);
    assert.equal(r.status, 503);
    assert.match(r.data.error, /DeepSeek/);
  } finally {
    await app.close();
  }
});

// ---------- npm run reset ----------

/** 一份用过的数据：测试账号和对局，网页上选过模型，上传过一个剧本（下架了），从旧版本复制过。 */
async function usedData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-reset-'));
  const dbPath = path.join(dir, 'data', 'game.db');
  const db = openDatabase(dbPath, { onBackup: () => {} });
  await seedTestData(db);
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai_model_dm', 'claude-sonnet-5-5')").run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('scenarios_hidden', '["my-test","yakou-fifth-man"]')`).run();
  const scenarios = testScenarioDir(dir);
  fs.copyFileSync(path.join(scenarios, 'qingxi-lantern-night.json'), path.join(scenarios, 'my-test.json'));
  fs.writeFileSync(path.join(dir, 'data', 'imported-from.json'), JSON.stringify({ from: '/old', at: 1 }));
  return { dir, dbPath, db, scenarios };
}

const tableCounts = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => [
      t.name,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n,
    ]),
  );

test('清空数据：先备份；账号、对局和所有记录都清掉，只剩新的 0 号站长；设置留着、AI 关掉；不是自带的剧本文件挪进备份文件夹', async () => {
  const { dir, dbPath, db, scenarios } = await usedData();
  try {
    const before = schemaVersion(db);
    assert.ok((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n >= 6);
    const result = await resetData(db, {
      dbPath,
      scenarioDir: scenarios,
      owner: { username: 'boss', displayName: '新站长', password: 'boss-pass-2026' },
      now: Date.UTC(2026, 9, 26, 10, 0, 0),
    });
    assert.deepEqual([result.users >= 6, result.rooms, result.scenarioFiles], [true, 4, ['fog-harbor-inn.json', 'my-test.json']]);
    assert.ok(result.backup && fs.existsSync(result.backup), '清空前的备份');
    assert.equal(listBackups(dbPath)[0].kind, 'reset');
    // 备份里是清空之前的数据
    const old = openDatabase(result.backup!, { onBackup: () => {} });
    assert.ok((old.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n === 4);
    old.close();

    const counts = tableCounts(db);
    for (const [table, n] of Object.entries(counts)) {
      if (table === 'users' || table === 'admin_audit') assert.equal(n, 1, table);
      else if (!['settings', 'schema_version'].includes(table)) assert.equal(n, 0, `${table} 清空了`);
    }
    const owner = db.prepare('SELECT * FROM users').get() as Record<string, any>;
    assert.deepEqual(
      [owner.uid, owner.username, owner.display_name, owner.is_owner, owner.is_admin, owner.is_guest],
      [0, 'boss', '新站长', 1, 1, 0],
    );
    assert.deepEqual(JSON.parse(owner.admin_perms), [...ALL_PERMISSIONS]);
    assert.ok(await verifyPassword('boss-pass-2026', owner.password_hash));
    assert.ok(owner.rules_agreed_at);
    assert.equal(result.owner.uid, 0);
    assert.match((db.prepare('SELECT action, detail FROM admin_audit').get() as { detail: string }).detail, /npm run reset/);
    assert.equal(schemaVersion(db), before);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    const setting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    assert.equal(setting('ai_enabled'), '0', 'AI 关掉了');
    assert.equal(setting('ai_model_dm'), 'claude-sonnet-5-5', '选过的模型留着');
    assert.deepEqual(JSON.parse(setting('scenarios_hidden')!), ['yakou-fifth-man'], '挪走的剧本不再算下架');

    // 自带的剧本留着；别的挪进备份文件夹，连同从旧版本复制数据的记录
    assert.deepEqual(fs.readdirSync(scenarios).sort(), [...BUILTIN_SCENARIO_FILES].sort());
    assert.ok(result.movedTo && result.movedTo.startsWith(path.join(dir, 'data', 'backups')));
    assert.deepEqual(fs.readdirSync(path.join(result.movedTo!, 'scenarios')).sort(), ['fog-harbor-inn.json', 'my-test.json']);
    assert.ok(fs.existsSync(path.join(result.movedTo!, 'imported-from.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'imported-from.json')));
    db.close();

    // 打开网站：站长能登录，下一个注册的账号是 1 号
    const app = await (async () => {
      const { createApp } = await import('../server/app');
      const a = createApp({ dbPath, webDist: path.join(dir, 'dist'), scenarioDir: scenarios, rateLimits: false });
      const port = await a.listen(0, '127.0.0.1');
      return { a, base: `http://127.0.0.1:${port}` };
    })();
    try {
      const login = await fetch(`${app.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'boss-pass-2026' }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie()[0].split(';')[0];
      const invite = await (await fetch(`${app.base}/api/admin/invites`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ note: '朋友' }) })).json();
      const reg = await fetch(`${app.base}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode: invite.invite.code, username: 'friend1', displayName: '朋友', password: 'friend-pass-1', agreeRules: true }),
      });
      assert.equal(reg.status, 201);
      assert.equal((app.a.db.prepare("SELECT uid FROM users WHERE username = 'friend1'").get() as { uid: number }).uid, 1);
      const ai = await (await fetch(`${app.base}/api/admin/ai`, { headers: { cookie } })).json();
      assert.equal(ai.enabled, false);
    } finally {
      await app.a.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 运行 npm run reset，按顺序回答（不是在窗口里运行，按行读）。 */
function runReset(dbPath: string, scenarios: string, port: number, input: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '..', 'server', 'reset.ts'), `--scenario-dir=${scenarios}`], {
      env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test('npm run reset：先问清楚再动数据；不输入「清空」、服务器还开着都不动；用户名、密码不合要求会重新问', async () => {
  const { dir, dbPath, db, scenarios } = await usedData();
  db.close();
  const users = () => {
    const check = openDatabase(dbPath, { onBackup: () => {} });
    try {
      return (check.prepare('SELECT username, display_name, uid FROM users ORDER BY id').all() as { username: string; display_name: string; uid: number }[]).map(
        (u) => ({ ...u }),
      );
    } finally {
      check.close();
    }
  };
  try {
    const port = await freePort();
    const count = users().length;
    // 不确认
    let r = await runReset(dbPath, scenarios, port, '算了\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /会删掉：\d+ 个账号/);
    assert.match(r.out, /会挪进备份文件夹的剧本文件.*my-test\.json/);
    assert.match(r.out, /没有清空，什么都没改/);
    assert.equal(users().length, count);
    // 问到一半输入断了
    r = await runReset(dbPath, scenarios, port, '清空\nboss\n');
    assert.equal(r.code, 1);
    assert.match(r.out, /没有读到输入，什么都没改/);
    assert.equal(users().length, count);
    // 服务器还开着
    const busy = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => busy.listen(port, '127.0.0.1', resolve));
    try {
      r = await runReset(dbPath, scenarios, port, '清空\n');
      assert.equal(r.code, 1);
      assert.match(r.out, /服务器还开着/);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
    // 用户名不对、密码太短、两次不一样：重新问；显示名直接回车就用用户名
    r = await runReset(dbPath, scenarios, port, '清空\nb!\nboss_1\n\nshort\nboss-pass-2026\nboss-pass-other\nboss-pass-2026\nboss-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /用户名要用3～20位字母、数字或下划线/);
    assert.match(r.out, /密码至少8位/);
    assert.match(r.out, /两次输的密码不一样/);
    assert.match(r.out, /清空好了/);
    assert.match(r.out, /站长账号：boss_1（UID 0）/);
    assert.match(r.out, /清空之前的备份：.*before-reset-/);
    assert.match(r.out, /备份里还是清空之前的全部数据.*不要发给别人/);
    assert.doesNotMatch(r.out, /输入时不显示/, '不在窗口里运行时，输入是看得见的，不这么说');
    assert.deepEqual(users(), [{ username: 'boss_1', display_name: 'boss_1', uid: 0 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 另开一个程序打开着数据库（像开着的服务器那样），收到 ready 再返回。 */
async function holdDatabase(dbPath: string) {
  const script = `const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.prepare('SELECT COUNT(*) FROM users').get();
console.log('ready');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`打开数据库的程序退出了：${code}`)));
  });
  return async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  };
}

test('npm run reset：确认之前不新建、不升级数据库；问的时候数据库被别的程序打开了（换了端口的服务器）也不动；旧版本的数据库能清空', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-reset-old-'));
  try {
    const port = await freePort();
    const scenarios = testScenarioDir(dir);
    // 还没有数据库：不确认就什么都不建
    const fresh = path.join(dir, 'fresh', 'game.db');
    const freshScenarios = testScenarioDir(path.join(dir, 'fresh-install'));
    let r = await runReset(fresh, freshScenarios, port, '算了\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /还没有，会新建一个/);
    assert.ok(!fs.existsSync(path.dirname(fresh)), '没有新建');
    // 确认了：新建数据库和站长账号；新建的数据库里什么都没有，不用备份（测试剧本照样挪走）
    r = await runReset(fresh, freshScenarios, port, '清空\nfirst\n\nfirst-pass-2026\nfirst-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /站长账号：first（UID 0）/);
    assert.doesNotMatch(r.out, /清空之前的备份|动数据之前会先把整个数据库备份/);
    assert.deepEqual(
      fs.readdirSync(path.join(path.dirname(fresh), 'backups')).map((f) => f.replace(/-\d{8}-\d{6}(-\d+)?$/, '')),
      ['reset'],
    );

    // 旧版本（第 9 版）的数据库
    const old = path.join(dir, 'data', 'game.db');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    const raw = new DatabaseSync(old);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const sql of MIGRATIONS.slice(0, 9)) raw.exec(sql);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (9);');
    const add = raw.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, 'x', 1)");
    add.run('old_one', '旧账号一');
    add.run('old_two', '旧账号二');
    raw.close();
    const version = () => {
      const db = new DatabaseSync(old, { readOnly: true });
      try {
        return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      } finally {
        db.close();
      }
    };
    const backups = path.join(dir, 'data', 'backups');
    r = await runReset(old, scenarios, port, '算了\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /会删掉：2 个账号/);
    assert.equal(version(), 9, '确认之前没有升级');
    assert.ok(!fs.existsSync(backups), '也没有备份');

    // 一开始就被别的程序打开着
    let release = await holdDatabase(old);
    try {
      r = await runReset(old, scenarios, port, '清空\n');
      assert.equal(r.code, 1);
      assert.match(r.out, /数据库正被别的程序用着/);
    } finally {
      await release();
    }
    // 问到一半才被打开：问完、动数据之前再看一次
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '..', 'server', 'reset.ts'), `--scenario-dir=${scenarios}`], {
      env: { ...process.env, DB_PATH: old, PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.write('清空\nboss\n\n');
    for (let i = 0; i < 200 && !out.includes('密码'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(out, /密码/);
    release = await holdDatabase(old);
    try {
      child.stdin.end('boss-pass-2026\nboss-pass-2026\n');
      assert.equal(await closed, 1, out);
      assert.match(out, /数据库正被别的程序用着.*什么都没改/);
    } finally {
      await release();
    }
    assert.equal(version(), 9);
    assert.ok(!fs.existsSync(backups));

    // 都关掉以后：先升级（升级前备份一份），再清空
    r = await runReset(old, scenarios, port, '清空\nboss\n老板\nboss-pass-2026\nboss-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`从第 9 版升级到第 ${MIGRATIONS.length} 版`));
    assert.match(r.out, /清空好了/);
    assert.equal(version(), MIGRATIONS.length);
    assert.deepEqual(
      fs
        .readdirSync(backups)
        .map((f) => f.replace(/-\d{8}-\d{6}(-\d+)?(\.db)?$/, ''))
        .sort(),
      ['before-reset', 'before-upgrade', 'reset'],
      '升级前、清空前各备份一份；测试剧本挪进了 reset- 文件夹',
    );
    const db = openDatabase(old, { onBackup: () => {} });
    try {
      assert.deepEqual(
        (db.prepare('SELECT username, display_name, uid, is_owner FROM users').all() as Record<string, unknown>[]).map((u) => ({ ...u })),
        [{ username: 'boss', display_name: '老板', uid: 0, is_owner: 1 }],
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
