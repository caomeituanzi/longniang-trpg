import type { IncomingMessage } from 'node:http';
import { HttpError } from './http';

// 网站防护：限制频率（防撞库、猜对局码、刷屏）、认出访客的真实地址。

/**
 * 访客的网络地址。用 Cloudflare 隧道时，连到这台电脑的是本机上的隧道程序，
 * 真实地址在 Cloudflare 加的 CF-Connecting-IP 里。只有连接来自本机时才信这个头（直接从外面连进来的人可以伪造它）。
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['cf-connecting-ip'];
  if (loopback && typeof forwarded === 'string' && forwarded.trim() && forwarded.length <= 64) return forwarded.trim();
  return remote;
}

/**
 * 在运行服务器的这台电脑上打开的（不是从 Cloudflare 隧道转进来的）：自己测试时同时开好几个窗口、好几个账号，
 * 请求都算在同一个地址头上，按地址的频率限制对它不管用，只会挡住自己。
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return loopback && req.headers['cf-connecting-ip'] === undefined;
}

type Rule = { max: number; windowMs: number; message: string };

/** 各种操作的频率上限。key 前面的部分是规则名，后面是地址或账号。 */
export const LIMITS = {
  /** 每个地址所有接口加起来（正常玩远远到不了；好几个朋友在同一个网络里一起玩也够用）。在这台电脑上打开的不算。 */
  api: { max: 3000, windowMs: 60_000, message: '请求太频繁了，请稍后再试' },
  /** 登录：每个地址 10 分钟 30 次（另外，同一个地址对同一个账号连续输错 5 次，锁 10 分钟，见 LoginGuard）。 */
  login: { max: 30, windowMs: 10 * 60_000, message: '登录尝试太多了，请过一会儿再试' },
  register: { max: 10, windowMs: 60 * 60_000, message: '注册尝试太多了，请过一会儿再试' },
  guest: { max: 10, windowMs: 60 * 60_000, message: '这一个小时里建的游客账号太多了，过一会儿再试' },
  /** 用对局码加入：防止有人一个个试对局码。 */
  joinCode: { max: 30, windowMs: 10 * 60_000, message: '试对局码的次数太多了，请过一会儿再试' },
  lobbyChat: { max: 8, windowMs: 20_000, message: '发得太快了，歇一会儿再说' },
  roomChat: { max: 12, windowMs: 20_000, message: '发得太快了，歇一会儿再说' },
  dm: { max: 15, windowMs: 20_000, message: '发得太快了，歇一会儿再说' },
  say: { max: 10, windowMs: 30_000, message: '说得太快了，歇一会儿再说' },
  friendRequest: { max: 20, windowMs: 60 * 60_000, message: '加好友的请求发得太多了，请过一会儿再试' },
  invite: { max: 30, windowMs: 60 * 60_000, message: '邀请发得太多了，请过一会儿再试' },
  /** 在大厅里申请加入对局。 */
  joinRequest: { max: 20, windowMs: 60 * 60_000, message: '加入申请发得太多了，请过一会儿再试' },
  report: { max: 10, windowMs: 60 * 60_000, message: '举报和反馈一小时最多 10 条，请过一会儿再提交' },
  avatar: { max: 10, windowMs: 60 * 60_000, message: '头像换得太频繁了，请过一会儿再试' },
  /** 兑换额度：防止有人一个个试兑换码。 */
  redeem: { max: 20, windowMs: 60 * 60_000, message: '兑换试得太多了，请过一会儿再试' },
  /** 投稿剧本（V0.5.0）。 */
  submission: { max: 10, windowMs: 60 * 60_000, message: '投稿太频繁了，请过一会儿再试' },
  /** 宠物：建、改名字和介绍（要做内容检查）、换图（V0.5.0）。 */
  pet: { max: 20, windowMs: 60 * 60_000, message: '改得太频繁了，请过一会儿再试' },
  /** 宠物之间：切磋、串门、留言（V0.6.0；每天的次数另有上限）。 */
  petPlay: { max: 30, windowMs: 10 * 60_000, message: '太频繁了，请过一会儿再试' },
  /** 剧本评分（V0.6.0）。 */
  rating: { max: 20, windowMs: 60 * 60_000, message: '评分改得太频繁了，请过一会儿再试' },
  /** 给作者写反馈（V0.6.0）。 */
  feedback: { max: 10, windowMs: 60 * 60_000, message: '反馈写得太频繁了，请过一会儿再写' },
  /** 问网站向导（V0.6.0）。 */
  guide: { max: 30, windowMs: 10 * 60_000, message: '问得太快了，歇一会儿再问' },
  /** 导出整局排查包（V0.6.0）。 */
  debugExport: { max: 30, windowMs: 10 * 60_000, message: '导出得太频繁了，请过一会儿再试' },
  /** 手动备份（V0.8.0）：备份的时候整个网站要停一下，按账号算。 */
  backup: { max: 3, windowMs: 10 * 60_000, message: '手动备份太频繁了：每 10 分钟最多备份 3 次，请过一会儿再试' },
  /**
   * 剧本编辑器边写边检查（V0.8.0）：网页上改完停一会儿才检查、两次检查至少隔 3.5 秒，正常写碰不到。
   * 按账号算；游客也能检查、一个地址能建好几个游客账号，所以另外按地址算（editorCheckAddress，
   * 比按账号的宽一点：同一个网络里两个人同时写剧本也够用）。
   */
  editorCheck: { max: 20, windowMs: 60_000, message: '检查得太频繁了，过一会儿再试' },
  editorCheckAddress: { max: 30, windowMs: 60_000, message: '检查得太频繁了，过一会儿再试' },
  /** 剧本编辑器存草稿（V0.8.0）。 */
  editorSave: { max: 60, windowMs: 60_000, message: '存得太频繁了，过一会儿再存' },
  /** 把身份交给 AI 演、改名字、取消（V0.8.0 AI 补位）：按账号算，防止来回切刷屏。 */
  aiSeat: { max: 20, windowMs: 60_000, message: '交给 AI 的身份改得太频繁了，过一分钟再改' },
  /** 新建、修改 AI 角色（V1.1.0 AI 大厅，要做内容检查）：按账号算。 */
  persona: { max: 30, windowMs: 60 * 60_000, message: 'AI 角色改得太频繁了，请过一会儿再试' },
} satisfies Record<string, Rule>;

