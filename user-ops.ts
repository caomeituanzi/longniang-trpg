import type { Deps } from '../../app';
import { who } from '../../audit';
import { randomCode, type User } from '../../auth';
import { transaction } from '../../db';
import { HttpError } from '../../http';
import { cnyRate, showMoney } from '../../money';
import { banLengthText } from '../../../shared/admin';
import { deleteRoom } from '../rooms';
import { adminLog, type Grant } from './common';

// 对一个账号做的管理操作：账号详情里单个处理、勾选了好几个批量处理都用这些。
// 管理员动不了其他管理员和站长：对管理员账号封号、重置密码、改额度、写备注，只有站长能做；站长的账号谁也动不了（target）。

export function userOps(deps: Deps) {
  const { db, hub, rooms, engine, safety, social, now } = deps;
  const log = adminLog(deps);

  /**
   * 对某个账号做管理操作之前的检查：站长的账号谁也动不了；管理员的账号只有站长能动。返回这个账号。
   * self：能不能对自己做（写备注可以，封号不行）。
   */
  function target(admin: User, userId: number, what: string, self = false) {
    const row = db.prepare('SELECT id, is_admin, is_owner, is_guest, banned_at FROM users WHERE id = ?').get(userId) as
      | { id: number; is_admin: number; is_owner: number; is_guest: number; banned_at: number | null }
      | undefined;
    if (!row) throw new HttpError(404, '没有这个用户');
    if (row.id === admin.id) {
      if (!self) throw new HttpError(400, what === '改额度' ? '不能给自己改额度' : `不能${what}自己`);
      return row;
    }
    if (row.is_owner === 1) throw new HttpError(403, `站长的账号不能被${what}`);
    if (row.is_admin === 1 && !admin.isOwner) throw new HttpError(403, `只有站长能对管理员${what}`);
    return row;
  }

  /** 删掉的账号的用户名：deleted- 加 12 位随机字符（和游客的一样；正常的用户名里没有短横线，不会撞上）。 */
  function deletedUsername(): string {
    for (;;) {
      const name = `deleted-${randomCode(12, '0123456789abcdef')}`;
      if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return name;
    }
  }

  /**
   * 删除账号。游客直接删掉；正式账号（只有站长能删）留着一行，这样对局里他的角色、记录、找到的线索都还在：
   * 登录不了，用户名放出来（换成 deleted- 加一串随机字符），UID 空出来给以后的新账号，名字换成「已删除的账号」，
   * 头像、介绍、好友、私信、笔记、通知都清掉；他当房主的对局交给最早加入的其他成员，没有别的成员就删掉那一局；
   * 他在等的行动撤回，开着的页面断开。
   */
  function deleteAccount(admin: User, userId: number) {
    const row = target(admin, userId, '删除');
    const name = who(db, userId);
    if (row.is_guest === 1) {
      db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(userId);
      hub.closeUser(userId);
      log(admin, '删除游客账号', name);
      return;
    }
    if (!admin.isOwner) throw new HttpError(403, '只有站长能删除正式账号');
    const at = now();
    const displayName = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name: string }).display_name;
    const memberOf = (db.prepare('SELECT room_id FROM players WHERE user_id = ?').all(userId) as { room_id: number }[]).map((r) => r.room_id);
    const friends = (
      db
        .prepare('SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE requester_id = ? OR addressee_id = ?')
        .all(userId, userId, userId) as { id: number }[]
    ).map((r) => r.id);
    const orphanRooms: { id: number; name: string }[] = [];
    const handedOver: { roomId: number; to: string }[] = [];
    transaction(db, () => {
      // 他当房主的对局：交给最早加入的其他成员；没有别人就删掉
      for (const room of db.prepare('SELECT id, name FROM rooms WHERE host_user_id = ?').all(userId) as { id: number; name: string }[]) {
        const next = db
          .prepare('SELECT p.user_id, u.display_name FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? AND p.user_id != ? AND u.deleted_at IS NULL ORDER BY p.id LIMIT 1')
          .get(room.id, userId) as { user_id: number; display_name: string } | undefined;
        if (!next) {
          orphanRooms.push(room);
          continue;
        }
        db.prepare('UPDATE rooms SET host_user_id = ? WHERE id = ?').run(next.user_id, room.id);
        db.prepare("UPDATE players SET role = 'host' WHERE room_id = ? AND user_id = ?").run(room.id, next.user_id);
        db.prepare("UPDATE players SET role = 'player' WHERE room_id = ? AND user_id = ?").run(room.id, userId);
        handedOver.push({ roomId: room.id, to: next.display_name });
      }
      // 他建的注册邀请码：改记在删账号的人名下，还没用的照样能用
      db.prepare('UPDATE invites SET created_by = ? WHERE created_by = ?').run(admin.id, userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM avatars WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?').run(userId, userId);
      db.prepare('DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?').run(userId, userId);
      db.prepare('DELETE FROM direct_messages WHERE sender_id = ? OR recipient_id = ?').run(userId, userId);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM room_invites WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM notes WHERE author_user_id = ?').run(userId);
      db.prepare('DELETE FROM login_places WHERE user_id = ?').run(userId);
      // 关注和被关注、宠物和背包（V0.5.0）；还没审的投稿撤回，通过了的剧本留在剧本大厅里
      db.prepare('DELETE FROM follows WHERE follower_id = ? OR author_id = ?').run(userId, userId);
      db.prepare('DELETE FROM pets WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM pet_items WHERE user_id = ?').run(userId);
      // 角色卡和装备（V0.7.0）：切磋、排行里不再出现（这一局里的角色照旧留着）
      db.prepare('DELETE FROM character_cards WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM gear_items WHERE user_id = ?').run(userId);
      // 5E 角色卡（V0.9.0）：一起删掉（这一局里的角色照旧留着）
      db.prepare('DELETE FROM cards5e WHERE user_id = ?').run(userId);
      // AI 角色（V1.1.0）：一起删掉（已经请进对局的照旧，用的是请进去时的样子）
      db.prepare('DELETE FROM ai_personas WHERE user_id = ?').run(userId);
      // 群聊（V0.7.0）：退出所有的群（发过的消息留着，管理员看得到）；群里没人了就解散
      db.prepare('DELETE FROM chat_group_members WHERE user_id = ?').run(userId);
      db.prepare(
        'UPDATE chat_groups SET disbanded_at = ? WHERE disbanded_at IS NULL AND NOT EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id = chat_groups.id)',
      ).run(at);
      db.prepare("UPDATE scenario_submissions SET status = 'withdrawn' WHERE user_id = ? AND status = 'pending'").run(userId);
      // V0.8.0：剧本草稿、浏览器通知的设备和设置、收藏的名场面、约团时勾的（账号只是标成删除，外键的级联删不到这些）
      db.prepare('DELETE FROM scenario_drafts WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM push_prefs WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM highlights WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM schedule_votes WHERE user_id = ?').run(userId);
      db.prepare(
        `UPDATE users SET username = ?, uid = NULL, display_name = '已删除的账号', password_hash = '!', bio = '', avatar_at = NULL, avatar_frame = NULL,
           is_admin = 0, admin_perms = '[]', ai_unlimited = 0, show_rooms = 0, failed_logins = 0, failed_login_at = NULL, locked_until = NULL,
           banned_at = COALESCE(banned_at, ?), ban_reason = '账号已删除', banned_until = NULL, deleted_at = ? WHERE id = ?`,
      ).run(deletedUsername(), at, at, userId);
    });
    for (const h of handedOver) rooms.addLog(h.roomId, 'system', `${displayName}的账号删除了，房主换成了${h.to}`);
    for (const room of orphanRooms) deleteRoom(deps, room.id, room.name, admin.isOwner ? '站长' : '管理员');
    hub.closeUser(userId);
    engine.withdrawUserActions(userId);
    // 他被封号冻结着的对局：账号删了，不会再解封，解冻
    engine.unfreezeRoomsOf(userId);
    for (const roomId of memberOf) {
      if (orphanRooms.some((r) => r.id === roomId)) continue;
      hub.toRoom(roomId, 'members', { roomId });
      rooms.broadcastPresence(roomId);
      engine.syncRoom(roomId);
    }
    for (const id of friends) {
      hub.toUser(id, 'friends-changed', {});
      social.pushBadges(id);
    }
    // 撤回的投稿：管理员要审的数字变了
    social.pushAdminBadges();
    log(admin, '删除账号', name);
  }

  /** 发放额度（负数是收回）。批量处理也用它。 */
  function grantCredit(admin: User, userId: number, grant: Grant, note: string) {
    const user = db.prepare('SELECT ai_credit_usd, is_guest FROM users WHERE id = ?').get(userId) as { ai_credit_usd: number; is_guest: number } | undefined;
    if (!user) throw new HttpError(404, '没有这个用户');
    if (user.is_guest === 1) throw new HttpError(400, '游客没有额度');
    // 填人民币换算出来的美元有小数尾巴：差一点点算刚好收完
    if (user.ai_credit_usd + grant.usd < -1e-9) throw new HttpError(400, `最多只能收回 ${showMoney(user.ai_credit_usd, grant.currency, cnyRate(db))}`);
    transaction(db, () => {
      db.prepare('UPDATE users SET ai_credit_usd = max(ai_credit_usd + ?, 0) WHERE id = ?').run(grant.usd, userId);
      db.prepare('INSERT INTO credit_grants (user_id, amount_usd, granted_by, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
        userId,
        grant.usd,
        admin.id,
        note,
        now(),
      );
    });
    log(admin, grant.usd > 0 ? '发放额度' : '收回额度', `${who(db, userId)}：${grant.text}${note ? `（${note}）` : ''}`);
  }

  /** hours：封多久，null 是永久（等管理员解封）。 */
  function banUser(admin: User, userId: number, reason: string, hours: number | null) {
    const row = target(admin, userId, '封禁');
    if (row.is_admin === 1) throw new HttpError(409, '管理员账号不能封禁：先撤销他的管理员身份');
    if (row.banned_at !== null) throw new HttpError(409, '这个账号已经被封禁了');
    safety.ban(userId, reason, admin.id, hours === null ? null : now() + hours * 3_600_000);
    log(admin, '封号', `${who(db, userId)}：${reason || '没写原因'}（${hours === null ? '永久' : `封 ${banLengthText(hours)}`}）`);
  }

  // 解封以后，他在的各局重新算在线情况（safety.onUnbanned）
  function unbanUser(admin: User, userId: number) {
    target(admin, userId, '解封');
    if (!safety.unban(userId)) throw new HttpError(409, '这个账号没有被封禁');
    log(admin, '解封', who(db, userId));
  }

  return { target, deleteAccount, grantCredit, banUser, unbanUser };
}
