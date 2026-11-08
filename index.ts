import path from 'node:path';
import { CONFIG_ERROR_EXIT } from '../scripts/supervise.mjs';
import { ClaudeProvider } from './ai/claude';
import { DeepSeekProvider } from './ai/deepseek';
import { demoHandler, FakeProvider } from './ai/fake';
import { OpenRouterProvider } from './ai/openrouter';
import { createApp, type App } from './app';
import { BackupSpaceError } from './backup';
import { betaWipeLines, finishBetaWipe } from './beta-wipe';
import { buildWeb, watchWeb } from './build-web';
import { config } from './config';
import { DataTooNewError } from './db';
import { installErrorLog } from './errorlog';
import { postReleaseNotes } from './release-notes';
import { accountsWithDefaultPassword } from './seed-data';
import { registrationMode, registrationPaused } from './settings';
import { versionLabel } from './version';

const provider =
  config.ai.provider === 'fake'
    ? // 假主持人也停顿一下，像是在思考，方便看清网页上的“正在结算”；收到的请求不留着（测试才用，留着会越积越多）
      Object.assign(new FakeProvider(demoHandler, 1500), { keepRequests: false })
    : new ClaudeProvider({ apiKey: config.ai.apiKey, baseUrl: config.ai.baseUrl, workspaceId: config.ai.workspaceId });
// 假主持人模式下 DeepSeek 的模型也交给假主持人
const deepseek = config.ai.provider === 'fake' ? undefined : new DeepSeekProvider({ apiKey: config.ai.deepseekKey, baseUrl: config.ai.deepseekBaseUrl });
// OpenRouter（或别家兼容 OpenAI 格式的服务）：管理页上填的模型交给它；假主持人模式下也交给假主持人
const openrouter =
  config.ai.provider === 'fake' ? undefined : new OpenRouterProvider({ apiKey: config.ai.openrouterKey, baseUrl: config.ai.openrouterBaseUrl });
// 中转站（V1.0.1）：ChatGPT 的模型交给它（接口地址和密钥都要填）；假主持人模式下也交给假主持人
const relay =
  config.ai.provider === 'fake'
    ? undefined
    : new OpenRouterProvider({ apiKey: config.ai.relayKey, baseUrl: config.ai.relayBaseUrl, baseUrlName: 'RELAY_BASE_URL', label: '中转站', keyName: 'RELAY_API_KEY', kind: 'relay' });

let app: App;

// ---------- V0.8.0：体面地关服务器、错误日志 ----------

/** 关服务器最多等这么久，超过了就强制退出（不能卡住重启）。 */
const CLOSE_TIMEOUT_MS = 10_000;
let stopping: Promise<void> | null = null;

/** 体面地关服务器再退出；调用几次都只关一次。 */
function shutdown(code: number): Promise<void> {
  stopping ??= (async () => {
    const force = setTimeout(() => {
      console.error(`关服务器超过 ${CLOSE_TIMEOUT_MS / 1000} 秒还没关完，强制退出。`);
      process.exit(code);
    }, CLOSE_TIMEOUT_MS);
    try {
      // 还没建好服务器（启动时就出错了）就直接退出
      if (app) await app.close();
    } catch (err) {
      console.error('关服务器时出错：', err);
    }
    clearTimeout(force);
    process.exit(code);
  })();
  return stopping;
}

// Ctrl+C（SIGINT）、SIGTERM；Windows 上关掉黑色窗口是 SIGHUP，Ctrl+Break 是 SIGBREAK。启动到一半时按也是体面地关
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => void shutdown(0));

// 错误日志：窗口里打印的报错另外写进数据库旁边的 logs 文件夹（默认 data/logs，按天分文件，留 14 天），管理页「版本和数据」里也看得到。
// 出了没处理到的错误：记下来，体面地关掉服务器，以退出码 1 退出（start.bat 会自动重启）
installErrorLog({ dir: path.join(path.dirname(path.resolve(config.dbPath)), 'logs'), onFatal: () => void shutdown(1) });

try {
  app = createApp({
    dbPath: config.dbPath,
    webDist: config.webDist,
    scenarioDir: config.scenarioDir,
    dev: config.dev,
    secureCookies: config.secureCookies,
    hstsMaxAge: config.hstsMaxAge,
    siteHosts: config.siteHosts,
    pushSubject: config.pushSubject,
    ai: provider,
    deepseek,
    openrouter,
    relay,
    aiSettings: config.ai.settings,
    timeScale: config.timeScale,
  });
} catch (err) {
  // 数据是更新的版本留下的：说清楚就退出，不打印一大段程序内部的报错。重启也没用：start.bat 看到这个退出码就不重启
  if (err instanceof DataTooNewError) {
    console.error(`\n${err.message}\n`);
    process.exit(CONFIG_ERROR_EXIT);
  }
  // 要升级数据库，升级前的备份因为硬盘空间不够没做成：没升级，也不启动（重启也没用，腾出空间再启动）
  if (err instanceof BackupSpaceError) {
    console.error(`\n这个版本要升级数据库，升级前要先备份一份，可是${err.message}\n`);
    process.exit(CONFIG_ERROR_EXIT);
  }
  throw err;
}

