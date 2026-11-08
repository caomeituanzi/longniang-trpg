// 商店收购价：基础比例 + 游说调整。服务端和网页用同一套算法。
export const SHOP_PERSUASION_RATE = 5;

/** 每 1 点游说调整值，收购价比例加 5 个百分点；最低 0，最高 100。基础 0 表示不收购。 */
export function shopSellRate(base: number, persuasion: number): number {
  if (base <= 0) return 0;
  return Math.max(0, Math.min(100, base + persuasion * SHOP_PERSUASION_RATE));
}

/** 每 1 点正游说调整值，商品价格降 5%，最多降 50%；最低 1 金币。基础 0（免费）不变。 */
export const SHOP_PERSUASION_DISCOUNT = 5;
export const SHOP_MAX_DISCOUNT = 50;

export function shopBuyPrice(base: number, persuasion: number): number {
  if (base <= 0) return 0;
  const discount = Math.min(SHOP_MAX_DISCOUNT, Math.max(0, persuasion) * SHOP_PERSUASION_DISCOUNT);
  return Math.max(1, Math.round((base * (100 - discount)) / 100));
}
