import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { MIGRATIONS, openDatabase } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, sleep, startTestApp } from './helpers';

// 账号、对局、在线状态：用临时数据库启动一个完整的服务器，从外面像浏览器一样调用接口

let t: Awaited<ReturnType<typeof startTestApp>>;
let inviteCode = '';
const [ADMIN, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;

before(async () => {
  t = await startTestApp();
  inviteCode = t.inviteCode;
});

after(async () => {
  await t.close();
});

const call = (...args: Parameters<typeof t.call>) => t.call(...args);
const login = (username: string, password: string) => t.login(username, password);
const openStream = (url: string, cookie: string) => t.openStream(url, cookie);

test('测试账号能登录，未登录访问会被拒绝', async () => {
  const anonymous = await call('GET', '/api/auth/me');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.user, null);
  assert.equal((await call('GET', '/api/rooms')).status, 401);
  const cookie = await login(ADMIN.username, ADMIN.password);
  const me = await call('GET', '/api/auth/me', undefined, cookie);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, 'admin');
  assert.equal(me.data.user.isAdmin, true);

  const bad = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, '用户名或密码不对');
  // 不存在的用户名给出同样的提示
  const unknown = await call('POST', '/api/auth/login', { username: 'nobody', password: 'whatever123' });
  assert.equal(unknown.data.error, '用户名或密码不对');
});

test('连续输错5次密码会锁定，管理员重置后能用临时密码登录', async () => {
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/api/auth/login', { username: 'tester2', password: 'nope-nope' })).status, 401);
  }
  const fifth = await call('POST', '/api/auth/login', { username: 'tester2', password: 'nope-nope' });
  assert.equal(fifth.status, 429);
  // 锁定期间正确密码也不行
  const locked = await call('POST', '/api/auth/login', { username: 'tester2', password: TESTER2.password });
  assert.equal(locked.status, 429);

  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const users = await call('GET', '/api/admin/users', undefined, adminCookie);
  const tester2 = users.data.users.find((u: any) => u.username === 'tester2');
  assert.equal(tester2.locked, true);

  const reset = await call('POST', `/api/admin/users/${tester2.id}/reset-password`, undefined, adminCookie);
  assert.equal(reset.status, 200);
  const temp = reset.data.tempPassword as string;
  assert.equal((await call('POST', '/api/auth/login', { username: 'tester2', password: TESTER2.password })).status, 401);
  const cookie = await login('tester2', temp);

  // 自己把密码改回来
  const change = await call('POST', '/api/auth/password', { currentPassword: temp, newPassword: TESTER2.password }, cookie);
  assert.equal(change.status, 200);
  await login('tester2', TESTER2.password);
});

test('普通账号不能用管理员接口', async () => {
  const cookie = await login(TESTER1.username, TESTER1.password);
  assert.equal((await call('GET', '/api/admin/users', undefined, cookie)).status, 403);
  assert.equal((await call('POST', '/api/admin/invites', {}, cookie)).status, 403);
});

