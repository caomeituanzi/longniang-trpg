import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse } from '../server/ai/types';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { setSetting } from '../server/settings';
import { OPUS_SETTINGS, startTestApp } from './helpers';

// 阶段4：每人的 AI 额度和花费归属、AI 总开关、管理后台（账号、封号、违规记录、所有对局）。
// 这里的假主持人按 Claude 的价格算钱：结算一次 0.4 美元，估时、问答 0.04，写剧本一步 0.2。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 25, 3, 0, 0);

/** 写了这个以后，下一次结算的第一步做完就把 AI 关掉（模拟结算到一半管理员紧急停用）。 */
let switchOffMidway = false;

function priced(req: MessagesRequest): MessagesResponse {
  const r = demoHandler(req);
  let tokens = 10_000;
  if (req.tools?.length) tokens = 100_000;
  if (req.system?.[0]?.text.includes('剧本作者')) tokens = 50_000;
  if (switchOffMidway && req.tools?.length && req.messages.length === 1) {
    switchOffMidway = false;
    setSetting(t.app.db, 'ai_enabled', '0');
  }
  return { ...r, usage: { input_tokens: tokens, output_tokens: 0 } };
}

const fake = new FakeProvider(priced);
fake.priced = true;
fake.guard = (text) =>
  text.includes('[违规]') ? { violation: true, category: 'sexual', reason: '测试用的违规' } : { violation: false, category: 'none', reason: '' };

let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};

before(async () => {
  // 额度、花费的数字是照 Opus 的价格写的
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0, aiSettings: OPUS_SETTINGS });
  for (const a of [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5]) cookies[a.username] = await t.login(a.username, a.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, who: string, body?: unknown) => t.call(method, url, body, cookies[who]);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const reporter = {
  name: '林小满',
  roleKey: 'reporter',
  attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 },
  specialties: ['打听消息', '速记'],
  appearance: '短头发，挂着相机',
  goal: '登上头版',
};
const detective = { ...reporter, name: '沈探', roleKey: 'detective', specialties: ['跟踪', '开锁'], appearance: '', goal: '' };

async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

/** 一个人开一局、选《雾港旅店》、建角色、开始（他不打开这一局的页面，是计时模式，用 pass 让时间过去）。 */
async function soloRoom(who: string, name = '额度测试') {
  const room = await call('POST', '/api/rooms', who, { name, maxPlayers: 2 });
  const id = room.data.room.id as number;
  assert.equal((await call('POST', `/api/rooms/${id}/scenario`, who, { key: 'fog-harbor-inn' })).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${id}/character`, who, reporter)).status, 200);
  assert.equal((await call('POST', `/api/rooms/${id}/status`, who, { status: 'running' })).status, 200);
  return { id, code: room.data.room.joinCode as string };
}

const credit = async (who: string) => (await call('GET', '/api/auth/me', who)).data.credit;

test('每人的 AI 额度：默认 5 美元；用完以后不能交新行动、提问，已经在等的照样结算；管理员发放、收回、设成不限', async () => {
  assert.deepEqual(await credit('tester1'), { spent: 0, total: 5, unlimited: false, remaining: 5 });
  assert.equal((await credit('admin')).unlimited, true, '管理员没有上限');

  // 管理员收回一部分，只剩 0.5 美元
  const take = await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'admin', { amount: -4.5, note: '测试收回' });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  assert.equal(take.data.credit.total, 0.5);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'admin', { amount: -1 })).status, 400, '不能收回比总额还多');
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'admin', { amount: 0 })).status, 400);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'tester1', { amount: 100 })).status, 403, '只有管理员能发');

  const room = await soloRoom('tester1');
  // 交行动时还有额度：估时 0.04，结算两步 0.8，加起来超过了也照样结算完
  assert.equal((await call('POST', `/api/rooms/${room.id}/actions`, 'tester1', { content: '在大堂里四处看看' })).status, 201);
  await pass(60);
  const state = (await call('GET', `/api/rooms/${room.id}/game`, 'tester1')).data;
  assert.equal(state.myAction, null, '已经在等的行动照样结算');
  assert.equal(state.credit.spent, 0.84);
  assert.ok(state.credit.remaining < 0);

  // 额度用完了：不能交新行动、不能提问
  const blocked = await call('POST', `/api/rooms/${room.id}/actions`, 'tester1', { content: '去厨房' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /额度用完了.*\$0\.84.*\$0\.50/);
  assert.equal((await call('POST', `/api/rooms/${room.id}/ask`, 'tester1', { question: '我能去哪' })).status, 403);

  // 管理员发放额度以后又能玩了；发放记录都留着
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'admin', { amount: 1, note: '再给一点' })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${room.id}/actions`, 'tester1', { content: '去厨房' })).status, 201);
  const detail = (await call('GET', `/api/admin/users/${userId('tester1')}`, 'admin')).data;
  assert.deepEqual(
    detail.grants.map((g: any) => [g.amount, g.note, g.by]),
    [
      [1, '再给一点', '测试管理员'],
      [-4.5, '测试收回', '测试管理员'],
    ],
  );
  assert.ok(detail.usage.byPurpose.some((p: any) => p.purpose === 'resolve' && p.cost === 0.8));
  assert.ok(detail.usage.recent.every((c: any) => c.room?.id === room.id));

  // 设成不限
  const unlimited = await call('PUT', `/api/admin/users/${userId('tester1')}/unlimited`, 'admin', { unlimited: true });
  assert.equal(unlimited.data.credit.unlimited, true);
  assert.equal(unlimited.data.credit.remaining, null);
  await call('PUT', `/api/admin/users/${userId('tester1')}/unlimited`, 'admin', { unlimited: false });
  await pass(60);
});

