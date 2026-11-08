import { audit } from './audit';
import { customTitleKey, customTitleName } from './custom-titles';
import { transaction, type DB } from './db';
import { HttpError } from './http';
import { anyGearView, LEGENDARY_GEAR } from './legendary';
import { rejectInvisibleName } from './util';
import { addCrystals } from './pets';
import { getSetting, setSetting } from './settings';
import { MANUAL_PREFIX, manualView, SKILLS } from './skills';
import { GEAR_BASES, gearLabel, gearView, type GearView } from '../shared/gear2';
import { BUY_MAX, PET_SHOP, shopItemOf } from '../shared/pets';
import { CONSUMABLES, consumableOf, ITEM_STACK_MAX, RARITY_KEYS, RARITY_LABEL, type Rarity } from '../shared/rules2';
import { catalogItemOf, gearEffect, SECTION_LABEL, SHOP_PRICE_MAX, SHOP_SECTIONS, type ShopEntry, type ShopSection } from '../shared/shop';
import {
  BUNDLE_MAX,
  CUSTOM_TITLE_MAX,
  LISTING_ITEM_PREFIX,
  LISTING_KINDS,
  listingMinPrice,
  type AdminItemOptions,
  type AdminListing,
  type ListingKind,
} from '../shared/shop-admin';

// 商城的上架和下架（V0.7.1），和管理员发物品共用的「一样东西」。
// 自带的商品（SHOP_CATALOG）下架记在设置 shop_hidden 里（编号的列表）：下架了的商城里不显示、买不了，买过的人照样有。
// 管理员上架的新商品在 shop_listings 表：装备（种类:稀有度，传奇的不行）、秘籍（技能）、宝箱、道具（吃的用的、地下城道具，
// 可以几个一份）、自己起名字的称号（背包里是 custom-title-编号，见 custom-titles.ts）。商城里的编号是 listing-编号。
// 买的规矩和自带的同类商品一样：称号、装备有了不能再买（装备看同一种、同一个稀有度），道具、秘籍、宝箱一种最多攒 99 个，
// 龙晶不够买不了，花的龙晶记账。

const HIDDEN_SETTING = 'shop_hidden';

/** 宝箱在背包里的编号（开宝箱在 cards.ts）。 */
export const CHEST_ITEM = 'chest';
/** 发物品时装备的编号：gear:种类:稀有度。 */
export const GEAR_THING_PREFIX = 'gear:';

/**
 * 能卖、能发的一样东西：
 * stack 背包里一种攒好几个的（吃的用的、地下城道具、秘籍、宝箱），max 是最多攒几个（吃的用的不限，是 null）；
 * once 有一个就够的（头像框、骰子、宠物装扮、称号）；gear 一件装备（同一种、同一个稀有度只能有一件）。
 */
export type Thing =
  | { type: 'stack'; key: string; name: string; max: number | null; section: ShopSection; effect: string }
  | { type: 'once'; key: string; name: string; section: ShopSection; effect: string }
  | { type: 'gear'; key: string; base: string; rarity: Rarity; name: string; view: GearView; section: ShopSection; effect: string };

const CHEST_EFFECT = '开出龙晶，再加一样道具或装备';
const TITLE_EFFECT = '戴在名字旁边';

function gearThing(base: string, rarity: string, legendary: boolean): Thing | null {
  if (!(RARITY_KEYS as string[]).includes(rarity) || (rarity === 'legendary' && !legendary)) return null;
  const view = anyGearView(0, base, rarity as Rarity);
  if (!view) return null;
  return { type: 'gear', key: `${GEAR_THING_PREFIX}${base}:${rarity}`, base, rarity: rarity as Rarity, name: view.name, view, section: 'gear', effect: gearEffect(view) };
}

/**
 * 编号对应的东西：吃的用的、地下城道具、头像框、骰子、宠物装扮、称号用它们自己的编号；宝箱 chest；秘籍 manual:技能；
 * 装备 gear:种类:稀有度（legendary 是 true 才认传奇的）；管理员上架的称号 custom-title-编号。认不出来是 null。
 */
