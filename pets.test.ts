import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider, say, useTools } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse, TextBlock, ToolResultBlock } from '../server/ai/types';
import { cnyRate } from '../server/money';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

// V0.5.0 宠物：养、改名卡、商店、喂食、称号、打工（到点发工钱和通知）、龙晶换额度（每人每月、全站每月的上限，能关）、
// 管理员发龙晶和改设置、玩完剧本按分区成长（一局只算一次）、带着宠物进剧本（只陪伴，名字和介绍要检查）、主页上的宠物、关注列表。
// V0.7.0：龙晶、龙晶记录、买东西、换额度挪到商城（/api/shop），背包是 /api/bag，称号只在账号上（宠物页、主页的宠物上没有）。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const MIN = 60_000;
const HOUR = 60 * MIN;
let now = Date.UTC(2026, 9, 10, 3, 0, 0);

function lastUserText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 假主持人：估时看 [分钟 N]；行动里写了 [结局 key] 就宣布结局。 */
async function dm(req: MessagesRequest): Promise<MessagesResponse> {
  const context = lastUserText(req);
  if (req.output_config?.format) {
    const minutes = Number(context.match(/\[分钟 (\d+)\]/)?.[1] ?? 10);
    return say(JSON.stringify({ minutes, reason: '测试' }));
  }
  if (!req.tools?.length) return say('笔记：测试');
  const last = req.messages[req.messages.length - 1];
  const results = last.role === 'user' && Array.isArray(last.content) ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  if (results.length) return say('叙述：尘埃落定');
  const block = context.slice(context.indexOf('# 这次要结算的行动'));
  const quotes = [...block.matchAll(/「([^」]*)」/g)];
  const text = quotes[quotes.length - 1]?.[1] ?? '';
  const ending = text.match(/\[结局 ([^\]]+)\]/)?.[1];
  return ending ? useTools({ name: 'end_game', input: { ending, epilogue: '雾散了。' } }) : say(`叙述：${text}`);
}

const fake = new FakeProvider(dm);
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
/** 查一个值（第一行第一列）。 */
const one = (sql: string, ...params: (string | number)[]) => Object.values(t.app.db.prepare(sql).get(...params) as Record<string, unknown>)[0];
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
/** 商城页（V0.7.0）：龙晶、龙晶记录、换额度的情况。 */
const shopOf = async (cookie: string) => (await as(cookie)('GET', '/api/shop')).data;
const crystalsOf = async (cookie: string) => (await shopOf(cookie)).crystals as number;
/** 背包里吃的用的（V0.7.0）：key → 个数。 */
const supplies = async (cookie: string) =>
  Object.fromEntries(((await as(cookie)('GET', '/api/bag')).data.supplies as { key: string; count: number }[]).map((s) => [s.key, s.count]));
const PNG ='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('养宠物：游客不能养；名字要填对；一个账号一只；饱食度随时间降，精力满了不再涨', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await as(guest)('POST', '/api/pet', { name: '小游' })).status, 403);
  // V0.7.1：宠物页游客能打开看看（没有宠物），养不了
  assert.equal((await as(guest)('GET', '/api/pet')).data.pet, null);

  let page = (await as(t1)('GET', '/api/pet')).data;
  assert.equal(page.pet, null);
  // V0.7.0：龙晶不在宠物页，在商城
  assert.equal('crystals' in page, false);
  assert.equal(await crystalsOf(t1), 0);
  assert.equal((await as(t1)('POST', '/api/pet', { name: ' ' })).status, 400);
  assert.equal((await as(t1)('POST', '/api/pet', { name: '一二三四五六七八九十一二三' })).status, 400);
  assert.equal((await as(t1)('POST', '/api/pet', { name: '团子', description: 'x'.repeat(201) })).status, 400);
  const r = await as(t1)('POST', '/api/pet', { name: '团子', description: '一只圆滚滚的小龙' });
  assert.equal(r.status, 201);
  page = r.data;
  assert.deepEqual(
    { name: page.pet.name, description: page.pet.description, satiety: page.pet.satiety, energy: page.pet.energy, image: page.pet.image, job: page.pet.job },
    { name: '团子', description: '一只圆滚滚的小龙', satiety: 80, energy: 100, image: null, job: null },
  );
  assert.equal('title' in page.pet, false, '宠物不再有称号');
  assert.deepEqual(page.pet.attributes, { body: 0, agility: 0, intellect: 0, perception: 0, charm: 0 });
  assert.equal((await as(t1)('POST', '/api/pet', { name: '第二只' })).data.error, '你已经有宠物了');

  now += 10 * HOUR;
  page = (await as(t1)('GET', '/api/pet')).data;
  assert.equal(page.pet.satiety, 60);
  assert.equal(page.pet.energy, 100);
});

