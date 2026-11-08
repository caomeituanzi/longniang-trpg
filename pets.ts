// 宠物（V0.5.0）：每个正式账号一只，场外的、不属于任何剧本。服务器和网页共用这一份规则。
import type { AttributeKey } from './rules';

export const PET_NAME_MAX = 12;
export const PET_DESCRIPTION_MAX = 200;
/** 宠物的图最大多少字节（网页上传前会缩小；转成 base64 以后还要在请求大小的上限 256 KB 以内）。 */
export const PET_IMAGE_MAX_BYTES = 180 * 1024;

/** 饱食度、精力都是 0～100。 */
export const PET_STAT_MAX = 100;
/** 刚养的宠物的饱食度、精力。 */
export const PET_START = { satiety: 80, energy: 100 } as const;
/** 饱食度每小时降多少；精力每小时回多少（打工的时候不回）。 */
export const SATIETY_PER_HOUR = 2;
export const ENERGY_PER_HOUR = 4;

/** 玩完一个剧本（走到结局）：自己至少交过几个行动才算；另外给多少龙晶。分区对应的属性 +1。 */
export const GAME_MIN_ACTIONS = 3;
export const GAME_REWARD_CRYSTALS = 20;

export type JobTier = 1 | 2 | 3;

/** 三档工：要求的属性、要多久、花多少精力和饱食度、挣多少龙晶。 */
export const JOB_TIERS: Record<JobTier, { need: number; hours: number; energy: number; satiety: number; pay: number }> = {
  1: { need: 0, hours: 1, energy: 20, satiety: 10, pay: 10 },
  2: { need: 3, hours: 4, energy: 40, satiety: 25, pay: 50 },
  3: { need: 6, hours: 8, energy: 60, satiety: 40, pay: 120 },
};

/** 五项属性各三档工。 */
export const PET_JOBS = [
  { key: 'porter', attribute: 'body', tier: 1, name: '码头扛包' },
  { key: 'escort', attribute: 'body', tier: 2, name: '镖局走镖' },
  { key: 'sparring', attribute: 'body', tier: 3, name: '擂台陪练' },
  { key: 'courier', attribute: 'agility', tier: 1, name: '跑腿送信' },
  { key: 'rider', attribute: 'agility', tier: 2, name: '驿站快马' },
  { key: 'acrobat', attribute: 'agility', tier: 3, name: '杂技班子' },
  { key: 'copyist', attribute: 'intellect', tier: 1, name: '抄书' },
  { key: 'bookkeeper', attribute: 'intellect', tier: 2, name: '当账房' },
  { key: 'lecturer', attribute: 'intellect', tier: 3, name: '书院讲学' },
  { key: 'watchman', attribute: 'perception', tier: 1, name: '打更巡夜' },
  { key: 'finder', attribute: 'perception', tier: 2, name: '帮人寻物' },
  { key: 'appraiser', attribute: 'perception', tier: 3, name: '古董鉴宝' },
  { key: 'hawker', attribute: 'charm', tier: 1, name: '街头吆喝' },
  { key: 'storyteller', attribute: 'charm', tier: 2, name: '茶馆说书' },
  { key: 'opera', attribute: 'charm', tier: 3, name: '戏台唱戏' },
] as const satisfies readonly { key: string; attribute: AttributeKey; tier: JobTier; name: string }[];

export type PetJobKey = (typeof PET_JOBS)[number]['key'];

/** 骰子皮肤、宠物装扮（V0.6.0）、头像框（V0.7.0）买一次就够，和称号一样。 */
export type ShopItemKind = 'food' | 'tea' | 'rename' | 'title' | 'dice' | 'outfit' | 'frame';

/**
 * 这些东西在「商城」里卖（V0.7.0 起商城还卖地下城道具、装备、换额度，见 shared/shop.ts；价格管理员能改，这里是默认价）。
 * 吃的加饱食度，提神茶加精力，改名卡给宠物改一次名字，称号买了以后能戴上（V0.6.0 起称号是账号的）；
 * 骰子皮肤换掷骰时骰子的样子，装扮戴在宠物身上（V0.6.0），头像框画在自己的头像外面（V0.7.0）。
 * event 的是限时商品：只在列着它的活动期间卖，买了的一直留着。
 */
