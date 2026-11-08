process.env.TZ = 'Asia/Shanghai';
// V1.0.1：维护页写着交流 QQ 群号；站长一键把所有正式用户的可用额度清零；接上兼容 OpenAI 格式的中转站，能选 ChatGPT 的模型。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import worker from '../cloudflare/maintenance-worker.js';
import { offerImport } from '../scripts/upgrade.mjs';
import { demoHandler, FAKE_CHECK_REFUSAL_WORD, FAKE_REFUSAL_WORD, FakeProvider } from '../server/ai/fake';
import { GUARD_MARK } from '../server/ai/moderation';
import { OpenRouterProvider } from '../server/ai/openrouter';
import { checkRelay } from '../scripts/key-check.mjs';
import { costOf, isRelayModel, KNOWN_MODELS, RELAY_MODELS } from '../server/ai/pricing';
import { AiRefusal, THIRD_PARTY_REFUSAL, type AiProvider, type MessagesRequest } from '../server/ai/types';
import { creditOf } from '../server/credit';
import { openDatabase } from '../server/db';
import { compareVersions, postReleaseNotes, RELEASE_NOTES } from '../server/release-notes';
import { seedTestData, TEST_ACCOUNTS } from '../server/seed-data';
import { APP_VERSION } from '../server/version';
import { BEFORE_WIPE, startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4] = TEST_ACCOUNTS;
const ROOT = path.resolve(import.meta.dirname, '..');

// ==================== 维护页 ====================

test('维护页：「升级维护中」下面写着交流 QQ 群号（和网页页脚的一样）；接口照旧回 JSON', async () => {
  const qq = fs.readFileSync(path.join(ROOT, 'web', 'src', 'version.ts'), 'utf8').match(/APP_QQ_GROUP = '(\d+)'/)?.[1];
  assert.equal(qq, '1130127996');
  const page = await worker.fetch(new Request('https://trpg.example.com/lobby'), { MAINTENANCE: '1' });
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, new RegExp(`QQ群<b>${qq}</b>`));
  assert.ok(html.indexOf('升级维护中') < html.indexOf(qq!), '写在「升级维护中」下面');
  const apiReply = await worker.fetch(new Request('https://trpg.example.com/api/me'), { MAINTENANCE: '1' });
  assert.equal(apiReply.status, 503);
  assert.match((await apiReply.json()).error, /正在升级维护/);
  // 开着的网页顶上那一行（维护时）也写着群号
  const banner = fs.readFileSync(path.join(ROOT, 'web', 'src', 'components', 'SiteDown.tsx'), 'utf8');
  assert.match(banner, /down === 'maintenance' && APP_QQ_GROUP/);
});

// ==================== 中转站 ====================

type Sent = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(replies: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = replies.shift();
    if (!next) throw new Error('测试没准备更多回复');
    return next();
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const reply = (message: Record<string, unknown>, finish = 'stop') => () =>
  Response.json({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-6.1-sol',
    choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 1000 } },
  });

/** 测试用的中转站地址（中转站没有默认的地址，用哪一家填哪一家）。 */
const RELAY_URL = 'https://relay.example.com/v1';

