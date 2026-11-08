// 剧本大厅、投稿、作者（V0.5.0）：服务器发给网页的数据格式，两边共用这一份。
import type { Identity } from './admin';
import type { AiReviewView } from './review';
import type { ScenarioCategory, ScenarioSummary } from './game';

/** 用户投稿的剧本的作者。following：我关注了他；self：就是我；deleted：账号已经删了。 */
export type HallAuthor = {
  publicId: string;
  displayName: string;
  avatar: string | null;
  /** 戴着的头像框（V0.7.0）。 */
  frame: string | null;
  following: boolean;
  self: boolean;
  deleted: boolean;
};

/** 剧本大厅里的一个剧本。 */
export type HallScenario = ScenarioSummary & {
  /** 用户投稿通过的：作者是谁。自带的、管理员上传的是 null，作者看 author。 */
  authorUser: HallAuthor | null;
  /** 投稿通过的时间（用户投稿的才有）。 */
  publishedAt: number | null;
  /** 用这个剧本开过几局。 */
  plays: number;
  /** 走到结局（玩完）过几局（V0.6.0）。 */
  finishes: number;
  /** 评分（V0.6.0）：平均几星（没人评是 null）、几个人评。 */
  rating: { average: number | null; count: number };
  /** 结局图鉴（V0.6.0）：一共几个结局、我达成了几个。 */
  endings: { total: number; reached: number };
  /** 我玩完过这个剧本，能评分。 */
  canRate: boolean;
};

/** 地下城的通关记录（V0.7.0）：最近通关的几队、最快的一次（realMinutes 是现实里打了几分钟）。 */
export type DungeonRecords = {
  recent: { title: string; players: string[]; at: number; realMinutes: number }[];
  fastest: { players: string[]; realMinutes: number; at: number } | null;
};

/** 「地下城」页（V0.7.1）的一个地下城：剧本大厅里的那些，加上通关记录。 */
export type DungeonHallEntry = HallScenario & { records: DungeonRecords };

/** 剧本大厅的排序（V0.6.0）。 */
export type HallSort = 'default' | 'rating' | 'plays' | 'newest';
export const HALL_SORT_LABEL: Record<HallSort, string> = { default: '默认', rating: '评分', plays: '开过的局数', newest: '最新' };

/** 短评最多几个字。 */
export const RATING_COMMENT_MAX = 100;

/** 一条评分和短评。 */
export type RatingView = {
  id: number;
  author: { publicId: string; displayName: string; avatar: string | null };
  stars: number;
  comment: string;
  /** 短评被管理员删了（星还在）。 */
  commentDeleted: boolean;
  at: number;
  mine: boolean;
};

/**
 * 一个剧本的评分和结局图鉴（剧本大厅里点开看）。comments 只给玩完过的人、作者和管理员看（免得剧透），别人是 null。
 * endings.reached 是我达成过的结局（名字），没达成的只算个数。
 */
export type ScenarioDetail = {
  key: string;
  rating: { average: number | null; count: number };
  comments: RatingView[] | null;
  mine: { stars: number; comment: string } | null;
  canRate: boolean;
  endings: { total: number; reached: { key: string; title: string; at: number }[] };
  /**
   * 给作者的反馈（用户投稿的剧本才有，自带的是 null）：我能不能写（玩过、不是作者自己、没有屏蔽）、我写过的和作者的回复。
   */
  feedback: { canSend: boolean; mine: FeedbackView[] } | null;
};

// ==================== 给作者的反馈、我的作品、排行（V0.6.0） ====================

/** 一条反馈最多几个字（作者的回复也是）。 */
export const FEEDBACK_MAX = 300;

/** 玩过的人私下给作者的一条反馈。from：写的人（作者看的时候有；自己看自己写的是 null）。 */
export type FeedbackView = {
  id: number;
  from: { publicId: string; displayName: string; avatar: string | null } | null;
  text: string;
  reply: string | null;
  at: number;
  repliedAt: number | null;
};

