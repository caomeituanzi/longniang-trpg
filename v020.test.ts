import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { openDatabase } from '../server/db';
import { seedTestData, TEST_ACCOUNTS } from '../server/seed-data';
import { ALL_PERMISSIONS } from '../shared/admin';
import { startTestApp } from './helpers';

// V0.2.0：游客、UID、站长和管理员分级、批量处理、公告、个人主页和头像、好友和私聊、屏蔽、对局邀请、
// 大厅聊天、举报和 bug 反馈、观看公开对局、合并的输入框、对白、协助、给东西、单局模型、网站防护。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 26, 3, 0, 0);
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
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
/** 公开编号（个人主页、头像的地址用它；网页上拿不到别人的用户名）。 */
const pid = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const game = async (roomId: number, who: string) => (await call('GET', `/api/rooms/${roomId}/game`, who)).data;
const log = async (roomId: number, who: string) => (await call('GET', `/api/rooms/${roomId}/log`, who)).data.entries as any[];
const notifications = async (who: string) => (await call('GET', '/api/notifications', who)).data.items as any[];
const badges = async (who: string) => (await call('GET', '/api/me/badges', who)).data;

async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

async function guest(): Promise<{ cookie: string; user: any }> {
  const g = await t.call('POST', '/api/auth/guest');
  assert.equal(g.status, 201, JSON.stringify(g.data));
  return { cookie: g.cookie!, user: g.data.user };
}

/** 建一局《雾港旅店》、建好角色、开始。characters：[谁, 身份, 名字]。没有人打开这一局的页面（都不在线）时是计时模式。 */
async function startedRoom(characters: [string, string, string][], opts: { isPublic?: boolean; name?: string } = {}) {
  const [host] = characters[0];
  const created = await call('POST', '/api/rooms', host, {
    name: opts.name ?? '测试局',
    maxPlayers: 6,
    isPublic: opts.isPublic ?? false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.room.id as number;
  for (const [who] of characters.slice(1)) assert.equal((await call('POST', '/api/rooms/join', who, { code: created.data.room.joinCode })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, host, { key: 'fog-harbor-inn' })).status, 200);
  for (const [who, roleKey, name] of characters) {
    const r = await call('PUT', `/api/rooms/${roomId}/character`, who, { roleKey, name });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const started = await call('POST', `/api/rooms/${roomId}/status`, host, { status: 'running' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  return { roomId, code: created.data.room.joinCode as string };
}

/** 两个人互相加好友。 */
async function befriend(a: string, b: string) {
  const r = await call('POST', '/api/friends', a, { username: b });
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.data));
  if (r.data.relation !== 'friends') assert.equal((await call('POST', `/api/friends/${a}/accept`, b)).status, 200);
}

test('游客：点一下就进来，只能看大厅、观看公开对局的故事；不能玩、不能发言、没有额度', async () => {
  const { cookie: gc, user } = await guest();
  cookies.guest1 = gc;
  assert.equal(user.identity, 'guest');
  assert.equal(user.isGuest, true);
  // 用户名、名字里都是随机的字符，不是 UID（UID 只有管理员看得到）
  assert.match(user.username, /^guest-[0-9a-f]{12}$/);
  assert.match(user.displayName, /^游客\d{4,6}$/);
  assert.equal('uid' in user, false, '网页拿不到 UID');
  // 同一个浏览器再点一次，还是这个游客
  assert.equal((await t.call('POST', '/api/auth/guest', undefined, gc)).data.user.username, user.username);
  // 游客没有密码，不能用密码登录
  assert.equal((await t.call('POST', '/api/auth/login', { username: user.username, password: 'whatever-123' })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', gc)).data.credit.remaining, 0);

  assert.equal((await call('GET', '/api/hall', gc)).status, 200);
  assert.equal((await call('GET', '/api/announcements', gc)).status, 200);
  assert.deepEqual((await call('GET', '/api/rooms', gc)).data.rooms, []);
  for (const [method, url, body] of [
    ['POST', '/api/rooms', { name: '游客的局', maxPlayers: 2 }],
    ['POST', '/api/lobby/chat', { text: '你好' }],
    ['POST', '/api/friends', { username: 'tester1' }],
    ['PUT', '/api/me/profile', { displayName: '改名' }],
  ] as const) {
    const r = await call(method, url, gc, body);
    assert.equal(r.status, 403, url);
    assert.match(r.data.error, /游客只能观看/);
  }

  // 一局公开的对局：开场、结算、公开的对白看得到；身份秘密、悄悄话、场外聊天、场外问答看不到
  const { roomId } = await startedRoom(
    [
      ['tester1', 'reporter', '林小满'],
      ['tester2', 'doctor', '许医生'],
    ],
    { isPublic: true, name: '公开观看测试' },
  );
  const doctorId = (await game(roomId, 'tester1')).others.find((o: any) => o.name === '许医生').id;
  const watch = await t.openStream(`/api/rooms/${roomId}/events`, gc);
  await watch.waitFor((e) => e.event === 'presence');
  assert.equal((await call('POST', `/api/rooms/${roomId}/chat`, 'tester1', { text: '场外聊天的内容' })).status, 201);
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '大家小心脚下' })).status, 201);
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '悄悄话的内容', to: doctorId })).status, 201);
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, 'tester2', { text: '？我能问问规则吗' })).status, 202);
  await t.app.engine.idle();
  await watch.waitFor((e) => e.event === 'log' && e.data.text === '大家小心脚下');

  const seen = await log(roomId, gc);
  const texts = JSON.stringify(seen);
  assert.ok(seen.some((e) => e.data?.type === 'opening'), '看得到开场');
  assert.ok(texts.includes('大家小心脚下'), '看得到公开的对白');
  for (const hidden of ['场外聊天的内容', '悄悄话的内容', '我能问问规则吗', '线人']) assert.ok(!texts.includes(hidden), `看不到：${hidden}`);
  assert.ok(!watch.events.some((e) => e.event === 'log' && JSON.stringify(e.data).includes('悄悄话的内容')), '推送里也没有悄悄话');

  const view = await game(roomId, gc);
  assert.equal(view.watching, true);
  assert.equal(view.manager, false);
  assert.equal(view.me, null);
  assert.deepEqual(view.clues, []);
  assert.equal(view.others.length, 2);
  assert.ok(!JSON.stringify(view).includes('线人'));
  // 观看不算在线
  const presence = (await call('GET', `/api/rooms/${roomId}`, gc)).data;
  assert.deepEqual(presence.viewer, { role: null, manager: false, watching: true, by: '管理员', requested: false });
  assert.ok(!presence.presence.online.includes(user.id));
  // 不能加入、不能发言、不能交行动
  assert.equal((await call('POST', `/api/hall/${roomId}/join`, gc)).status, 403);
  assert.equal((await call('POST', `/api/rooms/${roomId}/chat`, gc, { text: '我也说两句' })).status, 403);
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, gc, { text: '我来了' })).status, 403);
  watch.close();

  // 不公开的对局看不到（不说它存不存在）
  const { roomId: privateRoom } = await startedRoom([['tester3', 'reporter', '林三']]);
  assert.equal((await call('GET', `/api/rooms/${privateRoom}`, gc)).status, 404);
  assert.equal((await call('GET', `/api/rooms/${privateRoom}/log`, gc)).status, 404);
  assert.equal((await call('GET', `/api/rooms/${privateRoom}/game`, gc)).status, 404);
});

