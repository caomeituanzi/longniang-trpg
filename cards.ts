import { randomInt } from 'node:crypto';
import { transaction, type DB } from './db';
import { HttpError } from './http';
import { rejectInvisibleName } from './util';
import { avatarUrl } from './auth';
import { addCrystals, crystalsOf, dayStart, petGrowth } from './pets';
import type { Social } from './social';
import { anyGearView, freshGearView } from './legendary';
import { manualView, MANUAL_PREFIX, SKILL_MAX, skillOf, skillView, type SkillView } from './skills';
import { COMMON_GEAR_PRICE, GEAR_BASES, gearBaseOf, gearTotals, gearView, STARTER_GEAR, type GearView } from '../shared/gear2';
import {
  type Attribute2,
  ATTRIBUTE2_KEYS,
  ATTRIBUTE2_NAME,
  type Attributes2,
  BAG_MAX,
  CARD2_APPEARANCE_MAX,
  CARD2_BACKGROUND_MAX,
  CARD2_MAX,
  CARD2_NAME_MAX,
  CARD2_SPECIALTY_COST,
  CARD2_SPECIALTY_LENGTH,
  CARD2_SPECIALTY_MAX,
  CARD2_SPECIALTY_START,
  ROLE2_MAX,
  ROLE2_MIN,
  characterDefense,
  CHEST2,
  chestsFor,
  CONSUMABLE_KEYS,
  type ConsumableKey,
  consumableOf,
  DUEL_DAILY,
  DUEL_DEFENSE_REWARDS_DAILY,
  DUEL_REWARD,
  DUEL_ROUNDS,
  type DungeonResult,
  DUPLICATE_CRYSTALS,
  emptyAttributes2,
  EQUIP_SLOT_LABEL,
  EQUIP_SLOTS,
  type EquipSlot,
  GEAR_CATEGORIES,
  GEAR_PART_LABEL,
  growthPoints,
  isCardSpecialty,
  ITEM_STACK_MAX,
  maxHp,
  maxMp,
  PET_ATTRIBUTE_FOR,
  powerOf,
  raiseCost,
  type Rarity,
  RARITY_LABEL,
  rarityOdds,
  RESULT_LABEL,
  slotsForPart,
  startAttributesProblem,
} from '../shared/rules2';
import { GAME_MIN_ACTIONS, petHelpBonus } from '../shared/pets';
import type {
  CardGrowth,
  CardHistory,
  CardRankRow,
  CardRankings,
  CardsPage,
  CardView,
  ChestResult,
  DuelRound,
  DuelView,
  DungeonSettlement,
  PublicCard,
} from '../shared/cards';
import type { LootItem } from './game/rules2';
import type { ItemUse } from './game/tools2';
import type { Scenario } from './game/scenario';
import { loadScenario, parseWorld } from './game/world';
import { rankedDungeon } from './game/scenario-library';

// 自带角色卡（V0.7.0，规则第二版）：做卡、成长、穿装备、学技能；装备、道具、宝箱；地下城结束后的结算；切磋和排行。
// 角色卡只在地下城里用（五个分区的剧本用剧本里现成的身份），所以成长不封顶。

type CardRow = {
  id: number;
  user_id: number;
  name: string;
  appearance: string;
  background: string;
  attributes: string;
  specialties: string;
  gear: string;
  growth: number;
  pending: number;
  skills: string;
  duel_wins: number;
  duel_losses: number;
  /** 在不在个人主页上展示（V0.8.1，默认展示）。 */
  on_profile: number;
  created_at: number;
};

const CARD_COLUMNS = 'id, user_id, name, appearance, background, attributes, specialties, gear, growth, pending, skills, duel_wins, duel_losses, on_profile, created_at';

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function attributesOf(text: string): Attributes2 {
  const raw = parseJson<Record<string, number>>(text, {});
  const out = emptyAttributes2();
  for (const k of ATTRIBUTE2_KEYS) out[k] = Math.round(Number(raw[k] ?? 0)) || 0;
  return out;
}

/** 穿着的装备：格子 → gear_items 的编号。 */
type Equipped = Partial<Record<EquipSlot, number>>;

/**
 * 卡上存的装备（character_cards.gear）读成十六个格子。V0.7.0 存的是三个格子 {"weapon","armor","accessory"}：
 * 按那件装备的部位放进对应的格子（戒指、饰品放进空着的那一个；万一两件抢同一个格子，加值高的留下）。
 * 已经不在账号里的、放错格子的不算。下次保存（换装备）时写成新的样子；没换过的照旧存着老样子，读的时候再换算。
 */
export function normalizeEquipped(raw: unknown, gear: ReadonlyMap<number, GearView>): Equipped {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Equipped = {};
  const used = new Set<number>();
  for (const slot of EQUIP_SLOTS) {
    const g = typeof o[slot] === 'number' ? gear.get(o[slot] as number) : undefined;
    if (!g || used.has(g.id) || !slotsForPart(g.part).includes(slot)) continue;
    out[slot] = g.id;
    used.add(g.id);
  }
  const old = GEAR_CATEGORIES.flatMap((k) => {
    const g = typeof o[k] === 'number' ? gear.get(o[k] as number) : undefined;
    return g && !used.has(g.id) ? [g] : [];
  }).sort((a, b) => b.bonus - a.bonus);
  for (const g of old) {
    const free = slotsForPart(g.part).find((s) => out[s] === undefined);
    if (free === undefined || used.has(g.id)) continue;
    out[free] = g.id;
    used.add(g.id);
  }
  return out;
}

function cleanText(v: unknown, max: number, label: string, required = false): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (required && !t) throw new HttpError(400, `${label}不能为空`);
  if ([...t].length > max) throw new HttpError(400, `${label}最多${max}个字`);
  return t;
}

function specialtyName(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw new HttpError(400, '专长不能为空');
  if ([...t].length > CARD2_SPECIALTY_LENGTH) throw new HttpError(400, `专长最多${CARD2_SPECIALTY_LENGTH}个字`);
  return t;
}

/** 新挑的专长要在列表里（V0.7.1）；keep 里的（卡上本来就有的）不在列表里也行。 */
function listedSpecialty(name: string, keep: readonly string[] = []): string {
  if (!isCardSpecialty(name) && !keep.includes(name)) throw new HttpError(400, `「${name}」不在专长列表里`);
  return name;
}

/** 带进地下城的东西（engine 建角色时用）。 */
export type DungeonEntry = {
  cardId: number;
  name: string;
  appearance: string;
  background: string;
  attributes: Attributes2;
  specialties: string[];
  gear: GearView[];
  skills: string[];
  bag: Partial<Record<ConsumableKey, number>>;
};

export class Cards {
  /** 成就（服务器组装时接上）。 */
  achievements: { check(userId: number, keys: string[]): void; unlock(userId: number, key: string): void } | null = null;

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

  private d6(): number {
    return this.rand(6) + 1;
  }

  // ==================== 读 ====================

  private row(userId: number, id: number): CardRow {
    const row = this.db.prepare(`SELECT ${CARD_COLUMNS} FROM character_cards WHERE id = ? AND user_id = ?`).get(id, userId) as CardRow | undefined;
    if (!row) throw new HttpError(404, '没有这张角色卡');
    return row;
  }

