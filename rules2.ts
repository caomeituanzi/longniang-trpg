// 规则第二版（V0.7.0）：所有新剧本都用它（地下城、五个分区）。服务器和网页共用这一份，改数值只改这里。
// 地下城只能带自带角色卡、有难度和掉落；五个分区的剧本用剧本里现成的身份（七项属性按身份的实际情况分，加起来是 ROLE2_TOTAL）。
// 以前按第一版（shared/rules.ts）写的剧本、导入的老剧本、已经开始的老对局照旧按第一版跑；宠物照旧是五项属性。
import type { AttributeKey } from './rules';

export const ATTRIBUTES2 = [
  { key: 'strength', name: '力量', covers: '近战、搬重物、破门' },
  { key: 'constitution', name: '体质', covers: '生命值、耐力、抗毒' },
  { key: 'agility', name: '敏捷', covers: '闪避、潜行、远程、先后手' },
  { key: 'intellect', name: '智识', covers: '推理、知识、机关' },
  { key: 'perception', name: '感知', covers: '察觉、搜索、直觉' },
  { key: 'will', name: '意志', covers: '精神值、抗恐惧和迷惑' },
  { key: 'charm', name: '魅力', covers: '交涉、欺骗、威慑' },
] as const;

export type Attribute2 = (typeof ATTRIBUTES2)[number]['key'];
export const ATTRIBUTE2_KEYS = ATTRIBUTES2.map((a) => a.key) as Attribute2[];
export const ATTRIBUTE2_NAME = Object.fromEntries(ATTRIBUTES2.map((a) => [a.key, a.name])) as Record<Attribute2, string>;
export type Attributes2 = Record<Attribute2, number>;

/** 宠物只有第一版的五项属性：宠物帮忙重掷时，第二版的属性按这个对过去。 */
export const PET_ATTRIBUTE_FOR: Record<Attribute2, AttributeKey> = {
  strength: 'body',
  constitution: 'body',
  agility: 'agility',
  intellect: 'intellect',
  perception: 'perception',
  will: 'perception',
  charm: 'charm',
};

// ---------- 剧本里现成的身份 ----------

/**
 * 普通剧本（五个分区）的身份：七项属性按这个身份的实际情况分（擅长的高、不擅长的低），
 * 每项在 ROLE2_MIN～ROLE2_MAX 之间，加起来正好 ROLE2_TOTAL（和新卡一样是 4，几个身份之间大体平衡）。
 */
export const ROLE2_TOTAL = 4;
export const ROLE2_MIN = -2;
export const ROLE2_MAX = 3;

