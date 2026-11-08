import { audit } from '../audit';
import { requireAdmin, requireViewer } from '../auth';
import { Events } from '../events';
import { asId, asObject, type Router } from '../http';
import { CATEGORY_NAME } from '../../shared/game';
import { shopItemOf } from '../../shared/pets';
import type { EventView } from '../../shared/events';
import type { Deps } from '../app';

// 限时活动（V0.6.0）：进行中的活动（游戏大厅上方、商店用）；管理员（发放额度权限）开、改、删活动。逻辑在 events.ts。

function describe(e: Omit<EventView, 'id'>): string {
  const when = `${new Date(e.startsAt).toLocaleString('zh-CN')} 到 ${new Date(e.endsAt).toLocaleString('zh-CN')}`;
  const parts = [
    when,
    e.categories.length ? `${e.categories.map((c) => CATEGORY_NAME[c]).join('、')}龙晶翻倍` : '',
    e.items.length ? `限时商品：${e.items.map((i) => shopItemOf(i)?.name ?? i).join('、')}` : '',
    e.title ? `称号「${e.title}」` : '',
  ];
  return parts.filter(Boolean).join('；');
}

export function registerEventRoutes(router: Router, { db, events, now }: Deps) {
  // 进行中的活动
  router.get('/api/limited-events', (ctx) => {
    requireViewer(ctx);
    return { events: events.active() };
  });

  router.get('/api/admin/limited-events', (ctx) => {
    requireAdmin(ctx, 'credit');
    return { events: events.list(), now: now() };
  });

  router.post('/api/admin/limited-events', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const input = Events.check(asObject(ctx.body));
    const e = events.create(admin.id, input);
    audit(db, admin.id, '开活动', `「${e.name}」：${describe(e)}`, now());
    ctx.status = 201;
    return { events: events.list(), now: now() };
  });

  router.put('/api/admin/limited-events/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const id = asId(ctx.params.id);
    const input = Events.check(asObject(ctx.body));
    const e = events.update(id, input);
    audit(db, admin.id, '改活动', `「${e.name}」：${describe(e)}`, now());
    return { events: events.list(), now: now() };
  });

  router.delete('/api/admin/limited-events/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const e = events.remove(asId(ctx.params.id));
    audit(db, admin.id, '删活动', `「${e.name}」：${describe(e)}`, now());
    return { events: events.list(), now: now() };
  });
}
