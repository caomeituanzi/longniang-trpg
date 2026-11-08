import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { createApp } from '../server/app';
import { MIGRATIONS } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { networkOf, WITHHELD_LABEL } from '../server/signup';
import { startTestApp } from './helpers';

// V0.4.5：开放注册（不用邀请码）、防一个人注册好几个号领初始额度、应急开关（一键暂停注册）。

const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;
const DAY = 24 * 3_600_000;
let now = Date.UTC(2026, 9, 27, 3, 0, 0);

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, body?: unknown, cookie = admin) => t.call(method, url, body, cookie);
const credit = (username: string) => (t.app.db.prepare('SELECT ai_credit_usd AS c FROM users WHERE username = ?').get(username) as { c: number }).c;
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const lastAudit = () => ({ ...(t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as object) }) as { action: string; detail: string };

/** 从某个网络地址（经 Cloudflare 隧道转进来）、带着某个浏览器编号注册。 */
async function register(o: { name: string; ip: string; device?: string; code?: string }) {
  const res = await fetch(`${t.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': o.ip, ...(o.device ? { cookie: `trpg_device=${o.device}` } : {}) },
    body: JSON.stringify({ inviteCode: o.code ?? '', username: o.name, displayName: o.name, password: 'password-123', agreeRules: true }),
  });
  const data = await res.json();
  const device = res.headers
    .getSetCookie()
    .find((c) => c.startsWith('trpg_device='))
    ?.split(';')[0]
    .slice('trpg_device='.length);
  return { status: res.status, data, device: device ?? o.device };
}

test('第 14 版的数据库；网络的分法：IPv4 按地址，IPv6 按前 64 位', () => {
  assert.match(MIGRATIONS[13], /CREATE TABLE signups/);
  assert.equal(networkOf('203.0.113.5'), '203.0.113.5');
  assert.equal(networkOf('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(networkOf('2001:db8:1:2::10'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:0DB8:0001:0002:abcd::1'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0:0::/64');
});

test('默认只能用邀请码；站长打开开放注册以后，不填邀请码也能注册，送「开放注册的初始额度」（默认 1 美元）', async () => {
  assert.deepEqual((await t.call('GET', '/api/auth/registration')).data, { mode: 'invite', paused: false });
  let r = await register({ name: 'open_zero', ip: '198.51.100.1' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '请填写邀请码');

  assert.equal((await call('PUT', '/api/admin/registration/mode', { mode: 'open' })).status, 200);
  assert.deepEqual(lastAudit(), { action: '改注册方式', detail: '只能用邀请码 → 开放注册' });
  assert.deepEqual((await t.call('GET', '/api/auth/registration')).data, { mode: 'open', paused: false });

  r = await register({ name: 'open_a', ip: '203.0.113.5' });
  assert.equal(r.status, 201);
  assert.equal(r.data.creditWithheld, undefined);
  assert.ok(r.device, '发了浏览器编号');
  assert.equal(credit('open_a'), 1);
  const settings = (await call('GET', '/api/admin/registration')).data;
  assert.deepEqual(settings, { mode: 'open', paused: false, openStartCredit: 1, openDailyTrials: 10, trialsToday: 1 });
});

test('同一个网络、同一个浏览器 30 天里只送一份；用邀请码注册的照常送；管理页看得到原因和可能是同一个人的账号', async () => {
  const first = await register({ name: 'open_b0', ip: '203.0.113.9' });
  assert.equal(credit('open_b0'), 1);
  // 同一个网络（没带浏览器编号）：不送
  let r = await register({ name: 'open_b1', ip: '203.0.113.9' });
  assert.equal(r.status, 201);
  assert.equal(r.data.creditWithheld, WITHHELD_LABEL.network);
  assert.equal(credit('open_b1'), 0);
  // 换了网络、还是同一个浏览器：不送
  r = await register({ name: 'open_b2', ip: '192.0.2.77', device: first.device });
  assert.equal(r.data.creditWithheld, WITHHELD_LABEL.device);
  assert.equal(credit('open_b2'), 0);
  // IPv6：同一个 /64 算同一个网络
  assert.equal((await register({ name: 'open_v6a', ip: '2001:db8:1:2::10' })).data.creditWithheld, undefined);
  assert.equal((await register({ name: 'open_v6b', ip: '2001:db8:1:2:abcd::1' })).data.creditWithheld, WITHHELD_LABEL.network);
  assert.equal((await register({ name: 'open_v6c', ip: '2001:db8:1:3::1' })).data.creditWithheld, undefined);

  // 开放注册的时候也能填邀请码：照常送「新账号的初始额度」（5 美元），网络、浏览器都不管
  const code = (await call('POST', '/api/admin/invites', { note: '朋友' })).data.invite.code as string;
  r = await register({ name: 'invited_b', ip: '203.0.113.9', device: first.device, code });
  assert.equal(r.status, 201);
  assert.equal(r.data.creditWithheld, undefined);
  assert.equal(credit('invited_b'), 5);
  // 填了不对的邀请码：报错，不会变成开放注册
  assert.equal((await register({ name: 'bad_code', ip: '198.51.100.7', code: 'NOPE1234' })).status, 400);

  // 管理页：列表里写着怎么注册的、为什么没送；详情里列出可能是同一个人的账号
  const users = (await call('GET', '/api/admin/users')).data.users as { username: string; signup: { via: string; withheld: string | null } | null }[];
  const find = (name: string) => users.find((u) => u.username === name)!;
  assert.deepEqual(find('open_b1').signup, { via: 'open', withheld: WITHHELD_LABEL.network });
  assert.deepEqual(find('open_b0').signup, { via: 'open', withheld: null });
  assert.deepEqual(find('invited_b').signup, { via: 'invite', withheld: null });
  assert.equal(find('tester1').signup, null, '以前注册的没有记录');
  const detail = (await call('GET', `/api/admin/users/${userId('open_b0')}`)).data;
  const related = Object.fromEntries((detail.related as { username: string; how: string[] }[]).map((x) => [x.username, x.how]));
  assert.deepEqual(related.open_b1, ['在同一个网络注册']);
  assert.deepEqual(related.open_b2, ['用同一个浏览器登录过']);
  assert.deepEqual(related.invited_b, ['用同一个浏览器登录过', '在同一个网络注册']);

  // 30 天以后，同一个网络又能领一份
  now += 31 * DAY;
  assert.equal((await register({ name: 'open_b3', ip: '203.0.113.9' })).data.creditWithheld, undefined);
  assert.equal(credit('open_b3'), 1);
});

test('浏览器登录过别的账号（登录、打开网页时记下来）：这个浏览器开放注册的新账号不送', async () => {
  const res = await fetch(`${t.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TESTER1.username, password: TESTER1.password }),
  });
  assert.equal(res.status, 200);
  const device = res.headers
    .getSetCookie()
    .find((c) => c.startsWith('trpg_device='))!
    .split(';')[0]
    .slice('trpg_device='.length);
  const r = await register({ name: 'alt_of_t1', ip: '198.51.100.20', device });
  assert.equal(r.data.creditWithheld, WITHHELD_LABEL.device);

  // 一直登录着、没再输过密码的账号：打开网页（问「我登录了吗」）时也记下这个浏览器
  const session = await t.login(TESTER2.username, TESTER2.password);
  const me = await fetch(`${t.base}/api/auth/me`, { headers: { cookie: `${session}; trpg_device=t2-browser-device-0001` } });
  assert.equal((await me.json()).user.username, TESTER2.username);
  assert.equal((await register({ name: 'alt_of_t2', ip: '198.51.100.21', device: 't2-browser-device-0001' })).data.creditWithheld, WITHHELD_LABEL.device);
});