test('花费归属：自己的调用算自己的；生成剧本由这一局的人平摊，剧情笔记由有角色的玩家平摊', async () => {
  const host = await call('POST', '/api/rooms', 'tester2', { name: '平摊测试', maxPlayers: 3 });
  const roomId = host.data.room.id as number;
  assert.equal((await call('POST', '/api/rooms/join', 'tester3', { code: host.data.room.joinCode })).status, 200);
  const before2 = (await credit('tester2')).spent;
  const before3 = (await credit('tester3')).spent;

  const job = await call('POST', `/api/rooms/${roomId}/scenario/generate`, 'tester2', { genre: '民国悬疑', players: 3, days: 2 });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  await t.app.studio.idle();
  const spent2 = (await credit('tester2')).spent - before2;
  const spent3 = (await credit('tester3')).spent - before3;
  const scenarioCost = (
    t.app.db.prepare("SELECT SUM(cost_usd) AS c FROM ai_calls WHERE room_id = ? AND purpose = 'scenario'").get(roomId) as { c: number }
  ).c;
  assert.ok(scenarioCost >= 0.4);
  assert.ok(Math.abs(spent2 - spent3) < 1e-6, '房主和成员各出一半');
  assert.ok(Math.abs(spent2 + spent3 - scenarioCost) < 1e-3);

  // 剧情笔记这类大家共用的调用：有角色的玩家平摊（成员里没建角色的不算）
  assert.equal((await call('PUT', `/api/rooms/${roomId}/character`, 'tester2', reporter)).status, 200);
  const s2 = (await credit('tester2')).spent;
  const s3 = (await credit('tester3')).spent;
  await t.app.ai.send('summary', { max_tokens: 100, messages: [{ role: 'user', content: '测试' }] }, { roomId });
  assert.ok(Math.abs((await credit('tester2')).spent - s2 - 0.04) < 1e-6, '只有建了角色的人出');
  assert.equal((await credit('tester3')).spent, s3);
});