test('换图：只收图片，太大的不收；主页上看得到宠物', async () => {
  assert.equal((await as(t1)('PUT', '/api/pet/image', { image: 'data:image/png;base64,aGVsbG8=' })).data.error, '只能用 PNG、JPEG 或 WebP 图片');
  assert.equal((await as(t1)('PUT', '/api/pet/image', { image: 'not an image' })).status, 400);
  const big = 'data:image/png;base64,' + Buffer.alloc(181 * 1024).toString('base64');
  assert.equal((await as(t1)('PUT', '/api/pet/image', { image: big })).data.error, '图片太大了，最大 180 KB');
  // 超过请求大小上限的：没读完就回了，这条连接关掉，后面的请求照常
  const huge = 'data:image/png;base64,' + Buffer.alloc(300 * 1024).toString('base64');
  assert.equal((await as(t1)('PUT', '/api/pet/image', { image: huge })).data.error, '内容太长了');
  const page = (await as(t1)('PUT', '/api/pet/image', { image: PNG })).data;
  assert.match(page.pet.image, new RegExp(`^/api/pets/${publicId(TESTER1.username)}/image\\?v=\\d+$`));
  const img = await fetch(t.base + page.pet.image, { headers: { cookie: t2 } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  // 主页：别人（游客也行）看得到名字、介绍、图、属性
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  const profile = (await as(guest)('GET', `/api/users/${publicId(TESTER1.username)}`)).data;
  // V0.6.0 起还有装扮、串门（游客不能串门）；V0.7.0 去掉了宠物身上的称号、宠物留言
  assert.deepEqual(profile.pet, {
    name: '团子',
    description: '一只圆滚滚的小龙',
    image: page.pet.image,
    attributes: page.pet.attributes,
    outfit: null,
    visit: null,
  });
  assert.equal((await as(t1)('GET', `/api/users/${publicId(TESTER2.username)}`)).data.pet, null);
  // 去掉图
  assert.equal((await as(t1)('DELETE', '/api/pet/image')).data.pet.image, null);
  assert.equal((await fetch(t.base + page.pet.image, { headers: { cookie: t2 } })).status, 404);
});

test('管理员发龙晶：和发额度一样，管理员不能给自己发、管理员的号只有站长能动；游客没有龙晶；账号详情里看得到', async () => {
  const id1 = userId(TESTER1.username);
  assert.equal((await as(t1)('POST', `/api/admin/users/${id1}/crystals`, { amount: 100 })).status, 403);
  assert.equal((await as(admin)('POST', `/api/admin/users/${id1}/crystals`, { amount: 1.5 })).status, 400);
  assert.equal((await as(admin)('POST', `/api/admin/users/${id1}/crystals`, { amount: 0 })).status, 400);
  let r = await as(admin)('POST', `/api/admin/users/${id1}/crystals`, { amount: 500, note: '内测奖励' });
  assert.equal(r.status, 200);
  assert.equal(r.data.crystals, 500);
  assert.deepEqual(
    { kind: r.data.ledger[0].kind, delta: r.data.ledger[0].delta, detail: r.data.ledger[0].detail, by: r.data.ledger[0].by },
    { kind: 'grant', delta: 500, detail: '内测奖励', by: '测试管理员' },
  );
  // 收回：不能收到负数
  assert.equal((await as(admin)('POST', `/api/admin/users/${id1}/crystals`, { amount: -600 })).status, 409);
  // 账号详情
  const detail = (await as(admin)('GET', `/api/admin/users/${id1}`)).data;
  assert.equal(detail.pets.crystals, 500);
  assert.deepEqual(detail.pets.pet, { name: '团子', satiety: 60, energy: 100, job: null });
  // 游客
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  const guestId = (await as(guest)('GET', '/api/auth/me')).data.user.id as number;
  assert.equal((await as(admin)('POST', `/api/admin/users/${guestId}/crystals`, { amount: 10 })).data.error, '游客没有龙晶');
  assert.equal((await as(admin)('GET', `/api/admin/users/${guestId}`)).data.pets, null);
  // 有「发放额度」权限的管理员
  const id4 = userId(TESTER4.username);
  const id5 = userId(TESTER5.username);
  assert.equal((await as(admin)('PUT', `/api/admin/users/${id5}/role`, { role: 'admin', permissions: ['credit'] })).status, 200);
  assert.equal((await as(admin)('PUT', `/api/admin/users/${id4}/role`, { role: 'admin', permissions: ['credit'] })).status, 200);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('POST', `/api/admin/users/${id5}/crystals`, { amount: 10 })).data.error, '不能给自己发龙晶');
  assert.equal((await as(t5)('POST', `/api/admin/users/${id4}/crystals`, { amount: 10 })).data.error, '只有站长能对管理员改龙晶');
  assert.equal((await as(t5)('POST', `/api/admin/users/${userId(ADMIN.username)}/crystals`, { amount: 10 })).data.error, '站长的账号不能被改龙晶');
  assert.equal((await as(t5)('POST', `/api/admin/users/${userId(TESTER3.username)}/crystals`, { amount: 10 })).status, 200);
  assert.equal((await as(admin)('POST', `/api/admin/users/${id4}/crystals`, { amount: 10 })).status, 200);
  await as(admin)('PUT', `/api/admin/users/${id5}/role`, { role: 'user' });
  await as(admin)('PUT', `/api/admin/users/${id4}/role`, { role: 'user' });
  const audit = t.app.db.prepare("SELECT action, detail FROM admin_audit WHERE action IN ('发龙晶', '收回龙晶') ORDER BY id").all() as { action: string; detail: string }[];
  assert.equal(audit.length, 3);
  assert.match(audit[0].detail, /测试玩家一.*\+500（内测奖励），现在 500/);
});

