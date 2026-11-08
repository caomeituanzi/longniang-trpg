import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  cleanDroppedPath,
  dbFileOf,
  describeInstall,
  findInstalls,
  importData,
  lastUsedOf,
  offerImport,
  portOf,
  resolveSource,
  serverRunning,
} from '../scripts/upgrade.mjs';
import { createApp } from '../server/app';
import { verifyPassword } from '../server/auth';
import { AUTO_BACKUPS_KEPT, backupDatabase, listBackups } from '../server/backup';
import { DataTooNewError, MIGRATIONS, openDatabase, schemaVersion } from '../server/db';
import { seedTestData, TEST_ACCOUNTS } from '../server/seed-data';
import { getSetting, setSetting } from '../server/settings';
import { APP_VERSION } from '../server/version';
import { startTestApp } from './helpers';

// 升级到新版本时保留数据：start.bat 找旧版本、复制数据库、设置和自己加的剧本；旧版本一个字节都不改；
// 数据库升级前自动备份；更新的版本留下的数据，旧版本不打开；管理页的「版本和数据」。

const ROOT = path.resolve(import.meta.dirname, '..');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** 临时文件夹（真实路径：Mac 上 /var 其实是 /private/var）。 */
function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-upgrade-')));
}

/** 随便一个现在没人用的端口（测试里的“旧版本”“新版本”用它，免得碰上真的在 3000 端口跑着的服务器）。 */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/**
 * 做一个版本的文件夹：package.json、server、scenarios（自带的剧本），versioned 的还有 scripts/upgrade.mjs。
 * testScenario：还自带测试剧本《雾港旅店》（V0.2.0 以前的版本）。
 */
function makeInstall(dir: string, { versioned = false, version = '0.1.0', testScenario = true } = {}) {
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ai-trpg', version }));
  if (testScenario) {
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'fog-harbor-inn.json'), path.join(dir, 'scenarios', 'fog-harbor-inn.json'));
  }
  fs.copyFileSync(path.join(ROOT, 'scenarios', 'qingxi-lantern-night.json'), path.join(dir, 'scenarios', 'qingxi-lantern-night.json'));
  if (versioned) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    for (const f of ['upgrade.mjs', 'builtin-scenarios.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  }
  return dir;
}

/** 旧版本里放上数据：测试账号和对局、一个 AI 生成的剧本、设置文件、自己加的剧本文件。 */
async function fillOldInstall(dir: string, port: number) {
  const db = openDatabase(path.join(dir, 'data', 'game.db'), { onBackup: () => {} });
  await seedTestData(db);
  const room = db.prepare("SELECT id FROM rooms WHERE name = '山寺夜话'").get() as { id: number };
  const scenario = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'fog-harbor-inn.json'), 'utf8');
  db.prepare("INSERT INTO scenarios (room_id, source, scenario_key, data, created_at) VALUES (?, 'generated', NULL, ?, ?)").run(
    room.id,
    scenario,
    Date.now(),
  );
  db.close();
  fs.writeFileSync(path.join(dir, '.env'), `AI_PROVIDER=fake\nANTHROPIC_API_KEY=sk-ant-test-old\nPORT=${port}\n`);
  const mine = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'qingxi-lantern-night.json'), 'utf8'));
  mine.title = '自己写的剧本';
  fs.writeFileSync(path.join(dir, 'scenarios', 'my-story.json'), JSON.stringify(mine));
}

/** 文件夹里每个文件（包括数据库的 -wal、-shm）的内容摘要和修改时间：用来确认旧版本一个字节都没变。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    out[path.relative(dir, file)] = `${hash} ${fs.statSync(file).mtimeMs}`;
  }
  return out;
}

function count(dbFile: string, sql: string): number {
  const db = new DatabaseSync(dbFile);
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

/** 按顺序回答问题的“用户”：answers 用完以后一直按回车；answers 里的 null 表示输入被关掉了。 */
function script(answers: (string | null)[], onAsk?: (n: number) => Promise<void> | void) {
  const lines: string[] = [];
  let asked = 0;
  return {
    lines,
    text: () => lines.join('\n'),
    ask: async (question: string) => {
      lines.push(question);
      await onAsk?.(asked);
      asked++;
      return answers.length ? (answers.shift() as string | null) : '';
    },
    say: (text = '') => {
      lines.push(text);
    },
  };
}

