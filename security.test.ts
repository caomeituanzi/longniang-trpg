import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider, useTools } from '../server/ai/fake';
import { hashPassword } from '../server/auth';
import { MIGRATIONS, openDatabase } from '../server/db';
import { accountsWithDefaultPassword, TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, startTestApp } from './helpers';

// V0.2.0 发布前的安全审查发现的问题：悄悄做的内容外泄、管理员给自己发额度、退出登录后推送还在、取消公开后观看还在、
// 刷推送、撤回结算和给东西冲突、协助卡住、濒死还能说话给东西、举报管理员、删掉的消息、跨站 GET、锁别人的账号、UID 重复使用、升级的边界情况。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 26, 6, 0, 0);
/** 悄悄做影响到别人的测试：结算「在许二的茶里下药」时，主持人给这个角色加一格伤、塞一包药。 */
let poisonVictim: number | null = null;
const fake = new FakeProvider((request) => {
  const context = JSON.stringify(request.messages[0] ?? '');
  const resolving = context.slice(context.indexOf('# 这次要结算的行动'));
  const last = request.messages[request.messages.length - 1];
  const second = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b: { type: string }) => b.type === 'tool_result');
  if (poisonVictim !== null && request.tools?.length && resolving.includes('在许二的茶里下药') && !second) {
    return useTools({ name: 'update_character', input: { character: poisonVictim, wounds: 1, add_items: ['药包'], reason: '喝了下过药的茶' } });
  }
  return demoHandler(request);
});

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
const game = async (roomId: number, who: string) => (await call('GET', `/api/rooms/${roomId}/game`, who)).data;
const log = async (roomId: number, who: string) => (await call('GET', `/api/rooms/${roomId}/log`, who)).data.entries as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

async function guest(): Promise<string> {
  const g = await t.call('POST', '/api/auth/guest');
  assert.equal(g.status, 201, JSON.stringify(g.data));
  return g.cookie!;
}

