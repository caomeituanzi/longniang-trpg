process.env.TZ = 'Asia/Shanghai';
// V1.0.0 正式版：
// - 删档：数据库升级到第 23 版时清掉内测的数据（所有账号包括站长、对局、公告、投稿、聊天和各种记录），留下网站的设置、限时活动、商城上架的商品；
//   投稿通过的剧本文件挪进备份文件夹；start.bat 发现一个账号都没有时问你建新的站长账号；版本更新公告只发 V1.0.0 的。
// - 顶栏多了「模组」：5E 模组从剧本大厅里拿出来单独一页，按建议等级排。
// - 5E mod：普通剧本也能用 5E 规则玩，每个身份转成一个 3 级的 5E 角色，线索的检定换成技能和 DC，敌人换成 SRD 的怪物。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { needsOwner, willWipe } from '../scripts/upgrade.mjs';
import { monsterData, rules5e } from '../server/5e/rules-data';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { betaWipeLines, betaWipeOf, finishBetaWipe } from '../server/beta-wipe';
import { MIGRATIONS, openDatabase, schemaVersion } from '../server/db';
import { canPlayAs5e, check5eFor, classFor, convertTo5e, dcFor, magicWorld, MOD5E_LEVEL, modOf, monsterFor, NPC_MONSTERS, pregenOf } from '../server/game/mod5e';
import { scenarioBlock } from '../server/game/prompts';
import { newState5e } from '../server/game/rules5e';
import { validateScenario, type Role, type Scenario } from '../server/game/scenario';
import { Rules5eContext } from '../server/game/tools5e';
import { dmTools5e } from '../server/game/tools5e-defs';
import { emptyWorld, type Character } from '../server/game/world';
import { compareVersions, postReleaseNotes, RELEASE_NOTES } from '../server/release-notes';
import { seedTestData, TEST_ACCOUNTS } from '../server/seed-data';
import { ABILITIES, SKILL_KEYS } from '../shared/5e/core';
import { cardIssues, computeSheet } from '../shared/5e/sheet';
import type { ClassKey } from '../shared/5e/types';
import { BEFORE_WIPE, startTestApp, testScenarioDir } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULES = rules5e();
const [ADMIN, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;
const MIN = 60_000;
const FOG_FILE = path.join(ROOT, 'test', 'fixtures', 'fog-harbor-inn.json');
const MODULE_FILE = path.join(ROOT, 'scenarios', 'mistridge-silent-bell.json');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const scenarioOf = (data: unknown) => {
  const r = validateScenario(data);
  assert.deepEqual(r.errors, []);
  return r.scenario!;
};
const FOG = scenarioOf(readJson(FOG_FILE));
/** 会施法的职业。 */
const CASTERS: ClassKey[] = ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'];

// 一个测试网站：除了自带的剧本和《雾港旅店》，再放两个 5E 模组（建议 3 级的文件名排在前面、2 级的排在后面，看「模组」页按等级排）
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v100-'));
const appScenarios = testScenarioDir(appDir);
for (const [file, title, level] of [
  ['aa-module-l3.json', '三级的模组', 3],
  ['zz-module-l2.json', '二级的模组', 2],
] as const) {
  fs.writeFileSync(path.join(appScenarios, file), JSON.stringify({ ...readJson(MODULE_FILE), title, level }));
}

let now = Date.parse('2026-11-01T10:00:00+08:00');
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
let t3 = '';

before(async () => {
  // 骰子：d20 都是 14，别的骰子取一半（向上取整）
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0, now: () => now, rng: (sides) => (sides === 20 ? 14 : Math.ceil(sides / 2)), scenarioDir: appScenarios });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
});

after(async () => {
  await t.close();
  fs.rmSync(appDir, { recursive: true, force: true });
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const one = (sql: string, ...args: (string | number | null)[]) => Object.values(t.app.db.prepare(sql).get(...args) as Record<string, unknown>)[0];

async function logTexts(roomId: number): Promise<string[]> {
  const log = (await as(t1)('GET', `/api/rooms/${roomId}/log`)).data;
  return ((log.entries ?? log) as { kind: string; text: string }[]).filter((e) => e.kind === 'system').map((e) => e.text);
}

// ==================== 5E mod：转换（只用程序） ====================

/** 自带的剧本，加上测试剧本《雾港旅店》（规则第一版）。 */
function builtinScenarios(): { file: string; scenario: Scenario }[] {
  const dir = path.join(ROOT, 'scenarios');
  return [
    ...fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ file: f, scenario: scenarioOf(readJson(path.join(dir, f))) })),
    { file: 'fog-harbor-inn.json', scenario: FOG },
  ];
}

