import { randomInt } from 'node:crypto';
import { creditOf } from './credit';
import { CUSTOM_TITLE_PREFIX, customTitleName, ownedCustomTitles } from './custom-titles';
import { transaction, type DB } from './db';
import { loadScenario } from './game/world';
import { HttpError } from './http';
import { cnyRate } from './money';
import { getSetting, setSetting } from './settings';
import type { Social } from './social';
import { monthStart, rejectInvisibleName } from './util';
import { achievementOf, type TitleOption } from '../shared/achievements';
import type { AnyAchievementKey } from './hidden-achievements';
import { EVENT_MULTIPLIER } from '../shared/events';
import { CATEGORY_ATTRIBUTE, type ScenarioCategory } from '../shared/game';
import {
  ENERGY_PER_HOUR,
  EXCHANGE_DEFAULTS,
  EXCHANGE_LIMITS,
  GAME_MIN_ACTIONS,
  GAME_REWARD_CRYSTALS,
  JOB_TIERS,
  PET_JOBS,
  PET_SHOP,
  PET_START,
  PET_STAT_MAX,
  SATIETY_PER_HOUR,
  shopItemOf,
  TRIPS,
  type AdminPetSummary,
  type ExchangeSettings,
  type ExchangeView,
  type LedgerKind,
  type PetPage,
  type PetView,
  type TripKind,
} from '../shared/pets';
import { ATTRIBUTE_KEYS, ATTRIBUTE_NAME, type AttributeKey } from '../shared/rules';

// 宠物（V0.5.0）：每个正式账号一只。饱食度随时间降、精力随时间回（打工、远行的时候不回），都按记下的那一刻和过去的时间算；
// 打工、远行到点以后（有人看的时候，或者每分钟检查一次）发工钱、带回东西、发通知。龙晶记在账号上，每一笔都记账。
// 玩完剧本（走到结局、自己交过几个行动）在分区对应的属性上成长，一局只算一次；属性就是这些成长加起来。
// V0.6.0：远行和明信片、装扮、骰子皮肤；称号改到账号上（商城买的、成就得来的都能戴）；限时商品只在活动期间卖。
// V0.7.0：龙晶是整个网站的货币，买东西都在商城（server/shop.ts）；宠物不再有称号。

const HOUR = 3_600_000;
const EXCHANGE_SETTING = 'pet_exchange';

/** 龙晶变了要告诉的（网页顶栏的龙晶数跟着变，app.ts 接上推送）。按数据库分开记：测试里一个进程可能开好几个服务器。 */
const crystalWatchers = new WeakMap<DB, (userId: number) => void>();

export function watchCrystals(db: DB, fn: (userId: number) => void) {
  crystalWatchers.set(db, fn);
}

/** 换额度的设置（管理员改过的；没改过、存坏了的用默认的）。 */
export function exchangeSettingsOf(db: DB): ExchangeSettings {
  try {
    const v = JSON.parse(getSetting(db, EXCHANGE_SETTING) ?? 'null') as Partial<ExchangeSettings> | null;
    if (!v) return { ...EXCHANGE_DEFAULTS };
    const int = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : EXCHANGE_DEFAULTS.enabled,
      rate: int(v.rate, 1, EXCHANGE_LIMITS.rateMax, EXCHANGE_DEFAULTS.rate),
      userCap: int(v.userCap, 0, EXCHANGE_LIMITS.userCapMax, EXCHANGE_DEFAULTS.userCap),
      siteCap: int(v.siteCap, 0, EXCHANGE_LIMITS.siteCapMax, EXCHANGE_DEFAULTS.siteCap),
    };
  } catch {
    return { ...EXCHANGE_DEFAULTS };
  }
}

export function setExchangeSettingsOf(db: DB, s: ExchangeSettings) {
  setSetting(db, EXCHANGE_SETTING, JSON.stringify(s));
}

type PetRow = {
  user_id: number;
  name: string;
  description: string;
  image_type: string | null;
  image_at: number | null;
  outfit: string | null;
  satiety: number;
  energy: number;
  state_at: number;
  job: string | null;
  job_started_at: number | null;
  job_ends_at: number | null;
  trip: TripKind | null;
  trip_started_at: number | null;
  trip_ends_at: number | null;
  created_at: number;
};

const PET_COLUMNS =
  'user_id, name, description, image_type, image_at, outfit, satiety, energy, state_at, job, job_started_at, job_ends_at, trip, trip_started_at, trip_ends_at, created_at';

const clamp = (v: number) => Math.max(0, Math.min(PET_STAT_MAX, v));

type Window = { start: number | null; end: number | null };

