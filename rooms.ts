import { audit } from '../audit';
import { avatarUrl, permissionsOf, randomCode, requireUser, requireViewer, SESSION_COOKIE, sessionId, type User } from '../auth';
import { creditOf } from '../credit';
import { transaction, type DB } from '../db';
import {
  characterIdOf,
  canSee,
  insertLog,
  LOG_SELECT,
  LOG_SPECTATOR,
  LOG_VISIBLE,
  loadLogRow,
  spectatorCanSee,
  toLogEntry,
  type LogRow,
  type NewLog,
} from '../game/log';
import { asId, asInt, asObject, asOneOf, asString, HttpError, STREAMING, type Router } from '../http';
import type { RealtimeHub } from '../realtime';
import { BRIEF_COLUMNS, toBrief, type BriefRow } from '../social';
import {
  DIFFICULTY_LABEL,
  LANGUAGE_LABEL,
  VOICE_LABEL,
  type RoomStyle,
  type StyleDifficulty,
  type StyleLanguage,
  type StyleVoice,
} from '../../shared/game';
import type { Deps } from '../app';

export type RoomStatus = 'preparing' | 'running' | 'paused' | 'ended';
export type RoomModel = 'claude' | 'deepseek';

type RoomRow = {
  id: number;
  name: string;
  host_user_id: number;
  join_code: string;
  max_players: number;
  model: RoomModel;
  status: RoomStatus;
  /** 不计时（V0.7.1）：人不齐时，在线的人也照样一轮一轮结算。 */
  untimed: number;
  is_public: number;
  created_at: number;
  /** 有成员被封号、冻结起来的时间；没冻结是 NULL。 */
  frozen_at: number | null;
};

const NOT_FOUND = '对局不存在，或者你不在这一局里';

/** 谁在管这一局：房主，或者有「管理所有对局」权限的管理员、站长（有房主的全部权限）。写进记录里。 */
export type ManagerLabel = '房主' | '管理员' | '站长';

/**
 * 一个人和一局的关系。成员（房主、玩家）能玩；不是成员的管理员、公开对局里不是成员的人（包括游客）只能观看。
 */
export type RoomAccess = {
  room: RoomRow;
  /** 在这一局里的身份；不在这一局里（观看）是 null。 */
  role: 'host' | 'player' | null;
  /** 能管这一局：房主，或者有「管理所有对局」权限的管理员、站长。 */
  manager: boolean;
  /** 管这一局时记录里写的身份。 */
  by: ManagerLabel;
  /** 不是成员，只是在看。 */
  watching: boolean;
};
const LOG_PAGE = 50;
/** 同一局的“有新动静”最多每隔这么久通知一次“我的对局”页面。 */
const ACTIVITY_THROTTLE_MS = 2000;

/** 对局相关的通用操作，房间路由、游戏引擎和在线状态推送都要用。 */
export class Rooms {
  /** 在线情况变了以后调用（游戏引擎用它切换回合模式和计时模式）。 */
  onPresenceChanged: ((roomId: number) => void) | null = null;
  private activityTimers = new Map<number, { timer: NodeJS.Timeout; pending: boolean }>();

  constructor(
    private db: DB,
    private hub: () => RealtimeHub,
    private now: () => number = Date.now,
  ) {}

  requireMember(roomId: number, userId: number): { room: RoomRow; role: 'host' | 'player' } {
    const row = this.db
      .prepare(
        `SELECT r.*, p.role FROM rooms r JOIN players p ON p.room_id = r.id
         WHERE r.id = ? AND p.user_id = ?`,
      )
      .get(roomId, userId) as (RoomRow & { role: 'host' | 'player' }) | undefined;
    if (!row) throw new HttpError(404, NOT_FOUND);
    const { role, ...room } = row;
    return { room, role };
  }

  /** 能不能打开这一局的页面：成员；有「管理所有对局」权限的管理员、站长；公开的对局谁都能看（包括游客）。 */
  access(roomId: number, userId: number): RoomAccess {
    const row = this.db
      .prepare(
        `SELECT r.*, p.role, u.is_admin AS v_admin, u.is_owner AS v_owner, u.admin_perms AS v_perms FROM rooms r
         LEFT JOIN players p ON p.room_id = r.id AND p.user_id = ?
         LEFT JOIN users u ON u.id = ?
         WHERE r.id = ?`,
      )
      .get(userId, userId, roomId) as
      | (RoomRow & { role: 'host' | 'player' | null; v_admin: number | null; v_owner: number | null; v_perms: string | null })
      | undefined;
    if (!row) throw new HttpError(404, NOT_FOUND);
    const { role, v_admin, v_owner, v_perms, ...room } = row;
    const admin = permissionsOf({ is_admin: v_admin ?? 0, is_owner: v_owner ?? 0, admin_perms: v_perms ?? '[]' }).includes('rooms');
    if (!role && !admin && room.is_public !== 1) throw new HttpError(404, NOT_FOUND);
    return {
      room,
      role: role ?? null,
      manager: role === 'host' || admin,
      by: role === 'host' ? '房主' : v_owner === 1 ? '站长' : '管理员',
      watching: !role,
    };
  }

  /** 还能不能看这一局（推送连接心跳时检查：取消了公开、管理员被收回了权限，观看的人就看不了了）。 */
  canWatch(roomId: number, userId: number): boolean {
    try {
      this.access(roomId, userId);
      return true;
    } catch {
      return false;
    }
  }

  /** 房主或者管理员才能做的事。 */
  requireManager(roomId: number, userId: number, message: string): RoomAccess {
    const access = this.access(roomId, userId);
    if (!access.manager) throw new HttpError(access.role ? 403 : 404, access.role ? message : NOT_FOUND);
    return access;
  }