test('5E mod：每个普通剧本都能转成合格的 5E 剧本；身份转成 3 级的 5E 角色（没有法术的世界观里不施法），检定换成技能和 DC，敌人换成 SRD 的怪物；每次转出来都一样，不改原来的剧本', () => {
  const all = builtinScenarios();
  const regular = all.filter((x) => canPlayAs5e(x.scenario));
  assert.ok(regular.length >= 10, '自带的普通剧本都能转');
  const classes = new Set<string>();
  for (const { file, scenario } of all) {
    if (!canPlayAs5e(scenario)) {
      assert.ok(scenario.dungeon || scenario.rules === '5e', `${file}：只有地下城和 5E 模组不用转`);
      assert.throws(() => convertTo5e(scenario), /这个剧本不用转/);
      continue;
    }
    const before = JSON.stringify(scenario);
    const c = convertTo5e(scenario, RULES);
    assert.equal(JSON.stringify(scenario), before, `${file}：原来的剧本没被改`);
    assert.deepEqual(convertTo5e(scenario, RULES), c, `${file}：每次转出来都一样`);
    assert.deepEqual(validateScenario(JSON.parse(JSON.stringify(c))).errors, [], `${file}：转好的是合格的 5E 剧本`);
    assert.equal(c.rules, '5e');
    assert.equal(c.level, MOD5E_LEVEL);
    assert.equal(MOD5E_LEVEL, 3);
    assert.deepEqual(modOf(c), { from: scenario.rules === 2 ? 2 : 1, level: 3 });
    assert.equal(modOf(scenario), null);
    assert.equal(c.enemies, undefined);
    assert.deepEqual(c.treasure, []);
    assert.equal(c.stress, false);
    // 剧本的内容不动
    for (const k of ['title', 'truth', 'locations', 'npcs', 'endings', 'timeline', 'opening'] as const) assert.deepEqual(c[k], scenario[k], `${file}：${k} 照旧`);

    // 敌人：每个都对到 SRD 里有的怪物，名字照剧本的；再加上 NPC 动手时用的几个通用数据块
    const enemies = scenario.enemies ?? [];
    for (const e of enemies) {
      const m = c.monsters!.find((x) => x.key === e.key)!;
      assert.ok(m, `${file}：敌人 ${e.key} 转成了怪物`);
      assert.equal(m.name, e.name);
      assert.ok(m.monster && monsterData(m.monster), `${file}：${m.monster} 是 SRD 里有的怪物`);
      assert.equal(m.monster, monsterFor(e));
    }
    for (const npc of NPC_MONSTERS) assert.deepEqual(c.monsters!.find((x) => x.key === npc.key), npc);
    assert.equal(c.monsters!.length, enemies.length + NPC_MONSTERS.length);

    // 线索的检定：技能（或者属性）和 DC
    for (const [i, clue] of c.clues.entries()) {
      const was = scenario.clues[i].check;
      if (!was) {
        assert.equal(clue.check, scenario.clues[i].check);
        continue;
      }
      const check = clue.check as { skill: string | null; ability: string; dc: number };
      assert.ok(ABILITIES.includes(check.ability as never), `${file}：${clue.key} 的属性`);
      assert.ok(check.skill === null || SKILL_KEYS.includes(check.skill as never), `${file}：${clue.key} 的技能`);
      assert.ok(check.dc >= 8 && check.dc <= 20, `${file}：${clue.key} 的 DC ${check.dc}`);
      assert.equal(check.dc, dcFor((was as { modifier: number }).modifier));
    }

    // 身份：一个预设的 3 级人类 5E 角色
    const magic = magicWorld(scenario);
    for (const role of c.roles) {
      const p = pregenOf(role)!;
      assert.ok(p, `${file}：${role.key} 有预设的角色`);
      assert.equal(p.data.level, 3);
      assert.equal(p.data.species, 'human');
      assert.equal(p.data.class, classFor(scenario.roles.find((r) => r.key === role.key)!, magic));
      classes.add(p.data.class);
      const sheet = computeSheet(p.data, RULES);
      assert.equal(p.view.level, 3);
      assert.equal(p.view.className, sheet.className);
      assert.equal(p.view.hpMax, sheet.hpMax);
      assert.equal(p.view.ac, sheet.ac);
      assert.ok(p.view.skills.length >= 4, `${file}：${role.key} 会几门技能`);
      assert.ok(p.view.attacks.length >= 1, `${file}：${role.key} 有能用的攻击`);
      // 卡是按规则配的；唯一的例外：不施法的身份不拿背景给的「魔法学徒」，换成「多才多艺」
      const bg = RULES.backgrounds.find((b) => b.key === p.data.background)!;
      const swapped = bg.feat === 'magic-initiate' && !CASTERS.includes(p.data.class);
      const issues = cardIssues(p.data, RULES).filter((i) => !(swapped && i.text === `背景「${bg.name}」给的起源专长是固定的`));
      assert.deepEqual(issues, [], `${file}：${role.key}（${p.view.className}）的卡`);
      if (swapped) assert.equal(p.data.originFeats.find((f) => f.source === 'background')?.key, 'skilled');
      if (!magic) {
        assert.ok(!CASTERS.includes(p.data.class), `${file}：没有法术的世界观里 ${role.key} 不是施法的职业`);
        assert.deepEqual(p.view.spells, [], `${file}：${role.key} 不会法术`);
      }
    }
  }
  assert.ok(classes.has('fighter') && classes.has('rogue') && classes.size >= 3, [...classes].join('、'));
});

test('5E mod：职业照身份来（世界观里有法术才给施法的职业）；检定的技能照「怎么找到」来，DC 照难易；敌人照说法和强弱对到 SRD 的怪物', () => {
  const role = (name: string, specialties: string[], attributes: Record<string, number>): Role =>
    ({ key: 'x', name, public: '', secret: '', goal: '', specialties, attributes, appearance: '' }) as unknown as Role;
  const even = { strength: 0, agility: 0, constitution: 0, intellect: 0, perception: 0, will: 0, charm: 0 };
  const taoist = role('云游的道士', ['画符驱邪', '看风水'], { ...even, will: 2 });
  assert.equal(classFor(taoist, true), 'cleric');
  assert.ok(!CASTERS.includes(classFor(taoist, false)), '没有法术的世界观里道士也不施法');
  assert.equal(classFor(role('镖局的镖师', ['刀法', '护镖'], { ...even, strength: 2, constitution: 1 }), false), 'fighter');
  assert.equal(classFor(role('少林的武僧', ['拳法', '轻功'], { ...even, agility: 2, perception: 1 }), false), 'monk');
  assert.equal(classFor(role('码头的脚夫', ['力气大', '扛包'], { ...even, strength: 3, constitution: 2 }), false), 'barbarian');
  assert.equal(classFor(role('账房先生', ['算账', '察言观色'], { ...even, intellect: 2, agility: 1 }), false), 'rogue');
  assert.equal(magicWorld({ genre: '民国悬疑', tone: '阴冷压抑' }), false);
  assert.equal(magicWorld({ genre: '志怪', tone: '山里的狐仙' }), true);

  // DC：情境修正 0 是 12，难一级加 2，最低 8、最高 20
  assert.deepEqual([dcFor(0), dcFor(1), dcFor(-1), dcFor(-2), dcFor(3), dcFor(-6)], [12, 10, 14, 16, 8, 20]);
  assert.deepEqual(check5eFor({ title: '账房的神色', how: '看穿他在撒谎' }, 'perception', 0), { skill: 'insight', ability: 'wis', dc: 12 });
  assert.deepEqual(check5eFor({ title: '地上的脚印', how: '顺着足迹找' }, 'perception', -1), { skill: 'survival', ability: 'wis', dc: 14 });
  assert.deepEqual(check5eFor({ title: '门后', how: '仔细看看' }, 'perception', 1), { skill: 'perception', ability: 'wis', dc: 10 });
  assert.deepEqual(check5eFor({ title: '碑文', how: '认出上面的古文记载' }, 'intellect', 0), { skill: 'history', ability: 'int', dc: 12 });
  assert.deepEqual(check5eFor({ title: '账本', how: '对一对数目' }, 'intellect', 0), { skill: 'investigation', ability: 'int', dc: 12 });
  assert.deepEqual(check5eFor({ title: '伙计', how: '哄他说出来' }, 'charm', 0), { skill: 'deception', ability: 'cha', dc: 12 });
  assert.deepEqual(check5eFor({ title: '后院', how: '悄悄溜进去' }, 'agility', 0), { skill: 'stealth', ability: 'dex', dc: 12 });
  assert.deepEqual(check5eFor({ title: '石板', how: '推开' }, 'strength', -1), { skill: 'athletics', ability: 'str', dc: 14 });
  assert.deepEqual(check5eFor({ title: '冰水', how: '泡着' }, 'constitution', 0), { skill: null, ability: 'con', dc: 12 });
  assert.deepEqual(check5eFor({ title: '幻象', how: '定住心神' }, 'will', 0), { skill: null, ability: 'wis', dc: 12 });

  assert.equal(monsterFor({ name: '山里的狼', description: '饿极了的狼', tier: 'minion' }), 'wolf');
  assert.equal(monsterFor({ name: '狼王', description: '狼群的头', tier: 'boss' }), 'dire-wolf');
  assert.equal(monsterFor({ name: '守城的大将', description: '披着重甲', tier: 'boss' }), 'knight');
  assert.equal(monsterFor({ name: '寨子的大当家', description: '心狠手辣', tier: 'boss' }), 'tough-boss');
  assert.equal(monsterFor({ name: '莽汉', description: '力气大', tier: 'elite' }), 'berserker');
  assert.equal(monsterFor({ name: '城头的弓手', description: '', tier: 'minion' }), 'scout');
  assert.equal(monsterFor({ name: '地痞', description: '拿着扁担', tier: 'minion' }), 'tough');
  assert.equal(monsterFor({ name: '小喽啰', description: '', tier: 'minion' }), 'bandit');
  for (const m of NPC_MONSTERS) assert.ok(m.monster && monsterData(m.monster), `${m.key}`);
});

