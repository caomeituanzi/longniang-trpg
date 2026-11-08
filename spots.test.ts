process.env.TZ = 'Asia/Shanghai';
// 站位（V1.0.x）：一个地点里谁站在哪。剧本的写法和检查、主持工具 set_spot（换地点清空）、悄悄话只能说给身边的人
// （身边别的人看得到两个人凑在一起说话，嘈杂、昏暗的地方看不到）、给主持人的提示、战斗（第二版和 5E：近战要站在一起、
// 远程打掩体里的更难、身边有敌人时远程吃亏、走开时提醒敌人趁机打一下）、网页上看到的站位、以前开的局补上站位。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { monsterData, rules5e } from '../server/5e/rules-data';
import { MIGRATIONS } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { SKILLS } from '../server/skills';
import { buildDmContext, DM_RULES, DM_RULES_5E, DM_RULES_V2, SPOT_COMBAT_RULE, SPOT_RULE } from '../server/game/prompts';
import { fightsBlock5e } from '../server/game/prompts5e';
import { dungeonView } from '../server/game/engine';
import { fight5eView } from '../server/game/view5e';
import { newV2State } from '../server/game/rules2';
import { newState5e } from '../server/game/rules5e';
import { rollDungeonRun, validateScenario, type Scenario } from '../server/game/scenario';
import { DM_TOOLS, ResolutionContext } from '../server/game/tools';
import { Rules2Context } from '../server/game/tools2';
import { Rules5eContext } from '../server/game/tools5e';
import { emptyWorld, type Character, type World } from '../server/game/world';
import { emptyAttributes2, type Attributes2 } from '../shared/rules2';
import { gearView } from '../shared/gear2';
import { quickCard } from '../shared/5e/quick';
import { computeSheet } from '../shared/5e/sheet';
import type { Card5eData, ClassKey } from '../shared/5e/types';
import { cleanSpot, flagText, matchSpot, placeSpots, sameSpot, spotFlags, spotName, viewFlagText } from '../shared/spots';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;
const ROOT = path.resolve(import.meta.dirname, '..');
const fixture = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
const valid = (data: unknown): Scenario => {
  const r = validateScenario(data);
  assert.deepEqual(r.errors, []);
  return r.scenario!;
};

/** 《雾港旅店》的大堂写上站位：柜台、壁炉边（嘈杂）、楼梯底下（昏暗）；后厨整个嘈杂。 */
function spottedInn(): Record<string, any> {
  const data = fixture();
  const lobby = data.locations.find((l: any) => l.key === 'lobby');
  lobby.spots = [{ name: '柜台' }, { name: '壁炉边', noisy: true }, { name: '楼梯底下', dark: true }];
  data.locations.find((l: any) => l.key === 'kitchen').noisy = true;
  return data;
}

const character = (id: number, location: string | null, extra: Partial<Character> = {}): Character => ({
  id,
  roomId: 1,
  playerId: id,
  userId: id,
  playerName: `玩家${id}`,
  roleKey: 'reporter',
  name: `角色${id}`,
  attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 },
  specialties: ['打听消息', '速记'],
  appearance: '',
  goal: '',
  wounds: 0,
  stress: 0,
  conditions: [],
  items: [],
  location,
  visited: location ? [location] : [],
  dead: false,
  pet: null,
  cardId: null,
  background: '',
  gear: [],
  v2: null,
  ...extra,
});

function context(scenario: Scenario, characters: Character[], opts: { world?: World; actorId?: number } = {}) {
  return new ResolutionContext({
    scenario,
    world: opts.world ?? emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: opts.actorId ?? characters[0].id,
    gameEnd: 1400,
    rng: () => 3,
    minutes: 30,
  });
}

type Ctx = { execute: (name: string, input: unknown) => { content: string; isError?: boolean } };
const run = (ctx: Ctx, tool: string, input: unknown) => {
  const r = ctx.execute(tool, input);
  assert.ok(!r.isError, `${tool} 出错：${r.content}`);
  return JSON.parse(r.content);
};
const fail = (ctx: Ctx, tool: string, input: unknown) => {
  const r = ctx.execute(tool, input);
  assert.ok(r.isError, `${tool} 应该出错：${r.content}`);
  return r.content;
};

// ---------- 纯计算、剧本格式 ----------

