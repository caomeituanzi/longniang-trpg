import type { Deps } from '../../app';
import { randomCode, requireAdmin } from '../../auth';
import { asId, asInt, asObject, asString, HttpError, type Router } from '../../http';
import { adminLog } from './common';

// 注册邀请码：列表、生成、作废（用过的不能作废）。

type InviteRow = {
  id: number;
  code: string;
  note: string;
  created_at: number;
  expires_at: number | null;
  used_at: number | null;
  used_username: string | null;
  used_display_name: string | null;
};

function toInvite(row: InviteRow, now: number) {
  const status = row.used_at !== null ? 'used' : row.expires_at !== null && row.expires_at < now ? 'expired' : 'unused';
  return {
    id: row.id,
    code: row.code,
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: row.used_username ? { username: row.used_username, displayName: row.used_display_name } : null,
    status,
  };
}

const INVITE_SELECT = `
  SELECT i.id, i.code, i.note, i.created_at, i.expires_at, i.used_at,
         u.username AS used_username, u.display_name AS used_display_name
  FROM invites i LEFT JOIN users u ON u.id = i.used_by`;

export function registerInviteRoutes(router: Router, deps: Deps) {
  const { db, now } = deps;
  const log = adminLog(deps);

  router.get('/api/admin/invites', (ctx) => {
    requireAdmin(ctx, 'invites');
    const at = now();
    const rows = db.prepare(`${INVITE_SELECT} ORDER BY i.id DESC`).all() as InviteRow[];
    return { invites: rows.map((r) => toInvite(r, at)) };
  });

  router.post('/api/admin/invites', (ctx) => {
    const admin = requireAdmin(ctx, 'invites');
    const body = asObject(ctx.body ?? {});
    const note = body.note === undefined || body.note === '' ? '' : asString(body.note, { max: 40, message: '备注最多40个字' });
    const days = body.days === undefined ? 7 : asInt(body.days, { min: 1, max: 30, message: '有效期要在1～30天之间' });
    const at = now();
    let code = randomCode(8);
    while (db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)) code = randomCode(8);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO invites (code, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, admin.id, note, at + days * 24 * 60 * 60 * 1000, at);
    const row = db.prepare(`${INVITE_SELECT} WHERE i.id = ?`).get(Number(lastInsertRowid)) as InviteRow;
    log(admin, '生成邀请码', `${days}天有效${note ? `（${note}）` : ''}`);
    ctx.status = 201;
    return { invite: toInvite(row, at) };
  });

  router.delete('/api/admin/invites/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'invites');
    const id = asId(ctx.params.id);
    const result = db.prepare('DELETE FROM invites WHERE id = ? AND used_by IS NULL').run(id);
    if (result.changes !== 1) throw new HttpError(404, '没有这个邀请码，或者它已经被用过了');
    log(admin, '作废邀请码', `第 ${id} 个`);
    return { ok: true };
  });
}
