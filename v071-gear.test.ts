// 时间按东京算
process.env.TZ = 'Asia/Tokyo';
// V0.7.1：装备改成魔兽世界那样浑身十六个格子（一个部位一个格子，戒指、饰品各两个），「我的角色」里是人物栏；
// 护甲点合起来减伤、检定只算同一项属性最高的那件、攻击看主手；V0.7.0 存的卡和打到一半的地下城照样能用。
// 角色卡的专长从列表里挑（以前自己写的照样留着）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { normalizeEquipped } from '../server/cards';
import { anyGearView, LEGENDARY_GEAR } from '../server/legendary';
import { buildDmContext } from '../server/game/prompts';
import { accessoryFor, newV2State, parseV2, reductionOf, weaponOf, type V2State } from '../server/game/rules2';
import { rollDungeonRun, validateScenario } from '../server/game/scenario';
import { Rules2Context } from '../server/game/tools2';
import { emptyWorld, type Character } from '../server/game/world';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { COMMON_GEAR_PRICE, GEAR_BASES, gearTotals, gearView, type GearView } from '../shared/gear2';
import {
  CARD2_SPECIALTIES,
  CARD2_SPECIALTY_GROUPS,
  damageReduction,
  emptyAttributes2,
  EQUIP_SLOTS,
  GEAR_PARTS,
  slotsForPart,
  type Attributes2,
  type GearCategory,
} from '../shared/rules2';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3, TESTER4] = TEST_ACCOUNTS;
const MIN = 60_000;

/** 一件普通装备（不是传奇的）给人看的样子。 */
const g = (id: number, base: string, rarity: 'common' | 'fine' | 'rare' | 'epic' = 'common'): GearView => gearView(id, base, rarity)!;
const lantern = LEGENDARY_GEAR.find((l) => l.part === 'offHand')!;

/** 一个最小的地下城（和 v070 的测试地窖一样），宝物换成四种装备：三个大类各一处，再加一处不写大类的。 */
function dungeon(): Record<string, any> {
  return {
    format: 'longniang-trpg/scenario@1',
    title: '装备地窖',
    category: 'dungeon',
    rules: 2,
    intro: '一个测试装备用的小地窖。',
    author: '龙娘跑团',
    genre: '奇幻',
    tone: '紧张',
    players: { min: 1, max: 2 },
    expectedDays: 1,
    relation: 'coop',
    stress: false,
    start: { label: '入夜', day: 1, time: '20:00' },
    opening: { background: '村子地窖里闹老鼠。', situation: '你们站在地窖口。', known: ['地窖很深'] },
    roles: [
      { key: 'hunter', name: '猎人', public: '村里的猎人', secret: '', goal: '清掉鼠患', startLocation: 'cellar' },
      { key: 'monk', name: '游僧', public: '路过的游僧', secret: '他见过鼠王', goal: '超度地窖里的东西', startLocation: 'cellar' },
    ],
    locations: [
      { key: 'entrance', name: '地窖口', description: '潮湿的台阶往下。', exits: [{ to: 'cellar', minutes: 2 }], features: ['一盏油灯'] },
      { key: 'cellar', name: '地窖', description: '堆满酒坛。', exits: [{ to: 'entrance', minutes: 2 }, { to: 'nest', minutes: 5 }], features: ['酒坛'] },
      { key: 'nest', name: '鼠窝', description: '腥臭的洞。', exits: [{ to: 'cellar', minutes: 5 }], features: ['骨头堆'] },
    ],
    truth: { summary: '鼠王占了地窖。', points: [{ key: 'king', text: '鼠王怕火' }] },
    clues: [
      { key: 'burnt', title: '烧焦的毛', content: '墙角有一撮烧焦的鼠毛。', location: 'cellar', points: ['king'], how: '搜查墙角', check: { attribute: 'perception', modifier: 0 }, core: true },
      { key: 'note', title: '老账本', content: '账本上写着去年用火把赶过老鼠。', location: 'entrance', points: ['king'], how: '翻账本', check: null, core: false },
    ],
    npcs: [{ key: 'keeper', name: '看窖人', identity: '老头', personality: '胆小', knows: ['老鼠怕火'], wants: '保住酒', speech: '结巴', location: 'entrance', attitude: '友善' }],
    timeline: [],
    endings: [
      { key: 'win', title: '鼠患平息', condition: '打倒鼠王', summary: '地窖安静了。', result: 'clear' },
      { key: 'flee', title: '落荒而逃', condition: '活着逃出地窖口', summary: '鼠患还在。', result: 'escape' },
      { key: 'lost', title: '鼠口之下', condition: '全都倒下', summary: '地窖吞没了他们。', result: 'fail' },
    ],
    dungeon: {
      level: 1,
      size: 'small',
      exit: 'entrance',
      enemies: [
        { key: 'rat', name: '大老鼠', tier: 'minion', description: '猫一样大的老鼠', abilities: ['一拥而上'] },
        { key: 'rat-king', name: '鼠王', tier: 'boss', description: '几只老鼠尾巴缠在一起', abilities: ['尖啸：所有人精神值 -2'] },
      ],
      encounters: [{ key: 'pack', title: '鼠群', enemies: [{ enemy: 'rat', count: 2 }], places: ['cellar'], trigger: '走进去就遇上' }],
      loot: [
        { key: 'gear-weapon', places: ['cellar'], how: '骨头堆里', reward: { kind: 'gear', slot: 'weapon', rarity: 'fine' } },
        { key: 'gear-armor', places: ['cellar'], how: '酒坛后面', reward: { kind: 'gear', slot: 'armor', rarity: 'fine' } },
        { key: 'gear-accessory', places: ['cellar'], how: '墙缝里', reward: { kind: 'gear', slot: 'accessory', rarity: 'fine' } },
        { key: 'gear-any', places: ['cellar'], how: '地上', reward: { kind: 'gear', rarity: 'fine' } },
      ],
      variants: [
        { key: 'plain', title: '只是老鼠', truth: '鼠王只是成了精的老鼠。', clues: {}, npcs: {} },
        { key: 'curse', title: '诅咒', truth: '有人在地窖下了诅咒。', clues: { note: '账本上写着有人往地窖里扔过符纸。' }, npcs: { keeper: { knows: ['有人扔过符纸'] } } },
      ],
      boss: {
        enemy: 'rat-king',
        location: 'nest',
        weaknesses: [
          { key: 'fire', text: '怕火：火油、火把烧到时用上弱点', hint: '烧焦的毛' },
          { key: 'cat', text: '怕猫叫：学猫叫时它会愣住', hint: '账本' },
        ],
        shield: '',
      },
    },
  };
}