test('邀请码注册：只能用一次，用户名不能重复', async () => {
  const noInvite = await call('POST', '/api/auth/register', {
    inviteCode: 'WRONGCODE',
    username: 'newbie',
    displayName: '新人',
    password: 'newbie-pass-1',
    agreeRules: true,
  });
  assert.equal(noInvite.status, 400);

  // 没勾“同意使用规则”不能注册
  const noAgree = await call('POST', '/api/auth/register', {
    inviteCode,
    username: 'newbie',
    displayName: '新人',
    password: 'newbie-pass-1',
  });
  assert.equal(noAgree.status, 400);
  assert.match(noAgree.data.error, /使用规则/);

  const ok = await call('POST', '/api/auth/register', {
    inviteCode: inviteCode.toLowerCase(),
    username: 'newbie',
    displayName: '新人',
    password: 'newbie-pass-1',
    agreeRules: true,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(ok.cookie);
  const me = (await call('GET', '/api/auth/me', undefined, ok.cookie!)).data;
  assert.equal(me.user.displayName, '新人');
  assert.equal(me.user.rulesAgreed, true);
  assert.deepEqual(me.credit, { spent: 0, total: 5, unlimited: false, remaining: 5 }, '新账号默认 5 美元额度');

  const reused = await call('POST', '/api/auth/register', {
    inviteCode,
    username: 'another',
    displayName: '另一个',
    password: 'another-pass-1',
    agreeRules: true,
  });
  assert.equal(reused.status, 400);

  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const fresh = await call('POST', '/api/admin/invites', { note: '再来一个', days: 3 }, adminCookie);
  assert.equal(fresh.status, 201);
  const dupName = await call('POST', '/api/auth/register', {
    inviteCode: fresh.data.invite.code,
    username: 'NEWBIE',
    displayName: '撞名',
    password: 'another-pass-1',
    agreeRules: true,
  });
  assert.equal(dupName.status, 409);

  const badName = await call('POST', '/api/auth/register', {
    inviteCode: fresh.data.invite.code,
    username: '中文名',
    displayName: '中文名',
    password: 'another-pass-1',
    agreeRules: true,
  });
  assert.equal(badName.status, 400);

  const invites = await call('GET', '/api/admin/invites', undefined, adminCookie);
  const used = invites.data.invites.find((i: any) => i.code === inviteCode);
  assert.equal(used.status, 'used');
  assert.equal(used.usedBy.username, 'newbie');
});

test('使用规则：以前注册、还没同意过的账号，同意之前只能看规则、同意、改密码、退出登录', async () => {
  const cookie = await login(TESTER2.username, TESTER2.password);
  t.app.db.prepare("UPDATE users SET rules_agreed_at = NULL WHERE username = 'tester2'").run();
  try {
    const me = await call('GET', '/api/auth/me', undefined, cookie);
    assert.equal(me.data.user.rulesAgreed, false);
    const blocked = await call('GET', '/api/rooms', undefined, cookie);
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.error, /同意使用规则/);
    assert.equal((await call('POST', '/api/rooms', { name: '偷跑', maxPlayers: 2 }, cookie)).status, 403);

    const agreed = await call('POST', '/api/auth/agree-rules', {}, cookie);
    assert.equal(agreed.status, 200);
    assert.equal(agreed.data.user.rulesAgreed, true);
    assert.equal((await call('GET', '/api/rooms', undefined, cookie)).status, 200);
  } finally {
    t.app.db.prepare("UPDATE users SET rules_agreed_at = COALESCE(rules_agreed_at, 1) WHERE username = 'tester2'").run();
  }
});

test('对局：创建、用对局码加入、满员、非成员看不到；站长不用加入就能观看、能管', async () => {
  const hostCookie = await login(TESTER1.username, TESTER1.password);
  const created = await call('POST', '/api/rooms', { name: '两人小局', maxPlayers: 2 }, hostCookie);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.room.id as number;
  const code = created.data.room.joinCode as string;
  assert.equal(created.data.room.isHost, true);
  assert.match(code, /^[A-Z2-9]{6}$/);

  const memberCookie = await login(TESTER3.username, TESTER3.password);
  // 加入之前看不到这一局
  assert.equal((await call('GET', `/api/rooms/${roomId}`, undefined, memberCookie)).status, 404);
  assert.equal((await call('GET', `/api/rooms/${roomId}/log`, undefined, memberCookie)).status, 404);
  assert.equal((await call('POST', '/api/rooms/join', { code: 'XXXXXX' }, memberCookie)).status, 404);

  // 站长（有「管理所有对局」权限）不用加入：打开就是观看，能看到对局码，能管
  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const watched = await call('GET', `/api/rooms/${roomId}`, undefined, adminCookie);
  assert.equal(watched.status, 200);
  assert.deepEqual(watched.data.viewer, { role: null, manager: true, watching: true, by: '站长', requested: false });
  assert.equal(watched.data.room.joinCode, code);

  const joined = await call('POST', '/api/rooms/join', { code: code.toLowerCase() }, memberCookie);
  assert.equal(joined.status, 200);
  assert.equal(joined.data.roomId, roomId);
  const detail = await call('GET', `/api/rooms/${roomId}`, undefined, memberCookie);
  assert.equal(detail.data.members.length, 2);
  assert.deepEqual(detail.data.viewer, { role: 'player', manager: false, watching: false, by: '管理员', requested: false });
  // 对局码只给房主（和能管的管理员）看
  assert.equal(detail.data.room.joinCode, null);

  const tester2Cookie = await login(TESTER2.username, TESTER2.password);
  const full = await call('POST', '/api/rooms/join', { code }, tester2Cookie);
  assert.equal(full.status, 409);

  const tooMany = await call('POST', '/api/rooms', { name: '七人局', maxPlayers: 7 }, hostCookie);
  assert.equal(tooMany.status, 400);

  // 只有房主（和管理员）能改状态；没选剧本不能开始
  assert.equal((await call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, memberCookie)).status, 403);
  const noScenario = await call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, hostCookie);
  assert.equal(noScenario.status, 409);
  assert.equal(noScenario.data.error, '先选一个剧本');
  assert.equal((await call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, adminCookie)).data.error, '先选一个剧本', '站长也能开始');
  assert.equal((await call('POST', `/api/rooms/${roomId}/status`, { status: 'paused' }, hostCookie)).status, 409);

  const mine = await call('GET', '/api/rooms', undefined, memberCookie);
  const names = mine.data.rooms.map((r: any) => r.name);
  assert.ok(names.includes('两人小局') && names.includes('六人局'));
});