  memberIds(roomId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM players WHERE room_id = ?').all(roomId) as { user_id: number }[]).map(
      (r) => r.user_id,
    );
  }

  /**
   * 回合模式：参与游戏的人全都打开着这一局的页面；或者这一局设了「不计时」（人不齐时在线的人照样一轮一轮结算，见引擎的 roundParticipants）。
   * 其他时候是计时模式。有角色以后，“参与游戏的人”指角色还活着的玩家；还没有角色时（准备阶段）看全部成员。
   */
  presence(roomId: number) {
    const room = this.db.prepare('SELECT untimed FROM rooms WHERE id = ?').get(roomId) as { untimed: number } | undefined;
    const members = this.memberIds(roomId);
    const online = this.hub().onlineUserIds(roomId);
    // 被封禁的人回不来了，不算在“参与游戏的人”里，免得这一局永远等他
    const banned = new Set(
      (
        this.db
          .prepare('SELECT p.user_id FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? AND u.banned_at IS NOT NULL')
          .all(roomId) as { user_id: number }[]
      ).map((r) => r.user_id),
    );
    const players = (
      this.db
        .prepare('SELECT p.user_id FROM characters c JOIN players p ON p.id = c.player_id WHERE c.room_id = ? AND c.dead = 0')
        .all(roomId) as { user_id: number }[]
    )
      .map((r) => r.user_id)
      .filter((id) => !banned.has(id));
    const participants = players.length ? players : members.filter((id) => !banned.has(id));
    const allOnline = participants.length > 0 && participants.every((id) => online.has(id));
    const untimed = room?.untimed === 1;
    return {
      roomId,
      online: members.filter((id) => online.has(id)),
      allOnline,
      untimed,
      mode: allOnline || untimed ? ('round' as const) : ('timed' as const),
    };
  }

  broadcastPresence(roomId: number) {
    const presence = this.presence(roomId);
    this.hub().toRoom(roomId, 'presence', presence);
    for (const userId of this.memberIds(roomId)) {
      this.hub().toLobby(userId, 'room-presence', { roomId, onlineCount: presence.online.length });
    }
  }

  onPresenceChange(roomId: number, userId: number, online = true) {
    const now = this.now();
    this.db.prepare('UPDATE players SET last_seen_at = ? WHERE room_id = ? AND user_id = ?').run(now, roomId, userId);
    if (!online) {
      // 离开时记下看到了哪一条：下次回来，这之后的就是“你不在时发生的事”
      this.db
        .prepare(
          `UPDATE players SET left_at = ?, seen_log_id = (SELECT COALESCE(MAX(id), 0) FROM log_entries WHERE room_id = ?)
           WHERE room_id = ? AND user_id = ?`,
        )
        .run(now, roomId, roomId, userId);
    }
    this.broadcastPresence(roomId);
    this.onPresenceChanged?.(roomId);
  }

  /**
   * 这个人上次离开这一局时看到了哪一条记录、什么时候离开的。从没离开过是 null。
   * 升级以前离开的，没有记下编号，按离开的时间推算。
   */
  seenMark(roomId: number, userId: number): { logId: number; at: number | null } | null {
    const row = this.db.prepare('SELECT seen_log_id, left_at, last_seen_at FROM players WHERE room_id = ? AND user_id = ?').get(roomId, userId) as
      | { seen_log_id: number | null; left_at: number | null; last_seen_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.seen_log_id !== null) return { logId: row.seen_log_id, at: row.left_at };
    if (row.last_seen_at === null) return null;
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM log_entries WHERE room_id = ? AND created_at <= ?').get(roomId, row.last_seen_at) as {
      id: number;
    };
    return { logId: r.id, at: row.last_seen_at };
  }

  /**
   * 这一局有了新动静（新记录、行动状态变了）：让成员的“我的对局”页面重新拉一下待办。
   * 结算时一下子会有好几条，所以同一局两秒内只通知一次，最后一次的变化会在两秒后补上。
   */
  activity(roomId: number) {
    const waiting = this.activityTimers.get(roomId);
    if (waiting) {
      waiting.pending = true;
      return;
    }
    for (const userId of this.memberIds(roomId)) this.hub().toLobby(userId, 'room-activity', { roomId });
    const entry = {
      pending: false,
      timer: setTimeout(() => {
        this.activityTimers.delete(roomId);
        if (!entry.pending) return;
        try {
          this.activity(roomId);
        } catch (err) {
          console.error('通知“我的对局”时出错：', err instanceof Error ? err.message : err);
        }
      }, ACTIVITY_THROTTLE_MS),
    };
    entry.timer.unref();
    this.activityTimers.set(roomId, entry);
  }

  /** 服务器停止前调用：不再发还没发出的通知。 */
  stop() {
    for (const { timer } of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
  }

  notifyRoomsChanged(roomId: number) {
    for (const userId of this.memberIds(roomId)) this.hub().toLobby(userId, 'rooms-changed', { roomId });
    this.notifyHall(roomId);
  }

  /** 公开的对局有了变化（有人加入、开局、结束、换了剧本）：开着大厅的人刷新一下。force：刚取消公开、刚删除的也要通知。 */
  notifyHall(roomId: number, force = false) {
    const row = this.db.prepare('SELECT is_public FROM rooms WHERE id = ?').get(roomId) as { is_public: number } | undefined;
    if (force || row?.is_public === 1) this.hub().toAllLobbies('hall-changed', { roomId });
  }

  /** 写一条记录并推给能看到它的人。 */
  log(entry: Omit<NewLog, 'now'>) {
    const id = insertLog(this.db, { ...entry, now: this.now() });
    this.publishLog(id);
    return id;
  }

  /** 普通的公开记录（系统消息、场外聊天）。 */
  addLog(roomId: number, kind: LogRow['kind'], text: string, authorUserId: number | null = null) {
    const id = this.log({ roomId, kind, text, authorUserId });
    return toLogEntry(loadLogRow(this.db, id)!, null);
  }

  /** 把一条已经写好的记录推给在线、并且有权看到它的人；每个人看到的内容按他的角色过滤，观看的人只看到故事。 */
  publishLog(entryId: number) {
    const row = loadLogRow(this.db, entryId);
    if (!row) return;
    this.hub().toRoomEach(row.room_id, 'log', (userId, watch) => {
      if (watch) return spectatorCanSee(row) ? toLogEntry(row, null) : undefined;
      const characterId = characterIdOf(this.db, row.room_id, userId);
      return canSee(this.db, row, userId, characterId) ? toLogEntry(row, characterId) : undefined;
    });
    this.activity(row.room_id);
  }

  roomDetail(roomId: number, userId: number) {
    const access = this.access(roomId, userId);
    const { room, role, manager } = access;
    const online = this.hub().onlineUserIds(roomId);
    const members = (
      this.db
        .prepare(
          `SELECT u.id, u.public_id, u.display_name, u.avatar_at, p.role, p.last_seen_at, c.name AS character_name
           FROM players p JOIN users u ON u.id = p.user_id LEFT JOIN characters c ON c.player_id = p.id
           WHERE p.room_id = ? ORDER BY p.role = 'host' DESC, p.joined_at`,
        )
        .all(roomId) as {
        id: number;
        public_id: string;
        display_name: string;
        avatar_at: number | null;
        role: 'host' | 'player';
        last_seen_at: number | null;
        character_name: string | null;
      }[]
    ).map((m) => ({
      userId: m.id,
      publicId: m.public_id,
      displayName: m.display_name,
      avatar: avatarUrl(m.public_id, m.avatar_at),
      role: m.role,
      online: online.has(m.id),
      lastSeenAt: m.last_seen_at,
      characterName: m.character_name,
    }));
    const invites = manager
      ? (
          this.db
            .prepare(
              `SELECT ${BRIEF_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}, i.created_at AS invited_at
               FROM room_invites i JOIN users u ON u.id = i.user_id WHERE i.room_id = ? ORDER BY i.created_at`,
            )
            .all(roomId) as (BriefRow & { invited_at: number })[]
        ).map((r) => ({ ...toBrief(r), at: r.invited_at }))
      : [];
    // 在大厅里申请加入的人（房主和能管这一局的管理员看得到）
    const joinRequests = manager
      ? (
          this.db
            .prepare(
              `SELECT ${BRIEF_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}, j.created_at AS asked_at
               FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.room_id = ? ORDER BY j.created_at`,
            )
            .all(roomId) as (BriefRow & { asked_at: number })[]
        ).map((r) => ({ ...toBrief(r), at: r.asked_at }))
      : [];
    const requested = role === null && !!this.db.prepare('SELECT 1 FROM join_requests WHERE room_id = ? AND user_id = ?').get(roomId, userId);
    return {
      room: {
        id: room.id,
        name: room.name,
        status: room.status,
        model: room.model,
        maxPlayers: room.max_players,
        untimed: room.untimed === 1,
        isPublic: room.is_public === 1,
        /** 有成员被封号，冻结到他解封。 */
        frozen: room.frozen_at !== null,
        createdAt: room.created_at,
        isHost: role === 'host',
        // 对局码只给房主（和管理员）看，由他们决定发给谁
        joinCode: manager ? room.join_code : null,
      },
      viewer: { role, manager, watching: access.watching, by: access.by, requested },
      members,
      invites,
      joinRequests,
      presence: this.presence(roomId),
    };
  }
}

