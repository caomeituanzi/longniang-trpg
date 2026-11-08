import type { AiReviewer } from './ai-review';
import { avatarUrl } from './auth';
import { audit, who } from './audit';
import type { Collection } from './collection';
import { transaction, type DB } from './db';
import type { GameEngine } from './game/engine';
import { validateScenario, type Scenario } from './game/scenario';
import { hiddenScenarios, readScenarioFile, scenarioFileExists, scenarioFolderStamp, writeScenarioFile } from './game/scenario-library';
import { loadOriginalScenario, loadRoom, loadScenario } from './game/world';
import { HttpError } from './http';
import { addCrystals, type FinishedGame } from './pets';
import type { Social } from './social';
import { dayStart } from './util';
import { CATEGORY_KEYS, CATEGORY_NAME, type ScenarioCategory, type ScenarioSummary } from '../shared/game';
import { AUTHOR_DAILY_CAP, AUTHOR_REWARD } from '../shared/pets';
import {
  FEEDBACK_MAX,
  PENDING_SUBMISSIONS_MAX,
  RANK_MIN_RATINGS,
  RATING_COMMENT_MAX,
  type AdminSubmission,
  type AuthorRanking,
  type AuthorRankRow,
  type AuthorWork,
  type FeedbackView,
  type HallAuthor,
  type HallScenario,
  type RatingView,
  type RoomSubmissionState,
  type ScenarioDetail,
  type Submission,
  type WorkRankBy,
  type WorkRanking,
  type WorkRankRow,
} from '../shared/works';
import { frameOf, RANK_SIZE } from '../shared/pets';

/** 排名：一样多的并列（1、2、2、4……）。rows 要先按 value 从大到小排好。 */
function ranked<T extends { value: number }>(rows: T[]): (T & { rank: number })[] {
  let rank = 0;
  let last: number | null = null;
  return rows.map((r, i) => {
    if (r.value !== last) {
      rank = i + 1;
      last = r.value;
    }
    return { ...r, rank };
  });
}

// 剧本大厅（V0.5.0）：能用的剧本按分区列出来；房主把 AI 生成、导入的剧本投稿，管理员审核，
// 通过的存成 scenarios 文件夹里的文件（和管理员上传的一样，升级时会复制到新版本），作者记在数据库里；关注作者。

type SubmissionRow = {
  id: number;
  user_id: number;
  room_id: number | null;
  title: string;
  category: ScenarioCategory;
  intro: string;
  data: string;
  status: Submission['status'];
  reason: string;
  scenario_key: string | null;
  created_at: number;
  reviewed_by: number | null;
  reviewed_at: number | null;
};

const SUBMISSION_COLUMNS = 'id, user_id, room_id, title, category, intro, data, status, reason, scenario_key, created_at, reviewed_by, reviewed_at';

/** 投稿的剧本是不是 5E 模组（通过以后放进「模组」页，V1.0.0）。 */
function isModule(data: string): boolean {
  try {
    return (JSON.parse(data) as { rules?: unknown }).rules === '5e';
  } catch {
    return false;
  }
}

/** 剧本放在哪一页：地下城、模组、剧本大厅。 */
function hallName(category: ScenarioCategory, module: boolean): string {
  return module ? '模组' : category === 'dungeon' ? '地下城' : '剧本大厅';
}

