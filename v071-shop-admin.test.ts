// 时间按东京算
process.env.TZ = 'Asia/Tokyo';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeProvider, demoHandler } from '../server/ai/fake';
import { legendaryOf } from '../server/legendary';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { manualView } from '../server/skills';
import { gearLabel, gearView } from '../shared/gear2';
import { ITEM_STACK_MAX } from '../shared/rules2';
import { gearEffect, SHOP_CATALOG } from '../shared/shop';
import { startTestApp } from './helpers';

// V0.7.1 商城管理：自带的商品下架、重新上架（设置 shop_hidden）；管理员上架新商品（shop_listings：装备、秘籍、宝箱、
// 几个一份的道具、自己起名字的称号），改价、改称号名字、下架、重新上架；管理页「物品」给账号发东西（单个、一批、所有正式账号）；
// 游客能看商城（买不了）。

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4, TESTER5] = TEST_ACCOUNTS;
/** 2026-10-10（万圣节活动之前）。 */
const now = Date.UTC(2026, 9, 10, 3, 0, 0);

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';
let t5 = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
  t5 = await t.login(TESTER5.username, TESTER5.password);
});

after(async () => {
  await t.close();
});

type Entry = { key: string; name: string; section: string; price: number; effect: string; once: boolean; owned: number; max: number; note: string | null; gear: any };
type Listing = { id: number; key: string; kind: string; name: string; count: number; section: string; price: number; listed: boolean; known: boolean };

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const uidOf = (id: number) => (t.app.db.prepare('SELECT uid FROM users WHERE id = ?').get(id) as { uid: number }).uid;
const one = (sql: string, ...params: (string | number)[]) => Object.values((t.app.db.prepare(sql).get(...params) as Record<string, unknown>) ?? { v: undefined })[0];
const have = (username: string, item: string) => (one('SELECT count FROM pet_items WHERE user_id = ? AND item = ?', userId(username), item) as number | undefined) ?? 0;
const shopOf = async (cookie: string) => (await as(cookie)('GET', '/api/shop')).data;
const itemOf = (shop: { items: Entry[] }, key: string) => shop.items.find((i) => i.key === key)!;
const buy = (cookie: string, item: string, count?: number) => as(cookie)('POST', '/api/shop/buy', count === undefined ? { item } : { item, count });
const give = (username: string, amount: number) => as(admin)('POST', `/api/admin/users/${userId(username)}/crystals`, { amount, note: '测试' });
const lastAudit = () => ({ ...(t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string }) });
const list = (body: Record<string, unknown>) => as(admin)('POST', '/api/admin/shop/listings', body);
const grant = (cookie: string, body: Record<string, unknown>) => as(cookie)('POST', '/api/admin/items/grant', body);
const setPerms = (username: string, perms: string[] | null) =>
  t.app.db.prepare('UPDATE users SET is_admin = ?, admin_perms = ? WHERE username = ?').run(perms ? 1 : 0, JSON.stringify(perms ?? []), username);

/** 上架的商品（按名字找）。 */
let listings: Record<string, Listing> = {};

// ==================== 自带的商品：下架、重新上架 ====================

