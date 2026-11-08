import type { Deps } from '../../app';
import { requireAdmin } from '../../auth';
import { asId, asObject, asOneOf, asString, HttpError, type Router } from '../../http';
import { safeJson, Social, toBrief } from '../../social';
import { adminLog } from './common';

// 举报、意见和 bug 反馈：列表、处理（回复给提交的人）。

export function registerReportRoutes(router: Router, deps: Deps) {
  const { db, social, reviewer, now } = deps;
  const log = adminLog(deps);

  const OUTCOMES = ['handled', 'confirmed', 'fixed', 'not-a-bug', 'need-info'] as const;
  const OUTCOME_LABEL: Record<(typeof OUTCOMES)[number], string> = {
    handled: '已处理',
    confirmed: '已确认',
    fixed: '已修复',
    'not-a-bug': '不是问题',
    'need-info': '需要更多信息',
  };

  router.get('/api/admin/reports', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const kind = ctx.url.searchParams.get('kind');
    const rows = db
      .prepare(
        `SELECT r.*, rp.username AS r_username, rp.public_id AS r_public_id, rp.display_name AS r_display_name, rp.is_admin AS r_is_admin,
           rp.is_owner AS r_is_owner, rp.is_guest AS r_is_guest, rp.avatar_at AS r_avatar_at,
           t.username AS t_username, t.public_id AS t_public_id, t.display_name AS t_display_name, t.is_admin AS t_is_admin, t.is_owner AS t_is_owner,
           t.is_guest AS t_is_guest, t.avatar_at AS t_avatar_at, t.banned_at AS t_banned_at, h.display_name AS handler
         FROM reports r LEFT JOIN users rp ON rp.id = r.reporter_id LEFT JOIN users t ON t.id = r.target_user_id
         LEFT JOIN users h ON h.id = r.handled_by
         WHERE (? IS NULL OR r.kind = ?) AND ${Social.reportVisibleTo(admin.isOwner)}
         ORDER BY r.handled_at IS NOT NULL, r.id DESC LIMIT 300`,
      )
      .all(kind, kind) as Record<string, any>[];
    // 管理员看得到用户名
    const brief = (r: Record<string, any>, p: string) =>
      r[`${p}_username`]
        ? {
            ...toBrief({
              public_id: r[`${p}_public_id`],
              display_name: r[`${p}_display_name`],
              is_admin: r[`${p}_is_admin`],
              is_owner: r[`${p}_is_owner`],
              is_guest: r[`${p}_is_guest`],
              avatar_at: r[`${p}_avatar_at`],
            }),
            username: r[`${p}_username`] as string,
          }
        : null;
    return {
      reports: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        aiReview: r.kind === 'report' ? reviewer.latest('report', r.id) : null,
        from: brief(r, 'r'),
        about: brief(r, 't'),
        aboutUserId: r.target_user_id,
        aboutBanned: r.t_banned_at !== null && r.t_banned_at !== undefined,
        target: safeJson(r.target),
        body: r.body,
        steps: r.steps,
        context: safeJson(r.context),
        at: r.created_at,
        handledAt: r.handled_at,
        handler: r.handler,
        outcome: r.outcome,
        outcomeLabel: r.outcome ? (OUTCOME_LABEL[r.outcome as (typeof OUTCOMES)[number]] ?? r.outcome) : null,
        reply: r.reply,
      })),
      badges: social.badges(admin.id),
    };
  });

  // 处理：{ outcome?: 'handled' | 'confirmed' | 'fixed' | 'not-a-bug' | 'need-info', reply?: 回复给提交的人 }
  router.post('/api/admin/reports/:id/handle', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    const id = asId(ctx.params.id);
    const row = db.prepare(`SELECT r.kind, r.reporter_id FROM reports r WHERE r.id = ? AND ${Social.reportVisibleTo(admin.isOwner)}`).get(id) as
      | { kind: string; reporter_id: number | null }
      | undefined;
    if (!row) throw new HttpError(404, '没有这条记录');
    const body = asObject(ctx.body ?? {});
    const outcome = body.outcome === undefined ? 'handled' : asOneOf(body.outcome, OUTCOMES, '处理结果不对');
    const reply = body.reply === undefined || body.reply === '' ? '' : asString(body.reply, { max: 1000, message: '回复最多1000个字' });
    db.prepare('UPDATE reports SET handled_at = ?, handled_by = ?, outcome = ?, reply = ? WHERE id = ?').run(now(), admin.id, outcome, reply, id);
    log(admin, '处理反馈', `第 ${id} 条（${row.kind}）：${OUTCOME_LABEL[outcome]}${reply ? `，回复：${[...reply].slice(0, 60).join('')}` : ''}`);
    if (row.reporter_id !== null && row.reporter_id !== admin.id) {
      social.notify(row.reporter_id, 'report_reply', { reportId: id, kind: row.kind, outcome, outcomeLabel: OUTCOME_LABEL[outcome], reply });
    }
    social.pushAdminBadges();
    return { ok: true };
  });
}