function toSubmission(r: SubmissionRow): Submission {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    intro: r.intro,
    status: r.status,
    reason: r.reason,
    scenarioKey: r.scenario_key,
    roomId: r.room_id,
    module: isModule(r.data),
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

type AuthorRow = {
  scenario_key: string;
  published_at: number;
  id: number;
  public_id: string;
  display_name: string;
  avatar_at: number | null;
  avatar_frame: string | null;
  deleted_at: number | null;
};

export class Works {
  /** 结局图鉴、成就（V0.6.0，app.ts 接上）。 */
  collection?: Collection;
  /** AI 审核（V0.6.0，app.ts 接上）：投稿交上来先让 AI 看一遍。 */
  reviewer?: AiReviewer;

  constructor(
    private readonly opts: {
      db: DB;
      social: Social;
      engine: GameEngine;
      now: () => number;
    },
  ) {}

  private get db() {
    return this.opts.db;
  }

  private get dir() {
    return this.opts.engine.scenarioFolder;
  }

  /** 上次读的剧本列表和那时剧本文件夹的样子（scenarioFolderStamp）。 */
  private listCache: { stamp: string; list: ScenarioSummary[] } | null = null;

  /**
   * scenarios 文件夹里能用的剧本（就是 engine.listScenarios()）。它要把每个剧本文件解析、检查一遍，比较慢：
   * 文件夹里的文件和下架的设置都没变的话，用上次读的（同一份，调用的地方不要改它）。
   */
  listedScenarios(): ScenarioSummary[] {
    const stamp = scenarioFolderStamp(this.db, this.dir);
    if (this.listCache?.stamp !== stamp) this.listCache = { stamp, list: this.opts.engine.listScenarios() };
    return this.listCache.list;
  }

  // ==================== 剧本大厅 ====================

  /**
   * 剧本大厅：scenarios 文件夹里能用的剧本（下架的、文件有错的不列）。
   * 用户投稿通过的带着作者，排在前面（新的在前）；自带的、管理员上传的按从小到大排在后面。
   */
  hall(viewerId: number | null): HallScenario[] {
    const authors = new Map(
      (
        this.db
          .prepare(
            `SELECT a.scenario_key, a.published_at, u.id, u.public_id, u.display_name, u.avatar_at, u.avatar_frame, u.deleted_at
             FROM scenario_authors a JOIN users u ON u.id = a.user_id`,
          )
          .all() as AuthorRow[]
      ).map((r) => [r.scenario_key, r]),
    );
    const plays = new Map(
      (
        this.db.prepare("SELECT scenario_key, COUNT(*) AS n FROM scenarios WHERE source = 'builtin' GROUP BY scenario_key").all() as {
          scenario_key: string;
          n: number;
        }[]
      ).map((r) => [r.scenario_key, r.n]),
    );
    const finishes = new Map(
      (this.db.prepare('SELECT scenario_key, COUNT(*) AS n FROM scenario_finishes GROUP BY scenario_key').all() as { scenario_key: string; n: number }[]).map((r) => [
        r.scenario_key,
        r.n,
      ]),
    );
    const following =
      viewerId === null
        ? new Set<number>()
        : new Set((this.db.prepare('SELECT author_id FROM follows WHERE follower_id = ?').all(viewerId) as { author_id: number }[]).map((r) => r.author_id));
    const ratings = new Map(
      (this.db.prepare('SELECT scenario_key, AVG(stars) AS avg, COUNT(*) AS n FROM scenario_ratings GROUP BY scenario_key').all() as {
        scenario_key: string;
        avg: number;
        n: number;
      }[]).map((r) => [r.scenario_key, { average: Math.round(r.avg * 10) / 10, count: r.n }]),
    );
    const reached = viewerId === null ? new Map<string, number>() : (this.collection?.reachedCounts(viewerId) ?? new Map<string, number>());
    const list = this.listedScenarios().map((s): HallScenario => {
      const a = authors.get(s.key);
      return {
        ...s,
        authorUser: a ? this.authorOf(a, viewerId, following) : null,
        publishedAt: a?.published_at ?? null,
        plays: plays.get(s.key) ?? 0,
        finishes: finishes.get(s.key) ?? 0,
        rating: ratings.get(s.key) ?? { average: null, count: 0 },
        endings: { total: s.endingCount, reached: reached.get(s.key) ?? 0 },
        canRate: (reached.get(s.key) ?? 0) > 0,
      };
    });
    const users = list.filter((s) => s.publishedAt !== null).sort((a, b) => b.publishedAt! - a.publishedAt!);
    // 自带的、管理员放的：按分区排（地下城按难度），同一个分区里还是原来的顺序
    const order = (s: HallScenario) => {
      const i = s.category ? CATEGORY_KEYS.indexOf(s.category) : -1;
      return i < 0 ? CATEGORY_KEYS.length : i;
    };
    const rest = list.filter((s) => s.publishedAt === null).sort((a, b) => order(a) - order(b) || (a.dungeon?.level ?? 0) - (b.dungeon?.level ?? 0));
    return [...users, ...rest];
  }

  /**
   * 「剧本大厅」页（V0.7.1 起地下城单独一页、V1.0.0 起 5E 模组单独一页，这里都不列）。
   * 排行、图鉴、个人主页的作品照旧用 hall()，地下城、模组也算。
   */
  scenarioHall(viewerId: number | null): HallScenario[] {
    return this.hall(viewerId).filter((s) => s.category !== 'dungeon' && s.rules !== '5e');
  }

  /** 「模组」页（V1.0.0）：5E 模组，按建议等级从低到高排；一样的按剧本大厅原来的顺序。 */
  moduleHall(viewerId: number | null): HallScenario[] {
    return this.hall(viewerId)
      .filter((s) => s.rules === '5e')
      .sort((a, b) => (a.module5e?.level ?? 1) - (b.module5e?.level ?? 1));
  }

  /** 「地下城」页（V0.7.1）：分区是地下城的剧本，按难度从低到高排；一样的难度小型在前，再按剧本大厅原来的顺序。 */
  dungeonHall(viewerId: number | null): HallScenario[] {
    const large = (s: HallScenario) => (s.dungeon?.size === 'large' ? 1 : 0);
    return this.hall(viewerId)
      .filter((s) => s.category === 'dungeon')
      .sort((a, b) => (a.dungeon?.level ?? 0) - (b.dungeon?.level ?? 0) || large(a) - large(b));
  }

  private authorOf(a: AuthorRow, viewerId: number | null, following: Set<number>): HallAuthor {
    const deleted = a.deleted_at !== null;
    return {
      publicId: a.public_id,
      displayName: a.display_name,
      avatar: deleted ? null : avatarUrl(a.public_id, a.avatar_at),
      frame: deleted ? null : frameOf(a.avatar_frame),
      following: following.has(a.id),
      self: a.id === viewerId,
      deleted,
    };
  }

  /** 一个作者在剧本大厅里的作品（个人主页用）。 */
  worksOf(authorId: number, viewerId: number | null): HallScenario[] {
    const keys = new Set(
      (this.db.prepare('SELECT scenario_key FROM scenario_authors WHERE user_id = ?').all(authorId) as { scenario_key: string }[]).map((r) => r.scenario_key),
    );
    if (!keys.size) return [];
    return this.hall(viewerId).filter((s) => keys.has(s.key));
  }

  // ==================== 关注 ====================

  followers(authorId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE author_id = ?').get(authorId) as { n: number }).n;
  }

  isFollowing(followerId: number, authorId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND author_id = ?').get(followerId, authorId);
  }

  follow(followerId: number, authorId: number) {
    if (followerId === authorId) throw new HttpError(400, '不能关注自己');
    const target = this.db.prepare('SELECT is_guest, deleted_at FROM users WHERE id = ?').get(authorId) as { is_guest: number; deleted_at: number | null } | undefined;
    if (!target || target.deleted_at !== null || target.is_guest === 1) throw new HttpError(404, '没有这个用户');
    if (this.opts.social.blockedEither(followerId, authorId)) throw new HttpError(403, '你们之间有屏蔽，关注不了');
    this.db.prepare('INSERT INTO follows (follower_id, author_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(followerId, authorId, this.opts.now());
  }

  unfollow(followerId: number, authorId: number) {
    this.db.prepare('DELETE FROM follows WHERE follower_id = ? AND author_id = ?').run(followerId, authorId);
  }

  // ==================== 投稿 ====================

  private row(id: number): SubmissionRow | undefined {
    return this.db.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM scenario_submissions WHERE id = ?`).get(id) as SubmissionRow | undefined;
  }

  /**
   * 这一局的投稿情况（开团准备、「设置」、结局下面显示）：只有房主看得到。
   * 最近一次投稿按剧本的标题找（V0.9.2）：在这一局投的、在剧本编辑器里投的、在别的对局里投的都算；换了剧本就看新剧本的。
   */
  roomState(roomId: number, userId: number): RoomSubmissionState | null {
    const room = loadRoom(this.db, roomId);
    if (!room || room.host_user_id !== userId) return null;
    const stored = loadScenario(this.db, roomId);
    const latest = stored
      ? (this.db
          .prepare(`SELECT ${SUBMISSION_COLUMNS} FROM scenario_submissions WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1`)
          .get(userId, stored.scenario.title) as SubmissionRow | undefined)
      : undefined;
    return { canSubmit: !!stored && stored.source !== 'builtin', latest: latest ? toSubmission(latest) : null };
  }

  /**
   * 同一个人、同一个标题的投稿在等审核或者已经通过了，不能再投（V0.9.2：编辑器里投过的，开一局再投也算重复）；
   * 同时等审核的投稿不超过几份。
   */
  private checkOpen(userId: number, title: string) {
    const same = this.db
      .prepare("SELECT status, category, data FROM scenario_submissions WHERE user_id = ? AND title = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1")
      .get(userId, title) as { status: string; category: ScenarioCategory; data: string } | undefined;
    if (same) {
      throw new HttpError(409, same.status === 'pending' ? `《${title}》已经投稿了，等管理员审核` : `《${title}》已经通过审核，放进${hallName(same.category, isModule(same.data))}了`);
    }
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM scenario_submissions WHERE user_id = ? AND status = 'pending'").get(userId) as { n: number }).n;
    if (pending >= PENDING_SUBMISSIONS_MAX) throw new HttpError(429, `你已经有${pending}份投稿在等审核了，等审核完再投`);
  }

  /**
   * 投稿之前的检查（内容检查之前、之后各做一次）：只有房主能投；这一局的剧本是 AI 生成或导入的；
   * 这个剧本在这一局、别处都没有等审核、已经通过的投稿（换了剧本的，之前那个剧本的投稿不算）；同时等审核的投稿不超过几份。返回这一局的剧本。
   */
  checkSubmit(roomId: number, userId: number, category?: ScenarioCategory) {
    const room = loadRoom(this.db, roomId);
    if (!room) throw new HttpError(404, '对局不存在');
    if (room.host_user_id !== userId) throw new HttpError(403, '只有房主能投稿这一局的剧本');
    const stored = loadScenario(this.db, roomId);
    if (!stored) throw new HttpError(409, '这一局还没有剧本');
    if (stored.source === 'builtin') throw new HttpError(409, '这一局用的是剧本大厅里的剧本，不用再投稿');
    // V0.7.1 以前装进对局的地下城只存了随机定好的这一局，少了别的变化和弱点，审核过不了
    if (stored.scenario.dungeon && !this.db.prepare('SELECT 1 FROM scenarios WHERE room_id = ? AND original IS NOT NULL').get(roomId)) {
      throw new HttpError(409, '这一局的地下城是升级以前装进来的，投不了稿：在新的一局里重新导入以后再投');
    }
    // 分区要和剧本对得上（V0.7.1）：地下城只能投「地下城」，别的剧本不能投「地下城」
    if (category !== undefined) {
      const dungeon = !!stored.scenario.dungeon;
      if (dungeon && category !== 'dungeon') throw new HttpError(400, '这是地下城，分区要选「地下城」');
      if (!dungeon && category === 'dungeon') throw new HttpError(400, '这不是地下城，不能投到「地下城」');
    }
    const open = this.db
      .prepare("SELECT status FROM scenario_submissions WHERE room_id = ? AND title = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1")
      .get(roomId, stored.scenario.title) as { status: string } | undefined;
    if (open) throw new HttpError(409, open.status === 'pending' ? '这一局的剧本已经投稿了，等管理员审核' : '这一局的剧本已经通过审核了');
    this.checkOpen(userId, stored.scenario.title);
    return stored;
  }

  /** 一键投稿（V0.9.2）用的分区和简介：照这一局的剧本自己写的（没写的是 null，要投稿的人自己填）。 */
  submitDefaults(roomId: number, userId: number): { category: ScenarioCategory | null; intro: string | null } {
    const stored = this.checkSubmit(roomId, userId);
    return { category: stored.scenario.category ?? null, intro: stored.scenario.intro?.trim() || null };
  }

  submit(roomId: number, userId: number, category: ScenarioCategory, intro: string): Submission {
    const stored = this.checkSubmit(roomId, userId, category);
    // 地下城投原来的整份剧本：这一局用的是随机定好变化的一份，少了别的变化和弱点（V0.7.1）
    const data = { ...(loadOriginalScenario(this.db, roomId) ?? stored.scenario), category, intro };
    delete (data as { author?: string }).author;
    return this.insert(userId, roomId, stored.scenario.title, category, intro, data);
  }

  /**
   * 剧本编辑器里写好的剧本直接投稿（V0.9.2，不用先开一局）：剧本要能通过检查，写了分区和简介；
   * 同一个人同一个标题的投稿在等审核、已经通过了，不能再投。返回检查过的剧本（内容检查之前、之后各检查一次）。
   */
  checkDraftSubmit(userId: number, data: unknown): Scenario {
    const result = validateScenario(data);
    if (!result.scenario) throw new HttpError(400, `剧本还有 ${result.errors.length} 个错误，改好了再投：${result.errors.slice(0, 3).join('；')}`);
    const scenario = result.scenario;
    if (!scenario.category) throw new HttpError(400, '投稿前在「基本信息」里选一个分区');
    if (!scenario.intro?.trim()) throw new HttpError(400, '投稿前在「基本信息」里写一段简介');
    this.checkOpen(userId, scenario.title);
    return scenario;
  }

  submitDraft(userId: number, data: unknown): Submission {
    const scenario = this.checkDraftSubmit(userId, data);
    const copy = { ...scenario } as Scenario & { author?: string };
    delete copy.author;
    return this.insert(userId, null, scenario.title, scenario.category!, scenario.intro!.trim(), copy);
  }

  /** 存下一份投稿（等审核），交给 AI 先看一遍。 */
  private insert(userId: number, roomId: number | null, title: string, category: ScenarioCategory, intro: string, data: object): Submission {
    const at = this.opts.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO scenario_submissions (user_id, room_id, title, category, intro, data, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(userId, roomId, title, category, intro, JSON.stringify(data), at);
    this.opts.social.pushAdminBadges();
    const id = Number(lastInsertRowid);
    // 交上来先让 AI 看一遍，把意见给管理员（AI 用不了也不耽误投稿）
    try {
      this.reviewer?.start('submission', id, null);
    } catch (err) {
      console.error('投稿的 AI 审核没开始：', err);
    }
    return toSubmission(this.row(id)!);
  }

  mine(userId: number): Submission[] {
    return (this.db.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM scenario_submissions WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(userId) as SubmissionRow[]).map(
      toSubmission,
    );
  }

  /** 撤回还没审的投稿。 */
  withdraw(userId: number, id: number): Submission {
    const row = this.row(id);
    if (!row || row.user_id !== userId) throw new HttpError(404, '没有这份投稿');
    if (row.status !== 'pending') throw new HttpError(409, '这份投稿已经审核过了');
    this.db.prepare("UPDATE scenario_submissions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").run(id);
    this.opts.social.pushAdminBadges();
    return toSubmission(this.row(id)!);
  }

  // ==================== 管理员审核 ====================

  /** 等审核的全部，加上最近审核过的 30 份。 */
  adminList(): AdminSubmission[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT ${SUBMISSION_COLUMNS} FROM scenario_submissions WHERE status = 'pending')
         UNION ALL SELECT * FROM (SELECT ${SUBMISSION_COLUMNS} FROM scenario_submissions WHERE status != 'pending' ORDER BY id DESC LIMIT 30)`,
      )
      .all() as SubmissionRow[];
    const pending = rows.filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id);
    const done = rows.filter((r) => r.status !== 'pending').sort((a, b) => (b.reviewed_at ?? b.created_at) - (a.reviewed_at ?? a.created_at));
    return [...pending, ...done].map((r) => this.toAdmin(r));
  }

  private toAdmin(r: SubmissionRow): AdminSubmission {
    const u = this.db.prepare('SELECT public_id, display_name, uid, deleted_at FROM users WHERE id = ?').get(r.user_id) as {
      public_id: string;
      display_name: string;
      uid: number | null;
      deleted_at: number | null;
    };
    const reviewer = r.reviewed_by === null ? null : ((this.db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.reviewed_by) as { display_name: string } | undefined)?.display_name ?? null);
    return {
      ...toSubmission(r),
      author: { publicId: u.public_id, displayName: u.display_name, uid: u.uid, deleted: u.deleted_at !== null },
      reviewer,
      aiReview: this.reviewer?.latest('submission', r.id) ?? null,
    };
  }

  /** 投稿的全文（包括真相）：管理员审核时看。 */
  adminView(id: number) {
    const row = this.row(id);
    if (!row) throw new HttpError(404, '没有这份投稿');
    return { submission: this.toAdmin(row), scenario: validateScenario(JSON.parse(row.data)).scenario };
  }

  /**
   * 通过：存成 scenarios 文件夹里的文件（sub-投稿编号.json），放进剧本大厅，作者记下来；
   * 告诉投稿的人，再告诉关注他的人有新作品。
   */
  approve(adminId: number, id: number): AdminSubmission {
    const row = this.row(id);
    if (!row) throw new HttpError(404, '没有这份投稿');
    if (row.status !== 'pending') throw new HttpError(409, row.status === 'withdrawn' ? '投稿的人已经撤回了' : '这份投稿已经审核过了');
    const result = validateScenario(JSON.parse(row.data));
    if (!result.scenario) throw new HttpError(409, `这份剧本有错误：${result.errors.slice(0, 3).join('；')}`);
    const author = this.db.prepare('SELECT display_name, deleted_at FROM users WHERE id = ?').get(row.user_id) as { display_name: string; deleted_at: number | null };
    if (author.deleted_at !== null) throw new HttpError(409, '投稿的人的账号已经删掉了');
    let key = `sub-${id}`;
    for (let n = 2; scenarioFileExists(this.dir, key); n++) key = `sub-${id}-${n}`;
    const at = this.opts.now();
    // 先写文件再改数据库：写文件出错时投稿还是等审核
    writeScenarioFile(this.dir, key, { ...result.scenario, author: [...author.display_name].slice(0, 20).join('') }, false);
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE scenario_submissions SET status = 'approved', scenario_key = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
        .run(key, adminId, at, id);
      this.db.prepare('INSERT INTO scenario_authors (scenario_key, user_id, submission_id, published_at) VALUES (?, ?, ?, ?)').run(key, row.user_id, id, at);
    });
    audit(this.db, adminId, '投稿通过', `《${row.title}》（${CATEGORY_NAME[row.category]}，${who(this.db, row.user_id)}，存成 ${key}）`, at);
    const { social } = this.opts;
    // category：地下城的投稿通过了，通知里的按钮去「地下城」页（V0.7.1）；module：5E 模组去「模组」页（V1.0.0）
    const module = result.scenario.rules === '5e';
    social.notify(row.user_id, 'submission_result', { submissionId: id, title: row.title, approved: true, key, category: row.category, module });
    const from = social.brief(row.user_id);
    const followers = this.db
      .prepare('SELECT f.follower_id FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.author_id = ? AND u.deleted_at IS NULL')
      .all(row.user_id) as { follower_id: number }[];
    for (const f of followers) {
      if (social.blockedEither(f.follower_id, row.user_id)) continue;
      social.notify(f.follower_id, 'new_work', { from, title: row.title, key, category: row.category, module });
    }
    social.pushAdminBadges();
    this.collection?.check(row.user_id, ['author']);
    return this.toAdmin(this.row(id)!);
  }

  reject(adminId: number, id: number, reason: string): AdminSubmission {
    const row = this.row(id);
    if (!row) throw new HttpError(404, '没有这份投稿');
    if (row.status !== 'pending') throw new HttpError(409, row.status === 'withdrawn' ? '投稿的人已经撤回了' : '这份投稿已经审核过了');
    const at = this.opts.now();
    this.db.prepare("UPDATE scenario_submissions SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(reason, adminId, at, id);
    audit(this.db, adminId, '投稿不通过', `《${row.title}》（${who(this.db, row.user_id)}）：${reason}`, at);
    this.opts.social.notify(row.user_id, 'submission_result', { submissionId: id, title: row.title, approved: false, reason });
    this.opts.social.pushAdminBadges();
    return this.toAdmin(this.row(id)!);
  }

  /** 剧本删掉了：作者那一行也删掉（投稿记录留着）。 */
  forgetScenario(key: string) {
    this.db.prepare('DELETE FROM scenario_authors WHERE scenario_key = ?').run(key);
  }

  /**
   * 管理员把一个已通过的投稿下架：删掉“审核已过”的投稿记录和作者关联，
   * 这样作者以后可以用同一个标题重新投稿，不会被“已经通过审核”挡住。
   */
  takeDown(key: string) {
    const row = this.db
      .prepare("SELECT id FROM scenario_submissions WHERE scenario_key = ? AND status = 'approved' ORDER BY id DESC LIMIT 1")
      .get(key) as { id: number } | undefined;
    if (!row) {
      this.forgetScenario(key);
      return;
    }
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM ai_reviews WHERE target_type = 'submission' AND target_id = ?").run(row.id);
      this.db.prepare('DELETE FROM scenario_submissions WHERE id = ?').run(row.id);
      this.db.prepare('DELETE FROM scenario_authors WHERE scenario_key = ?').run(key);
    });
    this.opts.social.pushAdminBadges();
  }

  /** 这个剧本在剧本大厅里（存在、没下架）。 */
  listed(key: string): boolean {
    return scenarioFileExists(this.dir, key) && !hiddenScenarios(this.db).has(key);
  }

  /** 剧本大厅里一个剧本的全部结局（剧本不在了是 null）。 */
  endingsOf(key: string): { key: string; title: string }[] | null {
    if (!scenarioFileExists(this.dir, key)) return null;
    const { scenario } = readScenarioFile(this.dir, key);
    return scenario ? scenario.endings.map((e) => ({ key: e.key, title: e.title })) : null;
  }

  // ==================== 评分和短评（V0.6.0） ====================

  /** 玩完过这个剧本（达成过它的结局）才能评分。 */
  canRate(userId: number, key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM endings_reached WHERE user_id = ? AND scenario_key = ?').get(userId, key);
  }

  /** 打分、写短评（再打一次就是改）。 */
  rate(userId: number, key: string, stars: number, comment: string) {
    if (!this.listed(key)) throw new HttpError(404, '剧本大厅里没有这个剧本');
    if (!this.canRate(userId, key)) throw new HttpError(403, '玩完这个剧本以后才能评分');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, '请选 1～5 星');
    const text = comment.trim();
    if ([...text].length > RATING_COMMENT_MAX) throw new HttpError(400, `短评最多${RATING_COMMENT_MAX}个字`);
    const at = this.opts.now();
    const before = this.db.prepare('SELECT comment FROM scenario_ratings WHERE user_id = ? AND scenario_key = ?').get(userId, key) as { comment: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO scenario_ratings (user_id, scenario_key, stars, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, scenario_key) DO UPDATE SET stars = excluded.stars, comment = excluded.comment,
           comment_deleted_by = NULL, updated_at = excluded.updated_at`,
      )
      .run(userId, key, stars, text, at, at);
    this.collection?.check(userId, ['rater-3']);
    // 写了新的短评：告诉作者（用户投稿的剧本才有作者；自己评自己的不算）
    const author = this.authorIdOf(key);
    if (author !== null && author !== userId && text && text !== before?.comment && !this.opts.social.blockedEither(author, userId)) {
      this.opts.social.notify(author, 'work_review', { from: this.opts.social.brief(userId), title: this.titleOf(key), key, stars });
    }
  }

  /** 管理员删一条短评（星留着）。返回删之前的短评。 */
  deleteComment(adminId: number, ratingId: number): string {
    const row = this.db.prepare('SELECT user_id, scenario_key, comment FROM scenario_ratings WHERE id = ?').get(ratingId) as
      | { user_id: number; scenario_key: string; comment: string }
      | undefined;
    if (!row || !row.comment) throw new HttpError(404, '没有这条短评');
    this.db.prepare("UPDATE scenario_ratings SET comment = '', comment_deleted_by = ? WHERE id = ?").run(adminId, ratingId);
    audit(this.db, adminId, '删剧本短评', `${who(this.db, row.user_id)}给 ${row.scenario_key} 写的：${row.comment}`, this.opts.now());
    return row.comment;
  }

  /** 一条短评（举报用）：谁写的、写的什么、哪个剧本。 */
  ratingRow(id: number): { userId: number; key: string; comment: string } | null {
    const row = this.db.prepare('SELECT user_id, scenario_key, comment FROM scenario_ratings WHERE id = ?').get(id) as
      | { user_id: number; scenario_key: string; comment: string }
      | undefined;
    return row ? { userId: row.user_id, key: row.scenario_key, comment: row.comment } : null;
  }

  /**
   * 剧本大厅里点开一个剧本：评分、短评（只给玩完过的人、作者、管理员看）、我的评分、结局图鉴。
   * 我屏蔽了的人写的短评不给我看。
   */
  detail(viewerId: number, key: string, admin: boolean): ScenarioDetail {
    if (!this.listed(key)) throw new HttpError(404, '剧本大厅里没有这个剧本');
    const summary = this.db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM scenario_ratings WHERE scenario_key = ?').get(key) as { avg: number | null; n: number };
    const author = this.db.prepare('SELECT user_id FROM scenario_authors WHERE scenario_key = ?').get(key) as { user_id: number } | undefined;
    const canRate = this.canRate(viewerId, key);
    const seeComments = canRate || admin || author?.user_id === viewerId;
    const blocked = this.opts.social.blockedIds(viewerId);
    const comments: RatingView[] | null = seeComments
      ? (
          this.db
            .prepare(
              `SELECT r.id, r.user_id, r.stars, r.comment, r.comment_deleted_by, r.updated_at, u.public_id, u.display_name, u.avatar_at, u.deleted_at
               FROM scenario_ratings r JOIN users u ON u.id = r.user_id WHERE r.scenario_key = ? ORDER BY r.updated_at DESC LIMIT 100`,
            )
            .all(key) as {
            id: number;
            user_id: number;
            stars: number;
            comment: string;
            comment_deleted_by: number | null;
            updated_at: number;
            public_id: string;
            display_name: string;
            avatar_at: number | null;
            deleted_at: number | null;
          }[]
        )
          .filter((r) => !blocked.has(r.user_id))
          .map((r) => ({
            id: r.id,
            author: { publicId: r.public_id, displayName: r.display_name, avatar: r.deleted_at === null ? avatarUrl(r.public_id, r.avatar_at) : null },
            stars: r.stars,
            comment: r.comment,
            commentDeleted: r.comment_deleted_by !== null,
            at: r.updated_at,
            mine: r.user_id === viewerId,
          }))
      : null;
    const mine = this.db.prepare('SELECT stars, comment FROM scenario_ratings WHERE user_id = ? AND scenario_key = ?').get(viewerId, key) as
      | { stars: number; comment: string }
      | undefined;
    return {
      key,
      rating: { average: summary.avg === null ? null : Math.round(summary.avg * 10) / 10, count: summary.n },
      comments,
      mine: mine ?? null,
      canRate,
      endings: { total: this.endingsOf(key)?.length ?? 0, reached: this.collection?.reached(viewerId, key) ?? [] },
      feedback: author ? { canSend: this.canFeedback(viewerId, key), mine: this.feedbackOf(viewerId, key) } : null,
    };
  }

  // ==================== 作者分成（V0.6.0） ====================

  /**
   * 投稿的剧本被别人玩完了一局（这一局有作者以外算玩完的人）：给作者龙晶，每天有上限（到了上限照样记下这一局，算成就用）。
   * 一局只给一次。
   */
  authorReward(game: FinishedGame) {
    if (!game.scenarioKey || !game.ending) return;
    const author = this.db.prepare('SELECT a.user_id, u.deleted_at FROM scenario_authors a JOIN users u ON u.id = a.user_id WHERE a.scenario_key = ?').get(game.scenarioKey) as
      | { user_id: number; deleted_at: number | null }
      | undefined;
    if (!author || author.deleted_at !== null) return;
    if (!game.players.some((p) => p.userId !== author.user_id)) return;
    const at = this.opts.now();
    const today = (this.db.prepare('SELECT COALESCE(SUM(reward), 0) AS n FROM author_plays WHERE author_id = ? AND created_at >= ?').get(author.user_id, dayStart(at)) as { n: number }).n;
    const reward = Math.max(0, Math.min(AUTHOR_REWARD, AUTHOR_DAILY_CAP - today));
    const added = transaction(this.db, () => {
      const n = this.db
        .prepare(
          'INSERT INTO author_plays (room_id, room_created_at, scenario_key, author_id, reward, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .run(game.roomId, game.roomCreatedAt, game.scenarioKey, author.user_id, reward, at).changes;
      if (n && reward > 0) addCrystals(this.db, author.user_id, reward, 'author', `《${game.scenarioTitle}》被玩完了一局`, null, at);
      return n > 0;
    });
    if (!added) return;
    if (reward > 0) this.opts.social.notify(author.user_id, 'author_reward', { title: game.scenarioTitle, key: game.scenarioKey, reward });
    this.collection?.check(author.user_id, ['author-5', 'rich']);
  }

  // ==================== 玩完的局数、排行（V0.6.0） ====================

  /** 剧本大厅里的剧本走到了结局：记一局（玩完几次、结局分布、排行用）。重新走到结局不重复记。 */
  recordFinish(game: FinishedGame) {
    if (!game.scenarioKey || !game.ending) return;
    this.db
      .prepare(
        `INSERT INTO scenario_finishes (room_id, room_created_at, scenario_key, ending_key, ending_title, players, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(game.roomId, game.roomCreatedAt, game.scenarioKey, game.ending.key, game.ending.title, game.players.length, this.opts.now());
  }

  private authorIdOf(key: string): number | null {
    return (this.db.prepare('SELECT user_id FROM scenario_authors WHERE scenario_key = ?').get(key) as { user_id: number } | undefined)?.user_id ?? null;
  }

  /** 剧本的名字（文件读不出来的用投稿时的名字，再不行用编号）。 */
  private titleOf(key: string): string {
    const { scenario } = scenarioFileExists(this.dir, key) ? readScenarioFile(this.dir, key) : { scenario: null };
    if (scenario) return scenario.title;
    const sub = this.db.prepare('SELECT title FROM scenario_submissions WHERE scenario_key = ?').get(key) as { title: string } | undefined;
    return sub?.title ?? key;
  }

  /**
   * 作品榜（「排行」页，V0.7.0）：剧本大厅里全部的（category 是 null）或者一个分区的剧本，
   * 按好评（平均几星，至少 RANK_MIN_RATINGS 个人评过）或者游玩次数（玩完几局）排。
   */
  workRankings(viewerId: number, category: ScenarioCategory | null, by: WorkRankBy): WorkRanking {
    const hall = this.hall(viewerId).filter((s) => category === null || s.category === category);
    const row = (s: HallScenario, value: number, count: number): Omit<WorkRankRow, 'rank'> => ({
      key: s.key,
      title: s.title,
      category: s.category,
      author: s.authorUser && !s.authorUser.deleted ? { publicId: s.authorUser.publicId, displayName: s.authorUser.displayName } : null,
      authorName: s.authorUser?.displayName ?? (s.author || '龙娘跑团'),
      value,
      count,
    });
    const rows =
      by === 'rating'
        ? hall
            .filter((s) => s.rating.count >= RANK_MIN_RATINGS && s.rating.average !== null)
            .sort((a, b) => b.rating.average! - a.rating.average! || b.rating.count - a.rating.count)
            .map((s) => row(s, s.rating.average!, s.rating.count))
        : hall
            .filter((s) => s.finishes > 0)
            .sort((a, b) => b.finishes - a.finishes || b.plays - a.plays)
            .map((s) => row(s, s.finishes, s.plays));
    return { category, by, rows: ranked(rows).slice(0, RANK_SIZE) };
  }

  /** 作者榜（「排行」页）：作者的作品（还在剧本大厅里的）被玩完的局数，带着作品数、平均评分。 */
  authorRankings(viewerId: number): AuthorRanking {
    const hall = this.hall(viewerId);
    // 作者：还在剧本大厅里的作品
    const listed = new Set(hall.map((s) => s.key));
    const byAuthor = new Map<number, { finishes: number; works: number; ratingSum: number; ratingCount: number }>();
    const authorRows = this.db
      .prepare(
        `SELECT a.user_id, a.scenario_key, (SELECT COUNT(*) FROM scenario_finishes f WHERE f.scenario_key = a.scenario_key) AS finishes
         FROM scenario_authors a JOIN users u ON u.id = a.user_id WHERE u.deleted_at IS NULL AND u.banned_at IS NULL`,
      )
      .all() as { user_id: number; scenario_key: string; finishes: number }[];
    for (const r of authorRows) {
      if (!listed.has(r.scenario_key)) continue;
      const e = byAuthor.get(r.user_id) ?? { finishes: 0, works: 0, ratingSum: 0, ratingCount: 0 };
      e.finishes += r.finishes;
      e.works += 1;
      const s = hall.find((h) => h.key === r.scenario_key);
      if (s?.rating.average != null) {
        e.ratingSum += s.rating.average * s.rating.count;
        e.ratingCount += s.rating.count;
      }
      byAuthor.set(r.user_id, e);
    }
    const people = this.db.prepare('SELECT public_id, display_name, avatar_at, avatar_frame FROM users WHERE id = ?');
    const authors: AuthorRankRow[] = ranked(
      [...byAuthor.entries()]
        .filter(([, e]) => e.finishes > 0)
        .sort((a, b) => b[1].finishes - a[1].finishes || b[1].works - a[1].works)
        .map(([id, e]) => {
          const u = people.get(id) as { public_id: string; display_name: string; avatar_at: number | null; avatar_frame: string | null };
          return {
            author: { publicId: u.public_id, displayName: u.display_name, avatar: avatarUrl(u.public_id, u.avatar_at), frame: frameOf(u.avatar_frame) },
            finishes: e.finishes,
            works: e.works,
            average: e.ratingCount ? Math.round((e.ratingSum / e.ratingCount) * 10) / 10 : null,
            me: id === viewerId,
            value: e.finishes,
          };
        }),
    )
      .slice(0, RANK_SIZE)
      .map(({ value: _value, ...r }) => r);
    return { rows: authors };
  }

  // ==================== 给作者的反馈（V0.6.0） ====================

  /** 玩过这个剧本（在用它的对局里当过成员），不是作者自己，和作者之间没有屏蔽，才能给作者写反馈。 */
  canFeedback(userId: number, key: string): boolean {
    const author = this.authorIdOf(key);
    if (author === null || author === userId) return false;
    if (this.opts.social.blockedEither(author, userId)) return false;
    const user = this.db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId) as { is_guest: number } | undefined;
    if (!user || user.is_guest === 1) return false;
    return !!this.db
      .prepare("SELECT 1 FROM players p JOIN scenarios s ON s.room_id = p.room_id WHERE p.user_id = ? AND s.source = 'builtin' AND s.scenario_key = ?")
      .get(userId, key);
  }

  /** 我写给这个剧本的作者的反馈（新的在前）。 */
  feedbackOf(userId: number, key: string): FeedbackView[] {
    return (
      this.db
        .prepare(
          'SELECT id, text, reply, created_at, replied_at FROM scenario_feedback WHERE user_id = ? AND scenario_key = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20',
        )
        .all(userId, key) as { id: number; text: string; reply: string | null; created_at: number; replied_at: number | null }[]
    ).map((r) => ({ id: r.id, from: null, text: r.text, reply: r.reply, at: r.created_at, repliedAt: r.replied_at }));
  }

  sendFeedback(userId: number, key: string, raw: string): FeedbackView[] {
    if (!this.listed(key)) throw new HttpError(404, '剧本大厅里没有这个剧本');
    if (this.authorIdOf(key) === null) throw new HttpError(404, '这个剧本是网站自带的，有意见请用页面最下面的「反馈问题」');
    if (!this.canFeedback(userId, key)) throw new HttpError(403, '玩过这个剧本才能给作者写反馈');
    const text = raw.trim();
    if (!text || [...text].length > FEEDBACK_MAX) throw new HttpError(400, `反馈要在1～${FEEDBACK_MAX}个字之间`);
    const author = this.authorIdOf(key)!;
    const at = this.opts.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO scenario_feedback (scenario_key, author_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, author, userId, text, at);
    this.opts.social.notify(author, 'work_feedback', { from: this.opts.social.brief(userId), title: this.titleOf(key), key, feedbackId: Number(lastInsertRowid) });
    return this.feedbackOf(userId, key);
  }

  private feedbackRow(id: number) {
    return this.db.prepare('SELECT id, scenario_key, author_id, user_id, text, reply, deleted_at FROM scenario_feedback WHERE id = ?').get(id) as
      | { id: number; scenario_key: string; author_id: number; user_id: number; text: string; reply: string | null; deleted_at: number | null }
      | undefined;
  }

  /** 作者回复一条反馈（再回复就是改）。 */
  replyFeedback(authorId: number, id: number, raw: string) {
    const row = this.feedbackRow(id);
    if (!row || row.deleted_at !== null || row.author_id !== authorId) throw new HttpError(404, '没有这条反馈');
    const text = raw.trim();
    if (!text || [...text].length > FEEDBACK_MAX) throw new HttpError(400, `回复要在1～${FEEDBACK_MAX}个字之间`);
    this.db.prepare('UPDATE scenario_feedback SET reply = ?, replied_at = ? WHERE id = ?').run(text, this.opts.now(), id);
    if (!this.opts.social.blockedEither(authorId, row.user_id)) {
      // category：地下城的回复，通知里的按钮去「地下城」页（V0.7.1）；module：5E 模组去「模组」页（V1.0.0）
      const listed = this.listedScenarios().find((s) => s.key === row.scenario_key);
      this.opts.social.notify(row.user_id, 'feedback_reply', {
        from: this.opts.social.brief(authorId),
        title: this.titleOf(row.scenario_key),
        key: row.scenario_key,
        category: listed?.category ?? null,
        module: listed?.rules === '5e',
      });
    }
  }

  /** 删一条反馈：作者（收到的）、写的人（自己写的）；有「处理举报」权限的管理员删别人的记进操作记录。 */
  deleteFeedback(userId: number, id: number, moderator: boolean) {
    const row = this.feedbackRow(id);
    if (!row || row.deleted_at !== null) throw new HttpError(404, '没有这条反馈');
    const party = row.author_id === userId || row.user_id === userId;
    if (!party && !moderator) throw new HttpError(404, '没有这条反馈');
    const at = this.opts.now();
    this.db.prepare('UPDATE scenario_feedback SET deleted_at = ? WHERE id = ?').run(at, id);
    if (!party) audit(this.db, userId, '删给作者的反馈', `${who(this.db, row.user_id)}写给${who(this.db, row.author_id)}的：${row.text}`, at);
  }

  /** 一条反馈（举报用）：只有收到它的作者能举报。 */
  feedbackForReport(id: number, reporterId: number): { userId: number; key: string; text: string } | null {
    const row = this.feedbackRow(id);
    if (!row || row.deleted_at !== null || row.author_id !== reporterId) return null;
    return { userId: row.user_id, key: row.scenario_key, text: row.text };
  }

  // ==================== 我的作品（V0.6.0） ====================

  /** 作者的「我的作品」：每部作品的数据、结局分布、全部短评、收到的反馈。 */
  myWorks(authorId: number): AuthorWork[] {
    const rows = this.db
      .prepare('SELECT scenario_key, published_at FROM scenario_authors WHERE user_id = ? ORDER BY published_at DESC')
      .all(authorId) as { scenario_key: string; published_at: number }[];
    const hidden = hiddenScenarios(this.db);
    const blocked = this.opts.social.blockedIds(authorId);
    return rows.map((r) => {
      const key = r.scenario_key;
      const exists = scenarioFileExists(this.dir, key);
      const scenario = exists ? readScenarioFile(this.dir, key).scenario : null;
      const rating = this.db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM scenario_ratings WHERE scenario_key = ?').get(key) as { avg: number | null; n: number };
      const plays = (this.db.prepare("SELECT COUNT(*) AS n FROM scenarios WHERE source = 'builtin' AND scenario_key = ?").get(key) as { n: number }).n;
      const fin = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(players), 0) AS p FROM scenario_finishes WHERE scenario_key = ?').get(key) as { n: number; p: number };
      const reached = new Map(
        (this.db.prepare('SELECT ending_title, COUNT(*) AS n FROM scenario_finishes WHERE scenario_key = ? GROUP BY ending_title').all(key) as {
          ending_title: string | null;
          n: number;
        }[]).map((e) => [e.ending_title ?? '', e.n]),
      );
      const endings = scenario ? scenario.endings.map((e) => ({ title: e.title, count: reached.get(e.title) ?? 0 })) : [...reached.entries()].map(([title, count]) => ({ title, count }));
      const sub = this.db.prepare('SELECT title, category FROM scenario_submissions WHERE scenario_key = ?').get(key) as { title: string; category: ScenarioCategory } | undefined;
      const comments: RatingView[] = (
        this.db
          .prepare(
            `SELECT r.id, r.user_id, r.stars, r.comment, r.comment_deleted_by, r.updated_at, u.public_id, u.display_name, u.avatar_at, u.deleted_at
             FROM scenario_ratings r JOIN users u ON u.id = r.user_id WHERE r.scenario_key = ? ORDER BY r.updated_at DESC LIMIT 100`,
          )
          .all(key) as {
          id: number;
          user_id: number;
          stars: number;
          comment: string;
          comment_deleted_by: number | null;
          updated_at: number;
          public_id: string;
          display_name: string;
          avatar_at: number | null;
          deleted_at: number | null;
        }[]
      )
        .filter((c) => !blocked.has(c.user_id))
        .map((c) => ({
          id: c.id,
          author: { publicId: c.public_id, displayName: c.display_name, avatar: c.deleted_at === null ? avatarUrl(c.public_id, c.avatar_at) : null },
          stars: c.stars,
          comment: c.comment,
          commentDeleted: c.comment_deleted_by !== null,
          at: c.updated_at,
          mine: false,
        }));
      const feedback: FeedbackView[] = (
        this.db
          .prepare(
            `SELECT f.id, f.user_id, f.text, f.reply, f.created_at, f.replied_at, u.public_id, u.display_name, u.avatar_at, u.deleted_at
             FROM scenario_feedback f JOIN users u ON u.id = f.user_id WHERE f.scenario_key = ? AND f.author_id = ? AND f.deleted_at IS NULL ORDER BY f.id DESC LIMIT 100`,
          )
          .all(key, authorId) as {
          id: number;
          user_id: number;
          text: string;
          reply: string | null;
          created_at: number;
          replied_at: number | null;
          public_id: string;
          display_name: string;
          avatar_at: number | null;
          deleted_at: number | null;
        }[]
      )
        .filter((f) => !blocked.has(f.user_id))
        .map((f) => ({
          id: f.id,
          from: { publicId: f.public_id, displayName: f.display_name, avatar: f.deleted_at === null ? avatarUrl(f.public_id, f.avatar_at) : null },
          text: f.text,
          reply: f.reply,
          at: f.created_at,
          repliedAt: f.replied_at,
        }));
      return {
        key,
        title: scenario?.title ?? sub?.title ?? key,
        category: scenario?.category ?? sub?.category ?? null,
        listed: exists && !hidden.has(key),
        publishedAt: r.published_at,
        rating: { average: rating.avg === null ? null : Math.round(rating.avg * 10) / 10, count: rating.n },
        plays,
        finishes: fin.n,
        players: fin.p,
        endings,
        comments,
        feedback,
      };
    });
  }
}
