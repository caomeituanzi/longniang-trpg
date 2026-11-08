import type { Deps } from '../../app';
import type { Router } from '../../http';
import { registerAiRoutes } from './ai';
import { registerAnnouncementRoutes } from './announcements';
import { registerAuditRoutes } from './audit-log';
import { registerCreditCodeRoutes } from './credit-codes';
import { registerInviteRoutes } from './invites';
import { registerRegistrationRoutes } from './registration';
import { registerReportRoutes } from './reports';
import { registerAdminRoomRoutes } from './rooms';
import { registerScenarioFileRoutes } from './scenarios';
import { registerSystemRoutes } from './system';
import { registerUserListRoutes, registerUserRoutes } from './users';
import { registerViolationRoutes } from './violations';

// 管理员的接口：邀请码、账号（额度、封号、备注、身份）、违规记录、AI 总开关和模型、所有对局、现成的剧本、公告、举报和反馈、操作记录。
// 管理员分级：站长（只有一个）什么都能做，只有站长能任命管理员、给管理员下发权限；其他管理员按权限逐项能做。
// 管理员动不了其他管理员和站长：对管理员账号封号、重置密码、改额度、写备注，只有站长能做；站长的账号谁也动不了。
// 管理员做的事都记进操作记录（admin_audit）。
// 别的 /api/admin/ 接口跟着各自的功能放在 routes/ 下的文件里：大厅聊天（social）、投稿审核和 AI 审核（works）、
// 龙晶（pets）、商城价格（shop）、商城的上架下架和发物品（shop-admin，V0.7.1）、角色卡（cards）、群聊和私信（groups）、限时活动（events）、全部解锁（collection）、排查包（debug）。
//
// 这里按管理页的各栏分文件。路由按登记的先后匹配，下面的顺序和拆开以前（一个 admin.ts）一样，不要随便调换。

export function registerAdminRoutes(router: Router, deps: Deps) {
  // 账号列表
  registerUserListRoutes(router, deps);
  // 新账号的初始额度、注册方式、应急开关、开放注册的初始额度、汇率
  registerRegistrationRoutes(router, deps);
  // 新建账号、清理游客、账号详情、备注、删除、重置密码、额度、封号、任命管理员、批量处理
  registerUserRoutes(router, deps);
  registerViolationRoutes(router, deps);
  registerAiRoutes(router, deps);
  registerAdminRoomRoutes(router, deps);
  registerScenarioFileRoutes(router, deps);
  registerInviteRoutes(router, deps);
  registerCreditCodeRoutes(router, deps);
  registerAnnouncementRoutes(router, deps);
  registerReportRoutes(router, deps);
  registerAuditRoutes(router, deps);
  registerSystemRoutes(router, deps);
}
