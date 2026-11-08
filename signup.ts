import crypto from 'node:crypto';
import net from 'node:net';
import type { DB } from './db';
import { openDailyTrials } from './settings';
import { dayStart } from './util';

// 开放注册时防一个人注册好几个号领初始额度：
// - 同一个网络（IPv4 是同一个地址，IPv6 是同一个 /64 网段）30 天里只送一份初始额度；
// - 同一个浏览器 30 天里登录过别的正式账号，也不送（浏览器里存一个随机编号，存在 Cookie 里）；
// - 开放注册每天送出的份数有上限，超过的当天不送。
// 不送的账号照样能注册、能玩，只是额度从 0 开始，管理员可以手动发。网络和浏览器都只存哈希。
// 用邀请码注册的照常送「新账号的初始额度」，但它的网络和浏览器也记下来，算进上面的规矩里。

/** 浏览器编号存在这个 Cookie 里（只用来认出是不是同一个浏览器）。 */
export const DEVICE_COOKIE = 'trpg_device';
/** 浏览器编号的 Cookie 留多久（浏览器最多只认 400 天）。 */
export const DEVICE_COOKIE_DAYS = 400;
/** 同一个网络、同一个浏览器多久里只送一份初始额度。 */
export const TRIAL_WINDOW_DAYS = 30;
const TRIAL_WINDOW_MS = TRIAL_WINDOW_DAYS * 24 * 3_600_000;

export type Withheld = 'device' | 'network' | 'daily';

/** 没送初始额度的原因（管理页、注册完的提示里用）。 */
export const WITHHELD_LABEL: Record<Withheld, string> = {
  device: `这个浏览器 ${TRIAL_WINDOW_DAYS} 天内登录过别的账号`,
  network: `同一个网络 ${TRIAL_WINDOW_DAYS} 天内已经有账号领过初始额度`,
  daily: '今天开放注册送出的初始额度到上限了',
};

/** 网络：IPv4 是地址本身；IPv6 取前 64 位（同一户人家、同一台手机换着用的地址都在一个 /64 里）。 */
export function networkOf(ip: string): string {
  const address = ip.trim().toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (net.isIPv6(address)) {
    const [head, tail = ''] = address.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const full = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return `${full
      .slice(0, 4)
      .map((part) => (parseInt(part || '0', 16) || 0).toString(16))
      .join(':')}::/64`;
  }
  return address;
}

export function placeOf(ip: string): string {
  return crypto.createHash('sha256').update(`ai-trpg-signup-place:${networkOf(ip)}`).digest('hex');
}

export function newDeviceToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Cookie 里的浏览器编号换成存进数据库的哈希；Cookie 不像是我们发的（长度不对）就当没有。 */
export function deviceOf(token: string | undefined): string | null {
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return crypto.createHash('sha256').update(`ai-trpg-device:${token}`).digest('hex');
}

/** 记下这个浏览器登录过这个账号（游客不记）。 */
export function rememberDevice(db: DB, userId: number, device: string, at: number) {
  db.prepare(
    `INSERT INTO devices (device, user_id, last_at) SELECT ?, id, ? FROM users WHERE id = ? AND is_guest = 0
     ON CONFLICT (device, user_id) DO UPDATE SET last_at = excluded.last_at`,
  ).run(device, at, userId);
}

/** 今天（服务器这台电脑上的日历日）开放注册已经送出了几份初始额度。 */
export function trialsToday(db: DB, at: number): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM signups WHERE via = 'open' AND credit_usd > 0 AND created_at >= ?").get(dayStart(at)) as { n: number }
  ).n;
}

/** 开放注册的这个人能不能领初始额度：能领返回 null，不能领返回原因。 */
export function trialCheck(db: DB, c: { place: string; device: string | null; at: number }): Withheld | null {
  const since = c.at - TRIAL_WINDOW_MS;
  if (
    c.device &&
    db
      .prepare(
        `SELECT 1 FROM devices d JOIN users u ON u.id = d.user_id
         WHERE d.device = ? AND d.last_at >= ? AND u.is_guest = 0 AND u.deleted_at IS NULL LIMIT 1`,
      )
      .get(c.device, since)
  ) {
    return 'device';
  }
  if (db.prepare('SELECT 1 FROM signups WHERE place = ? AND credit_usd > 0 AND created_at >= ? LIMIT 1').get(c.place, since)) return 'network';
  if (trialsToday(db, c.at) >= openDailyTrials(db)) return 'daily';
  return null;
}

export function recordSignup(
  db: DB,
  s: { userId: number; via: 'invite' | 'open'; place: string; device: string | null; credit: number; withheld: Withheld | null; at: number },
) {
  db.prepare('INSERT INTO signups (user_id, via, place, device, credit_usd, withheld, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    s.userId,
    s.via,
    s.place,
    s.device,
    s.credit,
    s.withheld,
    s.at,
  );
}

export type RelatedAccount = { id: number; uid: number | null; username: string; displayName: string; how: string[] };

/**
 * 可能是同一个人的账号：用同一个浏览器登录过的、在同一个网络注册的（给管理员查小号用）。
 * 同一个网络也可能只是一家人、一个学校，管理员自己判断。
 */
export function relatedAccounts(db: DB, userId: number): RelatedAccount[] {
  const found = new Map<number, RelatedAccount>();
  const add = (rows: { id: number; uid: number | null; username: string; display_name: string }[], how: string) => {
    for (const r of rows) {
      const item = found.get(r.id) ?? { id: r.id, uid: r.uid, username: r.username, displayName: r.display_name, how: [] };
      if (!item.how.includes(how)) item.how.push(how);
      found.set(r.id, item);
    }
  };
  add(
    db
      .prepare(
        `SELECT DISTINCT u.id, u.uid, u.username, u.display_name FROM devices mine
         JOIN devices other ON other.device = mine.device AND other.user_id != mine.user_id
         JOIN users u ON u.id = other.user_id
         WHERE mine.user_id = ? AND u.deleted_at IS NULL AND u.is_guest = 0`,
      )
      .all(userId) as { id: number; uid: number | null; username: string; display_name: string }[],
    '用同一个浏览器登录过',
  );
  add(
    db
      .prepare(
        `SELECT DISTINCT u.id, u.uid, u.username, u.display_name FROM signups mine
         JOIN signups other ON other.place = mine.place AND other.user_id != mine.user_id
         JOIN users u ON u.id = other.user_id
         WHERE mine.user_id = ? AND u.deleted_at IS NULL`,
      )
      .all(userId) as { id: number; uid: number | null; username: string; display_name: string }[],
    '在同一个网络注册',
  );
  return [...found.values()].sort((a, b) => (a.uid ?? Number.MAX_SAFE_INTEGER) - (b.uid ?? Number.MAX_SAFE_INTEGER));
}
