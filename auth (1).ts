import crypto from 'node:crypto';
import {
  burnPasswordCheck,
  createSession,
  destroyOtherSessions,
  destroySession,
  DISPLAY_NAME_RULE,
  hashPassword,
  FAILED_LOGINS_WINDOW_MS,
  LOCK_MINUTES,
  loginPlace,
  MAX_FAILED_LOGINS_TOTAL,
  rememberLoginPlace,
  PASSWORD_RULE,
  requireLogin,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionId,
  toUser,
  USER_COLUMNS,
  USERNAME_RULE,
  verifyPassword,
  type UserRow,
} from '../auth';
import { creditOf } from '../credit';
import { cnyRate } from '../money';
import { openStartCredit, registrationMode, registrationPaused, startCredit } from '../settings';
import { DEVICE_COOKIE, DEVICE_COOKIE_DAYS, deviceOf, newDeviceToken, placeOf, recordSignup, rememberDevice, trialCheck, WITHHELD_LABEL } from '../signup';
import { transaction, type DB } from '../db';
import { asObject, asString, HttpError, serializeCookie, viaHttps, type Ctx, type Router } from '../http';
import { rejectInvisibleName } from '../util';
import { clientIp } from '../limits';
import { remainingText } from '../safety';
import type { Deps } from '../app';

