// 网页剧本编辑器（V0.8.0）：草稿、边写边检查。服务器和网页共用这一份。
// 剧本格式本身见 server/game/scenario.ts（validateScenario）和 docs/scenario-format.md。

/** 剧本文件第一行的格式名（和 server/game/scenario.ts 的 SCENARIO_FORMAT 一样，测试里对过）。 */
export const EDITOR_FORMAT = 'longniang-trpg/scenario@1';

/**
 * 一份剧本（草稿、检查）最多多少个字：整份剧本写成 JSON 以后的长度，和导入剧本的上限一样
 * （server/routes/game.ts 的 SCENARIO_CHECK_MAX，测试里对过）。网页先自己看一下，服务器还会再查。
 */
export const EDITOR_MAX_CHARS = 100_000;

/**
 * 发整份剧本的请求最多多少字节（和 server/routes/game.ts 的 SCENARIO_BODY_LIMIT 一样，测试里对过）：
 * 10 万字的中文剧本写成 JSON 大约 300KB，一般到不了；网页上快到了提示一下。
 */
export const EDITOR_MAX_BYTES = 400 * 1024;

/** 每人最多存几份草稿。 */
export const DRAFTS_MAX = 30;

/** 草稿列表里的标题最多几个字（剧本标题本身最多 40 个字）。 */
export const DRAFT_TITLE_MAX = 40;

/** 编辑页的分区（左边一列，手机上是顶上的一排）。表单盖不到的（地下城那一大块、以后加的字段）只在 JSON 里改。 */
export const EDITOR_SECTIONS = [
  { key: 'basic', name: '基本信息' },
  { key: 'roles', name: '身份' },
  { key: 'locations', name: '地点' },
  { key: 'npcs', name: 'NPC' },
  { key: 'truth', name: '真相' },
  { key: 'clues', name: '线索' },
  { key: 'timeline', name: '时间线' },
  { key: 'worldEvents', name: '世界事件' },
  { key: 'endings', name: '结局' },
  { key: 'items', name: '自定义道具' },
  { key: 'shops', name: '商店' },
  // 5E 模组（V0.9.0）才有：怪物和宝藏
  { key: 'monsters', name: '怪物和宝藏' },
  { key: 'json', name: 'JSON' },
] as const;

export type EditorSection = (typeof EDITOR_SECTIONS)[number]['key'];
export const SECTION_NAME = Object.fromEntries(EDITOR_SECTIONS.map((s) => [s.key, s.name])) as Record<EditorSection, string>;

/** 草稿列表里的一份。title 是空的：剧本还没起名字。 */
export type DraftSummary = { id: number; title: string; createdAt: number; updatedAt: number };
/** 一份草稿：data 是整份剧本（可以还没写完、有错误）。 */
export type Draft = DraftSummary & { data: unknown };

/**
 * 检查出来的一条问题。text 是 validateScenario 原样的报错（「路径：说明」；特别长的截短了）；
 * section、index、key 是在编辑页的哪个分区、第几项（点了跳过去），路径用 problemTarget(text) 算。
 */
export type EditorProblem = {
  level: 'error' | 'warning';
  text: string;
  section: EditorSection;
  index: number | null;
  key: string | null;
};

/** 剧本里有几个身份、地点、线索、结局……（检查结果里给，页面上显示）。 */
export type EditorSummary = {
  roles: number;
  locations: number;
  npcs: number;
  truthPoints: number;
  clues: number;
  coreClues: number;
  timeline: number;
  worldEvents: number;
  endings: number;
  /** 自定义道具（所有剧本都能写）。 */
  items: number;
  /** 商店（只有 5E 模组有）。 */
  shops: number;
  /** 地下城（category 是 dungeon）。 */
  dungeon: boolean;
  /** 5E 模组（rules 是 "5e"，V0.9.0）：几种怪物、几处宝藏。 */
  five: boolean;
  monsters: number;
  treasure: number;
};

/** 一共几个错误、几个提醒。 */
export type ProblemCount = { errors: number; warnings: number };

/**
 * POST /api/editor/validate 的结果：ok 是没有错误（提醒不算），可以用来开局。
 * problems 只列前 PROBLEMS_SHOWN 条（错误在前）；errors、warnings 是总数，sections 是每个分区各有几个。
 */
export type EditorCheck = {
  ok: boolean;
  problems: EditorProblem[];
  errors: number;
  warnings: number;
  sections: Record<EditorSection, ProblemCount>;
  summary: EditorSummary;
};

