// 5E 角色卡（V0.9.0）：做卡、改卡、升级、带进 5E 模组、模组结束后的结算、个人主页上的展示。
// 和龙娘角色卡（cards.ts）分开：不穿 16 格装备、不进地下城、不切磋、不上战力榜。卡上的选择照 SRD 5.2.1 检查（shared/5e/sheet.ts）。
import { transaction, type DB } from './db';
import { HttpError } from './http';
import { rejectInvisibleName } from './util';
import type { Social } from './social';
import { GAME_MIN_ACTIONS } from '../shared/pets';
import { CARD2_APPEARANCE_MAX, CARD2_BACKGROUND_MAX, CARD2_MAX, CARD2_NAME_MAX } from '../shared/rules2';
import { ABILITIES, XP_THRESHOLDS, isAbility, isDamageType, isLanguage, isSkill, maxLevelFor, xpForLevel, type Abilities, type Ability, type DamageType, type LanguageKey, type Skill } from '../shared/5e/core';
import { autoEquip, cardProblems, computeSheet, itemName, startingInventory, totalLevel } from '../shared/5e/sheet';
import { CLASS_KEYS, type Card5eData, type Card5eHistory, type Card5eView, type ClassKey, type OriginFeatChoice, type PublicCard5e, type State5e } from '../shared/5e/types';
import { rules5e } from './5e/rules-data';
import { parseState5e } from './game/rules5e';
import { loadScenario, parseWorld } from './game/world';
import { rankedDungeon } from './game/scenario-library';

/** 一个人最多几张 5E 卡（和龙娘角色卡一样多）。 */
export const CARD5E_MAX = CARD2_MAX;

type Row = {
  id: number;
  user_id: number;
  name: string;
  appearance: string;
  background: string;
  data: string;
  on_profile: number;
  created_at: number;
};

const COLUMNS = 'id, user_id, name, appearance, background, data, on_profile, created_at';

/** 带一张 5E 卡进模组（engine 建角色时用）：这一刻卡上的样子，之后在卡上改不影响这一局。 */
export type Card5eEntry = { cardId: number; name: string; appearance: string; background: string; data: Card5eData };

/** 一个人在一局 5E 模组结束后的结算（通知、测试用）。 */
export type Card5eSettlement = { cardId: number; cardName: string; title: string; survived: boolean; counted: boolean; levelUp: boolean; loot: string[] };

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function cleanText(v: unknown, max: number, label: string, required = false): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (required && !t) throw new HttpError(400, `${label}不能为空`);
  if ([...t].length > max) throw new HttpError(400, `${label}最多${max}个字`);
  return t;
}

// ==================== 把网页交来的卡整理成固定的样子 ====================

const KEY_RE = /^[a-z0-9][a-z0-9+-]{0,59}$/;
const bad = () => new HttpError(400, '角色卡的格式不对');

function key(v: unknown): string {
  if (typeof v !== 'string' || !KEY_RE.test(v)) throw bad();
  return v;
}
function keyOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : key(v);
}
function keys(v: unknown, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw bad();
  return v.map(key);
}
function skills(v: unknown, max: number): Skill[] {
  return keys(v, max).map((s) => {
    if (!isSkill(s)) throw bad();
    return s;
  });
}
function int(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
}
function abilityMap(v: unknown, min: number, max: number, partial: boolean): Partial<Abilities> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const out: Partial<Abilities> = {};
  for (const [k, n] of Object.entries(o)) {
    if (!isAbility(k)) throw bad();
    if (partial && (n === 0 || n === null || n === undefined)) continue;
    out[k] = int(n, min, max);
  }
  if (!partial && ABILITIES.some((a) => out[a] === undefined)) throw bad();
  return out;
}
function abilityOrNull(v: unknown): Ability | null {
  if (v === null || v === undefined || v === '') return null;
  if (!isAbility(v)) throw bad();
  return v;
}
function originFeat(v: unknown, sources: OriginFeatChoice['source'][]): OriginFeatChoice {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  if (!sources.includes(o.source as OriginFeatChoice['source'])) throw bad();
  const out: OriginFeatChoice = { key: key(o.key), source: o.source as OriginFeatChoice['source'] };
  if (o.list !== undefined && o.list !== null) {
    if (!['cleric', 'druid', 'wizard'].includes(o.list as string)) throw bad();
    out.list = o.list as OriginFeatChoice['list'];
  }
  const ability = abilityOrNull(o.ability);
  if (ability) out.ability = ability;
  if (o.cantrips !== undefined) out.cantrips = keys(o.cantrips, 2);
  if (o.spell !== undefined && o.spell !== null) out.spell = key(o.spell);
  if (o.skills !== undefined) out.skills = skills(o.skills, 3);
  return out;
}

