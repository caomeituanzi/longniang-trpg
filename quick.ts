// 5E 角色卡的「推荐配置」（V0.9.0）：给一个职业按常见的玩法把每一项都选好（种族矮人、背景士兵或罪犯、标准数组）。
// 做卡页的「按推荐填好」和自动测试用；做出来的卡要能通过 cardProblems。
import { ABILITIES, LANGUAGE_KEYS, STANDARD_ARRAY, maxLevelFor, xpForLevel, type Abilities, type Ability, type Skill } from './core';
import { DEITIES } from './deities';
import { LINEAGE_SPELLS, SCHOLAR_SKILLS, alwaysPrepared, asiCount, expertiseCount, fightingStyleLevel, invocationCount, magicalSecretsCount, masteryCount, wildShapeForms } from './class-rules';
import { autoEquip, classOf, classSpells, maxSpellLevel, startingInventory, weaponProficient } from './sheet';
import type { Card5eData, ClassKey, RulesData } from './types';

/** 各职业分属性的先后（标准数组 15、14、13、12、10、8 按这个顺序给）。 */
export const PRIORITY: Record<ClassKey, Ability[]> = {
  barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  bard: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
  cleric: ['wis', 'con', 'str', 'cha', 'dex', 'int'],
  druid: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
  fighter: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  monk: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
  ranger: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  rogue: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
  sorcerer: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  warlock: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  wizard: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
};

/** 推荐的背景：力量、体质为主的职业用士兵（凶蛮攻击者），别的用罪犯（警觉）。 */
function backgroundFor(cls: ClassKey): string {
  return ['barbarian', 'fighter', 'paladin', 'cleric'].includes(cls) ? 'soldier' : 'criminal';
}

const take = <T,>(list: readonly T[], n: number, skip: readonly T[] = []) => list.filter((x) => !skip.includes(x)).slice(0, Math.max(0, n));

