import { audit } from '../audit';
import { requireOwner, requireViewer } from '../auth';
import type { Router } from '../http';
import type { Deps } from '../app';

// 图鉴（V0.6.0）：结局、明信片、装扮、骰子皮肤、成就。站长「给自己全部解锁」（测试用）。逻辑在 collection.ts。

export function registerCollectionRoutes(router: Router, { db, collection, now }: Deps) {
  // 游客也能打开看看（什么都还没收集到，全是「？？？」）
  router.get('/api/collection', (ctx) => {
    const user = requireViewer(ctx);
    return collection.book(user.id);
  });

  // 站长给自己全部解锁：背包里每样东西放一个，图鉴全开（只能给自己，不发龙晶）
  router.post('/api/admin/unlock-all', (ctx) => {
    const owner = requireOwner(ctx);
    collection.unlockAll(owner.id);
    audit(db, owner.id, '给自己全部解锁', '背包里每样东西放一个（道具、秘籍、宝箱、每种装备），结局、明信片、成就全部记上（不发龙晶）', now());
    return collection.book(owner.id);
  });
}
