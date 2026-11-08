// 商城（V0.7.0）：所有用龙晶买的东西都在这里卖。服务器和网页共用这一份。
// 商品编号：吃的用的、宠物装扮、头像框、骰子、称号用 shared/pets.ts 里 PET_SHOP 的 key；地下城道具用 shared/rules2.ts 里
// CONSUMABLES 的 key；装备是「gear-种类」（只卖普通稀有度的，shared/gear2.ts）；换 AI 额度是 exchange（买几个就是换几元）。
// 这里是默认价。管理员能改（存在 settings 表的 shop_prices 里），现价一律由服务器的 priceOf 算（server/shop.ts）；
// 换额度的价格就是「多少龙晶换 1 元」，和管理页「龙晶」里的设置是同一个数。

import type { TitleOption } from './achievements';
import { COMMON_GEAR_PRICE, GEAR_BASES, gearEffectLine, gearView, type GearView } from './gear2';
import { EXCHANGE_DEFAULTS, PET_SHOP, type ExchangeView, type LedgerKind, type ShopItemKind } from './pets';
import { CONSUMABLES, ITEM_STACK_MAX, type ConsumableKey } from './rules2';

export type ShopSection = 'supplies' | 'dungeon' | 'gear' | 'manual' | 'chest' | 'outfit' | 'frame' | 'dice' | 'title' | 'exchange';

/** 商城的几栏（网页上按这个顺序排）。秘籍、宝箱（V0.7.1）只有管理员上架的，没上架时这两栏不出现。 */
export const SHOP_SECTIONS: readonly { key: ShopSection; label: string }[] = [
  { key: 'supplies', label: '吃的用的' },
  { key: 'dungeon', label: '地下城道具' },
  { key: 'gear', label: '装备' },
  { key: 'manual', label: '秘籍' },
  { key: 'chest', label: '宝箱' },
  { key: 'outfit', label: '装扮' },
  { key: 'frame', label: '头像框' },
  { key: 'dice', label: '骰子' },
  { key: 'title', label: '称号' },
  { key: 'exchange', label: '换额度' },
];

export const SECTION_LABEL = Object.fromEntries(SHOP_SECTIONS.map((s) => [s.key, s.label])) as Record<ShopSection, string>;

/** 换 AI 额度这件商品的编号。 */
export const EXCHANGE_ITEM = 'exchange';
/** 装备商品的编号是 gear-种类（gear-sword……）。 */
export const GEAR_ITEM_PREFIX = 'gear-';
/** 管理员改价：1～这么多龙晶。 */
export const SHOP_PRICE_MAX = 100_000;

export type CatalogItem = {
  key: string;
  name: string;
  section: ShopSection;
  /** 默认价（龙晶）。 */
  basePrice: number;
  /** 买一个就够（装扮、头像框、骰子、称号、装备）。 */
  once: boolean;
  /** 限时商品：只在列着它的活动期间卖。 */
  limited: boolean;
  /** 背包里一种最多攒几个（地下城道具）；不限是 null。 */
  stackMax: number | null;
  /** 一句话：它是干什么的。 */
  effect: string;
};

const SECTION_OF_KIND: Record<ShopItemKind, ShopSection> = {
  food: 'supplies',
  tea: 'supplies',
  rename: 'supplies',
  outfit: 'outfit',
  frame: 'frame',
  dice: 'dice',
  title: 'title',
};

function petShopEffect(i: (typeof PET_SHOP)[number]): string {
  if ('satiety' in i) return `宠物饱食度 +${i.satiety}`;
  if ('energy' in i) return `宠物精力 +${i.energy}`;
  switch (i.kind) {
    case 'rename':
      return '给宠物改一次名字';
    case 'dice':
      return '掷骰时骰子的样子';
    case 'outfit':
      return '戴在宠物身上';
    case 'frame':
      return '画在头像外面';
    default:
      return '戴在名字旁边';
  }
}

/** 一件装备一句话：哪个部位、加什么、什么时候用得上（「胸部，护甲 +1，挡刀挡箭」）。 */
export function gearEffect(g: Pick<GearView, 'part' | 'slot' | 'attribute' | 'bonus' | 'use'>): string {
  return gearEffectLine(g);
}

const SECTION_ORDER = new Map(SHOP_SECTIONS.map((s, i) => [s.key, i]));

