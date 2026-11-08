// 5E 各职业 1～5 级的机制表（V0.9.0）：资源、武器精通、专精、总是准备好的法术、免费施放的次数。
// 数字照 SRD 5.2.1 的职业表；说明文字在服务器的规则数据里。
import { type Ability, type Abilities, type Skill } from './core';
import type { Card5eData, ClassKey } from './types';

const at = (level: number, table: number[]) => table[Math.max(1, Math.min(5, level)) - 1] ?? 0;

/** 狂暴次数、狂暴伤害。 */
export const RAGES = [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 10];
export const RAGE_DAMAGE = [2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4];
/** 武器精通能选几种。 */
export const MASTERY_COUNT: Partial<Record<ClassKey, number[]>> = {
  barbarian: [2, 2, 2, 3, 3],
  fighter: [3, 3, 3, 4, 4],
  paladin: [2, 2, 2, 2, 2],
  ranger: [2, 2, 2, 2, 2],
  rogue: [2, 2, 2, 2, 2],
};
export function masteryCount(cls: ClassKey, level: number): number {
  const t = MASTERY_COUNT[cls];
  return t ? at(level, t) : 0;
}
/** 武僧的武艺骰。 */
export function martialArtsDie(level: number): number {
  return level >= 5 ? 8 : 6;
}
/** 游荡者的偷袭骰（d6 的个数）。 */
export function sneakDice(level: number): number {
  return at(level, [1, 1, 2, 2, 3]);
}
/** 吟游诗人的激励骰。 */
export function bardicDie(level: number): number {
  return level >= 5 ? 8 : 6;
}
/** 邪术师的魔能祈唤个数。 */
export function invocationCount(level: number): number {
  return at(level, [1, 3, 3, 3, 5]);
}
/** 德鲁伊荒野变形会几种形态、最高挑战等级。 */
export function wildShapeForms(level: number): { count: number; maxCr: number } {
  if (level < 2) return { count: 0, maxCr: 0 };
  return level >= 4 ? { count: 6, maxCr: 0.5 } : { count: 4, maxCr: 0.25 };
}
/** 游侠「宿敌」：不用法术位施放猎人印记的次数。 */
export function favoredEnemyUses(level: number): number {
  return at(level, [2, 2, 2, 2, 3]);
}
/** 属性值提升在哪几级（这一版只有 4 级）。 */
export function asiCount(level: number, cls?: string): number {
  if (cls === 'barbarian' || cls === 'bard') return [4, 8, 12, 16, 19].filter((l) => l <= level).length;
  return level >= 4 ? 1 : 0;
}

/** 专精：哪几级给几个（法师 2 级的「学者」只能从几个学识技能里挑）。 */
export function expertiseCount(cls: ClassKey, level: number): number {
  if (cls === 'rogue') return 2;
  if (cls === 'bard') return level >= 10 ? 4 : level >= 3 ? 2 : 0;
  if (cls === 'ranger') return level >= 2 ? 1 : 0;
  if (cls === 'wizard') return level >= 2 ? 1 : 0;
  return 0;
}
export const SCHOLAR_SKILLS: Skill[] = ['arcana', 'history', 'investigation', 'medicine', 'nature', 'religion'];

/** 战斗风格：战士 1 级、圣武士和游侠 2 级。 */
export function fightingStyleLevel(cls: ClassKey): number | null {
  if (cls === 'fighter') return 1;
  if (cls === 'paladin' || cls === 'ranger') return 2;
  return null;
}

/** 子职业在 3 级。 */
export const SUBCLASS_LEVEL = 3;

/** 兼职某职业的属性先决条件。 */
export function meetsMulticlassRequirement(cls: ClassKey, abilities: Abilities): boolean {
  const a = abilities;
  switch (cls) {
    case 'barbarian':
      return a.str >= 13;
    case 'bard':
      return a.cha >= 13;
    case 'cleric':
    case 'druid':
      return a.wis >= 13;
    case 'fighter':
      return a.str >= 13 || a.dex >= 13;
    case 'monk':
    case 'ranger':
      return a.dex >= 13 && a.wis >= 13;
    case 'paladin':
      return a.str >= 13 && a.cha >= 13;
    case 'rogue':
      return a.dex >= 13;
    case 'sorcerer':
    case 'warlock':
      return a.cha >= 13;
    case 'wizard':
      return a.int >= 13;
    default:
      return false;
  }
}

