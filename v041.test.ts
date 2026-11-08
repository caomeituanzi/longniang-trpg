import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DEFAULT_AI_SETTINGS } from '../server/ai/client';
import { DEFAULT_CNY_RATE } from '../server/money';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { ALL_PERMISSIONS } from '../shared/admin';
import { USAGE_RULES } from '../shared/usage-rules';
import { startTestApp } from './helpers';

// V0.4.1：新账号的初始额度可以改；额度可以填人民币（按管理员设的汇率换成美元记）；四项模型默认都用 DeepSeek V4.1 Flash 1017。

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
const creditUsd = (username: string) => (t.app.db.prepare('SELECT ai_credit_usd FROM users WHERE username = ?').get(username) as { ai_credit_usd: number }).ai_credit_usd;
const lastAudit = () => ({ ...(t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string }) });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** 用邀请码注册一个新账号，返回他的额度（美元）。 */
async function register(username: string): Promise<number> {
  const invite = (await call('POST', '/api/admin/invites', 'admin', { note: username })).data.invite.code;
  const reg = await t.call('POST', '/api/auth/register', { inviteCode: invite, username, displayName: username, password: `${username}-pass-1`, agreeRules: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  return creditUsd(username);
}

test('默认：四项模型都用 DeepSeek V4.1 Flash 1017；汇率 6.68；使用规则不再写死 AI 由 Claude 提供', async () => {
  // V0.6.0 加了「向导」「审核」两项，也默认 DeepSeek V4.1 Flash 1017
  assert.deepEqual(DEFAULT_AI_SETTINGS.models, {
    dm: 'deepseek-flash',
    scenario: 'deepseek-flash',
    misc: 'deepseek-flash',
    guard: 'deepseek-flash',
    guide: 'deepseek-flash',
    review: 'deepseek-flash',
  });
  assert.deepEqual(t.app.ai.models, DEFAULT_AI_SETTINGS.models, '没在网页上选过、.env 里也没写时用默认的');
  const ai = (await call('GET', '/api/admin/ai', 'admin')).data;
  assert.deepEqual(ai.defaults, DEFAULT_AI_SETTINGS.models, '「恢复默认」回到 DeepSeek V4.1 Flash 1017');
  assert.equal(DEFAULT_CNY_RATE, 6.68);
  assert.equal((await call('GET', '/api/auth/me', 'tester1')).data.cnyRate, 6.68, '登录的人拿得到汇率（网页上换算人民币用）');
  assert.equal((await call('GET', '/api/auth/me', null)).data.cnyRate, 6.68);
  assert.match(USAGE_RULES[0].text, /默认是 DeepSeek/);
  assert.doesNotMatch(USAGE_RULES.map((r) => r.text).join(''), /由 Anthropic 的 Claude 提供|被 Claude 的安全机制/);
});

test('新账号的初始额度：默认 5 美元；有「发放额度」权限的管理员能改（美元或人民币，0～100 美元），只影响以后注册、新建的账号', async () => {
  assert.equal((await call('GET', '/api/admin/users', 'admin')).data.startCredit, 5);
  assert.equal(await register('start_a'), 5);

  // 改成 3 美元：新注册的、管理员新建的都是 3；已经有的不变
  let r = await call('PUT', '/api/admin/start-credit', 'admin', { amount: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.startCredit, 3);
  assert.deepEqual(lastAudit(), { action: '改新账号的初始额度', detail: '5.00 美元 → 3.00 美元' });
  assert.equal(await register('start_b'), 3);
  const made = await call('POST', '/api/admin/users', 'admin', { username: 'start_c', displayName: '新建的' });
  assert.equal(made.status, 201);
  assert.equal(creditUsd('start_c'), 3);
  assert.equal(creditUsd('start_a'), 5, '已经有的账号不变');

  // 填人民币：66.80 元按 6.68 换成 10 美元
  r = await call('PUT', '/api/admin/start-credit', 'admin', { amount: 66.8, currency: 'CNY' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(near(r.data.startCredit, 10));
  assert.match(lastAudit().detail, /3\.00 美元 → ¥66\.80（约 10\.00 美元）/);
  assert.ok(near(await register('start_d'), 10));
  // 0 也行（新账号没有额度，要管理员发）
  assert.equal((await call('PUT', '/api/admin/start-credit', 'admin', { amount: 0 })).data.startCredit, 0);
  assert.equal(await register('start_e'), 0);

  // 不合规矩的
  for (const body of [{ amount: -1 }, { amount: 101 }, { amount: 700, currency: 'CNY' }, { amount: 'abc' }, { amount: 5, currency: 'JPY' }]) {
    assert.equal((await call('PUT', '/api/admin/start-credit', 'admin', body)).status, 400, JSON.stringify(body));
  }
  assert.match((await call('PUT', '/api/admin/start-credit', 'admin', { amount: 700, currency: 'CNY' })).data.error, /¥668\.00（100 美元）/);
  // 没有「发放额度」权限的管理员改不了（看得到）
  assert.equal(
    (await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'admin', { role: 'admin', permissions: ALL_PERMISSIONS.filter((p) => p !== 'credit') })).status,
    200,
  );
  assert.equal((await call('PUT', '/api/admin/start-credit', 'tester2', { amount: 2 })).status, 403);
  assert.equal((await call('GET', '/api/admin/users', 'tester2')).data.startCredit, 0);
  assert.equal((await call('PUT', '/api/admin/start-credit', 'tester1', { amount: 2 })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${userId('tester2')}/role`, 'admin', { role: 'user' })).status, 200);
  await call('PUT', '/api/admin/start-credit', 'admin', { amount: 5 });
});

test('填人民币发额度：按汇率换成美元记，记录里写填的人民币；批量一样；收回时超过他的额度报人民币；正好收完不会因为小数尾巴报错', async () => {
  const id = userId('tester3');
  const before = creditUsd('tester3');
  let r = await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: 66.8, currency: 'CNY', note: '人民币发' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(near(creditUsd('tester3') - before, 10));
  assert.deepEqual(lastAudit(), { action: '发放额度', detail: `${TESTER3.displayName}（${TESTER3.username}）：+¥66.80（约 10.00 美元）（人民币发）` });
  const grant = t.app.db.prepare('SELECT amount_usd, note FROM credit_grants WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id) as { amount_usd: number; note: string };
  assert.ok(near(grant.amount_usd * 6.68, 66.8), '换回人民币还是填的那个数');

  // 美元照旧（不写币种是美元）
  r = await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(lastAudit(), { action: '发放额度', detail: `${TESTER3.displayName}（${TESTER3.username}）：+1.00 美元` });

  // 收回：超过他的额度，按填的那种钱说最多能收回多少
  const total = creditUsd('tester3');
  r = await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: -(total * 6.68 + 10), currency: 'CNY' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, new RegExp(`最多只能收回 ¥${(total * 6.68).toFixed(2).replace('.', '\\.')}`));
  // 正好全收回（人民币按分四舍五入，换算有小数尾巴）：不报错，额度是 0
  r = await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: -Number((total * 6.68).toFixed(2)), currency: 'CNY' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(creditUsd('tester3') >= 0 && creditUsd('tester3') < 0.001);
  assert.equal(lastAudit().action, '收回额度');

  // 太多、不是数、币种不对
  assert.match((await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: 7000, currency: 'CNY' })).data.error, /最多 ¥6680\.00（1000 美元）/);
  assert.equal((await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: 0.001, currency: 'CNY' })).status, 400);
  assert.equal((await call('POST', `/api/admin/users/${id}/credit`, 'admin', { amount: 5, currency: 'EUR' })).status, 400);

  // 批量：每人 ¥33.40（5 美元）
  const ids = [userId('tester1'), userId('tester3')];
  const b1 = creditUsd('tester1');
  r = await call('POST', '/api/admin/users/batch', 'admin', { op: 'credit', ids, amount: 33.4, currency: 'CNY', note: '批量' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.done.sort(), [...ids].sort());
  assert.ok(near(creditUsd('tester1') - b1, 5));
  assert.match(lastAudit().detail, /\+¥33\.40（约 5\.00 美元）（批量）/);
});

test('兑换码可以填人民币：按汇率换成美元记，兑换时加的是那么多；人民币也按 100 美元的上限算', async () => {
  let r = await call('POST', '/api/admin/credit-codes', 'admin', { amount: 33.4, currency: 'CNY', days: 7 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(near(r.data.code.amount, 5));
  assert.match(lastAudit().detail, /¥33\.40（约 5\.00 美元），单次，7天有效/);
  const before = creditUsd('tester2');
  const redeemed = await call('POST', '/api/me/redeem', 'tester2', { code: r.data.code.code });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.ok(near(creditUsd('tester2') - before, 5));

  r = await call('POST', '/api/admin/credit-codes', 'admin', { amount: 700, currency: 'CNY', days: 7 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /¥668\.00（100 美元）/);
  assert.equal((await call('POST', '/api/admin/credit-codes', 'admin', { amount: 2, days: 7 })).status, 201, '不写币种是美元');
});

test('汇率：有「发放额度」权限的管理员能改（1～20），网页上的人民币、以后填人民币发的额度都按新的汇率；改了记进操作记录', async () => {
  let r = await call('PUT', '/api/admin/cny-rate', 'admin', { rate: 7.1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cnyRate, 7.1);
  assert.deepEqual(lastAudit(), { action: '改汇率', detail: '1 美元 = 6.68 元 → 7.1 元' });
  assert.equal((await call('GET', '/api/auth/me', 'tester1')).data.cnyRate, 7.1);
  assert.equal((await call('GET', '/api/admin/users', 'admin')).data.cnyRate, 7.1);
  const before = creditUsd('tester1');
  assert.equal((await call('POST', `/api/admin/users/${userId('tester1')}/credit`, 'admin', { amount: 71, currency: 'CNY' })).status, 200);
  assert.ok(near(creditUsd('tester1') - before, 10), '按新的汇率换算');

  for (const rate of [0.5, 25, 'abc', null]) assert.equal((await call('PUT', '/api/admin/cny-rate', 'admin', { rate })).status, 400, String(rate));
  assert.equal((await call('PUT', '/api/admin/cny-rate', 'tester1', { rate: 7 })).status, 403);
  await call('PUT', '/api/admin/cny-rate', 'admin', { rate: 6.68 });
});
