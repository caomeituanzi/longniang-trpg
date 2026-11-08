// 群聊（V0.7.0，「社交」里）：几个好友拉一个群。只有正式账号能用；拉进来的人要是拉人的那个人的好友。
// 群主能改群名、移出成员、解散群；群主退群时最早进群的人接着当群主。消息自己随时能撤回。
// 管理员（有「举报和大厅聊天」权限）能看所有群的记录（撤回的也看得到原文）、撤回消息、解散群。
import { transaction, type DB } from './db';
import { HttpError } from './http';
import { escapeLike, rejectInvisibleName } from './util';
import type { RealtimeHub } from './realtime';
import { BRIEF_COLUMNS, toBrief, type BriefRow, type Social } from './social';
import {
  GROUP_MEMBERS_MAX,
  GROUP_MESSAGE_MAX,
  GROUP_NAME_MAX,
  GROUP_PAGE,
  GROUPS_JOINED_MAX,
  type AdminGroupDetail,
  type AdminGroupMessage,
  type AdminGroupRow,
  type GroupDetail,
  type GroupMember,
  type GroupMessage,
  type GroupSummary,
} from '../shared/groups';

type GroupRow = { id: number; name: string; owner_id: number | null; created_at: number; disbanded_at: number | null; disbanded_by: number | null };
type MessageRow = { id: number; group_id: number; user_id: number | null; kind: 'text' | 'system'; text: string; created_at: number; deleted_at: number | null; deleted_by: number | null };
type MemberRow = BriefRow & { joined_at: number };

const BRIEF_U = BRIEF_COLUMNS.split(', ')
  .map((c) => `u.${c}`)
  .join(', ');

export class Groups {
  constructor(
    private readonly opts: {
      db: DB;
      social: Social;
      hub: () => RealtimeHub;
      now: () => number;
    },
  ) {}

  private get db() {
    return this.opts.db;
  }

  // ==================== 查 ====================

  private group(groupId: number): GroupRow | undefined {
    return this.db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(groupId) as GroupRow | undefined;
  }

  /** 还在的群（没解散）。 */
  private liveGroup(groupId: number): GroupRow {
    const g = this.group(groupId);
    if (!g || g.disbanded_at !== null) throw new HttpError(404, '这个群不在了');
    return g;
  }

  /** 群成员（账号删了的不算）。按进群的先后。 */
  private members(groupId: number): MemberRow[] {
    return this.db
      .prepare(
        `SELECT ${BRIEF_U}, m.joined_at FROM chat_group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? AND u.deleted_at IS NULL ORDER BY m.joined_at, u.id`,
      )
      .all(groupId) as MemberRow[];
  }

  private isMember(groupId: number, userId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  }

  /** 是这个还在的群的成员，不然当作没有这个群。 */
  private requireMember(groupId: number, userId: number): GroupRow {
    const g = this.liveGroup(groupId);
    if (!this.isMember(groupId, userId)) throw new HttpError(404, '这个群不在了');
    return g;
  }

  /** 群主：建群的人；他退群、账号删了，就是最早进群的人。 */
  private ownerOf(g: GroupRow, members = this.members(g.id)): number | null {
    if (g.owner_id !== null && members.some((m) => m.id === g.owner_id)) return g.owner_id;
    return members[0]?.id ?? null;
  }

  private requireOwner(groupId: number, userId: number): GroupRow {
    const g = this.requireMember(groupId, userId);
    if (this.ownerOf(g) !== userId) throw new HttpError(403, '只有群主能这么做');
    return g;
  }

  private memberIds(groupId: number): number[] {
    return this.members(groupId).map((m) => m.id);
  }

  /** 同一页里同一个人只查一次。 */
  private briefOf(id: number, cache?: Map<number, GroupMessage['from']>): GroupMessage['from'] {
    if (cache?.has(id)) return cache.get(id)!;
    const brief = this.opts.social.brief(id);
    cache?.set(id, brief);
    return brief;
  }

