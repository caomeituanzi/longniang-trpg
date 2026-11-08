import {
  PERSONA_INTRO_MAX,
  PERSONA_NAME_MAX,
  PERSONA_PAGE,
  PERSONA_PROMPT_MAX,
  PERSONAS_MAX,
  type Persona5e,
  type PersonaSort,
  type PersonaView,
} from '../shared/personas';
import { audit } from './audit';
import { transaction, type DB } from './db';
import { checkAiSeat } from './game/companions';
import { loadScenario } from './game/world';
import { HttpError } from './http';
import { parsePersona5e, persona5eSummary, readStoredPersona5e } from './persona5e';
import { toBrief } from './social';
import { escapeLike, hasInvisibleChars, rejectInvisibleName } from './util';

// AI 角色（V1.1.0，「AI 大厅」）：玩家自己做的陪玩 AI。名字、简介、人设（提示词），作者选公开还是不公开。
// 还可以带一张 5E 角色卡：和「我的角色 → 5E 角色」一样的格式，请进 5E 对局时按它算 5E 面板。
// 公开的放进 AI 大厅：谁都能看人设、能请进自己的对局；不公开的只有作者自己能请（有「举报和大厅聊天」权限的管理员看得到）。
// 名字、简介、人设都会写进给 AI 的提示词：新建、改了文字的先做内容检查（路由里），名字不能有看不见的字符。
// 请进对局时存一份当时的样子（ai_seats.persona，见 companions.ts）：还在开团准备时作者改了跟着换，开了局以后作者改了、删了、
// 不公开了，已经请进去的照旧。管理员下架的不一样：没结束的对局里都换下来，改由主持人顺带演。
// 作者被封号的、账号删掉了的，大厅里不再列他的（删账号时一起删掉）。编号不重复使用（AUTOINCREMENT）：按旧的举报下架不会删错。

/**
 * 请进对局时存下的样子（ai_seats.persona）：给 AI 角色交行动用（人设只发给它自己的那一次调用，不发给主持人）。
 * card5e 是作者给它做的 5E 角色卡；请进 5E 对局时按这张卡造它的 5E 面板。
 */
export type PersonaSnapshot = { name: string; intro: string; prompt: string; author: string; authorId: number; card5e?: Persona5e | null };

type PersonaRow = {
  id: number;
  user_id: number;
  name: string;
  intro: string;
  prompt: string;
  public: number;
  invites: number;
  card5e: string | null;
  created_at: number;
  updated_at: number;
};

type Joined = PersonaRow & {
  public_id: string;
  display_name: string;
  is_admin: number;
  is_owner: number;
  is_guest: number;
  avatar_at: number | null;
  avatar_frame: string | null;
  banned_at: number | null;
  deleted_at: number | null;
};

export type PersonaInput = { name: string; intro: string; prompt: string; public: boolean; card5e: Persona5e | null };

/** 看的人：自己是谁、是不是处理举报的管理员（有「举报和大厅聊天」权限，看得到不公开的人设）。 */
export type PersonaViewer = { id: number; isAdmin: boolean; isGuest?: boolean };

const SELECT = `SELECT p.*, u.public_id, u.display_name, u.is_admin, u.is_owner, u.is_guest, u.avatar_at, u.avatar_frame, u.banned_at, u.deleted_at
  FROM ai_personas p JOIN users u ON u.id = p.user_id`;

/** 人设里看不见的字符：控制字符（换行、制表符除外）、零宽、改文字方向的。贴进来的文字常带着，直接去掉。 */
const PROMPT_INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁩﻿\u{e0000}-\u{e007f}]/gu;

