// 对局进行中，服务器发给网页的数据格式。服务器和网页共用这一份。
import type { PersonaBrief } from './personas';
import type { AttributeKey, Outcome } from './rules';
import type { SpotFlag, SpotView } from './spots';
import type { GearView } from './gear2';
import type { Attributes2, ConsumableKey, DungeonSize, EnemyTier } from './rules2';
import type { Abilities, Ability, Condition5e, Skill } from './5e/core';
import type { AttackOption, Card5eData, ResourceInfo } from './5e/types';
import type { MapView } from './map';

export type { SpotView };

export type Relation = 'coop' | 'secrets' | 'versus';
export const RELATION_LABEL: Record<Relation, string> = { coop: '合作', secrets: '各有秘密', versus: '互相对立' };

/**
 * 剧本分区（V0.5.0）：每个剧本归一个分区，每个分区对应一项属性。玩完一个剧本，宠物在这个分区对应的属性上成长。
 * hint 是写给 AI 的：生成剧本时这一类剧本的重点放在哪里。
 */
export const SCENARIO_CATEGORIES = [
  { key: 'puzzle', name: '解谜', attribute: 'intellect', hint: '重点是查线索、推理出真相' },
  { key: 'horror', name: '恐怖', attribute: 'perception', hint: '重点是气氛和心理压力，察觉不对劲的地方，可以打开心智规则' },
  { key: 'combat', name: '战斗', attribute: 'body', hint: '重点是冲突和打斗，危险要真实，也要给玩家选择和退路' },
  { key: 'adventure', name: '冒险', attribute: 'agility', hint: '重点是赶路、探索、躲藏和追逐' },
  { key: 'social', name: '交涉', attribute: 'charm', hint: '重点是和各方人物周旋：谈判、拉拢、试探和欺瞒' },
  // V0.7.0：地下城用规则第二版（生命值、战斗、装备），只能用自带角色卡，能反复刷
  { key: 'dungeon', name: '地下城', attribute: 'body', hint: '用规则第二版：探索、战斗、找宝物、打首领；只能带自带角色卡进去，能反复刷' },
] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number]['key'];
export const CATEGORY_KEYS = SCENARIO_CATEGORIES.map((c) => c.key) as ScenarioCategory[];
export const CATEGORY_NAME = Object.fromEntries(SCENARIO_CATEGORIES.map((c) => [c.key, c.name])) as Record<ScenarioCategory, string>;
export const CATEGORY_ATTRIBUTE = Object.fromEntries(SCENARIO_CATEGORIES.map((c) => [c.key, c.attribute])) as Record<ScenarioCategory, AttributeKey>;
/** 自带剧本的作者。 */
export const SITE_AUTHOR = '龙娘跑团';

/** 剧本列表里给人看的部分，不含任何秘密。 */
export type ScenarioSummary = {
  key: string;
  title: string;
  genre: string;
  tone: string;
  players: { min: number; max: number };
  expectedDays: number;
  relation: Relation;
  stress: boolean;
  startLabel: string;
  /** 分区；老剧本没写的是 null。 */
  category: ScenarioCategory | null;
  /** 简介：给挑剧本的人看，不剧透。没写的是空字符串。 */
  intro: string;
  /** 剧本文件里写的作者（自带的是「龙娘跑团」）；没写的是空字符串。用户投稿的作者另外给。 */
  author: string;
  /** 一共几个结局（V0.6.0，结局图鉴用；不剧透结局是什么）。 */
  endingCount: number;
  /** 地下城（V0.7.0）：固定的难度 1～10、小型还是大型；别的剧本是 null。 */
  dungeon: { level: number; size: DungeonSize } | null;
  /** 用哪套规则（V0.9.0）：1、2 是龙娘规则的第一、二版，'5e' 是 5E 规则。 */
  rules: 1 | 2 | '5e';
  /** 5E 模组（V0.9.0）：建议几级的角色；别的剧本是 null。 */
  module5e: { level: number } | null;
};

