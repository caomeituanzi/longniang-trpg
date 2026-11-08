import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { ClaudeProvider } from './ai/claude';
import { AiClient, type AiSettings, type ModelCatalog } from './ai/client';
import type { AiProvider } from './ai/types';
import { getSessionUser, LOCK_MINUTES, MAX_FAILED_LOGINS, SESSION_COOKIE, sessionAlive } from './auth';
import { cleanupBackupLeftovers, scheduleDailyBackups } from './backup';
import { openDatabase, type DB } from './db';
import { GameEngine } from './game/engine';
import { cleanupGuestsIfDue, GUEST_CLEANUP_HOUR } from './guests';
import { HostTools } from './game/host';
import { ScenarioStudio } from './game/studio';
import type { Rng } from './game/rules';
import { acceptsGzip, cloudflareHttp, HttpError, parseCookies, readJsonBody, Router, sendJson, STREAMING, viaHttps, type Ctx } from './http';
import { clientIp, isLocalRequest, LIMITS, LoginGuard, RateLimiter } from './limits';
import { RealtimeHub } from './realtime';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerGameRoutes } from './routes/game';
import { registerHostRoutes } from './routes/host';
import { registerRoomRoutes, Rooms } from './routes/rooms';
import { registerSocialRoutes } from './routes/social';
import { registerPetRoutes } from './routes/pets';
import { registerEventRoutes } from './routes/events';
import { registerCollectionRoutes } from './routes/collection';
import { registerGuideRoutes } from './routes/guide';
import { registerDebugRoutes } from './routes/debug';
import { registerWorksRoutes } from './routes/works';
import { registerShopRoutes } from './routes/shop';
import { registerCardRoutes } from './routes/cards';
import { registerCard5eRoutes } from './routes/cards5e';
import { Cards5e } from './cards5e';
import { registerScheduleRoutes } from './routes/schedule';
import { registerPushRoutes } from './routes/push';
import { registerAiSeatRoutes } from './routes/ai-seats';
import { registerPersonaRoutes } from './routes/personas';
import { registerHighlightRoutes } from './routes/highlights';
import { registerEditorRoutes } from './routes/editor';
import { registerHealthRoutes } from './routes/health';
import { Cards } from './cards';
import { Groups } from './groups';
import { registerGroupRoutes } from './routes/groups';
import { randomInt } from 'node:crypto';
import { Collection } from './collection';
import { Diary, postcardFor } from './diary';
import { Events } from './events';
import { Guide } from './guide';
import { AiReviewer } from './ai-review';
import { PetPlay } from './pet-play';
import { crystalsOf, Pets, watchCrystals } from './pets';
import { Safety } from './safety';
import { Schedule } from './schedule';
import { Push } from './push';
import { vapidSubject, type PushSender } from './webpush';
import { Shop } from './shop';
import { Social } from './social';
import { Works } from './works';
import { Personas } from './personas';

export type Deps = {
  db: DB;
  hub: RealtimeHub;
  rooms: Rooms;
  engine: GameEngine;
  studio: ScenarioStudio;
  host: HostTools;
  ai: AiClient;
  safety: Safety;
  social: Social;
  /** 剧本大厅：投稿、审核、作者和关注（V0.5.0）。 */
  works: Works;
  /** 宠物和龙晶（V0.5.0）。 */
  pets: Pets;
  /** 限时活动（V0.6.0）。 */
  events: Events;
  /** 结局图鉴和成就（V0.6.0）。 */
  collection: Collection;
  /** 宠物串门（V0.6.0）。 */
  petPlay: PetPlay;
  /** 商城、我的背包、装扮（V0.7.0）。 */
  shop: Shop;
  /** 自带角色卡、装备、宝箱、切磋（V0.7.0）。 */
  cards: Cards;
  /** 5E 角色卡（V0.9.0）。 */
  cards5e: Cards5e;
  /** 群聊（V0.7.0）。 */
  groups: Groups;
  /** 宠物的日记和明信片（V0.6.0）。 */
  diary: Diary;
  /** 网站向导（V0.6.0）。 */
  guide: Guide;
  /** AI 审核：投稿、举报的意见给管理员（V0.6.0）。 */
  reviewer: AiReviewer;
  /** 约团：列时间、勾、定下、开始前提醒（V0.8.0）。 */
  schedule: Schedule;
  /** 浏览器推送：不开着网站也能在电脑、手机上收到通知（V0.8.0）。 */
  push: Push;
  /** AI 大厅：玩家自己做的 AI 角色（V1.1.0）。 */
  personas: Personas;
  /** 限制频率（防撞库、猜对局码、刷屏）。 */
  limiter: RateLimiter;
  /** 登录输错的次数（按账号 + 网络地址）。 */
  loginGuard: LoginGuard;
  now: () => number;
  secureCookies: boolean;
  /** 数据库文件（备份、管理页的「版本和数据」用）。 */
  dbPath: string;
};

