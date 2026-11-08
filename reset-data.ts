import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SCENARIO_FILES } from '../scripts/builtin-scenarios.mjs';
import { ALL_PERMISSIONS } from '../shared/admin';
import { audit } from './audit';
import { hashPassword } from './auth';
import { backupDatabase, backupDir, IMPORT_INFO_FILE, stamp } from './backup';
import { transaction, type DB } from './db';
import { hiddenScenarios, setScenarioHidden } from './game/scenario-library';
import { setSetting } from './settings';

// 清空数据（npm run reset）：正式开放之前把测试时留下的账号、对局全部清掉，从一个新的站长账号重新开始。
// 留下的：数据库的版本、设置（AI 模型这些；AI 开关默认关掉）、这个版本自带的剧本。
// 动数据之前先备份整个数据库；不是这个版本自带的剧本文件、从旧版本复制数据的记录，挪进备份文件夹，不直接删。
// 第一次运行（npm run reset -- --first-run，start.bat 发现还没有数据时用）也走这里：数据库是刚建的，只建站长账号，不备份、不挪文件。

/** 不清空的表：数据库的版本、设置。账号清空以后，新建的站长是 0 号（正式账号用空着的最小的号）。 */
const KEEP = new Set(['schema_version', 'settings']);

export type ResetPlan = {
  users: number;
  rooms: number;
  /** 会挪走的剧本文件（不是这个版本自带的）。 */
  scenarioFiles: string[];
};

export type ResetResult = ResetPlan & {
  /** 清空之前的整个数据库备份（数据库不在文件里时是 null）。 */
  backup: string | null;
  /** 挪走的文件放在这里（没有要挪的是 null）。 */
  movedTo: string | null;
  owner: { id: number; uid: number; username: string };
  /** 清空以后没做成的收尾（数据已经清空了，这些不影响使用）。 */
  problems: string[];
};

