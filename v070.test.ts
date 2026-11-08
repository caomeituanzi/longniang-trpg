// 时间按东京算
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { MIGRATIONS } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { LEGENDARY_GEAR } from '../server/legendary';
import { SKILLS } from '../server/skills';
import { newV2State, type V2State } from '../server/game/rules2';
import { rollDungeonRun, validateScenario, type Scenario } from '../server/game/scenario';
import { Rules2Context, dmTools2 } from '../server/game/tools2';
import { buildDmContext } from '../server/game/prompts';
import { emptyWorld, type Character } from '../server/game/world';
import {
  DYING_TURNS,
  emptyAttributes2,
  enemyStats,
  growthPoints,
  levelPenalty,
  raiseCost,
  shorthandedPenalty,
  startAttributesProblem,
  type Attributes2,
} from '../shared/rules2';
import { gearView } from '../shared/gear2';
import { startTestApp } from './helpers';

// V0.7.0：规则第二版（七项属性、生命值和精神值、战斗、道具、宝物、技能、奇遇）、地下城、角色卡、宝箱、切磋、排行。

const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;
const MIN = 60_000;

// ==================== 规则的数字 ====================

test('规则第二版的数字：敌人按难度算、成长点、加点越来越贵、新卡分点、难度和人手不足的减值', () => {
  assert.deepEqual(enemyStats('minion', 1, 'small'), { hp: 6, defense: 8, attack: 0, initiative: 0, maxSeverity: 'light', damageBonus: 0 });
  assert.equal(enemyStats('boss', 1, 'small').hp, 18);
  assert.equal(enemyStats('boss', 1, 'large').hp, 36, '大型的首领生命值翻倍');
  assert.equal(enemyStats('elite', 5, 'small').damageBonus, 2);
  assert.equal(enemyStats('minion', 1, 'small', { hp: -10 }).hp, 1, '微调以后至少 1 点生命');
  assert.equal(growthPoints(1, 'small', 'clear'), 2);
  assert.equal(growthPoints(3, 'large', 'clear'), 8);
  assert.equal(growthPoints(3, 'large', 'escape'), 4);
  assert.equal(growthPoints(9, 'large', 'fail'), 0);
  assert.deepEqual([-1, 0, 1, 2, 5].map(raiseCost), [1, 1, 2, 3, 6]);
  assert.equal(levelPenalty(1), 0);
  assert.equal(levelPenalty(6), -5);
  assert.equal(shorthandedPenalty('large', 2), -2);
  assert.equal(shorthandedPenalty('small', 1), 0);
  const ok: Attributes2 = { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 };
  assert.equal(startAttributesProblem(ok), null);
  assert.match(startAttributesProblem({ ...ok, charm: 0 })!, /正好是 4/);
  assert.match(startAttributesProblem({ ...ok, strength: 3, charm: -2 })!, /之间/);
});

// ==================== 地下城的剧本格式 ====================

/** 一个最小的地下城：小型、难度 1，两种真相，鼠群在地窖或入口，首领怕火或怕猫。 */
function miniDungeon(): Record<string, any> {
  return {
    format: 'longniang-trpg/scenario@1',
    title: '测试地窖',
    category: 'dungeon',
    rules: 2,
    intro: '一个测试用的小地窖。',
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
        { key: 'potions', places: ['cellar'], how: '酒坛后面的箱子', reward: { kind: 'item', item: 'potion', count: 2 } },
        { key: 'blade', places: ['cellar'], how: '骨头堆里', reward: { kind: 'gear', slot: 'weapon', rarity: 'fine' } },
        { key: 'book', places: ['nest'], how: '鼠王身下', reward: { kind: 'manual' } },
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

test('地下城的格式：写对了通过；没有通关的结局、小型放传奇、首领不是首领、变化里的线索写错、大型没写护盾都是错误', () => {
  const ok = validateScenario(miniDungeon());
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.scenario?.dungeon?.level, 1);
  assert.equal(ok.scenario?.rules, 2);

  const broken = miniDungeon();
  broken.endings = broken.endings.filter((e: { result: string }) => e.result !== 'clear');
  broken.dungeon.loot.push({ key: 'leg', places: ['nest'], how: '藏着', reward: { kind: 'legendary' } });
  broken.dungeon.enemies[1].tier = 'elite';
  broken.dungeon.variants[1].clues = { nope: '没有这条线索' };
  const errors = validateScenario(broken).errors.join('\n');
  assert.match(errors, /至少要有一个通关的结局/);
  assert.match(errors, /传奇装备只在大型地下城里掉/);
  assert.match(errors, /tier 要是 boss/);
  assert.match(errors, /clues 里没有「nope」/);

  const large = miniDungeon();
  large.dungeon.size = 'large';
  large.players = { min: 2, max: 4 };
  large.roles.push(
    { key: 'a', name: '甲', public: '甲', secret: '', goal: '甲', startLocation: 'cellar' },
    { key: 'b', name: '乙', public: '乙', secret: '', goal: '乙', startLocation: 'cellar' },
  );
  assert.match(validateScenario(large).errors.join('\n'), /要写 shield/);

  // 地下城以外的第二版剧本：身份要写七项属性，每项 -2～+3，加起来正好 4
  const plain = miniDungeon();
  plain.category = 'combat';
  delete plain.dungeon;
  for (const e of plain.endings) delete e.result;
  for (const r of plain.roles) Object.assign(r, { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 1, perception: 0, will: 0, charm: -1 }, specialties: ['射箭', '追踪'], appearance: '' });
  assert.deepEqual(validateScenario(plain).errors, []);
  plain.roles[0].attributes.charm = 0;
  assert.match(validateScenario(plain).errors.join('\n'), /roles\[0\]\.attributes：七项属性加起来要正好是 4，现在是 5/);
});