test('自带的商品下架、重新上架：商城里不显示、买不了，买过的人照样有；要「发放额度」权限；记进操作记录', async () => {
  await give(TESTER1.username, 1000);
  assert.equal((await buy(t1, 'fish', 2)).status, 200);

  // 权限：没有「发放额度」的管理员不行，普通用户更不行
  setPerms(TESTER5.username, ['announce']);
  for (const [method, url, body] of [
    ['GET', '/api/admin/shop', undefined],
    ['PUT', '/api/admin/shop/hidden', { key: 'fish', hidden: true }],
    ['POST', '/api/admin/shop/listings', { kind: 'chest', price: 10 }],
    ['PUT', '/api/admin/shop/listings/1', { price: 10 }],
    ['GET', '/api/admin/items', undefined],
    ['POST', '/api/admin/items/grant', { item: 'fish', accounts: [TESTER1.username] }],
  ] as const) {
    assert.equal((await as(t5)(method, url, body)).status, 403, url);
    assert.equal((await as(t1)(method, url, body)).status, 403, url);
  }
  setPerms(TESTER5.username, null);

  const page = (await as(admin)('GET', '/api/admin/shop')).data;
  assert.equal(page.items.length, SHOP_CATALOG.length);
  assert.deepEqual(page.items.find((i: { key: string }) => i.key === 'fish'), { key: 'fish', name: '小鱼干', section: 'supplies', basePrice: 5, price: 5, limited: false, hidden: false });
  assert.deepEqual(page.listings, []);
  // 上架时能选的东西：秘籍（服务器给）、装备种类和稀有度（传奇的不在里面，站长也一样）
  assert.ok(page.options.manuals.some((m: { key: string }) => m.key === 'manual:pojun'));
  assert.deepEqual(
    page.options.rarities.map((r: { key: string }) => r.key),
    ['common', 'fine', 'rare', 'epic'],
  );
  assert.deepEqual(page.options.legendary, []);

  // 下架
  assert.equal((await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'nothing', hidden: true })).status, 404);
  assert.equal((await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'fish' })).status, 400);
  const hidden = (await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'fish', hidden: true })).data;
  assert.equal(hidden.items.find((i: { key: string }) => i.key === 'fish').hidden, true);
  assert.deepEqual(lastAudit(), { action: '下架商品', detail: '吃的用的「小鱼干」' });
  assert.deepEqual(JSON.parse(one("SELECT value FROM settings WHERE key = 'shop_hidden'") as string), ['fish']);
  await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'gear-sword', hidden: true });
  let shop = await shopOf(t1);
  assert.ok(!shop.items.some((i: Entry) => i.key === 'fish' || i.key === 'gear-sword'));
  const r = await buy(t1, 'fish');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '小鱼干已经下架了');
  assert.equal((await buy(t1, 'gear-sword')).status, 409);
  // 买过的人照样有
  assert.equal((await as(t1)('GET', '/api/bag')).data.supplies.find((s: { key: string }) => s.key === 'fish').count, 2);
  // 改价照样能改（下架了的也列着）
  assert.equal((await as(admin)('GET', '/api/admin/shop-prices')).data.items.length, SHOP_CATALOG.length);

  // 重新上架
  await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'fish', hidden: false });
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '吃的用的「小鱼干」' });
  await as(admin)('PUT', '/api/admin/shop/hidden', { key: 'gear-sword', hidden: false });
  shop = (await buy(t1, 'fish')).data;
  assert.equal(itemOf(shop, 'fish').owned, 3);
  assert.ok(itemOf(shop, 'gear-sword'));
  assert.deepEqual(JSON.parse(one("SELECT value FROM settings WHERE key = 'shop_hidden'") as string), []);
});

// ==================== 管理员上架新商品 ====================