test('5E mod：给主持人的剧本里说清楚是转过来的（没有法术的世界观不写法术），不发身份转成的角色卡；开打时剧本里的人物用通用数据块，name 填他的名字，同名的加编号', () => {
  const c = convertTo5e(FOG, RULES);
  const block = scenarioBlock(c);
  assert.match(block, /这个剧本原来是按龙娘规则写的，这一局用 5E 规则玩：每个身份转成了一个 3 级的 5E 角色/);
  assert.match(block, /npc- 开头的那几个），name 填他的名字/);
  assert.match(block, /这个世界观里没有法术/);
  assert.match(block, /npc-tough「会打架的人」/);
  assert.doesNotMatch(block, /pregen5e|"mod5e"/);
  const json = JSON.parse(block.slice(block.lastIndexOf('\n{') + 1));
  assert.equal(json.roles.length, FOG.roles.length);
  assert.equal(json.roles[0].name, FOG.roles[0].name);
  // 5E 模组照旧：角色是玩家自己的卡
  const module = scenarioOf(readJson(MODULE_FILE));
  assert.match(scenarioBlock(module), /角色都是玩家自己的 5E 角色卡/);

  // start_combat 的 name（V1.0.0）
  const def = dmTools5e(c).find((d) => d.name === 'start_combat')!;
  assert.equal((def.input_schema as any).properties.monsters.items.properties.name.type, 'string');
  const here = c.locations[0].key;
  const role = c.roles.find((r) => r.key === 'customs')!;
  const p = pregenOf(role)!;
  const pc: Character = {
    id: 1,
    roomId: 1,
    playerId: 1,
    userId: 1,
    playerName: '玩家1',
    roleKey: role.key,
    name: '老陈',
    attributes: {} as Character['attributes'],
    specialties: [],
    appearance: role.appearance,
    goal: '',
    wounds: 0,
    stress: 0,
    conditions: [],
    items: [],
    location: here,
    visited: [here],
    dead: false,
    pet: null,
    cardId: null,
    background: '',
    gear: [],
    v2: null,
    v5: newState5e(0, p.data, computeSheet(p.data, RULES)),
    card5eId: null,
  };
  const ctx = new Rules5eContext({
    scenario: c,
    world: emptyWorld(),
    characters: [pc],
    clueHolders: new Map(),
    actorId: 1,
    gameEnd: 100,
    rng: (sides) => Math.min(10, sides),
    allowDeath: true,
    rules: RULES,
    srd: monsterData,
  });
  const start = (monsters: unknown[]) => {
    const r = ctx.execute('start_combat', { monsters });
    assert.ok(!r.isError, r.content);
    return JSON.parse(r.content).monsters as { id: string; name: string }[];
  };
  let list = start([{ monster: 'npc-tough', count: 2, name: '王二' }, { monster: 'npc-commoner' }, { monster: 'npc-guard', name: '  ' }]);
  assert.deepEqual(
    list.map((m) => [m.id, m.name]),
    [
      ['npc-tough-1', '王二1'],
      ['npc-tough-2', '王二2'],
      ['npc-commoner-1', '普通人'],
      ['npc-guard-1', '官差兵丁'],
    ],
  );
  list = start([{ monster: 'npc-tough', name: '王二' }, { monster: 'npc-commoner' }, { monster: 'npc-veteran', name: '一个名字特别特别长的江湖好手来这里挑事的家伙' }]);
  assert.deepEqual(
    list.slice(4).map((m) => [m.id, m.name]),
    [
      ['npc-tough-3', '王二3'],
      ['npc-commoner-2', '普通人2'],
      ['npc-veteran-1', '一个名字特别特别长的江湖好手来这里挑事的'],
    ],
  );
});

// ==================== 「模组」页 ====================

test('「模组」页：5E 模组单独一页（游客也能看），按建议等级排；剧本大厅里不再列 5E 模组；剧本大厅、地下城、模组三页加起来是全部的剧本', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  for (const who of [guest, t1]) {
    const r = await as(who)('GET', '/api/module-hall');
    assert.equal(r.status, 200);
    const modules = r.data.modules as { key: string; title: string; rules: string; module5e: { level: number } }[];
    assert.deepEqual(
      modules.map((m) => [m.key, m.module5e.level]),
      [
        ['mistridge-silent-bell', 1],
        ['zz-module-l2', 2],
        ['aa-module-l3', 3],
      ],
    );
    assert.ok(modules.every((m) => m.rules === '5e'));
  }
  assert.equal((await t.call('GET', '/api/module-hall')).status, 401);
  const hall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios as { key: string; rules: string | number }[];
  assert.ok(hall.length > 0 && hall.every((s) => s.rules !== '5e'), '剧本大厅里没有 5E 模组');
  const dungeons = (await as(t1)('GET', '/api/dungeon-hall')).data.dungeons as { key: string; rules: string | number }[];
  assert.ok(dungeons.every((s) => s.rules !== '5e'));
  const modules = (await as(t1)('GET', '/api/module-hall')).data.modules as { key: string }[];
  assert.deepEqual(
    [...hall, ...dungeons, ...modules].map((s) => s.key).sort(),
    t.app.works
      .listedScenarios()
      .map((s) => s.key)
      .sort(),
  );
});

