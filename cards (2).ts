import { audit, who } from '../audit';
import { requireOwner, requireUser, requireViewer } from '../auth';
import { asId, asObject, HttpError, type Router } from '../http';
import { ATTRIBUTE2_KEYS, EQUIP_SLOTS, type Attribute2, type EquipSlot } from '../../shared/rules2';
import type { CardGrowth } from '../../shared/cards';
import type { Deps } from '../app';

// 自带角色卡（V0.7.0）：「我的角色」页（卡、装备、道具、宝箱、秘籍）、成长、穿装备、研读秘籍、切磋、排行。逻辑在 cards.ts。

export function registerCardRoutes(router: Router, deps: Deps) {
  const { cards, social } = deps;

  router.get('/api/cards', (ctx) => {
    const user = requireUser(ctx);
    return { ...cards.page(user.id), duels: cards.recentDuels(user.id) };
  });

  router.post('/api/cards', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards.create(user.id, asObject(ctx.body)) };
  });

  // 导入角色卡（属性、专长、技能；装备不带）
  router.post('/api/cards/import', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards.importCard(user.id, asObject(ctx.body)) };
  });

  // 角色排行（战力、切磋胜场）：放在 /api/cards/:id 前面不要紧（路径段数不一样），这里单独一个前缀
  router.get('/api/rankings/cards', (ctx) => {
    // 排行页游客也能看
    const viewer = requireViewer(ctx);
    return cards.rankings(viewer.id);
  });

  router.get('/api/duels', (ctx) => {
    const user = requireUser(ctx);
    return { duels: cards.recentDuels(user.id) };
  });

  // 开宝箱（宝箱只能靠打完地下城得到）
  router.post('/api/chests/open', (ctx) => {
    const user = requireUser(ctx);
    return { result: cards.openChest(user.id), chests: cards.chests(user.id) };
  });

  // 一个人公开的角色卡：和个人主页上的一样（V0.8.1 起只有主人选了展示的）
  router.get('/api/users/:ref/cards', (ctx) => {
    requireUser(ctx);
    // 只认公开编号（用户名不公开）
    const target = ctx.params.ref.startsWith('p-') ? social.findUser(ctx.params.ref) : undefined;
    if (!target) throw new HttpError(404, '没有这个人');
    return { cards: cards.publicCards(target.id) };
  });

  // 地下城的通关记录
  router.get('/api/dungeons/:key/records', (ctx) => {
    requireUser(ctx);
    return cards.clearRecords(ctx.params.key);
  });

  router.put('/api/cards/:id', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards.update(user.id, asId(ctx.params.id), asObject(ctx.body)) };
  });

  router.delete('/api/cards/:id', (ctx) => {
    const user = requireUser(ctx);
    cards.remove(user.id, asId(ctx.params.id));
    return { ok: true };
  });

  // 用成长点：{ type: 'attribute', key } 或 { type: 'specialty', name }
  router.post('/api/cards/:id/grow', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    let growth: CardGrowth;
    if (body.type === 'attribute') {
      if (!ATTRIBUTE2_KEYS.includes(body.key as Attribute2)) throw new HttpError(400, '没有这项属性');
      growth = { type: 'attribute', key: body.key as Attribute2 };
    } else if (body.type === 'specialty') {
      growth = { type: 'specialty', name: typeof body.name === 'string' ? body.name : '' };
    } else {
      throw new HttpError(400, '请求格式不对');
    }
    return { card: cards.grow(user.id, asId(ctx.params.id), growth) };
  });

  // 穿上、脱下装备：{ slot（十六个格子之一，见 EQUIP_SLOTS）, gearId | null }
  router.put('/api/cards/:id/equip', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    if (!EQUIP_SLOTS.includes(body.slot as EquipSlot)) throw new HttpError(400, '没有这个格子');
    const gearId = body.gearId === null ? null : Number(body.gearId);
    if (gearId !== null && !Number.isInteger(gearId)) throw new HttpError(400, '请求格式不对');
    return { card: cards.equip(user.id, asId(ctx.params.id), body.slot as EquipSlot, gearId) };
  });

  // 研读秘籍：{ manual: 'manual:技能编号' }
  router.post('/api/cards/:id/learn', (ctx) => {
    const user = requireUser(ctx);
    const manual = asObject(ctx.body).manual;
    if (typeof manual !== 'string') throw new HttpError(400, '请求格式不对');
    return { card: cards.learn(user.id, asId(ctx.params.id), manual) };
  });

  // 切磋：{ opponent: 对方的卡的编号 }
  router.post('/api/cards/:id/duel', (ctx) => {
    const user = requireUser(ctx);
    const opponent = Number(asObject(ctx.body).opponent);
    if (!Number.isInteger(opponent)) throw new HttpError(400, '请选一张对手的卡');
    return { duel: cards.duel(user.id, asId(ctx.params.id), opponent) };
  });

  // 站长给一张卡发成长点（测试高难度地下城用）：{ points }
  router.post('/api/admin/cards/:id/points', (ctx) => {
    const owner = requireOwner(ctx);
    const points = Number(asObject(ctx.body).points);
    const id = asId(ctx.params.id);
    cards.grantPoints(id, points);
    audit(deps.db, owner.id, 'card_points', `${who(deps.db, owner.id)}给角色卡 ${id} 发了 ${points} 点成长点`);
    return { ok: true };
  });
}
