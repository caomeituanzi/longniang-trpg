import { audit } from './audit';
import type { Cards } from './cards';
import { transaction, type DB } from './db';
import { HttpError } from './http';
import { anyGearView } from './legendary';
import { addCrystals, crystalsOf, exchangeSettingsOf, owns, petImageUrl, setExchangeSettingsOf, type Pets } from './pets';
import { getSetting, setSetting } from './settings';
import { buyListing, hiddenItems, listingEntries, listingIdOf, sortBySection } from './shop-listings';
import { MANUAL_PREFIX, manualView } from './skills';
import { BUY_MAX, EXCHANGE_DEFAULTS, frameOf, PET_SHOP, shopItemOf, type LedgerKind } from '../shared/pets';
import { CONSUMABLES, type Rarity } from '../shared/rules2';
import {
  catalogItemOf,
  EXCHANGE_ITEM,
  gearBaseOfItem,
  SECTION_LABEL,
  SHOP_CATALOG,
  SHOP_PRICE_MAX,
  type AdminShopPrice,
  type BagManual,
  type BagPage,
  type BagSupply,
  type ShopEntry,
  type ShopPage,
  type WardrobePage,
} from '../shared/shop';
import { gearView } from '../shared/gear2';

// 商城（V0.7.0）：所有用龙晶买的东西都在这里买，买的东西进账号的背包。
// 吃的用的、宠物装扮、头像框、骰子、称号、地下城道具记在 pet_items（key 是商品编号；地下城道具一种最多攒 ITEM_STACK_MAX 个）；
// 装备只卖普通的，交给角色卡那边记（cards.buyCommonGear：往 gear_items 插一行，同一件只能有一件）；
// 换 AI 额度沿用 pets.ts 的 exchange（买几个就是换几元）。自带的商品里没有秘籍（地下城里得到，背包里列着；V0.7.1 起管理员可以上架）。
// 价格管理员能改：改过的存在 settings 表的 shop_prices 里（{商品编号: 价格}），所有地方算价格都走 priceOf；
// 换额度的价格就是「多少龙晶换 1 元」，存在换额度的设置里（管理页「龙晶」里也能改）。
// 「我的背包」「装扮」两页要的东西也在这里拼。
// V0.7.1：自带的商品管理员能下架；管理员上架的新商品（编号 listing-编号）；游客也能看商城（买不了）。这些在 shop-listings.ts。

const PRICES_SETTING = 'shop_prices';

const validPrice = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SHOP_PRICE_MAX;

/** 管理员改过的价格：商品编号 → 价格（不认识的编号、不对的价格不算；换额度不在这里）。 */
export function priceOverrides(db: DB): Record<string, number> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(getSetting(db, PRICES_SETTING) ?? '{}');
  } catch {
    raw = null;
  }
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key !== EXCHANGE_ITEM && catalogItemOf(key) && validPrice(value)) out[key] = value;
    }
  }
  return out;
}

/** 一件商品现在的价格（龙晶）：改过的用改过的，没改过的用默认价；换额度是换 1 元要多少龙晶。不认识的商品是 null。 */
export function priceOf(db: DB, key: string, overrides: Record<string, number> = priceOverrides(db)): number | null {
  const item = catalogItemOf(key);
  if (!item) return null;
  if (key === EXCHANGE_ITEM) return exchangeSettingsOf(db).rate;
  return overrides[key] ?? item.basePrice;
}

/** 账号已经有的普通装备的种类（买过的、捡到的、开出来的都算）。 */
function commonGearOwned(db: DB, userId: number): Set<string> {
  return new Set(
    (db.prepare("SELECT base FROM gear_items WHERE user_id = ? AND rarity = 'common'").all(userId) as { base: string }[]).map((r) => r.base),
  );
}

export class Shop {
  /** 角色卡（app.ts 接上）：买普通装备交给它记（gear_items）。 */
  cards?: Pick<Cards, 'buyCommonGear'>;

  constructor(
    private readonly opts: {
      db: DB;
      pets: Pets;
      now: () => number;
    },
  ) {}

  private get db() {
    return this.opts.db;
  }

  priceOf(key: string): number | null {
    return priceOf(this.db, key);
  }

  // ==================== 商城 ====================