test('大厅：公开的对局谁都看得到、能直接加入；不公开的看不到也不能直接加入；房主随时可以打开或关掉', async () => {
  const host = await login(ADMIN.username, ADMIN.password);
  const t1 = await login(TESTER1.username, TESTER1.password);
  const t2 = await login(TESTER2.username, TESTER2.password);
  const pub = (await call('POST', '/api/rooms', { name: '大厅里的两人局', maxPlayers: 2, isPublic: true }, host)).data.room;
  assert.equal(pub.isPublic, true);
  const priv = (await call('POST', '/api/rooms', { name: '不公开的局', maxPlayers: 2 }, host)).data.room;
  assert.equal(priv.isPublic, false);
  const hall = async (cookie: string) => (await call('GET', '/api/hall', undefined, cookie)).data.rooms as any[];
  assert.equal((await call('GET', '/api/hall')).status, 401, '要登录');

  // 打开着“我的对局”或大厅的人，公开的对局有变化时会收到通知
  const watching = await openStream('/api/events', t2);
  let list = await hall(t1);
  const row = list.find((r) => r.id === pub.id);
  assert.ok(row);
  assert.deepEqual(
    { host: row.host, members: row.members, limit: row.limit, full: row.full, joined: row.joined, status: row.status, scenario: row.scenario },
    { host: ADMIN.displayName, members: 1, limit: 2, full: false, joined: false, status: 'preparing', scenario: null },
  );
  assert.ok(!list.some((r) => r.id === priv.id), '不公开的不在大厅里');
  assert.ok(!JSON.stringify(list).includes(pub.joinCode), '大厅里不给对局码');

  // 不用对局码：在大厅里申请加入，房主同意了才进来（V0.4.5 起）
  const asked = await call('POST', `/api/hall/${pub.id}/join`, undefined, t1);
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.data, { roomId: pub.id, requested: true });
  assert.equal((await hall(t1)).find((r) => r.id === pub.id)?.requested, true);
  const t1Id = (await call('GET', '/api/auth/me', undefined, t1)).data.user.publicId as string;
  const approved = await call('POST', `/api/rooms/${pub.id}/join-requests/${t1Id}/approve`, undefined, host);
  assert.equal(approved.status, 200);
  assert.ok(approved.data.members.some((m: { publicId: string }) => m.publicId === t1Id));
  await watching.waitFor((e) => e.event === 'hall-changed' && e.data.roomId === pub.id);
  // 自己在的公开对局照常列在大厅里，标着已经加入（V0.4.1 起「我的对局」是单独的一页）
  assert.equal((await hall(t1)).find((r) => r.id === pub.id)?.joined, true);
  assert.equal((await hall(host)).find((r) => r.id === pub.id)?.joined, true, '房主自己的也照常列');
  assert.equal((await call('POST', `/api/hall/${pub.id}/join`, undefined, t1)).data.alreadyMember, true);
  // 满员了：显示已满，加不进去
  assert.equal((await hall(t2)).find((r) => r.id === pub.id).full, true);
  assert.equal((await call('POST', `/api/hall/${pub.id}/join`, undefined, t2)).status, 409);
  // 不公开的不能直接加入（不说它存不存在）
  assert.equal((await call('POST', `/api/hall/${priv.id}/join`, undefined, t2)).status, 404);
  assert.equal((await call('POST', '/api/hall/999999/join', undefined, t2)).status, 404);

  // 只有房主能改；改了以后成员页面和大厅都会收到通知，记录里告诉大家
  assert.equal((await call('PUT', `/api/rooms/${pub.id}/public`, { isPublic: false }, t1)).status, 403);
  const roomEvents = await openStream(`/api/rooms/${priv.id}/events`, host);
  const opened = await call('PUT', `/api/rooms/${priv.id}/public`, { isPublic: true }, host);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.room.isPublic, true);
  const pushed = await roomEvents.waitFor((e) => e.event === 'room');
  assert.deepEqual(pushed.data, { roomId: priv.id, status: 'preparing', isPublic: true });
  roomEvents.close();
  const logText = (await call('GET', `/api/rooms/${priv.id}/log`, undefined, host)).data.entries.map((e: any) => e.text);
  assert.ok(logText.includes('房主把这一局设成了公开：大厅里的人可以直接加入、观看'));
  assert.equal((await call('PUT', `/api/rooms/${pub.id}/public`, { isPublic: false }, host)).status, 200);
  list = await hall(t2);
  assert.ok(list.some((r) => r.id === priv.id) && !list.some((r) => r.id === pub.id));

  // 选了剧本：显示剧本的标题这些公开信息（不给真相），人数上限按剧本算
  assert.equal((await call('POST', `/api/rooms/${priv.id}/scenario`, { key: 'fog-harbor-inn' }, host)).status, 200);
  const withScenario = (await hall(t2)).find((r) => r.id === priv.id);
  assert.equal(withScenario.scenario.title, '雾港旅店');
  assert.deepEqual(withScenario.scenario.players, { min: 1, max: 6 });
  assert.equal(withScenario.limit, 2);
  assert.ok(!JSON.stringify(withScenario).includes('刘疤子'), '不给剧本的真相');

  // 结束了的移出大厅（V0.7.0）
  assert.equal((await call('POST', `/api/rooms/${priv.id}/status`, { status: 'ended' }, host)).status, 200);
  assert.ok(!(await hall(t2)).some((r) => r.id === priv.id));
  assert.equal((await call('GET', '/api/hall', undefined, t2)).data.ended, undefined, '没有「最近结束的」');
  assert.equal((await call('POST', `/api/hall/${priv.id}/join`, undefined, t2)).status, 409);
  watching.close();
});