test('上架新商品：装备（传奇的不行）、秘籍、宝箱、几个一份的道具、自己起名字的称号；不对的不收；在卖的不能重复；记进操作记录', async () => {
  for (const [body, error] of [
    [{ kind: 'nope', price: 10 }, '选一下上架什么'],
    [{ kind: 'gear', ref: 'leg-dragon-spear:legendary', price: 100 }, '传奇装备不能上架'],
    [{ kind: 'gear', ref: 'sword:legendary', price: 100 }, '传奇装备不能上架'],
    [{ kind: 'gear', ref: 'nothing:fine', price: 100 }, '选一下哪件装备'],
    [{ kind: 'gear', ref: 'sword', price: 100 }, '选一下哪件装备'],
    [{ kind: 'gear', ref: 'sword:fine', count: 2, price: 100 }, '装备一份只能有一个'],
    [{ kind: 'manual', ref: 'no-such-skill', price: 100 }, '选一下哪本秘籍'],
    [{ kind: 'item', ref: 'frame-jade', price: 100 }, '选一下哪样道具'],
    [{ kind: 'item', ref: 'chest', price: 100 }, '选一下哪样道具'],
    [{ kind: 'item', ref: 'potion', count: 100, price: 10 }, '一份要填 1～99 个'],
    [{ kind: 'title', name: '', price: 100 }, '称号要填 1～10 个字'],
    [{ kind: 'title', name: '一二三四五六七八九十十', price: 100 }, '称号要填 1～10 个字'],
    [{ kind: 'title', name: '龙王', count: 2, price: 100 }, '称号一份只能有一个'],
    [{ kind: 'chest', price: 0 }, '价格要填 1～100000 的整数'],
    [{ kind: 'chest', price: 1.5 }, '价格要填 1～100000 的整数'],
    [{ kind: 'chest' }, '价格要填 1～100000 的整数'],
    // 底价（V0.7.1 审查）：宝箱一个至少是开一个最多能开出的龙晶，装备、秘籍、称号有底价
    [{ kind: 'chest', price: 249 }, '宝箱一个至少 250 龙晶'],
    [{ kind: 'chest', count: 3, price: 700 }, '宝箱一个至少 250 龙晶，3 个一份至少 750'],
    [{ kind: 'gear', ref: 'sword:epic', price: 1 }, '这件商品至少 600 龙晶'],
    [{ kind: 'gear', ref: 'sword:fine', price: 149 }, '这件商品至少 150 龙晶'],
    [{ kind: 'manual', ref: 'pojun', price: 199 }, '这件商品至少 200 龙晶'],
    [{ kind: 'title', name: '小龙', price: 49 }, '这件商品至少 50 龙晶'],
  ] as const) {
    const r = await list(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, error, JSON.stringify(body));
  }

  const fine = gearView(0, 'sword', 'fine')!;
  let r = await list({ kind: 'gear', ref: 'sword:fine', price: 150 });
  assert.equal(r.status, 201);
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: `装备「${gearLabel(fine)}」，150 龙晶` });
  await list({ kind: 'manual', ref: 'pojun', price: 300 });
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '秘籍「秘籍《破军一击》」，300 龙晶' });
  await list({ kind: 'chest', count: 3, price: 750 });
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '宝箱「宝箱 × 3」，750 龙晶' });
  await list({ kind: 'item', ref: 'potion', count: 5, price: 100 });
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '地下城道具「治疗药水 × 5」，100 龙晶' });
  await list({ kind: 'item', ref: 'dragonfruit', count: 2, price: 30 });
  r = await list({ kind: 'title', name: ' 龙王 ', price: 500 });
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '称号「龙王」，500 龙晶' });
  // 在卖的里面已经有一样的：不能再上架（几个一份不一样的可以）
  assert.equal((await list({ kind: 'gear', ref: 'sword:fine', price: 160 })).status, 409);
  assert.equal((await list({ kind: 'title', name: '龙王', price: 99 })).data.error, '已经有一样的商品在卖了');
  assert.equal((await list({ kind: 'chest', count: 3, price: 800 })).status, 409);

  const page = r.data;
  listings = Object.fromEntries(page.listings.map((l: Listing) => [l.name, l]));
  assert.deepEqual(
    page.listings.map((l: Listing) => [l.kind, l.name, l.count, l.section, l.price, l.listed, l.known]),
    [
      ['title', '龙王', 1, 'title', 500, true, true],
      ['item', '龙果 × 2', 2, 'supplies', 30, true, true],
      ['item', '治疗药水 × 5', 5, 'dungeon', 100, true, true],
      ['chest', '宝箱 × 3', 3, 'chest', 750, true, true],
      ['manual', '秘籍《破军一击》', 1, 'manual', 300, true, true],
      ['gear', gearLabel(fine), 1, 'gear', 150, true, true],
    ],
  );

  // 商城里：在各自那一栏，排在自带的后面；多了「秘籍」「宝箱」两栏
  const shop = await shopOf(t2);
  assert.deepEqual([...new Set(shop.items.map((i: Entry) => i.section))], ['supplies', 'dungeon', 'gear', 'manual', 'chest', 'outfit', 'frame', 'dice', 'title', 'exchange']);
  const gear = itemOf(shop, listings[gearLabel(fine)].key);
  assert.deepEqual([gear.name, gear.section, gear.price, gear.once, gear.max, gear.gear.rarity, gear.effect], [fine.name, 'gear', 150, true, 1, 'fine', gearEffect(fine)]);
  const manual = itemOf(shop, listings['秘籍《破军一击》'].key);
  assert.deepEqual([manual.section, manual.effect, manual.once, manual.max], ['manual', manualView('manual:pojun')!.text, false, 20]);
  assert.deepEqual([itemOf(shop, listings['宝箱 × 3'].key).name, itemOf(shop, listings['宝箱 × 3'].key).max], ['宝箱 × 3', 20]);
  // 一种最多攒 99 个：一份 5 个最多买 19 份
  assert.equal(itemOf(shop, listings['治疗药水 × 5'].key).max, 19);
  const title = itemOf(shop, listings['龙王'].key);
  assert.deepEqual([title.name, title.section, title.once, title.max], ['龙王', 'title', true, 1]);
  const dungeon = shop.items.filter((i: Entry) => i.section === 'dungeon');
  assert.equal(dungeon.at(-1).key, listings['治疗药水 × 5'].key);
});