/** 做卡时直接选的等级（1～5）。没写是 1 级；写了不是这个范围报错。 */
export function readCard5eLevel(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 1;
  const v = (raw as Record<string, unknown>).level;
  if (v === undefined || v === null) return 1;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > XP_THRESHOLDS.length) throw new HttpError(400, `等级要在 1～${XP_THRESHOLDS.length} 之间`);
  return v;
}

/** 背景可选语言：最多两门，不能重复，必须是规则里的语言。 */
function languageList(v: unknown): LanguageKey[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 2) throw bad();
  const out = v.map((x) => {
    if (!isLanguage(x)) throw bad();
    return x;
  });
  if (new Set(out).size !== out.length) throw bad();
  return out;
}

/**
 * 网页交来的卡（只认识的字段、类型对的；物品和钱不收，由服务器按起始装备算）。
 * 选得对不对（有没有这个职业、技能选够了没有）交给 cardProblems。
 */
export function readCard5e(raw: unknown): Omit<Card5eData, 'inventory' | 'money' | 'level' | 'earned' | 'equipped'> & { equipped: Card5eData['equipped'] | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const o = raw as Record<string, unknown>;
  if (!CLASS_KEYS.includes(o.class as ClassKey)) throw new HttpError(400, '请选一个职业');
  if (o.size !== 'medium' && o.size !== 'small') throw bad();
  if (o.method !== 'array' && o.method !== 'pointbuy') throw bad();
  const ec = o.equipmentChoice && typeof o.equipmentChoice === 'object' ? (o.equipmentChoice as Record<string, unknown>) : null;
  if (!ec) throw bad();
  const asi = o.asi === undefined || o.asi === null ? [] : Array.isArray(o.asi) && o.asi.length <= 5 ? o.asi.map((x) => abilityMap(x, 0, 2, true)) : (() => { throw bad(); })();
  const asiFeats =
    o.asiFeats === undefined || o.asiFeats === null
      ? []
      : Array.isArray(o.asiFeats) && o.asiFeats.length <= 5
        ? o.asiFeats.map((x) => {
            const f = (x ?? {}) as Record<string, unknown>;
            const out: {
              key: string;
              ability?: Ability;
              damageType?: DamageType;
              weapons?: string[];
              rituals?: string[];
              cantrip?: string;
              list?: ClassKey;
            } = { key: key(f.key) };
            if (isAbility(f.ability)) out.ability = f.ability;
            if (isDamageType(f.damageType)) out.damageType = f.damageType;
            if (Array.isArray(f.weapons)) out.weapons = f.weapons.filter((x): x is string => typeof x === 'string').slice(0, 4);
            if (Array.isArray(f.rituals)) out.rituals = f.rituals.filter((x): x is string => typeof x === 'string').slice(0, 2);
            if (typeof f.cantrip === 'string') out.cantrip = f.cantrip;
            if (typeof f.list === 'string' && (CLASS_KEYS as string[]).includes(f.list)) out.list = f.list as ClassKey;
            return out;
          })
        : (() => { throw bad(); })();
  const bonusSkills = (o.bonusSkills === undefined || o.bonusSkills === null ? [] : Array.isArray(o.bonusSkills) && o.bonusSkills.length <= 6 ? o.bonusSkills : (() => { throw bad(); })()).map((b) => {
    if (!b || typeof b !== 'object') throw bad();
    const x = b as Record<string, unknown>;
    const skill = x.skill;
    if (!isSkill(skill)) throw bad();
    return { source: key(x.source), skill };
  });
  const feats = o.originFeats === undefined ? [] : Array.isArray(o.originFeats) && o.originFeats.length <= 2 ? o.originFeats.map((f) => originFeat(f, ['background', 'species'])) : (() => { throw bad(); })();
  const invocations = (o.invocations === undefined || o.invocations === null ? [] : Array.isArray(o.invocations) && o.invocations.length <= 8 ? o.invocations : (() => { throw bad(); })()).map((v) => {
    if (!v || typeof v !== 'object') throw bad();
    const x = v as Record<string, unknown>;
    return {
      key: key(x.key),
      ...(x.cantrip !== undefined && x.cantrip !== null ? { cantrip: key(x.cantrip) } : {}),
      ...(x.feat !== undefined && x.feat !== null ? { feat: originFeat(x.feat, ['invocation']) } : {}),
    };
  });
  const tome =
    o.tome === undefined || o.tome === null
      ? null
      : typeof o.tome === 'object' && !Array.isArray(o.tome)
        ? { cantrips: keys((o.tome as Record<string, unknown>).cantrips, 3), rituals: keys((o.tome as Record<string, unknown>).rituals, 2) }
        : (() => { throw bad(); })();
  const eq = o.equipped && typeof o.equipped === 'object' && !Array.isArray(o.equipped) ? (o.equipped as Record<string, unknown>) : null;
  return {
    v: 1,
    class: o.class as ClassKey,
    subclass: keyOrNull(o.subclass),
    totem: keyOrNull(o.totem),
    xp: o.xp === undefined || o.xp === null ? undefined : int(o.xp, 0, 355000),
    deity: keyOrNull(o.deity),
    species: key(o.species),
    lineage: keyOrNull(o.lineage),
    size: o.size,
    lineageAbility: abilityOrNull(o.lineageAbility),
    background: key(o.background),
    languages: languageList(o.languages),
    method: o.method,
    base: abilityMap(o.base, 3, 18, false) as Abilities,
    bgBonus: abilityMap(o.bgBonus ?? {}, 0, 2, true),
    speciesBonus: o.speciesBonus === undefined || o.speciesBonus === null ? undefined : abilityMap(o.speciesBonus, 0, 2, true),
    speciesSkills: o.speciesSkills === undefined || o.speciesSkills === null ? [] : skills(o.speciesSkills, 2),
    speciesLanguages: languageList(o.speciesLanguages),
    asi,
    asiFeats,
    classSkills: skills(o.classSkills, 6),
    bonusSkills,
    expertise: skills(o.expertise, 6),
    originFeats: feats,
    fightingStyle: keyOrNull(o.fightingStyle),
    styleCantrips: keys(o.styleCantrips, 2),
    masteries: keys(o.masteries, 6),
    order: keyOrNull(o.order),
    cantrips: keys(o.cantrips, 8),
    prepared: keys(o.prepared, 24),
    spellbook: keys(o.spellbook, 24),
    magicalSecrets: keys(o.magicalSecrets, 8),
    multiclass: Array.isArray(o.multiclass)
      ? o.multiclass.slice(0, 3).map((x) => {
          const m = (x ?? {}) as Record<string, unknown>;
          return { class: m.class as ClassKey, level: Number(m.level ?? 1) };
        })
      : [],
    invocations,
    tome,
    metamagic: keys(o.metamagic, 4),
    hunterPrey: keyOrNull(o.hunterPrey),
    land: keyOrNull(o.land),
    wildShapes: keys(o.wildShapes, 8),
    equipmentChoice: { class: int(ec.class, 0, 5), background: int(ec.background, 0, 5) },
    equipped: eq
      ? {
          armor: keyOrNull(eq.armor),
          shield: keyOrNull(eq.shield),
          main: keyOrNull(eq.main),
          off: keyOrNull(eq.off),
          feet: keyOrNull(eq.feet),
          ring1: keyOrNull(eq.ring1),
          ring2: keyOrNull(eq.ring2),
          necklace: keyOrNull(eq.necklace),
        }
      : null,
  };
}