export function thingOf(db: DB, key: string, opts: { legendary?: boolean } = {}): Thing | null {
  if (key === CHEST_ITEM) return { type: 'stack', key, name: '宝箱', max: ITEM_STACK_MAX, section: 'chest', effect: CHEST_EFFECT };
  if (key.startsWith(MANUAL_PREFIX)) {
    const m = manualView(key);
    return m ? { type: 'stack', key, name: m.name, max: ITEM_STACK_MAX, section: 'manual', effect: m.text } : null;
  }
  if (key.startsWith(GEAR_THING_PREFIX)) {
    const [base = '', rarity = '', extra] = key.slice(GEAR_THING_PREFIX.length).split(':');
    return extra === undefined ? gearThing(base, rarity, !!opts.legendary) : null;
  }
  const c = consumableOf(key);
  if (c) return { type: 'stack', key, name: c.name, max: ITEM_STACK_MAX, section: 'dungeon', effect: c.effect };
  const p = shopItemOf(key);
  if (p) {
    const effect = catalogItemOf(p.key)?.effect ?? '';
    if (p.kind === 'food' || p.kind === 'tea' || p.kind === 'rename') return { type: 'stack', key, name: p.name, max: null, section: 'supplies', effect };
    return { type: 'once', key, name: p.name, section: p.kind, effect };
  }
  const title = customTitleName(db, key);
  return title !== null ? { type: 'once', key, name: title, section: 'title', effect: TITLE_EFFECT } : null;
}

/** 名字（装备带上稀有度：精钢剑（精良））。 */
export function thingLabel(thing: Thing): string {
  return thing.type === 'gear' ? gearLabel(thing.view) : thing.name;
}

/** 已经有几个（一个就够的、装备：有了是 1）。 */
export function ownedCount(db: DB, userId: number, thing: Thing): number {
  if (thing.type === 'gear') return db.prepare('SELECT 1 FROM gear_items WHERE user_id = ? AND base = ? AND rarity = ?').get(userId, thing.base, thing.rarity) ? 1 : 0;
  const n = (db.prepare('SELECT count FROM pet_items WHERE user_id = ? AND item = ?').get(userId, thing.key) as { count: number } | undefined)?.count ?? 0;
  return thing.type === 'once' ? (n > 0 ? 1 : 0) : Math.max(0, n);
}

/** 放进背包（装备进 gear_items）。数量的上限调用的人先算好。要在事务里调用。 */
export function giveThing(db: DB, userId: number, thing: Thing, count: number, source: string, at: number) {
  if (thing.type === 'gear') {
    db.prepare('INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(userId, thing.base, thing.rarity, source, at);
  } else if (thing.type === 'once') {
    db.prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, 1) ON CONFLICT (user_id, item) DO UPDATE SET count = MAX(count, 1)').run(userId, thing.key);
  } else {
    db.prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, ?) ON CONFLICT (user_id, item) DO UPDATE SET count = count + excluded.count').run(userId, thing.key, count);
  }
}

// ==================== 自带商品的下架 ====================

