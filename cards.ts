// 自带角色卡（V0.7.0，规则第二版）：服务器和网页共用这一份。只在地下城里用，所以成长不封顶。
// 规则的数字在 shared/rules2.ts，装备在 shared/gear2.ts。
import type { GearView } from './gear2';
import type { Attribute2, Attributes2, ConsumableKey, DungeonResult, DungeonSize, EquipSlot } from './rules2';

export type CardView = {
  id: number;
  name: string;
  appearance: string;
  background: string;
  attributes: Attributes2;
  specialties: string[];
  /** 攒着没用的成长点；一共用掉了多少。 */
  points: number;
  spent: number;
  /** 穿着的装备（十六个格子，每个格子一件）。 */
  equipped: Partial<Record<EquipSlot, GearView>>;
  /** 生命值、精神值的上限，防御，战力。 */
  hpMax: number;
  mpMax: number;
  defense: number;
  power: number;
  /** 切磋的胜负。 */
  duel: { wins: number; losses: number };
  /** 在不在个人主页上展示（V0.8.1，默认展示）。 */
  onProfile: boolean;
  /** 正在哪一局地下城里（还没结束的）；不在是 null。在地下城里的卡不能改、不能换装备。 */
  inRoom: { id: number; name: string } | null;
  /** 经历：带着它打过的地下城，新的在前。 */
  history: CardHistory[];
  /** 学会的技能（从秘籍研读来的）。 */
  skills: { key: string; name: string; cost: number; text: string }[];
  createdAt: number;
};

export type CardHistory = {
  title: string;
  level: number | null;
  result: DungeonResult | 'dead' | null;
  ending: string | null;
  points: number;
  /** 带出来的东西（名字）。 */
  loot: string[];
  at: number;
};

/** 用成长点：一项属性 +1（花 raiseCost 点），或者学一个新专长（花 CARD2_SPECIALTY_COST 点）。 */
export type CardGrowth = { type: 'attribute'; key: Attribute2 } | { type: 'specialty'; name: string };

/** 「角色」页要的东西：自己的卡、有的装备、道具、宝箱。 */
export type CardsPage = {
  cards: CardView[];
  /** 背包里的秘籍（研读给一张卡）。 */
  manuals: { key: string; name: string; text: string; count: number }[];
  /** 最近的切磋。 */
  duels?: DuelView[];
  /** 账号有的装备（穿在哪张卡的哪个格子上见 wornBy）。 */
  gear: (GearView & { wornBy: { cardId: number; name: string; slot: EquipSlot } | null })[];
  bag: Partial<Record<ConsumableKey, number>>;
  chests: number;
  /** 最近开的宝箱。 */
  recentChests: (ChestResult & { at: number })[];
  /** 今天还能主动切磋几次。 */
  duelsLeft: number;
  crystals: number;
};

/** 开一个宝箱开出来的东西：必有的龙晶，再加道具或者装备（已经有的装备折成龙晶：duplicate）。 */
export type ChestResult = {
  crystals: number;
  item: { key: ConsumableKey; name: string; count: number } | null;
  gear: (GearView & { duplicate: number | null }) | null;
};

/** 排行：战力榜、切磋胜场榜的一行。 */
export type CardRankRow = {
  rank: number;
  cardId: number;
  name: string;
  owner: { publicId: string; displayName: string; avatar: string | null; frame: string | null };
  power: number;
  wins: number;
  losses: number;
  /** 通关过几次地下城。 */
  clears: number;
  me: boolean;
};

export type CardRankings = { power: CardRankRow[]; wins: CardRankRow[] };

/** 别人能看到的一张卡（个人主页）：背景、经历、成长点这些私事不在里面。V0.8.1 加了生命、精神、防御、技能、通关次数。 */
export type PublicCard = {
  id: number;
  name: string;
  appearance: string;
  attributes: Attributes2;
  specialties: string[];
  equipped: Partial<Record<EquipSlot, GearView>>;
  hpMax: number;
  mpMax: number;
  defense: number;
  power: number;
  duel: { wins: number; losses: number };
  /** 学会的技能（名字和说明）。 */
  skills: { name: string; text: string }[];
  /** 带着它通关过几次地下城。 */
  clears: number;
};

/** 切磋的一轮：比哪一项、两边掷了多少（宠物帮忙重掷的写在 pet 里）。 */
export type DuelRound = {
  attribute: Attribute2;
  a: { dice: [number, number]; bonus: number; total: number; pet?: { name: string; first: number } };
  b: { dice: [number, number]; bonus: number; total: number; pet?: { name: string; first: number } };
  winner: 'a' | 'b' | 'tie';
};

export type DuelView = {
  id: number;
  /** a 是挑战的一方，b 是被挑战的。 */
  a: { publicId: string; displayName: string; card: string };
  b: { publicId: string; displayName: string; card: string };
  rounds: DuelRound[];
  winner: 'a' | 'b';
  /** 看的人自己这一场得了多少龙晶。 */
  myReward: number;
  at: number;
};

/** 地下城结束后给一张卡结算的结果（通知、经历里用）。 */
export type DungeonSettlement = {
  cardId: number;
  cardName: string;
  title: string;
  level: number;
  size: DungeonSize;
  result: DungeonResult | 'dead';
  points: number;
  chests: number;
  loot: string[];
  crystals: number;
};
