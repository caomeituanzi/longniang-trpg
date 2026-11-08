// 5E 规则（V0.9.0）的数据格式：规则数据（职业、种族、背景、专长、装备、法术、怪物）、5E 角色卡、对局里的状态。
// 规则数据放在服务器上（server/5e/），网页做卡时从 /api/5e/rules 拿；这里只有格式。
import type { Abilities, Ability, Condition5e, DamageType, LanguageKey, Skill } from './core';

export type ClassKey = 'barbarian' | 'bard' | 'cleric' | 'druid' | 'fighter' | 'monk' | 'paladin' | 'ranger' | 'rogue' | 'sorcerer' | 'warlock' | 'wizard';
export const CLASS_KEYS: ClassKey[] = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];

/** 一件东西和数量（装备、物品）。 */
export type ItemStack = { key: string; qty: number };

// ==================== 规则数据 ====================

export type WeaponProperty = 'ammunition' | 'finesse' | 'heavy' | 'light' | 'loading' | 'range' | 'reach' | 'thrown' | 'two-handed' | 'versatile';
export type MasteryKey = 'cleave' | 'graze' | 'nick' | 'push' | 'sap' | 'slow' | 'topple' | 'vex';

export type WeaponData = {
  key: string;
  name: string;
  category: 'simple' | 'martial';
  ranged: boolean;
  damage: string;
  damageType: DamageType;
  /** 多用武器双手用的伤害骰。 */
  versatile: string | null;
  properties: WeaponProperty[];
  /** 射程（远程、投掷），尺：[正常, 最远]。 */
  range: [number, number] | null;
  mastery: MasteryKey | null;
  /** 价格（铜币）、重量（磅）。 */
  cost: number;
  weight: number;
};

export type ArmorKind = 'light' | 'medium' | 'heavy' | 'shield';
export type ArmorData = {
  key: string;
  name: string;
  kind: ArmorKind;
  /** 基础 AC（盾牌是 +2）。 */
  ac: number;
  /** 能加多少敏捷调整值：轻甲不限（null），中甲 2，重甲 0。 */
  dexMax: number | null;
  strMin: number | null;
  stealthDisadvantage: boolean;
  cost: number;
  weight: number;
};

/** 别的物品（冒险用品、工具、套组、法器）。contents：套组里有什么。 */
export type GearData = { key: string; name: string; kind: 'gear' | 'tool' | 'pack' | 'focus' | 'ammunition'; cost: number; weight: number; text: string; contents: ItemStack[] };

/** 魔法物品：程序能自动算的效果写在 mech 里，别的照 text 由主持人裁定。 */
export type MagicItemData = {
  key: string;
  name: string;
  rarity: string;
  attunement: boolean;
  text: string;
  mech: { heal?: string; attack?: number; damage?: number; ac?: number; saves?: number; charges?: number } | null;
};

/** 法术的机制（程序照它掷骰、记账；没有的照 text 由主持人裁定）。字段见翻译说明。 */
export type SpellMech = {
  attack?: 'melee' | 'ranged';
  save?: Ability;
  onSave?: 'half' | 'none';
  auto?: true;
  count?: number;
  countPerSlot?: number;
  countAtLevel5?: number;
  damage?: string;
  damageType?: DamageType;
  damageChoices?: DamageType[];
  damagePerSlot?: string;
  cantripDice?: string;
  addMod?: true;
  heal?: string;
  healPerSlot?: string;
  tempHp?: string;
  tempHpPerSlot?: string;
  condition?: Condition5e;
  effect?: SpellEffect;
};

export type SpellEffect = {
  target: 'self' | 'targets';
  ac?: number;
  acBase?: number;
  acMin?: number;
  attackDice?: string;
  saveDice?: string;
  damageDice?: string;
  damageType?: DamageType;
  vsTarget?: boolean;
  hpMax?: number;
  hpMaxPerSlot?: number;
  resist?: DamageType[];
  note: string;
};

export type SpellData = {
  key: string;
  name: string;
  level: 0 | 1 | 2 | 3;
  school: string;
  classes: ClassKey[];
  castingTime: string;
  /** 施法时间的种类（程序用）：动作、附赠动作、反应、更久。 */
  timing: 'action' | 'bonus' | 'reaction' | 'long';
  ritual: boolean;
  range: string;
  components: string;
  duration: string;
  concentration: boolean;
  text: string;
  higher: string | null;
  mech: SpellMech | null;
};

