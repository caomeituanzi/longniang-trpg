import type { Deps } from '../../app';
import { requireAdmin } from '../../auth';
import { asId, type Router } from '../../http';

// 操作记录：管理员做过的事（记录是 server/audit.ts 写的）。

export function registerAuditRoutes(router: Router, deps: Deps) {
  const { db } = deps;

  router.get('/api/admin/audit', (ctx) => {
    requireAdmin(ctx, 'audit');
    const beforeParam = ctx.url.searchParams.get('before');
    const before = beforeParam ? asId(beforeParam) : Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT a.id, a.admin_id, a.action, a.detail, a.created_at, u.username, u.display_name, u.is_owner FROM admin_audit a
         LEFT JOIN users u ON u.id = a.admin_id WHERE a.id < ? ORDER BY a.id DESC LIMIT 201`,
      )
      .all(before) as {
      id: number;
      admin_id: number | null;
      action: string;
      detail: string;
      created_at: number;
      username: string | null;
      display_name: string | null;
      is_owner: number | null;
    }[];
    return {
      entries: rows.slice(0, 200).map((r) => ({
        id: r.id,
        action: r.action,
        detail: r.detail,
        at: r.created_at,
        // 没有记是谁：网站自己做的（比如每天清理游客）
        by: r.username ? `${r.display_name}（${r.username}）${r.is_owner ? '，站长' : ''}` : r.admin_id === null ? '网站自动' : '已删除的账号',
      })),
      hasMore: rows.length > 200,
    };
  });
}
