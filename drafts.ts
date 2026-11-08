import fs from 'node:fs';
import path from 'node:path';
import { transaction, type DB } from './db';
import { validateScenario } from './game/scenario';
import { HttpError } from './http';
import { SCENARIO_CHECK_MAX } from './routes/game';
import {
  DRAFTS_MAX,
  DRAFT_TITLE_MAX,
  EDITOR_SECTIONS,
  PROBLEMS_SHOWN,
  problemSection,
  problemTarget,
  type Draft,
  type DraftSummary,
  type EditorCheck,
  type EditorProblem,
  type EditorSummary,
} from '../shared/editor';

// 网页剧本编辑器（V0.8.0）：草稿（只有自己看得到）、边写边检查、示例剧本。
// 草稿可以还没写完、有错误：只查是不是一个 JSON 对象、有多大、套了几层，内容等用的时候（检查、导入进对局）再查。

/** 剧本最多套几层（自带剧本最深的地下城也就七八层）：太深的 JSON 在服务器上转成文字时会把调用栈撑爆。 */
const MAX_DEPTH = 32;

type Row = { id: number; title: string; data: string; created_at: number; updated_at: number };

const NOT_FOUND = '没有这份草稿（可能已经删了）';

/** 套了超过 limit 层（不递归，免得被特别深的 JSON 撑爆调用栈）。 */
function tooDeep(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * 一份剧本（草稿、要检查的）的大小：写成 JSON 以后最多 SCENARIO_CHECK_MAX 个字（和导入剧本一样），最多套 MAX_DEPTH 层。
 * 返回写成的 JSON 文字。
 */
export function scenarioText(data: unknown): string {
  if (tooDeep(data, MAX_DEPTH)) throw new HttpError(400, `剧本套的层数太多了（最多 ${MAX_DEPTH} 层），请检查 JSON 是不是写乱了`);
  const text = JSON.stringify(data) ?? '';
  if (text.length > SCENARIO_CHECK_MAX) throw new HttpError(413, `剧本太长了（${text.length}个字），最多${SCENARIO_CHECK_MAX}个字`);
  return text;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 草稿的标题：剧本的 title，去掉两头的空白，最多 DRAFT_TITLE_MAX 个字；没写是空的。 */
export function draftTitle(data: Record<string, unknown>): string {
  const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : '';
  return [...title].slice(0, DRAFT_TITLE_MAX).join('');
}

const toSummary = (r: Row): DraftSummary => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });

export class Drafts {
  constructor(
    private db: DB,
    private now: () => number,
  ) {}