export function registerAuthRoutes(router: Router, { db, hub, secureCookies, now, limiter, loginGuard, safety }: Deps) {
  const loadUser = (id: number) => toUser(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow);
  // 登录 Cookie 带不带 Secure（只走加密连接）：设了 COOKIE_SECURE=1 一律带；没设的话，访问者是用 https 来的就带
  // （经过 Cloudflare 用域名访问的都是），在本机、局域网里用 http:// 访问的不带，免得登录不上
  const secure = (ctx: Ctx) => secureCookies || viaHttps(ctx.req);
  const sessionCookie = (ctx: Ctx, token: string) =>
    serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60, secure: secure(ctx) });
  const clearCookie = (ctx: Ctx) => serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: secure(ctx) });

  /** 认出这个浏览器：Cookie 里没有编号就发一个。返回存进数据库的哈希（防一个人注册好几个号领初始额度用，见 signup.ts）。 */
  const deviceFor = (ctx: Ctx): string => {
    const known = deviceOf(ctx.cookies[DEVICE_COOKIE]);
    if (known) return known;
    const token = newDeviceToken();
    ctx.setCookies.push(serializeCookie(DEVICE_COOKIE, token, { maxAgeSeconds: DEVICE_COOKIE_DAYS * 24 * 60 * 60, secure: secure(ctx) }));
    return deviceOf(token)!;
  };

  // 没登录时返回 user: null，而不是报错：打开网页时先问一句“我登录了吗”是正常情况
  router.get('/api/auth/me', (ctx) => {
    // 记下这个浏览器登录着哪个账号（以前登录的、一直没再输密码的账号也记得到）
    if (ctx.user && !ctx.user.isGuest) rememberDevice(db, ctx.user.id, deviceFor(ctx), now());
    // cnyRate：网页上把美元换成人民币显示用的汇率
    return { user: ctx.user, credit: ctx.user ? creditOf(db, ctx.user.id) : null, cnyRate: cnyRate(db) };
  });

  // 注册页先问一句：只能用邀请码，还是开放注册；是不是暂停注册了
  router.get('/api/auth/registration', () => ({ mode: registrationMode(db), paused: registrationPaused(db) }));

  // 注册：用户名登录用；另外分到一个 UID（空着的最小的号，只有管理员看得到）
  // 只能用邀请码的时候要填邀请码；开放注册时邀请码选填（填了照样按邀请码注册，初始额度照常）。
  // 开放注册（没填邀请码）的：同一个网络、同一个浏览器 30 天里只送一份初始额度，每天送出的份数有上限（见 signup.ts），
  // 不送的照样注册，额度从 0 开始，管理员能手动发
  router.post('/api/auth/register', async (ctx) => {
    limiter.hitAddress('register', ctx.req);
    if (registrationPaused(db)) throw new HttpError(403, REGISTRATION_PAUSED_MESSAGE);
    const body = asObject(ctx.body);
    const typed = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!typed && registrationMode(db) === 'invite') throw new HttpError(400, '请填写邀请码');
    const code = typed ? asString(typed, { max: 32, message: '邀请码无效，或者已经被用过了' }).toUpperCase() : '';
    const username = asString(body.username, USERNAME_RULE);
    const displayName = asString(body.displayName, DISPLAY_NAME_RULE);
    // 显示名别人都看得到：零宽、改文字方向这些看不见的字符不要（V0.8.0 安全审查）
    rejectInvisibleName(displayName);
    const password = asString(body.password, { ...PASSWORD_RULE, trim: false });
    if (body.agreeRules !== true) throw new HttpError(400, '请先阅读并同意使用规则');

    const at = now();
    const invite = code
      ? (db.prepare('SELECT id, used_by, expires_at FROM invites WHERE code = ?').get(code) as
          | { id: number; used_by: number | null; expires_at: number | null }
          | undefined)
      : null;
    if (code && (!invite || invite.used_by !== null)) throw new HttpError(400, '邀请码无效，或者已经被用过了');
    if (invite && invite.expires_at !== null && invite.expires_at < at) throw new HttpError(400, '邀请码已过期，请找房主重新要一个');

    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, '这个用户名已经有人用了');
    }

    const passwordHash = await hashPassword(password);
    const ip = clientIp(ctx.req);
    const place = placeOf(ip);
    const device = deviceFor(ctx);
    const { user, withheld } = transaction(db, () => {
      const trial = invite ? 0 : openStartCredit(db);
      const withheld = !invite && trial > 0 ? trialCheck(db, { place, device, at }) : null;
      const credit = invite ? startCredit(db) : withheld ? 0 : trial;
      const userId = insertAccount(db, { username, displayName, passwordHash, at, guest: false, credit });
      if (invite) {
        // 条件里再判断一次 used_by，防止两个人同时用同一个码
        const claimed = db
          .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL')
          .run(userId, at, invite.id);
        if (claimed.changes !== 1) throw new HttpError(400, '邀请码无效，或者已经被用过了');
      }
      recordSignup(db, { userId, via: invite ? 'invite' : 'open', place, device, credit, withheld, at });
      rememberDevice(db, userId, device, at);
      return { user: loadUser(userId), withheld };
    });

    rememberLoginPlace(db, user.id, ip, at);
    ctx.setCookies.unshift(sessionCookie(ctx, createSession(db, user.id)));
    // 游客在网页上点「注册」注册的（V0.7.1）：原来的游客账号就不要了，和游客退出登录一样删掉，开着的推送连接也断开
    if (ctx.user?.isGuest) {
      destroySession(db, ctx.cookies[SESSION_COOKIE]);
      db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(ctx.user.id);
      hub.closeUser(ctx.user.id);
    }
    ctx.status = 201;
    // creditWithheld：这个账号没送初始额度的原因（注册完提示一句）
    return withheld ? { user, creditWithheld: WITHHELD_LABEL[withheld] } : { user };
  });

  // 游客：不用注册，点一下就进来，只能看大厅、观看公开对局。同一个浏览器下次来还是这个游客（登录能保持 30 天）
  router.post('/api/auth/guest', async (ctx) => {
    if (ctx.user) return { user: ctx.user };
    if (registrationPaused(db)) throw new HttpError(403, REGISTRATION_PAUSED_MESSAGE);
    // 同一个网络地址一小时里最多建 10 个游客账号（防止有人刷出一大堆账号）
    limiter.hitAddress('guest', ctx.req);
    const at = now();
    // 游客没有密码可用：随便设一个谁都不知道的
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
    // 游客的用户名带短横线，正常注册的用户名不会有，不会撞上；名字是「游客」加随机数字（不用 UID：UID 只有管理员看得到）
    const userId = insertAccount(db, { username: `guest-${crypto.randomBytes(6).toString('hex')}`, displayName: guestName(), passwordHash, at, guest: true });
    ctx.setCookies.push(sessionCookie(ctx, createSession(db, userId)));
    ctx.status = 201;
    return { user: loadUser(userId) };
  });

  /** 游客的名字：「游客」加 4 位随机数字，和别人重了就再抽一个。 */
  function guestName(): string {
    for (let i = 0; i < 20; i++) {
      const name = `游客${crypto.randomInt(1000, 10000)}`;
      if (!db.prepare('SELECT 1 FROM users WHERE display_name = ?').get(name)) return name;
    }
    return `游客${crypto.randomInt(100000, 1000000)}`;
  }

  router.post('/api/auth/login', async (ctx) => {
    // 同一个网络地址试太多次（撞库）：先挡住。同一个地址对同一个账号连续输错 5 次，这个地址锁 10 分钟（别处照样能登录）；
    // 有人换着地址猜密码：从没登录成功过的地方加起来一小时内输错 20 次，这些地方都锁 10 分钟——
    // 以前登录成功过的地方不受影响，所以别人知道你的用户名也锁不住你
    const ip = clientIp(ctx.req);
    limiter.hitAddress('login', ctx.req);
    const body = asObject(ctx.body);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw new HttpError(400, '请填写用户名和密码');

    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    // 游客不能用密码登录
    if (!row || row.is_guest === 1) {
      await burnPasswordCheck(password);
      throw new HttpError(401, '用户名或密码不对');
    }

    const at = now();
    const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60000));
    const known = !!db.prepare('SELECT 1 FROM login_places WHERE user_id = ? AND place = ?').get(row.id, loginPlace(ip));
    if (!known && row.locked_until !== null && row.locked_until > at) {
      throw new HttpError(429, `这个账号最近输错密码的次数太多，暂时锁定，请${minutes(row.locked_until - at)}分钟后再试`);
    }
    const wait = loginGuard.lockedFor(row.id, ip);
    if (wait > 0) throw new HttpError(429, `密码连续输错太多次，请${minutes(wait)}分钟后再试`);

    if (!(await verifyPassword(password, row.password_hash))) {
      const lockedHere = loginGuard.failed(row.id, ip);
      let lockedAll = false;
      // 以前登录成功过的地方输错（自己手滑）不算进整个账号的次数
      if (!known) {
        const recent = row.failed_login_at !== null && at - row.failed_login_at < FAILED_LOGINS_WINDOW_MS ? row.failed_logins : 0;
        const fails = recent + 1;
        lockedAll = fails >= MAX_FAILED_LOGINS_TOTAL;
        if (lockedAll) {
          db.prepare('UPDATE users SET failed_logins = 0, failed_login_at = NULL, locked_until = ? WHERE id = ?').run(at + LOCK_MINUTES * 60000, row.id);
        } else {
          db.prepare('UPDATE users SET failed_logins = ?, failed_login_at = ? WHERE id = ?').run(fails, at, row.id);
        }
      }
      if (lockedHere || lockedAll) throw new HttpError(429, `密码连续输错太多次，请${LOCK_MINUTES}分钟后再试`);
      throw new HttpError(401, '用户名或密码不对');
    }

    db.prepare('UPDATE users SET failed_logins = 0, failed_login_at = NULL, locked_until = NULL WHERE id = ?').run(row.id);
    loginGuard.clear(row.id, ip);
    // 密码对了才告诉他被封了，免得别人靠这个试出哪些账号被封
    if (row.banned_at !== null) {
      // 定的时长到了：这就解封，接着登录（服务器每分钟也会统一解封一次）
      if (row.banned_until !== null && row.banned_until <= at) {
        safety.liftExpiredBans();
      } else {
        const lift = row.banned_until !== null ? `，${remainingText(row.banned_until - at)}后自动解封` : '';
        throw new HttpError(403, `账号已被封禁${row.ban_reason ? `（${row.ban_reason}）` : ''}${lift}。有疑问请联系管理员。`);
      }
    }
    rememberLoginPlace(db, row.id, ip, at);
    rememberDevice(db, row.id, deviceFor(ctx), at);
    // 登录的 Cookie 放在最前面（浏览器编号的 Cookie 在后面）
    ctx.setCookies.unshift(sessionCookie(ctx, createSession(db, row.id)));
    return { user: toUser(row) };
  });

  // 同意使用规则（注册时已经同意过的不用再点；以前注册的账号第一次登录后要点一次）
  router.post('/api/auth/agree-rules', (ctx) => {
    const user = requireLogin(ctx);
    db.prepare('UPDATE users SET rules_agreed_at = COALESCE(rules_agreed_at, ?) WHERE id = ?').run(now(), user.id);
    return { user: { ...user, rulesAgreed: true } };
  });

  router.post('/api/auth/logout', (ctx: Ctx) => {
    destroySession(db, ctx.cookies[SESSION_COOKIE]);
    const session = sessionId(ctx.cookies[SESSION_COOKIE]);
    if (session) hub.closeSession(session);
    // 游客退出登录：这个游客账号就不要了，直接删掉（他提交的反馈留着，只是不再记是谁交的）
    if (ctx.user?.isGuest) {
      db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(ctx.user.id);
      hub.closeUser(ctx.user.id);
    }
    ctx.setCookies.push(clearCookie(ctx));
    return { ok: true };
  });

  // 退出其他设备：除了现在这个，别的地方的登录全部失效（手机丢了、在别人电脑上登录过忘了退），开着的页面也收不到推送了
  router.post('/api/auth/logout-others', (ctx: Ctx) => {
    const user = requireLogin(ctx);
    destroyOtherSessions(db, user.id, ctx.cookies[SESSION_COOKIE]);
    hub.closeOtherSessions(user.id, sessionId(ctx.cookies[SESSION_COOKIE]));
    return { ok: true };
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireLogin(ctx);
    if (user.isGuest) throw new HttpError(403, '游客没有密码可改');
    const body = asObject(ctx.body);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = asString(body.newPassword, { ...PASSWORD_RULE, message: '新密码至少8位', trim: false });

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as Pick<UserRow, 'password_hash'>;
    if (!(await verifyPassword(current, row.password_hash))) throw new HttpError(400, '当前密码不对');

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
    // 改密码后，其他设备上的登录全部失效
    destroyOtherSessions(db, user.id, ctx.cookies[SESSION_COOKIE]);
    hub.closeOtherSessions(user.id, sessionId(ctx.cookies[SESSION_COOKIE]));
    return { ok: true };
  });
}