test('商城和背包：买吃的、喂食（吃饱了喂不进）、提神茶、改名卡（在背包里用）、称号（只能买一次，买了才能戴，只戴在账号上）', async () => {
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'nothing' })).status, 404);
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'fish', count: 21 })).status, 400);
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'fish', count: 0 })).status, 400);
  const shop = (await as(t1)('POST', '/api/shop/buy', { item: 'fish', count: 3 })).data;
  // V0.6.0 吃的降价：小鱼干 5 龙晶一条
  assert.equal(shop.crystals, 500 - 15);
  assert.deepEqual(await supplies(t1), { fish: 3 });
  assert.deepEqual({ kind: shop.ledger[0].kind, delta: shop.ledger[0].delta, detail: shop.ledger[0].detail }, { kind: 'buy', delta: -15, detail: '小鱼干 × 3' });
  // 喂：60 → 80 → 100，再喂就吃不下了
  let page = (await as(t1)('POST', '/api/pet/use', { item: 'fish' })).data;
  assert.equal(page.pet.satiety, 80);
  assert.equal((await supplies(t1)).fish, 2);
  page = (await as(t1)('POST', '/api/pet/use', { item: 'fish' })).data;
  assert.equal(page.pet.satiety, 100);
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'fish' })).data.error, '团子吃饱了，吃不下了');
  assert.equal((await supplies(t1)).fish, 1, '吃不下的没用掉');
  // 背包里没有的、不能直接用的
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'skewer' })).status, 409);
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'rename' })).data.error, '这个东西不能直接用');
  // 提神茶：精神正好的时候用不着
  await as(t1)('POST', '/api/shop/buy', { item: 'tea' });
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'tea' })).data.error, '团子精神正好，用不着喝茶');
  // 改名：没有改名卡改不了；改介绍不花钱
  assert.equal((await as(t1)('PUT', '/api/pet', { name: '大团子' })).data.error, '背包里没有改名卡了');
  page = (await as(t1)('PUT', '/api/pet', { description: '一只圆滚滚、爱吃鱼干的小龙' })).data;
  assert.equal(page.pet.description, '一只圆滚滚、爱吃鱼干的小龙');
  // 改名卡在背包里「使用」：就是给宠物改名字
  await as(t1)('POST', '/api/shop/buy', { item: 'rename' });
  assert.equal((await supplies(t1)).rename, 1);
  page = (await as(t1)('PUT', '/api/pet', { name: '大团子' })).data;
  assert.equal(page.pet.name, '大团子');
  assert.equal((await supplies(t1)).rename, undefined);
  // 名字没变不用卡
  assert.equal((await as(t1)('PUT', '/api/pet', { name: '大团子', description: '还是那只小龙' })).status, 200);
  // 称号：在「装扮」里戴（/api/me/title），只在账号上
  assert.equal((await as(t1)('PUT', '/api/me/title', { title: 'title-novice' })).data.error, '先在商城里买这个称号');
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'title-novice', count: 2 })).data.error, '称号买一个就够了');
  const bought = (await as(t1)('POST', '/api/shop/buy', { item: 'title-novice' })).data;
  const novice = bought.items.find((i: { key: string }) => i.key === 'title-novice');
  assert.deepEqual([novice.owned, novice.max, novice.note], [1, 0, '已经有了']);
  assert.equal('title-novice' in (await supplies(t1)), false, '称号不在背包的吃的用的里');
  assert.equal((await as(t1)('POST', '/api/shop/buy', { item: 'title-novice' })).data.error, '这个称号你已经有了');
  assert.equal((await as(t1)('PUT', '/api/me/title', { title: 'title-novice' })).data.current, 'title-novice');
  assert.equal((await as(t1)('GET', '/api/wardrobe')).data.title, 'title-novice');
  const profile = (await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data;
  assert.equal(profile.title, '初出茅庐');
  assert.equal('title' in profile.pet, false);
  assert.equal((await as(t1)('PUT', '/api/me/title', { title: null })).data.current, null);
  assert.equal((await as(t1)('PUT', '/api/me/title', { title: 'fish' })).status, 404);
  // 宠物页的称号接口没有了
  assert.equal((await as(t1)('PUT', '/api/pet/title', { title: 'title-novice' })).status, 404);
  // 龙晶不够
  const r = await as(t1)('POST', '/api/shop/buy', { item: 'title-rich' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /^龙晶不够：要 1000，只有 \d+$/);
});