/** 一个规则第二版的角色（地下城里），穿着 gear。 */
function hero(gear: GearView[], attributes: Partial<Attributes2> = {}): Character {
  const attrs = { ...emptyAttributes2(), ...attributes };
  return {
    id: 1,
    roomId: 1,
    playerId: 1,
    userId: 1,
    playerName: '玩家1',
    roleKey: 'hunter',
    name: '阿猎',
    attributes: attrs as unknown as Character['attributes'],
    specialties: ['射箭'],
    appearance: '',
    goal: '',
    wounds: 0,
    stress: 0,
    conditions: [],
    items: [],
    location: 'cellar',
    visited: ['cellar'],
    dead: false,
    pet: null,
    cardId: 1,
    background: '',
    gear: [],
    v2: newV2State(attrs, gear, {}),
  };
}

/** 主持工具：骰子按 dice 掷，掷完了都是 3；pick 挑宝物。 */
function contextOf(c: Character, dice: number[], pick: (n: number) => number = () => 0) {
  const scenario = rollDungeonRun(validateScenario(dungeon()).scenario!, () => 0);
  const rolls = [...dice];
  return new Rules2Context({
    scenario,
    world: emptyWorld(),
    characters: [c],
    clueHolders: new Map(),
    actorId: c.id,
    gameEnd: 100,
    rng: (sides) => (rolls.length ? rolls.shift()! : Math.min(3, sides)),
    allowDeath: true,
    players: 1,
    pick,
    ownedLegendary: new Map(),
  });
}

const armorOf = (gear: GearView[]) => {
  const t = gearTotals(gear);
  return { armor: t.armor, reduction: t.reduction };
};

// ==================== 格子、装备的种类 ====================

