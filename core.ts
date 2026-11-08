// 5E 规则（V0.9.0）的基本定义：属性、技能、状态、伤害类型、骰子、熟练加值。服务器和网页共用。
// 规则来自 SRD 5.2.1（CC-BY-4.0，见 SRD_ATTRIBUTION），中文是本站自己翻译、改写的。只做 1～5 级。

/** SRD 5.2.1 要求的署名（原文照登，不能改）；中文说明另写在 SRD_NOTE。 */
export const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
export const SRD_NOTE = '本站的 5E 规则内容译自 SRD 5.2.1，有删改：只收 1～5 级用得到的部分，并按网站的玩法改写了一些说法。';
export const SRD_UPDATE_NOTE = 'V1.3.2 以 DND Player’s Handbook《龙与地下城第五册》进行了优化和更新，并按照网站玩法略做修改。';

/** 5E 角色等级上限。内容会慢慢补，等级先统一开到 20。 */
export const LEVEL_MAX_5E = 20;
/** 5E 模组建议等级上限，和角色等级上限一起开到 20。 */
export const MODULE_LEVEL_MAX = 20;

/** 所有职业的等级上限都先开到 20；具体 6～20 级内容再逐职业补。 */
export function maxLevelFor(_classKey: string): number {
  return LEVEL_MAX_5E;
}

/** 1～20 级每级起始经验值（第 1 级 0）。等级上限已开到 20；6～20 级职业内容逐步补。 */
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
] as const;

export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.min(XP_THRESHOLDS.length, Math.floor(level)));
  return XP_THRESHOLDS[n - 1];
}

/** 下一级的起始经验；已经 20 级是 null。 */
export function nextLevelXp(level: number): number | null {
  return level >= XP_THRESHOLDS.length ? null : XP_THRESHOLDS[level];
}

/** 这个经验值够升到几级（不自动升级，只用来算进度和能不能点升级）。 */
export function levelForXp(xp: number): number {
  let out = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) if (xp >= XP_THRESHOLDS[i]) out = i + 1;
  return out;
}
/** 普通剧本用 5E 规则玩（V1.0.0 5E mod）时，每个身份转成的角色几级。 */
export const MOD5E_LEVEL = 3;

// ---------- 属性 ----------

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];
export type Abilities = Record<Ability, number>;
export const ABILITY_NAME: Record<Ability, string> = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };

export function isAbility(x: unknown): x is Ability {
  return typeof x === 'string' && (ABILITIES as readonly string[]).includes(x);
}

