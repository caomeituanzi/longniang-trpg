// 一键启动：检查 Node.js 版本 → 第一次运行时安装依赖 → 新版本第一次启动时问要不要从旧版本复制数据
// → 没有设置文件就建一个，一个密钥都没有时问你要 DeepSeek 的 API 密钥并检查能不能用 → 第一次运行时建站长账号（不建测试账号）→ 启动服务器 → 打开浏览器。
// 服务器意外停了会自动重启（V0.8.0，见 supervise.mjs）。
// Windows 双击 start.bat，Mac 双击 start.command，或者在项目文件夹里运行 node scripts/start.mjs。
// 只用 Node 自带的功能，旧版本的 Node 也能跑到版本检查那一步。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const isWindows = process.platform === 'win32';

function say(text = '') {
  console.log(text);
}

// 读用户输入的一行。整个过程共用一个读取器：一次粘贴了好几行也不会丢。
// 输入被关掉了（按了 Ctrl+Z / Ctrl+D，或者不是在窗口里运行）时返回 null，之后再问也马上返回 null，不会卡住。
let reader = null;
let inputEnded = false;
let closingOnPurpose = false;
const lines = [];
const waiting = [];

function ask(question) {
  process.stdout.write(question);
  if (inputEnded) {
    process.stdout.write('\n');
    return Promise.resolve(null);
  }
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin });
    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    reader.on('close', () => {
      if (!closingOnPurpose) inputEnded = true;
      for (const next of waiting.splice(0)) next(null);
    });
  }
  return new Promise((resolve) => {
    if (lines.length) resolve(lines.shift().trim());
    else waiting.push((line) => resolve(line === null ? null : line.trim()));
  });
}

/** 不再需要输入了：放开键盘输入，交给服务器。 */
function stopAsking() {
  closingOnPurpose = true;
  reader?.close();
  reader = null;
  closingOnPurpose = false;
}

/**
 * 启动一个命令。Windows 上 npm 是 npm.cmd，要经过 cmd 才能运行（也就绕开了 PowerShell 禁止运行脚本的问题）；
 * 经过 cmd 时把命令拼成一整句（参数都是写死的，没有空格），新版 Node 不会再提示不安全。
 */
function spawnCommand(command, args, options) {
  return isWindows ? spawn([command, ...args].join(' '), { ...options, shell: true }) : spawn(command, args, options);
}

/** 运行一个命令，把输出直接显示出来；返回退出码。 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function quit(message) {
  say();
  say(message);
  say();
  await ask('按回车键关闭这个窗口。');
  process.exit(1);
}

// ---------- 1. Node.js 版本 ----------

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  await quit(
    `你的 Node.js 是 ${process.versions.node}，太旧了，需要 22.13 或更高。\n请到 https://nodejs.org 下载标着 LTS 的版本重新安装，装好以后再双击启动。`,
  );
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
say(`龙娘跑团 V${pkg.version}：准备启动`);
say();

// ---------- 2. 安装依赖 ----------

// package.json 里列的依赖都装好了就不用再装（新版本加了依赖时会自动补装）
const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const missing = wanted.filter((name) => !fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')));
if (missing.length) {
  const first = missing.length === wanted.length;
  say(first ? '第一次运行，正在安装依赖（需要联网，一般一两分钟）……' : '有新的依赖，正在补装（需要联网）……');
  const code = await run('npm', ['install', '--no-audit', '--no-fund']);
  if (code !== 0) await quit('安装依赖失败了。看看上面的报错：多半是网络问题，换个网络或者过一会儿再双击启动。');
  say();
}

// ---------- 3. 从旧版本复制数据 ----------

// 新版本解压到新文件夹，第一次启动时还没有数据库：在旁边找旧版本，问要不要把账号、对局、剧本和设置复制过来
const upgrade = await import('./upgrade.mjs');
if (!fs.existsSync(upgrade.dbFileOf(ROOT))) {
  let result = 'skipped';
  try {
    result = await upgrade.offerImport({ root: ROOT, ask, say });
  } catch (err) {
    await quit(`从旧版本复制数据失败了：${err instanceof Error ? err.message : err}\n旧版本的文件夹没有受影响，关掉这个窗口以后还能照常用旧版本。`);
  }
  if (result === 'abort') await quit('这次没有复制数据，也没有启动。准备好以后再双击 start.bat（Mac 是 start.command），会重新问。');
}

// ---------- 4. 设置文件和 API 密钥 ----------

function readEnv() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '') : '';
}

/** 设置文件里某一项的值（没写、或者被 # 注释掉了是空字符串）。和服务器一样用 Node 自带的 parseEnv 读，行尾的 # 注释不算在值里。 */
function envValue(text, key) {
  try {
    return String(util.parseEnv(text)[key] ?? '').trim();
  } catch {
    return '';
  }
}

