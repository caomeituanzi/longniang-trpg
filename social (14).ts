import { avatarUrl, DISPLAY_NAME_RULE, hasPermission, requireAdmin, requireLogin, requireUser, requireViewer, type User } from '../auth';
import { transaction } from '../db';
import { characterIdOf, canSee, loadLogRow } from '../game/log';
import { asId, asObject, asOneOf, asString, HttpError, STREAMING, type Router } from '../http';
import { audit, who } from '../audit';
import { creditOf } from '../credit';
import { redeemCreditCode } from '../credit-codes';
import { audienceOf, BRIEF_COLUMNS, safeJson, Social, toBrief, type UserBrief } from '../social';
import { getSetting, setSetting } from '../settings';
import { titleNameOf, wornTitle } from '../pets';
import { APP_VERSION } from '../version';
import { rejectInvisibleName } from '../util';
import type { PublicPet } from '../../shared/pets';
import { ACHIEVEMENTS } from '../../shared/achievements';
import { LOBBY_RECALL_RECENT_MS, LOBBY_REPEAT_WINDOW_MS, LOBBY_SLOW_DEFAULT, LOBBY_SLOW_MAX } from '../../shared/admin';
import type { Deps } from '../app';

// 个人资料、头像、个人主页、好友、私聊、屏蔽、通知、公告、大厅聊天、举报和反馈。

const BIO_MAX = 200;
const DM_MAX = 1000;
const LOBBY_CHAT_MAX = 300;
const LOBBY_SLOW_SETTING = 'lobby_slow_seconds';
const REPORT_MAX = 1000;
const PAGE = 50;
const VISIBLE_ACHIEVEMENTS = new Set<string>(ACHIEVEMENTS.map((a) => a.key));
/** 头像图片最大多少字节（网页上传前会缩成 256×256，一般只有几十 KB）。 */
export const AVATAR_MAX_BYTES = 200 * 1024;

/** 看文件开头的几个字节认出图片格式；不是 PNG、JPEG、WebP 的不收（SVG 之类能带脚本的格式一律不收）。 */
export function sniffImage(data: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 报 bug 时附上的信息：网页收集的（当前页面、屏幕大小、网页的版本、最近的报错，都截短），加上服务器知道的浏览器和版本号。
 * 不收别的东西（不收登录信息、不收页面内容）。
 */
export function bugContext(raw: unknown, userAgent: string | undefined): Record<string, unknown> {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? [...v].slice(0, max).join('') : '');
  const errors = Array.isArray(o.errors) ? o.errors.slice(-5).map((e) => text(e, 500)).filter(Boolean) : [];
  return {
    page: text(o.page, 200),
    screen: text(o.screen, 20),
    webVersion: text(o.version, 20),
    errors,
    browser: text(userAgent, 300),
    serverVersion: APP_VERSION,
  };
}

type DmRow = { id: number; sender_id: number; recipient_id: number; text: string; created_at: number; read_at: number | null };