const ALL_ITEMS: CatalogItem[] = [
  ...PET_SHOP.map(
    (i): CatalogItem => ({
      key: i.key,
      name: i.name,
      section: SECTION_OF_KIND[i.kind],
      basePrice: i.price,
      once: i.kind === 'title' || i.kind === 'dice' || i.kind === 'outfit' || i.kind === 'frame',
      limited: 'event' in i && !!i.event,
      stackMax: null,
      effect: petShopEffect(i),
    }),
  ),
  ...CONSUMABLES.map(
    (c): CatalogItem => ({ key: c.key, name: c.name, section: 'dungeon', basePrice: c.price, once: false, limited: false, stackMax: ITEM_STACK_MAX, effect: c.effect }),
  ),
  ...GEAR_BASES.flatMap((b): CatalogItem[] => {
    const v = gearView(0, b.key, 'common');
    return v
      ? [{ key: GEAR_ITEM_PREFIX + b.key, name: v.name, section: 'gear', basePrice: COMMON_GEAR_PRICE, once: true, limited: false, stackMax: null, effect: gearEffect(v) }]
      : [];
  }),
  { key: EXCHANGE_ITEM, name: '1 元 AI 额度', section: 'exchange', basePrice: EXCHANGE_DEFAULTS.rate, once: false, limited: false, stackMax: null, effect: '用龙晶换 AI 额度' },
];

/** 商城里的全部商品（按栏排好，同一栏里照定义的顺序）。 */
export const SHOP_CATALOG: readonly CatalogItem[] = ALL_ITEMS.sort((a, b) => SECTION_ORDER.get(a.section)! - SECTION_ORDER.get(b.section)!);

const BY_KEY = new Map(SHOP_CATALOG.map((i) => [i.key, i]));
// 宠物的东西、地下城道具、装备的编号放在一起：撞了说明改了一边忘了另一边
if (BY_KEY.size !== SHOP_CATALOG.length) throw new Error('商城里有重复的商品编号');

export function catalogItemOf(key: string | null | undefined): CatalogItem | null {
  return (key && BY_KEY.get(key)) || null;
}

/** 装备商品的种类（gear-sword → sword）；不是装备的是 null。 */
export function gearBaseOfItem(key: string): string | null {
  return key.startsWith(GEAR_ITEM_PREFIX) && catalogItemOf(key)?.section === 'gear' ? key.slice(GEAR_ITEM_PREFIX.length) : null;
}

// ==================== 服务器发给网页的 ====================

/** 商城里的一件商品。 */
export type ShopEntry = {
  key: string;
  name: string;
  section: ShopSection;
  /** 现价（龙晶）；换额度是换 1 元要多少龙晶。 */
  price: number;
  effect: string;
  limited: boolean;
  once: boolean;
  /** 已经有几个（买一次就够的：有了是 1）。 */
  owned: number;
  /** 现在一次最多能买几个（换额度是最多换几元）；0 是现在买不了，原因在 note。 */
  max: number;
  note: string | null;
  /** 装备的样子（装备才有）。 */
  gear: GearView | null;
};

export type LedgerEntry = { delta: number; balance: number; kind: LedgerKind; detail: string; at: number };

/**
 * 商城页：龙晶、能买的东西、换额度的情况（关掉了是 null）、自己的宠物（预览装扮用）、龙晶记录。
 * 游客（V0.7.1）也能看：guest 是 true，只有商品和价格（买不了，max 都是 0），没有龙晶和龙晶记录（都是 null）。
 */
export type ShopPage = {
  guest: boolean;
  crystals: number | null;
  items: ShopEntry[];
  exchange: ExchangeView | null;
  pet: { name: string; image: string | null } | null;
  ledger: LedgerEntry[] | null;
};

export type BagSupply = { key: string; name: string; kind: 'food' | 'tea' | 'rename'; count: number; effect: string };

/**
 * 秘籍（背包里 key 是 manual:技能编号）：名字（秘籍《…》）、学会的技能做什么、有几本。
 * 自带的商品里没有秘籍（V0.7.1 起管理员可以上架）；研读（给一张角色卡学会）在「我的角色」里。
 */
export type BagManual = { key: string; name: string; text: string; count: number };

/** 「我的背包」：吃的用的、地下城道具、秘籍、宝箱、装备。pet：喂的是哪只（还没养是 null）。 */
export type BagPage = {
  supplies: BagSupply[];
  consumables: { key: ConsumableKey; name: string; effect: string; count: number }[];
  manuals: BagManual[];
  chests: number;
  gear: GearView[];
  pet: { name: string; satiety: number; energy: number } | null;
};

/** 「装扮」页：有的头像框、骰子、称号、宠物装扮，和戴着的（都没戴是 null）。 */
export type WardrobePage = {
  frames: string[];
  frame: string | null;
  dice: string[];
  diceSkin: string | null;
  titles: TitleOption[];
  title: string | null;
  outfits: string[];
  outfit: string | null;
  pet: { name: string; image: string | null } | null;
};

/** 管理页「商城」的一行：默认价、现价。 */
export type AdminShopPrice = { key: string; name: string; section: ShopSection; basePrice: number; price: number; limited: boolean };