/** 下架了的自带商品的编号（不认识的不算）。 */
export function hiddenItems(db: DB): Set<string> {
  try {
    const raw: unknown = JSON.parse(getSetting(db, HIDDEN_SETTING) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string' && !!catalogItemOf(k)) : []);
  } catch {
    return new Set();
  }
}

/** 下架（hidden 是 true）或者重新上架一件自带的商品。记进操作记录。 */
export function setHidden(db: DB, adminId: number, key: string, hidden: boolean, at: number) {
  const item = catalogItemOf(key);
  if (!item) throw new HttpError(404, '商城里没有这个东西');
  const set = hiddenItems(db);
  if (set.has(key) === hidden) return;
  if (hidden) set.add(key);
  else set.delete(key);
  setSetting(db, HIDDEN_SETTING, JSON.stringify([...set]));
  audit(db, adminId, hidden ? '下架商品' : '上架商品', `${SECTION_LABEL[item.section]}「${item.name}」`, at);
}

// ==================== 管理员上架的商品 ====================

type ListingRow = {
  id: number;
  kind: ListingKind;
  ref: string;
  name: string;
  count: number;
  price: number;
  created_by: number | null;
  created_at: number;
  removed_at: number | null;
};

const LISTING_COLUMNS = 'id, kind, ref, name, count, price, created_by, created_at, removed_at';
const FALLBACK_SECTION: Record<ListingKind, ShopSection> = { gear: 'gear', manual: 'manual', chest: 'chest', item: 'supplies', title: 'title' };

/** 上架的商品是什么东西（代码里去掉了的认不出来，是 null）。 */
function listingThing(db: DB, row: ListingRow): Thing | null {
  switch (row.kind) {
    case 'gear': {
      const [base = '', rarity = ''] = row.ref.split(':');
      return gearThing(base, rarity, false);
    }
    case 'manual':
      return thingOf(db, `${MANUAL_PREFIX}${row.ref}`);
    case 'chest':
      return thingOf(db, CHEST_ITEM);
    case 'item': {
      const thing = thingOf(db, row.ref);
      return thing?.type === 'stack' && (thing.section === 'supplies' || thing.section === 'dungeon') ? thing : null;
    }
    case 'title':
      return { type: 'once', key: customTitleKey(row.id), name: row.name, section: 'title', effect: TITLE_EFFECT };
  }
}

/** 商城里显示的名字：几个一份的写上几个（治疗药水 × 5）。 */
function listingName(row: ListingRow, thing: Thing | null): string {
  const name = thing ? thing.name : row.name;
  return row.count > 1 ? `${name} × ${row.count}` : name;
}

export function listingIdOf(key: string): number | null {
  if (!key.startsWith(LISTING_ITEM_PREFIX)) return null;
  const rest = key.slice(LISTING_ITEM_PREFIX.length);
  return /^[1-9]\d{0,11}$/.test(rest) ? Number(rest) : null;
}

function listingRow(db: DB, id: number): ListingRow | null {
  return (db.prepare(`SELECT ${LISTING_COLUMNS} FROM shop_listings WHERE id = ?`).get(id) as ListingRow | undefined) ?? null;
}

const SECTION_ORDER = new Map(SHOP_SECTIONS.map((s, i) => [s.key, i]));

/** 商品按栏排（同一栏里先后不变：自带的在前，上架的按上架的先后）。 */
export function sortBySection(entries: ShopEntry[]): ShopEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (SECTION_ORDER.get(a.e.section) ?? 99) - (SECTION_ORDER.get(b.e.section) ?? 99) || a.i - b.i)
    .map((x) => x.e);
}

/** 商城里管理员上架的、在卖的商品（这个人有几个、还能买几个）。 */
export function listingEntries(db: DB, userId: number): ShopEntry[] {
  const rows = db.prepare(`SELECT ${LISTING_COLUMNS} FROM shop_listings WHERE removed_at IS NULL ORDER BY id`).all() as ListingRow[];
  return rows.flatMap((row): ShopEntry[] => {
    const thing = listingThing(db, row);
    if (!thing) return [];
    const owned = ownedCount(db, userId, thing);
    let max: number = BUY_MAX;
    let note: string | null = null;
    if (thing.type !== 'stack') {
      max = owned ? 0 : 1;
      note = owned ? '已经有了' : null;
    } else if (thing.max !== null) {
      max = Math.max(0, Math.min(BUY_MAX, Math.floor((thing.max - owned) / row.count)));
      note = max === 0 ? `最多攒 ${thing.max} 个` : null;
    }
    return [
      {
        key: `${LISTING_ITEM_PREFIX}${row.id}`,
        name: listingName(row, thing),
        section: thing.section,
        price: row.price,
        effect: thing.effect,
        limited: false,
        once: thing.type !== 'stack',
        owned,
        max,
        note,
        gear: thing.type === 'gear' ? thing.view : null,
      },
    ];
  });
}