test('装进对局时挑这一局的变化：真相接在后面、线索和 NPC 换成这一种的、别的变化去掉', () => {
  const s = validateScenario(miniDungeon()).scenario!;
  const run = rollDungeonRun(s, (n) => n - 1);
  assert.equal(run.dungeon?.run?.variant, 'curse');
  assert.match(run.truth.summary, /【这一局的真相：诅咒】有人在地窖下了诅咒/);
  assert.equal(run.clues.find((c) => c.key === 'note')?.content, '账本上写着有人往地窖里扔过符纸。');
  assert.deepEqual(run.npcs[0].knows, ['有人扔过符纸']);
  assert.equal(run.dungeon?.variants.length, 1);
  assert.equal(run.dungeon?.boss.weaknesses.length, 1);
  assert.equal(run.dungeon?.encounters[0].at, 'cellar');
  assert.equal(rollDungeonRun(run, () => 0), run, '挑过的不再挑');
});

// ==================== 主持工具（规则第二版） ====================

function v2Character(id: number, attributes: Partial<Attributes2>, extra: Partial<V2State> = {}): Character {
  const attrs = { ...emptyAttributes2(), ...attributes };
  const state = { ...newV2State(attrs, [gearView(1, 'sword', 'common')!, gearView(2, 'mail', 'fine')!, gearView(3, 'bell', 'rare')!], { potion: 1, 'fire-oil': 1, smoke: 1 }, ['pojun', 'huichun']), ...extra };
  return {
    id,
    roomId: 1,
    playerId: id,
    userId: id,
    playerName: `玩家${id}`,
    roleKey: id === 1 ? 'hunter' : 'monk',
    name: id === 1 ? '阿猎' : '慧明',
    attributes: attrs as unknown as Character['attributes'],
    specialties: ['射箭', '医术'],
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
    cardId: id,
    background: '',
    gear: [],
    v2: state,
  };
}

function context2(characters: Character[], dice: number[], opts: { level?: number; allowDeath?: boolean; pick?: (n: number) => number; owned?: Set<string> } = {}) {
  const base = validateScenario(miniDungeon()).scenario!;
  const scenario: Scenario = rollDungeonRun({ ...base, dungeon: { ...base.dungeon!, level: opts.level ?? 1 } }, () => 0);
  const rolls = [...dice];
  return new Rules2Context({
    scenario,
    world: emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: characters[0].id,
    gameEnd: 100,
    rng: (sides) => (rolls.length ? rolls.shift()! : Math.min(3, sides)),
    allowDeath: opts.allowDeath ?? true,
    players: characters.length,
    pick: opts.pick ?? (() => 0),
    ownedLegendary: new Map([[1, opts.owned ?? new Set<string>()]]),
  });
}

test('规则第二版的检定：七项属性、对应的饰品自动加、难度减值；只给这一局用得上的工具', () => {
  const ctx = context2([v2Character(1, { perception: 2 })], [5, 5], { level: 3 });
  const r = JSON.parse(ctx.execute('roll_check', { character: 1, attribute: 'perception', modifier: 1, reason: '找暗门' }).content);
  // 5+5 + 感知 2 + 铜铃（稀有 +3）+ 修正 1 − 难度 2
  assert.equal(r.total, 10 + 2 + 3 + 1 - 2);
  assert.match(r.breakdown, /装备「听风铃」\+3/);
  assert.match(r.breakdown, /难度-2/);
  assert.equal(ctx.cards[0].attribute, '感知');
  const bad = ctx.execute('roll_check', { character: 1, attribute: 'body', modifier: 0, reason: 'x' });
  assert.ok(bad.isError, '第二版没有「体魄」');

  const names = (s: Scenario, skills = false) => dmTools2(s, { skills }).map((t) => t.name);
  const dungeon = validateScenario(miniDungeon()).scenario!;
  assert.ok(names(dungeon).includes('give_loot'));
  assert.ok(!names(dungeon).includes('use_skill'));
  assert.ok(names(dungeon, true).includes('use_skill'));
  const plain = { ...dungeon, dungeon: null, enemies: undefined };
  assert.ok(!names(plain).includes('start_combat'), '没写敌人的剧本没有战斗工具');
  assert.ok(!names(plain).includes('use_item'));
});

