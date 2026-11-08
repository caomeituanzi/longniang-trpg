// 群聊（V0.7.0，「社交」里）：服务器和网页共用的数字和类型。
import type { Identity } from './admin';

/** 群名最多几个字。 */
export const GROUP_NAME_MAX = 20;
/** 一条群消息最多几个字。 */
export const GROUP_MESSAGE_MAX = 500;
/** 一个群最多几个人（连群主）。 */
export const GROUP_MEMBERS_MAX = 50;
/** 一个人最多在几个群里。 */
export const GROUPS_JOINED_MAX = 30;
/** 一次给几条消息（往前翻也是）。 */
export const GROUP_PAGE = 50;

export type GroupUser = { publicId: string; displayName: string; avatar: string | null; identity: Identity; frame: string | null };

export type GroupMessage = {
  id: number;
  /** system：「谁进群了」这类提示。 */
  kind: 'text' | 'system';
  text: string;
  at: number;
  /** 谁发的（system 的、账号删了的是 null）。 */
  from: GroupUser | null;
  mine: boolean;
  /** 撤回了：self 自己撤回的，admin 管理员撤回的（text 是空的）。 */
  withdrawn: 'self' | 'admin' | null;
  /** 发的人被我屏蔽了（text 是空的）。 */
  hidden?: boolean;
};

/** 「社交」左边群聊列表里的一行。 */
export type GroupSummary = {
  id: number;
  name: string;
  members: number;
  /** 我是群主。 */
  owner: boolean;
  unread: number;
  last: { text: string; from: string | null; at: number } | null;
  createdAt: number;
};

export type GroupMember = GroupUser & { owner: boolean; online: boolean; joinedAt: number };

/** 打开一个群：成员和最近的消息。 */
export type GroupDetail = {
  id: number;
  name: string;
  owner: boolean;
  members: GroupMember[];
  messages: GroupMessage[];
  hasMore: boolean;
};

/** 管理页「群聊」：所有的群（解散了的也在）。 */
export type AdminGroupRow = {
  id: number;
  name: string;
  owner: GroupUser | null;
  members: number;
  messages: number;
  lastAt: number | null;
  createdAt: number;
  disbandedAt: number | null;
};

/** 管理员看一个群的记录：撤回的消息照样看得到原文。 */
export type AdminGroupMessage = Omit<GroupMessage, 'mine' | 'hidden'> & { withdrawnText: string | null };

export type AdminGroupDetail = {
  group: AdminGroupRow;
  members: GroupMember[];
  messages: AdminGroupMessage[];
  hasMore: boolean;
};

// ==================== 管理员看私信（V0.7.0） ====================

/** 管理页「聊天记录」→「私信」：两个人之间的一组私信。a、b 按账号编号小的在前。 */
export type AdminDmRow = {
  a: GroupUser;
  b: GroupUser;
  messages: number;
  lastAt: number;
  last: string;
};

export type AdminDmMessage = { id: number; from: 'a' | 'b'; text: string; at: number; read: boolean };

export type AdminDmThread = { a: GroupUser; b: GroupUser; messages: AdminDmMessage[]; hasMore: boolean };
