// 装备（V0.7.0 起，V0.7.1 改成魔兽世界那样浑身十六个格子）：稀有度决定加值。服务器和网页共用这一份。
// 每种装备有一个部位（part：头部、颈部……主手、副手；戒指、饰品各能放进两个格子里的任意一个）和一个大类（slot，见 GearCategory），
// 大类决定加什么：
// - 武器（主手）：加同一项属性的攻击，打中以后伤害也加；
// - 护甲（头、肩、胸、手、腰、腿，副手的盾牌算两倍）：加护甲点，身上的护甲点合起来减伤（damageReduction，不低于最好的那一件）；
// - 饰品（颈、背、腕、脚、戒指、饰品，副手的灯）：加它那一项属性的检定（不含攻击），同一项属性只算最高的那一件。
// 普通的能在商城用龙晶买；精良以上只能从地下城里捡、从宝箱里开；传奇的只在大型地下城里掉，是什么只在服务器上（server/legendary.ts）。
import {
  ATTRIBUTE2_KEYS,
  ATTRIBUTE2_NAME,
  damageReduction,
  GEAR_PART_LABEL,
  RARITY_BONUS,
  RARITY_LABEL,
  SHIELD_ARMOR_FACTOR,
  type Attribute2,
  type GearCategory,
  type GearPart,
  type Rarity,
} from './rules2';

export type GearBase = {
  key: string;
  /** 穿在哪个部位。 */
  part: GearPart;
  /** 大类：决定加什么（武器加攻击、护甲加护甲点、饰品加检定）。 */
  slot: GearCategory;
  /** 武器：加这一项属性的攻击（打中以后伤害也加）；饰品：加这一项属性的检定；护甲没有。 */
  attribute: Attribute2 | null;
  /** 普通、精良、稀有、史诗的名字。 */
  names: readonly [string, string, string, string];
  /** 什么时候用得上（给主持 AI 和玩家看）。 */
  use: string;
};