/** 剧本里的一个身份：公开介绍和固定的属性、专长、外貌（选的时候就看得到，不能改）。秘密和目标选了以后才看得到。 */
export type RoleChoice = {
  key: string;
  name: string;
  public: string;
  suggestedSpecialties: string[];
  /** 第一版是五项（AttributeKey），第二版是七项（Attribute2，V0.7.0）；地下城的身份没有（玩家带自己的卡）。 */
  attributes: Record<string, number>;
  specialties: string[];
  appearance: string;
  /** 已经被谁选走（角色名），没人选是 null。交给 AI 演的身份（V0.8.0）是 AI 队友的名字，见 GameState.companions。 */
  takenBy: string | null;
  mine: boolean;
  /** 用 5E 规则玩普通剧本（V1.0.0 5E mod）：这个身份转成的 5E 角色；别的剧本没有。 */
  pregen5e?: Pregen5eView | null;
};

/** 身份转成的 5E 角色（V1.0.0 5E mod），选身份时看的：职业、属性、生命值、AC、技能、攻击、法术。 */
export type Pregen5eView = {
  className: string;
  subclassName: string | null;
  speciesName: string;
  backgroundName: string;
  level: number;
  hpMax: number;
  ac: number;
  abilities: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  skills: string[];
  attacks: string[];
  spells: string[];
};

/** AI 补位（V0.8.0）：房主交给 AI 演的身份。主持人顺带演，跟着大家走，不是玩家的角色。 */
/** persona（V1.1.0 AI 大厅）：请了 AI 角色来演的，是它请进来时的名字、简介和作者（自己演，每一轮自己交行动）；主持人顺带演的是 null。 */
/** class5e（V1.2.0）：5E 对局里 AI 队友的「种族·职业 N 级」，别的对局是 null。 */
export type Companion = { roleKey: string; roleName: string; name: string; class5e?: string | null; persona: PersonaBrief | null };

/** 和你在同一个地点的 AI 队友（V1.1.0）：persona 是请了 AI 角色来演的。 */
export type NearbyCompanion = { roleKey: string; name: string; roleName: string; persona: boolean };

export type Condition = { name: string; effect: string; penalty: number };

export type PlaceInfo = {
  key: string;
  name: string;
  description: string;
  exits: { key: string; name: string; minutes: number }[];
  /** 站位（V1.0.x）：剧本给这个地点写的站位和属性；flags 是整个地点的属性（嘈杂、昏暗）。 */
  spots: SpotView[];
  flags: SpotFlag[];
};


export type MyCharacter = {
  id: number;
  name: string;
  roleKey: string;
  roleName: string;
  rolePublic: string;
  roleSecret: string;
  roleGoal: string;
  attributes: Record<AttributeKey, number>;
  specialties: string[];
  appearance: string;
  goal: string;
  wounds: number;
  stress: number;
  conditions: Condition[];
  items: string[];
  location: PlaceInfo | null;
  /** 站位（V1.0.x）：在这个地点里站在哪；null 是在大家中间。 */
  spot: string | null;
  visited: PlaceInfo[];
  dead: boolean;
  /** 现在不能行动的原因，能行动时是 null。 */
  blocked: string | null;
  /** 带进这一局的宠物（V0.5.0，只陪伴）。 */
  pet: PetCompanion | null;
  /** 宠物出手（V0.6.0）：ready 这一局还没用过，used 用过了；没带宠物是 null。 */
  petHelp: 'ready' | 'used' | null;
  /** 用哪张自带角色卡建的（V0.6.0；用身份自带的角色是 null）；卡上写的背景。 */
  cardId: number | null;
  background: string;
  /** 地下城里的角色（规则第二版，V0.7.0）；别的剧本是 null（用上面的 attributes、wounds、stress）。 */
  v2: Character2View | null;
  /** 5E 模组里的角色（V0.9.0）；别的剧本是 null。 */
  v5: Character5eView | null;
};

