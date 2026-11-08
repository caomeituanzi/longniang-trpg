import type { Router } from '../http';
import type { Deps } from '../app';
import { APP_VERSION } from '../version';

// 健康检查（V0.8.0）：不用登录，给监控网站在线的工具用。查一下数据库能不能用，
// 正常回 { ok: true, version }，数据库出错回 503 { ok: false }。别的什么都不说。

export function registerHealthRoutes(router: Router, deps: Deps) {
  router.get('/api/health', (ctx) => {
    try {
      deps.db.prepare('SELECT 1').get();
    } catch (err) {
      console.error('健康检查：数据库用不了：', err);
      ctx.status = 503;
      return { ok: false };
    }
    return { ok: true, version: APP_VERSION };
  });
}