/** 按部位排（人物栏的顺序）。编号存在数据库里，不能改；V0.7.0 的十二种（sword……boots）都还在。 */
export const GEAR_BASES: readonly GearBase[] = [
  { key: 'helmet', part: 'head', slot: 'armor', attribute: null, names: ['皮盔', '铁盔', '凤翅盔', '紫金冠'], use: '护住头脸' },
  { key: 'amulet', part: 'neck', slot: 'accessory', attribute: 'will', names: ['平安符', '护身符', '镇魂玉', '太一神符'], use: '稳住心神，抵抗恐惧和迷惑' },
  { key: 'pauldrons', part: 'shoulder', slot: 'armor', attribute: null, names: ['皮护肩', '铁护肩', '兽面吞肩', '麒麟吞肩'], use: '护住肩头' },
  { key: 'cloak', part: 'back', slot: 'accessory', attribute: 'agility', names: ['粗布斗篷', '夜行斗篷', '云纹披风', '无影披风'], use: '潜行、藏身（不加攻击）' },
  { key: 'mail', part: 'chest', slot: 'armor', attribute: null, names: ['皮甲', '软甲', '锁子甲', '玄铁甲'], use: '挡刀挡箭' },
  { key: 'bracer', part: 'wrist', slot: 'accessory', attribute: 'constitution', names: ['护腕', '铁护腕', '龟甲护腕', '不动护腕'], use: '扛毒、硬撑' },
  { key: 'gloves', part: 'hands', slot: 'armor', attribute: null, names: ['皮手套', '铁鳞手套', '乌金手套', '天蚕手套'], use: '护住双手' },
  { key: 'belt', part: 'waist', slot: 'armor', attribute: null, names: ['皮腰带', '铜扣腰带', '狮蛮带', '蛟龙带'], use: '护住腰腹' },
  { key: 'greaves', part: 'legs', slot: 'armor', attribute: null, names: ['皮护腿', '铁护腿', '鱼鳞战裙', '玄龟战裙'], use: '护住双腿' },
  { key: 'boots', part: 'feet', slot: 'accessory', attribute: 'agility', names: ['轻靴', '飞云靴', '踏雪靴', '凌波靴'], use: '闪避、潜行、攀爬（不加攻击）' },
  { key: 'ring-intellect', part: 'finger', slot: 'accessory', attribute: 'intellect', names: ['墨玉戒', '文心戒', '玲珑戒', '天机戒'], use: '推理、认字、解谜' },
  { key: 'ring-perception', part: 'finger', slot: 'accessory', attribute: 'perception', names: ['骨戒', '鹰目戒', '通幽戒', '洞玄戒'], use: '察觉、搜索、看穿伪装' },
  { key: 'ring-charm', part: 'finger', slot: 'accessory', attribute: 'charm', names: ['银戒', '翡翠戒', '红鸾戒', '倾城戒'], use: '交涉、说服、骗人' },
  { key: 'ring-will', part: 'finger', slot: 'accessory', attribute: 'will', names: ['铁戒', '定神戒', '金刚戒', '菩提戒'], use: '稳住心神，抵抗恐惧和迷惑' },
  { key: 'bell', part: 'trinket', slot: 'accessory', attribute: 'perception', names: ['铜铃', '千里镜', '听风铃', '天眼珠'], use: '察觉埋伏、搜索' },
  { key: 'box', part: 'trinket', slot: 'accessory', attribute: 'intellect', names: ['木匣', '机关匣', '天工匣', '璇玑匣'], use: '拆机关、解谜' },
  { key: 'fan', part: 'trinket', slot: 'accessory', attribute: 'charm', names: ['香囊', '玉佩', '金丝扇', '凤翎扇'], use: '交涉、震慑' },
  { key: 'iron-balls', part: 'trinket', slot: 'accessory', attribute: 'strength', names: ['铁胆', '钢胆', '镔铁胆', '霸王胆'], use: '搬重物、破门、角力（不加攻击）' },
  { key: 'sword', part: 'mainHand', slot: 'weapon', attribute: 'strength', names: ['铁剑', '精钢剑', '青锋剑', '龙鳞剑'], use: '近身劈砍' },
  { key: 'axe', part: 'mainHand', slot: 'weapon', attribute: 'strength', names: ['柴斧', '开山斧', '破岳斧', '雷鸣斧'], use: '重劈、破门' },
  { key: 'spear', part: 'mainHand', slot: 'weapon', attribute: 'strength', names: ['长枪', '红缨枪', '点钢枪', '沥泉枪'], use: '长兵刺挑、拦住去路' },
  { key: 'dagger', part: 'mainHand', slot: 'weapon', attribute: 'agility', names: ['短刀', '柳叶刀', '寒光匕', '影月刃'], use: '快刺、偷袭' },
  { key: 'bow', part: 'mainHand', slot: 'weapon', attribute: 'agility', names: ['猎弓', '角弓', '落雁弓', '追星弓'], use: '远处射击' },
  { key: 'shield', part: 'offHand', slot: 'armor', attribute: null, names: ['藤牌', '铁盾', '虎头盾', '玄武盾'], use: '架住重击' },
  { key: 'lantern', part: 'offHand', slot: 'accessory', attribute: 'perception', names: ['油灯', '风灯', '琉璃灯', '七星灯'], use: '照亮暗处、搜索' },
];

export function gearBaseOf(key: string | null | undefined): GearBase | null {
  return GEAR_BASES.find((b) => b.key === key) ?? null;
}

const RARITY_INDEX: Record<Exclude<Rarity, 'legendary'>, number> = { common: 0, fine: 1, rare: 2, epic: 3 };

/** 一件装备给人看的样子（网页、主持 AI、宝箱结果都用这个）。传奇的 ability 是特别的本事。 */
export type GearView = {
  /** gear_items 的编号（还没有的、商店里的是 0）。 */
  id: number;
  base: string;
  rarity: Rarity;
  name: string;
  /** 穿在哪个部位（V0.7.1）。 */
  part: GearPart;
  /** 大类：武器、护甲、饰品（决定加什么）。 */
  slot: GearCategory;
  attribute: Attribute2 | null;
  bonus: number;
  use: string;
  ability?: string;
};