  /**
   * 商城页：现在卖的东西（限时的只在活动期间有；换额度关掉了就没有；下架了的没有；管理员上架的排在各自那一栏里）、龙晶、龙晶记录。
   * 游客（guest）只有商品和价格：买不了（max 都是 0），没有龙晶、龙晶记录、换额度的情况、宠物。
   */
  page(userId: number, guest = false): ShopPage {
    const { pets } = this.opts;
    const hidden = hiddenItems(this.db);
    const items = pets.items(userId);
    const gear = commonGearOwned(this.db, userId);
    const onSale = new Set(pets.eventItems());
    const exchange = pets.exchangeView(userId);
    const overrides = priceOverrides(this.db);
    const pet = this.db.prepare('SELECT p.name, p.image_at, u.public_id FROM pets p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?').get(userId) as
      | { name: string; image_at: number | null; public_id: string }
      | undefined;
    const entries = SHOP_CATALOG.filter((i) => !hidden.has(i.key) && (!i.limited || onSale.has(i.key)) && (i.key !== EXCHANGE_ITEM || exchange.enabled)).map((i): ShopEntry => {
      const base = gearBaseOfItem(i.key);
      const owned = base ? (gear.has(base) ? 1 : 0) : (items[i.key] ?? 0);
      let max: number = BUY_MAX;
      let note: string | null = null;
      if (i.key === EXCHANGE_ITEM) {
        max = Math.max(0, Math.min(exchange.userCap - exchange.usedThisMonth, exchange.siteLeft));
        note = exchange.unlimited ? '额度不限，用不着换' : exchange.adminBlocked ? '管理员不能换' : max === 0 ? '这个月换不了了' : null;
        if (note) max = 0;
      } else if (i.once) {
        max = owned ? 0 : 1;
        note = owned ? '已经有了' : null;
      } else if (i.stackMax !== null) {
        max = Math.max(0, Math.min(BUY_MAX, i.stackMax - owned));
        note = max === 0 ? `最多攒 ${i.stackMax} 个` : null;
      }
      return {
        key: i.key,
        name: i.name,
        section: i.section,
        price: priceOf(this.db, i.key, overrides)!,
        effect: i.effect,
        limited: i.limited,
        once: i.once,
        owned,
        max,
        note,
        gear: base ? gearView(0, base, 'common') : null,
      };
    });
    const all = sortBySection([...entries, ...listingEntries(this.db, userId)]);
    if (guest) return { guest: true, crystals: null, items: all.map((e) => ({ ...e, owned: 0, max: 0, note: null })), exchange: null, pet: null, ledger: null };
    return {
      guest: false,
      crystals: crystalsOf(this.db, userId),
      items: all,
      exchange: exchange.enabled && !hidden.has(EXCHANGE_ITEM) ? exchange : null,
      pet: pet ? { name: pet.name, image: petImageUrl(pet.public_id, pet.image_at) } : null,
      ledger: (
        this.db.prepare('SELECT delta, balance, kind, detail, created_at FROM crystal_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId) as {
          delta: number;
          balance: number;
          kind: LedgerKind;
          detail: string;
          created_at: number;
        }[]
      ).map((r) => ({ delta: r.delta, balance: r.balance, kind: r.kind, detail: r.detail, at: r.created_at })),
    };
  }