// V1.0.0 正式版的删档：数据库升级时清掉了内测的数据，这里把投稿通过的剧本文件挪进备份，在窗口里说一声（只说一次）
try {
  const wiped = finishBetaWipe(app.db, { scenarioDir: config.scenarioDir, dbPath: config.dbPath });
  if (wiped) for (const line of betaWipeLines(wiped)) console.log(line);
} catch (err) {
  console.error('删档的收尾出错了：', err);
}

// 版本更新公告（V0.8.0 起）：新版本第一次启动时，把这一版改了什么发成全服公告
try {
  const posted = postReleaseNotes(app.db, { now: Date.now() });
  if (posted.length) console.log(`已经在公告里发了更新说明：${posted.map((v) => versionLabel(v)).join('、')}。`);
} catch (err) {
  console.error('发版本更新公告时出错：', err);
}

if (config.dev) {
  await watchWeb(() => app.devReload());
} else {
  // 每次正式启动都重新构建一遍网页（一两秒），保证用的是最新代码，而不是开发模式留下的版本
  console.log('正在构建网页……');
  await buildWeb();
}
// 构建网页的时候按了 Ctrl+C（正在关）：不再接着启动，等它关完退出
if (stopping) await stopping;

try {
  const port = await app.listen(config.port, config.host);
  console.log(`\n龙娘跑团 ${versionLabel()} 已启动：http://localhost:${port}${config.dev ? '（开发模式，改代码会自动刷新）' : ''}`);
  if (config.ai.provider === 'fake') {
    console.log('AI 主持：测试用的假主持人（AI_PROVIDER=fake），不调用任何 AI，不花钱。');
  } else {
    const m = app.ai.models;
    const keys = [config.ai.apiKey && 'Claude', config.ai.deepseekKey && 'DeepSeek', config.ai.openrouterKey && 'OpenRouter', config.ai.relayKey && '中转站'].filter(Boolean);
    console.log(`AI 模型：主持 ${m.dm}，生成剧本 ${m.scenario}，杂活 ${m.misc}，内容检查 ${m.guard}（设置了密钥的：${keys.length ? keys.join('、') : '还没有'}）`);
    // 正在用的模型那一家没设密钥：说清楚哪一家、怎么办
    const missing = [...new Set([m.dm, m.scenario, m.misc, m.guard].map((model) => app.ai.providerFor(model).status))]
      .filter((status) => !status.ready)
      .map((status) => status.message);
    for (const message of new Set(missing)) console.log(`注意：${message}`);
    if (missing.length) console.log('      双击 api-keys.bat（Mac 是 api-keys.command）填上密钥再重新启动，或者站长在「管理」→「AI」里换成有密钥的模型。');
    if (app.ai.switchedOff) console.log('AI 现在是关着的：站长在「管理」→「AI」里打开。');
  }
  if (registrationPaused(app.db)) {
    console.log('注意：现在暂停注册（应急开关）：谁都注册不了，也进不了新游客。站长在「管理」→「注册」里恢复。');
  } else if (registrationMode(app.db) === 'open') {
    console.log('注册：开放注册，不用邀请码也能注册（同一个网络、同一个浏览器 30 天里只送一份初始额度）。');
  }
  if (config.timeScale !== 1) console.log(`测试模式：现实时间快进${config.timeScale}倍（QUICK_WAIT=1），等15分钟变成等15秒。`);
  // 浏览器推送（V0.8.0）的联系方式是 mailto:admin@localhost：苹果的推送服务可能不收
  if (!config.pushSubject && !config.siteHosts.length) {
    console.log('提示：没设 SITE_HOSTS 和 PUSH_SUBJECT，iPhone、iPad、Mac 上的浏览器通知可能收不到。正式上线时在 .env 里设上 SITE_HOSTS（网站的域名），或者 PUSH_SUBJECT（你的邮箱）。');
  }
  // 升级前一个能用的管理员都没有（或者都被封了）：没有站长，网页上没人能任命管理员
  if (!app.db.prepare('SELECT 1 FROM users WHERE is_guest = 0 AND deleted_at IS NULL').get()) {
    console.log('注意：网站还没有账号，谁也注册不了（注册要邀请码）。先关掉服务器，再双击 start.bat（Mac 是 start.command），会问你建站长账号。');
  } else if (!app.db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) {
    console.log('注意：网站还没有站长（最高权限的管理员）。在项目文件夹里运行 npm run make-admin -- 你的用户名，就能把自己设成站长，见 README「重新指定站长」。');
  }
  const open = await accountsWithDefaultPassword(app.db);
  if (open.length) {
    const lan = config.host === '127.0.0.1' || config.host === 'localhost' ? '' : '同一个局域网里的人也能用它们登录（包括管理员）。';
    console.log(`注意：测试账号 ${open.join('、')} 还在用 seed-data.ts 里公开的密码，${lan}给朋友用之前，请改掉这些密码或者删掉这些账号（见 README）。`);
  }
  console.log('按 Ctrl+C 停止。\n');
} catch (err) {
  // 端口用不了：重启也没用，start.bat 看到这个退出码就不重启
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n端口 ${config.port} 被占用了。可以先关掉占用它的程序，或者换个端口，见 README。\n`);
    process.exit(CONFIG_ERROR_EXIT);
  }
  if ((err as NodeJS.ErrnoException).code === 'EACCES') {
    console.error(`\n端口 ${config.port} 用不了（没有权限，或者被系统保留了）。换个端口试试，见 README。\n`);
    process.exit(CONFIG_ERROR_EXIT);
  }
  throw err;
}