export function multiclassRequirementText(cls: ClassKey): string {
  switch (cls) {
    case 'barbarian':
      return '力量 13';
    case 'bard':
      return '魅力 13';
    case 'cleric':
    case 'druid':
      return '感知 13';
    case 'fighter':
      return '力量 13 或 敏捷 13';
    case 'monk':
    case 'ranger':
      return '敏捷 13 及感知 13';
    case 'paladin':
      return '力量 13 及魅力 13';
    case 'rogue':
      return '敏捷 13';
    case 'sorcerer':
    case 'warlock':
      return '魅力 13';
    case 'wizard':
      return '智力 13';
    default:
      return '';
  }
}

/** 诗人魔法奥秘要选几个：本职 10/14/18 各 2 个，逸闻学院 6 级再多 2 个。 */
export function magicalSecretsCount(level: number, subclass?: string | null): number {
  const base = level >= 18 ? 6 : level >= 14 ? 4 : level >= 10 ? 2 : 0;
  return base + (subclass === 'college-of-lore' && level >= 6 ? 2 : 0);
}

/**
 * 总是准备好的法术（不占准备的名额）：德鲁伊的动物交谈、游侠的猎人印记、圣武士的至圣斩和寻获坐骑、
 * 各子职业的法术表。land 是大地结社选的地形。
 */
export function alwaysPrepared(card: Pick<Card5eData, 'class' | 'subclass' | 'land' | 'level'>): string[] {
  const L = card.level;
  const out: string[] = [];
  if (card.class === 'druid') out.push('speak-with-animals');
  if (card.class === 'ranger') out.push('hunters-mark');
  if (card.class === 'paladin' && L >= 2) out.push('divine-smite');
  if (card.class === 'paladin' && L >= 5) out.push('find-steed');
  if (L < 3) return out;
  switch (card.subclass) {
    case 'life-domain':
      out.push('bless', 'cure-wounds');
      if (L >= 5) out.push('lesser-restoration', 'spiritual-weapon');
      if (L >= 7) out.push('beacon-of-hope', 'revivify');
      break;
    case 'light-domain':
      out.push('burning-hands', 'faerie-fire');
      if (L >= 5) out.push('flaming-sphere', 'scorching-ray');
      if (L >= 7) out.push('daylight', 'fireball');
      break;
    case 'nature-domain':
      out.push('animal-friendship', 'speak-with-animals');
      if (L >= 5) out.push('barkskin', 'spike-growth');
      if (L >= 7) out.push('plant-growth', 'wind-wall');
      break;
    case 'tempest-domain':
      out.push('fog-cloud', 'thunderwave');
      if (L >= 5) out.push('gust-of-wind', 'shatter');
      if (L >= 7) out.push('call-lightning', 'sleet-storm');
      break;
    case 'trickery-domain':
      out.push('charm-person', 'disguise-self');
      if (L >= 5) out.push('mirror-image', 'pass-without-trace');
      if (L >= 7) out.push('blink', 'dispel-magic');
      break;
    case 'war-domain':
      out.push('divine-favor', 'shield-of-faith');
      if (L >= 5) out.push('magic-weapon', 'spiritual-weapon');
      if (L >= 7) out.push('spirit-guardians');
      break;
    case 'knowledge-domain':
      out.push('command', 'identify');
      if (L >= 5) out.push('augury', 'suggestion');
      if (L >= 7) out.push('nondetection', 'speak-with-dead');
      break;
    case 'oath-of-devotion':
      out.push('protection-from-evil-and-good', 'shield-of-faith');
      if (L >= 5) out.push('aid', 'zone-of-truth');
      break;
    case 'draconic-sorcery':
      out.push('alter-self', 'chromatic-orb', 'command', 'dragons-breath');
      if (L >= 5) out.push('fear', 'fly');
      break;
    case 'fiend-patron':
      out.push('burning-hands', 'command', 'scorching-ray', 'suggestion');
      if (L >= 5) out.push('fireball', 'stinking-cloud');
      break;
    case 'circle-of-the-land': {
      const table: Record<string, [string[], string[]]> = {
        arid: [['blur', 'burning-hands', 'fire-bolt'], ['fireball']],
        polar: [['fog-cloud', 'hold-person', 'ray-of-frost'], ['sleet-storm']],
        temperate: [['misty-step', 'shocking-grasp', 'sleep'], ['lightning-bolt']],
        tropical: [['acid-splash', 'ray-of-sickness', 'web'], ['stinking-cloud']],
      };
      const t = table[card.land ?? ''];
      if (t) out.push(...t[0], ...(L >= 5 ? t[1] : []));
      break;
    }
  }
  return [...new Set(out)];
}