test('每天送出的份数有上限；送的额度、上限都能改（要「发放额度」权限），0 就是不送', async () => {
  const today = (await call('GET', '/api/admin/registration')).data.trialsToday as number;
  let r = await call('PUT', '/api/admin/registration/trial', { amount: 3.34, currency: 'CNY', daily: today + 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.openDailyTrials, today + 1);
  assert.ok(Math.abs(r.data.openStartCredit - 3.34 / 6.68) < 1e-9);
  assert.match(lastAudit().detail, /→ ¥3\.34（约 0\.50 美元）、每天最多 \d+ 份$/);
  assert.equal((await register({ name: 'daily_1', ip: '192.0.2.101' })).data.creditWithheld, undefined);
  assert.ok(Math.abs(credit('daily_1') - 0.5) < 1e-9);
  assert.equal((await register({ name: 'daily_2', ip: '192.0.2.102' })).data.creditWithheld, WITHHELD_LABEL.daily);
  // 第二天又能送
  now += DAY;
  assert.equal((await register({ name: 'daily_3', ip: '192.0.2.103' })).data.creditWithheld, undefined);

  // 不送：谁都是 0，也不算「没送」
  assert.equal((await call('PUT', '/api/admin/registration/trial', { amount: 0, currency: 'USD', daily: 10 })).status, 200);
  const zero = await register({ name: 'zero_1', ip: '192.0.2.104' });
  assert.equal(zero.data.creditWithheld, undefined);
  assert.equal(credit('zero_1'), 0);
  // 范围
  assert.equal((await call('PUT', '/api/admin/registration/trial', { amount: 101, currency: 'USD', daily: 10 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/registration/trial', { amount: 1, currency: 'USD', daily: 1001 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/registration/trial', { amount: 1, currency: 'USD', daily: 10 })).status, 200);
});

test('应急开关：一键暂停注册，用邀请码注册、开放注册、新开游客都不行；已经有的账号照常用，管理员新建账号照常；恢复以后照旧', async () => {
  let r = await call('PUT', '/api/admin/registration/pause', { paused: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.paused, true);
  assert.equal(lastAudit().action, '暂停注册');
  assert.deepEqual((await t.call('GET', '/api/auth/registration')).data, { mode: 'open', paused: true });

  const paused = '现在暂停了新用户注册（游客也进不来），请过一段时间再来';
  const code = (await call('POST', '/api/admin/invites', {})).data.invite.code as string;
  const refused = await register({ name: 'during_pause', ip: '192.0.2.200', code });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, paused);
  assert.equal((await register({ name: 'during_pause2', ip: '192.0.2.201' })).status, 403);
  const guest = await t.call('POST', '/api/auth/guest');
  assert.equal(guest.status, 403);
  assert.equal(guest.data.error, paused);
  // 已经有的账号照常登录；管理员照常新建账号
  assert.equal((await t.call('POST', '/api/auth/login', { username: TESTER2.username, password: TESTER2.password })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'made_by_admin', displayName: '新建的' })).status, 201);

  // 没有「注册邀请码」权限的管理员动不了开关和注册方式
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, { role: 'admin', permissions: ['credit'] })).status, 200);
  const t2 = await t.login(TESTER2.username, TESTER2.password);
  assert.equal((await t.call('PUT', '/api/admin/registration/pause', { paused: false }, t2)).status, 403);
  assert.equal((await t.call('PUT', '/api/admin/registration/mode', { mode: 'invite' }, t2)).status, 403);
  assert.equal((await t.call('GET', '/api/admin/registration', undefined, t2)).status, 200, '能看');
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, { role: 'user' })).status, 200);

  r = await call('PUT', '/api/admin/registration/pause', { paused: false });
  assert.equal(r.data.paused, false);
  assert.deepEqual(lastAudit(), { action: '恢复注册', detail: '开放注册' });
  assert.equal((await register({ name: 'after_pause', ip: '192.0.2.202', code })).status, 201);
  assert.equal((await t.call('POST', '/api/auth/guest')).status, 201);

  // 改回只能用邀请码
  assert.equal((await call('PUT', '/api/admin/registration/mode', { mode: 'invite' })).status, 200);
  assert.equal((await register({ name: 'no_code_again', ip: '192.0.2.203' })).status, 400);
});

