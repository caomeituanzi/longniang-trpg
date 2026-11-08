import { avatarUrl, identityOf, permissionsOf, type Identity } from './auth';
import type { AdminPermission } from '../shared/admin';
import { frameOf } from '../shared/pets';
import type { DB } from './db';
import type { RealtimeHub } from './realtime';

// 人和人之间的事：好友、屏蔽、通知、公告、未读数。接口在 routes/social.ts。

export type NotificationKind =
  /** 有人想加你好友：{ from } */
  | 'friend_request'
  /** 对方同意了你的好友申请：{ from } */
  | 'friend_accepted'
  /** 有人邀请你进对局：{ from, roomId, roomName } */
  | 'room_invite'
  /** 你在的对局开始了：{ roomId, roomName, by } */
  | 'room_started'
  /** （发给房主）有人在大厅里申请加入你的对局：{ from, roomId, roomName } */
  | 'join_request'
  /** 房主处理了你的加入申请：{ roomId, roomName, approved, by } */
  | 'join_result'
  /** 第一次违规，警告你：{ message } */
  | 'violation_warning'
  /** 管理员回复了你的举报或反馈：{ reportId, kind, reply } */
  | 'report_reply'
  /** （发给管理员）有新的举报或反馈：{ reportId, kind, from } */
  | 'new_report'
  /** 投稿审核的结果：{ submissionId, title, approved, reason?, key? } */
  | 'submission_result'
  /** 关注的作者有新作品放进了剧本大厅：{ from, title, key, category } */
  | 'new_work'
  /** 宠物打工回来了：{ pet, job, pay } */
  | 'pet_job_done'
  /** 宠物远行回来了（V0.6.0）：{ pet, trip, crystals, food, place } */
  | 'pet_trip_done'
  /** 宠物写好了一篇日记（V0.6.0）：{ pet } */
  | 'pet_diary'
  /** 好友来串门（每人每天第一次，V0.6.0）：{ from, pet, kind: feed | pat, item, reward } */
  | 'pet_visit'
  /** 有人给你的宠物留言（V0.6.0；V0.7.0 去掉了留言，只有以前的通知还是这一种）：{ from, pet } */
  | 'pet_note'
  /** 达成了成就（V0.6.0）：{ key, title, how, reward } */
  | 'achievement'
  /** 投稿的剧本被别人玩完了一局，得到分成（V0.6.0）：{ title, key, reward } */
  | 'author_reward'
  /** （发给作者）有人给你的作品写了短评（V0.6.0）：{ from, title, key, stars } */
  | 'work_review'
  /** （发给作者）玩过的人私下给你写了反馈（V0.6.0）：{ from, title, key, feedbackId } */
  | 'work_feedback'
  /** 作者回复了你的反馈（V0.6.0）：{ from, title, key } */
  | 'feedback_reply'
  /** 角色卡攒了成长点（V0.7.0）：{ card, cardId, title, points } */
  | 'card_growth'
  /** 5E 角色打完了一个模组（V0.9.0）：{ card, cardId, title, survived, counted（剧本大厅里的才算）, levelUp, loot } */
  | 'card5e_done'
  /** 玩完一局得到一个宝箱（V0.7.0）：{ title } */
  | 'chest'
  /** 拿到了传奇装备（V0.7.0）：{ gear, name, title } */
  | 'legendary'
  /** 有人拿角色卡来和你的卡切磋（V0.7.0）：{ from, card, won } */
  | 'duel'
  /** 被拉进了群聊（V0.7.0）：{ from, groupId, name } */
  | 'group_added'
  /** 管理员发了东西给你（V0.7.1，管理页「物品」）：{ item: 名字, count, where: 'bag' | 'wardrobe'（去哪里看） } */
  | 'item_grant'
  // 约团（V0.8.0，server/schedule.ts）。startsAt 是 UTC 毫秒，网页、推送按对方设备的本地时间显示
  /** 房主列了新的候选时间（发给除房主以外的成员）：{ roomId, roomName, from（房主）, count（几个时间） } */
  | 'schedule_poll'
  /** 房主定下了时间（发给除房主以外的成员）：{ roomId, roomName, startsAt } */
  | 'schedule_confirmed'
  /** 房主取消了定下的、还没开始的时间（发给除房主以外的成员；只取消还在勾的不发）：{ roomId, roomName } */
  | 'schedule_cancelled'
  /** 定下的时间开始前 30 分钟（发给所有成员，包括房主）：{ roomId, roomName, startsAt } */
  | 'schedule_reminder';