/** 职业特性、子职业特性、种族特质、专长：名字和完整说明。 */
export type FeatureText = { key: string; name: string; text: string };

export type FeatData = FeatureText & { type: 'origin' | 'general' | 'fighting-style' | 'epic' };

export type SubclassData = { key: string; class: ClassKey; name: string; text: string; features: { level: number; key: string }[] };

/** 起始装备的一套选择：一些物品加若干金币（铜币计）。 */
export type EquipmentOption = { label: string; items: ItemStack[]; money: number };

export type ClassData = {
  key: ClassKey;
  name: string;
  text: string;
  hitDie: number;
  primary: Ability[];
  saves: Ability[];
  armor: ArmorKind[];
  /** 武器熟练：简易、军用；游荡者是带灵巧或轻型词条的军用武器，武僧是带轻型词条的军用武器。 */
  weapons: ('simple' | 'martial' | 'martial-finesse-light' | 'martial-light')[];
  tools: string[];
  skillCount: number;
  skillOptions: Skill[];
  /** 起始装备：几套里选一套（最后一套通常是只拿金币）。equipmentText 是原文说明。 */
  equipment: EquipmentOption[];
  equipmentText: string;
  /** 1～5 级各级的特性（key，说明在 features 里）。 */
  levels: { level: number; features: string[] }[];
  /** 施法：属性、哪种施法者、各级的戏法数、准备法术数（1～5 级）。不施法的是 null。 */
  spellcasting: null | { ability: Ability; kind: 'full' | 'half' | 'pact'; cantrips: number[]; prepared: number[] };
};

export type SpeciesData = {
  key: string;
  name: string;
  text: string;
  size: 'medium' | 'small' | 'choice';
  speed: number;
  darkvision: number;
  /** 种族特质（key，说明在 traits 里）。 */
  traits: string[];
  /** 亚种、血统、祖先（龙裔的龙族祖先、精灵的血统、侏儒的血统、歌利亚的巨人祖先、提夫林的魔鬼遗赠）；没有的是空。 */
  lineages: { key: string; name: string; traits: string[]; damageType: DamageType | null; text?: string }[];
  lineageLabel: string | null;
  /** 2014 版种族的属性值加成：固定几项，再选几项各加多少（半精灵是魅力 +2，再选两项各 +1）。 */
  abilityBonus?: { fixed: Partial<Abilities>; choose: number; each: number; exclude?: Ability[] } | null;
  /** 种族给的技能熟练数量（半精灵的「多才多艺」是两项）。 */
  skillChoices?: number;
  /** 种族语言：固定会的，以及还能自选几门。 */
  languages?: { fixed: LanguageKey[]; choices: number } | null;
};

export type BackgroundData = {
  key: string;
  name: string;
  text: string;
  abilities: Ability[];
  feat: string;
  /** 魔法学徒用哪个职业的法术表（侍僧是牧师、贤者是法师）。 */
  featList: 'cleric' | 'druid' | 'wizard' | null;
  skills: Skill[];
  tool: string;
  /** 工具熟练的完整写法（数据里只存一项工具；另外的载具写在这里给学生看）。 */
  toolText?: string;
  /** 背景可选几门语言（不写是 0）：在背景详情里选，和技能熟练一样是一行。 */
  languageChoices?: number;
  /** 背景特性（2014 版背景才有）：名字和说明，编辑器里和属性加值、技能熟练一样单独列一行。 */
  feature?: { name: string; text: string } | null;
  equipment: EquipmentOption[];
  equipmentText: string;
};

export type OptionData = FeatureText & { level?: number; requires?: string; repeatable?: boolean; cost?: number };