test('投稿的 5E 模组通过以后放进「模组」页（投稿记录、通知里写着是模组）；用 5E 规则玩的普通剧本投的是原来那一份，照旧放进剧本大厅', async () => {
  // 导入一个 5E 模组再投稿
  const room = (await as(t2)('POST', '/api/rooms', { name: '投模组', maxPlayers: 5 })).data.room;
  let r = await as(t2)('POST', `/api/rooms/${room.id}/scenario`, { data: { ...readJson(MODULE_FILE), title: '雾岭哑钟·投稿' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.scenario.mod5e, null, '5E 模组不用转');
  r = await as(t2)('POST', `/api/rooms/${room.id}/submission`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sub = r.data.submission;
  assert.equal(sub.module, true);
  assert.equal((await as(t2)('GET', '/api/submissions')).data.submissions.find((s: { id: number }) => s.id === sub.id).module, true);
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${sub.id}/approve`)).status, 200);
  const modules = (await as(t1)('GET', '/api/module-hall')).data.modules as { title: string; authorUser: { publicId: string } | null }[];
  assert.ok(modules.some((m) => m.title === '雾岭哑钟·投稿' && m.authorUser), '放进了「模组」页，作者是投稿的人');
  assert.ok(!(await as(t1)('GET', '/api/scenario-hall')).data.scenarios.some((s: { title: string }) => s.title === '雾岭哑钟·投稿'));
  const note = (await as(t2)('GET', '/api/notifications')).data.items.find((n: { kind: string; data: { submissionId?: number } }) => n.kind === 'submission_result' && n.data.submissionId === sub.id);
  assert.equal(note.data.module, true);
  assert.equal(note.data.approved, true);
  // 同一个标题再投：说已经放进模组了
  r = await as(t2)('POST', '/api/editor/submission', { data: { ...readJson(MODULE_FILE), title: '雾岭哑钟·投稿' } });
  assert.deepEqual([r.status, r.data.error], [409, '《雾岭哑钟·投稿》已经通过审核，放进模组了']);

  // 导入的普通剧本换成 5E 规则玩：投稿投的是原来那一份（不是转好的），通过了放进剧本大厅
  const room2 = (await as(t3)('POST', '/api/rooms', { name: '转了再投', maxPlayers: 4 })).data.room;
  r = await as(t3)('POST', `/api/rooms/${room2.id}/scenario`, { data: { ...readJson(FOG_FILE), title: '雾港·转过的', category: 'puzzle' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.scenario.mod5e, 'off');
  r = await as(t3)('PUT', `/api/rooms/${room2.id}/scenario/mod5e`, { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.scenario.mod5e, r.data.scenario.rules, r.data.scenario.source], ['on', '5e', 'imported']);
  r = await as(t3)('POST', `/api/rooms/${room2.id}/submission`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.module, false);
  const data = JSON.parse(one('SELECT data FROM scenario_submissions WHERE id = ?', r.data.submission.id) as string);
  assert.equal(data.rules, undefined);
  assert.equal(data.mod5e, undefined);
  assert.ok(data.roles.every((x: Record<string, unknown>) => !('pregen5e' in x)));
  assert.deepEqual(data.clues, JSON.parse(JSON.stringify(FOG.clues)), '线索的检定还是原来的写法');
  assert.equal((await as(admin)('POST', `/api/admin/submissions/${r.data.submission.id}/approve`)).status, 200);
  assert.ok((await as(t1)('GET', '/api/scenario-hall')).data.scenarios.some((s: { title: string }) => s.title === '雾港·转过的'));
});

// ==================== 5E mod：对局 ====================

test('用 5E 规则玩普通剧本：开局时勾上就转好；身份带着预设的 5E 角色（不用自己的卡），选身份只起名字；能改名；开打、攻击照 5E 结算；走到结局不升级、不带东西；再刷一次也用 5E 规则', async () => {
  const r0 = await as(t1)('POST', '/api/rooms', { name: '雾港·5E', maxPlayers: 4, scenarioKey: 'fog-harbor-inn', mod5e: true });
  assert.equal(r0.status, 201, JSON.stringify(r0.data));
  const roomId = r0.data.room.id as number;
  assert.ok((await logTexts(roomId)).includes(`房主选了剧本《${FOG.title}》，用 5E 规则玩`));
  const code = one('SELECT join_code FROM rooms WHERE id = ?', roomId) as string;
  assert.equal((await as(t2)('POST', '/api/rooms/join', { code })).status, 200);
  const game = async (cookie: string) => (await as(cookie)('GET', `/api/rooms/${roomId}/game`)).data;
  let g = await game(t1);
  assert.deepEqual([g.scenario.mod5e, g.scenario.rules, g.scenario.module5e], ['on', '5e', { level: 3 }]);
  assert.equal(g.scenario.roles.length, FOG.roles.length);
  for (const role of g.scenario.roles) {
    assert.equal(role.pregen5e.level, 3, role.key);
    assert.deepEqual([role.attributes, role.specialties], [{}, []]);
  }
  const customs = g.scenario.roles.find((x: { key: string }) => x.key === 'customs').pregen5e;
  assert.equal(customs.className, '战士');
  assert.equal(customs.speciesName, '人类');
  // 存的是转好的那份，原来的另外存着
  const stored = t.app.db.prepare('SELECT data, original FROM scenarios WHERE room_id = ?').get(roomId) as { data: string; original: string };
  assert.equal(JSON.parse(stored.data).rules, '5e');
  assert.equal(JSON.parse(stored.original).rules, undefined);

  // 选身份：只起名字，带的 5E 卡不看
  let r = await as(t1)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'customs', name: '老陈', cardId: 12345 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let me = r.data.me;
  assert.equal(me.name, '老陈');
  assert.equal(me.v5.cardId, 0);
  assert.deepEqual([me.v5.level, me.v5.className, me.v5.speciesName, me.v5.hpMax, me.v5.ac], [3, customs.className, '人类', customs.hpMax, customs.ac]);
  assert.equal(me.v5.hp, customs.hpMax);
  assert.equal(one('SELECT card5e_id FROM characters WHERE room_id = ? AND role_key = ?', roomId, 'customs'), null);
  // 开局前能改名字，角色照旧
  r = await as(t1)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'customs', name: '陈稽查' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  me = r.data.me;
  assert.deepEqual([me.name, me.v5.className, me.v5.hpMax], ['陈稽查', customs.className, customs.hpMax]);
  assert.equal((await as(t1)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'doctor', name: '陈稽查' })).status, 409, '身份不能换');
  r = await as(t2)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'doctor', name: '许医生' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.me.v5.className, g.scenario.roles.find((x: { key: string }) => x.key === 'doctor').pregen5e.className);
  // 别人看到的是种族、职业、等级
  assert.ok((await game(t2)).others.some((o: { name: string; class5e: string }) => o.name === '陈稽查' && o.class5e === '人类战士 3 级'));
  // AI 队友（V1.2.0）：用 5E 规则玩普通剧本也能把身份交给 AI，它带一张 5E 卡
  const seat = await as(t1)('PUT', `/api/rooms/${roomId}/ai-seats/reporter`, {});
  assert.equal(seat.status, 200, JSON.stringify(seat.data));
  assert.ok((await game(t1)).companions.some((c: { roleKey: string }) => c.roleKey === 'reporter'));

  assert.equal((await as(t1)('POST', `/api/rooms/${roomId}/status`, { status: 'running' })).status, 200);
  async function act(cookie: string, content: string) {
    const res = await as(cookie)('POST', `/api/rooms/${roomId}/actions`, { content });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    await t.app.engine.idle();
    now += 125 * MIN;
    t.app.engine.tick();
    await t.app.engine.idle();
  }
  // 剧本里没有敌人：开打放出的是通用的「普通人」
  await act(t1, '测试开打：有人从背后扑过来');
  g = await game(t1);
  assert.ok(g.fight5e, '开打以后看得到战斗');
  assert.equal(g.fight5e.monsters[0].name, '普通人');
  await act(t1, '测试攻击：一拳打过去');
  g = await game(t1);
  assert.ok(g.fight5e.monsters[0].hp < g.fight5e.monsters[0].hpMax || g.fight5e.monsters[0].defeated, '打中了');
  await act(t1, '测试结束战斗');
  await act(t1, '测试结局：雾散了');
  g = await game(t1);
  assert.ok(g.ending, '走到了结局');
  assert.equal(one('SELECT status FROM rooms WHERE id = ?', roomId), 'ended');
  // 用的是转好的角色：没有 5E 角色卡升级、带东西
  assert.equal(one('SELECT COUNT(*) FROM cards5e WHERE user_id IN (SELECT user_id FROM players WHERE room_id = ?)', roomId), 0);
  assert.equal(one('SELECT COUNT(*) FROM characters WHERE room_id = ? AND card5e_id IS NOT NULL', roomId), 0);

  // 再刷一次：新的一局也用 5E 规则
  r = await as(t1)('POST', `/api/rooms/${roomId}/replay`);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const fresh = (await as(t1)('GET', `/api/rooms/${r.data.room.id}/game`)).data;
  assert.deepEqual([fresh.scenario.key, fresh.scenario.mod5e, fresh.scenario.rules], ['fog-harbor-inn', 'on', '5e']);
});

test('开团准备里切换 5E 规则：只有房主、开局前能换；换了大家建的角色清空，记录里说一声；地下城、5E 模组、还没选剧本的不能换', async () => {
  const room = (await as(t1)('POST', '/api/rooms', { name: '雾港·切换', maxPlayers: 4, scenarioKey: 'fog-harbor-inn' })).data.room;
  const roomId = room.id as number;
  const code = one('SELECT join_code FROM rooms WHERE id = ?', roomId) as string;
  assert.equal((await as(t2)('POST', '/api/rooms/join', { code })).status, 200);
  const put = (cookie: string, body: unknown) => as(cookie)('PUT', `/api/rooms/${roomId}/scenario/mod5e`, body);
  let g = (await as(t1)('GET', `/api/rooms/${roomId}/game`)).data;
  assert.deepEqual([g.scenario.mod5e, g.scenario.rules], ['off', 1]);
  assert.ok(g.scenario.roles.every((x: { pregen5e: unknown }) => x.pregen5e === null));
  // 照原来的规则先建了角色
  let r = await as(t2)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'doctor', name: '许医生' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.me.v5, null);

  assert.equal((await put(t2, { on: true })).status, 403, '不是房主');
  assert.equal((await put(t1, { on: 'yes' })).status, 400);
  r = await put(t1, { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.scenario.mod5e, r.data.scenario.rules], ['on', '5e']);
  assert.equal(one('SELECT COUNT(*) FROM characters WHERE room_id = ?', roomId), 0, '建的角色清空了');
  let texts = await logTexts(roomId);
  assert.equal(texts.at(-1), '房主改成用 5E 规则玩：每个身份都转成了一个 5E 角色，检定也换成了 5E 的，之前建的角色清空了，请重新选身份');
  // 已经是了：什么都不变
  r = await put(t1, { on: true });
  assert.equal(r.status, 200);
  assert.equal((await logTexts(roomId)).length, texts.length);
  r = await as(t2)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'doctor', name: '许医生' });
  assert.equal(r.data.me.v5.cardId, 0);
  // 换回去
  r = await put(t1, { on: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.scenario.mod5e, r.data.scenario.rules], ['off', 1]);
  assert.equal(r.data.scenario.roles.find((x: { key: string }) => x.key === 'doctor').specialties.length, 2, '身份的专长回来了');
  texts = await logTexts(roomId);
  assert.equal(texts.at(-1), '房主改回了剧本原来的规则，之前建的角色清空了，请重新选身份');
  const stored = t.app.db.prepare('SELECT data, original FROM scenarios WHERE room_id = ?').get(roomId) as { data: string; original: string | null };
  assert.deepEqual(JSON.parse(stored.data), JSON.parse(JSON.stringify(FOG)));
  assert.equal(stored.original, null);
  // 开局以后不能换
  assert.equal((await put(t1, { on: true })).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${roomId}/character`, { roleKey: 'customs', name: '老陈' })).status, 200);
  assert.equal((await as(t1)('POST', `/api/rooms/${roomId}/status`, { status: 'running' })).status, 200);
  r = await put(t1, { on: false });
  assert.deepEqual([r.status, r.data.error], [409, '对局已经开始了，不能再换规则']);

  // 地下城、5E 模组不能换；开局时勾上了也不转
  const dungeon = (await as(t1)('POST', '/api/rooms', { name: '矿', maxPlayers: 2, scenarioKey: 'dungeon-abandoned-mine', mod5e: true })).data.room;
  assert.equal((await as(t1)('GET', `/api/rooms/${dungeon.id}/game`)).data.scenario.mod5e, null);
  r = await as(t1)('PUT', `/api/rooms/${dungeon.id}/scenario/mod5e`, { on: true });
  assert.deepEqual([r.status, r.data.error], [409, '地下城不能换成 5E 规则']);
  const module = (await as(t1)('POST', '/api/rooms', { name: '钟', maxPlayers: 4, scenarioKey: 'mistridge-silent-bell', mod5e: true })).data.room;
  g = (await as(t1)('GET', `/api/rooms/${module.id}/game`)).data;
  assert.deepEqual([g.scenario.mod5e, g.scenario.rules], [null, '5e']);
  r = await as(t1)('PUT', `/api/rooms/${module.id}/scenario/mod5e`, { on: true });
  assert.deepEqual([r.status, r.data.error], [409, '这个剧本本来就是 5E 模组']);
  const empty = (await as(t1)('POST', '/api/rooms', { name: '空的', maxPlayers: 4 })).data.room;
  r = await as(t1)('PUT', `/api/rooms/${empty.id}/scenario/mod5e`, { on: true });
  assert.deepEqual([r.status, r.data.error], [409, '先选一个剧本']);
});