/** 普通装备（base + 稀有度）给人看的样子；不认识的 base、传奇的返回 null（传奇的在服务器上另外查）。 */
export function gearView(id: number, base: string, rarity: Rarity): GearView | null {
  const b = gearBaseOf(base);
  if (!b || rarity === 'legendary') return null;
  return { id, base, rarity, name: b.names[RARITY_INDEX[rarity]], part: b.part, slot: b.slot, attribute: b.attribute, bonus: RARITY_BONUS[rarity], use: b.use };
}

export function gearLabel(g: Pick<GearView, 'name' | 'rarity'>): string {
  return `${g.name}（${RARITY_LABEL[g.rarity]}）`;
}

/** 一件装备加多少护甲点：护甲类的加稀有度那么多，副手的盾牌算两倍；别的没有。 */
export function armorPointsOf(g: Pick<GearView, 'slot' | 'part' | 'bonus'>): number {
  if (g.slot !== 'armor') return 0;
  return g.part === 'offHand' ? g.bonus * SHIELD_ARMOR_FACTOR : g.bonus;
}

/** 一件装备加什么，几个字：「力量攻击 +2」「护甲 +2」「感知检定 +3」。 */
export function gearEffectText(g: Pick<GearView, 'slot' | 'part' | 'attribute' | 'bonus'>): string {
  if (g.slot === 'armor') return `护甲 +${armorPointsOf(g)}`;
  const attr = g.attribute ? ATTRIBUTE2_NAME[g.attribute] : '';
  return `${attr}${g.slot === 'weapon' ? '攻击' : '检定'} +${g.bonus}`;
}

/** 一件装备一句话：部位、加什么、什么时候用得上（商城、背包）。 */
export function gearEffectLine(g: Pick<GearView, 'slot' | 'part' | 'attribute' | 'bonus' | 'use'>): string {
  return `${GEAR_PART_LABEL[g.part]}，${gearEffectText(g)}，${g.use}`;
}

/** 身上的装备合起来的效果（规则、切磋、网页都按这个算）。 */
export type GearTotals = {
  /** 主手的武器：加它那一项属性的攻击和伤害。 */
  weapon: GearView | null;
  /** 护甲点合计。 */
  armor: number;
  /** 减伤：护甲点 ÷ 3 往上取整，不低于最好的那一件护甲的加值，最多 6。 */
  reduction: number;
  /** 每一项属性的检定加值：只算这一项最高的那一件。 */
  checks: Partial<Record<Attribute2, GearView>>;
};

export function gearTotals(gear: readonly GearView[]): GearTotals {
  let weapon: GearView | null = null;
  let armor = 0;
  // 最好的那一件护甲的加值（盾牌不翻倍）：减伤不低于它
  let bestArmor = 0;
  const checks: Partial<Record<Attribute2, GearView>> = {};
  for (const g of gear) {
    if (g.slot === 'weapon') {
      if (g.part === 'mainHand' && (!weapon || g.bonus > weapon.bonus)) weapon = g;
    } else if (g.slot === 'armor') {
      armor += armorPointsOf(g);
      bestArmor = Math.max(bestArmor, g.bonus);
    } else if (g.attribute) {
      const best = checks[g.attribute];
      if (!best || g.bonus > best.bonus) checks[g.attribute] = g;
    }
  }
  return { weapon, armor, reduction: damageReduction(armor, bestArmor), checks };
}

/** 检定加值按七项属性的顺序列出来（网页、主持 AI 看）。 */
export function checkBonuses(totals: GearTotals): { attribute: Attribute2; gear: GearView }[] {
  return ATTRIBUTE2_KEYS.flatMap((k) => (totals.checks[k] ? [{ attribute: k, gear: totals.checks[k]! }] : []));
}

/** 商店：普通装备的价格（龙晶）。 */
export const COMMON_GEAR_PRICE = 60;

/** 新手礼：做第一张角色卡时送的三件普通装备（主手、胸部、颈部），直接穿上。 */
export const STARTER_GEAR = ['sword', 'mail', 'amulet'] as const;

/** 传奇装备一共几件（是什么、在哪掉只在服务器上；网页上没拿到的只显示「？？？」）。 */
export const LEGENDARY2_COUNT = 4;