// ==================== 开局能选的主持模型（按房主的身份） ====================

const TESTER3 = TEST_ACCOUNTS[3];
const reporter = {
  name: '林小满',
  roleKey: 'reporter',
  attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 },
  specialties: ['打听消息', '速记'],
  appearance: '短头发，挂着相机',
  goal: '登上头版',
};
const doctor = { ...reporter, name: '许望舒', roleKey: 'doctor', specialties: ['急救', '辨认药物'], appearance: '', goal: '' };
const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);

test('开局能选的主持模型：默认普通用户只能选 DeepSeek 的、管理员都能选；站长按身份勾；跟随网站设置的不在范围里就用 DeepSeek 的小模型', async () => {
  // 老测试为了照旧，开头把普通用户设成了什么都能选：这里删掉，回到默认
  t.app.db.prepare("DELETE FROM settings WHERE key = 'dm_models_user'").run();
  const info = (await call('GET', '/api/admin/ai')).data;
  assert.deepEqual(info.dmModelGroups, {
    user: ['deepseek-v4-pro', 'deepseek-flash'],
    // 管理员默认什么都能选（V1.0.1 起也有经中转站调用的 ChatGPT 的四个）
    admin: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'deepseek-v4-pro', 'deepseek-flash', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
  });

  const t1 = await t.login(TESTER1.username, TESTER1.password);
  const room = (await as(t1)('POST', '/api/rooms', { name: '普通用户的局', maxPlayers: 2 })).data.room;
  const game = async () => (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data.dmModel;
  let m = await game();
  assert.deepEqual(
    m.options.map((o: { model: string }) => o.model),
    ['deepseek-v4-pro', 'deepseek-flash'],
  );
  assert.equal(m.siteDefault, 'deepseek-flash');
  let r = await as(t1)('PUT', `/api/rooms/${room.id}/model`, { dmModel: 'claude-opus-5-5' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '这一局的房主是普通用户，只能选：DeepSeek V4 Pro、DeepSeek V4.1 Flash 1017');
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/model`, { dmModel: 'deepseek-v4-pro' })).status, 200);
  assert.equal(t.app.ai.modelFor('resolve', room.id), 'deepseek-v4-pro');

  // 网站的主持模型换成 Opus：普通用户开的局「跟随网站设置」时还是 DeepSeek 的小模型，站长开的局用 Opus
  assert.equal((await call('PUT', '/api/admin/ai/models', { models: { dm: 'claude-opus-5-5' } })).status, 200);
  const ownerRoom = (await call('POST', '/api/rooms', { name: '站长的局', maxPlayers: 2 })).data.room;
  assert.equal(t.app.ai.modelFor('resolve', ownerRoom.id), 'claude-opus-5-5');
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/model`, { dmModel: null })).status, 200);
  assert.equal(t.app.ai.modelFor('resolve', room.id), 'deepseek-flash');
  assert.equal((await game()).siteDefault, 'deepseek-flash');

  // 站长改：普通用户只能用 Flash；只有站长能改；每种身份至少留一个
  r = await call('PUT', '/api/admin/ai/dm-model-groups', { user: ['deepseek-flash', 'claude-haiku-5-5'], admin: ['deepseek-flash'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.dmModelGroups, { user: ['claude-haiku-5-5', 'deepseek-flash'], admin: ['deepseek-flash'] });
  assert.match(lastAudit().detail, /^普通用户：Haiku 5\.5、DeepSeek V4\.1 Flash 1017；管理员：DeepSeek V4\.1 Flash 1017$/);
  m = await game();
  assert.deepEqual(
    m.options.map((o: { model: string }) => o.model),
    ['claude-haiku-5-5', 'deepseek-flash'],
  );
  assert.equal((await call('PUT', '/api/admin/ai/dm-model-groups', { user: [], admin: ['deepseek-flash'] })).status, 400);
  assert.equal((await call('PUT', '/api/admin/ai/dm-model-groups', { user: ['no-such-model'], admin: ['deepseek-flash'] })).status, 400);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, { role: 'admin', permissions: ['ai'] })).status, 200);
  const t2 = await t.login(TESTER2.username, TESTER2.password);
  assert.equal((await as(t2)('PUT', '/api/admin/ai/dm-model-groups', { user: ['deepseek-flash'], admin: ['deepseek-flash'] })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, { role: 'user' })).status, 200);
  // 改回默认的样子，免得影响后面
  await call('PUT', '/api/admin/ai/models', { models: { dm: null } });
});

