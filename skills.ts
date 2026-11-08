// 技能、秘籍和奇遇（V0.7.0）：只放在服务器上，网页的代码里没有。
// 技能：角色卡学会以后，在地下城里花精神值用（主持 AI 调 use_skill）。只能从秘籍学，一张卡最多 SKILL_MAX 门。
// 秘籍：地下城的奇遇、宝物、宝箱里得到，记在账号背包里（pet_items，key 是 manual:技能编号），在「我的角色」里研读给一张卡。
// 奇遇：地下城里，角色走到新的地方时，如果某一项属性够高（难度 + 2 以上），有机会碰上（每人每局最多 QIYU_PER_RUN 次），
// 得到秘籍或者好装备。条件只在这里，玩家看不到，主持 AI 只在触发时才知道。

import type { Attribute2, Rarity } from '../shared/rules2';

export type SkillEffect =
  /** 一次加强的攻击：命中加 hit、伤害加 damage、无视 pierce 点防御。melee：只能近战（要和敌人站在一起，V1.0.x 站位）。 */
  | { type: 'strike'; hit: number; damage: number; pierce: number; attribute: 'strength' | 'agility'; melee?: boolean }
  /** 一次攻击打这个地点所有没倒下的敌人（每个敌人分别比防御），伤害减半。 */
  | { type: 'sweep'; attribute: 'strength' | 'agility' | 'will' }
  /** 给身边的一个同伴（或自己）回生命值：2d6 + bonus。 */
  | { type: 'heal'; bonus: number }
  /** 给身边的一个同伴（或自己）回精神值、从失控里拉回来：2d6 + bonus。 */
  | { type: 'restore'; bonus: number }
  /** 给身边的同伴下一次检定或攻击加 value（all：在场的所有同伴）。 */
  | { type: 'boost'; value: number; all: boolean }
  /** 这场战斗里，一个同伴（或自己）的护甲再加 value。 */
  | { type: 'ward'; value: number }
  /** 吓退这个地点没倒下的小怪（count 个）。 */
  | { type: 'scare'; count: number }
  /** 看破：主持 AI 告诉他首领这一局的弱点是什么。 */
  | { type: 'insight' }
  /** 只在故事里起作用：主持 AI 照效果写，相关的检定给 +bonus 修正。 */
  | { type: 'story'; bonus: number };

export type Skill = { key: string; name: string; attribute: Attribute2; cost: number; effect: SkillEffect; text: string };

export const SKILLS: readonly Skill[] = [
  { key: 'pojun', name: '破军一击', attribute: 'strength', cost: 3, effect: { type: 'strike', hit: 2, damage: 4, pierce: 0, attribute: 'strength', melee: true }, text: '聚力一击：这次近战攻击 +2，打中再多 4 点伤害。' },
  { key: 'kaishan', name: '开山劲', attribute: 'strength', cost: 2, effect: { type: 'story', bonus: 3 }, text: '一身蛮力：破门、推石、扛起重物这类力气活 +3。' },
  { key: 'jinzhong', name: '金钟罩', attribute: 'constitution', cost: 3, effect: { type: 'ward', value: 3 }, text: '运气护体：这场战斗里自己或一个同伴的护甲再 +3。' },
  { key: 'guixi', name: '龟息功', attribute: 'constitution', cost: 2, effect: { type: 'story', bonus: 3 }, text: '闭气凝神：憋气、抗毒、熬过寒热这类硬撑的事 +3。' },
  { key: 'lianzhu', name: '连珠箭', attribute: 'agility', cost: 5, effect: { type: 'sweep', attribute: 'agility' }, text: '一口气射出数箭：对这里每个没倒下的敌人各攻击一次（伤害减半）。' },
  { key: 'yanzi', name: '燕子三抄水', attribute: 'agility', cost: 2, effect: { type: 'story', bonus: 3 }, text: '轻功身法：飞檐走壁、越过险地、甩开追兵 +3。' },
  { key: 'qimen', name: '奇门遁甲', attribute: 'intellect', cost: 3, effect: { type: 'story', bonus: 3 }, text: '通晓机关阵法：找暗门、破阵、拆机关 +3。' },
  { key: 'kanpo', name: '看破', attribute: 'intellect', cost: 4, effect: { type: 'insight' }, text: '一眼看出首领的破绽：主持人会告诉你它这一局的弱点。' },
  { key: 'tingfeng', name: '听风辨位', attribute: 'perception', cost: 2, effect: { type: 'story', bonus: 3 }, text: '耳聪目明：察觉埋伏、找藏起来的东西 +3。' },
  { key: 'dongcha', name: '弱点洞察', attribute: 'perception', cost: 3, effect: { type: 'strike', hit: 1, damage: 2, pierce: 3, attribute: 'agility' }, text: '看准要害：这次攻击无视 3 点防御，+1，打中多 2 点伤害。' },
  { key: 'qingxin', name: '清心诀', attribute: 'will', cost: 2, effect: { type: 'restore', bonus: 2 }, text: '念诀定神：给自己或一个同伴回 2d6+2 点精神值，失控的能清醒过来。' },
  { key: 'zhenhun', name: '镇魂咒', attribute: 'will', cost: 5, effect: { type: 'sweep', attribute: 'will' }, text: '以意志震慑邪祟：用意志对这里每个没倒下的敌人各攻击一次（伤害减半）。' },
  { key: 'huichun', name: '回春术', attribute: 'will', cost: 4, effect: { type: 'heal', bonus: 3 }, text: '妙手回春：给自己或一个同伴回 2d6+3 点生命值，濒死的能救回来。' },
  { key: 'weishe', name: '威慑', attribute: 'charm', cost: 3, effect: { type: 'scare', count: 2 }, text: '一声断喝：这里最多两个小怪吓得逃走。' },
  { key: 'jili', name: '激励', attribute: 'charm', cost: 4, effect: { type: 'boost', value: 2, all: true }, text: '鼓舞士气：在场的同伴下一次检定或攻击 +2。' },
];