// ==================== 删档 ====================

/**
 * 一个停在第 22 版（V0.9.x）、有数据的数据库：测试账号和测试对局，再加一局、一条公告、一份投稿；AI 开着、开放注册；版本更新公告发到了 0.9.2。
 * 返回删档时说的那几个数。
 */
async function betaDatabase(file: string, opts: { release?: string } = {}) {
  const db = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
  await seedTestData(db, now);
  db.prepare("INSERT INTO users (username, display_name, password_hash, is_guest, created_at) VALUES ('guest-beta00000001', '游客', '!', 1, ?)").run(now);
  const host = (db.prepare('SELECT id FROM users WHERE is_owner = 1').get() as { id: number }).id;
  const room = Number(
    db.prepare("INSERT INTO rooms (name, host_user_id, join_code, max_players, model, created_at) VALUES ('内测的局', ?, 'BETA01', 4, 'claude', ?)").run(host, now).lastInsertRowid,
  );
  db.prepare("INSERT INTO players (room_id, user_id, role, joined_at) VALUES (?, ?, 'host', ?)").run(room, host, now);
  db.prepare("INSERT INTO announcements (title, body, audience, created_by, created_at) VALUES ('内测公告', '大家好', 'all', ?, ?)").run(host, now);
  db.prepare(
    "INSERT INTO scenario_submissions (user_id, room_id, title, category, intro, data, status, created_at) VALUES (?, ?, '内测的投稿', 'puzzle', '简介', '{}', 'pending', ?)",
  ).run(host, room, now);
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', '1'), ('registration_mode', 'open'), ('release_notes_posted', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    opts.release ?? '0.9.2',
  );
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const counts = {
    users: n('SELECT COUNT(*) AS n FROM users WHERE is_guest = 0 AND deleted_at IS NULL'),
    rooms: n('SELECT COUNT(*) AS n FROM rooms'),
    announcements: n('SELECT COUNT(*) AS n FROM announcements'),
    submissions: n('SELECT COUNT(*) AS n FROM scenario_submissions'),
  };
  db.close();
  assert.ok(counts.users === TEST_ACCOUNTS.length && counts.rooms >= 2 && counts.announcements === 1 && counts.submissions === 1);
  return counts;
}
/** 删档时说的「几个账号、几局对局、几条公告、几份投稿」。 */
const countsText = (c: { users: number; rooms: number; announcements: number; submissions: number }) =>
  `${c.users} 个账号、${c.rooms} 局对局、${c.announcements} 条公告、${c.submissions} 份投稿`;

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** npm run reset -- --first-run（start.bat 发现要建站长账号时这样运行），按顺序回答。 */
function firstRun(dbPath: string, scenarios: string, port: number, input: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'reset.ts'), '--first-run', `--scenario-dir=${scenarios}`], {
      env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('删档（数据库第 23 版）：内测的账号（包括站长）、对局、公告、投稿、聊天和各种记录全清掉；网站的设置、限时活动、商城上架的商品留着；升级前先备份；记下清掉了多少；版本更新公告只发 V1.0.0 的', async () => {
  // 删档是第 23 版（V1.0.x 以后还有新的版本：站位是第 24 版）
  assert.ok(MIGRATIONS.length >= 23);
  assert.match(MIGRATIONS[22], /'beta_wipe'/);
  assert.equal(BEFORE_WIPE, 22);
  // 这个测试网站用了一阵子：再加点公告、大厅聊天、好友申请、商城上架的商品
  assert.equal((await as(admin)('POST', '/api/admin/announcements', { title: '内测公告', body: '感谢大家参加内测', audience: 'all' })).status, 201);
  assert.equal((await as(t1)('POST', '/api/lobby/chat', { text: '大家好' })).status < 300, true);
  await as(t1)('POST', '/api/friends', { username: TESTER2.username });
  const adminId = one('SELECT id FROM users WHERE username = ?', ADMIN.username) as number;
  t.app.db.prepare("INSERT INTO shop_listings (kind, ref, name, count, price, created_by, created_at) VALUES ('title', 'beta', '内测元老', 1, 10, ?, ?)").run(adminId, now);
  t.app.db.prepare("INSERT INTO settings (key, value) VALUES ('release_notes_posted', '0.9.2') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();

  // 拷一份，退回第 22 版（第 23 版只删数据，表结构和第 22 版一样），再打开：升级时删档
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-wipe-'));
  try {
    const file = path.join(dir, 'game.db');
    t.app.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const raw = new DatabaseSync(file);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
    const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const beforeCounts = Object.fromEntries(tables.map((x) => [x, count(raw, x)]));
    for (const x of ['users', 'sessions', 'rooms', 'players', 'characters', 'log_entries', 'actions', 'announcements', 'scenario_submissions', 'notifications', 'lobby_messages', 'friendships', 'scenarios']) {
      assert.ok(beforeCounts[x] > 0, `删档前 ${x} 里有数据`);
    }
    const settingsBefore = raw.prepare("SELECT key, value FROM settings WHERE key NOT IN ('release_notes_posted', 'app_version') ORDER BY key").all();
    const users = count(raw, 'users');
    const guests = (raw.prepare('SELECT COUNT(*) AS n FROM users WHERE is_guest = 1').get() as { n: number }).n;
    assert.ok(guests > 0, '有游客');
    // 退回第 22 版：第 24 版（站位）、第 25 版（V1.1.0 AI 大厅）加的先去掉，升级时会再加上
    // （ai_seats.persona_id 带着外键，不能直接去掉这一列：照第 22 版的样子重建这张表）
    raw.exec('ALTER TABLE characters DROP COLUMN spot');
    raw.exec(`DROP INDEX ai_seats_persona;
      CREATE TABLE ai_seats_v22 (
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        role_key TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, role_key)
      );
      INSERT INTO ai_seats_v22 SELECT room_id, role_key, name, created_at FROM ai_seats;
      DROP TABLE ai_seats;
      ALTER TABLE ai_seats_v22 RENAME TO ai_seats;
      DROP TABLE ai_persona_invites;
      DROP TABLE ai_personas;`);
    raw.exec('UPDATE schema_version SET version = 22');
    raw.close();

    const backups: [string, number, number][] = [];
    const db = openDatabase(file, { onBackup: (f, from, to) => backups.push([f, from, to]) });
    try {
      assert.equal(schemaVersion(db), MIGRATIONS.length);
      assert.equal(backups.length, 1, '升级前先备份');
      assert.deepEqual(backups[0].slice(1), [22, MIGRATIONS.length]);
      const backup = new DatabaseSync(backups[0][0], { readOnly: true });
      assert.equal(count(backup, 'users'), users, '备份里是删档前的数据');
      backup.close();

      const kept = new Set(['events', 'schema_version', 'settings', 'shop_listings']);
      for (const x of tables) {
        if (kept.has(x)) continue;
        assert.equal(count(db as unknown as DatabaseSync, x), 0, `${x} 清空了`);
      }
      assert.equal(count(db as unknown as DatabaseSync, 'events'), beforeCounts.events, '限时活动留着');
      assert.ok(beforeCounts.events > 0);
      assert.deepEqual(
        (db.prepare("SELECT name, price, created_by FROM shop_listings WHERE ref = 'beta'").all() as object[]).map((x) => ({ ...x })),
        [{ name: '内测元老', price: 10, created_by: null }],
        '商城上架的商品留着（上架的人没了）',
      );
      assert.deepEqual(
        db.prepare("SELECT key, value FROM settings WHERE key NOT IN ('beta_wipe', 'app_version') ORDER BY key").all(),
        settingsBefore,
        '网站的设置留着，只忘了版本更新公告发到哪一版',
      );
      const wipe = betaWipeOf(db)!;
      assert.deepEqual(
        { ...wipe, at: 0 },
        {
          pending: 1,
          users: users - guests,
          guests,
          rooms: beforeCounts.rooms,
          announcements: beforeCounts.announcements,
          submissions: beforeCounts.scenario_submissions,
          at: 0,
        },
      );
      assert.ok(Math.abs(wipe.at - Date.now()) < 60_000);
      // 新的站长是 0 号；版本更新公告像全新的网站一样只发 V1.0.0 的
      db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_admin, is_owner) VALUES ('newboss', '新站长', 'x', 1, 1, 1)").run();
      assert.equal((db.prepare("SELECT uid FROM users WHERE username = 'newboss'").get() as { uid: number }).uid, 0);
      assert.deepEqual(postReleaseNotes(db, { now, version: '1.0.0' }), ['1.0.0']);
      assert.deepEqual(
        (db.prepare('SELECT title FROM announcements').all() as { title: string }[]).map((x) => x.title),
        ['V1.0.0 更新了什么'],
      );
    } finally {
      db.close();
    }

    // 从 V0.8.x 升级上来（公告发到 0.8.3）也只发 V1.0.0 的，不补发 V0.9.x 的
    const old = path.join(dir, 'old.db');
    await betaDatabase(old, { release: '0.8.3' });
    const oldDb = openDatabase(old, { onBackup: () => {} });
    try {
      assert.deepEqual(postReleaseNotes(oldDb, { now, version: '1.0.0' }), ['1.0.0']);
    } finally {
      oldDb.close();
    }

    // 全新的网站、停在第 22 版但一个账号和对局都没有的：不记删档
    const fresh = openDatabase(':memory:');
    assert.equal(betaWipeOf(fresh), null);
    assert.equal(finishBetaWipe(fresh, { scenarioDir: dir, dbPath: ':memory:' }), null);
    assert.deepEqual(postReleaseNotes(fresh, { now, version: '1.0.0' }), ['1.0.0']);
    fresh.close();
    const unused = path.join(dir, 'unused.db');
    openDatabase(unused, { onBackup: () => {}, upTo: BEFORE_WIPE }).close();
    const unusedDb = openDatabase(unused, { onBackup: () => {} });
    assert.equal(betaWipeOf(unusedDb), null);
    unusedDb.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('删档的收尾：投稿通过的剧本文件（sub-*.json）挪进备份文件夹，下架的记录跟着去掉；自己放的剧本文件、自带的不动；记一笔操作记录；只做一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-wipe-files-'));
  try {
    const scenarios = testScenarioDir(dir);
    for (const f of ['sub-3.json', 'sub-12-2.json', 'my-own.json', 'sub-x.json']) fs.writeFileSync(path.join(scenarios, f), JSON.stringify({ ...readJson(FOG_FILE), title: f }));
    const file = path.join(dir, 'data', 'game.db');
    const counts = await betaDatabase(file);
    const db = openDatabase(file, { onBackup: () => {} });
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('scenarios_hidden', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
        JSON.stringify(['sub-3', 'teahouse-truce']),
      );
      const at = Date.parse('2026-11-01T12:30:00+08:00');
      const done = finishBetaWipe(db, { scenarioDir: scenarios, dbPath: file, now: at })!;
      assert.ok(done);
      assert.deepEqual(done.moved, ['sub-12-2.json', 'sub-3.json']);
      assert.deepEqual(done.problems, []);
      assert.equal(done.movedTo, path.join(dir, 'data', 'backups', 'v1-wipe-20261101-123000'));
      assert.deepEqual(fs.readdirSync(path.join(done.movedTo!, 'scenarios')).sort(), ['sub-12-2.json', 'sub-3.json']);
      const left = fs.readdirSync(scenarios);
      assert.ok(!left.includes('sub-3.json') && !left.includes('sub-12-2.json'));
      assert.ok(left.includes('my-own.json') && left.includes('sub-x.json') && left.includes('teahouse-truce.json'), '自己放的、自带的不动');
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'scenarios_hidden'").get()!.value as string), ['teahouse-truce']);
      const wipe = betaWipeOf(db)!;
      assert.equal(wipe.pending, undefined);
      assert.deepEqual(wipe.moved, ['sub-12-2.json', 'sub-3.json']);
      const audits = db.prepare('SELECT admin_id, action, detail, created_at FROM admin_audit').all() as { admin_id: number | null; action: string; detail: string; created_at: number }[];
      assert.equal(audits.length, 1);
      assert.deepEqual([audits[0].admin_id, audits[0].action, audits[0].created_at], [null, '正式版删档', at]);
      assert.ok(audits[0].detail.startsWith(`升级到 V1.0.0 时清掉了内测的数据：${countsText(counts)}；投稿通过的剧本文件 2 个挪进了`), audits[0].detail);
      const lines = betaWipeLines(done);
      assert.ok(lines[0].startsWith(`V1.0.0 正式版：内测的数据已经清空了（${countsText(counts)}，还有聊天`), lines[0]);
      assert.match(lines.join('\n'), /网站的设置（AI 模型和开关、商城、注册方式）、限时活动留着/);
      assert.ok(lines.some((l) => l.includes(done.movedTo!)));
      // 只做一次
      assert.equal(finishBetaWipe(db, { scenarioDir: scenarios, dbPath: file }), null);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start.bat 什么时候问你建站长账号：还没有数据；数据是 V1.0.0 以前的（复制过来升级时删档）；里面一个账号都没有。V1.0.0 以前的版本不删档', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-needs-owner-'));
  try {
    const file = path.join(dir, 'game.db');
    assert.equal(needsOwner(file, ROOT), true, '还没有数据');
    await betaDatabase(file);
    assert.equal(willWipe(file, ROOT), true, '第 22 版的数据到 V1.0.0 会删档');
    assert.equal(needsOwner(file, ROOT), true, '删档连站长一起清掉：要建');
    // V0.9.2 的文件夹里不删档
    const oldRoot = path.join(dir, 'v092');
    fs.mkdirSync(oldRoot);
    fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ name: 'ai-trpg', version: '0.9.2' }));
    assert.equal(willWipe(file, oldRoot), false);
    assert.equal(needsOwner(file, oldRoot), false, '有账号');
    // 删过档、还没建站长
    openDatabase(file, { onBackup: () => {} }).close();
    assert.equal(willWipe(file, ROOT), false);
    assert.equal(needsOwner(file, ROOT), true);
    // 有了站长
    const db = openDatabase(file, { onBackup: () => {} });
    db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_admin, is_owner) VALUES ('boss', '站长', 'x', 1, 1, 1)").run();
    db.close();
    assert.equal(needsOwner(file, ROOT), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('删档以后第一次运行（npm run reset -- --first-run）：先升级（删档、挪走投稿通过的剧本文件），再只建新的站长账号（0 号），网站的设置不动；问到一半断了下次再问；建好以后不再问', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-first-wipe-'));
  try {
    const port = await freePort();
    const scenarios = testScenarioDir(dir);
    fs.writeFileSync(path.join(scenarios, 'sub-7.json'), JSON.stringify({ ...readJson(FOG_FILE), title: '投稿通过的' }));
    const dbPath = path.join(dir, 'data', 'game.db');
    const counts = await betaDatabase(dbPath);

    // 问到一半输入断了：删档已经做了（升级时），站长没建；下次还会问
    let r = await firstRun(dbPath, scenarios, port, 'newboss\n');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`数据库要从第 22 版升级到第 ${MIGRATIONS.length} 版，升级前先备份了一份`));
    assert.ok(r.out.includes(`V1.0.0 正式版：内测的数据已经清空了（${countsText(counts)}`), r.out);
    assert.match(r.out, /投稿通过的剧本文件挪进了/);
    assert.match(r.out, /网站里还没有账号，先建你的站长账号/);
    assert.match(r.out, /没有读到输入，什么都没改/);
    assert.doesNotMatch(r.out, /确定清空吗/);
    assert.ok(!fs.existsSync(path.join(scenarios, 'sub-7.json')));
    assert.equal(needsOwner(dbPath, ROOT), true);

    r = await firstRun(dbPath, scenarios, port, 'newboss\n新站长\nnewboss-pass-2026\nnewboss-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /内测的数据已经清空了/, '删档的收尾只做一次');
    assert.match(r.out, /网站里还没有账号，先建你的站长账号/);
    assert.match(r.out, /站长账号：newboss（UID 0）/);
    assert.match(r.out, /AI：开着/, '网站的设置不动（AI 开着的照旧开着）');
    const db = openDatabase(dbPath, { onBackup: () => {} });
    try {
      assert.deepEqual(
        (db.prepare('SELECT username, display_name, uid, is_owner, is_admin, is_guest FROM users').all() as object[]).map((x) => ({ ...x })),
        [{ username: 'newboss', display_name: '新站长', uid: 0, is_owner: 1, is_admin: 1, is_guest: 0 }],
      );
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'registration_mode'").get()!.value, 'open');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n, 0);
      assert.equal(betaWipeOf(db)!.pending, undefined);
    } finally {
      db.close();
    }
    assert.equal(needsOwner(dbPath, ROOT), false);

    // 再运行：已经有账号了，什么都不做
    r = await firstRun(dbPath, scenarios, port, '');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已经有数据了，不用再建站长账号/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 版本 ====================

test('V1.0.0：版本号、页脚写「正式版」；更新公告', () => {
  // V1.0.1 起版本号往上走：不比 1.0.0 旧就行
  assert.ok(compareVersions(readJson(path.join(ROOT, 'package.json')).version, '1.0.0') >= 0);
  const version = fs.readFileSync(path.join(ROOT, 'web', 'src', 'version.ts'), 'utf8');
  assert.match(version, /export const APP_STAGE = '正式版';/);
  const note = RELEASE_NOTES.find((n) => n.version === '1.0.0')!;
  assert.ok(note && [...note.title].length <= 40 && [...note.body].length <= 2000);
  for (const word of [/正式版/, /重新注册/, /「模组」/, /用 5E 规则玩/, /3 级/]) assert.match(note.body, word);
  assert.doesNotMatch(note.body, /DeepSeek|Claude|管理页|站长/);
});
