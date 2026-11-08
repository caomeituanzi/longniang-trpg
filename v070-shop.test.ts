import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeProvider, demoHandler } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { PET_SHOP } from '../shared/pets';
import { CONSUMABLES, ITEM_STACK_MAX } from '../shared/rules2';
import { COMMON_GEAR_PRICE, GEAR_BASES } from '../shared/gear2';
import { SHOP_CATALOG } from '../shared/shop';
import { startTestApp } from './helpers';

// V0.7.0 网站改版：商城（所有用龙晶买的东西、换额度、龙晶记录；管理员改价）、我的背包（吃的用的、地下城道具、秘籍、宝箱、装备）、
// 装扮（头像框、骰子、称号、宠物装扮）、头像框（用户简介里带着）、排行（作品榜按分区、按好评或游玩次数；作者榜）、
// 顶栏的龙晶（变了推过去）；宠物留言、宠物排行没有了。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
const HOUR = 3_600_000;
/** 2026-10-10（万圣节活动之前）。 */
let now = Date.UTC(2026, 9, 10, 3, 0, 0);

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';
let t4 = '';

before(async () => {
  // 隐藏成就打开：测「人见人爱」（这个文件里不玩完剧本，别的隐藏成就碰不上）
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0, hiddenAchievements: true });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
  t4 = await t.login(TESTER4.username, TESTER4.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const one = (sql: string, ...params: (string | number)[]) => Object.values(t.app.db.prepare(sql).get(...params) as Record<string, unknown>)[0];
const shopOf = async (cookie: string) => (await as(cookie)('GET', '/api/shop')).data;
const bagOf = async (cookie: string) => (await as(cookie)('GET', '/api/bag')).data;
const itemOf = (shop: { items: { key: string }[] }, key: string) => shop.items.find((i) => i.key === key) as Record<string, any>;
const buy = (cookie: string, item: string, count?: number) => as(cookie)('POST', '/api/shop/buy', count === undefined ? { item } : { item, count });
const give = (username: string, amount: number) => as(admin)('POST', `/api/admin/users/${userId(username)}/crystals`, { amount, note: '测试' });
const lastAudit = () => ({ ...(t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string }) });

// ==================== 商城 ====================

test('商城：游客买不了（V0.7.1 起能看，见 v071-shop-admin）；分几栏、带现价；限时商品只在活动期间有；龙晶在商城和顶栏，不在宠物页', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  for (const [method, url] of [
    ['POST', '/api/shop/buy'],
    ['GET', '/api/bag'],
    // 「装扮」页游客能打开看看（V0.7.1，见 v071-guest-dungeon-hall.test.ts），戴不了
    ['PUT', '/api/me/frame'],
    ['GET', '/api/me/crystals'],
  ] as const) {
    assert.equal((await as(guest)(method, url, method === 'GET' ? undefined : { item: 'fish', frame: null })).status, 403, url);
  }
  const shop = await shopOf(t1);
  assert.equal(shop.crystals, 0);
  assert.deepEqual(shop.ledger, []);
  // 每一栏都有东西：吃的用的、地下城道具、装备、装扮、头像框、骰子、称号、换额度
  assert.deepEqual([...new Set(shop.items.map((i: { section: string }) => i.section))], ['supplies', 'dungeon', 'gear', 'outfit', 'frame', 'dice', 'title', 'exchange']);
  // 地下城道具、装备（只卖普通的）都在
  for (const c of CONSUMABLES) assert.equal(itemOf(shop, c.key).price, c.price, c.key);
  for (const b of GEAR_BASES) {
    const g = itemOf(shop, `gear-${b.key}`);
    assert.equal(g.price, COMMON_GEAR_PRICE);
    assert.equal(g.gear.rarity, 'common');
  }
  // 头像框（新加的）
  assert.ok(PET_SHOP.filter((i) => i.kind === 'frame').length >= 4);
  assert.equal(itemOf(shop, 'frame-jade').section, 'frame');
  // 换额度：100 龙晶换 1 元
  assert.deepEqual([itemOf(shop, 'exchange').price, itemOf(shop, 'exchange').max], [100, 5]);
  // 秘籍不在商城里卖
  assert.ok(!shop.items.some((i: { key: string }) => i.key.startsWith('manual:')));
  // 不在活动期间：限时商品不卖
  assert.ok(!shop.items.some((i: { limited: boolean }) => i.limited));
  assert.equal((await buy(t1, 'outfit-pumpkin')).status, 409);
  // 万圣节（10 月 28 日到 11 月 4 日）：有「限时」
  now = Date.UTC(2026, 9, 30, 3, 0, 0);
  assert.deepEqual(
    (await shopOf(t1)).items.filter((i: { limited: boolean }) => i.limited).map((i: { key: string }) => i.key),
    ['outfit-pumpkin', 'outfit-ghost', 'dice-pumpkin'],
  );
  now = Date.UTC(2026, 9, 10, 3, 0, 0);
  // 宠物页不再有龙晶、背包、商店、换额度、记录里的龙晶
  const pet = (await as(t1)('GET', '/api/pet')).data;
  assert.deepEqual(Object.keys(pet).sort(), ['games', 'growth', 'pet']);
  assert.deepEqual((await as(t1)('GET', '/api/me/crystals')).data, { crystals: 0 });
});