/**
 * 网页上显示一个人用的简单信息。publicId：公开编号，个人主页、头像的网址用它；
 * 里面没有用户名（用户名只有本人和管理员看得到，别人要知道完整的用户名才能加好友）。
 * frame：戴着的头像框（V0.7.0，没戴是 null）。
 */
export type UserBrief = { publicId: string; displayName: string; avatar: string | null; identity: Identity; frame: string | null };

/**
 * 要处理的通知（好友申请、对局邀请）现在怎么样了：pending 还在等你处理；friends 已经是好友；joined 已经加入了；
 * gone 已经失效（被拒绝、撤回、对局删了）。别的通知没有这一项。
 */
export type NotificationState = 'pending' | 'friends' | 'joined' | 'gone';

export type NotificationView = {
  id: number;
  kind: NotificationKind;
  data: Record<string, unknown>;
  createdAt: number;
  read: boolean;
  state?: NotificationState;
};

/**
 * 各处的未读数：notifications 铃铛里的通知，announcements 没读的公告（铃铛上的数字是这两个加起来），
 * messages 没读的私信，friendRequests 等你同意的好友申请（「好友」旁边的数字是这两个加起来），
 * admin 只有管理员有：没处理的举报和反馈、没处理的违规记录。
 */
/** admin 是管理页上要处理的总数（没处理的举报和反馈、没处理的违规记录、等审核的投稿），只算有权限的。 */
export type Badges = {
  notifications: number;
  announcements: number;
  messages: number;
  /** 没读的群消息（V0.7.0）。 */
  groups: number;
  friendRequests: number;
  admin: number;
  adminReports: number;
  adminViolations: number;
  /** 等审核的投稿（有「剧本管理」权限的管理员才算）。 */
  adminSubmissions: number;
};

export type Relation = 'self' | 'friends' | 'pending-out' | 'pending-in' | 'none';

export type BriefRow = {
  id: number;
  username: string;
  public_id: string;
  display_name: string;
  is_admin: number;
  is_owner: number;
  is_guest: number;
  avatar_at: number | null;
  avatar_frame: string | null;
};

export const BRIEF_COLUMNS = 'id, username, public_id, display_name, is_admin, is_owner, is_guest, avatar_at, avatar_frame';

/** 公告按身份发给谁时，站长算管理员。 */
export function audienceOf(identity: Identity): 'guest' | 'user' | 'admin' {
  return identity === 'owner' ? 'admin' : identity;
}

/** 查出来的一行换成用户简介。没查 avatar_frame 的（管理页、举报里的）头像框是 null。 */
export function toBrief(
  row: Pick<BriefRow, 'public_id' | 'display_name' | 'is_admin' | 'is_owner' | 'is_guest' | 'avatar_at'> & { avatar_frame?: string | null },
): UserBrief {
  return {
    publicId: row.public_id,
    displayName: row.display_name,
    avatar: avatarUrl(row.public_id, row.avatar_at),
    identity: identityOf(row),
    frame: frameOf(row.avatar_frame),
  };
}

export type FoundUser = BriefRow & { banned_at: number | null; show_rooms: number; bio: string; created_at: number; last_seen_at: number | null };

export class Social {
  /** 写好一条通知以后（V0.8.0：浏览器推送，服务器组装时接上；在这里面出错不影响通知本身）。 */
  onNotified: ((userId: number, view: NotificationView) => void) | null = null;