test('中转站：接口地址和密钥都要填；按 OpenAI 的写法发（max_completion_tokens、思考强度），不发用户编号；记账时写 relay', async () => {
  const { fetchImpl, sent } = fakeFetch([reply({ content: '好' }), reply({ content: null, refusal: '不能写这个' })]);
  const relay = new OpenRouterProvider({ apiKey: 'sk-relay-test', baseUrl: `${RELAY_URL}/`, label: '中转站', keyName: 'RELAY_API_KEY', kind: 'relay', fetchImpl });
  assert.deepEqual(relay.status, { ready: true, message: null });
  assert.equal(relay.name, 'relay');
  assert.equal(relay.priced, true);
  const request: MessagesRequest = {
    model: 'gpt-6.1-sol',
    max_tokens: 4000,
    system: [{ type: 'text', text: '你是主持人' }],
    messages: [{ role: 'user', content: '开始' }],
    tools: [{ name: 'roll_check', description: '掷骰', input_schema: { type: 'object', properties: {} } }],
    output_config: { effort: 'low' },
    metadata: { user_id: 'anon-1' },
  };
  const res = await relay.send(request);
  assert.equal(res.content.find((b) => b.type === 'text')?.type, 'text');
  // 用量：缓存读的那部分单独算；中转站不报花费，记账时按价格表算
  assert.deepEqual(res.usage, { input_tokens: 200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 });
  const body = sent[0].body;
  assert.equal(sent[0].url, 'https://relay.example.com/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-relay-test');
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.max_completion_tokens, 4000);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.user, undefined);
  assert.equal(body.safety_identifier, undefined);
  assert.equal(body.tools[0].function.name, 'roll_check');
  // 被那边拒绝：记成「被中转站那边拒绝」
  const refused = await relay.send({ ...request, output_config: undefined });
  assert.equal(refused.stop_reason, 'refusal');
  assert.equal(refused.stop_details?.category, 'openrouter:relay:refusal');
  assert.equal(sent[1].body.reasoning_effort, undefined, '没写思考强度就不发');
  // 没设置密钥：说清楚是 .env 的哪一项
  const none = new OpenRouterProvider({ apiKey: undefined, baseUrl: RELAY_URL, label: '中转站', keyName: 'RELAY_API_KEY', kind: 'relay' });
  assert.equal(none.status.ready, false);
  assert.match(none.status.message!, /中转站.*RELAY_API_KEY/);
  // 有密钥没有地址：中转站没有默认的地址（不会发到 OpenRouter 去），说清楚要填 RELAY_BASE_URL；调用也不发出去
  const noUrl = new OpenRouterProvider({ apiKey: 'sk-relay-test', baseUrlName: 'RELAY_BASE_URL', label: '中转站', keyName: 'RELAY_API_KEY', kind: 'relay', fetchImpl });
  assert.equal(noUrl.status.ready, false);
  assert.match(noUrl.status.message!, /中转站 的接口地址（项目文件夹里 \.env 文件的 RELAY_BASE_URL）/);
  const count = sent.length;
  await assert.rejects(noUrl.send(request), /RELAY_BASE_URL/);
  assert.equal(sent.length, count, '没有发请求');
  // OpenRouter 照旧有默认地址
  assert.equal(new OpenRouterProvider({ apiKey: 'sk-or-test' }).status.ready, true);
});

