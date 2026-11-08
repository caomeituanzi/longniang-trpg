import type { Deps } from '../../app';
import { GUARD_CATEGORY_LABEL, type GuardCategory } from '../../ai/moderation';
import { THIRD_PARTY_REFUSAL } from '../../ai/types';
import { requireAdmin } from '../../auth';
import { asId, asObject, HttpError, type Router } from '../../http';
import { SOURCE_LABEL, type ViolationSource } from '../../safety';
import { adminLog } from './common';

// 违规记录：内容检查拦下的、被 AI 拒绝的。账号详情、对局详情里也列着这个人、这一局的（VIOLATION_SELECT、toViolation）。

/** 违规的类别给人看的说法。 */
function categoryLabel(kind: string, category: string | null): string {
  if (kind === 'refusal' || category?.startsWith('refusal')) {
    const detail = category?.replace(/^refusal:?/, '') ?? '';
    // 经 OpenRouter、中转站（V1.0.1）调用、被别家拒绝的（只拦下，不封号）
    if (detail.startsWith(THIRD_PARTY_REFUSAL)) {
      const rest = detail.slice(THIRD_PARTY_REFUSAL.length);
      return rest.startsWith('relay:') ? `被中转站那边拒绝（${rest.slice('relay:'.length)}）` : `被 OpenRouter 那边拒绝（${rest}）`;
    }
    return `被 Claude 拒绝${detail ? `（${detail}）` : ''}`;
  }
  return GUARD_CATEGORY_LABEL[(category ?? 'other') as GuardCategory] ?? category ?? '';
}

export type ViolationRow = {
  id: number;
  user_id: number | null;
  username: string | null;
  display_name: string | null;
  user_is_owner: number | null;
  room_id: number | null;
  room_name: string | null;
  kind: 'precheck' | 'refusal';
  source: string;
  content: string;
  category: string | null;
  reason: string | null;
  outcome: 'banned' | 'warned' | 'flagged' | 'blocked';
  created_at: number;
  reviewed_at: number | null;
  reviewer: string | null;
  dismissed: number;
};

export const VIOLATION_SELECT = `
  SELECT v.*, u.username, u.display_name, u.is_owner AS user_is_owner, r.name AS room_name, rv.display_name AS reviewer
  FROM violations v LEFT JOIN users u ON u.id = v.user_id LEFT JOIN rooms r ON r.id = v.room_id
  LEFT JOIN users rv ON rv.id = v.reviewed_by`;

export function toViolation(v: ViolationRow) {
  return {
    id: v.id,
    at: v.created_at,
    user: v.user_id !== null ? { id: v.user_id, username: v.username ?? '', displayName: v.display_name ?? '', isOwner: v.user_is_owner === 1 } : null,
    room: v.room_id !== null ? { id: v.room_id, name: v.room_name ?? '' } : null,
    kind: v.kind,
    source: v.source,
    sourceLabel: SOURCE_LABEL[v.source as ViolationSource] ?? v.source,
    content: v.content,
    category: categoryLabel(v.kind, v.category),
    reason: v.reason ?? '',
    outcome: v.outcome,
    reviewedAt: v.reviewed_at,
    reviewer: v.reviewer,
    /** 管理员标成了误判：不算这个人的违规次数。 */
    dismissed: v.dismissed === 1,
  };
}

export function registerViolationRoutes(router: Router, deps: Deps) {
  const { db, social, now } = deps;
  const log = adminLog(deps);

  router.get('/api/admin/violations', (ctx) => {
    requireAdmin(ctx, 'ban');
    const rows = db.prepare(`${VIOLATION_SELECT} ORDER BY v.id DESC LIMIT 300`).all() as ViolationRow[];
    return { violations: rows.map(toViolation) };
  });

  // 标记为已处理：{ dismiss?: true } 是误判（检查的 AI 看错了），这一次不算他的违规次数。
  // 因为这一次被封的号不会自动解封，要解封在「账号」里点
  router.post('/api/admin/violations/:id/review', (ctx) => {
    const admin = requireAdmin(ctx, 'ban');
    const id = asId(ctx.params.id);
    const dismiss = asObject(ctx.body ?? {}).dismiss === true;
    // 站长的违规记录只有站长自己能处理
    const ofOwner = db.prepare('SELECT 1 FROM violations v JOIN users u ON u.id = v.user_id WHERE v.id = ? AND u.is_owner = 1').get(id);
    if (ofOwner && !admin.isOwner) throw new HttpError(403, '站长的记录只有站长能处理');
    const changed = db
      .prepare('UPDATE violations SET reviewed_at = ?, reviewed_by = ?, dismissed = ? WHERE id = ? AND reviewed_at IS NULL')
      .run(now(), admin.id, dismiss ? 1 : 0, id).changes;
    if (!changed) throw new HttpError(404, '没有这条记录，或者已经处理过了');
    log(admin, '处理违规记录', `第 ${id} 条${dismiss ? '：误判，不算次数' : ''}`);
    social.pushAdminBadges();
    return { ok: true };
  });
}
