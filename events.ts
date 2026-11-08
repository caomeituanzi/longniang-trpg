import type { DB } from './db';
import { HttpError } from './http';
import { CATEGORY_KEYS, type ScenarioCategory } from '../shared/game';
import { EVENT_NAME_MAX, EVENT_TITLE_MAX, type EventView } from '../shared/events';
import { EVENT_ITEMS } from '../shared/pets';

// 限时活动（V0.6.0）：管理员（发放额度权限）开的，从开始时间到结束时间。活动期间：列着的分区玩完剧本龙晶翻倍，
// 列着的限时商品在商店里卖，有活动称号的，玩完翻倍分区的剧本得到称号（见 collection.ts）。

type EventRow = { id: number; name: string; starts_at: number; ends_at: number; categories: string; items: string; title: string };

function parseList(text: string): string[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toView(r: EventRow): EventView {
  return {
    id: r.id,
    name: r.name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    categories: parseList(r.categories).filter((c): c is ScenarioCategory => (CATEGORY_KEYS as string[]).includes(c)),
    items: parseList(r.items).filter((i) => (EVENT_ITEMS as readonly string[]).includes(i)),
    title: r.title,
  };
}

export type EventInput = Omit<EventView, 'id'>;

export class Events {
  constructor(private readonly opts: { db: DB; now: () => number }) {}

  private get db() {
    return this.opts.db;
  }

  /** 全部活动：进行中和还没开始的在前，结束了的在后。 */
  list(): EventView[] {
    const now = this.opts.now();
    const all = (this.db.prepare('SELECT id, name, starts_at, ends_at, categories, items, title FROM events').all() as EventRow[]).map(toView);
    const live = all.filter((e) => e.endsAt > now).sort((a, b) => a.startsAt - b.startsAt);
    const over = all.filter((e) => e.endsAt <= now).sort((a, b) => b.endsAt - a.endsAt);
    return [...live, ...over];
  }

  get(id: number): EventView | null {
    const row = this.db.prepare('SELECT id, name, starts_at, ends_at, categories, items, title FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return row ? toView(row) : null;
  }

  /** at 那一刻进行中的活动。 */
  active(at: number = this.opts.now()): EventView[] {
    return (
      this.db.prepare('SELECT id, name, starts_at, ends_at, categories, items, title FROM events WHERE starts_at <= ? AND ends_at > ? ORDER BY starts_at, id').all(at, at) as EventRow[]
    ).map(toView);
  }

  /** 现在能买的限时商品。 */
  activeItems(at: number = this.opts.now()): string[] {
    return [...new Set(this.active(at).flatMap((e) => e.items))];
  }

  /** 这个分区的剧本现在玩完翻不翻倍：翻倍的话是哪个活动（几个活动同时翻同一个分区也只翻一次）。 */
  bonusFor(category: ScenarioCategory | null, at: number = this.opts.now()): { id: number; name: string; title: string } | null {
    if (!category) return null;
    const e = this.active(at).find((x) => x.categories.includes(category));
    return e ? { id: e.id, name: e.name, title: e.title } : null;
  }

  /** 检查管理员填的活动。 */
  static check(o: Record<string, unknown>): EventInput {
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name || [...name].length > EVENT_NAME_MAX) throw new HttpError(400, `活动的名字要在1～${EVENT_NAME_MAX}个字之间`);
    const startsAt = Number(o.startsAt);
    const endsAt = Number(o.endsAt);
    if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || startsAt <= 0) throw new HttpError(400, '请填开始和结束的时间');
    if (endsAt <= startsAt) throw new HttpError(400, '结束时间要在开始时间之后');
    if (endsAt - startsAt > 366 * 24 * 3_600_000) throw new HttpError(400, '一个活动最长一年');
    const categories = Array.isArray(o.categories) ? [...new Set(o.categories)] : [];
    if (!categories.every((c) => typeof c === 'string' && (CATEGORY_KEYS as string[]).includes(c))) throw new HttpError(400, '没有这个分区');
    const items = Array.isArray(o.items) ? [...new Set(o.items)] : [];
    if (!items.every((i) => typeof i === 'string' && (EVENT_ITEMS as readonly string[]).includes(i))) throw new HttpError(400, '没有这件限时商品');
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if ([...title].length > EVENT_TITLE_MAX) throw new HttpError(400, `活动称号最多${EVENT_TITLE_MAX}个字`);
    if (title && !categories.length) throw new HttpError(400, '有活动称号的话，要选至少一个翻倍的分区（玩完那个分区的剧本得到称号）');
    return { name, startsAt, endsAt, categories: categories as ScenarioCategory[], items: items as string[], title };
  }

  create(adminId: number, input: EventInput): EventView {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (name, starts_at, ends_at, categories, items, title, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.startsAt, input.endsAt, JSON.stringify(input.categories), JSON.stringify(input.items), input.title, adminId, this.opts.now());
    return this.get(Number(lastInsertRowid))!;
  }

  update(id: number, input: EventInput): EventView {
    const n = this.db
      .prepare('UPDATE events SET name = ?, starts_at = ?, ends_at = ?, categories = ?, items = ?, title = ? WHERE id = ?')
      .run(input.name, input.startsAt, input.endsAt, JSON.stringify(input.categories), JSON.stringify(input.items), input.title, id).changes;
    if (!n) throw new HttpError(404, '没有这个活动');
    return this.get(id)!;
  }

  remove(id: number): EventView {
    const e = this.get(id);
    if (!e) throw new HttpError(404, '没有这个活动');
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    return e;
  }
}