test('站位的计算：属性（地点的嘈杂、昏暗哪儿都算，掩体只看站位）、身边、名字的清理、写给人看的样子', () => {
  const place = { spots: [{ name: '柜台' }, { name: '窗边', cover: true, dark: true }], noisy: true };
  assert.deepEqual(spotFlags(place, '窗边'), { noisy: true, dark: true, cover: true });
  assert.deepEqual(spotFlags(place, null), { noisy: true, dark: false, cover: false }, '没特别站在哪只看地点的');
  assert.deepEqual(spotFlags(place, '编的名字'), { noisy: true, dark: false, cover: false }, '主持人起的名字没有属性');
  assert.equal(flagText(spotFlags(place, '窗边')), '嘈杂、昏暗、掩体');
  assert.equal(flagText(spotFlags(undefined, '柜台')), '');
  assert.ok(sameSpot(null, undefined) && sameSpot('', null) && sameSpot('柜台', '柜台'));
  assert.ok(!sameSpot('柜台', null));
  assert.equal(cleanSpot('  门\n口 '), '门 口');
  assert.equal(cleanSpot('一二三四五六七八九十甲乙丙'), '一二三四五六七八九十甲乙');
  assert.equal(cleanSpot('   '), null);
  assert.equal(cleanSpot(3), null);
  assert.equal(cleanSpot('大家中间'), null, '主持人照着写回来的「大家中间」是没特别站在哪');
  assert.equal(cleanSpot('「窗边」'), '窗边');
  // 照抄了提示里带的属性：对得上剧本里的站位就去掉括号
  assert.equal(matchSpot(place, '窗边（昏暗、掩体）'), '窗边');
  assert.equal(matchSpot(place, '窗边(掩体)'), '窗边');
  assert.equal(matchSpot(place, '门口（左边）'), '门口（左边）', '剧本里没有的照原样记');
  assert.equal(matchSpot(place, '大家中间（嘈杂）'), null);
  assert.equal(matchSpot(place, '柜台'), '柜台');
  assert.equal(matchSpot(undefined, ' 窗边 '), '窗边');
  assert.equal(spotName(null), '大家中间');
  assert.equal(spotName('柜台'), '柜台');
  const view = placeSpots(place);
  assert.deepEqual(view, { spots: [{ name: '柜台', flags: [] }, { name: '窗边', flags: ['dark', 'cover'] }], flags: ['noisy'] });
  assert.equal(viewFlagText(view, '窗边'), '嘈杂、昏暗、掩体');
  assert.equal(viewFlagText(view, null), '嘈杂');
  assert.equal(viewFlagText(null, '窗边'), '');
});

test('剧本里的站位：最多 8 个、名字最多 12 个字不能重复也不能空；属性只认 true；整个地点可以嘈杂、昏暗；数据库加了站位这一列', () => {
  const s = valid(spottedInn());
  const lobby = s.locations.find((l) => l.key === 'lobby')!;
  assert.deepEqual(lobby.spots, [{ name: '柜台' }, { name: '壁炉边', noisy: true }, { name: '楼梯底下', dark: true }]);
  assert.equal(s.locations.find((l) => l.key === 'kitchen')!.noisy, true);
  assert.equal(s.locations.find((l) => l.key === 'cellar')!.spots, undefined);

  const off = spottedInn();
  off.locations[0].spots = [{ name: '柜台', noisy: false, cover: false }];
  off.locations[0].dark = false;
  const parsed = valid(off).locations[0];
  assert.deepEqual(parsed.spots, [{ name: '柜台' }], '写 false 的属性去掉');
  assert.equal(parsed.dark, undefined);
  const empty = spottedInn();
  empty.locations[0].spots = [];
  assert.equal(valid(empty).locations[0].spots, undefined, '空列表当没写');

  const bad = spottedInn();
  bad.locations[0].spots = [{ name: '柜台' }, { name: '柜台' }, { name: '一二三四五六七八九十甲乙丙' }, { name: '' }];
  bad.locations[1].spots = Array.from({ length: 9 }, (_, i) => ({ name: `位置${i}` }));
  bad.locations[2].spots = [{ name: '窗边', cover: 'yes' }];
  bad.locations[3].spots = [{ name: '大家中间' }];
  const errors = validateScenario(bad).errors.join('\n');
  assert.match(errors, /站位「柜台」重复了/);
  assert.match(errors, /locations\[0\]\.spots\[2\]\.name/);
  assert.match(errors, /locations\[0\]\.spots\[3\]\.name/);
  assert.match(errors, /locations\[1\]\.spots/);
  assert.match(errors, /locations\[2\]\.spots\[0\]\.cover/);
  assert.match(errors, /locations\[3\]\.spots\[0\]\.name：站位不能叫「大家中间」/);

  assert.ok(MIGRATIONS.length >= 24);
  assert.match(MIGRATIONS[23], /ALTER TABLE characters ADD COLUMN spot TEXT/);
});

// ---------- 主持工具（第一版） ----------

test('set_spot：记下站在哪（返回属性、身边的人）；原地不动、主持人起的名字、回到大家中间；死了、不在任何地点的不行；换了地点站位清空', () => {
  const s = valid(spottedInn());
  const a = character(1, 'lobby');
  const b = character(2, 'lobby', { name: '许乙' });
  const ctx = context(s, [a, b]);
  assert.ok(DM_TOOLS.some((t) => t.name === 'set_spot'));

  let r = run(ctx, 'set_spot', { character: 1, spot: '壁炉边' });
  assert.deepEqual(r, { character: '角色1', spot: '壁炉边', flags: '嘈杂', beside: [] });
  assert.equal(ctx.characters.get(1)!.spot, '壁炉边');
  assert.ok(ctx.changes.some((c) => c.characterId === 1 && c.text === '站位：壁炉边'));
  r = run(ctx, 'set_spot', { character: 2, spot: '壁炉边' });
  assert.deepEqual(r.beside, ['角色1']);
  assert.equal(run(ctx, 'set_spot', { character: 2, spot: ' 壁炉边 ' }).note, '本来就站在这里');
  // 主持人按描述起的名字：照记下，告诉他剧本里写了哪些
  r = run(ctx, 'set_spot', { character: 2, spot: '门口' });
  assert.equal(r.spot, '门口');
  assert.match(r.note, /剧本里这个地点的站位是：柜台、壁炉边、楼梯底下/);
  r = run(ctx, 'set_spot', { character: 2, spot: '' });
  assert.equal(r.spot, '大家中间');
  assert.equal(ctx.characters.get(2)!.spot, null);
  // 写了「大家中间」也是回到大家中间；照抄了提示里的「壁炉边（嘈杂）」，记成剧本里的壁炉边（带着属性）
  run(ctx, 'set_spot', { character: 2, spot: '门口' });
  run(ctx, 'set_spot', { character: 2, spot: '大家中间' });
  assert.equal(ctx.characters.get(2)!.spot, null);
  r = run(ctx, 'set_spot', { character: 2, spot: '壁炉边（嘈杂）' });
  assert.deepEqual([r.spot, r.flags, r.beside], ['壁炉边', '嘈杂', ['角色1']]);
  // 第一版的剧本没有战斗：没有敌人可以挪
  assert.match(fail(ctx, 'set_spot', { enemy: 'rat-1', spot: '柜台' }), /没有在打的敌人/);

  const dead = context(s, [character(1, 'lobby', { dead: true }), character(2, null)]);
  assert.match(fail(dead, 'set_spot', { character: 1, spot: '柜台' }), /已经死了/);
  assert.match(fail(dead, 'set_spot', { character: 2, spot: '柜台' }), /不在任何地点/);

  // 换了地点：站位清空
  run(ctx, 'move_character', { character: 1, location: 'kitchen' });
  assert.equal(ctx.characters.get(1)!.location, 'kitchen');
  assert.equal(ctx.characters.get(1)!.spot, null);
});