/** a 里的每一个 b 里都有（b 只能比 a 多）。 */
function keeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  const pool = b.map((v) => JSON.stringify(v));
  return a.every((v) => {
    const i = pool.indexOf(JSON.stringify(v));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
}

export class Cards5e {
  /** 成就（服务器组装时接上）。 */
  achievements: { unlock(userId: number, key: string): void } | null = null;

  constructor(private readonly opts: { db: DB; social: Social; now: () => number }) {}

  private get db() {
    return this.opts.db;
  }

  // ==================== 读 ====================

  private row(userId: number, id: number): Row {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM cards5e WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
    if (!row) throw new HttpError(404, '没有这张 5E 角色卡');
    return row;
  }

  private dataOf(r: Row): Card5eData {
    const data = parseJson<Card5eData>(r.data, null as unknown as Card5eData);
    if (data && typeof data === 'object' && typeof data.xp !== 'number') data.xp = xpForLevel(data.level);
    return data;
  }

  /** 这张卡正在哪一局（还没结束的）里。 */
  private inRoom(cardId: number): { id: number; name: string } | null {
    return (
      (this.db
        .prepare("SELECT r.id, r.name FROM characters c JOIN rooms r ON r.id = c.room_id WHERE c.card5e_id = ? AND r.status != 'ended' ORDER BY r.id DESC LIMIT 1")
        .get(cardId) as { id: number; name: string } | undefined) ?? null
    );
  }

  private history(cardId: number): Card5eHistory[] {
    const rows = this.db
      .prepare('SELECT scenario_title, ending_title, level, survived, counted, loot, created_at FROM card5e_history WHERE card_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(cardId) as { scenario_title: string; ending_title: string | null; level: number; survived: number; counted: number; loot: string; created_at: number }[];
    return rows.map((r) => ({
      title: r.scenario_title,
      ending: r.ending_title,
      level: r.level,
      survived: r.survived === 1,
      counted: r.counted === 1,
      loot: parseJson<string[]>(r.loot, []),
      at: r.created_at,
    }));
  }

  private played(cardId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM card5e_history WHERE card_id = ?').get(cardId);
  }

  private view(r: Row): Card5eView {
    const data = this.dataOf(r);
    const inRoom = this.inRoom(r.id);
    return {
      id: r.id,
      name: r.name,
      appearance: r.appearance,
      background: r.background,
      data,
      sheet: computeSheet(data, rules5e()),
      inRoom,
      history: this.history(r.id),
      // 没打过模组、不在对局里的卡都能改等级、重新选技能（打过模组的照旧只能升级）
      editable: !inRoom && !this.played(r.id),
      onProfile: r.on_profile === 1,
      createdAt: r.created_at,
    };
  }

  list(userId: number): Card5eView[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM cards5e WHERE user_id = ? ORDER BY id`).all(userId) as Row[]).map((r) => this.view(r));
  }

  get(userId: number, id: number): Card5eView {
    return this.view(this.row(userId, id));
  }

  /** 一个人在个人主页上展示的 5E 角色（主人选了不展示的不算）。 */
  publicCards(userId: number): PublicCard5e[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM cards5e WHERE user_id = ? AND on_profile = 1 ORDER BY id`).all(userId) as Row[];
    return rows.map((r) => {
      const data = this.dataOf(r);
      const sheet = computeSheet(data, rules5e());
      const modules = (this.db.prepare('SELECT COUNT(*) AS n FROM card5e_history WHERE card_id = ?').get(r.id) as { n: number }).n;
      return {
        id: r.id,
        name: r.name,
        appearance: r.appearance,
        species: sheet.speciesName,
        className: sheet.className,
        subclassName: sheet.subclassName,
        level: data.level,
        hpMax: sheet.hpMax,
        ac: sheet.ac,
        abilities: sheet.abilities,
        modules,
      };
    });
  }

  // ==================== 做卡、改卡 ====================

  private requireFormal(userId: number) {
    const u = this.db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId) as { is_guest: number } | undefined;
    if (!u || u.is_guest === 1) throw new HttpError(403, '游客不能做角色卡');
  }

  private requireValid(data: Card5eData) {
    const problems = cardProblems(data, rules5e());
    if (problems.length) throw new HttpError(400, `角色卡还有${problems.length}处要改：${problems.slice(0, 5).join('；')}${problems.length > 5 ? '……' : ''}`);
  }

  /** 新做的卡：等级按网页选的（不写是 1 级），物品和钱照起始装备算；没说穿什么就自动穿上最好的。 */
  private fresh(raw: unknown): Card5eData {
    const input = readCard5e(raw);
    const level = readCard5eLevel(raw);
    const rules = rules5e();
    const { inventory, money } = startingInventory(input, rules);
    const data: Card5eData = { ...input, level, earned: 0, xp: input.xp ?? xpForLevel(level), inventory, money, equipped: input.equipped ?? { armor: null, shield: null, main: null, off: null } };
    if (!input.equipped) data.equipped = autoEquip(data, rules);
    this.requireValid(data);
    return data;
  }

  create(userId: number, body: Record<string, unknown>): Card5eView {
    this.requireFormal(userId);
    const name = cleanText(body.name, CARD2_NAME_MAX, '名字', true);
    // 名字别人看得到、会带进模组：看不见的字符不要
    rejectInvisibleName(name);
    const appearance = cleanText(body.appearance, CARD2_APPEARANCE_MAX, '外貌');
    const background = cleanText(body.background, CARD2_BACKGROUND_MAX, '背景');
    const data = this.fresh(body.data);
    const at = this.opts.now();
    const id = transaction(this.db, () => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM cards5e WHERE user_id = ?').get(userId) as { n: number }).n;
      if (n >= CARD5E_MAX) throw new HttpError(409, `最多 ${CARD5E_MAX} 张 5E 角色卡`);
      if (this.db.prepare('SELECT 1 FROM cards5e WHERE user_id = ? AND name = ?').get(userId, name)) throw new HttpError(409, '已经有一张同名的 5E 卡了');
      const r = this.db
        .prepare('INSERT INTO cards5e (user_id, name, appearance, background, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, name, appearance, background, JSON.stringify(data), at, at);
      return Number(r.lastInsertRowid);
    });
    return this.get(userId, id);
  }

  /**
   * 改卡（不在对局里时）：名字、外貌、背景、在不在主页上展示；穿着拿着的东西、准备的法术、精通的武器、荒野变形的形态
   * （长休时就能换的）。还没打过模组的 1 级卡可以整张重新做（data）。
   */
  update(userId: number, id: number, body: Record<string, unknown>): Card5eView {
    const r = this.row(userId, id);
    const old = this.dataOf(r);
    if (body.onProfile !== undefined && typeof body.onProfile !== 'boolean') throw new HttpError(400, '请求格式不对');
    const onProfile = body.onProfile === undefined ? r.on_profile : body.onProfile ? 1 : 0;
    const name = body.name === undefined ? r.name : cleanText(body.name, CARD2_NAME_MAX, '名字', true);
    if (name !== r.name) rejectInvisibleName(name);
    const appearance = body.appearance === undefined ? r.appearance : cleanText(body.appearance, CARD2_APPEARANCE_MAX, '外貌');
    const background = body.background === undefined ? r.background : cleanText(body.background, CARD2_BACKGROUND_MAX, '背景');
    let data = old;
    if (body.data !== undefined || body.rest !== undefined) {
      if (this.inRoom(id)) throw new HttpError(409, '这张卡正在一局 5E 模组里，打完以后才能改');
    }
    if (body.data !== undefined) {
      if (this.played(id)) throw new HttpError(409, '这张卡已经打过模组了，不能重新做（升级时可以做新的选择）');
      // 等级按网页上选的（1～5），技能和等级决定的特性重新选；名字、种族、职业、背景这些文字照旧另存
      data = this.fresh(body.data);
      data.earned = old.earned;
    } else if (body.rest !== undefined) {
      data = this.rested(old, body.rest);
    }
    if (name !== r.name && this.db.prepare('SELECT 1 FROM cards5e WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, id)) {
      throw new HttpError(409, '已经有一张同名的 5E 卡了');
    }
    this.db
      .prepare('UPDATE cards5e SET name = ?, appearance = ?, background = ?, data = ?, on_profile = ?, updated_at = ? WHERE id = ?')
      .run(name, appearance, background, JSON.stringify(data), onProfile, this.opts.now(), id);
    return this.get(userId, id);
  }

  /** 长休时能换的：穿着拿着的东西、准备的法术（法师从法术书里挑）、精通的武器、荒野变形的形态。 */
  private rested(old: Card5eData, raw: unknown): Card5eData {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
    const o = raw as Record<string, unknown>;
    const next: Card5eData = structuredClone(old);
    if (o.equipped !== undefined) {
      const eq = o.equipped && typeof o.equipped === 'object' && !Array.isArray(o.equipped) ? (o.equipped as Record<string, unknown>) : null;
      if (!eq) throw bad();
      next.equipped = { armor: keyOrNull(eq.armor), shield: keyOrNull(eq.shield), main: keyOrNull(eq.main), off: keyOrNull(eq.off) };
    }
    if (o.prepared !== undefined) next.prepared = keys(o.prepared, 24);
    if (o.masteries !== undefined) next.masteries = keys(o.masteries, 6);
    if (o.wildShapes !== undefined) next.wildShapes = keys(o.wildShapes, 8);
    this.requireValid(next);
    return next;
  }

  /**
   * 升一级（打完模组挣到的）：等级 +1，做这一级的新选择。种族、职业、背景、属性这些不变；属性值提升、专精、技能、
   * 法术书只能加不能减，子职业选了就不能换；戏法、准备的法术、魔能祈唤、超魔、战斗风格可以重新选（升级时规则允许换）。
   */
  levelUp(userId: number, id: number, body: Record<string, unknown>): Card5eView {
    const r = this.row(userId, id);
    const old = this.dataOf(r);
    if (this.inRoom(id)) throw new HttpError(409, '这张卡正在一局 5E 模组里，打完以后才能升级');
    const total = totalLevel(old);
    const xp = old.xp ?? xpForLevel(total);
    if (old.earned < 1 && xp < xpForLevel(total + 1)) {
      throw new HttpError(409, `还没有挣到新的等级（要 ${xpForLevel(total + 1)} 经验，或者打完一个剧本大厅里的 5E 模组）`);
    }
    const maxLevel = maxLevelFor(old.class);
    if (total >= maxLevel) throw new HttpError(409, `这个职业这一版最高 ${maxLevel} 级`);
    const input = readCard5e(body.data);
    const next: Card5eData = {
      ...input,
      // 不能变的照旧
      v: 1,
      class: old.class,
      species: old.species,
      lineage: old.lineage,
      size: old.size,
      lineageAbility: old.lineageAbility,
      background: old.background,
      method: old.method,
      base: old.base,
      bgBonus: old.bgBonus,
      classSkills: old.classSkills,
      originFeats: old.originFeats,
      order: old.order,
      equipmentChoice: old.equipmentChoice,
      inventory: old.inventory,
      money: old.money,
      equipped: old.equipped,
      level: old.level + 1,
      earned: Math.max(0, old.earned - 1),
      xp: Math.max(input.xp ?? old.xp ?? 0, xpForLevel(total + 1)),
    };
    if (!keeps(old.asi, next.asi) || !keeps(old.asiFeats ?? [], next.asiFeats ?? []) || !keeps(old.bonusSkills, next.bonusSkills) || !keeps(old.expertise, next.expertise) || !keeps(old.spellbook, next.spellbook)) {
      throw new HttpError(400, '属性值提升、技能、专精、法术书升级时只能加，不能去掉以前的');
    }
    if (old.subclass && next.subclass !== old.subclass) throw new HttpError(400, '子职业选了就不能换');
    this.requireValid(next);
    this.db.prepare('UPDATE cards5e SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), this.opts.now(), id);
    return this.get(userId, id);
  }

  remove(userId: number, id: number) {
    this.row(userId, id);
    if (this.inRoom(id)) throw new HttpError(409, '这张卡正在一局 5E 模组里，打完以后才能删');
    this.db.prepare('DELETE FROM cards5e WHERE id = ?').run(id);
  }

  /** 站长给一张卡发一级（测试高等级模组用）：挣到的等级 +1（升级时照常做选择），最多到 5 级。 */
  grantLevel(cardId: number) {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM cards5e WHERE id = ?`).get(cardId) as Row | undefined;
    if (!row) throw new HttpError(404, '没有这张 5E 角色卡');
    const data = this.dataOf(row);
    const maxLevel = maxLevelFor(data.class);
    if (data.level + data.earned >= maxLevel) throw new HttpError(409, `这个职业这一版最高 ${maxLevel} 级`);
    data.earned += 1;
    this.db.prepare('UPDATE cards5e SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), this.opts.now(), cardId);
  }

  // ==================== 带进模组 ====================

  /** 带一张 5E 卡进模组：是自己的、没在别的还没结束的局里、卡上的选择都做完了（挣到的等级还没升的，照现在的等级玩）。 */
  entry(userId: number, cardId: number, roomId: number): Card5eEntry {
    const r = this.row(userId, cardId);
    const busy = this.inRoom(cardId);
    if (busy && busy.id !== roomId) throw new HttpError(409, `这张卡正在「${busy.name}」里，打完那一局才能带进别的模组`);
    const data = this.dataOf(r);
    const problems = cardProblems(data, rules5e());
    if (problems.length) throw new HttpError(409, `这张卡还有没做完的选择：${problems.slice(0, 3).join('；')}`);
    return { cardId, name: r.name, appearance: r.appearance, background: r.background, data };
  }

  // ==================== 模组结束 ====================

  /**
   * 一局 5E 模组走到了结局：带 5E 卡进来、交过几个行动的正式账号，每人记一条经历。
   * 剧本大厅里的模组（自带的、管理员上传的、投稿通过的）才算：活着的升一级（挣到一级，在「5E 角色」里升），
   * 这一局结束时身上的东西和钱就是卡上以后的；死了的卡照旧（不升级，这一局得到、用掉的都不算）。
   * 自己导入的、让 AI 写的模组照样能玩，但不升级、不带出东西（宝藏是写剧本的人自己定的）。一局只算一次。
   */
  afterRoom(roomId: number): Card5eSettlement[] {
    const stored = loadScenario(this.db, roomId);
    const room = this.db.prepare('SELECT created_at, world FROM rooms WHERE id = ?').get(roomId) as { created_at: number; world: string } | undefined;
    if (!stored || stored.scenario.rules !== '5e' || !room) return [];
    const ending = parseWorld(room.world).ending;
    if (!ending) return [];
    const counted = rankedDungeon(stored);
    const scenario = stored.scenario;
    const rules = rules5e();
    const at = this.opts.now();
    const rows = this.db
      .prepare(
        `SELECT c.id, c.card5e_id, c.dead, c.v5, p.user_id,
           (SELECT COUNT(*) FROM actions a WHERE a.character_id = c.id AND a.status = 'done') AS done
         FROM characters c JOIN players p ON p.id = c.player_id JOIN users u ON u.id = p.user_id
         WHERE c.room_id = ? AND c.card5e_id IS NOT NULL AND u.is_guest = 0 AND u.deleted_at IS NULL`,
      )
      .all(roomId) as { id: number; card5e_id: number; dead: number; v5: string | null; user_id: number; done: number }[];
    const out: Card5eSettlement[] = [];
    for (const row of rows) {
      if (row.done < GAME_MIN_ACTIONS) continue;
      const state: State5e | null = parseState5e(row.v5);
      const survived = row.dead === 0;
      const settled = transaction(this.db, () => {
        const card = this.db.prepare(`SELECT ${COLUMNS} FROM cards5e WHERE id = ?`).get(row.card5e_id) as Row | undefined;
        if (!card || card.user_id !== row.user_id) return null;
        const data = this.dataOf(card);
        // 带出来的：结局时身上比进模组时多出来的东西和钱（这一局拿到又用掉了的不算）
        const had = new Map(data.inventory.map((i) => [i.key, i.qty]));
        const more = state ? state.inventory.filter((i) => i.qty > (had.get(i.key) ?? 0)).map((i) => ({ key: i.key, qty: i.qty - (had.get(i.key) ?? 0) })) : [];
        const moreMoney = state ? Math.max(0, Math.round(state.money) - data.money) : 0;
        const loot = survived && counted && state ? [...more.map((g) => `${itemName(rules, g.key)}${g.qty > 1 ? `×${g.qty}` : ''}`), ...(moreMoney >= 100 ? [`${Math.floor(moreMoney / 100)} 金币`] : [])] : [];
        const inserted = this.db
          .prepare(
            `INSERT INTO card5e_history (card_id, room_id, room_created_at, scenario_key, scenario_title, ending_title, level, survived, counted, loot, created_at)
             VALUES (?, ?, ?, (SELECT scenario_key FROM scenarios WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(card.id, roomId, room.created_at, roomId, scenario.title, ending.title, state?.data.level ?? data.level, survived ? 1 : 0, counted ? 1 : 0, JSON.stringify(loot), at).changes;
        if (!inserted) return null;
        let levelUp = false;
        if (survived && counted) {
          // 活着回来：身上的东西和钱就是这一局结束时的；挣到一级（最高 5 级）
          if (state) {
            data.inventory = state.inventory.filter((i) => i.qty > 0).map((i) => ({ key: i.key, qty: i.qty }));
            data.money = Math.max(0, Math.round(state.money));
            // 穿着拿着的东西没了（丢了、卖了）就脱下来
            for (const slot of ['armor', 'shield', 'main', 'off'] as const) {
              const k = data.equipped[slot];
              if (k && !data.inventory.some((i) => i.key === k)) data.equipped[slot] = null;
            }
          }
          if (data.level + data.earned < maxLevelFor(data.class)) {
            data.earned += 1;
            levelUp = true;
          }
          this.db.prepare('UPDATE cards5e SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), at, card.id);
        }
        return { cardId: card.id, cardName: card.name, loot, levelUp };
      });
      if (!settled) continue;
      const s: Card5eSettlement = { cardId: settled.cardId, cardName: settled.cardName, title: scenario.title, survived, counted, levelUp: settled.levelUp, loot: settled.loot };
      out.push(s);
      this.opts.social.notify(row.user_id, 'card5e_done', { card: s.cardName, cardId: s.cardId, title: s.title, survived, counted, levelUp: s.levelUp, loot: s.loot });
    }
    return out;
  }
}
