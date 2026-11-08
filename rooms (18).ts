import type { Deps } from '../../app';
import { requireAdmin } from '../../auth';
import { creditOf } from '../../credit';
import { LOG_SELECT, type LogRow } from '../../game/log';
import { companionsOf, loadAiSeats } from '../../game/companions';
import { mapViewOf } from '../../game/map-view';
import { loadCharacters, loadRoom, loadScenario, parseWorld } from '../../game/world';
import { asId, asObject, asOneOf, HttpError, type Router } from '../../http';
import { roundUsd } from '../../money';
import { deleteRoom } from '../rooms';
import { adminLog } from './common';
import { toViolation, VIOLATION_SELECT, type ViolationRow } from './violations';

// 所有对局：列表、一局的全部后台数据、全部记录（包括私密的）、改状态、删除。

const LOG_PAGE = 200;

export function registerAdminRoomRoutes(router: Router, deps: Deps) {
  const { db, hub, rooms, engine, studio, ai } = deps;
  const log = adminLog(deps);

  router.get('/api/admin/rooms', (ctx) => {
    requireAdmin(ctx, 'rooms');
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.status, r.created_at, r.is_public, u.id AS host_id, u.display_name AS host_name,
           (SELECT COUNT(*) FROM players p WHERE p.room_id = r.id) AS members,
           (SELECT COUNT(*) FROM characters c WHERE c.room_id = r.id) AS characters,
           (SELECT MAX(l.created_at) FROM log_entries l WHERE l.room_id = r.id) AS last_activity,
           (SELECT COALESCE(SUM(a.cost_usd), 0) FROM ai_calls a WHERE a.room_id = r.id) AS cost,
           (SELECT json_extract(s.data, '$.title') FROM scenarios s WHERE s.room_id = r.id) AS scenario_title
         FROM rooms r LEFT JOIN users u ON u.id = r.host_user_id
         ORDER BY (r.status = 'ended'), COALESCE(last_activity, r.created_at) DESC`,
      )
      .all() as {
      id: number;
      name: string;
      status: string;
      created_at: number;
      is_public: number;
      host_id: number | null;
      host_name: string | null;
      members: number;
      characters: number;
      last_activity: number | null;
      cost: number;
      scenario_title: string | null;
    }[];
    return {
      rooms: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        host: r.host_id !== null ? { id: r.host_id, displayName: r.host_name ?? '' } : null,
        members: r.members,
        characters: r.characters,
        online: hub.onlineUserIds(r.id).size,
        createdAt: r.created_at,
        lastActivityAt: r.last_activity ?? r.created_at,
        cost: roundUsd(r.cost),
        scenarioTitle: r.scenario_title,
        isPublic: r.is_public === 1,
      })),
    };
  });

  /** 一局的全部后台数据：设置、成员、完整的角色卡、完整的剧本、世界状态、行动、AI 调用、笔记、生成剧本的记录、违规记录。 */
  router.get('/api/admin/rooms/:id', (ctx) => {
    requireAdmin(ctx, 'rooms');
    const roomId = asId(ctx.params.id);
    const room = loadRoom(db, roomId);
    if (!room) throw new HttpError(404, '对局不存在');
    const extra = db.prepare('SELECT join_code, created_at, story_summary, summary_until_log_id FROM rooms WHERE id = ?').get(roomId) as {
      join_code: string;
      created_at: number;
      story_summary: string;
      summary_until_log_id: number;
    };
    const online = hub.onlineUserIds(roomId);
    const members = (
      db
        .prepare(
          `SELECT u.id, u.username, u.public_id, u.display_name, u.banned_at, p.role, p.joined_at, p.last_seen_at
           FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? ORDER BY p.role = 'host' DESC, p.joined_at`,
        )
        .all(roomId) as {
        id: number;
        username: string;
        public_id: string;
        display_name: string;
        banned_at: number | null;
        role: string;
        joined_at: number;
        last_seen_at: number | null;
      }[]
    ).map((m) => ({
      userId: m.id,
      username: m.username,
      publicId: m.public_id,
      displayName: m.display_name,
      role: m.role,
      joinedAt: m.joined_at,
      lastSeenAt: m.last_seen_at,
      online: online.has(m.id),
      banned: m.banned_at !== null,
      credit: creditOf(db, m.id),
    }));
    const stored = loadScenario(db, roomId);
    const scenario = stored?.scenario ?? null;
    const placeName = (key: string | null) => (key ? (scenario?.locations.find((l) => l.key === key)?.name ?? key) : null);
    const rawCharacters = loadCharacters(db, roomId);
    const characters = rawCharacters.map((c) => {
      const role = scenario?.roles.find((r) => r.key === c.roleKey);
      return {
        ...c,
        roleName: role?.name ?? c.roleKey,
        roleSecret: role?.secret ?? '',
        roleGoal: role?.goal ?? '',
        locationName: placeName(c.location),
        spot: c.location ? (c.spot ?? null) : null,
        visitedNames: c.visited.map((k) => placeName(k) ?? k),
      };
    });
    // 交给 AI 演的身份（V0.8.0）：npcKey 是主持 AI 那份剧本里的 NPC key（世界状态的「NPC 的变化」里按它记）
    const companionInfos = scenario ? companionsOf(scenario, loadAiSeats(db, roomId), characters.map((c) => c.roleKey)) : [];
    const companions = companionInfos.map(({ roleKey, roleName, name, npcKey }) => ({ roleKey, roleName, name, npcKey }));
    const world = parseWorld(room.world);
    // 地图（V1.0.x）：整张，标上所有角色、AI 队友和 NPC 在哪
    const map = scenario ? mapViewOf(scenario, world, rawCharacters, { me: null, full: true, npcs: true, companions: companionInfos }) : null;
    const actions = (
      db
        .prepare(
          `SELECT a.id, a.content, a.status, a.mode, a.round, a.submitted_at, a.due_at, a.game_start, a.game_minutes, a.estimate_note,
             a.attempts, a.last_error, a.refused, a.resolved_at, c.name AS character_name
           FROM actions a JOIN characters c ON c.id = a.character_id WHERE a.room_id = ? ORDER BY a.id DESC LIMIT 100`,
        )
        .all(roomId) as Record<string, unknown>[]
    ).map((a) => ({
      id: a.id,
      character: a.character_name,
      content: a.content,
      status: a.status,
      mode: a.mode,
      round: a.round,
      submittedAt: a.submitted_at,
      dueAt: a.due_at,
      gameStart: a.game_start,
      gameMinutes: a.game_minutes,
      estimateNote: a.estimate_note,
      attempts: a.attempts,
      error: a.last_error,
      refused: a.refused === 1,
      resolvedAt: a.resolved_at,
    }));
    const calls = (
      db
        .prepare(
          `SELECT c.*, u.display_name AS user_name FROM ai_calls c LEFT JOIN users u ON u.id = c.user_id
           WHERE c.room_id = ? ORDER BY c.id DESC LIMIT 100`,
        )
        .all(roomId) as Record<string, any>[]
    ).map((c) => ({
      at: c.created_at,
      purpose: c.purpose,
      model: c.model,
      user: c.user_name,
      input: c.input_tokens,
      output: c.output_tokens,
      cacheRead: c.cache_read_tokens,
      cacheWrite: c.cache_write_tokens,
      cost: roundUsd(c.cost_usd),
      durationMs: c.duration_ms,
      stopReason: c.stop_reason,
      requestId: c.request_id,
      error: c.error,
    }));
    const costByPurpose = (
      db
        .prepare('SELECT purpose, COUNT(*) AS calls, SUM(cost_usd) AS cost FROM ai_calls WHERE room_id = ? GROUP BY purpose ORDER BY cost DESC')
        .all(roomId) as { purpose: string; calls: number; cost: number }[]
    ).map((p) => ({ purpose: p.purpose, calls: p.calls, cost: roundUsd(p.cost) }));
    const nameOfUser = (id: number) => members.find((m) => m.userId === id)?.displayName ?? `账号${id}`;
    const notes = (
      db
        .prepare('SELECT n.author_user_id, n.content, n.shared_with, n.updated_at FROM notes n WHERE n.room_id = ? ORDER BY n.updated_at DESC')
        .all(roomId) as { author_user_id: number; content: string; shared_with: string; updated_at: number }[]
    ).map((n) => {
      let shared: number[] = [];
      try {
        shared = JSON.parse(n.shared_with || '[]');
      } catch {
        shared = [];
      }
      return { author: nameOfUser(n.author_user_id), content: n.content, sharedWith: shared.map(nameOfUser), updatedAt: n.updated_at };
    });
    const jobs = (
      db
        .prepare(
          `SELECT j.id, j.kind, j.status, j.step, j.fix_round, j.input, j.error, j.notes, j.created_at, j.finished_at, u.display_name AS by_name
           FROM scenario_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.room_id = ? ORDER BY j.id DESC LIMIT 20`,
        )
        .all(roomId) as Record<string, any>[]
    ).map((j) => {
      let input: unknown = null;
      try {
        input = JSON.parse(j.input);
      } catch {
        input = j.input;
      }
      return {
        id: j.id,
        kind: j.kind,
        status: j.status,
        step: j.step,
        fixRound: j.fix_round,
        input,
        error: j.error,
        notes: j.notes ? (JSON.parse(j.notes) as string[]) : [],
        by: j.by_name,
        createdAt: j.created_at,
        finishedAt: j.finished_at,
      };
    });
    const violations = (db.prepare(`${VIOLATION_SELECT} WHERE v.room_id = ? ORDER BY v.id DESC LIMIT 50`).all(roomId) as ViolationRow[]).map(toViolation);
    return {
      room: {
        id: room.id,
        name: room.name,
        status: room.status,
        model: room.model,
        maxPlayers: room.max_players,
        untimed: room.untimed === 1,
        joinCode: extra.join_code,
        createdAt: extra.created_at,
        host: members.find((m) => m.role === 'host') ?? null,
        clock: room.game_clock === null ? null : engine.gameNow(room),
        roundNo: room.round_no,
        timeRatio: room.time_ratio,
        waits: { min: room.min_wait_minutes, max: room.max_wait_minutes },
        costLimit: room.cost_limit_usd,
        mode: rooms.presence(roomId).mode,
        cost: roundUsd(ai.roomCost(roomId)),
      },
      members,
      characters,
      companions,
      scenario: stored ? { source: stored.source, key: stored.key, revealed: stored.revealed, data: stored.scenario } : null,
      world,
      map,
      storySummary: { text: extra.story_summary, untilLogId: extra.summary_until_log_id },
      actions,
      ai: { byPurpose: costByPurpose, recent: calls },
      notes,
      jobs,
      violations,
    };
  });

  // 全部记录（包括所有私密内容），注明谁看得到。before：翻到更早的
  router.get('/api/admin/rooms/:id/log', (ctx) => {
    requireAdmin(ctx, 'rooms');
    const roomId = asId(ctx.params.id);
    if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) throw new HttpError(404, '对局不存在');
    const beforeParam = ctx.url.searchParams.get('before');
    const before = beforeParam ? asId(beforeParam) : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`${LOG_SELECT} WHERE l.room_id = ? AND l.id < ? ORDER BY l.id DESC LIMIT ?`).all(roomId, before, LOG_PAGE + 1) as LogRow[];
    const audience = db.prepare(
      "SELECT c.name FROM knowledge k JOIN characters c ON c.id = k.character_id WHERE k.content_type = 'log' AND k.content_id = ? ORDER BY c.id",
    );
    const userName = db.prepare('SELECT display_name FROM users WHERE id = ?');
    const entries = rows.slice(0, LOG_PAGE).reverse().map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      private: r.visibility === 'private',
      to: [
        ...(audience.all(r.id) as { name: string }[]).map((a) => a.name),
        ...(r.target_user_id !== null ? [(userName.get(r.target_user_id) as { display_name: string } | undefined)?.display_name ?? '已注销的账号'] : []),
      ],
      author: r.author_name,
      createdAt: r.created_at,
      gameTime: r.game_time,
      data: r.data ? JSON.parse(r.data) : null,
    }));
    return { entries, hasMore: rows.length > LOG_PAGE };
  });

  router.post('/api/admin/rooms/:id/status', (ctx) => {
    const admin = requireAdmin(ctx, 'rooms');
    const roomId = asId(ctx.params.id);
    const room = db.prepare('SELECT name, status FROM rooms WHERE id = ?').get(roomId) as { name: string; status: string } | undefined;
    if (!room) throw new HttpError(404, '对局不存在');
    const next = asOneOf(asObject(ctx.body).status, ['running', 'paused', 'ended'] as const, '状态不对');
    const by = admin.isOwner ? '站长' : '管理员';
    const status = engine.changeStatus(roomId, next, by, admin.id);
    if (status === 'ended') studio.cancelRoom(roomId);
    log(admin, '改对局状态', `对局 ${roomId}「${room.name}」：${room.status} → ${status}`);
    return { status };
  });

  router.delete('/api/admin/rooms/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'rooms');
    const roomId = asId(ctx.params.id);
    const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId) as { name: string } | undefined;
    if (!room) throw new HttpError(404, '对局不存在');
    deleteRoom(deps, roomId, room.name, admin.isOwner ? '站长' : '管理员');
    log(admin, '删除对局', `对局 ${roomId}「${room.name}」`);
    return { deleted: true };
  });
}
