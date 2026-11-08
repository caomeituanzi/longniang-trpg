import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';

// 数据库备份：放在数据库旁边的 backups 文件夹里。
// 数据库升级前（换了新版本）自动备份一份；用旧版本的数据替换掉现有数据之前也备份（scripts/upgrade.mjs 做的）；
// 管理员也可以在「管理」→「版本和数据」里手动备份；npm run reset 清空数据之前也备份一份。
// 服务器开着时每天自动备份一份（V0.8.0，scheduleDailyBackups）。
// 升级前的自动备份只留最近 AUTO_BACKUPS_KEPT 份，每天自动备份只留最近 DAILY_BACKUPS_KEPT 份；别的备份是唯一的一份，不会自动删。

export type BackupKind = 'upgrade' | 'import' | 'manual' | 'reset' | 'daily';

const PREFIX: Record<BackupKind, string> = {
  upgrade: 'before-upgrade',
  import: 'before-import',
  manual: 'manual',
  reset: 'before-reset',
  daily: 'daily',
};

export const AUTO_BACKUPS_KEPT = 10;
/** 每天自动备份只留最近这么多份。 */
export const DAILY_BACKUPS_KEPT = 14;
/** 最近一份每天自动备份是这么久以前的（或者还没有），就再备份一份。 */
export const DAILY_BACKUP_AFTER_MS = 23 * 60 * 60_000;
/** 服务器启动以后过多久看第一次、以后隔多久看一次该不该备份了。 */
export const DAILY_BACKUP_FIRST_CHECK_MS = 2 * 60_000;
export const DAILY_BACKUP_CHECK_MS = 60 * 60_000;

export type BackupInfo = { name: string; kind: BackupKind; size: number; createdAt: number };

export function backupDir(dbFile: string): string {
  return path.join(path.dirname(path.resolve(dbFile)), 'backups');
}

/** 本地时间，文件名里用：20261025-170500 */
export function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 文件名里的时间（20261025-170500），按它排先后：电脑的时钟被调过也不会排错。 */
function stampOf(name: string): string {
  return /(\d{8}-\d{6})(?:-(\d+))?\.db$/.exec(name)?.slice(1, 3).map((x) => x ?? '').join('-') ?? '';
}

/** 正式的备份文件名：前缀-20261025-170500.db（同一秒里有好几份时后面加 -2、-3）。写到一半的 .partial 不算。 */
function kindOf(name: string): BackupKind | null {
  if (!/-\d{8}-\d{6}(?:-\d+)?\.db$/.test(name)) return null;
  for (const kind of Object.keys(PREFIX) as BackupKind[]) {
    if (name.startsWith(`${PREFIX[kind]}-`)) return kind;
  }
  return null;
}

// ---------- 写备份：先写临时名，写完再改成正式的名字（V0.8.0）----------

/** 正在写的备份先叫「正式名.partial」（不会被当成备份），写完了再改名。写到一半断电、被强行结束留下的，下次清掉。 */
const PARTIAL_SUFFIX = '.partial';
/** 备份前硬盘至少要剩下数据库大小的这么多倍，不够就不备份（免得写到一半把硬盘写满）。 */
export const BACKUP_SPACE_FACTOR = 1.2;

/** 硬盘空间不够，没有备份。 */
export class BackupSpaceError extends Error {}

const MB = (bytes: number) => Math.ceil(bytes / 1024 / 1024);

/** 硬盘还剩多少（字节）；看不了（有的网络盘）是 null。 */
function freeSpace(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** 剩下的空间不到数据库大小的 1.2 倍：抛 BackupSpaceError，说清楚要多少、剩多少。 */
function checkFreeSpace(db: DB, dir: string) {
  const free = freeSpace(dir);
  if (free === null) return;
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const need = pages * pageSize * BACKUP_SPACE_FACTOR;
  if (free < need) {
    throw new BackupSpaceError(`硬盘空间不够，这次没有备份：备份大约要 ${MB(need)} MB，${dir} 所在的硬盘只剩 ${MB(free)} MB。腾出一些空间再备份。`);
  }
}

function removeQuietly(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 删不掉（被别的程序打开着）就留着，下次再删
  }
}

