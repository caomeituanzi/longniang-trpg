import { audit } from './audit';
import type { User } from './auth';
import { transaction, type DB } from './db';
import { HttpError } from './http';
import type { Social } from './social';
import { GEAR_THING_PREFIX, giveThing, ownedCount, thingLabel, thingOf } from './shop-listings';
import { BUNDLE_MAX, GRANT_ACCOUNTS_MAX, type ItemGrantResult } from '../shared/shop-admin';

// 管理页「物品」（V0.7.1）：给一个账号、一批账号（用户名、UID 或公开编号）或者所有正式账号发东西。
// 和发龙晶的规矩一样：管理员不能给自己发（站长可以）；管理员、站长的账号只有站长能发；游客、删掉的账号跳过。
// 「所有正式账号」不含封禁中的（和公告里一起发龙晶一样）；点名发的封禁中的账号照样发。
// 一种最多攒几个的（地下城道具、秘籍、宝箱）发到满为止，已经满了的跳过；一个就够的（装备、头像框、骰子、装扮、称号）有了的跳过。
// 拿到的人每人一条通知（item_grant）；整次发放记一条操作记录。

type Target = { id: number; username: string; display_name: string; is_guest: number; is_admin: number; is_owner: number; deleted_at: number | null };
const TARGET_COLUMNS = 'id, username, display_name, is_guest, is_admin, is_owner, deleted_at';

/** 头像框、骰子、宠物装扮、称号在「装扮」里看，别的在「我的背包」里。 */
const WEAR_SECTIONS = new Set(['frame', 'dice', 'outfit', 'title']);

/**
 * 公开编号（p-十六位）、用户名、UID（数字，前面可以带「UID」）都认。
 * 用户名也可以是「123」「UID12」这样的：同一个写法既是一个人的用户名、又是另一个人的 UID 时分不清，不发（返回 'ambiguous'），
 * 免得发错人（V0.7.1 审查）。
 */
function findAccount(db: DB, ref: string): Target | 'ambiguous' | null {
  const by = (where: string, v: string | number) => (db.prepare(`SELECT ${TARGET_COLUMNS} FROM users WHERE ${where}`).get(v) as Target | undefined) ?? null;
  if (/^p-[0-9a-f]{16}$/.test(ref)) return by('public_id = ?', ref);
  const byName = by('username = ?', ref);
  const uid = /^(?:uid[:：]?)?(\d{1,12})$/i.exec(ref)?.[1];
  const byUid = uid ? by('uid = ?', Number(uid)) : null;
  if (byName && byUid && byName.id !== byUid.id) return 'ambiguous';
  return byName ?? byUid;
}

/**
 * 发物品：{ item: 编号, count?: 每人几个（一种攒好几个的才能多于 1）, accounts?: [用户名、UID 或公开编号], all?: true（所有正式账号） }。
 * 编号见 shared/shop-admin.ts 的 AdminItemOptions。返回发了几个账号、只发了一部分的、没发的和原因。
 */
export function grantItems(deps: { db: DB; social: Social; now: () => number }, admin: User, body: Record<string, unknown>): ItemGrantResult {
  const { db, social, now } = deps;
  const key = typeof body.item === 'string' ? body.item.trim() : '';
  const thing = key ? thingOf(db, key, { legendary: admin.isOwner }) : null;
  if (!thing) {
    if (key.startsWith(GEAR_THING_PREFIX) && thingOf(db, key, { legendary: true })) throw new HttpError(403, '只有站长能发传奇装备');
    throw new HttpError(400, '选一下发什么');
  }
  let count = 1;
  if (thing.type === 'stack') {
    const n = body.count === undefined ? 1 : body.count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > BUNDLE_MAX) throw new HttpError(400, `每人发 1～${BUNDLE_MAX} 个`);
    count = n;
  } else if (body.count !== undefined && body.count !== 1) {
    throw new HttpError(400, `${thingLabel(thing)}每人只能发一个`);
  }

  const all = body.all === true;
  let targets: { ref: string; row: Target | 'ambiguous' | null }[];
  if (all) {
    targets = (db.prepare(`SELECT ${TARGET_COLUMNS} FROM users WHERE is_guest = 0 AND deleted_at IS NULL AND banned_at IS NULL ORDER BY uid`).all() as Target[]).map((row) => ({
      ref: row.username,
      row,
    }));
  } else {
    const refs = Array.isArray(body.accounts)
      ? [...new Set(body.accounts.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
      : [];
    if (!refs.length) throw new HttpError(400, '填一下发给谁');
    if (refs.length > GRANT_ACCOUNTS_MAX) throw new HttpError(400, `一次最多发给 ${GRANT_ACCOUNTS_MAX} 个账号`);
    targets = refs.map((ref) => ({ ref, row: findAccount(db, ref) }));
  }

  const label = (r: Target) => `${r.display_name}（${r.username}）`;
  const skipped: ItemGrantResult['skipped'] = [];
  const capped: ItemGrantResult['capped'] = [];
  const plan: { row: Target; n: number }[] = [];
  const seen = new Set<number>();
  for (const { ref, row } of targets) {
    if (row === 'ambiguous') {
      skipped.push({ name: ref, reason: '分不清是用户名还是 UID（两个账号都对得上），换成公开编号再发' });
      continue;
    }
    if (!row) {
      skipped.push({ name: ref, reason: '没有这个账号' });
      continue;
    }
    // 同一个账号填了两遍（比如一次用户名、一次 UID）：只发一份
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.deleted_at !== null) {
      skipped.push({ name: ref, reason: '账号已删除' });
      continue;
    }
    const reason =
      row.is_guest === 1
        ? '游客'
        : row.id === admin.id
          ? admin.isOwner
            ? null
            : '不能发给自己'
          : (row.is_admin === 1 || row.is_owner === 1) && !admin.isOwner
            ? '只有站长能发给管理员'
            : null;
    if (reason) {
      skipped.push({ name: label(row), reason });
      continue;
    }
    const have = ownedCount(db, row.id, thing);
    let n = count;
    if (thing.type !== 'stack') {
      if (have) {
        skipped.push({ name: label(row), reason: '已经有了' });
        continue;
      }
    } else if (thing.max !== null) {
      n = Math.min(count, thing.max - have);
      if (n <= 0) {
        skipped.push({ name: label(row), reason: `最多攒 ${thing.max} 个` });
        continue;
      }
      if (n < count) capped.push({ name: label(row), count: n });
    }
    plan.push({ row, n });
  }

  const at = now();
  transaction(db, () => {
    for (const p of plan) giveThing(db, p.row.id, thing, p.n, 'grant', at);
  });
  const what = thingLabel(thing);
  const where = thing.type !== 'gear' && WEAR_SECTIONS.has(thing.section) ? 'wardrobe' : 'bag';
  for (const p of plan) social.notify(p.row.id, 'item_grant', { item: what, count: p.n, where });
  const who = all
    ? `所有正式账号，${plan.length} 个拿到了`
    : plan.length
      ? `${plan
          .slice(0, 10)
          .map((p) => label(p.row))
          .join('、')}${plan.length > 10 ? ` 等 ${plan.length} 个账号` : ''}`
      : '没有人拿到';
  audit(db, admin.id, '发物品', `${what}${count > 1 ? ` × ${count}` : ''} → ${who}${skipped.length ? `；跳过 ${skipped.length} 个` : ''}`, at);
  return { item: what, count, granted: plan.length, recipients: plan.map((p) => label(p.row)), capped, skipped };
}