test('给主持人的提示：主持规则讲站位（第二版、5E 还讲战斗里的站位）；这次结算写着站在哪、这里有哪些站位、谁在身边', () => {
  assert.ok(DM_RULES.includes(SPOT_RULE) && !DM_RULES.includes(SPOT_COMBAT_RULE));
  assert.ok(DM_RULES_V2.includes(SPOT_RULE) && DM_RULES_V2.includes(SPOT_COMBAT_RULE));
  assert.ok(DM_RULES_5E.includes(SPOT_RULE) && DM_RULES_5E.includes(SPOT_COMBAT_RULE));
  assert.match(SPOT_COMBAT_RULE, /ranged/);
  assert.match(SPOT_COMBAT_RULE, /thrown/);

  const s = valid(spottedInn());
  const me = character(1, 'lobby', { spot: '壁炉边' });
  const near = character(2, 'lobby', { name: '许乙', spot: '壁炉边' });
  const far = character(3, 'lobby', { name: '沈丙', spot: null });
  const context = (actor: Character, characters: Character[]) =>
    buildDmContext({
      scenario: s,
      world: emptyWorld(),
      characters,
      clues: [],
      actor,
      action: { content: '烤烤火', gameStart: 1320, minutes: 10, secret: false },
      pending: [],
      recent: [],
    } as any);
  const text = context(me, [me, near, far]);
  assert.match(text, /现在在 大堂（lobby）·壁炉边（嘈杂）\n/);
  assert.match(text, /这里的站位：柜台、壁炉边（嘈杂）、楼梯底下（昏暗）\n/);
  assert.match(text, /同一地点的其他角色：许乙（编号 2，在他身边）、沈丙（编号 3，站在大家中间）/);
  assert.match(text, /所在：大堂（lobby）·壁炉边（嘈杂）/);
  const cellar = character(1, 'cellar');
  assert.match(context(cellar, [cellar]), /这里的站位：剧本没写（需要时按描述起短名字）/);
  const kitchen = character(1, 'kitchen');
  assert.match(context(kitchen, [kitchen]), /这里的站位：整个地方嘈杂/);
});

// ---------- 战斗（第二版） ----------

/** 一个最小的地下城：地窖里有站位「酒坛后」（掩体）、「台阶口」；鼠群在地窖。 */
function spotDungeon(): Scenario {
  const data = {
    format: 'longniang-trpg/scenario@1',
    title: '站位地窖',
    category: 'dungeon',
    rules: 2,
    intro: '测试站位用的地窖。',
    author: '龙娘跑团',
    genre: '奇幻',
    tone: '紧张',
    players: { min: 1, max: 2 },
    expectedDays: 1,
    relation: 'coop',
    stress: false,
    start: { label: '入夜', day: 1, time: '20:00' },
    opening: { background: '地窖里闹老鼠。', situation: '你们站在地窖里。', known: [] },
    roles: [
      { key: 'hunter', name: '猎人', public: '猎人', secret: '', goal: '清掉鼠患', startLocation: 'cellar' },
      { key: 'monk', name: '游僧', public: '游僧', secret: '', goal: '超度', startLocation: 'cellar' },
    ],
    locations: [
      { key: 'entrance', name: '地窖口', description: '台阶往下。', exits: [{ to: 'cellar', minutes: 2 }], features: [] },
      {
        key: 'cellar',
        name: '地窖',
        description: '堆满酒坛。',
        exits: [{ to: 'entrance', minutes: 2 }],
        features: ['酒坛'],
        spots: [{ name: '酒坛后', cover: true }, { name: '台阶口' }],
      },
    ],
    truth: { summary: '鼠王占了地窖。', points: [{ key: 'king', text: '鼠王怕火' }] },
    clues: [
      { key: 'burnt', title: '烧焦的毛', content: '墙角有烧焦的鼠毛。', location: 'cellar', points: ['king'], how: '搜查', check: null, core: true },
      { key: 'note', title: '账本', content: '用火赶过老鼠。', location: 'entrance', points: ['king'], how: '翻', check: null, core: false },
    ],
    npcs: [],
    timeline: [],
    endings: [
      { key: 'win', title: '鼠患平息', condition: '打倒鼠王', summary: '安静了。', result: 'clear' },
      { key: 'lost', title: '倒下', condition: '全都倒下', summary: '没了。', result: 'fail' },
    ],
    dungeon: {
      level: 1,
      size: 'small',
      exit: 'entrance',
      enemies: [
        { key: 'rat', name: '大老鼠', tier: 'minion', description: '猫一样大', abilities: ['一拥而上'] },
        { key: 'rat-king', name: '鼠王', tier: 'boss', description: '尾巴缠在一起', abilities: ['尖啸'] },
      ],
      encounters: [{ key: 'pack', title: '鼠群', enemies: [{ enemy: 'rat', count: 2 }], places: ['cellar'], trigger: '走进去就遇上' }],
      loot: [],
      variants: [
        { key: 'plain', title: '老鼠', truth: '只是老鼠。', clues: {}, npcs: {} },
        { key: 'curse', title: '诅咒', truth: '有人下了诅咒。', clues: {}, npcs: {} },
      ],
      boss: {
        enemy: 'rat-king',
        location: 'cellar',
        weaknesses: [
          { key: 'fire', text: '怕火', hint: '烧焦的毛' },
          { key: 'cat', text: '怕猫叫', hint: '账本' },
        ],
        shield: '',
      },
    },
  };
  return rollDungeonRun(valid(data), () => 0);
}