test('打工：属性、精力、饱食度不够不能去；打工的时候精力不回；到点发工钱、发通知；中途不干了没有工钱', async () => {
  // 第二档要属性 3
  let r = await as(t1)('POST', '/api/pet/job', { job: 'escort' });
  assert.equal(r.data.error, '这份工要体魄到 3，大团子现在是 0');
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'nothing' })).status, 404);
  const before = (await as(t1)('GET', '/api/pet')).data;
  const crystalsBefore = await crystalsOf(t1);
  // 第一档：1 小时，花 20 精力、10 饱食度，挣 10
  let page = (await as(t1)('POST', '/api/pet/job', { job: 'porter' })).data;
  assert.equal(page.pet.energy, before.pet.energy - 20);
  assert.equal(page.pet.satiety, before.pet.satiety - 10);
  assert.deepEqual({ key: page.pet.job.key, endsAt: page.pet.job.endsAt, pay: page.pet.job.pay }, { key: 'porter', endsAt: now + HOUR, pay: 10 });
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'courier' })).data.error, '大团子正在打工，回来了再说');
  // 不干了：没有工钱，花掉的不退
  page = (await as(t1)('DELETE', '/api/pet/job')).data;
  assert.equal(page.pet.job, null);
  assert.equal(await crystalsOf(t1), crystalsBefore);
  assert.equal(page.pet.energy, before.pet.energy - 20);
  assert.equal((await as(t1)('DELETE', '/api/pet/job')).data.error, '大团子现在没在打工');

  page = (await as(t1)('POST', '/api/pet/job', { job: 'copyist' })).data;
  const energy = page.pet.energy;
  now += 30 * MIN;
  assert.equal((await as(t1)('GET', '/api/pet')).data.pet.energy, energy, '打工的时候精力不回');
  // 到点了：每分钟检查一次，发工钱、发通知
  now += 31 * MIN;
  t.app.pets.sweepJobs();
  page = (await as(t1)('GET', '/api/pet')).data;
  assert.equal(page.pet.job, null);
  const shop = await shopOf(t1);
  assert.equal(shop.crystals, crystalsBefore + 10);
  assert.deepEqual({ kind: shop.ledger[0].kind, delta: shop.ledger[0].delta, detail: shop.ledger[0].detail }, { kind: 'job', delta: 10, detail: '大团子做完「抄书」' });
  const note = (await as(t1)('GET', '/api/notifications')).data.items[0];
  assert.deepEqual({ kind: note.kind, data: note.data }, { kind: 'pet_job_done', data: { pet: '大团子', job: '抄书', pay: 10 } });
  // 下班以后精力按时间回：下班 1 分钟，回了一点点（取整前 4/60）
  assert.equal(page.pet.energy, energy);
  now += HOUR;
  assert.equal((await as(t1)('GET', '/api/pet')).data.pet.energy, energy + 4);
  // 再结算一次也不会重复发
  t.app.pets.sweepJobs();
  assert.equal(await crystalsOf(t1), crystalsBefore + 10);

  // 精力、饱食度不够
  t.app.db.prepare('UPDATE pets SET energy = 10, state_at = ? WHERE user_id = ?').run(now, userId(TESTER1.username));
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'porter' })).data.error, '大团子没精神了：这份工要 20 点精力，现在只有 10');
  // 喝提神茶
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'tea' })).data.pet.energy, 60);
  t.app.db.prepare('UPDATE pets SET satiety = 5, state_at = ? WHERE user_id = ?').run(now, userId(TESTER1.username));
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'porter' })).data.error, '大团子饿着肚子：这份工要 10 点饱食度，现在只有 5');
  await as(t1)('POST', '/api/pet/use', { item: 'fish' });
  assert.equal((await as(t1)('POST', '/api/pet/job', { job: 'porter' })).status, 200);
  // 没人看的时候也会到点结算（应用里每分钟一次）
  now += HOUR;
  t.app.pets.sweepJobs();
  assert.equal(one('SELECT job FROM pets WHERE user_id = ?', userId(TESTER1.username)), null);
});

