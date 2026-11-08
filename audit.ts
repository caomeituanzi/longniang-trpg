import type { DB } from './db';

// 管理员操作记录：谁、什么时候、做了什么。管理页「操作记录」里能查。

export function audit(db: DB, adminId: number | null, action: string, detail: string, now = Date.now()) {
  db.prepare('INSERT INTO admin_audit (admin_id, action, detail, created_at) VALUES (?, ?, ?, ?)').run(adminId, action, detail.slice(0, 500), now);
}

/** 记录里写账号时用的样子：显示名（用户名）。 */
export function who(db: DB, userId: number): string {
  const row = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId) as { username: string; display_name: string } | undefined;
  return row ? `${row.display_name}（${row.username}）` : `账号${userId}`;
}