function v2Character(id: number, attributes: Partial<Attributes2>, skills: string[] = ['pojun', 'lianzhu']): Character {
  const attrs = { ...emptyAttributes2(), ...attributes };
  return {
    ...character(id, 'cellar', { name: id === 1 ? '阿猎' : '慧明', roleKey: id === 1 ? 'hunter' : 'monk' }),
    attributes: attrs as unknown as Character['attributes'],
    v2: newV2State(attrs, [gearView(1, 'sword', 'common')!], {}, skills),
  };
}

function context2(characters: Character[], dice: number[] = []) {
  const rolls = [...dice];
  return new Rules2Context({
    scenario: spotDungeon(),
    world: emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: characters[0].id,
    gameEnd: 100,
    rng: (sides) => (rolls.length ? rolls.shift()! : Math.min(3, sides)),
    allowDeath: true,
    players: characters.length,
    pick: () => 0,
    ownedLegendary: new Map(),
  });
}

test('第二版的战斗：敌人站在开打时写的站位；近战要站在一起，远程打掩体里的防御 +1、身边有敌人 -1；敌人也一样；走开时提醒敌人趁机打一下', () => {
  const ctx = context2([v2Character(1, { strength: 2, agility: 2 }), v2Character(2, { agility: 1 })]);
  const start = run(ctx, 'start_combat', { encounter: 'pack', note: '鼠群从酒坛后面扑出来', spot: '酒坛后' });
  assert.deepEqual(start.enemies.map((e: any) => e.spot), ['酒坛后', '酒坛后']);
  const fight = () => ctx.world.combats.cellar;
  assert.deepEqual(fight().enemies.map((e) => e.spot), ['酒坛后', '酒坛后']);

  // 阿猎在大家中间：近战够不着；远程打得到，掩体防御 +1
  assert.match(fail(ctx, 'attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '砍' }), /近战够不着.*set_spot/);
  let r = run(ctx, 'attack', { character: 1, enemy: 'rat-1', attribute: 'agility', modifier: 0, ranged: true, reason: '射' });
  assert.equal(r.defense, 8 + 1);
  assert.ok(r.notes.some((n: string) => n.includes('有掩体：防御 +1')));
  assert.ok(!r.breakdown.includes('身边有敌人'));

  // 走到酒坛后：近战打得到（掩体对近战没用）；这时候用远程，身边有敌人 -1
  r = run(ctx, 'set_spot', { character: 1, spot: '酒坛后' });
  assert.equal(r.left_enemies, undefined, '原来身边没有敌人');
  r = run(ctx, 'attack', { character: 1, enemy: 'rat-2', attribute: 'strength', modifier: 0, reason: '砍' });
  assert.equal(r.defense, 8);
  r = run(ctx, 'attack', { character: 1, enemy: 'rat-2', attribute: 'agility', modifier: 0, ranged: true, reason: '贴脸射' });
  assert.match(r.breakdown, /身边有敌人-1/);

  // 破军一击只能近战：够不着时不扣精神值；横扫照旧打所有的敌人
  run(ctx, 'set_spot', { character: 2, spot: '台阶口' });
  const mp = ctx.characters.get(2)!.v2!.mp;
  assert.match(fail(ctx, 'use_skill', { character: 2, skill: 'pojun', target_enemy: 'rat-1', ranged: true, reason: '冲上去' }), /近战够不着/);
  assert.equal(ctx.characters.get(2)!.v2!.mp, mp);
  r = run(ctx, 'use_skill', { character: 2, skill: 'lianzhu', reason: '连射' });
  assert.ok(SKILLS.find((s) => s.key === 'lianzhu'));
  assert.equal(ctx.cards.filter((c) => c.reason === '连珠箭').length, fight().enemies.length, '每个敌人都射了一箭');

  // 敌人：近战够不着台阶口的慧明；远程打得到；挪过去以后近战打得到
  assert.match(fail(ctx, 'enemy_attack', { enemy: 'rat-1', character: 2, severity: 'light' }), /近战够不着.*set_spot（enemy）/);
  run(ctx, 'enemy_attack', { enemy: 'rat-1', character: 2, severity: 'light', ranged: true });
  r = run(ctx, 'set_spot', { enemy: 'rat-1', spot: '台阶口' });
  assert.deepEqual(r, { enemy: 'rat-1=大老鼠', spot: '台阶口', beside: ['慧明'] });
  run(ctx, 'enemy_attack', { enemy: 'rat-1', character: 2, severity: 'light' });
  assert.match(fail(ctx, 'set_spot', { enemy: 'nope', spot: '台阶口' }), /没有这个敌人：nope，现在的敌人：rat-1=大老鼠、rat-2=大老鼠/);

  // 慧明站在掩体里：大老鼠2 从酒坛后用远程打他，防御 +1；大老鼠2 身边站着阿猎，远程 -1
  run(ctx, 'set_spot', { character: 2, spot: '酒坛后' });
  run(ctx, 'set_spot', { enemy: 'rat-2', spot: '台阶口' });
  run(ctx, 'set_spot', { character: 1, spot: '台阶口' });
  r = run(ctx, 'enemy_attack', { enemy: 'rat-2', character: 2, severity: 'light', ranged: true });
  assert.ok(r.notes.some((n: string) => n.includes('慧明站在酒坛后，有掩体：防御 +1')));
  assert.ok(ctx.cards.at(-1)!.parts.some((p) => p.label === '身边有敌人' && p.value === -1));

  // 阿猎从两只老鼠身边走开：提醒主持人它们趁机打一下（写上编号，名字一样的分得清）；这一下近战照样打得到，各一次
  r = run(ctx, 'set_spot', { character: 1, spot: '' });
  assert.match(r.left_enemies, /阿猎从大老鼠（rat-1）、大老鼠（rat-2）身边走开了.*enemy_attack/);
  r = run(ctx, 'enemy_attack', { enemy: 'rat-1', character: 1, severity: 'light' });
  assert.ok(r.notes.some((n: string) => n.includes('阿猎刚从大老鼠身边走开：这一下是趁机打的')));
  assert.match(fail(ctx, 'enemy_attack', { enemy: 'rat-1', character: 1, severity: 'light' }), /近战够不着/, '只打一下');
  run(ctx, 'enemy_attack', { enemy: 'rat-2', character: 1, severity: 'light' });
  // 主持人写「大家中间」：开打的敌人也是在大家中间，近战打得到
  const two = context2([v2Character(1, { strength: 2 })]);
  run(two, 'start_combat', { encounter: 'pack', note: 'x', spot: '大家中间' });
  assert.equal(two.world.combats.cellar.enemies[0].spot ?? null, null);
  run(two, 'attack', { character: 1, enemy: 'rat-1', attribute: 'strength', modifier: 0, reason: '砍' });
  run(two, 'set_spot', { enemy: 'rat-2', spot: '酒坛后（掩体）' });
  assert.equal(two.world.combats.cellar.enemies[1].spot, '酒坛后');
});

test('第二版：给主持人看的正在打的仗写着敌人站在哪；网页上的战斗写着谁站在哪', () => {
  const ctx = context2([v2Character(1, { strength: 2 })]);
  run(ctx, 'start_combat', { encounter: 'pack', note: 'x', spot: '酒坛后' });
  run(ctx, 'set_spot', { character: 1, spot: '台阶口' });
  const me = ctx.characters.get(1)!;
  const combat = dungeonView(ctx.scenario, ctx.world, me, [me], false).combat!;
  assert.deepEqual(
    combat.order.map((o) => [o.name, o.spot, o.down]).sort(),
    [
      ['大老鼠', '酒坛后', false],
      ['大老鼠', '酒坛后', false],
      ['阿猎', '台阶口', false],
    ],
  );
  assert.deepEqual(combat.enemies.map((e) => e.spot), ['酒坛后', '酒坛后']);
  const text = buildDmContext({
    scenario: ctx.scenario,
    world: ctx.world,
    characters: [me],
    clues: [],
    actor: me,
    action: { content: '打', gameStart: 1320, minutes: 10, secret: false },
    pending: [],
    recent: [],
  } as any);
  assert.match(text, /rat-1 大老鼠（小怪）：站在酒坛后；生命/);
  assert.match(text, /这里的站位：酒坛后（掩体）、台阶口/);
});

// ---------- 战斗（5E） ----------

const RULES = rules5e();
const MODULE_FILE = path.join(ROOT, 'scenarios', 'mistridge-silent-bell.json');

/** 5E 入门模组，黑松林写上站位：倒树后（掩体）、林间空地。 */
function module5e(): Scenario {
  const data = JSON.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  const woods = data.locations.find((l: any) => l.key === 'woods');
  woods.spots = [{ name: '倒树后', cover: true }, { name: '林间空地' }];
  delete woods.noisy;
  delete woods.dark;
  return valid(data);
}

function pc5e(id: number, cls: ClassKey, tweak?: (d: Card5eData) => void): Character {
  const data = quickCard(RULES, cls);
  tweak?.(data);
  return { ...character(id, 'woods', { name: ['阿岚', '墨衡'][id - 1] }), v5: newState5e(100 + id, data, computeSheet(data, RULES)), card5eId: 100 + id };
}

function ctx5e(characters: Character[], dice: number[]) {
  const rolls = [...dice];
  const ctx = new Rules5eContext({
    scenario: module5e(),
    world: emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: characters[0].id,
    gameEnd: 100,
    rng: (sides) => {
      const v = rolls.shift();
      if (v === undefined) throw new Error(`骰子不够了（d${sides}）`);
      assert.ok(v >= 1 && v <= sides, `d${sides} 掷不出 ${v}`);
      return v;
    },
    allowDeath: true,
    rules: RULES,
    srd: monsterData,
  });
  return { ctx, rolls };
}

test('5E 的战斗：近战、触碰的法术要站在一起；远程打掩体里的 AC +2；身边有还能动手的敌人时远程有劣势（怪物也一样）；投掷武器扔出去算远程', () => {
  const fighter = pc5e(1, 'fighter');
  const wizard = pc5e(2, 'wizard', (d) => {
    d.cantrips = ['fire-bolt', 'chill-touch', 'mage-hand'];
  });
  // 先攻：怪物 10，战士 15，法师 5
  const { ctx, rolls } = ctx5e([fighter, wizard], [10, 15, 5]);
  const start = run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-warrior', count: 1 }], note: '倒树后面跳出一个地精', spot: '倒树后' });
  assert.equal(start.monsters[0].spot, '倒树后');
  const m = () => ctx.world.fights5e.woods.monsters[0];
  assert.equal(m().spot, '倒树后');
  const ac = m().ac;
  assert.equal(rolls.length, 0);

  // 战士在大家中间：巨剑够不着（不掷骰）；短弓打得到，掩体 AC +2；标枪扔出去也算远程，不扔就是近战
  assert.match(fail(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'greatsword', reason: '砍' }), /近战够不着/);
  rolls.push(2);
  let r = run(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'shortbow', reason: '射' });
  assert.equal(r.ac, ac + 2);
  assert.ok(r.notes.some((n: string) => n.includes('有掩体：AC +2（半身掩护）')));
  rolls.push(2);
  assert.equal(run(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'javelin', thrown: true, reason: '扔标枪' }).ac, ac + 2);
  assert.match(fail(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'javelin', reason: '捅' }), /近战够不着/);
  assert.match(fail(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'greatsword', thrown: true, reason: '扔剑' }), /近战够不着/, '巨剑不是投掷武器，按近战算');
  assert.equal(rolls.length, 0);

  // 走到倒树后：巨剑打得到（掩体对近战没用）；这时候用短弓，身边有敌人，劣势（取低的那颗）
  run(ctx, 'set_spot', { character: 1, spot: '倒树后' });
  rolls.push(2);
  assert.equal(run(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'greatsword', reason: '砍' }).ac, ac);
  rolls.push(15, 3);
  r = run(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'shortbow', reason: '贴脸射' });
  assert.equal(r.total, 3 + 3, '短弓 +3，劣势取 3');
  assert.equal(rolls.length, 0);

  // 怪物：弯刀是近战，够不着大家中间的法师；砍身边的战士要掷骰；短弓射法师，身边站着战士，劣势
  assert.match(fail(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '弯刀', targets: [2], reason: '砍法师' }), /「弯刀」是近战，够不着/);
  rolls.push(2);
  r = run(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '弯刀', targets: [1], reason: '砍战士' });
  assert.equal(r.results[0].hit, false);
  rolls.push(15, 2);
  r = run(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '短弓', targets: [2], reason: '射法师' });
  assert.equal(r.results[0].hit, false);
  assert.equal(rolls.length, 0, '劣势掷了两颗');

  // 法师：冻寒之触要摸得到；火焰箭打得到，掩体 AC +2；法师身边没有敌人，不劣势
  assert.match(fail(ctx, 'cast_spell', { character: 2, spell: 'chill-touch', enemies: ['goblin-warrior-1'], reason: '摸' }), /够不着/);
  rolls.push(2);
  r = run(ctx, 'cast_spell', { character: 2, spell: 'fire-bolt', enemies: ['goblin-warrior-1'], reason: '火焰箭' });
  assert.ok(r.notes.some((n: string) => n.includes('有掩体：AC +2')));
  assert.equal(rolls.length, 0);

  // 战士从地精身边走开：提醒主持人借机攻击；借机攻击近战照样打得到，算地精的反应（不占它的回合），只打一下
  r = run(ctx, 'set_spot', { character: 1, spot: '林间空地' });
  assert.match(r.left_enemies, /阿岚从破耳战士（goblin-warrior-1）身边走开了.*opportunity=true/);
  const acted = [...ctx.world.fights5e.woods.acted];
  rolls.push(2);
  r = run(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '弯刀', targets: [1], reason: '借机砍一刀' });
  assert.equal(r.reaction, '用的是它的反应，不占它这一轮的回合');
  assert.ok(r.results[0].notes.some((n: string) => n.includes('这一下是借机攻击')));
  assert.deepEqual(ctx.world.fights5e.woods.acted, acted);
  assert.match(fail(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '弯刀', targets: [1], reason: '再砍' }), /够不着/);
  assert.match(fail(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '弯刀', targets: [1], opportunity: true, reason: 'x' }), /够不着/);
  // 不在这个地点的人打不到
  ctx.characters.get(2)!.location = 'inn';
  assert.match(fail(ctx, 'monster_action', { enemy: 'goblin-warrior-1', action: '短弓', targets: [2], reason: '射' }), /墨衡不在/);
  ctx.characters.get(2)!.location = 'woods';
  // 远程武器填了 thrown：照样是远程，不说「不是投掷武器」
  rolls.push(2);
  r = run(ctx, 'attack', { character: 1, target: 'goblin-warrior-1', weapon: 'shortbow', thrown: true, reason: '射' });
  assert.ok(!r.notes.some((n: string) => n.includes('不是投掷武器')));
  assert.equal(rolls.length, 0);
  // 地精挪到林间空地，又站到了战士身边
  r = run(ctx, 'set_spot', { enemy: 'goblin-warrior-1', spot: '林间空地' });
  assert.deepEqual(r, { enemy: 'goblin-warrior-1=破耳战士', spot: '林间空地', beside: ['阿岚'] });
  const block = fightsBlock5e(ctx.scenario, ctx.world, [...ctx.characters.values()], ctx.characters.get(1)!).join('\n');
  assert.match(block, /goblin-warrior-1 破耳战士：站在林间空地、生命/);
  // 网页上的战斗：谁站在哪
  const view = fight5eView(ctx.world, ctx.characters.get(1)!, [...ctx.characters.values()])!;
  assert.deepEqual(view.monsters.map((x) => x.spot), ['林间空地']);
  assert.deepEqual(view.order.map((o) => [o.name, o.spot]).sort(), [
    ['墨衡', null],
    ['破耳战士', '林间空地'],
    ['阿岚', '林间空地'],
  ]);
});