test('商城买东西：吃的进背包；地下城道具一种最多攒 99 个；装备只卖普通的、有了不能再买；头像框、骰子、称号买一个就够；龙晶不够买不了', async () => {
  await give(TESTER1.username, 2000);
  // 吃的
  let shop = (await buy(t1, 'skewer', 2)).data;
  assert.equal(shop.crystals, 2000 - 24);
  assert.equal(itemOf(shop, 'skewer').owned, 2);
  assert.deepEqual({ kind: shop.ledger[0].kind, delta: shop.ledger[0].delta, detail: shop.ledger[0].detail }, { kind: 'buy', delta: -24, detail: '烤肉串 × 2' });
  // 地下城道具：记在背包 pet_items，key 就是道具的编号
  shop = (await buy(t1, 'potion', 5)).data;
  assert.equal(one("SELECT count FROM pet_items WHERE user_id = ? AND item = 'potion'", userId(TESTER1.username)), 5);
  assert.equal(itemOf(shop, 'potion').owned, 5);
  t.app.db.prepare("UPDATE pet_items SET count = 97 WHERE user_id = ? AND item = 'potion'").run(userId(TESTER1.username));
  assert.equal((await buy(t1, 'potion', 3)).data.error, `治疗药水最多攒 ${ITEM_STACK_MAX} 个，现在有 97 个`);
  shop = (await buy(t1, 'potion', 2)).data;
  assert.deepEqual([itemOf(shop, 'potion').owned, itemOf(shop, 'potion').max, itemOf(shop, 'potion').note], [99, 0, '最多攒 99 个']);
  // 装备：往 gear_items 插一行普通的；有了不能再买；捡到的精良的不挡着买普通的
  t.app.db
    .prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, 'sword', 'fine', 'chest', ?)")
    .run(userId(TESTER1.username), now);
  const crystals = (await shopOf(t1)).crystals;
  assert.equal((await buy(t1, 'gear-sword', 2)).status, 400);
  shop = (await buy(t1, 'gear-sword')).data;
  assert.equal(shop.crystals, crystals - COMMON_GEAR_PRICE);
  assert.deepEqual(
    t.app.db.prepare("SELECT rarity, source FROM gear_items WHERE user_id = ? AND base = 'sword' ORDER BY rarity").all(userId(TESTER1.username)).map((r) => ({ ...r })),
    [
      { rarity: 'common', source: 'shop' },
      { rarity: 'fine', source: 'chest' },
    ],
  );
  assert.deepEqual([itemOf(shop, 'gear-sword').owned, itemOf(shop, 'gear-sword').max, itemOf(shop, 'gear-sword').note], [1, 0, '已经有了']);
  assert.equal((await buy(t1, 'gear-sword')).data.error, '铁剑你已经有了');
  assert.equal((await buy(t1, 'gear-nothing')).status, 404);
  // 头像框、骰子、称号
  assert.equal((await buy(t1, 'frame-jade', 2)).data.error, '青玉买一个就够了');
  shop = (await buy(t1, 'frame-jade')).data;
  assert.equal(shop.ledger[0].detail, '头像框「青玉」');
  assert.equal((await buy(t1, 'frame-jade')).data.error, '青玉你已经有了');
  await buy(t1, 'dice-jade');
  await buy(t1, 'title-known');
  assert.equal((await buy(t1, 'title-known')).data.error, '这个称号你已经有了');
  // 龙晶不够
  await give(TESTER2.username, 10);
  const r = await buy(t2, 'frame-gold');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /^龙晶不够：要 400，只有 10$/);
});