/** 5E 模组里自己角色的状态（V0.9.0）：卡上的数值（进来时的样子）和这一局的生命值、法术位、能力、状态、物品。 */
export type Shop5eView = {
  key: string;
  name: string;
  description: string;
  locationName: string | null;
  /** 游说调整后的收购价比例（0 表示不收购）。 */
  sellRate: number;
  /** 商店自己的基础收购比例。 */
  baseSellRate: number;
  /** 角色的游说调整值。 */
  persuasion: number;
  items: { key: string; name: string; basePrice: number; price: number; description: string }[];
};

export type Character5eView = {
  cardId: number;
  /** 自己卡上的完整选择，局内升级时拿来打开编辑器。 */
  cardData: Card5eData;
  level: number;
  xp: number;
  xpStart: number;
  xpNext: number | null;
  /** 经验够升下一级，且这一版内容还支持下一级。 */
  levelUpReady: boolean;
  speciesName: string;
  className: string;
  subclassName: string | null;
  backgroundName: string;
  /** 牧师信仰的神祇名字；别的职业是 null。 */
  deityName: string | null;
  /** 图腾武者的图腾精魄名字；别的子职是 null。 */
  totemName: string | null;
  /** 正在看的商店；主持人用 open_shop 打开，玩家在这里买。 */
  shop: Shop5eView | null;
  hp: number;
  hpMax: number;
  tempHp: number;
  ac: number;
  speed: number;
  initiative: number;
  pb: number;
  passivePerception: number;
  /** 穿着让隐匿检定有劣势的护甲时，护甲的名字（V0.9.0）。 */
  stealthDis: string | null;
  abilities: Abilities;
  mods: Abilities;
  /** 熟练的豁免。 */
  saves: Ability[];
  skills: { key: Skill; mod: number; prof: 0 | 0.5 | 1 | 2 }[];
  hitDice: { left: number; max: number; die: number };
  /** 倒地时的死亡豁免；没倒地、已经稳定是 null。 */
  death: { success: number; failure: number } | null;
  stable: boolean;
  conditions: { key: Condition5e; note: string }[];
  exhaustion: number;
  effects: { name: string; note: string; conc: boolean }[];
  concentration: string | null;
  inspiration: boolean;
  bardicDie: number | null;
  /** 荒野变形成了什么（野兽的名字）。 */
  wildShape: string | null;
  attacks: AttackOption[];
  spell: {
    dc: number;
    attack: number;
    slots: { level: number; left: number; max: number }[];
    pact: { level: number; left: number; max: number } | null;
    cantrips: { key: string; name: string }[];
    prepared: { key: string; name: string; level: number }[];
    free: { key: string; name: string; left: number; max: number }[];
  } | null;
  resources: (Pick<ResourceInfo, 'key' | 'name' | 'max' | 'recover'> & { left: number })[];
  features: { name: string; source: string }[];
  /** 身上装备的槽位。 */
  equipment: {
    armor: string | null;
    shield: string | null;
    main: string | null;
    off: string | null;
    feet: string | null;
    ring1: string | null;
    ring2: string | null;
    necklace: string | null;
  };
  inventory: {
    key: string;
    name: string;
    qty: number;
    equipped: boolean;
    /** 能不能装备、装到哪个槽；普通杂物是 null。 */
    kind: 'weapon' | 'armor' | 'shield' | 'custom-weapon' | 'custom-equipment' | null;
    slot: 'body' | 'feet' | 'ring' | 'necklace' | null;
    /** 武器是不是双手（副手不能放）。 */
    twoHanded: boolean;
    description?: string;
    /** 自定义道具的价值（金币）；普通物品没有。 */
    value?: number;
  }[];
  /** 钱（铜币）。 */
  money: number;
  /** 这一局得到的东西、钱：现在身上比进模组时多出来的（拿到又用掉了的不算；活着打完剧本大厅里的模组才带得走）。 */
  gained: { name: string; qty: number }[];
  gainedMoney: number;
};

/** 5E 的战斗（和你在同一个地点的，V0.9.0）：第几轮、先攻、敌人。 */
export type Fight5eView = {
  round: number;
  /** spot：站位（V1.0.x），null 是在大家中间。 */
  order: { name: string; side: 'ally' | 'enemy'; initiative: number; acted: boolean; down: boolean; spot: string | null }[];
  monsters: { id: string; name: string; hp: number; hpMax: number; conditions: string[]; defeated: boolean; fled?: boolean; spot: string | null }[];
};