test('检查中转站的密钥：没写接口地址时直接说要先写地址；写了就去问那一家的模型列表', async () => {
  assert.deepEqual(await checkRelay('relay-key-123456', ''), { ok: false, message: '还没有写中转站的接口地址（.env 的 RELAY_BASE_URL）。' });
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization}`);
    res.writeHead(req.headers.authorization === 'Bearer relay-key-123456' ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    assert.deepEqual(await checkRelay('relay-key-123456', `RELAY_BASE_URL=${base}/\n`), { ok: true });
    assert.deepEqual(await checkRelay('wrong-key-123456', `RELAY_BASE_URL=${base}\n`), { ok: false, message: '这个密钥不对（中转站说认证失败）。' });
    assert.deepEqual(seen, ['/v1/models Bearer relay-key-123456', '/v1/models Bearer wrong-key-123456']);
  } finally {
    server.close();
  }
});

test('api-keys.bat 的第 4 项（中转站）：先问接口地址，再问密钥，两项都存进 .env；没填地址就不往下问', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v101-keys-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['keys.mjs', 'key-check.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const run = (input: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(dir, 'scripts', 'keys.mjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', () => resolve(out));
        child.stdin.end(input);
      });
    // 没填地址：不问密钥
    let out = await run('4\n\n\n');
    assert.match(out, /中转站的接口地址：还没设置/);
    assert.match(out, /没有接口地址，中转站用不了。/);
    assert.doesNotMatch(out, /中转站 的 API 密钥/);
    // 填地址、填密钥
    out = await run(`4\n${base}/\nrelay-key-123456\n\n`);
    assert.match(out, /接口地址存进 \.env 了。/);
    assert.match(out, /密钥可以用，已经存进 \.env。/);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, new RegExp(`^RELAY_BASE_URL=${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(env, /^RELAY_API_KEY=relay-key-123456$/m);
    // 再进来：直接回车用现在的地址
    out = await run('4\n\n\n\n');
    assert.match(out, new RegExp(`中转站的接口地址：${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(out, /中转站 的 API 密钥：relay-key-…3456|中转站 的 API 密钥：（已设置）/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('中转站回 403（模型拒绝、内容审核拦下）：拒绝的类别带 relay:，说的是中转站', async () => {
  const forbidden = (metadata: Record<string, unknown>) => () => Response.json({ error: { message: 'blocked', code: 403, metadata } }, { status: 403 });
  const { fetchImpl } = fakeFetch([forbidden({ error_type: 'refusal' }), forbidden({ reasons: ['violence'], flagged_input: '……' })]);
  const relay = new OpenRouterProvider({ apiKey: 'sk-relay-test', baseUrl: RELAY_URL, label: '中转站', keyName: 'RELAY_API_KEY', kind: 'relay', fetchImpl });
  const request: MessagesRequest = { model: 'gpt-6-luna', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] };
  const declined = await relay.send(request).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(declined instanceof AiRefusal);
  assert.equal(declined.category, `${THIRD_PARTY_REFUSAL}relay:refusal`);
  assert.match(declined.message, /中转站 那边的模型拒绝了/);
  const flagged = await relay.send(request).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(flagged instanceof AiRefusal);
  assert.equal(flagged.category, `${THIRD_PARTY_REFUSAL}relay:moderation`);
  assert.match(flagged.message, /中转站 的内容审核拦下了（violence）/);
});

test('经中转站调用时被拒绝：只拦下、标给管理员看，不封号；违规记录和管理页写「被中转站那边拒绝」', async () => {
  const inner = new FakeProvider(demoHandler);
  const relay: AiProvider = {
    name: 'relay',
    priced: true,
    status: { ready: true, message: null },
    async send(request, signal, hooks) {
      const response = await inner.send(request, signal, hooks);
      if (response.stop_reason !== 'refusal') return response;
      // 内容检查被中转站那边的审核拦下（直接报错）；别的是模型拒绝回答（回一个被拒绝的回复）
      if (request.system?.[0]?.text.startsWith(GUARD_MARK)) throw new AiRefusal('这次请求被 中转站 的内容审核拦下了（violence）', `${THIRD_PARTY_REFUSAL}relay:moderation`);
      return { ...response, stop_details: { type: 'refusal', category: `${THIRD_PARTY_REFUSAL}relay:content_filter`, explanation: null } };
    },
  };
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), relay, tickMs: 0 });
  try {
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const player = await app.login(TESTER1.username, TESTER1.password);
    const set = await app.call('PUT', '/api/admin/ai/models', { models: { dm: 'gpt-6.1-sol', misc: 'gpt-6-luna', guard: 'gpt-6.1-terra' } }, admin);
    assert.equal(set.status, 200, JSON.stringify(set.data));
    const room = (await app.call('POST', '/api/rooms', { name: '中转站拒绝', maxPlayers: 1 }, player)).data.room;
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林记者' }, player)).status, 200);
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, player)).status, 200);
    for (let i = 1; i <= 2; i++) {
      const r = await app.call('POST', `/api/rooms/${room.id}/act`, { text: `第${i}次 ${FAKE_CHECK_REFUSAL_WORD}`, as: 'action' }, player);
      assert.equal(r.status, 403, JSON.stringify(r.data));
      assert.doesNotMatch(r.data.error, /封/);
    }
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/act`, { text: `我做一件事 ${FAKE_REFUSAL_WORD}`, as: 'action' }, player)).status, 201);
    await app.app.engine.idle();
    const user = app.app.db.prepare('SELECT banned_at FROM users WHERE username = ?').get(TESTER1.username) as { banned_at: number | null };
    assert.equal(user.banned_at, null, '不封号');
    const violations = app.app.db
      .prepare('SELECT v.kind, v.category, v.reason, v.outcome FROM violations v JOIN users u ON u.id = v.user_id WHERE u.username = ? ORDER BY v.id')
      .all(TESTER1.username) as { kind: string; category: string; reason: string; outcome: string }[];
    assert.deepEqual(
      violations.map((v) => ({ kind: v.kind, category: v.category, outcome: v.outcome })),
      [
        { kind: 'precheck', category: 'refusal:openrouter:relay:moderation', outcome: 'flagged' },
        { kind: 'precheck', category: 'refusal:openrouter:relay:moderation', outcome: 'flagged' },
        { kind: 'refusal', category: 'refusal:openrouter:relay:content_filter', outcome: 'flagged' },
      ],
    );
    assert.match(violations[0].reason, /^内容检查被中转站那边拒绝了/);
    assert.match(violations[2].reason, /^被中转站那边拒绝了/);
    assert.ok(violations.every((v) => !v.reason.includes('OpenRouter')));
    const listed = (await app.call('GET', '/api/admin/violations', undefined, admin)).data.violations as { category: string }[];
    assert.ok(listed.some((v) => v.category === '被中转站那边拒绝（moderation）'));
    assert.ok(listed.some((v) => v.category === '被中转站那边拒绝（content_filter）'));
  } finally {
    await app.close();
  }
});

