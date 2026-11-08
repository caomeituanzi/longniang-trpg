import { transaction, type DB } from './db';
import { canSee, characterIdOf, LOG_SELECT, LOG_VISIBLE, loadLogRow, toLogEntry, type LogEntryView, type LogRow } from './game/log';
import { loadCharacters, loadRoom, loadScenario, parseWorld } from './game/world';
import { HttpError } from './http';
import { HIGHLIGHT_LIMIT, highlightTypeOf, type HighlightItem, type ReportData, type RollTally } from '../shared/highlights';
import type { Outcome } from '../shared/rules';

// 名场面（V0.8.0）：成员收藏自己看得到的叙述和对白（私人的）；战报卡片要的数据。
// 「看不看得到」和对局记录接口（GET /api/rooms/:id/log）是同一套判断：game/log.ts 的 LOG_VISIBLE、canSee，
// 内容用 toLogEntry 整理（别人拿到的线索、身上的变化不给）。成员的检查（requireMember）在路由里。

/** 不存在的、别的对局的、自己看不到的记录，一律是这一句：不透露它存不存在。 */
const NO_ENTRY = '没有这条记录';

/** 对局手动结束、走到结局时写的系统消息（engine 的 endByHost、finishGame）：战报的「结束时间」按它算。 */
const END_TEXTS = `(l.text = '对局结束了' OR l.text LIKE '%结束了对局')`;

/** 把一条记录整理成名场面；不能收藏的类别是 null。 */
export function highlightOf(entry: LogEntryView, savedAt: number): HighlightItem | null {
  const type = highlightTypeOf(entry);
  if (!type) return null;
  const d = entry.data;
  let label = '叙述';
  let who: string | null = null;
  let action: string | null = null;
  if (d?.type === 'opening') label = `开场：${d.title}`;
  else if (d?.type === 'role') label = '你的身份';
  else if (d?.type === 'resolution') {
    label = d.actor;
    who = d.actor;
    action = d.action;
  } else if (d?.type === 'private') label = '只有你察觉到';
  else if (d?.type === 'say') {
    label = d.to ? `${d.speaker}悄悄对${d.to}说` : `${d.speaker}说`;
    who = d.speaker;
  } else if (d?.type === 'ending') label = `结局：${d.title}`;
  // 只有你知道：本来就只给一个人看的类别（身份、只有你察觉到的事、悄悄做的行动的结果；老版本留下的没有类型的私密叙述也算）。
  // 不看 visibility：同一地点的人都看得到的行动结果、对白也存成 private（限定了谁看得到），它们不算只有你知道
  const onlyMe = d?.type === 'role' || d?.type === 'private' || (d?.type === 'resolution' && d.secret === true) || (!d && entry.private);
  return {
    logId: entry.id,
    type,
    label,
    who,
    action,
    text: entry.text,
    onlyMe,
    whisper: d?.type === 'say' && !!d.to,
    gameTime: entry.gameTime,
    createdAt: entry.createdAt,
    savedAt,
  };
}

/** 这个人在这一局收藏的、现在还看得到的名场面，按记录的先后。 */
export function listHighlights(db: DB, roomId: number, userId: number): HighlightItem[] {
  const characterId = characterIdOf(db, roomId, userId);
  const rows = db
    .prepare(`${LOG_SELECT} JOIN highlights h ON h.log_id = l.id WHERE h.user_id = ? AND h.room_id = ? AND l.room_id = ? AND ${LOG_VISIBLE} ORDER BY l.id`)
    .all(userId, roomId, roomId, userId, characterId ?? -1) as LogRow[];
  const savedAt = new Map(
    (db.prepare('SELECT log_id, created_at FROM highlights WHERE user_id = ? AND room_id = ?').all(userId, roomId) as { log_id: number; created_at: number }[]).map(
      (r) => [r.log_id, r.created_at],
    ),
  );
  return rows.flatMap((row) => {
    const item = highlightOf(toLogEntry(row, characterId), savedAt.get(row.id) ?? row.created_at);
    return item ? [item] : [];
  });
}