/** 作者的「我的作品」：每部作品的数据、结局分布（只有作者看得到）、全部短评、收到的反馈。 */
export type AuthorWork = {
  key: string;
  title: string;
  category: ScenarioCategory | null;
  /** 还在剧本大厅里（没下架、文件还在）。 */
  listed: boolean;
  publishedAt: number;
  rating: { average: number | null; count: number };
  plays: number;
  finishes: number;
  /** 玩完的人一共几人次。 */
  players: number;
  /** 各个结局被达成过几局（剧本里写的结局都列出来，没人达成过的是 0）。 */
  endings: { title: string; count: number }[];
  comments: RatingView[];
  feedback: FeedbackView[];
};

/** 评分榜至少要几个人评过才上榜。 */
export const RANK_MIN_RATINGS = 3;

/** 作品榜按什么排（V0.7.0「排行」页）：好评（平均几星）、游玩次数（玩完几局）。 */
export type WorkRankBy = 'rating' | 'plays';
export const WORK_RANK_BY_LABEL: Record<WorkRankBy, string> = { rating: '好评', plays: '游玩次数' };

/** 作品排行的一行：好评榜的 value 是平均几星（count 是几个人评），游玩次数榜的 value 是玩完几局（count 是开过几局）。 */
export type WorkRankRow = {
  rank: number;
  key: string;
  title: string;
  category: ScenarioCategory | null;
  author: { publicId: string; displayName: string } | null;
  authorName: string;
  value: number;
  count: number;
};

/** 作者排行：作品被玩完的局数（作品数、平均评分）。frame：作者戴着的头像框。 */
export type AuthorRankRow = {
  rank: number;
  author: { publicId: string; displayName: string; avatar: string | null; frame: string | null };
  finishes: number;
  works: number;
  average: number | null;
  me: boolean;
};

/** 作品榜：全部的（category 是 null）或者一个分区的，按好评或者游玩次数排。 */
export type WorkRanking = { category: ScenarioCategory | null; by: WorkRankBy; rows: WorkRankRow[] };

/** 作者榜。 */
export type AuthorRanking = { rows: AuthorRankRow[] };

/** pending 等审核；approved 通过了；rejected 没通过；withdrawn 自己撤回了。 */
export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: '等审核',
  approved: '通过了',
  rejected: '没通过',
  withdrawn: '撤回了',
};

/** 投稿的简介最多几个字（和剧本格式里的一样）。 */
export const SUBMISSION_INTRO_MAX = 300;
/** 不通过的原因最多几个字。 */
export const REJECT_REASON_MAX = 200;
/** 一个人同时最多有几份等审核的投稿。 */
export const PENDING_SUBMISSIONS_MAX = 3;

export type Submission = {
  id: number;
  title: string;
  category: ScenarioCategory;
  intro: string;
  status: SubmissionStatus;
  /** 不通过的原因。 */
  reason: string;
  /** 通过以后放进剧本大厅用的编号（剧本文件名）。 */
  scenarioKey: string | null;
  /** 从哪一局投的（对局删了、在剧本编辑器里直接投的是 null）。 */
  roomId: number | null;
  /** 投的是 5E 模组（V1.0.0）：通过以后放进「模组」页。 */
  module: boolean;
  createdAt: number;
  reviewedAt: number | null;
};

/** 管理页看到的投稿：多了投稿的人、谁审的。 */
export type AdminSubmission = Submission & {
  author: { publicId: string; displayName: string; uid: number | null; deleted: boolean };
  reviewer: string | null;
  /** AI 审核的意见（V0.6.0，最新的一次；还没审过是 null）。 */
  aiReview: AiReviewView | null;
};

/** 我关注的一个人（社交页的「关注」列表）：在剧本大厅里有几部作品、最新的一部。 */
export type FollowingUser = {
  publicId: string;
  displayName: string;
  avatar: string | null;
  identity: Identity;
  /** 戴着的头像框（V0.7.0）。 */
  frame: string | null;
  since: number;
  works: number;
  latest: { key: string; title: string; category: ScenarioCategory | null } | null;
};

/** 对局「设置」里的投稿：这一局的剧本能不能投、投过的情况。 */
export type RoomSubmissionState = {
  /** 能投稿：房主、这一局的剧本是 AI 生成或导入的。 */
  canSubmit: boolean;
  /** 这一局的剧本最近一次投稿（V0.9.2 起按标题找：在剧本编辑器、别的对局里投的也算）。 */
  latest: Submission | null;
};