/**
 * 删除对局：聊天记录、笔记、角色、行动等会跟着一起删掉（数据库里设了级联删除）。
 * 正在生成的剧本停下；开着这一局的人收到通知，推送断开。
 */
export function deleteRoom({ db, hub, rooms, studio }: Pick<Deps, 'db' | 'hub' | 'rooms' | 'studio'>, roomId: number, name: string, by: ManagerLabel) {
  const memberIds = rooms.memberIds(roomId);
  const wasPublic = (db.prepare('SELECT is_public FROM rooms WHERE id = ?').get(roomId) as { is_public: number } | undefined)?.is_public === 1;
  studio.cancelRoom(roomId);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  hub.toRoom(roomId, 'deleted', { roomId, name, by });
  hub.closeRoom(roomId);
  for (const id of memberIds) hub.toLobby(id, 'rooms-changed', { roomId });
  if (wasPublic) hub.toAllLobbies('hall-changed', { roomId });
}

/** 大厅里的一局（公开的、还没结束的）。不给对局码，剧本只给标题这些公开的信息。 */
export type HallRoom = {
  id: number;
  name: string;
  status: RoomStatus;
  host: string;
  members: number;
  /** 最多几个人：房主设的人数上限，选了剧本以后还不能超过剧本的上限。 */
  limit: number;
  full: boolean;
  /** 我已经在这一局里了。 */
  joined: boolean;
  /** 我在大厅里申请加入了，等房主同意。 */
  requested: boolean;
  online: number;
  /** 不计时：人不齐也照样一轮一轮结算。 */
  untimed: boolean;
  createdAt: number;
  lastActivityAt: number;
  scenario: {
    title: string;
    genre: string;
    tone: string;
    players: { min: number; max: number };
    expectedDays: number;
    relation: string;
    stress: boolean;
    /** 分区（V0.7.0：大厅里按分区筛选）；没写分区的是 null。 */
    category: string | null;
    /** 地下城的难度和大小。 */
    dungeon: { level: number; size: string } | null;
  } | null;
  /** AI 正在写剧本。 */
  generating: boolean;
};

