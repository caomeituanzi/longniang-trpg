import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { ALL_PERMISSIONS } from '../shared/admin';
import { MIGRATIONS, openDatabase } from '../server/db';
import { insertAccount } from '../server/routes/auth';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, startTestApp } from './helpers';

// V0.3.2：管理员新建正式账号；删掉的账号把 UID 空出来，新账号用空着的最小的号；账号列表的创建时间；
// 站长的最高权限（别的管理员有全部权限也动不了站长）；用户名只有本人和管理员看得到，加好友要填完整的用户名。

let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};
const [ADMIN, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;

before(async () => {
  t = await startTestApp();
  for (const a of [ADMIN, TESTER1, TESTER2, TESTER3]) cookies[a.username] = await t.login(a.username, a.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, who: string | null, body?: unknown) => t.call(method, url, body, who ? (cookies[who] ?? who) : undefined);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const pid = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const uidOf = (username: string) => (t.app.db.prepare('SELECT uid FROM users WHERE username = ?').get(username) as { uid: number | null }).uid;

// ---------- 升级 ----------

test('升级到 V0.3.2：删掉的账号把 UID 空出来、用户名换成随机的；每个账号有公开编号；通知里存的用户名换成公开编号；新账号用空着的最小的号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-mig12-'));
  try {
    const file = path.join(dir, 'game.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 11)) raw.exec(sql);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (11);');
    // V0.3.1 的样子：站长 0、alice 1、删掉的账号 2（用户名 deleted-2）、bob 3、一个游客
    const add = raw.prepare(
      'INSERT INTO users (username, display_name, password_hash, created_at, uid, is_guest, is_admin, is_owner, deleted_at, avatar_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    );
    add.run('boss', '站长', 'x', 0, 0, 1, 1, null, null);
    add.run('alice', '爱丽丝', 'x', 1, 0, 0, 0, null, 1234);
    add.run('deleted-2', '已删除的账号', '!', 2, 0, 0, 0, 5, null);
    add.run('bob', '鲍勃', 'x', 3, 0, 0, 0, null, null);
    add.run('guest-aaaaaaaaaaaa', '游客1001', 'x', 12345678, 1, 0, 0, null, null);
    const bossId = (raw.prepare("SELECT id FROM users WHERE username = 'boss'").get() as { id: number }).id;
    raw
      .prepare("INSERT INTO notifications (user_id, kind, data, created_at) VALUES (?, 'friend_request', ?, 1)")
      .run(bossId, JSON.stringify({ from: { username: 'alice', displayName: '爱丽丝', avatar: '/api/avatars/alice?v=1234', identity: 'user' } }));
    raw.close();

    const db = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
    try {
      const rows = db.prepare('SELECT username, uid, public_id, created_by FROM users ORDER BY id').all() as {
        username: string;
        uid: number | null;
        public_id: string;
        created_by: number | null;
      }[];
      assert.deepEqual(
        rows.filter((r) => !r.username.startsWith('deleted-')).map((r) => [r.username, r.uid]),
        [
          ['boss', 0],
          ['alice', 1],
          ['bob', 3],
          ['guest-aaaaaaaaaaaa', 12345678],
        ],
        '别的账号的号不动',
      );
      const removed = rows.find((r) => r.username.startsWith('deleted-'))!;
      assert.match(removed.username, /^deleted-[0-9a-f]{12}$/);
      assert.equal(removed.uid, null);
      assert.ok(rows.every((r) => /^p-[0-9a-f]{16}$/.test(r.public_id)), '每个账号都有公开编号');
      assert.equal(new Set(rows.map((r) => r.public_id)).size, rows.length);
      assert.ok(rows.every((r) => r.created_by === null));
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'uid_counter'").get(), undefined);

      // 通知里存的发起人：换成公开编号，头像的地址也换了，没有用户名了
      const alice = rows.find((r) => r.username === 'alice')!;
      const data = JSON.parse((db.prepare('SELECT data FROM notifications').get() as { data: string }).data);
      assert.deepEqual(data.from, { displayName: '爱丽丝', avatar: `/api/avatars/${alice.public_id}?v=1234`, identity: 'user', publicId: alice.public_id });

      // 新账号用空着的最小的号；游客不占；新账号也有公开编号
      const at = Date.now();
      const carol = insertAccount(db, { username: 'carol', displayName: '卡罗尔', passwordHash: 'x', at, guest: false });
      insertAccount(db, { username: 'guest-bbbbbbbbbbbb', displayName: '游客1002', passwordHash: 'x', at, guest: true });
      const dave = insertAccount(db, { username: 'dave', displayName: '戴夫', passwordHash: 'x', at, guest: false });
      const of = (id: number) => db.prepare('SELECT uid, public_id FROM users WHERE id = ?').get(id) as { uid: number; public_id: string };
      assert.equal(of(carol).uid, 2, '用上空出来的 2');
      assert.equal(of(dave).uid, 4, '1～3 都有人了，接着是 4');
      assert.match(of(dave).public_id, /^p-[0-9a-f]{16}$/);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 新建账号、删除以后号空出来 ----------

test('管理员新建正式账号：要有「账号管理」权限；用户名不能重复；给一次临时密码；本人第一次登录先同意使用规则；UID 用空着的最小的号', async () => {
  // 没有「账号管理」权限的管理员、普通玩家都不行
  assert.equal((await call('POST', '/api/admin/users', 'tester1', { username: 'made_by_player', displayName: '玩家建的' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['credit'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', 'tester3', { username: 'made_by_credit', displayName: '额度管理员建的' })).status, 403);
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'user' });

  // 用户名的规矩和注册一样；大小写不同也算重名
  for (const [username, status] of [
    ['ab', 400],
    ['bad-name', 400],
    ['TESTER1', 409],
  ] as const) {
    assert.equal((await call('POST', '/api/admin/users', 'admin', { username, displayName: '试试' })).status, status, username);
  }
  assert.equal((await call('POST', '/api/admin/users', 'admin', { username: 'no_name', displayName: '' })).status, 400);

  const made = await call('POST', '/api/admin/users', 'admin', { username: 'friend_a', displayName: '朋友甲' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.data.tempPassword, /^[a-z0-9]{10}$/);
  assert.equal(made.data.user.username, 'friend_a');
  assert.equal(made.data.user.uid, 6, '0～5 是测试账号，接着是 6');
  assert.equal(made.data.user.createdBy, ADMIN.displayName);
  assert.equal(made.data.user.rulesAgreed, false);
  assert.ok((await call('GET', '/api/admin/audit', 'admin')).data.entries.some((e: any) => e.action === '新建账号' && e.detail.includes('friend_a') && e.detail.includes('UID 6')));

  // 本人用临时密码登录：先同意使用规则；额度和注册的账号一样
  const cookie = await t.login('friend_a', made.data.tempPassword);
  const me = (await t.call('GET', '/api/auth/me', undefined, cookie)).data;
  assert.equal(me.user.rulesAgreed, false);
  assert.equal(me.credit.total, 5);

  // 账号列表默认按 UID 排；有创建时间、谁建的
  const list = (await call('GET', '/api/admin/users', 'admin')).data.users as any[];
  const members = list.filter((u) => !u.isGuest);
  assert.deepEqual(
    members.map((u) => u.uid),
    [...members.map((u) => u.uid)].sort((a, b) => a - b),
  );
  const row = list.find((u) => u.username === 'friend_a');
  assert.equal(typeof row.createdAt, 'number');
  assert.equal(row.createdBy, ADMIN.displayName);
  assert.equal(list.find((u) => u.username === 'tester1').createdBy, null, '自己注册的没有');
});

test('删除正式账号：UID 空出来，下一个注册或新建的正式账号用空着的最小的号；游客不占号', async () => {
  const freed = uidOf('friend_a')!;
  assert.equal((await call('DELETE', `/api/admin/users/${userId('friend_a')}`, 'admin')).status, 200);
  const count = (uid: number) => (t.app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE uid = ?').get(uid) as { n: number }).n;
  assert.equal(count(freed), 0, `UID ${freed} 空出来了`);

  // 游客不占号
  const guest = await t.call('POST', '/api/auth/guest');
  assert.equal(guest.status, 201);
  const guestUid = (t.app.db.prepare('SELECT uid FROM users WHERE id = ?').get(guest.data.user.id) as { uid: number }).uid;
  assert.ok(guestUid >= 10_000_000);

  // 管理员新建的账号用空出来的号；再建两个接着排
  const make = async (username: string) => {
    const r = await call('POST', '/api/admin/users', 'admin', { username, displayName: username });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.user.uid as number;
  };
  assert.equal(await make('friend_b'), freed);
  const middle = await make('friend_d');
  const last = await make('friend_e');
  assert.equal(last, middle + 1);

  // 删掉中间的一个，注册一个新的：用中间空出来的号（比最后一个小）
  assert.equal((await call('DELETE', `/api/admin/users/${userId('friend_d')}`, 'admin')).status, 200);
  const code = (await call('POST', '/api/admin/invites', 'admin', { note: '补号' })).data.invite.code;
  const reg = await t.call('POST', '/api/auth/register', { inviteCode: code, username: 'friend_c', displayName: '朋友丙', password: 'friend-c-pass-1', agreeRules: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal(uidOf('friend_c'), middle);
  assert.equal(uidOf('friend_e'), last, '别人的号不动');
});

// ---------- 站长的最高权限 ----------

test('站长的最高权限：管理员有全部权限也动不了站长的账号、聊天消息、违规记录、举报站长的记录；站长在的对局不算账号，照样能管', async () => {
  const boss = userId(ADMIN.username);
  // 让 tester1 当管理员，给全部权限
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester1')}/role`, 'admin', { role: 'admin', permissions: ALL_PERMISSIONS })).status, 200);
  cookies.tester1 = await t.login(TESTER1.username, TESTER1.password);

  // 账号：封号、重置密码、改额度、不限额度、写备注、删除、改身份，都不行
  for (const [method, url, body] of [
    ['POST', `/api/admin/users/${boss}/ban`, { reason: '试试' }],
    ['POST', `/api/admin/users/${boss}/reset-password`, undefined],
    ['POST', `/api/admin/users/${boss}/credit`, { amount: 1 }],
    ['PUT', `/api/admin/users/${boss}/unlimited`, { unlimited: false }],
    ['PUT', `/api/admin/users/${boss}/note`, { note: '试试' }],
    ['DELETE', `/api/admin/users/${boss}`, undefined],
    ['PUT', `/api/admin/users/${boss}/role`, { role: 'user' }],
  ] as const) {
    const r = await call(method, url, 'tester1', body);
    assert.equal(r.status, 403, `${method} ${url}：${JSON.stringify(r.data)}`);
  }
  for (const op of ['ban', 'credit', 'unlimited', 'delete'] as const) {
    const r = await call('POST', '/api/admin/users/batch', 'tester1', { ids: [boss], op, reason: '试试', amount: 1, unlimited: false });
    assert.ok(r.status === 403 || (r.status === 200 && r.data.done.length === 0), `批量 ${op}：${JSON.stringify(r.data)}`);
  }
  assert.equal((t.app.db.prepare('SELECT banned_at FROM users WHERE id = ?').get(boss) as { banned_at: number | null }).banned_at, null);

  // 对局不算站长的账号：站长当房主的对局、站长在里面玩的对局，有「管理所有对局」权限的管理员照样能管
  const room = (await call('POST', '/api/rooms', 'admin', { name: '站长的局', maxPlayers: 4 })).data.room;
  assert.equal((await call('PUT', `/api/rooms/${room.id}/public`, 'tester1', { isPublic: true })).status, 200);
  assert.equal((await call('POST', `/api/admin/rooms/${room.id}/status`, 'tester1', { status: 'ended' })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/rooms/${room.id}`, 'tester1')).status, 200);
  const other = (await call('POST', '/api/rooms', 'tester2', { name: '站长来玩', maxPlayers: 4 })).data.room;
  assert.equal((await call('POST', '/api/rooms/join', 'admin', { code: other.joinCode })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/rooms/${other.id}`, 'tester1')).status, 200);

  // 大厅聊天：站长的消息只有站长自己能撤回
  const said = await call('POST', '/api/lobby/chat', 'admin', { text: '站长说话' });
  assert.equal((await call('DELETE', `/api/lobby/chat/${said.data.message.id}`, 'tester1')).status, 403);
  const plainMsg = await call('POST', '/api/lobby/chat', 'tester2', { text: '普通人说话' });
  assert.equal((await call('DELETE', `/api/lobby/chat/${plainMsg.data.message.id}`, 'tester1')).status, 200, '别人的照常能删');
  assert.equal((await call('DELETE', `/api/lobby/chat/${said.data.message.id}`, 'admin')).status, 200);

  // 站长的违规记录：只有站长能处理
  const { lastInsertRowid } = t.app.db
    .prepare("INSERT INTO violations (user_id, room_id, kind, source, content, category, reason, outcome, created_at) VALUES (?, NULL, 'precheck', 'action', 'x', 'other', '测试', 'blocked', ?)")
    .run(boss, Date.now());
  const violation = (await call('GET', '/api/admin/violations', 'tester1')).data.violations.find((v: any) => v.id === Number(lastInsertRowid));
  assert.equal(violation.user.isOwner, true);
  assert.equal((await call('POST', `/api/admin/violations/${lastInsertRowid}/review`, 'tester1')).status, 403);
  assert.equal((await call('POST', `/api/admin/violations/${lastInsertRowid}/review`, 'admin')).status, 200);

  // 举报站长：只交给站长
  const report = await call('POST', '/api/reports', 'tester2', { kind: 'report', user: pid(ADMIN.username), body: '举报站长' });
  assert.equal(report.status, 201, JSON.stringify(report.data));
  assert.ok(!(await call('GET', '/api/admin/reports', 'tester1')).data.reports.some((r: any) => r.id === report.data.id));
  assert.ok((await call('GET', '/api/admin/reports', 'admin')).data.reports.some((r: any) => r.id === report.data.id));
  assert.equal((await call('POST', `/api/admin/reports/${report.data.id}/handle`, 'tester1', {})).status, 404);
});

// ---------- 额度兑换码 ----------

test('额度兑换码：有「发放额度」权限才能生成、删除；可以自己写或随机；单次的只能一个人用，可重复的每人一次；过期、删掉以后不能兑换，已经兑换的额度不受影响', async () => {
  cookies.friend_c = await t.login('friend_c', 'friend-c-pass-1');
  const total = async (who: string) => (await call('GET', '/api/auth/me', who)).data.credit.total as number;
  const redeem = (who: string, code: string) => call('POST', '/api/me/redeem', who, { code });

  // 权限、格式
  assert.equal((await call('POST', '/api/admin/credit-codes', 'tester2', { amount: 1, days: 7 })).status, 403);
  for (const body of [
    { amount: 0, days: 7 },
    { amount: 101, days: 7 },
    { amount: 1, days: 0 },
    { amount: 1, days: 7, code: 'ab' },
    { amount: 1, days: 7, code: '!!!!!' },
  ]) {
    assert.equal((await call('POST', '/api/admin/credit-codes', 'admin', body)).status, 400, JSON.stringify(body));
  }

  // 自己写的、可重复的：大小写、空格、短横线都不管；重名不行
  const custom = await call('POST', '/api/admin/credit-codes', 'admin', { code: 'longniang666', amount: 2, reusable: true, days: 7, note: '周末活动' });
  assert.equal(custom.status, 201, JSON.stringify(custom.data));
  assert.equal(custom.data.code.code, 'longniang666');
  assert.equal((await call('POST', '/api/admin/credit-codes', 'admin', { code: 'LONGNIANG-666', amount: 1, days: 7 })).status, 409);

  // 随机的、单次的
  const single = await call('POST', '/api/admin/credit-codes', 'admin', { amount: 1.5, days: 1 });
  assert.equal(single.status, 201);
  assert.match(single.data.code.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(single.data.code.reusable, false);

  const before2 = await total('tester2');
  const r1 = await redeem('tester2', 'Long Niang 666');
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.amount, 2);
  assert.equal(r1.data.credit.total, before2 + 2);
  assert.equal((await redeem('tester2', 'longniang666')).status, 409, '每人只能兑换一次');
  assert.equal((await redeem('friend_c', 'longniang666')).status, 200, '可重复的别人也能兑换');
  // 单次的：小写、不带短横线也认；第二个人就不行了
  assert.equal((await redeem('tester2', single.data.code.code.replaceAll('-', '').toLowerCase())).status, 200);
  const taken = await redeem('friend_c', single.data.code.code);
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /已经被用过了/);
  assert.equal(await total('tester2'), before2 + 3.5);

  // 管理页看得到谁兑换了；兑换记进了发放记录
  const list = (await call('GET', '/api/admin/credit-codes', 'admin')).data.codes as any[];
  const row = list.find((c) => c.id === custom.data.code.id);
  assert.equal(row.uses, 2);
  assert.deepEqual(row.usedBy, [TESTER2.displayName, '朋友丙']);
  assert.equal(list.find((c) => c.id === single.data.code.id).status, 'used');
  const grants = (await call('GET', `/api/admin/users/${userId('tester2')}`, 'admin')).data.grants as any[];
  assert.ok(grants.some((g) => g.amount === 2 && g.note === '兑换码 longniang666（周末活动）' && g.by === ADMIN.displayName));

  // 过期了不能兑换
  t.app.db.prepare('UPDATE credit_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, single.data.code.id);
  const expired = await call('POST', '/api/admin/credit-codes', 'admin', { code: 'gone-soon', amount: 1, days: 1 });
  t.app.db.prepare('UPDATE credit_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expired.data.code.id);
  assert.equal((await redeem('tester2', 'gone-soon')).status, 410);

  // 删掉：不能再兑换；已经兑换的额度不变
  assert.equal((await call('DELETE', `/api/admin/credit-codes/${custom.data.code.id}`, 'admin')).status, 200);
  assert.equal((await redeem('admin', 'longniang666')).status, 404);
  assert.equal(await total('tester2'), before2 + 3.5, '已经兑换的不受影响');
  assert.ok(grants.length > 0 && (t.app.db.prepare('SELECT COUNT(*) AS n FROM credit_grants WHERE note LIKE ?').get('兑换码 longniang666%') as { n: number }).n === 2);
  const audit = (await call('GET', '/api/admin/audit', 'admin')).data.entries as any[];
  assert.ok(audit.some((e) => e.action === '生成兑换码' && e.detail.includes('longniang666')));
  assert.ok(audit.some((e) => e.action === '删除兑换码' && e.detail === 'longniang666'));

  // 游客不能兑换
  const guest = await t.call('POST', '/api/auth/guest');
  assert.equal((await t.call('POST', '/api/me/redeem', { code: 'whatever' }, guest.cookie ?? undefined)).status, 403);
});