/** 地下城里自己角色的状态（规则第二版）。 */
export type Character2View = {
  attributes: Attributes2;
  hp: number;
  hpMax: number;
  mp: number;
  mpMax: number;
  /** 濒死：还剩几次（同一地点再结算几次行动没人救就死）；没倒下是 null。 */
  dying: number | null;
  /** 精神值到了 0：下一次行动失控。 */
  lostControl: boolean;
  /** 防御：敌人要掷到这个数才打得中。 */
  defense: number;
  /** 穿着的装备。 */
  gear: GearView[];
  /** 带进来的道具（还剩几个）。 */
  bag: Partial<Record<ConsumableKey, number>>;
  /** 这一局捡到的东西：活着出去才能带走。 */
  loot: LootView[];
  /** 会的技能。 */
  skills: { key: string; name: string; cost: number; text: string }[];
  /** 同伴给的加成（下一次检定或攻击）、这场战斗多的护甲。 */
  boost: number;
  ward: number;
};

/** 地下城里捡到的一样东西。 */
export type LootView =
  | { kind: 'gear'; gear: GearView }
  | { kind: 'item'; item: ConsumableKey; name: string; count: number }
  | { kind: 'crystals'; amount: number }
  | { kind: 'manual'; name: string };

/** 地下城的局面（规则第二版，V0.7.0）：难度、人数减值、战斗。 */
export type DungeonView = {
  level: number;
  size: DungeonSize;
  /** 是地下城（别的规则第二版剧本也有这一项，难度按 1 算、没有道具和宝物）。 */
  isDungeon: boolean;
  /** 打完算成绩（成长点、带出来的东西、宝箱、通关记录）：剧本大厅里的地下城算，自己导入的、AI 写的不算。 */
  ranked: boolean;
  /** 所有检定一共减多少（难度和大型少人的减值加起来，是负数或 0）。 */
  penalty: number;
  /** 正在打的仗（和你在同一个地点的）；没在打是 null。 */
  combat: CombatView | null;
};

export type CombatView = {
  /** 先后手：从先到后（角色、敌人混在一起）。spot：站位（V1.0.x），null 是在大家中间；down：倒下了。 */
  order: { name: string; side: 'ally' | 'enemy'; initiative: number; spot: string | null; down: boolean }[];
  enemies: EnemyView[];
};

export type EnemyView = {
  id: string;
  name: string;
  tier: EnemyTier;
  hp: number;
  hpMax: number;
  /** 不再参战：倒下了，或者逃走、投降了（fled）。 */
  defeated: boolean;
  fled?: boolean;
  /** 首领的护盾还在：打不动，要大家配合破开。 */
  shielded: boolean;
  /** 站位（V1.0.x），null 是在大家中间。 */
  spot: string | null;
};

/** 带进剧本的宠物：带进来那一刻的名字和介绍。 */
export type PetCompanion = { name: string; description: string };

// ---------- 主持风格（V0.6.0） ----------

export type StyleVoice = 'default' | 'classical' | 'plain' | 'cold' | 'lively';
export type StyleDifficulty = 'easy' | 'normal' | 'hard';
export type StyleLanguage = 'zh' | 'ja' | 'en';

/** 房主选的主持风格：文风、难度、角色会不会死、主持用的语言。 */
export type RoomStyle = { voice: StyleVoice; difficulty: StyleDifficulty; death: boolean; language: StyleLanguage };

export const DEFAULT_STYLE: RoomStyle = { voice: 'default', difficulty: 'normal', death: true, language: 'zh' };
export const VOICE_LABEL: Record<StyleVoice, string> = { default: '默认', classical: '古风', plain: '白话', cold: '冷峻', lively: '轻快' };
export const DIFFICULTY_LABEL: Record<StyleDifficulty, string> = { easy: '宽松', normal: '标准', hard: '严酷' };
export const LANGUAGE_LABEL: Record<StyleLanguage, string> = { zh: '中文', ja: '日语', en: '英语' };
/** 朗读用的语音（浏览器的语言代码）。 */
export const LANGUAGE_SPEECH: Record<StyleLanguage, string> = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' };

