import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app';
import { audit } from '../../audit';
import { requireAdmin } from '../../auth';
import { backupDatabase, backupDir, BackupSpaceError, lastDailyBackupAt, listBackups, readImportInfo } from '../../backup';
import { schemaVersion } from '../../db';
import { clearRecentErrors, errorLogDir, recentErrors } from '../../errorlog';
import { HttpError, type Router } from '../../http';
import { APP_AUTHOR, APP_VERSION } from '../../version';

// 版本和数据：版本号、数据库文件和大小、备份；手动备份一份。
// V0.8.0：服务器运行了多久、占了多少内存、最近一次每天自动备份、最近的错误（清空只清内存里的列表）。

export function registerSystemRoutes(router: Router, deps: Deps) {
  const { db, now, dbPath } = deps;

  const inMemory = dbPath === ':memory:';

  function systemInfo() {
    const file = inMemory ? null : path.resolve(dbPath);
    let size = 0;
    if (file) {
      for (const f of [file, `${file}-wal`]) {
        try {
          size += fs.statSync(f).size;
        } catch {
          // 没有这个文件
        }
      }
    }
    return {
      version: APP_VERSION,
      author: APP_AUTHOR,
      schemaVersion: schemaVersion(db),
      dbFile: file,
      dbSize: size,
      backupDir: file ? backupDir(file) : null,
      importedFrom: file ? readImportInfo(file) : null,
      backups: file ? listBackups(file) : [],
      runtime: {
        uptimeSeconds: Math.floor(process.uptime()),
        rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        lastDailyBackupAt: file ? lastDailyBackupAt(file, now()) : null,
        logDir: errorLogDir(),
        errors: recentErrors(),
      },
    };
  }

  router.get('/api/admin/system', (ctx) => {
    requireAdmin(ctx, 'system');
    return systemInfo();
  });

  // 手动备份一份：对局进行中也可以，备份的是这一刻的完整数据。
  // 备份的时候整个网站要停一下（数据库越大停得越久）：每个账号 10 分钟最多 3 次（V0.8.0）
  router.post('/api/admin/backup', (ctx) => {
    const admin = requireAdmin(ctx, 'system');
    if (inMemory) throw new HttpError(409, '数据库不在文件里，没法备份');
    deps.limiter.hit('backup', admin.id);
    let file: string;
    try {
      file = backupDatabase(db, dbPath, 'manual', new Date(now()));
    } catch (err) {
      // 硬盘空间不够：说清楚要多少、剩多少（没有留下文件）
      if (err instanceof BackupSpaceError) throw new HttpError(507, err.message);
      throw err;
    }
    audit(db, admin.id, '手动备份', path.basename(file), now());
    ctx.status = 201;
    return { ...systemInfo(), created: path.basename(file) };
  });

  // 清空「最近的错误」：只清内存里的列表，日志文件不动
  router.delete('/api/admin/system/errors', (ctx) => {
    const admin = requireAdmin(ctx, 'system');
    const count = recentErrors().length;
    clearRecentErrors();
    audit(db, admin.id, '清空最近的错误', `${count} 条`, now());
    return systemInfo();
  });
}