// ==================== 大厅里加入要房主同意 ====================

test('大厅里加入公开的对局：先申请，房主同意了才进来；可以撤回、拒绝；房主邀请过的直接进；通知里有按钮和结果', async () => {
  const host = await t.login(TESTER1.username, TESTER1.password);
  const asker = await t.login(TESTER2.username, TESTER2.password);
  const pub = (await as(host)('POST', '/api/rooms', { name: '要申请的局', maxPlayers: 3, isPublic: true })).data.room;
  const askerId = (await as(asker)('GET', '/api/auth/me')).data.user.publicId as string;
  const notices = async (cookie: string, kind: string) => ((await as(cookie)('GET', '/api/notifications')).data.items as any[]).filter((n) => n.kind === kind);

  let r = await as(asker)('POST', `/api/hall/${pub.id}/join`);
  assert.deepEqual(r.data, { roomId: pub.id, requested: true });
  assert.equal((await as(asker)('GET', `/api/rooms/${pub.id}`)).data.viewer.requested, true);
  assert.equal(((await as(asker)('GET', '/api/hall')).data.rooms as any[]).find((x) => x.id === pub.id).requested, true);
  let detail = (await as(host)('GET', `/api/rooms/${pub.id}`)).data;
  assert.deepEqual(
    detail.joinRequests.map((x: { publicId: string }) => x.publicId),
    [askerId],
  );
  let request = (await notices(host, 'join_request'))[0];
  assert.equal(request.data.roomId, pub.id);
  assert.equal(request.state, 'pending');
  // 重复申请不重复通知；别人处理不了
  await as(asker)('POST', `/api/hall/${pub.id}/join`);
  assert.equal((await notices(host, 'join_request')).length, 1);
  assert.equal((await as(asker)('POST', `/api/rooms/${pub.id}/join-requests/${askerId}/approve`)).status, 404);

  // 撤回
  assert.equal((await as(asker)('DELETE', `/api/hall/${pub.id}/join`)).status, 200);
  assert.equal((await as(host)('GET', `/api/rooms/${pub.id}`)).data.joinRequests.length, 0);
  assert.equal((await notices(host, 'join_request'))[0].state, 'gone');
  // 拒绝
  await as(asker)('POST', `/api/hall/${pub.id}/join`);
  r = await as(host)('POST', `/api/rooms/${pub.id}/join-requests/${askerId}/reject`);
  assert.equal(r.status, 200);
  assert.equal(r.data.members.length, 1);
  assert.equal((await notices(asker, 'join_result'))[0].data.approved, false);
  // 同意
  await as(asker)('POST', `/api/hall/${pub.id}/join`);
  r = await as(host)('POST', `/api/rooms/${pub.id}/join-requests/${askerId}/approve`);
  assert.equal(r.status, 200);
  assert.ok(r.data.members.some((x: { publicId: string }) => x.publicId === askerId));
  const result = (await notices(asker, 'join_result'))[0];
  assert.deepEqual([result.data.roomId, result.data.approved, result.data.by], [pub.id, true, '房主']);
  assert.equal((await notices(host, 'join_request'))[0].state, 'joined');
  assert.equal((await as(host)('POST', `/api/rooms/${pub.id}/join-requests/${askerId}/approve`)).status, 404, '处理过了');

  // 房主邀请过的：在大厅里直接进来（邀请只能发给好友：先加好友）
  const invited = await t.login(TESTER3.username, TESTER3.password);
  const invitedId = (await as(invited)('GET', '/api/auth/me')).data.user.publicId as string;
  const hostId = (await as(host)('GET', '/api/auth/me')).data.user.publicId as string;
  assert.ok([200, 201].includes((await as(host)('POST', '/api/friends', { username: TESTER3.username })).status));
  assert.equal((await as(invited)('POST', `/api/friends/${hostId}/accept`)).status, 200);
  assert.equal((await as(host)('POST', `/api/rooms/${pub.id}/invites`, { user: invitedId })).status, 201);
  r = await as(invited)('POST', `/api/hall/${pub.id}/join`);
  assert.deepEqual(r.data, { roomId: pub.id, alreadyMember: false });
  // 满员了申请不了
  const late = await t.login(TEST_ACCOUNTS[4].username, TEST_ACCOUNTS[4].password);
  assert.equal((await as(late)('POST', `/api/hall/${pub.id}/join`)).status, 409);
});

