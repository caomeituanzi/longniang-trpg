// 图腾武者道途的三个图腾精魄。
export const TOTEMS = [
  {
    key: 'bear',
    name: '熊',
    text: '狂暴时，你获得对心灵伤害之外任何伤害类型的抗性。熊之精魄令你坚韧无匹，无惧于任何打击。',
  },
  {
    key: 'eagle',
    name: '鹰',
    text: '狂暴时，如果你未着装重甲，则其他生物在对你进行借机攻击时进行的攻击检定具有劣势。另外，你在自己回合内可以用附赠动作执行疾行动作。鹰之精魄让你成为在战场中自由穿梭的猎杀者。',
  },
  {
    key: 'wolf',
    name: '狼',
    text: '狂暴时，如果你的周围 5 尺范围内有任何敌对生物，则你的盟友对这些生物发动近战攻击时的攻击检定具有优势。狼之精魄让你成为猎手中的领袖。',
  },
] as const;

export type TotemKey = (typeof TOTEMS)[number]['key'];
export const TOTEM_KEYS = TOTEMS.map((t) => t.key);
export const TOTEM_NAME: Record<TotemKey, string> = Object.fromEntries(TOTEMS.map((t) => [t.key, t.name])) as Record<TotemKey, string>;

export function isTotem(x: unknown): x is TotemKey {
  return typeof x === 'string' && (TOTEM_KEYS as string[]).includes(x);
}
