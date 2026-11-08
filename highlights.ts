// 名场面和战报卡片（V0.8.0）：服务器和网页共用的数字、类型和「哪些记录能收藏」。
import type { ScenarioCategory } from './game';
import type { Outcome } from './rules';

/** 每人每局最多收藏这么多条。 */
export const HIGHLIGHT_LIMIT = 200;
/** 战报卡片上最多放几条名场面。 */
export const REPORT_HIGHLIGHTS = 3;

/** 能收藏的叙述：开场、身份、行动的结果、只告诉你的事、对白、结局。 */
const STORY_TYPES = ['opening', 'role', 'resolution', 'private', 'say', 'ending'] as const;

/** 名场面的类别；narration 是老版本留下的、没有类型的叙述。 */
export type HighlightType = (typeof STORY_TYPES)[number] | 'narration';

/**
 * 这条记录能不能收藏，能的话是哪一类。能收藏的是故事本身：主持人的叙述和角色说的话。
 * 系统提示（谁加入了、开局、暂停、房主改了什么）、场外聊天和场外问答、「把东西交给谁」「把线索告诉谁」这种一行的提示不能收藏：
 * 它们不是故事，收进来只会把名场面和战报挤乱。
 */
export function highlightTypeOf(entry: { kind: string; data: { type: string } | null }): HighlightType | null {
  if (entry.kind !== 'narration') return null;
  if (!entry.data) return 'narration';
  return (STORY_TYPES as readonly string[]).includes(entry.data.type) ? (entry.data.type as HighlightType) : null;
}

/** 收藏的一条。内容按收藏的人看得到的样子给（别人的线索、变化不在里面）。 */
export type HighlightItem = {
  logId: number;
  type: HighlightType;
  /** 一句话的标题：「开场：标题」「林小满」（行动）、「林小满说」「林小满悄悄对沈探说」「只有你察觉到」「你的身份」「结局：标题」。 */
  label: string;
  /** 是谁的：行动的角色、说话的角色；别的是 null。 */
  who: string | null;
  /** 行动的内容（行动的结果才有）。 */
  action: string | null;
  /** 正文：主持人的叙述、说的话、结局的收尾。 */
  text: string;
  /**
   * 只有你知道：这一类本来就只给你一个人看（你的身份、只有你察觉到的事、你悄悄做的行动的结果）。
   * 战报是拿去给别人看的：这些和结局一样默认不放，自己勾了照样能放。
   */
  onlyMe: boolean;
  /** 悄悄话：两个人之间的话，发给别人看不合适，也默认不放。 */
  whisper: boolean;
  /** 游戏时间（从第1天0点起的分钟数）。 */
  gameTime: number | null;
  /** 记录写下的时间。 */
  createdAt: number;
  /** 收藏的时间。 */
  savedAt: number;
};

/** 战报默认放的名场面：按先后取前 REPORT_HIGHLIGHTS 条，结局（剧透）、只有你知道的、悄悄话不算，不够就少放。 */
export function defaultReportPicks(list: HighlightItem[]): number[] {
  return list
    .filter((h) => h.type !== 'ending' && !h.onlyMe && !h.whisper)
    .slice(0, REPORT_HIGHLIGHTS)
    .map((h) => h.logId);
}

/** 掷骰统计：一共几次检定，各种结果各几次（暗骰、敌人的攻击不算）。 */
export type RollTally = { total: number; counts: Record<Outcome, number> };

/** 战报卡片要的数据：全部按看的人自己的视角算（别人的私密记录、暗骰都不算进来）。 */
export type ReportData = {
  room: { id: number; name: string; status: 'preparing' | 'running' | 'paused' | 'ended' };
  scenario: { title: string; category: ScenarioCategory | null } | null;
  /** 开局（开场那一段写下）的时间；还没开局是 null。 */
  startedAt: number | null;
  /** 结束的时间；还没结束是 null（玩了多久算到 now）。 */
  endedAt: number | null;
  /** 服务器的当前时间。 */
  now: number;
  /** 回合模式下结算过几轮（一直是计时模式的是 0）。 */
  rounds: number;
  /** 看得到的行动结果有几次，其中自己的角色几次。 */
  actions: { total: number; mine: number };
  /** 这一局的角色（只有这一局成员的角色，AI 演的队友不算）。 */
  characters: { name: string; roleName: string; playerName: string; mine: boolean; dead: boolean }[];
  /** 看得到的检定；mine 是自己的角色掷的（没有角色是 null）。 */
  rolls: { all: RollTally; mine: RollTally | null };
  /** 结局：对局结束了、并且走到了结局才有。 */
  ending: { title: string; epilogue: string } | null;
  /** 自己收藏的名场面（按记录的先后）。 */
  highlights: HighlightItem[];
};

/** 收藏有变化时推给自己开着这一局的页面（别的标签页跟着变）。 */
export type HighlightChange = { roomId: number; logId: number; on: boolean; item?: HighlightItem };