/** 网页做卡、看角色卡要用的规则数据（/api/5e/rules）。怪物另外拿（/api/5e/monsters）。 */
export type RulesData = {
  classes: ClassData[];
  subclasses: SubclassData[];
  features: Record<string, FeatureText>;
  species: SpeciesData[];
  traits: Record<string, FeatureText>;
  backgrounds: BackgroundData[];
  feats: FeatData[];
  weapons: WeaponData[];
  armor: ArmorData[];
  gear: GearData[];
  magicItems: MagicItemData[];
  spells: SpellData[];
  invocations: OptionData[];
  metamagic: OptionData[];
  masteries: FeatureText[];
  properties: FeatureText[];
  conditions: FeatureText[];
  skills: FeatureText[];
  /** 德鲁伊能变的野兽（挑战等级 1/2 以下、不会飞）：key、名字、挑战等级。 */
  beasts: { key: string; name: string; cr: number; fly: boolean; swim: boolean }[];
};

// ---------- 怪物 ----------

export type MonsterAction = {
  name: string;
  desc: string;
  /** 攻击检定的加值；不是攻击（豁免类、多重攻击）是 null。 */
  attack: number | null;
  /**
   * 命中（或豁免失败）造成的伤害：几段，每段骰子和类型。第二段以后的 when：没写是一直有；adv 攻击有优势时才有；
   * if 描述里的条件满足才有（主持人判断）；or 换掉第一段（集群浴血时之类）。
   */
  damage: { dice: string; type: DamageType; when?: 'adv' | 'if' | 'or' }[];
  /** 要目标做的豁免：属性、DC、成功时（减半 half / 没事 none）。 */
  save: { ability: Ability; dc: number; onSuccess: 'half' | 'none' } | null;
  /** 用法：充能（recharge 5 是掷到 5、6 回来）、每天几次。 */
  recharge: number | null;
  perDay: number | null;
  multiattack: boolean;
  /** 豁免失败以后目标获得的状态（程序自动加上）。 */
  saveCondition?: Condition5e;
};

export type MonsterData = {
  key: string;
  name: string;
  size: string;
  type: string;
  alignment: string;
  ac: number;
  acNote: string;
  hp: number;
  hitDice: string;
  speed: string;
  abilities: Abilities;
  /** 熟练的豁免、技能的总加值（数据块写的）；没写的用属性调整值。 */
  saves: Partial<Record<Ability, number>>;
  skills: Partial<Record<Skill, number>>;
  resist: string[];
  vulnerable: string[];
  immune: string[];
  conditionImmune: Condition5e[];
  senses: string;
  languages: string;
  cr: number;
  xp: number;
  pb: number;
  traits: MonsterAction[];
  actions: MonsterAction[];
  bonusActions: MonsterAction[];
  reactions: MonsterAction[];
};

export const CR_LABEL = (cr: number) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));

// ==================== 5E 角色卡 ====================

/** 起源专长（背景给的、人类多给的一个）：魔法学徒、多才多艺要另外做选择。 */
export type OriginFeatChoice = {
  key: string;
  source: 'background' | 'species' | 'invocation';
  /** 魔法学徒：用哪个职业的法术表、施法属性、两个戏法、一个 1 环法术。 */
  list?: 'cleric' | 'druid' | 'wizard';
  ability?: Ability;
  cantrips?: string[];
  spell?: string;
  /** 多才多艺：三个技能（这一版只选技能，不选工具）。 */
  skills?: Skill[];
};

