import crypto from 'node:crypto';
import { transaction, type DB } from './db';
import { asObject, HttpError } from './http';
import { getSetting, setSetting } from './settings';
import { safeJson, type NotificationView } from './social';
import {
  DEFAULT_PUSH_PREFS,
  PUSH_CATEGORIES,
  PUSH_MAX_DEVICES,
  type PushCategory,
  type PushDevice,
  type PushInfo,
  type PushPrefs,
} from '../shared/push';
import {
  encryptPayload,
  ENDPOINT_MAX,
  fetchSender,
  generateVapid,
  isApplePush,
  loadVapid,
  pushServiceHost,
  vapidAuthorization,
  type PushSender,
  type VapidKeys,
} from './webpush';

// 浏览器推送（V0.8.0）：玩家不开着网页也能在电脑、手机上收到系统通知。
// - 订阅：每个浏览器一条（push_subscriptions），每人最多 10 台；同一个浏览器换了账号就归新账号。
//   订阅跟着订阅时的那次登录：退出登录、改密码、「退出其他设备」、封号以后那台设备不再收，登录过期的也不发（重新登录后网页再交一次就接上）。
// - 推什么：通知（Social.notify 的钩子，按他勾的类别）、私信（只说谁发来的，不带内容；同一个人 2 分钟里只推一次）、
//   回合模式下别人都交了、就等你（等 3 分钟还在等才推）。开着网站也推：家里电脑开着网页，出门的手机照样收得到；
//   哪台设备上本站的页面正在前台、有焦点，那台的 sw.js 就不弹（快开团的提醒、苹果的推送照样弹）。
// - 发送不拖慢请求：排队，最多同时发 4 条，出错只记一行日志。推送服务说这个订阅没了（404/410）就删掉它。

/** 服务器的 VAPID 密钥存在设置里的键。 */
export const VAPID_SETTING = 'push_vapid';
/** 推给浏览器的内容（JSON）最多多少字节。 */
export const PUSH_PAYLOAD_MAX = 3000;
/** 点了以后去的站内路径最长多少字（都是程序自己拼的，正常很短）。 */
const PUSH_URL_MAX = 300;
/** 回合模式下等你交行动：这么久以后还在等你，才推「就等你了」。 */
export const TURN_DELAY_MS = 3 * 60_000;
/** 「发一条试试」：每人这么久最多一次。 */
export const TEST_INTERVAL_MS = 30_000;
/** 一次最多同时发几条。 */
const CONCURRENCY = 4;
/** 全站最多排多少条（推送服务一直不回应时，队伍不能越排越长）。 */
const QUEUE_MAX = 2000;
/** 每个账号最多排多少条：一个人的推送堵住了（他的设备在不回应的推送服务上、有人狂发），不挤掉别人的。快开团的提醒不算。 */
export const QUEUE_PER_USER = 20;
/** 推送服务多久没回应算失败。 */
export const SEND_TIMEOUT_MS = 5_000;
/** 签好的 VAPID（12 小时有效）用多久换一次。 */
const JWT_REUSE_MS = 6 * 3600_000;
/** 记着的签名最多几条（每个推送服务一条，正常只有几条）。 */
export const JWT_CACHE_MAX = 50;
/** 同一个人发来的私信，这么久里只推一次（好友不能一直让你的手机响）。 */
export const DM_PUSH_INTERVAL_MS = 2 * 60_000;
const HOUR_SECONDS = 3600;

/**
 * 还能发的订阅（表的别名是 s）：订阅时的那次登录还在、没过期。退出登录、改密码、「退出其他设备」、封号删掉了登录，
 * 订阅跟着删掉了；过期的登录还留在表里，这里挡住。参数：现在的时间（和 auth.ts 一样，登录的有效期按真的时间算）。
 */
const ACTIVE = 'JOIN sessions se ON se.id = s.session_id AND se.expires_at > ?';

/** 每种通知归哪一类。约团的几种由约团那边加进 NotificationKind，这里按名字认；没列出来的都是「其他通知」。 */
const CATEGORY_OF: Record<string, PushCategory> = {
  schedule_poll: 'schedule',
  schedule_confirmed: 'schedule',
  schedule_cancelled: 'schedule',
  schedule_reminder: 'schedule',
  room_started: 'started',
  room_invite: 'invites',
  join_request: 'invites',
  join_result: 'invites',
  friend_request: 'invites',
  group_added: 'invites',
};

/**
 * 推给浏览器的内容（sw.js 读）：url 是点了以后去的站内路径；tag 一样的通知后来的替换前面的（不再响）；
 * startsAt：约团的开始时间，sw.js 按手机的本地时间换掉 body 里的 {time}（服务器不知道对方在哪个时区）；
 * always：页面开在前台也要弹（快开团的提醒、发一条试试）；renotify：替换前面的时候照样响（只给快开团、轮到你这类要紧的）。
 */