// ---------- 网页 ----------

let t: Awaited<ReturnType<typeof startTestApp>>;
let now = Date.UTC(2026, 10, 1, 3, 0, 0);
/** 现实时间过去几分钟（计时模式的行动到点结算）。 */
async function pass(minutes: number) {
  await t.app.engine.idle();
  now += minutes * 60_000;
  t.app.engine.tick();
  await t.app.engine.idle();
}
const cookies: Record<string, string> = {};
before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  for (const a of [ADMIN, TESTER1, TESTER2, TESTER3]) cookies[a.username] = await t.login(a.username, a.password);
});
after(async () => {
  await t.close();
});
const as = (who: { username: string }) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookies[who.username]);

/** 三个人的局（改过的《雾港旅店》：大堂有站位），记者林甲、医生许乙、海关稽查员沈丙都在大堂。 */
async function lobbyRoom() {
  const room = (await as(TESTER1)('POST', '/api/rooms', { name: '站位局', maxPlayers: 4 })).data.room;
  for (const who of [TESTER2, TESTER3]) assert.equal((await as(who)('POST', '/api/rooms/join', { code: room.joinCode })).status, 200);
  const chosen = await as(TESTER1)('POST', `/api/rooms/${room.id}/scenario`, { data: spottedInn() });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  const roles: [{ username: string }, string, string][] = [
    [TESTER1, 'reporter', '林甲'],
    [TESTER2, 'doctor', '许乙'],
    [TESTER3, 'customs', '沈丙'],
  ];
  for (const [who, roleKey, name] of roles) assert.equal((await as(who)('PUT', `/api/rooms/${room.id}/character`, { roleKey, name })).status, 200);
  assert.equal((await as(TESTER1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  const id = (name: string) => (t.app.db.prepare('SELECT id FROM characters WHERE room_id = ? AND name = ?').get(room.id, name) as { id: number }).id;
  return { roomId: room.id as number, lin: id('林甲'), xu: id('许乙'), shen: id('沈丙') };
}
const stand = (id: number, spot: string | null) => t.app.db.prepare('UPDATE characters SET spot = ? WHERE id = ?').run(spot, id);
const logOf = async (who: { username: string }, roomId: number) => (await as(who)('GET', `/api/rooms/${roomId}/log`)).data.entries as any[];
const gameOf = async (who: { username: string }, roomId: number) => (await as(who)('GET', `/api/rooms/${roomId}/game`)).data;

test('悄悄话只能说给身边的人；身边别的人看得到两个人凑在一起说话（听不到内容），嘈杂、昏暗的地方看不到', async () => {
  const { roomId, lin, xu, shen } = await lobbyRoom();
  const say = (who: { username: string }, body: unknown) => as(who)('POST', `/api/rooms/${roomId}/say`, body);
  // 都在大家中间：沈丙看得到林甲凑到许乙耳边，听不到说了什么
  let r = await say(TESTER1, { text: '只告诉你', to: xu });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.noticedBy, ['沈丙']);
  const shenLog = await logOf(TESTER3, roomId);
  assert.ok(shenLog.some((e) => e.data?.type === 'aside' && e.text === '林甲凑到许乙耳边，低声说了几句什么。'));
  assert.ok(!shenLog.some((e) => e.text === '只告诉你'), '听不到内容');
  assert.ok(!(await logOf(TESTER2, roomId)).some((e) => e.data?.type === 'aside'), '说悄悄话的两个人不另外收到');

  // 许乙走到柜台：林甲够不着
  stand(xu, '柜台');
  r = await say(TESTER1, { text: '过来', to: xu });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /悄悄话只能说给身边的人：许乙在柜台，你在大家中间/);
  // 林甲也到柜台：沈丙在大家中间，不在身边，看不到
  stand(lin, '柜台');
  r = await say(TESTER1, { text: '账本在哪', to: xu });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.noticedBy, []);

  // 三个人都在壁炉边（嘈杂）、楼梯底下（昏暗）：同在一处的沈丙也注意不到
  for (const spot of ['壁炉边', '楼梯底下']) {
    for (const id of [lin, xu, shen]) stand(id, spot);
    const seen = (await logOf(TESTER3, roomId)).filter((e) => e.data?.type === 'aside').length;
    r = await say(TESTER1, { text: `${spot}说话`, to: xu });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.noticedBy, [], spot);
    assert.equal((await logOf(TESTER3, roomId)).filter((e) => e.data?.type === 'aside').length, seen, spot);
  }
  // 公开的对白：同一地点的人都听得到，不管站在哪
  stand(shen, null);
  r = await say(TESTER1, { text: '大家小心' });
  assert.deepEqual([...r.data.heardBy].sort(), ['沈丙', '许乙'].sort());
});