/** t 那一刻的饱食度和精力：饱食度一直在降；精力在回，打工、远行的那段时间不回。 */
export function statsAt(
  row: Pick<PetRow, 'satiety' | 'energy' | 'state_at' | 'job' | 'job_started_at' | 'job_ends_at'> & Partial<Pick<PetRow, 'trip' | 'trip_started_at' | 'trip_ends_at'>>,
  t: number,
) {
  if (t <= row.state_at) return { satiety: row.satiety, energy: row.energy };
  let resting = t - row.state_at;
  const away: Window[] = [];
  if (row.job) away.push({ start: row.job_started_at, end: row.job_ends_at });
  if (row.trip) away.push({ start: row.trip_started_at ?? null, end: row.trip_ends_at ?? null });
  for (const w of away) {
    if (w.start === null || w.end === null) continue;
    resting -= Math.max(0, Math.min(t, w.end) - Math.max(row.state_at, w.start));
  }
  return {
    satiety: clamp(row.satiety - (SATIETY_PER_HOUR * (t - row.state_at)) / HOUR),
    energy: clamp(row.energy + (ENERGY_PER_HOUR * Math.max(0, resting)) / HOUR),
  };
}

export function petImageUrl(publicId: string, imageAt: number | null): string | null {
  return imageAt === null ? null : `/api/pets/${encodeURIComponent(publicId)}/image?v=${imageAt}`;
}

// 「今天从什么时候开始」在 util.ts；cards.ts 还是从这里引用
export { dayStart } from './util';

const jobOf = (key: string | null) => PET_JOBS.find((j) => j.key === key) ?? null;

/** 玩完剧本攒下的属性（宠物的属性就是这个）。 */
export function petGrowth(db: DB, userId: number): Record<AttributeKey, number> {
  const out = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, 0])) as Record<AttributeKey, number>;
  for (const r of db
    .prepare('SELECT attribute, COUNT(*) AS n FROM pet_growth WHERE user_id = ? AND attribute IS NOT NULL GROUP BY attribute')
    .all(userId) as { attribute: AttributeKey; n: number }[]) {
    if (r.attribute in out) out[r.attribute] = r.n;
  }
  return out;
}

export function crystalsOf(db: DB, userId: number): number {
  return (db.prepare('SELECT crystals FROM users WHERE id = ?').get(userId) as { crystals: number } | undefined)?.crystals ?? 0;
}

/** 加减龙晶并记账；减到负数抛出。要在事务里调用。 */
export function addCrystals(db: DB, userId: number, delta: number, kind: LedgerKind, detail: string, by: number | null, at: number) {
  const balance = crystalsOf(db, userId) + delta;
  if (balance < 0) throw new HttpError(409, `龙晶不够：要 ${-delta}，只有 ${balance - delta}`);
  db.prepare('UPDATE users SET crystals = ? WHERE id = ?').run(balance, userId);
  db.prepare('INSERT INTO crystal_ledger (user_id, delta, balance, kind, detail, by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    userId,
    delta,
    balance,
    kind,
    detail,
    by,
    at,
  );
  crystalWatchers.get(db)?.(userId);
}

/** 背包里有没有这个东西（称号、骰子皮肤、装扮、头像框买过没有）。 */
export function owns(db: DB, userId: number, item: string): boolean {
  return !!db.prepare('SELECT 1 FROM pet_items WHERE user_id = ? AND item = ? AND count > 0').get(userId, item);
}

/** 称号的名字：商店的称号看商店，管理员上架的称号（V0.7.1）看上架的那一件，成就、活动得来的看成就那一行。不认识的是 null。 */
export function titleNameOf(db: DB, userId: number, key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith(CUSTOM_TITLE_PREFIX)) return customTitleName(db, key);
  const shop = shopItemOf(key);
  if (shop) return shop.kind === 'title' ? shop.name : null;
  const row = db.prepare('SELECT title FROM achievements WHERE user_id = ? AND key = ?').get(userId, key) as { title: string } | undefined;
  return row?.title ?? achievementOf(key)?.title ?? null;
}

/** 一个人戴着的称号的名字。 */
export function wornTitle(db: DB, userId: number): string | null {
  const row = db.prepare('SELECT title FROM users WHERE id = ?').get(userId) as { title: string | null } | undefined;
  return titleNameOf(db, userId, row?.title ?? null);
}

/** 一局走到结局以后，记下的这一局的情况（成长、结局图鉴、成就、作者分成、日记都用它）。 */
export type FinishedGame = {
  roomId: number;
  roomCreatedAt: number;
  /** 剧本大厅里的剧本的编号（AI 生成、导入的没有）。 */
  scenarioKey: string | null;
  scenarioTitle: string;
  category: ScenarioCategory | null;
  stress: boolean;
  ending: { key: string; title: string; epilogue: string } | null;
  /** 算玩完了的人（正式账号、自己交过至少几个行动）。fresh：这一局是第一次算（重新走到结局不会再算）。 */
  players: { userId: number; fresh: boolean }[];
  /** 这一局翻倍的活动（没有是 null）。 */
  event: { id: number; name: string; title: string } | null;
};

