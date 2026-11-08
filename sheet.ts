// 5E 角色卡（V0.9.0）：从卡上的选择算出角色数值（computeSheet），检查选择对不对（cardProblems）。
// 服务器建卡、改卡、带进对局时用；网页做卡时也用同一份（规则数据从 /api/5e/rules 拿）。
import {
  ABILITIES,
  ABILITY_NAME,
  ABILITY_SCORE_MAX,
  FULL_CASTER_SLOTS,
  HALF_CASTER_SLOTS,
  LANGUAGE_KEYS,
  LANGUAGE_NAME,
  maxLevelFor,
  PACT_SLOTS,
  POINT_BUY_COST,
  POINT_BUY_TOTAL,
  SKILL_ABILITY,
  SKILL_KEYS,
  SKILL_NAME,
  STANDARD_ARRAY,
  abilityMod,
  formatDice,
  isAbility,
  isLanguage,
  isSkill,
  parseDice,
  proficiencyBonus,
  signed,
  type Abilities,
  type Ability,
  type DamageType,
  type Skill,
} from './core';
import {
  AT_WILL,
  INVOCATION_SPELLS,
  LINEAGE_SPELLS,
  MENTAL,
  RAGES,
  SCHOLAR_SKILLS,
  SUBCLASS_LEVEL,
  alwaysPrepared,
  asiCount,
  bardicDie,
  expertiseCount,
  favoredEnemyUses,
  fightingStyleLevel,
  invocationCount,
  martialArtsDie,
  magicalSecretsCount,
  masteryCount,
  meetsMulticlassRequirement,
  multiclassRequirementText,
  wildShapeForms,
} from './class-rules';
import type { ArmorData, AttackOption, Card5eData, ClassData, ClassKey, ResourceInfo, RulesData, Sheet5e, SpeciesData, SpellData, WeaponData } from './types';
import { DEITIES } from './deities';
import { isTotem } from './totems';

// ==================== 小工具 ====================

/** 物品 key 拆成基础物品和魔法加值：longsword+1 → longsword、1。 */
export function splitItemKey(key: string): { base: string; plus: number } {
  const m = /^(.*)\+(\d)$/.exec(key);
  return m ? { base: m[1], plus: Number(m[2]) } : { base: key, plus: 0 };
}

export function weaponOf(rules: RulesData, key: string | null | undefined): (WeaponData & { plus: number; itemKey: string }) | null {
  if (!key) return null;
  const { base, plus } = splitItemKey(key);
  const w = rules.weapons.find((x) => x.key === base);
  return w ? { ...w, plus, itemKey: key, name: plus ? `${w.name} +${plus}` : w.name } : null;
}

export function armorOf(rules: RulesData, key: string | null | undefined): (ArmorData & { plus: number; itemKey: string }) | null {
  if (!key) return null;
  const { base, plus } = splitItemKey(key);
  const a = rules.armor.find((x) => x.key === base);
  return a ? { ...a, plus, itemKey: key, name: plus ? `${a.name} +${plus}` : a.name } : null;
}

/** 物品的名字（武器、护甲、杂物、魔法物品；带 +1 的写上）。 */
export function itemName(rules: RulesData, key: string): string {
  const w = weaponOf(rules, key);
  if (w) return w.name;
  const a = armorOf(rules, key);
  if (a) return a.name;
  return rules.gear.find((g) => g.key === key)?.name ?? rules.magicItems.find((m) => m.key === key)?.name ?? key;
}

export function classOf(rules: RulesData, key: string): ClassData | null {
  return rules.classes.find((c) => c.key === key) ?? null;
}

/** 一个职业的法术表（某一环以下）。 */
export function classSpells(rules: RulesData, cls: ClassKey, maxLevel = 3): SpellData[] {
  return rules.spells.filter((s) => s.classes.includes(cls) && s.level <= maxLevel);
}

/** 这一级能施放的最高环（全施法者、半施法者、契约魔法）。 */
export function maxSpellLevel(cls: ClassData, level: number): number {
  const sc = cls.spellcasting;
  if (!sc) return 0;
  const slotLevel = Math.min(level, 20);
  if (sc.kind === 'pact') return PACT_SLOTS[Math.min(level, 5)]?.level ?? 1;
  const slots = (sc.kind === 'full' ? FULL_CASTER_SLOTS : HALF_CASTER_SLOTS)[slotLevel] ?? [0];
  let max = 0;
  for (let i = 0; i < slots.length; i++) if (slots[i] > 0) max = i + 1;
  return max;
}

/** 最后的六项属性：分配的 + 种族 + 背景 + 属性值提升（最高 20）。 */
/** 兼职属性不达标的职业；这些职业的动作会有劣势。 */
export function unmetMulticlass(card: Pick<Card5eData, 'level' | 'multiclass' | 'class' | 'base' | 'bgBonus' | 'speciesBonus' | 'asi'>): ClassKey[] {
  if (!(card.multiclass ?? []).length) return [];
  const abilities = finalAbilities(card);
  return [card.class, ...(card.multiclass ?? []).map((m) => m.class)].filter((c) => !meetsMulticlassRequirement(c, abilities));
}

/** 角色总等级：主职业等级 + 所有兼职等级。 */
export function totalLevel(card: Pick<Card5eData, 'level' | 'multiclass'>): number {
  return Number(card.level || 0) + (card.multiclass ?? []).reduce((sum, m) => sum + Number(m.level || 0), 0);
}

export function finalAbilities(
  card: Pick<Card5eData, 'base' | 'bgBonus' | 'speciesBonus' | 'asi'> & Partial<Pick<Card5eData, 'class' | 'level' | 'asiFeats'>>,
): Abilities {
  const out = {} as Abilities;
  const primal = card.class === 'barbarian' && Number(card.level ?? 0) >= 20;
  for (const a of ABILITIES) {
    let v = Number(card.base?.[a] ?? 8) + Number(card.speciesBonus?.[a] ?? 0) + Number(card.bgBonus?.[a] ?? 0);
    for (const x of card.asi ?? []) v += Number(x?.[a] ?? 0);
    for (const f of card.asiFeats ?? []) if (f.ability === a) v += 1;
    if (primal && (a === 'str' || a === 'con')) v += 4;
    out[a] = Math.min(primal && (a === 'str' || a === 'con') ? 24 : ABILITY_SCORE_MAX, v);
  }
  return out;
}

/** 种族固定的属性加值（半精灵的魅力 +2）；可选项由玩家在 SpeciesStep 里选。 */
export function speciesFixedBonus(sp: SpeciesData | null | undefined): Partial<Abilities> | undefined {
  if (!sp?.abilityBonus) return undefined;
  return { ...sp.abilityBonus.fixed };
}

function hasInvocation(card: Card5eData, key: string): boolean {
  return (card.invocations ?? []).some((i) => i.key === key);
}

/** 兼职时只给的部分熟练项。 */
const MC_ARMOR: Partial<Record<ClassKey, ArmorData['kind'][]>> = {
  barbarian: ['shield'],
  bard: ['light'],
  cleric: ['light', 'medium', 'shield'],
  druid: ['light', 'medium', 'shield'],
  fighter: ['light', 'medium', 'shield'],
  paladin: ['light', 'medium', 'shield'],
  ranger: ['light', 'medium', 'shield'],
  rogue: ['light'],
  warlock: ['light'],
};
const MC_WEAPON: Partial<Record<ClassKey, ('simple' | 'martial' | 'shortsword')[]>> = {
  barbarian: ['simple', 'martial'],
  fighter: ['simple', 'martial'],
  monk: ['simple', 'shortsword'],
  paladin: ['simple', 'martial'],
  ranger: ['simple', 'martial'],
  warlock: ['simple'],
};

/** 会不会用这种武器。 */
export function weaponProficient(card: Card5eData, cls: ClassData, w: WeaponData): boolean {
  if ((cls.weapons as string[]).includes(w.category)) return true;
  if (w.category === 'martial') {
    if (card.class === 'monk' && w.properties.includes('light')) return true;
    if (card.class === 'rogue' && (w.properties.includes('finesse') || w.properties.includes('light'))) return true;
    if (card.subclass === 'college-of-valor' && card.level >= 3) return true;
    if (card.order === 'protector' || card.order === 'warden') return true;
    if (hasInvocation(card, 'pact-of-the-blade') && !w.ranged) return true;
  }
  for (const f of card.asiFeats ?? []) if (f.key === 'weapon-master' && (f.weapons ?? []).includes(w.key)) return true;
  for (const m of card.multiclass ?? []) {
    const grants = MC_WEAPON[m.class] ?? [];
    if (grants.includes('simple') && w.category === 'simple') return true;
    if (grants.includes('martial') && w.category === 'martial') return true;
    if (grants.includes('shortsword') && w.key === 'shortsword') return true;
  }
  return false;
}