/** 建一局《雾港旅店》、建好角色、开始。characters：[谁, 身份, 名字]；members：只加入、不建角色的人。 */
async function startedRoom(characters: [string, string, string][], opts: { isPublic?: boolean; members?: string[] } = {}) {
  const [host] = characters[0];
  const created = await call('POST', '/api/rooms', host, { name: '审查局', maxPlayers: 6, isPublic: opts.isPublic ?? false });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.room.id as number;
  for (const who of [...characters.slice(1).map((c) => c[0]), ...(opts.members ?? [])]) {
    assert.equal((await call('POST', '/api/rooms/join', who, { code: created.data.room.joinCode })).status, 200);
  }
  assert.equal((await call('POST', `/api/rooms/${roomId}/scenario`, host, { key: 'fog-harbor-inn' })).status, 200);
  for (const [who, roleKey, name] of characters) assert.equal((await call('PUT', `/api/rooms/${roomId}/character`, who, { roleKey, name })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${roomId}/status`, host, { status: 'running' })).status, 200);
  return roomId;
}

/** 不经过测试工具的请求：可以带上任意请求头（假装从别的网络地址、别的网站来）。 */
function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  const url = new URL(opts.path, t.base);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: opts.method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('悄悄做：结算的叙述只给自己；同一地点的人、观看的人都看不到；别人结算时主持人也看不到悄悄做的内容', async () => {
  const roomId = await startedRoom(
    [
      ['tester1', 'reporter', '林一'],
      ['tester2', 'doctor', '许二'],
    ],
    { isPublic: true },
  );
  const gc = await guest();
  const watch = await t.openStream(`/api/rooms/${roomId}/events`, gc);
  await watch.waitFor((e) => e.event === 'presence');

  const SECRET = '偷偷把柜台抽屉里的账本塞进怀里';
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, 'tester2', { text: SECRET, secret: true, as: 'action' })).status, 201);
  await t.app.engine.idle();
  // 让悄悄做的晚一点出结果：先结算林一的行动
  t.app.db.prepare('UPDATE actions SET due_at = due_at + 3600000 WHERE content = ?').run(SECRET);
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '和老板娘聊聊天气', as: 'action' })).status, 201);
  const before = fake.requests.length;
  await pass(30);
  const others = fake.requests.slice(before).map((r) => JSON.stringify(r.messages[0])).find((s) => s.includes('和老板娘聊聊天气'));
  assert.ok(others, '林一的行动结算了');
  assert.ok(!others.includes(SECRET), '别人结算时，主持人看不到悄悄做的内容');

  const beforeSecret = fake.requests.length;
  await pass(120);
  const own = fake.requests.slice(beforeSecret).map((r) => JSON.stringify(r.messages[0])).find((s) => s.includes(SECRET));
  assert.ok(own?.includes('做法：悄悄做'), '主持人知道这是悄悄做的');

  const mine = (await log(roomId, 'tester2')).find((e) => e.data?.type === 'resolution' && e.data.actor === '许二');
  assert.ok(mine, '自己看得到结果');
  assert.equal(mine.data.action, SECRET);
  assert.equal(mine.data.secret, true);
  assert.equal(mine.private, true);
  assert.ok(!(await log(roomId, 'tester1')).some((e) => e.data?.type === 'resolution' && e.data.actor === '许二'), '同一地点的人看不到');
  assert.ok(!(await log(roomId, gc)).some((e) => JSON.stringify(e).includes(SECRET)), '观看的人看不到');
  assert.ok(!watch.events.some((e) => JSON.stringify(e.data).includes(SECRET)), '推送里也没有');
  // 不是悄悄做的结算，观看的人照样看得到
  assert.ok((await log(roomId, gc)).some((e) => e.data?.type === 'resolution' && e.data.actor === '林一'));
  // 导出团录：同一地点的人导出的也没有
  const exported = await call('GET', `/api/rooms/${roomId}/export`, 'tester1');
  assert.ok(!exported.data.content.includes(SECRET));
  watch.close();
});

test('悄悄做的结果落到别人身上：他只收到自己身上的变化（不带行动的内容），观看的人看不到；撤回时一起撤掉', async () => {
  const roomId = await startedRoom(
    [
      ['tester1', 'reporter', '林十'],
      ['tester2', 'doctor', '许二'],
    ],
    { isPublic: true },
  );
  const victim = (await game(roomId, 'tester2')).me.id;
  poisonVictim = victim;
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '趁他不注意，在许二的茶里下药', secret: true, as: 'action' })).status, 201);
  await pass(180);
  poisonVictim = null;
  const mine = await game(roomId, 'tester2');
  assert.equal(mine.me.wounds, 1);
  assert.deepEqual(mine.me.items, ['药包']);
  const notes = (await log(roomId, 'tester2')).filter((e) => e.data?.type === 'private');
  const note = notes.find((e) => e.text.includes('许二身上起了变化'));
  assert.ok(note, '收到了自己身上的变化');
  assert.match(note.text, /伤势：没受伤 → 轻伤；得到：药包/);
  assert.match(note.text, /。还不知道是怎么回事。$/);
  assert.doesNotMatch(note.text, /你/);
  assert.ok(!JSON.stringify(await log(roomId, 'tester2')).includes('下药'), '看不到行动的内容');
  const gc = await guest();
  assert.ok(!(await log(roomId, gc)).some((e) => e.text.includes('身上起了变化')), '观看的人看不到');
  // 撤回这次结算：变化和这条私下的消息一起撤掉
  assert.equal((await call('POST', `/api/rooms/${roomId}/host/undo`, 'tester1', {})).status, 200);
  assert.equal((await game(roomId, 'tester2')).me.wounds, 0);
  assert.ok(!(await log(roomId, 'tester2')).some((e) => e.text.includes('身上起了变化')));
});

test('额度：没有站长身份的管理员不能给自己发额度（单个、批量都不行），可以给别人发', async () => {
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['credit', 'users'] })).status, 200);
  const self = await call('POST', `/api/admin/users/${userId('tester3')}/credit`, 'tester3', { amount: 1000, note: '给自己' });
  assert.equal(self.status, 400);
  assert.equal(self.data.error, '不能给自己改额度');
  const batch = await call('POST', '/api/admin/users/batch', 'tester3', { ids: [userId('tester3'), userId('tester4')], op: 'credit', amount: 1 });
  assert.deepEqual(batch.data.done, [userId('tester4')]);
  assert.equal(batch.data.skipped[0].id, userId('tester3'));
  assert.equal((await call('GET', '/api/auth/me', 'tester3')).data.credit.total, 5);
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'user' });
});

test('撤销管理员：不限额度也一起取消（升级前的管理员升级时被设成了不限额度）', async () => {
  await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'admin' });
  t.app.db.prepare('UPDATE users SET ai_unlimited = 1 WHERE id = ?').run(userId('tester4'));
  assert.equal((await call('GET', '/api/auth/me', 'tester4')).data.credit.unlimited, true);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'user' })).status, 200);
  const me = (await call('GET', '/api/auth/me', 'tester4')).data;
  assert.equal(me.user.identity, 'user');
  assert.equal(me.credit.unlimited, false);
});

test('没有账号相关权限的管理员看不到账号列表（里面有备注、额度、封号原因）', async () => {
  await call('PUT', `/api/admin/users/${userId('tester5')}/note`, 'admin', { note: '站长写的备注' });
  await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'admin', permissions: ['announce'] });
  assert.equal((await call('GET', '/api/admin/users', 'tester4')).status, 403);
  await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'admin', permissions: ['ban'] });
  const list = await call('GET', '/api/admin/users', 'tester4');
  assert.equal(list.status, 200);
  await call('PUT', `/api/admin/users/${userId('tester4')}/role`, 'admin', { role: 'user' });
});

test('退出其他设备、改密码：别的登录开着的推送马上断开，现在这个不受影响；退出登录也断开这次的；登录失效的连接下次心跳就断开', async () => {
  const other = await t.login(TESTER4.username, TESTER4.password);
  const otherStream = await t.openStream('/api/events', other);
  await otherStream.waitFor((e) => e.event === 'badges');
  const mine = await t.openStream('/api/events', cookies.tester4);
  await mine.waitFor((e) => e.event === 'badges');
  assert.equal((await call('POST', '/api/auth/logout-others', 'tester4')).status, 200);
  await otherStream.waitEnded();
  assert.equal(mine.ended, false);
  // 被退出的那个登录重新连也连不上
  assert.equal((await t.call('GET', '/api/events', undefined, other)).status, 401);

  const third = await t.login(TESTER4.username, TESTER4.password);
  const thirdStream = await t.openStream('/api/events', third);
  await thirdStream.waitFor((e) => e.event === 'badges');
  assert.equal((await call('POST', '/api/auth/password', 'tester4', { currentPassword: TESTER4.password, newPassword: TESTER4.password })).status, 200);
  await thirdStream.waitEnded();
  assert.equal(mine.ended, false);

  const fourth = await t.login(TESTER4.username, TESTER4.password);
  const fourthStream = await t.openStream('/api/events', fourth);
  await fourthStream.waitFor((e) => e.event === 'badges');
  assert.equal((await t.call('POST', '/api/auth/logout', undefined, fourth)).status, 200);
  await fourthStream.waitEnded();

  // 登录在数据库里没了（过期、被删）：下次心跳时断开
  const fifth = await t.login(TESTER4.username, TESTER4.password);
  const fifthStream = await t.openStream('/api/events', fifth);
  await fifthStream.waitFor((e) => e.event === 'badges');
  t.app.db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ? AND created_at = (SELECT MAX(created_at) FROM sessions WHERE user_id = ?)').run(userId('tester4'), userId('tester4'));
  t.app.hub.recheck();
  await fifthStream.waitEnded();
  assert.equal(mine.ended, false);
  mine.close();
});

test('取消公开：观看的人马上断开、重新连也连不上，成员不受影响；收回管理员的权限，他观看的连接也断开', async () => {
  const roomId = await startedRoom(
    [
      ['tester1', 'reporter', '林五'],
      ['tester2', 'doctor', '许五'],
    ],
    { isPublic: true },
  );
  const gc = await guest();
  const watch = await t.openStream(`/api/rooms/${roomId}/events`, gc);
  await watch.waitFor((e) => e.event === 'presence');
  const ownerWatch = await t.openStream(`/api/rooms/${roomId}/events`, cookies.admin);
  await ownerWatch.waitFor((e) => e.event === 'presence');
  const member = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await member.waitFor((e) => e.event === 'presence');

  assert.equal((await call('PUT', `/api/rooms/${roomId}/public`, 'tester1', { isPublic: false })).status, 200);
  await watch.waitEnded();
  await ownerWatch.waitEnded();
  assert.ok(watch.events.some((e) => e.event === 'room' && e.data.isPublic === false), '断开前先告诉他取消了公开');
  assert.equal(member.ended, false);
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/events`, undefined, gc)).status, 404, '游客重新连连不上');
  // 站长有权限：重新连照样能看
  const ownerAgain = await t.openStream(`/api/rooms/${roomId}/events`, cookies.admin);
  await ownerAgain.waitFor((e) => e.event === 'presence');
  ownerAgain.close();

  // 管理员在看这一局（不公开的），站长收回了他的权限
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['rooms'] });
  const adminWatch = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester3);
  await adminWatch.waitFor((e) => e.event === 'presence');
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['announce'] });
  await adminWatch.waitEnded();
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/events`, undefined, cookies.tester3)).status, 404);
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'user' });

  // 心跳检查：直接在数据库里取消公开（不走接口），下次心跳也会断开观看的人
  t.app.db.prepare('UPDATE rooms SET is_public = 1 WHERE id = ?').run(roomId);
  const gc2 = await guest();
  const watch2 = await t.openStream(`/api/rooms/${roomId}/events`, gc2);
  await watch2.waitFor((e) => e.event === 'presence');
  t.app.db.prepare('UPDATE rooms SET is_public = 0 WHERE id = ?').run(roomId);
  t.app.hub.recheck();
  await watch2.waitEnded();
  assert.equal(member.ended, false);
  member.close();
});

test('拒绝邀请：没有邀请的人点拒绝，不会让这一局的人刷新', async () => {
  const created = await call('POST', '/api/rooms', 'tester1', { name: '私密小局', maxPlayers: 3 });
  const roomId = created.data.room.id as number;
  const s = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester1);
  await s.waitFor((e) => e.event === 'presence');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/api/rooms/${roomId}/invites/decline`, 'tester5')).status, 200);
  await sleep(100);
  assert.equal(s.events.filter((e) => e.event === 'members').length, 0);
  s.close();
});

