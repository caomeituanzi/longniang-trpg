import { transaction, type DB } from './db';
import { HttpError } from './http';
import type { RealtimeHub } from './realtime';
import { BRIEF_COLUMNS, toBrief, type BriefRow, type NotificationKind, type Social } from './social';
import {
  SCHEDULE_ANSWERS,
  SCHEDULE_MAX_AHEAD_MS,
  SCHEDULE_MAX_SLOTS,
  SCHEDULE_MIN_LEAD_MS,
  SCHEDULE_NOTE_MAX,
  SCHEDULE_PAST_AFTER_MS,
  SCHEDULE_REMIND_BEFORE_MS,
  type ScheduleAnswer,
  type ScheduleMine,
  type ScheduleSlot,
  type ScheduleUser,
  type ScheduleView,
} from '../shared/schedule';

// 约团（V0.8.0）：房主在对局里列几个候选时间，成员勾「能来 / 也许 / 来不了」，房主定下一个，开始前 30 分钟提醒。
// 一局同时只有一个约团（正在勾的 open，或者定下了的 confirmed）；房主重新列时间就开一个新的，旧的作废（cancelled）。
// 谁能做什么：房主（rooms.host_user_id）列、定、取消；成员（players 里的人，包括房主）勾、看。接口在 routes/schedule.ts。

/** 约团要的对局信息（rooms.requireMember 查出来的那一行就有）。 */
export type ScheduleRoom = { id: number; name: string; status: string; host_user_id: number };

type PollRow = {
  id: number;
  room_id: number;
  created_by: number | null;
  note: string;
  status: 'open' | 'confirmed' | 'cancelled';
  confirmed_slot_id: number | null;
  starts_at: number | null;
  reminded_at: number | null;
  created_at: number;
  updated_at: number;
};

const NONE = '现在没有在约的时间（可能房主取消了），刷新一下看看';
const GONE_SLOT = '这个时间已经不在了（可能房主重新列了时间），刷新一下再试';

/** 附言：一句话，换行和连着的空格合成一个空格；可以不写。 */
function parseNote(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new HttpError(400, '附言的格式不对');
  const note = raw.replace(/\s+/g, ' ').trim();
  if ([...note].length > SCHEDULE_NOTE_MAX) throw new HttpError(400, `附言最多 ${SCHEDULE_NOTE_MAX} 个字`);
  return note;
}

/**
 * 候选时间：1～6 个 UTC 毫秒数，按分钟取整（秒数不要）；每个要比现在晚至少 10 分钟、在 60 天以内。
 * 同一分钟的两个算重复：报错（不悄悄去掉，免得房主以为列了三个、大家只看到两个）。返回按时间先后排好的。
 */
function parseSlots(raw: unknown, at: number): number[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SCHEDULE_MAX_SLOTS) throw new HttpError(400, `候选时间要列 1～${SCHEDULE_MAX_SLOTS} 个`);
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new HttpError(400, '时间的格式不对，刷新一下再试');
    const minute = Math.floor(value / 60_000) * 60_000;
    if (minute < at + SCHEDULE_MIN_LEAD_MS) throw new HttpError(400, '每个时间都要比现在晚至少 10 分钟');
    if (minute > at + SCHEDULE_MAX_AHEAD_MS) throw new HttpError(400, '时间要在 60 天以内');
    if (out.includes(minute)) throw new HttpError(400, '有两个时间是同一分钟，删掉一个再发');
    out.push(minute);
  }
  return out.sort((a, b) => a - b);
}

export class Schedule {
  private timer: NodeJS.Timeout | null = null;
  /** 同一局的约团变了以后，这么久（毫秒）里再变只补推一次（见 changed）。测试可以改小。 */
  throttleMs = 1500;
  /** 正在等这段时间过去的对局：again 是这段时间里又变过。 */
  private pushes = new Map<number, { timer: NodeJS.Timeout; again: boolean }>();

  constructor(private readonly opts: { db: DB; hub: () => RealtimeHub; social: Social; now: () => number }) {}

  // ==================== 查 ====================

