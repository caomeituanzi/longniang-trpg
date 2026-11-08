import { requireUser } from '../auth';
import { asId, asObject, HttpError, type Ctx, type Router } from '../http';
import type { ScheduleResponse } from '../../shared/schedule';
import type { Deps } from '../app';

// 约团（V0.8.0）：对局里列几个时间、大家勾能不能来、房主定下、开始前提醒。逻辑在 server/schedule.ts。
// 都要是能玩的账号（游客 403），并且是这一局的成员（不是的 404，和对局的其他接口一样不说这一局在不在）。

/** 列、定、取消会给成员发通知：每个房主一小时最多这么多次（防止刷通知）。 */
const CHANGES_PER_HOUR = 30;
/** 勾：每人每分钟最多这么多次（一直点会让同一局别人的页面跟着重新拉）。 */
const VOTES_PER_MINUTE = 30;

export function registerScheduleRoutes(router: Router, deps: Deps) {
  const { rooms, schedule, limiter, now } = deps;

  /** 登录的成员和这一局。 */
  function member(ctx: Ctx) {
    const user = requireUser(ctx);
    const { room } = rooms.requireMember(asId(ctx.params.id), user.id);
    return { user, room };
  }

  function throttle(userId: number) {
    if (!limiter.allow(`schedule:${userId}`, CHANGES_PER_HOUR, 60 * 60_000)) throw new HttpError(429, '约时间改得太频繁了，请过一会儿再试');
  }

  // 现在的约团（没有是 null）
  router.get('/api/rooms/:id/schedule', (ctx): ScheduleResponse => {
    const { user, room } = member(ctx);
    return { schedule: schedule.view(room, user.id), now: now() };
  });

  // 房主列新的候选时间：{ slots: [UTC 毫秒], note?: 附言 }（原来的作废）
  router.post('/api/rooms/:id/schedule', (ctx): ScheduleResponse => {
    const { user, room } = member(ctx);
    const body = asObject(ctx.body);
    if (room.host_user_id === user.id && room.status !== 'ended') throttle(user.id);
    const view = schedule.create(room, user.id, { slots: body.slots, note: body.note });
    ctx.status = 201;
    return { schedule: view, now: now() };
  });

  // 成员勾：{ votes: { [时间的编号]: 'yes' | 'maybe' | 'no' | null } }
  router.put('/api/rooms/:id/schedule/votes', (ctx): ScheduleResponse => {
    const { user, room } = member(ctx);
    if (!limiter.allow(`scheduleVote:${user.id}`, VOTES_PER_MINUTE, 60_000)) throw new HttpError(429, '勾得太快了，歇一会儿再勾');
    return { schedule: schedule.vote(room, user.id, asObject(ctx.body).votes), now: now() };
  });

  // 房主定下一个：{ slotId }
  router.post('/api/rooms/:id/schedule/confirm', (ctx): ScheduleResponse => {
    const { user, room } = member(ctx);
    const body = asObject(ctx.body);
    if (room.host_user_id === user.id && room.status !== 'ended') throttle(user.id);
    return { schedule: schedule.confirm(room, user.id, body.slotId), now: now() };
  });

  // 房主取消现在的约团
  router.delete('/api/rooms/:id/schedule', (ctx): ScheduleResponse => {
    const { user, room } = member(ctx);
    if (room.host_user_id === user.id && room.status !== 'ended') throttle(user.id);
    return { schedule: schedule.cancel(room, user.id), now: now() };
  });

  // 「我的对局」：我在的、没结束的每一局的下次时间、要不要我勾
  router.get('/api/schedule/mine', (ctx) => {
    const user = requireUser(ctx);
    return { rooms: schedule.mine(user.id) };
  });
}