export type LimitName = keyof typeof LIMITS;

/** 滑动窗口计数：在窗口时间里最多 max 次，超过了抛 429。数据只放在内存里，重启后清零。 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private sweeper: NodeJS.Timeout;

  constructor(private now: () => number = Date.now) {
    // 定期清掉过期的记录，免得内存越用越多
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref();
  }

  /** 按访客的网络地址记一次；在这台电脑上打开的不限（见 isLocalRequest）。 */
  hitAddress(name: LimitName, req: IncomingMessage) {
    if (isLocalRequest(req)) return;
    this.hit(name, clientIp(req));
  }

  /** 记一次；超过上限抛 429（不记这一次）。 */
  hit(name: LimitName, who: string | number) {
    const rule = LIMITS[name];
    if (!this.allow(`${name}:${who}`, rule.max, rule.windowMs)) throw new HttpError(429, rule.message);
  }

  /** 记一次并返回是否还没超过上限。 */
  allow(key: string, max: number, windowMs: number): boolean {
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => at - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    return true;
  }

  private sweep() {
    const at = this.now();
    const longest = Math.max(...Object.values(LIMITS).map((r) => r.windowMs));
    for (const [key, times] of this.hits) {
      if (!times.length || at - times[times.length - 1] > longest) this.hits.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

/**
 * 登录输错的次数，按“账号 + 网络地址”记：同一个地址对同一个账号连续输错 5 次，这个地址 10 分钟内不能再登录这个账号。
 * 别人知道你的用户名，乱输密码也只能锁住他自己那边，锁不住你。数据只放在内存里，重启后清零。
 * （有人换着很多地址猜同一个账号的密码：另外按账号累计，见登录接口。）
 */
export class LoginGuard {
  private fails = new Map<string, { count: number; lockedUntil: number; last: number }>();

  constructor(
    private readonly max: number,
    private readonly lockMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private key(userId: number, ip: string) {
    return `${userId}|${ip}`;
  }

  /** 这个地址对这个账号还要锁多久（毫秒），0 是没锁。 */
  lockedFor(userId: number, ip: string): number {
    const entry = this.fails.get(this.key(userId, ip));
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  /** 这个账号有没有哪个地址正被锁着（管理页显示“锁定中”）。 */
  anyLocked(userId: number): boolean {
    const at = this.now();
    for (const [key, entry] of this.fails) if (key.startsWith(`${userId}|`) && entry.lockedUntil > at) return true;
    return false;
  }

  /** 记一次输错。返回 true：这一次以后锁上了。 */
  failed(userId: number, ip: string): boolean {
    const at = this.now();
    this.sweep(at);
    const key = this.key(userId, ip);
    const entry = this.fails.get(key) ?? { count: 0, lockedUntil: 0, last: at };
    // 上一次输错已经是很久以前（锁定时间那么长）了：重新数
    if (at - entry.last > this.lockMs) entry.count = 0;
    entry.count += 1;
    entry.last = at;
    if (entry.count >= this.max) {
      entry.count = 0;
      entry.lockedUntil = at + this.lockMs;
    }
    this.fails.set(key, entry);
    return entry.lockedUntil > at;
  }

  /** 登录成功（只清这个地址）、管理员重置了密码（清这个账号的全部）。 */
  clear(userId: number, ip?: string) {
    if (ip !== undefined) {
      this.fails.delete(this.key(userId, ip));
      return;
    }
    for (const key of [...this.fails.keys()]) if (key.startsWith(`${userId}|`)) this.fails.delete(key);
  }

  /** 记得太多了（有人在刷）：清掉早就过了的。 */
  private sweep(at: number) {
    if (this.fails.size < 5000) return;
    for (const [key, entry] of this.fails) if (entry.lockedUntil <= at && at - entry.last > this.lockMs) this.fails.delete(key);
  }
}
