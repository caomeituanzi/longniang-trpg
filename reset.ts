import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { databaseInUse, serverRunning, withReadOnly } from '../scripts/upgrade.mjs';
import { DISPLAY_NAME_RULE, PASSWORD_RULE, USERNAME_RULE } from './auth';
import { config } from './config';
import { assertNotTooNew, DataTooNewError, openDatabase, type DB } from './db';
import { betaWipeLines, finishBetaWipe } from './beta-wipe';
import { createOwner, planReset, resetData, type ResetPlan, type ResetResult } from './reset-data';
import { getSetting } from './settings';
import { versionLabel } from './version';

/**
 * 清空数据，从一个新的站长账号重新开始（正式开放之前用）：
 *   npm run reset
 * 先问清楚（输入「清空」确认、新站长的用户名、显示名、密码），问完才动数据；中途按 Ctrl+C 什么都不会改。
 * 问的时候数据库只读，不新建、不升级。
 * 只有能碰到运行服务器的这台电脑的人才能运行，所以别人没法抢先注册成站长。
 *
 *   npm run reset -- --first-run
 * 第一次运行（start.bat 发现还没有数据时用）：没什么要清空的，不问「清空」，只建站长账号，不建测试账号。已经有账号时什么都不做。
 * 已经有数据、里面一个账号都没有（V1.0.0 正式版升级时删档了）：先把数据库升级好（删档在升级里做），只建站长账号，别的不动。
 */

const firstRun = process.argv.includes('--first-run');
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario-dir='));
const scenarioDir = scenarioArg ? path.resolve(scenarioArg.slice('--scenario-dir='.length)) : config.scenarioDir;

// ---------- 一问一答 ----------
// 在窗口里运行时一问一答，密码不显示；不在窗口里（测试、管道）时按行读。输入被关掉了返回 null。

const tty = !!process.stdin.isTTY;
let lines: string[] | null = null;
let waiting: ((line: string | null) => void)[] = [];
let ended = false;

function lineReader() {
  if (lines) return;
  lines = [];
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines!.push(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });
}