/** 读出存着的主持风格（JSON），没写的、不认识的按默认。 */
export function parseStyle(text: string | null | undefined): RoomStyle {
  let v: Partial<Record<keyof RoomStyle, unknown>> = {};
  try {
    v = (JSON.parse(text || '{}') ?? {}) as typeof v;
  } catch {
    v = {};
  }
  const pick = <T extends string>(x: unknown, labels: Record<T, string>, d: T): T => (typeof x === 'string' && x in labels ? (x as T) : d);
  return {
    voice: pick(v.voice, VOICE_LABEL, DEFAULT_STYLE.voice),
    difficulty: pick(v.difficulty, DIFFICULTY_LABEL, DEFAULT_STYLE.difficulty),
    death: typeof v.death === 'boolean' ? v.death : DEFAULT_STYLE.death,
    language: pick(v.language, LANGUAGE_LABEL, DEFAULT_STYLE.language),
  };
}

export type OtherCharacter = {
  id: number;
  userId: number;
  playerName: string;
  name: string;
  roleName: string;
  rolePublic: string;
  appearance: string;
  dead: boolean;
  /** 带着的宠物的名字（V0.5.0）。 */
  petName: string | null;
  /** 5E 角色（V0.9.0）：种族、职业、等级；别的剧本是 null。 */
  class5e: string | null;
};

export type ActionStatus = 'waiting' | 'resolving' | 'done' | 'withdrawn' | 'failed';

export type MyAction = {
  id: number;
  content: string;
  mode: 'timed' | 'round';
  status: 'waiting' | 'resolving' | 'failed';
  submittedAt: number;
  /** 计时模式下出结果的时间（现实时间）；还在估算耗时时是 null。 */
  dueAt: number | null;
  /** 游戏里要花多少分钟；还在估算时是 null。 */
  gameMinutes: number | null;
  estimateNote: string | null;
  error: string | null;
  /** 被 Anthropic 的安全机制拒绝了：不能重试，只能撤回重写。 */
  refused: boolean;
  /** 悄悄做：同一地点的人看不到交了什么。 */
  secret: boolean;
  /** 这是在协助谁（角色名）；不是协助是 null。 */
  assisting: string | null;
  /** 勾了「让宠物帮一把」（V0.6.0）。 */
  petHelp: boolean;
};

/** 同一地点的其他角色，和他们交了还没出结果的行动（悄悄做的看不到内容）。 */
export type NearbyCharacter = {
  id: number;
  name: string;
  roleName: string;
  /** 站位（V1.0.x）：null 是在大家中间。同一个站位的才是身边的人（悄悄话只能说给他们）。 */
  spot: string | null;
  action: {
    id: number;
    /** 悄悄做的是 null。 */
    content: string | null;
    status: 'waiting' | 'resolving';
    /** 他这个行动是在协助谁（角色名）。 */
    assisting: string | null;
    /** 谁在协助这个行动（角色名）。 */
    assistedBy: string[];
    /** 你现在能协助它。 */
    canAssist: boolean;
  } | null;
};

/** from：这条线索是谁告诉你的（角色名），自己找到的是 null。 */
export type ClueCard = { key: string; title: string; content: string; gameTime: number | null; from: string | null };

