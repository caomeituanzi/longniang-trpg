// 升级到新版本时保留数据：把旧版本文件夹里的数据库（账号、对局、记录、AI 生成和导入的剧本、额度、违规记录……）、
// 设置文件 .env（API 密钥和其他设置）、自己放进 scenarios 的剧本文件复制到新版本。旧版本的文件夹不会被改动：
// 旧版本的数据库只用只读的方式打开（不会把它没合并的 -wal 合并进去），打开时临时生成的空文件用完就删掉。
//
// 新版本第一次双击 start.bat / start.command（还没有数据库）时，会调用 offerImport 问你要不要复制。
// 也可以手动运行（新版本的黑色窗口要先关掉）：
//   npm run import-data -- "旧版本的文件夹"            新版本里还没有数据时
//   npm run import-data -- "旧版本的文件夹" --force    用旧版本的数据替换掉新版本现在的数据（现在的会先备份）
//   npm run import-data -- "备份文件.db" --force       用 backups 里的备份恢复
// 只用 Node 自带的功能。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 各个版本 package.json 里的 name。以后改名的话，旧名字要留在这里，才认得出旧版本。 */
export const APP_PACKAGE_NAMES = ['ai-trpg'];

/** 各个版本自带的剧本文件（只增不减）：由新版本自己带，不从旧版本复制。 */
export { BUILTIN_SCENARIO_FILES, RETIRED_SCENARIO_FILES } from './builtin-scenarios.mjs';
import { BUILTIN_SCENARIO_FILES, RETIRED_SCENARIO_FILES } from './builtin-scenarios.mjs';

const DEFAULT_DB = path.join('data', 'game.db');
export const IMPORT_INFO_FILE = 'imported-from.json';
const DEFAULT_PORT = 3000;
// 找旧版本时不进这些文件夹（系统文件夹、依赖包，里面东西多又不可能有旧版本）
const SKIP_DIRS = new Set([
  'node_modules',
  'AppData',
  'Library',
  'Applications',
  '$RECYCLE.BIN',
  'System Volume Information',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
]);
const isWindows = process.platform === 'win32';

// ==================== 小工具 ====================

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
}