test('ChatGPT 的四个模型：按 OpenAI 官方价格记账（缓存读的便宜，没有缓存写入费）；和 Claude、DeepSeek 的一样列在能选的模型里', () => {
  assert.deepEqual(RELAY_MODELS, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
  for (const m of RELAY_MODELS) {
    assert.ok(KNOWN_MODELS.includes(m));
    assert.ok(isRelayModel(m));
  }
  assert.ok(!isRelayModel('claude-opus-5-5') && !isRelayModel('openai/gpt-6.1-sol'));
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
  assert.equal(costOf('gpt-6-astra', usage), 10 + 50 + 1 + 10);
  assert.equal(costOf('gpt-6.1-sol', usage), 2 + 10 + 0.1 + 2);
  assert.equal(costOf('gpt-6.1-terra', usage), 1 + 5 + 0.05 + 1);
  assert.ok(Math.abs(costOf('gpt-6-luna', usage) - (0.1 + 0.5 + 0.01 + 0.1)) < 1e-12);
});

test('中转站接进网站：管理页列着 ChatGPT 的模型（价格、说明、有没有密钥）；选了的交给中转站调用，花费按价格表记；没设密钥时选不了', async () => {
  const inner = new FakeProvider(demoHandler);
  let ready = true;
  const relay: AiProvider = {
    name: 'relay',
    priced: true,
    get status() {
      return ready ? { ready: true, message: null } : { ready: false, message: '还没有设置 中转站 的 API 密钥（项目文件夹里 .env 文件的 RELAY_API_KEY），中转站 的模型暂时用不了。' };
    },
    async send(request, signal, hooks) {
      const response = await inner.send(request, signal, hooks);
      return { ...response, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } };
    },
  };
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), relay, tickMs: 0 });
  try {
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const player = await app.login(TESTER1.username, TESTER1.password);
    let info = (await app.call('GET', '/api/admin/ai', undefined, admin)).data;
    assert.ok(info.providers.some((p: { label: string; ready: boolean }) => p.label === '中转站' && p.ready));
    const sol = info.options.find((o: { model: string }) => o.model === 'gpt-6.1-sol');
    assert.deepEqual({ name: sol.name, price: sol.price, available: sol.available }, { name: 'GPT-6.1 Sol', price: { input: 2, output: 10 }, available: true });
    assert.match(sol.note, /经中转站调用，内容发给中转站和 OpenAI/);
    assert.deepEqual(
      info.options.filter((o: { model: string }) => isRelayModel(o.model)).map((o: { name: string }) => o.name),
      ['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6.1 Terra', 'GPT-6 Luna'],
    );

    // 杂活换成 GPT-6 Luna：估时交给中转站，花费按价格表算（输入 1000、缓存读 500、输出 200）
    info = (await app.call('PUT', '/api/admin/ai/models', { models: { misc: 'gpt-6-luna' } }, admin)).data;
    assert.equal(info.models.misc, 'gpt-6-luna');
    const room = (await app.call('POST', '/api/rooms', { name: '中转站局', maxPlayers: 2 }, player)).data.room;
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林记者' }, player)).status, 200);
    // 房主给这一局的主持选 GPT-6.1 Sol
    assert.equal((await app.call('PUT', `/api/rooms/${room.id}/model`, { dmModel: 'gpt-6.1-sol' }, player)).status, 200);
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/status`, { status: 'running' }, player)).status, 200);
    const log = (await app.call('GET', `/api/rooms/${room.id}/log`, undefined, player)).data.entries.map((e: { text: string }) => e.text);
    assert.ok(log.some((text: string) => text.includes('主持：GPT-6.1 Sol')), '记录里写模型的名字');
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/act`, { text: '我推开旅店的门。', as: 'action' }, player)).status, 201);
    await app.app.engine.idle();
    const calls = app.app.db.prepare('SELECT purpose, provider, model, cost_usd FROM ai_calls WHERE room_id = ? ORDER BY id').all(room.id) as {
      purpose: string;
      provider: string;
      model: string;
      cost_usd: number;
    }[];
    const estimate = calls.find((c) => c.purpose === 'estimate')!;
    assert.equal(estimate.provider, 'relay');
    assert.equal(estimate.model, 'gpt-6-luna');
    assert.ok(Math.abs(estimate.cost_usd - (1000 * 0.1 + 500 * 0.01 + 200 * 0.5) / 1_000_000) < 1e-12);

    // 没设密钥：选不了，已经选了的那一项说明原因
    ready = false;
    info = (await app.call('GET', '/api/admin/ai', undefined, admin)).data;
    assert.equal(info.options.find((o: { model: string }) => o.model === 'gpt-6-astra').available, false);
    const r = await app.call('PUT', '/api/admin/ai/models', { models: { dm: 'gpt-6-astra' } }, admin);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /RELAY_API_KEY/);
  } finally {
    await app.close();
  }
});