/**
 * 收藏一条。看得到的规矩和对局记录一样（canSee）：看不到的、不在这一局的，说没有这条记录（404）。
 * 系统提示、场外聊天这类不能收藏（400）。已经收藏过的不重复（added 是 false）。每人每局最多 HIGHLIGHT_LIMIT 条（409）。
 */
export function addHighlight(db: DB, roomId: number, userId: number, logId: number, now: number): { item: HighlightItem; added: boolean } {
  const row = loadLogRow(db, logId);
  const characterId = characterIdOf(db, roomId, userId);
  if (!row || row.room_id !== roomId || !canSee(db, row, userId, characterId)) throw new HttpError(404, NO_ENTRY);
  const entry = toLogEntry(row, characterId);
  if (!highlightTypeOf(entry)) throw new HttpError(400, '这一条不能收藏：能收藏的是主持人的叙述和角色说的话');
  return transaction(db, () => {
    const existing = db.prepare('SELECT created_at FROM highlights WHERE user_id = ? AND log_id = ?').get(userId, logId) as { created_at: number } | undefined;
    if (existing) return { item: highlightOf(entry, existing.created_at)!, added: false };
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM highlights WHERE user_id = ? AND room_id = ?').get(userId, roomId) as { n: number };
    if (n >= HIGHLIGHT_LIMIT) throw new HttpError(409, `每一局最多收藏${HIGHLIGHT_LIMIT}条，先取消几条再收藏`);
    db.prepare('INSERT INTO highlights (user_id, room_id, log_id, created_at) VALUES (?, ?, ?, ?)').run(userId, roomId, logId, now);
    return { item: highlightOf(entry, now)!, added: true };
  });
}

/** 取消收藏。本来就没收藏的照样算成功（removed 是 false）。 */
export function removeHighlight(db: DB, roomId: number, userId: number, logId: number): boolean {
  return db.prepare('DELETE FROM highlights WHERE user_id = ? AND room_id = ? AND log_id = ?').run(userId, roomId, logId).changes > 0;
}

const emptyTally = (): RollTally => ({ total: 0, counts: { critical: 0, success: 0, partial: 0, failure: 0, fumble: 0 } });

/** 记几次；不认识的结果（不该有）不算。 */
function count(tally: RollTally, outcome: string, n: number) {
  if (!(outcome in tally.counts)) return;
  tally.total += n;
  tally.counts[outcome as Outcome] += n;
}

/** 战报里要把一整局数一遍的部分：看得到的行动结果几次、检定各种结果几次、开局的时间。 */
type Counted = Pick<ReportData, 'actions' | 'rolls' | 'startedAt'>;

/**
 * 战报的缓存：每个人每一局记一份数过的结果；这一局的记录没变（最新的编号、条数都一样）、他的角色没变，就直接用。
 * 只放在内存里，最多记 REPORT_CACHE_MAX 份（满了扔掉最早的）。每个服务器一份，在路由里建。
 */
export type ReportCache = Map<string, { stamp: string; value: Counted }>;
const REPORT_CACHE_MAX = 500;

/**
 * 数行动和检定：直接在 SQL 里数，不把每条行动结果整条拿出来解析；看得到的规矩照样是 LOG_VISIBLE。
 * 暗骰本来就不在行动结果的骰子卡片里；敌人的攻击（combat.kind 是 enemy）不是角色的检定，不算。myName：自己角色的名字（没有角色是 null）。
 */
