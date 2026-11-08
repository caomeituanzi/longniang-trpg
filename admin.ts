// 管理员的权限：站长（最高权限，只有一个）什么都能做；其他管理员由站长逐项下发。服务器和网页共用这一份。

export const ADMIN_PERMISSIONS = [
  { key: 'users', label: '账号管理', detail: '查看账号详情、写备注、重置密码、新建正式账号、删除游客账号' },
  { key: 'credit', label: '发放额度', detail: '给账号加减 AI 额度、设成不限额度，生成和删除额度兑换码；发龙晶、发物品，改商城里的价格、上架下架商品，管限时活动' },
  { key: 'ban', label: '封号和违规', detail: '封号、解封，处理违规记录' },
  { key: 'rooms', label: '管理所有对局', detail: '打开、观看任何对局，有房主的全部权限：选剧本、开局、暂停、结束、删除、主持工具，看完整记录' },
  { key: 'scenarios', label: '剧本管理', detail: '管理现成的剧本：上架、下架、查看全文、上传新剧本、删除上传的剧本' },
  { key: 'invites', label: '注册邀请码', detail: '生成、作废注册邀请码' },
  { key: 'announce', label: '发公告', detail: '给全服、某种身份的人、指定的人发公告' },
  { key: 'reports', label: '举报和大厅聊天', detail: '处理举报和反馈，撤回大厅聊天里的消息，设大厅的发言间隔，查看所有群聊和私信的记录' },
  { key: 'ai', label: 'AI 开关和模型', detail: '紧急停用 AI、切换各项用的模型' },
  { key: 'system', label: '版本和数据', detail: '查看版本和数据、手动备份、查看最近的错误' },
  { key: 'audit', label: '查看操作记录', detail: '查看管理员做过的操作' },
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS = ADMIN_PERMISSIONS.map((p) => p.key) as AdminPermission[];

export const PERMISSION_LABEL = Object.fromEntries(ADMIN_PERMISSIONS.map((p) => [p.key, p.label])) as Record<AdminPermission, string>;

/** 新任命的管理员默认有的权限（站长可以再改）：日常管理用得到的几项，不含额度、AI、数据这些花钱和动数据的。 */
export const DEFAULT_PERMISSIONS: AdminPermission[] = ['users', 'ban', 'rooms', 'scenarios', 'invites', 'announce', 'reports'];

/** 身份：游客、普通用户、管理员、站长。 */
export type Identity = 'guest' | 'user' | 'admin' | 'owner';

export const IDENTITY_LABEL: Record<Identity, string> = { guest: '游客', user: '普通用户', admin: '管理员', owner: '站长' };

/** 从数据库里读出来的权限列表（JSON 数组），去掉不认识的。 */
export function parsePermissions(text: string | null | undefined): AdminPermission[] {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? ALL_PERMISSIONS.filter((p) => value.includes(p)) : [];
  } catch {
    return [];
  }
}

/** 管理员封号最长定多久（小时）：一年。再长就选永久。 */
export const BAN_MAX_HOURS = 365 * 24;

/** 封号时选得到的几个时长（小时），null 是永久（等管理员解封）。 */
export const BAN_PRESETS: { hours: number | null; label: string }[] = [
  { hours: null, label: '永久' },
  { hours: 1, label: '1 小时' },
  { hours: 24, label: '1 天' },
  { hours: 3 * 24, label: '3 天' },
  { hours: 7 * 24, label: '7 天' },
  { hours: 30 * 24, label: '30 天' },
];

/** 封多久写成一句话：永久、几天（整天的）、几小时。 */
export function banLengthText(hours: number | null): string {
  if (hours === null) return '永久';
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
}

/**
 * 大厅聊天的发言限制（V0.5.0，防刷屏）：每人每隔这么多秒才能说一句，也不能连着发一样的话；0 是不限。
 * 有「举报和大厅聊天」权限的管理员不受限。
 */
export const LOBBY_SLOW_DEFAULT = 5;
export const LOBBY_SLOW_MAX = 600;
/** 和自己上一句一样的话，多久以内不能再发。 */
export const LOBBY_REPEAT_WINDOW_MS = 10 * 60_000;
/** 管理员「撤回他最近一小时的」：撤回一个人多久以内的大厅聊天。 */
export const LOBBY_RECALL_RECENT_MS = 60 * 60_000;