test('笔记：每个对局各自独立，别人看不到', async () => {
  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const tester1Cookie = await login(TESTER1.username, TESTER1.password);
  const rooms = (await call('GET', '/api/rooms', undefined, adminCookie)).data.rooms as any[];
  const harbor = rooms.find((r) => r.name === '雾港旅店');
  const temple = rooms.find((r) => r.name === '山寺夜话');

  assert.equal((await call('PUT', `/api/rooms/${harbor.id}/note`, { content: '只给自己看的A' }, adminCookie)).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${temple.id}/note`, { content: '只给自己看的B' }, adminCookie)).status, 200);

  assert.equal((await call('GET', `/api/rooms/${harbor.id}/note`, undefined, adminCookie)).data.content, '只给自己看的A');
  assert.equal((await call('GET', `/api/rooms/${temple.id}/note`, undefined, adminCookie)).data.content, '只给自己看的B');
  // 同一局里的别人读到的是他自己的笔记
  const tester1Note = await call('GET', `/api/rooms/${harbor.id}/note`, undefined, tester1Cookie);
  assert.notEqual(tester1Note.data.content, '只给自己看的A');

  // 不在这一局的人读不到
  const tester2Cookie = await login(TESTER2.username, TESTER2.password);
  assert.equal((await call('GET', `/api/rooms/${temple.id}/note`, undefined, tester2Cookie)).status, 404);
});

test('笔记分享：分享给指定的人，对方只能看；改了实时推过去，取消分享后对方就看不到了', async () => {
  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const tester1Cookie = await login(TESTER1.username, TESTER1.password);
  const tester2Cookie = await login(TESTER2.username, TESTER2.password);
  const idOf = async (cookie: string) => (await call('GET', '/api/auth/me', undefined, cookie)).data.user.id as number;
  const [adminId, tester1Id] = [await idOf(adminCookie), await idOf(tester1Cookie)];
  const harbor = ((await call('GET', '/api/rooms', undefined, adminCookie)).data.rooms as any[]).find((r) => r.name === '雾港旅店');
  const url = `/api/rooms/${harbor.id}`;
  const sharedTo = async (cookie: string) => (await call('GET', `${url}/shared-notes`, undefined, cookie)).data.notes as any[];

  assert.equal((await call('PUT', `${url}/note`, { content: '老板娘在撒谎' }, adminCookie)).status, 200);
  assert.ok(!(await sharedTo(tester1Cookie)).some((n) => n.author.id === adminId), '没分享之前别人看不到');

  // 只能分享给这一局里的人；分享给自己没有意义，忽略掉
  assert.equal((await call('PUT', `${url}/note/sharing`, { userIds: [999999] }, adminCookie)).status, 400);
  assert.deepEqual((await call('PUT', `${url}/note/sharing`, { userIds: [adminId] }, adminCookie)).data.sharedWith, []);

  const shared = await call('PUT', `${url}/note/sharing`, { userIds: [tester1Id] }, adminCookie);
  assert.deepEqual(shared.data.sharedWith, [tester1Id]);
  assert.deepEqual((await call('GET', `${url}/note`, undefined, adminCookie)).data.sharedWith, [tester1Id]);
  const seen = (await sharedTo(tester1Cookie)).find((n) => n.author.id === adminId);
  assert.equal(seen.content, '老板娘在撒谎');
  assert.equal(seen.author.displayName, '测试管理员');
  assert.ok(!(await sharedTo(tester2Cookie)).some((n) => n.author.id === adminId), '没分享给的人还是看不到');

  // 改了笔记，开着页面的人马上收到
  const stream = await openStream(`${url}/events`, tester1Cookie);
  await stream.waitFor((e) => e.event === 'presence');
  let mark = stream.events.length;
  await call('PUT', `${url}/note`, { content: '老板娘在撒谎，地窖有问题' }, adminCookie);
  const pushed = await stream.waitFor((e) => e.event === 'shared-note' && e.data.author.id === adminId, mark);
  assert.equal(pushed.data.content, '老板娘在撒谎，地窖有问题');

  // 取消分享
  mark = stream.events.length;
  assert.deepEqual((await call('PUT', `${url}/note/sharing`, { userIds: [] }, adminCookie)).data.sharedWith, []);
  await stream.waitFor((e) => e.event === 'shared-note-removed' && e.data.authorId === adminId, mark);
  assert.ok(!(await sharedTo(tester1Cookie)).some((n) => n.author.id === adminId));
  stream.close();
});

test('在线状态按对局算，全员在线时切到回合模式；场外聊天实时推送', async () => {
  const adminCookie = await login(ADMIN.username, ADMIN.password);
  const tester1Cookie = await login(TESTER1.username, TESTER1.password);
  const rooms = (await call('GET', '/api/rooms', undefined, adminCookie)).data.rooms as any[];
  const temple = rooms.find((r) => r.name === '山寺夜话'); // 成员：tester1（房主）、admin
  const harbor = rooms.find((r) => r.name === '雾港旅店');

  const lobby = await openStream('/api/events', adminCookie);
  const adminStream = await openStream(`/api/rooms/${temple.id}/events`, adminCookie);
  const first = await adminStream.waitFor((e) => e.event === 'presence');
  assert.deepEqual(first.data.online, [(await call('GET', '/api/auth/me', undefined, adminCookie)).data.user.id]);
  assert.equal(first.data.mode, 'timed');

  const mark = adminStream.events.length;
  const tester1Stream = await openStream(`/api/rooms/${temple.id}/events`, tester1Cookie);
  const both = await adminStream.waitFor((e) => e.event === 'presence' && e.data.allOnline, mark);
  assert.equal(both.data.mode, 'round');
  await lobby.waitFor((e) => e.event === 'room-presence' && e.data.roomId === temple.id && e.data.onlineCount === 2);

  // 另一局不受影响
  const harborDetail = await call('GET', `/api/rooms/${harbor.id}`, undefined, adminCookie);
  assert.equal(harborDetail.data.presence.online.length, 0);

  const chatMark = adminStream.events.length;
  const sent = await call('POST', `/api/rooms/${temple.id}/chat`, { text: '晚上好' }, tester1Cookie);
  assert.equal(sent.status, 201);
  const pushed = await adminStream.waitFor((e) => e.event === 'log' && e.data.text === '晚上好', chatMark);
  assert.equal(pushed.data.kind, 'ooc');
  assert.equal(pushed.data.author.displayName, '测试玩家一');

  const leaveMark = adminStream.events.length;
  tester1Stream.close();
  const left = await adminStream.waitFor((e) => e.event === 'presence' && !e.data.allOnline, leaveMark);
  assert.equal(left.data.mode, 'timed');

  adminStream.close();
  lobby.close();
  await sleep(50);

  const log = await call('GET', `/api/rooms/${temple.id}/log`, undefined, adminCookie);
  assert.ok(log.data.entries.some((e: any) => e.text === '晚上好'));
});

test('房主可以删除对局：成员收到推送，记录和笔记一起删掉，别人不能删', async () => {
  const hostCookie = await login(TESTER1.username, TESTER1.password);
  const memberCookie = await login(TESTER3.username, TESTER3.password);
  const tester2Cookie = await login(TESTER2.username, TESTER2.password);
  const created = await call('POST', '/api/rooms', { name: '要删的局', maxPlayers: 3 }, hostCookie);
  assert.equal(created.status, 201);
  const roomId = created.data.room.id as number;
  assert.equal((await call('POST', '/api/rooms/join', { code: created.data.room.joinCode }, memberCookie)).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${roomId}/note`, { content: '会被删掉的笔记' }, memberCookie)).status, 200);
  assert.equal((await call('POST', `/api/rooms/${roomId}/chat`, { text: '会被删掉的聊天' }, hostCookie)).status, 201);

  // 普通成员不能删，不在这一局的人连这一局都看不到
  assert.equal((await call('DELETE', `/api/rooms/${roomId}`, undefined, memberCookie)).status, 403);
  assert.equal((await call('DELETE', `/api/rooms/${roomId}`, undefined, tester2Cookie)).status, 404);

  const roomStream = await openStream(`/api/rooms/${roomId}/events`, memberCookie);
  await roomStream.waitFor((e) => e.event === 'presence');
  const lobby = await openStream('/api/events', memberCookie);

  const removed = await call('DELETE', `/api/rooms/${roomId}`, undefined, hostCookie);
  assert.equal(removed.status, 200);
  const pushed = await roomStream.waitFor((e) => e.event === 'deleted');
  assert.equal(pushed.data.name, '要删的局');
  await lobby.waitFor((e) => e.event === 'rooms-changed' && e.data.roomId === roomId);

  assert.equal((await call('GET', `/api/rooms/${roomId}`, undefined, hostCookie)).status, 404);
  const names = (await call('GET', '/api/rooms', undefined, memberCookie)).data.rooms.map((r: any) => r.name);
  assert.ok(!names.includes('要删的局'));
  const remaining = (table: string) =>
    (t.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(roomId) as { n: number }).n;
  for (const table of ['players', 'notes', 'log_entries']) assert.equal(remaining(table), 0, `${table} 里还有这一局的数据`);
  assert.equal((await call('DELETE', `/api/rooms/${roomId}`, undefined, hostCookie)).status, 404);

  roomStream.close();
  lobby.close();
});