  constructor(
    private readonly db: DB,
    private readonly hub: () => RealtimeHub,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 按公开编号（网页上用的）或用户名找账号（被封禁的也找得到，调用的地方自己决定能不能用；删除了的找不到）。
   * 公开编号是 p- 开头的，用户名里不会有短横线，不会弄混。
   */
  findUser(ref: string): FoundUser | undefined {
    return this.db
      .prepare(`SELECT ${BRIEF_COLUMNS}, banned_at, show_rooms, bio, created_at, last_seen_at FROM users WHERE (public_id = ? OR username = ?) AND deleted_at IS NULL`)
      .get(ref, ref) as never;
  }

  /** 只按完整的用户名找（加好友用：知道对方完整的用户名才能加）。大小写不分。 */
  findByUsername(username: string): FoundUser | undefined {
    return this.db
      .prepare(`SELECT ${BRIEF_COLUMNS}, banned_at, show_rooms, bio, created_at, last_seen_at FROM users WHERE username = ? AND deleted_at IS NULL`)
      .get(username) as never;
  }

  brief(userId: number): UserBrief | null {
    const row = this.db.prepare(`SELECT ${BRIEF_COLUMNS} FROM users WHERE id = ?`).get(userId) as BriefRow | undefined;
    return row ? toBrief(row) : null;
  }

  // ==================== 好友和屏蔽 ====================

  /** a 屏蔽了 b。 */
  blocked(a: number, b: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(a, b);
  }

  /** 两个人之间有一方屏蔽了另一方。 */
  blockedEither(a: number, b: number): boolean {
    return this.blocked(a, b) || this.blocked(b, a);
  }

  /** 我屏蔽了的人。 */
  blockedIds(userId: number): Set<number> {
    return new Set((this.db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ?').all(userId) as { blocked_id: number }[]).map((r) => r.blocked_id));
  }

  private friendshipRow(a: number, b: number) {
    return this.db
      .prepare(
        `SELECT id, requester_id, addressee_id, status FROM friendships
         WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
      )
      .get(a, b, b, a) as { id: number; requester_id: number; addressee_id: number; status: 'pending' | 'accepted' } | undefined;
  }

  relation(viewer: number, target: number): Relation {
    if (viewer === target) return 'self';
    const row = this.friendshipRow(viewer, target);
    if (!row) return 'none';
    if (row.status === 'accepted') return 'friends';
    return row.requester_id === viewer ? 'pending-out' : 'pending-in';
  }

  areFriends(a: number, b: number): boolean {
    return this.relation(a, b) === 'friends';
  }

  /** 删掉两个人之间的好友关系（包括还没同意的申请）。 */
  unfriend(a: number, b: number): boolean {
    const row = this.friendshipRow(a, b);
    if (!row) return false;
    this.db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
    // 还没处理的好友申请通知也一起清掉
    this.clearNotifications(a, 'friend_request', b);
    this.clearNotifications(b, 'friend_request', a);
    return true;
  }

  // ==================== 通知 ====================

  notify(userId: number, kind: NotificationKind, data: Record<string, unknown>) {
    const at = this.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO notifications (user_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, kind, JSON.stringify(data), at);
    const view: NotificationView = { id: Number(lastInsertRowid), kind, data, createdAt: at, read: false, ...this.stateOf(userId, kind, data) };
    this.hub().toUser(userId, 'notification', view);
    this.pushBadges(userId);
    // 通知只留最近 200 条
    this.db
      .prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200)')
      .run(userId, userId);
    // 浏览器推送（V0.8.0）：不开着网站的人推到电脑、手机上
    try {
      this.onNotified?.(userId, view);
    } catch (err) {
      console.error('浏览器推送出错：', err);
    }
  }

  /**
   * 某人发起的某类通知不用再看了（好友申请处理了、邀请处理了）：标成已读。
   * from 是发起人的账号编号（通知里存的是公开编号，这里换过来比较）。
   */
  clearNotifications(userId: number, kind: NotificationKind, from: number | null, roomId: number | null = null) {
    const fromRef = from === null ? null : (this.db.prepare('SELECT public_id FROM users WHERE id = ?').get(from) as { public_id: string } | undefined)?.public_id;
    const changed = this.db
      .prepare(
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = ? AND read_at IS NULL
           AND (? IS NULL OR json_extract(data, '$.from.publicId') = ?)
           AND (? IS NULL OR json_extract(data, '$.roomId') = ?)`,
      )
      .run(this.now(), userId, kind, fromRef ?? null, fromRef ?? null, roomId, roomId).changes;
    if (changed) this.pushBadges(userId);
  }

  listNotifications(userId: number, limit = 50): NotificationView[] {
    return (
      this.db.prepare('SELECT id, kind, data, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as {
        id: number;
        kind: NotificationKind;
        data: string;
        created_at: number;
        read_at: number | null;
      }[]
    ).map((n) => {
      const data = safeJson(n.data);
      return { id: n.id, kind: n.kind, data, createdAt: n.created_at, read: n.read_at !== null, ...this.stateOf(userId, n.kind, data) };
    });
  }

  /** 好友申请、对局邀请现在的状态（别处已经同意、拒绝过的，通知页上不再给按钮）。 */
  private stateOf(userId: number, kind: NotificationKind, data: Record<string, unknown>): { state?: NotificationState } {
    if (kind === 'friend_request') {
      const ref = (data.from as { publicId?: unknown } | undefined)?.publicId;
      const from = typeof ref === 'string' ? (this.db.prepare('SELECT id FROM users WHERE public_id = ? AND deleted_at IS NULL').get(ref) as { id: number } | undefined) : undefined;
      if (!from) return { state: 'gone' };
      const relation = this.relation(userId, from.id);
      return { state: relation === 'pending-in' ? 'pending' : relation === 'friends' ? 'friends' : 'gone' };
    }
    if (kind === 'join_request') {
      const ref = (data.from as { publicId?: unknown } | undefined)?.publicId;
      const from = typeof ref === 'string' ? (this.db.prepare('SELECT id FROM users WHERE public_id = ? AND deleted_at IS NULL').get(ref) as { id: number } | undefined) : undefined;
      if (!from) return { state: 'gone' };
      const roomId = Number(data.roomId);
      if (this.db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(roomId, from.id)) return { state: 'joined' };
      const pending = this.db
        .prepare("SELECT 1 FROM join_requests j JOIN rooms r ON r.id = j.room_id WHERE j.room_id = ? AND j.user_id = ? AND r.status != 'ended'")
        .get(roomId, from.id);
      return { state: pending ? 'pending' : 'gone' };
    }
    if (kind === 'room_invite') {
      const roomId = Number(data.roomId);
      if (this.db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(roomId, userId)) return { state: 'joined' };
      return { state: this.db.prepare('SELECT 1 FROM room_invites WHERE room_id = ? AND user_id = ?').get(roomId, userId) ? 'pending' : 'gone' };
    }
    return {};
  }

  readNotifications(userId: number, ids: number[] | null) {
    const at = this.now();
    if (ids === null) this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
    else {
      const mark = this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
      for (const id of ids) mark.run(at, userId, id);
    }
    this.pushBadges(userId);
  }

  /** 你在的对局开始了：告诉没开着这一局页面的成员（开着的人自己看得到）。 */
  notifyRoomStarted(roomId: number, by: string, actorId: number | null) {
    const room = this.db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId) as { name: string } | undefined;
    if (!room) return;
    const members = this.db.prepare('SELECT user_id FROM players WHERE room_id = ?').all(roomId) as { user_id: number }[];
    for (const m of members) {
      if (m.user_id === actorId || this.hub().isOnline(roomId, m.user_id)) continue;
      this.notify(m.user_id, 'room_started', { roomId, roomName: room.name, by });
    }
  }

  // ==================== 公告 ====================

  /** 这个人能看到的公告的条件（SQL 片段，参数：身份、账号编号）。 */
  /**
   * 管理员能看到、能处理哪些举报和反馈（SQL 条件，表的别名是 r）：举报的是管理员（或站长）的，只交给站长，
   * 别的管理员看不到——不然被举报的管理员能看到是谁举报了他，还能自己结案。
   */
  static reportVisibleTo(isOwner: boolean): string {
    return isOwner ? '1 = 1' : 'NOT EXISTS (SELECT 1 FROM users ta WHERE ta.id = r.target_user_id AND (ta.is_admin = 1 OR ta.is_owner = 1))';
  }

  static readonly ANNOUNCEMENT_VISIBLE = `(a.audience = 'all' OR a.audience = ? OR (a.audience = 'users' AND EXISTS (
    SELECT 1 FROM announcement_targets t WHERE t.announcement_id = a.id AND t.user_id = ?)))`;

  identityOf(userId: number): Identity | null {
    const row = this.db.prepare('SELECT is_admin, is_owner, is_guest FROM users WHERE id = ?').get(userId) as
      | { is_admin: number; is_owner: number; is_guest: number }
      | undefined;
    return row ? identityOf(row) : null;
  }

  canSeeAnnouncement(userId: number, announcementId: number): boolean {
    const identity = this.identityOf(userId);
    if (!identity) return false;
    return !!this.db
      .prepare(`SELECT 1 FROM announcements a WHERE a.id = ? AND ${Social.ANNOUNCEMENT_VISIBLE}`)
      .get(announcementId, audienceOf(identity), userId);
  }

  // ==================== 未读数 ====================

  badges(userId: number): Badges {
    const user = this.db.prepare('SELECT is_admin, is_owner, admin_perms, is_guest, created_at FROM users WHERE id = ?').get(userId) as
      | { is_admin: number; is_owner: number; admin_perms: string; is_guest: number; created_at: number }
      | undefined;
    if (!user) return { notifications: 0, announcements: 0, messages: 0, groups: 0, friendRequests: 0, admin: 0, adminReports: 0, adminViolations: 0, adminSubmissions: 0 };
    const count = (sql: string, ...params: (number | string)[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    const identity = audienceOf(identityOf(user));
    const perms = permissionsOf(user);
    const adminReports = perms.includes('reports')
      ? count(`SELECT COUNT(*) AS n FROM reports r WHERE r.handled_at IS NULL AND ${Social.reportVisibleTo(user.is_owner === 1)}`)
      : 0;
    const adminViolations = perms.includes('ban') ? count('SELECT COUNT(*) AS n FROM violations WHERE reviewed_at IS NULL') : 0;
    const adminSubmissions = perms.includes('scenarios') ? count("SELECT COUNT(*) AS n FROM scenario_submissions WHERE status = 'pending'") : 0;
    return {
      notifications: count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId),
      // 注册以前发的公告不算“没读”（列表里照样看得到）
      announcements: count(
        `SELECT COUNT(*) AS n FROM announcements a WHERE a.created_at >= ? AND ${Social.ANNOUNCEMENT_VISIBLE}
           AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?)`,
        user.created_at,
        identity,
        userId,
        userId,
      ),
      messages: count(
        `SELECT COUNT(*) AS n FROM direct_messages d WHERE d.recipient_id = ? AND d.read_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = ? AND b.blocked_id = d.sender_id)`,
        userId,
        userId,
      ),
      // 群消息：屏蔽的人发的、撤回的、「谁进群了」这类提示不算（和 groups.ts 的 unread 一样）
      groups: count(
        `SELECT COUNT(*) AS n FROM chat_group_messages x
           JOIN chat_group_members m ON m.group_id = x.group_id AND m.user_id = ?
           JOIN chat_groups g ON g.id = x.group_id AND g.disbanded_at IS NULL
           WHERE x.id > m.last_read_id AND x.kind = 'text' AND x.deleted_at IS NULL AND x.user_id IS NOT NULL AND x.user_id != ?
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = ? AND b.blocked_id = x.user_id)`,
        userId,
        userId,
        userId,
      ),
      friendRequests: count("SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending'", userId),
      admin: adminReports + adminViolations + adminSubmissions,
      adminReports,
      adminViolations,
      adminSubmissions,
    };
  }

  pushBadges(userId: number) {
    this.hub().toUser(userId, 'badges', this.badges(userId));
  }

  /** 管理员要处理的事变了（新的举报、处理了举报）：所有管理员的数字刷新一下。 */
  pushAdminBadges() {
    for (const r of this.db.prepare('SELECT id FROM users WHERE is_admin = 1').all() as { id: number }[]) this.pushBadges(r.id);
  }

  /** 有某项权限的管理员（包括站长）。 */
  adminsWith(perm: AdminPermission): number[] {
    const rows = this.db.prepare('SELECT id, is_admin, is_owner, admin_perms FROM users WHERE is_admin = 1 AND banned_at IS NULL').all() as {
      id: number;
      is_admin: number;
      is_owner: number;
      admin_perms: string;
    }[];
    return rows.filter((r) => permissionsOf(r).includes(perm)).map((r) => r.id);
  }
}

export function safeJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