test('从旧版本复制数据：在旁边找得到，账号、对局、剧本、设置都过来，旧版本一个字节都不变', async () => {
  const base = tempDir();
  // Windows「全部解压」的样子：每个压缩包解压出来多套一层同名文件夹
  const old = makeInstall(path.join(base, 'Downloads', 'ai-trpg', 'ai-trpg'));
  const fresh = makeInstall(path.join(base, 'Downloads', 'ai-trpg-V0.1.0', 'ai-trpg-V0.1.0'), { versioned: true, testScenario: false });
  // 不相干的文件夹不算：名字不对的项目、没有数据的旧版本
  fs.mkdirSync(path.join(base, 'Downloads', 'other', 'server'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Downloads', 'other', 'package.json'), JSON.stringify({ name: 'something-else' }));
  makeInstall(path.join(base, 'Downloads', 'empty-copy'));
  await fillOldInstall(old, await freePort());
  const before = snapshot(old);
  const lastUsed = lastUsedOf(path.join(old, 'data', 'game.db'));

  const found = findInstalls(fresh);
  assert.deepEqual(
    found.map((f: { dir: string }) => f.dir),
    [old],
  );
  const info = describeInstall(old);
  assert.equal(info.version, null, '还没有版本号的旧版本');
  assert.deepEqual(info.counts, { users: TEST_ACCOUNTS.length, rooms: 4, scenarios: 1 });
  assert.deepEqual(info.scenarioFiles, ['my-story.json']);

  const result = importData({ from: old, to: fresh });
  assert.equal(result.envCopied, true);
  assert.equal(result.shared, false);
  assert.deepEqual(result.scenarioFiles, ['my-story.json']);
  assert.deepEqual(result.counts, { users: TEST_ACCOUNTS.length, rooms: 4, scenarios: 1 });
  assert.equal(result.backup, null);
  assert.deepEqual(snapshot(old), before, '旧版本的文件夹一点没变，也没有多出 -wal、-shm');
  assert.equal(lastUsedOf(path.join(old, 'data', 'game.db')), lastUsed, '最后使用的时间也没变');

  // 设置文件、自己加的剧本过来了；新版本自带的剧本没被旧版本的覆盖；旧版本自带、新版本去掉的测试剧本不搬过来
  assert.equal(fs.readFileSync(path.join(fresh, '.env'), 'utf8'), fs.readFileSync(path.join(old, '.env'), 'utf8'));
  assert.ok(fs.existsSync(path.join(fresh, 'scenarios', 'my-story.json')));
  assert.ok(!fs.existsSync(path.join(fresh, 'scenarios', 'fog-harbor-inn.json')), '测试剧本《雾港旅店》没被搬过来');
  const record = JSON.parse(fs.readFileSync(path.join(fresh, 'data', 'imported-from.json'), 'utf8'));
  assert.equal(record.from, old);
  assert.equal(record.version, null);
  assert.deepEqual(record.scenarioFiles, ['my-story.json']);

  // 新版本打开：账号能登录、对局和剧本都在、自己加的剧本能选
  const app = createApp({
    dbPath: path.join(fresh, 'data', 'game.db'),
    webDist: path.join(base, 'dist'),
    scenarioDir: path.join(fresh, 'scenarios'),
  });
  try {
    const tester = app.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('tester1') as { password_hash: string };
    assert.ok(await verifyPassword(TEST_ACCOUNTS[1].password, tester.password_hash));
    const rooms = (app.db.prepare('SELECT name FROM rooms ORDER BY id').all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(rooms, ['单人试玩', '雾港旅店', '六人局', '山寺夜话']);
    assert.equal(count(path.join(fresh, 'data', 'game.db'), "SELECT COUNT(*) AS n FROM scenarios WHERE source = 'generated'"), 1);
    assert.ok(app.engine.listScenarios().some((s) => s.key === 'my-story' && s.title === '自己写的剧本'));
  } finally {
    await app.close();
  }
});

test('旧版本是直接关掉窗口的（留着没合并的 -wal）：复制到完整的数据，旧版本的文件不改、也不会被排到前面', async () => {
  const base = tempDir();
  const crashed = makeInstall(path.join(base, 'Downloads', 'crashed'));
  const recent = makeInstall(path.join(base, 'Downloads', 'recent'));
  const fresh = makeInstall(path.join(base, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true });
  await fillOldInstall(recent, await freePort());

  // 旧版本开着、刚改过数据（还在 -wal 里），这时窗口被直接关掉：留下 game.db 和 game.db-wal
  const live = makeInstall(path.join(tempDir(), 'live'));
  await fillOldInstall(live, await freePort());
  const writer = new DatabaseSync(path.join(live, 'data', 'game.db'));
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  writer.prepare("UPDATE rooms SET name = '关窗口前改的名字' WHERE name = '山寺夜话'").run();
  fs.mkdirSync(path.join(crashed, 'data'));
  fs.copyFileSync(path.join(live, 'data', 'game.db'), path.join(crashed, 'data', 'game.db'));
  fs.copyFileSync(path.join(live, 'data', 'game.db-wal'), path.join(crashed, 'data', 'game.db-wal'));
  fs.copyFileSync(path.join(live, '.env'), path.join(crashed, '.env'));
  writer.close();
  assert.ok(fs.statSync(path.join(crashed, 'data', 'game.db-wal')).size > 0);
  // 这个旧版本是很久以前用的；recent 是最近用的
  const past = new Date(Date.now() - 30 * 86400_000);
  for (const f of ['game.db', 'game.db-wal']) fs.utimesSync(path.join(crashed, 'data', f), past, past);
  const before = snapshot(crashed);

  // 列出来、看一眼里面有什么，都不会改它，也不会把它排到前面
  for (let i = 0; i < 2; i++) {
    const found = findInstalls(fresh).map((f: { dir: string }) => describeInstall(f.dir));
    assert.deepEqual(
      found.map((f: { dir: string }) => f.dir),
      [recent, crashed],
    );
  }
  assert.deepEqual(snapshot(crashed), before);

  const result = importData({ from: crashed, to: fresh });
  assert.deepEqual(snapshot(crashed), before, '数据库文件和 -wal 都原样不动，也没留下 -shm');
  assert.equal(result.counts.rooms, 4);
  assert.equal(count(path.join(fresh, 'data', 'game.db'), "SELECT COUNT(*) AS n FROM rooms WHERE name = '关窗口前改的名字'"), 1, '-wal 里的数据也复制过来了');
});

test('Mac 上解压出来是并排的两个文件夹，也找得到；最近用过的排前面', async () => {
  const base = tempDir();
  const older = makeInstall(path.join(base, 'Downloads', 'ai-trpg'));
  const newer = makeInstall(path.join(base, 'Downloads', 'ai-trpg 2'));
  const fresh = makeInstall(path.join(base, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true });
  await fillOldInstall(older, await freePort());
  await fillOldInstall(newer, await freePort());
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(older, 'data', 'game.db'), past, past);
  assert.deepEqual(
    findInstalls(fresh).map((f: { dir: string }) => f.dir),
    [newer, older],
  );
});

test('新版本解压在旧版本的文件夹里面也找得到；比这个版本新的不算；不在家目录里往下找', async () => {
  const base = tempDir();
  // 新版本解压到了旧版本的文件夹里面（多套了一层同名文件夹）
  const old = makeInstall(path.join(base, 'ai-trpg'));
  await fillOldInstall(old, await freePort());
  const nested = makeInstall(path.join(old, 'ai-trpg-V0.1.0', 'ai-trpg-V0.1.0'), { versioned: true });
  assert.deepEqual(
    findInstalls(nested).map((f: { dir: string }) => f.dir),
    [old],
  );

  // 旁边有个更新的版本（V0.2.0）：它的数据这个版本打不开，不列出来，拖进来也不收
  const side = tempDir();
  const future = makeInstall(path.join(side, 'Downloads', 'ai-trpg-V0.2.0'), { versioned: true, version: '0.2.0' });
  await fillOldInstall(future, await freePort());
  const current = makeInstall(path.join(side, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true, version: '0.1.0' });
  assert.deepEqual(findInstalls(current), []);
  assert.match(resolveSource(future, current).error ?? '', /更新的版本（V0\.2\.0）.*V0\.1\.0/);

  // 新版本直接放在家目录下的「下载」里：只看「下载」里面，不去翻家目录下的别的文件夹（Mac 上会弹权限请求）
  const home = tempDir();
  const inDesktop = makeInstall(path.join(home, 'Desktop', 'ai-trpg'));
  const inDownloads = makeInstall(path.join(home, 'Downloads', 'ai-trpg'));
  await fillOldInstall(inDesktop, await freePort());
  await fillOldInstall(inDownloads, await freePort());
  const flat = makeInstall(path.join(home, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true });
  assert.deepEqual(
    findInstalls(flat, { home }).map((f: { dir: string }) => f.dir),
    [inDownloads],
  );
});

test('旧版本开着时复制：还没合并进数据库文件的新数据也在', async () => {
  const base = tempDir();
  const old = makeInstall(path.join(base, 'old'));
  const fresh = makeInstall(path.join(base, 'new'), { versioned: true });
  await fillOldInstall(old, await freePort());
  // 模拟旧版本的服务器还开着：连接不关，刚写的数据还在 -wal 文件里
  const running = new DatabaseSync(path.join(old, 'data', 'game.db'));
  running.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  running.prepare("UPDATE rooms SET name = '改过名字的对局' WHERE name = '山寺夜话'").run();
  assert.ok(fs.statSync(path.join(old, 'data', 'game.db-wal')).size > 0);
  try {
    importData({ from: old, to: fresh });
  } finally {
    running.close();
  }
  assert.equal(count(path.join(fresh, 'data', 'game.db'), "SELECT COUNT(*) AS n FROM rooms WHERE name = '改过名字的对局'"), 1);
});

test('新版本里已经有数据：不加 --force 不替换；新版本开着时不替换；替换前先备份；留下的 -wal、-journal 不会混进来', async () => {
  const base = tempDir();
  const old = makeInstall(path.join(base, 'old'));
  const fresh = makeInstall(path.join(base, 'new'), { versioned: true });
  await fillOldInstall(old, await freePort());
  // 新版本自己先有一份数据（一个账号）
  const target = path.join(fresh, 'data', 'game.db');
  const own = openDatabase(target, { onBackup: () => {} });
  own.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('newbie', '新人', 'x', 0)").run();
  fs.writeFileSync(path.join(fresh, '.env'), 'AI_PROVIDER=fake\n');

  assert.throws(() => importData({ from: old, to: fresh }), /已经有数据了.*--force/);
  // 新版本的服务器还开着（数据库连接没关）：不替换，什么都不动
  assert.throws(() => importData({ from: old, to: fresh, force: true }), /正在被使用/);
  assert.equal(listBackups(target).length, 0);
  own.close();

  const result = importData({ from: old, to: fresh, force: true });
  assert.ok(result.backup && fs.existsSync(result.backup), '原来的数据备份了');
  assert.match(path.basename(result.backup), /^before-import-\d{8}-\d{6}\.db$/);
  assert.equal(count(result.backup, "SELECT COUNT(*) AS n FROM users WHERE username = 'newbie'"), 1);
  assert.equal(count(target, "SELECT COUNT(*) AS n FROM users WHERE username = 'newbie'"), 0);
  assert.equal(result.envCopied, false);
  assert.equal(result.envKept, true, '新版本自己的 .env 不动');
  assert.equal(fs.readFileSync(path.join(fresh, '.env'), 'utf8'), 'AI_PROVIDER=fake\n');

  // 只删了 game.db、留下了 -wal、-journal：复制时要把它们删掉，不然会被当成新数据库的一部分
  fs.rmSync(target);
  fs.writeFileSync(`${target}-wal`, 'stale');
  fs.writeFileSync(`${target}-journal`, 'stale');
  importData({ from: old, to: fresh });
  assert.ok(!fs.existsSync(`${target}-wal`));
  assert.ok(!fs.existsSync(`${target}-journal`));
  assert.equal(count(target, 'SELECT COUNT(*) AS n FROM rooms'), 4);
});

test('新旧版本用的是同一个数据库文件（.env 里的 DB_PATH）：不复制数据库，设置和剧本照样复制', async () => {
  const base = tempDir();
  const old = makeInstall(path.join(base, 'old'));
  const fresh = makeInstall(path.join(base, 'new'), { versioned: true });
  const shared = path.join(base, 'shared', 'game.db');
  const db = openDatabase(shared, { onBackup: () => {} });
  await seedTestData(db);
  db.close();
  fs.writeFileSync(path.join(old, '.env'), `AI_PROVIDER=fake\nDB_PATH=${shared}\nPORT=${await freePort()}\n`);
  const mine = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'qingxi-lantern-night.json'), 'utf8'));
  fs.writeFileSync(path.join(old, 'scenarios', 'my-story.json'), JSON.stringify(mine));

  const s = script(['']);
  assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say }), 'imported');
  assert.match(s.text(), /数据库没有复制：新旧版本用的是同一个数据库文件/);
  assert.ok(fs.existsSync(path.join(fresh, '.env')));
  assert.ok(fs.existsSync(path.join(fresh, 'scenarios', 'my-story.json')));
  assert.equal(dbFileOf(fresh), shared, '新版本直接用那个数据库');
  assert.ok(!fs.existsSync(path.join(fresh, 'data')));
});