  private gearRows(userId: number): { id: number; base: string; rarity: Rarity }[] {
    return this.db.prepare('SELECT id, base, rarity FROM gear_items WHERE user_id = ? ORDER BY id').all(userId) as { id: number; base: string; rarity: Rarity }[];
  }

  private gearById(userId: number): Map<number, GearView> {
    const out = new Map<number, GearView>();
    for (const g of this.gearRows(userId)) {
      const v = anyGearView(g.id, g.base, g.rarity);
      if (v) out.set(g.id, v);
    }
    return out;
  }

  private equippedOf(r: CardRow, gear: Map<number, GearView>): Partial<Record<EquipSlot, GearView>> {
    const ids = normalizeEquipped(parseJson<unknown>(r.gear, {}), gear);
    const out: Partial<Record<EquipSlot, GearView>> = {};
    for (const slot of EQUIP_SLOTS) {
      const g = ids[slot] !== undefined ? gear.get(ids[slot]!) : undefined;
      if (g) out[slot] = g;
    }
    return out;
  }

  /** 这张卡正在哪一局（还没结束的）里。 */
  private inRoom(cardId: number): { id: number; name: string } | null {
    return (
      (this.db
        .prepare("SELECT r.id, r.name FROM characters c JOIN rooms r ON r.id = c.room_id WHERE c.card_id = ? AND r.status != 'ended' ORDER BY r.id DESC LIMIT 1")
        .get(cardId) as { id: number; name: string } | undefined) ?? null
    );
  }

  private history(cardId: number): CardHistory[] {
    const rows = this.db
      .prepare('SELECT scenario_title, ending_title, points, result, level, loot, created_at FROM card_history WHERE card_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(cardId) as { scenario_title: string; ending_title: string | null; points: number; result: string | null; level: number | null; loot: string | null; created_at: number }[];
    return rows.map((r) => ({
      title: r.scenario_title,
      level: r.level,
      result: (r.result as CardHistory['result']) ?? null,
      ending: r.ending_title,
      points: r.points,
      loot: parseJson<string[]>(r.loot, []),
      at: r.created_at,
    }));
  }

  private view(r: CardRow, gear: Map<number, GearView>): CardView & { skills: SkillView[] } {
    const attributes = attributesOf(r.attributes);
    const equipped = this.equippedOf(r, gear);
    const bonus = Object.values(equipped).reduce((sum, g) => sum + (g?.bonus ?? 0), 0);
    return {
      id: r.id,
      name: r.name,
      appearance: r.appearance,
      background: r.background,
      attributes,
      specialties: parseJson<string[]>(r.specialties, []),
      points: r.pending,
      spent: r.growth,
      equipped,
      hpMax: maxHp(attributes.constitution),
      mpMax: maxMp(attributes.will),
      defense: characterDefense(attributes.agility),
      power: powerOf(attributes, bonus),
      duel: { wins: r.duel_wins, losses: r.duel_losses },
      onProfile: r.on_profile === 1,
      inRoom: this.inRoom(r.id),
      history: this.history(r.id),
      createdAt: r.created_at,
      skills: parseJson<string[]>(r.skills, [])
        .map((k) => skillView(k))
        .filter((s): s is SkillView => !!s),
    };
  }

  list(userId: number): (CardView & { skills: SkillView[] })[] {
    const gear = this.gearById(userId);
    return (this.db.prepare(`SELECT ${CARD_COLUMNS} FROM character_cards WHERE user_id = ? ORDER BY id`).all(userId) as CardRow[]).map((r) => this.view(r, gear));
  }

  get(userId: number, id: number) {
    return this.view(this.row(userId, id), this.gearById(userId));
  }

  /** 「我的角色」页。 */
  page(userId: number): CardsPage & { manuals: { key: string; name: string; text: string; count: number }[] } {
    const cards = this.list(userId);
    const worn = new Map<number, { cardId: number; name: string; slot: EquipSlot }>();
    for (const c of cards) {
      for (const slot of EQUIP_SLOTS) {
        const g = c.equipped[slot];
        if (g) worn.set(g.id, { cardId: c.id, name: c.name, slot });
      }
    }
    const gear = [...this.gearById(userId).values()].map((g) => ({ ...g, wornBy: worn.get(g.id) ?? null }));
    const at = this.opts.now();
    const duelsToday = (this.db.prepare('SELECT COUNT(*) AS n FROM card_duels WHERE challenger_id = ? AND created_at >= ?').get(userId, dayStart(at)) as { n: number }).n;
    const recent = (this.db.prepare('SELECT result, created_at FROM chest_opens WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(userId) as { result: string; created_at: number }[]).map(
      (r) => {
        const result = parseJson<ChestResult>(r.result, { crystals: 0, item: null, gear: null });
        // V0.7.0 记下的装备没有部位：按现在的定义补上
        const gear = result.gear ? freshGearView(result.gear) : null;
        return { ...result, gear: gear && result.gear ? { ...gear, duplicate: result.gear.duplicate ?? null } : null, at: r.created_at };
      },
    );
    const manuals = (this.db.prepare("SELECT item, count FROM pet_items WHERE user_id = ? AND item LIKE 'manual:%' AND count > 0").all(userId) as { item: string; count: number }[])
      .map((r) => {
        const m = manualView(r.item);
        return m ? { key: m.key, name: m.name, text: m.text, count: r.count } : null;
      })
      .filter((m): m is NonNullable<typeof m> => !!m);
    return {
      cards,
      gear,
      bag: this.bag(userId),
      chests: this.chests(userId),
      recentChests: recent,
      duelsLeft: Math.max(0, DUEL_DAILY - duelsToday),
      crystals: crystalsOf(this.db, userId),
      manuals,
    };
  }

  /** 账号背包里的地下城道具。 */
  bag(userId: number): Partial<Record<ConsumableKey, number>> {
    const out: Partial<Record<ConsumableKey, number>> = {};
    const rows = this.db.prepare('SELECT item, count FROM pet_items WHERE user_id = ? AND count > 0').all(userId) as { item: string; count: number }[];
    for (const r of rows) if ((CONSUMABLE_KEYS as string[]).includes(r.item)) out[r.item as ConsumableKey] = r.count;
    return out;
  }

  chests(userId: number): number {
    return (this.db.prepare("SELECT count FROM pet_items WHERE user_id = ? AND item = 'chest'").get(userId) as { count: number } | undefined)?.count ?? 0;
  }

  /** 已经有的传奇装备（编号）：地下城里不会再掉。 */
  ownedLegendary(userId: number): Set<string> {
    return new Set((this.db.prepare("SELECT base FROM gear_items WHERE user_id = ? AND rarity = 'legendary'").all(userId) as { base: string }[]).map((r) => r.base));
  }

  // ==================== 做卡、改卡 ====================

  private requireFormal(userId: number) {
    const u = this.db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId) as { is_guest: number } | undefined;
    if (!u || u.is_guest === 1) throw new HttpError(403, '游客不能做角色卡');
  }

  /** 属性和两个专长（专长从列表里挑；keep 是卡上本来就有的，不在列表里也照样留着）。 */
  private sheet(o: Record<string, unknown>, keep: readonly string[] = []): { attributes: Attributes2; specialties: string[] } {
    const problem = startAttributesProblem(o.attributes);
    if (problem) throw new HttpError(400, problem);
    const raw = o.attributes as Record<string, number>;
    const attributes = emptyAttributes2();
    for (const k of ATTRIBUTE2_KEYS) attributes[k] = raw[k];
    const list = Array.isArray(o.specialties) ? o.specialties.map(specialtyName) : [];
    if (list.length !== CARD2_SPECIALTY_START) throw new HttpError(400, `要选 ${CARD2_SPECIALTY_START} 个专长`);
    if (new Set(list).size !== list.length) throw new HttpError(400, '两个专长不能一样');
    for (const name of list) listedSpecialty(name, keep);
    return { attributes, specialties: list };
  }

  /** 导入角色卡：保留最终属性、专长和技能；装备/成长点/经历不随文件带过来。 */
  importCard(userId: number, body: Record<string, unknown>) {
    this.requireFormal(userId);
    const name = cleanText(body.name, CARD2_NAME_MAX, '名字', true);
    rejectInvisibleName(name);
    const appearance = cleanText(body.appearance, CARD2_APPEARANCE_MAX, '外貌');
    const background = cleanText(body.background, CARD2_BACKGROUND_MAX, '背景');
    const raw = body.attributes;
    if (!raw || typeof raw !== 'object') throw new HttpError(400, '角色卡里没有属性');
    const attributes = emptyAttributes2();
    const o = raw as Record<string, unknown>;
    for (const k of ATTRIBUTE2_KEYS) {
      const v = o[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < ROLE2_MIN || v > ROLE2_MAX) {
        throw new HttpError(400, `${ATTRIBUTE2_NAME[k]}的数值不对`);
      }
      attributes[k] = v;
    }
    const specialties = Array.isArray(body.specialties) ? body.specialties.map(specialtyName) : [];
    if (specialties.length > CARD2_SPECIALTY_MAX) throw new HttpError(400, `专长最多 ${CARD2_SPECIALTY_MAX} 个`);
    if (new Set(specialties).size !== specialties.length) throw new HttpError(400, '专长不能重复');
    for (const name of specialties) listedSpecialty(name);
    const skills = Array.isArray(body.skills)
      ? body.skills.map((x) => String(x)).filter((x) => !!skillOf(x)).slice(0, SKILL_MAX)
      : [];
    const at = this.opts.now();
    return transaction(this.db, () => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM character_cards WHERE user_id = ?').get(userId) as { n: number }).n;
      if (n >= CARD2_MAX) throw new HttpError(409, `最多 ${CARD2_MAX} 张角色卡`);
      if (this.db.prepare('SELECT 1 FROM character_cards WHERE user_id = ? AND name = ?').get(userId, name)) {
        throw new HttpError(409, '已经有一张同名的卡了');
      }
      const result = this.db
        .prepare(
          `INSERT INTO character_cards (user_id, name, appearance, background, attributes, specialties, gear, growth, pending, skills, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 0, ?, ?, ?)`,
        )
        .run(userId, name, appearance, background, JSON.stringify(attributes), JSON.stringify(specialties), JSON.stringify(skills), at, at);
      return this.get(userId, Number(result.lastInsertRowid));
    });
  }