test('龙晶变了推给自己开着的页面（顶栏右上角）；/api/me/crystals', async () => {
  const stream = await t.openStream('/api/events', t2);
  const before = (await as(t2)('GET', '/api/me/crystals')).data.crystals as number;
  await buy(t2, 'fish');
  const pushed = await stream.waitFor((e) => e.event === 'crystals' && e.data.crystals === before - 5);
  assert.equal(pushed.data.crystals, before - 5);
  // 别人发龙晶也推
  await give(TESTER2.username, 7);
  await stream.waitFor((e) => e.event === 'crystals' && e.data.crystals === before + 2);
  stream.close();
});

// ==================== 管理员改价 ====================

test('管理员改商城的价格：要「发放额度」权限；改了以后商城按现价卖；能恢复默认；换额度的价格就是多少龙晶换 1 元；记进操作记录', async () => {
  assert.equal((await as(t1)('GET', '/api/admin/shop-prices')).status, 403);
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["announce"]' WHERE username = ?`).run(TESTER5.username);
  const t5 = await t.login(TESTER5.username, TESTER5.password);
  assert.equal((await as(t5)('GET', '/api/admin/shop-prices')).status, 403);
  assert.equal((await as(t5)('PUT', '/api/admin/shop-prices', { key: 'fish', price: 1 })).status, 403);
  t.app.db.prepare(`UPDATE users SET is_admin = 0, admin_perms = '[]' WHERE username = ?`).run(TESTER5.username);

  let list = (await as(admin)('GET', '/api/admin/shop-prices')).data.items as { key: string; basePrice: number; price: number; section: string; limited: boolean }[];
  assert.equal(list.length, SHOP_CATALOG.length);
  assert.deepEqual(list.find((i) => i.key === 'fish'), { key: 'fish', name: '小鱼干', section: 'supplies', basePrice: 5, price: 5, limited: false });
  assert.ok(list.some((i) => i.key === 'outfit-pumpkin' && i.limited), '限时商品也能改价');
  // 价格不对、商品不存在
  for (const price of [0, -1, 1.5, 100_001, '8']) assert.equal((await as(admin)('PUT', '/api/admin/shop-prices', { key: 'fish', price })).status, 400, String(price));
  assert.equal((await as(admin)('PUT', '/api/admin/shop-prices', { key: 'nothing', price: 5 })).status, 404);
  // 改价
  list = (await as(admin)('PUT', '/api/admin/shop-prices', { key: 'fish', price: 8 })).data.items;
  assert.equal(list.find((i) => i.key === 'fish')!.price, 8);
  assert.deepEqual(lastAudit(), { action: '改商城价格', detail: '吃的用的「小鱼干」：5 → 8 龙晶' });
  await as(admin)('PUT', '/api/admin/shop-prices', { key: 'gear-axe', price: 99 });
  assert.deepEqual(JSON.parse(one("SELECT value FROM settings WHERE key = 'shop_prices'") as string), { fish: 8, 'gear-axe': 99 });
  await give(TESTER3.username, 500);
  let shop = await shopOf(t3);
  assert.equal(itemOf(shop, 'fish').price, 8);
  assert.equal(itemOf(shop, 'gear-axe').price, 99);
  assert.equal(itemOf(shop, 'gear-bow').price, COMMON_GEAR_PRICE);
  shop = (await buy(t3, 'fish', 2)).data;
  assert.equal(shop.crystals, 500 - 16);
  shop = (await buy(t3, 'gear-axe')).data;
  assert.equal(shop.crystals, 500 - 16 - 99);
  // 改回默认价那么多：不再记着
  await as(admin)('PUT', '/api/admin/shop-prices', { key: 'gear-axe', price: 60 });
  assert.deepEqual(JSON.parse(one("SELECT value FROM settings WHERE key = 'shop_prices'") as string), { fish: 8 });
  // 恢复默认
  list = (await as(admin)('PUT', '/api/admin/shop-prices', { key: 'fish', price: null })).data.items;
  assert.equal(list.find((i) => i.key === 'fish')!.price, 5);
  assert.deepEqual(lastAudit(), { action: '改商城价格', detail: '吃的用的「小鱼干」：8 → 5 龙晶（恢复默认）' });
  assert.equal(itemOf(await shopOf(t3), 'fish').price, 5);
  // 换额度：改的是「多少龙晶换 1 元」，和管理页「龙晶」里的设置是同一个数
  await as(admin)('PUT', '/api/admin/shop-prices', { key: 'exchange', price: 80 });
  assert.equal((await as(admin)('GET', '/api/admin/pets')).data.exchange.rate, 80);
  assert.equal(itemOf(await shopOf(t3), 'exchange').price, 80);
  shop = (await buy(t3, 'exchange', 1)).data;
  assert.deepEqual({ kind: shop.ledger[0].kind, delta: shop.ledger[0].delta }, { kind: 'exchange', delta: -80 });
  await as(admin)('PUT', '/api/admin/shop-prices', { key: 'exchange', price: null });
  assert.equal((await as(admin)('GET', '/api/admin/pets')).data.exchange.rate, 100);
});