/** 身份的属性有什么不对：七项都要写、都是整数、每项在 ROLE2_MIN～ROLE2_MAX 之间、加起来正好 ROLE2_TOTAL。对的返回 null，不对返回原因。 */
export function roleAttributes2Problem(value: unknown): string | null {
  const range = `${ROLE2_MIN}～+${ROLE2_MAX}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `要写七项属性（${ATTRIBUTE2_KEYS.join('、')}），每项 ${range}，加起来正好 ${ROLE2_TOTAL}`;
  }
  const o = value as Record<string, unknown>;
  const missing = ATTRIBUTE2_KEYS.filter((k) => o[k] === undefined || o[k] === null);
  if (missing.length) return `缺了 ${missing.map((k) => `${k}（${ATTRIBUTE2_NAME[k]}）`).join('、')}：七项属性都要写`;
  let sum = 0;
  for (const k of ATTRIBUTE2_KEYS) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) return `${k}（${ATTRIBUTE2_NAME[k]}）要写整数`;
    if (v < ROLE2_MIN || v > ROLE2_MAX) return `${k}（${ATTRIBUTE2_NAME[k]}）是 ${v > 0 ? `+${v}` : v}，每项要在 ${range} 之间`;
    sum += v;
  }
  if (sum !== ROLE2_TOTAL) return `七项属性加起来要正好是 ${ROLE2_TOTAL}，现在是 ${sum}`;
  return null;
}

/** 身份的属性对不对（见 roleAttributes2Problem）。 */
export function validRoleAttributes2(value: unknown): value is Attributes2 {
  return roleAttributes2Problem(value) === null;
}

// ---------- 新卡 ----------

/** 新卡分点：七项加起来正好这么多，每项在 CARD2_START_MIN～CARD2_START_MAX 之间（和剧本里现成的身份差不多强）。 */
export const CARD2_START_TOTAL = 4;
export const CARD2_START_MIN = -1;
export const CARD2_START_MAX = 2;
/** 每个正式账号最多几张角色卡。 */
export const CARD2_MAX = 6;
export const CARD2_NAME_MAX = 20;
export const CARD2_APPEARANCE_MAX = 200;
export const CARD2_BACKGROUND_MAX = 300;
/** 新卡两个专长；成长以后最多几个。 */
export const CARD2_SPECIALTY_START = 2;
export const CARD2_SPECIALTY_MAX = 6;
export const CARD2_SPECIALTY_LENGTH = 10;
/** 学一个新专长花几点成长点。 */
export const CARD2_SPECIALTY_COST = 4;

/**
 * 角色卡的专长（V0.7.1）：做卡、学新专长都从这里挑，按擅长的方面分组。
 * 以前自己写的专长（不在这里的）照样留在卡上、照样算。
 */
export const CARD2_SPECIALTY_GROUPS: readonly { name: string; list: readonly string[] }[] = [
  { name: '武艺', list: ['剑术', '刀法', '枪法', '棍法', '拳脚', '掌法', '擒拿', '角力'] },
  { name: '体魄', list: ['硬功', '耐力', '闭气', '酒量', '耐寒', '长途跋涉', '野外求生'] },
  { name: '身手', list: ['轻功', '攀爬', '潜行', '骑术', '水性', '射箭', '暗器', '开锁', '妙手'] },
  { name: '学识', list: ['机关', '医术', '草药', '毒物', '阵法', '算学', '古文', '符箓', '炼丹', '兵法'] },
  { name: '眼力', list: ['追踪', '搜查', '察言观色', '寻路', '辨音', '识破', '鉴宝', '天象'] },
  { name: '心性', list: ['定力', '胆识', '坚忍', '禅定', '佛法', '道法', '驱邪', '超度'] },
  { name: '江湖', list: ['交涉', '讨价还价', '打听消息', '江湖规矩', '江湖切口', '骗术', '威吓', '号令', '易容', '赌术'] },
  { name: '手艺', list: ['打铁', '木工', '厨艺', '驯兽', '驾车', '撑船', '绳结', '包扎', '书画', '琴艺'] },
];

export const CARD2_SPECIALTIES: readonly string[] = CARD2_SPECIALTY_GROUPS.flatMap((g) => g.list);

/** 是不是列表里的专长。 */
export function isCardSpecialty(name: string): boolean {
  return CARD2_SPECIALTIES.includes(name);
}

/** 一项属性从 current 加到 current+1 要花几点成长点：越高越贵，但不封顶。 */
export function raiseCost(current: number): number {
  return Math.max(1, current + 1);
}

export function emptyAttributes2(): Attributes2 {
  return Object.fromEntries(ATTRIBUTE2_KEYS.map((k) => [k, 0])) as Attributes2;
}

/** 新卡的属性对不对：七项都是整数、在范围里、加起来是 CARD2_START_TOTAL。对的返回 null，不对返回原因。 */
export function startAttributesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '属性没填';
  const o = value as Record<string, unknown>;
  let sum = 0;
  for (const k of ATTRIBUTE2_KEYS) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) return `${ATTRIBUTE2_NAME[k]}要填整数`;
    if (v < CARD2_START_MIN || v > CARD2_START_MAX) return `${ATTRIBUTE2_NAME[k]}要在 ${CARD2_START_MIN}～+${CARD2_START_MAX} 之间`;
    sum += v;
  }
  if (sum !== CARD2_START_TOTAL) return `七项加起来要正好是 ${CARD2_START_TOTAL}，现在是 ${sum}`;
  return null;
}

// ---------- 生命值、精神值 ----------

export function maxHp(constitution: number): number {
  return Math.max(4, 10 + constitution * 2);
}

export function maxMp(will: number): number {
  return Math.max(4, 10 + will * 2);
}

/** 生命值到 0 倒地濒死：同一地点再结算这么多次行动还没人救，就死了。 */
export const DYING_TURNS = 3;

// ---------- 检定 ----------

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 10;

/** 地下城难度 N：所有检定、攻击 −(N−1)。敌人的数值另外按难度算（见 enemyStats）。 */
export function levelPenalty(level: number): number {
  return 1 - Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, level));
}

export type DungeonSize = 'small' | 'large';
export const SIZE_LABEL: Record<DungeonSize, string> = { small: '小型', large: '大型' };
/** 大型地下城推荐几个人：少一个人，检定再 −1。 */
export const LARGE_RECOMMENDED = 4;
/** 小型最多几个人。 */
export const SMALL_MAX_PLAYERS = 2;

export function shorthandedPenalty(size: DungeonSize, players: number): number {
  return size === 'large' ? -Math.max(0, LARGE_RECOMMENDED - players) : 0;
}

/** 专长正好用上：+1（和第一版一样）。 */
export const SPECIALTY2_BONUS = 1;
/** 主持 AI 给的情境修正。 */
export const MODIFIER2_MIN = -3;
export const MODIFIER2_MAX = 3;

// ---------- 伤害 ----------

export type Severity = 'light' | 'medium' | 'heavy';
export const SEVERITY: Record<Severity, { name: string; min: number; max: number }> = {
  light: { name: '轻', min: 1, max: 3 },
  medium: { name: '中', min: 4, max: 6 },
  heavy: { name: '重', min: 7, max: 10 },
};
export const SEVERITY_KEYS = Object.keys(SEVERITY) as Severity[];

/** 难度高的地下城，伤害再加这么多（敌人打人、陷阱都算）。 */
export function levelDamageBonus(level: number): number {
  return Math.floor((Math.max(1, level) - 1) / 2);
}

/** 角色的防御（敌人攻击要掷到这个数才打得中）。 */
export function characterDefense(agility: number): number {
  return 7 + agility;
}

/** 攻击打中以后的伤害：1d6 + 武器加值；大成功翻倍；用上首领的弱点再翻倍。 */
export const ATTACK_DIE = 6;
/** 用上首领的弱点：这一下攻击 +3。 */
export const WEAKNESS_BONUS = 3;

// ---------- 敌人 ----------

export type EnemyTier = 'minion' | 'elite' | 'boss';
export const TIER_LABEL: Record<EnemyTier, string> = { minion: '小怪', elite: '精英', boss: '首领' };

export type EnemyStats = { hp: number; defense: number; attack: number; initiative: number; maxSeverity: Severity; damageBonus: number };

/**
 * 敌人的数值由程序按难度和种类算，剧本只写是什么敌人、有什么本事（可以微调）。
 * 大型地下城的首领生命值翻倍（要几个人一起打）。
 */
export function enemyStats(tier: EnemyTier, level: number, size: DungeonSize, tweak?: { hp?: number; defense?: number; attack?: number }): EnemyStats {
  const L = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, level));
  const base =
    tier === 'minion'
      ? { hp: 4 + 2 * L, defense: 7 + L, attack: L - 1, initiative: L - 1, maxSeverity: 'light' as Severity }
      : tier === 'elite'
        ? { hp: 8 + 4 * L, defense: 8 + L, attack: L, initiative: L, maxSeverity: 'medium' as Severity }
        : { hp: (12 + 6 * L) * (size === 'large' ? 2 : 1), defense: 9 + L, attack: L + 1, initiative: L + 1, maxSeverity: 'heavy' as Severity };
  return {
    hp: Math.max(1, base.hp + (tweak?.hp ?? 0)),
    defense: base.defense + (tweak?.defense ?? 0),
    attack: base.attack + (tweak?.attack ?? 0),
    initiative: base.initiative,
    maxSeverity: base.maxSeverity,
    damageBonus: levelDamageBonus(L),
  };
}

/** 剧本里微调敌人数值的范围。 */
export const ENEMY_TWEAK = { hp: [-10, 20], defense: [-2, 2], attack: [-2, 2] } as const;

// ---------- 装备 ----------

export type Rarity = 'common' | 'fine' | 'rare' | 'epic' | 'legendary';
export const RARITY_KEYS: Rarity[] = ['common', 'fine', 'rare', 'epic', 'legendary'];
export const RARITY_LABEL: Record<Rarity, string> = { common: '普通', fine: '精良', rare: '稀有', epic: '史诗', legendary: '传奇' };
/** 加在它对应的那一项上：武器加攻击（同一项属性的）、护甲加护甲点、饰品加检定。 */
export const RARITY_BONUS: Record<Rarity, number> = { common: 1, fine: 2, rare: 3, epic: 4, legendary: 5 };
/** 开到已经有的装备，折成多少龙晶。 */
export const DUPLICATE_CRYSTALS: Record<Rarity, number> = { common: 10, fine: 25, rare: 50, epic: 100, legendary: 200 };

/**
 * 装备的大类，决定加什么：weapon 武器（穿在主手，加同一项属性的攻击和伤害）、armor 护甲（加护甲点，合起来减伤）、
 * accessory 饰品（加它那一项属性的检定）。V0.7.0 身上就是这三个格子；V0.7.1 起是十六个格子（EQUIP_SLOTS），
 * 剧本的宝物、奇遇里写的 slot 照旧是这三个大类（按大类随机挑一种）。
 */
export type GearCategory = 'weapon' | 'armor' | 'accessory';
export const GEAR_CATEGORIES: GearCategory[] = ['weapon', 'armor', 'accessory'];
export const GEAR_CATEGORY_LABEL: Record<GearCategory, string> = { weapon: '武器', armor: '护甲', accessory: '饰品' };
/** V0.7.0 的名字（剧本宝物的 slot 字段还用它）：就是大类。 */
export type GearSlot = GearCategory;
export const SLOT_KEYS = GEAR_CATEGORIES;
export const SLOT_LABEL = GEAR_CATEGORY_LABEL;

/** 装备穿在哪个部位（V0.7.1，照魔兽世界）：戒指、饰品各能放进两个格子里的任意一个，别的一个部位一个格子。 */
export type GearPart = 'head' | 'neck' | 'shoulder' | 'back' | 'chest' | 'wrist' | 'hands' | 'waist' | 'legs' | 'feet' | 'finger' | 'trinket' | 'mainHand' | 'offHand';
export const GEAR_PART_LABEL: Record<GearPart, string> = {
  head: '头部',
  neck: '颈部',
  shoulder: '肩部',
  back: '背部',
  chest: '胸部',
  wrist: '手腕',
  hands: '手部',
  waist: '腰部',
  legs: '腿部',
  feet: '脚部',
  finger: '戒指',
  trinket: '饰品',
  mainHand: '主手',
  offHand: '副手',
};
export const GEAR_PARTS = Object.keys(GEAR_PART_LABEL) as GearPart[];

/** 身上的十六个格子：人物栏左边一列（头部到手腕）、右边一列（手部到饰品）、下面两只手。 */
export type EquipSlot = 'head' | 'neck' | 'shoulder' | 'back' | 'chest' | 'wrist' | 'hands' | 'waist' | 'legs' | 'feet' | 'finger1' | 'finger2' | 'trinket1' | 'trinket2' | 'mainHand' | 'offHand';
export const EQUIP_SLOT_PART: Record<EquipSlot, GearPart> = {
  head: 'head',
  neck: 'neck',
  shoulder: 'shoulder',
  back: 'back',
  chest: 'chest',
  wrist: 'wrist',
  hands: 'hands',
  waist: 'waist',
  legs: 'legs',
  feet: 'feet',
  finger1: 'finger',
  finger2: 'finger',
  trinket1: 'trinket',
  trinket2: 'trinket',
  mainHand: 'mainHand',
  offHand: 'offHand',
};
export const EQUIP_SLOTS = Object.keys(EQUIP_SLOT_PART) as EquipSlot[];
export const EQUIP_SLOT_LABEL = Object.fromEntries(EQUIP_SLOTS.map((s) => [s, GEAR_PART_LABEL[EQUIP_SLOT_PART[s]]])) as Record<EquipSlot, string>;

/** 这个部位的装备能放进哪几个格子（戒指、饰品两个，别的一个）。 */
export function slotsForPart(part: GearPart): EquipSlot[] {
  return EQUIP_SLOTS.filter((s) => EQUIP_SLOT_PART[s] === part);
}

/**
 * 护甲：护甲类的装备各加稀有度那么多护甲点，副手的盾牌算两倍；每 ARMOR_PER_REDUCTION 点减 1 点伤（往上取整），
 * 但不低于身上最好的那一件护甲的加值（只穿一件好甲的和 V0.7.0 一样，不吃亏）；最多减 REDUCTION_MAX。
 */
export const SHIELD_ARMOR_FACTOR = 2;
export const ARMOR_PER_REDUCTION = 3;
export const REDUCTION_MAX = 6;

/** 护甲点合起来能减多少伤：护甲点 ÷ 3 往上取整，不低于最好的那一件护甲的加值（best，盾牌不翻倍），最多 6。 */
export function damageReduction(armor: number, best = 0): number {
  return Math.min(REDUCTION_MAX, Math.max(Math.max(0, best), Math.ceil(Math.max(0, armor) / ARMOR_PER_REDUCTION)));
}

/** 按难度开出来的装备稀有度（百分比，普通、精良、稀有、史诗）。传奇的另外算。 */
export function rarityOdds(level: number): Record<Exclude<Rarity, 'legendary'>, number> {
  const L = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, level));
  if (L <= 2) return { common: 70, fine: 25, rare: 5, epic: 0 };
  if (L <= 4) return { common: 45, fine: 40, rare: 13, epic: 2 };
  if (L <= 6) return { common: 25, fine: 45, rare: 25, epic: 5 };
  if (L <= 8) return { common: 10, fine: 40, rare: 38, epic: 12 };
  return { common: 5, fine: 30, rare: 45, epic: 20 };
}

// ---------- 道具 ----------

export const CONSUMABLES = [
  { key: 'potion', name: '治疗药水', effect: '回 2d6+2 点生命值；濒死的人喝下去能醒过来', price: 30, combat: false },
  { key: 'clear-pill', name: '清心丸', effect: '回 2d6+2 点精神值', price: 30, combat: false },
  { key: 'antidote', name: '解毒剂', effect: '解掉中毒', price: 20, combat: false },
  { key: 'smoke', name: '烟雾弹', effect: '战斗里用：自己和同一地点的同伴脱离这场战斗', price: 40, combat: true },
  { key: 'fire-oil', name: '火油', effect: '战斗里扔向一个敌人：2d6 点伤害，不看防御', price: 40, combat: true },
] as const satisfies readonly { key: string; name: string; effect: string; price: number; combat: boolean }[];

export type ConsumableKey = (typeof CONSUMABLES)[number]['key'];
export const CONSUMABLE_KEYS = CONSUMABLES.map((c) => c.key) as ConsumableKey[];
export function consumableOf(key: string | null | undefined) {
  return CONSUMABLES.find((c) => c.key === key) ?? null;
}
/** 进地下城最多带几个道具（一共）。 */
export const BAG_MAX = 6;
/** 账号背包里一种道具最多攒几个。 */
export const ITEM_STACK_MAX = 99;

// ---------- 成长、宝箱 ----------

/** 打完一个地下城给的成长点：clear 通关、escape 活着逃出来（减半）、fail 或者死了没有。 */
export type DungeonResult = 'clear' | 'escape' | 'fail';
export const RESULT_LABEL: Record<DungeonResult, string> = { clear: '通关', escape: '逃出来了', fail: '失败' };

export function growthPoints(level: number, size: DungeonSize, result: DungeonResult): number {
  const full = size === 'large' ? 2 * (level + 1) : level + 1;
  return result === 'clear' ? full : result === 'escape' ? Math.floor(full / 2) : 0;
}

/** 通关给几个宝箱。 */
export function chestsFor(size: DungeonSize, result: DungeonResult): number {
  if (result !== 'clear') return 0;
  return size === 'large' ? 2 : 1;
}

/** 宝箱：必有的龙晶（按难度：基数 × 难度），再开出一样：道具或者装备（百分比）。 */
export const CHEST2 = { crystalsBase: [8, 15] as [number, number], odds: { item: 50, gear: 50 } };

// ---------- 战力、切磋 ----------

/** 战力：七项属性加起来 ×10，加上身上装备的加值 ×5，加上生命值、精神值。排行用。 */
export function powerOf(attributes: Attributes2, gearBonus: number): number {
  const sum = ATTRIBUTE2_KEYS.reduce((s, k) => s + (attributes[k] ?? 0), 0);
  return sum * 10 + gearBonus * 5 + maxHp(attributes.constitution) + maxMp(attributes.will);
}

export const DUEL_ROUNDS = 3;
/** 每天最多主动切磋几次（东京时间零点重置）。 */
export const DUEL_DAILY = 5;
/** 赢了得几颗龙晶；被挑战的一方赢了也得，但每天最多拿几次。 */
export const DUEL_REWARD = 10;
export const DUEL_DEFENSE_REWARDS_DAILY = 5;