/** 受没受过这种护甲的训练（盾牌也算）。 */
export function armorTrained(card: Card5eData, cls: ClassData, kind: ArmorData['kind']): boolean {
  if (cls.armor.includes(kind)) return true;
  if (kind === 'heavy' && card.order === 'protector') return true;
  if (kind === 'medium' && card.order === 'warden') return true;
  if (card.subclass === 'college-of-valor' && card.level >= 3 && (kind === 'medium' || kind === 'shield')) return true;
  for (const m of card.multiclass ?? []) if ((MC_ARMOR[m.class] ?? []).includes(kind)) return true;
  const feats = (card.asiFeats ?? []).map((f) => f.key);
  if (feats.includes('lightly-armored') && kind === 'light') return true;
  if (feats.includes('moderately-armored') && (kind === 'medium' || kind === 'shield')) return true;
  if (feats.includes('heavily-armored') && kind === 'heavy') return true;
  return false;
}

/** 武僧武器：简易近战武器、有轻型属性的军用近战武器。 */
export function isMonkWeapon(w: WeaponData): boolean {
  return !w.ranged && (w.category === 'simple' || w.properties.includes('light'));
}

/** 起源专长里的魔法学徒：每一个都给两个戏法、一个 1 环法术。 */
function magicInitiates(card: Card5eData) {
  const list = [...(card.originFeats ?? [])];
  for (const inv of card.invocations ?? []) if (inv.key === 'lessons-of-the-first-ones' && inv.feat) list.push(inv.feat);
  return list.filter((f) => f.key === 'magic-initiate');
}

function allFeats(card: Card5eData): string[] {
  const out = (card.originFeats ?? []).map((f) => f.key);
  for (const f of card.asiFeats ?? []) out.push(f.key);
  for (const inv of card.invocations ?? []) if (inv.key === 'lessons-of-the-first-ones' && inv.feat) out.push(inv.feat.key);
  if (card.fightingStyle && !['blessed-warrior', 'druidic-warrior'].includes(card.fightingStyle)) out.push(card.fightingStyle);
  return out;
}

// ==================== 算数值 ====================