export const LANDS: { key: string; name: string }[] = [
  { key: 'arid', name: '干旱之地' },
  { key: 'polar', name: '极地' },
  { key: 'temperate', name: '温带' },
  { key: 'tropical', name: '热带' },
];

export const DIVINE_ORDERS = [
  { key: 'protector', name: '护卫者', text: '受过战斗训练：获得军用武器熟练和重甲受训。' },
  { key: 'thaumaturge', name: '奇术师', text: '多知道一个牧师戏法；智力（奥秘或宗教）检定加上感知调整值（至少 +1）。' },
];
export const PRIMAL_ORDERS = [
  { key: 'magician', name: '秘术师', text: '多知道一个德鲁伊戏法；智力（奥秘或自然）检定加上感知调整值（至少 +1）。' },
  { key: 'warden', name: '守护者', text: '受过战斗训练：获得军用武器熟练和中甲受训。' },
];
export const HUNTER_PREY = [
  { key: 'colossus-slayer', name: '巨像杀手', text: '用武器命中一个已经受了伤（生命值不满）的生物时，额外造成 1d8 伤害，每回合一次。' },
  { key: 'horde-breaker', name: '破阵者', text: '每回合一次，用武器攻击后，可以用同一把武器再攻击原目标 5 尺内的另一个、这回合还没攻击过的生物。' },
];

/** 能看到、能选的施法属性（精灵、侏儒、提夫林血统法术，魔法学徒）。 */
export const MENTAL: Ability[] = ['int', 'wis', 'cha'];

/** 种族血统给的法术：几级给、哪个法术；免费施放一次（长休恢复），戏法随意。提夫林的异界存在（奇术）也算在这里。 */
export const LINEAGE_SPELLS: Record<string, { level: number; spell: string }[]> = {
  'elven-lineage-drow': [
    { level: 1, spell: 'dancing-lights' },
    { level: 3, spell: 'faerie-fire' },
    { level: 5, spell: 'darkness' },
  ],
  'elven-lineage-high-elf': [
    { level: 1, spell: 'prestidigitation' },
    { level: 3, spell: 'detect-magic' },
    { level: 5, spell: 'misty-step' },
  ],
  'elven-lineage-wood-elf': [
    { level: 1, spell: 'druidcraft' },
    { level: 3, spell: 'longstrider' },
    { level: 5, spell: 'pass-without-trace' },
  ],
  'gnomish-lineage-forest-gnome': [
    { level: 1, spell: 'minor-illusion' },
    { level: 1, spell: 'speak-with-animals' },
  ],
  'gnomish-lineage-rock-gnome': [
    { level: 1, spell: 'mending' },
    { level: 1, spell: 'prestidigitation' },
  ],
  'fiendish-legacy-abyssal': [
    { level: 1, spell: 'poison-spray' },
    { level: 1, spell: 'thaumaturgy' },
    { level: 3, spell: 'ray-of-sickness' },
    { level: 5, spell: 'hold-person' },
  ],
  'fiendish-legacy-chthonic': [
    { level: 1, spell: 'chill-touch' },
    { level: 1, spell: 'thaumaturgy' },
    { level: 3, spell: 'false-life' },
    { level: 5, spell: 'ray-of-enfeeblement' },
  ],
  'fiendish-legacy-infernal': [
    { level: 1, spell: 'fire-bolt' },
    { level: 1, spell: 'thaumaturgy' },
    { level: 3, spell: 'hellish-rebuke' },
    { level: 5, spell: 'darkness' },
  ],
};

/** 魔能祈唤给的法术：不用法术位就能施放（at will，不限次数；gift-of-the-depths 的水下呼吸是一天一次）。 */
export const INVOCATION_SPELLS: Record<string, { spell: string; perDay?: number }> = {
  'armor-of-shadows': { spell: 'mage-armor' },
  'ascendant-step': { spell: 'levitate' },
  'fiendish-vigor': { spell: 'false-life' },
  'gift-of-the-depths': { spell: 'water-breathing', perDay: 1 },
  'mask-of-many-faces': { spell: 'disguise-self' },
  'master-of-myriad-forms': { spell: 'alter-self' },
  'misty-visions': { spell: 'silent-image' },
  'one-with-shadows': { spell: 'invisibility' },
  'otherworldly-leap': { spell: 'jump' },
  'pact-of-the-chain': { spell: 'find-familiar' },
};

/** 不限次数的免费施放记成这个数。 */
export const AT_WILL = 99;
