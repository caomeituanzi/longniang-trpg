import type { Deps } from '../../app';
import { who } from '../../audit';
import {
  DISPLAY_NAME_RULE,
  hashPassword,
  identityOf,
  permissionsOf,
  randomTempPassword,
  requireAdmin,
  requireOwner,
  USERNAME_RULE,
} from '../../auth';
import { creditOf } from '../../credit';
import { transaction, type DB } from '../../db';
import { deleteOfflineGuests } from '../../guests';
import { asId, asObject, asOneOf, asString, HttpError, type Router } from '../../http';
import { cnyRate, roundUsd } from '../../money';
import { startCredit } from '../../settings';
import { relatedAccounts, WITHHELD_LABEL, type Withheld } from '../../signup';
import { toBrief } from '../../social';
import { rejectInvisibleName } from '../../util';
import { ALL_PERMISSIONS, BAN_MAX_HOURS, DEFAULT_PERMISSIONS, IDENTITY_LABEL, PERMISSION_LABEL, type AdminPermission } from '../../../shared/admin';
import { insertAccount } from '../auth';
import { adminLog, readAmount } from './common';
import { userOps } from './user-ops';
import { toViolation, VIOLATION_SELECT, type ViolationRow } from './violations';

// 账号：列表、新建、详情、备注、删除、重置密码、发放额度、不限额度、所有人的额度一键清零（只有站长）、封号和解封、任命管理员（只有站长能做）、批量处理。
// 对账号做的操作（删除、发额度、封号……）在 user-ops.ts，单个处理和批量处理共用。

type UserRow = {
  id: number;
  /** 删掉的账号没有 UID（号空出来给新账号了）。 */
  uid: number | null;
  username: string;
  public_id: string;
  display_name: string;
  is_admin: number;
  is_owner: number;
  admin_perms: string;
  is_guest: number;
  admin_note: string;
  locked_until: number | null;
  created_at: number;
  last_seen_at: number | null;
  banned_at: number | null;
  ban_reason: string | null;
  banned_until: number | null;
  rules_agreed_at: number | null;
  ai_unlimited: number;
  /** 怎么注册的（V0.4.5 以后注册的才有）：invite 用邀请码，open 开放注册。 */
  signup_via: 'invite' | 'open' | null;
  /** 开放注册时没送初始额度的原因。 */
  signup_withheld: Withheld | null;
  avatar_at: number | null;
  room_count: number;
  /** 管理员在管理页新建的账号：是谁建的（显示名）。 */
  created_by_name: string | null;
};

const USER_SELECT = `
  SELECT u.id, u.uid, u.username, u.public_id, u.display_name, u.is_admin, u.is_owner, u.admin_perms, u.is_guest, u.admin_note, u.locked_until,
         u.created_at, u.last_seen_at, u.banned_at, u.ban_reason, u.banned_until, u.rules_agreed_at, u.ai_unlimited, u.avatar_at,
         (SELECT COUNT(*) FROM players p WHERE p.user_id = u.id) AS room_count,
         (SELECT c.display_name FROM users c WHERE c.id = u.created_by) AS created_by_name,
         (SELECT s.via FROM signups s WHERE s.user_id = u.id) AS signup_via,
         (SELECT s.withheld FROM signups s WHERE s.user_id = u.id) AS signup_withheld
  FROM users u`;