export function registerSocialRoutes(router: Router, deps: Deps) {
  const { db, hub, social, works, pets, petPlay, collection, reviewer, limiter, now, groups, cards, safety } = deps;

  /** 按公开编号（或用户名）找一个能打交道的人：不能是自己、游客、被封禁的。 */
  function otherUser(me: User, ref: string | undefined, what: string) {
    const target = ref ? social.findUser(ref) : undefined;
    if (!target || target.banned_at !== null) throw new HttpError(404, '没有这个用户');
    if (target.id === me.id) throw new HttpError(400, `不能${what}自己`);
    if (target.is_guest === 1) throw new HttpError(400, `游客不能${what}`);
    return target;
  }

  // ==================== 自己的资料 ====================

  router.get('/api/me/badges', (ctx) => {
    const user = requireLogin(ctx);
    return social.badges(user.id);
  });

  // 改显示名、一句话介绍、个人主页上展示不展示自己的对局：{ displayName?, bio?, showRooms? }
  router.put('/api/me/profile', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    if (body.displayName !== undefined) {
      const name = asString(body.displayName, DISPLAY_NAME_RULE);
      // 改了的显示名不能有看不见的字符（V0.8.0 安全审查）；没改的（以前存的）照旧
      if (name !== user.displayName) rejectInvisibleName(name);
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    }
    if (body.bio !== undefined) {
      if (typeof body.bio !== 'string' || [...body.bio.trim()].length > BIO_MAX) throw new HttpError(400, `介绍最多${BIO_MAX}个字`);
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(body.bio.trim(), user.id);
    }
    if (body.showRooms !== undefined) {
      if (typeof body.showRooms !== 'boolean') throw new HttpError(400, '请求格式不对');
      db.prepare('UPDATE users SET show_rooms = ? WHERE id = ?').run(body.showRooms ? 1 : 0, user.id);
    }
    return profileOf(user, user.publicId);
  });

  // 兑换额度：{ code }（大小写、空格、短横线都不管）。成功以后返回加了多少、现在的额度
  router.post('/api/me/redeem', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('redeem', user.id);
    const code = asString(asObject(ctx.body).code, { max: 60, message: '请填写兑换码' });
    const result = redeemCreditCode(db, user.id, code, now());
    // 额度用完、回合在跳过他的局：现在又有额度了
    deps.engine.creditChanged([user.id], true);
    return { amount: result.amount, credit: creditOf(db, user.id) };
  });

  // 换头像：{ image: 'data:image/webp;base64,…' }。只收 PNG、JPEG、WebP，按文件内容认格式
  router.put('/api/me/avatar', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('avatar', user.id);
    const image = asObject(ctx.body).image;
    const match = typeof image === 'string' ? /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
    if (!match) throw new HttpError(400, '请选择一张图片');
    const data = Buffer.from(match[1], 'base64');
    if (data.length > AVATAR_MAX_BYTES) throw new HttpError(413, `图片太大了，最大 ${AVATAR_MAX_BYTES / 1024} KB`);
    const type = sniffImage(data);
    if (!type) throw new HttpError(400, '只能用 PNG、JPEG 或 WebP 图片');
    const at = now();
    transaction(db, () => {
      db.prepare('INSERT INTO avatars (user_id, type, data) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET type = excluded.type, data = excluded.data').run(
        user.id,
        type,
        data,
      );
      db.prepare('UPDATE users SET avatar_at = ? WHERE id = ?').run(at, user.id);
    });
    return { avatar: avatarUrl(user.publicId, at) };
  });

  router.delete('/api/me/avatar', (ctx) => {
    const user = requireUser(ctx);
    transaction(db, () => {
      db.prepare('DELETE FROM avatars WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE users SET avatar_at = NULL WHERE id = ?').run(user.id);
    });
    return { avatar: null };
  });

  // 头像图片（地址里是公开编号；以前的地址用的是用户名，也认）。地址里带着换头像的时间，换了以后地址就变了，所以可以一直缓存
  router.get('/api/avatars/:ref', (ctx) => {
    requireLogin(ctx);
    const ref = ctx.params.ref ?? '';
    const row = db
      .prepare('SELECT a.type, a.data FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.public_id = ? OR u.username = ?')
      .get(ref, ref) as { type: string; data: Uint8Array } | undefined;
    if (!row) throw new HttpError(404, '没有头像');
    ctx.res.writeHead(200, {
      'Content-Type': row.type,
      'Content-Length': row.data.byteLength,
      'Cache-Control': 'private, max-age=31536000, immutable',
      // 图片本身不能当网页打开
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Content-Disposition': 'inline',
    });
    ctx.res.end(Buffer.from(row.data));
    return STREAMING;
  });

  // ==================== 个人主页 ====================

  function profileOf(viewer: User, ref: string | undefined) {
    // 管理员在主页上封号（V0.8.1）：定的时长到了的先解封，主页上就不再写着封禁
    if (hasPermission(viewer, 'ban')) safety.liftExpiredBans();
    const target = ref ? social.findUser(ref) : undefined;
    if (!target) throw new HttpError(404, '没有这个用户');
    const self = target.id === viewer.id;
    // 被封禁的账号：只有管理员看得到
    if (target.banned_at !== null && !viewer.isAdmin) throw new HttpError(404, '没有这个用户');
    const showRooms = target.show_rooms === 1 || self || viewer.isAdmin;
    const rows =
      showRooms && target.is_guest !== 1
        ? (db
            .prepare(
              `SELECT r.id, r.name, r.status, r.is_public, p.role, c.name AS character_name, c.role_key,
                 json_extract(s.data, '$.title') AS scenario_title, s.data AS scenario_data,
                 EXISTS (SELECT 1 FROM players me WHERE me.room_id = r.id AND me.user_id = ?) AS viewer_member
               FROM players p JOIN rooms r ON r.id = p.room_id LEFT JOIN characters c ON c.player_id = p.id
               LEFT JOIN scenarios s ON s.room_id = r.id
               WHERE p.user_id = ? ORDER BY r.created_at DESC LIMIT 100`,
            )
            .all(viewer.id, target.id) as {
            id: number;
            name: string;
            status: string;
            is_public: number;
            role: 'host' | 'player';
            character_name: string | null;
            role_key: string | null;
            scenario_title: string | null;
            scenario_data: string | null;
            viewer_member: number;
          }[])
        : null;
    const roleName = (data: string | null, key: string | null) => {
      if (!data || !key) return null;
      const roles = (safeJson(data).roles ?? []) as { key?: string; name?: string }[];
      return roles.find((r) => r.key === key)?.name ?? null;
    };
    const rooms = rows?.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      isPublic: r.is_public === 1,
      role: r.role,
      characterName: r.character_name,
      roleName: roleName(r.scenario_data, r.role_key),
      scenarioTitle: r.scenario_title,
      // 能不能点进去：自己在里面、公开的、或者是能管所有对局的管理员
      canOpen: r.viewer_member === 1 || r.is_public === 1 || hasPermission(viewer, 'rooms'),
    }));
    return {
      user: {
        ...toBrief(target),
        // 用户名只给本人和管理员看（别人要知道完整的用户名才能加好友）
        ...(self || viewer.isAdmin ? { username: target.username } : {}),
        bio: target.bio,
        joinedAt: target.created_at,
        lastSeenAt: target.last_seen_at,
        online: hub.isConnected(target.id),
        banned: viewer.isAdmin ? target.banned_at !== null : false,
      },
      relation: social.relation(viewer.id, target.id),
      /** 我屏蔽了他。 */
      blocked: social.blocked(viewer.id, target.id),
      showRooms: self ? target.show_rooms === 1 : null,
      // 四个数（V0.8.2 起换成这四个）：和对局一起，本人选了不展示时别人看不到
      stats: rooms ? statsOf(target.id) : null,
      rooms: rooms ?? null,
      // 剧本大厅里的作品、关注他的人数、我关注了没有（V0.5.0）
      works: target.is_guest === 1 ? [] : works.worksOf(target.id, viewer.id),
      followers: works.followers(target.id),
      following: !self && !viewer.isGuest && works.isFollowing(viewer.id, target.id),
      pet: target.is_guest === 1 ? null : publicPetOf(viewer, target.id),
      // 角色卡（V0.8.1）：主人选了在主页展示的
      cards: target.is_guest === 1 ? [] : cards.publicCards(target.id),
      // 5E 角色（V0.9.0）：主人选了在主页展示的
      cards5e: target.is_guest === 1 ? [] : deps.cards5e.publicCards(target.id),
      // 封号、解封（V0.8.1）：只给有封号权限的管理员
      moderation: hasPermission(viewer, 'ban') ? moderationOf(viewer, target) : null,
      // 戴着的称号、成就、达成的结局数（V0.6.0）；能戴的称号只给本人
      title: wornTitle(db, target.id),
      collection:
        target.is_guest === 1
          ? null
          : {
              achievements: collection.earned(target.id),
              endings: collection.endingCount(target.id),
              titles: self ? { options: pets.titleOptions(target.id), current: pets.titleKey(target.id) } : null,
            },
    };
  }

  /**
   * 主页上的四个数（V0.8.2）：
   * - 玩完的剧本：剧本大厅里的剧本（不算地下城）走到结局、自己交过至少 3 个行动的局数，重复玩也算（和发龙晶、长宠物属性一样，一局只算一次）；
   * - 通关的地下城：剧本大厅里的地下城通关的次数，重复刷也算；队伍通关了、自己的卡死在里面的不算；
   * - 达成的结局：达成过几个不同的结局（图鉴里的那个数）；
   * - 成就：达成了几个成就（隐藏成就算，活动称号不算），和成就那一块的数一样。
   */
  function statsOf(userId: number) {
    const count = (sql: string) => (db.prepare(sql).get(userId) as { n: number }).n;
    return {
      scenarios: count(
        `SELECT COUNT(*) AS n FROM pet_growth g
         JOIN scenario_finishes f ON f.room_id = g.room_id AND f.room_created_at = g.room_created_at
         WHERE g.user_id = ? AND NOT EXISTS (SELECT 1 FROM dungeon_runs d WHERE d.room_id = g.room_id AND d.room_created_at = g.room_created_at)`,
      ),
      dungeons: count(
        `SELECT COUNT(*) AS n FROM dungeon_runs d, json_each(d.members) m
         WHERE d.result = 'clear' AND json_extract(m.value, '$.userId') = ?
           AND NOT EXISTS (SELECT 1 FROM card_history h WHERE h.card_id = json_extract(m.value, '$.cardId')
                             AND h.room_id = d.room_id AND h.room_created_at = d.room_created_at AND h.result = 'dead')`,
      ),
      endings: collection.endingCount(userId),
      // 和成就那一块标题旁边的数一样算：看得到的成就 + 达成了的隐藏成就（活动称号不算）
      achievements: collection.earned(userId).filter((a) => VISIBLE_ACHIEVEMENTS.has(a.key) || a.hidden).length,
    };
  }

  /**
   * 主页上管理员要的（V0.8.1）：账号编号（封号的接口用）、封着没有（什么时候、为什么、到什么时候）、能不能封他。
   * 能不能封和账号详情里一样：自己、站长、管理员都不行（管理员要先撤销身份）。
   */
  function moderationOf(viewer: User, target: { id: number; is_admin: number; is_owner: number }) {
    const row = db.prepare('SELECT banned_at, ban_reason, banned_until FROM users WHERE id = ?').get(target.id) as
      | { banned_at: number | null; ban_reason: string | null; banned_until: number | null }
      | undefined;
    return {
      id: target.id,
      banned: row && row.banned_at !== null ? { at: row.banned_at, reason: row.ban_reason ?? '', until: row.banned_until } : null,
      canBan: target.id !== viewer.id && target.is_owner !== 1 && target.is_admin !== 1,
    };
  }

  /** 主页上的宠物：加上我能不能串门（V0.6.0）。 */
  function publicPetOf(viewer: User, ownerId: number): PublicPet | null {
    const base = pets.publicView(ownerId);
    if (!base) return null;
    return { ...base, visit: viewer.isGuest ? null : petPlay.visitInfo(viewer.id, ownerId) };
  }

  // 个人主页：地址里是公开编号（以前的地址用的是用户名，也认）
  router.get('/api/users/:ref', (ctx) => {
    const viewer = requireViewer(ctx);
    return profileOf(viewer, ctx.params.ref);
  });

  // ==================== 好友 ====================

  router.get('/api/friends', (ctx) => {
    const user = requireViewer(ctx);
    // 游客没有好友（加好友、私信都要正式账号）：社交页照样能打开看看，这里是空的
    if (user.isGuest) return { friends: [], incoming: [], outgoing: [], blocked: [] };
    const rows = db
      .prepare(
        `SELECT f.requester_id, f.addressee_id, f.status, f.created_at, f.accepted_at,
           u.id, u.username, u.public_id, u.display_name, u.is_admin, u.is_owner, u.is_guest, u.avatar_at, u.avatar_frame, u.last_seen_at, u.banned_at
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
         WHERE f.requester_id = ? OR f.addressee_id = ?`,
      )
      .all(user.id, user.id, user.id) as {
      requester_id: number;
      status: 'pending' | 'accepted';
      created_at: number;
      accepted_at: number | null;
      id: number;
      username: string;
      public_id: string;
      display_name: string;
      is_admin: number;
      is_owner: number;
      is_guest: number;
      avatar_at: number | null;
      avatar_frame: string | null;
      last_seen_at: number | null;
      banned_at: number | null;
    }[];
    const unread = new Map(
      (
        db
          .prepare('SELECT sender_id, COUNT(*) AS n FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id')
          .all(user.id) as { sender_id: number; n: number }[]
      ).map((r) => [r.sender_id, r.n]),
    );
    const lastMessage = db.prepare(
      `SELECT sender_id, text, created_at FROM direct_messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) ORDER BY id DESC LIMIT 1`,
    );
    const friends = rows
      .filter((r) => r.status === 'accepted')
      .map((r) => {
        const last = lastMessage.get(user.id, r.id, r.id, user.id) as { sender_id: number; text: string; created_at: number } | undefined;
        return {
          ...toBrief(r),
          online: r.banned_at === null && hub.isConnected(r.id),
          lastSeenAt: r.last_seen_at,
          since: r.accepted_at ?? r.created_at,
          unread: unread.get(r.id) ?? 0,
          last: last ? { text: [...last.text].slice(0, 60).join(''), at: last.created_at, mine: last.sender_id === user.id } : null,
        };
      })
      .sort((a, b) => (b.last?.at ?? b.since) - (a.last?.at ?? a.since));
    const blocked = (
      db
        .prepare(`SELECT ${BRIEF_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')} FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC`)
        .all(user.id) as Parameters<typeof toBrief>[0][]
    ).map(toBrief);
    return {
      friends,
      incoming: rows.filter((r) => r.status === 'pending' && r.requester_id !== user.id).map((r) => ({ ...toBrief(r), at: r.created_at })),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requester_id === user.id).map((r) => ({ ...toBrief(r), at: r.created_at })),
      blocked,
    };
  });

  // 加好友：{ username }，要填对方完整的用户名（大小写不分），不能用公开编号、显示名，免得陌生人随便加。
  // 对方已经申请加你了，就直接成为好友
  router.post('/api/friends', (ctx) => {
    const user = requireUser(ctx);
    const username = asString(asObject(ctx.body).username, { max: 40, message: '请填写对方的用户名' });
    const found = social.findByUsername(username);
    if (!found || found.banned_at !== null) throw new HttpError(404, '没有这个用户名');
    const target = otherUser(user, found.public_id, '加');
    if (social.blockedEither(user.id, target.id)) {
      throw new HttpError(403, social.blocked(user.id, target.id) ? '你屏蔽了这个人，先取消屏蔽' : '没法加这个人为好友');
    }
    const relation = social.relation(user.id, target.id);
    if (relation === 'friends') throw new HttpError(409, '你们已经是好友了');
    if (relation === 'pending-out') throw new HttpError(409, '已经发过申请了，等对方同意');
    if (relation === 'pending-in') return accept(user, target.id);
    limiter.hit('friendRequest', user.id);
    db.prepare("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(user.id, target.id, now());
    social.notify(target.id, 'friend_request', { from: social.brief(user.id) });
    ctx.status = 201;
    return { relation: 'pending-out' };
  });

  function accept(user: User, fromId: number) {
    const changed = db
      .prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'")
      .run(now(), fromId, user.id).changes;
    if (!changed) {
      // 已经同意过了（在别处点过、或者点了两次）：照样算成功
      if (social.relation(user.id, fromId) === 'friends') return { relation: 'friends' };
      throw new HttpError(404, '这个好友申请已经不在了（可能被撤回了）');
    }
    social.clearNotifications(user.id, 'friend_request', fromId);
    social.notify(fromId, 'friend_accepted', { from: social.brief(user.id) });
    social.pushBadges(user.id);
    hub.toUser(user.id, 'friends-changed', {});
    hub.toUser(fromId, 'friends-changed', {});
    return { relation: 'friends' };
  }

  router.post('/api/friends/:username/accept', (ctx) => {
    const user = requireUser(ctx);
    const target = otherUser(user, ctx.params.username, '加');
    return accept(user, target.id);
  });

  // 删除好友、拒绝申请、撤回自己发的申请，都是这个
  router.delete('/api/friends/:username', (ctx) => {
    const user = requireUser(ctx);
    const target = social.findUser(ctx.params.username ?? '');
    if (!target || !social.unfriend(user.id, target.id)) throw new HttpError(404, '你们不是好友');
    social.pushBadges(user.id);
    social.pushBadges(target.id);
    hub.toUser(user.id, 'friends-changed', {});
    hub.toUser(target.id, 'friends-changed', {});
    return { relation: 'none' };
  });

  // ==================== 私聊 ====================

  const toDm = (r: DmRow, me: number) => ({ id: r.id, mine: r.sender_id === me, text: r.text, at: r.created_at, read: r.read_at !== null });

  // 和某人的聊天记录（不是好友了也能看以前的）。before：翻到更早的
  router.get('/api/friends/:username/messages', (ctx) => {
    const user = requireUser(ctx);
    const target = social.findUser(ctx.params.username ?? '');
    if (!target) throw new HttpError(404, '没有这个用户');
    const beforeParam = ctx.url.searchParams.get('before');
    const before = beforeParam ? asId(beforeParam) : Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT * FROM direct_messages WHERE id < ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
         ORDER BY id DESC LIMIT ?`,
      )
      .all(before, user.id, target.id, target.id, user.id, PAGE + 1) as DmRow[];
    return {
      user: { ...toBrief(target), online: hub.isConnected(target.id) },
      relation: social.relation(user.id, target.id),
      blocked: social.blocked(user.id, target.id),
      messages: rows.slice(0, PAGE).reverse().map((r) => toDm(r, user.id)),
      hasMore: rows.length > PAGE,
    };
  });

  router.post('/api/friends/:username/messages', (ctx) => {
    const user = requireUser(ctx);
    const target = otherUser(user, ctx.params.username, '私聊');
    if (!social.areFriends(user.id, target.id)) throw new HttpError(403, '成为好友以后才能私聊');
    if (social.blockedEither(user.id, target.id)) throw new HttpError(403, social.blocked(user.id, target.id) ? '你屏蔽了这个人，先取消屏蔽' : '对方现在不接收你的消息');
    const text = asString(asObject(ctx.body).text, { max: DM_MAX, message: `消息要在1～${DM_MAX}个字之间` });
    limiter.hit('dm', user.id);
    const at = now();
    const { lastInsertRowid } = db.prepare('INSERT INTO direct_messages (sender_id, recipient_id, text, created_at) VALUES (?, ?, ?, ?)').run(user.id, target.id, text, at);
    const row: DmRow = { id: Number(lastInsertRowid), sender_id: user.id, recipient_id: target.id, text, created_at: at, read_at: null };
    hub.toUser(target.id, 'dm', { with: user.publicId, message: toDm(row, target.id), from: social.brief(user.id) });
    hub.toUser(user.id, 'dm', { with: target.public_id, message: toDm(row, user.id) });
    social.pushBadges(target.id);
    // 浏览器推送（V0.8.0）：对方没开着网站就推「某某给你发了私信」（不带内容）
    deps.push.directMessage(target.id, { publicId: user.publicId, displayName: user.displayName });
    ctx.status = 201;
    return { message: toDm(row, user.id) };
  });

  // 看过了和某人的私聊：他发来的都标成已读
  router.post('/api/friends/:username/read', (ctx) => {
    const user = requireUser(ctx);
    const target = social.findUser(ctx.params.username ?? '');
    if (!target) throw new HttpError(404, '没有这个用户');
    const changed = db.prepare('UPDATE direct_messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').run(now(), target.id, user.id).changes;
    if (changed) {
      social.pushBadges(user.id);
      // 对方那边显示“已读”
      hub.toUser(target.id, 'dm-read', { by: user.publicId });
    }
    return { ok: true };
  });

  // ==================== 屏蔽 ====================

  router.post('/api/blocks', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    const target = otherUser(user, asString(body.user ?? body.username, { max: 40, message: '请选要屏蔽的人' }), '屏蔽');
    db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(user.id, target.id, now());
    // 屏蔽以后不再是好友，互相也不再关注；他发来的对局邀请也作废
    social.unfriend(user.id, target.id);
    db.prepare('DELETE FROM follows WHERE (follower_id = ? AND author_id = ?) OR (follower_id = ? AND author_id = ?)').run(user.id, target.id, target.id, user.id);
    db.prepare('DELETE FROM room_invites WHERE user_id = ? AND invited_by = ?').run(user.id, target.id);
    social.clearNotifications(user.id, 'room_invite', target.id);
    social.pushBadges(user.id);
    social.pushBadges(target.id);
    hub.toUser(user.id, 'friends-changed', {});
    hub.toUser(target.id, 'friends-changed', {});
    return { blocked: true };
  });

  router.delete('/api/blocks/:username', (ctx) => {
    const user = requireUser(ctx);
    const target = social.findUser(ctx.params.username ?? '');
    if (!target) throw new HttpError(404, '没有这个用户');
    db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(user.id, target.id);
    social.pushBadges(user.id);
    hub.toUser(user.id, 'friends-changed', {});
    return { blocked: false };
  });

  // ==================== 通知 ====================

  router.get('/api/notifications', (ctx) => {
    const user = requireLogin(ctx);
    return { items: social.listNotifications(user.id), badges: social.badges(user.id) };
  });

  // 标成已读：{ ids: [通知编号] }，不写 ids 就是全部
  router.post('/api/notifications/read', (ctx) => {
    const user = requireLogin(ctx);
    const raw = ctx.body === undefined ? undefined : asObject(ctx.body).ids;
    const ids = Array.isArray(raw) ? raw.filter((x): x is number => Number.isInteger(x)).slice(0, 200) : null;
    social.readNotifications(user.id, ids);
    return social.badges(user.id);
  });

  // ==================== 公告 ====================

  router.get('/api/announcements', (ctx) => {
    const user = requireViewer(ctx);
    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.body, a.created_at, u.display_name AS by_name,
           EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) AS read
         FROM announcements a LEFT JOIN users u ON u.id = a.created_by
         WHERE ${Social.ANNOUNCEMENT_VISIBLE} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(user.id, audienceOf(user.identity), user.id, PAGE) as { id: number; title: string; body: string; created_at: number; by_name: string | null; read: number }[];
    return { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, at: r.created_at, by: r.by_name, read: r.read === 1 })) };
  });

  router.post('/api/announcements/:id/read', (ctx) => {
    const user = requireViewer(ctx);
    const id = asId(ctx.params.id);
    if (!social.canSeeAnnouncement(user.id, id)) throw new HttpError(404, '没有这条公告');
    db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(id, user.id, now());
    social.pushBadges(user.id);
    return social.badges(user.id);
  });

  router.post('/api/announcements/read-all', (ctx) => {
    const user = requireViewer(ctx);
    db.prepare(
      `INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at)
       SELECT a.id, ?, ? FROM announcements a WHERE ${Social.ANNOUNCEMENT_VISIBLE}`,
    ).run(user.id, now(), audienceOf(user.identity), user.id);
    social.pushBadges(user.id);
    return social.badges(user.id);
  });

  // ==================== 大厅聊天 ====================

  type LobbyRow = {
    id: number;
    user_id: number;
    text: string;
    created_at: number;
    deleted_at: number | null;
    deleted_by: number | null;
    public_id: string;
    display_name: string;
    is_admin: number;
    is_owner: number;
    is_guest: number;
    avatar_at: number | null;
    avatar_frame: string | null;
    title_key: string | null;
  };
  const LOBBY_SELECT = `SELECT m.id, m.user_id, m.text, m.created_at, m.deleted_at, m.deleted_by, u.public_id, u.display_name, u.is_admin, u.is_owner, u.is_guest, u.avatar_at,
      u.avatar_frame, u.title AS title_key
    FROM lobby_messages m JOIN users u ON u.id = m.user_id`;
  const toLobby = (r: LobbyRow) => ({
    id: r.id,
    user: toBrief(r),
    /** 戴着的称号（V0.6.0）。 */
    title: titleNameOf(db, r.user_id, r.title_key),
    // 撤回了的不再给内容
    text: r.deleted_at === null ? r.text : '',
    deleted: r.deleted_at !== null,
    /** 是管理员撤回的（不是自己撤回的）。 */
    byAdmin: r.deleted_at !== null && r.deleted_by !== r.user_id,
    at: r.created_at,
  });

  /** 大厅的发言间隔（秒），0 是不限。 */
  const lobbySlowSeconds = (): number => {
    const v = Number(getSetting(db, LOBBY_SLOW_SETTING) ?? LOBBY_SLOW_DEFAULT);
    return Number.isInteger(v) && v >= 0 && v <= LOBBY_SLOW_MAX ? v : LOBBY_SLOW_DEFAULT;
  };
  /** 有「举报和大厅聊天」权限的管理员不受发言间隔限制。 */
  const lobbyModerator = (user: User) => user.permissions.includes('reports');

  router.get('/api/lobby/chat', (ctx) => {
    const user = requireViewer(ctx);
    const beforeParam = ctx.url.searchParams.get('before');
    const before = beforeParam ? asId(beforeParam) : Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `${LOBBY_SELECT} WHERE m.id < ? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = ? AND b.blocked_id = m.user_id)
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(before, user.id, PAGE + 1) as LobbyRow[];
    return {
      messages: rows.slice(0, PAGE).reverse().map(toLobby),
      hasMore: rows.length > PAGE,
      /** 自己的发言间隔（秒）：0 是不限（管理员也是 0）。 */
      slowSeconds: user.isGuest || lobbyModerator(user) ? 0 : lobbySlowSeconds(),
    };
  });

  router.post('/api/lobby/chat', (ctx) => {
    const user = requireUser(ctx);
    const text = asString(asObject(ctx.body).text, { max: LOBBY_CHAT_MAX, message: `消息要在1～${LOBBY_CHAT_MAX}个字之间` });
    // 防刷屏（V0.5.0）：每人每隔几秒才能说一句，也不能连着发一样的话；管理员不受限
    const slow = lobbySlowSeconds();
    if (slow > 0 && !lobbyModerator(user)) {
      const last = db.prepare('SELECT text, created_at, deleted_at FROM lobby_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id) as
        | { text: string; created_at: number; deleted_at: number | null }
        | undefined;
      if (last) {
        const wait = last.created_at + slow * 1000 - now();
        if (wait > 0) throw new HttpError(429, `发得太快了，${Math.ceil(wait / 1000)} 秒后再发`);
        if (last.deleted_at === null && last.text === text && now() - last.created_at < LOBBY_REPEAT_WINDOW_MS) {
          throw new HttpError(409, '和你上一句一样，不用再发一遍');
        }
      }
    }
    limiter.hit('lobbyChat', user.id);
    const { lastInsertRowid } = db.prepare('INSERT INTO lobby_messages (user_id, text, created_at) VALUES (?, ?, ?)').run(user.id, text, now());
    const message = toLobby(db.prepare(`${LOBBY_SELECT} WHERE m.id = ?`).get(Number(lastInsertRowid)) as LobbyRow);
    // 屏蔽了他的人收不到
    hub.toAllLobbiesEach('lobby-chat', (viewerId) => (social.blocked(viewerId, user.id) ? undefined : message));
    ctx.status = 201;
    return { message };
  });

  // 撤回一条大厅聊天：自己的、或者管理员撤回任何人的（站长的只有站长自己能撤回）。撤回的留着记录，不再给内容
  router.delete('/api/lobby/chat/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = asId(ctx.params.id);
    const row = db.prepare('SELECT user_id, text, deleted_at FROM lobby_messages WHERE id = ?').get(id) as
      | { user_id: number; text: string; deleted_at: number | null }
      | undefined;
    if (!row || row.deleted_at !== null) throw new HttpError(404, '没有这条消息');
    if (row.user_id !== user.id && !lobbyModerator(user)) throw new HttpError(403, '只能撤回自己的消息');
    if (row.user_id !== user.id && !user.isOwner && db.prepare('SELECT 1 FROM users WHERE id = ? AND is_owner = 1').get(row.user_id)) {
      throw new HttpError(403, '站长的消息只有站长自己能撤回');
    }
    db.prepare('UPDATE lobby_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, id);
    if (row.user_id !== user.id) audit(db, user.id, '撤回大厅聊天', `${who(db, row.user_id)}：${[...row.text].slice(0, 80).join('')}`, now());
    hub.toAllLobbies('lobby-chat-deleted', { id, ids: [id], byAdmin: row.user_id !== user.id });
    return { deleted: true };
  });

  // 管理员清理刷屏：撤回一个人最近一小时在大厅里说的话 { user: 公开编号 }
  router.post('/api/lobby/chat/recall-recent', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const ref = asObject(ctx.body).user;
    const target = typeof ref === 'string' ? social.findUser(ref) : undefined;
    if (!target) throw new HttpError(404, '没有这个用户');
    if (target.id !== admin.id && target.is_owner === 1 && !admin.isOwner) throw new HttpError(403, '站长的消息只有站长自己能撤回');
    const at = now();
    const ids = (
      db.prepare('SELECT id FROM lobby_messages WHERE user_id = ? AND deleted_at IS NULL AND created_at >= ? ORDER BY id').all(target.id, at - LOBBY_RECALL_RECENT_MS) as {
        id: number;
      }[]
    ).map((r) => r.id);
    if (ids.length) {
      transaction(db, () => {
        for (const id of ids) db.prepare('UPDATE lobby_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(at, admin.id, id);
      });
      if (target.id !== admin.id) audit(db, admin.id, '撤回大厅聊天', `${who(db, target.id)}：最近一小时的 ${ids.length} 条`, at);
      hub.toAllLobbies('lobby-chat-deleted', { ids, byAdmin: target.id !== admin.id });
    }
    return { recalled: ids.length };
  });

  // 大厅的发言间隔（管理页「举报和反馈」最上面）：{ slowSeconds } 0 是不限
  router.get('/api/admin/lobby', (ctx) => {
    requireAdmin(ctx, 'reports');
    return { slowSeconds: lobbySlowSeconds() };
  });

  router.put('/api/admin/lobby', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const v = asObject(ctx.body).slowSeconds;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > LOBBY_SLOW_MAX) throw new HttpError(400, `发言间隔要填 0～${LOBBY_SLOW_MAX} 秒`);
    const before = lobbySlowSeconds();
    setSetting(db, LOBBY_SLOW_SETTING, String(v));
    const text = (n: number) => (n === 0 ? '不限' : `${n} 秒`);
    if (before !== v) audit(db, admin.id, '改大厅发言间隔', `${text(before)} → ${text(v)}`, now());
    return { slowSeconds: v };
  });

  // ==================== 举报、意见和 bug 反馈 ====================

  /**
   * { kind: 'report' | 'feedback' | 'bug', body, username?, target?: { type: 'lobby' | 'dm' | 'room', id }, steps?, context? }
   * report 举报某个人或某条消息；feedback 给管理员提意见；bug 报告网站的问题（游客也能提意见、报 bug）。
   * bug 会附上网页自动收集的页面、屏幕大小、最近的报错（context），服务器再加上浏览器和版本号。
   */
  router.post('/api/reports', (ctx) => {
    const user = requireViewer(ctx);
    const o = asObject(ctx.body);
    const kind = asOneOf(o.kind, ['report', 'feedback', 'bug'] as const, '请求格式不对');
    if (kind === 'report' && user.isGuest) throw new HttpError(403, '游客不能举报，有问题可以用「提意见」告诉管理员');
    const label = kind === 'report' ? '举报的原因' : kind === 'bug' ? '发生了什么' : '内容';
    const body = asString(o.body, { max: REPORT_MAX, message: `请写一下${label}（最多${REPORT_MAX}个字）` });
    let targetUser: number | null = null;
    let target: Record<string, unknown> | null = null;
    let steps = '';
    let context: Record<string, unknown> | null = null;
    if (kind === 'report') {
      const t = o.target === undefined ? null : asObject(o.target);
      if (t) {
        // V0.7.0 去掉了宠物留言：以前的举报（pet_note）管理页照样看得到，新的不收
        const type = asOneOf(t.type, ['lobby', 'dm', 'room', 'rating', 'feedback', 'group', 'persona'] as const, '请求格式不对');
        const id = typeof t.id === 'number' && Number.isInteger(t.id) && t.id > 0 ? t.id : 0;
        if (type === 'persona') {
          // AI 大厅里公开的 AI 角色（V1.1.0）：名字、简介、人设一起附上
          const p = db.prepare('SELECT user_id, name, intro, prompt, public FROM ai_personas WHERE id = ?').get(id) as
            | { user_id: number; name: string; intro: string; prompt: string; public: number }
            | undefined;
          if (!p || p.public !== 1) throw new HttpError(404, '没有这个 AI 角色');
          targetUser = p.user_id;
          target = { type, id, name: p.name, text: `名字：${p.name}\n简介：${p.intro || '（没写）'}\n人设：\n${p.prompt}` };
        } else if (type === 'group') {
          // 群聊里别人发的消息（V0.7.0）：自己在这个群里才能举报
          const m = groups.messageForReport(id, user.id);
          if (!m) throw new HttpError(404, '没有这条消息');
          targetUser = m.senderId;
          target = { type, id, groupId: m.groupId, groupName: m.groupName, text: m.text, at: m.at };
        } else if (type === 'feedback') {
          // 私下给作者的反馈（V0.6.0）：只有收到它的作者能举报
          const f = works.feedbackForReport(id, user.id);
          if (!f) throw new HttpError(404, '没有这条反馈');
          targetUser = f.userId;
          target = { type, id, text: f.text, scenarioKey: f.key };
        } else if (type === 'rating') {
          // 剧本的短评（V0.6.0）：看得到短评的人（玩完过的、作者、管理员）才能举报
          const r = works.ratingRow(id);
          if (!r || !r.comment) throw new HttpError(404, '没有这条短评');
          if (!works.detail(user.id, r.key, user.isAdmin).comments) throw new HttpError(404, '没有这条短评');
          targetUser = r.userId;
          target = { type, id, text: r.comment, scenarioKey: r.key };
        } else if (type === 'lobby') {
          const m = db.prepare('SELECT user_id, text, created_at, deleted_at, deleted_by FROM lobby_messages WHERE id = ?').get(id) as
            | { user_id: number; text: string; created_at: number; deleted_at: number | null; deleted_by: number | null }
            | undefined;
          if (!m) throw new HttpError(404, '没有这条消息');
          // 管理员撤回的不用再举报（已经处理过了）；自己撤回的照样能举报：发了难听的话马上撤回，管理员在举报里看得到原文
          if (m.deleted_at !== null && m.deleted_by !== m.user_id) throw new HttpError(409, '这条消息已经被管理员撤回了');
          targetUser = m.user_id;
          target = { type, id, text: m.text, at: m.created_at };
        } else if (type === 'dm') {
          const m = db.prepare('SELECT sender_id, recipient_id, text, created_at FROM direct_messages WHERE id = ?').get(id) as
            | { sender_id: number; recipient_id: number; text: string; created_at: number }
            | undefined;
          // 只能举报别人发给自己的私信
          if (!m || m.recipient_id !== user.id) throw new HttpError(404, '没有这条消息');
          targetUser = m.sender_id;
          target = { type, id, text: m.text, at: m.created_at };
        } else {
          const row = loadLogRow(db, id);
          // 只能举报自己看得到的、玩家写的内容（场外聊天、对白）
          const member = row ? db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(row.room_id, user.id) : undefined;
          if (!row || !member || row.author_id === null || !canSee(db, row, user.id, characterIdOf(db, row.room_id, user.id))) {
            throw new HttpError(404, '没有这条消息');
          }
          const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(row.room_id) as { name: string };
          targetUser = row.author_id;
          target = { type, id, roomId: row.room_id, roomName: room.name, text: row.text, at: row.created_at };
        }
      } else {
        const t = otherUser(user, asString(o.user ?? o.username, { max: 40, message: '请选要举报的人' }), '举报');
        targetUser = t.id;
        target = { type: 'user', displayName: t.display_name, bio: t.bio };
      }
      if (targetUser === user.id) throw new HttpError(400, '不能举报自己');
    } else if (kind === 'bug') {
      if (o.steps !== undefined) {
        if (typeof o.steps !== 'string' || [...o.steps.trim()].length > REPORT_MAX) throw new HttpError(400, `怎么出现的最多${REPORT_MAX}个字`);
        steps = o.steps.trim();
      }
      context = bugContext(o.context, ctx.req.headers['user-agent']);
    }
    limiter.hit('report', user.id);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO reports (reporter_id, kind, target_user_id, target, body, steps, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, kind, targetUser, target ? JSON.stringify(target) : null, body, steps, context ? JSON.stringify(context) : null, now());
    const reportId = Number(lastInsertRowid);
    // 举报的是管理员：只告诉站长
    const aboutAdmin = targetUser !== null && !!db.prepare('SELECT 1 FROM users WHERE id = ? AND (is_admin = 1 OR is_owner = 1)').get(targetUser);
    const owners = new Set((db.prepare('SELECT id FROM users WHERE is_owner = 1').all() as { id: number }[]).map((r) => r.id));
    for (const adminId of social.adminsWith('reports')) {
      if (adminId === user.id || (aboutAdmin && !owners.has(adminId))) continue;
      social.notify(adminId, 'new_report', { reportId, kind, from: social.brief(user.id) });
    }
    social.pushAdminBadges();
    // 举报交上来先让 AI 看一遍，把意见给管理员（V0.6.0；AI 用不了也不耽误举报）
    if (kind === 'report') {
      try {
        reviewer.start('report', reportId, null);
      } catch (err) {
        console.error('举报的 AI 审核没开始：', err);
      }
    }
    ctx.status = 201;
    return { id: reportId };
  });

  /** 「我的举报」里只说举报的是哪一类东西（大厅聊天、私信、群聊……）。 */
  function reportTargetType(text: string | null): { type: string } | null {
    const type = safeJson(text).type;
    return typeof type === 'string' ? { type } : null;
  }

  // 我提交过的举报、意见、bug，以及管理员的处理结果和回复
  router.get('/api/reports/mine', (ctx) => {
    const user = requireViewer(ctx);
    const rows = db
      .prepare(
        `SELECT r.id, r.kind, r.body, r.steps, r.target, r.created_at, r.handled_at, r.outcome, r.reply,
           u.public_id, u.display_name, u.is_admin, u.is_owner, u.is_guest, u.avatar_at
         FROM reports r LEFT JOIN users u ON u.id = r.target_user_id WHERE r.reporter_id = ? ORDER BY r.id DESC LIMIT 50`,
      )
      .all(user.id) as {
      id: number;
      kind: string;
      body: string;
      steps: string;
      target: string | null;
      created_at: number;
      handled_at: number | null;
      outcome: string | null;
      reply: string;
      public_id: string | null;
      display_name: string;
      is_admin: number;
      is_owner: number;
      is_guest: number;
      avatar_at: number | null;
    }[];
    return {
      reports: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        body: r.body,
        steps: r.steps,
        about: r.public_id ? (toBrief(r as never) as UserBrief) : null,
        // 只给举报的是哪一类：举报里存的原文（可能是对方后来撤回了的）只给管理员看
        target: reportTargetType(r.target),
        at: r.created_at,
        handledAt: r.handled_at,
        outcome: r.outcome,
        reply: r.reply,
      })),
    };
  });
}