test('龙晶换额度（V0.7.0 起是商城里的一件商品）：按设置的比例；每人每月、全站每月有上限；额度不限的、关掉以后不能换；下个月重新算', async () => {
  const id1 = userId(TESTER1.username);
  const id3 = userId(TESTER3.username);
  const exchange = (cookie: string, yuan: unknown) => as(cookie)('POST', '/api/shop/buy', { item: 'exchange', count: yuan });
  // 默认 100 龙晶换 1 元，每人每月 5 元，全站每月 50 元
  let page = await shopOf(t1);
  assert.deepEqual(
    { enabled: page.exchange.enabled, rate: page.exchange.rate, userCap: page.exchange.userCap, siteCap: page.exchange.siteCap, used: page.exchange.usedThisMonth, left: page.exchange.siteLeft },
    { enabled: true, rate: 100, userCap: 5, siteCap: 50, used: 0, left: 50 },
  );
  const item = page.items.find((i: { key: string }) => i.key === 'exchange');
  assert.deepEqual([item.price, item.max, item.note], [100, 5, null]);
  await as(admin)('POST', `/api/admin/users/${id1}/crystals`, { amount: 1000 });
  const crystals = await crystalsOf(t1);
  const creditBefore = (await as(t1)('GET', '/api/auth/me')).data.credit.total as number;
  assert.equal((await exchange(t1, 1.5)).status, 400);
  assert.equal((await exchange(t1, 0)).status, 400);
  assert.equal((await exchange(t1, '2')).status, 400);
  page = (await exchange(t1, 2)).data;
  assert.equal(page.crystals, crystals - 200);
  assert.equal(page.exchange.usedThisMonth, 2);
  assert.equal(page.exchange.siteLeft, 48);
  assert.deepEqual({ kind: page.ledger[0].kind, delta: page.ledger[0].delta, detail: page.ledger[0].detail }, { kind: 'exchange', delta: -200, detail: '换了 2 元 AI 额度' });
  const creditAfter = (await as(t1)('GET', '/api/auth/me')).data.credit.total as number;
  assert.ok(Math.abs(creditAfter - creditBefore - 2 / cnyRate(t.app.db)) < 1e-4, '额度按汇率加上了');
  const grant = t.app.db.prepare('SELECT amount_usd, granted_by, note FROM credit_grants WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id1) as { amount_usd: number; granted_by: number | null; note: string };
  assert.deepEqual({ by: grant.granted_by, note: grant.note }, { by: null, note: '龙晶换额度（200 龙晶换 2 元）' });
  // 每人每月 5 元
  assert.equal((await exchange(t1, 4)).data.error, '每人每月最多换 5 元，这个月你还能换 3 元');
  assert.equal((await exchange(t1, 3)).status, 200);
  const used = (await shopOf(t1)).items.find((i: { key: string }) => i.key === 'exchange');
  assert.deepEqual([used.max, used.note], [0, '这个月换不了了']);
  // 额度不限的（站长）用不着换
  assert.equal((await exchange(admin, 1)).data.error, '你的额度不限，用不着换');
  // 管理员能改换额度的设置，自己不能换（和不能给自己发额度一样）
  const id4 = userId(TESTER4.username);
  await as(admin)('PUT', `/api/admin/users/${id4}/role`, { role: 'admin', permissions: ['credit'] });
  await as(admin)('POST', `/api/admin/users/${id4}/crystals`, { amount: 300 });
  const t4 = await t.login(TESTER4.username, TESTER4.password);
  assert.equal((await shopOf(t4)).exchange.adminBlocked, true);
  const blocked = await exchange(t4, 1);
  assert.deepEqual([blocked.status, blocked.data.error], [403, '管理员不能用龙晶换额度']);
  await as(admin)('PUT', `/api/admin/users/${id4}/role`, { role: 'user' });
  assert.equal((await shopOf(t4)).exchange.adminBlocked, false);

  // 管理员改设置：要有「发放额度」权限；数字要填对；记操作记录
  assert.equal((await as(t1)('GET', '/api/admin/pets')).status, 403);
  assert.equal((await as(admin)('PUT', '/api/admin/pets/exchange', { enabled: true, rate: 0, userCap: 5, siteCap: 50 })).status, 400);
  assert.equal((await as(admin)('PUT', '/api/admin/pets/exchange', { rate: 100, userCap: 5, siteCap: 50 })).status, 400);
  let r = await as(admin)('PUT', '/api/admin/pets/exchange', { enabled: true, rate: 50, userCap: 10, siteCap: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.exchange, { enabled: true, rate: 50, userCap: 10, siteCap: 7 });
  assert.equal(r.data.siteUsedThisMonth, 5);
  const audit = one("SELECT detail FROM admin_audit WHERE action = '改龙晶换额度' ORDER BY id DESC LIMIT 1") as string;
  assert.equal(audit, '开着，100 龙晶换 1 元，每人每月 5 元，全站每月 50 元 → 开着，50 龙晶换 1 元，每人每月 10 元，全站每月 7 元');
  // 全站这个月只剩 2 元
  await as(admin)('POST', `/api/admin/users/${id3}/crystals`, { amount: 500 });
  assert.equal((await exchange(t3, 3)).data.error, '这个月全站能换的额度只剩 2 元了');
  page = (await exchange(t3, 2)).data;
  assert.equal(page.ledger[0].delta, -100, '按新的比例：50 龙晶换 1 元');
  // 管理页：最近换的
  const overview = (await as(admin)('GET', '/api/admin/pets')).data;
  assert.equal(overview.siteUsedThisMonth, 7);
  assert.deepEqual(
    overview.recent.map((e: { name: string; crystals: number; yuan: number }) => [e.name, e.crystals, e.yuan]),
    [
      ['测试玩家三', 100, 2],
      ['测试玩家一', 300, 3],
      ['测试玩家一', 200, 2],
    ],
  );
  // 关掉：商城里没有这一件了，硬买也不行
  r = await as(admin)('PUT', '/api/admin/pets/exchange', { enabled: false, rate: 50, userCap: 10, siteCap: 7 });
  page = await shopOf(t3);
  assert.equal(page.exchange, null);
  assert.equal(page.items.some((i: { key: string }) => i.key === 'exchange'), false);
  assert.equal((await exchange(t3, 1)).data.error, '现在不能用龙晶换额度');
  // 下个月重新算
  await as(admin)('PUT', '/api/admin/pets/exchange', { enabled: true, rate: 100, userCap: 5, siteCap: 50 });
  now = Date.UTC(2026, 10, 2, 3, 0, 0);
  page = await shopOf(t1);
  assert.equal(page.exchange.usedThisMonth, 0);
  assert.equal(page.exchange.siteLeft, 50);
  assert.equal((await exchange(t1, 1)).status, 200);
  // 以前的接口没有了
  assert.equal((await as(t1)('POST', '/api/pet/exchange', { yuan: 1 })).status, 404);
});

/** 建一局（计时模式）、导入剧本、成员各自建角色，开始。 */
async function startedRoom(host: string, guests: string[], scenario: object, characters: Record<string, object>) {
  const room = (await as(host)('POST', '/api/rooms', { name: '宠物测试局', maxPlayers: 4 })).data.room;
  for (const g of guests) assert.equal((await as(g)('POST', '/api/rooms/join', { code: room.joinCode })).status, 200);
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/scenario`, scenario)).status, 200);
  for (const [cookie, character] of Object.entries(characters)) {
    const r = await as(cookie)('PUT', `/api/rooms/${room.id}/character`, character);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal((await as(host)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  return room.id as number;
}

/** 交一个行动，让时间过去（计时模式下最少等 15 分钟，最多 2 小时），结算完。 */
async function act(roomId: number, cookie: string, content: string, waitMinutes = 16) {
  const r = await as(cookie)('POST', `/api/rooms/${roomId}/actions`, { content: `${content} [分钟 10]` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.engine.idle();
  now += waitMinutes * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

test('带着宠物进剧本：只陪伴；名字和介绍和角色名一起检查；别人看得到；主持 AI 知道；可以不带', async () => {
  const room = (await as(t1)('POST', '/api/rooms', { name: '带宠物', maxPlayers: 4 })).data.room;
  await as(t2)('POST', '/api/rooms/join', { code: room.joinCode });
  await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' });
  // 没宠物的不能带
  assert.equal((await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'detective', name: '沈探', withPet: true })).data.error, '你还没有宠物');
  // 带上：名字、介绍发给 AI 检查
  fake.guardRequests.length = 0;
  let game = (await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小满', withPet: true })).data;
  assert.deepEqual(game.me.pet, { name: '大团子', description: '还是那只小龙' });
  assert.deepEqual(game.myPet, { name: '大团子', description: '还是那只小龙' });
  const checked = JSON.stringify(fake.guardRequests.map((q) => q.messages));
  assert.ok(checked.includes('带着的宠物：大团子（还是那只小龙）'), '宠物的名字和介绍检查过');
  // 别人看得到
  game = (await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'detective', name: '沈探' })).data;
  assert.equal(game.me.pet, null);
  assert.equal(game.others.find((c: { name: string }) => c.name === '林小满').petName, '大团子');
  // 只改名字：宠物照旧带着，不用再查宠物
  fake.guardRequests.length = 0;
  game = (await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小雨' })).data;
  assert.equal(game.me.pet.name, '大团子');
  assert.ok(!JSON.stringify(fake.guardRequests.map((q) => q.messages)).includes('带着的宠物'));
  // 不带了
  game = (await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小雨', withPet: false })).data;
  assert.equal(game.me.pet, null);
  // 宠物介绍违规：带进剧本的时候查出来（第一次警告），角色没改
  await as(t1)('PUT', '/api/pet', { description: '测试违规' });
  const r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小雨', withPet: true });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /这是警告/);
  assert.equal(one('SELECT source FROM violations WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId(TESTER1.username)), 'character');
  t.app.db.prepare('UPDATE violations SET dismissed = 1 WHERE user_id = ?').run(userId(TESTER1.username));
  assert.equal((await as(t1)('GET', `/api/rooms/${room.id}/game`)).data.me.pet, null);
  await as(t1)('PUT', '/api/pet', { description: '还是那只小龙' });
});

test('玩完剧本：走到结局、自己交过至少 3 个行动的人，在分区对应的属性上成长、拿龙晶；一局只算一次；没写分区的只拿龙晶', async () => {
  const fight = { data: { ...structuredClone(fog), title: '雾港械斗', category: 'combat' } };
  const crystals1 = await crystalsOf(t1);
  const roomId = await startedRoom(t1, [t2], fight, {
    [t1]: { roleKey: 'reporter', name: '林小满', withPet: true },
    [t2]: { roleKey: 'detective', name: '沈探' },
  });
  // 宠物写进了日志，主持 AI 的材料里有
  const entries = (await as(t2)('GET', `/api/rooms/${roomId}/log`)).data.entries as { text: string }[];
  assert.ok(entries.some((e) => e.text.includes('建好了角色「林小满」（上海来的记者），带着宠物「大团子」')));
  fake.requests.length = 0;
  await act(roomId, t1, '我四处看看');
  assert.ok(JSON.stringify(fake.requests).includes('带着宠物：「大团子」，玩家写的介绍：「还是那只小龙」（只陪伴'), '主持 AI 知道带着宠物');
  await act(roomId, t2, '我也看看');
  await act(roomId, t2, '我再看看');
  await act(roomId, t1, '我翻翻柜台');
  await act(roomId, t1, '把证据交给陆探长 [结局 truth]');
  assert.equal((await as(t1)('GET', `/api/rooms/${roomId}`)).data.room.status, 'ended');
  // tester1：3 个行动，体魄 +1，龙晶 +20；tester2：2 个行动，不算。
  // V0.6.0：第一次玩完剧本、带着宠物玩完，各是一个成就，各 +20（导入的剧本不在剧本大厅里，不记结局图鉴）
  let page = (await as(t1)('GET', '/api/pet')).data;
  assert.equal(page.pet.attributes.body, 1);
  assert.equal(page.growth.body, 1);
  // 龙晶的进出在商城的「龙晶记录」里
  const gained = (p: { ledger: { kind: string; delta: number; detail: string }[] }, n: number) => p.ledger.slice(0, n).map((l) => [l.kind, l.delta, l.detail]).reverse();
  let shop = await shopOf(t1);
  assert.deepEqual(gained(shop, 3), [
    ['game', 20, '玩完《雾港械斗》'],
    ['achievement', 20, '成就「初入江湖」'],
    ['achievement', 20, '成就「形影不离」'],
  ]);
  assert.equal(shop.crystals, crystals1 + 60);
  assert.deepEqual(
    page.games.map((g: { title: string; attribute: string }) => [g.title, g.attribute]),
    [['雾港械斗', 'body']],
  );
  assert.equal(await crystalsOf(t2), 0);
  assert.equal(one('SELECT COUNT(*) FROM pet_growth WHERE user_id = ?', userId(TESTER2.username)), 0);
  // 一局只算一次
  t.app.pets.growFromGame(roomId);
  assert.equal(await crystalsOf(t1), crystals1 + 60);
  assert.equal(one('SELECT COUNT(*) FROM pet_growth WHERE room_id = ?', roomId), 1);
  // 主页上的属性跟着变
  assert.equal((await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data.pet.attributes.body, 1);

  // 没写分区的剧本（雾港旅店）：只拿龙晶，不长属性；还没养宠物也记着
  const before3 = await crystalsOf(t3);
  const solo = await startedRoom(t3, [], { key: 'fog-harbor-inn' }, { [t3]: { roleKey: 'doctor', name: '许医生' } });
  await act(solo, t3, '我看看');
  await act(solo, t3, '我再看看');
  await act(solo, t3, '真相大白 [结局 truth]');
  page = (await as(t3)('GET', '/api/pet')).data;
  assert.equal(page.pet, null);
  // 玩完剧本 +20；《雾港旅店》在测试的剧本大厅里：第一次达成这个结局 +10；第一次玩完剧本的成就 +20
  shop = await shopOf(t3);
  assert.deepEqual(gained(shop, 3), [
    ['game', 20, '玩完《雾港旅店》'],
    ['ending', 10, '第一次达成《雾港旅店》的结局「真相大白」'],
    ['achievement', 20, '成就「初入江湖」'],
  ]);
  assert.equal(shop.crystals, before3 + 50);
  assert.deepEqual(page.growth, { body: 0, agility: 0, intellect: 0, perception: 0, charm: 0 });
  assert.deepEqual(
    page.games.map((g: { title: string; attribute: string | null }) => [g.title, g.attribute]),
    [['雾港旅店', null]],
  );
});

test('假主持人：行动里写了「测试结局」就走到剧本的第一个结局（不接 AI 也能验宠物成长）', async () => {
  fake.handler = demoHandler;
  try {
    const before = (await as(t1)('GET', '/api/pet')).data;
    const crystalsBefore = await crystalsOf(t1);
    const ledgerBefore = (t.app.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM crystal_ledger').get() as { id: number }).id;
    const roomId = await startedRoom(t1, [], { key: 'qingxi-lantern-night' }, { [t1]: { roleKey: 'scholar', name: '阿青' } });
    await act(roomId, t1, '我四处看看', 121);
    await act(roomId, t1, '我再看看', 121);
    await act(roomId, t1, '把灯点上 测试结局', 121);
    const game = (await as(t1)('GET', `/api/rooms/${roomId}/game`)).data;
    const qingxi = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', 'qingxi-lantern-night.json'), 'utf8'));
    assert.equal(game.ending.title, qingxi.endings[0].title);
    assert.equal((await as(t1)('GET', `/api/rooms/${roomId}`)).data.room.status, 'ended');
    const page = (await as(t1)('GET', '/api/pet')).data;
    assert.equal(page.pet.attributes.intellect, before.pet.attributes.intellect + 1, '解谜长智识');
    // 玩完剧本 +20，第一次达成这个结局 +10（V0.6.0 结局图鉴）；假主持人的检定是真掷骰子，碰巧掷出大成功、大失败解锁的成就另算
    const fromAchievements = (
      t.app.db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM crystal_ledger WHERE user_id = ? AND kind = 'achievement' AND id > ?").get(userId(TESTER1.username), ledgerBefore) as { n: number }
    ).n;
    assert.equal(await crystalsOf(t1), crystalsBefore + 30 + fromAchievements);
  } finally {
    fake.handler = dm;
  }
});

test('删掉的对局的编号给新的对局再用：新的一局照样算成长', async () => {
  const before = await crystalsOf(t3);
  const first = await startedRoom(t3, [], { key: 'fog-harbor-inn' }, { [t3]: { roleKey: 'doctor', name: '许医生' } });
  await act(first, t3, '我看看');
  await act(first, t3, '我再看看');
  await act(first, t3, '真相大白 [结局 truth]');
  // 这个结局上一个测试里已经达成过：只有玩完剧本的 20
  assert.equal(await crystalsOf(t3), before + 20);
  assert.equal((await as(t3)('DELETE', `/api/rooms/${first}`)).status, 200);
  now += MIN;
  const second = await startedRoom(t3, [], { key: 'fog-harbor-inn' }, { [t3]: { roleKey: 'doctor', name: '许医生' } });
  assert.equal(second, first, 'SQLite 把删掉的最大编号给了新的对局');
  await act(second, t3, '我看看');
  await act(second, t3, '我再看看');
  await act(second, t3, '真相大白 [结局 truth]');
  assert.equal(await crystalsOf(t3), before + 40);
});

test('社交页的关注列表：带着作品数；屏蔽以后互相不再关注；删账号清掉宠物', async () => {
  const id2 = userId(TESTER2.username);
  assert.equal((await as(t1)('POST', `/api/users/${publicId(TESTER2.username)}/follow`)).status, 200);
  assert.equal((await as(t2)('POST', `/api/users/${publicId(TESTER1.username)}/follow`)).status, 200);
  let follows = (await as(t1)('GET', '/api/follows')).data;
  assert.deepEqual(
    follows.following.map((f: { displayName: string; works: number; latest: unknown }) => [f.displayName, f.works, f.latest]),
    [['测试玩家二', 0, null]],
  );
  assert.equal(follows.followers, 1);
  // 屏蔽
  assert.equal((await as(t1)('POST', '/api/blocks', { user: TESTER2.username })).status, 200);
  follows = (await as(t1)('GET', '/api/follows')).data;
  assert.deepEqual(follows.following, []);
  assert.equal(follows.followers, 0);
  assert.equal((await as(t2)('POST', `/api/users/${publicId(TESTER1.username)}/follow`)).status, 403);
  await as(t1)('DELETE', `/api/blocks/${TESTER2.username}`);
  // 删账号：宠物、背包都清掉
  await as(t2)('POST', '/api/pet', { name: '小灰' });
  await as(admin)('POST', `/api/admin/users/${id2}/crystals`, { amount: 50 });
  await as(t2)('POST', '/api/shop/buy', { item: 'fish' });
  assert.equal((await as(admin)('DELETE', `/api/admin/users/${id2}`)).status, 200);
  assert.equal(one('SELECT COUNT(*) FROM pets WHERE user_id = ?', id2), 0);
  assert.equal(one('SELECT COUNT(*) FROM pet_items WHERE user_id = ?', id2), 0);
});
