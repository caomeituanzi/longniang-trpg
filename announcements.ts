import type { Deps } from '../../app';
import { hasPermission, requireAdmin } from '../../auth';
import { transaction } from '../../db';
import { asId, asInt, asObject, asOneOf, asString, HttpError, type Router } from '../../http';
import { addCrystals } from '../../pets';
import { AMOUNT_TOKEN, ANNOUNCE_CRYSTALS_MAX, type AnnounceGrantKind } from '../../../shared/announce';
import { adminLog, readAmount, type Grant } from './common';

// 公告：列表、发公告（可以同时给收到的人发额度或者龙晶）、删除。

export function registerAnnouncementRoutes(router: Router, deps: Deps) {
  const { db, hub, engine, social, now } = deps;
  const log = adminLog(deps);

  const AUDIENCE_LABEL = { all: '全服', guest: '游客', user: '普通用户', admin: '管理员', users: '指定的人' } as const;

  router.get('/api/admin/announcements', (ctx) => {
    requireAdmin(ctx, 'announce');
    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.body, a.audience, a.created_at, u.display_name AS by_name,
           (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads,
           (SELECT group_concat(t.display_name, '、') FROM announcement_targets x JOIN users t ON t.id = x.user_id WHERE x.announcement_id = a.id) AS targets
         FROM announcements a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT 200`,
      )
      .all() as { id: number; title: string; body: string; audience: keyof typeof AUDIENCE_LABEL; created_at: number; by_name: string | null; reads: number; targets: string | null }[];
    return {
      announcements: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        audience: r.audience,
        audienceLabel: r.audience === 'users' ? `指定的人：${r.targets ?? ''}` : AUDIENCE_LABEL[r.audience],
        at: r.created_at,
        by: r.by_name,
        reads: r.reads,
      })),
    };
  });

  // 发公告：{ title, body, audience: 'all' | 'guest' | 'user' | 'admin' | 'users', usernames?: [用户名]（audience 是 users 时） }
  router.post('/api/admin/announcements', (ctx) => {
    const admin = requireAdmin(ctx, 'announce');
    const body = asObject(ctx.body);
    const title = asString(body.title, { max: 40, message: '标题要在1～40个字之间' });
    const text = asString(body.body, { max: 2000, message: '内容要在1～2000个字之间' });
    const audience = asOneOf(body.audience, ['all', 'guest', 'user', 'admin', 'users'] as const, '选一下发给谁');
    let targets: number[] = [];
    if (audience === 'users') {
      const names = Array.isArray(body.usernames) ? [...new Set(body.usernames.filter((x): x is string => typeof x === 'string'))] : [];
      if (!names.length) throw new HttpError(400, '选一下发给哪些人');
      if (names.length > 500) throw new HttpError(400, '一次最多发给 500 个人');
      const find = db.prepare('SELECT id FROM users WHERE username = ?');
      const missing: string[] = [];
      for (const name of names) {
        const row = find.get(name) as { id: number } | undefined;
        if (row) targets.push(row.id);
        else missing.push(name);
      }
      if (missing.length) throw new HttpError(400, `没有这些用户：${missing.slice(0, 10).join('、')}`);
    }
    // 全服发额度、发龙晶（V0.6.0 的公告模板）：发公告的同时给收到公告的正式账号每人发一份
    const grantBody = body.grant === undefined || body.grant === null ? null : asObject(body.grant);
    let grant: { kind: AnnounceGrantKind; credit: Grant | null; crystals: number; text: string } | null = null;
    if (grantBody) {
      if (!hasPermission(admin, 'credit')) throw new HttpError(403, '发额度、发龙晶还要有「发放额度」权限，请找站长开通');
      if (audience === 'guest') throw new HttpError(400, '游客没有额度和龙晶');
      const kind = asOneOf(grantBody.kind, ['credit', 'crystals'] as const, '请求格式不对');
      if (kind === 'credit') {
        const credit = readAmount(db, grantBody);
        if (credit.usd <= 0) throw new HttpError(400, '额度要填一个正数');
        // 公告里写的数额不带正负号
        grant = { kind, credit, crystals: 0, text: credit.text.replace(/^\+/, '') };
      } else {
        const n = asInt(grantBody.amount, { min: 1, max: ANNOUNCE_CRYSTALS_MAX, message: `龙晶要填 1～${ANNOUNCE_CRYSTALS_MAX} 的整数` });
        grant = { kind, credit: null, crystals: n, text: `${n} 龙晶` };
      }
    }
    // 收到这一份的人：收得到这条公告的正式账号（没删、没封）。和单独发额度、发龙晶的规矩一样：
    // 不给自己发；管理员、站长的号只有站长能发
    const recipients = grant
      ? (
          db
            .prepare(
              `SELECT id, is_admin, is_owner FROM users WHERE is_guest = 0 AND deleted_at IS NULL AND banned_at IS NULL`,
            )
            .all() as { id: number; is_admin: number; is_owner: number }[]
        )
          .filter((u) =>
            audience === 'all' ? true : audience === 'user' ? u.is_admin === 0 && u.is_owner === 0 : audience === 'admin' ? u.is_admin === 1 || u.is_owner === 1 : targets.includes(u.id),
          )
          .filter((u) => u.id !== admin.id && (admin.isOwner || (u.is_admin === 0 && u.is_owner === 0)))
          .map((u) => u.id)
      : [];
    if (grant && !recipients.length) throw new HttpError(400, '没有能收到的正式账号');
    const finalText = grant ? text.replaceAll(AMOUNT_TOKEN, grant.text) : text;
    const at = now();
    const id = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO announcements (title, body, audience, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(title, finalText, audience, admin.id, at);
      const announcementId = Number(lastInsertRowid);
      const add = db.prepare('INSERT INTO announcement_targets (announcement_id, user_id) VALUES (?, ?)');
      for (const userId of targets) add.run(announcementId, userId);
      if (grant?.credit) {
        const credit = grant.credit;
        const up = db.prepare('UPDATE users SET ai_credit_usd = ai_credit_usd + ? WHERE id = ?');
        const record = db.prepare('INSERT INTO credit_grants (user_id, amount_usd, granted_by, note, created_at) VALUES (?, ?, ?, ?, ?)');
        for (const userId of recipients) {
          up.run(credit.usd, userId);
          record.run(userId, credit.usd, admin.id, `公告「${title}」`, at);
        }
      } else if (grant) {
        for (const userId of recipients) addCrystals(db, userId, grant.crystals, 'grant', `公告「${title}」`, admin.id, at);
      }
      return announcementId;
    });
    log(admin, '发公告', `「${title}」发给${audience === 'users' ? `${targets.length}个人` : AUDIENCE_LABEL[audience]}`);
    if (grant) {
      log(admin, grant.kind === 'credit' ? '全服发额度' : '全服发龙晶', `公告「${title}」：每人 ${grant.text}，一共 ${recipients.length} 个账号`);
      // 额度变了：在等额度的回合可以开始了；开着网站的人刷新额度
      if (grant.kind === 'credit') engine.creditChanged(recipients);
    }
    // 开着网站的人马上收到（铃铛上的数字也跟着变）
    const view = { id, title, body: text, at, by: admin.displayName, read: false };
    hub.toEveryone('announcement', (userId) => (social.canSeeAnnouncement(userId, id) ? view : undefined));
    for (const userId of hub.connectedUserIds()) if (social.canSeeAnnouncement(userId, id)) social.pushBadges(userId);
    ctx.status = 201;
    return { id, recipients: recipients.length };
  });

  router.delete('/api/admin/announcements/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'announce');
    const id = asId(ctx.params.id);
    const row = db.prepare('SELECT title FROM announcements WHERE id = ?').get(id) as { title: string } | undefined;
    if (!row) throw new HttpError(404, '没有这条公告');
    db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    log(admin, '删除公告', `「${row.title}」`);
    for (const userId of hub.connectedUserIds()) social.pushBadges(userId);
    return { deleted: true };
  });
}
