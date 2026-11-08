// 浏览器推送（V0.8.0）：前后端共用的类型和推哪几类。

/** 推哪几类：约团、对局开始、轮到你、私信、邀请和申请、其他通知。 */
export const PUSH_CATEGORIES = ['schedule', 'started', 'turn', 'dm', 'invites', 'other'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export type PushPrefs = Record<PushCategory, boolean>;

/** 没改过的人：约团、对局开始、轮到你、私信、邀请和申请打开，其他通知关着。 */
export const DEFAULT_PUSH_PREFS: PushPrefs = { schedule: true, started: true, turn: true, dm: true, invites: true, other: false };

export const PUSH_CATEGORY_LABEL: Record<PushCategory, string> = {
  schedule: '约团',
  started: '对局开始',
  turn: '轮到你',
  dm: '私信',
  invites: '邀请和申请',
  other: '其他通知',
};

/** 收通知的一台设备（一个浏览器）。current：就是现在这台。 */
export type PushDevice = { id: number; label: string; createdAt: number; lastOkAt: number | null; current?: boolean };

/** GET /api/push：服务器的公钥（浏览器订阅时用）、推哪几类、我的设备。 */
export type PushInfo = { publicKey: string; prefs: PushPrefs; devices: PushDevice[] };

/** 每人最多几台设备（多了删最旧的）。 */
export const PUSH_MAX_DEVICES = 10;