/** 按推荐把一张卡的选择都做好（等级 1～5）。种族、背景可以指定（亚种、血统、人类多选的专长和技能、魔法学徒也按推荐选好）。 */
export function quickCard(rules: RulesData, cls: ClassKey, opts: { level?: number; species?: string; background?: string } = {}): Card5eData {
  const level = Math.max(1, Math.min(maxLevelFor(cls), opts.level ?? 1));
  // 法术内容只到 5 级，先按 5 级的数量推荐。
  const contentLevel = Math.min(level, 5);
  const c = classOf(rules, cls)!;
  const bg = rules.backgrounds.find((b) => b.key === (opts.background ?? backgroundFor(cls)))!;
  const order = PRIORITY[cls];
  const base = {} as Abilities;
  order.forEach((a, i) => (base[a] = STANDARD_ARRAY[i]));
  // 背景的属性加值：背景三项里排得最前的 +2，其次 +1
  const ranked = [...bg.abilities].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const bgBonus: Partial<Abilities> = { [ranked[0]]: 2, [ranked[1]]: 1 };
  // 推荐卡也要守 20 上限：每次属性提升挑一项还能加 2 的。
  const asiScores = { ...base };
  for (const a of ABILITIES) asiScores[a] = (asiScores[a] ?? 8) + Number(bgBonus[a] ?? 0);
  const asi: Record<string, number>[] = [];
  for (let i = 0; i < asiCount(level, cls); i++) {
    const a = order.find((x) => (asiScores[x] ?? 8) + 2 <= 20) ?? order[0];
    asi.push({ [a]: 2 });
    asiScores[a] = (asiScores[a] ?? 8) + 2;
  }
  const card: Card5eData = {
    v: 1,
    class: cls,
    subclass: level >= 3 ? (rules.subclasses.find((s) => s.class === cls)?.key ?? null) : null,
    level,
    earned: 0,
    xp: xpForLevel(level),
    multiclass: [],
    species: opts.species ?? 'dwarf',
    lineage: null,
    size: 'medium',
    lineageAbility: null,
    background: bg.key,
    method: 'array',
    base,
    bgBonus,
    languages: [],
    asi,
    classSkills: [],
    bonusSkills: [],
    expertise: [],
    originFeats: [{ key: bg.feat, source: 'background' }],
    fightingStyle: null,
    styleCantrips: [],
    masteries: [],
    order: cls === 'cleric' ? 'protector' : cls === 'druid' ? 'warden' : null,
    totem: null,
    deity: cls === 'cleric' ? DEITIES.find((d) => d.name === '海姆')?.key ?? DEITIES[0].key : null,
    cantrips: [],
    prepared: [],
    spellbook: [],
    invocations: [],
    tome: null,
    metamagic: [],
    hunterPrey: null,
    land: null,
    wildShapes: [],
    equipmentChoice: { class: 0, background: 0 },
    inventory: [],
    money: 0,
    equipped: { armor: null, shield: null, main: null, off: null, feet: null, ring1: null, ring2: null, necklace: null },
  };
  // 技能：背景的两个以外，从职业的列表里按顺序挑（法师先挑学者能专精的）
  const options = cls === 'wizard' ? [...c.skillOptions].sort((x, y) => Number(SCHOLAR_SKILLS.includes(y)) - Number(SCHOLAR_SKILLS.includes(x))) : c.skillOptions;
  card.classSkills = take(options, c.skillCount, bg.skills);
  const taken = (): Skill[] => [...bg.skills, ...card.classSkills, ...card.bonusSkills.map((b) => b.skill)];
  // 种族：亚种选第一个（精灵：用智力、魅力施法的选高等精灵，别的选木精灵）；血统法术用职业的施法属性（不是心智属性的用感知）；
  // 精灵、人类多一个技能；人类多一个起源专长
  const sp = rules.species.find((x) => x.key === card.species);
  const casting = c.spellcasting?.ability;
  if (sp?.lineages.length) {
    const want = card.species === 'elf' ? (casting === 'int' || casting === 'cha' ? 'elven-lineage-high-elf' : 'elven-lineage-wood-elf') : null;
    card.lineage = sp.lineages.find((l) => l.key === want)?.key ?? sp.lineages[0].key;
  }
  if (sp?.size === 'small') card.size = 'small';
  // 半精灵这类 2014 种族：固定的属性加值 + 再选几项各加多少
  if (sp?.abilityBonus) {
    const bonus: Partial<Abilities> = { ...sp.abilityBonus.fixed };
    const pool = ABILITIES.filter((a) => sp.abilityBonus!.fixed[a] === undefined && !sp.abilityBonus!.exclude?.includes(a));
    for (const a of pool.slice(0, sp.abilityBonus.choose)) bonus[a] = sp.abilityBonus.each;
    card.speciesBonus = bonus;
  }
  if (sp?.skillChoices) card.speciesSkills = take(rules.skills.map((x) => x.key as Skill), sp.skillChoices, taken());
  if (sp?.languages?.choices) card.speciesLanguages = LANGUAGE_KEYS.filter((k) => !sp.languages!.fixed.includes(k)).slice(0, sp.languages.choices);
  const mental: Ability = casting && ['int', 'wis', 'cha'].includes(casting) ? casting : 'wis';
  if (['elf', 'gnome', 'tiefling'].includes(card.species)) card.lineageAbility = mental;
  if (card.species === 'elf') card.bonusSkills.push({ source: 'keen-senses', skill: take(['perception', 'insight', 'survival'] as Skill[], 1, taken())[0] });
  if (card.species === 'human') {
    card.bonusSkills.push({ source: 'skillful', skill: take(rules.skills.map((x) => x.key as Skill), 1, taken())[0] });
    card.originFeats.push({ key: bg.feat === 'alert' ? 'savage-attacker' : 'alert', source: 'species' });
  }
  if (cls === 'barbarian' && level >= 3) card.bonusSkills.push({ source: 'primal-knowledge', skill: take(c.skillOptions, 1, taken())[0] });
  if (card.subclass === 'college-of-lore' && level >= 3) {
    const all = rules.skills.map((s) => s.key as Skill);
    for (const skill of take(all, 3, taken())) card.bonusSkills.push({ source: 'lore-bonus-proficiencies', skill });
  }
  const expN = expertiseCount(cls, level);
  card.expertise = cls === 'wizard' ? take(taken().filter((s) => SCHOLAR_SKILLS.includes(s)), expN) : take(taken(), expN);
  // 战斗风格
  const styleLevel = fightingStyleLevel(cls);
  if (styleLevel && level >= styleLevel) card.fightingStyle = cls === 'ranger' ? 'archery' : 'defense';
  // 起始装备、穿戴
  const { inventory, money } = startingInventory(card, rules);
  card.inventory = inventory;
  card.money = money;
  // 武器精通：先挑身上带着的、会用的武器，不够再从别的会用的武器里挑
  const mCount = masteryCount(cls, level);
  if (mCount) {
    const ok = rules.weapons.filter((w) => weaponProficient(card, c, w) && (cls !== 'barbarian' || !w.ranged));
    const carried = ok.filter((w) => inventory.some((i) => i.key === w.key));
    card.masteries = [...new Set([...carried, ...ok].map((w) => w.key))].slice(0, mCount);
  }
  card.equipped = autoEquip(card, rules);
  // 法术
  const sc = c.spellcasting;
  if (sc) {
    const max = maxSpellLevel(c, level);
    const list = classSpells(rules, cls, max);
    // 种族、血统已经给了的戏法、法术不再挑
    const granted = (LINEAGE_SPELLS[card.lineage ?? ''] ?? []).map((x) => x.spell);
    card.cantrips = list.filter((s) => s.level === 0 && !granted.includes(s.key)).slice(0, sc.cantrips[contentLevel - 1]).map((s) => s.key);
    const always = alwaysPrepared({ class: cls, subclass: card.subclass, land: card.land, level });
    const leveled = list.filter((s) => s.level >= 1 && !always.includes(s.key) && !granted.includes(s.key)).sort((x, y) => y.level - x.level || x.key.localeCompare(y.key));
    if (cls === 'wizard') {
      const savant = card.subclass === 'evoker' && level >= 3 ? (level >= 5 ? 3 : 2) : 0;
      const need = 6 + 2 * (contentLevel - 1) + savant;
      const evocations = leveled.filter((s) => s.school === 'evocation');
      // 塑能学派学者：先放够塑能法术
      card.spellbook = [...new Set([...evocations.slice(0, savant).map((s) => s.key), ...leveled.map((s) => s.key)])].slice(0, need);
      card.prepared = card.spellbook.slice(0, sc.prepared[contentLevel - 1]);
    } else {
      card.prepared = leveled.slice(0, sc.prepared[contentLevel - 1]).map((s) => s.key);
    }
  }
  if (cls === 'bard' && magicalSecretsCount(level, card.subclass) > 0) {
    const n = magicalSecretsCount(level, card.subclass);
    const max = maxSpellLevel(c, level);
    const pool = rules.spells.filter((s) => s.level <= max && !card.prepared.includes(s.key) && !(card.magicalSecrets ?? []).includes(s.key));
    card.magicalSecrets = pool.slice(0, n).map((s) => s.key);
  }
  if (cls === 'warlock') {
    const n = invocationCount(level);
    const simple = rules.invocations.filter((o) => !o.requires && (o.level ?? 1) <= level && !['lessons-of-the-first-ones', 'pact-of-the-tome', 'pact-of-the-chain'].includes(o.key));
    card.invocations = simple.slice(0, n).map((o) => ({ key: o.key }));
  }
  if (cls === 'sorcerer' && level >= 2) card.metamagic = rules.metamagic.slice(0, 2).map((m) => m.key);
  if (card.subclass === 'hunter') card.hunterPrey = 'colossus-slayer';
  if (card.subclass === 'circle-of-the-land') {
    card.land = 'temperate';
    // 地形定了以后总是准备好的法术多了：从准备的里面去掉重复的
    const always = alwaysPrepared({ class: cls, subclass: card.subclass, land: card.land, level });
    const list = classSpells(rules, cls, maxSpellLevel(c, level)).filter((s) => s.level >= 1 && !always.includes(s.key));
    card.prepared = list.slice(0, c.spellcasting!.prepared[contentLevel - 1]).map((s) => s.key);
  }
  if (cls === 'druid' && level >= 2) {
    const { count, maxCr } = wildShapeForms(level);
    card.wildShapes = rules.beasts.filter((b) => b.cr <= maxCr && !b.fly).slice(0, count).map((b) => b.key);
  }
  // 背景的魔法学徒（侍僧、贤者）：照法术表挑两个职业还没学的戏法、一个 1 环法术，用感知（牧师、德鲁伊的表）或智力（法师的表）施放
  for (const f of card.originFeats) {
    if (f.key !== 'magic-initiate') continue;
    const list = f.list ?? bg.featList ?? 'wizard';
    f.list = list;
    f.ability = list === 'wizard' ? 'int' : 'wis';
    // 职业、血统已经会的不再挑：戏法跳过已经会的，1 环法术跳过准备了的、法术书里有的、总是准备好的
    const granted = (LINEAGE_SPELLS[card.lineage ?? ''] ?? []).map((x) => x.spell);
    const always = alwaysPrepared({ class: cls, subclass: card.subclass, land: card.land, level });
    const known = new Set([...card.cantrips, ...card.prepared, ...card.spellbook, ...granted, ...always]);
    f.cantrips = rules.spells.filter((x) => x.level === 0 && x.classes.includes(list) && !known.has(x.key)).slice(0, 2).map((x) => x.key);
    f.spell = rules.spells.find((x) => x.level === 1 && x.classes.includes(list) && !known.has(x.key))?.key;
  }
  void ABILITIES;
  return card;
}