export type Card5eData = {
  v: 1;
  class: ClassKey;
  subclass: string | null;
  /** 用属性值提升换的通用专长（每一项对应一次属性提升）。 */
  asiFeats?: {
    key: string;
    ability?: Ability;
    damageType?: DamageType;
    weapons?: string[];
    rituals?: string[];
    cantrip?: string;
    list?: ClassKey;
  }[];
  /** 兼职：主职业之外的职业和等级，总等级不能超过 20。 */
  multiclass?: { class: ClassKey; level: number }[];
  /** 吟游诗人魔法奥秘选的法术（可以来自任何职业）。 */
  magicalSecrets?: string[];
  /** 图腾武者道途选择的图腾精魄（bear / eagle / wolf）；别的子职是 null。 */
  totem?: string | null;
  /** 牧师选择的神祇（DEITIES 的 key）；别的职业是 null。 */
  deity?: string | null;
  /** 现在几级；earned 是打完模组挣到、还没升的级数（升级时做选择）。 */
  level: number;
  earned: number;
  /** 累计经验值；老卡没有时按当前等级的起始经验算。 */
  xp?: number;
  species: string;
  lineage: string | null;
  /** 人类、提夫林可以选中型或小型。 */
  size: 'medium' | 'small';
  /** 精灵、侏儒、提夫林的血统法术用什么属性施放。 */
  lineageAbility: Ability | null;
  background: string;
  /** 背景可选语言（从 LANGUAGES 里选，数量由背景的 languageChoices 定；老卡没有就是空）。 */
  languages?: LanguageKey[];
  method: 'array' | 'pointbuy';
  /** 分配前的六项属性（标准数组或购点）。 */
  base: Abilities;
  /** 背景给的属性加值：背景的三项里 +2/+1 或 +1/+1/+1。 */
  bgBonus: Partial<Abilities>;
  /** 种族给的属性加值（半精灵的魅力 +2、再选两项各 +1）。 */
  speciesBonus?: Partial<Abilities>;
  /** 种族给的技能（半精灵的两项）。 */
  speciesSkills?: Skill[];
  /** 种族可选语言（固定语言在种族数据里）。 */
  speciesLanguages?: LanguageKey[];
  /** 4 级的属性值提升：一项 +2 或两项各 +1。 */
  asi: Partial<Abilities>[];
  /** 职业给的技能。 */
  classSkills: Skill[];
  /** 别处来的技能：种族（精灵的敏锐感官、人类的多才）、野蛮人 3 级、逸闻学院 3 级。 */
  bonusSkills: { source: string; skill: Skill }[];
  /** 专精（游荡者 1 级、吟游诗人 2 级、游侠 2 级、法师 2 级的学者）。 */
  expertise: Skill[];
  originFeats: OriginFeatChoice[];
  /** 战斗风格（专长 key），或者圣武士的「神佑战士」blessed-warrior、游侠的「德鲁伊战士」druidic-warrior。 */
  fightingStyle: string | null;
  /** 神佑战士、德鲁伊战士学的两个戏法。 */
  styleCantrips: string[];
  /** 武器精通：哪几种武器（武器 key）。 */
  masteries: string[];
  /** 牧师的神圣职责（protector 护卫、thaumaturge 神术师）、德鲁伊的原初职责（magician 术师、warden 守望者）。 */
  order: string | null;
  cantrips: string[];
  /** 准备的 1 环以上法术（职业的）。 */
  prepared: string[];
  /** 法师的法术书。 */
  spellbook: string[];
  /** 魔能祈唤：key，和要另外选的戏法（苦痛魔能、推斥魔能、魔能长矛选哪个戏法）、专长（太初者课程）。 */
  invocations: { key: string; cantrip?: string; feat?: OriginFeatChoice }[];
  /** 魔典契约：三个戏法、两个 1 环仪式法术。 */
  tome: { cantrips: string[]; rituals: string[] } | null;
  metamagic: string[];
  /** 游侠猎人 3 级：巨物杀手 colossus-slayer 或破群者 horde-breaker。 */
  hunterPrey: string | null;
  /** 大地结社 3 级：哪种地形（arid 干旱、polar 极地、temperate 温带、tropical 热带）。 */
  land: string | null;
  /** 德鲁伊的荒野变形会的形态（野兽 key）。 */
  wildShapes: string[];
  /** 起始装备选了第几套（职业、背景）。 */
  equipmentChoice: { class: number; background: number };
  /** 带着的东西（武器、护甲、物品、魔法物品）和钱（铜币）。 */
  inventory: ItemStack[];
  money: number;
  /**
   * 穿着、拿着的：护甲、盾牌、主手、副手（物品 key）。
   * 物品 key 后面带「+1」的是魔法武器、护甲（longsword+1、chain-mail+1、shield+1）。
   */
  equipped: {
    armor: string | null;
    shield: string | null;
    main: string | null;
    off: string | null;
    /** 自定义道具的装备栏：鞋子、两枚戒指、项链。 */
    feet?: string | null;
    ring1?: string | null;
    ring2?: string | null;
    necklace?: string | null;
  };
};

/** 打完的一个 5E 模组：那时几级、活没活下来、算不算（剧本大厅里的模组才升级、带出东西）、带出来的东西。 */
export type Card5eHistory = { title: string; ending: string | null; level: number; survived: boolean; counted: boolean; loot: string[]; at: number };