test('撤回结算：之后交换过的东西不会被撤掉、也不会变成两份；结算改过的角色之后又变过，就不能自动撤回', async () => {
  const roomId = await startedRoom([['tester1', 'reporter', '林六']], { members: ['tester2'] });
  const reporter = (await game(roomId, 'tester1')).me.id;
  t.app.db.prepare('UPDATE characters SET items = ? WHERE id = ?').run(JSON.stringify(['旧相机']), reporter);
  // 这次结算没改林六（只掷了骰子）
  await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '坐着发呆', as: 'action' });
  await pass(180);
  assert.equal((await game(roomId, 'tester1')).myAction, null);
  // 结算以后才加入的人；林六把相机给了他
  assert.equal((await call('PUT', `/api/rooms/${roomId}/character`, 'tester2', { roleKey: 'doctor', name: '许六' })).status, 200);
  const doctor = (await game(roomId, 'tester2')).me.id;
  assert.equal((await call('POST', `/api/rooms/${roomId}/give`, 'tester1', { item: '旧相机', to: doctor })).status, 200);
  const undo = await call('POST', `/api/rooms/${roomId}/host/undo`, 'tester1', {});
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.deepEqual((await game(roomId, 'tester1')).me.items, [], '给出去的没被撤回来');
  assert.deepEqual((await game(roomId, 'tester2')).me.items, ['旧相机'], '也没有变成两份');
  assert.ok((await log(roomId, 'tester2')).some((e) => e.data?.type === 'give'));

  // 这次结算让许六走到了账房（改了他）；之后房主又改了他的伤势：不能自动撤回
  await call('POST', `/api/rooms/${roomId}/act`, 'tester2', { text: '去账房看看', as: 'action' });
  await pass(180);
  assert.equal((await game(roomId, 'tester2')).me.location.key, 'ledger-room');
  const host = (await call('GET', `/api/rooms/${roomId}/host`, 'tester1')).data;
  assert.equal(host.last.blocked, null, '还没变过：能撤回');
  assert.equal((await call('PUT', `/api/rooms/${roomId}/host/characters/${doctor}`, 'tester1', { wounds: 1 })).status, 200);
  const blocked = (await call('GET', `/api/rooms/${roomId}/host`, 'tester1')).data.last.blocked;
  assert.match(blocked, /「许六」的状态又变过/);
  const refused = await call('POST', `/api/rooms/${roomId}/host/undo`, 'tester1', {});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /不能自动撤回/);
  // 改回去就又能撤回
  assert.equal((await call('PUT', `/api/rooms/${roomId}/host/characters/${doctor}`, 'tester1', { wounds: 0 })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${roomId}/host/undo`, 'tester1', {})).status, 200);
  assert.equal((await game(roomId, 'tester2')).me.location.key, 'lobby', '退回结算前的地点');
});

test('协助：被协助的行动因为濒死撤下时，协助也一起取消，协助的人可以重新交行动', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter', '林七'],
    ['tester2', 'doctor', '许七'],
  ]);
  const acted = await call('POST', `/api/rooms/${roomId}/act`, 'tester1', { text: '搜查大堂的柜台', as: 'action' });
  await t.app.engine.idle();
  const assist = await call('POST', `/api/rooms/${roomId}/actions/${acted.data.action.id}/assist`, 'tester2', {});
  assert.equal(assist.status, 201);
  // 出结果之前，林七受了重伤变成濒死（别的结算、房主改数值）
  t.app.db.prepare('UPDATE characters SET wounds = 3 WHERE id = ?').run((await game(roomId, 'tester1')).me.id);
  await pass(180);
  const status = (id: number) => (t.app.db.prepare('SELECT status FROM actions WHERE id = ?').get(id) as { status: string }).status;
  assert.equal(status(acted.data.action.id), 'withdrawn');
  assert.equal(status(assist.data.action.id), 'withdrawn');
  assert.ok((await log(roomId, 'tester2')).some((e) => e.kind === 'system' && e.text.includes('你要协助的行动')));
  assert.equal((await call('POST', `/api/rooms/${roomId}/act`, 'tester2', { text: '四处看看', as: 'action' })).status, 201);
});

test('濒死、失控的角色不能说话、不能给东西（场外聊天照样能用）', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter', '林八'],
    ['tester2', 'doctor', '许八'],
  ]);
  const me = (await game(roomId, 'tester1')).me.id;
  const doc = (await game(roomId, 'tester2')).me.id;
  t.app.db.prepare('UPDATE characters SET wounds = 3, items = ? WHERE id = ?').run(JSON.stringify(['怀表']), me);
  const give = await call('POST', `/api/rooms/${roomId}/give`, 'tester1', { item: '怀表', to: doc });
  assert.equal(give.status, 409);
  assert.match(give.data.error, /濒死/);
  assert.equal((await call('POST', `/api/rooms/${roomId}/say`, 'tester1', { text: '快跑' })).status, 409);
  assert.equal((await call('POST', `/api/rooms/${roomId}/chat`, 'tester1', { text: '我先挂机一会儿' })).status, 201);
  // 别人照样能给他东西
  t.app.db.prepare('UPDATE characters SET items = ? WHERE id = ?').run(JSON.stringify(['绷带']), doc);
  assert.equal((await call('POST', `/api/rooms/${roomId}/give`, 'tester2', { item: '绷带', to: me })).status, 200);
});

test('举报管理员：只告诉站长，别的管理员看不到、处理不了；管理员撤回的大厅消息不能再举报', async () => {
  await call('PUT', `/api/admin/users/${userId('tester3')}/role`, 'admin', { role: 'admin', permissions: ['reports'] });
  await call('PUT', `/api/admin/users/${userId('tester5')}/role`, 'admin', { role: 'admin', permissions: ['reports'] });
  const r = await call('POST', '/api/reports', 'tester1', { kind: 'report', username: 'tester3', body: '管理员滥用权限' });
  assert.equal(r.status, 201);
  const notes = async (who: string) => (await call('GET', '/api/notifications', who)).data.items as any[];
  for (const who of ['tester3', 'tester5']) {
    assert.ok(!(await notes(who)).some((n) => n.kind === 'new_report' && n.data.reportId === r.data.id), `${who} 没收到通知`);
    assert.ok(!(await call('GET', '/api/admin/reports', who)).data.reports.some((x: any) => x.id === r.data.id), `${who} 看不到`);
    assert.equal((await call('POST', `/api/admin/reports/${r.data.id}/handle`, who, { outcome: 'handled' })).status, 404, `${who} 处理不了`);
  }
  assert.ok((await notes('admin')).some((n) => n.kind === 'new_report' && n.data.reportId === r.data.id), '站长收到了');
  assert.ok((await call('GET', '/api/admin/reports', 'admin')).data.reports.some((x: any) => x.id === r.data.id));
  // 未读数：别的管理员不算这一条
  const open = (t.app.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE handled_at IS NULL').get() as { n: number }).n;
  assert.equal((await call('GET', '/api/me/badges', 'tester5')).data.adminReports, open - 1);
  assert.equal((await call('POST', `/api/admin/reports/${r.data.id}/handle`, 'admin', { outcome: 'handled', reply: '查过了' })).status, 200);
  // 举报普通用户：有权限的管理员照常处理
  const normal = await call('POST', '/api/reports', 'tester1', { kind: 'report', username: 'tester2', body: '刷屏' });
  assert.ok((await notes('tester5')).some((n) => n.kind === 'new_report' && n.data.reportId === normal.data.id));
  assert.equal((await call('POST', `/api/admin/reports/${normal.data.id}/handle`, 'tester5', { outcome: 'handled' })).status, 200);
  for (const who of ['tester3', 'tester5']) await call('PUT', `/api/admin/users/${userId(who)}/role`, 'admin', { role: 'user' });

  const posted = await call('POST', '/api/lobby/chat', 'tester1', { text: '要被管理员撤回的话' });
  assert.equal((await call('DELETE', `/api/lobby/chat/${posted.data.message.id}`, 'admin')).status, 200);
  const late = await call('POST', '/api/reports', 'tester4', { kind: 'report', target: { type: 'lobby', id: posted.data.message.id }, body: '骂人' });
  assert.equal(late.status, 409);
});

test('跨站请求：别的网站发来的、从别的网站点链接跳过来的接口请求（包括 GET）都拒绝；地址栏直接打开、本站页面发的照常', async () => {
  const roomId = await startedRoom([
    ['tester1', 'reporter', '林九'],
    ['tester2', 'doctor', '许九'],
  ]);
  const other = (await game(roomId, 'tester1')).others[0].id;
  const peek = (site: string) => raw({ method: 'GET', path: `/api/rooms/${roomId}/host?reveal=${other}`, headers: { cookie: cookies.tester1, 'Sec-Fetch-Site': site } });
  assert.equal((await peek('cross-site')).status, 403);
  assert.equal((await peek('same-site')).status, 403);
  assert.ok(!(await log(roomId, 'tester2')).some((e) => e.kind === 'system' && e.text.includes('房主查看了')), '没有留下记录');
  assert.equal((await peek('same-origin')).status, 200);
  assert.equal((await raw({ method: 'GET', path: '/api/auth/me', headers: { cookie: cookies.tester1, 'Sec-Fetch-Site': 'none' } })).status, 200);
  // 网页本身（不是接口）从别的网站点过来照常打开，比如别人发来的注册链接
  assert.notEqual((await raw({ method: 'GET', path: '/register', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('登录输错：只锁这个网络地址，别处照样能登录；没登录成功过的地方加起来输错太多次才锁整个账号，以前登录成功过的地方不受影响（别人锁不住站长）；管理员重置密码后解锁', async () => {
  const login = (ip: string, username: string, password: string) =>
    raw({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username, password }),
    });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await login('198.51.100.7', 'admin', 'wrong-password')).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  assert.equal((await login('198.51.100.7', 'admin', ADMIN.password)).status, 429, '这个地址锁住了，密码对了也不行');
  assert.equal((await login('198.51.100.8', 'admin', ADMIN.password)).status, 200, '站长在别处照样能登录');
  // 有人换着 5 个地址、每个输错 4 次（每个地址都没到 5 次）：整个账号对没登录成功过的地方锁定，站长常用的地方照样能登录
  for (let ip = 1; ip <= 5; ip++) for (let i = 0; i < 4; i++) await login(`192.0.2.${ip}`, 'admin', 'wrong-password');
  assert.equal((await login('192.0.2.99', 'admin', ADMIN.password)).status, 429, '没登录成功过的地方被锁');
  assert.equal((await login('198.51.100.8', 'admin', ADMIN.password)).status, 200, '登录成功过的地方不受影响');

  // 另一个账号：换着 20 个地址各输错一次，整个账号锁定
  const invite = await call('POST', '/api/admin/invites', 'admin', { note: '锁定测试' });
  const reg = await t.call('POST', '/api/auth/register', {
    inviteCode: invite.data.invite.code,
    username: 'locktest',
    displayName: '锁定测试',
    password: 'locktest-pass-1',
    agreeRules: true,
  });
  assert.equal(reg.status, 201);
  for (let i = 0; i < 19; i++) assert.equal((await login(`203.0.113.${i + 1}`, 'locktest', 'nope-nope')).status, 401);
  assert.equal((await login('203.0.113.100', 'locktest', 'nope-nope')).status, 429);
  const locked = await login('203.0.113.101', 'locktest', 'locktest-pass-1');
  assert.equal(locked.status, 429);
  assert.match(JSON.parse(locked.body).error, /暂时锁定/);
  const listed = (await call('GET', '/api/admin/users', 'admin')).data.users.find((u: any) => u.username === 'locktest');
  assert.equal(listed.locked, true);
  // 注册时用的地方（本机）算登录成功过：不受整个账号锁定的影响
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'locktest', password: 'locktest-pass-1' })).status, 200);
  // 再锁一次，管理员重置密码以后，没登录成功过的地方也马上能用临时密码登录
  for (let i = 0; i < 20; i++) await login(`203.0.113.${i + 150}`, 'locktest', 'nope-nope');
  assert.equal((await login('203.0.113.200', 'locktest', 'locktest-pass-1')).status, 429);
  const reset = await call('POST', `/api/admin/users/${listed.id}/reset-password`, 'admin');
  assert.equal(reset.status, 200);
  assert.equal((await login('203.0.113.200', 'locktest', reset.data.tempPassword)).status, 200);
  // 很久以前的输错不算：一小时前的 19 次加上现在的 1 次，不会锁
  for (let i = 0; i < 19; i++) await login(`203.0.113.${i + 1}`, 'locktest', 'nope-nope');
  now += 61 * MIN;
  assert.equal((await login('203.0.113.230', 'locktest', 'nope-nope')).status, 401);
  assert.equal((await login('203.0.113.231', 'locktest', reset.data.tempPassword)).status, 200);
});

test('UID：游客是随机的 8 位数，不占正式账号的号；删掉的正式账号的 UID 空出来，下一个新账号用空着的最小的号；游客的名字和用户名里没有 UID', async () => {
  const users = () => t.app.db.prepare('SELECT id, uid, username, is_guest FROM users').all() as { id: number; uid: number | null; username: string; is_guest: number }[];
  const lastMember = () => Math.max(...users().filter((u) => !u.is_guest && u.uid !== null).map((u) => u.uid as number));
  const before = lastMember();
  const g1 = (await t.call('POST', '/api/auth/guest')).data.user;
  assert.match(g1.username, /^guest-[0-9a-f]{12}$/);
  assert.match(g1.displayName, /^游客\d{4,6}$/);
  const uid1 = users().find((u) => u.username === g1.username)!.uid as number;
  assert.ok(uid1 >= 10_000_000 && uid1 < 100_000_000, `游客的 UID 是 8 位数：${uid1}`);
  assert.ok(!g1.username.includes(String(uid1)) && !g1.displayName.includes(String(uid1)));
  assert.deepEqual((await call('POST', '/api/admin/users/batch', 'admin', { ids: [g1.id], op: 'delete-guests' })).data.done, [g1.id]);
  const g2 = (await t.call('POST', '/api/auth/guest')).data.user;
  assert.notEqual(g2.username, g1.username);
  assert.ok((users().find((u) => u.username === g2.username)!.uid as number) >= 10_000_000);
  assert.equal(lastMember(), before, '游客不占顺序号');

  // 正式账号用空着的最小的号；删掉的正式账号的 UID 空出来，下一个新账号用上
  const register = async (username: string) => {
    const code = (await call('POST', '/api/admin/invites', 'admin', { note: username })).data.invite.code;
    const r = await t.call('POST', '/api/auth/register', { inviteCode: code, username, displayName: username, password: `${username}-pass-1`, agreeRules: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return users().find((u) => u.username === username)!;
  };
  const first = await register('uid_first');
  assert.equal(first.uid, before + 1);
  assert.equal((await call('DELETE', `/api/admin/users/${first.id}`, 'admin')).status, 200);
  assert.equal(users().find((u) => u.id === first.id)!.uid, null, '删掉的账号没有 UID 了');
  assert.equal((await register('uid_second')).uid, before + 1, '空出来的号给了下一个新账号');
});

test('启动时提醒还在用公开密码的测试账号：封了的不算（封了的登录不了）', async () => {
  assert.ok((await accountsWithDefaultPassword(t.app.db)).includes('tester5'));
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/ban`, 'admin', { reason: '测试账号不用了' })).status, 200);
  const open = await accountsWithDefaultPassword(t.app.db);
  assert.ok(!open.includes('tester5'));
  assert.ok(open.includes('tester1'));
});