/** 设置文件的内容按服务器一样的规则读（Node 自带的 parseEnv：支持引号、行尾的 # 注释、export）。 */
export function parseEnvText(text) {
  try {
    return util.parseEnv(String(text).replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

/** 设置文件里某一项的值（没写、或者被 # 注释掉了是空字符串）。 */
export function envValue(text, key) {
  return String(parseEnvText(text)[key] ?? '').trim();
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间：2026-10-25 16:40 */
export function formatTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const sqlQuote = (file) => `'${file.replaceAll("'", "''")}'`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 改名。Windows 上杀毒软件、OneDrive 有时会短暂占着刚写好的文件，等一下再试。 */
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      sleepSync(200);
    }
  }
}

/** 版本号比大小：0.2.0 比 0.1.10 新。 */
export function compareVersions(a, b) {
  const x = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

// ==================== 数据库 ====================

let DatabaseSync = null;
/** Node 自带的 SQLite。加载时它会提示“实验性功能”，只会让人误以为出错了，屏蔽掉。 */
function sqlite() {
  if (!DatabaseSync) {
    const original = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
      const message = typeof warning === 'string' ? warning : warning?.message;
      if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
      return original.call(process, warning, ...rest);
    };
    ({ DatabaseSync } = process.getBuiltinModule('node:sqlite'));
  }
  return DatabaseSync;
}

/**
 * 只读打开旧版本的数据库，做完 fn 就关掉。
 * 只读：不会把旧版本没来得及合并的 -wal（直接关掉黑色窗口时会留下）合并进数据库文件，数据库文件和 -wal 都原样不动；
 * 只读连接在没有 -wal、-shm 的时候会新建这两个文件，关掉以后把自己新建的删掉。
 */
export function withReadOnly(file, fn) {
  const extras = [`${file}-wal`, `${file}-shm`];
  const existed = extras.map((f) => fs.existsSync(f));
  const db = new (sqlite())(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
    extras.forEach((f, i) => {
      if (existed[i]) return;
      try {
        // 只删自己新建的：-wal 要是空的才删（旧版本要是正好开着，这两个文件本来就在，不会走到这里）
        if (f.endsWith('-wal') && fs.statSync(f).size > 0) return;
        fs.rmSync(f, { force: true });
      } catch {
        // 没有新建，或者删不掉（留着也没关系）
      }
    });
  }
}

function withReadWrite(file, fn) {
  const db = new (sqlite())(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/** 有没有别的程序开着这个数据库（新版本的服务器还开着时，不能替换它的数据库）。 */
export function databaseInUse(file) {
  if (!fs.existsSync(file)) return false;
  const db = new (sqlite())(file);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    return false;
  } catch (err) {
    if (/locked|busy/i.test(String(err?.message))) return true;
    throw err;
  } finally {
    db.close();
  }
}

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      return head.toString('latin1') === 'SQLite format 3\0';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ==================== 认出一个版本 ====================

function packageOf(dir) {
  try {
    return JSON.parse(readText(path.join(dir, 'package.json')));
  } catch {
    return null;
  }
}

/** 这个文件夹是不是龙娘跑团（某个版本）：package.json 的 name 对得上，还有 server 文件夹。 */
export function isInstall(dir) {
  try {
    return APP_PACKAGE_NAMES.includes(packageOf(dir)?.name) && fs.statSync(path.join(dir, 'server')).isDirectory();
  } catch {
    return false;
  }
}

/** 版本号。V0.1.0 起才有版本号（有这个文件）；更早的版本 package.json 里写的版本号没有意义，返回 null。 */
export function installVersion(dir) {
  if (!fs.existsSync(path.join(dir, 'scripts', 'upgrade.mjs'))) return null;
  return packageOf(dir)?.version ?? null;
}

/** 那个版本比 root 这个版本新：它的数据（数据库升级过）root 打不开，不能拿来复制。 */
function newerThan(dir, root) {
  const theirs = installVersion(dir);
  const mine = packageOf(root)?.version;
  return !!theirs && !!mine && compareVersions(theirs, mine) > 0;
}

export function versionText(version) {
  return version ? `V${version}` : '更早的版本（还没有版本号）';
}

/** 这个版本的数据库文件：.env 里写了 DB_PATH 就用它（相对路径按这个文件夹算），否则是 data/game.db。 */
export function dbFileOf(dir, envText = readText(path.join(dir, '.env'))) {
  return path.resolve(dir, envValue(envText, 'DB_PATH') || DEFAULT_DB);
}

export function portOf(dir) {
  const port = Number(envValue(readText(path.join(dir, '.env')), 'PORT'));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/** 最后一次用的时间：数据库文件（或者还没合并进去的 -wal 文件）最后改动的时间。 */
export function lastUsedOf(dbFile) {
  return Math.max(mtime(dbFile), mtime(`${dbFile}-wal`));
}

/** 自己放进 scenarios 的剧本文件（不是哪个版本自带的，也不是以前的版本自带、后来去掉的）。 */
export function customScenarioFiles(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, 'scenarios'))
      .filter((f) => f.endsWith('.json') && !BUILTIN_SCENARIO_FILES.includes(f) && !RETIRED_SCENARIO_FILES.includes(f))
      .sort();
  } catch {
    return [];
  }
}

/** 数据库里有多少东西（只读）。读不出来的项是 null（太早的版本没有那张表）。 */
export function countData(dbFile) {
  return withReadOnly(dbFile, (db) => {
    const count = (sql) => {
      try {
        return Number(db.prepare(sql).get().n);
      } catch {
        return null;
      }
    };
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      rooms: count('SELECT COUNT(*) AS n FROM rooms'),
      scenarios: count("SELECT COUNT(*) AS n FROM scenarios WHERE source IN ('generated', 'imported')"),
    };
  });
}

/**
 * V1.0.0 正式版删档（数据库第 23 版的升级做的）：之前的数据（第 22 版以前）一升级就清空账号、对局和公告。
 * 新版本是 1.0.0 以后、旧数据是删档以前的：复制之前说清楚。
 */
export const BETA_WIPE_SCHEMA = 23;

function schemaOf(dbFile) {
  try {
    return withReadOnly(dbFile, (db) => Number(db.prepare('SELECT version FROM schema_version').get()?.version ?? 0));
  } catch {
    return null;
  }
}

/** 这份数据升级到这个版本时会删档（数据是删档以前的，这个版本是 1.0.0 以后的）。 */
export function willWipe(dbFile, root = PROJECT_ROOT) {
  const ours = packageOf(root)?.version ?? '0';
  if (compareVersions(ours, '1.0.0') < 0) return false;
  const schema = schemaOf(dbFile);
  return schema !== null && schema > 0 && schema < BETA_WIPE_SCHEMA;
}