function cancelled(): never {
  // 从 start.bat 里运行时，退出以后窗口还要接着用：先把键盘输入恢复成平常的样子
  if (tty && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdout.write('\n什么都没改。\n');
  process.exit(130);
}

function askLine(question: string): Promise<string | null> {
  if (!tty) {
    process.stdout.write(question);
    lineReader();
    if (lines!.length) return Promise.resolve(lines!.shift()!);
    if (ended) {
      process.stdout.write('\n');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  // 问题交给 readline 来写：它会重画这一行，自己先写上去的会被擦掉
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', cancelled);
    rl.on('close', () => {
      if (answered) return;
      process.stdout.write('\n');
      resolve(null);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/** 输入时不显示（密码）。方向键这些按键发来的控制字符不算进密码。 */
function askHidden(question: string): Promise<string | null> {
  if (!tty) return askLine(question);
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    // 正在跳过的控制序列：esc 是刚收到 ESC，csi 是 ESC [ 开头的（方向键、Delete 这些），ss3 是 ESC O 开头的
    let skipping: 'esc' | 'csi' | 'ss3' | null = null;
    const finish = (result: string | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (skipping === 'esc') {
          skipping = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : null;
          continue;
        }
        if (skipping === 'csi') {
          // 参数、中间的字符之后，以 @～~ 之间的一个字符结束
          if (ch >= '@' && ch <= '~') skipping = null;
          continue;
        }
        if (skipping === 'ss3') {
          skipping = null;
          continue;
        }
        if (ch === '\u001b') skipping = 'esc';
        else if (ch === '\r' || ch === '\n') return finish(value);
        else if (ch === '\u0003') {
          stdin.setRawMode(false);
          cancelled();
        } else if (ch === '\u0004') return finish(null);
        else if (ch === '\u0015') value = ''; // Ctrl+U：清掉重输
        else if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

function quit(message: string, code = 1): never {
  console.log(`\n${message}\n`);
  process.exit(code);
}

const NO_INPUT = '没有读到输入，什么都没改。';

/** 问到符合要求为止。 */
async function askValid(question: string, check: (value: string) => string | null, hidden = false): Promise<string> {
  for (;;) {
    const raw = hidden ? await askHidden(question) : await askLine(question);
    if (raw === null) quit(NO_INPUT);
    const value = hidden ? raw : raw.trim();
    const problem = check(value);
    if (!problem) return value;
    console.log(problem);
  }
}

const length = (s: string) => [...s].length;
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isBusy = (err: unknown) => /locked|busy/i.test(reason(err));

const AGAIN = firstRun ? '再双击 start.bat（Mac 是 start.command）' : '再运行 npm run reset';
const SERVER_RUNNING = `服务器还开着（http://localhost:${config.port}）。先关掉它的黑色窗口，${AGAIN}。`;
const DB_IN_USE = `数据库正被别的程序用着（多半是服务器还开着，可能用的是别的端口）。先关掉服务器的黑色窗口，${AGAIN}。`;

/** 服务器还开着就不能清空：先看端口，再看数据库有没有被别的程序打开着（换了端口的服务器也能发现）。 */
async function requireStopped(after: string) {
  if (await serverRunning(config.port)) quit(`${SERVER_RUNNING}${after}`);
  let inUse = false;
  try {
    inUse = databaseInUse(config.dbPath);
  } catch (err) {
    quit(`打不开数据库（${config.dbPath}）：${reason(err)}`);
  }
  if (inUse) quit(`${DB_IN_USE}${after}`);
}

// ---------- 开始 ----------

// 先只读地看一眼：数据库还没确认清空之前不新建、不升级
const dbExists = config.dbPath !== ':memory:' && fs.existsSync(config.dbPath);
/** 已经有数据、一个账号都没有（V1.0.0 删档以后）：只建站长账号，别的数据不动。 */
let ownerOnly = false;
if (firstRun && dbExists) {
  // 要看里面有没有账号，先把数据库升级到这个版本（V0.x 的数据升级到 V1.0.0 时删档，升级前自动备份）
  await requireStopped('');
  let db: DB;
  try {
    db = openDatabase(config.dbPath);
  } catch (err) {
    if (err instanceof DataTooNewError) quit(err.message);
    if (isBusy(err)) quit(DB_IN_USE);
    quit(`打不开数据库（${config.dbPath}）：${reason(err)}`);
  }
  try {
    const wiped = finishBetaWipe(db, { scenarioDir, dbPath: config.dbPath });
    if (wiped) for (const line of betaWipeLines(wiped)) console.log(line);
    ownerOnly = !db.prepare('SELECT 1 FROM users WHERE is_guest = 0 AND deleted_at IS NULL').get();
  } finally {
    db.close();
  }
  if (!ownerOnly) {
    console.log('已经有数据了，不用再建站长账号。');
    process.exit(0);
  }
  console.log('');
}

if (ownerOnly) console.log('网站里还没有账号，先建你的站长账号（0 号，有全部权限）。朋友们拿邀请码自己注册。\n');
else if (firstRun) console.log('第一次运行，先建你的站长账号（0 号，有全部权限）。不建测试账号，朋友们拿邀请码自己注册。\n');
else console.log(`\n龙娘跑团 ${versionLabel()}：清空数据\n`);

await requireStopped('');

let plan: ResetPlan;
try {
  plan = dbExists
    ? (withReadOnly(config.dbPath, (raw: DB) => {
        assertNotTooNew(raw, config.dbPath);
        return planReset(raw, scenarioDir);
      }) as ResetPlan)
    : planReset(null, scenarioDir);
} catch (err) {
  if (err instanceof DataTooNewError) quit(err.message);
  if (isBusy(err)) quit(DB_IN_USE);
  quit(`读不了数据库（${config.dbPath}）：${reason(err)}`);
}

if (!firstRun) {
  console.log(`数据：${config.dbPath}${dbExists ? '' : '（还没有，会新建一个）'}`);
  if (dbExists) {
    console.log(
      `会删掉：${plan.users} 个账号（包括测试账号和游客）、${plan.rooms} 局对局，还有聊天、好友、私信、通知、公告、举报和反馈、邀请码、违规记录、AI 花费记录、操作记录。`,
    );
  }
  if (plan.scenarioFiles.length) console.log(`会挪进备份文件夹的剧本文件（不是这个版本自带的）：${plan.scenarioFiles.join('、')}`);
  console.log('留着：这个版本自带的剧本、AI 模型的设置、.env 里的设置（API 密钥这些）。');
  console.log(`${dbExists ? '动数据之前会先把整个数据库备份一份。' : ''}做完以后 AI 是关着的，要用的时候站长在「管理」→「AI」里打开。\n`);

  const confirm = await askLine('确定清空吗？输入「清空」两个字再按回车：');
  if (confirm === null) quit(NO_INPUT);
  if (confirm.trim() !== '清空') quit('没有清空，什么都没改。', 0);
}

if (!firstRun) console.log('\n新的站长账号（0 号，有全部权限）：');
const username = await askValid('用户名（3～20 位字母、数字或下划线）：', (v) =>
  length(v) < USERNAME_RULE.min || length(v) > USERNAME_RULE.max || !USERNAME_RULE.pattern.test(v) ? USERNAME_RULE.message : null,
);
const displayRaw = await askLine('显示名（直接回车就和用户名一样）：');
if (displayRaw === null) quit(NO_INPUT);
let displayName = displayRaw.trim() || username;
while (length(displayName) > DISPLAY_NAME_RULE.max) {
  console.log(DISPLAY_NAME_RULE.message);
  const again = await askLine('显示名：');
  if (again === null) quit(NO_INPUT);
  displayName = again.trim() || username;
}
let password = '';
for (;;) {
  password = await askValid(
    `密码（至少 8 位${tty ? '，输入时不显示' : ''}）：`,
    (v) => (length(v) < PASSWORD_RULE.min || length(v) > PASSWORD_RULE.max ? PASSWORD_RULE.message : null),
    true,
  );
  const again = await askHidden('再输一次密码：');
  if (again === null) quit(NO_INPUT);
  if (again === password) break;
  console.log('两次输的密码不一样，重新输一次。');
}

// 问的这一会儿里，服务器可能又打开了：动数据之前再看一次
await requireStopped('什么都没改。');

/** 数据库是这次新建的，没做成：把新建的文件删掉，下次运行还是从头来（start.bat 会再问一遍）。 */
function discardNew() {
  if (dbExists || config.dbPath === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
    } catch {
      // 删不掉也不要紧：下面会说没做成
    }
  }
}

let db: DB;
try {
  db = openDatabase(config.dbPath);
} catch (err) {
  discardNew();
  if (err instanceof DataTooNewError) quit(err.message);
  if (isBusy(err)) quit(`${DB_IN_USE}什么都没改。`);
  quit(`打不开数据库（${config.dbPath}）：${reason(err)}。什么都没改。`);
}
// 清空的时候占住数据库，直到做完：这时候再打开的服务器读写不了它，不会和清空搅在一起
try {
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('BEGIN EXCLUSIVE');
  db.exec('COMMIT');
  db.exec('PRAGMA busy_timeout = 5000');
} catch (err) {
  db.close();
  discardNew();
  if (isBusy(err)) quit(`${DB_IN_USE}什么都没改。`);
  quit(`打不开数据库（${config.dbPath}）：${reason(err)}。什么都没改。`);
}

console.log(firstRun ? '\n正在建站长账号……' : '\n正在清空……');
let result: Pick<ResetResult, 'owner' | 'backup' | 'movedTo' | 'problems'>;
try {
  if (ownerOnly) {
    // 删档以后：只建站长账号，设置、活动这些都不动
    const owner = await createOwner(db, { username, displayName, password }, Date.now(), '网站里没有账号，建了站长账号');
    result = { owner, backup: null, movedTo: null, problems: [] };
  } else {
    // 数据库是这次新建的：里面什么都没有，不用备份
    result = await resetData(db, { dbPath: config.dbPath, scenarioDir, owner: { username, displayName, password }, backup: dbExists, firstRun });
  }
} catch (err) {
  db.close();
  discardNew();
  quit(firstRun ? `站长账号没有建成：${reason(err)}` : `没有清空成功，数据没有改动：${reason(err)}`);
}
const aiOn = getSetting(db, 'ai_enabled') !== '0';
db.close();

console.log(firstRun ? '建好了。' : '\n清空好了。');
console.log(`站长账号：${result.owner.username}（UID ${result.owner.uid}）`);
console.log(aiOn ? 'AI：开着' : 'AI：关着（要用时在「管理」→「AI」里打开）');
if (firstRun) console.log('请朋友来：登录以后在「管理」→「邀请码」里生成注册邀请码，把注册链接发给他们。');
if (result.backup) {
  console.log(`清空之前的备份：${result.backup}`);
  console.log('  这个备份里还是清空之前的全部数据（测试账号、对局、聊天记录都在）：不要发给别人，确定用不着了可以删掉。');
}
if (result.movedTo) console.log(`挪走的文件在：${result.movedTo}`);
if (result.problems.length) {
  console.log('\n有几件收尾的事没做成：');
  for (const problem of result.problems) console.log(`  - ${problem}`);
}
if (!firstRun) console.log('\n接下来：双击 start.bat（Mac 是 start.command）启动，用站长账号登录；请朋友来，在「管理」→「邀请码」里生成注册邀请码。\n');
process.exit(0);