test('网页上的站位：自己站在哪、这个地点有哪些站位和属性、在场的人各站在哪；换了地点清空', async () => {
  const { roomId, lin, xu } = await lobbyRoom();
  let g = await gameOf(TESTER1, roomId);
  assert.equal(g.me.spot, null);
  assert.deepEqual(g.me.location.spots, [
    { name: '柜台', flags: [] },
    { name: '壁炉边', flags: ['noisy'] },
    { name: '楼梯底下', flags: ['dark'] },
  ]);
  assert.deepEqual(g.me.location.flags, []);
  assert.deepEqual(g.nearby.map((n: any) => [n.name, n.spot]).sort(), [['沈丙', null], ['许乙', null]]);
  stand(lin, '壁炉边');
  stand(xu, '柜台');
  g = await gameOf(TESTER1, roomId);
  assert.equal(g.me.spot, '壁炉边');
  assert.equal(g.nearby.find((n: any) => n.name === '许乙').spot, '柜台');
  // 房主把林甲挪到后厨（整个嘈杂）：站位清空
  t.app.db.prepare('UPDATE characters SET visited = ? WHERE id = ?').run(JSON.stringify(['lobby', 'kitchen']), lin);
  const moved = await as(TESTER1)('PUT', `/api/rooms/${roomId}/host/characters/${lin}`, { location: 'kitchen' });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  g = await gameOf(TESTER1, roomId);
  assert.equal(g.me.location.key, 'kitchen');
  assert.equal(g.me.spot, null);
  assert.equal((t.app.db.prepare('SELECT spot FROM characters WHERE id = ?').get(lin) as { spot: string | null }).spot, null);
  assert.deepEqual(g.me.location.flags, ['noisy']);
  assert.deepEqual(g.me.location.spots, []);
});