export function registerRoomRoutes(router: Router, deps: Deps) {
  const { db, hub, rooms, engine, studio, social, limiter, now } = deps;

  // 我的对局（游客没有对局）
  router.get('/api/rooms', (ctx) => {
    const user = requireViewer(ctx);
    if (user.isGuest) return { now: engine.now(), credit: creditOf(db, user.id), rooms: [] };
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.status, r.model, r.max_players, r.is_public, r.created_at, p.role,
           (SELECT COUNT(*) FROM players p2 WHERE p2.room_id = r.id) AS member_count,
           (SELECT MAX(l.created_at) FROM log_entries l WHERE l.room_id = r.id) AS last_activity,
           (SELECT json_extract(s.data, '$.title') FROM scenarios s WHERE s.room_id = r.id) AS scenario_title
         FROM players p JOIN rooms r ON r.id = p.room_id
         WHERE p.user_id = ?
         ORDER BY (r.status = 'ended'), COALESCE(last_activity, r.created_at) DESC`,
      )
      .all(user.id) as {
      id: number;
      name: string;
      status: RoomStatus;
      model: RoomModel;
      max_players: number;
      is_public: number;
      created_at: number;
      role: 'host' | 'player';
      member_count: number;
      last_activity: number | null;
      scenario_title: string | null;
    }[];
    return {
      // 服务器的当前时间，网页用它校正倒计时
      now: engine.now(),
      credit: creditOf(db, user.id),
      rooms: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        model: r.model,
        maxPlayers: r.max_players,
        memberCount: r.member_count,
        onlineCount: hub.onlineUserIds(r.id).size,
        isHost: r.role === 'host',
        isPublic: r.is_public === 1,
        scenarioTitle: r.scenario_title,
        lastActivityAt: r.last_activity ?? r.created_at,
        todo: engine.roomTodo(r.id, user.id, r.role, r.status),
      })),
    };
  });

  router.post('/api/rooms', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    const name = asString(body.name, { max: 30, message: '对局名称要在1～30个字之间' });
    const maxPlayers = asInt(body.maxPlayers, { min: 1, max: 6, message: '人数上限要在1～6人之间' });
    // 剧本大厅里「用这个剧本开局」：建好就选上这个剧本（V0.5.0）
    const scenarioKey = body.scenarioKey === undefined || body.scenarioKey === null ? null : asString(body.scenarioKey, { max: 80, message: '没有这个剧本' });
    // 「始终计时」V0.7.1 去掉了：旧版网页发来的 alwaysTimed 不看。mod5e：用 5E 规则玩这个剧本（V1.0.0）
    const roomId = createRoom(user, { name, maxPlayers, untimed: body.untimed === true, isPublic: body.isPublic === true, scenarioKey, mod5e: body.mod5e === true });
    ctx.status = 201;
    return rooms.roomDetail(roomId, user.id);
  });

  /**
   * 「再刷一次」（V0.7.0）：一局打完以后，用同一个剧本（剧本大厅里的，地下城会重新挑这一局的变化）、同样的设置再开一局，
   * 这一局的其他人都收到邀请。只有这一局里的人能用。
   */
  router.post('/api/rooms/:id/replay', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const room = db.prepare('SELECT id, name, status, max_players, untimed, is_public FROM rooms WHERE id = ?').get(roomId) as
      | { id: number; name: string; status: string; max_players: number; untimed: number; is_public: number }
      | undefined;
    if (!room || !db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(roomId, user.id)) throw new HttpError(404, '对局不存在');
    if (room.status !== 'ended') throw new HttpError(409, '这一局还没结束');
    const stored = db.prepare('SELECT source, scenario_key, data FROM scenarios WHERE room_id = ?').get(roomId) as
      | { source: string; scenario_key: string | null; data: string }
      | undefined;
    if (!stored || stored.source !== 'builtin' || !stored.scenario_key) throw new HttpError(409, '只有剧本大厅、地下城里的剧本能再刷一次');
    // 用 5E 规则玩的（V1.0.0）：新的一局也用 5E 规则
    const mod5e = !!(JSON.parse(stored.data) as { mod5e?: unknown }).mod5e;
    const name = [...room.name.replace(/（再刷一次）$/, '')].slice(0, 24).join('') + '（再刷一次）';
    const fresh = createRoom(user, {
      name,
      maxPlayers: room.max_players,
      untimed: room.untimed === 1,
      isPublic: room.is_public === 1,
      scenarioKey: stored.scenario_key,
      mod5e,
    });
    const others = db
      .prepare(
        `SELECT p.user_id FROM players p JOIN users u ON u.id = p.user_id
         WHERE p.room_id = ? AND p.user_id != ? AND u.is_guest = 0 AND u.deleted_at IS NULL AND u.banned_at IS NULL`,
      )
      .all(roomId, user.id) as { user_id: number }[];
    for (const o of others) {
      if (social.blockedEither(user.id, o.user_id)) continue;
      const added = db
        .prepare('INSERT INTO room_invites (room_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (room_id, user_id) DO NOTHING')
        .run(fresh, o.user_id, user.id, now()).changes;
      if (added) social.notify(o.user_id, 'room_invite', { from: social.brief(user.id), roomId: fresh, roomName: name });
    }
    ctx.status = 201;
    return rooms.roomDetail(fresh, user.id);
  });

  /** 建一局（房主是 user），给了剧本就直接选上。 */
  function createRoom(
    user: Pick<User, 'id' | 'displayName'>,
    o: { name: string; maxPlayers: number; untimed: boolean; isPublic: boolean; scenarioKey: string | null; mod5e?: boolean },
  ): number {
    const { name, maxPlayers, untimed, isPublic, scenarioKey } = o;
    // 现在只用 Claude 主持，建对局时不再让选模型；请求里带了 model 也不看
    const model: RoomModel = 'claude';
    const scenario = scenarioKey === null ? null : engine.libraryScenario(scenarioKey);
    if (scenario && maxPlayers > scenario.players.max) {
      throw new HttpError(400, `《${scenario.title}》最多${scenario.players.max}个人玩，人数上限不能超过${scenario.players.max}`);
    }

    const at = now();
    let code = randomCode(6);
    while (db.prepare('SELECT 1 FROM rooms WHERE join_code = ?').get(code)) code = randomCode(6);

    const roomId = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO rooms (name, host_user_id, join_code, max_players, model, untimed, is_public, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(name, user.id, code, maxPlayers, model, untimed ? 1 : 0, isPublic ? 1 : 0, at);
      const id = Number(lastInsertRowid);
      db.prepare("INSERT INTO players (room_id, user_id, role, joined_at) VALUES (?, ?, 'host', ?)").run(id, user.id, at);
      return id;
    });
    rooms.addLog(roomId, 'system', `${user.displayName} 创建了这一局${isPublic ? '，在大厅里公开' : ''}${untimed ? '，不计时' : ''}`);
    if (scenario && scenarioKey) engine.applyScenarioChoice(roomId, { scenario, source: 'builtin', key: scenarioKey }, '房主', { mod5e: o.mod5e === true });
    rooms.notifyHall(roomId);
    return roomId;
  }

  /** 加入一局（用对局码、接受邀请、房主同意了大厅里的申请）：已经在里面的直接返回；结束了的、满员的不能加入。 */
  function joinRoom(room: Pick<RoomRow, 'id' | 'status' | 'max_players'>, user: Pick<User, 'id' | 'displayName'>) {
    if (db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(room.id, user.id)) {
      return { roomId: room.id, alreadyMember: true };
    }
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');

    // 选了剧本以后，人数还不能超过剧本的上限；AI 正在生成、转换剧本时，也不能超过它要的人数
    const limit = Math.min(room.max_players, engine.scenarioMaxPlayers(room.id) ?? room.max_players);
    const reserved = studio.joinLimit(room.id);
    const joined = transaction(db, () => {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM players WHERE room_id = ?').get(room.id) as { n: number };
      if (n >= limit) return 'full';
      if (reserved && n >= reserved.limit) return 'reserved';
      db.prepare("INSERT INTO players (room_id, user_id, role, joined_at) VALUES (?, ?, 'player', ?)").run(room.id, user.id, now());
      // 进来了，之前收到的邀请、在大厅里发的加入申请都用不着了
      db.prepare('DELETE FROM room_invites WHERE room_id = ? AND user_id = ?').run(room.id, user.id);
      db.prepare('DELETE FROM join_requests WHERE room_id = ? AND user_id = ?').run(room.id, user.id);
      return 'ok';
    });
    if (joined === 'full') throw new HttpError(409, `这一局已经满员了（${limit}人）`);
    if (joined === 'reserved') throw new HttpError(409, reserved!.message);

    social.clearNotifications(user.id, 'room_invite', null, room.id);
    rooms.addLog(room.id, 'system', `${user.displayName} 加入了这一局`);
    hub.toRoom(room.id, 'members', { roomId: room.id });
    rooms.broadcastPresence(room.id);
    rooms.notifyRoomsChanged(room.id);
    engine.pushGame(room.id);
    return { roomId: room.id, alreadyMember: false };
  }

  router.post('/api/rooms/join', (ctx) => {
    const user = requireUser(ctx);
    // 防止有人一个个试对局码
    limiter.hitAddress('joinCode', ctx.req);
    const body = asObject(ctx.body);
    const code = asString(body.code, { max: 12, message: '请填写对局码' }).toUpperCase();
    const room = db.prepare('SELECT id, status, max_players FROM rooms WHERE join_code = ?').get(code) as
      | Pick<RoomRow, 'id' | 'status' | 'max_players'>
      | undefined;
    if (!room) throw new HttpError(404, '对局码不对，请找房主确认一下');
    return joinRoom(room, user);
  });

  // ---------- 大厅：公开的对局，能玩的人可以直接加入，谁都能观看（包括游客） ----------

  type HallRow = {
    id: number;
    name: string;
    status: RoomStatus;
    max_players: number;
    untimed: number;
    created_at: number;
    host_name: string;
    member_count: number;
    last_activity: number | null;
    joined: number;
    requested: number;
    s_title: string | null;
    s_genre: string | null;
    s_tone: string | null;
    s_min: number | null;
    s_max: number | null;
    s_days: number | null;
    s_relation: string | null;
    s_stress: number | null;
    s_category: string | null;
    s_level: number | null;
    s_size: string | null;
  };

  const HALL_SELECT = `SELECT r.id, r.name, r.status, r.max_players, r.untimed, r.created_at, u.display_name AS host_name,
       (SELECT COUNT(*) FROM players p WHERE p.room_id = r.id) AS member_count,
       (SELECT MAX(l.created_at) FROM log_entries l WHERE l.room_id = r.id) AS last_activity,
       EXISTS (SELECT 1 FROM players p WHERE p.room_id = r.id AND p.user_id = ?) AS joined,
       EXISTS (SELECT 1 FROM join_requests j WHERE j.room_id = r.id AND j.user_id = ?) AS requested,
       json_extract(s.data, '$.title') AS s_title, json_extract(s.data, '$.genre') AS s_genre,
       json_extract(s.data, '$.tone') AS s_tone, json_extract(s.data, '$.players.min') AS s_min,
       json_extract(s.data, '$.players.max') AS s_max, json_extract(s.data, '$.expectedDays') AS s_days,
       json_extract(s.data, '$.relation') AS s_relation, json_extract(s.data, '$.stress') AS s_stress,
       json_extract(s.data, '$.category') AS s_category,
       json_extract(s.data, '$.dungeon.level') AS s_level, json_extract(s.data, '$.dungeon.size') AS s_size
     FROM rooms r JOIN users u ON u.id = r.host_user_id LEFT JOIN scenarios s ON s.room_id = r.id`;

  const toHall = (r: HallRow): HallRoom => {
    const limit = Math.min(r.max_players, r.s_max ?? r.max_players);
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      host: r.host_name,
      members: r.member_count,
      limit,
      full: r.member_count >= limit,
      joined: r.joined === 1,
      requested: r.requested === 1,
      online: hub.onlineUserIds(r.id).size,
      untimed: r.untimed === 1,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity ?? r.created_at,
      scenario: r.s_title
        ? {
            title: r.s_title,
            genre: r.s_genre ?? '',
            tone: r.s_tone ?? '',
            players: { min: r.s_min ?? 1, max: r.s_max ?? limit },
            expectedDays: r.s_days ?? 1,
            relation: r.s_relation ?? 'coop',
            stress: r.s_stress === 1,
            category: r.s_category ?? null,
            dungeon: r.s_level ? { level: r.s_level, size: r.s_size ?? 'small' } : null,
          }
        : null,
      generating: engine.scenarioJobRunning(r.id),
    };
  };

  router.get('/api/hall', (ctx) => {
    const user = requireViewer(ctx);
    // 自己在的公开对局也照常列出来（joined 标着已经加入）；「我的对局」是单独的一页
    const open = db
      .prepare(
        `${HALL_SELECT}
         WHERE r.is_public = 1 AND r.status != 'ended' AND u.banned_at IS NULL
         ORDER BY (r.status != 'preparing'), COALESCE(last_activity, r.created_at) DESC
         LIMIT 100`,
      )
      .all(user.id, user.id) as HallRow[];
    // 结束了的对局不在大厅里（V0.7.0）：自己玩过的在「我的对局」里
    return { rooms: open.map(toHall) };
  });

  // 在大厅里申请加入公开的对局：房主（或能管这一局的管理员）同意了才进来，结果会通知他。
  // 房主邀请过的直接进来；用对局码加入的不用申请（对局码是房主给的）
  router.post('/api/hall/:id/join', (ctx) => {
    const user = requireUser(ctx);
    const room = db.prepare('SELECT id, name, status, max_players, is_public, host_user_id FROM rooms WHERE id = ?').get(asId(ctx.params.id)) as
      | Pick<RoomRow, 'id' | 'name' | 'status' | 'max_players' | 'is_public' | 'host_user_id'>
      | undefined;
    const member = !!room && !!db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(room.id, user.id);
    // 不公开的对局只能用对局码、邀请加入；不说它存不存在
    if (!room || (room.is_public !== 1 && !member)) {
      throw new HttpError(404, '这一局不在大厅里了（可能房主取消了公开），需要对局码才能加入');
    }
    if (member) return { roomId: room.id, alreadyMember: true };
    if (db.prepare('SELECT 1 FROM room_invites WHERE room_id = ? AND user_id = ?').get(room.id, user.id)) return joinRoom(room, user);
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    const limit = Math.min(room.max_players, engine.scenarioMaxPlayers(room.id) ?? room.max_players);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM players WHERE room_id = ?').get(room.id) as { n: number };
    if (n >= limit) throw new HttpError(409, `这一局已经满员了（${limit}人）`);
    limiter.hit('joinRequest', user.id);
    const fresh = db.prepare('INSERT INTO join_requests (room_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (room_id, user_id) DO NOTHING').run(room.id, user.id, now()).changes;
    if (fresh) {
      social.notify(room.host_user_id, 'join_request', { from: social.brief(user.id), roomId: room.id, roomName: room.name });
      hub.toRoom(room.id, 'members', { roomId: room.id });
    }
    return { roomId: room.id, requested: true };
  });

  // 撤回自己在大厅里发的加入申请
  router.delete('/api/hall/:id/join', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const removed = db.prepare('DELETE FROM join_requests WHERE room_id = ? AND user_id = ?').run(roomId, user.id).changes;
    if (removed) hub.toRoom(roomId, 'members', { roomId });
    return { requested: false };
  });

  // 房主（或能管这一局的管理员）处理大厅里的加入申请：approve 同意（满员、结束了的进不来）、reject 拒绝；都会通知申请的人
  router.post('/api/rooms/:id/join-requests/:publicId/:decision', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能处理加入申请');
    const decision = asOneOf(ctx.params.decision, ['approve', 'reject'] as const, '不认识的操作');
    const target = db.prepare('SELECT id, display_name FROM users WHERE public_id = ? AND deleted_at IS NULL').get(ctx.params.publicId) as
      | { id: number; display_name: string }
      | undefined;
    if (!target || !db.prepare('SELECT 1 FROM join_requests WHERE room_id = ? AND user_id = ?').get(roomId, target.id)) {
      throw new HttpError(404, '这个申请已经处理过了，或者对方撤回了');
    }
    if (decision === 'approve') {
      joinRoom(room, { id: target.id, displayName: target.display_name });
    } else {
      db.prepare('DELETE FROM join_requests WHERE room_id = ? AND user_id = ?').run(roomId, target.id);
      hub.toRoom(roomId, 'members', { roomId });
    }
    social.notify(target.id, 'join_result', { roomId, roomName: room.name, approved: decision === 'approve', by });
    social.clearNotifications(user.id, 'join_request', target.id, roomId);
    return rooms.roomDetail(roomId, user.id);
  });

  // 房主（或管理员）把对局设成公开（出现在大厅里，谁都能直接加入、观看）或者取消公开：{ isPublic: true/false }
  router.put('/api/rooms/:id/public', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能设置公开');
    const isPublic = asObject(ctx.body).isPublic;
    if (typeof isPublic !== 'boolean') throw new HttpError(400, '请求格式不对');
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    if ((room.is_public === 1) === isPublic) return rooms.roomDetail(roomId, user.id);
    db.prepare('UPDATE rooms SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, roomId);
    rooms.addLog(roomId, 'system', isPublic ? `${by}把这一局设成了公开：大厅里的人可以直接加入、观看` : `${by}取消了公开：这一局不在大厅里了，要对局码或者邀请才能加入`);
    if (by !== '房主') audit(db, user.id, isPublic ? '把对局设成公开' : '取消对局公开', `对局 ${roomId}「${room.name}」`, now());
    hub.toRoom(roomId, 'room', { roomId, status: room.status, isPublic });
    // 取消公开：正在观看的人断开（有权限的管理员会自动重新连上）
    if (!isPublic) hub.closeWatches({ roomId });
    rooms.notifyHall(roomId, true);
    return rooms.roomDetail(roomId, user.id);
  });

  // 房主（或管理员）设成不计时（人不齐时在线的人也照样一轮一轮结算）或者取消：{ untimed: true/false }（V0.7.1）
  router.put('/api/rooms/:id/untimed', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能改计时');
    const untimed = asObject(ctx.body).untimed;
    if (typeof untimed !== 'boolean') throw new HttpError(400, '请求格式不对');
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    if ((room.untimed === 1) === untimed) return rooms.roomDetail(roomId, user.id);
    db.prepare('UPDATE rooms SET untimed = ? WHERE id = ?').run(untimed ? 1 : 0, roomId);
    rooms.addLog(roomId, 'system', untimed ? `${by}把这一局设成了不计时：人不齐也照样结算` : `${by}取消了不计时：人不齐时按现实时间计时`);
    if (by !== '房主') audit(db, user.id, untimed ? '把对局设成不计时' : '取消对局不计时', `对局 ${roomId}「${room.name}」`, now());
    hub.toRoom(roomId, 'room', { roomId, status: room.status, untimed });
    // 模式可能变了：推给开着页面的人，等着的行动按新的模式转过去（回合凑齐了就结算）
    rooms.broadcastPresence(roomId);
    engine.syncRoom(roomId);
    rooms.notifyHall(roomId);
    return rooms.roomDetail(roomId, user.id);
  });

  router.get('/api/rooms/:id', (ctx) => {
    const user = requireViewer(ctx);
    return rooms.roomDetail(asId(ctx.params.id), user.id);
  });

  router.post('/api/rooms/:id/status', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能改对局状态');
    const body = asObject(ctx.body);
    const next = asOneOf(body.status, ['running', 'paused', 'ended'] as const, '状态不对');
    // 开局时可以顺便选这一局的主持模型（null 是跟随网站设置）；开局的记录里会写上用的是哪个
    if (next === 'running' && room.status === 'preparing' && body.dmModel !== undefined) {
      if (body.dmModel !== null && typeof body.dmModel !== 'string') throw new HttpError(400, '模型不对');
      engine.setDmModel(roomId, body.dmModel as string | null, by, { quiet: true });
    }
    const status = engine.changeStatus(roomId, next, by, user.id);
    // 准备阶段直接结束：正在生成的剧本用不上了，停下来，别再花钱
    if (status === 'ended') studio.cancelRoom(roomId);
    if (by !== '房主') audit(db, user.id, '改对局状态', `对局 ${roomId}「${room.name}」：${room.status} → ${status}`, now());
    return { status };
  });

  // 这一局的主持模型：{ dmModel: 模型 | null }（null 是跟随网站设置）。开局前后都能改，记录里会告诉大家
  router.put('/api/rooms/:id/model', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { by } = rooms.requireManager(roomId, user.id, '只有房主能选主持模型');
    const model = asObject(ctx.body).dmModel;
    if (model !== null && typeof model !== 'string') throw new HttpError(400, '模型不对');
    engine.setDmModel(roomId, model, by);
    return engine.gameState(roomId, user.id);
  });

  // 主持风格（V0.6.0）：{ voice, difficulty, death, language }。开局前后都能改，改了以后的结算按新的来；记录里告诉大家
  router.put('/api/rooms/:id/style', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能改主持风格');
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    const body = asObject(ctx.body);
    if (typeof body.death !== 'boolean') throw new HttpError(400, '请说明角色会不会死');
    const style: RoomStyle = {
      voice: asOneOf(body.voice, Object.keys(VOICE_LABEL) as StyleVoice[], '文风不对'),
      difficulty: asOneOf(body.difficulty, Object.keys(DIFFICULTY_LABEL) as StyleDifficulty[], '难度不对'),
      death: body.death,
      language: asOneOf(body.language, Object.keys(LANGUAGE_LABEL) as StyleLanguage[], '语言不对'),
    };
    const before = engine.roomStyle(roomId);
    if (JSON.stringify(before) !== JSON.stringify(style)) {
      engine.setRoomStyle(roomId, style);
      rooms.addLog(
        roomId,
        'system',
        `${by === '房主' ? '房主' : by}把主持风格改成了：文风${VOICE_LABEL[style.voice]}，难度${DIFFICULTY_LABEL[style.difficulty]}，${style.death ? '角色会死' : '角色不会死'}，用${LANGUAGE_LABEL[style.language]}主持`,
      );
    }
    return engine.gameState(roomId, user.id);
  });

  router.delete('/api/rooms/:id', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room, by } = rooms.requireManager(roomId, user.id, '只有房主能删除对局');
    deleteRoom(deps, roomId, room.name, by);
    if (by !== '房主') audit(db, user.id, '删除对局', `对局 ${roomId}「${room.name}」`, now());
    return { deleted: true };
  });

  router.get('/api/rooms/:id/log', (ctx) => {
    const user = requireViewer(ctx);
    const roomId = asId(ctx.params.id);
    const { watching } = rooms.access(roomId, user.id);
    const characterId = watching ? null : characterIdOf(db, roomId, user.id);
    const beforeParam = ctx.url.searchParams.get('before');
    const before = beforeParam ? asId(beforeParam) : Number.MAX_SAFE_INTEGER;
    const rows = (
      watching
        ? db.prepare(`${LOG_SELECT} WHERE l.room_id = ? AND l.id < ? AND ${LOG_SPECTATOR} ORDER BY l.id DESC LIMIT ?`).all(roomId, before, LOG_PAGE + 1)
        : db
            .prepare(`${LOG_SELECT} WHERE l.room_id = ? AND l.id < ? AND ${LOG_VISIBLE} ORDER BY l.id DESC LIMIT ?`)
            .all(roomId, before, user.id, characterId ?? -1, LOG_PAGE + 1)
    ) as LogRow[];
    const hasMore = rows.length > LOG_PAGE;
    return { entries: rows.slice(0, LOG_PAGE).reverse().map((row) => toLogEntry(row, characterId)), hasMore };
  });

  router.post('/api/rooms/:id/chat', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room } = rooms.requireMember(roomId, user.id);
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    const text = asString(asObject(ctx.body).text, { max: 500, message: '消息要在1～500个字之间' });
    limiter.hit('roomChat', user.id);
    ctx.status = 201;
    return { entry: rooms.addLog(roomId, 'ooc', text, user.id) };
  });

  // ---------- 邀请好友：房主（或管理员）邀请，对方在通知里点“加入”就能进来，不用对局码 ----------

  router.post('/api/rooms/:id/invites', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { room } = rooms.requireManager(roomId, user.id, '只有房主能邀请别人');
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了');
    // user：好友的公开编号（以前的版本发的是用户名，也认）
    const body = asObject(ctx.body);
    const target = social.findUser(asString(body.user ?? body.username, { max: 40, message: '请选一个好友' }));
    if (!target || target.banned_at !== null || target.is_guest === 1 || target.id === user.id) throw new HttpError(404, '没有这个用户');
    if (!social.areFriends(user.id, target.id)) throw new HttpError(403, '只能邀请好友');
    if (social.blockedEither(user.id, target.id)) throw new HttpError(403, '没法邀请这个人');
    if (db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?').get(roomId, target.id)) throw new HttpError(409, '他已经在这一局里了');
    limiter.hit('invite', user.id);
    const fresh = db
      .prepare('INSERT INTO room_invites (room_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (room_id, user_id) DO NOTHING')
      .run(roomId, target.id, user.id, now()).changes;
    if (fresh) social.notify(target.id, 'room_invite', { from: social.brief(user.id), roomId, roomName: room.name });
    hub.toRoom(roomId, 'members', { roomId });
    ctx.status = 201;
    return rooms.roomDetail(roomId, user.id);
  });

  router.delete('/api/rooms/:id/invites/:ref', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireManager(roomId, user.id, '只有房主能撤回邀请');
    const target = social.findUser(ctx.params.ref ?? '');
    if (!target) throw new HttpError(404, '没有这个用户');
    db.prepare('DELETE FROM room_invites WHERE room_id = ? AND user_id = ?').run(roomId, target.id);
    social.clearNotifications(target.id, 'room_invite', null, roomId);
    hub.toRoom(roomId, 'members', { roomId });
    return rooms.roomDetail(roomId, user.id);
  });

  router.post('/api/rooms/:id/invites/accept', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const invite = db.prepare('SELECT invited_by FROM room_invites WHERE room_id = ? AND user_id = ?').get(roomId, user.id);
    const room = db.prepare('SELECT id, status, max_players FROM rooms WHERE id = ?').get(roomId) as Pick<RoomRow, 'id' | 'status' | 'max_players'> | undefined;
    if (!invite || !room) {
      social.clearNotifications(user.id, 'room_invite', null, roomId);
      throw new HttpError(404, '这个邀请已经失效了（可能被撤回了，或者对局被删除了）');
    }
    return joinRoom(room, user);
  });

  router.post('/api/rooms/:id/invites/decline', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const removed = db.prepare('DELETE FROM room_invites WHERE room_id = ? AND user_id = ?').run(roomId, user.id).changes;
    social.clearNotifications(user.id, 'room_invite', null, roomId);
    // 真的有这个邀请才告诉这一局（不然谁都能让任何一局的人一遍遍刷新）
    if (removed) hub.toRoom(roomId, 'members', { roomId });
    return { ok: true };
  });

  // ---------- 个人笔记：默认只有自己看得到，可以分享给这一局里指定的人（只能看，不能改） ----------

  const idsOf = (text: string | null | undefined): number[] => {
    try {
      const value = JSON.parse(text || '[]');
      return Array.isArray(value) ? value.filter((x) => Number.isInteger(x)) : [];
    } catch {
      return [];
    }
  };

  /** 别人看到的这份笔记：作者、内容、更新时间。 */
  function sharedNote(roomId: number, authorId: number) {
    const row = db
      .prepare(
        `SELECT n.content, n.updated_at, u.id, u.display_name, c.name AS character_name
         FROM notes n JOIN users u ON u.id = n.author_user_id
         JOIN players p ON p.room_id = n.room_id AND p.user_id = n.author_user_id
         LEFT JOIN characters c ON c.player_id = p.id
         WHERE n.room_id = ? AND n.author_user_id = ?`,
      )
      .get(roomId, authorId) as
      | { content: string; updated_at: number; id: number; display_name: string; character_name: string | null }
      | undefined;
    if (!row) return null;
    return {
      author: { id: row.id, displayName: row.display_name, characterName: row.character_name },
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  /** 笔记有变化时，推给分享给的人（他们开着这一局的页面才收得到）。 */
  function pushSharedNote(roomId: number, authorId: number, to: number[]) {
    if (!to.length) return;
    const note = sharedNote(roomId, authorId);
    if (note) hub.toRoom(roomId, 'shared-note', note, (userId) => to.includes(userId));
  }

  router.get('/api/rooms/:id/note', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const row = db.prepare('SELECT content, updated_at, shared_with FROM notes WHERE room_id = ? AND author_user_id = ?').get(roomId, user.id) as
      | { content: string; updated_at: number; shared_with: string }
      | undefined;
    return { content: row?.content ?? '', updatedAt: row?.updated_at ?? null, sharedWith: idsOf(row?.shared_with) };
  });

  router.put('/api/rooms/:id/note', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const content = asObject(ctx.body).content;
    if (typeof content !== 'string' || [...content].length > 20000) throw new HttpError(400, '笔记最多2万字');
    const now = Date.now();
    db.prepare(
      `INSERT INTO notes (room_id, author_user_id, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, author_user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ).run(roomId, user.id, content, now);
    const row = db.prepare('SELECT shared_with FROM notes WHERE room_id = ? AND author_user_id = ?').get(roomId, user.id) as {
      shared_with: string;
    };
    pushSharedNote(roomId, user.id, idsOf(row.shared_with));
    return { updatedAt: now };
  });

  // 设置笔记分享给谁：{ userIds: [账号编号] }，空数组就是不分享
  router.put('/api/rooms/:id/note/sharing', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const raw = asObject(ctx.body).userIds;
    if (!Array.isArray(raw) || !raw.every((x) => Number.isInteger(x))) throw new HttpError(400, '选一下要分享给谁');
    const members = new Set(rooms.memberIds(roomId));
    const ids = [...new Set(raw as number[])].filter((id) => id !== user.id);
    if (ids.some((id) => !members.has(id))) throw new HttpError(400, '只能分享给这一局里的人');
    const before = idsOf(
      (db.prepare('SELECT shared_with FROM notes WHERE room_id = ? AND author_user_id = ?').get(roomId, user.id) as { shared_with: string } | undefined)
        ?.shared_with,
    );
    db.prepare(
      `INSERT INTO notes (room_id, author_user_id, content, shared_with, updated_at) VALUES (?, ?, '', ?, ?)
       ON CONFLICT (room_id, author_user_id) DO UPDATE SET shared_with = excluded.shared_with`,
    ).run(roomId, user.id, JSON.stringify(ids), Date.now());
    pushSharedNote(roomId, user.id, ids);
    const removed = before.filter((id) => !ids.includes(id));
    if (removed.length) hub.toRoom(roomId, 'shared-note-removed', { authorId: user.id }, (userId) => removed.includes(userId));
    return { sharedWith: ids };
  });

  // 别人分享给我的笔记
  router.get('/api/rooms/:id/shared-notes', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const authors = db
      .prepare(
        `SELECT n.author_user_id FROM notes n
         WHERE n.room_id = ? AND n.author_user_id != ? AND EXISTS (SELECT 1 FROM json_each(n.shared_with) j WHERE j.value = ?)
         ORDER BY n.updated_at DESC`,
      )
      .all(roomId, user.id, user.id) as { author_user_id: number }[];
    return { notes: authors.map((a) => sharedNote(roomId, a.author_user_id)).filter((n) => n !== null) };
  });

  // 对局页面的实时推送：成员打开着就算在这一局在线；不是成员的人是在观看，不算在线
  router.get('/api/rooms/:id/events', (ctx) => {
    const user = requireViewer(ctx);
    const roomId = asId(ctx.params.id);
    const { watching } = rooms.access(roomId, user.id);
    const stream = hub.open(ctx.res, user.id, roomId, watching, sessionId(ctx.cookies[SESSION_COOKIE]));
    hub.send(stream, 'presence', rooms.presence(roomId));
    hub.send(stream, 'badges', social.badges(user.id));
    return STREAMING;
  });

  // 对局页面以外的页面的实时推送：大厅、“我的对局”、好友、通知、公告
  router.get('/api/events', (ctx) => {
    const user = requireViewer(ctx);
    const stream = hub.open(ctx.res, user.id, null, false, sessionId(ctx.cookies[SESSION_COOKIE]));
    hub.send(stream, 'badges', social.badges(user.id));
    return STREAMING;
  });
}