/** 一张卡最多学几门技能。 */
export const SKILL_MAX = 6;
/** 秘籍在背包里的 key 前缀。 */
export const MANUAL_PREFIX = 'manual:';

export function skillOf(key: string | null | undefined): Skill | null {
  return SKILLS.find((s) => s.key === key) ?? null;
}

/** 秘籍（背包里的一样东西）给人看的样子。不认识的是 null。 */
export function manualView(itemKey: string): { key: string; skill: string; name: string; text: string; cost: number } | null {
  if (!itemKey.startsWith(MANUAL_PREFIX)) return null;
  const skill = skillOf(itemKey.slice(MANUAL_PREFIX.length));
  return skill ? { key: itemKey, skill: skill.key, name: `秘籍《${skill.name}》`, text: skill.text, cost: skill.cost } : null;
}

/** 技能给人看的样子（网页、主持 AI）。 */
export type SkillView = { key: string; name: string; cost: number; text: string };

export function skillView(key: string): SkillView | null {
  const s = skillOf(key);
  return s ? { key: s.key, name: s.name, cost: s.cost, text: s.text } : null;
}

// ---------- 奇遇 ----------

export type Qiyu = {
  key: string;
  title: string;
  attribute: Attribute2;
  /** 给主持 AI 的场景提示：照这个写，融进这个地点和剧本的气氛里。 */
  scene: string;
  reward: { kind: 'manual' } | { kind: 'gear'; slot?: 'weapon' | 'armor' | 'accessory'; rarity: Exclude<Rarity, 'legendary' | 'common' | 'fine'> };
};

export const QIYU: readonly Qiyu[] = [
  { key: 'inscription', title: '石壁残字', attribute: 'intellect', scene: '墙上、地上或器物上有一段几乎被磨平的刻字，只有学识够的人认得出那是一门功法的口诀。', reward: { kind: 'manual' } },
  { key: 'hidden-niche', title: '暗格', attribute: 'perception', scene: '有一处别人都看漏了的暗格或夹层，里面藏着前人留下的东西。', reward: { kind: 'gear', rarity: 'rare' } },
  { key: 'lingering-soul', title: '残魂托付', attribute: 'will', scene: '一缕残魂（或一段执念的回响）找上了心志坚定的人，把生前的本事托付给他。', reward: { kind: 'manual' } },
  { key: 'sealed-chest', title: '千斤匣', attribute: 'strength', scene: '一只沉得出奇、卡死在石缝或废墟里的匣子，只有力气够大的人搬得开。', reward: { kind: 'gear', slot: 'weapon', rarity: 'rare' } },
  { key: 'hermit', title: '异人指点', attribute: 'charm', scene: '一个来历不明的怪人（隐士、过路的老者、某种通人性的东西）对这个角色另眼相看，指点了几招。', reward: { kind: 'manual' } },
  { key: 'ledge', title: '绝壁小径', attribute: 'agility', scene: '一条只有身手极好的人才上得去的小路或横梁，尽头有前人藏下的东西。', reward: { kind: 'manual' } },
  { key: 'strange-spring', title: '异泉', attribute: 'constitution', scene: '一汪颜色古怪的泉水或一株怪草，体魄不够的人碰了会难受，扛得住的人反而脱胎换骨、悟出一门功夫。', reward: { kind: 'manual' } },
  { key: 'old-armory', title: '前人遗甲', attribute: 'perception', scene: '尘土下压着一副保存完好的护具，要细心才发现得了。', reward: { kind: 'gear', slot: 'armor', rarity: 'rare' } },
  { key: 'star-chart', title: '星图', attribute: 'intellect', scene: '顶上或墙上有一幅暗合星宿的图，看懂的人能找到藏在图眼里的宝物。', reward: { kind: 'gear', slot: 'accessory', rarity: 'epic' } },
];

/** 属性要到「难度 + 这个数」才可能碰上奇遇。 */
export const QIYU_THRESHOLD = 2;
/** 走到新地方时，条件够了，有百分之几的机会碰上。 */
export const QIYU_CHANCE = 30;
/** 每个角色每局最多碰上几次。 */
export const QIYU_PER_RUN = 1;
