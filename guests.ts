import { audit } from './audit';
import type { DB } from './db';
import { getSetting, setSetting } from './settings';

// 游客账号的清理：游客点一下就能建，又不会自己消失（换个浏览器、清了 Cookie 再来就是新的一个），
// 所以每天凌晨 4 点（按服务器这台电脑的时间）把当时不在线的游客账号全部删掉。
// 那时候服务器没开着的话，下次启动时补做。正在看的游客不删，留到第二天。

export const GUEST_CLEANUP_HOUR = 4;
const LAST_CLEANUP_SETTING = 'guest_cleanup_at';

/** 最近一个「凌晨 4 点」（今天的 4 点还没到就是昨天的）。 */
export function lastCleanupBoundary(now: number): number {
  const at = new Date(now);
  at.setHours(GUEST_CLEANUP_HOUR, 0, 0, 0);
  if (at.getTime() > now) at.setDate(at.getDate() - 1);
  return at.getTime();
}

/**
 * 删掉不在线的游客账号，返回删了几个。他们提交的反馈留着（只是不再记是谁交的），和游客自己退出登录一样。
 * by：谁让删的（管理员点「清理」时是他，自动清理是 null）。
 */
export function deleteOfflineGuests(db: DB, online: Set<number>, now: number, by: number | null): number {
  const guests = (db.prepare('SELECT id FROM users WHERE is_guest = 1').all() as { id: number }[]).map((r) => r.id).filter((id) => !online.has(id));
  const remove = db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1');
  let removed = 0;
  for (const id of guests) removed += Number(remove.run(id).changes);
  if (removed > 0 || by !== null) {
    audit(db, by, '清理游客账号', `删掉了 ${removed} 个不在线的游客账号${by === null ? `（每天凌晨 ${GUEST_CLEANUP_HOUR} 点自动清理）` : ''}`, now);
  }
  return removed;
}

/** 到点了（上次清理在最近的凌晨 4 点之前）就清理一次，返回删了几个；还没到点返回 null。 */
export function cleanupGuestsIfDue(db: DB, online: Set<number>, now: number): number | null {
  const last = Number(getSetting(db, LAST_CLEANUP_SETTING) ?? 0);
  if (last >= lastCleanupBoundary(now)) return null;
  setSetting(db, LAST_CLEANUP_SETTING, String(now));
  return deleteOfflineGuests(db, online, now, null);
}