/**
 * 新建一个账号（注册、游客、管理员在管理页新建），返回账号编号。游客没有额度；正式账号的额度按管理页设的初始额度（没改过是 5 美元）。
 * UID：正式账号由数据库分配，用空着的最小的号（站长 0，其他人从 1 开始；删掉的账号的号空出来以后会再给新账号）；
 * 游客是随机的 8 位数，不占正式账号的号。
 * rulesAgreed：注册时已经同意了使用规则；管理员新建的账号是 false，本人第一次登录时先同意。
 * createdBy：管理员新建的账号记下是谁建的。
 */
/** 暂停注册时（应急开关）注册、新开游客看到的话。 */
export const REGISTRATION_PAUSED_MESSAGE = '现在暂停了新用户注册（游客也进不来），请过一段时间再来';

/** credit：一开始的 AI 额度（美元），不写是「新账号的初始额度」；游客没有额度。 */
export function insertAccount(
  db: DB,
  a: {
    username: string;
    displayName: string;
    passwordHash: string;
    at: number;
    guest: boolean;
    rulesAgreed?: boolean;
    createdBy?: number | null;
    credit?: number;
  },
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, rules_agreed_at, created_at, is_guest, ai_credit_usd, uid, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.username,
      a.displayName,
      a.passwordHash,
      a.rulesAgreed === false ? null : a.at,
      a.at,
      a.guest ? 1 : 0,
      a.guest ? 0 : (a.credit ?? startCredit(db)),
      a.guest ? randomGuestUid(db) : null,
      a.createdBy ?? null,
    );
  return Number(lastInsertRowid);
}

/** 游客的 UID：随机的 8 位数（正式账号的号从 0 开始，用空着的最小的号，到不了这么大）。 */
export const GUEST_UID_MIN = 10_000_000;

export function randomGuestUid(db: DB): number {
  for (;;) {
    const uid = crypto.randomInt(GUEST_UID_MIN, 100_000_000);
    if (!db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid)) return uid;
  }
}
