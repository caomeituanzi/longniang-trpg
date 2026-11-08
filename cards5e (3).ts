import { audit, who } from '../audit';
import { requireOwner, requireUser, requireViewer } from '../auth';
import { asId, asObject, HttpError, type Router } from '../http';
import { monsterData, rules5e } from '../5e/rules-data';
import { CARD5E_MAX } from '../cards5e';
import type { Deps } from '../app';

// 5E 规则（V0.9.0）：规则数据（做卡、规则页、剧本编辑器用）、「我的角色」里的「5E 角色」（做卡、改卡、升级、删卡）。逻辑在 cards5e.ts。

export function registerCard5eRoutes(router: Router, deps: Deps) {
  const { cards5e } = deps;

  // 规则数据：职业、种族、背景、专长、装备、法术……（不含怪物）。规则页游客也能看
  router.get('/api/5e/rules', (ctx) => {
    requireViewer(ctx);
    return rules5e();
  });

  // 一个怪物的数据块（剧本编辑器、规则页看怪物用）
  router.get('/api/5e/monsters/:key', (ctx) => {
    requireViewer(ctx);
    const m = monsterData(ctx.params.key);
    if (!m) throw new HttpError(404, '没有这个怪物');
    return { monster: m };
  });

  router.get('/api/cards5e', (ctx) => {
    const user = requireUser(ctx);
    return { cards: cards5e.list(user.id), max: CARD5E_MAX };
  });

  // 做卡：{ name, appearance, background, data（卡上的选择，见 shared/5e/types.ts 的 Card5eData；物品和钱服务器按起始装备算）}
  router.post('/api/cards5e', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards5e.create(user.id, asObject(ctx.body)) };
  });

  // 改卡：名字、外貌、背景、onProfile；rest（长休能换的：equipped、prepared、masteries、wildShapes）；没打过模组的 1 级卡可以交整张 data
  router.put('/api/cards5e/:id', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards5e.update(user.id, asId(ctx.params.id), asObject(ctx.body)) };
  });

  // 升一级：{ data（升级以后的整张卡，新一级的选择做好了）}
  router.post('/api/cards5e/:id/level-up', (ctx) => {
    const user = requireUser(ctx);
    return { card: cards5e.levelUp(user.id, asId(ctx.params.id), asObject(ctx.body)) };
  });

  router.delete('/api/cards5e/:id', (ctx) => {
    const user = requireUser(ctx);
    cards5e.remove(user.id, asId(ctx.params.id));
    return { ok: true };
  });

  // 站长给一张 5E 卡发一级（测试高等级模组用）
  router.post('/api/admin/cards5e/:id/level', (ctx) => {
    const owner = requireOwner(ctx);
    const id = asId(ctx.params.id);
    cards5e.grantLevel(id);
    audit(deps.db, owner.id, 'card5e_level', `${who(deps.db, owner.id)}给 5E 角色卡 ${id} 发了一级`);
    return { ok: true };
  });
}