test('“不计时”的对局人不齐也是回合模式；旧版网页发来的“始终计时”不管用', async () => {
  const cookie = await login(TESTER2.username, TESTER2.password);
  const otherCookie = await login(TESTER3.username, TESTER3.password);
  const untimed = await call('POST', '/api/rooms', { name: '不计时的局', maxPlayers: 2, untimed: true }, cookie);
  assert.equal(untimed.status, 201);
  assert.equal(untimed.data.room.untimed, true);
  assert.equal((await call('POST', '/api/rooms/join', { code: untimed.data.room.joinCode }, otherCookie)).status, 200);
  const stream = await openStream(`/api/rooms/${untimed.data.room.id}/events`, cookie);
  const presence = await stream.waitFor((e) => e.event === 'presence');
  assert.deepEqual([presence.data.allOnline, presence.data.untimed, presence.data.mode], [false, true, 'round']);
  stream.close();

  // 旧版网页建的“始终计时”单人局：和默认的一样，人在就是回合模式
  const created = await call('POST', '/api/rooms', { name: '单人局', maxPlayers: 1, alwaysTimed: true }, cookie);
  assert.equal(created.status, 201);
  assert.equal(created.data.room.untimed, false);
  const solo = await openStream(`/api/rooms/${created.data.room.id}/events`, cookie);
  const soloPresence = await solo.waitFor((e) => e.event === 'presence' && e.data.allOnline);
  assert.equal(soloPresence.data.mode, 'round');
  solo.close();
});