/** 从卡上的选择算出角色数值。数据不全（做卡做到一半）时也尽量算，缺的当没有。 */
export function computeSheet(card: Card5eData, rules: RulesData): Sheet5e {
  const level = Math.max(1, Math.min(maxLevelFor(card.class), card.level || 1));
  const cls = classOf(rules, card.class) ?? rules.classes[0];
  const sub = level >= SUBCLASS_LEVEL ? (rules.subclasses.find((s) => s.key === card.subclass) ?? null) : null;
  const species = rules.species.find((s) => s.key === card.species) ?? null;
  const lineage = species?.lineages.find((l) => l.key === card.lineage) ?? null;
  const background = rules.backgrounds.find((b) => b.key === card.background) ?? null;
  const total = totalLevel(card);
  const pb = proficiencyBonus(total);
  const abilities = finalAbilities(card);
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, abilityMod(abilities[a])])) as Abilities;
  const feats = allFeats(card);

  // ---------- 豁免、技能 ----------
  const resilient = (card.asiFeats ?? []).find((f) => f.key === 'resilient')?.ability;
  const saves = Object.fromEntries(
    ABILITIES.map((a) => {
      const prof = cls.saves.includes(a) || resilient === a;
      return [a, { mod: mods[a] + (prof ? pb : 0), prof }];
    }),
  ) as Sheet5e['saves'];
  const profSkills = new Set<Skill>([
    ...(card.classSkills ?? []),
    ...(background?.skills ?? []),
    ...(card.speciesSkills ?? []),
    ...(card.bonusSkills ?? []).map((b) => b.skill),
  ]);
  for (const f of card.originFeats ?? []) if (f.key === 'skilled') for (const s of f.skills ?? []) profSkills.add(s);
  for (const inv of card.invocations ?? []) if (inv.feat?.key === 'skilled') for (const s of inv.feat.skills ?? []) profSkills.add(s);
  const expertise = new Set((card.expertise ?? []).filter((s) => profSkills.has(s)));
  const jack = card.class === 'bard' && level >= 2;
  const thaumaturge = card.order === 'thaumaturge' ? (['arcana', 'religion'] as Skill[]) : card.order === 'magician' ? (['arcana', 'nature'] as Skill[]) : [];
  const skills = Object.fromEntries(
    SKILL_KEYS.map((s) => {
      const prof: 0 | 0.5 | 1 | 2 = expertise.has(s) ? 2 : profSkills.has(s) ? 1 : jack ? 0.5 : 0;
      let mod = mods[SKILL_ABILITY[s]] + Math.floor(pb * prof);
      if (thaumaturge.includes(s)) mod += Math.max(1, mods.wis);
      return [s, { mod, prof }];
    }),
  ) as Sheet5e['skills'];
  const passivePerception = 10 + skills.perception.mod + ((card.asiFeats ?? []).some((f) => f.key === 'observant') ? 5 : 0);

  // ---------- 生命值 ----------
  const hitDie = cls.hitDie;
  let hpMax = hitDie + mods.con;
  for (let L = 2; L <= level; L++) hpMax += Math.max(1, hitDie / 2 + 1 + mods.con);
  // 兼职等级只拿所升职业的升级生命值，不拿首级生命值
  for (const m of card.multiclass ?? []) {
    const mc = rules.classes.find((c) => c.key === m.class);
    if (!mc) continue;
    for (let L = 0; L < m.level; L++) hpMax += Math.max(1, mc.hitDie / 2 + 1 + mods.con);
  }
  if (card.species === 'dwarf') hpMax += total;
  if (card.subclass === 'draconic-sorcery' && level >= 3) hpMax += level;
  if ((card.asiFeats ?? []).some((f) => f.key === 'tough')) hpMax += total * 2;
  hpMax = Math.max(1, hpMax);

  // ---------- 护甲等级 ----------
  const armor = armorOf(rules, card.equipped?.armor);
  const shield = armorOf(rules, card.equipped?.shield);
  const hasShield = !!shield && shield.kind === 'shield';
  const bodyArmor = armor && armor.kind !== 'shield' ? armor : null;
  const options: { ac: number; note: string }[] = [];
  if (bodyArmor) {
    const dex = bodyArmor.dexMax === null ? mods.dex : Math.min(mods.dex, bodyArmor.dexMax);
    options.push({ ac: bodyArmor.ac + dex + bodyArmor.plus, note: bodyArmor.name });
  } else {
    options.push({ ac: 10 + mods.dex, note: '没穿甲' });
    if (card.class === 'barbarian') options.push({ ac: 10 + mods.dex + mods.con, note: '无甲防御' });
    if (card.class === 'monk' && !hasShield) options.push({ ac: 10 + mods.dex + mods.wis, note: '无甲防御' });
    if (card.subclass === 'draconic-sorcery' && level >= 3) options.push({ ac: 10 + mods.dex + mods.cha, note: '龙族韧性' });
  }
  const best = options.reduce((a, b) => (b.ac > a.ac ? b : a));
  let ac = best.ac;
  const acParts = [best.note];
  if (hasShield) {
    ac += 2 + shield!.plus;
    acParts.push(shield!.name);
  }
  if (card.fightingStyle === 'defense' && bodyArmor) {
    ac += 1;
    acParts.push('战斗风格「防御」');
  }
  for (const it of card.inventory ?? []) {
    const mi = rules.magicItems.find((m) => m.key === it.key);
    if (mi?.mech?.ac && (it.key === 'cloak-of-protection' || it.key === 'ring-of-protection')) {
      ac += mi.mech.ac;
      acParts.push(mi.name);
    }
  }

  // ---------- 速度、体型、视觉 ----------
  let speed = species?.speed ?? 30;
  if (card.lineage === 'elven-lineage-wood-elf') speed += 5;
  if (card.class === 'barbarian' && level >= 5 && bodyArmor?.kind !== 'heavy') speed += 10;
  if (card.class === 'monk' && level >= 2 && !bodyArmor && !hasShield) speed += 10;
  if ((card.asiFeats ?? []).some((f) => f.key === 'mobile')) speed += 10;
  const size: 'medium' | 'small' = species?.size === 'small' ? 'small' : species?.size === 'choice' ? (card.size === 'small' ? 'small' : 'medium') : 'medium';
  const darkvision = card.lineage === 'elven-lineage-drow' ? 120 : (species?.darkvision ?? 0);

  // ---------- 攻击 ----------
  const attacks: AttackOption[] = [];
  const masteryKnown = new Set(masteryCount(card.class, level) ? (card.masteries ?? []) : []);
  const monk = card.class === 'monk';
  const martialDie = martialArtsDie(level);
  const seen = new Set<string>();
  for (const it of card.inventory ?? []) {
    const w = weaponOf(rules, it.key);
    if (!w || seen.has(it.key)) continue;
    seen.add(it.key);
    const prof = weaponProficient(card, cls, w);
    const finesse = w.properties.includes('finesse');
    const monkWeapon = monk && isMonkWeapon(w) && !bodyArmor && !hasShield;
    let ability: Ability = w.ranged ? 'dex' : finesse || monkWeapon ? (mods.dex > mods.str ? 'dex' : 'str') : 'str';
    if (hasInvocation(card, 'pact-of-the-blade') && !w.ranged && mods.cha > mods[ability]) ability = 'cha';
    let toHit = mods[ability] + (prof ? pb : 0) + w.plus;
    if (card.fightingStyle === 'archery' && w.ranged) toHit += 2;
    let dice = parseDice(w.damage) ?? { count: 1, sides: 4, bonus: 0 };
    if (monkWeapon && dice.sides < martialDie && dice.count === 1) dice = { count: 1, sides: martialDie, bonus: 0 };
    const dmg = formatDice({ ...dice, bonus: mods[ability] + w.plus });
    const notes: string[] = [];
    if (!prof) notes.push('不熟练，不加熟练加值');
    if (w.versatile) notes.push(`双手用 ${w.versatile}`);
    if (w.range) notes.push(`射程 ${w.range[0]}/${w.range[1]} 尺`);
    attacks.push({
      key: it.key,
      name: w.name,
      kind: 'weapon',
      ability,
      toHit,
      damage: dmg,
      damageType: w.damageType,
      range: w.ranged ? `射程 ${w.range?.[0] ?? 0}/${w.range?.[1] ?? 0} 尺` : w.properties.includes('reach') ? '触及 10 尺' : '触及 5 尺',
      mastery: masteryKnown.has(splitItemKey(it.key).base) ? w.mastery : null,
      note: notes.join('；'),
    });
  }
  {
    const ability: Ability = monk && mods.dex > mods.str ? 'dex' : 'str';
    const dmg = monk ? formatDice({ count: 1, sides: martialDie, bonus: mods[ability] }) : String(Math.max(1, 1 + mods.str));
    attacks.push({ key: 'unarmed', name: '徒手打击', kind: 'unarmed', ability, toHit: mods[ability] + pb, damage: dmg, damageType: 'bludgeoning', range: '触及 5 尺', mastery: null, note: monk ? '武艺：可以用附赠动作再打一次' : '' });
  }

  // ---------- 施法 ----------
  const sc = cls.spellcasting;
  const abilityOf: Record<string, Ability> = {};
  const cantrips = new Set<string>(card.cantrips ?? []);
  const always = alwaysPrepared({ class: card.class, subclass: level >= 3 ? card.subclass : null, land: card.land, level });
  // 总是准备好的里面有戏法（大地结社的火焰箭、冷冻射线、电爪、酸液飞溅）：算进戏法
  const alwaysCantrip = (k: string) => rules.spells.find((s) => s.key === k)?.level === 0;
  for (const k of always) if (alwaysCantrip(k)) cantrips.add(k);
  const prepared = new Set<string>([...(card.prepared ?? []), ...(card.magicalSecrets ?? []), ...always.filter((k) => !alwaysCantrip(k))]);
  const free: Record<string, number> = {};
  if (card.class === 'ranger') free['hunters-mark'] = favoredEnemyUses(level);
  if (card.class === 'paladin' && level >= 2) free['divine-smite'] = 1;
  if (card.class === 'paladin' && level >= 5) free['find-steed'] = 1;
  // 血统法术：戏法随时用，1 环以上每次长休免费一次（森林侏儒的动物交谈是熟练加值那么多次）
  for (const x of LINEAGE_SPELLS[card.lineage ?? ''] ?? []) {
    if (x.level > level) continue;
    const s = rules.spells.find((y) => y.key === x.spell);
    if (!s) continue;
    if (card.lineageAbility) abilityOf[s.key] = card.lineageAbility;
    if (s.level === 0) cantrips.add(s.key);
    else {
      prepared.add(s.key);
      free[s.key] = (free[s.key] ?? 0) + (card.lineage === 'gnomish-lineage-forest-gnome' ? pb : 1);
    }
  }
  // 魔法学徒：两个戏法、一个 1 环法术（每次长休免费一次，也能用法术位）
  for (const f of magicInitiates(card)) {
    for (const c of f.cantrips ?? []) {
      cantrips.add(c);
      if (f.ability) abilityOf[c] = f.ability;
    }
    if (f.spell) {
      prepared.add(f.spell);
      free[f.spell] = (free[f.spell] ?? 0) + 1;
      if (f.ability) abilityOf[f.spell] = f.ability;
    }
  }
  // 神佑战士（圣武士，魅力）、德鲁伊战士（游侠，感知）的两个戏法
  if (card.fightingStyle === 'blessed-warrior' || card.fightingStyle === 'druidic-warrior') {
    for (const c of card.styleCantrips ?? []) {
      cantrips.add(c);
      abilityOf[c] = card.fightingStyle === 'blessed-warrior' ? 'cha' : 'wis';
    }
  }
  // 邪术师：魔能祈唤给的法术（不用法术位）、魔典契约
  if (card.class === 'warlock') {
    for (const inv of card.invocations ?? []) {
      const x = INVOCATION_SPELLS[inv.key];
      if (!x) continue;
      prepared.add(x.spell);
      free[x.spell] = x.perDay ?? AT_WILL;
    }
    if (hasInvocation(card, 'pact-of-the-tome') && card.tome) {
      for (const c of card.tome.cantrips) {
        cantrips.add(c);
        abilityOf[c] = 'cha';
      }
      for (const r of card.tome.rituals) {
        prepared.add(r);
        abilityOf[r] = 'cha';
      }
    }
  }
  let spell: Sheet5e['spell'] = null;
  if (sc || cantrips.size || prepared.size) {
    const ability = sc?.ability ?? null;
    const castMod = ability ? mods[ability] : 0;
    // 法术内容目前只填到 5 级：6 级以后先沿用 5 级的法术位，等各职业内容补齐再往上加。
    const slotLevel = Math.min(level, 20);
    const slots: number[] =
      (sc?.kind === 'full' ? FULL_CASTER_SLOTS[slotLevel] : sc?.kind === 'half' ? HALF_CASTER_SLOTS[slotLevel] : null) ?? [0];
    // 没有职业施法的（血统、专长给的法术）：DC 照第一个法术用的属性算，abilityOf 里每个都有
    const fallback = Object.values(abilityOf)[0] ?? 'int';
    const m = ability ? castMod : mods[fallback];
    spell = {
      ability,
      dc: 8 + pb + m,
      attack: pb + m,
      slots: [...slots],
      pact: sc?.kind === 'pact' ? (PACT_SLOTS[Math.min(level, 5)] ?? PACT_SLOTS[5]) : null,
      cantrips: [...cantrips],
      prepared: [...prepared],
      always,
      free,
      spellbook: card.class === 'wizard' ? [...(card.spellbook ?? [])] : null,
      abilityOf,
    };
    // 戏法里能打人的，也列进攻击（命中加值、伤害）
    for (const key of cantrips) {
      const s = rules.spells.find((x) => x.key === key);
      if (!s?.mech?.damage || (!s.mech.attack && !s.mech.save)) continue;
      const ab = abilityOf[key] ?? ability ?? fallback;
      const dice = level >= 5 && s.mech.cantripDice ? s.mech.cantripDice : s.mech.damage;
      const count = level >= 5 && s.mech.countAtLevel5 ? s.mech.countAtLevel5 : (s.mech.count ?? 1);
      const agonizing = (card.invocations ?? []).some((i) => i.key === 'agonizing-blast' && i.cantrip === key);
      const d = parseDice(dice);
      attacks.push({
        key: `spell:${key}`,
        name: s.name,
        kind: 'spell',
        ability: ab,
        toHit: s.mech.attack ? pb + mods[ab] : 8 + pb + mods[ab],
        damage: d ? formatDice({ ...d, bonus: d.bonus + (agonizing ? mods.cha : 0) }) : dice,
        damageType: (s.mech.damageType ?? 'force') as DamageType,
        range: s.range,
        mastery: null,
        note: `${s.mech.attack ? '法术攻击' : `${ABILITY_NAME[s.mech.save!]}豁免 DC ${8 + pb + mods[ab]}`}${count > 1 ? `，${count} 道` : ''}`,
      });
    }
  }

  // ---------- 资源 ----------
  const resources: ResourceInfo[] = [];
  const res = (key: string, name: string, max: number, recover: ResourceInfo['recover']) => {
    if (max > 0) resources.push({ key, name, max, recover });
  };
  switch (card.class) {
    case 'barbarian':
      res('rage', '狂暴', RAGES[level - 1], 'short-one');
      break;
    case 'bard':
      res('bardic-inspiration', `诗人激励（d${bardicDie(level)}）`, Math.max(1, mods.cha), level >= 5 ? 'short' : 'long');
      break;
    case 'cleric':
      if (level >= 2) res('channel-divinity', '引导神力', level >= 18 ? 3 : level >= 6 ? 2 : 1, 'short');
      break;
    case 'druid':
      if (level >= 2) res('wild-shape', '荒野变形', 2, 'short-one');
      break;
    case 'fighter':
      res('second-wind', '回气', level >= 4 ? 3 : 2, 'short-one');
      if (level >= 2) res('action-surge', '动作如潮', 1, 'short');
      break;
    case 'monk':
      if (level >= 2) res('focus', '功力点', level, 'short');
      if (level >= 2) res('uncanny-metabolism', '奇异代谢', 1, 'long');
      break;
    case 'paladin':
      res('lay-on-hands', '圣疗（生命值池）', 5 * level, 'long');
      if (level >= 3) res('channel-divinity', '引导神力', 2, 'short-one');
      break;
    case 'sorcerer':
      res('innate-sorcery', '先天术法', 2, 'long');
      if (level >= 2) res('sorcery-points', '术法点', level, 'long');
      if (level >= 5) res('sorcerous-restoration', '术法复苏', 1, 'long');
      break;
    case 'warlock':
      if (level >= 2) res('magical-cunning', '魔法诡计', 1, 'long');
      break;
    case 'wizard':
      res('arcane-recovery', '奥术回复', 1, 'long');
      break;
  }
  switch (card.species) {
    case 'dragonborn':
      res('breath-weapon', '吐息武器', pb, 'long');
      if (level >= 5) res('draconic-flight', '龙族飞行', 1, 'long');
      break;
    case 'dwarf':
      res('stonecunning', '石工知识', pb, 'long');
      break;
    case 'goliath':
      res('giant-ancestry', '巨人祖先', pb, 'long');
      if (level >= 5) res('large-form', '巨大形态', 1, 'long');
      break;
    case 'orc':
      res('adrenaline-rush', '肾上腺素爆发', pb, 'short');
      res('relentless-endurance', '坚韧不屈', 1, 'long');
      break;
  }

  // ---------- 特性列表 ----------
  const features: Sheet5e['features'] = [];
  for (const l of cls.levels) {
    if (l.level > level) continue;
    for (const k of l.features) features.push({ key: k, name: rules.features[k]?.name ?? k, source: `${cls.name} ${l.level} 级` });
  }
  if (sub) for (const f of sub.features) if (f.level <= level) features.push({ key: f.key, name: rules.features[f.key]?.name ?? f.key, source: sub.name });
  // 亚种有自己的黑暗视觉（卓尔 120 尺）时，种族本来的那条不列；血统法术到了那一级才列
  const lineageTraits = lineage?.traits ?? [];
  const lineageDark = lineageTraits.some((t) => t.startsWith('darkvision-'));
  for (const t of species?.traits ?? []) {
    if (lineageDark && t.startsWith('darkvision-')) continue;
    features.push({ key: t, name: rules.traits[t]?.name ?? t, source: species!.name });
  }
  for (const t of lineageTraits) {
    const spell = /^lineage-spell-(.+)$/.exec(t)?.[1];
    if (spell && ((LINEAGE_SPELLS[card.lineage ?? ''] ?? []).find((x) => x.spell === spell)?.level ?? 1) > level) continue;
    features.push({ key: t, name: rules.traits[t]?.name ?? t, source: lineage!.name });
  }
  for (const f of feats) {
    const fd = rules.feats.find((x) => x.key === f);
    if (fd) features.push({ key: fd.key, name: fd.name, source: '专长' });
  }
  for (const inv of card.invocations ?? []) {
    const o = rules.invocations.find((x) => x.key === inv.key);
    if (o) features.push({ key: o.key, name: o.name, source: '魔能祈唤' });
  }
  for (const m of card.metamagic ?? []) {
    const o = rules.metamagic.find((x) => x.key === m);
    if (o) features.push({ key: o.key, name: o.name, source: '超魔' });
  }

  // ---------- 抗性 ----------
  const resist = new Set<DamageType>();
  if (card.species === 'dwarf') resist.add('poison');
  if (lineage?.damageType && card.species === 'dragonborn') resist.add(lineage.damageType);
  if (card.lineage === 'fiendish-legacy-abyssal') resist.add('poison');
  if (card.lineage === 'fiendish-legacy-chthonic') resist.add('necrotic');
  if (card.lineage === 'fiendish-legacy-infernal') resist.add('fire');

  // ---------- 熟练 ----------
  const ARMOR_NAME: Record<string, string> = { light: '轻甲', medium: '中甲', heavy: '重甲', shield: '盾牌' };
  const armorKinds = (['light', 'medium', 'heavy', 'shield'] as const).filter((k) => armorTrained(card, cls, k));
  const weaponKinds = cls.weapons.map((w) => (w === 'simple' ? '简易武器' : w === 'martial' ? '军用武器' : w === 'martial-light' ? '有轻型属性的军用武器' : '有灵巧或轻型属性的军用武器'));
  if ((card.order === 'protector' || card.order === 'warden') && !cls.weapons.includes('martial')) weaponKinds.push('军用武器');
  // 吟游诗人：三种乐器；武僧：一种工匠工具或乐器（这一版不细分是哪一种）
  const TOOL_NAME: Record<string, string> = { 'musical-instrument': '三种乐器', 'artisans-tools-or-instrument': '一种工匠工具或乐器' };
  const tools = [...cls.tools, ...(background?.tool ? [background.tool] : [])].map((t) => TOOL_NAME[t] ?? rules.gear.find((g) => g.key === t)?.name ?? t);

  const initiative = mods.dex + (feats.includes('alert-2014') ? 5 : feats.includes('alert') ? pb : 0);

  return {
    level,
    totalLevel: total,
    pb,
    className: cls.name,
    subclassName: sub?.name ?? null,
    speciesName: lineage ? `${species?.name ?? ''}（${lineage.name}）` : (species?.name ?? ''),
    backgroundName: background?.name ?? '',
    abilities,
    mods,
    saves,
    skills,
    passivePerception,
    hpMax,
    hitDie,
    speed,
    size,
    darkvision,
    ac,
    acNote: acParts.join(' + '),
    stealthDis: bodyArmor?.stealthDisadvantage ? bodyArmor.name : null,
    initiative,
    attacks,
    spell,
    resources,
    features,
    resist: [...resist],
    proficiencies: { armor: armorKinds.map((k) => ARMOR_NAME[k]), weapons: weaponKinds, tools },
    todo: cardProblems(card, rules, { todoOnly: true }),
  };
}

