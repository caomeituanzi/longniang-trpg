import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ALL_PERMISSIONS, parsePermissions, PERMISSION_LABEL, type AdminPermission, type Identity } from '../shared/admin';
import { frameOf } from '../shared/pets';
import type { DB } from './db';
import { HttpError, type Ctx } from './http';

export { IDENTITY_LABEL, type Identity } from '../shared/admin';

export type User = {
  id: number;
  /** 登录用的用户名。只有本人和管理员看得到；别人要知道完整的用户名才能加他好友。 */
  username: string;
  /** 公开编号：个人主页、头像的网址用它（不暴露用户名）。 */
  publicId: string;
  displayName: string;
  /** 管理员或者站长。 */
  isAdmin: boolean;
  /** 站长：最高权限，只有一个。 */
  isOwner: boolean;
  isGuest: boolean;
  identity: Identity;
  /** 管理员的权限；站长是全部；不是管理员是空的。 */
  permissions: AdminPermission[];
  /** 头像图片的地址，没有头像是 null。 */
  avatar: string | null;
  /** 戴着的头像框（V0.7.0，没戴是 null）。 */
  frame: string | null;
  /** 同意过使用规则。没同意的账号只能看规则、同意、退出登录、改密码。 */
  rulesAgreed: boolean;
};

export type UserRow = {
  id: number;
  uid: number | null;
  username: string;
  public_id: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  is_owner: number;
  admin_perms: string;
  is_guest: number;
  failed_logins: number;
  failed_login_at: number | null;
  locked_until: number | null;
  created_at: number;
  banned_at: number | null;
  ban_reason: string | null;
  /** 定了时长的封号：到这个时间自动解封。 */
  banned_until: number | null;
  rules_agreed_at: number | null;
  avatar_at: number | null;
  avatar_frame: string | null;
};

/** 查账号时要的列（给 toUser 用）。 */
export const USER_COLUMNS = 'id, username, public_id, display_name, is_admin, is_owner, admin_perms, is_guest, rules_agreed_at, avatar_at, avatar_frame';

export function identityOf(row: { is_admin: number; is_guest: number; is_owner?: number }): Identity {
  if (row.is_owner === 1) return 'owner';
  return row.is_admin === 1 ? 'admin' : row.is_guest === 1 ? 'guest' : 'user';
}

/** 这个账号有哪些管理权限：站长全部，管理员按站长下发的，其他人没有。 */
export function permissionsOf(row: { is_admin: number; is_owner?: number; admin_perms?: string }): AdminPermission[] {
  if (row.is_owner === 1) return [...ALL_PERMISSIONS];
  if (row.is_admin !== 1) return [];
  return parsePermissions(row.admin_perms);
}

/** 头像图片的地址（用公开编号，不带用户名）：换了头像以后地址跟着变，浏览器不会用旧的缓存。 */
export function avatarUrl(publicId: string, avatarAt: number | null): string | null {
  return avatarAt === null ? null : `/api/avatars/${encodeURIComponent(publicId)}?v=${avatarAt}`;
}

export function toUser(
  row: Pick<
    UserRow,
    'id' | 'username' | 'public_id' | 'display_name' | 'is_admin' | 'is_owner' | 'admin_perms' | 'is_guest' | 'rules_agreed_at' | 'avatar_at' | 'avatar_frame'
  >,
): User {
  const identity = identityOf(row);
  return {
    id: row.id,
    username: row.username,
    publicId: row.public_id,
    displayName: row.display_name,
    isAdmin: identity === 'admin' || identity === 'owner',
    isOwner: identity === 'owner',
    isGuest: identity === 'guest',
    identity,
    permissions: permissionsOf(row),
    avatar: avatarUrl(row.public_id, row.avatar_at),
    frame: frameOf(row.avatar_frame),
    rulesAgreed: row.rules_agreed_at !== null,
  };
}

// ---- 密码：用 Node 自带的 scrypt，加盐后哈希，数据库里不存明文 ----

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;
/** 用户名不存在时也算一次哈希，避免靠响应快慢猜出哪些用户名存在。 */
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
}

export const PASSWORD_RULE = { min: 8, max: 128, message: '密码至少8位' };
export const USERNAME_RULE = { min: 3, max: 20, pattern: /^[A-Za-z0-9_]+$/, message: '用户名要用3～20位字母、数字或下划线' };
export const DISPLAY_NAME_RULE = { min: 1, max: 20, message: '显示名要在1～20个字之间' };

// ---- 登录失败锁定 ----