  /** 这一局现在的约团（正在勾的或者定下了的，最多一个）。 */
  private current(roomId: number): PollRow | undefined {
    return this.opts.db
      .prepare("SELECT * FROM schedule_polls WHERE room_id = ? AND status IN ('open', 'confirmed') ORDER BY id DESC LIMIT 1")
      .get(roomId) as PollRow | undefined;
  }

  /** 现在的成员（账号删了的不算），房主在前，其他人按加入的先后。 */
  private members(roomId: number): BriefRow[] {
    return this.opts.db
      .prepare(
        `SELECT ${BRIEF_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')} FROM players p JOIN users u ON u.id = p.user_id
         WHERE p.room_id = ? AND u.deleted_at IS NULL ORDER BY p.role = 'host' DESC, p.joined_at, p.id`,
      )
      .all(roomId) as BriefRow[];
  }

  private memberIds(roomId: number): number[] {
    return this.members(roomId).map((m) => m.id);
  }

  /** 这一局现在的约团，从 userId 这个成员看（调用前先确认他是成员）。没有是 null。 */
  view(room: ScheduleRoom, userId: number): ScheduleView | null {
    const poll = this.current(room.id);
    if (!poll) return null;
    const db = this.opts.db;
    const at = this.opts.now();
    const members = this.members(room.id);
    const briefs = new Map<number, ScheduleUser>(members.map((m) => [m.id, toBrief(m)]));
    // 只算现在的成员：离开了对局（或者账号删了）的人勾的不算
    const votes = (
      db
        .prepare('SELECT v.slot_id, v.user_id, v.answer FROM schedule_votes v JOIN schedule_slots s ON s.id = v.slot_id WHERE s.poll_id = ?')
        .all(poll.id) as { slot_id: number; user_id: number; answer: ScheduleAnswer }[]
    ).filter((v) => briefs.has(v.user_id));
    const order = new Map(members.map((m, i) => [m.id, i]));
    votes.sort((a, b) => order.get(a.user_id)! - order.get(b.user_id)!);
    const slots: ScheduleSlot[] = (db.prepare('SELECT id, starts_at FROM schedule_slots WHERE poll_id = ? ORDER BY starts_at, id').all(poll.id) as { id: number; starts_at: number }[]).map(
      (s) => {
        const mineVotes = votes.filter((v) => v.slot_id === s.id);
        const counts = { yes: 0, maybe: 0, no: 0 };
        for (const v of mineVotes) counts[v.answer]++;
        return {
          id: s.id,
          startsAt: s.starts_at,
          votes: mineVotes.map((v) => ({ user: briefs.get(v.user_id)!, answer: v.answer })),
          counts,
          mine: mineVotes.find((v) => v.user_id === userId)?.answer ?? null,
        };
      },
    );
    const voters = new Set(votes.map((v) => v.user_id));
    return {
      id: poll.id,
      status: poll.status === 'confirmed' ? 'confirmed' : 'open',
      note: poll.note,
      createdBy: poll.created_by === null ? null : this.opts.social.brief(poll.created_by),
      createdAt: poll.created_at,
      updatedAt: poll.updated_at,
      slots,
      confirmedSlotId: poll.status === 'confirmed' ? poll.confirmed_slot_id : null,
      startsAt: poll.status === 'confirmed' ? poll.starts_at : null,
      past: poll.status === 'confirmed' && poll.starts_at !== null && at >= poll.starts_at + SCHEDULE_PAST_AFTER_MS,
      canManage: room.host_user_id === userId,
      members: members.length,
      answered: voters.size,
      waiting: members.filter((m) => !voters.has(m.id)).map((m) => briefs.get(m.id)!),
    };
  }

