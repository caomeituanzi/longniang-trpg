import { AI_OFF_MESSAGE, AiSwitchedOff, type AiClient } from './ai/client';
import { GUARD_CATEGORY_LABEL, MISUSE_CATEGORIES, moderate, type GuardCategory } from './ai/moderation';
import { AiError, isThirdPartyRefusal, thirdPartyBy } from './ai/types';
import { audit, who } from './audit';
import type { DB } from './db';
import { HttpError } from './http';

// 防违规：发给 AI 之前先检查，明确违规的（包括和跑团无关、想让主持 AI 做别的事的）不发；被 AI 的安全机制拒绝的按情况处理。
// 算到某个人头上的违规（V0.4.5 起）：第一次警告，第二次封号；管理员标成误判的不算次数。
// 管理员自己写了违规内容也照样拦下，但不警告、不封号（不然没人能管了），记成 blocked。
// 多人局里被拒绝（发给 AI 的内容混着别人写的）、AI 自己写的内容被拒绝：分不清是谁的，只标给管理员看（flagged）。

export type ViolationSource =
  | 'action'
  | 'question'
  | 'dialogue'
  | 'character'
  | 'scenario'
  | 'generate'
  | 'summary'
  | 'submission'
  | 'draft'
  | 'guide'
  | 'persona'
  | 'companion';

export const SOURCE_LABEL: Record<ViolationSource, string> = {
  action: '角色的行动',
  question: '场外提问',
  dialogue: '角色的对白',
  character: '角色设定',
  scenario: '导入的剧本',
  generate: '生成剧本的要求',
  summary: 'AI 写的摘要',
  submission: '投稿的简介',
  draft: '投稿的剧本',
  guide: '问网站向导的问题',
  // AI 大厅（V1.1.0）：AI 角色的名字、简介、人设；AI 角色在对局里交的行动（AI 自己写的，被拒绝了只标给管理员看）
  persona: 'AI 角色的人设',
  companion: 'AI 角色的行动',
};

/** 记下的违规内容最多留多少字（给管理员看是怎么回事就够了）。 */
const CONTENT_MAX = 2000;

export const BANNED_MESSAGE = '账号已被封禁，有疑问请联系管理员。';