test('买管理员上架的商品：装备、秘籍、宝箱、几个一份的道具、称号都进对的地方；规矩和自带的一样；龙晶记账', async () => {
  await give(TESTER2.username, 3000);
  const fine = gearView(0, 'sword', 'fine')!;
  const gearKey = listings[gearLabel(fine)].key;
  // 装备：一件就够，同一种、同一个稀有度有了不能再买
  assert.equal((await buy(t2, gearKey, 2)).data.error, `${fine.name}买一件就够了`);
  let shop = (await buy(t2, gearKey)).data;
  assert.deepEqual({ ...(t.app.db.prepare("SELECT rarity, source FROM gear_items WHERE user_id = ? AND base = 'sword'").get(userId(TESTER2.username)) as object) }, {
    rarity: 'fine',
    source: 'shop',
  });
  assert.deepEqual([shop.ledger[0].delta, shop.ledger[0].detail], [-150, `装备「${gearLabel(fine)}」`]);
  assert.deepEqual([itemOf(shop, gearKey).owned, itemOf(shop, gearKey).max, itemOf(shop, gearKey).note], [1, 0, '已经有了']);
  assert.equal((await buy(t2, gearKey)).data.error, `${fine.name}你已经有了`);
  // 普通的那件还能在自带的里面买
  assert.equal(itemOf(shop, 'gear-sword').max, 1);

  // 秘籍
  shop = (await buy(t2, listings['秘籍《破军一击》'].key, 2)).data;
  assert.equal(have(TESTER2.username, 'manual:pojun'), 2);
  assert.deepEqual([shop.ledger[0].delta, shop.ledger[0].detail], [-600, '秘籍《破军一击》 × 2']);
  // 宝箱：一份 3 个，买 2 份是 6 个
  shop = (await buy(t2, listings['宝箱 × 3'].key, 2)).data;
  assert.equal(have(TESTER2.username, 'chest'), 6);
  assert.deepEqual([shop.ledger[0].delta, shop.ledger[0].detail], [-1500, '宝箱 × 6']);
  assert.equal(itemOf(shop, listings['宝箱 × 3'].key).owned, 6);
  // 道具：一种最多攒 99 个，按一份几个算
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'potion', 90)").run(userId(TESTER2.username));
  shop = (await buy(t2, listings['治疗药水 × 5'].key)).data;
  assert.equal(have(TESTER2.username, 'potion'), 95);
  assert.deepEqual([itemOf(shop, listings['治疗药水 × 5'].key).max, itemOf(shop, listings['治疗药水 × 5'].key).note], [0, `最多攒 ${ITEM_STACK_MAX} 个`]);
  assert.equal((await buy(t2, listings['治疗药水 × 5'].key)).data.error, `治疗药水最多攒 ${ITEM_STACK_MAX} 个，现在有 95 个`);
  // 吃的不限
  await buy(t2, listings['龙果 × 2'].key, 3);
  assert.equal(have(TESTER2.username, 'dragonfruit'), 6);
  // 称号：背包里是 custom-title-编号；有了不能再买
  const titleKey = `custom-title-${listings['龙王'].id}`;
  shop = (await buy(t2, listings['龙王'].key)).data;
  assert.equal(have(TESTER2.username, titleKey), 1);
  assert.deepEqual([shop.ledger[0].delta, shop.ledger[0].detail], [-500, '称号「龙王」']);
  assert.equal((await buy(t2, listings['龙王'].key)).data.error, '这个称号你已经有了');
  assert.equal(shop.crystals, 3000 - 150 - 600 - 1500 - 100 - 90 - 500);
  // 管理员买上架的商品记进操作记录（上架的价格是管理员定的）
  assert.ok(!t.app.db.prepare("SELECT 1 FROM admin_audit WHERE action = '管理员买上架的商品'").get(), '普通玩家买不记');

  // 背包里看得到
  const bag = (await as(t2)('GET', '/api/bag')).data;
  assert.equal(bag.chests, 6);
  assert.deepEqual(
    bag.manuals.map((m: { key: string; count: number }) => [m.key, m.count]),
    [['manual:pojun', 2]],
  );
  assert.ok(bag.gear.some((g: { base: string; rarity: string }) => g.base === 'sword' && g.rarity === 'fine'));

  // 龙晶不够；没有这件；游客买不了
  const r = await buy(t3, listings['龙王'].key);
  assert.deepEqual([r.status, r.data.error], [409, '龙晶不够：要 500，只有 0']);
  assert.equal((await buy(t2, 'listing-999')).status, 404);
  assert.equal((await buy(t2, 'listing-abc')).status, 404);
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  assert.equal((await buy(guest, listings['龙王'].key)).status, 403);
});

