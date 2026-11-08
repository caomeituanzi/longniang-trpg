import { audit } from '../audit';
import { requireUser } from '../auth';
import { requireCredit } from '../credit';
import {
  checkAiSeat,
  removeAiSeat,
  saveAiSeat,
  SEAT_LOG_MERGE_MS,
  seatLogChange,
  seatLogFlavor,
  seatLogMerge,
  seatLogPersona,
  seatLogText,
  type SeatChange,
  type SeatFlavor,
  type SeatPersona,
} from '../game/companions';
import { asId, asObject, HttpError, type Router } from '../http';
import type { Deps } from '../app';

// AI 补位（V0.8.0）：房主把没人选的身份交给 AI 演（主持 AI 顺带演，当作跟着大家的队友）。规则见 server/game/companions.ts。
// 读：在游戏状态里（GameState.companions，身份的 takenBy），准备阶段的页面本来就拉它，不另开接口。
// 改了以后推给开着这一局的人（engine.pushGame），记录里告诉大家。
// 防刷屏（V0.8.0 安全审查）：每人每分钟最多改 20 次（limits.ts 的 aiSeat）；同一个身份短时间里来回改，记录合并成一条。
// AI 角色（V1.1.0 AI 大厅）：{ personaId } 请一个 AI 角色来演（公开的，或者自己做的），null 换回主持人顺带演，不写照旧。

/** 身份的 key（和剧本格式里的一样）。 */
const ROLE_KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function registerAiSeatRoutes(router: Router, { db, hub, rooms, engine, safety, limiter, personas, now }: Deps) {
  const roleKeyOf = (raw: string | undefined): string => {
    if (!raw || !ROLE_KEY_RE.test(raw)) throw new HttpError(404, '剧本里没有这个身份');
    return raw;
  };

  /**
   * 写一条大家看得到的记录。这一局最后一条记录正好是同一个人对同一个身份写的、还在合并时间以内：按 seatLogMerge 合并
   * （要撤掉的上一条从网页上也去掉；刚交给 AI 又取消的，两条都不留）。
   * own：这次改动本身是请了（换了）AI 角色、把请来的换下来，还是只改名字；has：现在是不是请着 AI 角色。写法见 seatLogPersona。
   */
  function logSeat(roomId: number, by: string, change: SeatChange, roleName: string, name: string, own: SeatFlavor = 'plain', has = false) {
    const last = db.prepare('SELECT id, kind, visibility, text, created_at FROM log_entries WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(roomId) as
      | { id: number; kind: string; visibility: string; text: string; created_at: number }
      | undefined;
    const prev =
      last && last.kind === 'system' && last.visibility === 'all' && now() - last.created_at < SEAT_LOG_MERGE_MS ? seatLogChange(last.text, by, roleName) : null;
    let write: SeatChange | null = change;
    let prevFlavor: SeatFlavor | null = null;
    if (last && prev) {
      const merged = seatLogMerge(prev, change);
      if (merged.replace) {
        db.prepare('DELETE FROM log_entries WHERE id = ? AND room_id = ?').run(last.id, roomId);
        hub.toRoom(roomId, 'log-removed', { ids: [last.id] });
        prevFlavor = seatLogFlavor(last.text, by, roleName);
      }
      write = merged.write;
    }
    if (write) rooms.addLog(roomId, 'system', seatLogText(by, write, roleName, name, seatLogPersona(write, own, prevFlavor, has)));
  }

  /** 这个身份现在请着哪个 AI 角色（大厅里的编号和存下的样子；没请是 null）。 */
  const seatPersonaOf = (roomId: number, roleKey: string) =>
    (db.prepare('SELECT persona_id, persona FROM ai_seats WHERE room_id = ? AND role_key = ? AND persona IS NOT NULL').get(roomId, roleKey) as
      | { persona_id: number | null; persona: string }
      | undefined) ?? null;

  // 交给 AI 演、改名字：{ name?: 名字 }（不写就用身份的名字）。名字会写进给主持 AI 的提示词：起了新名字的先检查内容
  router.put('/api/rooms/:id/ai-seats/:roleKey', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const roleKey = roleKeyOf(ctx.params.roleKey);
    rooms.requireManager(roomId, user.id, '只有房主能把身份交给 AI');
    limiter.hit('aiSeat', user.id);
    const body = ctx.body === undefined || ctx.body === null ? {} : asObject(ctx.body);
    if (body.personaId !== undefined && body.personaId !== null) {
      if (typeof body.personaId !== 'number' || !Number.isInteger(body.personaId) || body.personaId <= 0) throw new HttpError(400, '请求格式不对');
    }
    // AI 角色：公开的，或者自己做的（不公开的只有作者自己能请）
    const personaOf = (): SeatPersona => (body.personaId === null ? null : body.personaId === undefined ? undefined : personas.usable(body.personaId as number, user.id));
    const first = checkAiSeat(db, roomId, roleKey, body.name, personaOf());
    if (first.needsCheck) {
      requireCredit(db, user.id);
      await safety.precheck(user.id, roomId, 'character', `AI 队友的名字：${first.name}`);
    }
    // 检查内容的这一会儿里可能开了局、换了剧本、有人选了这个身份，AI 角色也可能被删掉、改成不公开：再查一遍（同步的，查完马上写）
    const { by } = rooms.requireManager(roomId, user.id, '只有房主能把身份交给 AI');
    const persona = personaOf();
    const { role, name } = checkAiSeat(db, roomId, roleKey, body.name, persona);
    const before = seatPersonaOf(roomId, roleKey);
    const result = saveAiSeat(db, roomId, roleKey, name, now(), persona);
    if (result !== 'same') {
      const after = seatPersonaOf(roomId, roleKey);
      const has = after !== null;
      // 这次请了（换了）AI 角色、把请来的换下来，还是只改了名字
      const changed = before?.persona_id !== after?.persona_id || before?.persona !== after?.persona;
      const own: SeatFlavor = has && changed ? 'persona' : before && !has ? 'dropped' : 'plain';
      logSeat(roomId, by, result, role.name, name, own, has);
      if (by !== '房主') audit(db, user.id, '替对局把身份交给 AI', `对局 ${roomId}：「${role.name}」${name === role.name ? '' : `（${name}）`}${has ? '，AI 角色' : ''}`, now());
      engine.pushGame(roomId);
    }
    return engine.gameState(roomId, user.id);
  });

  // 不交给 AI 了：这个身份又可以选了
  router.delete('/api/rooms/:id/ai-seats/:roleKey', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const roleKey = roleKeyOf(ctx.params.roleKey);
    const { by } = rooms.requireManager(roomId, user.id, '只有房主能改哪些身份交给 AI');
    limiter.hit('aiSeat', user.id);
    const removed = removeAiSeat(db, roomId, roleKey);
    logSeat(roomId, by, 'removed', removed.roleName, removed.name);
    if (by !== '房主') audit(db, user.id, '替对局取消交给 AI 的身份', `对局 ${roomId}：「${removed.roleName}」`, now());
    engine.pushGame(roomId);
    return engine.gameState(roomId, user.id);
  });
}
