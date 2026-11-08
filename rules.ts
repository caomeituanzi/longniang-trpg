// 规则里的固定数据：服务器和网页都用这一份，改规则只改这里。

export const ATTRIBUTES = [
  { key: 'body', name: '体魄', covers: '力量、耐力、搏斗、扛伤' },
  { key: 'agility', name: '敏捷', covers: '速度、潜行、射击、手上功夫' },
  { key: 'intellect', name: '智识', covers: '推理、知识、查资料' },
  { key: 'perception', name: '感知', covers: '观察、直觉、察觉危险' },
  { key: 'charm', name: '魅力', covers: '交涉、欺骗、威慑' },
] as const;

export type AttributeKey = (typeof ATTRIBUTES)[number]['key'];
export const ATTRIBUTE_KEYS = ATTRIBUTES.map((a) => a.key) as AttributeKey[];
export const ATTRIBUTE_NAME = Object.fromEntries(ATTRIBUTES.map((a) => [a.key, a.name])) as Record<AttributeKey, string>;

/** 车卡时这五个数各用一次。 */
export const STARTING_VALUES = [2, 1, 1, 0, -1] as const;
/** 成长后属性最高到 +3。 */
export const ATTRIBUTE_MAX = 3;

export const SPECIALTY_COUNT = 2;
export const SPECIALTY_MAX_LENGTH = 10;

/** 主持AI给的情境修正范围。 */
export const MODIFIER_MIN = -2;
export const MODIFIER_MAX = 2;

/** 协助：同一地点的另一个角色花一个行动帮忙。 */
export const ASSIST_BONUS = 1;

export type Outcome = 'critical' | 'success' | 'partial' | 'failure' | 'fumble';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  critical: '大成功',
  success: '成功',
  partial: '有代价的成功',
  failure: '失败',
  fumble: '大失败',
};

export const OUTCOME_MEANING: Record<Outcome, string> = {
  critical: '成功，而且有额外收获',
  success: '做到了',
  partial: '做到了，但要付出代价，或者只做到一部分',
  failure: '没做到，局面变糟',
  fumble: '失败，而且出了意外',
};

/** 总点数到这个数就是成功。 */
export const SUCCESS_AT = 10;
/** 总点数到这个数就是有代价的成功。 */
export const PARTIAL_AT = 7;

/** 两颗骰子的点数和总点数（已经加上所有加减值）决定结果。两个6一定是大成功，两个1一定是大失败。 */
export function outcomeFor(die1: number, die2: number, total: number): Outcome {
  if (die1 === 6 && die2 === 6) return 'critical';
  if (die1 === 1 && die2 === 1) return 'fumble';
  if (total >= SUCCESS_AT) return 'success';
  if (total >= PARTIAL_AT) return 'partial';
  return 'failure';
}

/** 加减值合计为 bonus 时，各种结果的概率（把36种掷法全部算一遍）。 */
export function outcomeOdds(bonus: number): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { critical: 0, success: 0, partial: 0, failure: 0, fumble: 0 };
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) counts[outcomeFor(a, b, a + b + bonus)]++;
  }
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / 36])) as Record<Outcome, number>;
}

/** 伤势和心智各有3格，0 表示没事。 */
export const TRACK_MAX = 3;

export const WOUND_LABEL = ['没受伤', '轻伤', '重伤', '濒死'] as const;
export const STRESS_LABEL = ['平静', '动摇', '崩溃', '失控'] as const;

/** 到了这一格，所有检定 -1。 */
export const PENALTY_LEVEL = 2;
/** 到了这一格，不能自己行动。 */
export const INCAPACITATED_LEVEL = 3;