test('自己起名字的称号：装扮里能戴，个人主页、大厅聊天里显示；下架以后买过的人照样有；改名字跟着变；改价、重新上架', async () => {
  const id = listings['龙王'].id;
  const titleKey = `custom-title-${id}`;
  const w = (await as(t2)('GET', '/api/wardrobe')).data;
  assert.deepEqual(
    w.titles.find((x: { key: string }) => x.key === titleKey),
    { key: titleKey, name: '龙王', source: 'shop' },
  );
  assert.equal((await as(t2)('PUT', '/api/me/title', { title: titleKey })).status, 200);
  assert.equal((await as(t2)('GET', '/api/wardrobe')).data.title, titleKey);
  assert.equal((await as(t1)('GET', `/api/users/${publicId(TESTER2.username)}`)).data.title, '龙王');
  assert.equal((await as(t2)('POST', '/api/lobby/chat', { text: '戴上新称号了' })).status, 201);
  const said = (await as(t1)('GET', '/api/lobby/chat')).data.messages.find((m: { text: string }) => m.text === '戴上新称号了');
  assert.equal(said.title, '龙王');
  // 没买的戴不了；没有的称号
  assert.deepEqual([(await as(t3)('PUT', '/api/me/title', { title: titleKey })).status, (await as(t3)('PUT', '/api/me/title', { title: titleKey })).data.error], [409, '先在商城里买这个称号']);
  assert.equal((await as(t3)('PUT', '/api/me/title', { title: 'custom-title-999' })).status, 404);

  // 下架：商城里没有了、买不了；买过的人照样戴着
  let page = (await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { listed: false })).data;
  assert.deepEqual(lastAudit(), { action: '下架商品', detail: '称号「龙王」' });
  assert.equal(page.listings.at(-1).id, id, '下架了的排在后面');
  assert.equal(page.listings.at(-1).listed, false);
  assert.ok(!(await shopOf(t1)).items.some((i: Entry) => i.key === listings['龙王'].key));
  assert.equal((await buy(t1, listings['龙王'].key)).data.error, '龙王已经下架了');
  assert.equal((await as(t1)('GET', `/api/users/${publicId(TESTER2.username)}`)).data.title, '龙王');
  assert.ok((await as(t2)('GET', '/api/wardrobe')).data.titles.some((x: { key: string }) => x.key === titleKey));

  // 改名字：戴着的人跟着变
  assert.equal((await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { name: '' })).status, 400);
  await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { name: '龙王归来' });
  assert.deepEqual(lastAudit(), { action: '改称号名字', detail: '称号「龙王」→「龙王归来」' });
  assert.equal((await as(t1)('GET', `/api/users/${publicId(TESTER2.username)}`)).data.title, '龙王归来');

  // 改价（只有称号能改名字）
  const fine = gearView(0, 'sword', 'fine')!;
  const gearListing = listings[gearLabel(fine)];
  assert.equal((await as(admin)('PUT', `/api/admin/shop/listings/${gearListing.id}`, { name: '好剑' })).data.error, '只有称号能改名字');
  assert.equal((await as(admin)('PUT', `/api/admin/shop/listings/${gearListing.id}`, { price: 0 })).status, 400);
  assert.equal((await as(admin)('PUT', `/api/admin/shop/listings/${gearListing.id}`, { price: 120 })).data.error, '这件商品至少 150 龙晶');
  await as(admin)('PUT', `/api/admin/shop/listings/${gearListing.id}`, { price: 180 });
  assert.deepEqual(lastAudit(), { action: '改商城价格', detail: `装备「${gearLabel(fine)}」：150 → 180 龙晶` });
  assert.equal(itemOf(await shopOf(t1), gearListing.key).price, 180);
  assert.equal((await as(admin)('PUT', `/api/admin/shop/listings/${gearListing.id}`, {})).status, 400);
  assert.equal((await as(admin)('PUT', '/api/admin/shop/listings/999', { price: 5 })).status, 404);

  // 重新上架：又能买了
  page = (await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { listed: true })).data;
  assert.deepEqual(lastAudit(), { action: '上架商品', detail: '称号「龙王归来」，500 龙晶' });
  assert.equal(page.listings.find((l: Listing) => l.id === id).listed, true);
  await buy(t1, listings['龙王'].key);
  assert.equal(have(TESTER1.username, titleKey), 1);
});

test('认不出来的上架商品（代码里去掉了的技能、装备）：商城里不显示、买不了；管理页标着；下架以后不能再上架', async () => {
  await list({ kind: 'manual', ref: 'kanpo', price: 200 });
  const id = (one("SELECT id FROM shop_listings WHERE kind = 'manual' AND ref = 'kanpo'") as number);
  t.app.db.prepare("UPDATE shop_listings SET ref = 'gone-skill' WHERE id = ?").run(id);
  assert.ok(!(await shopOf(t1)).items.some((i: Entry) => i.key === `listing-${id}`));
  assert.equal((await buy(t1, `listing-${id}`)).status, 404);
  let page = (await as(admin)('GET', '/api/admin/shop')).data;
  assert.deepEqual(
    (({ known, listed, name }) => ({ known, listed, name }))(page.listings.find((l: Listing) => l.id === id)),
    { known: false, listed: true, name: '秘籍《看破》' },
  );
  page = (await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { listed: false })).data;
  const r = await as(admin)('PUT', `/api/admin/shop/listings/${id}`, { listed: true });
  assert.deepEqual([r.status, r.data.error], [409, '认不出来这件商品是什么，不能再上架']);
});

// ==================== 游客 ====================

