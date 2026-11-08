// 限时活动（V0.6.0）：服务器和网页共用这一份。
import type { ScenarioCategory } from './game';

/**
 * 一个活动：从 startsAt 到 endsAt（那一刻结束）。categories 里的分区玩完剧本龙晶翻倍；items 是限时商品；
 * title 不是空的：活动期间玩完翻倍分区的剧本，得到这个称号。
 */
export type EventView = {
  id: number;
  name: string;
  startsAt: number;
  endsAt: number;
  categories: ScenarioCategory[];
  items: string[];
  title: string;
};

export const EVENT_NAME_MAX = 20;
export const EVENT_TITLE_MAX = 8;
/** 翻倍分区的剧本玩完时，龙晶乘几。 */
export const EVENT_MULTIPLIER = 2;

/** 管理页「活动」里的模板：点一下填好名字、分区、限时商品、称号，再改时间。 */
export const EVENT_TEMPLATES: { key: string; name: string; categories: ScenarioCategory[]; items: string[]; title: string }[] = [
  { key: 'halloween', name: '万圣节', categories: ['horror'], items: ['outfit-pumpkin', 'outfit-ghost', 'dice-pumpkin'], title: '南瓜灯' },
  { key: 'christmas', name: '圣诞节', categories: ['adventure'], items: ['outfit-santa'], title: '雪夜旅人' },
  { key: 'spring', name: '春节', categories: ['social'], items: ['outfit-lantern', 'dice-red'], title: '红红火火' },
];