/**
 * start.bat 要不要问你建站长账号：还没有数据库；数据要删档（升级时连账号一起清掉）；或者里面一个正式账号都没有。
 */
export function needsOwner(dbFile, root = PROJECT_ROOT) {
  if (!fs.existsSync(dbFile)) return true;
  if (willWipe(dbFile, root)) return true;
  try {
    return withReadOnly(dbFile, (db) => !db.prepare('SELECT 1 FROM users WHERE is_guest = 0 AND deleted_at IS NULL').get());
  } catch {
    return false;
  }
}

/** 一个旧版本的情况：在哪、什么版本、最后用的时间、有多少数据、自己加的剧本文件。 */
export function describeInstall(dir) {
  const dbFile = dbFileOf(dir);
  const exists = fs.existsSync(dbFile);
  const lastUsed = exists ? lastUsedOf(dbFile) : null;
  return {
    dir,
    dbFile,
    exists,
    lastUsed,
    version: installVersion(dir),
    counts: exists ? countData(dbFile) : null,
    scenarioFiles: customScenarioFiles(dir),
  };
}

export function describeCounts(counts, scenarioFiles = []) {
  const parts = [];
  if (counts?.users != null) parts.push(`账号 ${counts.users} 个`);
  if (counts?.rooms != null) parts.push(`对局 ${counts.rooms} 局`);
  if (counts?.scenarios != null) parts.push(`AI 生成和导入的剧本 ${counts.scenarios} 个`);
  if (scenarioFiles.length) parts.push(`自己加的剧本文件 ${scenarioFiles.length} 个`);
  return parts.join('，');
}

// ==================== 找旧版本 ====================

/** 一个文件夹下面的子文件夹（快捷方式、OneDrive 里的文件夹也算，只要它指向的是文件夹）。 */
function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(p);
    } else if (e.isSymbolicLink()) {
      try {
        if (fs.statSync(p).isDirectory()) out.push(p);
      } catch {
        // 指向的地方不在了
      }
    }
  }
  return out;
}

/**
 * 在新版本旁边找有数据的旧版本：新版本文件夹的上一层、上两层里，往下看两层；上一层、上两层本身是旧版本也算
 * （新版本解压在旧版本的文件夹里面）。这样能找到解压在同一个地方的旧版本（Mac 解压出来是并排的两个文件夹；
 * Windows 的「全部解压」会多套一层同名文件夹）。
 * 不在家目录和磁盘根目录里往下找：Mac 上翻家目录里的「桌面」「文稿」会一个个弹出权限请求，那里也很少直接放旧版本。
 * 比这个版本新的不算（它的数据这个版本打不开）。最近用过的排在前面。
 */
export function findInstalls(root = PROJECT_ROOT, { maxChecks = 5000, home = os.homedir() } = {}) {
  const self = realOrResolved(root);
  const ownDb = dbFileOf(self);
  const key = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
  const homeKey = key(realOrResolved(home));
  const parent = path.dirname(self);
  const grand = path.dirname(parent);
  const isDriveRoot = (p) => path.dirname(p) === p;
  const seen = new Set([key(self)]);
  const found = [];
  let checks = 0;

  /** 看一个文件夹：是旧版本就记下来（有数据、不比这个版本新的才算），返回它是不是旧版本。 */
  const consider = (dir) => {
    checks++;
    if (!isInstall(dir)) return false;
    const dbFile = dbFileOf(dir);
    if (!samePath(dbFile, ownDb) && fs.existsSync(dbFile) && !newerThan(dir, self)) {
      found.push({ dir, dbFile, lastUsed: lastUsedOf(dbFile) });
    }
    return true;
  };

  for (const up of [parent, grand]) {
    if (seen.has(key(up))) continue;
    seen.add(key(up));
    consider(up);
  }
  const scanRoots = [parent, grand].filter((p, i, all) => all.indexOf(p) === i && !isDriveRoot(p) && key(p) !== homeKey);
  outer: for (const scanRoot of scanRoots) {
    for (const child of subdirs(scanRoot)) {
      if (checks > maxChecks) break outer;
      if (seen.has(key(child))) continue;
      seen.add(key(child));
      if (consider(child)) continue; // 旧版本里面不用再往下找
      for (const grandchild of subdirs(child)) {
        if (checks > maxChecks) break outer;
        if (seen.has(key(grandchild))) continue;
        seen.add(key(grandchild));
        consider(grandchild);
      }
    }
  }
  return found.sort((a, b) => b.lastUsed - a.lastUsed);
}

