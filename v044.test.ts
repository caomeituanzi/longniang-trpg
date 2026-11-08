import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS } from '../server/db';
import { remainingText } from '../server/safety';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BAN_MAX_HOURS, banLengthText } from '../shared/admin';
import { startTestApp } from './helpers';

// V0.4.4：封号可以选时长（几小时、几天、永久），到时间自动解封。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const HOUR = 3_600_000;
let now = Date.UTC(2026, 9, 27, 3, 0, 0);

let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  cookies.admin = await t.login(ADMIN.username, ADMIN.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, body?: unknown) => t.call(method, url, body, cookies.admin);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const row = (username: string) =>
  ({ ...(t.app.db.prepare('SELECT banned_at, ban_reason, banned_until FROM users WHERE username = ?').get(username) as object) }) as {
    banned_at: number | null;
    ban_reason: string | null;
    banned_until: number | null;
  };
const lastAudit = () => ({ ...(t.app.db.prepare('SELECT admin_id, action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as object) }) as {
  admin_id: number | null;
  action: string;
  detail: string;
};
const login = (a: { username: string; password: string }) => t.call('POST', '/api/auth/login', { username: a.username, password: a.password });
const listed = async (username: string) =>
  ((await call('GET', '/api/admin/users')).data.users as { username: string; banned: { at: number; reason: string; until: number | null } | null }[]).find(
    (u) => u.username === username,
  )!;

test('第 13 版的数据库：账号多了「到时间自动解封」的时间；时长的说法', () => {
  assert.match(MIGRATIONS[12], /ADD COLUMN banned_until/);
  const columns = (t.app.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes('banned_until'));
  assert.equal(banLengthText(null), '永久');
  assert.equal(banLengthText(1), '1 小时');
  assert.equal(banLengthText(36), '36 小时');
  assert.equal(banLengthText(72), '3 天');
  assert.equal(BAN_MAX_HOURS, 365 * 24);
  assert.equal(remainingText(24 * HOUR), '1 天');
  assert.equal(remainingText(71 * HOUR + 1), '3 天');
  assert.equal(remainingText(49 * HOUR), '2 天 1 小时');
  assert.equal(remainingText(HOUR), '1 小时');
  assert.equal(remainingText(90 * 60_000), '1 小时 30 分钟');
  assert.equal(remainingText(1000), '1 分钟');
});

test('封 1 天：马上登录不了，登录时写着多久以后解封；到时间自动解封，能登录，操作记录里记一条「网站自动」的', async () => {
  const before = await t.login(TESTER1.username, TESTER1.password);
  const start = now;
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/ban`, { reason: '刷屏', hours: 24 })).status, 200);
  assert.deepEqual(row('tester1'), { banned_at: start, ban_reason: '管理员封禁：刷屏', banned_until: start + 24 * HOUR });
  assert.equal(lastAudit().action, '封号');
  assert.match(lastAudit().detail, /：刷屏（封 1 天）$/);
  // 原来的登录失效了
  assert.equal((await t.call('GET', '/api/auth/me', undefined, before)).data.user, null);
  // 管理页的列表里写着到什么时候
  assert.deepEqual((await listed('tester1')).banned, { at: start, reason: '管理员封禁：刷屏', until: start + 24 * HOUR });

  let r = await login(TESTER1);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '账号已被封禁（管理员封禁：刷屏），1 天后自动解封。有疑问请联系管理员。');
  now += 23 * HOUR;
  r = await login(TESTER1);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /，1 小时后自动解封。/);
  now += 30 * 60_000;
  assert.match((await login(TESTER1)).data.error, /，30 分钟后自动解封。/);

  // 到时间了：登录时就解封
  now += 31 * 60_000;
  r = await login(TESTER1);
  assert.equal(r.status, 200);
  assert.deepEqual(row('tester1'), { banned_at: null, ban_reason: null, banned_until: null });
  const lifted = lastAudit();
  assert.equal(lifted.admin_id, null, '是网站自动解封的');
  assert.equal(lifted.action, '解封');
  assert.match(lifted.detail, /tester1）：封禁到期，自动解封（封禁的原因：管理员封禁：刷屏）$/);
  assert.equal((await listed('tester1')).banned, null);
});

test('没人登录也会到时间解封（服务器每分钟查一次；打开管理页的账号列表时也先查）；永久的一直封着', async () => {
  assert.equal((await call('POST', `/api/admin/users/${userId('tester2')}/ban`, { reason: '骂人', hours: 1 })).status, 200);
  // 不写时长：永久
  assert.equal((await call('POST', `/api/admin/users/${userId('tester3')}/ban`, { reason: '外挂' })).status, 200);
  assert.equal(row('tester3').banned_until, null);
  assert.match(lastAudit().detail, /：外挂（永久）$/);
  assert.equal((await listed('tester3')).banned?.until, null);

  now += HOUR - 1;
  assert.deepEqual(t.app.safety.liftExpiredBans(), [], '还差一点');
  now += 1;
  assert.deepEqual(t.app.safety.liftExpiredBans(), [userId('tester2')]);
  assert.equal(row('tester2').banned_at, null);
  assert.equal((await login(TESTER2)).status, 200);

  // 永久的：过了很久也不解封，登录时不写什么时候解封
  now += 400 * 24 * HOUR;
  assert.equal((await listed('tester3')).banned?.until, null);
  assert.ok(row('tester3').banned_at !== null);
  const r = await login(TESTER3);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '账号已被封禁（管理员封禁：外挂）。有疑问请联系管理员。');
  // 管理员解封：照常
  assert.equal((await call('POST', `/api/admin/users/${userId('tester3')}/unban`, {})).status, 200);
  assert.deepEqual(row('tester3'), { banned_at: null, ban_reason: null, banned_until: null });
  assert.equal(lastAudit().admin_id, userId('admin'));
});

test('时长要在 1 小时到 365 天之间的整数小时；提前解封以后不会再「到期解封」一次', async () => {
  const id = userId('tester4');
  for (const hours of [0, -1, 1.5, BAN_MAX_HOURS + 1, '24']) {
    const r = await call('POST', `/api/admin/users/${id}/ban`, { reason: '测试', hours });
    assert.equal(r.status, 400, `hours=${hours}`);
    assert.equal(r.data.error, '封禁时长要在 1 小时到 365 天之间，再长就选永久');
  }
  assert.equal(row('tester4').banned_at, null, '都没封上');
  assert.equal((await call('POST', `/api/admin/users/${id}/ban`, { reason: '测试', hours: BAN_MAX_HOURS })).status, 200);
  assert.equal(row('tester4').banned_until, now + BAN_MAX_HOURS * HOUR);
  assert.match(lastAudit().detail, /（封 365 天）$/);
  // 已经封着的不能再封（要改时长：先解封再封）
  assert.equal((await call('POST', `/api/admin/users/${id}/ban`, { reason: '再封', hours: 1 })).status, 409);
  assert.equal((await call('POST', `/api/admin/users/${id}/unban`, {})).status, 200);
  assert.equal(row('tester4').banned_until, null);
  const audits = (t.app.db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n;
  now += (BAN_MAX_HOURS + 1) * HOUR;
  assert.deepEqual(t.app.safety.liftExpiredBans(), []);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n, audits);
});

test('批量封号也能选时长；删掉的账号不会到时间被「解封」', async () => {
  const ids = [userId('tester4'), userId('tester5')];
  let r = await call('POST', '/api/admin/users/batch', { op: 'ban', ids, reason: '一起刷屏', hours: 72 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.done, ids);
  for (const name of ['tester4', 'tester5']) {
    assert.equal(row(name).banned_until, now + 72 * HOUR);
  }
  assert.match(lastAudit().detail, /：一起刷屏（封 3 天）$/);
  r = await call('POST', '/api/admin/users/batch', { op: 'ban', ids: [userId('tester1')], reason: '刷屏', hours: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '封禁时长要在 1 小时到 365 天之间，再长就选永久');

  // 站长删掉 tester5：删掉的账号一直是封着的
  assert.equal((await call('DELETE', `/api/admin/users/${ids[1]}`)).status, 200);
  const deleted = t.app.db.prepare('SELECT banned_at, banned_until, deleted_at FROM users WHERE id = ?').get(ids[1]) as {
    banned_at: number | null;
    banned_until: number | null;
    deleted_at: number | null;
  };
  assert.ok(deleted.deleted_at !== null && deleted.banned_at !== null);
  assert.equal(deleted.banned_until, null);
  now += 73 * HOUR;
  assert.deepEqual(t.app.safety.liftExpiredBans(), [ids[0]]);
  assert.ok((t.app.db.prepare('SELECT banned_at FROM users WHERE id = ?').get(ids[1]) as { banned_at: number | null }).banned_at !== null);
  assert.equal((await login(TESTER4)).status, 200);
  assert.equal((await login(TESTER5)).status, 401, '删掉的账号登录不了');
});