// ==================== 有成员被封号：对局冻结到解封 ====================

test('一局里有成员被封号：冻结（进行中的暂停、不能继续、没开始的不能开局），解封以后解冻（冻结时进行中的自动接着进行）', async () => {
  const host = await t.login(TESTER1.username, TESTER1.password);
  const member = await t.login(TESTER2.username, TESTER2.password);
  const room = (await as(host)('POST', '/api/rooms', { name: '会被冻结的局', maxPlayers: 2 })).data.room;
  assert.equal((await as(member)('POST', '/api/rooms/join', { code: room.joinCode })).status, 200);
  await as(host)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' });
  assert.equal((await as(host)('PUT', `/api/rooms/${room.id}/character`, reporter)).status, 200);
  assert.equal((await as(member)('PUT', `/api/rooms/${room.id}/character`, doctor)).status, 200);
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  // 另一局还没开始
  const waiting = (await as(host)('POST', '/api/rooms', { name: '还没开始的局', maxPlayers: 2 })).data.room;
  assert.equal((await as(member)('POST', '/api/rooms/join', { code: waiting.joinCode })).status, 200);
  await as(host)('POST', `/api/rooms/${waiting.id}/scenario`, { key: 'fog-harbor-inn' });
  assert.equal((await as(host)('PUT', `/api/rooms/${waiting.id}/character`, reporter)).status, 200);

  assert.equal((await call('POST', `/api/admin/users/${userId('tester2')}/ban`, { reason: '测试冻结', hours: 1 })).status, 200);
  let detail = (await as(host)('GET', `/api/rooms/${room.id}`)).data;
  assert.equal(detail.room.status, 'paused');
  assert.equal(detail.room.frozen, true);
  const log = async (id: number) => ((await as(host)('GET', `/api/rooms/${id}/log`)).data.entries as { kind: string; text: string }[]).map((e) => e.text);
  assert.ok((await log(room.id)).includes('这一局有成员被封号了，先冻结起来，等他解封以后再继续'));
  let r = await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '这一局有成员被封号了，冻结到他解封以后才能继续');
  assert.equal((await as(host)('POST', `/api/rooms/${waiting.id}/status`, { status: 'running' })).status, 409, '没开始的不能开局');
  assert.equal((await as(host)('GET', `/api/rooms/${waiting.id}`)).data.room.status, 'preparing');

  // 定的时长到了，自动解封：冻结时进行中的那一局接着进行；没开始的那一局可以开局了
  now += 61 * 60_000;
  t.app.safety.liftExpiredBans();
  detail = (await as(host)('GET', `/api/rooms/${room.id}`)).data;
  assert.equal(detail.room.frozen, false);
  assert.equal(detail.room.status, 'running');
  assert.ok((await log(room.id)).includes('冻结解除了，对局继续'));
  assert.ok((await log(waiting.id)).includes('冻结解除了，可以开局了'));
  assert.equal((await as(host)('POST', `/api/rooms/${waiting.id}/status`, { status: 'running' })).status, 200);

  // 房主自己暂停着的：解封以后还是暂停，等房主来
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'paused' })).status, 200);
  await call('POST', `/api/admin/users/${userId('tester2')}/ban`, { reason: '再冻一次' });
  assert.equal((await as(host)('GET', `/api/rooms/${room.id}`)).data.room.frozen, true);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester2')}/unban`)).status, 200);
  detail = (await as(host)('GET', `/api/rooms/${room.id}`)).data;
  assert.deepEqual([detail.room.frozen, detail.room.status], [false, 'paused']);
  assert.ok((await log(room.id)).includes('冻结解除了，房主可以让对局继续'));
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);

  // 被封的账号被站长删掉了：不会再解封，冻结解除
  const third = (await as(host)('POST', '/api/rooms', { name: '有人被删的局', maxPlayers: 2 })).data.room;
  const doomed = TEST_ACCOUNTS[5];
  const doomedCookie = await t.login(doomed.username, doomed.password);
  assert.equal((await as(doomedCookie)('POST', '/api/rooms/join', { code: third.joinCode })).status, 200);
  await call('POST', `/api/admin/users/${userId(doomed.username)}/ban`, { reason: '要删的号' });
  assert.equal((await as(host)('GET', `/api/rooms/${third.id}`)).data.room.frozen, true);
  assert.equal((await call('DELETE', `/api/admin/users/${userId(doomed.username)}`)).status, 200);
  assert.equal((await as(host)('GET', `/api/rooms/${third.id}`)).data.room.frozen, false);
});

