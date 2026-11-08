import type { DB } from './db';

// 管理员在商城上架的称号（V0.7.1，shop_listings 里 kind 是 title 的那些，名字是管理员起的）。
// 背包（pet_items）里的编号是 custom-title-上架的编号；戴着的时候 users.title 也是这个编号。
// 下架了以后买过的人照样有、照样能戴，名字照样认得出来。

export const CUSTOM_TITLE_PREFIX = 'custom-title-';

export function customTitleKey(listingId: number): string {
  return `${CUSTOM_TITLE_PREFIX}${listingId}`;
}

/** custom-title-编号 的编号；不是这种编号的是 null。 */
export function customTitleId(key: string | null | undefined): number | null {
  if (!key || !key.startsWith(CUSTOM_TITLE_PREFIX)) return null;
  const rest = key.slice(CUSTOM_TITLE_PREFIX.length);
  return /^[1-9]\d{0,11}$/.test(rest) ? Number(rest) : null;
}

/** 管理员上架的称号的名字（不是这种称号、没有这一件的是 null）。 */
export function customTitleName(db: DB, key: string | null | undefined): string | null {
  const id = customTitleId(key);
  if (id === null) return null;
  const row = db.prepare("SELECT name FROM shop_listings WHERE id = ? AND kind = 'title'").get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

/** 一个人有的管理员上架的称号（按上架的先后）。 */
export function ownedCustomTitles(db: DB, userId: number): { key: string; name: string }[] {
  return (
    db
      .prepare(
        `SELECT l.id, l.name FROM pet_items i JOIN shop_listings l ON l.kind = 'title' AND i.item = '${CUSTOM_TITLE_PREFIX}' || l.id
         WHERE i.user_id = ? AND i.count > 0 ORDER BY l.id`,
      )
      .all(userId) as { id: number; name: string }[]
  ).map((r) => ({ key: customTitleKey(r.id), name: r.name }));
}