/** ipLocked：有哪个网络地址因为连续输错密码，正被锁着不能登录这个账号。 */
function toAdminUser(db: DB, r: UserRow, now: number, online: boolean, ipLocked = false) {
  const identity = identityOf(r);
  return {
    id: r.id,
    /** UID：正式账号用空着的最小的号，游客是随机的 8 位数；只有管理员看得到。删掉的账号没有。 */
    uid: r.uid,
    username: r.username,
    /** 公开编号：个人主页的网址用它。 */
    publicId: r.public_id,
    displayName: r.display_name,
    avatar: toBrief(r).avatar,
    identity,
    identityLabel: IDENTITY_LABEL[identity],
    isAdmin: r.is_admin === 1,
    isOwner: r.is_owner === 1,
    isGuest: r.is_guest === 1,
    permissions: permissionsOf(r),
    note: r.admin_note,
    createdAt: r.created_at,
    createdBy: r.created_by_name,
    lastSeenAt: r.last_seen_at,
    online,
    locked: ipLocked || (r.locked_until !== null && r.locked_until > now),
    /** until：到这个时间自动解封；null 是一直封着，等管理员解封。 */
    banned: r.banned_at !== null ? { at: r.banned_at, reason: r.ban_reason ?? '', until: r.banned_until } : null,
    rulesAgreed: r.rules_agreed_at !== null,
    /** 怎么注册的；withheld 是开放注册时没送初始额度的原因（送了是 null）。管理员新建的、V0.4.5 以前注册的是 null。 */
    signup: r.signup_via ? { via: r.signup_via, withheld: r.signup_withheld ? WITHHELD_LABEL[r.signup_withheld] : null } : null,
    credit: creditOf(db, r.id),
    rooms: r.room_count,
  };
}

/** 账号列表。登记在「注册和额度的设置」（registration.ts）前面，其他账号的接口在后面（registerUserRoutes）：照拆开以前的顺序。 */
export function registerUserListRoutes(router: Router, deps: Deps) {
  const { db, hub, safety, social, now, loginGuard } = deps;

  // 账号列表（备注、额度、封号原因都在里面）：有「账号管理」「发放额度」「封号」其中一项权限才能看
  router.get('/api/admin/users', (ctx) => {
    const admin = requireAdmin(ctx, ['users', 'credit', 'ban']);
    // 定的时长到了的先解封，列表里就不再写着封禁
    safety.liftExpiredBans();
    const at = now();
    const rows = db.prepare(`${USER_SELECT} WHERE u.deleted_at IS NULL ORDER BY u.uid`).all() as UserRow[];
    const online = hub.connectedUserIds();
    return {
      users: rows.map((r) => toAdminUser(db, r, at, online.has(r.id), loginGuard.anyLocked(r.id))),
      badges: social.badges(admin.id),
      /** 新的正式账号一开始的额度（美元）。 */
      startCredit: startCredit(db),
      /** 汇率：1 美元换多少人民币。 */
      cnyRate: cnyRate(db),
    };
  });
}