function countVisible(db: DB, roomId: number, userId: number, characterId: number | null, myName: string | null): Counted {
  const visible = `l.room_id = ? AND l.kind = 'narration' AND json_extract(l.data, '$.type') = 'resolution' AND ${LOG_VISIBLE}`;
  const params = [roomId, userId, characterId ?? -1];
  const acts = db
    .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(json_extract(l.data, '$.actor') = ?), 0) AS mine FROM log_entries l WHERE ${visible}`)
    .get(myName, ...params) as { total: number; mine: number };
  const rolls = db
    .prepare(
      `SELECT json_extract(r.value, '$.outcome') AS outcome, COUNT(*) AS n, COALESCE(SUM(json_extract(r.value, '$.who') = ?), 0) AS mine
       FROM log_entries l, json_each(l.data, '$.rolls') r
       WHERE ${visible} AND COALESCE(json_extract(r.value, '$.combat.kind'), '') != 'enemy'
       GROUP BY outcome`,
    )
    .all(myName, ...params) as { outcome: string; n: number; mine: number }[];
  const all = emptyTally();
  const mine = emptyTally();
  for (const r of rolls) {
    count(all, r.outcome, r.n);
    count(mine, r.outcome, r.mine);
  }
  // 开局：开场那一段写下的时间（collection.ts 算「多快走完」也是这样）
  const opening = db
    .prepare("SELECT MIN(created_at) AS at FROM log_entries WHERE room_id = ? AND kind = 'narration' AND json_extract(data, '$.type') = 'opening'")
    .get(roomId) as { at: number | null };
  return {
    actions: { total: acts.total, mine: myName === null ? 0 : acts.mine },
    rolls: { all, mine: myName === null ? null : mine },
    startedAt: opening.at,
  };
}

/**
 * 战报卡片的数据，全部从这个人的视角算：
 * 行动和检定只数他看得到的行动结果（同一套 LOG_VISIBLE）；暗骰本来就不在行动结果里，敌人的攻击不是角色的检定，也不算。
 * 结局只有对局结束了、走到了结局才给；不给真相。cache：数过的结果（见 ReportCache），不给就每次都数。
 */
export function reportData(db: DB, roomId: number, userId: number, now: number, cache?: ReportCache): ReportData {
  const room = loadRoom(db, roomId);
  if (!room) throw new HttpError(404, '对局不存在');
  const scenario = loadScenario(db, roomId)?.scenario ?? null;
  const characterId = characterIdOf(db, roomId, userId);
  const characters = loadCharacters(db, roomId);
  const me = characters.find((c) => c.id === characterId) ?? null;

  // 这一局的记录有没有变：新的记录编号更大；撤回结算先写一条再删，编号、条数都会变
  const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id, COUNT(*) AS n FROM log_entries WHERE room_id = ?').get(roomId) as { id: number; n: number };
  const stamp = `${latest.id}:${latest.n}:${characterId ?? 0}:${me?.name ?? ''}`;
  const key = `${roomId}:${userId}`;
  const cached = cache?.get(key);
  let counted = cached?.stamp === stamp ? cached.value : null;
  if (!counted) {
    counted = countVisible(db, roomId, userId, characterId, me?.name ?? null);
    if (cache) {
      cache.delete(key);
      if (cache.size >= REPORT_CACHE_MAX) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { stamp, value: counted });
    }
  }

  const { rounds } = db
    .prepare("SELECT COUNT(DISTINCT round) AS rounds FROM actions WHERE room_id = ? AND mode = 'round' AND status = 'done' AND round IS NOT NULL")
    .get(roomId) as { rounds: number };
  let endedAt: number | null = null;
  if (room.status === 'ended') {
    const end = db
      .prepare(`SELECT MAX(l.created_at) AS at FROM log_entries l WHERE l.room_id = ? AND l.kind = 'system' AND l.visibility = 'all' AND ${END_TEXTS}`)
      .get(roomId) as { at: number | null };
    // 找不到那条系统消息（不该发生）：按最后一条记录算
    endedAt = end.at ?? (db.prepare('SELECT MAX(created_at) AS at FROM log_entries WHERE room_id = ?').get(roomId) as { at: number | null }).at ?? now;
  }

  const world = parseWorld(room.world);
  return {
    room: { id: room.id, name: room.name, status: room.status },
    scenario: scenario ? { title: scenario.title, category: scenario.category ?? null } : null,
    startedAt: counted.startedAt,
    endedAt,
    now,
    rounds,
    actions: counted.actions,
    characters: characters.map((c) => ({
      name: c.name,
      roleName: scenario?.roles.find((r) => r.key === c.roleKey)?.name ?? c.roleKey,
      playerName: c.playerName,
      mine: c.id === characterId,
      dead: c.dead,
    })),
    rolls: counted.rolls,
    ending: room.status === 'ended' && world.ending ? { title: world.ending.title, epilogue: world.ending.epilogue } : null,
    highlights: listHighlights(db, roomId, userId),
  };
}