test('十六个格子：每个部位都有装备，戒指、饰品各两个格子；V0.7.0 的十二种装备都还在、放进对应的部位；传奇装备也有部位', () => {
  assert.equal(EQUIP_SLOTS.length, 16);
  assert.deepEqual(slotsForPart('finger'), ['finger1', 'finger2']);
  assert.deepEqual(slotsForPart('trinket'), ['trinket1', 'trinket2']);
  assert.deepEqual(slotsForPart('offHand'), ['offHand']);
  for (const part of GEAR_PARTS) assert.ok(GEAR_BASES.some((b) => b.part === part), `${part} 有装备`);
  const old: Record<string, [string, GearCategory, string | null]> = {
    sword: ['mainHand', 'weapon', 'strength'],
    axe: ['mainHand', 'weapon', 'strength'],
    dagger: ['mainHand', 'weapon', 'agility'],
    bow: ['mainHand', 'weapon', 'agility'],
    mail: ['chest', 'armor', null],
    shield: ['offHand', 'armor', null],
    amulet: ['neck', 'accessory', 'will'],
    bracer: ['wrist', 'accessory', 'constitution'],
    boots: ['feet', 'accessory', 'agility'],
    bell: ['trinket', 'accessory', 'perception'],
    box: ['trinket', 'accessory', 'intellect'],
    fan: ['trinket', 'accessory', 'charm'],
  };
  for (const [key, expected] of Object.entries(old)) {
    const b = GEAR_BASES.find((x) => x.key === key);
    assert.deepEqual(b && [b.part, b.slot, b.attribute], expected, key);
  }
  assert.deepEqual(
    ['sword', 'mail', 'amulet', 'bell'].map((k) => gearView(0, k, 'common')!.name),
    ['铁剑', '皮甲', '平安符', '铜铃'],
    '名字照旧',
  );
  // 每种四个名字（普通、精良、稀有、史诗），全都不重样
  assert.equal(new Set(GEAR_BASES.flatMap((b) => b.names)).size, GEAR_BASES.length * 4);
  // 武器都在主手；护甲在头、肩、胸、手、腰、腿和副手（盾牌）；加检定的都写了是哪一项属性
  for (const b of GEAR_BASES) {
    if (b.slot === 'weapon') assert.equal(b.part, 'mainHand', b.key);
    if (b.slot === 'armor') assert.ok(['head', 'shoulder', 'chest', 'hands', 'waist', 'legs', 'offHand'].includes(b.part), b.key);
    if (b.slot === 'accessory') assert.ok(b.attribute, b.key);
  }
  // 传奇：两件武器在主手，背甲在胸部，灯在副手（加意志检定）；本事照旧
  assert.deepEqual(
    LEGENDARY_GEAR.map((l) => {
      const v = anyGearView(9, l.key, 'legendary')!;
      return [v.part, v.slot, v.attribute, v.bonus, v.ability === l.ability];
    }),
    [
      ['mainHand', 'weapon', 'strength', 5, true],
      ['mainHand', 'weapon', 'agility', 5, true],
      ['chest', 'armor', null, 5, true],
      ['offHand', 'accessory', 'will', 5, true],
    ],
  );
});

test('合起来的效果：护甲点加起来（盾牌算两倍），每 3 点减 1 点伤、不低于最好的那一件、最多减 6；检定只算同一项属性最高的那件；攻击只看主手', () => {
  assert.deepEqual([0, 1, 3, 4, 10, 18, 40].map((a) => damageReduction(a)), [0, 1, 1, 2, 4, 6, 6]);
  assert.deepEqual([damageReduction(3, 3), damageReduction(10, 3), damageReduction(30, 5)], [3, 4, 6]);
  // 一件普通的胸甲减 1（和 V0.7.0 一样）
  assert.deepEqual(armorOf([g(1, 'mail')]), { armor: 1, reduction: 1 });
  // 只穿一件稀有、史诗的胸甲：和 V0.7.0 一样减 3、减 4（不低于最好的那一件）
  assert.deepEqual(armorOf([g(1, 'mail', 'rare')]), { armor: 3, reduction: 3 });
  assert.deepEqual(armorOf([g(1, 'mail', 'epic')]), { armor: 4, reduction: 4 });
  // 稀有胸甲 3 + 五件普通 5 + 普通盾牌 1×2 = 10，减 4（比只穿胸甲多减 1）
  const mixed = [g(1, 'mail', 'rare'), ...['helmet', 'pauldrons', 'gloves', 'belt', 'greaves', 'shield'].map((b, i) => g(i + 2, b))];
  assert.deepEqual(armorOf(mixed), { armor: 10, reduction: 4 });
  // 精良胸甲 2 + 精良头盔 2 + 稀有盾牌 3×2 = 10，减 4
  assert.deepEqual(armorOf([g(1, 'mail', 'fine'), g(2, 'helmet', 'fine'), g(3, 'shield', 'rare')]), { armor: 10, reduction: 4 });
  // 全身史诗：6 件 × 4 + 盾牌 4×2 = 32，最多减 6
  const epic = ['helmet', 'pauldrons', 'mail', 'gloves', 'belt', 'greaves', 'shield'].map((b, i) => g(i + 1, b, 'epic'));
  assert.deepEqual(armorOf(epic), { armor: 32, reduction: 6 });
  // 检定：敏捷有靴子（+1）和披风（稀有 +3），只算 +3；感知有铃铛、戒指、副手的灯，只算最高的灯
  const t = gearTotals([g(1, 'boots'), g(2, 'cloak', 'rare'), g(3, 'bell', 'fine'), g(4, 'ring-perception'), g(5, 'lantern', 'epic'), g(6, 'sword', 'fine')]);
  assert.deepEqual([t.checks.agility?.name, t.checks.agility?.bonus], ['云纹披风', 3]);
  assert.deepEqual([t.checks.perception?.name, t.checks.perception?.bonus], ['七星灯', 4]);
  assert.equal(t.checks.strength, undefined, '剑加攻击，不加检定');
  assert.equal(t.armor, 0, '灯不是盾牌');
  assert.equal(t.weapon?.name, '精钢剑');
  assert.equal(gearTotals([g(1, 'ring-will'), g(2, 'iron-balls')]).weapon, null, '戒指、铁胆不是武器');
  assert.equal(gearTotals([g(1, 'iron-balls', 'rare')]).checks.strength?.bonus, 3, '铁胆加力量检定');
});