// ==================== 我的背包 ====================

test('我的背包：吃的用的（能喂宠物、改名卡给宠物改名字）、地下城道具、秘籍、宝箱、装备', async () => {
  // tester1：没养宠物时也看得到背包
  let bag = await bagOf(t1);
  assert.equal(bag.pet, null);
  assert.deepEqual(
    bag.supplies.map((s: { key: string; count: number }) => [s.key, s.count]),
    [['skewer', 2]],
  );
  assert.deepEqual(
    bag.consumables.map((c: { key: string; count: number }) => [c.key, c.count]),
    [['potion', 99]],
  );
  // 称号、头像框、骰子不在背包里（在「装扮」里）
  assert.ok(!bag.supplies.some((s: { key: string }) => /^(title|frame|dice)-/.test(s.key)));
  assert.deepEqual(
    bag.gear.map((g: { base: string; rarity: string; name: string; bonus: number }) => [g.base, g.rarity, g.name, g.bonus]),
    [
      ['sword', 'fine', '精钢剑', 2],
      ['sword', 'common', '铁剑', 1],
    ],
  );
  assert.equal(bag.chests, 0);
  assert.deepEqual(bag.manuals, []);
  // 秘籍（地下城里得到的，key 是 manual:技能编号）、宝箱
  const id1 = userId(TESTER1.username);
  const put = t.app.db.prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, ?)');
  put.run(id1, 'manual:pojun', 2);
  put.run(id1, 'manual:no-such-skill', 1);
  put.run(id1, 'chest', 3);
  bag = await bagOf(t1);
  assert.equal(bag.chests, 3);
  assert.equal(bag.manuals.length, 1, '认不出来的秘籍不列');
  assert.deepEqual({ key: bag.manuals[0].key, name: bag.manuals[0].name, count: bag.manuals[0].count }, { key: 'manual:pojun', name: '秘籍《破军一击》', count: 2 });
  assert.ok(bag.manuals[0].text.length > 0);
  // 养了宠物：喂它（吃的从背包出）；改名卡就是给宠物改名字
  await as(t1)('POST', '/api/pet', { name: '团子' });
  t.app.db.prepare('UPDATE pets SET satiety = 30, state_at = ? WHERE user_id = ?').run(now, id1);
  bag = await bagOf(t1);
  assert.deepEqual(bag.pet, { name: '团子', satiety: 30, energy: 100 });
  assert.equal((await as(t1)('POST', '/api/pet/use', { item: 'skewer' })).data.pet.satiety, 80);
  bag = await bagOf(t1);
  assert.equal(bag.supplies.find((s: { key: string }) => s.key === 'skewer').count, 1);
  assert.equal(bag.pet.satiety, 80);
  await buy(t1, 'rename');
  assert.equal((await bagOf(t1)).supplies.find((s: { key: string }) => s.key === 'rename').count, 1);
  assert.equal((await as(t1)('PUT', '/api/pet', { name: '大团子' })).data.pet.name, '大团子');
  assert.ok(!(await bagOf(t1)).supplies.some((s: { key: string }) => s.key === 'rename'), '改名卡用掉了');
  assert.equal((await as(t1)('PUT', '/api/pet', { name: '小团子' })).data.error, '背包里没有改名卡了');
});

// ==================== 装扮、头像框 ====================