/** 买 count 份管理员上架的商品。花的龙晶记账，东西进账号的背包（装备进 gear_items）。 */
export function buyListing(db: DB, userId: number, key: string, count: number, at: number) {
  const id = listingIdOf(key);
  const row = id === null ? null : listingRow(db, id);
  const thing = row ? listingThing(db, row) : null;
  if (!row || !thing) throw new HttpError(404, '商城里没有这个东西');
  const name = listingName(row, thing);
  if (row.removed_at !== null) throw new HttpError(409, `${name}已经下架了`);
  if (!Number.isInteger(count) || count < 1 || count > BUY_MAX) throw new HttpError(400, `一次买 1～${BUY_MAX} 个`);
  const title = thing.section === 'title';
  if (thing.type !== 'stack') {
    if (count !== 1) throw new HttpError(400, title ? '称号买一个就够了' : `${name}买一件就够了`);
    if (ownedCount(db, userId, thing)) throw new HttpError(409, title ? '这个称号你已经有了' : `${name}你已经有了`);
  }
  const units = thing.type === 'stack' ? count * row.count : 1;
  if (thing.type === 'stack' && thing.max !== null) {
    const have = ownedCount(db, userId, thing);
    if (have + units > thing.max) throw new HttpError(409, `${thing.name}最多攒 ${thing.max} 个，现在有 ${have} 个`);
  }
  const detail = thing.type === 'gear' ? `装备「${thingLabel(thing)}」` : title ? `称号「${thing.name}」` : `${thing.name}${units > 1 ? ` × ${units}` : ''}`;
  // 管理员买管理员上架的商品记进操作记录（上架的价格是管理员定的，V0.7.1 审查）
  const buyer = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(userId) as { is_admin: number; is_owner: number } | undefined;
  transaction(db, () => {
    addCrystals(db, userId, -row.price * count, 'buy', detail, null, at);
    giveThing(db, userId, thing, units, 'shop', at);
    if (buyer && (buyer.is_admin === 1 || buyer.is_owner === 1)) audit(db, userId, '管理员买上架的商品', `${detail}，${row.price * count} 龙晶`, at);
  });
}

// ---------- 管理页 ----------

/** 管理页「商城」里管理员上架的商品：在卖的在前（新的在前），下架了的在后。 */
export function adminListings(db: DB): AdminListing[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.kind, l.ref, l.name, l.count, l.price, l.created_by, l.created_at, l.removed_at, u.display_name AS by_name
       FROM shop_listings l LEFT JOIN users u ON u.id = l.created_by ORDER BY l.removed_at IS NOT NULL, l.id DESC`,
    )
    .all() as (ListingRow & { by_name: string | null })[];
  return rows.map((row) => {
    const thing = listingThing(db, row);
    return {
      id: row.id,
      key: `${LISTING_ITEM_PREFIX}${row.id}`,
      kind: row.kind,
      ref: row.ref,
      name: thing?.type === 'gear' ? gearLabel(thing.view) : listingName(row, thing),
      count: row.count,
      section: thing?.section ?? FALLBACK_SECTION[row.kind],
      price: row.price,
      listed: row.removed_at === null,
      known: !!thing,
      at: row.created_at,
      by: row.by_name,
    };
  });
}

/** 价格：整数，不低于这一类商品的底价（见 listingMinPrice），不超过 SHOP_PRICE_MAX。 */
const readPrice = (v: unknown, kind: ListingKind, ref: string, count: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > SHOP_PRICE_MAX) throw new HttpError(400, `价格要填 1～${SHOP_PRICE_MAX} 的整数`);
  const min = listingMinPrice(kind, ref, count);
  if (v < min) throw new HttpError(400, `${kind === 'chest' ? `宝箱一个至少 ${min / count} 龙晶${count > 1 ? `，${count} 个一份至少 ${min}` : ''}` : `这件商品至少 ${min} 龙晶`}`);
  return v;
};

/**
 * 称号的名字：1～CUSTOM_TITLE_MAX 个字；新起的不能有换行、零宽、改文字方向这些看不见的字符（V0.8.0 安全审查）。
 * current 是原来的名字：没改的不查（以前存的照旧）。
 */
function readTitleName(v: unknown, current: string | null = null): string {
  const text = typeof v === 'string' ? v.trim() : '';
  if (!text || [...text].length > CUSTOM_TITLE_MAX) throw new HttpError(400, `称号要填 1～${CUSTOM_TITLE_MAX} 个字`);
  if (text !== current) rejectInvisibleName(text);
  return text;
}

/** 在卖的商品里已经有一样的（种类、东西、几个一份都一样；称号是名字一样）。 */
function sameOnSale(db: DB, kind: ListingKind, ref: string, name: string, count: number, except: number | null): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM shop_listings WHERE removed_at IS NULL AND kind = ? AND ref = ? AND count = ? AND (kind != 'title' OR name = ?) AND id != ?`,
    )
    .get(kind, ref, count, name, except ?? 0);
}

