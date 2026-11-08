import { requireUser } from '../auth';
import { requireCredit } from '../credit';
import { asObject, type Router } from '../http';
import type { Deps } from '../app';

// 网站向导（V0.6.0）：正式用户问关于这个网站的事，花自己的额度。逻辑在 guide.ts。

export function registerGuideRoutes(router: Router, { db, guide, limiter }: Deps) {
  // 对话和现在能不能问
  router.get('/api/guide', (ctx) => {
    const user = requireUser(ctx);
    return guide.page(user.id);
  });

  // 问一个问题：{ question }
  router.post('/api/guide', async (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('guide', user.id);
    requireCredit(db, user.id);
    const body = asObject(ctx.body);
    return guide.ask(user.id, typeof body.question === 'string' ? body.question : '');
  });

  // 清空对话
  router.delete('/api/guide', (ctx) => {
    const user = requireUser(ctx);
    guide.clear(user.id);
    return guide.page(user.id);
  });
}