test('AI 总开关：关掉以后不能交行动、提问，到时间的行动先放着；结算到一半关掉的放回去；打开以后接着结算', async () => {
  const room = await soloRoom('tester4', '开关测试');
  assert.equal((await call('POST', `/api/rooms/${room.id}/actions`, 'tester4', { content: '在大堂里四处看看' })).status, 201);
  await t.app.engine.idle();

  assert.equal((await call('PUT', '/api/admin/ai', 'tester4', { enabled: false })).status, 403);
  assert.equal((await call('PUT', '/api/admin/ai', 'admin', { enabled: false })).status, 200);
  assert.equal((await call('GET', '/api/admin/ai', 'admin')).data.enabled, false);
  await pass(60);
  let state = (await call('GET', `/api/rooms/${room.id}/game`, 'tester4')).data;
  assert.equal(state.myAction.status, 'waiting', '到时间了也先不结算');
  assert.equal(state.ai.ready, false);
  assert.match(state.ai.message, /管理员暂时关掉了 AI/);
  const asked = await call('POST', `/api/rooms/${room.id}/ask`, 'tester4', { question: '现在几点' });
  assert.equal(asked.status, 503);
  assert.match(asked.data.error, /关掉了 AI/);

  // 打开以后马上结算
  assert.equal((await call('PUT', '/api/admin/ai', 'admin', { enabled: true })).status, 200);
  await t.app.engine.idle();
  state = (await call('GET', `/api/rooms/${room.id}/game`, 'tester4')).data;
  assert.equal(state.myAction, null);
  assert.equal(state.ai.ready, true);

  // 结算到一半被关掉：不算失败，放回去等着；打开以后接着结算
  switchOffMidway = true;
  assert.equal((await call('POST', `/api/rooms/${room.id}/actions`, 'tester4', { content: '去厨房看看' })).status, 201);
  await pass(60);
  state = (await call('GET', `/api/rooms/${room.id}/game`, 'tester4')).data;
  assert.equal(state.myAction.status, 'waiting');
  assert.equal(state.myAction.error, null);
  await call('PUT', '/api/admin/ai', 'admin', { enabled: true });
  await t.app.engine.idle();
  assert.equal((await call('GET', `/api/rooms/${room.id}/game`, 'tester4')).data.myAction, null);
});