test('战斗：开打掷先后手、攻击按防御算、打倒敌人、敌人还手扣血（护甲减伤）', () => {
  const ctx = context2([v2Character(1, { strength: 2, agility: 1, constitution: 1 })], [6, 6, 1, 1, 2, 3]);
  const start = JSON.parse(ctx.execute('start_combat', { encounter: 'pack', note: '鼠群扑上来' }).content);
  assert.equal(start.enemies.length, 2);
  assert.equal(start.enemies[0].id, 'rat-1');
  assert.equal(start.enemies[0].defense, 8);
  assert.ok(ctx.world.combats.cellar);
  assert.ok(ctx.events.some((e) => e.startsWith('开打：大老鼠 ×2')));
  // 攻击：4+4 + 力量 2 + 铁剑 1 = 11 ≥ 8，伤害 1d6(3) + 1 = 4
  const ctx2 = context2([v2Character(1, { strength: 2 })], []);
  ctx2.execute('start_combat', { encounter: 'pack', note: 'x' });
  const hit = JSON.parse(ctx2.execute('attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '砍' }).content);
  assert.equal(hit.hit, true);
  assert.equal(hit.damage, 3 + 1);
  assert.equal(ctx2.world.combats.cellar.enemies[0].hp, 6 - 4);
  const kill = JSON.parse(ctx2.execute('attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '再砍' }).content);
  assert.equal(kill.enemy.defeated, true);
  assert.ok(ctx2.events.includes('大老鼠倒下了'));
  assert.ok(ctx2.execute('attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '鞭尸' }).isError);
  assert.equal(ctx2.cards.at(-1)?.combat?.kind, 'attack');
  // 敌人还手：小怪最多轻伤，按中伤要求也只算轻；软甲（精良，护甲 2）减伤 2（V0.7.1：护甲点 ÷ 3 往上取整，不低于最好的那一件），至少 1
  const back = JSON.parse(ctx2.execute('enemy_attack', { enemy: 'rat-2', character: 1, severity: 'medium' }).content);
  assert.ok(back.notes.some((n: string) => n.includes('最多造成轻伤')));
  if (back.hit) assert.equal(back.damage, 3 - 2);
});

test('打着仗走开：从先后手里拿掉，敌人打不到；那里一个同伴都不剩，那场战斗就结束', () => {
  const ctx = context2([v2Character(1, { agility: 1 }), v2Character(2, {})], []);
  ctx.execute('start_combat', { encounter: 'pack', note: '鼠群扑上来' });
  assert.ok(ctx.world.combats.cellar.order.some((o) => o.id === 'c2'));
  const away = JSON.parse(ctx.execute('move_character', { character: 2, location: 'entrance' }).content);
  assert.match(away.combat, /慧明离开了「地窖」的战斗/);
  assert.ok(!ctx.world.combats.cellar.order.some((o) => o.id === 'c2'), '走开的人不在先后手里了');
  assert.ok(ctx.world.combats.cellar.order.some((o) => o.id === 'c1'), '还有人在打，战斗还在');
  assert.ok(ctx.execute('enemy_attack', { enemy: 'rat-1', character: 2, severity: 'light' }).isError, '走开的人敌人打不到');
  const last = JSON.parse(ctx.execute('move_character', { character: 1, location: 'entrance' }).content);
  assert.match(last.combat, /那场战斗结束/);
  assert.equal(ctx.world.combats.cellar, undefined);
  assert.ok(ctx.events.includes('大家都离开了「地窖」，那里的战斗结束了'));
});

test('倒地濒死：没人救的话这里再结算三次就死；房主选了不会死就停在濒死；喝药水能救回来', () => {
  const me = v2Character(1, { constitution: -1 }, { hp: 2 });
  const ctx = context2([me], [6, 6]);
  JSON.parse(ctx.execute('hurt', { character: 1, severity: 'heavy', armor: false, reason: '塌方' }).content);
  const c = ctx.characters.get(1)!;
  assert.equal(c.v2!.hp, 0);
  assert.equal(c.v2!.dying, DYING_TURNS);
  ctx.finish();
  assert.equal(c.v2!.dying, DYING_TURNS, '刚倒下的这一次不算');
  // 下一次结算：同一个地点的另一个人行动
  let world = ctx.world;
  let chars = [...ctx.characters.values()];
  for (let i = 0; i < DYING_TURNS; i++) {
    const next = new Rules2Context({
      scenario: ctx.scenario,
      world,
      characters: [...chars, v2Character(2, {})].filter((x, j, a) => a.findIndex((y) => y.id === x.id) === j),
      clueHolders: new Map(),
      actorId: 2,
      gameEnd: 200,
      rng: () => 3,
      allowDeath: true,
      players: 2,
    });
    next.finish();
    world = next.world;
    chars = [...next.characters.values()];
  }
  assert.equal(chars.find((x) => x.id === 1)!.dead, true);

  const safe = context2([v2Character(1, {}, { hp: 0, dying: 1 })], [], { allowDeath: false });
  safe.finish();
  assert.equal(safe.characters.get(1)!.dead, false);
  // 药水：同伴喂给倒地的人
  const save = context2([v2Character(2, {}), v2Character(1, {}, { hp: 0, dying: 2 })], [4, 4]);
  const r = JSON.parse(save.execute('use_item', { character: 2, item: 'potion', target_character: 1 }).content);
  assert.match(r.result.join(), /从濒死被救回来了/);
  assert.equal(save.characters.get(1)!.v2!.dying, null);
  assert.equal(save.characters.get(1)!.v2!.hp, 4 + 4 + 2);
  assert.equal(save.characters.get(2)!.v2!.bag.potion, undefined, '用掉了');
  assert.deepEqual(save.itemUses, [{ characterId: 2, item: 'potion' }]);
  assert.ok(save.execute('use_item', { character: 2, item: 'potion' }).isError, '没有了');
});

test('宝物：这一局放在哪才在哪拿得到，拿过的不能再拿；传奇的只给还没有的；秘籍挑没学过的技能', () => {
  const ctx = context2([v2Character(1, {})], []);
  const got = JSON.parse(ctx.execute('give_loot', { character: 1, loot: 'blade' }).content);
  assert.match(got.found, /（精良）/);
  assert.ok(ctx.execute('give_loot', { character: 1, loot: 'blade' }).isError);
  assert.ok(ctx.execute('give_loot', { character: 1, loot: 'book' }).isError, '秘籍在鼠窝，人在地窖');
  ctx.characters.get(1)!.location = 'nest';
  const book = JSON.parse(ctx.execute('give_loot', { character: 1, loot: 'book' }).content);
  assert.match(book.found, /秘籍《/);
  const loot = ctx.characters.get(1)!.v2!.loot;
  assert.equal(loot.length, 2);
  const manual = loot[1] as { kind: string; skill: string };
  assert.equal(manual.kind, 'manual');
  assert.ok(!['pojun', 'huichun'].includes(manual.skill), '不给已经会的');

  // 传奇（大型才有）：已经有第一件的话给第二件
  const base = miniDungeon();
  base.dungeon.size = 'large';
  base.dungeon.boss.shield = '两个人同时堵住两个洞口';
  base.players = { min: 1, max: 4 };
  base.roles.push(
    { key: 'a', name: '甲', public: '甲', secret: '', goal: '甲', startLocation: 'cellar' },
    { key: 'b', name: '乙', public: '乙', secret: '', goal: '乙', startLocation: 'cellar' },
  );
  base.dungeon.loot.push({ key: 'leg', places: ['cellar'], how: '藏着', reward: { kind: 'legendary' } });
  const scenario = rollDungeonRun(validateScenario(base).scenario!, () => 0);
  const big = new Rules2Context({
    scenario,
    world: emptyWorld(),
    characters: [v2Character(1, {})],
    clueHolders: new Map(),
    actorId: 1,
    gameEnd: 1,
    rng: () => 3,
    players: 1,
    pick: () => 0,
    ownedLegendary: new Map([[1, new Set([LEGENDARY_GEAR[0].key])]]),
  });
  const leg = JSON.parse(big.execute('give_loot', { character: 1, loot: 'leg' }).content);
  assert.match(leg.found, new RegExp(LEGENDARY_GEAR[1].name));
  // 大型：首领开打时有护盾，打不动；配合破开以后才打得动
  big.execute('start_combat', { enemies: [{ enemy: 'rat-king', count: 1 }], note: '鼠王' });
  const blocked = JSON.parse(big.execute('attack', { character: 1, enemy: 'rat-king-1', attribute: 'strength', modifier: 3, reason: '砍' }).content);
  if (blocked.hit) assert.equal(blocked.damage, 0);
  big.execute('update_enemy', { enemy: 'rat-king-1', shielded: false, note: '洞口堵住了' });
  assert.equal(big.world.combats.cellar.enemies[0].shielded, false);
});

test('技能：花精神值，精神值不够不扣；强力一击加命中和伤害；回春术能救倒地的人', () => {
  const ctx = context2([v2Character(1, { strength: 1 }), v2Character(2, {}, { hp: 0, dying: 2 })], [5, 5, 4, 4, 4]);
  ctx.execute('start_combat', { encounter: 'pack', note: 'x' });
  const strike = JSON.parse(ctx.execute('use_skill', { character: 1, skill: 'pojun', target_enemy: 'rat-1', reason: '聚力一击' }).content);
  assert.equal(strike.mp, `${10 - 3}/10`);
  assert.equal(strike.hit, true);
  assert.match(strike.breakdown, /技能\+2/);
  const heal = JSON.parse(ctx.execute('use_skill', { character: 1, skill: 'huichun', target_character: 2, reason: '回春' }).content);
  assert.match(heal.result.join(), /从濒死被救回来了/);
  const me = ctx.characters.get(1)!.v2!;
  assert.equal(me.mp, 10 - 3 - 4);
  const before = me.mp;
  assert.ok(ctx.execute('use_skill', { character: 1, skill: 'huichun', target_character: 2, reason: 'again' }).isError);
  assert.equal(me.mp, before, '用不了不扣精神值');
  assert.ok(ctx.execute('use_skill', { character: 1, skill: 'lianzhu', reason: 'x' }).isError, '不会的技能');
  assert.ok(SKILLS.length >= 10);
});

test('奇遇：属性够高、走到新地方有机会碰上，得到秘籍或装备；每人每局最多一次', () => {
  const ctx = context2([v2Character(1, { intellect: 5 })], [], { pick: () => 0 });
  const moved = JSON.parse(ctx.execute('move_character', { character: 1, location: 'nest' }).content);
  assert.ok(moved.qiyu, '智识 5 ≥ 难度 1 + 2');
  assert.ok(ctx.events.some((e) => e.startsWith('〔奇遇〕')));
  assert.equal(ctx.characters.get(1)!.v2!.qiyu, 1);
  const again = JSON.parse(ctx.execute('move_character', { character: 1, location: 'cellar' }).content);
  assert.equal(again.qiyu, undefined);
  const weak = context2([v2Character(1, {})], [], { pick: () => 0 });
  assert.equal(JSON.parse(weak.execute('move_character', { character: 1, location: 'nest' }).content).qiyu, undefined, '属性不够碰不上');
  // 回到这一局去过的地方、原地「移动」都不算走到新地方
  const back = context2([v2Character(1, { intellect: 5 })], [], { pick: () => 0 });
  back.characters.get(1)!.visited.push('nest');
  assert.equal(JSON.parse(back.execute('move_character', { character: 1, location: 'nest' }).content).qiyu, undefined, '去过的地方');
  assert.equal(JSON.parse(back.execute('move_character', { character: 1, location: 'nest' }).content).qiyu, undefined, '本来就在这里');
  assert.ok(JSON.parse(back.execute('move_character', { character: 1, location: 'entrance' }).content).qiyu, '没去过的地方');
});

// ==================== 模拟第二局后修的（V0.7.1） ====================

test('物品名太长：只记下前 20 个字，并告诉主持人写短一点；地下城里没人选的身份当他们没来', () => {
  const ctx = context2([v2Character(1, {})], []);
  const r = JSON.parse(ctx.execute('update_character', { character: 1, add_items: ['一卷用皮筋扎着的钞票（道班门口狐皮帽瘦高个给的封口费）'] }).content);
  assert.equal(ctx.characters.get(1)!.items[0], '一卷用皮筋扎着的钞票（道班门口狐皮帽瘦高');
  assert.ok(r.changes.some((x: string) => x.includes('太长，只记下了前 20 个字')), JSON.stringify(r.changes));
  const short = JSON.parse(ctx.execute('update_character', { character: 1, add_items: ['封口费'] }).content);
  assert.ok(!short.changes.some((x: string) => x.includes('太长')));

  const scenario = rollDungeonRun(validateScenario(miniDungeon()).scenario!, () => 0);
  const me = v2Character(1, {});
  const text = buildDmContext({ scenario, world: emptyWorld(), characters: [me], clues: [], actor: me, action: { content: '四处看看', gameStart: 20 * 60, minutes: 10 }, pending: [], recent: [] });
  assert.ok(text.includes('这一局没人选的身份：「游僧」。这一局没有这些人'));
});

// ==================== 模拟一局后修的（V0.7.0） ====================

test('捡到的道具当场能用（不扣账号里的）；道具能给 NPC 用；秘籍可以挑一门对得上的', () => {
  const ctx = context2([v2Character(1, {}, { bag: {}, hp: 3 })], [4, 4]);
  const me = ctx.characters.get(1)!;
  // 没带药水，捡到两瓶
  let r = JSON.parse(ctx.execute('give_loot', { character: 1, loot: 'potions' }).content);
  assert.match(r.note, /这一局就能用/);
  r = JSON.parse(ctx.execute('use_item', { character: 1, item: 'potion' }).content);
  assert.match(r.result.join(''), /生命值 3 → /);
  assert.equal((me.v2!.loot.find((l) => l.kind === 'item') as { count: number }).count, 1, '捡到的少了一瓶');
  assert.deepEqual(ctx.itemUses, [], '捡到的用掉不扣账号背包');
  // 给 NPC 用
  r = JSON.parse(ctx.execute('use_item', { character: 1, item: 'potion', target_npc: 'keeper' }).content);
  assert.equal(r.target, '看窖人');
  assert.ok(!me.v2!.loot.some((l) => l.kind === 'item'), '两瓶都用掉了');
  assert.ok(ctx.events.some((e) => e.includes('给看窖人用了治疗药水')));
  assert.ok(ctx.execute('use_item', { character: 1, item: 'potion' }).isError, '没有了');
  // 秘籍：主持人挑一门
  me.location = 'nest';
  r = JSON.parse(ctx.execute('give_loot', { character: 1, loot: 'book', skill: 'qingxin' }).content);
  assert.equal(r.found, '秘籍《清心诀》');
});

test('用技能打首领也能用上弱点；逃走的敌人记成逃走、不是倒下', () => {
  const ctx = context2([v2Character(1, { strength: 2 })], [6, 5, 6, 6, 5, 6, 3]);
  ctx.characters.get(1)!.location = 'nest';
  ctx.execute('start_combat', { enemies: [{ enemy: 'rat-king', count: 1 }, { enemy: 'rat', count: 1 }] });
  const fight = Object.values(ctx.world.combats)[0];
  const king = fight.enemies.find((e) => e.key === 'rat-king')!;
  const r = JSON.parse(ctx.execute('use_skill', { character: 1, skill: 'pojun', target_enemy: king.id, weakness: true, reason: '照着烧焦的地方劈' }).content);
  assert.match(JSON.stringify(r), /弱点/);
  const rat = fight.enemies.find((e) => e.key === 'rat')!;
  const g = JSON.parse(ctx.execute('update_enemy', { enemy: rat.id, gone: true, note: '吓跑了' }).content);
  assert.equal(g.now.fled, true);
  assert.equal(g.now.in_fight, false);
});

// ==================== 接口：角色卡、宝箱、切磋、地下城 ====================

let now = new Date(2026, 10, 2, 14, 0, 0).getTime();
const dice: number[] = [];
const rng = (sides: number) => (dice.length ? dice.shift()! : Math.min(4, sides));
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0, rng, petRng: () => 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  fs.writeFileSync(path.join(t.app.engine.scenarioFolder, 'mini-dungeon.json'), JSON.stringify(miniDungeon()));
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const SHEET = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };

test('第 17 版的数据库（以后的版本照样有这些）', () => {
  assert.ok(MIGRATIONS.length >= 17);
  const columns = (table: string) => (t.app.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns('characters').includes('v2'));
  assert.ok(columns('users').includes('avatar_frame'));
  assert.ok(columns('character_cards').includes('skills'));
});

test('角色卡：分点不对不让做；第一张送三件普通装备并穿上；用成长点加属性越来越贵；研读秘籍学技能', async () => {
  let r = await as(t1)('POST', '/api/cards', { name: '阿猎', ...SHEET, attributes: { ...SHEET.attributes, charm: 0 } });
  assert.equal(r.status, 400);
  r = await as(t1)('POST', '/api/cards', { name: '阿猎', appearance: '黑脸膛', ...SHEET });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const card = r.data.card;
  assert.equal(card.hpMax, 12);
  // V0.7.1 起是十六个格子：剑在主手、皮甲在胸部、平安符在颈部
  assert.equal(card.equipped.mainHand.name, '铁剑');
  assert.equal(card.equipped.chest.name, '皮甲');
  assert.equal(card.equipped.neck.name, '平安符');
  r = await as(t1)('POST', `/api/cards/${card.id}/grow`, { type: 'attribute', key: 'strength' });
  assert.equal(r.status, 409, '没有成长点');
  r = await as(admin)('POST', `/api/admin/cards/${card.id}/points`, { points: 7 });
  assert.equal(r.status, 200);
  r = await as(t1)('POST', `/api/cards/${card.id}/grow`, { type: 'attribute', key: 'strength' });
  assert.equal(r.data.card.attributes.strength, 3);
  assert.equal(r.data.card.points, 7 - 3);
  r = await as(t1)('POST', `/api/cards/${card.id}/grow`, { type: 'specialty', name: '追踪' });
  assert.deepEqual(r.data.card.specialties, ['剑术', '攀爬', '追踪']);
  assert.equal(r.data.card.points, 0);
  // 秘籍
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'manual:pojun', 1)").run(userId('tester1'));
  r = await as(t1)('POST', `/api/cards/${card.id}/learn`, { manual: 'manual:pojun' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.skills[0].name, '破军一击');
  r = await as(t1)('POST', `/api/cards/${card.id}/learn`, { manual: 'manual:pojun' });
  assert.equal(r.status, 409);
  // 换装备：脱下武器
  r = await as(t1)('PUT', `/api/cards/${card.id}/equip`, { slot: 'mainHand', gearId: null });
  assert.equal(r.data.card.equipped.mainHand, undefined);
  const page = (await as(t1)('GET', '/api/cards')).data;
  const sword = page.gear.find((g: { name: string }) => g.name === '铁剑');
  r = await as(t1)('PUT', `/api/cards/${card.id}/equip`, { slot: 'mainHand', gearId: sword.id });
  assert.equal(r.data.card.equipped.mainHand.name, '铁剑');
  r = await as(t1)('PUT', `/api/cards/${card.id}/equip`, { slot: 'chest', gearId: sword.id });
  assert.equal(r.status, 400, '剑放不进胸部');
});

test('宝箱：没有不能开；开出龙晶，再加道具或者装备', async () => {
  let r = await as(t2)('POST', '/api/chests/open');
  assert.equal(r.status, 409);
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'chest', 2)").run(userId('tester2'));
  r = await as(t2)('POST', '/api/chests/open');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.result.crystals > 0);
  assert.ok(r.data.result.item || r.data.result.gear);
  assert.equal(r.data.chests, 1);
});

test('切磋：三轮比属性，赢的得龙晶；双方的胜负记在卡上；排行里有战力榜', async () => {
  const mine = (await as(t1)('GET', '/api/cards')).data.cards[0];
  const theirs = (await as(t2)('POST', '/api/cards', { name: '慧明', ...SHEET, attributes: { strength: -1, constitution: 1, agility: 1, intellect: 1, perception: 1, will: 1, charm: 0 } })).data.card;
  let r = await as(t1)('POST', `/api/cards/${mine.id}/duel`, { opponent: mine.id });
  assert.equal(r.status, 400, '不能和自己的卡切磋');
  r = await as(t1)('POST', `/api/cards/${mine.id}/duel`, { opponent: theirs.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const duel = r.data.duel;
  assert.ok(duel.rounds.length >= 3);
  const after1 = (await as(t1)('GET', '/api/cards')).data.cards[0];
  assert.equal(after1.duel.wins + after1.duel.losses, 1);
  const ranks = (await as(t1)('GET', '/api/rankings/cards')).data;
  assert.ok(ranks.power.some((x: { name: string; me: boolean }) => x.name === '阿猎' && x.me));
  assert.ok(ranks.wins.length >= 1);
  assert.ok((await as(t2)('GET', '/api/notifications')).data.items.some((n: { kind: string }) => n.kind === 'duel'), '被挑战的人收到通知');
});

test('地下城：只能带角色卡进去；带的道具不能超过背包里有的；生命值、精神值从满的开始；打完按结局结算', async () => {
  const card = (await as(t1)('GET', '/api/cards')).data.cards[0];
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'potion', 2) ON CONFLICT DO UPDATE SET count = 2").run(userId('tester1'));
  const room = (await as(t1)('POST', '/api/rooms', { name: '刷地窖', maxPlayers: 2, scenarioKey: 'mini-dungeon' })).data.room;
  let game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.scenario.dungeon.level, 1);
  assert.deepEqual(game.scenario.roles[0].attributes, {}, '地下城的身份没有属性');
  let r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', name: '随便' });
  assert.equal(r.status, 400, '地下城要带角色卡');
  r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId: card.id, bag: { potion: 3 } });
  assert.equal(r.status, 409, '背包里只有 2 瓶');
  r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId: card.id, bag: { potion: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  game = r.data;
  assert.equal(game.me.name, '阿猎');
  assert.equal(game.me.v2.hp, game.me.v2.hpMax);
  assert.equal(game.me.v2.bag.potion, 2);
  assert.equal(game.me.v2.skills[0].name, '破军一击');
  assert.equal(game.dungeon.isDungeon, true);
  r = await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  assert.equal(r.status, 200);

  async function act(content: string) {
    const res = await as(t1)('POST', `/api/rooms/${room.id}/actions`, { content });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    await t.app.engine.idle();
    now += 125 * MIN;
    t.app.engine.tick();
    await t.app.engine.idle();
  }
  await act('测试开打：鼠群冲上来了');
  game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.ok(game.dungeon.combat, '开打以后看得到战斗');
  assert.equal(game.dungeon.combat.enemies.length, 2);
  await act('测试攻击：一剑砍过去');
  await act('测试宝物：翻酒坛后面');
  game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  const traces = (t.app.db.prepare('SELECT content, result FROM actions WHERE room_id = ? ORDER BY id').all(room.id) as { content: string; result: string }[]).map(
    (a) => `${a.content} => ${a.result}`,
  );
  assert.ok(game.me.v2.loot.length >= 1, `捡到了东西：${traces.join('\n')}`);
  const log = (await as(t1)('GET', `/api/rooms/${room.id}/log`)).data.entries;
  assert.ok(log.some((e: any) => e.data?.type === 'resolution' && e.data.events?.some((x: string) => x.startsWith('开打'))), '战况写进记录');
  assert.ok(log.some((e: any) => e.data?.rolls?.some((x: any) => x.combat?.kind === 'attack')), '攻击的骰子卡片');
  await act('测试结局');
  const room2 = (await as(t1)('GET', `/api/rooms/${room.id}`)).data.room;
  assert.equal(room2.status, 'ended');
  const after1 = (await as(t1)('GET', '/api/cards')).data;
  const c = after1.cards.find((x: { id: number }) => x.id === card.id);
  assert.equal(c.history[0].result, 'clear');
  assert.equal(c.points, 2, '难度 1 的小型通关给 2 点');
  assert.ok(after1.chests >= 1, '通关给宝箱');
  assert.ok(after1.gear.some((g: { rarity: string }) => g.rarity === 'fine') || after1.bag.potion >= 2, '带出来的东西进了账号');
  const run = t.app.db.prepare('SELECT result, players FROM dungeon_runs WHERE room_id = ?').get(room.id) as { result: string; players: number };
  assert.deepEqual({ ...run }, { result: 'clear', players: 1 });
  const records = (await as(t1)('GET', '/api/dungeons/mini-dungeon/records')).data;
  assert.equal(records.recent[0].players[0], '阿猎');
});

test('回合模式里同一场战斗的行动按先后手结算（不按谁先交）；别处的行动顺序不变', async () => {
  const c1 = (await as(t1)('GET', '/api/cards')).data.cards[0];
  const c2 = (await as(t2)('GET', '/api/cards')).data.cards[0];
  const room = (await as(t1)('POST', '/api/rooms', { name: '先后手', maxPlayers: 2, scenarioKey: 'mini-dungeon' })).data.room;
  const code = (t.app.db.prepare('SELECT join_code FROM rooms WHERE id = ?').get(room.id) as { join_code: string }).join_code;
  assert.equal((await as(t2)('POST', '/api/rooms/join', { code })).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId: c1.id, bag: {} })).status, 200);
  assert.equal((await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'monk', cardId: c2.id, bag: {} })).status, 200);
  const ids = (t.app.db.prepare('SELECT id FROM characters WHERE room_id = ? ORDER BY id').all(room.id) as { id: number }[]).map((r) => r.id);
  t.app.db.prepare("UPDATE characters SET location = 'cellar' WHERE room_id = ?").run(room.id);
  // 地窖里在打仗：后建的角色先手
  const world = { npcs: {}, events: {}, ending: null, lootTaken: {}, encountered: {}, combats: { cellar: { location: 'cellar', round: 1, enemies: [], order: [{ id: `c${ids[1]}`, name: '乙', side: 'ally', initiative: 12 }, { id: `c${ids[0]}`, name: '甲', side: 'ally', initiative: 5 }] } } };
  t.app.db.prepare('UPDATE rooms SET world = ? WHERE id = ?').run(JSON.stringify(world), room.id);
  const row = t.app.db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  const actions = [
    { id: 1, character_id: ids[0] },
    { id: 2, character_id: ids[1] },
  ];
  (t.app.engine as unknown as { orderByInitiative: (r: unknown, a: unknown[]) => void }).orderByInitiative(row, actions);
  assert.deepEqual(actions.map((a) => a.character_id), [ids[1], ids[0]], '先手的先结算');
  // 不在打仗：照旧
  t.app.db.prepare("UPDATE rooms SET world = '{}' WHERE id = ?").run(room.id);
  const again = [
    { id: 1, character_id: ids[0] },
    { id: 2, character_id: ids[1] },
  ];
  (t.app.engine as unknown as { orderByInitiative: (r: unknown, a: unknown[]) => void }).orderByInitiative(t.app.db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id), again);
  assert.deepEqual(again.map((a) => a.character_id), [ids[0], ids[1]]);
});