export function extraScenarioFiles(scenarioDir: string): string[] {
  try {
    return fs
      .readdirSync(scenarioDir)
      .filter((f) => f.endsWith('.json') && !BUILTIN_SCENARIO_FILES.includes(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 清空之前先看看会清掉什么。只读，不改数据库；旧版本的数据库（还没升级）也能看。
 * db 是 null：数据库还没建。
 */
export function planReset(db: DB | null, scenarioDir: string): ResetPlan {
  const scenarioFiles = extraScenarioFiles(scenarioDir);
  if (!db) return { users: 0, rooms: 0, scenarioFiles };
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let users = 0;
  if (hasTable('users')) {
    // 删除账号（deleted_at）是 V0.3.0 才有的：旧版本的数据库没有这一列
    const columns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    users = count(`SELECT COUNT(*) AS n FROM users${columns.includes('deleted_at') ? ' WHERE deleted_at IS NULL' : ''}`);
  }
  return { users, rooms: hasTable('rooms') ? count('SELECT COUNT(*) AS n FROM rooms') : 0, scenarioFiles };
}

export type ResetOptions = {
  dbPath: string;
  scenarioDir: string;
  owner: { username: string; displayName: string; password: string };
  now?: number;
  /** 做完以后关掉 AI（默认关）。 */
  turnOffAi?: boolean;
  /** 清空之前备份（默认备份）。数据库是刚建的、里面什么都没有时不用。 */
  backup?: boolean;
  /** 第一次运行时建站长账号：数据库是刚建的，不备份，剧本文件一个都不挪（自己放进去的剧本留着）。 */
  firstRun?: boolean;
};

/**
 * 建站长账号（0 号，有全部权限，算同意过使用规则）。数据库里一个正式账号都没有时用：
 * 第一次运行、清空以后、V1.0.0 删档以后（ownerOnly：别的数据不动）。
 */
export async function createOwner(db: DB, owner: ResetOptions['owner'], at: number, note: string): Promise<ResetResult['owner']> {
  const passwordHash = await hashPassword(owner.password);
  return transaction(db, () => insertOwner(db, owner, passwordHash, at, note));
}

function insertOwner(db: DB, owner: ResetOptions['owner'], passwordHash: string, at: number, note: string | null): ResetResult['owner'] {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, rules_agreed_at, created_at, is_admin, is_owner, admin_perms, ai_credit_usd)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, 5)`,
    )
    .run(owner.username, owner.displayName, passwordHash, at, at, JSON.stringify(ALL_PERMISSIONS));
  const id = Number(lastInsertRowid);
  const row = db.prepare('SELECT uid, username FROM users WHERE id = ?').get(id) as { uid: number; username: string };
  if (note) audit(db, id, '建站长账号', note, at);
  return { id, uid: row.uid, username: row.username };
}

/**
 * 清空。出错抛出来的时候，数据库没有改动（清空在一个事务里，出错就整个撤回）；
 * 清空成功以后的收尾（检查、整理数据库文件、挪文件）出错不抛出，写在 problems 里。
 */
export async function resetData(db: DB, opts: ResetOptions): Promise<ResetResult> {
  const at = opts.now ?? Date.now();
  const plan: ResetPlan = opts.firstRun ? { users: 0, rooms: 0, scenarioFiles: [] } : planReset(db, opts.scenarioDir);
  const passwordHash = await hashPassword(opts.owner.password);
  const backup =
    opts.dbPath === ':memory:' || opts.backup === false || opts.firstRun ? null : backupDatabase(db, opts.dbPath, 'reset', new Date(at));

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((t) => t.name)
    .filter((name) => !KEEP.has(name));
  // 表之间互相引用：先关掉外键检查，全部清空以后再打开（清空以后不会有对不上的）
  db.exec('PRAGMA foreign_keys = OFF');
  let owner: ResetResult['owner'];
  try {
    owner = transaction(db, () => {
      for (const table of tables) db.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.exec('DELETE FROM sqlite_sequence');
      if (opts.turnOffAi !== false) setSetting(db, 'ai_enabled', '0');
      const made = insertOwner(db, opts.owner, passwordHash, at, opts.firstRun ? '第一次运行时建了站长账号' : null);
      if (!opts.firstRun) audit(db, made.id, '清空数据', `运行 npm run reset 清空了所有账号和对局${backup ? `，清空前的备份：${path.basename(backup)}` : ''}`, at);
      return made;
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // ---- 到这里已经清空了：下面的收尾出错也不抛出，记下来告诉运行的人 ----
  const problems: string[] = [];
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) problems.push(`清空以后有 ${broken.length} 处数据对不上。网站多半照常能用；不放心的话，可以用清空之前的备份恢复：${backup ?? '（没有备份）'}`);
  } catch (err) {
    problems.push(`清空以后没能检查数据（${reason(err)}）`);
  }
  // 删掉的数据占的空间还给硬盘
  if (opts.dbPath !== ':memory:') {
    try {
      db.exec('VACUUM');
    } catch (err) {
      problems.push(`没能整理数据库文件（${reason(err)}），不影响使用，只是文件比需要的大一些`);
    }
  }

  // 不是自带的剧本文件、从旧版本复制数据的记录：挪进备份文件夹
  let movedTo: string | null = null;
  const importInfo = opts.dbPath === ':memory:' || opts.firstRun ? null : path.join(path.dirname(path.resolve(opts.dbPath)), IMPORT_INFO_FILE);
  const hasImportInfo = importInfo !== null && fs.existsSync(importInfo);
  if (plan.scenarioFiles.length || hasImportInfo) {
    const base = opts.dbPath === ':memory:' ? path.join(opts.scenarioDir, '..', 'backups') : backupDir(opts.dbPath);
    let target = path.join(base, `reset-${stamp(new Date(at))}`);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(base, `reset-${stamp(new Date(at))}-${i}`);
    try {
      fs.mkdirSync(plan.scenarioFiles.length ? path.join(target, 'scenarios') : target, { recursive: true });
      movedTo = target;
    } catch (err) {
      problems.push(`没能建备份文件夹 ${target}（${reason(err)}），文件都没有挪`);
    }
    if (movedTo) {
      const hidden = hiddenScenarios(db);
      for (const file of plan.scenarioFiles) {
        try {
          await moveFile(path.join(opts.scenarioDir, file), path.join(movedTo, 'scenarios', file));
          // 下架的记录跟着文件走：以后再放进一个同名的剧本，不会一上来就是下架的
          const key = path.basename(file, '.json');
          if (hidden.has(key)) setScenarioHidden(db, key, false);
        } catch (err) {
          problems.push(`没能挪走剧本文件 ${file}（${reason(err)}）。它还在 scenarios 文件夹里，建对局时还能选到；不要的话关掉服务器以后手动删掉`);
        }
      }
      if (hasImportInfo) {
        try {
          await moveFile(importInfo, path.join(movedTo, IMPORT_INFO_FILE));
        } catch (err) {
          problems.push(`没能挪走 ${IMPORT_INFO_FILE}（${reason(err)}），留着也不影响使用`);
        }
      }
    }
  }
  return { ...plan, backup, movedTo, owner, problems };
}

const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

/** Windows 上杀毒软件、OneDrive、打开着它的编辑器有时会短暂占着文件：等一下再试（最多四秒左右）。 */
async function withRetry(fn: () => void) {
  for (let i = 0; ; i++) {
    try {
      fn();
      return;
    } catch (err) {
      if (i >= 20 || !BUSY_CODES.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** 挪文件：不在同一个盘上时改成先复制再删。 */
async function moveFile(from: string, to: string) {
  try {
    await withRetry(() => fs.renameSync(from, to));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    try {
      await withRetry(() => fs.unlinkSync(from));
    } catch (unlinkErr) {
      // 复制过去了，原来的删不掉：把复制的也删掉，算没挪
      fs.rmSync(to, { force: true });
      throw unlinkErr;
    }
  }
}