test('UID：从 0 开始按注册顺序编号，只有管理员看得到；身份分游客、普通用户、管理员、站长', async () => {
  const users = (await call('GET', '/api/admin/users', 'admin')).data.users as any[];
  const admin = users.find((u) => u.username === 'admin');
  assert.equal(admin.uid, 0);
  assert.equal(admin.identity, 'owner');
  assert.equal(admin.identityLabel, '站长');
  assert.equal(users.find((u) => u.username === 'tester1').identityLabel, '普通用户');
  assert.equal(users.find((u) => u.isGuest).identityLabel, '游客');
  const uids = users.map((u) => u.uid);
  assert.deepEqual(uids, [...uids].sort((a, b) => a - b), '按 UID 排');
  assert.equal(new Set(uids).size, uids.length);
  // 正式账号从 0 开始连续编号；游客是 8 位数，不占顺序号
  const memberUids = users.filter((u) => !u.isGuest).map((u) => u.uid);
  assert.deepEqual(memberUids, memberUids.map((_, i) => i));
  assert.ok(users.filter((u) => u.isGuest).every((u) => u.uid >= 10_000_000 && u.uid < 100_000_000));

  // 新注册的接着编号
  const invite = await call('POST', '/api/admin/invites', 'admin', { note: 'uid' });
  const reg = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username: 'newcomer',
    displayName: '新来的',
    password: 'newcomer-pass-1',
    agreeRules: true,
  });
  assert.equal(reg.status, 201);
  cookies.newcomer = reg.cookie!;
  const after = (await call('GET', '/api/admin/users', 'admin')).data.users as any[];
  assert.equal(after.find((u) => u.username === 'newcomer').uid, Math.max(...memberUids) + 1);
  // 普通用户看不到 UID
  assert.equal('uid' in (await call('GET', '/api/auth/me', 'newcomer')).data.user, false);
  assert.ok(!JSON.stringify((await call('GET', '/api/users/newcomer', 'tester1')).data).includes('"uid"'));
  assert.equal((await call('GET', '/api/admin/users', 'newcomer')).status, 403);
});

test('站长和管理员分级：只有站长能任命管理员、下发权限；管理员按权限做事，动不了其他管理员和站长；都记进操作记录', async () => {
  // 普通用户、管理员都不能任命
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'tester1', { role: 'admin' })).status, 403);

  const appointed = await call('PUT', `/api/admin/users/${userId('tester1')}/role`, 'admin', { role: 'admin', permissions: ['announce'] });
  assert.equal(appointed.status, 200, JSON.stringify(appointed.data));
  assert.equal(appointed.data.user.identity, 'admin');
  assert.deepEqual(appointed.data.user.permissions, ['announce']);
  const me = (await call('GET', '/api/auth/me', 'tester1')).data;
  assert.equal(me.user.isAdmin, true);
  assert.deepEqual(me.user.permissions, ['announce']);
  assert.equal(me.credit.unlimited, false, '管理员不会自动变成不限额度');

  // 有发公告的权限，没有别的
  assert.equal((await call('POST', '/api/admin/announcements', 'tester1', { title: '管理员的公告', body: '内容', audience: 'all' })).status, 201);
  const denied = await call('GET', '/api/admin/rooms', 'tester1');
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /管理所有对局/);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/ban`, 'tester1', { reason: '试试' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'tester1', { role: 'admin' })).status, 403, '管理员不能任命别人');
  // 账号列表里有备注、额度、封号原因：没有账号相关的权限看不到
  assert.equal((await call('GET', '/api/admin/users', 'tester1')).status, 403, '只能发公告的管理员看不到账号列表');

  // 没有「管理所有对局」：不公开的对局看不到
  const { roomId: privateRoom } = await startedRoom([['tester4', 'reporter', '林四']]);
  assert.equal((await call('GET', `/api/rooms/${privateRoom}`, 'tester1')).status, 404);

  // 再给封号权限：能封普通用户；站长、其他管理员封不了
  await call('PUT', `/api/admin/users/${userId('tester1')}/role`, 'admin', { role: 'admin', permissions: ['announce', 'ban'] });
  await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'admin', { role: 'admin' });
  assert.deepEqual(
    (await call('GET', '/api/admin/users', 'admin')).data.users.find((u: any) => u.username === 'tester2').permissions,
    ['users', 'ban', 'rooms', 'scenarios', 'invites', 'announce', 'reports'],
    '不写权限就给默认的几项',
  );
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/ban`, 'tester1', { reason: '测试封号' })).status, 200);
  const banOwner = await call('POST', `/api/admin/users/${userId('admin')}/ban`, 'tester1', { reason: '试试' });
  assert.equal(banOwner.status, 403);
  assert.match(banOwner.data.error, /站长的账号不能被封禁/);
  const banAdmin = await call('POST', `/api/admin/users/${userId('tester2')}/ban`, 'tester1', { reason: '试试' });
  assert.equal(banAdmin.status, 403);
  assert.match(banAdmin.data.error, /只有站长能对管理员封禁/);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester2')}/ban`, 'admin', { reason: '试试' })).status, 409, '管理员要先撤销身份才能封');
  assert.equal((await call('POST', `/api/admin/users/${userId('tester2')}/reset-password`, 'tester1')).status, 403);

  // 站长的身份不能在网页上改；游客不能当管理员
  assert.equal((await call('PUT', `/api/admin/users/${userId('admin')}/role`, 'admin', { role: 'user' })).status, 409);
  const guestId = (await call('GET', '/api/auth/me', cookies.guest1)).data.user.id;
  assert.equal((await call('PUT', `/api/admin/users/${guestId}/role`, 'admin', { role: 'admin' })).status, 400);

  // 撤销
  const demoted = await call('PUT', `/api/admin/users/${userId('tester1')}/role`, 'admin', { role: 'user' });
  assert.equal(demoted.data.user.identity, 'user');
  assert.deepEqual(demoted.data.user.permissions, []);
  assert.equal((await call('GET', '/api/admin/users', 'tester1')).status, 403);

  // 操作记录：站长看得到；默认权限里没有「查看操作记录」
  const audit = (await call('GET', '/api/admin/audit', 'admin')).data.entries as any[];
  for (const action of ['任命管理员', '改管理员权限', '封号', '发公告', '撤销管理员']) assert.ok(audit.some((e) => e.action === action), action);
  assert.ok(audit.find((e) => e.action === '封号').by.includes('tester1'));
  assert.equal((await call('GET', '/api/admin/audit', 'tester2')).status, 403);

  await call('POST', `/api/admin/users/${userId('tester5')}/unban`, 'admin');
  cookies.tester5 = await t.login(TESTER5.username, TESTER5.password);
  await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'admin', { role: 'user' });
});