/** 人设：换行统一成 \n，去掉看不见的字符，制表符换成空格，连着的空行最多留一行。 */
export function cleanPrompt(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(PROMPT_INVISIBLE, '')
    .replace(/\t/g, ' ')
    .replace(/[ 　]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 读出新建、修改的内容（不写入）。名字 1～20 个字、不能有看不见的字符；简介最多 100 个字，写成一行；人设 1～1000 个字。
 * 修改时没写的项照旧（existing）。
 */
export function parsePersonaInput(raw: unknown, existing?: PersonaInput): PersonaInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '请求格式不对');
  const o = raw as Record<string, unknown>;
  // 没写的：修改时照旧，新建时当成空的（名字、人设空的下面会报）
  const text = (v: unknown, fallback: string | undefined, what: string): string => {
    if (v === undefined || v === null) return fallback ?? '';
    if (typeof v !== 'string') throw new HttpError(400, `${what}要写成文字`);
    return v;
  };
  const name = text(o.name, existing?.name, '名字').trim();
  if (!name) throw new HttpError(400, '给 AI 角色起个名字');
  if ([...name].length > PERSONA_NAME_MAX) throw new HttpError(400, `名字最多${PERSONA_NAME_MAX}个字`);
  rejectInvisibleName(name);
  const intro = text(o.intro, existing?.intro, '简介').replace(/\s+/g, ' ').trim();
  if ([...intro].length > PERSONA_INTRO_MAX) throw new HttpError(400, `简介最多${PERSONA_INTRO_MAX}个字`);
  if (hasInvisibleChars(intro)) throw new HttpError(400, '简介里有看不见的字符（零宽字符、改文字方向的字符），删掉再试');
  const prompt = cleanPrompt(text(o.prompt, existing?.prompt, '人设'));
  if (!prompt) throw new HttpError(400, '写一下人设');
  if ([...prompt].length > PERSONA_PROMPT_MAX) throw new HttpError(400, `人设最多${PERSONA_PROMPT_MAX}个字`);
  let isPublic = existing?.public ?? false;
  if (o.public !== undefined) {
    if (typeof o.public !== 'boolean') throw new HttpError(400, '请求格式不对');
    isPublic = o.public;
  }
  // 5E 角色卡：没写照旧，写了 null 是不带了；写了就先按做 5E 角色的规矩检查一遍
  let card5e = existing?.card5e ?? null;
  if (o.card5e !== undefined) card5e = o.card5e === null ? null : parsePersona5e(o.card5e);
  return { name, intro, prompt, public: isPublic, card5e };
}

/** 发去做内容检查的那段文字：名字、简介、人设都在里面。 */
export function personaCheckText(input: Pick<PersonaInput, 'name' | 'intro' | 'prompt'>): string {
  return `AI 角色的名字：${input.name}\n简介：${input.intro || '（没写）'}\n人设：\n${input.prompt}`;
}

/** 文字改了没有（只改公开不公开的不用再检查内容）。 */
export function textChanged(a: Pick<PersonaInput, 'name' | 'intro' | 'prompt'>, b: Pick<PersonaInput, 'name' | 'intro' | 'prompt'>): boolean {
  return a.name !== b.name || a.intro !== b.intro || a.prompt !== b.prompt;
}

export class Personas {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  private joined(id: number): Joined | undefined {
    return this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Joined | undefined;
  }

  /** 看得到这个 AI 角色：公开的（作者没被封号），自己的，管理员什么都看得到。 */
  private visible(row: Joined, viewer: PersonaViewer): boolean {
    if (row.user_id === viewer.id || viewer.isAdmin) return true;
    return row.public === 1 && row.banned_at === null && row.deleted_at === null;
  }