  /** 买 count 个（换额度是换 count 元）。花的龙晶记账，东西进账号的背包。管理员上架的（listing-编号）在 shop-listings.ts 里买。 */
  buy(userId: number, key: string, count: number) {
    if (listingIdOf(key) !== null) {
      buyListing(this.db, userId, key, count, this.opts.now());
      return;
    }
    const item = catalogItemOf(key);
    if (!item) throw new HttpError(404, '商城里没有这个东西');
    if (hiddenItems(this.db).has(key)) throw new HttpError(409, `${item.name}已经下架了`);
    if (item.limited && !this.opts.pets.eventItems().includes(key)) throw new HttpError(409, `${item.name}是限时商品，现在不卖`);
    if (key === EXCHANGE_ITEM) {
      this.opts.pets.exchange(userId, count);
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > BUY_MAX) throw new HttpError(400, `一次买 1～${BUY_MAX} 个`);
    const price = this.priceOf(key)!;
    const at = this.opts.now();
    const base = gearBaseOfItem(key);
    if (base) {
      if (count !== 1) throw new HttpError(400, `${item.name}买一件就够了`);
      if (commonGearOwned(this.db, userId).has(base)) throw new HttpError(409, `${item.name}你已经有了`);
      if (this.cards) {
        this.cards.buyCommonGear(userId, base, price);
        return;
      }
      transaction(this.db, () => {
        addCrystals(this.db, userId, -price, 'buy', `装备「${item.name}」`, null, at);
        this.db.prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, 'common', 'shop', ?)").run(userId, base, at);
      });
      return;
    }
    const title = item.section === 'title';
    if (item.once) {
      if (count !== 1) throw new HttpError(400, title ? '称号买一个就够了' : `${item.name}买一个就够了`);
      if (owns(this.db, userId, key)) throw new HttpError(409, title ? '这个称号你已经有了' : `${item.name}你已经有了`);
    }
    if (item.stackMax !== null) {
      const have = this.opts.pets.items(userId)[key] ?? 0;
      if (have + count > item.stackMax) throw new HttpError(409, `${item.name}最多攒 ${item.stackMax} 个，现在有 ${have} 个`);
    }
    const what = title ? `称号「${item.name}」` : item.section === 'frame' ? `头像框「${item.name}」` : item.name;
    transaction(this.db, () => {
      addCrystals(this.db, userId, -price * count, 'buy', `${what}${count > 1 ? ` × ${count}` : ''}`, null, at);
      this.db
        .prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, ?) ON CONFLICT (user_id, item) DO UPDATE SET count = count + excluded.count')
        .run(userId, key, count);
    });
  }

  // ==================== 我的背包 ====================

  /** 「我的背包」：吃的用的、地下城道具、秘籍、宝箱、装备（gear_items 里的，传奇的也在）。 */
  bag(userId: number): BagPage {
    const items = this.opts.pets.items(userId);
    const supplies = PET_SHOP.flatMap((i): BagSupply[] => {
      const count = items[i.key] ?? 0;
      if (count < 1 || (i.kind !== 'food' && i.kind !== 'tea' && i.kind !== 'rename')) return [];
      return [{ key: i.key, name: i.name, kind: i.kind, count, effect: catalogItemOf(i.key)?.effect ?? '' }];
    });
    const consumables = CONSUMABLES.filter((c) => (items[c.key] ?? 0) > 0).map((c) => ({ key: c.key, name: c.name, effect: c.effect, count: items[c.key] }));
    // 秘籍（技能编号认不出来的不列）
    const manuals = Object.entries(items).flatMap(([key, count]): BagManual[] => {
      const m = key.startsWith(MANUAL_PREFIX) ? manualView(key) : null;
      return m ? [{ key: m.key, name: m.name, text: m.text, count }] : [];
    });
    const gear = (this.db.prepare('SELECT id, base, rarity FROM gear_items WHERE user_id = ? ORDER BY id').all(userId) as { id: number; base: string; rarity: Rarity }[]).flatMap(
      (r) => {
        const view = anyGearView(r.id, r.base, r.rarity);
        return view ? [view] : [];
      },
    );
    return { supplies, consumables, manuals, chests: items.chest ?? 0, gear, pet: this.opts.pets.status(userId) };
  }

  // ==================== 装扮 ====================

  /** 「装扮」页：有的头像框、骰子、称号、宠物装扮，和戴着的。 */
  wardrobe(userId: number): WardrobePage {
    const { pets } = this.opts;
    const items = pets.items(userId);
    const owned = (kind: string) => PET_SHOP.filter((i) => i.kind === kind && (items[i.key] ?? 0) > 0).map((i) => i.key);
    const user = this.db.prepare('SELECT public_id, avatar_frame, dice_skin, title FROM users WHERE id = ?').get(userId) as {
      public_id: string;
      avatar_frame: string | null;
      dice_skin: string | null;
      title: string | null;
    };
    const pet = this.db.prepare('SELECT name, image_at, outfit FROM pets WHERE user_id = ?').get(userId) as
      | { name: string; image_at: number | null; outfit: string | null }
      | undefined;
    return {
      frames: owned('frame'),
      frame: frameOf(user.avatar_frame),
      dice: owned('dice'),
      diceSkin: user.dice_skin,
      titles: pets.titleOptions(userId),
      title: user.title,
      outfits: owned('outfit'),
      outfit: pet?.outfit ?? null,
      pet: pet ? { name: pet.name, image: petImageUrl(user.public_id, pet.image_at) } : null,
    };
  }

  /** 戴上头像框（null 是摘掉）。买过的才能戴。 */
  setFrame(userId: number, key: string | null) {
    if (key !== null) {
      const item = shopItemOf(key);
      if (!item || item.kind !== 'frame') throw new HttpError(404, '没有这个头像框');
      if (!owns(this.db, userId, key)) throw new HttpError(409, `先在商城里买${item.name}`);
    }
    this.db.prepare('UPDATE users SET avatar_frame = ? WHERE id = ?').run(key, userId);
  }

  // ==================== 管理员改价 ====================

  /** 管理页「商城」：每件商品的默认价和现价（限时的也列着）。 */
  adminPrices(): AdminShopPrice[] {
    const overrides = priceOverrides(this.db);
    return SHOP_CATALOG.map((i) => ({ key: i.key, name: i.name, section: i.section, basePrice: i.basePrice, price: priceOf(this.db, i.key, overrides)!, limited: i.limited }));
  }

  /** 改一件商品的价格（null 是恢复默认价）。记进操作记录。 */
  setPrice(adminId: number, key: string, price: number | null) {
    const item = catalogItemOf(key);
    if (!item) throw new HttpError(404, '商城里没有这个东西');
    if (price !== null && !validPrice(price)) throw new HttpError(400, `价格要填 1～${SHOP_PRICE_MAX} 的整数`);
    const before = this.priceOf(key)!;
    if (key === EXCHANGE_ITEM) {
      setExchangeSettingsOf(this.db, { ...exchangeSettingsOf(this.db), rate: price ?? EXCHANGE_DEFAULTS.rate });
    } else {
      const overrides = priceOverrides(this.db);
      if (price === null || price === item.basePrice) delete overrides[key];
      else overrides[key] = price;
      setSetting(this.db, PRICES_SETTING, JSON.stringify(overrides));
    }
    const after = this.priceOf(key)!;
    audit(this.db, adminId, '改商城价格', `${SECTION_LABEL[item.section]}「${item.name}」：${before} → ${after} 龙晶${price === null ? '（恢复默认）' : ''}`, this.opts.now());
  }
}