/**
 * 上架一件新商品：{ kind, ref, name?, count?, price }。
 * gear 的 ref 是 种类:稀有度（传奇的不行）；manual 的 ref 是技能；chest 不用 ref；item 的 ref 是吃的用的、地下城道具的编号；
 * title 要写 name（称号本身）。count 是一份几个（只有 item、chest 能多于 1）。返回编号。
 */
export function createListing(db: DB, adminId: number, body: Record<string, unknown>, at: number): number {
  if (typeof body.kind !== 'string' || !(LISTING_KINDS as readonly string[]).includes(body.kind)) throw new HttpError(400, '选一下上架什么');
  const kind = body.kind as ListingKind;
  const rawRef = typeof body.ref === 'string' ? body.ref.trim() : '';
  let ref = '';
  let thing: Thing | null = null;
  let name = '';
  if (kind === 'gear') {
    const [base = '', rarity = ''] = rawRef.split(':');
    if (rarity === 'legendary') throw new HttpError(400, '传奇装备不能上架');
    thing = gearThing(base, rarity, false);
    if (!thing) throw new HttpError(400, '选一下哪件装备');
    ref = `${base}:${rarity}`;
  } else if (kind === 'manual') {
    thing = thingOf(db, `${MANUAL_PREFIX}${rawRef}`);
    if (!thing) throw new HttpError(400, '选一下哪本秘籍');
    ref = rawRef;
  } else if (kind === 'chest') {
    thing = thingOf(db, CHEST_ITEM);
  } else if (kind === 'item') {
    const t = thingOf(db, rawRef);
    if (!t || t.type !== 'stack' || (t.section !== 'supplies' && t.section !== 'dungeon')) throw new HttpError(400, '选一下哪样道具');
    thing = t;
    ref = rawRef;
  } else {
    name = readTitleName(body.name);
  }
  if (thing) name = thing.name;
  const bundle = kind === 'item' || kind === 'chest';
  let count = 1;
  if (body.count !== undefined && body.count !== 1) {
    if (!bundle) throw new HttpError(400, `${kind === 'title' ? '称号' : kind === 'gear' ? '装备' : '秘籍'}一份只能有一个`);
    if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > BUNDLE_MAX) throw new HttpError(400, `一份要填 1～${BUNDLE_MAX} 个`);
    count = body.count;
  }
  const price = readPrice(body.price, kind, ref, count);
  if (sameOnSale(db, kind, ref, name, count, null)) throw new HttpError(409, '已经有一样的商品在卖了');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO shop_listings (kind, ref, name, count, price, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, ref, name, count, price, adminId, at);
  const id = Number(lastInsertRowid);
  const row = listingRow(db, id)!;
  const label = kind === 'gear' && thing ? thingLabel(thing) : listingName(row, thing);
  audit(db, adminId, '上架商品', `${SECTION_LABEL[thing?.section ?? FALLBACK_SECTION[kind]]}「${label}」，${price} 龙晶`, at);
  return id;
}