test('后台备注和批量处理：发额度、封号、解封、删游客；做不了的跳过并说明原因', async () => {
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/note`, 'admin', { note: '常来玩的朋友' })).status, 200);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/note`, 'tester4', { note: 'x' })).status, 403);
  const list = (await call('GET', '/api/admin/users', 'admin')).data.users as any[];
  assert.equal(list.find((u) => u.username === 'tester3').note, '常来玩的朋友');

  const ids = [userId('tester3'), userId('tester4')];
  const credited = await call('POST', '/api/admin/users/batch', 'admin', { ids, op: 'credit', amount: 2, note: '活动' });
  assert.deepEqual(credited.data, { done: ids, skipped: [] });
  for (const who of ['tester3', 'tester4']) assert.equal((await call('GET', '/api/auth/me', who)).data.credit.total, 7);

  const banned = await call('POST', '/api/admin/users/batch', 'admin', { ids: [userId('tester4'), userId('admin')], op: 'ban', reason: '批量测试' });
  assert.deepEqual(banned.data.done, [userId('tester4')]);
  assert.equal(banned.data.skipped[0].id, userId('admin'));
  assert.match(banned.data.skipped[0].reason, /不能封禁自己/);
  assert.equal((await call('GET', '/api/rooms', 'tester4')).status, 401, '被封的人登录失效了');
  assert.deepEqual((await call('POST', '/api/admin/users/batch', 'admin', { ids: [userId('tester4')], op: 'unban' })).data.done, [userId('tester4')]);
  cookies.tester4 = await t.login(TESTER4.username, TESTER4.password);

  const { user: g } = await guest();
  const removed = await call('POST', '/api/admin/users/batch', 'admin', { ids: [g.id, userId('tester3')], op: 'delete-guests' });
  assert.deepEqual(removed.data.done, [g.id]);
  assert.match(removed.data.skipped[0].reason, /只能删除游客账号/);
  assert.equal(t.app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(g.id), undefined);
  assert.equal((await call('POST', '/api/admin/users/batch', 'admin', { ids: [], op: 'ban' })).status, 400);
});

test('公告：发给全服、某种身份的人、指定的人；铃铛上有未读数，开着网站的人马上收到；可以删', async () => {
  const stream = await t.openStream('/api/events', cookies.tester4);
  const before = (await badges('tester4')).announcements;
  const toUsers = await call('POST', '/api/admin/announcements', 'admin', { title: '给普通用户', body: '周末开团', audience: 'user' });
  assert.equal(toUsers.status, 201);
  const pushed = await stream.waitFor((e) => e.event === 'announcement' && e.data.title === '给普通用户');
  assert.equal(pushed.data.body, '周末开团');
  assert.equal((await badges('tester4')).announcements, before + 1);
  const guestList = (await call('GET', '/api/announcements', cookies.guest1)).data.items as any[];
  assert.ok(!guestList.some((a) => a.title === '给普通用户'), '游客收不到发给普通用户的');

  const picked = await call('POST', '/api/admin/announcements', 'admin', { title: '只给三号', body: '你的角色卡', audience: 'users', usernames: ['tester3'] });
  assert.equal(picked.status, 201);
  assert.ok((await call('GET', '/api/announcements', 'tester3')).data.items.some((a: any) => a.title === '只给三号'));
  assert.ok(!(await call('GET', '/api/announcements', 'tester4')).data.items.some((a: any) => a.title === '只给三号'));
  assert.equal((await call('POST', '/api/admin/announcements', 'admin', { title: 'x', body: 'y', audience: 'users', usernames: ['nobody-here'] })).status, 400);
  assert.equal((await call('POST', '/api/admin/announcements', 'tester3', { title: 'x', body: 'y', audience: 'all' })).status, 403);

  // 读了以后不再算未读；看不到的公告不能标已读
  assert.equal((await call('POST', `/api/announcements/${toUsers.data.id}/read`, 'tester4')).status, 200);
  assert.equal((await badges('tester4')).announcements, before);
  assert.equal((await call('POST', `/api/announcements/${picked.data.id}/read`, 'tester4')).status, 404);
  await call('POST', '/api/announcements/read-all', 'tester3');
  assert.equal((await badges('tester3')).announcements, 0);

  const adminList = (await call('GET', '/api/admin/announcements', 'admin')).data.announcements as any[];
  assert.equal(adminList.find((a) => a.id === picked.data.id).audienceLabel, '指定的人：测试玩家三');
  assert.equal(adminList.find((a) => a.id === toUsers.data.id).reads, 2, '四号点开读了，三号点了全部已读');
  assert.equal((await call('DELETE', `/api/admin/announcements/${picked.data.id}`, 'admin')).status, 200);
  assert.ok(!(await call('GET', '/api/announcements', 'tester3')).data.items.some((a: any) => a.title === '只给三号'));
  stream.close();
});

