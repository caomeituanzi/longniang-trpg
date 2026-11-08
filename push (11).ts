import { requireUser, SESSION_COOKIE, sessionId } from '../auth';
import { asId, HttpError, type Router } from '../http';
import type { PushDevice, PushInfo, PushPrefs } from '../../shared/push';
import type { Deps } from '../app';

// 浏览器推送（V0.8.0）：在这台设备上打开通知、设备列表、推哪几种。逻辑在 server/push.ts。
// 都要是能玩的账号（游客 403）。

export function registerPushRoutes(router: Router, deps: Deps) {
  const { push } = deps;

  // 服务器的公钥、推哪几类、我的设备。?device=…：这台设备推送地址的哈希（SHA-256，base64url），标出是哪一台。
  // 只传哈希：推送地址本身不进网址、不进访问日志
  router.get('/api/push', (ctx): PushInfo => {
    const user = requireUser(ctx);
    const device = ctx.url.searchParams.get('device');
    return push.info(user.id, device && /^[A-Za-z0-9_-]{43}$/.test(device) ? device : null);
  });

  // 这台设备打开通知：{ endpoint, keys: { p256dh, auth } }（浏览器的 PushSubscription.toJSON()）。
  // 订阅绑在这次登录上；网页每次打开（每个标签页一次）都会再交一次，绑到现在的登录上
  router.post('/api/push/subscriptions', (ctx): { device: PushDevice } => {
    const user = requireUser(ctx);
    const session = sessionId(ctx.cookies[SESSION_COOKIE]);
    if (!session) throw new HttpError(401, '需要先登录');
    const device = push.subscribe(user.id, session, ctx.body, ctx.req.headers['user-agent']);
    ctx.status = 201;
    return { device };
  });

  // 这台设备关掉通知：{ endpoint }（退出登录时网页也会先调用它）
  router.delete('/api/push/subscriptions', (ctx) => {
    const user = requireUser(ctx);
    push.unsubscribe(user.id, ctx.body);
    return { ok: true };
  });

  // 设备列表里删掉一台
  router.delete('/api/push/devices/:id', (ctx) => {
    const user = requireUser(ctx);
    push.removeDevice(user.id, asId(ctx.params.id));
    return { ok: true };
  });

  // 推哪几类：{ schedule?, started?, turn?, dm?, invites?, other? }
  router.put('/api/push/prefs', (ctx): { prefs: PushPrefs } => {
    const user = requireUser(ctx);
    return { prefs: push.setPrefs(user.id, ctx.body) };
  });

  // 发一条试试：给自己的所有设备发一条（每人 30 秒最多一次）
  router.post('/api/push/test', (ctx): { sent: number } => {
    const user = requireUser(ctx);
    return { sent: push.sendTest(user.id) };
  });
}