test('管理后台：普通账号用不了；账号列表带额度和封禁；手动封号、解封；违规记录可以标成已处理', async () => {
  for (const url of ['/api/admin/users', '/api/admin/rooms', '/api/admin/ai', '/api/admin/violations', `/api/admin/users/${userId('tester1')}`]) {
    assert.equal((await call('GET', url, 'tester5')).status, 403, url);
  }

  const users = (await call('GET', '/api/admin/users', 'admin')).data.users;
  const t5 = users.find((u: any) => u.username === 'tester5');
  assert.deepEqual(t5.credit, { spent: 0, total: 5, unlimited: false, remaining: 5 });
  assert.equal(t5.banned, null);
  assert.equal(t5.rulesAgreed, true);

  // 不能封自己；站长的账号谁也封不了（站长就是测试管理员）
  assert.equal((await call('POST', `/api/admin/users/${userId('admin')}/ban`, 'admin', { reason: '试试' })).status, 400);
  // V0.6.0 起原因可以不写（见 v060 的测试），写了不能太长
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/ban`, 'admin', { reason: '长'.repeat(101) })).status, 400, '原因太长');

  // 手动封号：登录马上失效，再登录会看到原因；解封以后能正常登录
  const stream = await t.openStream('/api/events', cookies.tester5);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/ban`, 'admin', { reason: '测试封号' })).status, 200);
  assert.equal((await call('GET', '/api/rooms', 'tester5')).status, 401);
  const login = await t.call('POST', '/api/auth/login', { username: TESTER5.username, password: TESTER5.password });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /管理员封禁：测试封号/);
  assert.ok((await call('GET', '/api/admin/users', 'admin')).data.users.find((u: any) => u.username === 'tester5').banned.reason.includes('测试封号'));
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/unban`, 'admin')).status, 200);
  assert.equal((await call('POST', `/api/admin/users/${userId('tester5')}/unban`, 'admin')).status, 409);
  cookies.tester5 = await t.login(TESTER5.username, TESTER5.password);
  stream.close();

  // 违规记录：内容检查查出来的违规会列出来，管理员可以标成已处理
  const room = await soloRoom('tester5', '违规记录测试');
  const bad = await call('POST', `/api/rooms/${room.id}/actions`, 'tester5', { content: '违规的内容 [违规]' });
  assert.equal(bad.status, 403);
  // V0.4.5 起第一次违规是警告（第二次才封号，见 v045 的测试）
  assert.match(bad.data.error, /这是警告，再违反一次账号会被封禁。$/);
  const list = (await call('GET', '/api/admin/violations', 'admin')).data.violations;
  const v = list.find((x: any) => x.user?.username === 'tester5');
  assert.equal(v.kind, 'precheck');
  assert.equal(v.sourceLabel, '角色的行动');
  assert.equal(v.category, '露骨的性内容');
  assert.equal(v.outcome, 'warned');
  assert.equal(v.room.name, '违规记录测试');
  assert.equal(v.reviewedAt, null);
  assert.ok((await call('GET', '/api/admin/users', 'admin')).data.badges.admin >= 1, '管理员的待处理数里算上了没处理的违规记录');
  assert.equal((await call('POST', `/api/admin/violations/${v.id}/review`, 'admin')).status, 200);
  assert.equal((await call('POST', `/api/admin/violations/${v.id}/review`, 'admin')).status, 404);
  const reviewed = (await call('GET', '/api/admin/violations', 'admin')).data.violations.find((x: any) => x.id === v.id);
  assert.equal(reviewed.reviewer, '测试管理员');
  await call('POST', `/api/admin/users/${userId('tester5')}/unban`, 'admin');
  cookies.tester5 = await t.login(TESTER5.username, TESTER5.password);
});

test('管理后台的对局：不用加入就能看到所有对局的全部内容（秘密、剧本、私密记录），能暂停、删除', async () => {
  const room = await call('POST', '/api/rooms', 'tester2', { name: '后台查看', maxPlayers: 2 });
  const roomId = room.data.room.id as number;
  await call('POST', '/api/rooms/join', 'tester3', { code: room.data.room.joinCode });
  await call('POST', `/api/rooms/${roomId}/scenario`, 'tester2', { key: 'fog-harbor-inn' });
  await call('PUT', `/api/rooms/${roomId}/character`, 'tester2', reporter);
  await call('PUT', `/api/rooms/${roomId}/character`, 'tester3', detective);
  await call('POST', `/api/rooms/${roomId}/status`, 'tester2', { status: 'running' });
  await call('PUT', `/api/rooms/${roomId}/note`, 'tester3', { content: '我怀疑老板娘' });

  const list = (await call('GET', '/api/admin/rooms', 'admin')).data.rooms;
  const row = list.find((r: any) => r.id === roomId);
  assert.equal(row.host.displayName, '测试玩家二');
  assert.equal(row.characters, 2);
  assert.equal(row.scenarioTitle, '雾港旅店');

  const detail = (await call('GET', `/api/admin/rooms/${roomId}`, 'admin')).data;
  assert.ok(detail.characters.find((c: any) => c.name === '林小满').roleSecret.includes('线人'), '能看到身份秘密');
  assert.ok(detail.scenario.data.truth.summary.length > 0, '能看到完整剧本');
  assert.equal(detail.notes[0].content, '我怀疑老板娘', '能看到所有人的笔记');
  assert.equal(detail.room.joinCode, room.data.room.joinCode);
  assert.equal(detail.members.length, 2);

  const log = (await call('GET', `/api/admin/rooms/${roomId}/log`, 'admin')).data.entries;
  const roleEntry = log.find((e: any) => e.data?.type === 'role' && e.text.includes('线人'));
  assert.ok(roleEntry.private);
  assert.deepEqual(roleEntry.to, ['林小满'], '注明了谁看得到');

  // 有「管理所有对局」权限的管理员（站长）不在这一局里：在对局页面里是观看，只看得到故事，看不到谁的角色卡、线索、秘密
  const watched = await call('GET', `/api/rooms/${roomId}/game`, 'admin');
  assert.equal(watched.status, 200);
  assert.equal(watched.data.watching, true);
  assert.equal(watched.data.manager, true);
  assert.equal(watched.data.me, null);
  assert.deepEqual(watched.data.clues, []);
  assert.ok(!JSON.stringify(watched.data).includes('线人'), '观看的人看不到身份秘密');
  const watchedLog = (await call('GET', `/api/rooms/${roomId}/log`, 'admin')).data.entries;
  assert.ok(!watchedLog.some((e: any) => e.data?.type === 'role'), '观看时看不到私下告诉玩家的身份');

  // 暂停、继续：记录里写的是站长（测试管理员是站长）
  assert.equal((await call('POST', `/api/admin/rooms/${roomId}/status`, 'admin', { status: 'paused' })).data.status, 'paused');
  const entries = (await call('GET', `/api/rooms/${roomId}/log`, 'tester2')).data.entries;
  assert.ok(entries.some((e: any) => e.text === '站长暂停了对局'));
  assert.equal((await call('POST', `/api/admin/rooms/${roomId}/status`, 'tester2', { status: 'running' })).status, 403);

  // 删除
  const lobby = await t.openStream('/api/events', cookies.tester3);
  assert.equal((await call('DELETE', `/api/admin/rooms/${roomId}`, 'admin')).status, 200);
  await lobby.waitFor((e) => e.event === 'rooms-changed' && e.data.roomId === roomId);
  assert.equal((await call('GET', `/api/rooms/${roomId}`, 'tester2')).status, 404);
  lobby.close();
});