test('装扮：头像框（买了才能戴，戴上以后用户简介里带着）、骰子、称号、宠物装扮都在这里', async () => {
  let w = (await as(t1)('GET', '/api/wardrobe')).data;
  assert.deepEqual({ frames: w.frames, frame: w.frame, dice: w.dice, diceSkin: w.diceSkin, outfits: w.outfits, outfit: w.outfit }, {
    frames: ['frame-jade'],
    frame: null,
    dice: ['dice-jade'],
    diceSkin: null,
    outfits: [],
    outfit: null,
  });
  assert.ok(w.titles.some((x: { key: string; source: string }) => x.key === 'title-known' && x.source === 'shop'));
  assert.deepEqual(w.pet, { name: '大团子', image: null });
  // 头像框
  assert.equal((await as(t1)('PUT', '/api/me/frame', { frame: 'frame-gold' })).data.error, '先在商城里买描金');
  assert.equal((await as(t1)('PUT', '/api/me/frame', { frame: 'dice-jade' })).status, 404);
  assert.equal((await as(t1)('PUT', '/api/me/frame', { frame: 3 })).status, 400);
  w = (await as(t1)('PUT', '/api/me/frame', { frame: 'frame-jade' })).data;
  assert.equal(w.frame, 'frame-jade');
  // 自己（顶栏）、个人主页、大厅聊天、好友列表里的头像都带着头像框
  assert.equal((await as(t1)('GET', '/api/auth/me')).data.user.frame, 'frame-jade');
  assert.equal((await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data.user.frame, 'frame-jade');
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '戴上头像框了' })).status, 201);
  const said = (await as(t2)('GET', '/api/lobby/chat')).data.messages.find((m: { text: string }) => m.text === '戴上头像框了');
  assert.equal(said.user.frame, 'frame-jade');
  assert.equal((await as(t1)('POST', '/api/friends', { username: TESTER4.username })).status, 201);
  assert.equal((await as(t4)('POST', `/api/friends/${publicId(TESTER1.username)}/accept`)).status, 200);
  const friends = (await as(t4)('GET', '/api/friends')).data.friends as { publicId: string; frame: string | null }[];
  assert.equal(friends.find((f) => f.publicId === publicId(TESTER1.username))!.frame, 'frame-jade');
  assert.equal((await as(t4)('GET', `/api/users/${publicId(TESTER4.username)}`)).data.user.frame, null);
  // 骰子、称号、宠物装扮（接口照旧，骰子、装扮返回「装扮」页）
  w = (await as(t1)('PUT', '/api/pet/dice', { dice: 'dice-jade' })).data;
  assert.equal(w.diceSkin, 'dice-jade');
  assert.equal((await as(t1)('PUT', '/api/me/title', { title: 'title-known' })).status, 200);
  assert.equal((await as(t1)('GET', '/api/wardrobe')).data.title, 'title-known');
  await buy(t1, 'outfit-bow');
  w = (await as(t1)('PUT', '/api/pet/outfit', { outfit: 'outfit-bow' })).data;
  assert.deepEqual([w.outfits, w.outfit], [['outfit-bow'], 'outfit-bow']);
  // 称号只在账号上：宠物页、主页的宠物上没有
  const profile = (await as(t2)('GET', `/api/users/${publicId(TESTER1.username)}`)).data;
  assert.equal(profile.title, '小有名气');
  assert.equal('title' in profile.pet, false);
  assert.equal('title' in (await as(t1)('GET', '/api/pet')).data.pet, false);
  // 摘下头像框
  assert.equal((await as(t1)('PUT', '/api/me/frame', { frame: null })).data.frame, null);
  assert.equal((await as(t1)('GET', '/api/auth/me')).data.user.frame, null);
});

// ==================== 宠物：留言、排行没有了；「人见人爱」改成被串门 ====================

test('宠物留言、宠物排行的接口没有了；隐藏成就「人见人爱」改成宠物被好友串门 20 次', async () => {
  const ref = publicId(TESTER1.username);
  assert.equal((await as(t4)('POST', `/api/pets/${ref}/notes`, { text: '你好' })).status, 404);
  assert.equal((await as(t1)('DELETE', '/api/pet-notes/1')).status, 404);
  assert.equal((await as(t1)('GET', '/api/pet/rankings')).status, 404);
  assert.equal((await as(t1)('GET', '/api/scenario-hall/rankings')).status, 404);
  assert.equal((await as(t1)('POST', '/api/pet/buy', { item: 'fish' })).status, 404);
  assert.equal((await as(t1)('PUT', '/api/pet/title', { title: null })).status, 404);
  // 举报宠物留言也不收了
  assert.equal((await as(t4)('POST', '/api/reports', { kind: 'report', body: '乱写', target: { type: 'pet_note', id: 1 } })).status, 400);
  // 以前被串门过 19 次（前几天），今天 tester4 再来一次
  const owner = userId(TESTER1.username);
  const visit = t.app.db.prepare("INSERT INTO pet_visits (visitor_id, owner_id, kind, rewarded, created_at) VALUES (?, ?, 'pat', 1, ?)");
  for (let i = 0; i < 19; i++) visit.run(userId(TESTER4.username), owner, now - 3 * 24 * HOUR - i);
  assert.ok(!t.app.db.prepare("SELECT 1 FROM achievements WHERE user_id = ? AND key = 'popular-pet'").get(owner));
  const r = await as(t4)('POST', `/api/pets/${ref}/visit`, { kind: 'pat' });
  assert.equal(r.data.rewarded, 3);
  assert.ok(t.app.db.prepare("SELECT 1 FROM achievements WHERE user_id = ? AND key = 'popular-pet'").get(owner));
});

