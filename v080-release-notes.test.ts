process.env.TZ = 'Asia/Shanghai';
// V0.8.0：版本更新公告——新版本第一次启动时，把这一版改了什么发成全服公告（只发一次；跳着升级的补上中间几版）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { compareVersions, postReleaseNotes, RELEASE_NOTES, RELEASE_NOTES_SETTING, type ReleaseNote } from '../server/release-notes';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { getSetting, setSetting } from '../server/settings';
import { APP_VERSION } from '../server/version';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1] = TEST_ACCOUNTS;
let t: Awaited<ReturnType<typeof startTestApp>>;

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
});

after(async () => {
  await t.close();
});

const NOTES: ReleaseNote[] = [
  { version: '0.10.0', title: 'V0.10.0 更新了什么', body: '・十' },
  { version: '0.9.0', title: 'V0.9.0 更新了什么', body: '・九' },
  { version: '0.8.0', title: 'V0.8.0 更新了什么', body: '・八' },
];

const announcements = () =>
  t.app.db.prepare('SELECT title, body, audience, created_by FROM announcements ORDER BY id').all() as {
    title: string;
    body: string;
    audience: string;
    created_by: number | null;
  }[];

test('这个版本有更新说明：标题、内容不超过公告的上限，新的在前', () => {
  assert.ok(
    RELEASE_NOTES.some((n) => n.version === APP_VERSION),
    `package.json 的版本 ${APP_VERSION} 在 server/release-notes.ts 里还没有更新说明`,
  );
  for (const n of RELEASE_NOTES) {
    assert.ok([...n.title].length <= 40 && n.title.length > 0, n.title);
    assert.ok([...n.body].length <= 2000 && n.body.length > 0, n.version);
  }
  const versions = RELEASE_NOTES.map((n) => n.version);
  assert.deepEqual([...versions].sort((a, b) => compareVersions(b, a)), versions);
});

test('版本号比较', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.8.0', '0.8.1') < 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('第一次：只发现在这个版本的，发给全服、记成站长发的；再启动不重复', async () => {
  const before = announcements().length;
  assert.deepEqual(postReleaseNotes(t.app.db, { now: t.app.engine.now(), version: '0.8.0', notes: NOTES }), ['0.8.0']);
  const list = announcements().slice(before);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'V0.8.0 更新了什么');
  assert.equal(list[0].audience, 'all');
  const owner = t.app.db.prepare('SELECT id FROM users WHERE is_owner = 1').get() as { id: number } | undefined;
  assert.equal(list[0].created_by, owner?.id ?? null);
  assert.equal(getSetting(t.app.db, RELEASE_NOTES_SETTING), '0.8.0');
  // 玩家在公告里看得到
  const cookie = await t.login(TESTER1.username, TESTER1.password);
  const items = (await t.call('GET', '/api/announcements', undefined, cookie)).data.items as { title: string; read: boolean }[];
  assert.ok(items.some((a) => a.title === 'V0.8.0 更新了什么' && !a.read));
  // 同一个版本再启动：不再发
  assert.deepEqual(postReleaseNotes(t.app.db, { now: t.app.engine.now(), version: '0.8.0', notes: NOTES }), []);
  assert.equal(announcements().length, before + 1);
});

test('跳着升级：中间几版的说明按顺序补上；拿旧版本打开什么都不做', () => {
  setSetting(t.app.db, RELEASE_NOTES_SETTING, '0.8.0');
  const before = announcements().length;
  assert.deepEqual(postReleaseNotes(t.app.db, { now: t.app.engine.now(), version: '0.10.0', notes: NOTES }), ['0.9.0', '0.10.0']);
  assert.deepEqual(
    announcements()
      .slice(before)
      .map((a) => a.title),
    ['V0.9.0 更新了什么', 'V0.10.0 更新了什么'],
  );
  assert.equal(getSetting(t.app.db, RELEASE_NOTES_SETTING), '0.10.0');
  // 旧版本打开：不发，也不把记录改回去
  assert.deepEqual(postReleaseNotes(t.app.db, { now: t.app.engine.now(), version: '0.9.0', notes: NOTES }), []);
  assert.equal(getSetting(t.app.db, RELEASE_NOTES_SETTING), '0.10.0');
  // 这个版本没写说明（只修了点小问题）：记下版本，什么都不发
  assert.deepEqual(postReleaseNotes(t.app.db, { now: t.app.engine.now(), version: '0.10.1', notes: NOTES }), []);
  assert.equal(getSetting(t.app.db, RELEASE_NOTES_SETTING), '0.10.1');
  assert.equal(announcements().length, before + 2);
});

test('管理员在公告列表里看得到、删得掉自动发的公告', async () => {
  const admin = await t.login(ADMIN.username, ADMIN.password);
  const list = (await t.call('GET', '/api/admin/announcements', undefined, admin)).data.announcements as { id: number; title: string }[];
  const mine = list.find((a) => a.title === 'V0.10.0 更新了什么');
  assert.ok(mine);
  assert.equal((await t.call('DELETE', `/api/admin/announcements/${mine.id}`, undefined, admin)).status, 200);
});
