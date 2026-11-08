import { requireAdmin, requireUser, requireViewer } from '../auth';
import { asObject, HttpError, type Router } from '../http';
import { crystalsOf } from '../pets';
import { EXCHANGE_ITEM } from '../../shared/shop';
import type { Deps } from '../app';
import { registerShopAdminRoutes } from './shop-admin';

// 商城、我的背包、装扮、头像框（V0.7.0）；管理员改商城的价格。逻辑在 shop.ts。

export function registerShopRoutes(router: Router, deps: Deps) {
  const { db, hub, shop, engine } = deps;
  // 商城：现在卖的东西（带现价）、龙晶、龙晶记录。游客也能看（V0.7.1）：只有商品和价格，买不了
  router.get('/api/shop', (ctx) => {
    const user = requireViewer(ctx);
    return shop.page(user.id, user.isGuest);
  });

  // 买：{ item: 商品编号, count }（换额度的 count 是换几元）。返回买完以后的商城
  router.post('/api/shop/buy', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    const item = typeof body.item === 'string' ? body.item : '';
    const count = body.count === undefined ? 1 : typeof body.count === 'number' ? body.count : NaN;
    shop.buy(user.id, item, count);
    // 换了额度：他在的各局刷新额度（额度用完了在等他的回合，换完马上又能交行动）
    if (item === EXCHANGE_ITEM) engine.creditChanged([user.id], true);
    return shop.page(user.id);
  });

  // 自己的龙晶（顶栏右上角；变了的时候服务器另外推 crystals）
  router.get('/api/me/crystals', (ctx) => {
    const user = requireUser(ctx);
    return { crystals: crystalsOf(db, user.id) };
  });

  // 我的背包：吃的用的、地下城道具、宝箱、装备
  router.get('/api/bag', (ctx) => {
    const user = requireUser(ctx);
    return shop.bag(user.id);
  });

  // 装扮：有的头像框、骰子、称号、宠物装扮和戴着的（游客也能打开看看：什么都没有，也戴不了）
  router.get('/api/wardrobe', (ctx) => {
    const user = requireViewer(ctx);
    return shop.wardrobe(user.id);
  });

  // 戴上头像框：{ frame: key | null }（null 是摘掉）
  router.put('/api/me/frame', (ctx) => {
    const user = requireUser(ctx);
    const frame = asObject(ctx.body).frame;
    if (frame !== null && typeof frame !== 'string') throw new HttpError(400, '请求格式不对');
    shop.setFrame(user.id, frame);
    // 开着的别的页面：顶栏的头像跟着换
    hub.toUser(user.id, 'me-changed', {});
    return shop.wardrobe(user.id);
  });

  // ==================== 管理员（发放额度权限：龙晶能换额度，价格和它连着） ====================

  router.get('/api/admin/shop-prices', (ctx) => {
    requireAdmin(ctx, 'credit');
    return { items: shop.adminPrices() };
  });

  // 改价：{ key: 商品编号, price: 龙晶 | null }（null 是恢复默认价）
  router.put('/api/admin/shop-prices', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    if (typeof body.key !== 'string') throw new HttpError(400, '请选要改的商品');
    if (body.price !== null && typeof body.price !== 'number') throw new HttpError(400, '价格要填整数');
    shop.setPrice(admin.id, body.key, body.price);
    return { items: shop.adminPrices() };
  });

  // V0.7.1：上架、下架商品，发物品（routes/shop-admin.ts）
  registerShopAdminRoutes(router, deps);
}