/** 做一个 V0.1.0（数据库第 8 版）的数据库，让 V0.2.0 来升级。 */
async function oldDatabase(accounts: { username: string; admin?: boolean; banned?: boolean }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-mig9-'));
  const file = path.join(dir, 'game.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (8);');
  const hash = await hashPassword('password-1234');
  let at = 1_700_000_000_000;
  for (const a of accounts) {
    db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin, created_at, rules_agreed_at, banned_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      a.username,
      a.username,
      hash,
      a.admin ? 1 : 0,
      at,
      at,
      a.banned ? at : null,
    );
    at += 1000;
  }
  db.close();
  return { dir, file };
}

test('升级到 V0.2.0：站长是最早的、没被封的管理员（UID 0）；一个都没有就先没有站长；以后新账号用空着的最小的号', async () => {
  const a = await oldDatabase([{ username: 'alice' }, { username: 'oldboss', admin: true, banned: true }, { username: 'boss', admin: true }, { username: 'bob' }]);
  const db = openDatabase(a.file, { onBackup: () => {}, upTo: BEFORE_WIPE });
  const rows = db.prepare('SELECT username, uid, is_owner, ai_unlimited FROM users ORDER BY uid').all() as { username: string; uid: number; is_owner: number; ai_unlimited: number }[];
  assert.deepEqual(
    rows.map((r) => [r.username, r.uid, r.is_owner]),
    [
      ['boss', 0, 1],
      ['alice', 1, 0],
      ['oldboss', 2, 0],
      ['bob', 3, 0],
    ],
  );
  // 新账号接着编号；号空出来以后，下一个新账号用空着的最小的号
  db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('carol', 'carol', 'x', 1)").run();
  assert.equal((db.prepare("SELECT uid FROM users WHERE username = 'carol'").get() as { uid: number }).uid, 4);
  db.prepare("DELETE FROM users WHERE username = 'carol'").run();
  db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('dave', 'dave', 'x', 1)").run();
  assert.equal((db.prepare("SELECT uid FROM users WHERE username = 'dave'").get() as { uid: number }).uid, 4);
  db.close();
  fs.rmSync(a.dir, { recursive: true, force: true });

  const b = await oldDatabase([{ username: 'x' }, { username: 'y' }]);
  const db2 = openDatabase(b.file, { onBackup: () => {}, upTo: BEFORE_WIPE });
  assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 1').get() as { n: number }).n, 0);
  assert.deepEqual(
    (db2.prepare('SELECT username, uid FROM users ORDER BY uid').all() as { username: string; uid: number }[]).map((r) => [r.username, r.uid]),
    [
      ['x', 0],
      ['y', 1],
    ],
  );
  db2.close();
  fs.rmSync(b.dir, { recursive: true, force: true });
});