// ==================== 主持工具（规则第二版） ====================

test('主持工具按十六个格子算：检定加同一项属性最高的那件，攻击加主手，受伤按身上几件护甲合起来减', () => {
  const gear = [g(1, 'sword'), g(2, 'mail', 'fine'), g(3, 'helmet', 'fine'), g(4, 'shield', 'rare'), g(5, 'boots'), g(6, 'cloak', 'rare')];
  const ctx = contextOf(hero(gear, { strength: 2 }), [5, 5]);
  const check = JSON.parse(ctx.execute('roll_check', { character: 1, attribute: 'agility', modifier: 0, reason: '溜过去' }).content);
  assert.equal(check.total, 10 + 3);
  assert.match(check.breakdown, /装备「云纹披风」\+3/);
  assert.doesNotMatch(check.breakdown, /轻靴/);
  // 攻击：2d6（3+3）+ 力量 2 + 主手铁剑 1 = 9 ≥ 小怪的防御 8；伤害 1d6（3）+ 1
  ctx.execute('start_combat', { encounter: 'pack', note: '鼠群扑上来' });
  const hit = JSON.parse(ctx.execute('attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '砍' }).content);
  assert.deepEqual([hit.total, hit.hit, hit.damage], [9, true, 4]);
  assert.match(hit.breakdown, /装备「铁剑」\+1/);
  // 受伤：护甲 2 + 2 + 3×2 = 10，减 4；中伤掷出 6，扣 2
  const hurt = JSON.parse(ctx.execute('hurt', { character: 1, severity: 'medium', reason: '塌下来的木头' }).content);
  assert.deepEqual([hurt.rolled, hurt.armor_blocked, hurt.lost_hp], [6, 4, 2]);
  // 护甲挡不住的照旧
  const poison = JSON.parse(ctx.execute('hurt', { character: 1, severity: 'medium', armor: false, reason: '毒气' }).content);
  assert.equal(poison.lost_hp, 6);
});

test('宝物按剧本写的大类挑：weapon 只出主手武器，armor 出护甲和盾牌，accessory 出加检定的（连副手的灯），不写哪一类都可能', () => {
  const seen: Record<string, Set<string>> = { weapon: new Set(), armor: new Set(), accessory: new Set(), any: new Set() };
  for (let i = 0; i < GEAR_BASES.length; i++) {
    for (const kind of Object.keys(seen)) {
      const ctx = contextOf(hero([]), [], (n) => i % n);
      const r = JSON.parse(ctx.execute('give_loot', { character: 1, loot: `gear-${kind}` }).content);
      assert.match(r.found, /（精良）$/);
      const loot = ctx.characters.get(1)!.v2!.loot[0] as { kind: string; base: string };
      assert.equal(loot.kind, 'gear');
      seen[kind].add(loot.base);
      if (kind === 'armor' && loot.base === 'helmet') assert.equal(r.detail, '护住头脸；头部，护甲 +2');
      if (kind === 'armor' && loot.base === 'shield') assert.equal(r.detail, '架住重击；副手，护甲 +4');
    }
  }
  const of = (slot: GearCategory) => new Set(GEAR_BASES.filter((b) => b.slot === slot).map((b) => b.key));
  assert.deepEqual(seen.weapon, of('weapon'));
  assert.deepEqual(seen.armor, of('armor'));
  assert.deepEqual(seen.accessory, of('accessory'));
  assert.deepEqual(seen.any, new Set(GEAR_BASES.map((b) => b.key)));
  assert.ok(of('weapon').has('spear') && of('armor').has('shield') && of('armor').has('greaves') && of('accessory').has('lantern') && of('accessory').has('ring-will'));
});

test('主持 AI 看到的装备是合起来的：主手的攻击、减伤、每一项属性的检定加值，传奇的本事单独一行；不一件件列', () => {
  const gear = [g(1, 'sword', 'fine'), g(2, 'mail'), g(3, 'helmet'), g(4, 'gloves'), g(5, 'bell', 'rare'), g(6, 'ring-perception'), g(7, 'amulet'), anyGearView(8, lantern.key, 'legendary')!];
  const me = hero(gear);
  const scenario = rollDungeonRun(validateScenario(dungeon()).scenario!, () => 0);
  const text = buildDmContext({ scenario, world: emptyWorld(), characters: [me], clues: [], actor: me, action: { content: '四处看看', gameStart: 20 * 60, minutes: 10 }, pending: [], recent: [] });
  const lines = text.split('\n').filter((l) => l.includes('装备'));
  const line = lines.find((l) => l.includes('程序自动算'))!;
  assert.ok(line, lines.join('\n'));
  assert.match(line, /装备（8 件，程序自动算）/);
  assert.match(line, /主手精钢剑（精良，力量攻击和伤害 \+2）/);
  // 皮甲、皮盔、皮手套各 1：护甲 3，减 1
  assert.match(line, /护甲合起来受伤减 1/);
  assert.ok(line.includes(`检定加值：感知 +3（听风铃）、意志 +5（${lantern.name}）`), line);
  for (const name of ['皮盔', '皮手套', '骨戒', '平安符']) assert.ok(!line.includes(name), `${name}不单独列`);
  assert.ok(text.includes(`传奇装备的本事（每局一次，你照着用）：${lantern.name}：${lantern.ability}`));
});

// ==================== V0.7.0 存下来的东西 ====================

test('V0.7.0 存的地下城角色（装备没有部位）读进来补上部位，照样算攻击、减伤、检定；存回去是新的样子', () => {
  const old = {
    attributes: { ...emptyAttributes2(), strength: 2 },
    hp: 12,
    hpMax: 12,
    mp: 10,
    mpMax: 10,
    dying: null,
    lostControl: false,
    gear: [
      { id: 11, base: 'sword', rarity: 'common', name: '铁剑', slot: 'weapon', attribute: 'strength', bonus: 1, use: '近身劈砍' },
      { id: 12, base: 'shield', rarity: 'fine', name: '铁盾', slot: 'armor', attribute: null, bonus: 2, use: '架住重击，受伤时减伤' },
      { id: 13, base: 'bell', rarity: 'rare', name: '听风铃', slot: 'accessory', attribute: 'perception', bonus: 3, use: '察觉埋伏、搜索' },
      { id: 14, base: lantern.key, rarity: 'legendary', name: lantern.name, slot: 'accessory', attribute: 'will', bonus: 5, use: lantern.use, ability: lantern.ability },
    ],
    bag: { potion: 1 },
    loot: [],
    abilitiesUsed: [],
    skills: [],
    boost: 0,
    ward: 0,
    qiyu: 0,
  };
  const s = parseV2(JSON.stringify(old))!;
  assert.deepEqual(
    s.gear.map((x) => [x.id, x.part]),
    [
      [11, 'mainHand'],
      [12, 'offHand'],
      [13, 'trinket'],
      [14, 'offHand'],
    ],
  );
  assert.equal(weaponOf(s)?.name, '铁剑');
  assert.equal(reductionOf(s), 2, '精良盾牌：护甲 2×2 = 4，减 2');
  assert.equal(accessoryFor(s, 'perception')?.name, '听风铃');
  assert.equal(accessoryFor(s, 'will')?.ability, lantern.ability);
  const saved = JSON.parse(JSON.stringify(s)) as V2State;
  assert.ok(saved.gear.every((x) => typeof x.part === 'string'));
  // 认不出来的种类（不该有）按大类放个部位，不让一局卡住
  const odd = parseV2(JSON.stringify({ ...old, gear: [{ id: 1, base: 'nope', rarity: 'rare', name: '怪剑', slot: 'weapon', attribute: 'strength', bonus: 3, use: '' }] }))!;
  assert.deepEqual([odd.gear[0].part, weaponOf(odd)?.bonus], ['mainHand', 3]);
});

test('V0.7.0 的角色卡存的是三个格子：换算成十六个格子，按装备的部位放；两件抢同一格时加值高的留下；放错格子、不在账号里的不算', () => {
  const list = [g(1, 'sword'), g(2, 'mail'), g(3, 'amulet'), g(4, 'shield'), g(5, 'bell'), g(6, 'boots'), g(7, 'bracer'), anyGearView(8, lantern.key, 'legendary')!, g(9, 'fan')];
  const gear = new Map(list.map((x) => [x.id, x]));
  assert.deepEqual(normalizeEquipped({ weapon: 1, armor: 2, accessory: 3 }, gear), { mainHand: 1, chest: 2, neck: 3 });
  assert.deepEqual(normalizeEquipped({ weapon: 1, armor: 4, accessory: 5 }, gear), { mainHand: 1, offHand: 4, trinket1: 5 });
  assert.deepEqual(normalizeEquipped({ accessory: 6 }, gear), { feet: 6 });
  assert.deepEqual(normalizeEquipped({ accessory: 7 }, gear), { wrist: 7 });
  // 盾牌和传奇的灯都要副手：加值高的（灯）留下，盾牌留在账号里
  assert.deepEqual(normalizeEquipped({ armor: 4, accessory: 8 }, gear), { offHand: 8 });
  // 新的样子照旧；饰品格子已经有一件时，老的那件放进空着的另一格
  assert.deepEqual(normalizeEquipped({ trinket1: 9, accessory: 5 }, gear), { trinket1: 9, trinket2: 5 });
  assert.deepEqual(normalizeEquipped({ head: 1, finger2: 99, trinket2: 5, mainHand: 1 }, gear), { trinket2: 5, mainHand: 1 });
  assert.deepEqual(normalizeEquipped('坏了', gear), {});
});

// ==================== 接口 ====================

let now = new Date(2026, 10, 5, 14, 0, 0).getTime();
/** 角色卡那边的随机数（宝箱）：按顺序用，用完了是 0。 */
const cardDice: number[] = [];
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';
let t4 = '';

before(async () => {
  t = await startTestApp({
    ai: new FakeProvider(demoHandler),
    now: () => now,
    tickMs: 0,
    rng: (sides) => Math.min(3, sides),
    petRng: (n) => (cardDice.length ? cardDice.shift()! % n : 0),
  });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
  t4 = await t.login(TESTER4.username, TESTER4.password);
  fs.writeFileSync(path.join(t.app.engine.scenarioFolder, 'gear-cellar.json'), JSON.stringify(dungeon()));
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const stored = (cardId: number) => (t.app.db.prepare('SELECT gear FROM character_cards WHERE id = ?').get(cardId) as { gear: string }).gear;
const SHEET = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };
/** 往账号里放一件装备（像地下城里捡到、宝箱开出来的），返回编号。 */
const giveGear = (username: string, base: string, rarity = 'common') =>
  Number(t.app.db.prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, ?, 'test', ?)").run(userId(username), base, rarity, now).lastInsertRowid);
type CardJson = { id: number; name: string; equipped: Record<string, GearView>; specialties: string[]; power: number };
type PageGear = GearView & { wornBy: { cardId: number; name: string; slot: string } | null };

test('V0.7.0 的角色卡：存的三个格子读出来穿在对应的格子里（剑在主手、盾在副手、铃铛在第一个饰品格）；换一次装备就存成十六个格子', async () => {
  const card = (await as(t1)('POST', '/api/cards', { name: '老卡', ...SHEET })).data.card as CardJson;
  // 新手礼照旧：主手、胸部、颈部
  assert.deepEqual(Object.fromEntries(Object.entries(card.equipped).map(([k, v]) => [k, v.name])), { mainHand: '铁剑', chest: '皮甲', neck: '平安符' });
  const sword = card.equipped.mainHand.id;
  const shield = giveGear(TESTER1.username, 'shield', 'fine');
  const bell = giveGear(TESTER1.username, 'bell', 'rare');
  const old = JSON.stringify({ weapon: sword, armor: shield, accessory: bell });
  t.app.db.prepare('UPDATE character_cards SET gear = ? WHERE id = ?').run(old, card.id);
  const page = (await as(t1)('GET', '/api/cards')).data as { cards: CardJson[]; gear: PageGear[] };
  const mine = page.cards.find((c) => c.id === card.id)!;
  assert.deepEqual(Object.keys(mine.equipped).sort(), ['mainHand', 'offHand', 'trinket1']);
  assert.deepEqual([mine.equipped.offHand.name, mine.equipped.trinket1.name], ['铁盾', '听风铃']);
  assert.deepEqual(page.gear.find((x) => x.id === shield)!.wornBy, { cardId: card.id, name: '老卡', slot: 'offHand' });
  const mail = page.gear.find((x) => x.name === '皮甲')!;
  assert.equal(mail.wornBy, null, '老的护甲格放的是盾牌，皮甲没穿着');
  // 光是读不改数据库；换一次装备就存成新的样子
  assert.equal(stored(card.id), old);
  const r = await as(t1)('PUT', `/api/cards/${card.id}/equip`, { slot: 'chest', gearId: mail.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(JSON.parse(stored(card.id)), { mainHand: sword, offHand: shield, trinket1: bell, chest: mail.id });
  // 战力：属性 4×10 + 装备加值（1 + 2 + 3 + 1）×5 + 生命 12 + 精神 10
  assert.equal(r.data.card.power, 40 + 7 * 5 + 12 + 10);
});

test('穿装备：戒指、饰品放进两个格子里的哪个都行；放不进别的部位；一件装备只能穿在一个地方', async () => {
  const card = (await as(t2)('POST', '/api/cards', { name: '甲', ...SHEET })).data.card as CardJson;
  const other = (await as(t2)('POST', '/api/cards', { name: '乙', ...SHEET })).data.card as CardJson;
  assert.deepEqual(other.equipped, {}, '新手礼只送第一张卡');
  const ringA = giveGear(TESTER2.username, 'ring-will');
  const ringB = giveGear(TESTER2.username, 'ring-charm', 'fine');
  const fan = giveGear(TESTER2.username, 'fan');
  const helmet = giveGear(TESTER2.username, 'helmet');
  const equip = (id: number, slot: string, gearId: number | null) => as(t2)('PUT', `/api/cards/${id}/equip`, { slot, gearId });
  let r = await equip(card.id, 'finger1', ringA);
  assert.equal(r.data.card.equipped.finger1.name, '铁戒');
  r = await equip(card.id, 'finger2', ringB);
  assert.equal(r.data.card.equipped.finger2.name, '翡翠戒');
  r = await equip(card.id, 'trinket2', fan);
  assert.equal(r.data.card.equipped.trinket2.name, '香囊');
  // 同一枚戒指换到另一格：原来那一格空出来，那一格原来的戒指脱下
  r = await equip(card.id, 'finger2', ringA);
  assert.deepEqual([r.data.card.equipped.finger1, r.data.card.equipped.finger2.name], [undefined, '铁戒']);
  // 放不进别的部位
  r = await equip(card.id, 'neck', helmet);
  assert.deepEqual([r.status, r.data.error], [400, '皮盔是头部的装备，放不进颈部']);
  assert.equal((await equip(card.id, 'trinket1', ringB)).status, 400, '戒指不是饰品');
  assert.equal((await equip(card.id, 'weapon', null)).status, 400, '没有「武器」这个格子了');
  r = await equip(card.id, 'head', helmet);
  assert.equal(r.data.card.equipped.head.name, '皮盔');
  // 另一张卡戴上它：这张卡上的就脱下来
  r = await equip(other.id, 'head', helmet);
  assert.equal(r.data.card.equipped.head.name, '皮盔');
  const page = (await as(t2)('GET', '/api/cards')).data as { cards: CardJson[]; gear: PageGear[] };
  assert.equal(page.cards.find((c) => c.id === card.id)!.equipped.head, undefined);
  assert.deepEqual(page.gear.find((x) => x.id === helmet)!.wornBy, { cardId: other.id, name: '乙', slot: 'head' });
  // 卸下
  r = await equip(card.id, 'finger2', null);
  assert.equal(r.data.card.equipped.finger2, undefined);
});

test('宝箱开出来的装备什么部位都有：每一种都可能开到', async () => {
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'chest', ?)").run(userId(TESTER3.username), GEAR_BASES.length);
  const got: string[] = [];
  for (let i = 0; i < GEAR_BASES.length; i++) {
    // 龙晶、开出装备（不是道具）、哪一种、稀有度（普通）
    cardDice.push(0, 99, i, 0);
    const r = await as(t3)('POST', '/api/chests/open');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    got.push(r.data.result.gear.base);
    assert.deepEqual([r.data.result.gear.part, r.data.result.gear.rarity], [GEAR_BASES[i].part, 'common']);
  }
  assert.deepEqual(got, GEAR_BASES.map((b) => b.key));
  const bag = (await as(t3)('GET', '/api/bag')).data as { gear: GearView[] };
  assert.deepEqual(new Set(bag.gear.map((x) => x.part)), new Set(GEAR_PARTS));
  // 最近开的宝箱（「我的角色」页）也带着部位
  const page = (await as(t3)('GET', '/api/cards')).data as { recentChests: { gear: GearView | null }[] };
  assert.equal(page.recentChests[0].gear?.part, GEAR_BASES.at(-1)!.part);
});

test('商城：每种装备的普通版都在卖（gear-种类，价格照旧）；新部位的买得到、穿得上', async () => {
  const shop = (await as(t4)('GET', '/api/shop')).data as { items: { key: string; section: string; price: number; effect: string; gear: GearView | null }[] };
  const item = (key: string) => shop.items.find((i) => i.key === key)!;
  for (const b of GEAR_BASES) {
    const it = item(`gear-${b.key}`);
    assert.ok(it, b.key);
    assert.deepEqual([it.section, it.price, it.gear?.part, it.gear?.rarity], ['gear', COMMON_GEAR_PRICE, b.part, 'common'], b.key);
  }
  assert.equal(item('gear-helmet').effect, '头部，护甲 +1，护住头脸');
  assert.equal(item('gear-shield').effect, '副手，护甲 +2，架住重击');
  assert.equal(item('gear-ring-charm').effect, '戒指，魅力检定 +1，交涉、说服、骗人');
  assert.equal(item('gear-sword').effect, '主手，力量攻击 +1，近身劈砍');
  await as(admin)('POST', `/api/admin/users/${userId(TESTER4.username)}/crystals`, { amount: 500, note: '测试' });
  const r = await as(t4)('POST', '/api/shop/buy', { item: 'gear-pauldrons', count: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bag = (await as(t4)('GET', '/api/bag')).data as { gear: GearView[] };
  assert.deepEqual(
    bag.gear.map((x) => [x.base, x.part, x.name]),
    [['pauldrons', 'shoulder', '皮护肩']],
  );
});

test('专长从列表里挑：六七十个、分几组；做卡、学新专长只能挑列表里的；以前自己写的专长照样留着', async () => {
  assert.ok(CARD2_SPECIALTIES.length >= 60 && CARD2_SPECIALTIES.length <= 70, String(CARD2_SPECIALTIES.length));
  assert.equal(new Set(CARD2_SPECIALTIES).size, CARD2_SPECIALTIES.length, '不重样');
  assert.ok(CARD2_SPECIALTY_GROUPS.length >= 5);
  assert.ok(CARD2_SPECIALTIES.every((s) => [...s].length <= 10));
  // 以前的测试、剧本里常用的
  for (const s of ['剑术', '攀爬', '追踪', '刀法', '机关', '草药', '医术', '射箭']) assert.ok(CARD2_SPECIALTIES.includes(s), s);
  const make = (name: string, specialties: string[]) => as(t4)('POST', '/api/cards', { name, attributes: SHEET.attributes, specialties });
  let r = await make('会飞的', ['剑术', '会飞']);
  assert.deepEqual([r.status, r.data.error], [400, '「会飞」不在专长列表里']);
  assert.equal((await make('两个剑术', ['剑术', '剑术'])).status, 400);
  assert.equal((await make('一个专长', ['剑术'])).status, 400);
  assert.equal((await make('没选', ['剑术', ''])).status, 400);
  r = await make('剑客', ['剑术', '轻功']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const card = r.data.card as CardJson;
  await as(admin)('POST', `/api/admin/cards/${card.id}/points`, { points: 8 });
  r = await as(t4)('POST', `/api/cards/${card.id}/grow`, { type: 'specialty', name: '会飞' });
  assert.equal(r.status, 400);
  r = await as(t4)('POST', `/api/cards/${card.id}/grow`, { type: 'specialty', name: '追踪' });
  assert.deepEqual(r.data.card.specialties, ['剑术', '轻功', '追踪']);
  r = await as(t4)('POST', `/api/cards/${card.id}/grow`, { type: 'specialty', name: '轻功' });
  assert.equal(r.status, 409, '已经有了');
  // 以前自己写的（不在列表里）照样留着：改名字、还没打过地下城的卡重新分属性都不用换
  const old = (await make('老专长', ['医术', '草药'])).data.card as CardJson;
  t.app.db.prepare('UPDATE character_cards SET specialties = ? WHERE id = ?').run(JSON.stringify(['打听消息', '速记']), old.id);
  r = await as(t4)('PUT', `/api/cards/${old.id}`, { name: '老专长的卡', attributes: { ...SHEET.attributes, strength: 1, constitution: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.card.name, r.data.card.specialties, r.data.card.attributes.constitution], ['老专长的卡', ['打听消息', '速记'], 2]);
  r = await as(t4)('PUT', `/api/cards/${old.id}`, { specialties: ['打听消息', '剑术'] });
  assert.deepEqual(r.data.card.specialties, ['打听消息', '剑术'], '留一个以前的、换一个列表里的');
  r = await as(t4)('PUT', `/api/cards/${old.id}`, { specialties: ['打听消息', '会飞'] });
  assert.equal(r.status, 400);
});

test('V0.7.0 开始的地下城（角色身上的装备没有部位）照样打得下去：看得到部位，受伤按几件护甲合起来减，存回去是新的样子', async () => {
  const card = ((await as(t1)('GET', '/api/cards')).data.cards as CardJson[]).find((c) => c.name === '老卡')!;
  const room = (await as(t1)('POST', '/api/rooms', { name: '老地窖', maxPlayers: 2, scenarioKey: 'gear-cellar' })).data.room;
  let r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId: card.id, bag: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const parts = ['chest', 'mainHand', 'offHand', 'trinket'];
  assert.deepEqual((r.data.me.v2.gear as GearView[]).map((x) => x.part).sort(), parts);
  // 改成 V0.7.0 存的样子：装备没有部位
  const row = t.app.db.prepare('SELECT id, v2 FROM characters WHERE room_id = ?').get(room.id) as { id: number; v2: string };
  const v2 = JSON.parse(row.v2) as { gear: Record<string, unknown>[] };
  v2.gear = v2.gear.map(({ part: _part, ...rest }) => rest);
  t.app.db.prepare('UPDATE characters SET v2 = ? WHERE id = ?').run(JSON.stringify(v2), row.id);
  const v2Now = () => (t.app.db.prepare('SELECT v2 FROM characters WHERE id = ?').get(row.id) as { v2: string }).v2;
  assert.ok(!v2Now().includes('"part"'));
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  let game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.deepEqual((game.me.v2.gear as GearView[]).map((x) => x.part).sort(), parts);
  // 受伤：皮甲 1 + 铁盾（精良）2×2 = 护甲 5，减 2；轻伤掷出 3，扣 1
  const res = await as(t1)('POST', `/api/rooms/${room.id}/actions`, { content: '测试受伤：被砖头砸了一下' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await t.app.engine.idle();
  now += 125 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.me.v2.hp, game.me.v2.hpMax - 1);
  assert.match(v2Now(), /"part":"offHand"/);
});