test('没接中转站（测试用的假主持人）：ChatGPT 的模型交给假主持人，照样能跑', async () => {
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  try {
    assert.equal(app.app.ai.providerFor('gpt-6.1-terra'), app.app.ai.provider);
    assert.equal(app.app.ai.relay, null);
  } finally {
    await app.close();
  }
});

// ==================== 额度一键清零 ====================

test('额度一键清零：只有站长能用；所有正式用户的可用额度变成 0（用掉的不变，剩下的记一笔收回）；游客、不限额度的、本来就用完了的不动', async () => {
  const app = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  try {
    const db = app.app.db;
    const owner = await app.login(ADMIN.username, ADMIN.password);
    const id = (username: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
    // 玩家二用掉了 1.5 美元；玩家三不限额度；玩家四本来就用完了；玩家一是管理员（有发放额度的权限）
    const call = Number(
      db.prepare("INSERT INTO ai_calls (provider, model, purpose, input_tokens, output_tokens, cost_usd, duration_ms, created_at) VALUES ('fake', 'deepseek-flash', 'answer', 1, 1, 1.5, 1, 1)").run()
        .lastInsertRowid,
    );
    db.prepare('INSERT INTO ai_call_shares (call_id, user_id, cost_usd) VALUES (?, ?, 1.5)').run(call, id(TESTER2.username));
    db.prepare('UPDATE users SET ai_unlimited = 1, ai_credit_usd = 7 WHERE id = ?').run(id(TESTER3.username));
    db.prepare('UPDATE users SET ai_credit_usd = 0 WHERE id = ?').run(id(TESTER4.username));
    db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["credit","users"]' WHERE id = ?`).run(id(TESTER1.username));
    const guest = await app.call('POST', '/api/auth/guest');
    assert.equal(guest.status, 201, JSON.stringify(guest.data));
    const before = (username: string) => creditOf(db, id(username));
    const t1 = before(TESTER1.username);
    const t2 = before(TESTER2.username);
    assert.ok(t2.remaining! > 0 && t2.spent === 1.5);
    const t5 = before('tester5');

    // 管理员（不是站长）、普通玩家都不能用
    const adminCookie = await app.login(TESTER1.username, TESTER1.password);
    assert.equal((await app.call('POST', '/api/admin/credit/zero-all', {}, adminCookie)).status, 403);
    const player = await app.login(TESTER2.username, TESTER2.password);
    assert.equal((await app.call('POST', '/api/admin/credit/zero-all', {}, player)).status, 403);

    const r = await app.call('POST', '/api/admin/credit/zero-all', {}, owner);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // 清零的：玩家一、二、五（站长、不限额度的玩家三没动，玩家四本来就是 0）
    assert.equal(r.data.zeroed, 3);
    assert.equal(r.data.unlimited, 2);
    assert.ok(Math.abs(r.data.takenUsd - (t1.remaining! + t2.remaining! + t5.remaining!)) < 1e-6, '收回的是剩下的');
    for (const u of [TESTER1.username, TESTER2.username, 'tester5']) assert.equal(before(u).remaining, 0, u);
    assert.equal(before(TESTER2.username).total, 1.5, '用掉的不变');
    assert.equal(before(TESTER3.username).unlimited, true);
    assert.equal((db.prepare('SELECT ai_credit_usd FROM users WHERE id = ?').get(id(TESTER3.username)) as { ai_credit_usd: number }).ai_credit_usd, 7);
    assert.equal(before(TESTER4.username).remaining, 0);
    const grants = db.prepare("SELECT user_id, amount_usd FROM credit_grants WHERE note = '一键清零' ORDER BY user_id").all() as { user_id: number; amount_usd: number }[];
    assert.deepEqual(
      grants.map((g) => g.user_id),
      [id(TESTER1.username), id(TESTER2.username), id('tester5')].sort((a, b) => a - b),
    );
    assert.ok(grants.every((g) => g.amount_usd < 0));
    const guestRow = db.prepare('SELECT ai_credit_usd FROM users WHERE id = ?').get(guest.data.user.id) as { ai_credit_usd: number };
    assert.equal(guestRow.ai_credit_usd, 0, '游客没有额度，不动');
    assert.ok(!grants.some((g) => g.user_id === guest.data.user.id));
    const audit = db.prepare("SELECT detail FROM admin_audit WHERE action = '所有正式用户的可用额度清零'").get() as { detail: string };
    assert.match(audit.detail, /3 个账号，一共收回 .* 美元；不限额度的 2 个没动/);
    // 玩家再用 AI（建角色时名字要先检查一遍）：额度用完了
    const room = (await app.call('POST', '/api/rooms', { name: '清零以后', maxPlayers: 2 }, player)).data.room;
    assert.equal((await app.call('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' }, player)).status, 200);
    const made = await app.call('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林记者' }, player);
    assert.equal(made.status, 403);
    assert.match(made.data.error, /AI 额度用完了/);
    // 再点一次：没有可清的了
    assert.deepEqual((await app.call('POST', '/api/admin/credit/zero-all', {}, owner)).data, { zeroed: 0, takenUsd: 0, unlimited: 2 });
  } finally {
    await app.close();
  }
});