// ==================== 拖进来的路径 ====================

/**
 * 把旧版本的文件夹拖进黑色窗口时粘贴进来的路径：Windows 上有空格的会加引号，Mac 上空格前面会加反斜杠。
 */
export function cleanDroppedPath(input) {
  let s = String(input).trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  } else if (!isWindows) {
    s = s.replace(/\\(.)/g, '$1');
  }
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s);
    } catch {
      // 不是正常的文件地址，按原样找
    }
  }
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

/** 输入的东西像不像一个路径（拖进来的文件夹、文件）。 */
function looksLikePath(input) {
  const s = String(input).trim();
  return /[\\/]/.test(s) || /^["'~]/.test(s) || s.startsWith('file:') || fs.existsSync(path.resolve(s));
}

/**
 * 拖进来的东西在某个旧版本里面（data、backups、scenarios……），或者是解压出来的外面那层（里面只有一个旧版本）：找到那个旧版本。
 * @returns {{ dir?: string, error?: string }}
 */
function installAround(dir, root) {
  if (isInstall(dir)) return { dir };
  const up1 = path.dirname(dir);
  if (isInstall(up1)) return { dir: up1 };
  const up2 = path.dirname(up1);
  if (isInstall(up2)) return { dir: up2 };
  const inner = subdirs(dir).filter((d) => isInstall(d) && !samePath(realOrResolved(d), realOrResolved(root)));
  if (inner.length === 1) return { dir: inner[0] };
  if (inner.length > 1) return { error: '这个文件夹里有好几个版本，请拖要复制的那一个版本的文件夹。' };
  return {};
}

/** @returns {{ dir?: string, dbFile?: string, error?: string }} */
function checkInstall(found, root) {
  if (found.error) return { error: found.error };
  const dir = found.dir;
  if (!dir || !isInstall(dir)) {
    return { error: '这不是龙娘跑团的文件夹（里面应该有 package.json、start.bat 和 server 文件夹）。' };
  }
  if (samePath(realOrResolved(dir), realOrResolved(root))) {
    return { error: '这是新版本自己的文件夹，请拖旧版本的文件夹。' };
  }
  if (newerThan(dir, root)) {
    return {
      error: `那是更新的版本（${versionText(installVersion(dir))}），它的数据这个版本（${versionText(packageOf(root)?.version)}）打不开。请用新版本。`,
    };
  }
  const dbFile = dbFileOf(dir);
  if (!fs.existsSync(dbFile)) return { error: `这个旧版本里还没有数据（没有 ${path.relative(dir, dbFile)}），不用复制。` };
  return { dir };
}

/**
 * 用户给的来源：旧版本的文件夹 → { dir }；数据库文件（比如 backups 里的备份）→ { dbFile }；不对 → { error }。
 * @param {string} input
 * @param {string} [root]
 * @returns {{ dir?: string, dbFile?: string, error?: string }}
 */
export function resolveSource(input, root = PROJECT_ROOT) {
  const p = cleanDroppedPath(input);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return { error: `找不到「${p}」。` };
  }
  if (stat.isFile()) {
    if (isSqliteFile(p)) {
      const around = installAround(path.dirname(p), root);
      if (around.dir && samePath(dbFileOf(around.dir), p)) return checkInstall(around, root);
      return { dbFile: p };
    }
    return checkInstall(installAround(path.dirname(p), root), root);
  }
  return checkInstall(installAround(p, root), root);
}

// ==================== 复制 ====================

/**
 * 把旧版本的数据复制到新版本。
 * from：旧版本的文件夹（复制数据库、.env、自己加的剧本文件）；或者只给 dbFile（一个数据库文件，只复制数据库）。
 * 新版本里已经有数据库时，要 force 才替换（新版本的服务器开着时不替换），替换前把现在的备份到 backups。
 * 新旧版本用的是同一个数据库文件（.env 里的 DB_PATH 指到同一个地方）时，不用复制数据库，只复制设置和剧本文件。
 * 数据库最后才放进去：中途出了错，下次启动时还会再问。
 * 返回复制了什么。旧版本的文件夹不会被改动。
 * @param {{ from?: string | null, dbFile?: string | null, to?: string, force?: boolean, now?: number }} options
 */
