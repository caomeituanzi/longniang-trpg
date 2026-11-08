import { audit } from '../audit';
import { requireAdmin, requireUser } from '../auth';
import { requireCredit } from '../credit';
import { asId, asObject, HttpError, type Ctx, type Router } from '../http';
import type { Deps } from '../app';
import type { Operator } from '../game/host';

// 房主工具：撤回或重新结算最近一次结算、改角色的数值、改游戏时间、改线索归属、导出团录。
// 有「管理所有对局」权限的管理员（和站长）有房主的全部权限：在对局页面里用的和房主一样；
// 在「管理」页用同样的接口，加上 ?full=1：不用加入对局，能看到、改到全部内容。
// 房主自己通常也在玩：别人的角色状态要带 ?reveal=角色编号，线索归属要带 ?reveal=1 才给，记录里会告诉大家。
// 不在这一局里玩的管理员不会被剧透，在对局页面里也能看到全部。

export function registerHostRoutes(router: Router, { db, rooms, host, safety, now }: Deps) {
  /** 管理员、站长用了主持工具：记进操作记录（房主自己用不记）。 */
  function note(op: Operator, roomId: number, what: string) {
    if (op.by === '房主') return;
    const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId) as { name: string } | undefined;
    audit(db, op.userId, what, `对局 ${roomId}「${room?.name ?? ''}」`, now());
  }

  function operator(ctx: Ctx, roomId: number): Operator {
    if (ctx.url.searchParams.get('full') === '1') {
      const admin = requireAdmin(ctx, 'rooms');
      if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) throw new HttpError(404, '对局不存在');
      return { by: admin.isOwner ? '站长' : '管理员', full: true, userId: admin.id };
    }
    const user = requireUser(ctx);
    const access = rooms.requireManager(roomId, user.id, '只有房主能用主持工具');
    return { by: access.by, full: access.role === null, userId: user.id };
  }

  /** ?reveal=3,5：房主点了“查看”的角色。 */
  function revealed(ctx: Ctx): number[] {
    return (ctx.url.searchParams.get('reveal') ?? '')
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 12);
  }

  // 最近一次结算（能不能撤回）和各角色现在的状态
  router.get('/api/rooms/:id/host', (ctx) => {
    const roomId = asId(ctx.params.id);
    const op = operator(ctx, roomId);
    return { last: host.lastResolution(roomId, op), characters: host.characters(roomId, op, revealed(ctx)) };
  });

  // 线索和谁知道：房主只看得到已经被找到的，要带 ?reveal=1（网页上要先确认，记录里会告诉大家）
  router.get('/api/rooms/:id/host/clues', (ctx) => {
    const roomId = asId(ctx.params.id);
    return host.clues(roomId, operator(ctx, roomId), ctx.url.searchParams.get('reveal') === '1');
  });

  // 撤回最近一次结算：{ regenerate: true } 撤回以后让主持人重新结算（钱记给按按钮的人）
  router.post('/api/rooms/:id/host/undo', (ctx) => {
    const roomId = asId(ctx.params.id);
    const op = operator(ctx, roomId);
    const regenerate = ctx.body !== undefined && asObject(ctx.body).regenerate === true;
    if (regenerate) requireCredit(db, op.userId);
    const result = host.undo(roomId, op, regenerate);
    note(op, roomId, regenerate ? '撤回并重新结算' : '撤回结算');
    return result;
  });

  router.put('/api/rooms/:id/host/characters/:characterId', async (ctx) => {
    const roomId = asId(ctx.params.id);
    const op = operator(ctx, roomId);
    const characterId = asId(ctx.params.characterId);
    // 新写的物品、状态以后会发给主持 AI：和玩家写的内容一样先检查（检查的钱记给改的人）
    const text = host.editText(roomId, characterId, ctx.body);
    if (text) {
      requireCredit(db, op.userId);
      await safety.precheck(op.userId, roomId, 'character', text);
      operator(ctx, roomId);
    }
    const result = host.editCharacter(roomId, characterId, ctx.body, op);
    note(op, roomId, `改角色 ${characterId} 的数值`);
    return { ...result, characters: host.characters(roomId, op, [...revealed(ctx), characterId]) };
  });

  // 游戏时间：{ day: 第几天, time: '时:分' }
  router.put('/api/rooms/:id/host/clock', (ctx) => {
    const roomId = asId(ctx.params.id);
    const op = operator(ctx, roomId);
    const result = host.setClock(roomId, ctx.body, op);
    note(op, roomId, '改游戏时间');
    return result;
  });

  // 线索归属：{ characterIds: [知道这条线索的角色] }，空数组就是没人知道（算没找到）
  router.put('/api/rooms/:id/host/clues/:key', (ctx) => {
    const roomId = asId(ctx.params.id);
    const op = operator(ctx, roomId);
    const result = host.setClueHolders(roomId, ctx.params.key, ctx.body, op);
    note(op, roomId, `改线索「${ctx.params.key}」的归属`);
    return { ...result, ...host.clues(roomId, op, true) };
  });

  // 导出团录：成员导出自己能看到的部分；管理员加 ?full=1 导出全部
  router.get('/api/rooms/:id/export', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    if (ctx.url.searchParams.get('full') === '1') {
      operator(ctx, roomId);
      return host.exportLog(roomId, 'admin');
    }
    rooms.requireMember(roomId, user.id);
    return host.exportLog(roomId, { userId: user.id, displayName: user.displayName });
  });
}
