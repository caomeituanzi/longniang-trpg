// 约团（V0.8.0）：服务器和网页共用的数字和类型。
// 一局常常要分几次玩完：房主在对局里列几个候选时间，成员各自勾「能来 / 也许 / 来不了」，房主定下一个；
// 定下以后通知成员，开始前 30 分钟再提醒一次。时间一律是 UTC 毫秒，网页按浏览器的本地时间显示。
import type { Identity } from './admin';

/** 一次最多列几个候选时间。 */
export const SCHEDULE_MAX_SLOTS = 6;
/** 候选时间至少要比现在晚这么久（10 分钟）。 */
export const SCHEDULE_MIN_LEAD_MS = 10 * 60_000;
/** 候选时间最远到多久以后（60 天）。 */
export const SCHEDULE_MAX_AHEAD_MS = 60 * 24 * 60 * 60_000;
/** 附言最多几个字。 */
export const SCHEDULE_NOTE_MAX = 100;
/** 开始前多久提醒（30 分钟）。 */
export const SCHEDULE_REMIND_BEFORE_MS = 30 * 60_000;
/** 定下的时间过了开始时间这么久（6 小时）就算过去了：不再当作「下次」显示，房主可以再约。 */
export const SCHEDULE_PAST_AFTER_MS = 6 * 60 * 60_000;

/** 勾的：能来、也许、来不了。 */
export type ScheduleAnswer = 'yes' | 'maybe' | 'no';
export const SCHEDULE_ANSWERS: readonly ScheduleAnswer[] = ['yes', 'maybe', 'no'];
export const SCHEDULE_ANSWER_LABEL: Record<ScheduleAnswer, string> = { yes: '能来', maybe: '也许', no: '来不了' };

/** 和 UserBrief 一样（网页上显示一个人用）。 */
export type ScheduleUser = { publicId: string; displayName: string; avatar: string | null; identity: Identity; frame: string | null };

export type ScheduleSlot = {
  id: number;
  startsAt: number;
  /** 现在的成员各勾了什么（没勾的人不在里面；离开了对局的人不算）。 */
  votes: { user: ScheduleUser; answer: ScheduleAnswer }[];
  counts: Record<ScheduleAnswer, number>;
  /** 我勾的；没勾是 null。 */
  mine: ScheduleAnswer | null;
};

/** 一局现在的约团：open 正在勾，confirmed 定下了。 */
export type ScheduleView = {
  id: number;
  status: 'open' | 'confirmed';
  /** 附言（可以是空的）。 */
  note: string;
  /** 谁列的（账号删了是 null）。 */
  createdBy: ScheduleUser | null;
  createdAt: number;
  updatedAt: number;
  /** 按时间先后排好。 */
  slots: ScheduleSlot[];
  /** 定下的是哪个（还在勾的是 null）。 */
  confirmedSlotId: number | null;
  /** 定下的时间（还在勾的是 null）。 */
  startsAt: number | null;
  /** 定下的时间已经过了开始时间 6 小时：不再当作「下次」，房主可以再约。 */
  past: boolean;
  /** 我是房主：能列、定、取消。 */
  canManage: boolean;
  /** 现在有几个成员；其中勾过（至少勾了一个时间）的有几个。 */
  members: number;
  answered: number;
  /** 一个时间都还没勾的成员。 */
  waiting: ScheduleUser[];
};

/** GET /api/rooms/:id/schedule 等接口的返回：现在的约团（没有是 null），now 是服务器的时间。 */
export type ScheduleResponse = { schedule: ScheduleView | null; now: number };

/** 「我的对局」每一局的约团：下次定下的时间（还没过去的，没有是 null）；有正在勾的、我一个都还没勾。 */
export type ScheduleMine = { roomId: number; startsAt: number | null; needsVote: boolean };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 约团的时间按这台设备的本地时间写出来：「10月30日 周五 20:00」。 */
export function scheduleTimeText(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