  /** 「我的对局」：我在的、没结束的每一局——下次定下的时间（还没过去的），有没有要我勾的。 */
  mine(userId: number): ScheduleMine[] {
    const at = this.opts.now();
    const rows = this.opts.db
      .prepare(
        `SELECT r.id AS room_id, sp.status, sp.starts_at,
           EXISTS (SELECT 1 FROM schedule_votes v JOIN schedule_slots s ON s.id = v.slot_id WHERE s.poll_id = sp.id AND v.user_id = ?) AS voted
         FROM players p JOIN rooms r ON r.id = p.room_id
         LEFT JOIN schedule_polls sp ON sp.room_id = r.id AND sp.status IN ('open', 'confirmed')
         WHERE p.user_id = ? AND r.status != 'ended'
         ORDER BY r.id`,
      )
      .all(userId, userId) as { room_id: number; status: 'open' | 'confirmed' | null; starts_at: number | null; voted: number }[];
    return rows.map((r) => ({
      roomId: r.room_id,
      startsAt: r.status === 'confirmed' && r.starts_at !== null && at < r.starts_at + SCHEDULE_PAST_AFTER_MS ? r.starts_at : null,
      needsVote: r.status === 'open' && r.voted === 0,
    }));
  }

  // ==================== 改 ====================

  private assertHost(room: ScheduleRoom, userId: number, message: string) {
    if (room.host_user_id !== userId) throw new HttpError(403, message);
  }

  private assertOpenRoom(room: ScheduleRoom) {
    if (room.status === 'ended') throw new HttpError(409, '这一局已经结束了，不能再约时间');
  }

  /** 房主列新的候选时间（旧的作废）。通知除房主以外的成员；原来定下了、还没开始的，先告诉大家那次取消了。 */
  create(room: ScheduleRoom, userId: number, input: { slots: unknown; note: unknown }): ScheduleView {
    this.assertHost(room, userId, '只有房主能约时间');
    this.assertOpenRoom(room);
    const at = this.opts.now();
    const times = parseSlots(input.slots, at);
    const note = parseNote(input.note);
    const db = this.opts.db;
    const replaced = transaction(db, () => {
      const old = this.current(room.id);
      if (old) db.prepare("UPDATE schedule_polls SET status = 'cancelled', updated_at = ? WHERE id = ?").run(at, old.id);
      const pollId = Number(
        db.prepare("INSERT INTO schedule_polls (room_id, created_by, note, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)").run(room.id, userId, note, at, at)
          .lastInsertRowid,
      );
      const add = db.prepare('INSERT INTO schedule_slots (poll_id, starts_at) VALUES (?, ?)');
      for (const t of times) add.run(pollId, t);
      return old;
    });
    const others = this.memberIds(room.id).filter((id) => id !== userId);
    if (replaced?.status === 'confirmed' && replaced.starts_at !== null && replaced.starts_at > at) {
      this.notifyEach(others, 'schedule_cancelled', { roomId: room.id, roomName: room.name }, ['schedule_confirmed', 'schedule_reminder']);
    }
    // 以前列的还没看的「列了时间」作废（标成已读），只留这一条
    this.notifyEach(others, 'schedule_poll', { roomId: room.id, roomName: room.name, from: this.opts.social.brief(userId), count: times.length }, ['schedule_poll']);
    this.changed(room.id);
    return this.view(room, userId)!;
  }