export type AppOptions = {
  dbPath: string;
  webDist: string;
  /** 剧本文件夹，默认是项目里的 scenarios。 */
  scenarioDir?: string;
  dev?: boolean;
  secureCookies?: boolean;
  /** 调用AI用的供应商：真的 Claude，或者测试用的假主持人。 */
  ai?: AiProvider;
  /** DeepSeek 的模型走这个（不设：DeepSeek 的模型也交给上面那个，测试用的假主持人就是这样）。 */
  deepseek?: AiProvider;
  /** OpenRouter（或别家兼容 OpenAI 格式的服务）：管理员填的那些模型交给它。 */
  openrouter?: AiProvider & Partial<ModelCatalog>;
  /** 中转站（V1.0.1）：ChatGPT 的模型交给它（不设：交给 ai，测试用的假主持人就是这样）。 */
  relay?: AiProvider;
  aiSettings?: AiSettings;
  /** 下面几项测试用：固定时间、固定骰子、时间快进、不自动检查到期行动。 */
  now?: () => number;
  rng?: Rng;
  /** 宠物用的随机数（远行带回的东西、日记的结尾）：返回 0～n-1。测试用。 */
  petRng?: (n: number) => number;
  /**
   * 隐藏成就（V0.6.0），默认开着。测试默认关掉：它们看几点玩完、玩得多快，以前的测试里龙晶、成就的数字会对不上；
   * 专门测隐藏成就的测试再打开。
   */
  hiddenAchievements?: boolean;
  timeScale?: number;
  tickMs?: number;
  /** 测试用：关掉频率限制（默认开着）。 */
  rateLimits?: boolean;
  /** 每天凌晨 4 点清理不在线的游客账号（默认开着；测试时可以关掉）。 */
  guestCleanup?: boolean;
  /** 每天自动备份（V0.8.0，默认开着；测试默认关掉，专门的测试再打开）。 */
  autoBackup?: boolean;
  /**
   * 只接受这些域名的请求（比如 trpg.example.com）。不设就不限制（在本机、局域网里试的时候）。
   * 正式上线后设上，可以挡住 DNS 重绑定这类借用别的域名访问的攻击。
   */
  siteHosts?: string[];
  /** HSTS 的有效期（秒），.env 里 HSTS_MAX_AGE；0 是不发。默认 180 天。 */
  hstsMaxAge?: number;
  /** 浏览器推送的联系方式（VAPID 的 sub），.env 里 PUSH_SUBJECT；不设就用 siteHosts 的第一个域名。 */
  pushSubject?: string;
  /** 测试用：浏览器推送的发送换成假的（不联网）。 */
  pushSend?: PushSender;
  /** 测试用：回合等你多久以后推（默认 3 分钟）。 */
  pushTurnDelayMs?: number;
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  // 别的网站打开的窗口拿不到这个页面；别的网站不能读这里的资源
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 用不到的浏览器权限一律关掉
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

/** 访问者用 https 来的（或者设了 COOKIE_SECURE=1）：告诉浏览器以后只用 HTTPS 访问这个网站，默认 180 天。 */
export const HSTS_DEFAULT_SECONDS = 15552000;

/** 改动数据的请求方式：要检查请求是不是从本站页面发出的。 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * 跨站请求防护：浏览器发的请求会带上 Sec-Fetch-Site（改动数据的还会带 Origin）。
 * 别的网站发来的、或者从别的网站点链接跳过来的接口请求，就是在借用户的登录做事，一律拒绝（包括 GET：有的 GET 也会留下记录、花额度）。
 * 自己在地址栏输入、收藏夹打开的是 none，放行。没有这些头的（命令行、测试脚本）不是浏览器，放行：它们拿不到用户的登录。
 */
export function crossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  if (!UNSAFE_METHODS.has(req.method ?? 'GET')) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createApp(options: AppOptions) {
  const db = openDatabase(options.dbPath);
  const now = options.now ?? Date.now;
  const limiter = new RateLimiter(now);
  if (options.rateLimits === false) limiter.allow = () => true;
  const siteHosts = new Set((options.siteHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  // 设了域名以后，本机地址照样能用（在这台电脑上打开、隧道程序转过来的请求）
  if (siteHosts.size) for (const local of ['localhost', '127.0.0.1', '[::1]']) siteHosts.add(local);
  let hub: RealtimeHub;
  const rooms = new Rooms(db, () => hub, now);
  hub = new RealtimeHub(
    (roomId, userId, online) => rooms.onPresenceChange(roomId, userId, online),
    // 心跳时检查：这次登录还有效（没被退出、没改密码、没被封）；观看的还有权限看（对局还公开、管理员还有权限）
    (s) => (s.session === null || sessionAlive(db, s.session)) && (!s.watch || s.roomId === null || rooms.canWatch(s.roomId, s.userId)),
  );
  const ai = new AiClient(
    db,
    options.ai ?? new ClaudeProvider({ apiKey: undefined }),
    options.aiSettings,
    now,
    options.deepseek ?? null,
    options.openrouter ?? null,
    options.relay ?? null,
  );
  // OpenRouter 上的模型名字和价格：后台去拿，拿不到也不影响启动；以后每小时再拿一次（价格会变）
  void ai.refreshCatalog();
  const catalogTimer = options.openrouter ? setInterval(() => void ai.refreshCatalog(true), 60 * 60_000) : null;
  catalogTimer?.unref();
  const safety = new Safety(db, ai, now);
  const engine = new GameEngine({
    db,
    hub: () => hub,
    rooms,
    ai,
    safety,
    scenarioDir: options.scenarioDir ?? path.resolve(import.meta.dirname, '..', 'scenarios'),
    now,
    rng: options.rng,
    timeScale: options.timeScale,
    tickMs: options.tickMs,
  });
  rooms.onPresenceChanged = (roomId) => engine.syncRoom(roomId);
  engine.start();
  const studio = new ScenarioStudio({ db, ai, safety, rooms, hub: () => hub, engine, now });
  studio.recover();
  // 封号以后：登录已经删掉了；再断开他的推送（各局里算下线），撤回他还在等的行动。
  // 他不在线也要通知他在的各局：在线情况不再算他，可能从计时转成回合
  const presenceChanged = (userId: number) => {
    for (const r of db.prepare('SELECT room_id FROM players WHERE user_id = ?').all(userId) as { room_id: number }[]) {
      rooms.broadcastPresence(r.room_id);
      engine.syncRoom(r.room_id);
    }
  };
  // 他在的对局冻结起来，等他解封（V0.4.5）
  safety.onBanned = (userId) => {
    hub.closeUser(userId);
    engine.withdrawUserActions(userId);
    engine.freezeRoomsOf(userId);
    presenceChanged(userId);
  };
  // 解封以后（管理员解封、定的时长到了）：冻结的对局解冻；在线情况又要算上他了（他现在不在线：回合模式可能转回计时）
  // 第一次违规：警告他（通知里也留一条，结算时被拒绝的那种他多半不在场）
  safety.onWarned = (userId, message) => social.notify(userId, 'violation_warning', { message });
  safety.onUnbanned = (userId) => {
    engine.unfreezeRoomsOf(userId);
    presenceChanged(userId);
  };
  // 定了时长的封号：每分钟看一次有没有到时间的，到了就解封（服务器关着时到期的，启动时解封）
  const liftBans = () => {
    try {
      safety.liftExpiredBans();
    } catch (err) {
      console.error('解封到期的账号时出错：', err);
    }
  };
  liftBans();
  // 升级前就封着的号（V0.4.5 以前封的，那时还没有冻结）：他在的对局也冻结起来。已经冻结的不重复
  for (const { id } of db.prepare('SELECT id FROM users WHERE banned_at IS NOT NULL AND deleted_at IS NULL').all() as { id: number }[]) {
    engine.freezeRoomsOf(id);
  }
  const banTimer = setInterval(liftBans, 60_000);
  banTimer.unref();
  // 有人被记了账、额度用完了：他不再算回合的参与者，等他的回合可以开始了
  ai.onCharged = (userIds) => engine.creditChanged(userIds);
  const host = new HostTools({ db, rooms, hub: () => hub, engine, ai, now });
  const social = new Social(db, () => hub, now);
  const works = new Works({ db, social, engine, now });
  const petRng = options.petRng ?? ((n: number) => randomInt(n));
  const pets = new Pets({ db, social, now, rng: petRng });
  // V0.7.0：商城；龙晶变了推给这个人开着的页面（顶栏右上角的龙晶数）。等这一轮的事务做完再推（推的是最后的数）
  const shop = new Shop({ db, pets, now });
  const crystalsPending = new Set<number>();
  watchCrystals(db, (userId) => {
    if (crystalsPending.has(userId)) return;
    crystalsPending.add(userId);
    queueMicrotask(() => {
      crystalsPending.delete(userId);
      try {
        hub.toUser(userId, 'crystals', { crystals: crystalsOf(db, userId) });
      } catch {
        // 服务器正在关：不推了
      }
    });
  });
  // V0.6.0：限时活动、结局图鉴和成就、宠物之间的事、日记
  const events = new Events({ db, now });
  const collection = new Collection({
    db,
    social,
    now,
    scenarioEndings: (key) => works.endingsOf(key),
    hallScenarios: () => works.listedScenarios().map((s) => ({ key: s.key, title: s.title })),
    hidden: options.hiddenAchievements ?? true,
  });
  const petPlay = new PetPlay({ db, social, pets, now, rng: petRng });
  // V0.7.0：角色卡、装备、宝箱、切磋；地下城里建角色、扣道具、结算都找它
  const cards = new Cards({ db, social, now, rng: petRng });
  cards.achievements = collection;
  engine.cards = cards;
  // V0.9.0：5E 角色卡；5E 模组里建角色、结束后的结算找它
  const cards5e = new Cards5e({ db, social, now });
  engine.cards5e = cards5e;
  // 商城卖的普通装备记在角色卡那边（gear_items）
  shop.cards = cards;
  const groups = new Groups({ db, social, hub: () => hub, now });
  const diary = new Diary({ db, ai, social, now, rng: petRng });
  const guide = new Guide({ db, ai, safety, now });
  const reviewer = new AiReviewer({ db, ai, now, strikes: (id) => safety.strikes(id) });
  // 审完了：管理页上的意见要更新（管理员开着页面时它会再拉一次）
  reviewer.onFinished = () => social.pushAdminBadges();
  works.reviewer = reviewer;
  pets.hooks = { achievements: collection, events, postcard: postcardFor };
  petPlay.achievements = collection;
  works.collection = collection;
  // 一局走到了结局：玩完的人（交过几个行动）宠物成长、得龙晶；记下结局、给成就、给作者分成、宠物写日记
  engine.onGameFinished = (roomId) => {
    // 地下城（V0.7.0）：带卡进来的人按结局算成长点、带出来的东西、宝箱、通关记录
    try {
      cards.afterRoom(roomId);
    } catch (err) {
      console.error('地下城结算时出错：', err);
    }
    // 5E 模组（V0.9.0）：带 5E 卡进来的人，活着回来的挣到一级、带走身上的东西
    try {
      cards5e.afterRoom(roomId);
    } catch (err) {
      console.error('5E 模组结算时出错：', err);
    }
    try {
      const game = pets.growFromGame(roomId);
      if (!game) return;
      collection.afterGame(game);
      works.recordFinish(game);
      works.authorReward(game);
      diary.afterGame(game);
    } catch (err) {
      console.error('玩完剧本以后算成长、结局和成就时出错：', err);
    }
  };
  engine.onResolved = (rolls) => collection.afterResolution(rolls);
  // 宠物打工到点了：发工钱、发通知。每分钟看一次（有人打开宠物页时也会结算）
  const petTimer = setInterval(() => {
    try {
      pets.sweepJobs();
    } catch (err) {
      console.error('结算宠物打工时出错：', err);
    }
  }, 60_000);
  petTimer.unref();
  // 对局开始了：告诉没开着这一局的成员
  engine.onGameStarted = (roomId, by, actorId) => social.notifyRoomStarted(roomId, by, actorId);
  // V0.8.0：约团（开始前 30 分钟的提醒在下面路由都登记好以后才开始查）
  const schedule = new Schedule({ db, hub: () => hub, social, now });
  // V0.8.0：浏览器推送：通知（开着网站的人不推）、私信、回合模式下就等你时，推到不开着网站的人的电脑、手机上
  const push = new Push({
    db,
    now,
    subject: vapidSubject(options.pushSubject, options.siteHosts),
    roundWaitingFor: (roomId) => engine.roundWaitingFor(roomId),
    send: options.pushSend,
    turnDelayMs: options.pushTurnDelayMs,
  });
  social.onNotified = (userId, view) => push.notified(userId, view);
  engine.onRoundWaiting = (roomId, userIds) => push.roundWaiting(roomId, userIds);

  // 游客账号每天凌晨 4 点清理一次；那时候服务器没开着的话，启动时补做。每 10 分钟看一次到没到点
  let guestTimer: NodeJS.Timeout | null = null;
  if (options.guestCleanup !== false) {
    const cleanGuests = () => {
      try {
        const removed = cleanupGuestsIfDue(db, hub.connectedUserIds(), now());
        if (removed) console.log(`清理了 ${removed} 个不在线的游客账号（每天凌晨 ${GUEST_CLEANUP_HOUR} 点自动清理）。`);
      } catch (err) {
        console.error('清理游客账号时出错：', err);
      }
    };
    cleanGuests();
    guestTimer = setInterval(cleanGuests, 10 * 60_000);
    guestTimer.unref();
  }
  // V0.8.0：上次备份写到一半（断电、被强行结束）留下的临时文件，启动时清掉
  cleanupBackupLeftovers(options.dbPath);
  // V0.8.0：每天自动备份（启动 2 分钟后看一次，以后每小时看一次；最近一份是 23 小时以前的就备份）
  const stopDailyBackups = options.autoBackup === false ? () => {} : scheduleDailyBackups(db, options.dbPath, now);
  const deps: Deps = {
    db,
    hub,
    rooms,
    engine,
    studio,
    host,
    ai,
    safety,
    social,
    works,
    pets,
    events,
    collection,
    petPlay,
    shop,
    cards,
    cards5e,
    groups,
    diary,
    guide,
    reviewer,
    schedule,
    push,
    personas: new Personas(db, now),
    limiter,
    loginGuard: new LoginGuard(MAX_FAILED_LOGINS, LOCK_MINUTES * 60_000, now),
    now,
    secureCookies: options.secureCookies ?? false,
    dbPath: options.dbPath,
  };

  const router = new Router();
  registerAuthRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerRoomRoutes(router, deps);
  registerGameRoutes(router, deps);
  registerHostRoutes(router, deps);
  registerSocialRoutes(router, deps);
  registerWorksRoutes(router, deps);
  registerPetRoutes(router, deps);
  registerShopRoutes(router, deps);
  registerCardRoutes(router, deps);
  registerCard5eRoutes(router, deps);
  registerGroupRoutes(router, deps);
  registerEventRoutes(router, deps);
  registerCollectionRoutes(router, deps);
  registerGuideRoutes(router, deps);
  registerDebugRoutes(router, deps);
  // V0.8.0
  registerScheduleRoutes(router, deps);
  registerPushRoutes(router, deps);
  registerAiSeatRoutes(router, deps);
  registerPersonaRoutes(router, deps);
  registerHighlightRoutes(router, deps);
  registerEditorRoutes(router, deps);
  registerHealthRoutes(router, deps);
  // 约团的提醒：开起来先补发一次（关着的时候到了提醒的点、还没开始的），以后每分钟看一次。
  // 放在各个模块都建好、接好以后（浏览器推送要接在通知上，补发的提醒也要推出去）
  schedule.start();

  /** 记下每个人最近一次在线的时间：同一个人一分钟最多写一次数据库。 */
  const lastSeenWritten = new Map<number, number>();
  function touch(userId: number) {
    const at = now();
    if (at - (lastSeenWritten.get(userId) ?? 0) < 60_000) return;
    // 记得太多了（游客账号一直在换新的）：一分钟以前的反正不挡着写，清掉（V0.8.0）
    if (lastSeenWritten.size >= 10_000) for (const [id, t] of lastSeenWritten) if (at - t >= 60_000) lastSeenWritten.delete(id);
    lastSeenWritten.set(userId, at);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, userId);
  }

  const devReloadClients = new Set<ServerResponse>();

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (crossSite(req)) return sendJson(res, 403, { error: '请求来源不对：请在本站的页面里操作' });
    // 所有接口加起来的频率限制：在这台电脑上打开的（自己测试、开好几个窗口）不算
    if (!isLocalRequest(req) && !limiter.allow(`api:${clientIp(req)}`, LIMITS.api.max, LIMITS.api.windowMs)) {
      return sendJson(res, 429, { error: LIMITS.api.message });
    }
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (match === null) return sendJson(res, 404, { error: '没有这个接口' });
    if (match === 'wrong-method') return sendJson(res, 405, { error: '请求方式不对' });

    const cookies = parseCookies(req.headers.cookie);
    const ctx: Ctx = {
      req,
      res,
      url,
      params: match.params,
      cookies,
      body: undefined,
      user: getSessionUser(db, cookies[SESSION_COOKIE]),
      status: 200,
      setCookies: [],
    };
    try {
      if (ctx.user) touch(ctx.user.id);
      ctx.body = await readJsonBody(req, match.bodyLimit);
      const result = await match.handler(ctx);
      if (result === STREAMING) return;
      sendJson(res, ctx.status, result ?? { ok: true }, ctx.setCookies, acceptsGzip(req));
    } catch (err) {
      // 对方没发完就断开了（关了页面、网络断了）：不是服务器出错，不记进错误日志，也没法回了（V0.8.0）
      if (!req.complete && (err as NodeJS.ErrnoException)?.code === 'ECONNRESET') {
        res.destroy();
        return;
      }
      if (res.headersSent) {
        res.end();
      } else if (err instanceof HttpError) {
        // 内容太长、没读完就回了的：回完关掉这条连接（浏览器接着用这条连接发下一个请求会出错）
        if (!req.complete) res.setHeader('Connection', 'close');
        sendJson(res, err.status, { error: err.message }, ctx.setCookies);
      } else {
        console.error(err);
        sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
      }
    }
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let filePath: string | null = null;
    let decoded = '/';
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      decoded = '/';
    }
    // /.env、/.git/HEAD 这类以点开头的路径：一律说没有（不交给前端路由返回首页，免得看起来像是有这个文件）
    if (decoded.split('/').some((segment) => segment.startsWith('.'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没有这个文件');
      return;
    }
    const indexFile = path.join(options.webDist, 'index.html');
    if (!fs.existsSync(indexFile)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('网页还在构建，过几秒刷新一下。如果一直是这个提示，看看运行服务器的窗口里有没有报错。');
      return;
    }
    if (path.extname(decoded)) {
      const candidate = path.resolve(options.webDist, '.' + decoded);
      if (candidate.startsWith(options.webDist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('没有这个文件');
        return;
      }
    }

    // 没有扩展名的路径都交给前端路由处理
    const file = filePath ?? indexFile;
    const isAsset = file.startsWith(path.join(options.webDist, 'assets') + path.sep);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': isAsset && !options.dev ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // 读文件出错（刚好被删掉、被杀毒软件锁着）：断开这一个请求就行，不能让没人接的错误把整个服务器弄停（V0.8.0）
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.error(`读网页文件 ${file} 时出错：`, err);
      res.destroy();
    });
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const hsts = options.hstsMaxAge ?? HSTS_DEFAULT_SECONDS;
    if (hsts > 0 && (options.secureCookies || viaHttps(req))) res.setHeader('Strict-Transport-Security', `max-age=${hsts}`);
    // 设了网站域名以后，别的域名来的请求不处理
    if (siteHosts.size && !siteHosts.has((req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase())) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' }).end('这个地址不对');
      return;
    }
    // 从 Cloudflare 转过来、访问者用的是 http:// 的：跳到 https://（登录密码和 Cookie 不走明文）。
    // 在 Cloudflare 里打开「Always Use HTTPS」以后，在 Cloudflare 那边就跳走了，到不了这里
    if (cloudflareHttp(req) && req.headers.host) {
      res.writeHead(308, { Location: `https://${req.headers.host}${req.url ?? '/'}`, 'Content-Type': 'text/plain; charset=utf-8' }).end('请用 https:// 访问');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // 处理之前就出了错（比如查登录时数据库出错）：回一个 500，不让它变成没人接的错误（V0.8.0）
      handleApi(req, res, url).catch((err) => {
        console.error(err);
        if (res.headersSent) res.end();
        else sendJson(res, 500, { error: '服务器出错了，请稍后再试' });
      });
      return;
    }
    if (options.dev && url.pathname === '/__dev/reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': dev reload\n\n');
      devReloadClients.add(res);
      res.on('close', () => devReloadClients.delete(res));
      return;
    }
    try {
      serveStatic(req, res, url);
    } catch (err) {
      // 查文件时出错（被杀毒软件锁着、没有权限）：这一个请求回 500，服务器照常运行（V0.8.0）
      console.error(err);
      if (res.headersSent) res.destroy();
      else res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('服务器出错了，请稍后再试');
    }
  });

  // 慢速攻击防护：请求头 20 秒、整个请求 30 秒内没发完就断开（推送连接是响应慢慢发，不受影响）
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 100;

  return closeOnce({
    server,
    router,
    db,
    hub,
    engine,
    studio,
    ai,
    safety,
    pets,
    events,
    collection,
    petPlay,
    shop,
    cards,
    cards5e,
    groups,
    diary,
    guide,
    reviewer,
    works,
    /** 约团（V0.8.0；测试里直接调用 schedule.sweepReminders()）。 */
    schedule,
    /** 浏览器推送（V0.8.0；测试里直接调用 push.checkTurns()、push.idle()）。 */
    push,
    /** 通知、好友（测试里直接调用 social.notify）。 */
    social,
    /** AI 大厅（V1.1.0）。 */
    personas: deps.personas,
    /** 开发模式下网页重新构建后，通知已打开的页面自动刷新。 */
    devReload() {
      for (const client of devReloadClients) client.write('event: reload\ndata: {}\n\n');
    },
    listen(port: number, host: string): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          // 开起来以后的出错（比如一下子连进来太多、打开的文件太多）：记下来，服务器照常运行（V0.8.0）
          server.on('error', (err) => console.error('网站服务出错（服务器照常运行）：', err));
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    async close() {
      clearInterval(banTimer);
      clearInterval(petTimer);
      schedule.stop();
      push.stop();
      if (guestTimer) clearInterval(guestTimer);
      if (catalogTimer) clearInterval(catalogTimer);
      stopDailyBackups();
      await studio.stop();
      await engine.stop();
      diary.stop();
      await diary.idle();
      reviewer.stop();
      await reviewer.idle();
      rooms.stop();
      limiter.stop();
      hub.closeAll();
      for (const client of devReloadClients) client.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 正在发的浏览器推送已经取消了，等它们收完尾
      await push.idle();
      db.close();
    },
  });
}

/**
 * close() 可以调用好几次（V0.8.0）：第二次起不再关一遍，等第一次关完
 * （按了 Ctrl+C 正在关的时候又出了没处理到的错误，会再调用一次；关第二遍会因为数据库已经关了而出错）。
 */
function closeOnce<T extends { close: () => Promise<void> }>(app: T): T {
  const close = app.close;
  let closing: Promise<void> | null = null;
  (app as { close: () => Promise<void> }).close = () => (closing ??= close.call(app));
  return app;
}

export type App = ReturnType<typeof createApp>;