test('设置文件里行尾的 # 注释不算在值里（和服务器读法一样）', () => {
  const dir = makeInstall(path.join(tempDir(), 'x'));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=3001  # 3000 被旧版本占着\nDB_PATH=data/main.db # 数据库\n');
  assert.equal(portOf(dir), 3001);
  assert.equal(dbFileOf(dir), path.join(dir, 'data', 'main.db'));
});

test('拖进来的路径：引号、反斜杠、外面那层文件夹、data 文件夹、数据库文件、备份文件、不对的文件夹', async () => {
  const base = tempDir();
  const outer = path.join(base, 'Downloads', 'ai-trpg');
  const old = makeInstall(path.join(outer, 'ai-trpg'));
  const fresh = makeInstall(path.join(base, 'new'), { versioned: true });
  const empty = makeInstall(path.join(base, 'empty'));
  await fillOldInstall(old, await freePort());

  assert.equal(cleanDroppedPath(`"${old}"`), old);
  assert.equal(cleanDroppedPath(`  ${old}${path.sep}  `), old);
  if (process.platform !== 'win32') {
    const spaced = path.join(base, 'with space');
    assert.equal(cleanDroppedPath(spaced.replaceAll(' ', '\\ ')), spaced, 'Mac 的终端会在空格前面加反斜杠');
  }

  assert.deepEqual(resolveSource(old, fresh), { dir: old });
  assert.deepEqual(resolveSource(outer, fresh), { dir: old }, '拖了外面那层');
  assert.deepEqual(resolveSource(path.join(old, 'data'), fresh), { dir: old });
  assert.deepEqual(resolveSource(path.join(old, 'data', 'game.db'), fresh), { dir: old });
  assert.match(resolveSource(path.join(old, 'no-such-file'), fresh).error ?? '', /找不到/);

  // backups 里的备份文件：只复制数据库
  const db = new DatabaseSync(path.join(old, 'data', 'game.db'));
  const backup = backupDatabase(db, path.join(old, 'data', 'game.db'), 'manual');
  db.close();
  assert.deepEqual(resolveSource(backup, fresh), { dbFile: backup });

  assert.match(resolveSource(path.join(base, 'Downloads'), fresh).error ?? '', /不是龙娘跑团的文件夹/);
  assert.match(resolveSource(fresh, fresh).error ?? '', /新版本自己的文件夹/);
  assert.match(resolveSource(empty, fresh).error ?? '', /还没有数据/);

  // 用备份恢复：只复制数据库，不碰设置文件
  const result = importData({ dbFile: backup, to: fresh });
  assert.equal(result.envCopied, false);
  assert.deepEqual(result.scenarioFiles, []);
  assert.equal(count(path.join(fresh, 'data', 'game.db'), 'SELECT COUNT(*) AS n FROM users'), TEST_ACCOUNTS.length);
  assert.ok(!fs.existsSync(path.join(fresh, '.env')));
});

