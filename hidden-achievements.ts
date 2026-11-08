// 隐藏成就（V0.6.0）：只放在服务器上，网页的代码里没有（不然翻网页代码就看到了）。
// 没达成之前图鉴和个人主页上只显示「？？？」；达成了和普通成就一样：记下、给龙晶、发通知、得到同名的称号。
// 网站向导也不知道条件（它的说明里只有个数）。

import { HIDDEN_ACHIEVEMENT_COUNT, type AchievementKey } from '../shared/achievements';

export const HIDDEN_ACHIEVEMENTS = [
  { key: 'night-owl', title: '夜猫子', how: '凌晨 2 点到 5 点之间玩完一局' },
  { key: 'midnight-horror', title: '午夜凶铃', how: '半夜 0 点到 1 点之间玩完恐怖剧本' },
  { key: 'halloween', title: '不给糖就捣蛋', how: '万圣节（10 月 31 日）当天玩完一局' },
  { key: 'swing', title: '大起大落', how: '同一局里既掷出大成功，又掷出大失败' },
  { key: 'double-fumble', title: '祸不单行', how: '一局里掷出两次大失败' },
  { key: 'smooth', title: '一路顺风', how: '一局里检定 5 次以上，一次都没失败' },
  { key: 'last-breath', title: '九死一生', how: '角色濒死，还是撑到了结局' },
  { key: 'sacrifice', title: '舍生取义', how: '角色死了，故事还是走到了结局' },
  { key: 'speedrun', title: '速战速决', how: '开场以后不到一小时就走到结局' },
  { key: 'old-friends', title: '老搭档', how: '和同一个人一起玩完 5 局' },
  { key: 'pet-crit', title: '神来一爪', how: '宠物出手，掷出大成功' },
  { key: 'overfed', title: '吃撑了', how: '宠物吃饱了还接着喂' },
  { key: 'popular-pet', title: '人见人爱', how: '宠物被好友串门 20 次' },
  { key: 'regular', title: '回头客', how: '同一个剧本玩完 3 次' },
  { key: 'postcards-all', title: '环游世界', how: '集齐所有地方的明信片' },
  { key: 'rich', title: '家财万贯', how: '手里同时攒着 1000 龙晶' },
  // V0.7.0：角色卡、地下城、切磋
  { key: 'first-clear', title: '初探幽境', how: '第一次活着通关地下城' },
  { key: 'large-clear', title: '众志成城', how: '通关一个大型地下城' },
  { key: 'qiyu', title: '机缘巧合', how: '在地下城里碰上奇遇' },
  { key: 'skills-3', title: '博采众长', how: '一张角色卡学会 3 门技能' },
  { key: 'peak', title: '登峰造极', how: '一张角色卡的某一项属性练到 +10' },
  { key: 'legend', title: '天命所归', how: '拿到一件传奇装备' },
  { key: 'legend-all', title: '神兵谱', how: '集齐所有传奇装备' },
  { key: 'duel-10', title: '百战不殆', how: '一张角色卡切磋赢满 10 场' },
] as const;

export type HiddenAchievementKey = (typeof HIDDEN_ACHIEVEMENTS)[number]['key'];
/** 普通成就和隐藏成就。 */
export type AnyAchievementKey = AchievementKey | HiddenAchievementKey;

export function hiddenAchievementOf(key: string) {
  return HIDDEN_ACHIEVEMENTS.find((a) => a.key === key) ?? null;
}

/** 「家财万贯」：手里同时有这么多龙晶。 */
export const RICH_CRYSTALS = 1000;
/** 「一路顺风」：一局里至少检定几次。 */
export const SMOOTH_ROLLS = 5;
/** 「老搭档」：和同一个人一起玩完几局。 */
export const OLD_FRIENDS_GAMES = 5;
/** 「速战速决」：开场以后多久之内走到结局。 */
export const SPEEDRUN_MS = 60 * 60_000;
/**
 * 「人见人爱」：宠物被好友串门几次（每个好友每天只算第一次）。V0.7.0 去掉了宠物留言，以前按收到的留言算；
 * 已经得到的照样留着。
 */
export const POPULAR_VISITS = 20;
/** 「回头客」：同一个剧本玩完几次。 */
export const REGULAR_GAMES = 3;

// 网页上只知道个数：两边对不上说明改了一边忘了另一边
if (HIDDEN_ACHIEVEMENTS.length !== HIDDEN_ACHIEVEMENT_COUNT) {
  throw new Error(`隐藏成就有 ${HIDDEN_ACHIEVEMENTS.length} 个，shared/achievements.ts 里的 HIDDEN_ACHIEVEMENT_COUNT 是 ${HIDDEN_ACHIEVEMENT_COUNT}`);
}