  private toView(row: Joined, viewer: PersonaViewer): PersonaView {
    const mine = row.user_id === viewer.id;
    let storedCard = readStoredPersona5e(row.card5e);
    let card5eSummary: PersonaView['card5eSummary'] = null;
    if (storedCard) {
      try {
        card5eSummary = persona5eSummary(storedCard);
      } catch {
        // 存坏了的卡：当成没有，不影响大厅里别的
        storedCard = null;
      }
    }
    // 整张卡只给作者和管理员（改卡要用）；别人只看大厅卡片上的一句话
    const card5e = storedCard && (mine || viewer.isAdmin) ? storedCard : null;
    return {
      id: row.id,
      name: row.name,
      intro: row.intro,
      // 不公开的人设只给作者和管理员
      prompt: row.public === 1 || mine || viewer.isAdmin ? row.prompt : '',
      public: row.public === 1,
      author: toBrief(row),
      mine,
      invites: row.invites,
      card5e,
      card5eSummary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 一个 AI 角色（看不到的当成没有）。 */
  get(id: number, viewer: PersonaViewer): PersonaView {
    const row = this.joined(id);
    if (!row || !this.visible(row, viewer)) throw new HttpError(404, '没有这个 AI 角色');
    return this.toView(row, viewer);
  }

  /**
   * 列表。hall：AI 大厅里公开的（作者没被封号），q 按名字、简介找，popular 按被请进过几局排、new 按新建的先后；
   * mine：自己做的（公开的、不公开的都有），最近改过的在前面。
   */
  list(viewer: PersonaViewer, opts: { scope: 'hall' | 'mine'; q?: string; sort?: PersonaSort; offset?: number }): { personas: PersonaView[]; more: boolean } {
    if (opts.scope === 'mine') {
      const rows = this.db.prepare(`${SELECT} WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC`).all(viewer.id) as Joined[];
      return { personas: rows.map((r) => this.toView(r, viewer)), more: false };
    }
    const where = ['p.public = 1', 'u.banned_at IS NULL', 'u.deleted_at IS NULL'];
    const args: (string | number)[] = [];
    const q = (opts.q ?? '').trim();
    if (q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.intro LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      args.push(like, like);
    }
    const order = opts.sort === 'new' ? 'p.created_at DESC, p.id DESC' : 'p.invites DESC, p.updated_at DESC, p.id DESC';
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const rows = this.db
      .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, PERSONA_PAGE + 1, offset) as Joined[];
    return { personas: rows.slice(0, PERSONA_PAGE).map((r) => this.toView(r, viewer)), more: rows.length > PERSONA_PAGE };
  }

  /** 新建（内容先检查过）。每个账号最多 PERSONAS_MAX 个；自己的 AI 角色不能重名。 */
  create(userId: number, input: PersonaInput): PersonaView {
    const at = this.now();
    const id = transaction(this.db, () => {
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM ai_personas WHERE user_id = ?').get(userId) as { n: number };
      if (n >= PERSONAS_MAX) throw new HttpError(409, `每个账号最多做${PERSONAS_MAX}个 AI 角色，删掉一个再做新的`);
      this.rejectDuplicate(userId, input.name, null);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO ai_personas (user_id, name, intro, prompt, public, card5e, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(userId, input.name, input.intro, input.prompt, input.public ? 1 : 0, input.card5e ? JSON.stringify(input.card5e) : null, at, at);
      return Number(lastInsertRowid);
    });
    return this.get(id, { id: userId, isAdmin: false });
  }

  private rejectDuplicate(userId: number, name: string, exceptId: number | null) {
    if (this.db.prepare('SELECT 1 FROM ai_personas WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, exceptId ?? 0)) {
      throw new HttpError(409, '你已经有一个叫这个名字的 AI 角色了，换一个名字吧');
    }
  }

  /** 作者自己的这个 AI 角色（改、删之前用；别人的当成没有）。 */
  own(userId: number, id: number): PersonaInput & { id: number } {
    const row = this.db.prepare('SELECT * FROM ai_personas WHERE id = ?').get(id) as PersonaRow | undefined;
    if (!row || row.user_id !== userId) throw new HttpError(404, '没有这个 AI 角色');
    return { id: row.id, name: row.name, intro: row.intro, prompt: row.prompt, public: row.public === 1, card5e: readStoredPersona5e(row.card5e) };
  }

  /**
   * 修改（内容先检查过）。还在开团准备、已经请了它的对局跟着换成新的样子：它还公开，或者那一局的房主就是作者
   * （不公开了以后，别人的对局里留着请进去时的样子，不把新写的人设带过去）。名字没改过（还是它原来的名字）的跟着改成新名字
   * （新名字在那一局里和别的身份、角色重名的不改）。开了局的照旧。返回改过的对局（要推给开着的页面）。
   */
  update(userId: number, id: number, input: PersonaInput): { persona: PersonaView; rooms: number[] } {
    const rooms = transaction(this.db, () => {
      const before = this.own(userId, id);
      this.rejectDuplicate(userId, input.name, id);
      this.db
        .prepare('UPDATE ai_personas SET name = ?, intro = ?, prompt = ?, public = ?, card5e = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.intro, input.prompt, input.public ? 1 : 0, input.card5e ? JSON.stringify(input.card5e) : null, this.now(), id);
      const snapshot = this.snapshotOf(id);
      if (!snapshot) return [];
      const seats = this.db
        .prepare(
          `SELECT s.room_id, s.role_key, s.name FROM ai_seats s JOIN rooms r ON r.id = s.room_id
           WHERE s.persona_id = ? AND r.status = 'preparing' AND (? = 1 OR r.host_user_id = ?)`,
        )
        .all(id, input.public ? 1 : 0, userId) as { room_id: number; role_key: string; name: string }[];
      const save = this.db.prepare('UPDATE ai_seats SET persona = ?, name = ? WHERE room_id = ? AND role_key = ?');
      for (const s of seats) {
        let name = s.name;
        if (s.name === before.name && input.name !== before.name) {
          try {
            name = checkAiSeat(this.db, s.room_id, s.role_key, input.name).name;
          } catch {
            // 新名字在这一局里用不了：留着原来的
          }
        }
        save.run(JSON.stringify(snapshot), name, s.room_id, s.role_key);
      }
      return [...new Set(seats.map((s) => s.room_id))];
    });
    return { persona: this.get(id, { id: userId, isAdmin: false }), rooms };
  }

  /**
   * 删掉。作者自己删：已经请进对局的照旧（存着请进去时的样子）。
   * 管理员处理举报时下架（by.isAdmin，记操作记录）：没结束的对局里请着它的身份都换下来，改由主持人顺带演
   * （名字还是它的名字的改回身份的名字）。返回名字和换下来的身份。
   */
  remove(id: number, by: { id: number; isAdmin: boolean }): { name: string; seats: { roomId: number; roleKey: string; roleName: string }[] } {
    const row = this.joined(id);
    if (!row || (row.user_id !== by.id && !by.isAdmin)) throw new HttpError(404, '没有这个 AI 角色');
    const takedown = row.user_id !== by.id;
    const seats = transaction(this.db, () => {
      const found = takedown
        ? (this.db
            .prepare(
              `SELECT s.room_id, s.role_key, s.name, s.persona FROM ai_seats s JOIN rooms r ON r.id = s.room_id
               WHERE s.persona_id = ? AND s.persona IS NOT NULL AND r.status != 'ended'`,
            )
            .all(id) as { room_id: number; role_key: string; name: string; persona: string }[])
        : [];
      const out: { roomId: number; roleKey: string; roleName: string }[] = [];
      const drop = this.db.prepare('UPDATE ai_seats SET persona = NULL, persona_id = NULL, name = ? WHERE room_id = ? AND role_key = ?');
      for (const s of found) {
        const roleName = loadScenario(this.db, s.room_id)?.scenario.roles.find((r) => r.key === s.role_key)?.name ?? s.role_key;
        let snapshotName = '';
        try {
          snapshotName = String((JSON.parse(s.persona) as { name?: unknown }).name ?? '');
        } catch {
          // 存坏了的：只比现在的名字
        }
        const ownName = s.name === row.name || s.name === snapshotName;
        drop.run(ownName ? roleName : s.name, s.room_id, s.role_key);
        out.push({ roomId: s.room_id, roleKey: s.role_key, roleName });
      }
      this.db.prepare('DELETE FROM ai_personas WHERE id = ?').run(id);
      if (takedown) {
        const note = out.length ? `，${new Set(out.map((s) => s.roomId)).size} 局里换下来改由主持人顺带演` : '';
        audit(this.db, by.id, '删除 AI 角色', `${row.display_name} 的 AI 角色「${row.name}」${note}`, this.now());
      }
      return out;
    });
    return { name: row.name, seats };
  }

  /** 请进对局时存下的样子。没有这个 AI 角色是 null。 */
  snapshotOf(id: number): PersonaSnapshot | null {
    const row = this.joined(id);
    if (!row) return null;
    return { name: row.name, intro: row.intro, prompt: row.prompt, author: row.display_name, authorId: row.user_id, card5e: readStoredPersona5e(row.card5e) };
  }

  /** 这个人能把它请进对局：公开的（作者没被封号），或者是自己的。返回编号和请进去时存下的样子。 */
  usable(id: number, userId: number): { id: number; snapshot: PersonaSnapshot } {
    const row = this.joined(id);
    const ok = row && (row.user_id === userId || (row.public === 1 && row.banned_at === null && row.deleted_at === null));
    if (!row || !ok) throw new HttpError(404, '没有这个 AI 角色，或者它不公开了');
    return { id, snapshot: { name: row.name, intro: row.intro, prompt: row.prompt, author: row.display_name, authorId: row.user_id, card5e: readStoredPersona5e(row.card5e) } };
  }
}