export type GameState = {
  /** 服务器的当前时间，网页用它校正倒计时。 */
  now: number;
  /** 不是这一局的成员，只是在观看（只看得到故事，看不到谁的角色卡、线索）。 */
  watching: boolean;
  /** 能管这一局：房主，或者有「管理所有对局」权限的管理员、站长。 */
  manager: boolean;
  scenario:
    | (ScenarioSummary & {
        source: 'builtin' | 'generated' | 'imported';
        /** 房主看过完整剧本（包括真相）。 */
        revealed: boolean;
        /**
         * 这个剧本能不能、有没有用 5E 规则玩（V1.0.0 5E mod）：on 是正在用（身份、检定都转成了 5E），
         * off 是能转（普通剧本），null 是不用转（地下城、本来就是 5E 的模组）。
         */
        mod5e: 'on' | 'off' | null;
        opening: { background: string; situation: string; known: string[] };
        roles: RoleChoice[];
      })
    | null;
  /** 游戏时钟：minutes 是 now 那一刻的游戏分钟数（从第1天0点算起）；running 时按 minutesPerMs 往前走。 */
  clock: { minutes: number; running: boolean; minutesPerMs: number } | null;
  mode: 'round' | 'timed';
  /** 主持风格（V0.6.0）。 */
  style: RoomStyle;
  /** 规则第二版的局面（V0.7.0：难度、减值、战斗）；第一版的剧本是 null。 */
  dungeon: DungeonView | null;
  /** 5E 模组（V0.9.0）：你所在地点正在打的仗；没在打、别的剧本是 null。 */
  fight5e: Fight5eView | null;
  /**
   * 回合模式下这一轮的情况：已经提交的角色、还在等的角色、是否正在结算；
   * noCredit 是 AI 额度用完、交不了行动，所以这一轮不等的角色。
   */
  round: { number: number; submitted: number[]; waitingFor: number[]; resolving: boolean; noCredit: number[] } | null;
  me: MyCharacter | null;
  /** 自己的宠物（选身份时可以带上，V0.5.0）；没养是 null。 */
  myPet: PetCompanion | null;
  others: OtherCharacter[];
  /** 交给 AI 演的身份（V0.8.0 AI 补位），按剧本里身份的顺序。 */
  companions: Companion[];
  /** 和你在同一个地点、还活着的 AI 队友（V1.1.0；你没有角色、不在任何地点时是空的）。 */
  nearbyCompanions: NearbyCompanion[];
  /**
   * 地图（V1.0.x）：开局以后成员看得到自己（合作的剧本里一队人）走过的那一部分；对局结束了、不在这一局里玩的管理员看整张。
   * 准备阶段、没有角色的观看者是 null。
   */
  map: MapView | null;
  myAction: MyAction | null;
  /** 和你在同一个地点的其他角色（你没有角色、不在任何地点时是空的）。 */
  nearby: NearbyCharacter[];
  clues: ClueCard[];
  /** 主持人正在结算谁的行动（角色名）。 */
  resolving: string[];
  ending: { title: string; epilogue: string; truth: string } | null;
  /** 这一局到现在花了多少美元，只给房主（和能管这一局的管理员）看。 */
  cost: number | null;
  /** 你自己的 AI 额度。 */
  credit: Credit;
  /** AI 能不能用；不能用时说明原因（比如还没设置 API 密钥）。 */
  ai: { ready: boolean; message: string | null };
  /** 这一局的主持用哪个模型：chosen 是房主选的（null 是跟随网站设置），current 是现在实际用的，siteDefault 是网站的设置。 */
  /**
   * 主持模型：chosen 房主选的（null 是跟随网站设置），current 现在实际用的，siteDefault「跟随网站设置」时用的。
   * options 只有这一局房主的身份能用的模型（站长在「管理」→「AI」里按身份设）。
   */
  dmModel: { chosen: string | null; current: string; siteDefault: string; options: ModelOption[] };
};

/** 能选的模型：名字、一句说明、每百万 token 的输入和输出价格（美元）。available：那家的 API 密钥设置了，能选。 */
export type ModelOption = { model: string; name: string; note: string; price: { input: number; output: number } | null; available: boolean };

// ---------- 每人的 AI 额度 ----------

/** spent 已经用掉的（美元），total 管理员发放的总额；unlimited 不限时 remaining 是 null。 */
export type Credit = { spent: number; total: number; unlimited: boolean; remaining: number | null };

// ---------- AI 生成剧本、导入文本剧本 ----------