test('游客能看商城：有商品和价格（管理员上架的也在），没有龙晶和龙晶记录，买不了', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  const r = await as(guest)('GET', '/api/shop');
  assert.equal(r.status, 200);
  const shop = r.data;
  assert.deepEqual([shop.guest, shop.crystals, shop.ledger, shop.exchange, shop.pet], [true, null, null, null, null]);
  assert.equal(itemOf(shop, 'fish').price, 5);
  assert.equal(itemOf(shop, listings['秘籍《破军一击》'].key).price, 300);
  assert.ok(shop.items.every((i: Entry) => i.max === 0 && i.owned === 0 && i.note === null));
  assert.equal((await buy(guest, 'fish')).status, 403);
  // 正式账号照旧
  const mine = await shopOf(t1);
  assert.equal(mine.guest, false);
  assert.equal(typeof mine.crystals, 'number');
  assert.ok(Array.isArray(mine.ledger));
  // 没登录的看不了
  assert.equal((await t.call('GET', '/api/shop')).status, 401);
});

// ==================== 发物品 ====================

test('发物品的权限：要「发放额度」；不能发给自己（站长可以，和发龙晶一样）；管理员的账号只有站长能发；传奇装备只有站长能发', async () => {
  setPerms(TESTER5.username, ['credit']);
  const opts = (await as(t5)('GET', '/api/admin/items')).data.options;
  assert.deepEqual(opts.legendary, []);
  assert.ok(opts.titles.some((x: { key: string; name: string }) => x.key === `custom-title-${listings['龙王'].id}` && x.name === '龙王归来'));
  assert.equal((await as(admin)('GET', '/api/admin/items')).data.options.legendary.length, 4);

  // 给自己
  let r = await grant(t5, { item: 'potion', count: 2, accounts: [TESTER5.username] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { item: '治疗药水', count: 2, granted: 0, recipients: [], capped: [], skipped: [{ name: '测试玩家五（tester5）', reason: '不能发给自己' }] });
  assert.equal(have(TESTER5.username, 'potion'), 0);
  // 站长、管理员的账号
  setPerms(TESTER4.username, ['announce']);
  r = await grant(t5, { item: 'potion', accounts: [ADMIN.username, TESTER4.username] });
  assert.deepEqual(r.data.skipped, [
    { name: '测试管理员（admin）', reason: '只有站长能发给管理员' },
    { name: '测试玩家四（tester4）', reason: '只有站长能发给管理员' },
  ]);
  assert.equal(have(TESTER4.username, 'potion'), 0);
  r = await grant(admin, { item: 'potion', accounts: [TESTER4.username, TESTER5.username, ADMIN.username] });
  assert.deepEqual([r.data.granted, r.data.skipped], [3, []]);
  assert.equal(have(TESTER4.username, 'potion'), 1);
  assert.equal(have(ADMIN.username, 'potion'), 1);
  setPerms(TESTER4.username, null);

  // 传奇装备：只有站长
  const legend = legendaryOf('leg-dragon-spear')!;
  r = await grant(t5, { item: 'gear:leg-dragon-spear:legendary', accounts: [TESTER1.username] });
  assert.deepEqual([r.status, r.data.error], [403, '只有站长能发传奇装备']);
  r = await grant(admin, { item: 'gear:leg-dragon-spear:legendary', accounts: [TESTER1.username] });
  assert.deepEqual([r.data.item, r.data.granted], [`${legend.name}（传奇）`, 1]);
  assert.ok(t.app.db.prepare("SELECT 1 FROM gear_items WHERE user_id = ? AND base = 'leg-dragon-spear' AND rarity = 'legendary'").get(userId(TESTER1.username)));

  // 不对的请求
  for (const [body, error] of [
    [{ item: 'nothing', accounts: [TESTER1.username] }, '选一下发什么'],
    [{ item: 'gear:sword:nope', accounts: [TESTER1.username] }, '选一下发什么'],
    [{ item: 'potion', count: 0, accounts: [TESTER1.username] }, '每人发 1～99 个'],
    [{ item: 'potion', count: 100, accounts: [TESTER1.username] }, '每人发 1～99 个'],
    [{ item: 'frame-jade', count: 2, accounts: [TESTER1.username] }, '青玉每人只能发一个'],
    [{ item: 'potion' }, '填一下发给谁'],
    [{ item: 'potion', accounts: [' ', ''] }, '填一下发给谁'],
  ] as const) {
    r = await grant(admin, body);
    assert.deepEqual([r.status, r.data.error], [400, error], JSON.stringify(body));
  }
  setPerms(TESTER5.username, null);
});

test('批量发物品：用户名、UID、公开编号都认；游客、删掉的、找不到的跳过；攒满了的发到满；有了的跳过；每人一条通知；一次一条操作记录', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  const guestId = (await as(guest)('GET', '/api/auth/me')).data.user.id as number;
  // 删掉的账号（和站长删正式账号以后一样：用户名换掉，UID 空出来）
  t.app.db
    .prepare("INSERT INTO users (username, display_name, password_hash, created_at, deleted_at) VALUES ('deleted-0123456789ab', '已删除的账号', '!', ?, ?)")
    .run(now, now);
  t.app.db.prepare("UPDATE users SET uid = NULL WHERE username = 'deleted-0123456789ab'").run();
  const deletedRef = publicId('deleted-0123456789ab');
  t.app.db.prepare("UPDATE pet_items SET count = 97 WHERE user_id = ? AND item = 'potion'").run(userId(TESTER2.username));
  const before3 = have(TESTER3.username, 'potion');
  const notes = (username: string) =>
    (t.app.db.prepare("SELECT data FROM notifications WHERE user_id = ? AND kind = 'item_grant' ORDER BY id").all(userId(username)) as { data: string }[]).map((n) =>
      JSON.parse(n.data),
    );
  const notesBefore = notes(TESTER3.username).length;

  let r = await grant(admin, {
    item: 'potion',
    count: 5,
    accounts: [TESTER2.username, String(uidOf(userId(TESTER3.username))), `UID${uidOf(userId(TESTER1.username))}`, publicId(TESTER2.username), String(uidOf(guestId)), 'nobody_here', deletedRef],
  });
  assert.equal(r.status, 200);
  const guestName = one('SELECT display_name FROM users WHERE id = ?', guestId);
  const guestUsername = one('SELECT username FROM users WHERE id = ?', guestId);
  assert.deepEqual(r.data, {
    item: '治疗药水',
    count: 5,
    granted: 3,
    recipients: ['测试玩家二（tester2）', '测试玩家三（tester3）', '测试玩家一（tester1）'],
    capped: [{ name: '测试玩家二（tester2）', count: 2 }],
    skipped: [
      { name: `${guestName}（${guestUsername}）`, reason: '游客' },
      { name: 'nobody_here', reason: '没有这个账号' },
      { name: deletedRef, reason: '账号已删除' },
    ],
  });
  assert.equal(have(TESTER2.username, 'potion'), ITEM_STACK_MAX);
  assert.equal(have(TESTER3.username, 'potion'), before3 + 5);
  // 通知：发了几个就写几个，去背包看
  assert.deepEqual(notes(TESTER2.username).at(-1), { item: '治疗药水', count: 2, where: 'bag' });
  assert.equal(notes(TESTER3.username).length, notesBefore + 1);
  assert.deepEqual(notes(TESTER3.username).at(-1), { item: '治疗药水', count: 5, where: 'bag' });
  assert.equal((await as(t3)('GET', '/api/notifications')).data.items[0].kind, 'item_grant');
  // 一条操作记录
  assert.deepEqual(lastAudit(), { action: '发物品', detail: '治疗药水 × 5 → 测试玩家二（tester2）、测试玩家三（tester3）、测试玩家一（tester1）；跳过 3 个' });
  // 已经攒满了：跳过
  r = await grant(admin, { item: 'potion', count: 1, accounts: [TESTER2.username] });
  assert.deepEqual([r.data.granted, r.data.skipped], [0, [{ name: '测试玩家二（tester2）', reason: `最多攒 ${ITEM_STACK_MAX} 个` }]]);
  assert.deepEqual(lastAudit(), { action: '发物品', detail: '治疗药水 → 没有人拿到；跳过 1 个' });

  // 一个就够的：有了的跳过；头像框、称号去「装扮」看
  r = await grant(admin, { item: 'frame-jade', accounts: [TESTER1.username, TESTER3.username] });
  assert.equal(r.data.granted, 2);
  r = await grant(admin, { item: 'frame-jade', accounts: [TESTER1.username, TESTER2.username] });
  assert.deepEqual([r.data.granted, r.data.skipped], [1, [{ name: '测试玩家一（tester1）', reason: '已经有了' }]]);
  assert.deepEqual(notes(TESTER2.username).at(-1), { item: '青玉', count: 1, where: 'wardrobe' });
  assert.deepEqual((await as(t3)('GET', '/api/wardrobe')).data.frames, ['frame-jade']);
  const titleKey = `custom-title-${listings['龙王'].id}`;
  r = await grant(admin, { item: titleKey, accounts: [TESTER3.username] });
  assert.equal(r.data.item, '龙王归来');
  assert.ok((await as(t3)('GET', '/api/wardrobe')).data.titles.some((x: { key: string }) => x.key === titleKey));
  // 装备：同一种、同一个稀有度有了的跳过
  const rare = gearView(0, 'bow', 'rare')!;
  r = await grant(admin, { item: 'gear:bow:rare', accounts: [TESTER3.username] });
  assert.deepEqual([r.data.item, r.data.granted], [gearLabel(rare), 1]);
  assert.equal(one("SELECT source FROM gear_items WHERE user_id = ? AND base = 'bow' AND rarity = 'rare'", userId(TESTER3.username)), 'grant');
  r = await grant(admin, { item: 'gear:bow:rare', accounts: [TESTER3.username] });
  assert.deepEqual(r.data.skipped, [{ name: '测试玩家三（tester3）', reason: '已经有了' }]);
  // 宝箱、秘籍：背包里
  await grant(admin, { item: 'chest', count: 2, accounts: [TESTER3.username] });
  await grant(admin, { item: 'manual:kanpo', accounts: [TESTER3.username] });
  const bag = (await as(t3)('GET', '/api/bag')).data;
  assert.equal(bag.chests, 2);
  assert.ok(bag.manuals.some((m: { key: string; count: number }) => m.key === 'manual:kanpo' && m.count === 1));

  // 所有正式账号：封禁中的、游客、删掉的不算；站长自己也算（和发龙晶一样，站长能给自己发）
  t.app.db.prepare('UPDATE users SET banned_at = ? WHERE username = ?').run(now, TESTER5.username);
  const formal = (one('SELECT COUNT(*) FROM users WHERE is_guest = 0 AND deleted_at IS NULL AND banned_at IS NULL') as number);
  r = await grant(admin, { item: 'tea', count: 2, all: true });
  assert.deepEqual([r.data.granted, r.data.skipped], [formal, []]);
  assert.equal(have(TESTER5.username, 'tea'), 0);
  assert.equal(have(TESTER1.username, 'tea'), 2);
  assert.deepEqual(lastAudit(), { action: '发物品', detail: `提神茶 × 2 → 所有正式账号，${formal} 个拿到了` });
  t.app.db.prepare('UPDATE users SET banned_at = NULL WHERE username = ?').run(TESTER5.username);
  // 不是站长的管理员发给所有人：自己、站长、别的管理员跳过
  setPerms(TESTER5.username, ['credit']);
  const everyone = one('SELECT COUNT(*) FROM users WHERE is_guest = 0 AND deleted_at IS NULL AND banned_at IS NULL') as number;
  r = await grant(t5, { item: 'tea', all: true });
  assert.equal(r.data.granted, everyone - 2);
  assert.deepEqual(
    r.data.skipped.map((s: { reason: string }) => s.reason),
    ['只有站长能发给管理员', '不能发给自己'],
  );
  setPerms(TESTER5.username, null);
});