export const PET_SHOP = [
  { key: 'fish', name: '小鱼干', price: 5, kind: 'food', satiety: 20 },
  { key: 'skewer', name: '烤肉串', price: 12, kind: 'food', satiety: 50 },
  { key: 'dragonfruit', name: '龙果', price: 25, kind: 'food', satiety: 100 },
  { key: 'tea', name: '提神茶', price: 20, kind: 'tea', energy: 50 },
  { key: 'rename', name: '改名卡', price: 100, kind: 'rename' },
  { key: 'title-novice', name: '初出茅庐', price: 50, kind: 'title' },
  { key: 'title-known', name: '小有名气', price: 200, kind: 'title' },
  { key: 'title-famed', name: '名动一方', price: 500, kind: 'title' },
  { key: 'title-rich', name: '龙晶富翁', price: 1000, kind: 'title' },
  { key: 'dice-jade', name: '玉骰', price: 120, kind: 'dice' },
  { key: 'dice-bone', name: '骨骰', price: 120, kind: 'dice' },
  { key: 'dice-ink', name: '墨骰', price: 200, kind: 'dice' },
  { key: 'dice-gold', name: '金骰', price: 500, kind: 'dice' },
  { key: 'outfit-scarf', name: '红围巾', price: 80, kind: 'outfit' },
  { key: 'outfit-bow', name: '蝴蝶结', price: 80, kind: 'outfit' },
  { key: 'outfit-bell', name: '小铃铛', price: 120, kind: 'outfit' },
  { key: 'outfit-scholar', name: '书生帽', price: 150, kind: 'outfit' },
  { key: 'outfit-pumpkin', name: '南瓜帽', price: 100, kind: 'outfit', event: true },
  { key: 'outfit-ghost', name: '小幽灵披风', price: 100, kind: 'outfit', event: true },
  { key: 'dice-pumpkin', name: '南瓜骰', price: 150, kind: 'dice', event: true },
  { key: 'outfit-santa', name: '圣诞帽', price: 100, kind: 'outfit', event: true },
  { key: 'outfit-lantern', name: '小灯笼', price: 100, kind: 'outfit', event: true },
  { key: 'dice-red', name: '红金骰', price: 150, kind: 'dice', event: true },
  // 头像框（V0.7.0）：纸和墨的颜色，样子在网页的 styles.css（.avatar-frame-…）
  { key: 'frame-ink', name: '墨痕', price: 80, kind: 'frame' },
  { key: 'frame-jade', name: '青玉', price: 120, kind: 'frame' },
  { key: 'frame-seal', name: '朱印', price: 150, kind: 'frame' },
  { key: 'frame-porcelain', name: '青花', price: 200, kind: 'frame' },
  { key: 'frame-gold', name: '描金', price: 400, kind: 'frame' },
] as const satisfies readonly { key: string; name: string; price: number; kind: ShopItemKind; satiety?: number; energy?: number; event?: true }[];

/** 限时商品（活动里选卖哪几样）。 */
export const EVENT_ITEMS = PET_SHOP.filter((i) => 'event' in i && i.event).map((i) => i.key);

export function shopItemOf(key: string | null | undefined) {
  return PET_SHOP.find((i) => i.key === key) ?? null;
}

/** 认得的头像框的 key（不认识的、不是头像框的是 null）：发给网页的用户简介里带着它。 */
export function frameOf(key: string | null | undefined): string | null {
  const item = shopItemOf(key);
  return item?.kind === 'frame' ? item.key : null;
}

// ==================== 远行（V0.6.0） ====================

export type TripKind = 'near' | 'far';

/** 附近转转、出远门：要多久、花多少精力和饱食度、带回多少龙晶（在这个范围里随机），出远门另外带一份吃的。 */
export const TRIPS: Record<TripKind, { name: string; hours: number; energy: number; satiety: number; crystals: [number, number]; food: boolean }> = {
  near: { name: '附近转转', hours: 2, energy: 15, satiety: 10, crystals: [5, 15], food: false },
  far: { name: '出远门', hours: 8, energy: 40, satiety: 30, crystals: [20, 40], food: true },
};

export type PetTripView = { kind: TripKind; name: string; startedAt: number; endsAt: number };

// ==================== 串门（V0.6.0） ====================
// 宠物留言、宠物排行 V0.7.0 去掉了（排行改在「排行」页：作品、作者、角色）。

/** 每天第一次串门同一只宠物，两边各得多少龙晶。 */
export const VISIT_REWARD = 3;

/** 每个排行榜列几名。 */
export const RANK_SIZE = 20;

// ==================== 宠物出手（V0.6.0） ====================

/** 宠物帮着重掷时的加值：这一项属性到 6 加 2，到 3 加 1。 */
export function petHelpBonus(value: number): number {
  return value >= 6 ? 2 : value >= 3 ? 1 : 0;
}

// ==================== 日记和明信片（V0.6.0） ====================

export type DiaryEntry = {
  id: number;
  kind: 'diary' | 'postcard';
  title: string;
  text: string;
  /** 日记还在写（等 AI）。 */
  writing: boolean;
  at: number;
};