/** 属性调整值：(值 − 10) ÷ 2 往下取整。 */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${-n}`;
}

/** 熟练加值：1～4 级 +2，5～8 级 +3。 */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/** 做卡时的六项属性：标准数组，或者 27 点购点（每项 8～15）。 */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;
export const POINT_BUY_TOTAL = 27;
export const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
/** 背景、属性值提升以后，一项属性最高到 20。 */
export const ABILITY_SCORE_MAX = 20;

// ---------- 技能 ----------

export const SKILLS = [
  { key: 'athletics', name: '运动', ability: 'str' },
  { key: 'acrobatics', name: '体操', ability: 'dex' },
  { key: 'sleight-of-hand', name: '巧手', ability: 'dex' },
  { key: 'stealth', name: '隐匿', ability: 'dex' },
  { key: 'arcana', name: '奥秘', ability: 'int' },
  { key: 'history', name: '历史', ability: 'int' },
  { key: 'investigation', name: '调查', ability: 'int' },
  { key: 'nature', name: '自然', ability: 'int' },
  { key: 'religion', name: '宗教', ability: 'int' },
  { key: 'animal-handling', name: '驯兽', ability: 'wis' },
  { key: 'insight', name: '洞悉', ability: 'wis' },
  { key: 'medicine', name: '医药', ability: 'wis' },
  { key: 'perception', name: '察觉', ability: 'wis' },
  { key: 'survival', name: '求生', ability: 'wis' },
  { key: 'deception', name: '欺瞒', ability: 'cha' },
  { key: 'intimidation', name: '威吓', ability: 'cha' },
  { key: 'performance', name: '表演', ability: 'cha' },
  { key: 'persuasion', name: '游说', ability: 'cha' },
] as const satisfies readonly { key: string; name: string; ability: Ability }[];
export type Skill = (typeof SKILLS)[number]['key'];
export const SKILL_KEYS = SKILLS.map((s) => s.key) as Skill[];
export const SKILL_NAME = Object.fromEntries(SKILLS.map((s) => [s.key, s.name])) as Record<Skill, string>;
export const SKILL_ABILITY = Object.fromEntries(SKILLS.map((s) => [s.key, s.ability])) as Record<Skill, Ability>;

export function isSkill(x: unknown): x is Skill {
  return typeof x === 'string' && (SKILL_KEYS as string[]).includes(x);
}

// ---------- 语言（背景可选语言用） ----------

export const LANGUAGES = [
  { key: 'common', name: '通用语' },
  { key: 'dwarvish', name: '矮人语' },
  { key: 'elvish', name: '精灵语' },
  { key: 'giant', name: '巨人语' },
  { key: 'gnomish', name: '侏儒语' },
  { key: 'goblin', name: '地精语' },
  { key: 'halfling', name: '半身人语' },
  { key: 'orc', name: '兽人语' },
] as const;
export type LanguageKey = (typeof LANGUAGES)[number]['key'];
export const LANGUAGE_KEYS = LANGUAGES.map((l) => l.key) as LanguageKey[];
export const LANGUAGE_NAME = Object.fromEntries(LANGUAGES.map((l) => [l.key, l.name])) as Record<LanguageKey, string>;

export function isLanguage(x: unknown): x is LanguageKey {
  return typeof x === 'string' && (LANGUAGE_KEYS as string[]).includes(x);
}

// ---------- 状态、伤害类型 ----------

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;
export type Condition5e = (typeof CONDITIONS)[number];
export const CONDITION_NAME: Record<Condition5e, string> = {
  blinded: '目盲',
  charmed: '魅惑',
  deafened: '耳聋',
  exhaustion: '力竭',
  frightened: '恐慌',
  grappled: '被擒抱',
  incapacitated: '失能',
  invisible: '隐形',
  paralyzed: '麻痹',
  petrified: '石化',
  poisoned: '中毒',
  prone: '倒地',
  restrained: '束缚',
  stunned: '震慑',
  unconscious: '昏迷',
};
export function isCondition(x: unknown): x is Condition5e {
  return typeof x === 'string' && (CONDITIONS as readonly string[]).includes(x);
}
/** 力竭最多几级：到 6 级死亡。每一级 d20 检定 −2、速度 −5 尺（2024 版）。 */
export const EXHAUSTION_MAX = 6;

export const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
export const DAMAGE_NAME: Record<DamageType, string> = {
  acid: '强酸',
  bludgeoning: '钝击',
  cold: '冷冻',
  fire: '火焰',
  force: '力场',
  lightning: '闪电',
  necrotic: '暗蚀',
  piercing: '穿刺',
  poison: '毒素',
  psychic: '心灵',
  radiant: '光耀',
  slashing: '挥砍',
  thunder: '雷鸣',
};
export function isDamageType(x: unknown): x is DamageType {
  return typeof x === 'string' && (DAMAGE_TYPES as readonly string[]).includes(x);
}
/** 物理伤害（狂暴的抗性、武器）。 */
export const PHYSICAL: DamageType[] = ['bludgeoning', 'piercing', 'slashing'];

// ---------- 体型、生物类型（怪物用） ----------

export const SIZE_NAME: Record<string, string> = { Tiny: '微型', Small: '小型', Medium: '中型', Large: '大型', Huge: '巨型', Gargantuan: '超巨型' };
export const CREATURE_TYPE_NAME: Record<string, string> = {
  aberration: '异怪',
  beast: '野兽',
  celestial: '天界生物',
  construct: '构装生物',
  dragon: '龙',
  elemental: '元素生物',
  fey: '精类',
  fiend: '邪魔',
  giant: '巨人',
  humanoid: '类人生物',
  monstrosity: '怪兽',
  ooze: '泥怪',
  plant: '植物',
  undead: '不死生物',
};

// ---------- 骰子 ----------

/** 一组骰子：count 个 sides 面骰，加 bonus。没有骰子的固定数写成 count 0。 */
export type Dice = { count: number; sides: number; bonus: number };

const DICE_RE = /^\s*(?:(\d{1,2})\s*[dD]\s*(\d{1,3}))?\s*(?:([+-])\s*(\d{1,3}))?\s*$/;

/** 读「2d6+3」「1d4」「-1d4」（负的是减的骰子）「5」这样的写法；读不懂返回 null。 */
export function parseDice(text: string): Dice | null {
  const s = String(text ?? '').replace(/−/g, '-').replace(/＋/g, '+').trim();
  if (!s) return null;
  const negative = s.startsWith('-') && /^-\s*\d+\s*[dD]/.test(s);
  const m = DICE_RE.exec(negative ? s.slice(1) : s);
  if (!m || (!m[1] && !m[4])) return null;
  const count = m[1] ? Number(m[1]) : 0;
  const sides = m[2] ? Number(m[2]) : 0;
  if (m[1] && (count < 1 || ![2, 3, 4, 6, 8, 10, 12, 20, 100].includes(sides))) return null;
  const bonus = m[4] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  return negative ? { count: -count, sides, bonus: -bonus } : { count, sides, bonus };
}

export function formatDice(d: Dice): string {
  const dice = d.count ? `${d.count < 0 ? '-' : ''}${Math.abs(d.count)}d${d.sides}` : '';
  if (!d.bonus) return dice || '0';
  return dice ? `${dice}${d.bonus > 0 ? '+' : '-'}${Math.abs(d.bonus)}` : String(d.bonus);
}

/** 平均值（往下取整，2024 版数据块的写法）。 */
export function averageDice(d: Dice): number {
  return Math.floor(Math.abs(d.count) * ((d.sides + 1) / 2)) * Math.sign(d.count || 1) + d.bonus;
}

/** 1～n 的随机整数。 */
export type Rng = (n: number) => number;

export type DiceRoll = { dice: Dice; rolls: number[]; total: number };

/**
 * 掷一组骰子。crit：重击，骰子数翻倍（加值不翻）。负的骰子（灾祸术的 −1d4）掷出来是减的。
 * minEach：每颗骰子至少按几算（巨武器战斗把 1、2 当 3）。
 */
export function rollDice(d: Dice, rng: Rng, opts: { crit?: boolean; minEach?: number } = {}): DiceRoll {
  const n = Math.abs(d.count) * (opts.crit ? 2 : 1);
  const rolls: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng(d.sides);
    rolls.push(opts.minEach ? Math.max(opts.minEach, r) : r);
  }
  const sum = rolls.reduce((a, b) => a + b, 0) * (d.count < 0 ? -1 : 1);
  return { dice: d, rolls, total: sum + d.bonus };
}

/** 掷 d20 的方式：普通、优势（掷两颗取高）、劣势（取低）。优势和劣势同时有就抵消。 */
export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export function combineMode(advantage: boolean, disadvantage: boolean): RollMode {
  if (advantage && !disadvantage) return 'advantage';
  if (disadvantage && !advantage) return 'disadvantage';
  return 'normal';
}

export type D20Roll = { rolls: number[]; kept: number; mode: RollMode };

export function rollD20(rng: Rng, mode: RollMode): D20Roll {
  const a = rng(20);
  if (mode === 'normal') return { rolls: [a], kept: a, mode };
  const b = rng(20);
  return { rolls: [a, b], kept: mode === 'advantage' ? Math.max(a, b) : Math.min(a, b), mode };
}

export const MODE_LABEL: Record<RollMode, string> = { normal: '', advantage: '优势', disadvantage: '劣势' };

// ---------- 等级、经验、法术位 ----------

/** 全施法者（吟游诗人、牧师、德鲁伊、术士、法师）1～5 级的法术位：[1 环, 2 环, 3 环]。 */
export const FULL_CASTER_SLOTS: Record<number, number[]> = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2],
  9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1], 12: [4, 3, 3, 3, 2, 1],
  13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1], 15: [4, 3, 3, 3, 2, 1, 1, 1],
  16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1], 18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};
/** 半施法者（圣武士、游侠，2024 版 1 级就能施法）。 */
export const HALF_CASTER_SLOTS: Record<number, number[]> = {
  1: [2], 2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3], 9: [4, 3, 2], 10: [4, 3, 2],
  11: [4, 3, 3], 12: [4, 3, 3], 13: [4, 3, 3, 1], 14: [4, 3, 3, 1], 15: [4, 3, 3, 2], 16: [4, 3, 3, 2],
  17: [4, 3, 3, 3, 1], 18: [4, 3, 3, 3, 1], 19: [4, 3, 3, 3, 2], 20: [4, 3, 3, 3, 2],
};
/** 邪术师的契约魔法：几个法术位、都是几环；短休就回满。 */
export const PACT_SLOTS: Record<number, { count: number; level: number }> = { 1: { count: 1, level: 1 }, 2: { count: 2, level: 1 }, 3: { count: 2, level: 2 }, 4: { count: 2, level: 2 }, 5: { count: 2, level: 3 } };

export const SPELL_LEVEL_LABEL = ['戏法', '1 环', '2 环', '3 环', '4 环', '5 环', '6 环', '7 环', '8 环', '9 环'] as const;
export const SPELL_SCHOOL_NAME: Record<string, string> = {
  abjuration: '防护系',
  conjuration: '咒法系',
  divination: '预言系',
  enchantment: '惑控系',
  evocation: '塑能系',
  illusion: '幻术系',
  necromancy: '死灵系',
  transmutation: '变化系',
};

// ---------- 钱 ----------

/** 钱统一记成铜币：1 金币 = 10 银币 = 100 铜币。 */
export function formatMoney(cp: number): string {
  const gp = Math.floor(cp / 100);
  const sp = Math.floor((cp % 100) / 10);
  const c = cp % 10;
  const parts = [gp ? `${gp} 金币` : '', sp ? `${sp} 银币` : '', c ? `${c} 铜币` : ''].filter(Boolean);
  return parts.join(' ') || '0 金币';
}