// 1×1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('个人资料和个人主页：改显示名、介绍、头像（只收真的图片）；可以不展示自己的对局', async () => {
  const updated = await call('PUT', '/api/me/profile', 'tester3', { displayName: '三号玩家', bio: '喜欢悬疑本', showRooms: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.displayName, '三号玩家');
  assert.equal(updated.data.showRooms, false);
  assert.equal((await call('GET', '/api/auth/me', 'tester3')).data.user.displayName, '三号玩家');
  assert.equal((await call('PUT', '/api/me/profile', 'tester3', { displayName: '' })).status, 400);
  assert.equal((await call('PUT', '/api/me/profile', 'tester3', { bio: '长'.repeat(201) })).status, 400);

  // 不展示对局：别人看不到，自己和管理员看得到
  const byOther = (await call('GET', `/api/users/${pid('tester3')}`, 'tester4')).data;
  assert.equal(byOther.user.bio, '喜欢悬疑本');
  assert.equal(byOther.user.publicId, pid('tester3'));
  assert.equal(byOther.user.username, undefined, '别人看不到用户名');
  assert.ok(!JSON.stringify(byOther).includes('"tester3"'));
  assert.equal((await call('GET', `/api/users/${pid('tester3')}`, 'tester3')).data.user.username, 'tester3', '自己看得到');
  assert.equal((await call('GET', `/api/users/${pid('tester3')}`, 'admin')).data.user.username, 'tester3', '管理员看得到');
  assert.equal(byOther.rooms, null);
  assert.equal(byOther.stats, null);
  assert.ok((await call('GET', '/api/users/tester3', 'tester3')).data.rooms.length > 0);
  assert.ok((await call('GET', '/api/users/tester3', 'admin')).data.rooms.length > 0);
  await call('PUT', '/api/me/profile', 'tester3', { showRooms: true });
  const shown = (await call('GET', '/api/users/tester3', 'tester4')).data;
  // V0.8.2 起四个数换成玩完的剧本、通关的地下城、达成的结局、成就（v082.test.ts）
  assert.deepEqual(Object.keys(shown.stats).sort(), ['achievements', 'dungeons', 'endings', 'scenarios']);
  assert.ok(shown.rooms.some((r: any) => r.characterName === '林三'), '战绩里有扮演过的角色');
  assert.equal((await call('GET', '/api/users/no-such-user', 'tester4')).status, 404);

  // 头像
  const dataUrl = (type: string, data: Buffer) => `data:${type};base64,${data.toString('base64')}`;
  const ok = await call('PUT', '/api/me/avatar', 'tester3', { image: dataUrl('image/png', PNG) });
  assert.equal(ok.status, 200);
  assert.match(ok.data.avatar, /^\/api\/avatars\/p-[0-9a-f]{16}\?v=\d+$/, '头像的地址里是公开编号，没有用户名');
  const res = await fetch(t.base + ok.data.avatar, { headers: { cookie: cookies.tester3 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await call('GET', '/api/users/tester3', 'tester4')).data.user.avatar, ok.data.avatar);
  // 冒充图片的东西、SVG（能带脚本）都不收
  assert.equal((await call('PUT', '/api/me/avatar', 'tester3', { image: dataUrl('image/png', Buffer.from('<script>alert(1)</script>')) })).status, 400);
  assert.equal((await call('PUT', '/api/me/avatar', 'tester3', { image: dataUrl('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')) })).status, 400);
  assert.equal((await call('PUT', '/api/me/avatar', 'tester3', { image: dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(210 * 1024)])) })).status, 413);
  assert.equal((await call('DELETE', '/api/me/avatar', 'tester3')).data.avatar, null);
  assert.equal((await fetch(t.base + ok.data.avatar, { headers: { cookie: cookies.tester3 } })).status, 404);
});

test('好友和私聊：申请、同意、私聊（实时收到、未读数）；屏蔽以后加不了好友、发不了私信，大厅聊天里也看不到他', async () => {
  const sent = await call('POST', '/api/friends', 'tester4', { username: 'tester5' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.relation, 'pending-out');
  assert.equal((await call('POST', '/api/friends', 'tester4', { username: 'tester5' })).status, 409);
  assert.ok((await notifications('tester5')).some((n) => n.kind === 'friend_request' && n.data.from.publicId === pid('tester4') && !('username' in n.data.from)));
  assert.equal((await badges('tester5')).friendRequests, 1);
  assert.equal((await call('POST', '/api/friends/tester5/messages', 'tester4', { text: '在吗' })).status, 403, '成为好友以后才能私聊');

  assert.equal((await call('POST', '/api/friends/tester4/accept', 'tester5')).data.relation, 'friends');
  assert.equal((await badges('tester5')).friendRequests, 0);
  assert.ok((await notifications('tester4')).some((n) => n.kind === 'friend_accepted'));
  assert.equal((await call('GET', '/api/users/tester5', 'tester4')).data.relation, 'friends');

  const stream = await t.openStream('/api/events', cookies.tester5);
  const dm = await call('POST', '/api/friends/tester5/messages', 'tester4', { text: '今晚开团吗' });
  assert.equal(dm.status, 201);
  const pushed = await stream.waitFor((e) => e.event === 'dm');
  assert.equal(pushed.data.message.text, '今晚开团吗');
  assert.equal(pushed.data.message.mine, false);
  assert.equal((await badges('tester5')).messages, 1);
  // 好友开着网站就显示在线
  const sender = await t.openStream('/api/events', cookies.tester4);
  await sender.waitFor((e) => e.event === 'badges');
  const friends = (await call('GET', '/api/friends', 'tester5')).data;
  const row = friends.friends.find((f: any) => f.publicId === pid('tester4'));
  assert.equal('username' in row, false, '好友列表里也没有用户名');
  assert.equal(row.unread, 1);
  assert.equal(row.last.text, '今晚开团吗');
  assert.equal(row.online, true);
  sender.close();
  await call('POST', '/api/friends/tester4/read', 'tester5');
  assert.equal((await badges('tester5')).messages, 0);
  const history = (await call('GET', '/api/friends/tester4/messages', 'tester5')).data.messages as any[];
  assert.deepEqual(history.map((m) => [m.text, m.mine, m.read]), [['今晚开团吗', false, true]]);

  // 大厅聊天：屏蔽以后看不到他说的话
  assert.equal((await call('POST', '/api/lobby/chat', 'tester4', { text: '四号在大厅说话' })).status, 201);
  const lobbyMessage = (await call('GET', '/api/lobby/chat', 'tester5')).data.messages.find((m: any) => m.text === '四号在大厅说话');
  // V0.7.0 多了头像框（frame）
  assert.deepEqual(Object.keys(lobbyMessage.user).sort(), ['avatar', 'displayName', 'frame', 'identity', 'publicId'], '大厅聊天里没有用户名');
  assert.equal((await call('POST', '/api/blocks', 'tester5', { user: pid('tester4') })).status, 200);
  assert.equal((await call('GET', '/api/users/tester4', 'tester5')).data.blocked, true);
  assert.equal((await call('GET', '/api/users/tester4', 'tester5')).data.relation, 'none', '屏蔽以后不再是好友');
  assert.ok(!(await call('GET', '/api/lobby/chat', 'tester5')).data.messages.some((m: any) => m.text === '四号在大厅说话'));
  assert.ok((await call('GET', '/api/lobby/chat', 'tester3')).data.messages.some((m: any) => m.text === '四号在大厅说话'), '别人照样看得到');
  assert.equal((await call('POST', '/api/friends', 'tester4', { username: 'tester5' })).status, 403);
  assert.equal((await call('POST', '/api/friends/tester5/messages', 'tester4', { text: '?' })).status, 403);
  assert.deepEqual((await call('GET', '/api/friends', 'tester5')).data.blocked.map((b: any) => b.publicId), [pid('tester4')]);
  assert.equal((await call('DELETE', '/api/blocks/tester4', 'tester5')).status, 200);
  assert.ok((await call('GET', '/api/lobby/chat', 'tester5')).data.messages.some((m: any) => m.text === '四号在大厅说话'));

  // 加好友只能填完整的用户名（大小写不分）：搜不到人，填显示名、公开编号、半个用户名都不行
  assert.equal((await call('GET', '/api/users?q=tester', 'tester4')).status, 404, '没有搜人的接口了');
  for (const wrong of ['tester', '测试玩家三', pid('tester3')]) {
    const r = await call('POST', '/api/friends', 'tester4', { username: wrong });
    assert.equal(r.status, 404, wrong);
    assert.match(r.data.error, /没有这个用户名/);
  }
  const exact = await call('POST', '/api/friends', 'tester4', { username: 'TESTER3' });
  assert.equal(exact.status, 201, JSON.stringify(exact.data));
  assert.equal((await call('DELETE', `/api/friends/${pid('tester3')}`, 'tester4')).status, 200, '撤回');
  stream.close();
});

test('邀请好友进对局：只能邀请好友，对方在通知里点加入就进来，不用对局码；可以拒绝、撤回', async () => {
  await befriend('tester3', 'tester5');
  await befriend('tester3', 'tester2');
  const room = await call('POST', '/api/rooms', 'tester3', { name: '邀请测试', maxPlayers: 4 });
  const roomId = room.data.room.id as number;
  assert.equal((await call('POST', `/api/rooms/${roomId}/invites`, 'tester3', { username: 'tester4' })).status, 403, '不是好友');
  const invited = await call('POST', `/api/rooms/${roomId}/invites`, 'tester3', { username: 'tester5' });
  assert.equal(invited.status, 201);
  assert.deepEqual(invited.data.invites.map((i: any) => i.publicId), [pid('tester5')]);
  const note = (await notifications('tester5')).find((n) => n.kind === 'room_invite' && n.data.roomId === roomId);
  assert.equal(note.data.roomName, '邀请测试');
  assert.equal(note.data.from.publicId, pid('tester3'));

  const accepted = await call('POST', `/api/rooms/${roomId}/invites/accept`, 'tester5');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.roomId, roomId);
  assert.ok((await call('GET', `/api/rooms/${roomId}`, 'tester5')).data.members.some((m: any) => m.publicId === pid('tester5') && !('username' in m)));
  assert.equal((await notifications('tester5')).find((n) => n.id === note.id).read, true, '处理过的邀请标成已读');
  assert.equal((await call('POST', `/api/rooms/${roomId}/invites/accept`, 'tester5')).status, 404, '邀请用过了');

  // 拒绝；撤回
  await call('POST', `/api/rooms/${roomId}/invites`, 'tester3', { user: pid('tester2') });
  assert.equal((await call('POST', `/api/rooms/${roomId}/invites/decline`, 'tester2')).status, 200);
  assert.deepEqual((await call('GET', `/api/rooms/${roomId}`, 'tester3')).data.invites, []);
  await call('POST', `/api/rooms/${roomId}/invites`, 'tester3', { username: 'tester2' });
  assert.equal((await call('DELETE', `/api/rooms/${roomId}/invites/tester2`, 'tester3')).status, 200);
  assert.equal((await call('POST', `/api/rooms/${roomId}/invites/accept`, 'tester2')).status, 404);
  // 普通成员不能邀请
  assert.equal((await call('POST', `/api/rooms/${roomId}/invites`, 'tester5', { username: 'tester3' })).status, 403);
});

