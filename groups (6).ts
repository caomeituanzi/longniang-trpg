import { audit } from '../audit';
import { requireAdmin, requireUser, requireViewer } from '../auth';
import { adminDmList, adminDmThread } from '../dm-admin';
import { asId, asObject, HttpError, type Router } from '../http';
import type { Deps } from '../app';

// 群聊（V0.7.0，「社交」里）。逻辑在 groups.ts。管理员看所有的群聊和私信也在这里（私信的逻辑在 dm-admin.ts）。

/** 管理员反复翻同一个群、同一组私信：这么久里只记一次操作记录。 */
const VIEW_AUDIT_WINDOW_MS = 10 * 60_000;

export function registerGroupRoutes(router: Router, { groups, limiter, db, now, social }: Deps) {
  // 我在的群（游客不在任何群里：社交页照样能打开看看，这里是空的）
  router.get('/api/groups', (ctx) => {
    const user = requireViewer(ctx);
    if (user.isGuest) return { groups: [] };
    return { groups: groups.list(user.id) };
  });

  // 建群：{ name, members: [公开编号] }（都要是自己的好友）
  router.post('/api/groups', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('dm', user.id);
    const body = asObject(ctx.body);
    ctx.status = 201;
    return { group: groups.create(user.id, { name: body.name, members: body.members }) };
  });

  // 打开一个群：成员和最近的消息
  router.get('/api/groups/:id', (ctx) => {
    const user = requireUser(ctx);
    return groups.detail(user.id, asId(ctx.params.id));
  });

  // 往前翻：?before=消息编号
  router.get('/api/groups/:id/messages', (ctx) => {
    const user = requireUser(ctx);
    const before = ctx.url.searchParams.get('before');
    return groups.older(user.id, asId(ctx.params.id), before ? asId(before) : Number.MAX_SAFE_INTEGER);
  });

  // 发消息：{ text }
  router.post('/api/groups/:id/messages', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('dm', user.id);
    const message = groups.send(user.id, asId(ctx.params.id), asObject(ctx.body).text);
    ctx.status = 201;
    return { message };
  });

  // 看过了
  router.post('/api/groups/:id/read', (ctx) => {
    const user = requireUser(ctx);
    groups.markRead(user.id, asId(ctx.params.id));
    return { ok: true };
  });

  // 撤回自己的消息
  router.delete('/api/groups/:id/messages/:messageId', (ctx) => {
    const user = requireUser(ctx);
    groups.withdraw(user.id, asId(ctx.params.id), asId(ctx.params.messageId), false);
    return { ok: true };
  });

  // 拉人进群：{ members: [公开编号] }（自己的好友）
  router.post('/api/groups/:id/members', (ctx) => {
    const user = requireUser(ctx);
    return groups.addMembers(user.id, asId(ctx.params.id), asObject(ctx.body).members);
  });

  // 移出群（群主移出别人）；自己退群是 /members/me
  router.delete('/api/groups/:id/members/:ref', (ctx) => {
    const user = requireUser(ctx);
    return groups.removeMember(user.id, asId(ctx.params.id), ctx.params.ref ?? '');
  });

  // 群主改群名：{ name }
  router.put('/api/groups/:id', (ctx) => {
    const user = requireUser(ctx);
    return groups.rename(user.id, asId(ctx.params.id), asObject(ctx.body).name);
  });

  // 群主解散群
  router.delete('/api/groups/:id', (ctx) => {
    const user = requireUser(ctx);
    groups.disband(user.id, asId(ctx.params.id));
    return { ok: true };
  });

  // ==================== 管理员：所有的群聊记录（「举报和大厅聊天」权限） ====================

  router.get('/api/admin/groups', (ctx) => {
    requireAdmin(ctx, 'reports');
    return { groups: groups.adminList(ctx.url.searchParams.get('q') ?? '') };
  });

  /** 看聊天记录都记进操作记录：同一个管理员十分钟里反复翻同一个群、同一组私信，只记一次。 */
  function auditView(adminId: number, action: string, detail: string) {
    const at = now();
    const seen = db
      .prepare('SELECT 1 FROM admin_audit WHERE admin_id = ? AND action = ? AND detail = ? AND created_at >= ?')
      .get(adminId, action, detail.slice(0, 500), at - VIEW_AUDIT_WINDOW_MS);
    if (!seen) audit(db, adminId, action, detail, at);
  }

  // 看一个群的记录（撤回的也看得到原文）；记进操作记录
  router.get('/api/admin/groups/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const id = asId(ctx.params.id);
    const before = ctx.url.searchParams.get('before');
    const detail = groups.adminDetail(id, before ? asId(before) : Number.MAX_SAFE_INTEGER);
    auditView(admin.id, '查看群聊记录', `群 ${id}「${detail.group.name}」`);
    return detail;
  });

  router.delete('/api/admin/groups/:id/messages/:messageId', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const id = asId(ctx.params.id);
    const messageId = asId(ctx.params.messageId);
    // 和大厅一样：站长的消息只有站长自己能撤回
    const author = db
      .prepare('SELECT u.id, u.is_owner FROM chat_group_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.group_id = ?')
      .get(messageId, id) as { id: number; is_owner: number } | undefined;
    if (author && author.is_owner && author.id !== admin.id && !admin.isOwner) throw new HttpError(403, '站长的消息只有站长自己能撤回');
    groups.withdraw(admin.id, id, messageId, true);
    audit(db, admin.id, '撤回群聊消息', `群 ${id} 的消息 ${ctx.params.messageId}`, now());
    return groups.adminDetail(id, Number.MAX_SAFE_INTEGER);
  });

  // ==================== 管理员：所有的私信（「举报和大厅聊天」权限） ====================

  router.get('/api/admin/dms', (ctx) => {
    requireAdmin(ctx, 'reports');
    return { pairs: adminDmList(db, social, ctx.url.searchParams.get('q') ?? '') };
  });

  // 两个人之间的私信（公开编号）；记进操作记录
  router.get('/api/admin/dms/:a/:b', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const before = ctx.url.searchParams.get('before');
    const { ids: _ids, ...thread } = adminDmThread(db, social, ctx.params.a ?? '', ctx.params.b ?? '', before ? asId(before) : Number.MAX_SAFE_INTEGER);
    auditView(admin.id, '查看私信记录', `${thread.a.displayName} 和 ${thread.b.displayName}`);
    return thread;
  });

  router.post('/api/admin/groups/:id/disband', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const id = asId(ctx.params.id);
    const detail = groups.adminDetail(id, Number.MAX_SAFE_INTEGER);
    if (detail.group.disbandedAt !== null) throw new HttpError(409, '这个群已经解散了');
    groups.disband(admin.id, id, true);
    audit(db, admin.id, '解散群聊', `群 ${id}「${detail.group.name}」`, now());
    return groups.adminDetail(id, Number.MAX_SAFE_INTEGER);
  });
}