/** 同一个地址对同一个账号连续输错几次锁定（只锁这个地址，见 LoginGuard）。 */
export const MAX_FAILED_LOGINS = 5;
/** 一个账号从没登录成功过的地方加起来、一小时内输错几次，整个账号对这些地方锁定（有人换着地址猜密码）。 */
export const MAX_FAILED_LOGINS_TOTAL = 20;
export const FAILED_LOGINS_WINDOW_MS = 60 * 60 * 1000;
export const LOCK_MINUTES = 10;

/** 网络地址换成哈希再存（只用来认出“这个账号以前在这里登录成功过”）。 */
export function loginPlace(ip: string): string {
  return crypto.createHash('sha256').update(`ai-trpg-login-place:${ip}`).digest('hex');
}

/** 记下这个账号在这里登录成功了。 */
export function rememberLoginPlace(db: DB, userId: number, ip: string, at: number) {
  db.prepare(
    'INSERT INTO login_places (user_id, place, last_at) VALUES (?, ?, ?) ON CONFLICT (user_id, place) DO UPDATE SET last_at = excluded.last_at',
  ).run(userId, loginPlace(ip), at);
}

// ---- 会话：浏览器里只存一个随机令牌，数据库里存它的哈希 ----

export const SESSION_COOKIE = 'trpg_sid';
export const SESSION_DAYS = 30;

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 这次登录的会话编号（数据库里存的是令牌的哈希）：推送连接记下它，登录失效时好断开。 */
export function sessionId(token: string | undefined): string | null {
  return token ? hashToken(token) : null;
}

/** 这个会话还有效（没退出、没过期、账号没被封）。 */
export function sessionAlive(db: DB, id: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.banned_at IS NULL')
    .get(id, Date.now());
}

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    now,
    now + SESSION_DAYS * 24 * 60 * 60 * 1000,
  );
  return token;
}

export function getSessionUser(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  // 被封禁的账号：封号时已经删掉了登录，这里再挡一次
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.public_id, u.display_name, u.is_admin, u.is_owner, u.admin_perms, u.is_guest, u.rules_agreed_at, u.avatar_at, u.avatar_frame
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.banned_at IS NULL`,
    )
    .get(hashToken(token), Date.now()) as Parameters<typeof toUser>[0] | undefined;
  return row ? toUser(row) : null;
}

export function destroySession(db: DB, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function destroyOtherSessions(db: DB, userId: number, keepToken: string | undefined) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepToken ? hashToken(keepToken) : '');
}

/** 登录了就行（还没同意使用规则也可以）：同意规则、改密码用。 */
export function requireLogin(ctx: Ctx): User {
  if (!ctx.user) throw new HttpError(401, '需要先登录');
  return ctx.user;
}

/** 登录了，并且同意过使用规则；游客也行（看大厅、观看公开对局、公告、个人主页用）。 */
export function requireViewer(ctx: Ctx): User {
  const user = requireLogin(ctx);
  if (!user.rulesAgreed) throw new HttpError(403, '请先阅读并同意使用规则');
  return user;
}

export const GUEST_FORBIDDEN = '游客只能观看。要一起玩，请找管理员要注册邀请码。';

/** 能玩的账号：登录了、同意过使用规则，不是游客。 */
export function requireUser(ctx: Ctx): User {
  const user = requireViewer(ctx);
  if (user.isGuest) throw new HttpError(403, GUEST_FORBIDDEN);
  return user;
}

/**
 * 管理员才能做的事。perm 写了就还要有这项权限（写一个数组是其中任何一项都行）；站长什么都能做。
 */
export function requireAdmin(ctx: Ctx, perm?: AdminPermission | AdminPermission[]): User {
  const user = requireUser(ctx);
  if (!user.isAdmin) throw new HttpError(403, '需要管理员权限');
  if (perm !== undefined) {
    const needed = Array.isArray(perm) ? perm : [perm];
    if (!needed.some((p) => user.permissions.includes(p))) {
      throw new HttpError(403, `需要「${needed.map((p) => PERMISSION_LABEL[p]).join('」或「')}」权限，请找站长开通`);
    }
  }
  return user;
}

/** 只有站长能做的事（任命管理员、下发权限）。 */
export function requireOwner(ctx: Ctx): User {
  const user = requireUser(ctx);
  if (!user.isOwner) throw new HttpError(403, '只有站长能做这件事');
  return user;
}

export function hasPermission(user: Pick<User, 'permissions'>, perm: AdminPermission): boolean {
  return user.permissions.includes(perm);
}

// ---- 随机码：去掉了容易看错的 0/O、1/I/L ----

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomCode(length: number, alphabet = CODE_ALPHABET): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function randomTempPassword(): string {
  return randomCode(10, PASSWORD_ALPHABET);
}