/** 这个法术用哪项属性施放（职业的，或者血统、专长给的）。 */
export function spellAbility(sheet: Sheet5e, spellKey: string): Ability {
  return sheet.spell?.abilityOf[spellKey] ?? sheet.spell?.ability ?? 'int';
}

// ==================== 检查卡上的选择 ====================

/** 做卡的哪一步：职业、种族、背景、属性、技能、职业特性、法术、装备。 */
export type CardSection = 'class' | 'species' | 'background' | 'abilities' | 'feats' | 'skills' | 'features' | 'spells' | 'equipment';

/** 卡上的一个问题：在哪一步、还没选（todo）还是选错了。 */
export type CardIssue = { section: CardSection; text: string; todo: boolean };

/**
 * 检查卡上的选择对不对，返回问题列表（空的就是没问题）。
 * todoOnly：只列「还没选」的（升级以后要补的选择），给角色页提醒用。
 */
export function cardProblems(card: Card5eData, rules: RulesData, opts: { todoOnly?: boolean } = {}): string[] {
  return cardIssues(card, rules)
    .filter((i) => i.todo || !opts.todoOnly)
    .map((i) => i.text);
}

/** 同 cardProblems，但每个问题带着它在做卡的哪一步（网页做卡时在每一步旁边标出来）。 */
export function cardIssues(card: Card5eData, rules: RulesData): CardIssue[] {
  const issues: CardIssue[] = [];
  let section: CardSection = 'class';
  const at = (s: CardSection) => (section = s);
  const todo = (msg: string) => issues.push({ section, text: msg, todo: true });
  const bad = (msg: string) => issues.push({ section, text: msg, todo: false });
  const out = issues;
  const level = card.level;
  const classMaxLevel = maxLevelFor(card.class);
  if (!Number.isInteger(level) || level < 1 || level > classMaxLevel) {
    bad(`等级要在 1～${classMaxLevel} 之间`);
    return out;
  }
  const cls = classOf(rules, card.class);
  if (!cls) {
    bad('没有这个职业');
    return out;
  }
  const multiclass = card.multiclass ?? [];
  const total = totalLevel(card);
  if (total > 20) bad(`总等级不能超过 20（现在 ${total}）`);
  const seenClasses = new Set<string>([card.class]);
  for (const m of multiclass) {
    if (!classOf(rules, m.class)) bad('兼职里没有这个职业');
    if (seenClasses.has(m.class)) bad('同一个职业不能重复兼职');
    seenClasses.add(m.class);
    if (!Number.isInteger(m.level) || m.level < 1 || m.level > maxLevelFor(m.class)) bad(`兼职 ${m.class} 的等级不对`);
  }
  // 兼职属性不达标不再禁止；对应职业动作会在结算时带劣势。
  if (card.class === 'cleric') {
    if (!card.deity) todo('选一个神祇');
    else if (!DEITIES.some((d) => d.key === card.deity)) bad('没有这个神祇');
  } else if (card.deity) {
    bad('只有牧师能选神祇');
  }
  at('species');
  const species = rules.species.find((s) => s.key === card.species);
  if (!species) bad('没有这个种族');
  at('background');
  const background = rules.backgrounds.find((b) => b.key === card.background);
  if (!background) bad('没有这个背景');
  if (background) {
    const need = background.languageChoices ?? 0;
    const chosen = card.languages ?? [];
    if (chosen.length > need) bad(`背景「${background.name}」最多选 ${need} 门语言`);
    else if (chosen.length < need) todo(`背景「${background.name}」要选 ${need} 门语言`);
    if (new Set(chosen).size !== chosen.length) bad('背景语言不能重复');
    for (const l of chosen) if (!(LANGUAGE_KEYS as string[]).includes(l)) bad('有不认识的背景语言');
  }

  // ---------- 种族 ----------
  at('species');
  if (species?.lineages.length) {
    if (!card.lineage) todo(`选一个${species.lineageLabel ?? '亚种'}`);
    else if (!species.lineages.some((l) => l.key === card.lineage)) bad(`${species.name}没有这个${species.lineageLabel ?? '亚种'}`);
  } else if (card.lineage) bad(`${species?.name ?? '这个种族'}没有亚种可选`);
  if (['elf', 'gnome', 'tiefling'].includes(card.species) && !MENTAL.includes(card.lineageAbility as Ability)) todo('选血统法术用的施法属性（智力、感知或魅力）');
  if (card.size !== 'medium' && card.size !== 'small') bad('体型只能是中型或小型');
  else if (species && species.size !== 'choice' && card.size !== species.size) bad(`${species.name}的体型是${species.size === 'small' ? '小型' : '中型'}`);

  // 种族给的属性值加成（半精灵）：固定的要照写，另外选的项数、每项加值、不能选的属性都要对
  const speciesBonus = card.speciesBonus ?? {};
  const abilityBonus = species?.abilityBonus;
  if (abilityBonus) {
    const fixed = abilityBonus.fixed;
    for (const a of ABILITIES) {
      const v = Number(speciesBonus[a] ?? 0);
      if (fixed[a] !== undefined) {
        if (v !== fixed[a]) bad(`${species?.name}的${ABILITY_NAME[a]}固定加 ${fixed[a]}`);
      } else if (v) {
        if (abilityBonus.exclude?.includes(a)) bad(`${species?.name}的${ABILITY_NAME[a]}不能再加`);
        else if (v !== abilityBonus.each) bad(`${species?.name}另外选的属性每项加 ${abilityBonus.each}`);
      }
    }
    const chosen = ABILITIES.filter((a) => fixed[a] === undefined && Number(speciesBonus[a] ?? 0) > 0);
    if (chosen.length > abilityBonus.choose) bad(`${species?.name}另外只能选 ${abilityBonus.choose} 项属性`);
    else if (chosen.length < abilityBonus.choose) todo(`${species?.name}还要选 ${abilityBonus.choose - chosen.length} 项属性各加 ${abilityBonus.each}`);
  } else if (Object.values(speciesBonus).some((v) => Number(v ?? 0) !== 0)) {
    bad(`${species?.name ?? '这个种族'}没有属性值加成`);
  }

  // 种族给的技能（半精灵两项）
  const speciesSkills = card.speciesSkills ?? [];
  const skillNeed = species?.skillChoices ?? 0;
  if (speciesSkills.length > skillNeed) bad(`${species?.name}最多 ${skillNeed} 项种族技能`);
  else if (speciesSkills.length < skillNeed) todo(`${species?.name}还要选 ${skillNeed - speciesSkills.length} 项种族技能`);
  if (new Set(speciesSkills).size !== speciesSkills.length) bad('种族技能不能重复');
  for (const s of speciesSkills) if (!isSkill(s)) bad('有不认识的种族技能');

  // 种族语言：固定的以外，还能自选几门
  const speciesLanguages = card.speciesLanguages ?? [];
  const languageChoices = species?.languages?.choices ?? 0;
  const fixedLanguages = species?.languages?.fixed ?? [];
  if (speciesLanguages.length > languageChoices) bad(`${species?.name}最多选 ${languageChoices} 门种族语言`);
  else if (speciesLanguages.length < languageChoices) todo(`${species?.name}还要选 ${languageChoices - speciesLanguages.length} 门种族语言`);
  if (new Set(speciesLanguages).size !== speciesLanguages.length) bad('种族语言不能重复');
  for (const l of speciesLanguages) if (!isLanguage(l)) bad('有不认识的种族语言');
  for (const l of speciesLanguages) if (fixedLanguages.includes(l)) bad(`${LANGUAGE_NAME[l]}已经会了，不用再选`);

  // ---------- 属性 ----------
  at('abilities');
  const base = card.base ?? ({} as Abilities);
  const values = ABILITIES.map((a) => base[a]);
  if (values.some((v) => !Number.isInteger(v))) bad('六项属性都要填整数');
  else if (card.method === 'array') {
    const sorted = [...values].sort((x, y) => y - x);
    if (sorted.join() !== STANDARD_ARRAY.join()) bad(`标准数组要把 ${STANDARD_ARRAY.join('、')} 各用一次`);
  } else if (card.method === 'pointbuy') {
    if (values.some((v) => v < 8 || v > 15)) bad('购点时每项属性在 8～15 之间');
    else {
      const cost = values.reduce((s, v) => s + POINT_BUY_COST[v], 0);
      if (cost > POINT_BUY_TOTAL) bad(`购点一共 ${POINT_BUY_TOTAL} 点，现在用了 ${cost} 点`);
    }
  } else bad('属性要用标准数组或者购点');
  if (background) {
    const bonus = Object.entries(card.bgBonus ?? {}).filter(([, v]) => v);
    const amounts = bonus.map(([, v]) => Number(v)).sort((x, y) => y - x);
    if (bonus.some(([k]) => !background.abilities.includes(k as Ability))) bad(`背景「${background.name}」只能加 ${background.abilities.map((a) => ABILITY_NAME[a]).join('、')}`);
    else if (!(amounts.join() === '2,1' || amounts.join() === '1,1,1')) todo('背景的属性加值：在背景的三项里一项 +2、一项 +1，或者三项各 +1');
  }
  const need = asiCount(level, card.class);
  if ((card.asi ?? []).length > need) bad(`${level} 级最多 ${need} 次属性值提升`);
  else if ((card.asi ?? []).length < need) todo('4 级的属性值提升：一项 +2，或者两项各 +1');
  const asiFeats = card.asiFeats ?? [];
  if (asiFeats.length > (card.asi ?? []).length) bad('专长不能多于属性值提升次数');
  const seenFeats = new Set<string>();
  const seenDamage = new Set<string>();
  for (let i = 0; i < (card.asi ?? []).length; i++) {
    const x = card.asi![i] ?? {};
    const feat = asiFeats[i];
    if (feat?.key) {
      if (Object.keys(x).length) bad('同一项属性提升不能既加属性又选专长');
      const data = rules.feats.find((f) => f.key === feat.key);
      if (!data) bad(`没有这个专长：${feat.key}`);
      else if (data.type !== 'general') bad('这里只能选通用专长');
      else if (seenFeats.has(feat.key) && !['ability-score-improvement', 'skilled', 'elemental-adept'].includes(feat.key)) bad(`专长「${data.name}」不能重复选`);
      if (feat.key === 'elemental-adept') {
        if (!feat.damageType) bad('元素导师要选一种伤害类型');
        else if (seenDamage.has(feat.damageType)) bad('元素导师每次要选不同的伤害类型');
        else seenDamage.add(feat.damageType);
      }
      if (feat.key === 'weapon-master' && (feat.weapons ?? []).length !== 4) bad('武器大师要选 4 种武器');
      if (feat.key === 'ritual-caster' && (!feat.list || (feat.rituals ?? []).length !== 2)) bad('仪式施法者要选职业和 2 个仪式法术');
      if (feat.key === 'spell-sniper' && (!feat.list || !feat.cantrip)) bad('法术射手要选职业和 1 个攻击戏法');
      // 专长先决条件只作说明，不阻止选择；是否生效由主持人/结算判断。
      seenFeats.add(feat.key);
    } else {
      const amounts = Object.values(x)
        .filter((v) => v)
        .map(Number)
        .sort((a, b) => b - a);
      if (!(amounts.join() === '2' || amounts.join() === '1,1')) bad('属性值提升：一项 +2，或者两项各 +1');
      if (Object.keys(x).some((k) => !isAbility(k))) bad('属性值提升里有不认识的属性');
    }
  }
  const finals = finalAbilities(card);
  const raw = ABILITIES.map(
    (a) =>
      Number(base[a] ?? 8) +
      Number(card.speciesBonus?.[a] ?? 0) +
      Number(card.bgBonus?.[a] ?? 0) +
      (card.asi ?? []).reduce((s, x) => s + Number(x?.[a] ?? 0), 0) +
      (card.asiFeats ?? []).filter((f) => f.ability === a).length,
  );
  const primal = card.class === 'barbarian' && level >= 20;
  if (raw.some((v, i) => v > (primal && (ABILITIES[i] === 'str' || ABILITIES[i] === 'con') ? 24 : ABILITY_SCORE_MAX))) {
    bad(`属性最高 ${primal ? '24（力量、体质）或 20（其他）' : ABILITY_SCORE_MAX}`);
  }
  void finals;

  // ---------- 技能 ----------
  at('skills');
  const taken = new Map<Skill, string>();
  const take = (s: Skill, from: string) => {
    if (!isSkill(s)) return bad(`没有这个技能：${String(s)}`);
    const before = taken.get(s);
    if (before) bad(`${SKILL_NAME[s]}已经从${before}拿到了，${from}要换一个`);
    else taken.set(s, from);
  };
  for (const s of background?.skills ?? []) take(s, `背景「${background!.name}」`);
  const classSkills = card.classSkills ?? [];
  if (classSkills.length !== cls.skillCount) todo(`${cls.name}要选 ${cls.skillCount} 个技能（现在 ${classSkills.length} 个）`);
  for (const s of classSkills) {
    if (cls.skillOptions.length && !cls.skillOptions.includes(s)) bad(`${SKILL_NAME[s] ?? s}不在${cls.name}能选的技能里`);
    take(s, cls.name);
  }
  const bonusNeed: { source: string; label: string; count: number; options: Skill[] | null }[] = [];
  if (card.species === 'elf') bonusNeed.push({ source: 'keen-senses', label: '精灵的敏锐感官', count: 1, options: ['insight', 'perception', 'survival'] });
  if (card.species === 'human') bonusNeed.push({ source: 'skillful', label: '人类的多才', count: 1, options: null });
  if (card.class === 'barbarian' && level >= 3) bonusNeed.push({ source: 'primal-knowledge', label: '野蛮人 3 级的原初学识', count: 1, options: cls.skillOptions });
  if (card.subclass === 'college-of-lore' && level >= 3) bonusNeed.push({ source: 'lore-bonus-proficiencies', label: '逸闻学院的额外熟练', count: 3, options: null });
  for (const n of bonusNeed) {
    const got = (card.bonusSkills ?? []).filter((b) => b.source === n.source);
    if (got.length !== n.count) todo(`${n.label}：选 ${n.count} 个技能`);
    for (const g of got) {
      if (n.options && !n.options.includes(g.skill)) bad(`${n.label}只能从 ${n.options.map((s) => SKILL_NAME[s]).join('、')} 里选`);
      take(g.skill, n.label);
    }
  }
  for (const b of card.bonusSkills ?? []) if (!bonusNeed.some((n) => n.source === b.source)) bad(`多了一个技能选择（${b.source}）`);

  // ---------- 起源专长 ----------
  at('background');
  const feats = card.originFeats ?? [];
  if (background) {
    const f = feats.find((x) => x.source === 'background');
    if (!f || f.key !== background.feat) bad(`背景「${background.name}」给的起源专长是固定的`);
  }
  at('species');
  const speciesFeat = feats.filter((x) => x.source === 'species');
  if (card.species === 'human') {
    if (speciesFeat.length !== 1) todo('人类的「多才多艺」：再选一个起源专长');
  } else if (speciesFeat.length) bad('只有人类能多选一个起源专长');
  for (const f of feats) {
    at(f.source === 'background' ? 'background' : f.source === 'species' ? 'species' : 'features');
    checkOriginFeat(f, f.source === 'background' ? (background?.featList ?? null) : null, rules, take, bad, todo);
  }
  if (feats.filter((f) => f.key !== 'magic-initiate').length !== new Set(feats.filter((f) => f.key !== 'magic-initiate').map((f) => f.key)).size) bad('同一个起源专长（魔法学徒以外）只能拿一次');

  // ---------- 专精 ----------
  at('skills');
  const expNeed = expertiseCount(card.class, level);
  const expertise = card.expertise ?? [];
  if (expertise.length > expNeed) bad(`${cls.name} ${level} 级最多 ${expNeed} 个专精`);
  else if (expertise.length < expNeed) todo(`选 ${expNeed} 个专精（现在 ${expertise.length} 个）`);
  if (new Set(expertise).size !== expertise.length) bad('专精不能重复');
  for (const s of expertise) if (!taken.has(s)) bad(`专精要选已经熟练的技能（${SKILL_NAME[s] ?? s}还不熟练）`);
  if (card.class === 'wizard' && level >= 2 && expertise.length && !SCHOLAR_SKILLS.includes(expertise[0])) bad(`法师的「学者」只能从 ${SCHOLAR_SKILLS.map((s) => SKILL_NAME[s]).join('、')} 里选`);

  // ---------- 子职业、职责、战斗风格、精通 ----------
  at('features');
  if (level >= SUBCLASS_LEVEL) {
    const sub = rules.subclasses.find((s) => s.key === card.subclass);
    if (!card.subclass) todo('3 级：选一个子职业');
    else if (!sub || sub.class !== card.class) bad('没有这个子职业');
  } else if (card.subclass) bad('3 级才能选子职业');
  if (card.subclass === 'path-of-the-totem-warrior' && level >= 3) {
    if (!card.totem) todo('图腾武者 3 级：选一个图腾精魄（熊、鹰或狼）');
    else if (!isTotem(card.totem)) bad('没有这个图腾精魄');
  } else if (card.totem) {
    bad('只有图腾武者道途能选图腾精魄');
  }
  if (card.class === 'cleric' || card.class === 'druid') {
    const ok = card.class === 'cleric' ? ['protector', 'thaumaturge'] : ['magician', 'warden'];
    if (!card.order) todo(card.class === 'cleric' ? '选神圣职责（护卫者或奇术师）' : '选原初职责（秘术师或守护者）');
    else if (!ok.includes(card.order)) bad('职责选得不对');
  } else if (card.order) bad('这个职业没有职责可选');
  const styleLevel = fightingStyleLevel(card.class);
  if (styleLevel && level >= styleLevel) {
    const special = card.class === 'paladin' ? 'blessed-warrior' : card.class === 'ranger' ? 'druidic-warrior' : null;
    if (!card.fightingStyle) todo('选一个战斗风格');
    else if (card.fightingStyle !== special && rules.feats.find((f) => f.key === card.fightingStyle)?.type !== 'fighting-style') bad('没有这个战斗风格');
    if (card.fightingStyle && card.fightingStyle === special) {
      const list = card.fightingStyle === 'blessed-warrior' ? 'cleric' : 'druid';
      const cs = card.styleCantrips ?? [];
      if (cs.length !== 2) todo(`${card.fightingStyle === 'blessed-warrior' ? '神佑战士' : '德鲁伊战士'}：选两个${list === 'cleric' ? '牧师' : '德鲁伊'}戏法`);
      for (const c of cs) if (!rules.spells.some((s) => s.key === c && s.level === 0 && s.classes.includes(list))) bad(`「${c}」不是${list === 'cleric' ? '牧师' : '德鲁伊'}戏法`);
    } else if ((card.styleCantrips ?? []).length) bad('只有神佑战士、德鲁伊战士要选戏法');
  } else if (card.fightingStyle) bad(`${cls.name}${styleLevel ? `要到 ${styleLevel} 级才有` : '没有'}战斗风格`);
  const mCount = masteryCount(card.class, level);
  const masteries = card.masteries ?? [];
  if (masteries.length > mCount) bad(`${cls.name} ${level} 级最多精通 ${mCount} 种武器`);
  else if (masteries.length < mCount) todo(`选 ${mCount} 种精通的武器（现在 ${masteries.length} 种）`);
  if (new Set(masteries).size !== masteries.length) bad('精通的武器不能重复');
  for (const m of masteries) {
    const w = rules.weapons.find((x) => x.key === m);
    if (!w) bad(`没有这种武器：${m}`);
    else if (card.class === 'barbarian' && w.ranged) bad('野蛮人只能精通近战武器');
    else if (!weaponProficient(card, cls, w)) bad(`${w.name}不熟练，不能精通`);
  }

  // ---------- 法术 ----------
  at('spells');
  checkSpells(card, cls, level, rules, bad, todo, at);

  // ---------- 别的选择 ----------
  at('features');
  if (card.class === 'sorcerer' && level >= 2) {
    const mm = card.metamagic ?? [];
    if (mm.length !== 2) todo('选两个超魔');
    if (new Set(mm).size !== mm.length) bad('超魔不能重复');
    for (const m of mm) if (!rules.metamagic.some((x) => x.key === m)) bad(`没有这个超魔：${m}`);
  } else if ((card.metamagic ?? []).length) bad('只有 2 级以上的术士有超魔');
  if (card.subclass === 'hunter' && level >= 3) {
    if (!card.hunterPrey) todo('猎人 3 级：选「猎人猎物」（巨像杀手或破阵者）');
    else if (!['colossus-slayer', 'horde-breaker'].includes(card.hunterPrey)) bad('「猎人猎物」选得不对');
  } else if (card.hunterPrey) bad('只有 3 级以上的猎人选「猎人猎物」');
  if (card.subclass === 'circle-of-the-land' && level >= 3) {
    if (!card.land) todo('大地结社 3 级：选一种地形');
    else if (!['arid', 'polar', 'temperate', 'tropical'].includes(card.land)) bad('地形选得不对');
  } else if (card.land) bad('只有 3 级以上的大地结社德鲁伊选地形');
  if (card.class === 'druid' && level >= 2) {
    const { count, maxCr } = wildShapeForms(level);
    const ws = card.wildShapes ?? [];
    if (ws.length !== count) todo(`荒野变形：选 ${count} 种野兽形态（现在 ${ws.length} 种）`);
    if (new Set(ws).size !== ws.length) bad('野兽形态不能重复');
    for (const k of ws) {
      const b = rules.beasts.find((x) => x.key === k);
      if (!b) bad(`没有这种野兽：${k}`);
      else if (b.cr > maxCr || b.fly) bad(`${b.name}变不了（挑战等级要在 ${maxCr === 0.25 ? '1/4' : '1/2'} 以下、不会飞）`);
    }
  } else if ((card.wildShapes ?? []).length) bad('只有 2 级以上的德鲁伊有荒野变形');

  // ---------- 装备 ----------
  at('equipment');
  if (!cls.equipment[card.equipmentChoice?.class ?? -1]) bad('起始装备（职业）选得不对');
  if (background && !background.equipment[card.equipmentChoice?.background ?? -1]) bad('起始装备（背景）选得不对');
  const inv = new Map((card.inventory ?? []).map((i) => [i.key, i.qty]));
  const eq = card.equipped ?? { armor: null, shield: null, main: null, off: null };
  for (const [slot, key] of Object.entries(eq)) if (key && !inv.get(key)) bad(`身上没有「${itemName(rules, key)}」，不能${slot === 'armor' ? '穿' : '拿'}`);
  const armor = armorOf(rules, eq.armor);
  if (eq.armor && (!armor || armor.kind === 'shield')) bad('护甲那一格只能放护甲');
  const shield = armorOf(rules, eq.shield);
  if (eq.shield && (!shield || shield.kind !== 'shield')) bad('盾牌那一格只能放盾牌');
  if (eq.main && !weaponOf(rules, eq.main)) bad('主手只能拿武器');
  if (eq.off && !weaponOf(rules, eq.off)) bad('副手只能拿武器（盾牌放进盾牌那一格）');
  if (!Number.isInteger(card.money) || card.money < 0) bad('钱数不对');
  return out;
}

