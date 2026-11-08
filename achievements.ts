// 成就、称号、结局图鉴（V0.6.0）：服务器和网页共用这一份。

/** 成就：达成时得到同名的称号和龙晶。how 是怎么达成的（个人主页上列出来，没达成的灰着）。 */
export const ACHIEVEMENTS = [
  { key: 'first-game', title: '初入江湖', how: '第一次玩完剧本' },
  { key: 'five-categories', title: '五方游历', how: '五个分区的剧本都玩完过' },
  { key: 'endings-5', title: '见多识广', how: '达成 5 个不同的结局' },
  { key: 'all-endings', title: '穷尽可能', how: '一个剧本的结局全部达成过' },
  { key: 'crit-3', title: '天选之人', how: '一局里掷出 3 次大成功' },
  { key: 'fumble', title: '倒霉蛋', how: '掷出大失败' },
  { key: 'calm-horror', title: '心如止水', how: '玩完恐怖剧本时心智还是平静的' },
  { key: 'with-pet', title: '形影不离', how: '带着宠物玩完剧本' },
  { key: 'pet-save', title: '好帮手', how: '宠物出手，把失败变成了成功' },
  { key: 'job-10', title: '勤勤恳恳', how: '宠物打工 10 次' },
  { key: 'trip-5', title: '行万里路', how: '宠物远行 5 次' },
  { key: 'visit-10', title: '热心邻居', how: '串门 10 次' },
  { key: 'author', title: '执笔人', how: '投稿的剧本通过审核' },
  { key: 'author-5', title: '名作家', how: '你写的剧本被别人玩完 5 局' },
  { key: 'rater-3', title: '品鉴家', how: '评过 3 个剧本' },
] as const;

/**
 * 隐藏成就有几个（V0.6.0）：名字和条件只在服务器上（server/hidden-achievements.ts），网页上没达成的只显示「？？？」，
 * 达成了服务器才把名字和条件发过来。
 */
export const HIDDEN_ACHIEVEMENT_COUNT = 24;

export type AchievementKey = (typeof ACHIEVEMENTS)[number]['key'];

export function achievementOf(key: string) {
  return ACHIEVEMENTS.find((a) => a.key === key) ?? null;
}

/** 达成了的成就（活动称号也在里面，key 是 event-活动编号）。hidden：隐藏成就。 */
export type EarnedAchievement = { key: string; title: string; how: string; at: number; hidden?: boolean };

/** 能戴的称号：商店买的（shop）、成就得来的（achievement）。 */
export type TitleOption = { key: string; name: string; source: 'shop' | 'achievement' };

/** 个人主页上的成就和结局图鉴。titles 只有本人有（选戴哪个称号）。 */
export type ProfileCollection = {
  achievements: EarnedAchievement[];
  /** 达成的结局一共几个。 */
  endings: number;
  /** 本人才有：能戴的称号和戴着的。 */
  titles: { options: TitleOption[]; current: string | null } | null;
};

/**
 * 图鉴（V0.6.0）：结局（剧本大厅里的每个剧本，达成了的给名字，没达成的只算个数）、明信片（去过的地方）、
 * 装扮、骰子皮肤、成就。装扮、骰子、地点、普通成就的全部列表网页上有，这里只给我已经有的；隐藏成就达成了才给。
 */
export type CollectionBook = {
  endings: { key: string; title: string; total: number; reached: { key: string; title: string }[] }[];
  places: string[];
  outfits: string[];
  dice: string[];
  achievements: EarnedAchievement[];
};