/** 离解封还有多久：几天几小时、几小时几分钟、几分钟（不足一分钟算一分钟）。 */
export function remainingText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 24 * 60) {
    const hours = Math.ceil(minutes / 60);
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
  }
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} 分钟`;
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
}

/** 这一类拒绝是网站自己提示词的问题，不算玩家违规（见 Claude 文档“Refusals and fallback”）。 */
export const PROMPT_ISSUE_CATEGORY = 'reasoning_extraction';

export type ViolationOutcome = 'banned' | 'warned' | 'flagged' | 'blocked';

/** 第一次违规时告诉他的话（接在说明哪里违规的后面）。 */
export const WARNING_TAIL = '这是警告，再违反一次账号会被封禁。';

export class Safety {
  /** 封号以后要做的事（退出登录、断开推送、撤回他在等的行动），由服务器组装时接上。 */
  onBanned: ((userId: number) => void) | null = null;
  /** 解封以后要做的事（他在的各局重新算在线情况），由服务器组装时接上。 */
  onUnbanned: ((userId: number) => void) | null = null;
  /** 警告了他（第一次违规）：发一条通知，由服务器组装时接上。message 是告诉他的话。 */
  onWarned: ((userId: number, message: string) => void) | null = null;

  constructor(
    private readonly db: DB,
    private readonly ai: AiClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 发给 AI 之前检查一段玩家写的内容。没问题就直接返回；明确违规就记下、封号（管理员只拦下），抛出 403。
   * 检查本身出错（网络、AI 暂时用不了）时也不放行，让他过一会儿再试。
   */
  async precheck(
    userId: number,
    roomId: number | null,
    source: ViolationSource,
    text: string,
    /** declineMisuse：和跑团无关、想让 AI 无视规则的只回这句话拒绝，不算违规（网站向导用：它本来就只回答网站的事）。 */
    opts: { declineMisuse?: string } = {},
  ): Promise<void> {
    if (!text.trim()) return;
    // 检查内容用的 AI 现在用不了（管理员关掉了、那一家没设置密钥）：直接说原因
    const status = this.ai.statusFor('moderation', roomId);
    if (!status.ready) throw new HttpError(503, status.message ?? 'AI 暂时用不了');
    let verdict;
    try {
      verdict = await moderate(this.ai, text, SOURCE_LABEL[source], { roomId, userId });
    } catch (err) {
      if (err instanceof AiSwitchedOff) throw new HttpError(503, AI_OFF_MESSAGE);
      const reason = err instanceof AiError ? err.message.replace(/，?过一会儿会自动重试/, '').replace(/[。.]$/, '') : '出错了';
      throw new HttpError(503, `发给 AI 之前的内容检查没做成（${reason}），请过一会儿再试`);
    }
    if (!verdict.violation) {
      // 检查的这一会儿里，他可能因为别的内容被封了：不再往下做
      if (this.isBanned(userId)) throw new HttpError(403, BANNED_MESSAGE);
      return;
    }
    const admin = this.isAdmin(userId);
    if (verdict.refused) {
      this.refusedCheck(userId, roomId, source, text, verdict.refused.category, admin);
      return;
    }
    if (opts.declineMisuse && MISUSE_CATEGORIES.includes(verdict.category)) throw new HttpError(400, opts.declineMisuse);
    // 和跑团无关、想让 AI 无视规则的：主持 AI 只用来跑团
    const label = GUARD_CATEGORY_LABEL[verdict.category];
    const what = MISUSE_CATEGORIES.includes(verdict.category) ? `${label}（主持 AI 只用来跑团）` : `违反使用规则（${label}）`;
    const outcome = this.penalty(userId, admin);
    this.record({ userId, roomId, kind: 'precheck', source, content: text, category: verdict.category, reason: verdict.reason, outcome });
    this.punish(userId, outcome, `这段内容${what}，没有发给 AI。`, `${SOURCE_LABEL[source]}${what}`);
  }

  /** 这个人以前被警告、封号过几次（管理员标成误判的不算）。 */
  strikes(userId: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM violations WHERE user_id = ? AND outcome IN ('warned', 'banned') AND dismissed = 0").get(userId) as { n: number }
    ).n;
  }

  /** 这次违规怎么处理：管理员只拦下；以前没有过的警告；以前警告过（或封过）的封号。要在记下这次之前算。 */
  private penalty(userId: number, admin: boolean): ViolationOutcome {
    if (admin) return 'blocked';
    return this.strikes(userId) > 0 ? 'banned' : 'warned';
  }

  /**
   * 按处理结果告诉他、封号，总是抛出 403。said：说明哪里违规的一句（警告、封号的话接在后面）；
   * banReason：封号时记的原因。
   */
  private punish(userId: number, outcome: ViolationOutcome, said: string, banReason: string): never {
    if (outcome === 'warned') {
      const message = `${said}${WARNING_TAIL}`;
      this.warn(userId, message);
      throw new HttpError(403, message);
    }
    if (outcome === 'banned') {
      this.ban(userId, `${banReason}（第二次违规）`, null);
      throw new HttpError(403, `${said}${BANNED_MESSAGE}`);
    }
    throw new HttpError(403, said.replace(/。$/, ''));
  }

  private warn(userId: number, message: string) {
    try {
      this.onWarned?.(userId, message);
    } catch (err) {
      console.error('发警告通知出错：', err);
    }
  }

  /**
   * 内容检查本身被 AI 的安全机制拒绝了：和别的违规一样，第一次警告，第二次封号（偶尔会误判，管理员可以标成误判）。
   * 经 OpenRouter、中转站调用、被别家拒绝的只拦下，不算次数。总是抛出 403。
   */
  private refusedCheck(userId: number, roomId: number | null, source: ViolationSource, text: string, category: string | null, admin: boolean): never {
    // 经 OpenRouter 调用、被别家拒绝的：只拦下，不封号，也不算进「第二次」里
    const thirdParty = isThirdPartyRefusal(category);
    if (thirdParty) {
      this.record({
        userId,
        roomId,
        kind: 'precheck',
        source,
        content: text,
        category: `refusal:${category}`,
        reason: `内容检查${thirdPartyBy(category)}拒绝了（别家的模型或内容审核，只拦下，不封号）`,
        outcome: admin ? 'blocked' : 'flagged',
      });
      throw new HttpError(403, '这段内容没有通过内容检查（被 AI 那边拒绝了），没有发给 AI。如果是误判，请换个写法。');
    }
    const outcome = this.penalty(userId, admin);
    this.record({
      userId,
      roomId,
      kind: 'precheck',
      source,
      content: text,
      category: category ? `refusal:${category}` : 'refusal',
      reason: '内容检查被 AI 的安全机制拒绝了',
      outcome,
    });
    this.punish(userId, outcome, '这段内容没有通过内容检查（被 AI 的安全机制拒绝了），没有发给 AI。', `${SOURCE_LABEL[source]}的内容检查被 AI 的安全机制拒绝`);
  }

  /**
   * 请求被 AI 的安全机制拒绝了。内容只来自一个人的（单人局的行动、场外提问、导入的剧本）：算他一次违规
   * （第一次警告，第二次封号）；多人局里的（叙述里混着别人的内容）、AI 自己写的（生成剧本、摘要）：只标给管理员看。
   * 这时候他多半不在场（结算是过一阵子才做的）：警告用通知告诉他。
   */
  refusal(opts: {
    userId: number | null;
    roomId: number | null;
    source: ViolationSource;
    content: string;
    category: string | null;
    soloAuthor: boolean;
  }): ViolationOutcome {
    // 「推理提取」类的拒绝是我们自己提示词的问题（要求 AI 把思考过程写出来），不是玩家写的内容违规：只标给管理员看
    const promptIssue = opts.category === PROMPT_ISSUE_CATEGORY;
    // 经 OpenRouter 调用、被别家拒绝的：误判多少不清楚，也只标给管理员看
    const thirdParty = isThirdPartyRefusal(opts.category);
    const counts = opts.soloAuthor && !promptIssue && !thirdParty && opts.userId !== null && !this.isAdmin(opts.userId);
    const outcome: ViolationOutcome = counts ? this.penalty(opts.userId!, false) : 'flagged';
    this.record({
      userId: opts.userId,
      roomId: opts.roomId,
      kind: 'refusal',
      source: opts.source,
      content: opts.content,
      category: opts.category ? `refusal:${opts.category}` : 'refusal',
      reason: promptIssue
        ? '被 Claude 拒绝了，类别是“推理提取”：是网站提示词的问题，不算玩家违规'
        : thirdParty
          ? `${thirdPartyBy(opts.category)}拒绝了（别家的模型或内容审核，不自动封号）`
          : '请求被 Claude 的安全机制拒绝了',
      outcome,
    });
    if (outcome === 'banned') this.ban(opts.userId!, `${SOURCE_LABEL[opts.source]}被 AI 的安全机制拒绝了（第二次违规）`, null);
    if (outcome === 'warned') this.warn(opts.userId!, `你写的${SOURCE_LABEL[opts.source]}被 AI 的安全机制拒绝了，算一次违规。${WARNING_TAIL}`);
    return outcome;
  }

  /**
   * 封号。管理员不能被封；已经封了的不重复封。返回这次有没有封。
   * until：到这个时间自动解封；不写是一直封着（违规自动封的都是这样），等管理员解封。
   */
  ban(userId: number, reason: string, by: number | null, until: number | null = null): boolean {
    if (this.isAdmin(userId)) return false;
    const changed = this.db
      .prepare('UPDATE users SET banned_at = ?, ban_reason = ?, banned_until = ? WHERE id = ? AND banned_at IS NULL')
      // 管理员封号可以不写原因（V0.6.0）：只记「管理员封禁」
      .run(this.now(), by === null ? reason : reason ? `管理员封禁：${reason}` : '管理员封禁', until, userId).changes;
    if (!changed) return false;
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    try {
      this.onBanned?.(userId);
    } catch (err) {
      console.error('封号以后的处理出错：', err);
    }
    return true;
  }

  /** 解封。返回这次有没有解（本来就没封着的不算）。 */
  unban(userId: number): boolean {
    const changed =
      this.db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL, banned_until = NULL WHERE id = ? AND banned_at IS NOT NULL').run(userId).changes > 0;
    if (changed) this.afterUnban(userId);
    return changed;
  }

  /**
   * 定了时长的封号到时间了：自动解封，操作记录里记一条「网站自动」的。返回解封了的账号。
   * 服务器每分钟查一次；登录、打开管理页的账号列表时也先查一次，到点就能用，不用等。
   */
  liftExpiredBans(): number[] {
    const at = this.now();
    const due = this.db
      .prepare('SELECT id, ban_reason FROM users WHERE banned_at IS NOT NULL AND banned_until IS NOT NULL AND banned_until <= ? AND deleted_at IS NULL')
      .all(at) as { id: number; ban_reason: string | null }[];
    const lifted: number[] = [];
    for (const row of due) {
      const changed = this.db
        .prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL, banned_until = NULL WHERE id = ? AND banned_until IS NOT NULL AND banned_until <= ?')
        .run(row.id, at).changes;
      if (!changed) continue;
      audit(this.db, null, '解封', `${who(this.db, row.id)}：封禁到期，自动解封${row.ban_reason ? `（封禁的原因：${row.ban_reason}）` : ''}`, at);
      lifted.push(row.id);
      this.afterUnban(row.id);
    }
    return lifted;
  }

  private afterUnban(userId: number) {
    try {
      this.onUnbanned?.(userId);
    } catch (err) {
      console.error('解封以后的处理出错：', err);
    }
  }

  private isAdmin(userId: number): boolean {
    const row = this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined;
    return row?.is_admin === 1;
  }

  isBanned(userId: number): boolean {
    const row = this.db.prepare('SELECT banned_at FROM users WHERE id = ?').get(userId) as { banned_at: number | null } | undefined;
    return !row || row.banned_at !== null;
  }

  private record(v: {
    userId: number | null;
    roomId: number | null;
    kind: 'precheck' | 'refusal';
    source: ViolationSource;
    content: string;
    category: GuardCategory | string;
    reason: string;
    outcome: ViolationOutcome;
  }) {
    this.db
      .prepare(
        `INSERT INTO violations (user_id, room_id, kind, source, content, category, reason, outcome, created_at)
         VALUES ((SELECT id FROM users WHERE id = ?), (SELECT id FROM rooms WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.userId, v.roomId, v.kind, v.source, [...v.content].slice(0, CONTENT_MAX).join(''), v.category, v.reason, v.outcome, this.now());
  }
}