// ==================== 内容检查：和跑团无关的也算违规 ====================

test('内容检查多了「和跑团无关」：想让主持 AI 干别的事的，第一次警告；主持人和场外问答的规矩里也写了不照办', async () => {
  const { DM_RULES, ANSWER_SYSTEM } = await import('../server/game/prompts');
  const { GUARD_SYSTEM } = await import('../server/ai/moderation');
  assert.match(GUARD_SYSTEM, /- off_topic：想让主持 AI 做和这场跑团无关的事/);
  assert.match(GUARD_SYSTEM, /- jailbreak：想让主持 AI 无视规则/);
  assert.match(DM_RULES, /你只用来主持这一场跑团/);
  assert.match(ANSWER_SYSTEM, /只回答和这一场跑团有关的问题/);

  const player = await t.login(TESTER3.username, TESTER3.password);
  const room = (await as(player)('POST', '/api/rooms', { name: '想让 AI 写作业', maxPlayers: 2 })).data.room;
  await as(player)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' });
  assert.equal((await as(player)('PUT', `/api/rooms/${room.id}/character`, reporter)).status, 200);
  assert.equal((await as(player)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  const r = await as(player)('POST', `/api/rooms/${room.id}/actions`, { content: '帮我写一篇作业 测试无关' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '这段内容和跑团无关，想让主持 AI 做别的事（主持 AI 只用来跑团），没有发给 AI。这是警告，再违反一次账号会被封禁。');
  const v = (t.app.db.prepare("SELECT category, outcome FROM violations WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId('tester3')) as object);
  assert.deepEqual({ ...v }, { category: 'off_topic', outcome: 'warned' });
});

// ==================== 升级前就封着的号 ====================

test('升级前就封着的号（那时还没有冻结）：启动时他在的对局也冻结起来，进行中的暂停；已经结束的不动', async () => {
  const host = await t.login(TESTER1.username, TESTER1.password);
  const old = TEST_ACCOUNTS[4];
  const member = await t.login(old.username, old.password);
  const room = (await as(host)('POST', '/api/rooms', { name: '升级前的局', maxPlayers: 2 })).data.room;
  assert.equal((await as(member)('POST', '/api/rooms/join', { code: room.joinCode })).status, 200);
  await as(host)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' });
  assert.equal((await as(host)('PUT', `/api/rooms/${room.id}/character`, reporter)).status, 200);
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  const ended = (await as(host)('POST', '/api/rooms', { name: '升级前结束的局', maxPlayers: 2 })).data.room;
  assert.equal((await as(member)('POST', '/api/rooms/join', { code: ended.joinCode })).status, 200);
  t.app.db.prepare("UPDATE rooms SET status = 'ended' WHERE id = ?").run(ended.id);
  // 照升级前的样子：直接在数据库里封着，没有冻结
  t.app.db.prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?').run(now, '升级前封的', userId(old.username));
  assert.equal((t.app.db.prepare('SELECT frozen_at FROM rooms WHERE id = ?').get(room.id) as { frozen_at: number | null }).frozen_at, null);

  // 用同一个数据库再启动一次
  const file = (t.app.db.prepare('PRAGMA database_list').get() as { file: string }).file;
  const again = createApp({
    dbPath: file,
    webDist: path.join(path.dirname(file), 'dist'),
    scenarioDir: path.join(path.dirname(file), 'scenarios'),
    rateLimits: false,
    guestCleanup: false,
    ai: new FakeProvider(demoHandler),
    now: () => now,
    tickMs: 0,
  });
  try {
    const row = (id: number) => ({ ...(again.db.prepare('SELECT status, frozen_at IS NOT NULL AS frozen, frozen_paused FROM rooms WHERE id = ?').get(id) as object) });
    assert.deepEqual(row(room.id), { status: 'paused', frozen: 1, frozen_paused: 1 });
    assert.deepEqual(row(ended.id), { status: 'ended', frozen: 0, frozen_paused: 0 });
    const texts = (again.db.prepare('SELECT text FROM log_entries WHERE room_id = ?').all(room.id) as { text: string }[]).map((e) => e.text);
    assert.equal(texts.filter((x) => x === '这一局有成员被封号了，先冻结起来，等他解封以后再继续').length, 1);
  } finally {
    await again.close();
  }
  // 解封以后照常解冻、接着进行
  assert.equal((await call('POST', `/api/admin/users/${userId(old.username)}/unban`)).status, 200);
  const detail = (await as(host)('GET', `/api/rooms/${room.id}`)).data;
  assert.deepEqual([detail.room.frozen, detail.room.status], [false, 'running']);
});