test('以前开的局：自带剧本存下来的那份没有站位，启动时照现在的剧本文件补上（地点对不上的不补，已经有站位的不动）', async () => {
  const room = (await as(TESTER1)('POST', '/api/rooms', { name: '老局', maxPlayers: 2, scenarioKey: 'qingxi-lantern-night' })).data.room;
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'qingxi-lantern-night.json'), 'utf8'));
  const stored = () => JSON.parse((t.app.db.prepare('SELECT data FROM scenarios WHERE room_id = ?').get(room.id) as { data: string }).data);
  // 剧本文件里先补上一处站位（自带剧本写没写都不影响这个测试）
  const dir = (t.app.engine as any).scenarioDir as string;
  const file = path.join(dir, 'qingxi-lantern-night.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    current.locations[0].spots = [{ name: '柜台' }, { name: '窗边', dark: true }];
    current.locations[1].noisy = true;
    fs.writeFileSync(file, JSON.stringify(current));
    const data = stored();
    for (const l of data.locations) {
      delete l.spots;
      delete l.noisy;
      delete l.dark;
    }
    t.app.db.prepare('UPDATE scenarios SET data = ? WHERE room_id = ?').run(JSON.stringify(data), room.id);
    t.app.engine.fillBuiltinSpots();
    const fixed = stored();
    assert.deepEqual(fixed.locations[0].spots, [{ name: '柜台' }, { name: '窗边', dark: true }]);
    assert.equal(fixed.locations[1].noisy, true);
    // 已经有站位的不再动
    fixed.locations[0].spots = [{ name: '自己改的' }];
    t.app.db.prepare('UPDATE scenarios SET data = ? WHERE room_id = ?').run(JSON.stringify(fixed), room.id);
    t.app.engine.fillBuiltinSpots();
    assert.deepEqual(stored().locations[0].spots, [{ name: '自己改的' }]);
    // 地点对不上的不补
    const renamed = stored();
    for (const l of renamed.locations) delete l.spots;
    delete renamed.locations[1].noisy;
    renamed.locations[0].key = 'renamed-place';
    t.app.db.prepare('UPDATE scenarios SET data = ? WHERE room_id = ?').run(JSON.stringify(renamed), room.id);
    t.app.engine.fillBuiltinSpots();
    assert.ok(stored().locations.every((l: any) => l.spots === undefined && !l.noisy));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('撤回结算：站位跟着退回去（结算里换的站位、换了地点清掉的站位都回到结算前）', async () => {
  const { roomId, lin } = await lobbyRoom();
  const spotOf = () => (t.app.db.prepare('SELECT spot FROM characters WHERE id = ?').get(lin) as { spot: string | null }).spot;
  const acted = await as(TESTER1)('POST', `/api/rooms/${roomId}/actions`, { content: '走到壁炉边烤火，测试站位：壁炉边' });
  assert.equal(acted.status, 201, JSON.stringify(acted.data));
  await pass(121);
  assert.equal(spotOf(), '壁炉边');
  const undo = await as(TESTER1)('POST', `/api/rooms/${roomId}/host/undo`, {});
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(spotOf(), null);

  // 站在柜台的时候去后厨（站位清掉），撤回以后回到大堂的柜台
  stand(lin, '柜台');
  assert.equal((await as(TESTER1)('POST', `/api/rooms/${roomId}/actions`, { content: '去后厨和后院看看' })).status, 201);
  await pass(121);
  const at = () => t.app.db.prepare('SELECT location, spot FROM characters WHERE id = ?').get(lin) as { location: string; spot: string | null };
  assert.deepEqual({ ...at() }, { location: 'kitchen', spot: null });
  assert.equal((await as(TESTER1)('POST', `/api/rooms/${roomId}/host/undo`, {})).status, 200);
  assert.deepEqual({ ...at() }, { location: 'lobby', spot: '柜台' });
});
