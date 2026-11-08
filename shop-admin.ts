import { requireAdmin } from '../auth';
import { asId, asObject, HttpError, type Router } from '../http';
import { grantItems } from '../item-grants';
import { adminListings, createListing, hiddenItems, itemOptions, setHidden, updateListing } from '../shop-listings';
import type { AdminShopPage } from '../../shared/shop-admin';
import type { Deps } from '../app';

// 管理页「商城」「物品」（V0.7.1），都要「发放额度」权限（和改价一样：龙晶能换额度）：
// 自带的商品下架、重新上架；上架新商品、改价、改称号的名字、下架、重新上架；给账号发物品。逻辑在 shop-listings.ts、item-grants.ts。

export function registerShopAdminRoutes(router: Router, { db, shop, social, now }: Deps) {
  /** 管理页「商城」：自带的商品（默认价、现价、下架了没有）、管理员上架的、上架时能选的东西。 */
  const page = (): AdminShopPage => {
    const hidden = hiddenItems(db);
    return { items: shop.adminPrices().map((i) => ({ ...i, hidden: hidden.has(i.key) })), listings: adminListings(db), options: itemOptions(db, false) };
  };

  router.get('/api/admin/shop', (ctx) => {
    requireAdmin(ctx, 'credit');
    return page();
  });

  // 自带的商品下架、重新上架：{ key: 商品编号, hidden: true（下架） | false（上架） }
  router.put('/api/admin/shop/hidden', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    if (typeof body.key !== 'string' || typeof body.hidden !== 'boolean') throw new HttpError(400, '请求格式不对');
    setHidden(db, admin.id, body.key, body.hidden, now());
    return page();
  });

  // 上架新商品：{ kind, ref, name?, count?, price }（见 shop-listings.ts 的 createListing）
  router.post('/api/admin/shop/listings', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    createListing(db, admin.id, asObject(ctx.body), now());
    ctx.status = 201;
    return page();
  });

  // 改管理员上架的商品：{ price?, name?（称号）, listed?（false 下架，true 重新上架） }
  router.put('/api/admin/shop/listings/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    updateListing(db, admin.id, asId(ctx.params.id), asObject(ctx.body), now());
    return page();
  });

  // 管理页「物品」：能发的东西（传奇装备只有站长有）
  router.get('/api/admin/items', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    return { options: itemOptions(db, admin.isOwner) };
  });

  // 发物品：{ item, count?, accounts?: [用户名、UID 或公开编号] | all: true }（见 item-grants.ts）
  router.post('/api/admin/items/grant', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    return grantItems({ db, social, now }, admin, asObject(ctx.body));
  });
}