test('大厅聊天、举报、意见和 bug 反馈：管理员收到通知，处理以后提交的人收到结果', async () => {
  const lobby = await t.openStream('/api/events', cookies.tester2);
  const posted = await call('POST', '/api/lobby/chat', 'tester1', { text: '有人一起玩吗' });
  assert.equal(posted.status, 201);
  await lobby.waitFor((e) => e.event === 'lobby-chat' && e.data.text === '有人一起玩吗');
  assert.equal((await call('POST', '/api/lobby/chat', 'tester1', { text: '' })).status, 400);
  assert.equal((await call('DELETE', `/api/lobby/chat/${posted.data.message.id}`, 'tester2')).status, 403, '不能删别人的');

  // 举报一条大厅聊天
  const report = await call('POST', '/api/reports', 'tester2', { kind: 'report', target: { type: 'lobby', id: posted.data.message.id }, body: '刷屏' });
  assert.equal(report.status, 201);
  assert.ok((await notifications('admin')).some((n) => n.kind === 'new_report' && n.data.reportId === report.data.id));
  assert.ok((await badges('admin')).admin >= 1);
  assert.equal((await call('POST', '/api/reports', 'tester2', { kind: 'report', username: 'tester2', body: '自己' })).status, 400);

  // 游客能报 bug、提意见，不能举报
  assert.equal((await call('POST', '/api/reports', cookies.guest1, { kind: 'report', username: 'tester1', body: 'x' })).status, 403);
  const bug = await call('POST', '/api/reports', cookies.guest1, {
    kind: 'bug',
    body: '大厅的按钮点了没反应',
    steps: '打开大厅，点观看',
    context: { page: '/hall', screen: '390x844', version: 'V0.2.0', errors: ['TypeError: x is undefined'], secret: '不该收' },
  });
  assert.equal(bug.status, 201);
  const bugs = (await call('GET', '/api/admin/reports?kind=bug', 'admin')).data.reports as any[];
  const row = bugs.find((r) => r.id === bug.data.id);
  assert.equal(row.steps, '打开大厅，点观看');
  assert.equal(row.context.page, '/hall');
  assert.deepEqual(row.context.errors, ['TypeError: x is undefined']);
  assert.ok(row.context.serverVersion && 'browser' in row.context);
  assert.equal('secret' in row.context, false, '只收约定的几项');
  assert.equal(row.from.identity, 'guest');

  const handled = await call('POST', `/api/admin/reports/${bug.data.id}/handle`, 'admin', { outcome: 'fixed', reply: '修好了，谢谢' });
  assert.equal(handled.status, 200);
  const reply = (await notifications(cookies.guest1)).find((n) => n.kind === 'report_reply');
  assert.deepEqual([reply.data.outcomeLabel, reply.data.reply], ['已修复', '修好了，谢谢']);
  const mine = (await call('GET', '/api/reports/mine', cookies.guest1)).data.reports as any[];
  assert.equal(mine[0].outcome, 'fixed');
  assert.equal((await call('POST', `/api/admin/reports/${bug.data.id}/handle`, 'tester2', { outcome: 'fixed' })).status, 403);

  // 管理员删掉别人的大厅聊天：留着记录，内容不给
  assert.equal((await call('DELETE', `/api/lobby/chat/${posted.data.message.id}`, 'admin')).status, 200);
  await lobby.waitFor((e) => e.event === 'lobby-chat-deleted' && e.data.id === posted.data.message.id);
  const gone = (await call('GET', '/api/lobby/chat', 'tester2')).data.messages.find((m: any) => m.id === posted.data.message.id);
  assert.deepEqual([gone.deleted, gone.text], [true, '']);
  assert.ok((await call('GET', '/api/admin/audit', 'admin')).data.entries.some((e: any) => e.action === '撤回大厅聊天'));
  lobby.close();
});