export type PushMessage = { title: string; body: string; url: string; tag: string; startsAt?: number; always?: boolean; renotify?: boolean };

/** 要发的一条：内容，加上推送服务替我们留多久（秒）、急不急。 */
type Outgoing = PushMessage & { ttl: number; urgency: 'normal' | 'high' };

type SubRow = { id: number; endpoint: string; p256dh: string; auth: string };
type Job = { userId: number; sub: SubRow; message: Outgoing };
type TurnCheck = { roomId: number; round: number; userId: number; due: number };

export type PushOptions = {
  db: DB;
  now: () => number;
  /** VAPID 的 sub（联系方式，见 webpush.ts 的 vapidSubject）。 */
  subject: string;
  /** 这一局现在这一轮还在等谁交行动（引擎的 roundWaitingFor）；不在等是 null。 */
  roundWaitingFor?: (roomId: number) => { round: number; userIds: number[] } | null;
  /** 发出去的办法（默认用 fetch；测试换成假的，不联网）。 */
  send?: PushSender;
  /** 回合等你多久以后推（默认 3 分钟，测试可以改）。 */
  turnDelayMs?: number;
};

/** 按字（不是字节）截短，太长的后面加省略号。 */
function clip(value: unknown, max: number): string {
  const chars = [...(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** 通知里存的发起人（UserBrief，切磋的是名字）的显示名。 */
function nameOf(from: unknown): string {
  const name = typeof from === 'string' ? from : (from as { displayName?: unknown } | null | undefined)?.displayName;
  return clip(name, 20) || '有人';
}

/** 从浏览器标识粗略认出设备：「Windows · Chrome」「iPhone · Safari」「Android · Chrome」，认不出是「浏览器」。 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512);
  const os = /iPhone|iPod/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Macintosh|Mac OS X/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  let browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? '三星浏览器'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /CriOS\/|Chrome\/|Chromium\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  // 从主屏幕打开的网页（iPhone、iPad）不带浏览器的名字，用的是 Safari
  if (!browser && (os === 'iPhone' || os === 'iPad') && /AppleWebKit/.test(ua)) browser = 'Safari';
  if (os && browser) return `${os} · ${browser}`;
  return os || browser || '浏览器';
}

/** 浏览器给的 base64url（也认普通 base64）解出来，长度对才要。 */
function decodeKey(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length === bytes ? buf : null;
}

/** 浏览器的公钥是不是 P-256 曲线上的点（不是的话加密时才出错，订阅时就拒绝）。 */
function validPoint(point: Buffer): boolean {
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

/** 一种通知推出去写什么、点了去哪。文字短，不带隐私（私信、行动的内容，举报的回复这些都不带）。 */
export function messageFor(view: Pick<NotificationView, 'id' | 'kind' | 'data'>, now: number): Outgoing {
  const d = view.data;
  const kind = view.kind as string;
  const roomId = Number(d.roomId);
  const hasRoom = Number.isInteger(roomId) && roomId > 0;
  const roomUrl = hasRoom ? `/room/${roomId}` : '/notifications';
  const room = clip(d.roomName, 30) || '对局';
  const who = nameOf(d.from);
  const title = clip(d.title, 30);
  const startsAt = typeof d.startsAt === 'number' && Number.isFinite(d.startsAt) ? d.startsAt : undefined;
  const base = { ttl: 12 * HOUR_SECONDS, urgency: 'normal' as const, tag: `n-${view.id}`, url: '/notifications', title: '龙娘跑团' };
  /** 同一局的同一件事用同一个 tag：后来的替换前面的（没有对局编号的各自一条）。 */
  const roomTag = (what: string) => (hasRoom ? `${what}-${roomId}` : base.tag);
  switch (kind) {
    case 'schedule_poll': {
      const count = Number(d.count);
      const fromHost = d.from ? `${who}在` : '';
      const many = Number.isInteger(count) && count > 0 ? ` ${count} 个` : '';
      // 点开直接打开约团（对局页认 ?schedule）
      return { ...base, title: '约团', body: `${fromHost}「${room}」列了${many}候选时间`, url: hasRoom ? `${roomUrl}?schedule` : roomUrl, tag: roomTag('schedule') };
    }
    case 'schedule_confirmed':
      return { ...base, title: '定好时间了', body: startsAt ? `「${room}」{time} 开始` : `「${room}」定好了时间`, url: roomUrl, tag: roomTag('schedule'), startsAt };
    case 'schedule_cancelled':
      return { ...base, title: '约团取消了', body: `「${room}」定好的时间取消了`, url: roomUrl, tag: roomTag('schedule') };
    case 'schedule_reminder': {
      // 推送服务替我们留到开始的时候（至少一分钟、最多一小时）
      const left = startsAt === undefined ? HOUR_SECONDS : Math.round((startsAt - now) / 1000);
      return {
        ...base,
        title: '快开团了',
        body: startsAt ? `「${room}」{time} 开始` : `「${room}」快开始了`,
        url: roomUrl,
        tag: roomTag('schedule'),
        startsAt,
        ttl: Math.min(HOUR_SECONDS, Math.max(60, left)),
        urgency: 'high',
        renotify: true,
      };
    }
    case 'room_started':
      return { ...base, title: '对局开始了', body: `「${room}」开始了`, url: roomUrl, tag: roomTag('room') };
    case 'room_invite':
      // 还不是成员，打不开对局页：去通知页点「加入」
      return { ...base, title: '对局邀请', body: `${who}邀请你加入「${room}」`, tag: roomTag('invite') };
    case 'join_request':
      return { ...base, title: '加入申请', body: `${who}申请加入「${room}」`, url: roomUrl };
    case 'join_result':
      return d.approved
        ? { ...base, title: '加入申请', body: `${clip(d.by, 20) || '房主'}同意了你加入「${room}」`, url: roomUrl, tag: roomTag('room') }
        : { ...base, title: '加入申请', body: `${clip(d.by, 20) || '房主'}没有同意你加入「${room}」` };
    case 'friend_request':
      return { ...base, title: '好友申请', body: `${who}想加你好友`, url: '/friends' };
    case 'friend_accepted':
      return { ...base, body: `${who}同意了你的好友申请`, url: '/friends' };
    case 'group_added': {
      const groupId = Number(d.groupId);
      return { ...base, title: '群聊', body: `${who}把你拉进了群「${clip(d.name, 20)}」`, url: Number.isInteger(groupId) && groupId > 0 ? `/friends/g/${groupId}` : '/friends' };
    }
    case 'violation_warning':
      return { ...base, body: '你收到了一条警告' };
    case 'report_reply':
      return { ...base, body: '你提交的反馈有了结果' };
    case 'new_report':
      return { ...base, body: '有新的举报或反馈' };
    case 'submission_result':
      return { ...base, body: d.approved ? `你投稿的《${title}》通过了审核` : `你投稿的《${title}》没有通过审核` };
    case 'new_work':
      return { ...base, body: `${who}有新作品《${title}》` };
    case 'pet_job_done':
      return { ...base, body: `${clip(d.pet, 20) || '宠物'}打工回来了` };
    case 'pet_trip_done':
      return { ...base, body: `${clip(d.pet, 20) || '宠物'}远行回来了` };
    case 'pet_diary':
      return { ...base, body: `${clip(d.pet, 20) || '宠物'}写了一篇日记` };
    case 'pet_visit':
      return { ...base, body: `${who}来看你的宠物了` };
    case 'achievement':
      return { ...base, body: `达成成就「${title}」` };
    case 'author_reward':
      return { ...base, body: `有人玩完了你写的《${title}》` };
    case 'work_review':
      return { ...base, body: `${who}给《${title}》写了短评` };
    case 'work_feedback':
      return { ...base, body: `${who}给《${title}》写了反馈` };
    case 'feedback_reply':
      return { ...base, body: `${who}回复了你的反馈` };
    case 'card_growth':
      return { ...base, body: `「${clip(d.card, 20) || '角色卡'}」回来了` };
    case 'card5e_done':
      return { ...base, body: d.levelUp ? `「${clip(d.card, 20) || '5E 角色'}」可以升级了` : `「${clip(d.card, 20) || '5E 角色'}」打完了《${clip(d.title, 30)}》` };
    case 'chest':
      return { ...base, body: '得到了一个宝箱' };
    case 'legendary':
      return { ...base, body: `拿到了传奇装备「${clip(d.name, 20)}」` };
    case 'duel':
      return { ...base, body: `${who}和你的「${clip(d.card, 20)}」切磋了一场` };
    case 'item_grant':
      return { ...base, body: `管理员发给你：${clip(d.item, 20) || '东西'}` };
    default:
      return { ...base, body: '有一条新通知' };
  }
}

/** 推给浏览器的 JSON：不超过 PUSH_PAYLOAD_MAX 字节（太长就截短正文）。 */
export function encodeMessage(message: PushMessage): string {
  // 地址是站内路径，正常都很短；太长的（不该有）换成通知页
  const url = typeof message.url === 'string' && message.url.length <= PUSH_URL_MAX ? message.url : '/notifications';
  const make = (body: string, fallback = false) => {
    const payload: PushMessage = fallback
      ? { title: '龙娘跑团', body, url: '/notifications', tag: '' }
      : { title: clip(message.title, 40) || '龙娘跑团', body, url, tag: clip(message.tag, 64) };
    if (message.startsAt !== undefined) payload.startsAt = message.startsAt;
    if (message.always) payload.always = true;
    if (message.renotify) payload.renotify = true;
    return JSON.stringify(payload);
  };
  let chars = [...clip(message.body, 200)];
  let text = make(chars.join(''));
  // 太长：正文每次砍掉一半（字数一定变少，一定会停），砍光了还长就只留最简单的一条
  while (Buffer.byteLength(text) > PUSH_PAYLOAD_MAX && chars.length) {
    chars = chars.slice(0, Math.floor(chars.length / 2));
    text = make(chars.length ? `${chars.join('')}…` : '');
  }
  return Buffer.byteLength(text) <= PUSH_PAYLOAD_MAX ? text : make('', true);
}

/**
 * 写进日志之前藏掉推送相关的秘密：网址只留主机名（推送地址的路径里是这台设备的令牌）、VAPID 签名（vapid t=… 和
 * 像 JWT 的三段式字符串）、像密钥的长串（浏览器的 p256dh、auth）。
 */
export function scrubPushSecrets(text: string): string {
  return text
    .replace(/\b(https?):\/\/([^\s/?#'"<>]+)[^\s'"<>]*/gi, '$1://$2/…')
    .replace(/vapid\s+t=[^\s,'"]+/gi, 'vapid t=[已隐藏]')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[已隐藏]')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '[已隐藏]');
}

/** 自己这边出的错（数据库被锁住之类）写成一行：只要说明，不要调用栈，藏掉推送地址和签名。 */
function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return clip(scrubPushSecrets(text.slice(0, 2000)), 200) || '出错了';
}

/** 没发出去的原因（一行）：网络错误写错误的种类（ECONNREFUSED 这种）；别的写说明（推送地址换成主机名，日志里不留完整的地址和签名）。 */
function describeError(err: unknown, endpoint: string, host: string): string {
  const e = err as { name?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  if (e?.name === 'TimeoutError') return `${SEND_TIMEOUT_MS / 1000} 秒没有回应`;
  if (e?.cause?.code) return e.cause.code;
  const why = e?.cause?.message ? `${oneLine(err)}：${oneLine(e.cause.message)}` : oneLine(err);
  return why.split(endpoint).join(host);
}

/** 推送地址的哈希（SHA-256，base64url）：网页问「这台设备是哪一台」时只传它，推送地址不进网址、不进访问日志。 */
export function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint, 'utf8').digest('base64url');
}

export class Push {
  private readonly db: DB;
  private readonly send: PushSender;
  private vapidKeys: VapidKeys | null = null;
  private readonly jwts = new Map<string, { header: string; at: number }>();
  private readonly queue: Job[] = [];
  /** 快开团的提醒、发一条试试（always 的）：先发，也不受每个账号的上限。 */
  private readonly urgent: Job[] = [];
  /** 每个账号排着的条数（只算 queue 里的）。 */
  private readonly queuedBy = new Map<number, number>();
  /** 已经因为排满记过日志的账号（排空了再记）。 */
  private readonly fullLogged = new Set<number>();
  private active = 0;
  private queueFullLogged = false;
  /** 私信：每个人（收信人:发信人）上一次推的时间。 */
  private readonly dmPushed = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private stopped = false;
  /** 回合等你：到时候再看一次的（键：对局:轮次:账号）。 */
  private readonly turnChecks = new Map<string, TurnCheck>();
  /** 回合等你：推过的（同一局同一轮同一个人只推一次），留一天。 */
  private readonly turnSent = new Map<string, number>();
  private turnTimer: NodeJS.Timeout | null = null;
  /** 「发一条试试」上一次的时间。 */
  private readonly lastTest = new Map<number, number>();
  turnDelayMs: number;

  constructor(private readonly opts: PushOptions) {
    this.db = opts.db;
    this.send = opts.send ?? fetchSender;
    this.turnDelayMs = opts.turnDelayMs ?? TURN_DELAY_MS;
  }

  // ==================== 服务器的密钥 ====================

  /** 第一次用到时生成，存进设置；以后一直用这一对（换了的话，以前的订阅都要重新打开）。 */
  private vapid(): VapidKeys {
    if (this.vapidKeys) return this.vapidKeys;
    const raw = getSetting(this.db, VAPID_SETTING);
    if (raw) {
      try {
        this.vapidKeys = loadVapid(JSON.parse(raw));
        return this.vapidKeys;
      } catch {
        // 坏了（手改过设置）：换一对新的；用旧的建的订阅推送服务不认了，删掉，大家重新打开
        console.error('浏览器推送：设置里存的服务器密钥坏了，换了一对新的，以前打开的通知要在账号设置里重新打开');
        this.db.prepare('DELETE FROM push_subscriptions').run();
      }
    }
    const fresh = generateVapid();
    setSetting(this.db, VAPID_SETTING, JSON.stringify(fresh));
    this.vapidKeys = loadVapid(fresh);
    return this.vapidKeys;
  }

  /** 给浏览器订阅用的公钥（65 字节未压缩点的 base64url）。 */
  publicKey(): string {
    return this.vapid().publicKey;
  }

  /** Authorization 请求头（同一个推送服务 6 小时里用同一个签名）。 */
  private authorization(endpoint: string): string {
    const audience = new URL(endpoint).origin;
    const now = this.opts.now();
    const cached = this.jwts.get(audience);
    if (cached && now >= cached.at && now - cached.at < JWT_REUSE_MS) return cached.header;
    const header = vapidAuthorization(this.vapid(), audience, this.opts.subject, now);
    // 过了换签名时间的不要了；还是太多（推送服务的主机很多）：去掉最早记的
    for (const [key, entry] of this.jwts) if (now < entry.at || now - entry.at >= JWT_REUSE_MS) this.jwts.delete(key);
    this.jwts.delete(audience);
    while (this.jwts.size >= JWT_CACHE_MAX) this.jwts.delete(this.jwts.keys().next().value!);
    this.jwts.set(audience, { header, at: now });
    return header;
  }

  // ==================== 订阅和设备 ====================

  /**
   * 这台设备打开通知：{ endpoint, keys: { p256dh, auth } }。session 是这次请求的登录（数据库里的会话编号）：订阅跟着它，
   * 登录没了订阅也没了。同一个浏览器已经订阅过（哪怕是别的账号、以前的登录）就换成这个账号、这次登录的；网页每次打开都会再交一次。
   */
  subscribe(userId: number, session: string, input: unknown, userAgent: string | undefined): PushDevice {
    const body = asObject(input);
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint || endpoint.length > ENDPOINT_MAX) throw new HttpError(400, '推送地址不对');
    if (!pushServiceHost(endpoint)) throw new HttpError(400, '这个浏览器的推送服务用不了');
    const keys = body.keys && typeof body.keys === 'object' && !Array.isArray(body.keys) ? (body.keys as Record<string, unknown>) : {};
    const p256dh = decodeKey(keys.p256dh, 65);
    const auth = decodeKey(keys.auth, 16);
    if (!p256dh || !auth || !validPoint(p256dh)) throw new HttpError(400, '浏览器给的推送密钥不对，换个浏览器试试');
    const at = this.opts.now();
    const label = deviceLabel(userAgent);
    const keyText = { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
    // 这个地址已经在别的账号上：只有同一个浏览器（密钥一样）换了账号才换过来；光知道推送地址的人抢不走别人的设备
    const existing = this.db.prepare('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      | { user_id: number; p256dh: string; auth: string }
      | undefined;
    if (existing && existing.user_id !== userId && (existing.p256dh !== keyText.p256dh || existing.auth !== keyText.auth)) {
      throw new HttpError(409, '这个浏览器的通知已经在别的账号上打开了');
    }
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET
             created_at = CASE WHEN user_id = excluded.user_id THEN created_at ELSE excluded.created_at END,
             last_ok_at = CASE WHEN user_id = excluded.user_id THEN last_ok_at ELSE NULL END,
             user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
        )
        .run(userId, session, endpoint, keyText.p256dh, keyText.auth, label, at);
      // 每人最多 PUSH_MAX_DEVICES 台：多了删最旧的
      this.db
        .prepare(
          `DELETE FROM push_subscriptions WHERE user_id = ? AND id IN (
             SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(userId, userId, PUSH_MAX_DEVICES);
    });
    return this.devices(userId, endpointHash(endpoint)).find((d) => d.current)!;
  }

  /** 这台设备关掉通知（退出登录时也调用）。不是自己的、已经没有了的，当作已经关掉。 */
  unsubscribe(userId: number, input: unknown): void {
    const endpoint = asObject(input).endpoint;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > ENDPOINT_MAX) throw new HttpError(400, '推送地址不对');
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  }

  /** 在设备列表里删掉一台。 */
  removeDevice(userId: number, id: number): void {
    const removed = this.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes;
    if (!removed) throw new HttpError(404, '没有这台设备，可能已经删掉了');
  }

  /** 我的设备（登录还有效、收得到的），新的在前；currentHash 是网页给的这台设备推送地址的哈希（标出 current）。 */
  devices(userId: number, currentHash: string | null = null): PushDevice[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.endpoint, s.label, s.created_at, s.last_ok_at FROM push_subscriptions s ${ACTIVE}
         WHERE s.user_id = ? ORDER BY s.created_at DESC, s.id DESC`,
      )
      .all(Date.now(), userId) as { id: number; endpoint: string; label: string; created_at: number; last_ok_at: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label || '浏览器',
      createdAt: r.created_at,
      lastOkAt: r.last_ok_at,
      ...(currentHash !== null && endpointHash(r.endpoint) === currentHash ? { current: true } : {}),
    }));
  }

  private hasDevices(userId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM push_subscriptions s ${ACTIVE} WHERE s.user_id = ? LIMIT 1`).get(Date.now(), userId);
  }

  // ==================== 推哪几类 ====================

  prefs(userId: number): PushPrefs {
    const row = this.db.prepare('SELECT prefs FROM push_prefs WHERE user_id = ?').get(userId) as { prefs: string } | undefined;
    const out: PushPrefs = { ...DEFAULT_PUSH_PREFS };
    const saved = row ? safeJson(row.prefs) : {};
    for (const c of PUSH_CATEGORIES) if (typeof saved[c] === 'boolean') out[c] = saved[c] as boolean;
    return out;
  }

  /** 改推哪几类：{ schedule?, started?, turn?, dm?, invites?, other? }，没写的不变。 */
  setPrefs(userId: number, input: unknown): PushPrefs {
    const body = asObject(input);
    const keys = Object.keys(body);
    if (!keys.length) throw new HttpError(400, '没有要改的');
    const next = this.prefs(userId);
    for (const key of keys) {
      if (!(PUSH_CATEGORIES as readonly string[]).includes(key)) throw new HttpError(400, '没有这一类通知');
      if (typeof body[key] !== 'boolean') throw new HttpError(400, '每一类只能打开或者关闭');
      next[key as PushCategory] = body[key] as boolean;
    }
    this.db
      .prepare('INSERT INTO push_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(next), this.opts.now());
    return next;
  }

  info(userId: number, currentHash: string | null): PushInfo {
    return { publicKey: this.publicKey(), prefs: this.prefs(userId), devices: this.devices(userId, currentHash) };
  }

  // ==================== 什么时候推 ====================

  /**
   * 写好了一条通知（Social.notify 的钩子）：按他勾的类别推到他所有的设备。开着网站也推（电脑开着网页，手机照样要收到），
   * 页面正在前台、有焦点的那台设备，sw.js 不弹；快开团的提醒（always）照样弹。
   */
  notified(userId: number, view: NotificationView) {
    try {
      if (this.stopped) return;
      const always = (view.kind as string) === 'schedule_reminder';
      const category = CATEGORY_OF[view.kind] ?? 'other';
      const message = messageFor(view, this.opts.now());
      this.later(() => {
        // 写这条通知的事务撤回了：不推
        if (!this.db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(view.id)) return;
        this.deliver(userId, category, always ? { ...message, always } : message);
      });
    } catch (err) {
      console.error(`浏览器推送出错：${oneLine(err)}`);
    }
  }

  /**
   * 有人给他发了私信：推「某某给你发了私信」（不带私信的内容；开着网站也推，正在前台的那台设备不弹）。
   * 同一个人发来的，DM_PUSH_INTERVAL_MS 里只推一次（一条接一条地发，手机不会一直响）。
   */
  directMessage(recipientId: number, from: { publicId: string; displayName: string }) {
    // 推送出什么错都不能耽误发私信
    try {
      if (this.stopped) return;
      const now = this.opts.now();
      const key = `${recipientId}:${from.publicId}`;
      const last = this.dmPushed.get(key);
      if (last !== undefined && now >= last && now - last < DM_PUSH_INTERVAL_MS) return;
      for (const [k, at] of this.dmPushed) if (now < at || now - at >= DM_PUSH_INTERVAL_MS) this.dmPushed.delete(k);
      this.dmPushed.set(key, now);
      this.later(() =>
        this.deliver(recipientId, 'dm', {
          title: '私信',
          body: `${clip(from.displayName, 20) || '有人'}给你发了私信`,
          url: `/friends/${encodeURIComponent(from.publicId)}`,
          tag: `dm-${from.publicId}`,
          ttl: 12 * HOUR_SECONDS,
          urgency: 'high',
        }),
      );
    } catch (err) {
      console.error(`浏览器推送出错：${oneLine(err)}`);
    }
  }

  /**
   * 回合模式下这一轮别人已经交了、还在等这些人（引擎的 onRoundWaiting 钩子，同一轮会来很多次）。
   * 记下来，turnDelayMs 以后再问一次引擎；那时候同一轮还在等他，就推「就等你交行动了」。同一局同一轮同一个人只推一次。
   */
  roundWaiting(roomId: number, userIds: number[]) {
    if (this.stopped || !this.opts.roundWaitingFor) return;
    try {
      // 回合里每次有动静都会来，这里只做便宜的事：没有设备、关掉了这一类的人不用记；到时候再问引擎
      const users = [...new Set(userIds)].filter((id) => this.hasDevices(id) && this.prefs(id).turn);
      if (!users.length) return;
      const room = this.db.prepare('SELECT round_no FROM rooms WHERE id = ?').get(roomId) as { round_no: number } | undefined;
      if (!room) return;
      const due = this.opts.now() + this.turnDelayMs;
      let added = false;
      for (const userId of users) {
        const key = `${roomId}:${room.round_no}:${userId}`;
        if (this.turnChecks.has(key) || this.turnSent.has(key)) continue;
        this.turnChecks.set(key, { roomId, round: room.round_no, userId, due });
        added = true;
      }
      if (added) this.scheduleTurnCheck();
    } catch (err) {
      console.error(`浏览器推送出错：${oneLine(err)}`);
    }
  }

  /** 看看到时间的「回合等你」：还在等就推（计时器到点时调用；测试里改了时间直接调用）。 */
  checkTurns() {
    if (this.stopped) return;
    const now = this.opts.now();
    for (const [key, check] of [...this.turnChecks]) {
      if (check.due > now) continue;
      this.turnChecks.delete(key);
      try {
        const state = this.opts.roundWaitingFor?.(check.roomId) ?? null;
        if (!state || state.round !== check.round || !state.userIds.includes(check.userId)) continue;
        const room = this.db.prepare('SELECT name FROM rooms WHERE id = ?').get(check.roomId) as { name: string } | undefined;
        if (!room) continue;
        this.turnSent.set(key, now);
        this.deliver(check.userId, 'turn', {
          title: '轮到你了',
          body: `「${clip(room.name, 30) || '对局'}」就等你交行动了`,
          url: `/room/${check.roomId}`,
          tag: `turn-${check.roomId}`,
          ttl: HOUR_SECONDS,
          urgency: 'high',
          renotify: true,
        });
      } catch (err) {
        console.error(`浏览器推送：看「轮到你」时出错：${oneLine(err)}`);
      }
    }
    for (const [key, at] of this.turnSent) if (now - at > 24 * HOUR_SECONDS * 1000 || at > now) this.turnSent.delete(key);
    this.scheduleTurnCheck();
  }

  private scheduleTurnCheck() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (this.stopped || !this.turnChecks.size) return;
    const next = Math.min(...[...this.turnChecks.values()].map((c) => c.due));
    this.turnTimer = setTimeout(
      () => {
        this.turnTimer = null;
        // 计时器里出的错（数据库被锁住之类）不能往外抛：没人接，整个服务器会停下来
        try {
          this.checkTurns();
        } catch (err) {
          console.error(`浏览器推送出错：${oneLine(err)}`);
          try {
            this.scheduleTurnCheck();
          } catch {
            // 排不上下一次：等下次有人在等时再排
          }
        }
      },
      // 先加再夹到上限：超过 32 位的毫秒数 Node 会当成 1 毫秒（时钟往回调了很多时会一直转）
      Math.min(Math.max(0, next - this.opts.now()) + 1000, 2 ** 31 - 1),
    );
    this.turnTimer.unref();
  }

  /** 「发一条试试」：给自己的所有设备发一条（页面开在前台也弹）。每人 30 秒最多一次。返回发给了几台。 */
  sendTest(userId: number): number {
    const devices = this.devices(userId).length;
    if (!devices) throw new HttpError(409, '还没有设备打开通知');
    const now = this.opts.now();
    const last = this.lastTest.get(userId);
    if (last !== undefined && now >= last && now - last < TEST_INTERVAL_MS) throw new HttpError(429, '发得太勤了，过半分钟再试');
    for (const [id, at] of this.lastTest) if (now - at >= TEST_INTERVAL_MS) this.lastTest.delete(id);
    this.lastTest.set(userId, now);
    this.deliver(userId, null, { title: '龙娘跑团', body: '通知能收到了', url: '/account', tag: 'push-test', always: true, renotify: true, ttl: 600, urgency: 'high' });
    return devices;
  }

  // ==================== 发送 ====================

  /** 发给这个人的所有设备。category：属于哪一类（他关掉了就不发）；null 是不分类（发一条试试）。 */
  private deliver(userId: number, category: PushCategory | null, message: Outgoing) {
    const user = this.db.prepare('SELECT is_guest, banned_at, deleted_at FROM users WHERE id = ?').get(userId) as
      | { is_guest: number; banned_at: number | null; deleted_at: number | null }
      | undefined;
    // 游客、被封号的不推；删掉的账号连订阅一起删
    if (!user || user.is_guest === 1 || user.banned_at !== null) return;
    if (user.deleted_at !== null) {
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
      return;
    }
    if (category && !this.prefs(userId)[category]) return;
    // 只发给登录还有效的设备
    const subs = this.db
      .prepare(`SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s ${ACTIVE} WHERE s.user_id = ? ORDER BY s.id`)
      .all(Date.now(), userId) as SubRow[];
    for (const sub of subs) this.enqueue({ userId, sub, message });
  }

  /**
   * 排队。快开团的提醒、发一条试试（always 的）排在前面，不受每个账号的上限；别的每个账号最多排 QUEUE_PER_USER 条，
   * 全站最多 QUEUE_MAX 条，排满了后来的先不发（记一行日志）。
   */
  private enqueue(job: Job) {
    if (this.stopped) return;
    if (job.message.always) {
      if (this.urgent.length >= QUEUE_MAX) return;
      this.urgent.push(job);
      this.pump();
      return;
    }
    const mine = this.queuedBy.get(job.userId) ?? 0;
    if (mine >= QUEUE_PER_USER) {
      if (!this.fullLogged.has(job.userId)) console.error(`浏览器推送：账号 ${job.userId} 排队的太多了（他的推送服务没回应？），后来的先不发`);
      this.fullLogged.add(job.userId);
      return;
    }
    if (this.queue.length >= QUEUE_MAX) {
      if (!this.queueFullLogged) console.error('浏览器推送排队的太多了（推送服务一直没回应？），后来的先不发');
      this.queueFullLogged = true;
      return;
    }
    this.queueFullLogged = false;
    this.queuedBy.set(job.userId, mine + 1);
    this.queue.push(job);
    this.pump();
  }

  /** 从队伍里取下一条：先取要紧的。 */
  private next(): Job | undefined {
    const urgent = this.urgent.shift();
    if (urgent) return urgent;
    const job = this.queue.shift();
    if (job) {
      const left = (this.queuedBy.get(job.userId) ?? 1) - 1;
      if (left > 0) this.queuedBy.set(job.userId, left);
      else {
        this.queuedBy.delete(job.userId);
        this.fullLogged.delete(job.userId);
      }
    }
    return job;
  }

  private pump() {
    while (!this.stopped && this.active < CONCURRENCY && (this.urgent.length || this.queue.length)) {
      const job = this.next()!;
      this.active++;
      this.track(
        this.run(job).finally(() => {
          this.active--;
          this.pump();
        }),
      );
    }
  }

  /** 发一条。出什么错都只记一行日志，不往外抛。 */
  private async run({ sub, message }: Job) {
    try {
      const host = pushServiceHost(sub.endpoint);
      if (!host) {
        // 白名单变了（以前的版本收下的地址现在不认了）：删掉
        this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        return;
      }
      let status: number;
      try {
        const payload = encodeMessage(isApplePush(host) ? { ...message, always: true } : message);
        const body = encryptPayload(payload, sub.p256dh, sub.auth);
        const headers = {
          TTL: String(Math.max(0, Math.round(message.ttl))),
          Urgency: message.urgency,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: this.authorization(sub.endpoint),
        };
        const signal = AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), this.abort.signal]);
        ({ status } = await this.send({ endpoint: sub.endpoint, headers, body }, signal));
      } catch (err) {
        if (!this.stopped) console.error(`浏览器推送没发出去：${host}，${describeError(err, sub.endpoint, host)}`);
        return;
      }
      if (this.stopped) return;
      if (status === 200 || status === 201 || status === 202) {
        this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(this.opts.now(), sub.id);
      } else if (status === 404 || status === 410) {
        // 推送服务说这个订阅没了（浏览器里关掉了、卸载了）
        this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error(`浏览器推送没发出去：${host} 回了 ${status}`);
      }
    } catch (err) {
      // 记发送结果时出错（数据库被锁住之类）
      if (!this.stopped) console.error(`浏览器推送出错：${oneLine(err)}`);
    }
  }

  /** 等当前的事务做完再做（写通知的事务可能撤回）。 */
  private later(fn: () => void) {
    this.track(
      new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        if (this.stopped) return;
        try {
          fn();
        } catch (err) {
          console.error(`浏览器推送出错：${oneLine(err)}`);
        }
      }),
    );
  }

  private track(work: Promise<void>) {
    const p = work.catch((err) => console.error(`浏览器推送出错：${oneLine(err)}`));
    this.pending.add(p);
    void p.then(() => this.pending.delete(p));
  }

  /** 等排着队的都发完（测试用；关服务器前也等一下）。 */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** 关服务器：不再发，正在发的取消掉。 */
  stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.queue.length = 0;
    this.urgent.length = 0;
    this.queuedBy.clear();
    this.turnChecks.clear();
  }
}