test('建对局不再选模型，一律由 Claude 主持；旧数据库升级后 DeepSeek 对局改成 Claude，老账号有了匿名编号', async () => {
  const cookie = await login(TESTER1.username, TESTER1.password);
  // 旧版网页或者手动发的请求里带了 model 也不看
  const created = await call('POST', '/api/rooms', { name: '想选DeepSeek', maxPlayers: 2, model: 'deepseek' }, cookie);
  assert.equal(created.status, 201);
  assert.equal(created.data.room.model, 'claude');

  // 升级前的数据库：只有第2版的表结构，里面有一局选了 DeepSeek
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-upgrade-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON');
  old.exec(MIGRATIONS[0]);
  old.exec(MIGRATIONS[1]);
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (2);');
  const host = old
    .prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('old', '老玩家', 'x', 0)")
    .run().lastInsertRowid;
  const room = old
    .prepare("INSERT INTO rooms (name, host_user_id, join_code, max_players, model, created_at) VALUES ('老局', ?, 'OLD001', 4, 'deepseek', 0)")
    .run(host).lastInsertRowid;
  // 旧版测试数据里的那句聊天
  old
    .prepare("INSERT INTO log_entries (room_id, kind, author_user_id, text, created_at) VALUES (?, 'ooc', ?, ?, 0)")
    .run(room, host, '这一局选的是DeepSeek，用来测试另一种模型的设置。');
  old.close();

  const upgraded = openDatabase(file, { upTo: BEFORE_WIPE });
  const row = upgraded.prepare('SELECT model FROM rooms WHERE id = ?').get(room) as { model: string };
  const chat = upgraded.prepare('SELECT text FROM log_entries WHERE room_id = ?').get(room) as { text: string };
  // 第4次升级：老账号也有了匿名编号
  const ref = upgraded.prepare('SELECT ai_ref FROM users WHERE id = ?').get(host) as { ai_ref: string | null };
  upgraded.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(row.model, 'claude');
  assert.ok(!chat.text.includes('DeepSeek'), chat.text);
  assert.match(ref.ai_ref ?? '', /^[0-9a-f]{32}$/);
});