  private toMessage(r: MessageRow, viewer: number, blocked: Set<number>, cache?: Map<number, GroupMessage['from']>): GroupMessage {
    const withdrawn = r.deleted_at === null ? null : r.deleted_by === r.user_id ? 'self' : 'admin';
    const hidden = r.kind === 'text' && r.user_id !== null && r.user_id !== viewer && blocked.has(r.user_id);
    return {
      id: r.id,
      kind: r.kind,
      text: withdrawn || hidden ? '' : r.text,
      at: r.created_at,
      from: r.kind === 'text' && r.user_id !== null ? this.briefOf(r.user_id, cache) : null,
      mine: r.user_id === viewer && r.kind === 'text',
      withdrawn,
      ...(hidden ? { hidden: true } : {}),
    };
  }

  private page(groupId: number, before: number): { rows: MessageRow[]; hasMore: boolean } {
    const rows = this.db
      .prepare('SELECT * FROM chat_group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(groupId, before, GROUP_PAGE + 1) as MessageRow[];
    return { rows: rows.slice(0, GROUP_PAGE).reverse(), hasMore: rows.length > GROUP_PAGE };
  }

  private memberView(rows: MemberRow[], ownerId: number | null): GroupMember[] {
    const hub = this.opts.hub();
    return rows.map((m) => ({ ...toBrief(m), owner: m.id === ownerId, online: hub.isConnected(m.id), joinedAt: m.joined_at }));
  }

  /** 我在的群，有新消息的排前面。 */
  list(userId: number): GroupSummary[] {
    const rows = this.db
      .prepare(
        `SELECT g.*, m.last_read_id,
           (SELECT COUNT(*) FROM chat_group_members x JOIN users u ON u.id = x.user_id WHERE x.group_id = g.id AND u.deleted_at IS NULL) AS member_count,
           (SELECT MAX(id) FROM chat_group_messages WHERE group_id = g.id) AS last_id
         FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = ?
         WHERE g.disbanded_at IS NULL ORDER BY COALESCE(last_id, 0) DESC, g.id DESC`,
      )
      .all(userId) as (GroupRow & { last_read_id: number; member_count: number; last_id: number | null })[];
    const blocked = this.opts.social.blockedIds(userId);
    const unreadStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM chat_group_messages WHERE group_id = ? AND id > ? AND kind = 'text' AND deleted_at IS NULL
         AND user_id IS NOT NULL AND user_id != ?`,
    );
    const lastStmt = this.db.prepare('SELECT * FROM chat_group_messages WHERE id = ?');
    return rows.map((g) => {
      const last = g.last_id ? (lastStmt.get(g.last_id) as MessageRow) : null;
      let lastView: GroupSummary['last'] = null;
      if (last) {
        const view = this.toMessage(last, userId, blocked);
        const text = view.withdrawn ? '撤回了一条消息' : view.hidden ? '（屏蔽的人发的消息）' : view.text;
        lastView = { text, from: view.mine ? '你' : (view.from?.displayName ?? null), at: last.created_at };
      }
      const unread = blocked.size
        ? (
            this.db
              .prepare(
                `SELECT user_id FROM chat_group_messages WHERE group_id = ? AND id > ? AND kind = 'text' AND deleted_at IS NULL
                   AND user_id IS NOT NULL AND user_id != ?`,
              )
              .all(g.id, g.last_read_id, userId) as { user_id: number }[]
          ).filter((r) => !blocked.has(r.user_id)).length
        : (unreadStmt.get(g.id, g.last_read_id, userId) as { n: number }).n;
      return {
        id: g.id,
        name: g.name,
        members: g.member_count,
        owner: this.ownerOf(g) === userId,
        unread,
        last: lastView,
        createdAt: g.created_at,
      };
    });
  }

  detail(userId: number, groupId: number): GroupDetail {
    const g = this.requireMember(groupId, userId);
    const members = this.members(groupId);
    const owner = this.ownerOf(g, members);
    const { rows, hasMore } = this.page(groupId, Number.MAX_SAFE_INTEGER);
    const blocked = this.opts.social.blockedIds(userId);
    const cache = new Map<number, GroupMessage['from']>();
    return {
      id: g.id,
      name: g.name,
      owner: owner === userId,
      members: this.memberView(members, owner),
      messages: rows.map((r) => this.toMessage(r, userId, blocked, cache)),
      hasMore,
    };
  }

  /** 往前翻。 */
  older(userId: number, groupId: number, before: number): { messages: GroupMessage[]; hasMore: boolean } {
    this.requireMember(groupId, userId);
    const { rows, hasMore } = this.page(groupId, before);
    const blocked = this.opts.social.blockedIds(userId);
    const cache = new Map<number, GroupMessage['from']>();
    return { messages: rows.map((r) => this.toMessage(r, userId, blocked, cache)), hasMore };
  }

  /** 看过了：这个群到现在的消息都算读了。 */
  markRead(userId: number, groupId: number) {
    this.requireMember(groupId, userId);
    const last = (this.db.prepare('SELECT MAX(id) AS id FROM chat_group_messages WHERE group_id = ?').get(groupId) as { id: number | null }).id ?? 0;
    const changed = this.db.prepare('UPDATE chat_group_members SET last_read_id = ? WHERE group_id = ? AND user_id = ? AND last_read_id < ?').run(last, groupId, userId, last).changes;
    if (changed) this.opts.social.pushBadges(userId);
  }

  // ==================== 改 ====================

  private cleanName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (!name || [...name].length > GROUP_NAME_MAX) throw new HttpError(400, `群名要在1～${GROUP_NAME_MAX}个字之间`);
    return name;
  }

  /** 要拉进群的人：自己的好友、没被屏蔽、正式账号、没被封、没在太多群里。 */
  private invitees(userId: number, refs: unknown, groupId: number | null): BriefRow[] {
    if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string')) throw new HttpError(400, '请求格式不对');
    const out: BriefRow[] = [];
    for (const ref of new Set(refs as string[])) {
      const u = this.opts.social.findUser(ref);
      if (!u || u.id === userId || u.is_guest === 1) throw new HttpError(404, '没有这个用户');
      if (!this.opts.social.areFriends(userId, u.id)) throw new HttpError(403, `${u.display_name}不是你的好友，不能拉进群`);
      if (this.opts.social.blockedEither(userId, u.id)) throw new HttpError(403, `不能把${u.display_name}拉进群`);
      if (u.banned_at !== null) throw new HttpError(403, `${u.display_name}的账号被封了`);
      if (groupId !== null && this.isMember(groupId, u.id)) continue;
      if (this.joinedCount(u.id) >= GROUPS_JOINED_MAX) throw new HttpError(409, `${u.display_name}已经在 ${GROUPS_JOINED_MAX} 个群里了`);
      out.push(u);
    }
    return out;
  }

  private joinedCount(userId: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id WHERE m.user_id = ? AND g.disbanded_at IS NULL')
        .get(userId) as { n: number }
    ).n;
  }

  private system(groupId: number, text: string, at: number): MessageRow {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO chat_group_messages (group_id, user_id, kind, text, created_at) VALUES (?, NULL, 'system', ?, ?)")
      .run(groupId, text, at);
    return { id: Number(lastInsertRowid), group_id: groupId, user_id: null, kind: 'system', text, created_at: at, deleted_at: null, deleted_by: null };
  }

  /** 把一条消息推给群里每个人（每个人看到的 mine、屏蔽不一样）。 */
  private broadcast(groupId: number, row: MessageRow, skipBadges: number | null = null) {
    const hub = this.opts.hub();
    for (const id of this.memberIds(groupId)) {
      const blocked = this.opts.social.blockedIds(id);
      hub.toUser(id, 'group-message', { groupId, message: this.toMessage(row, id, blocked) });
      if (row.kind === 'text' && id !== skipBadges) this.opts.social.pushBadges(id);
    }
  }

  /** 群里的人（还有刚被移出去的人）的群列表要刷新。 */
  private changed(groupId: number, extra: number[] = []) {
    const hub = this.opts.hub();
    for (const id of new Set([...this.memberIds(groupId), ...extra])) {
      hub.toUser(id, 'groups-changed', { groupId });
      this.opts.social.pushBadges(id);
    }
  }

  create(userId: number, body: { name?: unknown; members?: unknown }): GroupSummary {
    const name = this.cleanName(body.name);
    // 群名别人看得到：看不见的字符不要（V0.8.0 安全审查）
    rejectInvisibleName(name);
    const people = this.invitees(userId, body.members ?? [], null);
    if (!people.length) throw new HttpError(400, '至少拉一个好友进群');
    if (people.length + 1 > GROUP_MEMBERS_MAX) throw new HttpError(400, `一个群最多 ${GROUP_MEMBERS_MAX} 个人`);
    if (this.joinedCount(userId) >= GROUPS_JOINED_MAX) throw new HttpError(409, `你已经在 ${GROUPS_JOINED_MAX} 个群里了`);
    const at = this.opts.now();
    const me = this.opts.social.brief(userId);
    const groupId = transaction(this.db, () => {
      const { lastInsertRowid } = this.db.prepare('INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)').run(name, userId, at);
      const id = Number(lastInsertRowid);
      const add = this.db.prepare('INSERT INTO chat_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)');
      add.run(id, userId, at);
      for (const p of people) add.run(id, p.id, at);
      this.system(id, `${me?.displayName ?? '有人'}建了群，拉了${people.map((p) => p.display_name).join('、')}`, at);
      return id;
    });
    for (const p of people) this.opts.social.notify(p.id, 'group_added', { from: me, groupId, name });
    this.changed(groupId);
    return this.list(userId).find((g) => g.id === groupId)!;
  }

  send(userId: number, groupId: number, raw: unknown): GroupMessage {
    this.requireMember(groupId, userId);
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || [...text].length > GROUP_MESSAGE_MAX) throw new HttpError(400, `消息要在1～${GROUP_MESSAGE_MAX}个字之间`);
    const at = this.opts.now();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO chat_group_messages (group_id, user_id, kind, text, created_at) VALUES (?, ?, 'text', ?, ?)")
      .run(groupId, userId, text, at);
    const row: MessageRow = { id: Number(lastInsertRowid), group_id: groupId, user_id: userId, kind: 'text', text, created_at: at, deleted_at: null, deleted_by: null };
    // 自己发的算读过了
    this.db.prepare('UPDATE chat_group_members SET last_read_id = ? WHERE group_id = ? AND user_id = ?').run(row.id, groupId, userId);
    this.broadcast(groupId, row, userId);
    return this.toMessage(row, userId, new Set());
  }

  addMembers(userId: number, groupId: number, refs: unknown): GroupDetail {
    const g = this.requireMember(groupId, userId);
    const people = this.invitees(userId, refs, groupId);
    if (!people.length) return this.detail(userId, groupId);
    if (this.members(groupId).length + people.length > GROUP_MEMBERS_MAX) throw new HttpError(409, `一个群最多 ${GROUP_MEMBERS_MAX} 个人`);
    const at = this.opts.now();
    const me = this.opts.social.brief(userId);
    let row: MessageRow | null = null;
    transaction(this.db, () => {
      const add = this.db.prepare('INSERT INTO chat_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
      for (const p of people) add.run(groupId, p.id, at);
      row = this.system(groupId, `${me?.displayName ?? '有人'}拉了${people.map((p) => p.display_name).join('、')}进群`, at);
    });
    for (const p of people) this.opts.social.notify(p.id, 'group_added', { from: me, groupId, name: g.name });
    if (row) this.broadcast(groupId, row);
    this.changed(groupId);
    return this.detail(userId, groupId);
  }

  /** 移出群：群主移出别人，或者自己退群。群主退群，最早进群的人接着当群主；最后一个人退了，群就解散了。 */
  removeMember(userId: number, groupId: number, ref: string): { left: boolean } {
    const g = this.requireMember(groupId, userId);
    const target = ref === 'me' ? { id: userId } : this.opts.social.findUser(ref);
    if (!target || !this.isMember(groupId, target.id)) throw new HttpError(404, '这个人不在群里');
    const members = this.members(groupId);
    const owner = this.ownerOf(g, members);
    const self = target.id === userId;
    if (!self && owner !== userId) throw new HttpError(403, '只有群主能移出别人');
    const at = this.opts.now();
    const name = members.find((m) => m.id === target.id)?.display_name ?? '有人';
    let row: MessageRow | null = null;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(groupId, target.id);
      const rest = members.filter((m) => m.id !== target.id);
      if (!rest.length) {
        this.db.prepare('UPDATE chat_groups SET disbanded_at = ?, disbanded_by = ? WHERE id = ?').run(at, userId, groupId);
        return;
      }
      if (target.id === owner) {
        // 群主退群：最早进群的人接着当群主
        this.db.prepare('UPDATE chat_groups SET owner_id = ? WHERE id = ?').run(rest[0].id, groupId);
        row = this.system(groupId, `${name}退出了群，${rest[0].display_name}成了群主`, at);
      } else {
        row = this.system(groupId, self ? `${name}退出了群` : `${name}被群主移出了群`, at);
      }
    });
    if (row) this.broadcast(groupId, row);
    this.changed(groupId, [target.id]);
    return { left: self };
  }

  rename(userId: number, groupId: number, raw: unknown): GroupDetail {
    const g = this.requireOwner(groupId, userId);
    const name = this.cleanName(raw);
    if (name !== g.name) {
      rejectInvisibleName(name);
      const at = this.opts.now();
      this.db.prepare('UPDATE chat_groups SET name = ? WHERE id = ?').run(name, groupId);
      const me = this.opts.social.brief(userId);
      this.broadcast(groupId, this.system(groupId, `${me?.displayName ?? '群主'}把群名改成了「${name}」`, at));
      this.changed(groupId);
    }
    return this.detail(userId, groupId);
  }

  /** 解散：群从每个人的列表里消失，记录留着（管理员看得到）。 */
  disband(userId: number, groupId: number, byAdmin = false) {
    const g = byAdmin ? this.group(groupId) : this.requireOwner(groupId, userId);
    if (!g) throw new HttpError(404, '没有这个群');
    if (g.disbanded_at !== null) return;
    const members = this.memberIds(groupId);
    this.db.prepare('UPDATE chat_groups SET disbanded_at = ?, disbanded_by = ? WHERE id = ?').run(this.opts.now(), userId, groupId);
    const hub = this.opts.hub();
    for (const id of members) {
      hub.toUser(id, 'groups-changed', { groupId, disbanded: true });
      this.opts.social.pushBadges(id);
    }
  }

  /** 撤回一条消息：自己的随时能撤回；管理员能撤回别人的。 */
  withdraw(userId: number, groupId: number, messageId: number, admin: boolean) {
    const g = admin ? this.group(groupId) : this.requireMember(groupId, userId);
    if (!g) throw new HttpError(404, '没有这个群');
    const row = this.db.prepare('SELECT * FROM chat_group_messages WHERE id = ? AND group_id = ?').get(messageId, groupId) as MessageRow | undefined;
    if (!row || row.kind !== 'text') throw new HttpError(404, '没有这条消息');
    if (row.deleted_at !== null) return;
    if (!admin && row.user_id !== userId) throw new HttpError(403, '只能撤回自己发的消息');
    this.db.prepare('UPDATE chat_group_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(this.opts.now(), userId, messageId);
    const fresh = { ...row, deleted_at: this.opts.now(), deleted_by: userId };
    const hub = this.opts.hub();
    for (const id of this.memberIds(groupId)) {
      hub.toUser(id, 'group-message', { groupId, message: this.toMessage(fresh, id, new Set()), replace: true });
      this.opts.social.pushBadges(id);
    }
  }

  /** 举报群消息用：自己在这个群里、是别人发的、没被管理员撤回的。 */
  messageForReport(messageId: number, userId: number): { senderId: number; text: string; groupId: number; groupName: string; at: number } | null {
    const row = this.db
      .prepare('SELECT x.*, g.name AS group_name FROM chat_group_messages x JOIN chat_groups g ON g.id = x.group_id WHERE x.id = ?')
      .get(messageId) as (MessageRow & { group_name: string }) | undefined;
    if (!row || row.kind !== 'text' || row.user_id === null || !this.isMember(row.group_id, userId)) return null;
    if (row.deleted_at !== null && row.deleted_by !== row.user_id) return null;
    return { senderId: row.user_id, text: row.text, groupId: row.group_id, groupName: row.group_name, at: row.created_at };
  }

  // ==================== 管理员 ====================

  private adminRow(g: GroupRow & { member_count: number; message_count: number; last_at: number | null }): AdminGroupRow {
    const members = this.members(g.id);
    const owner = g.disbanded_at === null ? this.ownerOf(g, members) : g.owner_id;
    return {
      id: g.id,
      name: g.name,
      owner: owner !== null ? this.opts.social.brief(owner) : null,
      members: g.member_count,
      messages: g.message_count,
      lastAt: g.last_at,
      createdAt: g.created_at,
      disbandedAt: g.disbanded_at,
    };
  }

  private static ADMIN_SELECT = `SELECT g.*,
      (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM chat_group_messages x WHERE x.group_id = g.id AND x.kind = 'text') AS message_count,
      (SELECT MAX(created_at) FROM chat_group_messages x WHERE x.group_id = g.id) AS last_at
    FROM chat_groups g`;

  /** 所有的群，最近有消息的在前；q 按群名或者成员的显示名找。 */
  adminList(q: string): AdminGroupRow[] {
    const words = q.trim();
    const rows = (
      words
        ? this.db
            .prepare(
              `${Groups.ADMIN_SELECT} WHERE g.name LIKE ? ESCAPE '\\' OR EXISTS (
                 SELECT 1 FROM chat_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = g.id AND (u.display_name LIKE ? ESCAPE '\\' OR u.public_id = ?))
               ORDER BY COALESCE(last_at, g.created_at) DESC LIMIT 200`,
            )
            .all(`%${escapeLike(words)}%`, `%${escapeLike(words)}%`, words)
        : this.db.prepare(`${Groups.ADMIN_SELECT} ORDER BY COALESCE(last_at, g.created_at) DESC LIMIT 200`).all()
    ) as (GroupRow & { member_count: number; message_count: number; last_at: number | null })[];
    return rows.map((g) => this.adminRow(g));
  }

  adminDetail(groupId: number, before: number): AdminGroupDetail {
    const g = this.db.prepare(`${Groups.ADMIN_SELECT} WHERE g.id = ?`).get(groupId) as
      | (GroupRow & { member_count: number; message_count: number; last_at: number | null })
      | undefined;
    if (!g) throw new HttpError(404, '没有这个群');
    const members = this.members(groupId);
    const owner = g.disbanded_at === null ? this.ownerOf(g, members) : g.owner_id;
    const { rows, hasMore } = this.page(groupId, before);
    const cache = new Map<number, GroupMessage['from']>();
    const messages: AdminGroupMessage[] = rows.map((r) => {
      const { mine: _mine, hidden: _hidden, ...view } = this.toMessage(r, 0, new Set(), cache);
      return { ...view, withdrawnText: r.deleted_at !== null ? r.text : null };
    });
    return { group: this.adminRow(g), members: this.memberView(members, owner), messages, hasMore };
  }
}