test('第一次启动时问你：回车复制、n 不复制、编号、全角字母数字、拖文件夹、看不懂的回答、读不到输入、旧版本还开着', async () => {
  /** 一个下载文件夹，里面有两个有数据的旧版本（第 1 个是最近用过的）和一个刚解压的新版本。 */
  async function downloads() {
    const base = tempDir();
    const first = makeInstall(path.join(base, 'Downloads', 'ai-trpg'));
    const second = makeInstall(path.join(base, 'Downloads', 'ai-trpg-old'));
    const firstPort = await freePort();
    await fillOldInstall(first, firstPort);
    await fillOldInstall(second, await freePort());
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(second, 'data', 'game.db'), past, past);
    const fresh = makeInstall(path.join(base, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true });
    return { base, first, second, firstPort, fresh };
  }
  const importedFrom = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'imported-from.json'), 'utf8')).from;
  const hasData = (dir: string) => fs.existsSync(path.join(dir, 'data', 'game.db'));

  // 回车：复制第 1 个（最近用过的）
  {
    const { first, fresh } = await downloads();
    const s = script(['']);
    assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say }), 'imported');
    assert.equal(importedFrom(fresh), first);
    assert.match(s.text(), /找到了旧版本的数据/);
    assert.match(
      s.text(),
      /更早的版本（还没有版本号），最后使用 \d{4}-\d\d-\d\d \d\d:\d\d；账号 6 个，对局 4 局，AI 生成和导入的剧本 1 个，自己加的剧本文件 1 个/,
    );
    assert.match(s.text(), /已经复制好了/);
    assert.match(s.text(), /设置文件 \.env/);
  }

  // n、全角的ｎ（中文输入法）：不复制
  for (const no of ['n', 'ｎ', '不']) {
    const { fresh } = await downloads();
    assert.equal(await offerImport({ root: fresh, ...script([no]) }), 'skipped', no);
    assert.ok(!hasData(fresh));
  }

  // 编号（全角的也行）：复制那一个；先输错编号、写了看不懂的话会再问
  {
    const { second, fresh } = await downloads();
    const s = script(['9', '随便写写', '２']);
    assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say }), 'imported');
    assert.equal(importedFrom(fresh), second);
    assert.match(s.text(), /没有第 9 个/);
    assert.match(s.text(), /没看懂「随便写写」/);
  }

  // 「是」也是复制第 1 个
  {
    const { first, fresh } = await downloads();
    assert.equal(await offerImport({ root: fresh, ...script(['是']) }), 'imported');
    assert.equal(importedFrom(fresh), first);
  }

  // 读不到输入（窗口的输入被关掉了）：不复制，这次也不启动
  {
    const { fresh } = await downloads();
    const s = script([null]);
    assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say }), 'abort');
    assert.ok(!hasData(fresh));
    assert.match(s.text(), /没有读到输入/);
  }

  // 旁边没有旧版本：拖文件夹进来；拖了一个装着好几个版本的文件夹会再问
  {
    const { base, second } = await downloads();
    const lonely = makeInstall(path.join(base, 'elsewhere', 'x', 'ai-trpg-V0.1.0'), { versioned: true });
    const s = script([path.join(base, 'Downloads'), `"${second}"`]);
    assert.equal(await offerImport({ root: lonely, ask: s.ask, say: s.say }), 'imported');
    assert.equal(importedFrom(lonely), second);
    assert.match(s.text(), /这个文件夹里还没有数据/);
    assert.match(s.text(), /好几个版本/);
  }

  // 旧版本还开着：先提示关掉，关掉以后（再按回车）才复制
  {
    const { first, firstPort, fresh } = await downloads();
    const oldServer = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => oldServer.listen(firstPort, '127.0.0.1', r));
    assert.equal(await serverRunning(firstPort), true);
    const s = script(['', ''], async (n) => {
      // 第二次问（提示关掉旧版本）时，用户把旧版本关了
      if (n === 1) await new Promise<void>((r) => oldServer.close(() => r()));
    });
    assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say }), 'imported');
    assert.equal(importedFrom(fresh), first);
    assert.match(s.text(), /旧版本好像还开着/);
    assert.equal(await serverRunning(firstPort), false);
  }

  // 旧版本一直开着：问够次数以后不复制、不启动（不会自己复制下去）；输入 n 也是
  {
    const { firstPort, fresh } = await downloads();
    const oldServer = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => oldServer.listen(firstPort, '127.0.0.1', r));
    try {
      const s = script(['', '', '', '']);
      assert.equal(await offerImport({ root: fresh, ask: s.ask, say: s.say, maxWaits: 2 }), 'abort');
      assert.match(s.text(), /旧版本还是开着/);
      assert.ok(!hasData(fresh));
      assert.equal(await offerImport({ root: fresh, ...script(['', 'n']) }), 'abort');
      assert.ok(!hasData(fresh));
      // 关不掉也要复制：输入 y（全角的也行）
      assert.equal(await offerImport({ root: fresh, ...script(['', 'ｙ']) }), 'imported');
      assert.ok(hasData(fresh));
    } finally {
      await new Promise<void>((r) => oldServer.close(() => r()));
    }
  }
});

