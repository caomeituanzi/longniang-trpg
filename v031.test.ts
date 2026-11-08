import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { demoHandler, FAKE_CHECK_REFUSAL_WORD, FAKE_REFUSAL_WORD, FakeProvider } from '../server/ai/fake';
import { GUARD_MARK } from '../server/ai/moderation';
import { modelOptions } from '../server/ai/pricing';
import { AiRefusal, THIRD_PARTY_REFUSAL, type AiProvider } from '../server/ai/types';
import { MIGRATIONS, openDatabase } from '../server/db';
import { cleanupGuestsIfDue, lastCleanupBoundary } from '../server/guests';
import { insertAccount } from '../server/routes/auth';
import { getSetting, setSetting } from '../server/settings';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { BEFORE_WIPE, startTestApp } from './helpers';

// V0.3.1：游客的 UID、每天清理游客、通知里的好友申请和邀请、大厅里自己的对局（V0.4.1 起照常列出来）、模型名字

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
/** 公开编号（网页上拿不到别人的用户名）。 */
const pid = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;

// ---------- UID ----------

test('升级到 V0.3.1、V0.3.2：游客换成 8 位数；正式账号重新排成连续的号，0 号不动；删掉的账号把号空出来；以后注册的用空着的最小的号，游客不占号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-mig11-'));
  try {
    const file = path.join(dir, 'game.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 10)) raw.exec(sql);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (10);');
    // V0.3.0 的样子：站长 0；游客占了 1、3（2 号游客退出时删掉了）；正式账号 4；删掉的正式账号 5；计数到了 5
    const add = raw.prepare(
      'INSERT INTO users (username, display_name, password_hash, created_at, uid, is_guest, is_admin, is_owner, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
    );
    add.run('boss', '站长', 'x', 0, 0, 1, 1, null);
    add.run('guest-aaaaaaaaaaaa', '游客1001', 'x', 1, 1, 0, 0, null);
    add.run('guest-bbbbbbbbbbbb', '游客1002', 'x', 3, 1, 0, 0, null);
    add.run('friend', '朋友', 'x', 4, 0, 0, 0, null);
    add.run('deleted-5', '已删除的账号', '!', 5, 0, 0, 0, 2);
    raw.exec('UPDATE uid_counter SET last = 5');
    raw.close();

    const db = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
    try {
      const rows = () =>
        (db.prepare('SELECT username, uid, is_guest FROM users ORDER BY id').all() as { username: string; uid: number | null; is_guest: number }[]).map((r) => ({ ...r }));
      const after = rows();
      const formal = after.filter((r) => !r.is_guest);
      assert.deepEqual(
        formal.slice(0, 2).map((r) => [r.username, r.uid]),
        [
          ['boss', 0],
          ['friend', 1],
        ],
        '正式账号连续编号',
      );
      assert.match(formal[2].username, /^deleted-[0-9a-f]{12}$/, '删掉的账号的用户名不带 UID');
      assert.equal(formal[2].uid, null, '删掉的账号把号空出来了');
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'uid_counter'").get(), undefined, '不再用计数');
      const guestUids = after.filter((r) => r.is_guest).map((r) => r.uid as number);
      assert.equal(guestUids.length, 2);
      assert.ok(guestUids.every((u) => u >= 10_000_000 && u < 100_000_000));
      assert.notEqual(guestUids[0], guestUids[1]);

      // 以后：正式账号用空着的最小的号，游客随机 8 位数；直接写进去的游客（没给 UID）也是 8 位数
      const at = Date.now();
      const member = insertAccount(db, { username: 'newbie', displayName: '新人', passwordHash: 'x', at, guest: false });
      const guest = insertAccount(db, { username: 'guest-cccccccccccc', displayName: '游客1003', passwordHash: 'x', at, guest: true });
      db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_guest) VALUES ('guest-dddddddddddd', '游客1004', 'x', 1, 1)").run();
      const member2 = insertAccount(db, { username: 'newbie2', displayName: '新人2', passwordHash: 'x', at, guest: false });
      const uidOf = (id: number) => (db.prepare('SELECT uid FROM users WHERE id = ?').get(id) as { uid: number }).uid;
      assert.equal(uidOf(member), 2, '用上删掉的账号空出来的号');
      assert.equal(uidOf(member2), 3, '游客没有占号');
      assert.ok(uidOf(guest) >= 10_000_000);
      const raw4 = (db.prepare("SELECT uid FROM users WHERE username = 'guest-dddddddddddd'").get() as { uid: number }).uid;
      assert.ok(raw4 >= 10_000_000 && raw4 < 100_000_000);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 游客清理 ----------

test('每天凌晨 4 点清理一次游客：最近的 4 点之前清理过才做；在线的游客留着', () => {
  // 4 点的界线按服务器所在地的时间算
  const at = (h: number, m = 0, day = 26) => new Date(2026, 9, day, h, m).getTime();
  assert.equal(lastCleanupBoundary(at(10)), at(4));
  assert.equal(lastCleanupBoundary(at(3, 59)), at(4, 0, 25));
  assert.equal(lastCleanupBoundary(at(4)), at(4));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-guests-'));
  const db = openDatabase(path.join(dir, 'game.db'), { onBackup: () => {} });
  try {
    const guest = (name: string) => insertAccount(db, { username: `guest-${name}`, displayName: name, passwordHash: 'x', at: at(1), guest: true });
    const member = insertAccount(db, { username: 'member', displayName: '正式', passwordHash: 'x', at: at(1), guest: false });
    const online = guest('aaaaaaaaaaaa');
    const offline = guest('bbbbbbbbbbbb');
    db.prepare("INSERT INTO reports (reporter_id, kind, body, created_at) VALUES (?, 'feedback', '游客的意见', 1)").run(offline);
    // 从没清理过：马上清理
    assert.equal(cleanupGuestsIfDue(db, new Set([online]), at(10)), 1);
    const ids = (db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id);
    assert.deepEqual(ids.sort(), [member, online].sort());
    assert.equal((db.prepare('SELECT reporter_id FROM reports').get() as { reporter_id: number | null }).reporter_id, null, '反馈留着');
    assert.match((db.prepare('SELECT detail FROM admin_audit ORDER BY id DESC').get() as { detail: string }).detail, /删掉了 1 个不在线的游客账号（每天凌晨 4 点自动清理）/);
    // 当天再看：不做；第二天 4 点以后：在线的那个这回不在线了，清掉
    assert.equal(cleanupGuestsIfDue(db, new Set(), at(23)), null);
    assert.equal(cleanupGuestsIfDue(db, new Set(), at(3, 30, 27)), null);
    assert.equal(cleanupGuestsIfDue(db, new Set(), at(4, 10, 27)), 1);
    assert.ok(Number(getSetting(db, 'guest_cleanup_at')) >= at(4, 0, 27));
    // 没有要清的：不记操作记录
    const audits = (db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n;
    setSetting(db, 'guest_cleanup_at', '0');
    assert.equal(cleanupGuestsIfDue(db, new Set(), at(5, 0, 28)), 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n, audits);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('管理页「清理不在线的游客」：要有「账号管理」权限；在线的游客不删；操作记录里记着是谁清理的，自动清理记成「网站自动」', async () => {
  const g1 = await t.call('POST', '/api/auth/guest');
  const g2 = await t.call('POST', '/api/auth/guest');
  assert.equal(g1.status, 201);
  const watching = await t.openStream('/api/events', g1.cookie!);
  try {
    assert.equal((await call('POST', '/api/admin/guests/cleanup', 'tester1')).status, 403);
    const r = await call('POST', '/api/admin/guests/cleanup', 'admin');
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 1);
    const left = (t.app.db.prepare('SELECT id FROM users WHERE is_guest = 1').all() as { id: number }[]).map((x) => x.id);
    assert.deepEqual(left, [g1.data.user.id], '在线的留着');
    assert.equal((await t.call('GET', '/api/auth/me', undefined, g2.cookie!)).data.user, null, '删掉的游客退出了登录');
  } finally {
    watching.close();
  }
  // 自动清理：操作记录里写「网站自动」
  setSetting(t.app.db, 'guest_cleanup_at', '0');
  cleanupGuestsIfDue(t.app.db, new Set(), Date.now());
  const entries = (await call('GET', '/api/admin/audit', 'admin')).data.entries as { action: string; by: string; detail: string }[];
  const cleanups = entries.filter((e) => e.action === '清理游客账号');
  assert.equal(cleanups[0].by, '网站自动');
  assert.match(cleanups[1].by, /admin/);
});

// ---------- 通知 ----------

test('通知里的好友申请、对局邀请：在别处同意、加入、撤回以后，显示现在的结果，不再给按钮；重复同意不报错', async () => {
  const items = async (who: string) => (await call('GET', '/api/notifications', who)).data.items as { kind: string; state?: string; data: any }[];
  const request = async (who: string) => (await items(who)).find((n) => n.kind === 'friend_request' && n.data.from.publicId === pid('tester1'));

  // tester1 加 tester2：还没处理
  assert.equal((await call('POST', '/api/friends', 'tester1', { username: 'tester2' })).status, 201);
  assert.equal((await request('tester2'))!.state, 'pending');
  // tester2 在好友页同意了：通知里显示已经是好友
  assert.equal((await call('POST', '/api/friends/tester1/accept', 'tester2')).status, 200);
  assert.equal((await request('tester2'))!.state, 'friends');
  // 又在通知里点了一次同意：照样成功
  const again = await call('POST', '/api/friends/tester1/accept', 'tester2');
  assert.equal(again.status, 200);
  assert.equal(again.data.relation, 'friends');

  // tester3 加 tester2，又撤回了：失效
  assert.equal((await call('POST', '/api/friends', 'tester3', { username: 'tester2' })).status, 201);
  assert.equal((await call('DELETE', '/api/friends/tester2', 'tester3')).status, 200);
  const withdrawn = (await items('tester2')).find((n) => n.kind === 'friend_request' && n.data.from.publicId === pid('tester3'))!;
  assert.equal(withdrawn.state, 'gone');
  assert.equal((await call('POST', '/api/friends/tester3/accept', 'tester2')).status, 404);

  // 对局邀请：还没处理 → 加入了 → 显示已加入；另一局的邀请被撤回 → 失效
  const room = (await call('POST', '/api/rooms', 'tester1', { name: '邀请的局', maxPlayers: 4 })).data.room;
  const other = (await call('POST', '/api/rooms', 'tester1', { name: '撤回邀请的局', maxPlayers: 4 })).data.room;
  assert.equal((await call('POST', `/api/rooms/${room.id}/invites`, 'tester1', { username: 'tester2' })).status, 201);
  assert.equal((await call('POST', `/api/rooms/${other.id}/invites`, 'tester1', { username: 'tester2' })).status, 201);
  const invite = async (roomId: number) => (await items('tester2')).find((n) => n.kind === 'room_invite' && n.data.roomId === roomId)!;
  assert.equal((await invite(room.id)).state, 'pending');
  assert.equal((await call('POST', `/api/rooms/${room.id}/invites/accept`, 'tester2')).status, 200);
  assert.equal((await invite(room.id)).state, 'joined');
  assert.equal((await call('DELETE', `/api/rooms/${other.id}/invites/tester2`, 'tester1')).status, 200);
  assert.equal((await invite(other.id)).state, 'gone');
  // 别的通知没有状态
  assert.ok((await items('tester1')).filter((n) => n.kind === 'friend_accepted').every((n) => n.state === undefined));
});

// ---------- 大厅 ----------

test('大厅：自己在的公开对局也照常列在「公开的对局」里，标着已经加入；结束了就移出大厅（V0.7.0），「我的对局」里还有', async () => {
  const room = (await call('POST', '/api/rooms', 'tester3', { name: '我自己的公开局', maxPlayers: 4, isPublic: true })).data.room;
  type Row = { id: number; joined: boolean };
  const hall = async (who: string) => (await call('GET', '/api/hall', who)).data as { rooms: Row[] };
  assert.equal((await hall('tester3')).rooms.find((r) => r.id === room.id)?.joined, true);
  assert.equal((await hall('tester1')).rooms.find((r) => r.id === room.id)?.joined, false, '别人看得到，没加入');
  assert.equal((await call('POST', `/api/rooms/${room.id}/status`, 'tester3', { status: 'ended' })).status, 200);
  assert.ok(!(await hall('tester3')).rooms.some((r) => r.id === room.id));
  assert.ok(!(await hall('tester1')).rooms.some((r) => r.id === room.id));
  assert.ok(((await call('GET', '/api/rooms', 'tester3')).data.rooms as { id: number }[]).some((r) => r.id === room.id), '在「我的对局」里');
});

// ---------- 模型 ----------

test('OpenRouter：管理页填要用的模型（查得到才收、正在用的删不掉），填了的能给各项选，交给 OpenRouter 调用，花费用它报的', async () => {
  const inner = new FakeProvider(demoHandler);
  let ready = true;
  const catalog = [
    { id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', contextLength: 400000, price: { input: 1.25, output: 10, cacheRead: 0.125 } },
    { id: 'google/gemini-3-pro', name: 'Google: Gemini 3 Pro', contextLength: 1000000, price: { input: 2, output: 12, cacheRead: null } },
  ];
  const openrouter: AiProvider & { listModels: () => Promise<typeof catalog> } = {
    name: 'openrouter',
    priced: true,
    get status() {
      return ready ? { ready: true, message: null } : { ready: false, message: '还没有设置 OpenRouter 的 API 密钥（.env 文件的 OPENROUTER_API_KEY），OpenRouter 的模型暂时用不了。' };
    },
    listModels: async () => catalog,
    async send(request, signal, hooks) {
      const response = await inner.send(request, signal, hooks);
      // OpenRouter 自己报花了多少钱
      return { ...response, usage: { ...response.usage, cost_usd: 0.0123 } };
    },
  };
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), openrouter, tickMs: 0 });
  try {
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const player = await app.login(TESTER1.username, TESTER1.password);
    let info = (await app.call('GET', '/api/admin/ai', undefined, admin)).data;
    assert.deepEqual(info.openrouter, { models: [], fromEnv: true });
    assert.ok(info.providers.some((p: { label: string; ready: boolean }) => p.label === 'OpenRouter' && p.ready));

    // 格式不对、和 Claude 的重名、OpenRouter 上没有：都不收
    for (const [models, pattern] of [
      [['bad model name'], /不像模型的名字/],
      [['claude-opus-5-5'], /Claude 或 DeepSeek 自己的模型/],
      [['openai/gpt-9'], /OpenRouter 上没有这些模型：openai\/gpt-9/],
    ] as const) {
      const r = await app.call('PUT', '/api/admin/ai/openrouter-models', { models }, admin);
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, pattern);
    }
    assert.equal((await app.call('PUT', '/api/admin/ai/openrouter-models', { models: ['openai/gpt-5.2'] }, player)).status, 403);
    const saved = await app.call('PUT', '/api/admin/ai/openrouter-models', { models: ['openai/gpt-5.2', 'google/gemini-3-pro', 'openai/gpt-5.2'] }, admin);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.openrouter, { models: ['openai/gpt-5.2', 'google/gemini-3-pro'], fromEnv: false });
    const gpt = saved.data.options.find((o: { model: string }) => o.model === 'openai/gpt-5.2');
    assert.deepEqual(
      { name: gpt.name, price: gpt.price, available: gpt.available },
      { name: 'OpenAI: GPT-5.2', price: { input: 1.25, output: 10 }, available: true },
      '名字和价格从 OpenRouter 拿',
    );
    assert.match(gpt.note, /经 OpenRouter 调用，内容发给 openai/);

    // 杂活换成它：估时交给 OpenRouter，花费用它报的
    info = (await app.call('PUT', '/api/admin/ai/models', { models: { misc: 'openai/gpt-5.2' } }, admin)).data;
    assert.equal(info.models.misc, 'openai/gpt-5.2');
    const room = (await app.call('POST', '/api/rooms', { name: 'OpenRouter 局', maxPlayers: 2 }, player)).data.room;
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林记者' }, player)).status, 200);
    // 房主可以给这一局的主持选 OpenRouter 的模型；没填的不行
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/model`, { dmModel: 'google/gemini-3-pro' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/model`, { dmModel: 'openai/gpt-9' }, player)).status, 400);
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, player)).status, 200);
    const log = (await app.call('GET', `/api/rooms/${room.id}/log`, undefined, player)).data.entries.map((e: { text: string }) => e.text);
    assert.ok(log.some((text: string) => text.includes('主持：Google: Gemini 3 Pro')), '记录里写模型的名字');
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/act`, { text: '我推开旅店的门。', as: 'action' }, player)).status, 201);
    await app.app.engine.idle();
    const calls = app.app.db.prepare('SELECT purpose, provider, model, cost_usd FROM ai_calls WHERE room_id = ? ORDER BY id').all(room.id) as {
      purpose: string;
      provider: string;
      model: string;
      cost_usd: number;
    }[];
    const estimate = calls.find((c) => c.purpose === 'estimate')!;
    assert.deepEqual({ ...estimate }, { purpose: 'estimate', provider: 'openrouter', model: 'openai/gpt-5.2', cost_usd: 0.0123 });

    // 正在用的删不掉；没设密钥时选不了
    const removing = await app.call('PUT', '/api/admin/ai/openrouter-models', { models: ['google/gemini-3-pro'] }, admin);
    assert.equal(removing.status, 409);
    assert.match(removing.data.error, /正在给「杂活」用/);
    ready = false;
    info = (await app.call('GET', '/api/admin/ai', undefined, admin)).data;
    assert.equal(info.options.find((o: { model: string }) => o.model === 'google/gemini-3-pro').available, false);
    const r = await app.call('PUT', '/api/admin/ai/models', { models: { dm: 'google/gemini-3-pro' } }, admin);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /OPENROUTER_API_KEY/);
  } finally {
    await app.close();
  }
});

test('经 OpenRouter 调用时被别家拒绝（内容审核拦下、模型拒绝回答）：只拦下、标给管理员看，单人局也不封号', async () => {
  const inner = new FakeProvider(demoHandler);
  const catalog = [{ id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', contextLength: 400000, price: { input: 1.25, output: 10, cacheRead: 0.125 } }];
  const openrouter: AiProvider & { listModels: () => Promise<typeof catalog> } = {
    name: 'openrouter',
    priced: true,
    status: { ready: true, message: null },
    listModels: async () => catalog,
    async send(request, signal, hooks) {
      const response = await inner.send(request, signal, hooks);
      if (response.stop_reason !== 'refusal') return response;
      // 内容检查被 OpenRouter 的内容审核拦下：直接报错（真的 OpenRouter 回 403）；别的是模型拒绝回答：回一个被拒绝的回复
      if (request.system?.[0]?.text.startsWith(GUARD_MARK)) {
        throw new AiRefusal('这次请求被 OpenRouter 的内容审核拦下了（violence）', `${THIRD_PARTY_REFUSAL}moderation`);
      }
      return { ...response, stop_details: { type: 'refusal', category: `${THIRD_PARTY_REFUSAL}content_filter`, explanation: null } };
    },
  };
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), openrouter, tickMs: 0 });
  try {
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const player = await app.login(TESTER1.username, TESTER1.password);
    assert.equal((await app.call('PUT', '/api/admin/ai/openrouter-models', { models: ['openai/gpt-5.2'] }, admin)).status, 200);
    const set = await app.call('PUT', '/api/admin/ai/models', { models: { dm: 'openai/gpt-5.2', misc: 'openai/gpt-5.2', guard: 'openai/gpt-5.2' } }, admin);
    assert.equal(set.status, 200, JSON.stringify(set.data));
    const room = (await app.call('POST', '/api/rooms', { name: '别家拒绝', maxPlayers: 1 }, player)).data.room;
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林记者' }, player)).status, 200);
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, player)).status, 200);

    // 内容检查被拦下：拦两次也不封号（Claude 的是第二次就封）
    for (let i = 1; i <= 2; i++) {
      const r = await app.call('POST', `/api/rooms/${room.id}/act`, { text: `第${i}次 ${FAKE_CHECK_REFUSAL_WORD}`, as: 'action' }, player);
      assert.equal(r.status, 403, JSON.stringify(r.data));
      assert.match(r.data.error, /被 AI 那边拒绝了/);
      assert.doesNotMatch(r.data.error, /封/);
    }
    // 单人局的行动被模型拒绝：不能重试，标给管理员看，不封号
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/act`, { text: `我做一件事 ${FAKE_REFUSAL_WORD}`, as: 'action' }, player)).status, 201);
    await app.app.engine.idle();
    const action = app.app.db.prepare('SELECT status, refused FROM actions WHERE room_id = ?').get(room.id) as { status: string; refused: number };
    assert.deepEqual({ ...action }, { status: 'failed', refused: 1 });
    const user = app.app.db.prepare('SELECT banned_at FROM users WHERE username = ?').get(TESTER1.username) as { banned_at: number | null };
    assert.equal(user.banned_at, null);
    const violations = app.app.db
      .prepare('SELECT v.kind, v.category, v.outcome FROM violations v JOIN users u ON u.id = v.user_id WHERE u.username = ? ORDER BY v.id')
      .all(TESTER1.username) as { kind: string; category: string; outcome: string }[];
    assert.deepEqual(
      violations.map((v) => ({ ...v })),
      [
        { kind: 'precheck', category: 'refusal:openrouter:moderation', outcome: 'flagged' },
        { kind: 'precheck', category: 'refusal:openrouter:moderation', outcome: 'flagged' },
        { kind: 'refusal', category: 'refusal:openrouter:content_filter', outcome: 'flagged' },
      ],
    );
    assert.equal((await app.call('GET', '/api/auth/me', undefined, player)).data.user?.username, TESTER1.username, '还登录着');
  } finally {
    await app.close();
  }
});

test('DeepSeek Flash 显示成 DeepSeek V4.1 Flash 1017（调用时还是 deepseek-flash）', () => {
  const flash = modelOptions().find((o) => o.model === 'deepseek-flash')!;
  assert.equal(flash.name, 'DeepSeek V4.1 Flash 1017');
});