/** 检查结果里最多列出多少条问题（剩下的只给总数）。 */
export const PROBLEMS_SHOWN = 100;

/** 基本信息分区里的字段（validateScenario 报错路径的第一段）。 */
const BASIC_FIELDS = new Set(['format', 'title', 'category', 'intro', 'author', 'genre', 'tone', 'rules', 'players', 'expectedDays', 'relation', 'stress', 'start', 'safety', 'opening', 'level']);
const LIST_SECTIONS = new Set<string>(['roles', 'locations', 'npcs', 'truth', 'clues', 'timeline', 'worldEvents', 'endings', 'shops']);
/** 5E 模组的怪物（monsters）、宝藏（treasure）在「怪物和宝藏」分区（V0.9.0）。 */
const FIVE_SECTIONS = new Set<string>(['monsters', 'treasure']);

export type ProblemTarget = { path: string; message: string; section: EditorSection; index: number | null; key: string | null };

const sectionOfHead = (head: string): EditorSection =>
  head === 'locationFolders'
    ? 'locations'
    : head === 'customItems'
      ? 'items'
      : BASIC_FIELDS.has(head)
      ? 'basic'
      : LIST_SECTIONS.has(head)
        ? (head as EditorSection)
        : FIVE_SECTIONS.has(head)
          ? 'monsters'
          : 'json';

/** 各分区的文件夹在哪个编辑分区：folders.clues[0].key → clues 分区；points 在「真相」里。 */
const FOLDER_SECTION: Record<string, EditorSection> = {
  roles: 'roles',
  npcs: 'npcs',
  points: 'truth',
  clues: 'clues',
  timeline: 'timeline',
  endings: 'endings',
};

const sectionOfPath = (path: string): EditorSection => {
  const folder = /^folders\.([A-Za-z]+)/.exec(path)?.[1];
  if (folder) return FOLDER_SECTION[folder] ?? 'json';
  return sectionOfHead(/^[A-Za-z]+/.exec(path)?.[0] ?? '');
};

/**
 * 只算分区（和 problemTarget(text).section 一样）：数每个分区有几条问题时用，问题可能有上万条，不用正则、不拆字符串。
 */
export function problemSection(text: string): EditorSection {
  const at = text.indexOf('：');
  if (at < 0) return 'json';
  const rawPath = text.slice(0, at);
  const path = rawPath.startsWith('剧本') ? rawPath.slice(2).replace(/^\./, '') : rawPath;
  return sectionOfPath(path);
}

/**
 * validateScenario 的一条报错是哪个分区、第几项的。报错写成「路径：说明」，比如
 * 「roles[2].name：不能为空」「剧本.title：不能为空」「truth.points「who」：只有一条线索……」；
 * 地下城（dungeon）、敌人（enemies）这些表单里没有的，算在 JSON 分区。
 */
export function problemTarget(text: string): ProblemTarget {
  const at = text.indexOf('：');
  const rawPath = at >= 0 ? text.slice(0, at) : '';
  const message = at >= 0 ? text.slice(at + 1) : text;
  const path = rawPath.startsWith('剧本') ? rawPath.slice(2).replace(/^\./, '') : rawPath;
  const section = sectionOfPath(path);
  const item = /^(?:truth\.points|[A-Za-z]+)\[(\d+)\]/.exec(path);
  const key = /^truth\.points「([^」]*)」/.exec(path);
  return { path, message, section, index: item ? Number(item[1]) : null, key: key ? key[1] : null };
}

/** 新建的空白剧本：字段都在（表单一块块填），内容是空的。规则用第二版（V0.7.0 起新写的剧本都用）。 */
export function blankScenario(): Record<string, unknown> {
  return {
    format: EDITOR_FORMAT,
    title: '',
    category: null,
    intro: '',
    author: '',
    genre: '',
    tone: '',
    rules: 2,
    players: { min: 1, max: 4 },
    expectedDays: 1,
    relation: 'coop',
    stress: false,
    start: { label: '', day: 1, time: '20:00' },
    safety: { avoid: [] },
    opening: { background: '', situation: '', known: [] },
    roles: [],
    locations: [],
    truth: { summary: '', points: [] },
    clues: [],
    npcs: [],
    timeline: [],
    worldEvents: [],
    endings: [],
    customItems: [],
    shops: [],
  };
}