function checkOriginFeat(
  f: Card5eData['originFeats'][number],
  fixedList: 'cleric' | 'druid' | 'wizard' | null,
  rules: RulesData,
  take: (s: Skill, from: string) => void,
  bad: (m: string) => void,
  todo: (m: string) => void,
) {
  const feat = rules.feats.find((x) => x.key === f.key);
  if (!feat || feat.type !== 'origin') return bad(`「${f.key}」不是起源专长`);
  if (f.key === 'magic-initiate') {
    const list = fixedList ?? f.list;
    if (!list || !['cleric', 'druid', 'wizard'].includes(list)) return todo('魔法学徒：选牧师、德鲁伊或法师的法术表');
    if (fixedList && f.list && f.list !== fixedList) bad(`这个背景的魔法学徒用${fixedList === 'cleric' ? '牧师' : fixedList === 'druid' ? '德鲁伊' : '法师'}的法术表`);
    if (!MENTAL.includes(f.ability as Ability)) todo('魔法学徒：选施法属性（智力、感知或魅力）');
    const cs = f.cantrips ?? [];
    if (cs.length !== 2) todo('魔法学徒：选两个戏法');
    for (const c of cs) if (!rules.spells.some((s) => s.key === c && s.level === 0 && s.classes.includes(list as ClassKey))) bad(`魔法学徒的戏法要从所选的法术表里挑（${c}）`);
    if (new Set(cs).size !== cs.length) bad('魔法学徒的两个戏法不能一样');
    if (!f.spell) todo('魔法学徒：选一个 1 环法术');
    else if (!rules.spells.some((s) => s.key === f.spell && s.level === 1 && s.classes.includes(list as ClassKey))) bad('魔法学徒的 1 环法术要从所选的法术表里挑');
  } else if (f.key === 'skilled') {
    const ss = f.skills ?? [];
    if (ss.length !== 3) todo('多才多艺：选三个技能');
    for (const s of ss) take(s, '多才多艺');
  }
}