/** 写到一半的备份留下的文件：临时名本身和它的 -journal（以防万一 -wal、-shm 也删）。 */
function removePartial(partial: string) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) removeQuietly(partial + suffix);
}

/**
 * 备份文件夹里没用的东西：写到一半的 .partial（和它的 -journal）；孤零零的 -journal（对应的备份已经删了）；
 * 旁边还躺着 -journal 的备份（以前的版本写到一半被打断留下的，打开会是空的，不能用）。启动时和每次备份前清一遍。
 */
export function cleanupBackupLeftovers(dbFile: string) {
  if (dbFile === ':memory:') return;
  const dir = backupDir(dbFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const present = new Set(names);
  for (const name of names) {
    if (/\.db\.partial(?:-journal|-wal|-shm)?$/.test(name)) {
      removeQuietly(path.join(dir, name));
    } else if (name.endsWith('.db-journal')) {
      const db = name.slice(0, -'-journal'.length);
      if (present.has(db) && kindOf(db)) {
        console.log(`删掉了一份没写完的备份：${db}（上次备份时被打断了，这份不能用）`);
        removeQuietly(path.join(dir, db));
      }
      removeQuietly(path.join(dir, name));
    }
  }
}

/** 改名：Windows 上杀毒软件刚好在看新文件时会改不了，等一下再试几次。 */
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * 把数据库完整地复制一份（VACUUM INTO：对局进行中也能备份，复制出来的是某一刻的完整数据），返回备份文件的路径。
 * 先写到临时名，写完了再改成正式的名字：写到一半出错、断电、被强行结束，都不会留下一份坏的备份（V0.8.0）。
 * 硬盘剩下的空间不到数据库大小的 1.2 倍时不备份，抛 BackupSpaceError。
 */
export function backupDatabase(db: DB, dbFile: string, kind: BackupKind, now: Date = new Date()): string {
  const dir = backupDir(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  cleanupBackupLeftovers(dbFile);
  checkFreeSpace(db, dir);
  const base = `${PREFIX[kind]}-${stamp(now)}`;
  let file = path.join(dir, `${base}.db`);
  for (let i = 2; fs.existsSync(file) || fs.existsSync(file + PARTIAL_SUFFIX); i++) file = path.join(dir, `${base}-${i}.db`);
  const partial = file + PARTIAL_SUFFIX;
  try {
    db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
    renameWithRetry(partial, file);
  } catch (err) {
    removePartial(partial);
    throw err;
  }
  if (kind === 'upgrade') pruneUpgradeBackups(dbFile, path.basename(file));
  if (kind === 'daily') pruneDailyBackups(dbFile, path.basename(file), now.getTime());
  return file;
}

/** backups 文件夹里的备份，新的在前。只认正式的名字；旁边还有 -journal 的（没写完的）不算。 */
export function listBackups(dbFile: string): BackupInfo[] {
  const dir = backupDir(dbFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const list: BackupInfo[] = [];
  for (const name of names) {
    const kind = kindOf(name);
    if (!kind || present.has(`${name}-journal`)) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) list.push({ name, kind, size: stat.size, createdAt: stat.mtimeMs });
    } catch {
      // 刚被删掉了
    }
  }
  return list.sort((a, b) => stampOf(b.name).localeCompare(stampOf(a.name)) || b.createdAt - a.createdAt);
}

/** 升级前的自动备份只留最近几份（刚做的这份一定留着）。 */
function pruneUpgradeBackups(dbFile: string, justMade: string) {
  const dir = backupDir(dbFile);
  const upgrades = listBackups(dbFile).filter((b) => b.kind === 'upgrade');
  for (const old of upgrades.slice(AUTO_BACKUPS_KEPT)) {
    if (old.name === justMade) continue;
    try {
      fs.rmSync(path.join(dir, old.name));
    } catch {
      // 删不掉就留着，下次再删
    }
    // 它要是还带着 -journal，一起删（V0.8.0）
    removeQuietly(path.join(dir, `${old.name}-journal`));
  }
}

// ---------- 每天自动备份（V0.8.0）----------

/** 比现在晚这么多以上的备份，当它是电脑的时钟被往回调以前做的（差一点点的是对时、夏令时，不算）。 */
const CLOCK_SLACK_MS = 60 * 60_000;

/** 文件名里的时间（本地时间，20261025-170500）换成毫秒；认不出来是 null。 */
function stampTime(name: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.db$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const at = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * 每天自动备份，新的在前（按文件名里的时间）。文件名里的时间比现在还晚的，其实是时钟被往回调以前做的，更旧：排到最后。
 * at 是文件名里的时间。
 */
function dailyBackups(dbFile: string, now: number): (BackupInfo & { at: number })[] {
  const list = listBackups(dbFile)
    .filter((b) => b.kind === 'daily')
    .map((b) => ({ ...b, at: stampTime(b.name) ?? b.createdAt }));
  const future = (b: { at: number }) => b.at > now + CLOCK_SLACK_MS;
  return [...list.filter((b) => !future(b)), ...list.filter(future)];
}

/** 每天自动备份只留最近几份（刚做的这份一定留着）。 */
function pruneDailyBackups(dbFile: string, justMade: string, now: number) {
  const dir = backupDir(dbFile);
  for (const old of dailyBackups(dbFile, now).slice(DAILY_BACKUPS_KEPT)) {
    if (old.name === justMade) continue;
    try {
      fs.rmSync(path.join(dir, old.name));
    } catch {
      // 删不掉就留着，下次再删
    }
    removeQuietly(path.join(dir, `${old.name}-journal`));
  }
}

/** 最近一次每天自动备份的时间（文件名里的时间）；还没有是 null。 */
export function lastDailyBackupAt(dbFile: string, now: number): number | null {
  const latest = dailyBackups(dbFile, now)[0];
  return latest && latest.at <= now + CLOCK_SLACK_MS ? latest.at : null;
}

/** 最近一份每天自动备份是 23 小时以前的（或者还没有）：备份一份，返回备份文件的路径；还不用备份返回 null。 */
export function dailyBackupIfDue(db: DB, dbFile: string, now: number): string | null {
  if (dbFile === ':memory:') return null;
  const last = lastDailyBackupAt(dbFile, now);
  if (last !== null && now - last < DAILY_BACKUP_AFTER_MS) return null;
  return backupDatabase(db, dbFile, 'daily', new Date(now));
}

/**
 * 服务器开着时每天自动备份：启动 2 分钟后看一次，以后每小时看一次（dailyBackupIfDue）。
 * 出错了记进错误日志，不影响网站，下次再试。返回停下来的函数（关服务器时调用）。timing 测试用。
 */
export function scheduleDailyBackups(
  db: DB,
  dbFile: string,
  now: () => number,
  timing: { firstMs: number; everyMs: number } = { firstMs: DAILY_BACKUP_FIRST_CHECK_MS, everyMs: DAILY_BACKUP_CHECK_MS },
): () => void {
  if (dbFile === ':memory:') return () => {};
  let stopped = false;
  const check = () => {
    if (stopped) return;
    try {
      const file = dailyBackupIfDue(db, dbFile, now());
      if (file) console.log(`每天自动备份了一份：${file}`);
    } catch (err) {
      console.error('每天自动备份失败了（网站照常运行，一小时以后再试）：', err);
    }
  };
  const first = setTimeout(check, timing.firstMs);
  const timer = setInterval(check, timing.everyMs);
  first.unref();
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** 从旧版本搬数据时，start.bat 在数据库旁边留下的记录（scripts/upgrade.mjs 写的）。 */
export type ImportInfo = {
  from: string;
  version: string | null;
  at: number;
  counts: { users: number | null; rooms: number | null; scenarios: number | null } | null;
  scenarioFiles: string[];
};

export const IMPORT_INFO_FILE = 'imported-from.json';

export function readImportInfo(dbFile: string): ImportInfo | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(dbFile)), IMPORT_INFO_FILE), 'utf8'));
    if (typeof data?.from !== 'string' || typeof data?.at !== 'number') return null;
    return {
      from: data.from,
      version: typeof data.version === 'string' ? data.version : null,
      at: data.at,
      counts: data.counts && typeof data.counts === 'object' ? data.counts : null,
      scenarioFiles: Array.isArray(data.scenarioFiles) ? data.scenarioFiles.filter((f: unknown) => typeof f === 'string') : [],
    };
  } catch {
    return null;
  }
}
