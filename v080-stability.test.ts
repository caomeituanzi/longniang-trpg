process.env.TZ = 'Asia/Shanghai';
// V0.8.0 稳定性：每天自动备份、错误日志（脱敏）、健康检查、管理页「最近的错误」、崩溃自动重启的判断、
// 体面地关服务器，以及顺手修的几处（请求处理之前出错、读网页文件出错、服务器的 error 事件、假主持人的监听）。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import type { MessagesRequest } from '../server/ai/types';
import { createApp } from '../server/app';
import {
  backupDatabase,
  BackupSpaceError,
  dailyBackupIfDue,
  DAILY_BACKUPS_KEPT,
  lastDailyBackupAt,
  listBackups,
  scheduleDailyBackups,
} from '../server/backup';
import { MIGRATIONS, openDatabase, type DB } from '../server/db';
import {
  clearRecentErrors,
  ERROR_LOG_DAYS,
  errorLogFile,
  installErrorLog,
  recentErrors,
  RECENT_ERROR_CHARS,
  RECENT_ERRORS_KEPT,
  recordError,
  redactSecrets,
  setErrorLogDir,
} from '../server/errorlog';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { APP_VERSION } from '../server/version';
import { afterServerExit, CONFIG_ERROR_EXIT, MAX_RESTARTS, RESTART_DELAY_MS, RESTART_WINDOW_MS } from '../scripts/supervise.mjs';
import { sleep, startTestApp, testScenarioDir } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v080-stability-'));
}

/** 暂时接住 console.error（不打印到测试输出里），拿到打印了什么。 */
function captureConsoleError() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