function checkSpells(card: Card5eData, cls: ClassData, level: number, rules: RulesData, bad: (m: string) => void, todo: (m: string) => void, at: (s: CardSection) => void) {
  const sc = cls.spellcasting;
  const cantrips = card.cantrips ?? [];
  const prepared = card.prepared ?? [];
  if (!sc) {
    if (cantrips.length || prepared.length || (card.spellbook ?? []).length) bad(`${cls.name}不施法，不用选法术`);
    return;
  }
  const list = classSpells(rules, card.class);
  const max = maxSpellLevel(cls, level);
  // 每个职业的戏法/准备数量表长度不同；表没写到的高等级先按表的最后一级算。
  const cLevel = Math.min(level, sc.cantrips.length);
  const pLevel = Math.min(level, sc.prepared.length);
  const extra = card.order === 'thaumaturge' || card.order === 'magician' ? 1 : 0;
  const cNeed = sc.cantrips[cLevel - 1] + extra;
  if (cantrips.length > cNeed) bad(`最多 ${cNeed} 个戏法`);
  else if (cantrips.length < cNeed) todo(`选 ${cNeed} 个戏法（现在 ${cantrips.length} 个）`);
  if (new Set(cantrips).size !== cantrips.length) bad('戏法不能重复');
  for (const c of cantrips) if (!list.some((s) => s.key === c && s.level === 0)) bad(`「${rules.spells.find((s) => s.key === c)?.name ?? c}」不是${cls.name}的戏法`);
  const always = alwaysPrepared({ class: card.class, subclass: level >= 3 ? card.subclass : null, land: card.land, level });
  const pNeed = sc.prepared[pLevel - 1];
  if (prepared.length > pNeed) bad(`最多准备 ${pNeed} 个 1 环以上的法术（总是准备好的不算）`);
  else if (prepared.length < pNeed) todo(`准备 ${pNeed} 个 1 环以上的法术（现在 ${prepared.length} 个）`);
  if (new Set(prepared).size !== prepared.length) bad('准备的法术不能重复');
  for (const p of prepared) {
    const s = list.find((x) => x.key === p);
    if (!s || s.level === 0) bad(`「${rules.spells.find((x) => x.key === p)?.name ?? p}」不是${cls.name}的 1 环以上法术`);
    else if (s.level > max) bad(`「${s.name}」是 ${s.level} 环，${level} 级的${cls.name}还用不了`);
    if (always.includes(p)) bad(`「${rules.spells.find((x) => x.key === p)?.name ?? p}」本来就总是准备好的，不用再占名额`);
  }
  // 吟游诗人的魔法奥秘：任意职业的法术，算在已知/准备之外，单独检查
  const secretNeed = card.class === 'bard' ? magicalSecretsCount(level, card.subclass) : 0;
  const secrets = card.magicalSecrets ?? [];
  if (card.class !== 'bard' && secrets.length) bad('只有吟游诗人有魔法奥秘');
  if (secrets.length > secretNeed) bad(`魔法奥秘最多 ${secretNeed} 个法术`);
  else if (secrets.length < secretNeed) todo(`魔法奥秘：再选 ${secretNeed - secrets.length} 个法术`);
  if (new Set(secrets).size !== secrets.length) bad('魔法奥秘里的法术不能重复');
  for (const key of secrets) {
    const spell = rules.spells.find((s) => s.key === key);
    if (!spell) bad(`没有这个法术：${key}`);
    else if (spell.level > max) bad(`《${spell.name}》是 ${spell.level} 环，现在还用不了`);
  }
  // 种族（血统）、魔法学徒已经给了的，职业的戏法、准备的法术不用再选（选了就白白占一个名额）
  const nameOf = (k: string) => rules.spells.find((x) => x.key === k)?.name ?? k;
  const fromLineage = (LINEAGE_SPELLS[card.lineage ?? ''] ?? []).filter((x) => x.level <= level).map((x) => x.spell);
  const fromInitiate = magicInitiates(card).flatMap((f) => [...(f.cantrips ?? []), ...(f.spell ? [f.spell] : [])]);
  for (const k of new Set([...cantrips, ...prepared])) {
    if (fromLineage.includes(k)) bad(`「${nameOf(k)}」种族已经给了，换一个别的`);
    else if (fromInitiate.includes(k)) bad(`「${nameOf(k)}」魔法学徒已经给了，换一个别的`);
  }
  for (const k of fromInitiate) if (fromLineage.includes(k) || always.includes(k)) bad(`魔法学徒的「${nameOf(k)}」本来就有了，换一个别的`);
  if (card.class === 'wizard') {
    const book = card.spellbook ?? [];
    const savant = card.subclass === 'evoker' && level >= 3 ? (level >= 5 ? 3 : 2) : 0;
    const bookNeed = 6 + 2 * (pLevel - 1) + savant;
    if (book.length > bookNeed) bad(`法术书里最多 ${bookNeed} 个法术`);
    else if (book.length < bookNeed) todo(`法术书要有 ${bookNeed} 个法术（现在 ${book.length} 个）`);
    if (new Set(book).size !== book.length) bad('法术书里的法术不能重复');
    for (const b of book) {
      const s = list.find((x) => x.key === b);
      if (!s || s.level === 0) bad(`「${rules.spells.find((x) => x.key === b)?.name ?? b}」不能写进法术书`);
      else if (s.level > max) bad(`「${s.name}」是 ${s.level} 环，现在还写不进法术书`);
    }
    for (const p of prepared) if (!book.includes(p)) bad(`法师只能准备法术书里的法术（「${rules.spells.find((x) => x.key === p)?.name ?? p}」不在书里）`);
    if (savant) {
      const evocations = book.filter((b) => rules.spells.find((s) => s.key === b)?.school === 'evocation').length;
      if (evocations < savant) todo(`塑能师：法术书里要有至少 ${savant} 个塑能系法术`);
    }
  } else if ((card.spellbook ?? []).length) bad('只有法师有法术书');
  at('features');
  if (card.class === 'warlock') {
    const invs = card.invocations ?? [];
    const iNeed = invocationCount(level);
    if (invs.length > iNeed) bad(`${level} 级最多 ${iNeed} 个魔能祈唤`);
    else if (invs.length < iNeed) todo(`选 ${iNeed} 个魔能祈唤（现在 ${invs.length} 个）`);
    const keys = invs.map((i) => i.key);
    for (const inv of invs) {
      const o = rules.invocations.find((x) => x.key === inv.key);
      if (!o) {
        bad(`没有这个魔能祈唤：${inv.key}`);
        continue;
      }
      if ((o.level ?? 1) > level) bad(`「${o.name}」要 ${o.level} 级`);
      if (!o.repeatable && keys.filter((k) => k === inv.key).length > 1) bad(`「${o.name}」只能选一次`);
      if (o.requires === 'pact-of-the-blade' || o.requires === 'pact-of-the-chain') {
        if (!keys.includes(o.requires)) bad(`「${o.name}」要先有「${rules.invocations.find((x) => x.key === o.requires)?.name ?? o.requires}」`);
      }
      if (o.requires === 'damage-cantrip' || o.requires === 'attack-cantrip') {
        const s = rules.spells.find((x) => x.key === inv.cantrip);
        const ok = !!s && s.level === 0 && cantrips.includes(s.key) && !!s.mech?.damage && (o.requires === 'damage-cantrip' || !!s.mech.attack);
        if (!inv.cantrip) todo(`「${o.name}」：选一个会造成伤害${o.requires === 'attack-cantrip' ? '、要掷攻击' : ''}的邪术师戏法`);
        else if (!ok) bad(`「${o.name}」选的戏法不合适`);
      }
      if (o.key === 'lessons-of-the-first-ones') {
        if (!inv.feat) todo('太初者课程：选一个起源专长');
      }
    }
    const repeats = invs.filter((i) => i.cantrip).map((i) => `${i.key}:${i.cantrip}`);
    if (new Set(repeats).size !== repeats.length) bad('同一个魔能祈唤要选不同的戏法');
    if (keys.includes('pact-of-the-tome')) {
      const tome = card.tome;
      if (!tome || tome.cantrips.length !== 3 || tome.rituals.length !== 2) todo('魔典契约：选三个戏法、两个 1 环仪式法术');
      for (const c of tome?.cantrips ?? []) if (!rules.spells.some((s) => s.key === c && s.level === 0)) bad(`魔典的「${c}」不是戏法`);
      for (const r of tome?.rituals ?? []) if (!rules.spells.some((s) => s.key === r && s.level === 1 && s.ritual)) bad(`魔典的「${r}」不是 1 环仪式法术`);
    } else if (card.tome) bad('没有魔典契约，不用选魔典的法术');
  } else if ((card.invocations ?? []).length) bad('只有邪术师有魔能祈唤');
}