/** 把某一项写进设置文件：已经有这一行（包括被注释掉的）就改掉，没有就加在最后。 */
function setEnvValue(key, value) {
  let text = readEnv();
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, 'm');
  text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  say('已经建好设置文件 .env（在项目文件夹里，里面会存你的 API 密钥，不要发给别人）。');
  say();
}

// 四项模型默认都用 DeepSeek V4.1 Flash 1017：一个密钥都还没有时，问 DeepSeek 的密钥并检查能不能用。
// 已经有哪一家的密钥（从旧版本复制来的、自己填的）就不问；缺了哪一家，服务器启动时会说。Claude、OpenRouter、中转站的密钥用 api-keys.bat 填。
let env = readEnv();
const fake = envValue(env, 'AI_PROVIDER').toLowerCase() === 'fake';
const anyKey = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'RELAY_API_KEY'].some((k) => envValue(env, k));
if (!fake && !anyKey) {
  const { KEYS, checkDeepSeek } = await import('./key-check.mjs');
  say('需要 DeepSeek 的 API 密钥，AI 主持才能用（四项模型默认都用 DeepSeek V4.1 Flash 1017）。');
  say(`${KEYS.deepseek.where}，复制以后粘贴到这里，再按回车。DeepSeek 要先充值才能用。`);
  say('还没有密钥、只想先看看流程：直接按回车，会先用不调用 AI 的假主持人。');
  say('要用 Claude、OpenRouter 或者中转站（ChatGPT 的模型）：也先直接按回车，之后双击 api-keys.bat 填它们的密钥、关掉假主持人，再在「管理」→「AI」里换模型。');
  for (;;) {
    const key = ((await ask('DeepSeek 的 API 密钥：')) ?? '').replace(/\s+/g, '');
    if (!key) {
      setEnvValue('AI_PROVIDER', 'fake');
      say('好的，这次先用假主持人（叙述是固定的套话，不花钱）。有了密钥以后，双击 api-keys.bat 填上密钥、关掉假主持人，再启动。');
      say();
      break;
    }
    if (!KEYS.deepseek.looksRight(key, env)) {
      say(`${KEYS.deepseek.wrongShape}再试一次。`);
      say();
      continue;
    }
    say('正在检查密钥……');
    const result = await checkDeepSeek(key, env);
    if (result.ok === false) {
      say(`${result.message}再试一次吧。`);
      say();
      continue;
    }
    setEnvValue('DEEPSEEK_API_KEY', key);
    if (result.ok) say('密钥可以用，已经存进 .env。');
    else if (result.custom) say('用的是自己设的接口地址，没法检查，密钥先存下了。启动以后 AI 用不了的话，网页上会说明原因。');
    else say('现在连不上 DeepSeek 的服务器，没法检查。密钥先存下了，启动以后 AI 用不了的话，网页上会说明原因。');
    say();
    break;
  }
}

// ---------- 5. 端口上已经有服务器在跑（多半是旧版本还开着）----------