test('双击 start.bat 时窗口的输入被关掉了：不复制旧版本，不建数据，直接结束（不会卡住）', async () => {
  const base = tempDir();
  const old = makeInstall(path.join(base, 'Downloads', 'ai-trpg'));
  await fillOldInstall(old, await freePort());
  // 新版本：真的启动脚本，依赖借用这个项目已经装好的
  const fresh = makeInstall(path.join(base, 'Downloads', 'ai-trpg-V0.1.0'), { versioned: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fresh, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'start.mjs'), path.join(fresh, 'scripts', 'start.mjs'));
  fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(fresh, '.env.example'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fresh, 'node_modules'), 'junction');

  const run = spawnSync(process.execPath, [path.join(fresh, 'scripts', 'start.mjs')], { cwd: fresh, input: '', encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /找到了旧版本的数据/);
  assert.match(run.stdout, /没有读到输入/);
  assert.match(run.stdout, /这次没有复制数据，也没有启动/);
  assert.ok(!fs.existsSync(path.join(fresh, 'data')), '没有复制、也没有生成测试数据');
  assert.ok(!fs.existsSync(path.join(fresh, '.env')));
});

test('数据库升级前自动备份；升级前的备份只留最近 10 份（刚做的一定留着），复制数据前的备份和手动备份不删', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data', 'game.db');
  // 一个停在第 6 版的旧数据库（阶段3），里面有一个账号
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (6);');
  for (const sql of MIGRATIONS.slice(0, 6)) old.exec(sql);
  old.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('veteran', '老玩家', 'x', 0)").run();
  old.close();

  const backups: { file: string; from: number; to: number }[] = [];
  const db = openDatabase(file, { onBackup: (f, from, to) => backups.push({ file: f, from, to }) });
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(getSetting(db, 'app_version'), APP_VERSION);
  assert.equal(backups.length, 1);
  assert.deepEqual([backups[0].from, backups[0].to], [6, MIGRATIONS.length]);
  assert.match(path.basename(backups[0].file), /^before-upgrade-\d{8}-\d{6}\.db$/);
  // 备份里是升级前的样子
  const saved = new DatabaseSync(backups[0].file);
  assert.equal((saved.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 6);
  assert.equal((saved.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'veteran'").get() as { n: number }).n, 1);
  saved.close();

  // 再打开一次：已经是最新的，不再备份
  db.close();
  openDatabase(file, { onBackup: (f, from, to) => backups.push({ file: f, from, to }) }).close();
  assert.equal(backups.length, 1);

  // 很多份升级前的备份（更早的）、一份复制数据前的备份、一份手动备份
  const backupDir = path.dirname(backups[0].file);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(backupDir, `before-upgrade-202501${String(i + 10)}-000000.db`), 'old');
  fs.writeFileSync(path.join(backupDir, 'before-import-20200101-000000.db'), 'only copy');
  fs.writeFileSync(path.join(backupDir, 'manual-20200101-000000.db'), 'mine');
  const again = openDatabase(file, { onBackup: () => {} });
  const made = backupDatabase(again, file, 'upgrade');
  const list = listBackups(file);
  assert.equal(list.filter((b) => b.kind === 'upgrade').length, AUTO_BACKUPS_KEPT);
  assert.ok(list.some((b) => b.name === path.basename(made)), '刚做的备份留着');
  assert.ok(list.some((b) => b.name === path.basename(backups[0].file)), '较新的自动备份留着');
  assert.ok(!list.some((b) => b.name === 'before-upgrade-20250110-000000.db'), '最早的升级前备份删掉了');
  assert.ok(list.some((b) => b.name === 'before-import-20200101-000000.db'), '复制数据前的备份不删');
  assert.ok(list.some((b) => b.name === 'manual-20200101-000000.db'), '手动备份不删');

  // 电脑的时钟被往回调了：已有的备份文件名里的时间都比现在晚，刚做的这份也留着
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(backupDir, `before-upgrade-209901${String(i + 10)}-000000.db`), 'future');
  const made2 = backupDatabase(again, file, 'upgrade');
  again.close();
  assert.ok(listBackups(file).some((b) => b.name === path.basename(made2)));
});