// ==================== 版本 ====================

test('V1.0.1：版本号；更新公告写给玩家看（群号），不写管理页的功能和用的是哪家的模型', () => {
  // V1.0.2 起版本号往上走：不比 1.0.1 旧就行
  assert.ok(compareVersions(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, '1.0.1') >= 0);
  assert.ok(compareVersions(APP_VERSION, '1.0.1') >= 0);
  const note = RELEASE_NOTES.find((n) => n.version === '1.0.1')!;
  assert.equal(note.title, 'V1.0.1 更新了什么');
  assert.match(note.body, /QQ 群号：1130127996/);
  assert.match(note.body, /维护/);
  assert.doesNotMatch(note.body, /DeepSeek|Claude|ChatGPT|GPT|OpenAI|中转站|管理|站长|额度|清零/);
});

test('更新公告：内测的数据直接升到 V1.0.1（删档）发 V1.0.0 和 V1.0.1 两条；从 V1.0.0 升上来、全新的网站只发 V1.0.1 的', async () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v101-notes-'));
  try {
    // 内测版（第 22 版，公告发到 V0.9.2）的数据，用 V1.0.1 打开：先删档，公告从正式版发起
    const file = path.join(dir, 'beta.db');
    const beta = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
    await seedTestData(beta, now);
    beta.prepare("INSERT INTO settings (key, value) VALUES ('release_notes_posted', '0.9.2') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    beta.close();
    const db = openDatabase(file, { onBackup: () => {} });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0, '删了档');
      assert.deepEqual(postReleaseNotes(db, { now, version: '1.0.1' }), ['1.0.0', '1.0.1']);
      assert.deepEqual(
        (db.prepare('SELECT title FROM announcements ORDER BY id').all() as { title: string }[]).map((x) => x.title),
        ['V1.0.0 更新了什么', 'V1.0.1 更新了什么'],
        '旧的先发，不补发内测时的',
      );
      assert.deepEqual(postReleaseNotes(db, { now, version: '1.0.1' }), [], '只发一次');
    } finally {
      db.close();
    }

    // 已经在用 V1.0.0（公告发到了 1.0.0）：只发 V1.0.1 的
    const formal = openDatabase(path.join(dir, 'formal.db'), { onBackup: () => {} });
    try {
      assert.deepEqual(postReleaseNotes(formal, { now, version: '1.0.0' }), ['1.0.0']);
      assert.deepEqual(postReleaseNotes(formal, { now, version: '1.0.1' }), ['1.0.1']);
    } finally {
      formal.close();
    }

    // 全新的网站：只发现在这个版本的
    const fresh = openDatabase(':memory:');
    try {
      assert.deepEqual(postReleaseNotes(fresh, { now, version: '1.0.1' }), ['1.0.1']);
    } finally {
      fresh.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start.bat 列出的旧版本里有正式版也有内测版：写明第几个是内测版（复制它的会删档），正式版的照常保留', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v101-offer-'));
  try {
    const install = (name: string, version: string) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'scripts', 'upgrade.mjs'), path.join(dir, 'scripts', 'upgrade.mjs'));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ai-trpg', version }));
      return dir;
    };
    const formal = install('ai-trpg-V1.0.0', '1.0.0');
    const beta = install('ai-trpg-V0.9.2', '0.9.2');
    const fresh = install('ai-trpg-V1.0.1', '1.0.1');
    openDatabase(path.join(formal, 'data', 'game.db'), { onBackup: () => {} }).close();
    openDatabase(path.join(beta, 'data', 'game.db'), { onBackup: () => {}, upTo: BEFORE_WIPE }).close();
    const offer = async () => {
      const lines: string[] = [];
      assert.equal(await offerImport({ root: fresh, home: path.dirname(base), ask: async () => 'n', say: (t = '') => void lines.push(t) }), 'skipped');
      return lines;
    };
    const lines = await offer();
    const text = lines.join('\n');
    const n = lines.find((l) => l.includes(beta))!.trim().split('.')[0];
    assert.ok(lines.some((l) => l.includes(formal)), '正式版的也列出来了');
    assert.match(text, new RegExp(`上面第 ${n} 个是内测版本，复制它们的数据、第一次启动时会清空`));
    assert.match(text, /V1\.0\.0 以后的版本复制过来，数据照常保留，不清空/);
    // 只有内测版的：照原来的说法
    fs.rmSync(path.join(formal, 'data'), { recursive: true });
    const only = (await offer()).join('\n');
    assert.match(only, /注意：这是正式版 V1\.0\.1。内测版本的数据复制过来、第一次启动时会清空/);
    assert.doesNotMatch(only, /照常保留/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