test('合并的输入框：「？」开头是问主持人；看起来是在问问题的会改成提问（指定是行动的不改）；悄悄做的同一地点的人看不到内容', async () => {
  const { roomId } = await startedRoom([
    ['tester1', 'reporter', '林一'],
    ['tester2', 'doctor', '许二'],
  ]);
  const asked = await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '？我现在知道些什么' });
  assert.equal(asked.status, 202);
  assert.equal(asked.data.kind, 'question');
  await t.app.engine.idle();
  let mine = await log(roomId, 'tester1');
  assert.ok(mine.some((e) => e.data?.type === 'question' && e.text === '我现在知道些什么'));
  assert.ok(mine.some((e) => e.data?.type === 'answer'));
  assert.equal((await game(roomId, 'tester1')).myAction, null, '提问不占行动');

  // 没加「？」，但主持人看出是在问问题：撤下行动，改成提问
  const auto = await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '我能看清楼梯上的脚印吗？' });
  assert.equal(auto.status, 201);
  assert.equal(auto.data.kind, 'action');
  await t.app.engine.idle();
  assert.equal((await game(roomId, 'tester1')).myAction, null);
  mine = await log(roomId, 'tester1');
  assert.ok(mine.some((e) => e.kind === 'system' && e.text.includes('改成了场外提问')));
  assert.ok(mine.some((e) => e.data?.type === 'question' && e.text === '我能看清楼梯上的脚印吗？'));

  // 指定是行动的不改
  await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '大声问老板娘：楼上住的是谁？', as: 'action' });
  await t.app.engine.idle();
  const kept = (await game(roomId, 'tester1')).myAction;
  assert.equal(kept.status, 'waiting');
  assert.ok(kept.gameMinutes > 0);
  assert.equal((await call('DELETE', `/api/rooms/${roomId}/actions/${kept.id}`, 'tester1')).status, 200);

  // 悄悄做：同一地点的人知道他交了行动，看不到内容
  await call('POST', `/api/rooms/${roomId}/act`, 'tester2', { text: '偷偷翻柜台的抽屉', secret: true });
  await t.app.engine.idle();
  const near = (await game(roomId, 'tester1')).nearby.find((n: any) => n.name === '许二');
  assert.equal(near.action.content, null);
  assert.equal(near.action.canAssist, false);
  assert.equal((await game(roomId, 'tester2')).myAction.secret, true);
});

test('对白、协助和给东西：同一地点的人马上看到对白（悄悄话只有对方）；协助跟着那个行动一起结算；东西可以交给同一地点的人', async () => {
  const { roomId } = await startedRoom([
    ['tester1', 'reporter', '林甲'],
    ['tester2', 'doctor', '许乙'],
    ['tester5', 'detective', '沈丙'],
  ]);
  const view = await game(roomId, 'tester1');
  const doctorId = view.others.find((o: any) => o.name === '许乙').id;
  const detectiveId = view.others.find((o: any) => o.name === '沈丙').id;
  assert.deepEqual(view.nearby.map((n: any) => n.name), ['许乙'], '侦探在二楼客房，不在同一个地点');

  // 对白
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '这旅店不对劲' })).data.heardBy.join(), '许乙');
  assert.ok((await log(roomId, 'tester2')).some((e) => e.data?.type === 'say' && e.text === '这旅店不对劲' && e.data.speaker === '林甲'));
  assert.ok(!(await log(roomId, 'tester5')).some((e) => e.text === '这旅店不对劲'), '不在场的人听不到');
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '小声点', to: detectiveId })).status, 409, '悄悄话只能说给在场的人');
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '只告诉你', to: doctorId })).status, 201);
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '' })).status, 400);

  // 协助：医生帮记者搜查，跟着记者的行动一起结算，只调用一次主持 AI
  const acted = await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '搜查大堂的柜台' });
  assert.equal(acted.status, 201);
  await t.app.engine.idle();
  const target = (await game(roomId, 'tester2')).nearby.find((n: any) => n.name === '林甲').action;
  assert.equal(target.content, '搜查大堂的柜台');
  assert.equal(target.canAssist, true);
  assert.equal((await call('POST', `/api/rooms/${roomId}/actions/${target.id}/assist`, 'tester5', {})).status, 409, '不在同一个地点不能协助');
  const estimatesBefore = fake.requests.filter((r) => r.output_config?.format).length;
  const assisted = await call('POST', `/api/rooms/${roomId}/actions/${target.id}/assist`, 'tester2', { note: '我举着灯' });
  assert.equal(assisted.status, 201, JSON.stringify(assisted.data));
  assert.equal(assisted.data.action.assisting, '林甲');
  await t.app.engine.idle();
  assert.equal(fake.requests.filter((r) => r.output_config?.format).length, estimatesBefore, '协助不用另外估时');
  assert.ok((await log(roomId, 'tester1')).some((e) => e.kind === 'system' && e.text.includes('许乙要协助你的行动')));
  assert.deepEqual((await game(roomId, 'tester1')).nearby.find((n: any) => n.name === '许乙').action.assisting, '林甲');
  assert.deepEqual((await game(roomId, 'tester2')).nearby.find((n: any) => n.name === '林甲').action.assistedBy, ['许乙']);

  const resolvesBefore = fake.requests.filter((r) => r.tools?.length).length;
  await pass(120);
  const resolves = fake.requests.filter((r) => r.tools?.length);
  const firstRound = resolves.slice(resolvesBefore).filter((r) => JSON.stringify(r.messages[0]).includes('搜查大堂的柜台'));
  assert.ok(firstRound.length >= 1);
  const context = JSON.stringify(firstRound[0].messages[0]);
  assert.ok(context.includes('在场协助这个行动的角色：许乙'), '主持人知道谁在协助');
  assert.ok(context.includes('这旅店不对劲'), '主持人看得到之前的对白');
  assert.ok(!resolves.slice(resolvesBefore).some((r) => JSON.stringify(r.messages[0]).includes('# 这次要结算的行动') && JSON.stringify(r.messages[0]).includes('协助林甲：')), '协助没有单独结算');
  assert.equal((await game(roomId, 'tester1')).myAction, null);
  assert.equal((await game(roomId, 'tester2')).myAction, null, '协助的行动也完成了');
  const assistRow = t.app.db.prepare('SELECT status FROM actions WHERE id = ?').get(assisted.data.action.id) as { status: string };
  assert.equal(assistRow.status, 'done');

  // 要协助的行动撤回了：协助也取消，告诉协助的人
  const again = await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '再翻一遍登记簿' });
  await t.app.engine.idle();
  await call('POST', `/api/rooms/${roomId}/actions/${again.data.action.id}/assist`, 'tester2', {});
  assert.equal((await call('DELETE', `/api/rooms/${roomId}/actions/${again.data.action.id}`, 'tester1')).status, 200);
  assert.equal((await game(roomId, 'tester2')).myAction, null);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.kind === 'system' && e.text.includes('你要协助的行动被撤回了')));

  // 给东西
  const [reporterId] = [view.me.id];
  t.app.db.prepare('UPDATE characters SET items = ? WHERE id = ?').run(JSON.stringify(['旧相机', '记者证']), reporterId);
  assert.equal((await call('POST', `/api/rooms/${roomId}/give`, 'tester1', { item: '旧相机', to: detectiveId })).status, 409, '不在同一个地点');
  assert.equal((await call('POST', `/api/rooms/${roomId}/give`, 'tester1', { item: '金条', to: doctorId })).status, 404);
  const given = await call('POST', `/api/rooms/${roomId}/give`, 'tester1', { item: '旧相机', to: doctorId });
  assert.deepEqual(given.data, { to: '许乙', item: '旧相机' });
  assert.deepEqual((await game(roomId, 'tester1')).me.items, ['记者证']);
  assert.deepEqual((await game(roomId, 'tester2')).me.items, ['旧相机']);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.data?.type === 'give' && e.text === '林甲把「旧相机」交给了许乙'));
  assert.ok(!(await log(roomId, 'tester5')).some((e) => e.data?.type === 'give'));
});