/** 房主让 AI 生成剧本时填的要求。relation 是 auto 表示交给 AI 决定。 */
export type GenerateScenarioInput = {
  /** 分区（V0.5.0）。 */
  category: ScenarioCategory;
  genre: string;
  tone: string;
  players: number;
  days: number;
  relation: Relation | 'auto';
  avoid: string;
  want: string;
};

/** outline 写大纲、details 写细节、converting 转换文本、checking 程序检查、fixing 让 AI 改、saving 存下来。 */
export type ScenarioJobStep = 'outline' | 'details' | 'converting' | 'checking' | 'fixing' | 'saving';

export type ScenarioJobView = {
  id: number;
  kind: 'generate' | 'convert';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  step: ScenarioJobStep | null;
  /** 让 AI 改了几次。 */
  fixRound: number;
  /** 这一步 AI 已经写了多少字（思考和正文都算），给等的人看个进度。 */
  chars: number;
  error: string | null;
  /** 完成以后给房主的提醒（只有导入的剧本有；生成的剧本为了不剧透，不列）。 */
  notes: string[];
  /** 谁发起的（显示名）。 */
  by: string;
  startedAt: number;
  finishedAt: number | null;
};

// ---------- “我的对局”里每一局的待办 ----------

export type RoomTodo = {
  /**
   * 开局前要做的事：pick-scenario 房主还没选剧本、wait-scenario 等房主选剧本、generating AI 正在生成剧本、make-character 你还没建角色
   * （开局以后还没建角色的也是这个）、wait-players 还没有人建角色、start 可以开局了（房主）、wait-start 等房主开局。没有要做的是 null。
   */
  setup: 'pick-scenario' | 'wait-scenario' | 'generating' | 'make-character' | 'wait-players' | 'start' | 'wait-start' | null;
  /** 你交了还没出结果的行动。 */
  action: { status: MyAction['status']; mode: MyAction['mode']; dueAt: number | null; refused: boolean } | null;
  /** 现在可以交新的行动（进行中、角色还能行动、没有在等结果的行动）。 */
  canAct: boolean;
  /** 上次离开以后：你的行动出了几个结果、你的角色知道的新进展有几条、别人发了几条场外聊天。正开着这一局时都是 0。 */
  newResults: number;
  newStory: number;
  newChat: number;
};

// ---------- 你不在时发生了什么 ----------

/** 离开期间的一件事：label 是一句话的标题，text 是节选。 */
export type CatchupItem = { id: number; gameTime: number | null; label: string; text: string };

export type Catchup = {
  /** 上次离开这一局的时间；从没离开过是 null。 */
  since: number | null;
  /** 离开时看到的最后一条记录，比它新的就是“你不在时发生的事”；从没离开过是 null。 */
  afterId: number | null;
  /** 算到哪一条为止（打开页面那一刻最新的一条）；没有新的事是 null。 */
  untilId: number | null;
  /** 新发生的事；多的时候只列最近几件。 */
  items: CatchupItem[];
  /** 没列出来的更早的事还有几件。 */
  more: number;
  /** 这期间别人发的场外聊天条数。 */
  chatCount: number;
  /** 事情多时 AI 写的摘要；还在写时是 null，summarizing 是 true。 */
  summary: string | null;
  summarizing: boolean;
};

// ---------- 对局记录里附带的结构化数据 ----------