/** 改管理员上架的商品：{ price?, name?（只有称号能改）, listed?（false 是下架，true 是重新上架） }。每一样改动记一条操作记录。 */
export function updateListing(db: DB, adminId: number, id: number, body: Record<string, unknown>, at: number) {
  const row = listingRow(db, id);
  if (!row) throw new HttpError(404, '没有这件商品');
  if (body.price === undefined && body.name === undefined && body.listed === undefined) throw new HttpError(400, '请求格式不对');
  if (body.listed !== undefined && typeof body.listed !== 'boolean') throw new HttpError(400, '请求格式不对');
  const price = body.price === undefined ? row.price : readPrice(body.price, row.kind, row.ref, row.count);
  let name = row.name;
  if (body.name !== undefined) {
    if (row.kind !== 'title') throw new HttpError(400, '只有称号能改名字');
    name = readTitleName(body.name, row.name);
  }
  const listed = body.listed === undefined ? row.removed_at === null : body.listed;
  if (listed && sameOnSale(db, row.kind, row.ref, name, row.count, row.id)) throw new HttpError(409, '已经有一样的商品在卖了');
  const thing = listingThing(db, row);
  if (listed && row.removed_at !== null && !thing) throw new HttpError(409, '认不出来这件商品是什么，不能再上架');
  const section = SECTION_LABEL[thing?.section ?? FALLBACK_SECTION[row.kind]];
  const label = (n: string) => (row.kind === 'title' ? n : thing?.type === 'gear' ? thingLabel(thing) : listingName(row, thing));
  transaction(db, () => {
    if (name !== row.name) {
      db.prepare('UPDATE shop_listings SET name = ? WHERE id = ?').run(name, id);
      audit(db, adminId, '改称号名字', `称号「${row.name}」→「${name}」`, at);
    }
    if (price !== row.price) {
      db.prepare('UPDATE shop_listings SET price = ? WHERE id = ?').run(price, id);
      audit(db, adminId, '改商城价格', `${section}「${label(name)}」：${row.price} → ${price} 龙晶`, at);
    }
    if (listed !== (row.removed_at === null)) {
      db.prepare('UPDATE shop_listings SET removed_at = ? WHERE id = ?').run(listed ? null : at, id);
      audit(db, adminId, listed ? '上架商品' : '下架商品', `${section}「${label(name)}」${listed ? `，${price} 龙晶` : ''}`, at);
    }
  });
}

/** 能上架、能发的东西（管理页「商城」「物品」选的时候用）。legendary：要不要传奇装备（只给站长）。 */
export function itemOptions(db: DB, legendary: boolean): AdminItemOptions {
  const pick = (kind: string) => PET_SHOP.filter((i) => i.kind === kind).map((i) => ({ key: i.key, name: i.name }));
  const custom = (db.prepare("SELECT id, name, removed_at FROM shop_listings WHERE kind = 'title' ORDER BY id").all() as { id: number; name: string; removed_at: number | null }[]).map(
    (r) => ({ key: customTitleKey(r.id), name: r.removed_at === null ? r.name : `${r.name}（已下架）` }),
  );
  return {
    supplies: PET_SHOP.filter((i) => i.kind === 'food' || i.kind === 'tea' || i.kind === 'rename').map((i) => ({ key: i.key, name: i.name })),
    consumables: CONSUMABLES.map((c) => ({ key: c.key, name: c.name })),
    manuals: SKILLS.flatMap((s) => {
      const m = manualView(`${MANUAL_PREFIX}${s.key}`);
      return m ? [{ key: m.key, name: m.name }] : [];
    }),
    gear: GEAR_BASES.flatMap((b) => {
      const v = gearView(0, b.key, 'common');
      return v ? [{ key: b.key, name: v.name }] : [];
    }),
    rarities: RARITY_KEYS.filter((r) => r !== 'legendary').map((r) => ({ key: r, name: RARITY_LABEL[r] })),
    legendary: legendary ? LEGENDARY_GEAR.map((g) => ({ key: g.key, name: g.name })) : [],
    frames: pick('frame'),
    dice: pick('dice'),
    outfits: pick('outfit'),
    titles: [...pick('title'), ...custom],
  };
}