test('开局不用凑够剧本建议的人数，开局以后没建角色的人照样能建；房主开局时选这一局的主持模型；没开着页面的成员收到开局通知', async () => {
  const created = await call('POST', '/api/rooms', 'tester1', { name: '盟主令小局', maxPlayers: 4 });
  const roomId = created.data.room.id as number;
  await call('POST', '/api/rooms/join', 'tester2', { code: created.data.room.joinCode });
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, 'tester1', { key: 'mengzhu-ling' })).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${roomId}/character`, 'tester1', { roleKey: 'snow-sword', name: '白衣' })).status, 200);
  // 《盟主令》建议至少两个人，一个人也能开
  const started = await call('POST', `/api/rooms/${roomId}/status`, 'tester1', { status: 'running', dmModel: 'claude-sonnet-5-5' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.ok((await log(roomId, 'tester1')).some((e) => e.text === '对局开始了（主持：Sonnet 5.5）'));
  const state = await game(roomId, 'tester1');
  assert.deepEqual([state.dmModel.chosen, state.dmModel.current], ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.ok(state.dmModel.options.some((o: any) => o.model === 'claude-haiku-5-5' && o.name === 'Haiku 5.5' && o.price));

  // 没开着页面的成员收到通知；他的待办是“选身份”
  assert.ok((await notifications('tester2')).some((n) => n.kind === 'room_started' && n.data.roomId === roomId));
  const todo = (await call('GET', '/api/rooms', 'tester2')).data.rooms.find((r: any) => r.id === roomId).todo;
  assert.equal(todo.setup, 'make-character');
  const late = await call('PUT', `/api/rooms/${roomId}/character`, 'tester2', { roleKey: 'healer', name: '青衫' });
  assert.equal(late.status, 200);
  assert.ok(late.data.me.location, '直接进入故事');
  assert.ok((await log(roomId, 'tester1')).some((e) => e.text.includes('青衫') && e.text.includes('加入了故事')));

  // 结算用的是这一局选的模型
  await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '在山庄里走走' });
  await pass(120);
  const resolve = [...fake.requests].reverse().find((r) => r.tools?.length && JSON.stringify(r.messages[0]).includes('在山庄里走走'));
  assert.equal(resolve!.model, 'claude-sonnet-5-5');

  // 设置里还能换；普通成员不能换
  assert.equal((await call('PUT', `/api/rooms/${roomId}/model`, 'tester2', { dmModel: 'claude-haiku-5-5' })).status, 403);
  assert.equal((await call('PUT', `/api/rooms/${roomId}/model`, 'tester1', { dmModel: 'gpt-4' })).status, 400);
  const back = await call('PUT', `/api/rooms/${roomId}/model`, 'tester1', { dmModel: null });
  assert.equal(back.data.dmModel.chosen, null);
  assert.ok((await log(roomId, 'tester2')).some((e) => e.text.startsWith('房主把主持模型改回了跟随网站设置')));

  // 管理员改网站的默认模型：马上生效；单局选过的以单局为准；可以恢复默认
  const site = await call('PUT', '/api/admin/ai/models', 'admin', { models: { dm: 'claude-haiku-5-5' } });
  assert.equal(site.data.models.dm, 'claude-haiku-5-5');
  assert.equal(site.data.chosen.dm, true);
  assert.equal((await game(roomId, 'tester1')).dmModel.current, 'claude-haiku-5-5');
  await call('PUT', `/api/rooms/${roomId}/model`, 'tester1', { dmModel: 'claude-opus-5-5' });
  assert.equal((await game(roomId, 'tester1')).dmModel.current, 'claude-opus-5-5');
  assert.equal((await call('PUT', '/api/admin/ai/models', 'admin', { models: { dm: 'no-such-model' } })).status, 400);
  const restored = await call('PUT', '/api/admin/ai/models', 'admin', { models: { dm: null } });
  assert.equal(restored.data.models.dm, restored.data.defaults.dm);
  assert.equal(restored.data.chosen.dm, false);
  assert.ok((await call('GET', '/api/admin/audit', 'admin')).data.entries.some((e: any) => e.action === '切换 AI 模型'));
});

/** 用 node 自带的 http 发请求（fetch 不让改 Origin 这类头）。 */
function raw(base: string, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  const url = new URL(opts.path, base);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: opts.method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('网站防护：安全响应头；别的网站发来的改动请求一律拒绝；退出其他设备', async () => {
  const page = await raw(t.base, { method: 'GET', path: '/api/auth/me' });
  for (const header of ['x-frame-options', 'x-content-type-options', 'content-security-policy', 'cross-origin-opener-policy', 'permissions-policy']) {
    assert.ok(page.headers[header], header);
  }
  const json = { 'Content-Type': 'application/json', cookie: cookies.tester3 };
  const body = JSON.stringify({ text: '跨站发的' });
  const evil = await raw(t.base, { method: 'POST', path: '/api/lobby/chat', headers: { ...json, Origin: 'http://evil.example' }, body });
  assert.equal(evil.status, 403);
  assert.match(JSON.parse(evil.body).error, /请求来源不对/);
  const fetchSite = await raw(t.base, { method: 'POST', path: '/api/lobby/chat', headers: { ...json, 'Sec-Fetch-Site': 'cross-site' }, body });
  assert.equal(fetchSite.status, 403);
  const same = await raw(t.base, { method: 'POST', path: '/api/lobby/chat', headers: { ...json, Origin: t.base, 'Sec-Fetch-Site': 'same-origin' }, body });
  assert.equal(same.status, 201);
  // 看东西（GET）不检查来源
  assert.equal((await raw(t.base, { method: 'GET', path: '/api/hall', headers: { cookie: cookies.tester3, Origin: 'http://evil.example' } })).status, 200);

  // 退出其他设备：别的登录失效，现在这个还在
  const other = await t.login(TESTER3.username, TESTER3.password);
  assert.equal((await call('POST', '/api/auth/logout-others', 'tester3')).status, 200);
  assert.equal((await t.call('GET', '/api/rooms', undefined, other)).status, 401);
  assert.equal((await call('GET', '/api/rooms', 'tester3')).status, 200);
});

test('网站防护：登录、用对局码加入、大厅聊天有频率限制；设了网站域名以后别的域名来的请求不处理', async () => {
  const limited = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0, rateLimits: true, siteHosts: ['trpg.example.com'] });
  try {
    // 设了域名：用 IP 访问（不是本机地址）不处理；本机地址照样能用
    const wrongHost = await raw(limited.base, { method: 'GET', path: '/api/auth/me', headers: { Host: 'evil.example' } });
    assert.equal(wrongHost.status, 421);
    assert.equal((await raw(limited.base, { method: 'GET', path: '/api/auth/me', headers: { Host: 'trpg.example.com' } })).status, 200);
    assert.equal((await raw(limited.base, { method: 'GET', path: '/api/auth/me', headers: { Host: 'localhost:3000' } })).status, 200);

    const tester = await limited.login(TESTER1.username, TESTER1.password);
    // 从外面来的请求（经过 Cloudflare 隧道，带着访客的真实地址）
    const remote = (path: string, body: unknown, cookie?: string) =>
      raw(limited.base, {
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    let status = 0;
    let tries = 0;
    for (; tries < 40 && status !== 429; tries++) {
      // 每次换一个用户名：挡住的是“同一个地址试太多次”，不是某个账号输错太多次
      status = (await remote('/api/auth/login', { username: `nobody${tries}`, password: 'wrong-password' })).status;
    }
    assert.equal(status, 429, '同一个地址试太多次登录会被挡住');
    assert.equal(tries, 31);

    let joinStatus = 0;
    for (let i = 0; i < 31 && joinStatus !== 429; i++) joinStatus = (await remote('/api/rooms/join', { code: 'ZZZZZZ' }, tester)).status;
    assert.equal(joinStatus, 429, '一个个试对局码会被挡住');

    // 在这台电脑上打开的（自己测试时开好几个窗口）：按地址的限制不算
    for (let i = 0; i < 40; i++) assert.equal((await limited.call('POST', '/api/rooms/join', { code: 'ZZZZZZ' }, tester)).status, 404);
    for (let i = 0; i < 40; i++) assert.equal((await limited.call('POST', '/api/auth/login', { username: `local${i}`, password: 'wrong-password' })).status, 401);

    let chatStatus = 0;
    for (let i = 0; i < 9 && chatStatus !== 429; i++) {
      chatStatus = (await limited.call('POST', '/api/lobby/chat', { text: `刷屏${i}` }, tester)).status;
    }
    assert.equal(chatStatus, 429, '大厅聊天发太快会被挡住');
  } finally {
    await limited.close();
  }
});

test('npm run make-admin：在服务器那台电脑上设管理员、换站长（站长账号进不去时用）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-owner-'));
  const dbPath = path.join(dir, 'game.db');
  const db = openDatabase(dbPath);
  await seedTestData(db);
  db.close();
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '..', 'server', 'make-admin.ts'), ...args], {
      env: { ...process.env, DB_PATH: dbPath },
    });
  const owner = () => {
    const check = openDatabase(dbPath);
    try {
      return (check.prepare('SELECT username FROM users WHERE is_owner = 1').get() as { username: string }).username;
    } finally {
      check.close();
    }
  };
  try {
    assert.equal(owner(), 'admin');
    assert.match((await run('tester1')).stdout, /现在是管理员了/);
    assert.equal(owner(), 'admin', '已经有站长时，只设成管理员');
    assert.match((await run('tester2', '--owner')).stdout, /现在是站长了/);
    assert.equal(owner(), 'tester2');
    const check = openDatabase(dbPath);
    const old = check.prepare('SELECT is_admin, is_owner, admin_perms FROM users WHERE username = ?').get('admin') as any;
    check.close();
    assert.deepEqual([old.is_admin, old.is_owner], [1, 0]);
    assert.deepEqual(JSON.parse(old.admin_perms), [...ALL_PERMISSIONS], '原来的站长变成有全部权限的管理员');
    await assert.rejects(run('tester2', '--remove'), /不能直接取消/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V0.2.0 以前选的现成剧本：启动时照剧本文件补上身份固定的属性、专长、外貌，别的剧本不动', async () => {
  const roomOf = (name: string) => (t.app.db.prepare('SELECT id FROM rooms WHERE name = ?').get(name) as { id: number }).id;
  const stored = (roomId: number) =>
    JSON.parse((t.app.db.prepare('SELECT data FROM scenarios WHERE room_id = ?').get(roomId) as { data: string }).data) as { roles: any[] };
  const sheet = (r: any) => ({ key: r.key, attributes: r.attributes, specialties: r.specialties, appearance: r.appearance });
  // 「山寺夜话」还没选剧本：选上《雾港旅店》，存下来的这份有剧本设计好的固定属性
  const roomId = roomOf('山寺夜话');
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, 'admin', { key: 'fog-harbor-inn' })).status, 200);
  const designed = stored(roomId).roles.map(sheet);
  assert.ok(designed.every((r) => r.attributes && r.specialties.length === 2));
  // 改成 V0.2.0 以前存的样子：身份没有固定的属性、专长、外貌；再加一个剧本文件里没有的身份
  const old = stored(roomId);
  for (const r of old.roles) {
    delete r.attributes;
    delete r.specialties;
    delete r.appearance;
  }
  old.roles.push({ ...old.roles[0], key: 'removed-role', name: '以前有、现在删了的身份' });
  t.app.db.prepare('UPDATE scenarios SET data = ? WHERE room_id = ?').run(JSON.stringify(old), roomId);
  // 导入的剧本（不是现成的）：不补
  t.app.db.prepare("UPDATE scenarios SET source = 'imported' WHERE room_id = ?").run(roomId);
  t.app.engine.fillBuiltinRoleSheets();
  assert.equal(stored(roomId).roles[0].attributes, undefined, '导入的剧本不照着文件补');
  t.app.db.prepare("UPDATE scenarios SET source = 'builtin' WHERE room_id = ?").run(roomId);

  t.app.engine.fillBuiltinRoleSheets();
  const after = stored(roomId);
  assert.deepEqual(after.roles.slice(0, -1).map(sheet), designed, '照剧本文件补上了');
  assert.equal(after.roles.at(-1).attributes, undefined, '剧本文件里没有的身份不补，读的时候按顺序给默认的');
  // 网页上选身份时看到的就是剧本设计好的
  const g = await game(roomId, 'tester1');
  assert.deepEqual(g.scenario.roles.slice(0, -1).map(sheet), designed);
  assert.ok(g.scenario.roles.at(-1).attributes, '剧本文件里没有的身份照样有一套默认的');
  // 再做一次也不变
  const before = JSON.stringify(stored(roomId));
  t.app.engine.fillBuiltinRoleSheets();
  assert.equal(JSON.stringify(stored(roomId)), before);
});
