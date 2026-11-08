import fs from 'node:fs';
import path from 'node:path';
import { formatWithOptions } from 'node:util';

// 错误日志（V0.8.0）：服务器窗口里打印的报错（console.error）另外写进 logs 文件夹（数据库旁边，默认 data/logs）里
// 按天的文件 errors-20261028.log（本地日期），只留最近 14 天；内存里留最近 100 条给管理页「版本和数据」看（重启就没了）。
// 写进文件、给管理页之前，把像 API 密钥的东西换成 [已隐藏]。
// 只在正式启动（server/index.ts）时装上；测试里不装（测试会建很多个服务器，不能每个都改全局的 console）。
// 管理页要读的「最近的错误」放在这个模块里：一个进程只有一份。

/** 日志文件只留最近这么多天（今天也算一天）。 */
export const ERROR_LOG_DAYS = 14;
/** 内存里只留最近这么多条。 */
export const RECENT_ERRORS_KEPT = 100;
/** 内存里每条只留前这么多个字。 */
export const RECENT_ERROR_CHARS = 2000;
/** 写进文件的每条最多这么多个字（有人打印了特别大的东西，不让它把硬盘写满）。 */
const FILE_ERROR_CHARS = 20_000;
/** 每天的日志文件最多写这么多（出错出得停不下来时，不把硬盘写满；窗口里和管理页上照样有）。 */
export const ERROR_LOG_BYTES_PER_DAY = 20 * 1024 * 1024;

export const HIDDEN = '[已隐藏]';

export type ErrorEntry = { at: number; text: string };

/** 最近的错误，旧的在前（给管理页时倒过来）。 */
const recent: ErrorEntry[] = [];
/** 日志文件夹；null 是不写文件（没装上、测试）。 */
let logDir: string | null = null;
let clock: () => number = Date.now;
let bytesPerDay = ERROR_LOG_BYTES_PER_DAY;
/** 哪一天已经删过 14 天以前的日志了（每天第一次写的时候删一次）。 */
let prunedDay = '';
/** 这一天的日志文件已经有多大了；写满了没有（写满时在文件最后说一句）。 */
let dayBytes = 0;
let dayFull = false;
/** 写不进文件时只在窗口里说一次，写进去了再重新算。 */
let warnedWriteFailure = false;
/** 装上以前的 console.error：写日志自己出了问题时用它说，不会又记一遍。 */
let originalError: ((...args: unknown[]) => void) | null = null;

// ---------- 脱敏 ----------

// 每个式子都以固定的字开头、能变长的部分有上限或者后面不用回头找：一大串字母、空格送进来也是一下子就扫完
// （console.error 是在主线程上同步做的，不能慢）。

/** 名字像密钥、密码、登录凭证的设置项（x-api-key: …、ANTHROPIC_API_KEY=…、"apiKey":"…"、密钥=…），后面的值藏起来。trpg_sid 是登录的 Cookie。 */
const SECRET_NAMES =
  'x-api-key|api[_-]?key|apikey|(?:access|refresh|auth|id|session)[_-]?token|token|client[_-]?secret|secret|private[_-]?key|' +
  'password(?:[_-]?hash)?|passwd|authorization|cookie|trpg_sid|密钥|密码|令牌';

