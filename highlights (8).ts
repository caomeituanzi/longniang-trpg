import { requireUser } from '../auth';
import { addHighlight, listHighlights, removeHighlight, reportData, type ReportCache } from '../highlights';
import { asId, asInt, asObject, HttpError, type Router } from '../http';
import type { HighlightChange } from '../../shared/highlights';
import type { Deps } from '../app';

// 名场面和战报卡片（V0.8.0）。都要是能玩的账号（游客不行）、这一局的成员（观看的人不行）。
// 收藏是私人的：只推给收藏的人自己开着这一局的页面（别的标签页跟着变），别人不知道谁收藏了什么。

/** 战报的数据：打开对话框时拉一次；长的对局数一遍要几十毫秒，按账号每分钟最多这么多次。 */
export const REPORTS_PER_MINUTE = 10;
/** 收藏、取消收藏：按账号每分钟最多这么多次（正常一条条点远远到不了）。 */
export const HIGHLIGHT_TOGGLES_PER_MINUTE = 60;

export function registerHighlightRoutes(router: Router, { db, rooms, hub, limiter, now }: Deps) {
  /** 推给自己开着这一局的页面。 */
  const tellMe = (userId: number, change: HighlightChange) => hub.toRoom(change.roomId, 'highlights', change, (id) => id === userId);
  /** 数过的战报（这一局的记录没变就直接用），这个服务器开着期间一直留着。 */
  const reportCache: ReportCache = new Map();
  /** 按账号限一分钟几次，超了说清楚（429）。 */
  const limit = (name: string, userId: number, max: number, message: string) => {
    if (!limiter.allow(`${name}:${userId}`, max, 60_000)) throw new HttpError(429, message);
  };
  const toggleLimit = (userId: number) => limit('highlight', userId, HIGHLIGHT_TOGGLES_PER_MINUTE, '收藏点得太快了，歇一会儿再点');

  // 我在这一局收藏的名场面（按记录的先后）
  router.get('/api/rooms/:id/highlights', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    return { highlights: listHighlights(db, roomId, user.id) };
  });

  // 收藏一条：{ logId }。看不到的记录说没有这条（404）；系统提示、场外聊天不能收藏（400）；每局最多 200 条（409）
  router.post('/api/rooms/:id/highlights', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    toggleLimit(user.id);
    const logId = asInt(asObject(ctx.body).logId, { min: 1, max: 999_999_999_999, message: '请选一条记录' });
    const { item, added } = addHighlight(db, roomId, user.id, logId, now());
    if (added) tellMe(user.id, { roomId, logId, on: true, item });
    ctx.status = added ? 201 : 200;
    return { highlight: item };
  });

  // 取消收藏（本来就没收藏的照样算成功）
  router.delete('/api/rooms/:id/highlights/:logId', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    toggleLimit(user.id);
    const logId = asId(ctx.params.logId);
    const removed = removeHighlight(db, roomId, user.id, logId);
    if (removed) tellMe(user.id, { roomId, logId, on: false });
    return { removed };
  });

  // 战报卡片要的数据：全部按我的视角算（看 server/highlights.ts 的 reportData）。打开对话框只拉一次
  router.get('/api/rooms/:id/report', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    limit('battleReport', user.id, REPORTS_PER_MINUTE, '战报生成得太频繁了，过一分钟再试');
    return reportData(db, roomId, user.id, now(), reportCache);
  });
}
