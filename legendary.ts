// 传奇装备（V0.7.0 改成规则第二版）：只放在服务器上，网页的代码里没有（不然翻网页代码就知道是什么、在哪掉了）。
// 只在大型地下城里掉（剧本的宝物写 {"kind":"legendary"}，或者首领身上）；拿过的不会再掉第二次。
// 数值：加值 +5（加在它对应的那一项上），另外带一个特别的本事（ability，主持 AI 照着用，每局一次）。
// V0.7.1 起每件有自己的部位：两件武器在主手，背甲在胸部，灯在副手（加意志检定）。

import { LEGENDARY2_COUNT, gearView, type GearView } from '../shared/gear2';
import { ATTRIBUTE2_KEYS, RARITY_BONUS, type Attribute2, type GearCategory, type GearPart, type Rarity } from '../shared/rules2';

export type LegendaryGear = { key: string; name: string; part: GearPart; slot: GearCategory; attribute: Attribute2 | null; use: string; ability: string };

export const LEGENDARY_GEAR: readonly LegendaryGear[] = [
  {
    key: 'leg-dragon-spear',
    name: '龙胆亮银枪',
    part: 'mainHand',
    slot: 'weapon',
    attribute: 'strength',
    use: '近身刺挑',
    ability: '每局一次：一枪挑飞一个小怪（直接打倒），或者把精英敌人挑翻在地，让同伴下一次攻击它时 +2。',
  },
  {
    key: 'leg-moon-bow',
    name: '摘月弓',
    part: 'mainHand',
    slot: 'weapon',
    attribute: 'agility',
    use: '远处射击',
    ability: '每局一次：射出一支照亮黑暗的箭，看清这个地点藏着的一切（暗门、埋伏、隐身的东西），这一箭也照常算攻击。',
  },
  {
    key: 'leg-xuanwu-mail',
    name: '玄武背甲',
    part: 'chest',
    slot: 'armor',
    attribute: null,
    use: '挡刀挡箭',
    ability: '每局一次：替身边的一个同伴挡下一次攻击，那一下的伤害全由自己承受（照常减伤）。',
  },
  {
    key: 'leg-soul-lantern',
    name: '引魂灯',
    part: 'offHand',
    slot: 'accessory',
    attribute: 'will',
    use: '稳住心神，看穿鬼魅',
    ability: '每局一次：让一个失控或被迷惑的同伴马上清醒（精神值回到一半），或者逼出一个隐身的鬼物的真身。',
  },
];

if (LEGENDARY_GEAR.length !== LEGENDARY2_COUNT) {
  throw new Error(`传奇装备有 ${LEGENDARY_GEAR.length} 件，shared/gear2.ts 里的 LEGENDARY2_COUNT 是 ${LEGENDARY2_COUNT}`);
}

export function legendaryOf(key: string | null | undefined): LegendaryGear | null {
  return LEGENDARY_GEAR.find((g) => g.key === key) ?? null;
}

/** 任何一件装备（普通的、传奇的）给人看的样子；认不出来的是 null。 */
export function anyGearView(id: number, base: string, rarity: Rarity): GearView | null {
  if (rarity === 'legendary') {
    const g = legendaryOf(base);
    if (!g) return null;
    return { id, base, rarity, name: g.name, part: g.part, slot: g.slot, attribute: g.attribute, bonus: RARITY_BONUS.legendary, use: g.use, ability: g.ability };
  }
  return gearView(id, base, rarity);
}

/**
 * 存着的一件装备（地下城角色的 v2、宝箱记录里的）按现在的定义重新算一遍：V0.7.0 存的没有部位（part），
 * 大类、名字、加值也都以现在的为准。认不出来的种类（不该有）按大类放个部位，免得一局打不下去。
 */
export function freshGearView(raw: unknown): GearView | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<GearView>;
  if (typeof g.base !== 'string' || typeof g.rarity !== 'string') return null;
  const id = Number(g.id) || 0;
  const view = anyGearView(id, g.base, g.rarity as Rarity);
  if (view) return view;
  if (typeof g.name !== 'string' || (g.slot !== 'weapon' && g.slot !== 'armor' && g.slot !== 'accessory')) return null;
  const part: GearPart = g.slot === 'weapon' ? 'mainHand' : g.slot === 'armor' ? 'chest' : 'trinket';
  return {
    id,
    base: g.base,
    rarity: g.rarity as Rarity,
    name: g.name,
    part,
    slot: g.slot,
    attribute: g.attribute && ATTRIBUTE2_KEYS.includes(g.attribute) ? g.attribute : null,
    bonus: Number(g.bonus) || 0,
    use: typeof g.use === 'string' ? g.use : '',
    ...(typeof g.ability === 'string' ? { ability: g.ability } : {}),
  };
}