// ==================== V0.7.1 审查补上的 ====================

test('发物品：用户名和 UID 对得上两个账号时不发（免得发错人），结果里写着发给了谁；管理员买上架的商品记进操作记录', async () => {
  // 有人把用户名注册成别人的 UID（「UID几」或者光是数字）
  const uid2 = uidOf(userId(TESTER2.username));
  const uid3 = uidOf(userId(TESTER3.username));
  for (const name of [`UID${uid2}`, String(uid3)]) {
    t.app.db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, '冒名的', '!', ?)").run(name, now);
  }
  const tea2 = have(TESTER2.username, 'tea');
  let r = await grant(admin, { item: 'tea', accounts: [`UID${uid2}`, String(uid3)] });
  assert.equal(r.data.granted, 0);
  assert.deepEqual(
    r.data.skipped.map((x: { reason: string }) => x.reason),
    ['分不清是用户名还是 UID（两个账号都对得上），换成公开编号再发', '分不清是用户名还是 UID（两个账号都对得上），换成公开编号再发'],
  );
  assert.equal(have(TESTER2.username, 'tea'), tea2);
  assert.equal(have(`UID${uid2}`, 'tea'), 0, '冒名的也没拿到');
  // 用公开编号就分得清
  r = await grant(admin, { item: 'tea', accounts: [publicId(TESTER2.username)] });
  assert.deepEqual([r.data.granted, r.data.recipients], [1, ['测试玩家二（tester2）']]);

  // 管理员买管理员上架的商品：记一条「管理员买上架的商品」
  setPerms(TESTER5.username, ['credit']);
  await give(TESTER5.username, 1000);
  r = await list({ kind: 'title', name: '夜行侠', price: 60 });
  const key = r.data.listings.find((l: Listing) => l.name === '夜行侠').key;
  assert.equal((await buy(t5, key)).status, 200);
  assert.deepEqual(lastAudit(), { action: '管理员买上架的商品', detail: '称号「夜行侠」，60 龙晶' });
  setPerms(TESTER5.username, null);
});