// ==================== 做卡时的起始物品 ====================

/** 起始装备：职业、背景选的那两套合起来（套组拆开）；钱另算。 */
export function startingInventory(card: Pick<Card5eData, 'class' | 'background' | 'equipmentChoice'>, rules: RulesData): { inventory: Card5eData['inventory']; money: number } {
  const cls = classOf(rules, card.class);
  const bg = rules.backgrounds.find((b) => b.key === card.background);
  const a = cls?.equipment[card.equipmentChoice.class];
  const b = bg?.equipment[card.equipmentChoice.background];
  const items = new Map<string, number>();
  const add = (key: string, qty: number) => {
    const pack = rules.gear.find((g) => g.key === key && g.kind === 'pack');
    if (pack && pack.contents.length) for (const c of pack.contents) add(c.key, c.qty * qty);
    else items.set(key, (items.get(key) ?? 0) + qty);
  };
  for (const it of [...(a?.items ?? []), ...(b?.items ?? [])]) add(it.key, it.qty);
  return { inventory: [...items].map(([key, qty]) => ({ key, qty })), money: (a?.money ?? 0) + (b?.money ?? 0) };
}

/** 起始装备里自动穿上的：受过训练的最好的护甲、盾牌，主手拿第一件武器。 */
export function autoEquip(card: Card5eData, rules: RulesData): Card5eData['equipped'] {
  const cls = classOf(rules, card.class);
  const eq: Card5eData['equipped'] = { armor: null, shield: null, main: null, off: null, feet: null, ring1: null, ring2: null, necklace: null };
  if (!cls) return eq;
  const abilities = finalAbilities(card);
  let bestAc = -1;
  for (const it of card.inventory) {
    const a = armorOf(rules, it.key);
    if (!a) continue;
    if (!armorTrained(card, cls, a.kind)) continue;
    if (a.kind === 'shield') {
      // 武僧、拿双手武器为主的不拿盾牌（武僧拿盾牌会丢掉无甲防御和武艺）
      if (card.class !== 'monk') eq.shield = it.key;
      continue;
    }
    if (a.strMin && abilities.str < a.strMin) continue;
    const dex = abilityMod(abilities.dex);
    const ac = a.ac + (a.dexMax === null ? dex : Math.min(dex, a.dexMax)) + a.plus;
    if (ac > bestAc) {
      bestAc = ac;
      eq.armor = it.key;
    }
  }
  // 野蛮人、武僧不穿甲更好时脱掉
  if (eq.armor && (card.class === 'barbarian' || card.class === 'monk')) {
    const m = (x: Ability) => abilityMod(abilities[x]);
    const unarmored = 10 + m('dex') + (card.class === 'barbarian' ? m('con') : m('wis'));
    if (unarmored >= bestAc) eq.armor = null;
  }
  const weapons = card.inventory.map((i) => weaponOf(rules, i.key)).filter((w): w is NonNullable<typeof w> => !!w);
  const main = weapons.find((w) => !w.ranged) ?? weapons[0];
  if (main) eq.main = main.itemKey;
  if (main?.properties.includes('two-handed') && eq.shield) eq.shield = null;
  return eq;
}

/** 给人看的属性摘要：「力量 15（+2）」。 */
export function abilityLine(score: number): string {
  return `${score}（${signed(abilityMod(score))}）`;
}