export function importData({ from = null, dbFile = null, to = PROJECT_ROOT, force = false, now = Date.now() }) {
  const source = from ? dbFileOf(from) : path.resolve(dbFile);
  if (!fs.existsSync(source)) throw new Error(`找不到旧版本的数据库：${source}`);
  if (!isSqliteFile(source)) throw new Error(`这不是数据库文件：${source}`);

  // 新版本还没有 .env 时会用旧版本的，数据库位置也按它算
  const envFrom = from ? path.join(from, '.env') : null;
  const envTo = path.join(to, '.env');
  const copyEnv = !!envFrom && fs.existsSync(envFrom) && !fs.existsSync(envTo);
  const target = dbFileOf(to, readText(copyEnv ? envFrom : envTo));
  const shared = samePath(source, target);
  if (shared && !from) throw new Error('这就是现在正在用的数据库文件，不用恢复。');
  const replacing = !shared && fs.existsSync(target);
  if (replacing && !force) {
    throw new Error(`新版本里已经有数据了（${target}）。要用旧版本的数据替换掉它，加上 --force（现在的数据会先备份到 backups 文件夹）。`);
  }
  if (replacing && databaseInUse(target)) {
    throw new Error('新版本的数据库正在被使用（新版本的黑色窗口可能还开着）。先关掉它，再复制。');
  }

  const counts = countData(source);
  // 1. 数据库先复制到临时文件：VACUUM INTO 复制出某一刻的完整数据（旧版本开着也不会复制到一半，没合并的 -wal 也算在内）
  const temp = shared ? null : `${target}.importing`;
  if (temp) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(temp, { force: true });
    withReadOnly(source, (db) => db.exec(`VACUUM INTO ${sqlQuote(temp)}`));
  }

  // 2. 设置文件
  if (copyEnv) fs.copyFileSync(envFrom, envTo);

  // 3. 自己加的剧本文件：新版本里没有同名文件的才复制
  const scenarioFiles = [];
  const scenarioSkipped = [];
  if (from) {
    for (const name of customScenarioFiles(from)) {
      const dest = path.join(to, 'scenarios', name);
      if (fs.existsSync(dest)) {
        scenarioSkipped.push(name);
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(from, 'scenarios', name), dest);
        scenarioFiles.push(name);
      }
    }
  }

  // 4. 数据库放进去：新版本里原来的数据先备份；留下的 -wal、-shm、-journal 是原来那个数据库的，一定要删掉，
  //    不然会被当成新数据库的一部分
  const version = from ? installVersion(from) : null;
  let backup = null;
  if (temp) {
    if (replacing) {
      const dir = path.join(path.dirname(target), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, `before-import-${stamp(now)}.db`);
      for (let i = 2; fs.existsSync(backup); i++) backup = path.join(dir, `before-import-${stamp(now)}-${i}.db`);
      // 先写到临时名，写完再改成正式名（V0.8.0）：写到一半出错、被打断时不会留下被当成备份的半截文件
      const partial = `${backup}.partial`;
      try {
        withReadWrite(target, (db) => db.exec(`VACUUM INTO ${sqlQuote(partial)}`));
        renameWithRetry(partial, backup);
      } catch (err) {
        for (const leftover of [partial, `${partial}-journal`]) fs.rmSync(leftover, { force: true });
        throw err;
      }
      fs.rmSync(target, { force: true });
    }
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${target}${suffix}`, { force: true });
    renameWithRetry(temp, target);
    // 记下是从哪里复制来的（管理页「版本和数据」里显示）
    const info = { from: from ? path.resolve(from) : source, version, at: now, counts, scenarioFiles };
    fs.writeFileSync(path.join(path.dirname(target), IMPORT_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
  }

  return {
    target,
    counts,
    version,
    shared,
    envCopied: copyEnv,
    envKept: !!envFrom && fs.existsSync(envFrom) && !copyEnv,
    scenarioFiles,
    scenarioSkipped,
    backup,
  };
}

/** 复制完以后给人看的结果。 */
export function summaryLines(result) {
  const lines = ['已经复制好了：'];
  const what = describeCounts(result.counts);
  if (result.shared) {
    lines.push('  数据库没有复制：新旧版本用的是同一个数据库文件（.env 里的 DB_PATH 指到同一个地方），新版本直接用它；');
    lines.push('  数据库要升级时会先备份，升级以后旧版本就打不开它了');
  } else {
    lines.push(`  数据库${what ? `：${what}` : ''}`);
  }
  if (result.envCopied) lines.push('  设置文件 .env（API 密钥和其他设置）');
  if (result.envKept) lines.push('  设置文件 .env 没有复制：这个文件夹里已经有了，用的还是它');
  if (result.scenarioFiles.length) lines.push(`  自己加的剧本文件：${result.scenarioFiles.join('、')}`);
  if (result.scenarioSkipped.length) lines.push(`  没有复制的剧本文件（新版本里已经有同名的）：${result.scenarioSkipped.join('、')}`);
  if (result.backup) lines.push(`  新版本里原来的数据备份到了：${result.backup}`);
  return lines;
}

// ==================== 旧版本还开着吗 ====================

/** 这个端口上有没有龙娘跑团（或者别的网页服务器）在运行。 */
export async function serverRunning(port) {
  try {
    await fetch(`http://localhost:${port}/api/auth/me`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

// ==================== start.bat 第一次启动时问你 ====================

/** 回答：全角的字母、数字也认（中文输入法下打出来的）。 */
const normalizeAnswer = (s) => String(s).normalize('NFKC').trim();
const YES = /^(y|yes|ok|是|好|要|复制)$/i;
const NO = /^(n|no|不|否|不要|不用|不复制)$/i;

/**
 * 新版本还没有数据库时：找旧版本，问要不要把数据复制过来。
 * 返回 'imported'（复制了）、'skipped'（不复制，新版本从空的开始）、'abort'（这次先不启动：旧版本还开着、没读到输入）。
 * ask(问题) 返回用户输入的一行，读不到输入（窗口的输入被关掉了）时返回 null；say(文字) 显示一行。
 * @param {{ root?: string, ask: (question: string) => Promise<string | null>, say: (text?: string) => void, maxWaits?: number, home?: string }} options
 * @returns {Promise<'imported' | 'skipped' | 'abort'>}
 */
export async function offerImport({ root = PROJECT_ROOT, ask, say, maxWaits = 20, home = os.homedir() }) {
  const found = findInstalls(root, { home })
    .slice(0, 5)
    .map((f) => describeInstall(f.dir));

  if (found.length) {
    say('找到了旧版本的数据：');
    found.forEach((d, i) => {
      say(`  ${i + 1}. ${d.dir}`);
      const what = describeCounts(d.counts, d.scenarioFiles);
      say(`     ${versionText(d.version)}，最后使用 ${formatTime(d.lastUsed)}${what ? `；${what}` : ''}`);
    });
    say('要把旧版本的账号、对局、剧本和设置（包括 API 密钥）复制到这个新版本吗？旧版本的文件夹不会被改动。');
    // V1.0.0 正式版：内测的数据复制过来以后会删档，先说清楚。
    // V1.0.1 起：列出来的有正式版也有内测版的（升级到 V1.0.1 时旁边常常还留着内测版的文件夹），写明是第几个，正式版的照常保留
    const beta = found.flatMap((d, i) => (d.exists && willWipe(d.dbFile, root) ? [i + 1] : []));
    if (beta.length) {
      const which = beta.length === found.length ? '内测版本的数据复制过来' : `上面第 ${beta.join('、')} 个是内测版本，复制它们的数据`;
      say(`  注意：这是正式版 ${versionText(packageOf(root)?.version ?? '')}。${which}、第一次启动时会清空：所有账号（包括站长）、对局、公告、投稿、聊天和记录都删掉，`);
      say('  只留下网站的设置（API 密钥、AI 模型和开关、商城、注册方式）、限时活动和你自己放进去的剧本文件（投稿通过的剧本挪进备份文件夹）。清空之前会自动备份，清空以后马上问你建新的站长账号。');
      if (beta.length < found.length) say('  V1.0.0 以后的版本复制过来，数据照常保留，不清空。');
    }
    say(found.length > 1 ? '  直接按回车：复制第 1 个；输入编号再按回车：复制那一个' : '  直接按回车：复制');
    say('  输入 n 再按回车：不复制，新版本从空的开始');
    say('  要用别的旧版本或者备份文件：把它拖进这个窗口，再按回车');
  } else {
    say('这个文件夹里还没有数据。');
    say('要把旧版本的数据（账号、对局、剧本和设置）复制过来，或者用备份恢复：把旧版本的文件夹（或者备份文件）拖进这个窗口，再按回车。旧版本的文件夹不会被改动。');
    say('没有旧版本，或者不用复制：直接按回车。');
  }
  const hint = found.length ? '直接按回车复制第 1 个，输入编号选一个，输入 n 不复制，或者把旧版本的文件夹拖进来。' : '把旧版本的文件夹拖进来，或者直接按回车跳过。';

  let source = null;
  while (!source) {
    const raw = await ask('> ');
    if (raw === null) {
      say('没有读到输入，这次先不复制，也不启动。');
      return 'abort';
    }
    const answer = normalizeAnswer(raw);
    if (!answer || YES.test(answer)) {
      if (found.length) source = { dir: found[0].dir };
      else if (!answer) return 'skipped';
      else say(`旁边没有找到旧版本。${hint}`);
    } else if (NO.test(answer)) {
      return 'skipped';
    } else if (/^\d+$/.test(answer) && found.length) {
      const pick = found[Number(answer) - 1];
      if (pick) source = { dir: pick.dir };
      else say(`没有第 ${answer} 个。${hint}`);
    } else if (looksLikePath(raw)) {
      const resolved = resolveSource(raw, root);
      if (resolved.error) say(`${resolved.error}${hint}`);
      else source = resolved;
    } else {
      say(`没看懂「${raw.trim()}」。${hint}`);
    }
  }

  // 旧版本还开着：复制以后在旧版本里的新动静不会过来，新版本也会因为端口被占用启动不了
  if (source.dir) {
    const port = portOf(source.dir);
    for (let waits = 0; await serverRunning(port); waits++) {
      if (waits >= maxWaits) {
        say('旧版本还是开着。这次先不复制，也不启动：关掉旧版本的黑色窗口以后，再双击这个版本的 start.bat。');
        return 'abort';
      }
      say(`旧版本好像还开着（http://localhost:${port} 能打开）。先关掉旧版本的黑色窗口，再按回车。`);
      say('  （关不掉也要复制：输入 y，之后在旧版本里的新动静不会过来；这次先不复制、不启动：输入 n）');
      const raw = await ask('> ');
      if (raw === null) return 'abort';
      const answer = normalizeAnswer(raw);
      if (NO.test(answer)) return 'abort';
      if (YES.test(answer)) break;
    }
  }

  say('正在复制……');
  const result = importData({ from: source.dir ?? null, dbFile: source.dbFile ?? null, to: root });
  for (const line of summaryLines(result)) say(line);
  if (source.dir) say('旧版本的文件夹没有改动。以后从这个新版本的文件夹启动；确认新版本没问题以后，旧版本的文件夹可以删掉。');
  say();
  return 'imported';
}

// ==================== 手动运行 ====================

async function main(args) {
  const force = args.includes('--force');
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    console.log('用法：npm run import-data -- "旧版本的文件夹"（新版本里已经有数据时加 --force，现在的数据会先备份）');
    const found = findInstalls();
    if (found.length) {
      console.log('\n在旁边找到的旧版本：');
      for (const f of found) console.log(`  ${f.dir}（最后使用 ${formatTime(f.lastUsed)}）`);
    }
    return 1;
  }
  const source = resolveSource(input);
  if (source.error) {
    console.error(source.error);
    return 1;
  }
  // 旧版本、新版本（.env 里的端口，或者命令行里临时设的 PORT）还开着时不复制
  const ports = new Set([source.dir ? portOf(source.dir) : null, portOf(PROJECT_ROOT), Number(process.env.PORT) || null]);
  for (const port of ports) {
    if (port && (await serverRunning(port))) {
      console.error(`http://localhost:${port} 上有龙娘跑团在运行（旧版本、新版本或者别的版本还开着）。先关掉它的黑色窗口再运行。`);
      return 1;
    }
  }
  try {
    const result = importData({ from: source.dir ?? null, dbFile: source.dbFile ?? null, force });
    for (const line of summaryLines(result)) console.log(line);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && samePath(realOrResolved(process.argv[1]), realOrResolved(fileURLToPath(import.meta.url)))) {
  process.exitCode = await main(process.argv.slice(2));
}