test('更新的版本留下的数据：这个版本不打开，也不改动它', () => {
  const dir = tempDir();
  const file = path.join(dir, 'game.db');
  const db = openDatabase(file);
  db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length + 1);
  setSetting(db, 'app_version', '9.9.0');
  db.close();
  assert.throws(
    () => openDatabase(file),
    (err: unknown) =>
      err instanceof DataTooNewError &&
      err.message.includes('V9.9.0') &&
      err.message.includes(`第 ${MIGRATIONS.length + 1} 版`) &&
      err.message.includes(`V${APP_VERSION}`),
  );
  const check = new DatabaseSync(file);
  assert.equal((check.prepare('SELECT version FROM schema_version').get() as { version: number }).version, MIGRATIONS.length + 1);
  assert.equal((check.prepare("SELECT value FROM settings WHERE key = 'app_version'").get() as { value: string }).value, '9.9.0');
  check.close();
  assert.ok(!fs.existsSync(path.join(dir, 'backups')), '没有备份，也没有升级');
});

test('手动运行 npm run import-data：复制、已经有数据时要 --force、旧版本开着时不复制', async () => {
  const base = tempDir();
  const old = makeInstall(path.join(base, 'old'));
  const fresh = makeInstall(path.join(base, 'new'), { versioned: true });
  const oldPort = await freePort();
  await fillOldInstall(old, oldPort);
  fs.writeFileSync(path.join(fresh, '.env'), `AI_PROVIDER=fake\nPORT=${await freePort()}\n`);
  const run = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      // 不能用同步的 spawnSync：下面要让这个测试进程里的“旧版本服务器”同时响应
      const child = spawn(process.execPath, [path.join(fresh, 'scripts', 'upgrade.mjs'), ...args], { env: { ...process.env, PORT: '' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  // 旧版本还开着：不复制
  const oldServer = http.createServer((_req, res) => res.end('{}'));
  await new Promise<void>((r) => oldServer.listen(oldPort, '127.0.0.1', r));
  const busy = await run(old);
  await new Promise<void>((r) => oldServer.close(() => r()));
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /先关掉它的黑色窗口/);
  assert.ok(!fs.existsSync(path.join(fresh, 'data', 'game.db')));

  const first = await run(old);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已经复制好了/);
  assert.match(first.stdout, /设置文件 \.env 没有复制/);

  const again = await run(old);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);

  const forced = await run(old, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /原来的数据备份到了/);
  assert.equal(listBackups(path.join(fresh, 'data', 'game.db')).filter((b) => b.kind === 'import').length, 1);

  const usage = await run();
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /用法/);
});