// 不先关掉的话，新版本启动不了，浏览器还会打开旧的那个
env = readEnv();
const port = Number(envValue(env, 'PORT')) || 3000;
const url = `http://localhost:${port}`;
for (let i = 0; await upgrade.serverRunning(port); i++) {
  if (i >= 20) await quit(`${url} 上一直有别的服务器在运行。先关掉它（可能是旧版本的黑色窗口），再双击 start.bat。`);
  say(`${url} 上已经有一个龙娘跑团在运行（可能是旧版本还开着）。先关掉它的黑色窗口，再按回车继续。`);
  if ((await ask('')) === null) await quit(`${url} 上已经有一个龙娘跑团在运行。先关掉它（可能是旧版本的黑色窗口），再双击 start.bat。`);
}

stopAsking();

// ---------- 6. 第一次运行：建站长账号 ----------

// 没有从旧版本复制数据、还没有数据库：只建你的站长账号（0 号），不建测试账号，朋友们拿邀请码自己注册。
// V1.0.0 正式版：内测的数据升级时删档（连站长一起清掉），清完也在这里建新的站长账号；数据库里一个账号都没有时也一样。
// 只在自己电脑上试、要测试账号的话，运行 npm run seed：往数据里加上测试账号，密码是公开的，朋友们在用的网站上别加。
const dbPath = path.resolve(ROOT, envValue(env, 'DB_PATH') || path.join('data', 'game.db'));
if (upgrade.needsOwner(dbPath, ROOT)) {
  const code = await run('npm', ['run', '--silent', 'reset', '--', '--first-run']);
  if (code !== 0 || !fs.existsSync(dbPath)) {
    await quit('站长账号没有建好，服务器也没有启动。再双击 start.bat（Mac 是 start.command）会重新问。');
  }
  say();
}

// ---------- 7. 启动，等网页能打开了就打开浏览器 ----------

// 服务器意外停了（V0.8.0）：等 5 秒自动重启，10 分钟里重启超过 5 次就不再重启；设置类的错误（退出码 78）不重启。
// 要不要重启由 supervise.mjs 判断
const { afterServerExit } = await import('./supervise.mjs');

// 按 Ctrl+C、关窗口时服务器自己会停下来；这边等它停好再退出。
// 没有在运行的服务器时（正在等着重启、服务器停了在等你按回车关窗口）直接退出
let stopping = false;
let restartTimer = null;
/** 服务器的进程还开着。 */
let serverRunning = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      process.exit(0);
    }
    if (!serverRunning) process.exit(1);
  });
}
/** 每次自动重启的时间。 */
const restarts = [];

function startServer() {
  const server = spawnCommand('npm', ['start'], { cwd: ROOT, stdio: 'inherit' });
  serverRunning = true;
  server.on('error', (err) => {
    serverRunning = false;
    void quit(`启动服务器失败了：${err.message}`);
  });
  server.on('exit', async (code, signal) => {
    serverRunning = false;
    const next = afterServerExit({ code, signal, stopping, restarts, now: Date.now() });
    if (next.action === 'restart') {
      // 重启时不再打开浏览器、不再问问题
      restarts.push(Date.now());
      say();
      say(`服务器意外停了（退出码 ${code ?? signal}），${next.delayMs / 1000} 秒后自动重启……`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startServer();
      }, next.delayMs);
      return;
    }
    if (next.action === 'stop') {
      await quit(
        next.reason === 'too-many' ? '服务器 10 分钟里意外停了好几次，不再自动重启了。看看上面的报错。' : '服务器停下来了，看看上面的报错。',
      );
    }
    process.exit(next.code ?? 0);
  });
}
startServer();

async function waitAndOpen() {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${url}/api/auth/me`);
      if (res.ok) {
        const [command, args] = isWindows ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        // Windows 上要原样传参数，不然 start 后面的 "" 会被转义坏
        spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: isWindows }).on('error', () => {}).unref();
        say(`浏览器已经打开 ${url}。没打开的话，自己在浏览器里输入这个地址。关掉这个窗口（或者按 Ctrl+C）就停止服务器。`);
        return;
      }
    } catch {
      // 还没启动好
    }
  }
}
void waitAndOpen();