  /** 成员勾：{ [时间的编号]: yes | maybe | no | null }，null 是不勾了。定下以后不能再改。 */
  vote(room: ScheduleRoom, userId: number, raw: unknown): ScheduleView {
    this.assertOpenRoom(room);
    const poll = this.current(room.id);
    if (!poll) throw new HttpError(404, NONE);
    if (poll.status !== 'open') throw new HttpError(409, '时间已经定下了，不能再改');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '请求格式不对');
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length < 1 || entries.length > SCHEDULE_MAX_SLOTS) throw new HttpError(400, '请求格式不对');
    const db = this.opts.db;
    const slotIds = new Set((db.prepare('SELECT id FROM schedule_slots WHERE poll_id = ?').all(poll.id) as { id: number }[]).map((s) => s.id));
    const changes: [number, ScheduleAnswer | null][] = [];
    for (const [key, value] of entries) {
      const slotId = /^\d{1,12}$/.test(key) ? Number(key) : 0;
      if (!slotIds.has(slotId)) throw new HttpError(409, GONE_SLOT);
      if (value !== null && !SCHEDULE_ANSWERS.includes(value as ScheduleAnswer)) throw new HttpError(400, '只能勾能来、也许或者来不了');
      changes.push([slotId, value as ScheduleAnswer | null]);
    }
    // 和原来一样的（勾的没变、本来就没勾又说不勾）不算：一个都没变就不写、不推（一直点同一个按钮也刷不了别人的页面）
    const before = new Map(
      (
        db
          .prepare('SELECT v.slot_id, v.answer FROM schedule_votes v JOIN schedule_slots s ON s.id = v.slot_id WHERE s.poll_id = ? AND v.user_id = ?')
          .all(poll.id, userId) as { slot_id: number; answer: ScheduleAnswer }[]
      ).map((v) => [v.slot_id, v.answer]),
    );
    const effective = changes.filter(([slotId, answer]) => (before.get(slotId) ?? null) !== answer);
    if (!effective.length) return this.view(room, userId)!;
    const at = this.opts.now();
    transaction(db, () => {
      const clear = db.prepare('DELETE FROM schedule_votes WHERE slot_id = ? AND user_id = ?');
      const set = db.prepare(
        `INSERT INTO schedule_votes (slot_id, user_id, answer, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (slot_id, user_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`,
      );
      for (const [slotId, answer] of effective) {
        if (answer === null) clear.run(slotId, userId);
        else set.run(slotId, userId, answer, at);
      }
    });
    // 勾过了：「房主列了时间」这条通知算看过了
    this.opts.social.clearNotifications(userId, 'schedule_poll', null, room.id);
    this.changed(room.id);
    return this.view(room, userId)!;
  }

  /** 房主从候选里定下一个（不一定要大家都勾过）。通知除房主以外的成员；离开始已经不到 30 分钟的，马上提醒。 */
  confirm(room: ScheduleRoom, userId: number, rawSlotId: unknown): ScheduleView {
    this.assertHost(room, userId, '只有房主能定时间');
    this.assertOpenRoom(room);
    if (typeof rawSlotId !== 'number' || !Number.isSafeInteger(rawSlotId) || rawSlotId < 1) throw new HttpError(400, '请选一个时间');
    const poll = this.current(room.id);
    if (!poll) throw new HttpError(404, NONE);
    const db = this.opts.db;
    const slot = db.prepare('SELECT id, starts_at FROM schedule_slots WHERE id = ? AND poll_id = ?').get(rawSlotId, poll.id) as
      | { id: number; starts_at: number }
      | undefined;
    if (!slot) throw new HttpError(409, GONE_SLOT);
    if (poll.status === 'confirmed') {
      // 点了两次：照样返回；定了别的就不能直接换（要换先取消，大家会收到通知）
      if (poll.confirmed_slot_id === slot.id) return this.view(room, userId)!;
      throw new HttpError(409, '已经定下了别的时间；要换，先取消再重新约');
    }
    const at = this.opts.now();
    if (slot.starts_at <= at) throw new HttpError(409, '这个时间已经过了，选别的时间，或者重新约');
    db.prepare("UPDATE schedule_polls SET status = 'confirmed', confirmed_slot_id = ?, starts_at = ?, updated_at = ? WHERE id = ?").run(slot.id, slot.starts_at, at, poll.id);
    const others = this.memberIds(room.id).filter((id) => id !== userId);
    this.notifyEach(others, 'schedule_confirmed', { roomId: room.id, roomName: room.name, startsAt: slot.starts_at }, ['schedule_poll']);
    this.changed(room.id);
    this.sweepReminders();
    return this.view(room, userId)!;
  }

  /** 房主取消现在的约团。定下了、还没开始的通知大家；只取消还在勾的不通知（那条「列了时间」标成已读）。 */
  cancel(room: ScheduleRoom, userId: number): null {
    this.assertHost(room, userId, '只有房主能取消约团');
    this.assertOpenRoom(room);
    const poll = this.current(room.id);
    // 已经没有了（点了两次、别的页面取消过了）：照样算取消了
    if (!poll) return null;
    const at = this.opts.now();
    this.opts.db.prepare("UPDATE schedule_polls SET status = 'cancelled', updated_at = ? WHERE id = ?").run(at, poll.id);
    const others = this.memberIds(room.id).filter((id) => id !== userId);
    if (poll.status === 'confirmed' && poll.starts_at !== null && poll.starts_at > at) {
      this.notifyEach(others, 'schedule_cancelled', { roomId: room.id, roomName: room.name }, ['schedule_poll', 'schedule_confirmed', 'schedule_reminder']);
    } else {
      for (const id of others) this.opts.social.clearNotifications(id, 'schedule_poll', null, room.id);
    }
    this.changed(room.id);
    return null;
  }

  /** 给这些人发一种通知；retract：先把这一局还没看的这几种通知标成已读（已经不作数了）。 */
  private notifyEach(userIds: number[], kind: NotificationKind, data: Record<string, unknown>, retract: NotificationKind[] = []) {
    const roomId = data.roomId as number;
    for (const id of userIds) {
      for (const old of retract) this.opts.social.clearNotifications(id, old, null, roomId);
      this.opts.social.notify(id, kind, data);
    }
  }

  /**
   * 约团变了：开着这一局的成员、开着「我的对局」的成员重新拉一下。
   * 同一局 throttleMs 里变了好几次只马上推第一次，后面的在这段时间结束时合成一次补推（最后的变化一定推出去）：
   * 有人一直点，也不会让别人的页面跟着一直重新拉、把别人的请求次数用光。
   */
  private changed(roomId: number) {
    const waiting = this.pushes.get(roomId);
    if (waiting) {
      waiting.again = true;
      return;
    }
    this.broadcast(roomId);
    const entry = {
      again: false,
      timer: setTimeout(() => {
        this.pushes.delete(roomId);
        if (!entry.again) return;
        try {
          this.changed(roomId);
        } catch (err) {
          console.error('推送约团的变化时出错：', err);
        }
      }, this.throttleMs),
    };
    entry.timer.unref();
    this.pushes.set(roomId, entry);
  }

  /** 只推给成员：观看的人（公开对局的观众、管理员）不推，不用让他们知道成员在约时间。 */
  private broadcast(roomId: number) {
    const hub = this.opts.hub();
    const members = this.memberIds(roomId);
    const isMember = new Set(members);
    hub.toRoom(roomId, 'schedule', { roomId }, (userId) => isMember.has(userId));
    for (const id of members) hub.toLobby(id, 'schedule', { roomId });
  }

  // ==================== 提醒 ====================

  /**
   * 定下的时间开始前 30 分钟，提醒所有成员（包括房主）。每个约团只提醒一次（记在 reminded_at，重启也不重复）。
   * 服务器在那个时刻关着、开起来时还没到开始时间的：开起来就补发；已经过了开始时间的不补。结束了的对局不提醒。
   * 返回这次提醒了几局（测试用）。
   */
  sweepReminders(): number {
    const db = this.opts.db;
    const at = this.opts.now();
    const due = db
      .prepare(
        `SELECT sp.id, sp.room_id, sp.starts_at, r.name FROM schedule_polls sp JOIN rooms r ON r.id = sp.room_id
         WHERE sp.status = 'confirmed' AND sp.starts_at > ? AND sp.starts_at <= ? AND sp.reminded_at IS NULL AND r.status != 'ended'`,
      )
      .all(at, at + SCHEDULE_REMIND_BEFORE_MS) as { id: number; room_id: number; starts_at: number; name: string }[];
    let sent = 0;
    for (const d of due) {
      // 先记下「提醒过了」再发：只发一次
      if (!db.prepare('UPDATE schedule_polls SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(at, d.id).changes) continue;
      for (const userId of this.memberIds(d.room_id)) {
        try {
          this.opts.social.notify(userId, 'schedule_reminder', { roomId: d.room_id, roomName: d.name, startsAt: d.starts_at });
        } catch (err) {
          console.error('发约团提醒时出错：', err);
        }
      }
      sent++;
    }
    return sent;
  }

  /** 开始：先看一次（补发关着的时候到点的），以后每分钟看一次。 */
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  private tick() {
    try {
      this.sweepReminders();
    } catch (err) {
      console.error('检查约团提醒时出错：', err);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { timer } of this.pushes.values()) clearTimeout(timer);
    this.pushes.clear();
  }
}