  create(userId: number, body: Record<string, unknown>) {
    this.requireFormal(userId);
    const name = cleanText(body.name, CARD2_NAME_MAX, '名字', true);
    // 角色卡的名字别人看得到、会带进地下城：看不见的字符不要（V0.8.0 安全审查）
    rejectInvisibleName(name);
    const appearance = cleanText(body.appearance, CARD2_APPEARANCE_MAX, '外貌');
    const background = cleanText(body.background, CARD2_BACKGROUND_MAX, '背景');
    const { attributes, specialties } = this.sheet(body);
    const at = this.opts.now();
    const id = transaction(this.db, () => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM character_cards WHERE user_id = ?').get(userId) as { n: number }).n;
      if (n >= CARD2_MAX) throw new HttpError(409, `最多 ${CARD2_MAX} 张角色卡`);
      if (this.db.prepare('SELECT 1 FROM character_cards WHERE user_id = ? AND name = ?').get(userId, name)) throw new HttpError(409, '已经有一张同名的卡了');
      const result = this.db
        .prepare(
          `INSERT INTO character_cards (user_id, name, appearance, background, attributes, specialties, gear, growth, pending, skills, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 0, '[]', ?, ?)`,
        )
        .run(userId, name, appearance, background, JSON.stringify(attributes), JSON.stringify(specialties), at, at);
      const cardId = Number(result.lastInsertRowid);
      // 新手礼：第一张卡送三件普通装备，直接穿上（主手、胸部、颈部）
      if (n === 0 && !this.gearRows(userId).length) {
        const equipped: Equipped = {};
        for (const base of STARTER_GEAR) {
          const r = this.db.prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, 'common', 'starter', ?)").run(userId, base, at);
          const slot = slotsForPart(gearBaseOf(base)!.part).find((s) => equipped[s] === undefined)!;
          equipped[slot] = Number(r.lastInsertRowid);
        }
        this.db.prepare('UPDATE character_cards SET gear = ? WHERE id = ?').run(JSON.stringify(equipped), cardId);
      }
      return cardId;
    });
    return this.get(userId, id);
  }

  /** 改名字、外貌、背景、在不在个人主页上展示；还没打过地下城、没用过成长点的卡还能重新分属性、换专长。 */
  update(userId: number, id: number, body: Record<string, unknown>) {
    const r = this.row(userId, id);
    if (body.onProfile !== undefined && typeof body.onProfile !== 'boolean') throw new HttpError(400, '请求格式不对');
    const onProfile = body.onProfile === undefined ? r.on_profile : body.onProfile ? 1 : 0;
    const name = body.name === undefined ? r.name : cleanText(body.name, CARD2_NAME_MAX, '名字', true);
    // 改了名字才查看不见的字符；没改的（以前存的）照旧
    if (name !== r.name) rejectInvisibleName(name);
    const appearance = body.appearance === undefined ? r.appearance : cleanText(body.appearance, CARD2_APPEARANCE_MAX, '外貌');
    const background = body.background === undefined ? r.background : cleanText(body.background, CARD2_BACKGROUND_MAX, '背景');
    let attributes = r.attributes;
    let specialties = r.specialties;
    if (body.attributes !== undefined || body.specialties !== undefined) {
      const used = r.growth > 0 || !!this.db.prepare('SELECT 1 FROM card_history WHERE card_id = ?').get(id) || !!this.inRoom(id);
      if (used) throw new HttpError(409, '这张卡已经打过地下城了，属性和专长不能重新分配（用成长点加）');
      const had = parseJson<string[]>(r.specialties, []);
      const sheet = this.sheet({ attributes: body.attributes ?? attributesOf(r.attributes), specialties: body.specialties ?? had }, had);
      attributes = JSON.stringify(sheet.attributes);
      specialties = JSON.stringify(sheet.specialties);
    }
    if (name !== r.name && this.db.prepare('SELECT 1 FROM character_cards WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, id)) {
      throw new HttpError(409, '已经有一张同名的卡了');
    }
    this.db
      .prepare('UPDATE character_cards SET name = ?, appearance = ?, background = ?, attributes = ?, specialties = ?, on_profile = ?, updated_at = ? WHERE id = ?')
      .run(name, appearance, background, attributes, specialties, onProfile, this.opts.now(), id);
    return this.get(userId, id);
  }

  remove(userId: number, id: number) {
    this.row(userId, id);
    if (this.inRoom(id)) throw new HttpError(409, '这张卡正在一局地下城里，打完以后才能删');
    this.db.prepare('DELETE FROM character_cards WHERE id = ?').run(id);
  }

  /** 用成长点：一项属性 +1（越高越贵），或者学一个新专长。 */
  grow(userId: number, id: number, growth: CardGrowth) {
    transaction(this.db, () => {
      const r = this.row(userId, id);
      if (growth.type === 'attribute') {
        if (!ATTRIBUTE2_KEYS.includes(growth.key)) throw new HttpError(400, '没有这项属性');
        const attributes = attributesOf(r.attributes);
        const cost = raiseCost(attributes[growth.key]);
        if (r.pending < cost) throw new HttpError(409, `${ATTRIBUTE2_NAME[growth.key]}加到 ${attributes[growth.key] + 1} 要 ${cost} 点成长点，现在只有 ${r.pending} 点`);
        attributes[growth.key] += 1;
        this.db
          .prepare('UPDATE character_cards SET attributes = ?, pending = pending - ?, growth = growth + ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(attributes), cost, cost, this.opts.now(), id);
        if (attributes[growth.key] >= 10) this.achievements?.unlock(userId, 'peak');
      } else {
        const name = specialtyName(growth.name);
        const list = parseJson<string[]>(r.specialties, []);
        if (list.includes(name)) throw new HttpError(409, '已经有这个专长了');
        listedSpecialty(name);
        if (list.length >= CARD2_SPECIALTY_MAX) throw new HttpError(409, `专长最多 ${CARD2_SPECIALTY_MAX} 个`);
        if (r.pending < CARD2_SPECIALTY_COST) throw new HttpError(409, `学新专长要 ${CARD2_SPECIALTY_COST} 点成长点，现在只有 ${r.pending} 点`);
        this.db
          .prepare('UPDATE character_cards SET specialties = ?, pending = pending - ?, growth = growth + ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify([...list, name]), CARD2_SPECIALTY_COST, CARD2_SPECIALTY_COST, this.opts.now(), id);
      }
    });
    return this.get(userId, id);
  }

  /**
   * 穿上（或脱下：gearId 为 null）一个格子的装备：装备只能放进它那个部位的格子（戒指、饰品两个格子都行）。
   * 一件装备同时只能穿在一个地方：穿到这里，这张卡别的格子上的、别的卡上的就脱下来。存成十六个格子的新样子。
   */
  equip(userId: number, id: number, slot: EquipSlot, gearId: number | null) {
    if (!EQUIP_SLOTS.includes(slot)) throw new HttpError(400, '没有这个格子');
    transaction(this.db, () => {
      const r = this.row(userId, id);
      const gear = this.gearById(userId);
      const equipped = normalizeEquipped(parseJson<unknown>(r.gear, {}), gear);
      if (gearId === null) {
        delete equipped[slot];
      } else {
        const g = gear.get(gearId);
        if (!g) throw new HttpError(404, '你没有这件装备');
        if (!slotsForPart(g.part).includes(slot)) throw new HttpError(400, `${g.name}是${GEAR_PART_LABEL[g.part]}的装备，放不进${EQUIP_SLOT_LABEL[slot]}`);
        for (const s of EQUIP_SLOTS) if (equipped[s] === gearId) delete equipped[s];
        for (const other of this.db.prepare('SELECT id, gear FROM character_cards WHERE user_id = ? AND id != ?').all(userId, id) as { id: number; gear: string }[]) {
          const eq = normalizeEquipped(parseJson<unknown>(other.gear, {}), gear);
          const at = EQUIP_SLOTS.filter((s) => eq[s] === gearId);
          if (!at.length) continue;
          for (const s of at) delete eq[s];
          this.db.prepare('UPDATE character_cards SET gear = ? WHERE id = ?').run(JSON.stringify(eq), other.id);
        }
        equipped[slot] = gearId;
      }
      this.db.prepare('UPDATE character_cards SET gear = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(equipped), this.opts.now(), id);
    });
    return this.get(userId, id);
  }

  /** 研读秘籍：用掉背包里的一本，这张卡学会这门技能。 */
  learn(userId: number, id: number, manualKey: string) {
    const manual = manualView(manualKey);
    if (!manual) throw new HttpError(400, '没有这本秘籍');
    transaction(this.db, () => {
      const r = this.row(userId, id);
      const skills = parseJson<string[]>(r.skills, []);
      if (skills.includes(manual.skill)) throw new HttpError(409, `${r.name}已经会「${skillOf(manual.skill)?.name}」了`);
      if (skills.length >= SKILL_MAX) throw new HttpError(409, `一张卡最多学 ${SKILL_MAX} 门技能`);
      const n = this.db.prepare('UPDATE pet_items SET count = count - 1 WHERE user_id = ? AND item = ? AND count > 0').run(userId, manualKey).changes;
      if (!n) throw new HttpError(409, '背包里没有这本秘籍了');
      this.db.prepare('UPDATE character_cards SET skills = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...skills, manual.skill]), this.opts.now(), id);
      if (skills.length + 1 >= 3) this.achievements?.unlock(userId, 'skills-3');
    });
    return this.get(userId, id);
  }

  // ==================== 装备、道具 ====================

  /** 得到一件装备：已经有同一件的，折成龙晶（返回折了多少）。要在事务里调用。 */
  addGear(userId: number, base: string, rarity: Rarity, source: string, at: number): { view: GearView; duplicate: number | null } {
    const view = anyGearView(0, base, rarity);
    if (!view) throw new Error(`不认识的装备：${base} ${rarity}`);
    const existing = this.db.prepare('SELECT id FROM gear_items WHERE user_id = ? AND base = ? AND rarity = ?').get(userId, base, rarity) as { id: number } | undefined;
    if (existing) {
      const crystals = DUPLICATE_CRYSTALS[rarity];
      addCrystals(this.db, userId, crystals, 'chest', `${view.name}（${RARITY_LABEL[rarity]}）已经有了，折成 ${crystals} 龙晶`, null, at);
      return { view: { ...view, id: existing.id }, duplicate: crystals };
    }
    const r = this.db.prepare('INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, base, rarity, source, at);
    if (rarity === 'legendary') {
      this.opts.social.notify(userId, 'legendary', { gear: base, name: view.name, title: source });
      this.achievements?.unlock(userId, 'legend');
      if (this.ownedLegendary(userId).size >= 4) this.achievements?.unlock(userId, 'legend-all');
    }
    return { view: { ...view, id: Number(r.lastInsertRowid) }, duplicate: null };
  }

  /** 背包里加道具（地下城道具、秘籍、宝箱都记在 pet_items）。要在事务里调用。 */
  addItem(userId: number, item: string, count: number) {
    this.db
      .prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, ?) ON CONFLICT (user_id, item) DO UPDATE SET count = MIN(?, count + excluded.count)')
      .run(userId, item, Math.min(count, ITEM_STACK_MAX), ITEM_STACK_MAX);
  }

  /** 商城：买一件普通装备（价格可能被管理员改过，由商城传进来）。 */
  buyCommonGear(userId: number, base: string, price = COMMON_GEAR_PRICE) {
    this.requireFormal(userId);
    if (!gearView(0, base, 'common')) throw new HttpError(404, '没有这件装备');
    const at = this.opts.now();
    transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM gear_items WHERE user_id = ? AND base = ? AND rarity = 'common'").get(userId, base)) throw new HttpError(409, '已经有这件装备了');
      addCrystals(this.db, userId, -price, 'buy', `装备「${gearView(0, base, 'common')!.name}」`, null, at);
      this.db.prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, 'common', 'shop', ?)").run(userId, base, at);
    });
  }

  /** 结算里用掉的道具：从账号背包里扣（扣到 0 为止）。要在事务里调用。 */
  consumeItems(uses: ItemUse[], userOf: (characterId: number) => number | null) {
    for (const u of uses) {
      const userId = userOf(u.characterId);
      if (userId === null) continue;
      this.db.prepare('UPDATE pet_items SET count = MAX(0, count - 1) WHERE user_id = ? AND item = ?').run(userId, u.item);
    }
  }

  // ==================== 宝箱 ====================

  /** 开一个宝箱：龙晶（按打过的最高难度），再加道具或者装备（稀有度按难度）。 */
  openChest(userId: number): ChestResult {
    const at = this.opts.now();
    return transaction(this.db, () => {
      const n = this.db.prepare("UPDATE pet_items SET count = count - 1 WHERE user_id = ? AND item = 'chest' AND count > 0").run(userId).changes;
      if (!n) throw new HttpError(409, '没有宝箱了');
      const level = this.bestLevel(userId);
      const [lo, hi] = CHEST2.crystalsBase;
      const crystals = (lo + this.rand(hi - lo + 1)) * level;
      let item: ChestResult['item'] = null;
      let gear: ChestResult['gear'] = null;
      if (this.rand(100) < CHEST2.odds.item) {
        const key = CONSUMABLE_KEYS[this.rand(CONSUMABLE_KEYS.length)];
        const count = 1 + this.rand(2);
        this.addItem(userId, key, count);
        item = { key, name: consumableOf(key)!.name, count };
      } else {
        const base = GEAR_BASES[this.rand(GEAR_BASES.length)];
        const rarity = this.rollRarity(level);
        const got = this.addGear(userId, base.key, rarity, 'chest', at);
        gear = { ...got.view, duplicate: got.duplicate };
      }
      addCrystals(this.db, userId, crystals, 'chest', '开宝箱', null, at);
      const result: ChestResult = { crystals, item, gear };
      this.db.prepare('INSERT INTO chest_opens (user_id, result, created_at) VALUES (?, ?, ?)').run(userId, JSON.stringify(result), at);
      return result;
    });
  }

  private rollRarity(level: number): Exclude<Rarity, 'legendary'> {
    const odds = rarityOdds(level);
    let roll = this.rand(100);
    for (const k of ['common', 'fine', 'rare', 'epic'] as const) {
      if (roll < odds[k]) return k;
      roll -= odds[k];
    }
    return 'common';
  }

  /** 这个账号通关过的最高难度（没有是 1）：宝箱按它开。 */
  private bestLevel(userId: number): number {
    const row = this.db
      .prepare("SELECT MAX(h.level) AS level FROM card_history h JOIN character_cards c ON c.id = h.card_id WHERE c.user_id = ? AND h.result = 'clear'")
      .get(userId) as { level: number | null };
    return Math.max(1, row.level ?? 1);
  }

  // ==================== 进地下城 ====================

  /**
   * 这个账号的角色带进别的、还没结束的地下城，还没用掉的道具。道具用掉时才从账号里扣，
   * 没用掉的还占着：同一份道具不能同时带进两个地下城。
   */
  private packedElsewhere(userId: number, roomId: number): Partial<Record<ConsumableKey, number>> {
    const rows = this.db
      .prepare(
        `SELECT c.v2 FROM characters c JOIN players p ON p.id = c.player_id JOIN rooms r ON r.id = c.room_id
         WHERE p.user_id = ? AND c.room_id != ? AND c.card_id IS NOT NULL AND c.v2 IS NOT NULL AND r.status != 'ended'`,
      )
      .all(userId, roomId) as { v2: string }[];
    const out: Partial<Record<ConsumableKey, number>> = {};
    for (const r of rows) {
      const bag = parseJson<{ bag?: Record<string, number> }>(r.v2, {}).bag ?? {};
      for (const [k, n] of Object.entries(bag)) {
        if ((CONSUMABLE_KEYS as string[]).includes(k) && Number.isInteger(n) && n > 0) out[k as ConsumableKey] = (out[k as ConsumableKey] ?? 0) + n;
      }
    }
    return out;
  }

  /**
   * 带一张卡进地下城：检查卡是自己的、没在别的地下城里，带的道具不超过背包里有的、一共不超过 BAG_MAX 个。
   * 返回建角色要用的东西（属性、装备、技能是这一刻的样子，之后在卡上改不影响这一局）。
   */
  entry(userId: number, cardId: number, roomId: number, rawBag: unknown): DungeonEntry {
    const r = this.row(userId, cardId);
    const busy = this.inRoom(cardId);
    if (busy && busy.id !== roomId) throw new HttpError(409, `这张卡正在「${busy.name}」里，打完那一局才能带进别的地下城`);
    const owned = this.bag(userId);
    const held = this.packedElsewhere(userId, roomId);
    const bag: Partial<Record<ConsumableKey, number>> = {};
    let total = 0;
    const o = rawBag && typeof rawBag === 'object' ? (rawBag as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(o)) {
      if (!(CONSUMABLE_KEYS as string[]).includes(k)) throw new HttpError(400, `没有这种道具：${k}`);
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '道具的个数不对');
      if (!n) continue;
      const away = held[k as ConsumableKey] ?? 0;
      const free = Math.max(0, (owned[k as ConsumableKey] ?? 0) - away);
      if (n > free) {
        throw new HttpError(409, away ? `背包里的${consumableOf(k)!.name}有 ${away} 个带进了别的地下城，只剩 ${free} 个能带` : `背包里的${consumableOf(k)!.name}不够 ${n} 个`);
      }
      bag[k as ConsumableKey] = n;
      total += n;
    }
    if (total > BAG_MAX) throw new HttpError(400, `一共最多带 ${BAG_MAX} 个道具`);
    const view = this.view(r, this.gearById(userId));
    return {
      cardId,
      name: r.name,
      appearance: r.appearance,
      background: r.background,
      attributes: view.attributes,
      specialties: view.specialties,
      gear: Object.values(view.equipped).filter((g): g is GearView => !!g),
      skills: view.skills.map((s) => s.key),
      bag,
    };
  }

  // ==================== 地下城结束 ====================

  /** 一局走到了结局：是地下城的话按结局结算（不是地下城、没有结局的什么都不做）。 */
  afterRoom(roomId: number): DungeonSettlement[] {
    const stored = loadScenario(this.db, roomId);
    const room = this.db.prepare('SELECT world FROM rooms WHERE id = ?').get(roomId) as { world: string } | undefined;
    // 只有这个版本自带的地下城算成绩：上传的、投稿的、导入的、AI 写的，难度和宝物是写剧本的人定的
    if (!stored?.scenario.dungeon || !room || !rankedDungeon(stored)) return [];
    const ending = parseWorld(room.world).ending;
    return this.afterDungeon(roomId, stored.scenario, ending ? { key: ending.key, title: ending.title } : null);
  }

  /**
   * 地下城走到了结局：每个带卡进来的人按结局算——通关给全部成长点、宝箱，逃出来成长点减半，失败、死了什么都没有；
   * 活着（失败的除外）才能把这一局捡到的东西带走。一局只算一次。返回每个人的结算（通知、测试用）。
   */
  afterDungeon(roomId: number, scenario: Scenario, ending: { key: string; title: string } | null): DungeonSettlement[] {
    const d = scenario.dungeon;
    if (!d || !ending) return [];
    const room = this.db.prepare('SELECT created_at, game_clock, world FROM rooms WHERE id = ?').get(roomId) as
      | { created_at: number; game_clock: number | null; world: string }
      | undefined;
    if (!room) return [];
    const result: DungeonResult = scenario.endings.find((e) => e.key === ending.key)?.result ?? 'fail';
    // 「逃出来」只算真的闯过的：打过至少一场、或者捡到过东西。一进门就退出去不给成长点
    const world = parseWorld(room.world);
    const ventured = Object.keys(world.encountered).length > 0 || Object.keys(world.lootTaken).length > 0;
    const at = this.opts.now();
    const rows = this.db
      .prepare(
        `SELECT c.id, c.card_id, c.dead, c.v2, c.name, p.user_id,
           (SELECT COUNT(*) FROM actions a WHERE a.character_id = c.id AND a.status = 'done') AS done
         FROM characters c JOIN players p ON p.id = c.player_id JOIN users u ON u.id = p.user_id
         WHERE c.room_id = ? AND c.card_id IS NOT NULL AND u.is_guest = 0 AND u.deleted_at IS NULL`,
      )
      .all(roomId) as { id: number; card_id: number; dead: number; v2: string | null; name: string; user_id: number; done: number }[];
    const out: DungeonSettlement[] = [];
    const members: { userId: number; cardId: number; name: string }[] = [];
    for (const row of rows) {
      // 和玩完剧本得龙晶一样：自己交过至少几个行动才算
      if (row.done < GAME_MIN_ACTIONS) continue;
      members.push({ userId: row.user_id, cardId: row.card_id, name: row.name });
      const dead = row.dead === 1;
      const mine: DungeonResult | 'dead' = dead ? 'dead' : result;
      const points = dead || (result === 'escape' && !ventured) ? 0 : growthPoints(d.level, d.size, result);
      const chests = dead ? 0 : chestsFor(d.size, result);
      const keep = !dead && result !== 'fail';
      const loot = keep ? (parseJson<{ loot?: LootItem[] }>(row.v2, {}).loot ?? []) : [];
      const settled = transaction(this.db, () => {
        const card = this.db.prepare('SELECT id, user_id, name FROM character_cards WHERE id = ?').get(row.card_id) as { id: number; user_id: number; name: string } | undefined;
        if (!card || card.user_id !== row.user_id) return null;
        const labels: string[] = [];
        let crystals = 0;
        // 先占住这一局的经历（一局只算一次）
        const inserted = this.db
          .prepare(
            `INSERT INTO card_history (card_id, room_id, room_created_at, scenario_title, ending_title, points, scenario_key, result, level, loot, created_at)
             VALUES (?, ?, ?, ?, ?, ?, (SELECT scenario_key FROM scenarios WHERE room_id = ?), ?, ?, '[]', ?) ON CONFLICT DO NOTHING`,
          )
          .run(card.id, roomId, room.created_at, scenario.title, ending.title, points, roomId, mine, d.level, at).changes;
        if (!inserted) return null;
        for (const item of loot) {
          if (item.kind === 'gear') {
            const got = this.addGear(row.user_id, item.base, item.rarity, scenario.title, at);
            labels.push(`${got.view.name}（${RARITY_LABEL[item.rarity]}）${got.duplicate ? `→ ${got.duplicate} 龙晶` : ''}`);
            crystals += got.duplicate ?? 0;
          } else if (item.kind === 'item') {
            this.addItem(row.user_id, item.item, item.count);
            labels.push(`${consumableOf(item.item)?.name ?? item.item}×${item.count}`);
          } else if (item.kind === 'manual') {
            this.addItem(row.user_id, `${MANUAL_PREFIX}${item.skill}`, 1);
            labels.push(`秘籍《${skillOf(item.skill)?.name ?? item.skill}》`);
          } else if (item.kind === 'crystals') {
            addCrystals(this.db, row.user_id, item.amount, 'game', `从《${scenario.title}》带出来的龙晶`, null, at);
            labels.push(`${item.amount} 龙晶`);
            crystals += item.amount;
          }
        }
        if (chests) this.addItem(row.user_id, 'chest', chests);
        if (points) this.db.prepare('UPDATE character_cards SET pending = pending + ? WHERE id = ?').run(points, card.id);
        this.db.prepare('UPDATE card_history SET loot = ? WHERE card_id = ? AND room_id = ? AND room_created_at = ?').run(JSON.stringify(labels), card.id, roomId, room.created_at);
        return { cardId: card.id, cardName: card.name, labels, crystals };
      });
      if (!settled) continue;
      const s: DungeonSettlement = {
        cardId: settled.cardId,
        cardName: settled.cardName,
        title: scenario.title,
        level: d.level,
        size: d.size,
        result: mine,
        points,
        chests,
        loot: settled.labels,
        crystals: settled.crystals,
      };
      out.push(s);
      this.opts.social.notify(row.user_id, 'card_growth', {
        card: s.cardName,
        cardId: s.cardId,
        title: s.title,
        points: s.points,
        result: s.result,
        resultLabel: s.result === 'dead' ? '死在了里面' : RESULT_LABEL[s.result],
        chests: s.chests,
        loot: s.loot,
      });
      if (mine === 'clear') {
        this.achievements?.unlock(row.user_id, 'first-clear');
        if (d.size === 'large') this.achievements?.unlock(row.user_id, 'large-clear');
      }
    }
    if (members.length) {
      this.db
        .prepare(
          `INSERT INTO dungeon_runs (room_id, room_created_at, scenario_key, scenario_title, level, size, result, players, members, real_minutes, game_minutes, created_at)
           VALUES (?, ?, (SELECT scenario_key FROM scenarios WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          roomId,
          room.created_at,
          roomId,
          scenario.title,
          d.level,
          d.size,
          result,
          members.length,
          JSON.stringify(members),
          Math.round((at - room.created_at) / 60_000),
          Math.max(0, Math.round(room.game_clock ?? 0)),
          at,
        );
    }
    return out;
  }

  /** 一个地下城的通关记录（最近的、最快的）。 */
  clearRecords(scenarioKey: string): { recent: { title: string; players: string[]; at: number; realMinutes: number }[]; fastest: { players: string[]; realMinutes: number; at: number } | null } {
    const rows = this.db
      .prepare("SELECT members, real_minutes, created_at, scenario_title FROM dungeon_runs WHERE scenario_key = ? AND result = 'clear' ORDER BY created_at DESC LIMIT 50")
      .all(scenarioKey) as { members: string; real_minutes: number; created_at: number; scenario_title: string }[];
    const names = (m: string) => parseJson<{ name: string }[]>(m, []).map((x) => x.name);
    const recent = rows.slice(0, 5).map((r) => ({ title: r.scenario_title, players: names(r.members), at: r.created_at, realMinutes: r.real_minutes }));
    const best = [...rows].sort((a, b) => a.real_minutes - b.real_minutes)[0];
    return { recent, fastest: best ? { players: names(best.members), realMinutes: best.real_minutes, at: best.created_at } : null };
  }

  // ==================== 切磋 ====================

  private publicOf(r: CardRow, gear: Map<number, GearView>): PublicCard {
    const v = this.view(r, gear);
    const clears = (this.db.prepare("SELECT COUNT(*) AS n FROM card_history WHERE card_id = ? AND result = 'clear'").get(r.id) as { n: number }).n;
    return {
      id: v.id,
      name: v.name,
      appearance: v.appearance,
      attributes: v.attributes,
      specialties: v.specialties,
      equipped: v.equipped,
      hpMax: v.hpMax,
      mpMax: v.mpMax,
      defense: v.defense,
      power: v.power,
      duel: v.duel,
      skills: v.skills.map((k) => ({ name: k.name, text: k.text })),
      clears,
    };
  }

  /** 一个人在个人主页上展示的角色卡（V0.8.1：主人选了不展示的不算）。 */
  publicCards(userId: number): PublicCard[] {
    const gear = this.gearById(userId);
    return (this.db.prepare(`SELECT ${CARD_COLUMNS} FROM character_cards WHERE user_id = ? AND on_profile = 1 ORDER BY id`).all(userId) as CardRow[]).map((r) => this.publicOf(r, gear));
  }

  /** 切磋一轮里某一项属性的加值：属性 + 对应的装备（主手武器加它那一项、护甲的减伤加体质、这一项检定加得最多的那件）。 */
  private duelBonus(attributes: Attributes2, equipped: Partial<Record<EquipSlot, GearView>>, attribute: Attribute2): number {
    const t = gearTotals(Object.values(equipped).filter((g): g is GearView => !!g));
    let bonus = attributes[attribute];
    if (t.weapon && t.weapon.attribute === attribute) bonus += t.weapon.bonus;
    if (attribute === 'constitution') bonus += t.reduction;
    bonus += t.checks[attribute]?.bonus ?? 0;
    return bonus;
  }

  duel(userId: number, myCardId: number, opponentCardId: number): DuelView {
    this.requireFormal(userId);
    const at = this.opts.now();
    const mine = this.row(userId, myCardId);
    const theirs = this.db.prepare(`SELECT ${CARD_COLUMNS} FROM character_cards WHERE id = ?`).get(opponentCardId) as CardRow | undefined;
    if (!theirs) throw new HttpError(404, '没有这张角色卡');
    if (theirs.user_id === userId) throw new HttpError(400, '不能和自己的卡切磋');
    const defender = this.db.prepare('SELECT id, display_name, public_id, is_guest, banned_at, deleted_at FROM users WHERE id = ?').get(theirs.user_id) as
      | { id: number; display_name: string; public_id: string; is_guest: number; banned_at: number | null; deleted_at: number | null }
      | undefined;
    if (!defender || defender.deleted_at || defender.is_guest) throw new HttpError(404, '没有这张角色卡');
    if (this.opts.social.blockedEither(userId, theirs.user_id)) throw new HttpError(403, '你们之间有屏蔽，不能切磋');
    const me = this.db.prepare('SELECT display_name, public_id FROM users WHERE id = ?').get(userId) as { display_name: string; public_id: string };
    const today = dayStart(at);
    const used = (this.db.prepare('SELECT COUNT(*) AS n FROM card_duels WHERE challenger_id = ? AND created_at >= ?').get(userId, today) as { n: number }).n;
    if (used >= DUEL_DAILY) throw new HttpError(429, `今天已经切磋了 ${DUEL_DAILY} 次，明天再来`);

    const a = this.view(mine, this.gearById(userId));
    const b = this.view(theirs, this.gearById(theirs.user_id));
    // 宠物：输掉的那一轮帮着重掷一次（每场每边一次）
    const petOf = (uid: number) => {
      const p = this.db.prepare('SELECT name FROM pets WHERE user_id = ?').get(uid) as { name: string } | undefined;
      return p ? { name: p.name, attributes: petGrowth(this.db, uid), used: false } : null;
    };
    const pets = { a: petOf(userId), b: petOf(theirs.user_id) };
    const rounds: DuelRound[] = [];
    const pool = [...ATTRIBUTE2_KEYS];
    const roll = () => [this.d6(), this.d6()] as [number, number];
    let wins = { a: 0, b: 0 };
    let sums = { a: 0, b: 0 };
    for (let i = 0; i < 6 && (i < DUEL_ROUNDS || wins.a === wins.b); i++) {
      const attribute = pool.length ? pool.splice(this.rand(pool.length), 1)[0] : ATTRIBUTE2_KEYS[this.rand(ATTRIBUTE2_KEYS.length)];
      const side = (v: typeof a) => {
        const dice = roll();
        const bonus = this.duelBonus(v.attributes, v.equipped, attribute);
        return { dice, bonus, total: dice[0] + dice[1] + bonus } as DuelRound['a'];
      };
      const ra = side(a);
      const rb = side(b);
      for (const [key, r, other] of [
        ['a', ra, rb],
        ['b', rb, ra],
      ] as const) {
        const pet = pets[key];
        if (pet && !pet.used && r.total < other.total) {
          pet.used = true;
          const first = r.total;
          const dice = roll();
          const help = petHelpBonus(pet.attributes[PET_ATTRIBUTE_FOR[attribute]] ?? 0);
          r.dice = dice;
          r.total = dice[0] + dice[1] + r.bonus + help;
          r.bonus += help;
          r.pet = { name: pet.name, first };
        }
      }
      const winner: DuelRound['winner'] = ra.total > rb.total ? 'a' : rb.total > ra.total ? 'b' : 'tie';
      if (winner !== 'tie') wins[winner]++;
      sums = { a: sums.a + ra.total, b: sums.b + rb.total };
      rounds.push({ attribute, a: ra, b: rb, winner });
      if (i >= DUEL_ROUNDS - 1 && wins.a !== wins.b) break;
    }
    const winner: 'a' | 'b' = wins.a > wins.b ? 'a' : wins.b > wins.a ? 'b' : sums.a > sums.b ? 'a' : 'b';
    const id = transaction(this.db, () => {
      let challengerReward = 0;
      let defenderReward = 0;
      if (winner === 'a') {
        challengerReward = DUEL_REWARD;
        addCrystals(this.db, userId, DUEL_REWARD, 'duel', `切磋赢了${defender.display_name}的「${theirs.name}」`, null, at);
      } else {
        const defended = (
          this.db.prepare("SELECT COUNT(*) AS n FROM card_duels WHERE defender_id = ? AND winner = 'defender' AND defender_reward > 0 AND created_at >= ?").get(theirs.user_id, today) as { n: number }
        ).n;
        if (defended < DUEL_DEFENSE_REWARDS_DAILY && !defender.banned_at) {
          defenderReward = DUEL_REWARD;
          addCrystals(this.db, theirs.user_id, DUEL_REWARD, 'duel', `「${theirs.name}」切磋赢了${me.display_name}`, null, at);
        }
      }
      this.db.prepare(`UPDATE character_cards SET ${winner === 'a' ? 'duel_wins = duel_wins + 1' : 'duel_losses = duel_losses + 1'} WHERE id = ?`).run(mine.id);
      this.db.prepare(`UPDATE character_cards SET ${winner === 'b' ? 'duel_wins = duel_wins + 1' : 'duel_losses = duel_losses + 1'} WHERE id = ?`).run(theirs.id);
      const r = this.db
        .prepare(
          `INSERT INTO card_duels (challenger_id, challenger_card, defender_id, defender_card, winner, detail, challenger_reward, defender_reward, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, mine.id, theirs.user_id, theirs.id, winner === 'a' ? 'challenger' : 'defender', JSON.stringify({ a: mine.name, b: theirs.name, rounds }), challengerReward, defenderReward, at);
      return Number(r.lastInsertRowid);
    });
    this.opts.social.notify(theirs.user_id, 'duel', { from: me.display_name, card: theirs.name, won: winner === 'b' });
    const wins10 = (this.db.prepare('SELECT duel_wins FROM character_cards WHERE id = ?').get(winner === 'a' ? mine.id : theirs.id) as { duel_wins: number }).duel_wins;
    if (wins10 >= 10) this.achievements?.unlock(winner === 'a' ? userId : theirs.user_id, 'duel-10');
    return this.duelView(id, userId)!;
  }

  private duelView(id: number, viewerId: number): DuelView | null {
    const r = this.db
      .prepare(
        `SELECT d.*, ua.display_name AS a_name, ua.public_id AS a_pid, ub.display_name AS b_name, ub.public_id AS b_pid
         FROM card_duels d JOIN users ua ON ua.id = d.challenger_id JOIN users ub ON ub.id = d.defender_id WHERE d.id = ?`,
      )
      .get(id) as
      | { id: number; challenger_id: number; defender_id: number; winner: string; detail: string; challenger_reward: number; defender_reward: number; created_at: number; a_name: string; a_pid: string; b_name: string; b_pid: string }
      | undefined;
    if (!r) return null;
    const detail = parseJson<{ a: string; b: string; rounds: DuelRound[] }>(r.detail, { a: '', b: '', rounds: [] });
    return {
      id: r.id,
      a: { publicId: r.a_pid, displayName: r.a_name, card: detail.a },
      b: { publicId: r.b_pid, displayName: r.b_name, card: detail.b },
      rounds: detail.rounds,
      winner: r.winner === 'challenger' ? 'a' : 'b',
      myReward: viewerId === r.challenger_id ? r.challenger_reward : viewerId === r.defender_id ? r.defender_reward : 0,
      at: r.created_at,
    };
  }

  /** 自己最近的切磋（挑战别人的、被挑战的）。 */
  recentDuels(userId: number): DuelView[] {
    const ids = this.db
      .prepare('SELECT id FROM card_duels WHERE challenger_id = ? OR defender_id = ? ORDER BY id DESC LIMIT 20')
      .all(userId, userId) as { id: number }[];
    return ids.map((r) => this.duelView(r.id, userId)).filter((v): v is DuelView => !!v);
  }

  // ==================== 排行 ====================

  rankings(viewerId: number): CardRankings {
    const rows = this.db
      .prepare(
        `SELECT c.*, u.public_id, u.display_name, u.avatar_at, u.avatar_frame,
           (SELECT COUNT(*) FROM card_history h WHERE h.card_id = c.id AND h.result = 'clear') AS clears
         FROM character_cards c JOIN users u ON u.id = c.user_id
         WHERE u.deleted_at IS NULL AND u.is_guest = 0 AND u.banned_at IS NULL`,
      )
      .all() as (CardRow & { public_id: string; display_name: string; avatar_at: number | null; avatar_frame: string | null; clears: number })[];
    // 有卡的人的装备一次查完（装备编号是全站唯一的，卡上记的都是卡主自己的装备）
    const allGear = new Map<number, GearView>();
    for (const g of this.db.prepare('SELECT id, base, rarity FROM gear_items WHERE user_id IN (SELECT DISTINCT user_id FROM character_cards)').all() as { id: number; base: string; rarity: Rarity }[]) {
      const v = anyGearView(g.id, g.base, g.rarity);
      if (v) allGear.set(g.id, v);
    }
    const base = rows.map((r) => {
      const attributes = attributesOf(r.attributes);
      const equipped = this.equippedOf(r, allGear);
      const bonus = Object.values(equipped).reduce((sum, g) => sum + (g?.bonus ?? 0), 0);
      return {
        cardId: r.id,
        name: r.name,
        owner: { publicId: r.public_id, displayName: r.display_name, avatar: avatarUrl(r.public_id, r.avatar_at), frame: r.avatar_frame },
        power: powerOf(attributes, bonus),
        wins: r.duel_wins,
        losses: r.duel_losses,
        clears: r.clears,
        me: r.user_id === viewerId,
      };
    });
    const ranked = (list: typeof base, value: (x: (typeof base)[number]) => number): CardRankRow[] => {
      const sorted = [...list].sort((x, y) => value(y) - value(x) || x.cardId - y.cardId);
      let rank = 0;
      let last: number | null = null;
      return sorted.slice(0, 50).map((x, i) => {
        if (value(x) !== last) {
          rank = i + 1;
          last = value(x);
        }
        return { rank, ...x };
      });
    };
    return { power: ranked(base, (x) => x.power), wins: ranked(base.filter((x) => x.wins > 0), (x) => x.wins) };
  }

  // ==================== 管理员（测试用） ====================

  /** 站长给一张卡发成长点（测试高难度地下城用）。 */
  grantPoints(cardId: number, points: number) {
    if (!Number.isInteger(points) || points < 1 || points > 500) throw new HttpError(400, '成长点要在 1～500 之间');
    const n = this.db.prepare('UPDATE character_cards SET pending = pending + ? WHERE id = ?').run(points, cardId).changes;
    if (!n) throw new HttpError(404, '没有这张角色卡');
  }
}