/** 本地时间（测试里固定用上海时间）。 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

// ==================== 每天自动备份 ====================

test('每天自动备份：没有就备份、23 小时以内不重复、到了再备份；只留 14 份，别的种类不删', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'data', 'game.db');
    const db = openDatabase(file, { onBackup: () => {} });
    const backups = path.join(dir, 'data', 'backups');
    fs.mkdirSync(backups, { recursive: true });
    // 别的种类的备份（很早以前的）：都不能删
    const others = ['manual-20200101-000000.db', 'before-upgrade-20200101-000000.db', 'before-import-20200101-000000.db', 'before-reset-20200101-000000.db'];
    for (const name of others) fs.writeFileSync(path.join(backups, name), 'other');

    const t0 = at(2026, 10, 1, 10);
    assert.equal(lastDailyBackupAt(file, t0), null);
    const first = dailyBackupIfDue(db, file, t0);
    assert.ok(first);
    assert.equal(path.basename(first), 'daily-20261001-100000.db');
    assert.equal(lastDailyBackupAt(file, t0), t0);
    assert.equal(listBackups(file).find((b) => b.name === 'daily-20261001-100000.db')?.kind, 'daily');

    // 23 小时以内不重复
    assert.equal(dailyBackupIfDue(db, file, t0 + HOUR), null);
    assert.equal(dailyBackupIfDue(db, file, t0 + 23 * HOUR - 1000), null);
    // 到了 23 小时：再备份
    const second = dailyBackupIfDue(db, file, t0 + 23 * HOUR);
    assert.equal(path.basename(second ?? ''), 'daily-20261002-090000.db');

    // 再过 20 天，每天一份：只留最近 14 份
    let now = t0 + 23 * HOUR;
    for (let i = 0; i < 20; i++) {
      now += DAY;
      assert.ok(dailyBackupIfDue(db, file, now));
    }
    const daily = listBackups(file).filter((b) => b.kind === 'daily');
    assert.equal(daily.length, DAILY_BACKUPS_KEPT);
    assert.equal(daily[0].name, 'daily-20261022-090000.db', '最新的留着');
    assert.equal(daily.at(-1)?.name, 'daily-20261009-090000.db', '最早留下的是 14 天以前那份');
    for (const name of others) assert.ok(fs.existsSync(path.join(backups, name)), `${name} 不删`);
    assert.equal(lastDailyBackupAt(file, now), now);

    // 电脑的时钟被往回调了：文件名比现在还晚的那些不算“最近一份”，照样备份；只留 14 份时先删它们（它们其实更旧）
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(backups, `daily-2099010${i}-000000.db`), 'future');
    const back = now + 2 * DAY;
    assert.equal(lastDailyBackupAt(file, back), now);
    const made = dailyBackupIfDue(db, file, back);
    assert.ok(made);
    const after = listBackups(file).filter((b) => b.kind === 'daily');
    assert.equal(after.length, DAILY_BACKUPS_KEPT);
    assert.ok(after.some((b) => b.name === path.basename(made)));
    assert.ok(after.some((b) => b.name === 'daily-20261022-090000.db'), '真的最近几份留着');
    assert.equal(after.filter((b) => b.name.startsWith('daily-2099')).length, 0, '时钟调回去以前的先删');
    assert.equal(dailyBackupIfDue(db, file, back + HOUR), null, '刚备份过，不重复');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('每天自动备份的计时器：到点就看、出错只记下来不影响服务器、停了就不再备份', async () => {
  const dir = tempDir();
  const captured = captureConsoleError();
  try {
    const file = path.join(dir, 'game.db');
    const db = openDatabase(file, { onBackup: () => {} });
    // 每看一次，时钟过去一天：每次都该备份
    let clock = at(2026, 10, 1, 10);
    const stop = scheduleDailyBackups(db, file, () => (clock += DAY), { firstMs: 10, everyMs: 30 });
    await sleep(150);
    stop();
    const made = listBackups(file).filter((b) => b.kind === 'daily').length;
    assert.ok(made >= 2, `看了几次就备份了几份：${made}`);
    await sleep(100);
    assert.equal(listBackups(file).filter((b) => b.kind === 'daily').length, made, '停了以后不再备份');
    db.close();

    // 备份失败（backups 是个文件，建不了文件夹）：记一条错误，不抛出来
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(broken);
    const db2 = openDatabase(path.join(broken, 'game.db'), { onBackup: () => {} });
    fs.writeFileSync(path.join(broken, 'backups'), 'not a folder');
    const stop2 = scheduleDailyBackups(db2, path.join(broken, 'game.db'), () => at(2026, 10, 1, 10), { firstMs: 5, everyMs: 1000 });
    await sleep(80);
    stop2();
    assert.ok(captured.lines.some((l) => l.includes('每天自动备份失败了')), captured.lines.join('\n'));
    db2.close();
  } finally {
    captured.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('开着每天自动备份的服务器照常启动、关闭；close() 调用好几次也不出错', async () => {
  const t = await startTestApp({ autoBackup: true });
  const res = await t.call('GET', '/api/health');
  assert.equal(res.status, 200);
  // 同时关两次、关好以后再关一次（Ctrl+C 正在关的时候又出了没处理到的错误）
  await Promise.all([t.app.close(), t.app.close()]);
  await t.app.close();
  await t.close();
});

/** 一个写备份写到一半就出错的数据库（像硬盘满了）：先写一截临时文件和 -journal，再抛错。别的都交给真的数据库。 */
function failingDb(real: DB): DB {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          const into = /^VACUUM INTO '(.*)'$/s.exec(sql);
          if (!into) return target.exec(sql);
          const file = into[1].replaceAll("''", "'");
          fs.writeFileSync(file, 'half a backup');
          fs.writeFileSync(`${file}-journal`, 'journal');
          throw new Error('database or disk is full');
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('备份写到一半失败（硬盘满了、出错）：不留下任何文件，不算一份备份，下一次照样会试', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'game.db');
    const db = openDatabase(file, { onBackup: () => {} });
    const backups = path.join(dir, 'backups');
    const t0 = at(2026, 10, 1, 10);
    assert.throws(() => dailyBackupIfDue(failingDb(db), file, t0), /disk is full/);
    assert.deepEqual(fs.readdirSync(backups), [], '没有留下半截的备份和 -journal');
    assert.equal(lastDailyBackupAt(file, t0), null);
    // 一小时以后再看：照样备份
    const made = dailyBackupIfDue(db, file, t0 + HOUR);
    assert.ok(made);
    assert.deepEqual(fs.readdirSync(backups), [path.basename(made)]);
    // 手动备份、升级前的备份走的是同一个函数
    assert.throws(() => backupDatabase(failingDb(db), file, 'manual', new Date(t0)), /disk is full/);
    assert.throws(() => backupDatabase(failingDb(db), file, 'upgrade', new Date(t0)), /disk is full/);
    assert.deepEqual(fs.readdirSync(backups), [path.basename(made)]);

    // 改名的时候被杀毒软件锁着：等一下再试；一直改不了就算失败，临时文件删掉
    const realRename = fs.renameSync;
    let failures = 2;
    (fs as { renameSync: unknown }).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
      if (failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      realRename(from, to);
    };
    try {
      const retried = backupDatabase(db, file, 'manual', new Date(t0 + 2 * HOUR));
      assert.ok(fs.existsSync(retried));
      (fs as { renameSync: unknown }).renameSync = () => {
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      };
      assert.throws(() => backupDatabase(db, file, 'manual', new Date(t0 + 3 * HOUR)), /EBUSY/);
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }
    assert.ok(!fs.readdirSync(backups).some((n) => n.includes('.partial') || n.endsWith('-journal')));
    assert.equal(listBackups(file).length, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('硬盘剩下的空间不到数据库的 1.2 倍：不备份（手动备份回 507 说清楚），腾出空间以后照常；看不了剩多少时照常备份', async () => {
  const realStatfs = fs.statfsSync;
  const setFree = (bytes: number | null) => {
    (fs as { statfsSync: unknown }).statfsSync = (p: fs.PathLike) => {
      if (bytes === null) throw Object.assign(new Error('ENOSYS: function not implemented, statfs'), { code: 'ENOSYS' });
      return { ...realStatfs(p), bavail: Math.floor(bytes / 4096), bsize: 4096 };
    };
  };
  const t = await startTestApp();
  try {
    const admin = await t.login(ADMIN.username, ADMIN.password);
    const dbFile = (await t.call('GET', '/api/admin/system', undefined, admin)).data.dbFile as string;
    const size = (() => {
      const pages = (t.app.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
      return pages * (t.app.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    })();

    setFree(Math.floor(size * 1.1));
    const res = await t.call('POST', '/api/admin/backup', {}, admin);
    assert.equal(res.status, 507);
    assert.match(res.data.error, /硬盘空间不够，这次没有备份：备份大约要 \d+ MB，.* 所在的硬盘只剩 \d+ MB/);
    assert.throws(() => dailyBackupIfDue(t.app.db, dbFile, Date.now()), BackupSpaceError);
    assert.ok(!fs.existsSync(path.join(path.dirname(dbFile), 'backups')) || fs.readdirSync(path.join(path.dirname(dbFile), 'backups')).length === 0);
    assert.equal(lastDailyBackupAt(dbFile, Date.now()), null, '下一次照样会试');

    setFree(Math.ceil(size * 1.3));
    assert.equal((await t.call('POST', '/api/admin/backup', {}, admin)).status, 201);
    setFree(null);
    assert.ok(dailyBackupIfDue(t.app.db, dbFile, Date.now()));
  } finally {
    (fs as { statfsSync: unknown }).statfsSync = realStatfs;
    await t.close();
  }
});

test('上次备份写到一半留下的东西：启动时清掉（.partial 和它的 -journal、孤零零的 -journal、旁边还有 -journal 的没写完的备份），列表里也不算', async () => {
  const dir = tempDir();
  const logged: string[] = [];
  const realLog = console.log;
  try {
    const file = path.join(dir, 'data', 'game.db');
    openDatabase(file, { onBackup: () => {} }).close();
    const backups = path.join(dir, 'data', 'backups');
    fs.mkdirSync(path.join(backups, 'reset-20261001-100000'), { recursive: true });
    const leftovers = [
      'daily-20261001-100000.db.partial',
      'daily-20261001-100000.db.partial-journal',
      'manual-20261001-100000.db-journal',
      'before-upgrade-20261001-100000.db',
      'before-upgrade-20261001-100000.db-journal',
    ];
    for (const name of [...leftovers, 'manual-20261002-100000.db', 'notes.txt']) fs.writeFileSync(path.join(backups, name), 'x');
    assert.deepEqual(
      listBackups(file).map((b) => b.name),
      ['manual-20261002-100000.db'],
      '写到一半的不算备份',
    );

    console.log = (...args: unknown[]) => void logged.push(args.join(' '));
    const app = createApp({ dbPath: file, webDist: path.join(dir, 'dist'), scenarioDir: testScenarioDir(dir), rateLimits: false, autoBackup: false });
    console.log = realLog;
    await app.close();
    assert.deepEqual(fs.readdirSync(backups).sort(), ['manual-20261002-100000.db', 'notes.txt', 'reset-20261001-100000']);
    assert.ok(logged.some((l) => l.includes('before-upgrade-20261001-100000.db')), logged.join('\n'));
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 错误日志 ====================

test('错误日志：写进按天分的文件，只留 14 天；内存里只留 100 条、每条前 2000 个字', () => {
  const dir = tempDir();
  try {
    clearRecentErrors();
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    // 以前的日志：18 天前、14 天前的要删，13 天前、昨天的留着；不是日志的文件不动
    const old = ['errors-20261010.log', 'errors-20261014.log', 'errors-20261015.log', 'errors-20261027.log', 'notes.txt'];
    for (const name of old) fs.writeFileSync(path.join(logs, name), 'old\n');
    const noon = at(2026, 10, 28, 12);
    setErrorLogDir(logs, () => noon);
    recordError('第一条错误');
    recordError('第二条错误', at(2026, 10, 28, 23, 59, 59));
    assert.deepEqual(fs.readdirSync(logs).sort(), ['errors-20261015.log', 'errors-20261027.log', 'errors-20261028.log', 'notes.txt']);
    // 第二天第一次写的时候：13 天前（10 月 15 日）的也到了 14 天，删掉
    recordError('第二天的错误', at(2026, 10, 29, 0, 0, 1));
    assert.deepEqual(fs.readdirSync(logs).sort(), ['errors-20261027.log', 'errors-20261028.log', 'errors-20261029.log', 'notes.txt']);
    assert.equal(ERROR_LOG_DAYS, 14);

    assert.equal(errorLogFile(logs, noon), path.join(logs, 'errors-20261028.log'));
    const today = fs.readFileSync(path.join(logs, 'errors-20261028.log'), 'utf8');
    assert.match(today, /^\[2026-10-28 12:00:00\] 第一条错误\n\[2026-10-28 23:59:59\] 第二条错误\n$/);
    assert.equal(fs.readFileSync(path.join(logs, 'errors-20261029.log'), 'utf8'), '[2026-10-29 00:00:01] 第二天的错误\n');

    // 内存里：新的在前，只留 100 条
    clearRecentErrors();
    for (let i = 0; i < 150; i++) recordError(`错误 ${i}`, noon + i);
    const recent = recentErrors();
    assert.equal(recent.length, RECENT_ERRORS_KEPT);
    assert.equal(recent[0].text, '错误 149');
    assert.equal(recent[0].at, noon + 149);
    assert.equal(recent.at(-1)?.text, '错误 50');

    // 很长的：内存里只留前 2000 个字，文件里是全的
    const long = '长'.repeat(5000);
    recordError(long, noon);
    assert.equal(recentErrors()[0].text, `${'长'.repeat(RECENT_ERROR_CHARS)}…`);
    assert.ok(fs.readFileSync(path.join(logs, 'errors-20261028.log'), 'utf8').includes(long));

    // 清空只清内存里的
    clearRecentErrors();
    assert.deepEqual(recentErrors(), []);
    assert.ok(fs.existsSync(path.join(logs, 'errors-20261028.log')));

    // 出错出得停不下来：每天的文件写到上限就不再写（说一句），第二天接着写；内存里照样记
    const capped = path.join(dir, 'capped');
    setErrorLogDir(capped, () => noon, 300);
    for (let i = 0; i < 20; i++) recordError(`错误 ${i} ${'x'.repeat(40)}`);
    const full = fs.readFileSync(path.join(capped, 'errors-20261028.log'), 'utf8');
    assert.ok(Buffer.byteLength(full) < 300 + 200, `文件没有一直变大：${Buffer.byteLength(full)}`);
    assert.match(full, /今天的错误太多了/);
    assert.equal(full.match(/今天的错误太多了/g)?.length, 1, '只说一次');
    assert.equal(recentErrors()[0].text, `错误 19 ${'x'.repeat(40)}`);
    recordError('第二天', at(2026, 10, 29, 8));
    assert.equal(fs.readFileSync(path.join(capped, 'errors-20261029.log'), 'utf8'), '[2026-10-29 08:00:00] 第二天\n');
    // 重新装上（重启服务器）：从今天的文件现在的大小接着算
    setErrorLogDir(capped, () => noon, 300);
    recordError('重启以后');
    assert.equal(fs.readFileSync(path.join(capped, 'errors-20261028.log'), 'utf8').match(/今天的错误太多了/g)?.length, 2);
    assert.ok(!fs.readFileSync(path.join(capped, 'errors-20261028.log'), 'utf8').includes('重启以后'));
  } finally {
    setErrorLogDir(null);
    clearRecentErrors();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('错误日志脱敏：API 密钥、令牌、密码换成 [已隐藏]，别的照旧', () => {
  // 假的密钥在运行时拼出来：源代码里不留像真密钥的字符串（打包时会检查压缩包里有没有像密钥的东西）
  const secrets = [
    ['sk', 'ant', 'api03', 'AbCdEf0123456789_xyz', 'QWERTY'].join('-'),
    ['sk', 'or', 'v1', '0123456789abcdef'.repeat(2)].join('-'),
    ['sk', '0123456789abcdef'.repeat(2)].join('-'),
    'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'plainsecretvalue123',
    'hunter2hunter2',
    'AIzaSyA-1234567890abcdefg',
    'abcdefSESSIONTOKEN',
  ];
  const text = [
    `调用 Claude 失败：invalid x-api-key ${secrets[0]}`,
    `OPENROUTER_API_KEY=${secrets[1]}`,
    `{"apiKey":"${secrets[2]}","model":"deepseek-v4"}`,
    `Authorization: Bearer ${secrets[3]}`,
    `x-api-key: ${secrets[4]}`,
    `密钥＝没写对，密码：${secrets[5]}`,
    `GET https://example.com/v1/models?key=${secrets[6]}&page=2`,
    `cookie: trpg_sid=${secrets[7]}; theme=dark`,
    'task-0123456789abcdef 不是密钥；max_tokens: 4000；input_tokens 12',
  ].join('\n');
  const clean = redactSecrets(text);
  for (const secret of secrets) assert.ok(!clean.includes(secret), `${secret} 没藏起来：\n${clean}`);
  assert.match(clean, /\[已隐藏\]/);
  assert.match(clean, /task-0123456789abcdef 不是密钥/);
  assert.match(clean, /max_tokens: 4000/);
  assert.match(clean, /"model":"deepseek-v4"/);
  assert.match(clean, /page=2/);
  assert.match(clean, /theme=dark/);

  // 内存里和文件里都是脱敏以后的
  const dir = tempDir();
  try {
    clearRecentErrors();
    setErrorLogDir(dir, () => at(2026, 10, 28, 12));
    recordError(text);
    const inFile = fs.readFileSync(path.join(dir, 'errors-20261028.log'), 'utf8');
    for (const secret of secrets) {
      assert.ok(!recentErrors()[0].text.includes(secret));
      assert.ok(!inFile.includes(secret));
    }
  } finally {
    setErrorLogDir(null);
    clearRecentErrors();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('脱敏还藏：浏览器推送的地址、JWT（vapid t=…）、JWK 私钥、兑换码和邀请码；正常的报错不误伤', () => {
  const secrets = [
    'dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ',
    'gAAAAABmZ0123456789abcdefSECRETmozilla',
    'BQYAAAB%3dsecretwnstoken',
    'QXBwbGVQdXNoU2VjcmV0VG9rZW4xMjM',
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSJ9.c2lnbmF0dXJlc2lnbmF0dXJl',
    'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    'ABCD2345EFGH',
    'HJKM3456NPQR',
    '新年快乐兑换码2026',
  ];
  const text = [
    `推送失败：https://fcm.googleapis.com/fcm/send/${secrets[0]}`,
    `推送失败：https://updates.push.services.mozilla.com/wpush/v2/${secrets[1]}`,
    `推送失败：https://wns2-par02p.notify.windows.com/w/?token=${secrets[2]}`,
    `推送失败：https://web.push.apple.com/${secrets[3]} 返回 410`,
    `headers: { Authorization: 'vapid t=${secrets[4]}, k=BPublicKey' }`,
    `{"kty":"EC","crv":"P-256","d":"${secrets[5]}","x":"pubx","y":"puby"}`,
    `{ kty: 'EC', crv: 'P-256', d: '${secrets[5]}' }`,
    `{"code":"${secrets[6]}","amount":1}`,
    `{"inviteCode":"${secrets[7]}","username":"friend"}`,
    `{ redeemCode: '${secrets[8]}' }`,
  ].join('\n');
  const clean = redactSecrets(text);
  for (const secret of secrets) assert.ok(!clean.includes(secret), `${secret} 没藏起来：\n${clean}`);
  // 主机名留着，看得出是哪家的推送服务
  assert.match(clean, /https:\/\/fcm\.googleapis\.com\/fcm\/send\/\[已隐藏\]/);
  assert.match(clean, /https:\/\/updates\.push\.services\.mozilla\.com\/wpush\/v2\/\[已隐藏\]/);
  assert.match(clean, /https:\/\/web\.push\.apple\.com\/\[已隐藏\] 返回 410/);
  assert.match(clean, /k=BPublicKey/);
  assert.match(clean, /"x":"pubx"/);
  assert.match(clean, /"amount":1/);

  // 平常的报错原样不动
  const ordinary = [
    "Error: ENOENT: no such file or directory, open 'C:\\Users\\me\\ai-trpg\\data\\game.db'",
    "  code: 'ECONNRESET',",
    "{ errno: -4077, code: 'ECONNRESET', syscall: 'read' }",
    'SyntaxError: Unexpected token } in JSON at position 5',
    "TypeError: Cannot read properties of undefined (reading 'roleKey')",
    'listen EADDRINUSE: address already in use 0.0.0.0:3000',
    '拿不到 OpenRouter 的模型列表：fetch failed',
    '龙娘跑团 V0.8.0 已启动：https://trpg.example.com/room/12?tab=log',
    '{"error":{"message":"Rate limit reached","code":429}}',
    '每天自动备份失败了（网站照常运行，一小时以后再试）： Error: SQLITE_BUSY: database is locked',
    '    at GameEngine.tick (file:///C:/ai-trpg/server/game/engine.ts:312:9)',
    'max_tokens: 4000；input_tokens 12；task-0123456789abcdef',
  ];
  for (const line of ordinary) assert.equal(redactSecrets(line), line);
});

test('脱敏不会慢：一大串字母、数字、空格、半截的密钥写法，4 万和 10 万个字都是几毫秒', () => {
  const makers: Record<string, (n: number) => string> = {
    小写字母: (n) => 'a'.repeat(n),
    大写字母: (n) => 'A'.repeat(n),
    数字: (n) => '7'.repeat(n),
    空格: (n) => ' '.repeat(n),
    下划线: (n) => '_'.repeat(n),
    很多sk: (n) => 'sk-'.repeat(n / 3),
    很多半截JWT: (n) => 'eyJaa.eyJaa.'.repeat(n / 12),
    很多网址: (n) => 'https://a.'.repeat(n / 10),
    没闭合的JWK: (n) => '"d":"' + 'a'.repeat(n),
    很多code: (n) => '"code":"'.repeat(n / 8),
    名字后面很多空格: (n) => 'token' + ' '.repeat(n),
    很多名字: (n) => 'password: '.repeat(n / 10),
    很多sid: (n) => 'a_sid'.repeat(n / 5),
    中文: (n) => '对局'.repeat(n / 2),
  };
  for (const n of [40_000, 100_000]) {
    for (const [name, make] of Object.entries(makers)) {
      const text = make(n);
      // 取三次里最快的一次（避开碰巧赶上的垃圾回收），以前最慢的要两三秒
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        redactSecrets(text);
        best = Math.min(best, performance.now() - t0);
      }
      assert.ok(best < 20, `${n} 个字的「${name}」脱敏用了 ${best.toFixed(1)} ms`);
    }
  }
  // 走 console.error 那条路（先截到 4 万字再脱敏）
  try {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      recordError('x'.repeat(100_000));
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 20, `recordError 用了 ${best.toFixed(1)} ms`);
  } finally {
    clearRecentErrors();
  }
});

test('装上错误日志：console.error 照常打印、另外记下来；没处理到的错误交给 onFatal；写不进文件不会没完没了', () => {
  const dir = tempDir();
  const printed: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => printed.push(args);
  const fatal: unknown[] = [];
  const uncaughtBefore = process.listeners('uncaughtException');
  const rejectionBefore = process.listeners('unhandledRejection');
  let uninstall = () => {};
  try {
    clearRecentErrors();
    uninstall = installErrorLog({ dir: path.join(dir, 'logs'), now: () => at(2026, 10, 28, 9), onFatal: (err) => fatal.push(err) });
    console.error('出错了：', new Error('boom'), { 'x-api-key': 'sk-ant-api03-secretsecretsecret' });
    assert.equal(printed.length, 1, '照常打印');
    const entry = recentErrors()[0];
    assert.match(entry.text, /出错了：/);
    assert.match(entry.text, /boom/);
    assert.ok(!entry.text.includes('secretsecretsecret'));
    const file = fs.readFileSync(path.join(dir, 'logs', 'errors-20261028.log'), 'utf8');
    assert.match(file, /^\[2026-10-28 09:00:00\] 出错了：/);
    assert.ok(!file.includes('secretsecretsecret'));

    // 没处理到的错误：记下来，交给 onFatal（关服务器、退出）；没处理到的异步错误：只记下来
    const onUncaught = process.listeners('uncaughtException').find((l) => !uncaughtBefore.includes(l));
    const onRejection = process.listeners('unhandledRejection').find((l) => !rejectionBefore.includes(l));
    assert.ok(onUncaught && onRejection);
    const crash = new Error('没人接的错误');
    onUncaught(crash, 'uncaughtException');
    assert.deepEqual(fatal, [crash]);
    assert.match(recentErrors()[0].text, /没处理到的错误[\s\S]*没人接的错误/);
    onRejection(new Error('没人接的 Promise'), Promise.resolve());
    assert.equal(fatal.length, 1, '异步错误不关服务器');
    assert.match(recentErrors()[0].text, /服务器照常运行[\s\S]*没人接的 Promise/);

    uninstall();
    uninstall = () => {};
    assert.equal(process.listeners('uncaughtException').length, uncaughtBefore.length);
    assert.equal(process.listeners('unhandledRejection').length, rejectionBefore.length);
    console.error('卸下以后');
    assert.notEqual(recentErrors()[0].text, '卸下以后', '卸下以后不再记');

    // 日志文件夹建不了（那里是个文件）：只在窗口里说一次，不会因为写日志出错又记日志
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'a file');
    printed.length = 0;
    uninstall = installErrorLog({ dir: path.join(blocked, 'logs'), onFatal: () => {} });
    console.error('第一条');
    console.error('第二条');
    const warnings = printed.filter((args) => String(args[0]).includes('错误日志写不进'));
    assert.equal(warnings.length, 1, '只说一次');
    assert.equal(printed.length, 3, '两条报错照常打印，加上一条提示');
    assert.equal(recentErrors()[0].text, '第二条', '内存里照样记下');
  } finally {
    uninstall();
    console.error = original;
    clearRecentErrors();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 健康检查 ====================

test('/api/health：不用登录；数据库正常回 ok 和版本号，数据库出错回 503，别的什么都不说', async () => {
  const t = await startTestApp();
  const captured = captureConsoleError();
  try {
    const ok = await t.call('GET', '/api/health');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true, version: APP_VERSION });

    // 数据库坏了（查 SELECT 1 出错）
    const db = t.app.db as unknown as { prepare: (sql: string) => unknown };
    const real = db.prepare;
    db.prepare = function (sql: string) {
      if (sql === 'SELECT 1') throw new Error('database disk image is malformed');
      return real.call(this, sql);
    };
    try {
      const bad = await t.call('GET', '/api/health');
      assert.equal(bad.status, 503);
      assert.deepEqual(bad.data, { ok: false });
    } finally {
      delete (db as { prepare?: unknown }).prepare;
    }
    assert.ok(captured.lines.some((l) => l.includes('健康检查')));
    assert.equal((await t.call('GET', '/api/health')).status, 200);
    assert.equal((await t.call('POST', '/api/health', {})).status, 405);
  } finally {
    captured.restore();
    await t.close();
  }
});

// ==================== 管理页「版本和数据」 ====================

test('管理页「版本和数据」：运行多久、内存、最近一次每天自动备份、最近的错误（脱敏、新的在前、能清空、要权限）', async () => {
  const t = await startTestApp();
  try {
    clearRecentErrors();
    const admin = await t.login(ADMIN.username, ADMIN.password);
    const player = await t.login(TESTER1.username, TESTER1.password);
    const other = await t.login(TESTER2.username, TESTER2.password);

    let info = await t.call('GET', '/api/admin/system', undefined, admin);
    assert.equal(info.status, 200);
    const runtime = info.data.runtime;
    assert.equal(typeof runtime.uptimeSeconds, 'number');
    assert.ok(runtime.uptimeSeconds >= 0);
    assert.ok(runtime.rssMb > 0);
    assert.equal(runtime.lastDailyBackupAt, null);
    assert.equal(runtime.logDir, null, '测试里没装错误日志');
    assert.deepEqual(runtime.errors, []);

    // 有了错误、有了一份每天自动备份
    recordError('第一条：连不上 DeepSeek（x-api-key: sk-0123456789abcdef0123）', Date.now() - 1000);
    recordError('第二条：Authorization: Bearer abcdefghijklmnop0123', Date.now());
    const madeAt = Date.now();
    const made = dailyBackupIfDue(t.app.db, info.data.dbFile, madeAt);
    assert.ok(made);
    info = await t.call('GET', '/api/admin/system', undefined, admin);
    assert.equal(info.data.runtime.lastDailyBackupAt, Math.floor(madeAt / 1000) * 1000);
    assert.equal(info.data.backups[0].kind, 'daily');
    const errors = info.data.runtime.errors as { at: number; text: string }[];
    assert.equal(errors.length, 2);
    assert.match(errors[0].text, /^第二条/, '新的在前');
    assert.ok(!JSON.stringify(errors).includes('sk-0123456789abcdef0123'));
    assert.ok(!JSON.stringify(errors).includes('abcdefghijklmnop0123'));
    assert.match(errors[1].text, /x-api-key: \[已隐藏\]/);

    // 权限：普通玩家、没有「版本和数据」权限的管理员都不行
    assert.equal((await t.call('GET', '/api/admin/system', undefined, player)).status, 403);
    assert.equal((await t.call('DELETE', '/api/admin/system/errors', undefined, player)).status, 403);
    t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["users"]' WHERE username = ?`).run(TESTER2.username);
    const denied = await t.call('DELETE', '/api/admin/system/errors', undefined, other);
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /版本和数据/);
    assert.equal((await t.call('DELETE', '/api/admin/system/errors')).status, 401);
    assert.equal(recentErrors().length, 2, '没清掉');

    // 清空：只清内存里的列表，记一笔操作记录
    const cleared = await t.call('DELETE', '/api/admin/system/errors', undefined, admin);
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.runtime.errors, []);
    assert.deepEqual(recentErrors(), []);
    const log = t.app.db.prepare("SELECT detail FROM admin_audit WHERE action = '清空最近的错误'").get() as { detail: string } | undefined;
    assert.equal(log?.detail, '2 条');
  } finally {
    clearRecentErrors();
    await t.close();
  }
});

test('手动备份有频率限制：每个账号 10 分钟最多 3 次，超了 429 说清楚；别的管理员不受影响', async () => {
  const t = await startTestApp({ rateLimits: true });
  try {
    const admin = await t.login(ADMIN.username, ADMIN.password);
    for (let i = 0; i < 3; i++) assert.equal((await t.call('POST', '/api/admin/backup', {}, admin)).status, 201);
    const fourth = await t.call('POST', '/api/admin/backup', {}, admin);
    assert.equal(fourth.status, 429);
    assert.match(fourth.data.error, /每 10 分钟最多备份 3 次/);
    const info = await t.call('GET', '/api/admin/system', undefined, admin);
    assert.equal(info.data.backups.filter((b: { kind: string }) => b.kind === 'manual').length, 3, '超了的那次没有备份');

    // 另一个有「版本和数据」权限的管理员照常能备份
    t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["system"]' WHERE username = ?`).run(TESTER2.username);
    const other = await t.login(TESTER2.username, TESTER2.password);
    assert.equal((await t.call('POST', '/api/admin/backup', {}, other)).status, 201);
  } finally {
    await t.close();
  }
});

// ==================== 自动重启的判断（scripts/supervise.mjs） ====================

test('自动重启的判断：正常退出、退出码 78、按了 Ctrl+C 不重启；意外停了重启；10 分钟里第 6 次不重启', () => {
  const now = 1_000_000_000;
  // 正常退出
  assert.deepEqual(afterServerExit({ code: 0, signal: null, stopping: false, restarts: [], now }), { action: 'exit', code: 0 });
  // 设置类的错误
  assert.equal(CONFIG_ERROR_EXIT, 78);
  assert.deepEqual(afterServerExit({ code: 78, signal: null, stopping: false, restarts: [], now }), { action: 'stop', reason: 'config' });
  // 按了 Ctrl+C、关窗口：start.mjs 自己也收到了信号；或者从退出码、信号看得出来
  assert.equal(afterServerExit({ code: 1, signal: null, stopping: true, restarts: [], now }).action, 'exit');
  assert.equal(afterServerExit({ code: null, signal: 'SIGINT', stopping: false, restarts: [], now }).action, 'exit');
  assert.equal(afterServerExit({ code: 130, signal: null, stopping: false, restarts: [], now }).action, 'exit');
  assert.equal(afterServerExit({ code: 3221225786, signal: null, stopping: false, restarts: [], now }).action, 'exit');
  assert.equal(afterServerExit({ code: null, signal: 'SIGHUP', stopping: false, restarts: [], now }).action, 'exit');
  // 意外停了：等 5 秒重启
  assert.deepEqual(afterServerExit({ code: 1, signal: null, stopping: false, restarts: [], now }), { action: 'restart', delayMs: RESTART_DELAY_MS });
  assert.equal(RESTART_DELAY_MS, 5000);
  assert.equal(afterServerExit({ code: null, signal: 'SIGKILL', stopping: false, restarts: [], now }).action, 'restart');
  assert.equal(afterServerExit({ code: 7, signal: null, stopping: false, restarts: [], now }).action, 'restart');

  // 10 分钟里已经重启了 5 次：第 6 次停了就不再重启
  assert.equal(MAX_RESTARTS, 5);
  assert.equal(RESTART_WINDOW_MS, 10 * 60_000);
  const five = [now - 9 * 60_000, now - 7 * 60_000, now - 5 * 60_000, now - 3 * 60_000, now - 60_000];
  assert.equal(afterServerExit({ code: 1, signal: null, stopping: false, restarts: five.slice(1), now }).action, 'restart', '第 5 次还重启');
  assert.deepEqual(afterServerExit({ code: 1, signal: null, stopping: false, restarts: five, now }), { action: 'stop', reason: 'too-many' });
  // 最早那次已经是 10 分钟以前了：照样重启
  const older = [now - 11 * 60_000, ...five.slice(1)];
  assert.equal(afterServerExit({ code: 1, signal: null, stopping: false, restarts: older, now }).action, 'restart');
  // 重启太多次以后按 Ctrl+C：照常退出
  assert.equal(afterServerExit({ code: 1, signal: null, stopping: true, restarts: five, now }).action, 'exit');
});

test('start.mjs：服务器停了不再重启、在等你按回车关窗口时按 Ctrl+C，马上退出', async () => {
  const dir = tempDir();
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  // 一个假的项目：npm start 跑的「服务器」一启动就以 78 退出（设置写错了那种，不重启）
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'data'));
  for (const f of ['start.mjs', 'supervise.mjs', 'upgrade.mjs', 'builtin-scenarios.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ai-trpg', version: APP_VERSION, private: true, scripts: { start: 'node fake-server.mjs' } }));
  fs.writeFileSync(path.join(dir, 'fake-server.mjs'), "console.log('假服务器：设置写错了'); process.exit(78);\n");
  fs.writeFileSync(path.join(dir, 'data', 'game.db'), '');
  fs.writeFileSync(path.join(dir, '.env'), `AI_PROVIDER=fake\nPORT=${port}\n`);
  // 输入一直开着（像真的窗口）：不按回车就一直等
  const child = spawn(process.execPath, [path.join(dir, 'scripts', 'start.mjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    for (let i = 0; i < 600 && !out.includes('按回车键关闭这个窗口'); i++) await sleep(50);
    assert.match(out, /服务器停下来了，看看上面的报错/, out);
    assert.doesNotMatch(out, /自动重启/);
    child.kill('SIGINT');
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
    assert.equal(code, 1, `按了 Ctrl+C 没有退出：\n${out}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('启动脚本：start.mjs 语法没问题；数据是更新的版本留下的、设置写错了，服务器以 78 退出，报错也写进了错误日志', async () => {
  assert.equal(spawnSync(process.execPath, ['--check', path.join(ROOT, 'scripts', 'start.mjs')]).status, 0);
  assert.equal(spawnSync(process.execPath, ['--check', path.join(ROOT, 'scripts', 'supervise.mjs')]).status, 0);

  const dir = tempDir();
  try {
    const file = path.join(dir, 'data', 'game.db');
    const db = openDatabase(file, { onBackup: () => {} });
    db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length + 1);
    db.close();
    const run = (env: Record<string, string>) =>
      new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts')], {
          cwd: ROOT,
          env: { ...process.env, AI_PROVIDER: 'fake', HOST: '127.0.0.1', PORT: '39999', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`服务器没有退出：\n${out}`));
        }, 60_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });

    const tooNew = await run({ DB_PATH: file });
    assert.equal(tooNew.code, CONFIG_ERROR_EXIT, tooNew.out);
    assert.match(tooNew.out, /被更新的版本/);
    // 错误日志在数据库旁边的 logs 文件夹里
    const logs = path.join(dir, 'data', 'logs');
    const logFiles = fs.readdirSync(logs);
    assert.equal(logFiles.length, 1);
    assert.match(logFiles[0], /^errors-\d{8}\.log$/);
    assert.match(fs.readFileSync(path.join(logs, logFiles[0]), 'utf8'), /被更新的版本/);

    const badPort = await run({ DB_PATH: file, PORT: 'abc' });
    assert.equal(badPort.code, CONFIG_ERROR_EXIT, badPort.out);
    assert.match(badPort.out, /PORT 设置得不对/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 顺手修的几处 ====================

test('请求处理之前就出错（查登录时数据库出错）：回 500，不会一直不回', async () => {
  const t = await startTestApp();
  const captured = captureConsoleError();
  try {
    const db = t.app.db as unknown as { prepare: (sql: string) => unknown };
    const real = db.prepare;
    db.prepare = function (sql: string) {
      if (sql.includes('FROM sessions s JOIN users u')) throw new Error('database is locked');
      return real.call(this, sql);
    };
    try {
      const res = await t.call('GET', '/api/auth/me', undefined, 'trpg_sid=abc');
      assert.equal(res.status, 500);
      assert.equal(res.data.error, '服务器出错了，请稍后再试');
    } finally {
      delete (db as { prepare?: unknown }).prepare;
    }
    assert.ok(captured.lines.some((l) => l.includes('database is locked')));
  } finally {
    captured.restore();
    await t.close();
  }
});

test('对方没发完就断开了（关了页面、网络断了）：不算服务器出错，不记进错误日志', async () => {
  const t = await startTestApp();
  const captured = captureConsoleError();
  try {
    const port = Number(new URL(t.base).port);
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"username":"a');
        setTimeout(() => {
          socket.destroy();
          setTimeout(resolve, 200);
        }, 100);
      });
    });
    assert.deepEqual(captured.lines, []);
    assert.equal((await t.call('GET', '/api/health')).status, 200);
  } finally {
    captured.restore();
    await t.close();
  }
});

test('读网页文件出错、查文件出错：只影响这一个请求，服务器照常运行；服务器的 error 事件不会把服务器弄停', async () => {
  const dir = tempDir();
  const webDist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>龙娘跑团</title>');
  fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log(1)');
  const t = await startTestApp({ webDist });
  const captured = captureConsoleError();
  const realStream = fs.createReadStream;
  const realStat = fs.statSync;
  try {
    assert.equal(await (await fetch(`${t.base}/`)).text(), '<!doctype html><title>龙娘跑团</title>');

    // 读文件的时候出错（被删掉了、被杀毒软件锁着）
    (fs as { createReadStream: unknown }).createReadStream = () =>
      new Readable({
        read() {
          this.destroy(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
        },
      });
    const broken = await fetch(`${t.base}/`)
      .then((r) => r.text())
      .catch(() => 'failed');
    assert.notEqual(broken, '<!doctype html><title>龙娘跑团</title>');
    (fs as { createReadStream: unknown }).createReadStream = realStream;
    assert.ok(captured.lines.some((l) => l.includes('EBUSY')));

    // 查文件的时候出错
    (fs as { statSync: unknown }).statSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    const statFailed = await fetch(`${t.base}/assets/app.js`);
    (fs as { statSync: unknown }).statSync = realStat;
    assert.equal(statFailed.status, 500);

    // 开起来以后的 error 事件（一下子连进来太多、打开的文件太多）：记下来，不抛出来
    assert.doesNotThrow(() => t.app.server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' })));
    assert.ok(captured.lines.some((l) => l.includes('网站服务出错')));

    // 服务器照常运行
    assert.equal((await t.call('GET', '/api/health')).status, 200);
    assert.equal(await (await fetch(`${t.base}/assets/app.js`)).text(), 'console.log(1)');
  } finally {
    (fs as { createReadStream: unknown }).createReadStream = realStream;
    (fs as { statSync: unknown }).statSync = realStat;
    captured.restore();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('假主持人：一直用着的 signal 上不会越积越多的监听；正式启动时不留收到的请求', async () => {
  const request = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: '你好' }] } as unknown as MessagesRequest;
  const fake = new FakeProvider(demoHandler, 1);
  const controller = new AbortController();
  for (let i = 0; i < 5; i++) await fake.send(request, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(fake.requests.length, 5, '测试里照样留着');

  // 中途取消：照样能取消
  const slow = new FakeProvider(demoHandler, 5000);
  const stop = new AbortController();
  const pending = slow.send(request, stop.signal);
  stop.abort(new Error('关服务器了'));
  await assert.rejects(pending, /关服务器了/);

  const quiet = Object.assign(new FakeProvider(demoHandler, 1), { keepRequests: false });
  await quiet.send(request, controller.signal);
  assert.equal(quiet.requests.length, 0);
});