test('五个分区的剧本也用规则第二版：身份是七项属性，生命值、精神值；受伤扣生命值', async () => {
  const room = (await as(t2)('POST', '/api/rooms', { name: '灯夜', maxPlayers: 2, scenarioKey: 'qingxi-lantern-night' })).data.room;
  let r = await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'constable', name: '赵捕头' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = r.data.me;
  assert.equal(me.v2.attributes.strength, 2);
  assert.equal(me.v2.hpMax, 10 + 2 * me.v2.attributes.constitution);
  assert.equal(r.data.dungeon.isDungeon, false);
  await as(t2)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  await as(t2)('POST', `/api/rooms/${room.id}/actions`, { content: '测试受伤：被砖头砸了一下' });
  await t.app.engine.idle();
  now += 20 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
  const game = (await as(t2)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.ok(game.me.v2.hp < game.me.v2.hpMax, '扣了生命值');
});

test('剧本大厅里的地下城才算成绩：自己导入的地下城照样能带卡进去玩，打完不给成长点、东西和宝箱', async () => {
  const card = (await as(admin)('POST', '/api/cards', { name: '试刷的卡', attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] })).data.card;
  const before = (await as(admin)('GET', '/api/cards')).data;
  const room = (await as(admin)('POST', '/api/rooms', { name: '自己写的地窖', maxPlayers: 1 })).data.room;
  const homemade = miniDungeon();
  homemade.dungeon.level = 10;
  homemade.dungeon.loot.push({ key: 'gold', places: ['cellar'], how: '地上', reward: { kind: 'crystals', amount: 200 } });
  let r = await as(admin)('POST', `/api/rooms/${room.id}/scenario`, { data: homemade });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.dungeon.isDungeon, r.data.dungeon.ranked], [true, false]);
  r = await as(admin)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId: card.id, bag: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await as(admin)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  for (const content of ['测试宝物：捡地上的东西', '四处看看', '测试结局']) {
    assert.equal((await as(admin)('POST', `/api/rooms/${room.id}/actions`, { content })).status, 201);
    await t.app.engine.idle();
    now += 125 * MIN;
    t.app.engine.tick();
    await t.app.engine.idle();
  }
  assert.equal((await as(admin)('GET', `/api/rooms/${room.id}`)).data.room.status, 'ended');
  const after = (await as(admin)('GET', '/api/cards')).data;
  const mine = after.cards.find((c: { id: number }) => c.id === card.id);
  assert.deepEqual([mine.points, mine.history.length, after.chests], [0, 0, before.chests]);
  // 玩完一局本来就给的龙晶照给；地上那 200 龙晶没带出来
  assert.ok(after.crystals - before.crystals < 200, `${before.crystals} → ${after.crystals}`);
});
