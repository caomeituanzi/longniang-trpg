// 管理员看私信（V0.7.0，「举报和大厅聊天」权限）：使用规则里写明了管理员看得到所有内容，包括私信。
// 列出两个人之间的私信（最近有消息的在前），点开看全部；看的时候记进操作记录（在路由里）。
import type { DB } from './db';
import { HttpError } from './http';
import { escapeLike } from './util';
import type { Social } from './social';
import { GROUP_PAGE, type AdminDmMessage, type AdminDmRow, type AdminDmThread, type GroupUser } from '../shared/groups';

type PairRow = { a: number; b: number; n: number; last_at: number; last_id: number };


/** 所有两个人之间的私信；q 按两边任何一个人的显示名、公开编号、用户名找。 */
export function adminDmList(db: DB, social: Social, q: string): AdminDmRow[] {
  const words = q.trim();
  const base = `SELECT MIN(sender_id, recipient_id) AS a, MAX(sender_id, recipient_id) AS b, COUNT(*) AS n, MAX(created_at) AS last_at, MAX(id) AS last_id
    FROM direct_messages`;
  const rows = (
    words
      ? db
          .prepare(
            `${base} WHERE sender_id IN (SELECT id FROM users WHERE display_name LIKE ? ESCAPE '\\' OR public_id = ? OR username = ?)
               OR recipient_id IN (SELECT id FROM users WHERE display_name LIKE ? ESCAPE '\\' OR public_id = ? OR username = ?)
             GROUP BY a, b ORDER BY last_at DESC LIMIT 200`,
          )
          .all(`%${escapeLike(words)}%`, words, words, `%${escapeLike(words)}%`, words, words)
      : db.prepare(`${base} GROUP BY a, b ORDER BY last_at DESC LIMIT 200`).all()
  ) as PairRow[];
  const last = db.prepare('SELECT text FROM direct_messages WHERE id = ?');
  const cache = new Map<number, GroupUser | null>();
  const brief = (id: number) => {
    if (!cache.has(id)) cache.set(id, social.brief(id));
    return cache.get(id)!;
  };
  return rows.flatMap((r) => {
    const a = brief(r.a);
    const b = brief(r.b);
    if (!a || !b) return [];
    return [{ a, b, messages: r.n, lastAt: r.last_at, last: (last.get(r.last_id) as { text: string } | undefined)?.text ?? '' }];
  });
}

/** 两个人之间的私信（按公开编号或用户名），新的在后；before 往前翻。 */
export function adminDmThread(db: DB, social: Social, refA: string, refB: string, before: number): AdminDmThread & { ids: [number, number] } {
  const ua = social.findUser(refA);
  const ub = social.findUser(refB);
  if (!ua || !ub || ua.id === ub.id) throw new HttpError(404, '没有这两个人之间的私信');
  const [x, y] = ua.id < ub.id ? [ua, ub] : [ub, ua];
  const rows = db
    .prepare(
      `SELECT id, sender_id, text, created_at, read_at FROM direct_messages
       WHERE id < ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) ORDER BY id DESC LIMIT ?`,
    )
    .all(before, x.id, y.id, y.id, x.id, GROUP_PAGE + 1) as { id: number; sender_id: number; text: string; created_at: number; read_at: number | null }[];
  const messages: AdminDmMessage[] = rows
    .slice(0, GROUP_PAGE)
    .reverse()
    .map((r) => ({ id: r.id, from: r.sender_id === x.id ? 'a' : 'b', text: r.text, at: r.created_at, read: r.read_at !== null }));
  return { a: social.brief(x.id)!, b: social.brief(y.id)!, messages, hasMore: rows.length > GROUP_PAGE, ids: [x.id, y.id] };
}