  /** 自己的草稿，最近改过的在前面。 */
  list(userId: number): DraftSummary[] {
    return (
      this.db
        .prepare('SELECT id, title, created_at, updated_at FROM scenario_drafts WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
        .all(userId) as Row[]
    ).map(toSummary);
  }

  /** 一份自己的草稿（别人的一律说没有）。 */
  get(userId: number, id: number): Draft {
    const row = this.db.prepare('SELECT * FROM scenario_drafts WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    if (!row) throw new HttpError(404, NOT_FOUND);
    return { ...toSummary(row), data: JSON.parse(row.data) };
  }

  /** 存一份新的草稿：每人最多 DRAFTS_MAX 份。 */
  create(userId: number, data: unknown): DraftSummary {
    const { text, title } = this.check(data);
    const at = this.now();
    const id = transaction(this.db, () => {
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM scenario_drafts WHERE user_id = ?').get(userId) as { n: number };
      if (n >= DRAFTS_MAX) throw new HttpError(409, `草稿最多存 ${DRAFTS_MAX} 份，删掉一些不要的再存`);
      return Number(
        this.db
          .prepare('INSERT INTO scenario_drafts (user_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(userId, title, text, at, at).lastInsertRowid,
      );
    });
    return { id, title, createdAt: at, updatedAt: at };
  }

  /** 改一份自己的草稿（整份换掉）。 */
  update(userId: number, id: number, data: unknown): DraftSummary {
    const { text, title } = this.check(data);
    const at = this.now();
    const changed = this.db.prepare('UPDATE scenario_drafts SET title = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(title, text, at, id, userId).changes;
    if (!changed) throw new HttpError(404, NOT_FOUND);
    const row = this.db.prepare('SELECT id, title, created_at, updated_at FROM scenario_drafts WHERE id = ?').get(id) as Row;
    return toSummary(row);
  }

  remove(userId: number, id: number) {
    if (!this.db.prepare('DELETE FROM scenario_drafts WHERE id = ? AND user_id = ?').run(id, userId).changes) throw new HttpError(404, NOT_FOUND);
  }

  /** 草稿要是一个 JSON 对象（整份剧本），大小、层数不超过上限。 */
  private check(data: unknown): { text: string; title: string } {
    if (data === undefined) throw new HttpError(400, '请求格式不对：没有剧本内容（data）');
    if (!isObject(data)) throw new HttpError(400, '剧本要是一个 JSON 对象 {…}');
    return { text: scenarioText(data), title: draftTitle(data) };
  }
}

/** 剧本里有几个身份、地点、线索……（没写对的也照样数，不是列表的算 0）。 */
function summarize(data: unknown): EditorSummary {
  const o = isObject(data) ? data : {};
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const truth = isObject(o.truth) ? o.truth : {};
  return {
    roles: count(o.roles),
    locations: count(o.locations),
    npcs: count(o.npcs),
    truthPoints: count(truth.points),
    clues: count(o.clues),
    coreClues: Array.isArray(o.clues) ? o.clues.filter((c) => isObject(c) && c.core === true).length : 0,
    timeline: count(o.timeline),
    worldEvents: count(o.worldEvents),
    endings: count(o.endings),
    items: count(o.customItems),
    shops: count(o.shops),
    dungeon: o.category === 'dungeon',
    five: o.rules === '5e',
    monsters: count(o.monsters),
    treasure: count(o.treasure),
  };
}

/**
 * 一条问题最多给多少个字：报错里会带上剧本里写的内容（地点、标识……），故意写得特别长的截短，免得回复太大。
 * 正常的报错远远到不了。
 */
const PROBLEM_TEXT_MAX = 300;

/** 截到 max 个字（按字算，不把一个字拆成两半）；只看前面这些，不把整段文字拆开。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  let n = 0;
  for (const ch of text) {
    if (n === max) return `${out}…`;
    out += ch;
    n++;
  }
  return out;
}

/**
 * 边写边检查：用 validateScenario 查一遍（和导入剧本、开团前的检查一样），错误和提醒原样给出来，
 * 另外标上是哪个分区、第几项（编辑页点了跳过去）。没有错误就是 ok（提醒不算），可以用来开局。
 * 只列前 PROBLEMS_SHOWN 条（错误在前），另外给总数和每个分区各有几个（V0.8.0 安全审查：问题条数、回复大小要有上限）。
 */
export function checkScenario(data: unknown): EditorCheck {
  scenarioText(data);
  const result = validateScenario(data);
  const sections = Object.fromEntries(EDITOR_SECTIONS.map((s) => [s.key, { errors: 0, warnings: 0 }])) as EditorCheck['sections'];
  const problems: EditorProblem[] = [];
  const add = (level: EditorProblem['level'], text: string) => {
    // 每一条都要数进它的分区（只算分区，快）；列出来的那些再算第几项
    sections[problemSection(text)][level === 'error' ? 'errors' : 'warnings']++;
    if (problems.length >= PROBLEMS_SHOWN) return;
    const { section, index, key } = problemTarget(text);
    problems.push({ level, text: clip(text, PROBLEM_TEXT_MAX), section, index, key });
  };
  for (const text of result.errors) add('error', text);
  for (const text of result.warnings) add('warning', text);
  return { ok: result.errors.length === 0, problems, errors: result.errors.length, warnings: result.warnings.length, sections, summary: summarize(data) };
}

let example: string | null = null;

/**
 * 新建时的「示例」：一份很短的原创剧本（server/editor-example.json，不用自带的剧本，免得把自带剧本的秘密和结局剧透给所有人）。
 * 每次给一份新的（网页拿去随便改）。
 */
export function editorExample(): Record<string, unknown> {
  example ??= fs.readFileSync(path.join(import.meta.dirname, 'editor-example.json'), 'utf8');
  return JSON.parse(example) as Record<string, unknown>;
}
