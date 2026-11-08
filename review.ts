// AI 审核（V0.6.0）：投稿、举报交上来，AI 先看一遍，把意见给管理员；最后由管理员裁决。服务器和网页共用这一份。

export type ReviewTarget = 'submission' | 'report';

/** 投稿：建议通过、建议退回、拿不准。举报：违规、不违规、拿不准。 */
export type ReviewVerdict = 'approve' | 'reject' | 'violation' | 'no_violation' | 'unsure';

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: '建议通过',
  reject: '建议退回',
  violation: '违规',
  no_violation: '不违规',
  unsure: '拿不准',
};

/** 举报建议怎么处理。 */
export type ReportAction = 'none' | 'delete' | 'warn' | 'ban';
export const REPORT_ACTION_LABEL: Record<ReportAction, string> = { none: '不用处理', delete: '删掉内容', warn: '警告', ban: '封号' };

/** 举报的内容违反的是哪一类。 */
export const REPORT_CATEGORIES = ['none', 'harassment', 'hate', 'sexual', 'minors', 'violence', 'self_harm', 'privacy', 'spam', 'cheating', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_CATEGORY_LABEL: Record<ReportCategory, string> = {
  none: '没有违规',
  harassment: '骚扰、辱骂、人身攻击',
  hate: '仇恨言论',
  sexual: '露骨的性内容',
  minors: '涉及未成年人的性内容',
  violence: '威胁、煽动现实中的暴力',
  self_harm: '鼓励自残、自杀',
  privacy: '泄露别人的隐私',
  spam: '刷屏、广告、诈骗',
  cheating: '小号、借号、绕过规则',
  other: '其他',
};

export type ReportSeverity = 'low' | 'medium' | 'high';
export const SEVERITY_LABEL: Record<ReportSeverity, string> = { low: '轻微', medium: '中等', high: '严重' };

/** 投稿的审核意见：内容合不合规矩、质量几分（1～5）、简介有没有剧透、分区对不对、修改建议。 */
export type SubmissionReviewDetails = {
  content: { ok: boolean; notes: string };
  quality: { score: number; strengths: string[]; problems: string[] };
  introSpoiler: boolean;
  category: { ok: boolean; suggested: string | null; notes: string };
  suggestions: string[];
};

/** 举报的审核意见：违反的是哪一类、严重程度、建议怎么处理、理由。 */
export type ReportReviewDetails = {
  category: ReportCategory;
  severity: ReportSeverity;
  action: ReportAction;
  reasons: string[];
};

export type AiReviewView = {
  id: number;
  target: ReviewTarget;
  status: 'running' | 'done' | 'failed';
  verdict: ReviewVerdict | null;
  summary: string;
  details: SubmissionReviewDetails | ReportReviewDetails | null;
  model: string | null;
  /** 没审成的原因。 */
  error: string | null;
  at: number;
  finishedAt: number | null;
};