/** 卡片上给人看的（不含对局里的状态）。 */
export type Card5eView = {
  id: number;
  name: string;
  appearance: string;
  background: string;
  data: Card5eData;
  sheet: Sheet5e;
  /** 正在哪一局里。 */
  inRoom: { id: number; name: string } | null;
  /** 打完的 5E 模组（最近的在前）。 */
  history: Card5eHistory[];
  /** 还能不能重新做（没打过模组、不在对局里、还是 1 级）。 */
  editable: boolean;
  onProfile: boolean;
  createdAt: number;
};

/** 个人主页上别人看得到的 5E 角色：种族、职业、等级、生命值、AC、属性，打完过几个模组。背景、物品不给别人看。 */
export type PublicCard5e = {
  id: number;
  name: string;
  appearance: string;
  species: string;
  className: string;
  subclassName: string | null;
  level: number;
  hpMax: number;
  ac: number;
  abilities: Abilities;
  modules: number;
};

// ==================== 算出来的角色数值 ====================

export type AttackOption = {
  key: string;
  name: string;
  kind: 'weapon' | 'unarmed' | 'spell';
  ability: Ability;
  toHit: number;
  damage: string;
  damageType: DamageType;
  /** 射程或触及，给人看的。 */
  range: string;
  /** 精通（会用的才有）。 */
  mastery: MasteryKey | null;
  note: string;
};

export type ResourceInfo = { key: string; name: string; max: number; recover: 'short' | 'long' | 'short-one'; text?: string };

export type Sheet5e = {
  pb: number;
  className: string;
  subclassName: string | null;
  speciesName: string;
  backgroundName: string;
  /** 主职业等级。 */
  level: number;
  /** 总等级（主职业 + 兼职），熟练加值和经验都按它算。 */
  totalLevel: number;
  abilities: Abilities;
  mods: Abilities;
  saves: Record<Ability, { mod: number; prof: boolean }>;
  /** prof：0 不熟练、0.5 万事通（吟游诗人的半个熟练加值）、1 熟练、2 专精。 */
  skills: Record<Skill, { mod: number; prof: 0 | 0.5 | 1 | 2 }>;
  passivePerception: number;
  hpMax: number;
  hitDie: number;
  speed: number;
  size: 'medium' | 'small';
  darkvision: number;
  ac: number;
  acNote: string;
  /** 穿着的护甲让隐匿检定有劣势（链甲、板甲……）：护甲的名字；没有是 null（V0.9.0）。 */
  stealthDis: string | null;
  initiative: number;
  attacks: AttackOption[];
  /** 施法：职业的施法属性、法术豁免 DC、法术攻击加值（不是施法职业、只有血统法术之类的，ability 是 null，DC 看 abilityOf）。 */
  spell: null | {
    ability: Ability | null;
    dc: number;
    attack: number;
    /** 1～3 环的法术位上限；契约魔法另算。 */
    slots: number[];
    pact: { count: number; level: number } | null;
    cantrips: string[];
    /** 准备好的 1 环以上法术（含总是准备好的）。 */
    prepared: string[];
    /** 总是准备好的（子职业、特性给的）。 */
    always: string[];
    /** 不用法术位就能施放的（次数用完要等长休）：法术 key → 次数。 */
    free: Record<string, number>;
    spellbook: string[] | null;
    /** 不是用职业施法属性施放的法术（血统法术、魔法学徒、神佑战士……）：法术 key → 用哪项属性。 */
    abilityOf: Record<string, Ability>;
  };
  resources: ResourceInfo[];
  /** 拿到的职业特性、子职业特性、种族特质、专长（key 和名字）。 */
  features: { key: string; name: string; source: string }[];
  resist: DamageType[];
  proficiencies: { armor: string[]; weapons: string[]; tools: string[] };
  /** 还没做完的选择（升级时要补的），做卡时是空的。 */
  todo: string[];
};

// ==================== 对局里的状态 ====================