test('管理页「版本和数据」：版本号、作者、数据库、从哪复制来的、备份', async () => {
  const t = await startTestApp();
  try {
    const admin = await t.login('admin', TEST_ACCOUNTS[0].password);
    const info = await t.call('GET', '/api/admin/system', undefined, admin);
    assert.equal(info.status, 200);
    assert.equal(info.data.version, APP_VERSION);
    assert.equal(info.data.author, '花崎诗奏');
    assert.equal(info.data.schemaVersion, MIGRATIONS.length);
    assert.ok(info.data.dbFile.endsWith('test.db'));
    assert.ok(info.data.dbSize > 0);
    assert.equal(info.data.importedFrom, null);
    assert.deepEqual(info.data.backups, []);

    const made = await t.call('POST', '/api/admin/backup', {}, admin);
    assert.equal(made.status, 201);
    assert.match(made.data.created, /^manual-\d{8}-\d{6}\.db$/);
    assert.equal(made.data.backups.length, 1);
    assert.equal(made.data.backups[0].kind, 'manual');
    assert.ok(fs.existsSync(path.join(made.data.backupDir, made.data.created)));

    // start.bat 复制旧版本数据时留下的记录
    fs.writeFileSync(
      path.join(path.dirname(info.data.dbFile), 'imported-from.json'),
      JSON.stringify({ from: '/old/ai-trpg', version: null, at: 1, counts: { users: 3, rooms: 2, scenarios: 1 }, scenarioFiles: ['a.json'] }),
    );
    const after = await t.call('GET', '/api/admin/system', undefined, admin);
    assert.deepEqual(after.data.importedFrom, {
      from: '/old/ai-trpg',
      version: null,
      at: 1,
      counts: { users: 3, rooms: 2, scenarios: 1 },
      scenarioFiles: ['a.json'],
    });

    const player = await t.login('tester1', TEST_ACCOUNTS[1].password);
    assert.equal((await t.call('GET', '/api/admin/system', undefined, player)).status, 403);
    assert.equal((await t.call('POST', '/api/admin/backup', {}, player)).status, 403);
  } finally {
    await t.close();
  }
});
