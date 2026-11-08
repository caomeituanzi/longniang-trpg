// 商城的上架、下架和管理员发物品（V0.7.1）。服务器和网页共用这一份。
// 自带的商品（shared/shop.ts 的 SHOP_CATALOG）管理员能下架、再上架（记在设置 shop_hidden 里）；
// 管理员还能上架新商品（shop_listings 表）：装备（任何稀有度，传奇的除外）、秘籍、宝箱、道具（几个一份）、自己起名字的称号。
// 管理页「物品」：给指定的账号、一批账号或者所有正式账号发东西。

import { CHEST2, DUPLICATE_CRYSTALS, LEVEL_MAX, type Rarity } from './rules2';
import type { AdminShopPrice, ShopSection } from './shop';

export const LISTING_KINDS = ['gear', 'manual', 'chest', 'item', 'title'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
export const LISTING_KIND_LABEL: Record<ListingKind, string> = { gear: '装备', manual: '秘籍', chest: '宝箱', item: '道具', title: '称号' };

/** 管理员上架的商品在商城里的编号：listing-编号。 */
export const LISTING_ITEM_PREFIX = 'listing-';
/** 自己起名字的称号最多几个字。 */
export const CUSTOM_TITLE_MAX = 10;
/** 道具、宝箱一份最多几个；发物品一次每人最多发几个。 */
export const BUNDLE_MAX = 99;
/** 发物品一次最多填几个账号。 */
export const GRANT_ACCOUNTS_MAX = 500;

/**
 * 上架的商品最少卖多少龙晶（V0.7.1 审查）：
 * - 宝箱一个至少是开一个最多能开出的龙晶（难度 10 的龙晶，加上开出已经有的史诗装备折的龙晶），不然买来开就能凭空刷龙晶；
 * - 装备、秘籍、称号有个底价，管理员不能标 1 龙晶上架再自己买走（给自己发东西本来就不行）；
 * - 道具和自带的一样，按管理员定的价（自带的道具管理员本来就能改价）。
 */
export const CHEST_LISTING_MIN = CHEST2.crystalsBase[1] * LEVEL_MAX + DUPLICATE_CRYSTALS.epic;
export const GEAR_LISTING_MIN: Record<Exclude<Rarity, 'legendary'>, number> = { common: 60, fine: 150, rare: 300, epic: 600 };
export const MANUAL_LISTING_MIN = 200;
export const TITLE_LISTING_MIN = 50;

/** 一件上架的商品（一份 count 个）最少卖多少。 */
export function listingMinPrice(kind: ListingKind, ref: string, count: number): number {
  if (kind === 'chest') return CHEST_LISTING_MIN * count;
  if (kind === 'gear') return GEAR_LISTING_MIN[ref.split(':')[1] as Exclude<Rarity, 'legendary'>] ?? GEAR_LISTING_MIN.epic;
  if (kind === 'manual') return MANUAL_LISTING_MIN;
  if (kind === 'title') return TITLE_LISTING_MIN;
  return 1;
}

/** 选东西用的一项：编号和名字。 */
export type ItemPick = { key: string; name: string };

/**
 * 能上架、能发的东西（管理页「商城」「物品」选的时候用）。秘籍、传奇装备只在服务器上，所以由服务器给。
 * 发物品的编号：吃的用的、地下城道具、头像框、骰子、宠物装扮、称号就是它们自己的编号；宝箱是 chest；
 * 秘籍是 manual:技能；装备是 gear:种类:稀有度（传奇的是 gear:传奇装备的编号:legendary，只有站长发得了）；
 * 管理员上架的称号是 custom-title-编号。
 */
export type AdminItemOptions = {
  /** 吃的用的：宠物的吃的、提神茶、改名卡。 */
  supplies: ItemPick[];
  /** 地下城道具。 */
  consumables: ItemPick[];
  /** 秘籍：key 是 manual:技能。 */
  manuals: ItemPick[];
  /** 装备的种类（名字是普通的那件）；稀有度（普通到史诗）。 */
  gear: ItemPick[];
  rarities: ItemPick[];
  /** 传奇装备：只有站长有（别人是空的）；上架用不了。 */
  legendary: ItemPick[];
  frames: ItemPick[];
  dice: ItemPick[];
  outfits: ItemPick[];
  /** 称号：商城自带的、管理员上架的（下架了的也在）。 */
  titles: ItemPick[];
};

/** 管理页「商城」里管理员上架的一件。listed：在卖（没下架）。known：认得出来是什么（代码里去掉了的东西认不出来，商城里不显示）。 */
export type AdminListing = {
  id: number;
  key: string;
  kind: ListingKind;
  ref: string;
  name: string;
  count: number;
  section: ShopSection;
  price: number;
  listed: boolean;
  known: boolean;
  at: number;
  by: string | null;
};

/** 管理页「商城」里自带的一件：默认价、现价、下架了没有。 */
export type AdminShopItem = AdminShopPrice & { hidden: boolean };

export type AdminShopPage = { items: AdminShopItem[]; listings: AdminListing[]; options: AdminItemOptions };

/** 发物品的结果：发了什么、每人几个；几个账号拿到了；只拿到一部分的（攒满了）；没发的和原因。 */
export type ItemGrantResult = {
  item: string;
  count: number;
  granted: number;
  /** 拿到的人：「显示名（用户名）」（V0.7.1 审查：写明发给了谁）。 */
  recipients: string[];
  capped: { name: string; count: number }[];
  skipped: { name: string; reason: string }[];
};