export function registerUserRoutes(router: Router, deps: Deps) {
  const { db, hub, engine, safety, social, pets, now, loginGuard } = deps;
  const log = adminLog(deps);
  const { target, deleteAccount, grantCredit, banUser, unbanUser } = userOps(deps);

  // 新建正式账号（有「账号管理」权限）：{ username, displayName }。密码是随机的临时密码，只在这次回复里给一次；
  // 本人第一次登录时先同意使用规则。UID 用空着的最小的号，额度和注册的账号一样（管理页设的初始额度）
  router.post('/api/admin/users', async (ctx) => {
    const admin = requireAdmin(ctx, 'users');
    const body = asObject(ctx.body);
    const username = asString(body.username, USERNAME_RULE);
    const displayName = asString(body.displayName, DISPLAY_NAME_RULE);
    rejectInvisibleName(displayName);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, '这个用户名已经有人用了');
    const tempPassword = randomTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const at = now();
    const userId = transaction(db, () => {
      // 算密码哈希的时候可能有人注册了同一个用户名：写进去之前再查一次
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, '这个用户名已经有人用了');
      return insertAccount(db, { username, displayName, passwordHash, at, guest: false, rulesAgreed: false, createdBy: admin.id });
    });
    const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow;
    log(admin, '新建账号', `${who(db, userId)}，UID ${row.uid}`);
    ctx.status = 201;
    return { user: toAdminUser(db, row, at, false), tempPassword };
  });

  // 清理游客：把现在不在线的游客账号都删掉（每天凌晨 4 点也会自动做一次）
  router.post('/api/admin/guests/cleanup', (ctx) => {
    const admin = requireAdmin(ctx, 'users');
    const removed = deleteOfflineGuests(db, hub.connectedUserIds(), now(), admin.id);
    return { removed };
  });

  /** 一个账号的详细情况：额度的发放记录、AI 花费、违规记录、在哪些对局里。 */
  router.get('/api/admin/users/:id', (ctx) => {
    requireAdmin(ctx, ['users', 'credit', 'ban']);
    const userId = asId(ctx.params.id);
    safety.liftExpiredBans();
    const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow | undefined;
    if (!row) throw new HttpError(404, '没有这个用户');
    const grants = (
      db
        .prepare(
          `SELECT g.amount_usd, g.note, g.created_at, u.display_name AS by_name FROM credit_grants g
           LEFT JOIN users u ON u.id = g.granted_by WHERE g.user_id = ? ORDER BY g.id DESC LIMIT 100`,
        )
        .all(userId) as { amount_usd: number; note: string; created_at: number; by_name: string | null }[]
    ).map((g) => ({ amount: g.amount_usd, note: g.note, at: g.created_at, by: g.by_name }));
    const byPurpose = (
      db
        .prepare(
          `SELECT c.purpose, COUNT(*) AS calls, SUM(s.cost_usd) AS cost FROM ai_call_shares s JOIN ai_calls c ON c.id = s.call_id
           WHERE s.user_id = ? GROUP BY c.purpose ORDER BY cost DESC`,
        )
        .all(userId) as { purpose: string; calls: number; cost: number }[]
    ).map((p) => ({ purpose: p.purpose, calls: p.calls, cost: roundUsd(p.cost) }));
    const recent = (
      db
        .prepare(
          `SELECT c.created_at, c.purpose, c.model, s.cost_usd, c.cost_usd AS full_cost, c.stop_reason, c.error, r.id AS room_id, r.name AS room_name
           FROM ai_call_shares s JOIN ai_calls c ON c.id = s.call_id LEFT JOIN rooms r ON r.id = c.room_id
           WHERE s.user_id = ? ORDER BY c.id DESC LIMIT 50`,
        )
        .all(userId) as {
        created_at: number;
        purpose: string;
        model: string;
        cost_usd: number;
        full_cost: number;
        stop_reason: string | null;
        error: string | null;
        room_id: number | null;
        room_name: string | null;
      }[]
    ).map((c) => ({
      at: c.created_at,
      purpose: c.purpose,
      model: c.model,
      cost: roundUsd(c.cost_usd),
      shared: c.full_cost - c.cost_usd > 1e-9,
      stopReason: c.stop_reason,
      error: c.error,
      room: c.room_id !== null ? { id: c.room_id, name: c.room_name ?? '' } : null,
    }));
    const violations = (db.prepare(`${VIOLATION_SELECT} WHERE v.user_id = ? ORDER BY v.id DESC LIMIT 50`).all(userId) as ViolationRow[]).map(toViolation);
    const memberOf = (
      db
        .prepare('SELECT r.id, r.name, r.status, p.role FROM players p JOIN rooms r ON r.id = p.room_id WHERE p.user_id = ? ORDER BY r.id DESC')
        .all(userId) as { id: number; name: string; status: string; role: string }[]
    ).map((r) => ({ id: r.id, name: r.name, status: r.status, role: r.role }));
    return {
      user: toAdminUser(db, row, now(), hub.isConnected(row.id), loginGuard.anyLocked(row.id)),
      /** 可能是同一个人的账号：用同一个浏览器登录过的、在同一个网络注册的。 */
      related: relatedAccounts(db, userId),
      grants,
      usage: { byPurpose, recent },
      violations,
      rooms: memberOf,
      /** 宠物和龙晶（V0.5.0）。 */
      pets: row.is_guest === 1 ? null : pets.adminSummary(userId),
    };
  });

  // 后台备注（只有管理员看得到）：{ note }
  router.put('/api/admin/users/:id/note', (ctx) => {
    const admin = requireAdmin(ctx, 'users');
    const userId = asId(ctx.params.id);
    target(admin, userId, '写备注', true);
    const note = asObject(ctx.body).note;
    if (typeof note !== 'string' || [...note.trim()].length > 500) throw new HttpError(400, '备注最多500个字');
    db.prepare('UPDATE users SET admin_note = ? WHERE id = ?').run(note.trim(), userId);
    log(admin, '改备注', `${who(db, userId)}：${[...note.trim()].slice(0, 60).join('')}`);
    return { note: note.trim() };
  });

  // 删除账号：游客（有「账号管理」权限就能删）；正式账号只有站长能删
  router.delete('/api/admin/users/:id', (ctx) => {
    const admin = requireAdmin(ctx, ['users']);
    deleteAccount(admin, asId(ctx.params.id));
    return { ok: true };
  });

  router.post('/api/admin/users/:id/reset-password', async (ctx) => {
    const admin = requireAdmin(ctx, 'users');
    const userId = asId(ctx.params.id);
    const row = target(admin, userId, '重置密码');
    if (row.is_guest === 1) throw new HttpError(400, '游客没有密码');
    const tempPassword = randomTempPassword();
    const hash = await hashPassword(tempPassword);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, failed_login_at = NULL, locked_until = NULL WHERE id = ?').run(hash, userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
    loginGuard.clear(userId);
    hub.closeUser(userId);
    log(admin, '重置密码', who(db, userId));
    return { tempPassword };
  });

  const readNote = (value: unknown) => (value === undefined || value === '' ? '' : asString(value, { max: 40, message: '备注最多40个字' }));

  // 发放额度：{ amount（负数是收回）, currency: 'CNY' | 'USD'（不写是美元）, note: 备注 }。额度是累计的，不会按月清零
  router.post('/api/admin/users/:id/credit', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const userId = asId(ctx.params.id);
    // 管理员不能给自己发额度（站长可以，站长本来就不限额度）
    target(admin, userId, '改额度', admin.isOwner);
    const body = asObject(ctx.body);
    grantCredit(admin, userId, readAmount(db, body), readNote(body.note));
    // 他在的各局刷新额度；收回额度以后用完了的，回合不再等他
    engine.creditChanged([userId], true);
    return { credit: creditOf(db, userId) };
  });

  // 不限额度：{ unlimited: true/false }
  router.put('/api/admin/users/:id/unlimited', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const userId = asId(ctx.params.id);
    target(admin, userId, '改额度', admin.isOwner);
    const unlimited = asObject(ctx.body).unlimited;
    if (typeof unlimited !== 'boolean') throw new HttpError(400, '请求格式不对');
    db.prepare('UPDATE users SET ai_unlimited = ? WHERE id = ?').run(unlimited ? 1 : 0, userId);
    log(admin, unlimited ? '设成不限额度' : '取消不限额度', who(db, userId));
    engine.creditChanged([userId], true);
    return { credit: creditOf(db, userId) };
  });

  // 一键清零（V1.0.1，只有站长）：所有正式账号（游客、删掉了的不算）的可用额度变成 0：发放的总额改成已经用掉的，
  // 少掉的那部分记成一笔收回（备注「一键清零」）。不限额度的（站长、设成不限的人）不动；本来就用完了的不动
  router.post('/api/admin/credit/zero-all', (ctx) => {
    const owner = requireOwner(ctx);
    const rows = db
      .prepare(
        `SELECT u.id, u.ai_credit_usd, u.ai_unlimited, u.is_owner,
           (SELECT COALESCE(SUM(s.cost_usd), 0) FROM ai_call_shares s WHERE s.user_id = u.id) AS spent
         FROM users u WHERE u.is_guest = 0 AND u.deleted_at IS NULL ORDER BY u.id`,
      )
      .all() as { id: number; ai_credit_usd: number; ai_unlimited: number; is_owner: number; spent: number }[];
    const zeroed: number[] = [];
    let taken = 0;
    let unlimited = 0;
    const at = now();
    transaction(db, () => {
      const update = db.prepare('UPDATE users SET ai_credit_usd = ? WHERE id = ?');
      const grant = db.prepare("INSERT INTO credit_grants (user_id, amount_usd, granted_by, note, created_at) VALUES (?, ?, ?, '一键清零', ?)");
      for (const u of rows) {
        if (u.is_owner === 1 || u.ai_unlimited === 1) {
          unlimited++;
          continue;
        }
        const left = u.ai_credit_usd - u.spent;
        // 差一点点（小数尾巴）的也算用完了
        if (left <= 1e-9) continue;
        update.run(Math.max(0, u.spent), u.id);
        grant.run(u.id, -left, owner.id, at);
        zeroed.push(u.id);
        taken += left;
      }
    });
    log(owner, '所有正式用户的可用额度清零', `${zeroed.length} 个账号，一共收回 ${roundUsd(taken).toFixed(2)} 美元${unlimited ? `；不限额度的 ${unlimited} 个没动` : ''}`);
    // 他们在的各局刷新额度；用完了的，回合不再等他们
    if (zeroed.length) engine.creditChanged(zeroed, true);
    return { zeroed: zeroed.length, takenUsd: roundUsd(taken), unlimited };
  });

  /** 封多久（小时）：不写或者 null 是永久；要填的话是 1 小时到一年之间的整数。 */
  function readBanHours(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > BAN_MAX_HOURS) {
      throw new HttpError(400, '封禁时长要在 1 小时到 365 天之间，再长就选永久');
    }
    return value;
  }

  // 手动封号：{ reason?: 原因（V0.6.0 起可以不写）, hours?: 封多久（小时，不写是永久） }。封号以后他的登录全部失效，在等的行动撤回；
  // 定了时长的到时间自动解封
  router.post('/api/admin/users/:id/ban', (ctx) => {
    const admin = requireAdmin(ctx, 'ban');
    const body = asObject(ctx.body);
    const reason = asString(body.reason ?? '', { min: 0, max: 100, message: '封号的原因最多100个字' });
    banUser(admin, asId(ctx.params.id), reason, readBanHours(body.hours));
    return { ok: true };
  });

  router.post('/api/admin/users/:id/unban', (ctx) => {
    const admin = requireAdmin(ctx, 'ban');
    unbanUser(admin, asId(ctx.params.id));
    return { ok: true };
  });

  // ==================== 管理员和权限（只有站长能做） ====================

  // 任命、撤销管理员，下发权限：{ role: 'user' | 'admin', permissions?: [权限] }（任命时不写权限就给默认的几项）
  router.put('/api/admin/users/:id/role', (ctx) => {
    const owner = requireOwner(ctx);
    const userId = asId(ctx.params.id);
    const row = db.prepare('SELECT id, is_admin, is_owner, is_guest, banned_at, admin_perms FROM users WHERE id = ?').get(userId) as
      | { id: number; is_admin: number; is_owner: number; is_guest: number; banned_at: number | null; admin_perms: string }
      | undefined;
    if (!row) throw new HttpError(404, '没有这个用户');
    if (row.is_owner === 1) throw new HttpError(409, '站长的身份不能在网页上改（要换站长，见 README「重新指定站长」）');
    if (row.is_guest === 1) throw new HttpError(400, '游客不能当管理员，请让他注册一个正式账号');
    if (row.banned_at !== null) throw new HttpError(409, '这个账号被封禁了，先解封');
    const body = asObject(ctx.body);
    const role = asOneOf(body.role, ['user', 'admin'] as const, '身份只能是普通用户或者管理员');
    let permissions: AdminPermission[] = [];
    if (role === 'admin') {
      if (body.permissions === undefined) permissions = row.is_admin === 1 ? permissionsOf({ ...row, is_owner: 0 }) : [...DEFAULT_PERMISSIONS];
      else if (Array.isArray(body.permissions) && body.permissions.every((p) => ALL_PERMISSIONS.includes(p as AdminPermission))) {
        permissions = ALL_PERMISSIONS.filter((p) => (body.permissions as string[]).includes(p));
      } else throw new HttpError(400, '权限不对');
    }
    db.prepare('UPDATE users SET is_admin = ?, admin_perms = ? WHERE id = ?').run(role === 'admin' ? 1 : 0, JSON.stringify(permissions), userId);
    // 撤销管理员：变回普通用户，不限额度也取消（升级前的管理员升级时被设成了不限额度）
    if (role === 'user' && row.is_admin === 1) db.prepare('UPDATE users SET ai_unlimited = 0 WHERE id = ?').run(userId);
    if (role === 'admin') {
      log(owner, row.is_admin === 1 ? '改管理员权限' : '任命管理员', `${who(db, userId)}：${permissions.map((p) => PERMISSION_LABEL[p]).join('、') || '没有权限'}`);
    } else if (row.is_admin === 1) {
      log(owner, '撤销管理员', who(db, userId));
    }
    // 他开着的页面刷新一下（顶栏、管理页的入口跟着变）；观看中的对局重新连一次，按新的权限判断还能不能看
    hub.toUser(userId, 'me-changed', {});
    hub.closeWatches({ userId });
    social.pushBadges(userId);
    if (role === 'user' && row.is_admin === 1) engine.creditChanged([userId], true);
    const updated = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow;
    return { user: toAdminUser(db, updated, now(), hub.isConnected(userId), loginGuard.anyLocked(userId)) };
  });

  // ==================== 批量处理 ====================

  /**
   * 批量处理：{ ids: [账号编号], op, … }。
   * op：credit（{ amount, currency, note } 发放额度）、unlimited（{ unlimited }）、ban（{ reason, hours? } 封多久，不写是永久）、unban、
   * delete-guests（删掉选中的游客账号）、delete（站长删账号）。
   * 每个账号单独处理，做不了的（比如权限不够、已经封了）跳过，结果里说明原因。
   */
  router.post('/api/admin/users/batch', (ctx) => {
    const admin = requireAdmin(ctx);
    const body = asObject(ctx.body);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is number => Number.isInteger(x)))].slice(0, 500) : [];
    if (!ids.length) throw new HttpError(400, '先勾选要处理的账号');
    const op = asOneOf(body.op, ['credit', 'unlimited', 'ban', 'unban', 'delete-guests', 'delete'] as const, '不认识的批量操作');
    const perm: Record<typeof op, AdminPermission> = { credit: 'credit', unlimited: 'credit', ban: 'ban', unban: 'ban', 'delete-guests': 'users', delete: 'users' };
    requireAdmin(ctx, perm[op]);
    if (op === 'delete' && !admin.isOwner) throw new HttpError(403, '只有站长能删除正式账号');
    const grant = op === 'credit' ? readAmount(db, body) : null;
    const note = op === 'credit' ? readNote(body.note) : '';
    const reason = op === 'ban' ? asString(body.reason ?? '', { min: 0, max: 100, message: '封号的原因最多100个字' }) : '';
    const banHours = op === 'ban' ? readBanHours(body.hours) : null;
    const unlimited = op === 'unlimited' ? body.unlimited === true : false;

    const done: number[] = [];
    const skipped: { id: number; reason: string }[] = [];
    const creditChanged: number[] = [];
    for (const id of ids) {
      try {
        if (op === 'credit') {
          target(admin, id, '改额度', admin.isOwner);
          grantCredit(admin, id, grant!, note);
          creditChanged.push(id);
        } else if (op === 'unlimited') {
          target(admin, id, '改额度', admin.isOwner);
          db.prepare('UPDATE users SET ai_unlimited = ? WHERE id = ?').run(unlimited ? 1 : 0, id);
          log(admin, unlimited ? '设成不限额度' : '取消不限额度', who(db, id));
          creditChanged.push(id);
        } else if (op === 'ban') {
          banUser(admin, id, reason, banHours);
        } else if (op === 'unban') {
          unbanUser(admin, id);
        } else if (op === 'delete') {
          deleteAccount(admin, id);
        } else {
          const row = target(admin, id, '删除');
          if (row.is_guest !== 1) throw new HttpError(400, '只能删除游客账号');
          deleteAccount(admin, id);
        }
        done.push(id);
      } catch (err) {
        skipped.push({ id, reason: err instanceof HttpError ? err.message : '出错了' });
      }
    }
    if (creditChanged.length) engine.creditChanged(creditChanged, true);
    return { done, skipped };
  });
}
