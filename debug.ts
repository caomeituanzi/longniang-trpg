import { audit } from '../audit';
import { requireAdmin } from '../auth';
import { buildDebugPackage } from '../debug-export';
import { asId, STREAMING, type Router } from '../http';
import type { Deps } from '../app';

// 整局排查包（V0.6.0）：有「管理所有对局」权限的管理员下载一局的 zip（诊断、时间线、原始数据）。每次导出记进操作记录。

export function registerDebugRoutes(router: Router, { db, ai, limiter, now }: Deps) {
  router.get('/api/admin/rooms/:id/debug-package', (ctx) => {
    const admin = requireAdmin(ctx, 'rooms');
    limiter.hit('debugExport', admin.id);
    const roomId = asId(ctx.params.id);
    const pkg = buildDebugPackage(db, ai, roomId, { id: admin.id, name: admin.displayName }, now());
    audit(db, admin.id, '导出排查包', pkg.summary, now());
    const ascii = `debug-room-${roomId}.zip`;
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': pkg.data.length,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pkg.filename)}`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(pkg.data);
    return STREAMING;
  });
}