// ==================== 排行 ====================

test('排行：作品榜按分区、按好评（至少 3 人评过）或游玩次数（玩完几局）排；作者榜；游客也能看', async () => {
  const hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios as { key: string; category: string | null }[];
  const categoryOf = (key: string) => hall.find((s) => s.key === key)!.category;
  assert.equal(categoryOf('qingxi-lantern-night'), 'puzzle');
  assert.equal(categoryOf('yakou-fifth-man'), 'horror');
  assert.equal(categoryOf('paper-effigy-shop'), 'horror');
  // 玩完的局：解谜 3 局、恐怖两个剧本各 2 局和 1 局
  const finish = t.app.db.prepare('INSERT INTO scenario_finishes (room_id, room_created_at, scenario_key, ending_key, ending_title, players, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
  let room = 9000;
  for (const [key, n] of [
    ['qingxi-lantern-night', 3],
    ['yakou-fifth-man', 2],
    ['paper-effigy-shop', 1],
  ] as const) {
    for (let i = 0; i < n; i++) finish.run(room++, now, key, 'e', '结局', now);
  }
  // 评分：青溪灯夜 3 个人评（上榜），垭口只有 2 个人评（不上榜）
  const rate = t.app.db.prepare('INSERT INTO scenario_ratings (user_id, scenario_key, stars, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [username, stars] of [
    [TESTER1.username, 5],
    [TESTER2.username, 4],
    [TESTER3.username, 4],
  ] as const) {
    rate.run(userId(username), 'qingxi-lantern-night', stars, '', now, now);
  }
  rate.run(userId(TESTER1.username), 'yakou-fifth-man', 5, '', now, now);
  rate.run(userId(TESTER2.username), 'yakou-fifth-man', 5, '', now, now);

  const works = async (query: string) => (await as(t1)('GET', `/api/rankings/works${query}`)).data;
  // 全部、游玩次数
  let r = await works('?by=plays');
  assert.deepEqual([r.category, r.by], [null, 'plays']);
  assert.deepEqual(
    r.rows.map((x: { key: string; value: number; rank: number; category: string }) => [x.key, x.value, x.rank, x.category]),
    [
      ['qingxi-lantern-night', 3, 1, 'puzzle'],
      ['yakou-fifth-man', 2, 2, 'horror'],
      ['paper-effigy-shop', 1, 3, 'horror'],
    ],
  );
  // 恐怖分区、游玩次数
  r = await works('?category=horror&by=plays');
  assert.deepEqual(
    r.rows.map((x: { key: string; value: number; rank: number }) => [x.key, x.value, x.rank]),
    [
      ['yakou-fifth-man', 2, 1],
      ['paper-effigy-shop', 1, 2],
    ],
  );
  // 好评：至少 3 个人评过；不写 by 就是好评；all 是全部
  r = await works('');
  assert.equal(r.by, 'rating');
  assert.deepEqual(
    r.rows.map((x: { key: string; value: number; count: number }) => [x.key, x.value, x.count]),
    [['qingxi-lantern-night', 4.3, 3]],
  );
  assert.deepEqual((await works('?category=all&by=rating')).rows.length, 1);
  assert.deepEqual((await works('?category=horror&by=rating')).rows, []);
  // 地下城分区（V0.7.0）也能选
  assert.equal((await works('?category=dungeon')).category, 'dungeon');
  assert.equal((await as(t1)('GET', '/api/rankings/works?category=nope')).status, 400);
  assert.equal((await as(t1)('GET', '/api/rankings/works?by=nope')).status, 400);
  // 作者榜：用户投稿的作品才算（这里还没有）
  assert.deepEqual((await as(t1)('GET', '/api/rankings/authors')).data, { rows: [] });
  // 游客也能看
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await as(guest)('GET', '/api/rankings/works?by=plays')).data.rows.length, 3);
  assert.equal((await as(guest)('GET', '/api/rankings/authors')).status, 200);
});