/** 身上持续的效果（法术、狂暴、闪避……）。conc：靠谁的专注维持（角色编号）；turnOf：到谁的下个回合开始就结束。 */
export type Effect5e = {
  id: string;
  key: string;
  name: string;
  from: string;
  conc?: number;
  turnOf?: string;
  /** 结束的时机：combat 这场战斗结束、short 短休、long 长休；没写的靠专注、回合或主持人去掉。 */
  until?: 'combat' | 'short' | 'long';
  /** 只对某个目标起作用（猎人印记、脆弱诅咒）：目标的编号（敌人 id、角色是 c+编号）。 */
  vs?: string;
  mods: {
    ac?: number;
    acBase?: number;
    acMin?: number;
    attackDice?: string;
    saveDice?: string;
    /** 属性检定加的骰（神导术 1d4，用一次就没了）。 */
    checkDice?: string;
    damageDice?: string;
    damageType?: DamageType;
    resist?: DamageType[];
    advAttack?: boolean;
    disAttack?: boolean;
    advAgainst?: boolean;
    disAgainst?: boolean;
    advSaves?: Ability[];
    advChecks?: Ability[];
    hpMax?: number;
    /** 法术豁免 DC 加值（先天术法 +1）。 */
    spellDc?: number;
    /** 狂暴：力量攻击的伤害加值。 */
    rageDamage?: number;
  };
  /** 用一次就没了（神导术、稳定瞄准、侵扰给的优势）。 */
  once?: boolean;
  note: string;
};

/**
 * 身上的状态。turnOf：到谁的下个回合开始就结束；再写了 endOfTurn 的，是到那个人下一个回合结束才去掉
 * （那个回合开始时标上 ending，这次结算做完时去掉）。
 */
export type ConditionState = { key: Condition5e; note?: string; from?: string; conc?: number; turnOf?: string; endOfTurn?: boolean; ending?: boolean };

/** 一个角色在 5E 模组里的状态（存在 characters.v5，JSON）。 */
export type State5e = {
  /** 用哪张 5E 卡进来的、进来时卡上的样子（这一局都照它算）。 */
  cardId: number;
  data: Card5eData;
  hp: number;
  tempHp: number;
  hitDiceUsed: number;
  /** 死亡豁免：生命值到 0、还没稳定时才有。 */
  death: { success: number; failure: number } | null;
  stable: boolean;
  /** 上一次在战斗里掷死亡豁免是第几轮（一轮只掷一次）。 */
  deathRound: number | null;
  slotsUsed: number[];
  pactUsed: number;
  /** 职业资源用了多少（狂暴、回气、引导神力、功力点、术法点、圣疗池……）。 */
  used: Record<string, number>;
  /** 正在专注的法术（level：用几环施放的，之后 spell_effect 照这个环级算）。 */
  concentration: { spell: string; name: string; level?: number } | null;
  conditions: ConditionState[];
  exhaustion: number;
  effects: Effect5e[];
  /** 英雄激励。 */
  inspiration: boolean;
  /** 手里的诗人激励骰（d6、d8）；没有是 null。 */
  bardicDie: number | null;
  /** 荒野变形：变成了哪种野兽。 */
  wildShape: string | null;
  inventory: ItemStack[];
  money: number;
  /** 这一局里捡到、得到的东西（结束时活着才带走；已经并进了 inventory，这里只是记账）。 */
  gained: ItemStack[];
  gainedMoney: number;
  /** 正在看的商店（剧本 shops 的 key）；不在商店里是 null。 */
  openShop?: string | null;
};

/** 战斗里的一个怪物。 */
export type Monster5eState = {
  id: string;
  key: string;
  name: string;
  hp: number;
  hpMax: number;
  tempHp: number;
  ac: number;
  conditions: ConditionState[];
  effects: Effect5e[];
  defeated: boolean;
  fled?: boolean;
  /** 充能类的行动用掉了（行动名）。 */
  spent: string[];
  /** 每天几次的行动用了几次（行动名 → 次数）。 */
  usedPerDay: Record<string, number>;
  /** 主持人记在它身上的事（剧本里的计数、机关进度），一直写在「正在打的仗」里。 */
  mark?: string;
  /** 站位（V1.0.x）：在这个地点里站在哪；没写是在大家中间。 */
  spot?: string | null;
};

/** 一场 5E 战斗：在哪、第几轮、先攻顺序、这一轮谁已经行动过、怪物。 */
export type Fight5e = {
  location: string;
  round: number;
  order: { id: string; name: string; side: 'ally' | 'enemy'; initiative: number }[];
  acted: string[];
  monsters: Monster5eState[];
};