export type RollCard = {
  who: string;
  reason: string;
  attribute: string;
  dice: [number, number];
  parts: { label: string; value: number }[];
  total: number;
  outcome: Outcome;
  /** 对抗检定时对方的情况。 */
  versus?: { who: string; dice: [number, number]; parts: { label: string; value: number }[]; total: number; outcome: Outcome; skin?: string | null };
  winner?: 'a' | 'b' | 'tie';
  /** 掷骰的人用的骰子皮肤（V0.6.0；普通的是 null，以前的记录没有这一项）。 */
  skin?: string | null;
  /**
   * 宠物出手（V0.6.0）：第一次没成，宠物帮着重掷了一次。上面的 dice、parts、total、outcome（对抗时还有 winner）是重掷以后的，
   * first 是第一次的。
   */
  petHelp?: { pet: string; first: { dice: [number, number]; total: number; outcome: Outcome; winner?: 'a' | 'b' | 'tie' } };
  /**
   * 战斗（V0.7.0）：attack 是角色打敌人（target 敌人的名字），enemy 是敌人打角色（who 是敌人，target 是角色）。
   * hit 打中没有；damage 扣了几点生命值（护甲减过的）；weakness 用上了首领的弱点；armor 护甲挡掉了几点。
   */
  combat?: { kind: 'attack' | 'enemy'; target: string; defense: number; hit: boolean; damage: number | null; weakness?: boolean; armor?: number };
  /**
   * 5E（V0.9.0）：d20 检定。有这一项时上面的 dice 是 [留下的那颗 d20, 0]，看这里的：kind 是哪种检定，rolls 掷出的一颗或两颗（优势、劣势），
   * target 是要达到的 DC 或 AC（对抗、没给 DC 的检定是 null），success 成没成（不判断的是 null），crit 重击（攻击掷到 20），
   * damage 攻击、法术造成的伤害（合计和类型）。
   */
  d20?: {
    kind: 'check' | 'save' | 'attack' | 'death' | 'contest' | 'initiative';
    rolls: number[];
    mode: 'normal' | 'advantage' | 'disadvantage';
    target: number | null;
    success: boolean | null;
    crit?: boolean;
    damage?: { total: number; type: string } | null;
    note?: string;
  };
};

export type LogData =
  | { type: 'opening'; title: string; background: string; situation: string; known: string[] }
  | { type: 'role'; roleName: string; secret: string; goal: string; location: string }
  | {
      type: 'resolution';
      actor: string;
      action: string;
      gameStart: number;
      gameEnd: number;
      rolls: RollCard[];
      /** 只包含看的人自己拿到的线索。 */
      clues: { key: string; title: string }[];
      /** 只包含看的人自己角色的变化，比如“伤势：轻伤 → 重伤”。 */
      changes: string[];
      /** 悄悄做的行动：只有行动的人自己看得到这段叙述。 */
      secret?: boolean;
      /** 地下城里大家都看得到的战况（V0.7.0）：开打、先后手、敌人倒下、用了道具、捡到东西。 */
      events?: string[];
      /** 和这个行动一起结算的 AI 角色的行动（V1.1.0 AI 大厅）：它自己交的。 */
      companions?: { name: string; action: string }[];
    }
  | { type: 'private'; gameTime: number | null }
  /** 有人把线索告诉了别人：只有分享的人和收到的人看得到。 */
  | { type: 'share'; from: string; to: string[]; clue: { key: string; title: string } }
  | { type: 'ending'; title: string; epilogue: string; truth: string }
  | { type: 'question' }
  | { type: 'answer' }
  /** 角色当面说的话（对白）：同一地点的角色都听得到；to 不是空的是悄悄话，只有对方听得到。 */
  | { type: 'say'; speaker: string; to: string | null }
  /** 把东西交给同一地点的另一个角色。 */
  | { type: 'give'; from: string; to: string; item: string }
  /** 身边的人看到的一个小动作（V1.0.x 站位）：两个人在说悄悄话（听不到内容）。只给看到的人。 */
  | { type: 'aside' }
  /** 世界事件（剧本 worldEvents）：写进所有人的记录，moved 是被强行移动的角色名。 */
  | { type: 'world-event'; key: string; location: string; moved: string[] };

// ---------- 游戏时间 ----------

/** 游戏时间（从第1天0点起的分钟数）写成“第2天 08:05”。 */
export function formatGameTime(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const day = Math.floor(m / 1440) + 1;
  const hh = String(Math.floor((m % 1440) / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `第${day}天 ${hh}:${mm}`;
}

/** 时长写成“20分钟”“1小时30分钟”“2天3小时”。 */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}分钟`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (days > 0) return hours ? `${days}天${hours}小时` : `${days}天`;
  return mins ? `${hours}小时${mins}分钟` : `${hours}小时`;
}