// ==================== 奖励（V0.6.0） ====================

/** 第一次达成某个结局多给的龙晶；达成一个成就给的龙晶。 */
export const ENDING_REWARD = 10;
export const ACHIEVEMENT_REWARD = 20;
/** 作者分成：别人玩完一局给作者的龙晶，每天最多给多少。 */
export const AUTHOR_REWARD = 10;
export const AUTHOR_DAILY_CAP = 50;

/** 一次最多买几个。 */
export const BUY_MAX = 20;

/** 龙晶换 AI 额度：rate 龙晶换 1 元；每人每月最多 userCap 元，全站每月最多 siteCap 元。管理员能改、能关掉。 */
export type ExchangeSettings = { enabled: boolean; rate: number; userCap: number; siteCap: number };
export const EXCHANGE_DEFAULTS: ExchangeSettings = { enabled: true, rate: 100, userCap: 5, siteCap: 50 };
export const EXCHANGE_LIMITS = { rateMax: 100_000, userCapMax: 1000, siteCapMax: 100_000 };

/** 龙晶的一笔进出是怎么来的。 */
export type LedgerKind = 'job' | 'game' | 'buy' | 'exchange' | 'grant' | 'duel' | 'visit' | 'trip' | 'ending' | 'achievement' | 'author' | 'chest';
export const LEDGER_LABEL: Record<LedgerKind, string> = {
  job: '打工',
  game: '玩完剧本',
  buy: '买东西',
  exchange: '换额度',
  grant: '管理员发',
  duel: '切磋',
  visit: '串门',
  trip: '远行',
  ending: '达成结局',
  achievement: '成就',
  author: '作者分成',
  chest: '开宝箱',
};

export type PetJobView = { key: PetJobKey; name: string; attribute: AttributeKey; tier: JobTier; startedAt: number; endsAt: number; pay: number };

export type PetView = {
  name: string;
  description: string;
  /** 图片的地址（没传图是 null）。 */
  image: string | null;
  /** 戴着的装扮的 key（V0.6.0）。称号只属于账号（V0.7.0 起宠物身上不再显示）。 */
  outfit: string | null;
  attributes: Record<AttributeKey, number>;
  satiety: number;
  energy: number;
  job: PetJobView | null;
  /** 远行（V0.6.0）：出门了是去哪、什么时候回来。 */
  trip: PetTripView | null;
  createdAt: number;
};

/** 换额度的情况（商城里「换额度」那一件）：设置，加上这个人这个月换了多少、全站还剩多少、他能不能换。 */
export type ExchangeView = ExchangeSettings & {
  /** 这个月自己已经换了多少元；全站还能换多少元。 */
  usedThisMonth: number;
  siteLeft: number;
  /** 额度不限的人（站长、设成不限的）用不着换。 */
  unlimited: boolean;
  /** 管理员不能换（他们能改换额度的设置）。 */
  adminBlocked: boolean;
};

/**
 * 宠物页：自己的宠物（还没养是 null）、玩完剧本攒下的属性、玩完的剧本。
 * V0.7.0 起龙晶、背包、商店、称号、骰子、装扮、换额度都不在宠物页了（见「商城」「我的背包」「装扮」）。
 */
export type PetPage = {
  pet: PetView | null;
  /** 玩完剧本攒下的属性（还没养宠物时也记着，养了以后就是宠物的属性）。 */
  growth: Record<AttributeKey, number>;
  games: { title: string; attribute: AttributeKey | null; at: number }[];
};

/**
 * 个人主页上别人看得到的宠物（V0.6.0 加了装扮）。visit：我能不能串门（好友才能）、今天串过没有；
 * 我背包里能喂的吃的。
 */
export type PublicPet = Pick<PetView, 'name' | 'description' | 'image' | 'attributes' | 'outfit'> & {
  visit: { allowed: boolean; visitedToday: boolean; food: { key: string; name: string; count: number }[] } | null;
};

/** 管理页账号详情里的宠物和龙晶。 */
export type AdminPetSummary = {
  crystals: number;
  pet: { name: string; satiety: number; energy: number; job: string | null } | null;
  growth: Record<AttributeKey, number>;
  ledger: { delta: number; balance: number; kind: LedgerKind; detail: string; at: number; by: string | null }[];
};

/** 管理页「宠物」：换额度的设置、这个月全站换了多少、最近换的。 */
export type AdminPetsOverview = {
  exchange: ExchangeSettings;
  siteUsedThisMonth: number;
  recent: { crystals: number; yuan: number; at: number; name: string; uid: number | null }[];
};