/** 浏览器推送的地址（地址本身就是给这台设备发推送的凭证）：谷歌、Mozilla、微软、苹果，主机名留着，后面的路径藏起来。 */
const PUSH_ENDPOINT =
  /(https:\/\/(?:fcm\.googleapis\.com|[a-z0-9.-]{1,100}\.(?:push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com))\/(?:fcm\/send\/|wpush\/v\d\/|w\/)?)[^\s"'<>]+/gi;

const SECRET_PATTERNS: [RegExp, string][] = [
  // Anthropic、DeepSeek、OpenRouter、OpenAI 的密钥：sk-ant-…、sk-or-v1-…、sk-…（task-… 这种单词中间的不算）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, HIDDEN],
  // JWT（浏览器推送的 vapid t=…、别的登录令牌）：三段 base64url 用点连起来，头一段是 eyJ（{" 编出来的样子）
  [/\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, HIDDEN],
  [/(\bvapid\s+t=)[^,\s"']+/gi, `$1${HIDDEN}`],
  // 请求头里的令牌：Bearer …、Basic …
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  [PUSH_ENDPOINT, `$1${HIDDEN}`],
  // 网址里的：?key=…、&token=…
  [/([?&](?:key|api[_-]?key|token|access[_-]?token|sig|signature)=)[^&#\s"']+/gi, `$1${HIDDEN}`],
  // JWK 私钥里的私密部分（浏览器推送的 VAPID 私钥存成 JWK）："d":"…"，打印出来的对象里是 d: '…'
  [/("(?:d|p|q|dp|dq|qi|k)"\s*:\s*")[A-Za-z0-9_-]{16,}(")/g, `$1${HIDDEN}$2`],
  [/(\b(?:d|p|q|dp|dq|qi|k):\s*')[A-Za-z0-9_-]{16,}(')/g, `$1${HIDDEN}$2`],
  // 兑换码、邀请码："code":"…"（只认带引号的 JSON 写法：报错里的 code: 'ECONNRESET' 这种不动）
  [/("(?:code|inviteCode|invite_code|redeemCode|redeem_code)"\s*:\s*")[^"\\]{1,200}(")/g, `$1${HIDDEN}$2`],
  [/(\b(?:inviteCode|invite_code|redeemCode|redeem_code):\s*')[^'\\]{1,200}(')/g, `$1${HIDDEN}$2`],
  [new RegExp(`(${SECRET_NAMES})(["']?\\s*[:=：]\\s*["']?)([^\\s"',;&]+)`, 'gi'), `$1$2${HIDDEN}`],
];

/** 把像 API 密钥、密码、登录凭证的东西换成 [已隐藏]。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 只留前 max 个字（按字算，不会把一个字切成两半）。 */
function cutChars(text: string, max: number): string {
  // 先粗切一刀，免得特别长的内容拆成一个个字太费事
  const rough = text.length > max * 2 ? text.slice(0, max * 2) : text;
  const chars = Array.from(rough);
  return chars.length > max || rough.length < text.length ? `${chars.slice(0, max).join('')}…` : text;
}

// ---------- 文件 ----------

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地日期：20261028。 */
function dayStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 本地时间：2026-10-28 14:03:05。 */
function timeText(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 这一天写进哪个文件。 */
export function errorLogFile(dir: string, at: number): string {
  return path.join(dir, `errors-${dayStamp(new Date(at))}.log`);
}

/** 删掉 14 天以前的日志文件（今天和前 13 天的留着）。删不掉的下次再删。 */
export function pruneErrorLogs(dir: string, now: number) {
  const today = new Date(now);
  const oldest = dayStamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (ERROR_LOG_DAYS - 1)));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const day = /^errors-(\d{8})\.log$/.exec(name)?.[1];
    if (!day || day >= oldest) continue;
    try {
      fs.rmSync(path.join(dir, name));
    } catch {
      // 删不掉（被别的程序打开着）就留着，明天再删
    }
  }
}

function writeToFile(dir: string, at: number, text: string) {
  try {
    const day = dayStamp(new Date(at));
    const file = errorLogFile(dir, at);
    if (day !== prunedDay) {
      fs.mkdirSync(dir, { recursive: true });
      pruneErrorLogs(dir, at);
      prunedDay = day;
      // 换了一天（或者刚装上）：从这一天的文件现在的大小接着算
      try {
        dayBytes = fs.statSync(file).size;
      } catch {
        dayBytes = 0;
      }
      dayFull = false;
    }
    if (dayFull) return;
    const line = `[${timeText(at)}] ${text}\n`;
    const size = Buffer.byteLength(line);
    if (dayBytes + size > bytesPerDay) {
      // 今天写满了：说一句，后面的不再写（窗口里、管理页上照样有），明天接着写
      dayFull = true;
      fs.appendFileSync(file, `[${timeText(at)}] 今天的错误太多了，后面的不再写进这个文件（服务器窗口里照样打印）。\n`);
      return;
    }
    fs.appendFileSync(file, line);
    dayBytes += size;
    warnedWriteFailure = false;
  } catch (err) {
    // 写不进去（硬盘满了、没有权限）：在窗口里说一次就行。这里绝不能再走 console.error，不然会一直记下去
    if (warnedWriteFailure) return;
    warnedWriteFailure = true;
    try {
      (originalError ?? process.stderr.write.bind(process.stderr))(`错误日志写不进 ${dir}：${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // 连窗口都写不了：算了
    }
  }
}

// ---------- 记录和读取 ----------

/**
 * 记一条错误：脱敏以后放进内存里的列表（只留最近 100 条，每条前 2000 个字），装上了的话再写进当天的日志文件。
 * 平常不用直接调用：装上以后 console.error 的内容都会记下来。
 */
export function recordError(text: string, at: number = clock()): ErrorEntry {
  const clean = redactSecrets(text.length > FILE_ERROR_CHARS * 2 ? text.slice(0, FILE_ERROR_CHARS * 2) : text);
  const entry = { at, text: cutChars(clean, RECENT_ERROR_CHARS) };
  recent.push(entry);
  if (recent.length > RECENT_ERRORS_KEPT) recent.splice(0, recent.length - RECENT_ERRORS_KEPT);
  if (logDir) writeToFile(logDir, at, cutChars(clean, FILE_ERROR_CHARS));
  return entry;
}

/** 最近的错误，新的在前（已经脱敏）。 */
export function recentErrors(): ErrorEntry[] {
  return recent.slice().reverse();
}

/** 管理页上的「清空」：只清内存里的列表，日志文件不动。 */
export function clearRecentErrors() {
  recent.length = 0;
}

/** 日志文件夹（没装上是 null）。 */
export function errorLogDir(): string | null {
  return logDir;
}

/**
 * 设定日志文件夹（null 是不写文件）和时钟。installErrorLog 会调用它；测试直接调用它，不动全局的 console。
 * maxBytesPerDay：每天的文件最多写多少（测试用）。
 */
export function setErrorLogDir(dir: string | null, now: () => number = Date.now, maxBytesPerDay = ERROR_LOG_BYTES_PER_DAY) {
  logDir = dir === null ? null : path.resolve(dir);
  clock = now;
  bytesPerDay = maxBytesPerDay;
  prunedDay = '';
  dayBytes = 0;
  dayFull = false;
  warnedWriteFailure = false;
}

/** console.error 收到的参数拼成一段文字（和打印出来的一样，不带颜色）。 */
function formatArgs(args: unknown[]): string {
  return formatWithOptions({ colors: false, depth: 4 }, ...args);
}

/**
 * 正式启动时装上（server/index.ts）：
 * - console.error 照常打印，另外记进日志（文件和内存）；
 * - 没处理到的错误（uncaughtException）：记下来，交给 onFatal（体面地关掉服务器，再以退出码 1 退出，start.bat 会自动重启）；
 * - 没处理到的异步错误（unhandledRejection）：记下来，服务器照常运行。
 * 返回卸下来的函数（测试用）。
 */
export function installErrorLog(options: { dir: string; now?: () => number; onFatal: (err: unknown) => void }): () => void {
  setErrorLogDir(options.dir, options.now);
  const original = console.error;
  originalError = original.bind(console);
  let recording = false;
  console.error = (...args: unknown[]) => {
    original.apply(console, args);
    // 记日志的时候又调用了 console.error（不该发生）：只打印，不再记，免得没完没了
    if (recording) return;
    recording = true;
    try {
      recordError(formatArgs(args));
    } catch {
      // 记日志本身出了问题：不影响打印，也不影响服务器
    } finally {
      recording = false;
    }
  };
  const onUncaught = (err: unknown) => {
    try {
      console.error('服务器出了没处理到的错误，正在关闭（用 start.bat 启动的会自动重启）：', err);
    } catch {
      // 打印不出来也要接着关
    }
    options.onFatal(err);
  };
  const onRejection = (reason: unknown) => {
    try {
      console.error('有一个没处理到的异步错误（服务器照常运行）：', reason);
    } catch {
      // 打印不出来就算了
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    console.error = original;
    originalError = null;
    setErrorLogDir(null);
  };
}