/** 别的模块要用的：达成成就（检查一遍这几个）；进行中的活动；写明信片的文字。 */
export type PetHooks = {
  achievements?: { check(userId: number, keys: AnyAchievementKey[]): void; unlock(userId: number, key: AnyAchievementKey): void };
  events?: {
    activeItems(at: number): string[];
    bonusFor(category: ScenarioCategory | null, at: number): { id: number; name: string; title: string } | null;
  };
  postcard?: (kind: TripKind, petName: string, rng: (n: number) => number) => { title: string; text: string };
};

export class Pets {
  hooks: PetHooks = {};

  constructor(
    private readonly opts: {
      db: DB;
      social: Social;
      now: () => number;
      /** 0～n-1 的随机整数（测试可以换掉）。 */
      rng?: (n: number) => number;
    },
  ) {}

  private get db() {
    return this.opts.db;
  }

  private rand(n: number): number {
    return this.opts.rng ? this.opts.rng(n) : randomInt(n);
  }

  private row(userId: number): PetRow | null {
    return (this.db.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE user_id = ?`).get(userId) as PetRow | undefined) ?? null;
  }

  private requirePet(userId: number): PetRow {
    const row = this.settle(userId);
    if (!row) throw new HttpError(404, '你还没有宠物');
    return row;
  }

  /** 宠物在不在家（打工、远行的时候不在）。 */
  awayReason(row: Pick<PetRow, 'name' | 'job' | 'trip'>): string | null {
    if (row.job) return `${row.name}正在打工，回来了再说`;
    if (row.trip) return `${row.name}出门了，回来了再说`;
    return null;
  }

  /**
   * 把饱食度、精力算到现在，记下来；打工、远行到点了就发工钱、带回东西、发通知。返回算好以后的宠物（没养是 null）。
   */
  settle(userId: number): PetRow | null {
    const row = this.row(userId);
    if (!row) return null;
    const now = this.opts.now();
    const { satiety, energy } = statsAt(row, now);
    const job = jobOf(row.job);
    const jobDone = !!job && row.job_ends_at !== null && row.job_ends_at <= now;
    const trip = row.trip ? TRIPS[row.trip] : null;
    const tripDone = !!trip && row.trip_ends_at !== null && row.trip_ends_at <= now;
    let haul: { crystals: number; food: string | null; postcard: { title: string; text: string } } | null = null;
    if (tripDone && trip && row.trip) {
      const [lo, hi] = trip.crystals;
      const foods = PET_SHOP.filter((i) => i.kind === 'food');
      haul = {
        crystals: lo + this.rand(hi - lo + 1),
        food: trip.food ? foods[this.rand(foods.length)].key : null,
        postcard: this.hooks.postcard?.(row.trip, row.name, (n) => this.rand(n)) ?? { title: trip.name, text: `${row.name}${trip.name}回来了。` },
      };
    }
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE pets SET satiety = ?, energy = ?, state_at = ?, job = ?, job_started_at = ?, job_ends_at = ?,
             trip = ?, trip_started_at = ?, trip_ends_at = ? WHERE user_id = ?`,
        )
        .run(
          satiety,
          energy,
          now,
          jobDone ? null : row.job,
          jobDone ? null : row.job_started_at,
          jobDone ? null : row.job_ends_at,
          tripDone ? null : row.trip,
          tripDone ? null : row.trip_started_at,
          tripDone ? null : row.trip_ends_at,
          userId,
        );
      if (jobDone && job) addCrystals(this.db, userId, JOB_TIERS[job.tier].pay, 'job', `${row.name}做完「${job.name}」`, null, now);
      if (haul && trip) {
        addCrystals(this.db, userId, haul.crystals, 'trip', `${row.name}${trip.name}带回来的`, null, now);
        if (haul.food) {
          this.db
            .prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, 1) ON CONFLICT (user_id, item) DO UPDATE SET count = count + 1')
            .run(userId, haul.food);
        }
        this.db
          .prepare("INSERT INTO pet_diary (user_id, kind, title, text, status, created_at) VALUES (?, 'postcard', ?, ?, 'done', ?)")
          .run(userId, haul.postcard.title, haul.postcard.text, row.trip_ends_at ?? now);
      }
    });
    if (jobDone && job) {
      this.opts.social.notify(userId, 'pet_job_done', { pet: row.name, job: job.name, pay: JOB_TIERS[job.tier].pay });
      this.hooks.achievements?.check(userId, ['job-10', 'rich']);
    }
    if (haul && trip) {
      this.opts.social.notify(userId, 'pet_trip_done', {
        pet: row.name,
        trip: trip.name,
        crystals: haul.crystals,
        food: haul.food ? (shopItemOf(haul.food)?.name ?? null) : null,
        place: haul.postcard.title,
      });
      this.hooks.achievements?.check(userId, ['trip-5', 'postcards-all', 'rich']);
    }
    return this.row(userId);
  }

  /** 打工、远行到点的都结算一下（每分钟一次）。 */
  sweepJobs() {
    const now = this.opts.now();
    const due = this.db
      .prepare('SELECT user_id FROM pets WHERE (job_ends_at IS NOT NULL AND job_ends_at <= ?) OR (trip_ends_at IS NOT NULL AND trip_ends_at <= ?)')
      .all(now, now) as { user_id: number }[];
    for (const { user_id } of due) this.settle(user_id);
  }

  // ==================== 龙晶 ====================

  crystals(userId: number): number {
    return crystalsOf(this.db, userId);
  }

  /** 管理员发龙晶（负数是收回，收不到负数）。 */
  grant(adminId: number, userId: number, delta: number, note: string) {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new HttpError(400, '龙晶要填不是 0 的整数');
    transaction(this.db, () => addCrystals(this.db, userId, delta, 'grant', note, adminId, this.opts.now()));
    return this.crystals(userId);
  }

  // ==================== 成长 ====================

  /** 玩完剧本攒下的属性。 */
  growth(userId: number): Record<AttributeKey, number> {
    return petGrowth(this.db, userId);
  }

  /**
   * 一局走到了结局：自己交过（结算完）至少几个行动的正式账号，在剧本分区对应的属性上 +1（剧本没写分区的不长属性），
   * 另外给龙晶（活动里翻倍的分区乘倍数）。一局只算一次（重新结算、撤回又走到结局也不会再算）。
   * 返回这一局的情况，给结局图鉴、成就、作者分成、日记接着用；对局或剧本找不到是 null。
   */
  growFromGame(roomId: number): FinishedGame | null {
    const stored = loadScenario(this.db, roomId);
    if (!stored) return null;
    const room = this.db.prepare('SELECT created_at, world FROM rooms WHERE id = ?').get(roomId) as { created_at: number; world: string } | undefined;
    if (!room) return null;
    const category = stored.scenario.category ?? null;
    const attribute = category ? CATEGORY_ATTRIBUTE[category] : null;
    const title = stored.scenario.title;
    let ending: FinishedGame['ending'] = null;
    try {
      const e = (JSON.parse(room.world || '{}') as { ending?: { key: string; title: string; epilogue: string } | null }).ending;
      ending = e ? { key: e.key, title: e.title, epilogue: e.epilogue } : null;
    } catch {
      ending = null;
    }
    const players = this.db
      .prepare(
        `SELECT p.user_id, COUNT(a.id) AS n FROM players p JOIN users u ON u.id = p.user_id
         LEFT JOIN characters c ON c.player_id = p.id LEFT JOIN actions a ON a.character_id = c.id AND a.status = 'done'
         WHERE p.room_id = ? AND u.is_guest = 0 AND u.deleted_at IS NULL AND u.banned_at IS NULL GROUP BY p.user_id`,
      )
      .all(roomId) as { user_id: number; n: number }[];
    const at = this.opts.now();
    const event = this.hooks.events?.bonusFor(category, at) ?? null;
    const reward = GAME_REWARD_CRYSTALS * (event ? EVENT_MULTIPLIER : 1);
    const done: FinishedGame['players'] = [];
    for (const p of players) {
      if (p.n < GAME_MIN_ACTIONS) continue;
      const fresh = transaction(this.db, () => {
        const added = this.db
          .prepare('INSERT INTO pet_growth (user_id, room_id, room_created_at, attribute, scenario_title, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(p.user_id, roomId, room.created_at, attribute, title, at).changes;
        if (added) addCrystals(this.db, p.user_id, reward, 'game', `玩完《${title}》${event ? `（${event.name}翻倍）` : ''}`, null, at);
        return added > 0;
      });
      done.push({ userId: p.user_id, fresh });
    }
    return {
      roomId,
      roomCreatedAt: room.created_at,
      scenarioKey: stored.source === 'builtin' ? stored.key : null,
      scenarioTitle: title,
      category,
      stress: stored.scenario.stress,
      ending,
      players: done,
      event,
    };
  }

  // ==================== 宠物本身 ====================

  create(userId: number, name: string, description: string) {
    const user = this.db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId) as { is_guest: number } | undefined;
    if (!user || user.is_guest === 1) throw new HttpError(403, '游客不能养宠物');
    if (this.row(userId)) throw new HttpError(409, '你已经有宠物了');
    // 宠物的名字别人看得到：看不见的字符不要（V0.8.0 安全审查）
    rejectInvisibleName(name);
    const at = this.opts.now();
    this.db
      .prepare('INSERT INTO pets (user_id, name, description, satiety, energy, state_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, name, description, PET_START.satiety, PET_START.energy, at, at);
  }

  /** 改介绍（不花钱）；改名字要用掉一张改名卡。 */
  update(userId: number, change: { name?: string; description?: string }) {
    const row = this.requirePet(userId);
    transaction(this.db, () => {
      if (change.name !== undefined && change.name !== row.name) {
        // 新名字不能有看不见的字符（先查，不白用掉改名卡）；没改名的照旧
        rejectInvisibleName(change.name);
        this.useItem(userId, 'rename');
        this.db.prepare('UPDATE pets SET name = ? WHERE user_id = ?').run(change.name, userId);
      }
      if (change.description !== undefined) this.db.prepare('UPDATE pets SET description = ? WHERE user_id = ?').run(change.description, userId);
    });
  }

  setImage(userId: number, type: string, data: Buffer) {
    this.requirePet(userId);
    this.db.prepare('UPDATE pets SET image_type = ?, image = ?, image_at = ? WHERE user_id = ?').run(type, data, this.opts.now(), userId);
  }

  removeImage(userId: number) {
    this.requirePet(userId);
    this.db.prepare('UPDATE pets SET image_type = NULL, image = NULL, image_at = NULL WHERE user_id = ?').run(userId);
  }

  image(publicId: string): { type: string; data: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT p.image_type AS type, p.image AS data FROM pets p JOIN users u ON u.id = p.user_id WHERE u.public_id = ? AND p.image IS NOT NULL')
      .get(publicId) as { type: string; data: Uint8Array } | undefined;
    return row ?? null;
  }

  // ==================== 背包（买东西在商城，见 shop.ts） ====================

  /** 背包里的全部（包括称号、骰子皮肤、装扮、头像框、地下城道具、宝箱）：key → 个数。 */
  items(userId: number): Record<string, number> {
    return Object.fromEntries(
      (this.db.prepare('SELECT item, count FROM pet_items WHERE user_id = ? AND count > 0').all(userId) as { item: string; count: number }[]).map((r) => [r.item, r.count]),
    );
  }

  /** 用掉背包里的一个东西（要在事务里调用）。 */
  useItem(userId: number, key: string) {
    const item = shopItemOf(key);
    const n = this.db.prepare('UPDATE pet_items SET count = count - 1 WHERE user_id = ? AND item = ? AND count > 0').run(userId, key).changes;
    if (!n) throw new HttpError(409, `背包里没有${item?.name ?? '这个东西'}了`);
  }

  /** 现在商城里卖的限时商品（进行中的活动列着的）。 */
  eventItems(): string[] {
    return this.hooks.events?.activeItems(this.opts.now()) ?? [];
  }

  /** 喂吃的、喝提神茶。 */
  use(userId: number, key: string) {
    const item = shopItemOf(key);
    if (!item || (item.kind !== 'food' && item.kind !== 'tea')) throw new HttpError(400, '这个东西不能直接用');
    const row = this.requirePet(userId);
    if (item.kind === 'food' && Math.floor(row.satiety) >= PET_STAT_MAX) {
      // 隐藏成就「吃撑了」：吃饱了还接着喂
      this.hooks.achievements?.unlock(userId, 'overfed');
      throw new HttpError(409, `${row.name}吃饱了，吃不下了`);
    }
    if (item.kind === 'tea' && Math.floor(row.energy) >= PET_STAT_MAX) throw new HttpError(409, `${row.name}精神正好，用不着喝茶`);
    transaction(this.db, () => {
      this.useItem(userId, key);
      if (item.kind === 'food' && 'satiety' in item) this.db.prepare('UPDATE pets SET satiety = ? WHERE user_id = ?').run(clamp(row.satiety + item.satiety), userId);
      else if ('energy' in item) this.db.prepare('UPDATE pets SET energy = ? WHERE user_id = ?').run(clamp(row.energy + item.energy), userId);
    });
  }

  /**
   * 给别人的宠物喂一口吃的（串门）：东西从自己的背包里出，饱食度加在他的宠物上。
   * 要在事务里调用；调用前先 settle(ownerId) 把他的宠物算到现在（settle 自己开事务，不能放在事务里）。
   */
  feedOther(visitorId: number, ownerId: number, key: string): { pet: string; item: string } {
    const item = shopItemOf(key);
    if (!item || item.kind !== 'food' || !('satiety' in item)) throw new HttpError(400, '只能喂吃的');
    const row = this.row(ownerId);
    if (!row) throw new HttpError(404, '他还没有宠物');
    if (Math.floor(row.satiety) >= PET_STAT_MAX) throw new HttpError(409, `${row.name}吃饱了，吃不下了`);
    this.useItem(visitorId, key);
    this.db.prepare('UPDATE pets SET satiety = ? WHERE user_id = ?').run(clamp(row.satiety + item.satiety), ownerId);
    return { pet: row.name, item: item.name };
  }

  // ==================== 称号（账号的）、骰子皮肤、装扮 ====================

  /** 能戴的称号：商城买的（自带的，和管理员上架的），加上成就、活动得来的。 */
  titleOptions(userId: number): TitleOption[] {
    const shop = PET_SHOP.filter((i) => i.kind === 'title' && owns(this.db, userId, i.key)).map((i): TitleOption => ({ key: i.key, name: i.name, source: 'shop' }));
    const custom = ownedCustomTitles(this.db, userId).map((t): TitleOption => ({ key: t.key, name: t.name, source: 'shop' }));
    const earned = (this.db.prepare('SELECT key, title FROM achievements WHERE user_id = ? ORDER BY created_at').all(userId) as { key: string; title: string }[]).map(
      (r): TitleOption => ({ key: r.key, name: r.title, source: 'achievement' }),
    );
    return [...shop, ...custom, ...earned];
  }

  titleKey(userId: number): string | null {
    return (this.db.prepare('SELECT title FROM users WHERE id = ?').get(userId) as { title: string | null } | undefined)?.title ?? null;
  }

  /** 戴上称号（null 是摘掉）。商城买的、成就得来的才能戴。 */
  setTitle(userId: number, key: string | null) {
    if (key !== null && !this.titleOptions(userId).some((t) => t.key === key)) {
      const shop = shopItemOf(key);
      if (shop?.kind === 'title' || customTitleName(this.db, key) !== null) throw new HttpError(409, '先在商城里买这个称号');
      if (shop || (!achievementOf(key) && !/^event-\d+$/.test(key))) throw new HttpError(404, '没有这个称号');
      throw new HttpError(409, '还没有这个称号');
    }
    this.db.prepare('UPDATE users SET title = ? WHERE id = ?').run(key, userId);
  }

  /** 换骰子皮肤（null 是用回普通的）。 */
  setDiceSkin(userId: number, key: string | null) {
    if (key !== null) {
      const item = shopItemOf(key);
      if (!item || item.kind !== 'dice') throw new HttpError(404, '没有这种骰子');
      if (!owns(this.db, userId, key)) throw new HttpError(409, `先在商城里买${item.name}`);
    }
    this.db.prepare('UPDATE users SET dice_skin = ? WHERE id = ?').run(key, userId);
  }

  /** 给宠物戴上装扮（null 是摘掉）。 */
  setOutfit(userId: number, key: string | null) {
    this.requirePet(userId);
    if (key !== null) {
      const item = shopItemOf(key);
      if (!item || item.kind !== 'outfit') throw new HttpError(404, '没有这件装扮');
      if (!owns(this.db, userId, key)) throw new HttpError(409, `先在商城里买${item.name}`);
    }
    this.db.prepare('UPDATE pets SET outfit = ? WHERE user_id = ?').run(key, userId);
  }

  // ==================== 打工 ====================

  startJob(userId: number, key: string) {
    const job = jobOf(key);
    if (!job) throw new HttpError(404, '没有这份工');
    const row = this.requirePet(userId);
    const away = this.awayReason(row);
    if (away) throw new HttpError(409, away);
    const tier = JOB_TIERS[job.tier];
    const have = this.growth(userId)[job.attribute];
    if (have < tier.need) throw new HttpError(409, `这份工要${ATTRIBUTE_NAME[job.attribute]}到 ${tier.need}，${row.name}现在是 ${have}`);
    if (Math.floor(row.energy) < tier.energy) throw new HttpError(409, `${row.name}没精神了：这份工要 ${tier.energy} 点精力，现在只有 ${Math.floor(row.energy)}`);
    if (Math.floor(row.satiety) < tier.satiety) throw new HttpError(409, `${row.name}饿着肚子：这份工要 ${tier.satiety} 点饱食度，现在只有 ${Math.floor(row.satiety)}`);
    const now = this.opts.now();
    this.db
      .prepare('UPDATE pets SET energy = ?, satiety = ?, job = ?, job_started_at = ?, job_ends_at = ? WHERE user_id = ?')
      .run(row.energy - tier.energy, row.satiety - tier.satiety, job.key, now, now + tier.hours * HOUR, userId);
  }

  /** 不干了：没有工钱，花掉的精力和饱食度也不退。 */
  quitJob(userId: number) {
    const row = this.requirePet(userId);
    if (!row.job) throw new HttpError(409, `${row.name}现在没在打工`);
    this.db.prepare('UPDATE pets SET job = NULL, job_started_at = NULL, job_ends_at = NULL WHERE user_id = ?').run(userId);
  }

  // ==================== 远行 ====================

  startTrip(userId: number, kind: string) {
    if (kind !== 'near' && kind !== 'far') throw new HttpError(404, '没有这种远行');
    const trip = TRIPS[kind];
    const row = this.requirePet(userId);
    const away = this.awayReason(row);
    if (away) throw new HttpError(409, away);
    if (Math.floor(row.energy) < trip.energy) throw new HttpError(409, `${row.name}没精神了：${trip.name}要 ${trip.energy} 点精力，现在只有 ${Math.floor(row.energy)}`);
    if (Math.floor(row.satiety) < trip.satiety) throw new HttpError(409, `${row.name}饿着肚子：${trip.name}要 ${trip.satiety} 点饱食度，现在只有 ${Math.floor(row.satiety)}`);
    const now = this.opts.now();
    this.db
      .prepare('UPDATE pets SET energy = ?, satiety = ?, trip = ?, trip_started_at = ?, trip_ends_at = ? WHERE user_id = ?')
      .run(row.energy - trip.energy, row.satiety - trip.satiety, kind, now, now + trip.hours * HOUR, userId);
  }

  /** 叫回来：什么也带不回来，花掉的精力和饱食度也不退。 */
  recallTrip(userId: number) {
    const row = this.requirePet(userId);
    if (!row.trip) throw new HttpError(409, `${row.name}现在没出门`);
    this.db.prepare('UPDATE pets SET trip = NULL, trip_started_at = NULL, trip_ends_at = NULL WHERE user_id = ?').run(userId);
  }

  // ==================== 换额度 ====================

  exchangeSettings(): ExchangeSettings {
    return exchangeSettingsOf(this.db);
  }

  setExchangeSettings(s: ExchangeSettings) {
    setExchangeSettingsOf(this.db, s);
  }

  /** 商城里「换额度」那一件：设置，加上这个人这个月换了多少、全站还剩多少、他能不能换。 */
  exchangeView(userId: number): ExchangeView {
    const s = this.exchangeSettings();
    return {
      ...s,
      usedThisMonth: this.exchangedThisMonth(userId),
      siteLeft: Math.max(0, s.siteCap - this.exchangedThisMonth(null)),
      unlimited: creditOf(this.db, userId).unlimited,
      adminBlocked: this.isAdmin(userId),
    };
  }

  private isAdmin(userId: number): boolean {
    return (this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined)?.is_admin === 1;
  }

  /** 这个月换了多少元：userId 是 null 时是全站。 */
  exchangedThisMonth(userId: number | null): number {
    const since = monthStart(this.opts.now());
    const row =
      userId === null
        ? (this.db.prepare('SELECT COALESCE(SUM(cny), 0) AS n FROM crystal_exchanges WHERE created_at >= ?').get(since) as { n: number })
        : (this.db.prepare('SELECT COALESCE(SUM(cny), 0) AS n FROM crystal_exchanges WHERE user_id = ? AND created_at >= ?').get(userId, since) as { n: number });
    return row.n;
  }

  /** 用龙晶换 yuan 元 AI 额度（整数元）。 */
  exchange(userId: number, yuan: number) {
    const s = this.exchangeSettings();
    if (!s.enabled) throw new HttpError(409, '现在不能用龙晶换额度');
    if (creditOf(this.db, userId).unlimited) throw new HttpError(409, '你的额度不限，用不着换');
    // 管理员能改换额度的比例和上限：自己不能换（和管理员不能给自己发额度一样）
    if (this.isAdmin(userId)) throw new HttpError(403, '管理员不能用龙晶换额度');
    if (!Number.isInteger(yuan) || yuan < 1) throw new HttpError(400, '换的额度要填 1 以上的整数（元）');
    const mine = this.exchangedThisMonth(userId);
    if (mine + yuan > s.userCap) throw new HttpError(409, `每人每月最多换 ${s.userCap} 元，这个月你还能换 ${Math.max(0, s.userCap - mine)} 元`);
    const site = this.exchangedThisMonth(null);
    if (site + yuan > s.siteCap) throw new HttpError(409, `这个月全站能换的额度只剩 ${Math.max(0, s.siteCap - site)} 元了`);
    const cost = yuan * s.rate;
    const usd = yuan / cnyRate(this.db);
    const at = this.opts.now();
    transaction(this.db, () => {
      addCrystals(this.db, userId, -cost, 'exchange', `换了 ${yuan} 元 AI 额度`, null, at);
      this.db.prepare('UPDATE users SET ai_credit_usd = ai_credit_usd + ? WHERE id = ?').run(usd, userId);
      this.db
        .prepare('INSERT INTO credit_grants (user_id, amount_usd, granted_by, note, created_at) VALUES (?, ?, NULL, ?, ?)')
        .run(userId, usd, `龙晶换额度（${cost} 龙晶换 ${yuan} 元）`, at);
      this.db.prepare('INSERT INTO crystal_exchanges (user_id, crystals, cny, usd, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, cost, yuan, usd, at);
    });
  }

  // ==================== 给网页的 ====================

  private view(row: PetRow, publicId: string): PetView {
    const job = jobOf(row.job);
    const trip = row.trip ? TRIPS[row.trip] : null;
    return {
      name: row.name,
      description: row.description,
      image: petImageUrl(publicId, row.image_at),
      outfit: row.outfit,
      attributes: this.growth(row.user_id),
      satiety: Math.floor(row.satiety),
      energy: Math.floor(row.energy),
      job:
        job && row.job_started_at !== null && row.job_ends_at !== null
          ? { key: job.key, name: job.name, attribute: job.attribute, tier: job.tier, startedAt: row.job_started_at, endsAt: row.job_ends_at, pay: JOB_TIERS[job.tier].pay }
          : null,
      trip:
        trip && row.trip && row.trip_started_at !== null && row.trip_ends_at !== null
          ? { kind: row.trip, name: trip.name, startedAt: row.trip_started_at, endsAt: row.trip_ends_at }
          : null,
      createdAt: row.created_at,
    };
  }

  page(userId: number): PetPage {
    const row = this.settle(userId);
    const publicId = (this.db.prepare('SELECT public_id FROM users WHERE id = ?').get(userId) as { public_id: string }).public_id;
    return {
      pet: row ? this.view(row, publicId) : null,
      growth: this.growth(userId),
      games: (
        this.db.prepare('SELECT scenario_title, attribute, created_at FROM pet_growth WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId) as {
          scenario_title: string;
          attribute: AttributeKey | null;
          created_at: number;
        }[]
      ).map((r) => ({ title: r.scenario_title, attribute: r.attribute, at: r.created_at })),
    };
  }

  /** 个人主页上的宠物（不含串门，那在 pet-play.ts）。 */
  publicView(userId: number): Pick<PetView, 'name' | 'description' | 'image' | 'attributes' | 'outfit'> | null {
    const row = this.row(userId);
    if (!row) return null;
    const publicId = (this.db.prepare('SELECT public_id FROM users WHERE id = ?').get(userId) as { public_id: string }).public_id;
    const v = this.view(row, publicId);
    return { name: v.name, description: v.description, image: v.image, attributes: v.attributes, outfit: v.outfit };
  }

  /** 宠物的名字和装扮（串门用）。 */
  brief(userId: number): { name: string; outfit: string | null } | null {
    const row = this.db.prepare('SELECT name, outfit FROM pets WHERE user_id = ?').get(userId) as { name: string; outfit: string | null } | undefined;
    return row ?? null;
  }

  /** 宠物现在的饱食度、精力（「我的背包」里喂它用）；还没养是 null。 */
  status(userId: number): { name: string; satiety: number; energy: number } | null {
    const row = this.settle(userId);
    return row ? { name: row.name, satiety: Math.floor(row.satiety), energy: Math.floor(row.energy) } : null;
  }

  /** 管理页：账号详情里的宠物和龙晶。 */
  adminSummary(userId: number): AdminPetSummary {
    const row = this.settle(userId);
    return {
      crystals: this.crystals(userId),
      pet: row
        ? { name: row.name, satiety: Math.floor(row.satiety), energy: Math.floor(row.energy), job: jobOf(row.job)?.name ?? (row.trip ? TRIPS[row.trip].name : null) }
        : null,
      growth: this.growth(userId),
      ledger: (
        this.db
          .prepare(
            `SELECT l.delta, l.balance, l.kind, l.detail, l.created_at, u.display_name AS by_name FROM crystal_ledger l
             LEFT JOIN users u ON u.id = l.by_user_id WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 30`,
          )
          .all(userId) as { delta: number; balance: number; kind: LedgerKind; detail: string; created_at: number; by_name: string | null }[]
      ).map((r) => ({ delta: r.delta, balance: r.balance, kind: r.kind, detail: r.detail, at: r.created_at, by: r.by_name })),
    };
  }
}
