process.env.TZ = 'Asia/Shanghai';
// 地图和距离（V1.0.x）：路程按出口算、最快的路线、时间不够只走到半路、赶路、地图上没有路的要写怎么去的、暗道、
// 附近听得到的动静、每个人看到的地图（去过的、看得见的、合作剧本一队人共享）、主持人和计时员看到的路程表、自带剧本的位置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { anyExit, edgeMinutes, hurried, layoutPlaces, openExits, pathKey, routeBetween, routesFrom, routesOnView, travelText, visibleMap, walkRoute, type MapPlace } from '../shared/map';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { buildAnswerContext, buildDmContext, buildEstimateContext, DM_RULES, DM_RULES_5E, DM_RULES_V2, routeLines, scenarioBlock } from '../server/game/prompts';
import { SCENARIO_SCHEMA, SCENARIO_WRITER_SYSTEM } from '../server/game/scenario-prompts';
import { validateScenario, type Scenario } from '../server/game/scenario';
import { ResolutionContext } from '../server/game/tools';
import { emptyWorld, exitsFoundBy, type Character, type World } from '../server/game/world';
import { knownRoutesText, mapViewOf } from '../server/game/map-view';
import { newLocation } from '../web/src/editor/doc';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;
const ROOT = path.resolve(import.meta.dirname, '..');
const fixture = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
const builtin = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', file), 'utf8'));
const valid = (data: unknown): Scenario => {
  const r = validateScenario(data);
  assert.deepEqual(r.errors, []);
  return r.scenario!;
};

// 《雾港旅店》的地图：大堂—账房 1、大堂—客房 1、大堂—后厨 1、大堂—街道 2、后厨—地窖 1、后厨—码头 8、码头—街道 10、街道—当铺 5
// 测试里加一条地窖和码头之间的暗道（3 分钟，两头都是暗的），一间只能从地窖的暗门进去的密室，一个哪儿都不通的小岛
function secretInn(): Scenario {
  const data = fixture();
  const cellar = data.locations.find((l: any) => l.key === 'cellar');
  const pier = data.locations.find((l: any) => l.key === 'pier');
  cellar.exits.push({ to: 'pier', minutes: 3, hidden: true }, { to: 'vault', minutes: 2, hidden: true });
  pier.exits.push({ to: 'cellar', minutes: 3, hidden: true });
  data.locations.push(
    { key: 'vault', name: '密室', description: '地窖墙后的小屋。', exits: [{ to: 'cellar', minutes: 2 }], features: [], x: 8, y: 80 },
    { key: 'island', name: '小岛', description: '雾里的小岛。', exits: [], features: [], x: 90, y: 90 },
  );
  return valid(data);
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

function context(scenario: Scenario, characters: Character[], opts: { minutes?: number; world?: World; actorId?: number } = {}) {
  return new ResolutionContext({
    scenario,
    world: opts.world ?? emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: opts.actorId ?? characters[0].id,
    gameEnd: 1400,
    rng: () => 3,
    minutes: opts.minutes,
  });
}

const run = (ctx: ResolutionContext, tool: string, input: unknown) => {
  const r = ctx.execute(tool, input);
  return { ...r, data: r.isError ? null : JSON.parse(r.content) };
};

// ---------- 纯计算 ----------

test('最快的路线：按出口的分钟数找，一样快的经过的地点少的优先；暗道发现了才走得通；路线写成「8 分钟」「1 小时 20 分钟」', () => {
  const s = secretInn();
  const r = routeBetween(s.locations, 'lobby', 'cellar')!;
  assert.deepEqual(r, { minutes: 2, path: ['lobby', 'kitchen', 'cellar'], steps: [1, 1] });
  // 没发现暗道：去码头走后厨（9 分钟）；发现了：穿过地窖的暗道（5 分钟）
  assert.deepEqual(routeBetween(s.locations, 'lobby', 'pier')!.path, ['lobby', 'kitchen', 'pier']);
  const found = new Set([pathKey('cellar', 'pier')]);
  assert.deepEqual(routeBetween(s.locations, 'lobby', 'pier', openExits(found)), { minutes: 5, path: ['lobby', 'kitchen', 'cellar', 'pier'], steps: [1, 1, 3] });
  assert.equal(routeBetween(s.locations, 'lobby', 'vault'), null, '密室只能走暗门进');
  assert.equal(routeBetween(s.locations, 'lobby', 'vault', anyExit)!.minutes, 4);
  assert.equal(routeBetween(s.locations, 'lobby', 'island', anyExit), null);
  assert.equal(routeBetween(s.locations, 'lobby', 'lobby')!.minutes, 0);
  assert.equal(pathKey('pier', 'cellar'), pathKey('cellar', 'pier'));
  // 一样快的：经过的地点少的优先
  const tie: MapPlace[] = [
    { key: 'a', name: 'A', exits: [{ to: 'b', minutes: 1 }, { to: 'd', minutes: 4 }] },
    { key: 'b', name: 'B', exits: [{ to: 'c', minutes: 1 }] },
    { key: 'c', name: 'C', exits: [{ to: 'd', minutes: 2 }] },
    { key: 'd', name: 'D', exits: [] },
  ];
  assert.deepEqual(routesFrom(tie, 'a').get('d')!.path, ['a', 'd']);
  assert.deepEqual([travelText(8), travelText(60), travelText(80), travelText(24 * 60 + 180), travelText(48 * 60)], ['8 分钟', '1 小时', '1 小时 20 分钟', '1 天 3 小时', '2 天']);
});

test('沿着路线走：时间只够走到哪个地点就停在哪；赶路每一段按一半算（至少 1 分钟）', () => {
  const route = { minutes: 17, path: ['a', 'b', 'c', 'd'], steps: [2, 5, 10] };
  assert.deepEqual(walkRoute(route, 100), { stop: 'd', used: 17, passed: ['b', 'c'], left: 0 });
  assert.deepEqual(walkRoute(route, 8), { stop: 'c', used: 7, passed: ['b'], left: 10 });
  assert.deepEqual(walkRoute(route, 1), { stop: 'a', used: 0, passed: [], left: 17 });
  assert.deepEqual(walkRoute(route, 9, true), { stop: 'd', used: 9, passed: ['b', 'c'], left: 0 });
  assert.deepEqual([hurried(1), hurried(2), hurried(5)], [1, 1, 3]);
});

test('地图上的位置：写了的照写的，没写的按路程摆（路近的近），每次都一样、不出界、不挤在一起；地点多也很快', () => {
  const s = secretInn();
  const fixed = layoutPlaces(s.locations);
  assert.deepEqual(fixed.lobby, { x: 50, y: 54 });
  assert.deepEqual(fixed.vault, { x: 8, y: 80 });
  // 去掉一部分位置：写了的不动，没写的自动摆
  const partial = s.locations.map((l) => (['lobby', 'street'].includes(l.key) ? l : { ...l, x: undefined, y: undefined }));
  const a = layoutPlaces(partial);
  assert.deepEqual(a.lobby, { x: 50, y: 54 });
  assert.deepEqual(layoutPlaces(partial), a, '每次都一样');
  for (const file of fs.readdirSync(path.join(ROOT, 'scenarios'))) {
    const places = builtin(file).locations.map((l: any) => ({ key: l.key, name: l.name, exits: l.exits }));
    const started = performance.now();
    const pos = layoutPlaces(places);
    assert.ok(performance.now() - started < 500, `${file} 摆得太慢`);
    const pts = Object.values(pos);
    assert.equal(pts.length, places.length);
    for (const p of pts) assert.ok(p.x >= 2 && p.x <= 98 && p.y >= 2 && p.y <= 98, `${file} 出界了`);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 8, `${file} 有地点挤在一起`);
    // 路近的比路远的摆得近：每个地点最近的邻居，比它没有出口相连的地点平均近
    const key = places[0].key;
    const near = Math.min(...places[0].exits.map((e: any) => Math.hypot(pos[key].x - pos[e.to].x, pos[key].y - pos[e.to].y)));
    const others = places.filter((p: any) => p.key !== key && !places[0].exits.some((e: any) => e.to === p.key));
    if (others.length) {
      const avg = others.reduce((sum: number, p: any) => sum + Math.hypot(pos[key].x - pos[p.key].x, pos[key].y - pos[p.key].y), 0) / others.length;
      assert.ok(near < avg, `${file}：相连的地点应该摆得更近`);
    }
  }
  // 40 个地点（剧本最多这么多）
  const big: MapPlace[] = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, name: `地点${i}`, exits: [{ to: `p${(i + 1) % 40}`, minutes: 5 + (i % 7) }, { to: `p${(i + 7) % 40}`, minutes: 30 }] }));
  const started = performance.now();
  layoutPlaces(big);
  assert.ok(performance.now() - started < 1500);
});

test('看得到的地图：去过的地点、从去过的地点看得见的出口通向的地点；路只画看得见的；暗道发现了才画；整张地图标出暗道；两个方向的分钟分开记', () => {
  const s = secretInn();
  const v = visibleMap(s.locations, { visited: new Set(['lobby']), found: new Set(), here: 'lobby' });
  assert.deepEqual([...v.nodes].sort(), ['guest-rooms', 'kitchen', 'ledger-room', 'lobby', 'street']);
  assert.ok(v.edges.every((e) => e.a === 'lobby' || e.b === 'lobby'), '两个都没去过的地点之间的路看不到');
  // 去过后厨和地窖：码头看得到，暗道看不到
  const v2 = visibleMap(s.locations, { visited: new Set(['lobby', 'kitchen', 'cellar']), found: new Set(), here: 'cellar' });
  assert.ok(v2.nodes.has('pier') && !v2.nodes.has('vault'));
  assert.ok(!v2.edges.some((e) => pathKey(e.a, e.b) === pathKey('cellar', 'pier')));
  const v3 = visibleMap(s.locations, { visited: new Set(['lobby', 'kitchen', 'cellar']), found: new Set([pathKey('cellar', 'pier')]), here: 'cellar' });
  const secret = v3.edges.find((e) => pathKey(e.a, e.b) === pathKey('cellar', 'pier'))!;
  assert.deepEqual(secret, { a: 'cellar', b: 'pier', ab: 3, ba: 3, hidden: true });
  // 密室：从地窖那边是暗门（还没发现），密室那边是普通的门：在密室里的人看得到回地窖的路
  const inside = visibleMap(s.locations, { visited: new Set(['vault']), found: new Set(), here: 'vault' });
  assert.deepEqual(inside.edges, [{ a: 'cellar', b: 'vault', ba: 2 }], '地窖那边的暗门还没发现：看起来是普通的门');
  const known = visibleMap(s.locations, { visited: new Set(['vault']), found: new Set([pathKey('cellar', 'vault')]), here: 'vault' });
  assert.deepEqual(known.edges, [{ a: 'cellar', b: 'vault', ab: 2, ba: 2, hidden: true }]);
  assert.equal(edgeMinutes(inside.edges[0], 'vault'), 2);
  assert.equal(edgeMinutes(inside.edges[0], 'cellar'), undefined, '地窖那边的暗门还没发现：从地窖走不过来');
  const full = visibleMap(s.locations, { visited: new Set(), found: new Set(), here: null, full: true });
  assert.equal(full.nodes.size, s.locations.length);
  assert.deepEqual(full.edges.find((e) => e.b === 'vault'), { a: 'cellar', b: 'vault', ab: 2, ba: 2, hidden: true }, '一头是暗门就画成暗道');
  assert.equal(full.edges.find((e) => pathKey(e.a, e.b) === pathKey('cellar', 'pier'))!.hidden, true);
  // 上坡下坡不一样快：路线照方向算
  const hill: MapPlace[] = [
    { key: 'foot', name: '山脚', exits: [{ to: 'top', minutes: 90 }] },
    { key: 'top', name: '山顶', exits: [{ to: 'foot', minutes: 30 }] },
  ];
  const hv = visibleMap(hill, { visited: new Set(['foot', 'top']), found: new Set(), here: 'top' });
  assert.deepEqual(hv.edges, [{ a: 'foot', b: 'top', ab: 90, ba: 30 }]);
  assert.equal(routesOnView({ nodes: hill, edges: hv.edges }, 'top').get('foot')!.minutes, 30);
  assert.equal(routesOnView({ nodes: hill, edges: hv.edges }, 'foot').get('top')!.minutes, 90);
});

// ---------- 剧本格式 ----------

test('剧本格式：x、y 要一起写、在 0～100 里；写了一部分、挤在一起的提醒；暗道只认 true', () => {
  const data = fixture();
  data.locations[0].exits[0].hidden = false;
  data.locations[1].exits[0].hidden = true;
  const s = valid(data);
  assert.equal('hidden' in s.locations[0].exits[0], false);
  assert.equal(s.locations[1].exits[0].hidden, true);

  const bad = fixture();
  delete bad.locations[0].y;
  bad.locations[1].x = 120;
  const r = validateScenario(bad);
  assert.ok(r.errors.some((e) => e.includes('locations[0].y') && e.includes('x、y 一起写')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.includes('locations[1].x')), r.errors.join('\n'));

  const part = fixture();
  delete part.locations[2].x;
  delete part.locations[2].y;
  part.locations[3].x = part.locations[4].x + 1;
  part.locations[3].y = part.locations[4].y;
  const w = validateScenario(part).warnings;
  assert.ok(w.some((x) => x.includes('有1个地点没写地图上的位置')), w.join('\n'));
  assert.ok(w.some((x) => x.includes('几乎叠在一起')), w.join('\n'));
  // 一个位置都不写的也行（按路程自动摆），不提醒
  const none = fixture();
  for (const l of none.locations) {
    delete l.x;
    delete l.y;
  }
  assert.deepEqual(validateScenario(none).warnings, []);
});

test('自带剧本：每个地点都摆好了位置，没有挤在一起的；该藏的暗门、暗道标了 hidden；发给主持 AI 的剧本里不带位置', () => {
  const expected: Record<string, string[]> = {
    'mengzhu-ling.json': ['pavilion→vault', 'kitchen→back-path'],
    'dungeon-sunken-fort.json': ['hall→secret-room', 'water-prison→secret-room'],
    'dungeon-general-tomb.json': ['armory→workshop', 'waterworks→main-chamber', 'main-chamber→waterworks'],
    'dungeon-demon-tower.json': ['flooded-hall→crypt'],
  };
  for (const file of fs.readdirSync(path.join(ROOT, 'scenarios'))) {
    const s = valid(builtin(file));
    assert.ok(s.locations.every((l) => typeof l.x === 'number' && typeof l.y === 'number'), `${file} 有地点没摆位置`);
    const hidden = s.locations.flatMap((l) => l.exits.filter((e) => e.hidden).map((e) => `${l.key}→${e.to}`));
    assert.deepEqual(hidden.sort(), (expected[file] ?? []).sort(), file);
    // 暗道的另一头：要么也是暗的，要么是从里面推得开的门；从开局的地点都走得到
    const block = scenarioBlock(s);
    assert.ok(!/"x":/.test(block) && !/"y":/.test(block), `${file}：发给主持 AI 的剧本里不带位置`);
  }
  const s = valid(builtin('mengzhu-ling.json'));
  assert.ok(scenarioBlock(s).includes('"hidden":true'), '暗道照样告诉主持 AI');
});

test('剧本编辑器：别的地点都摆好了位置时，新加的地点放在离别的地点最远的空地方；没摆的照旧不写', () => {
  const doc = { locations: [{ key: 'a', x: 10, y: 10 }, { key: 'b', x: 90, y: 90 }] };
  const loc = newLocation(doc);
  assert.equal(loc.key, 'place-1');
  assert.ok(typeof loc.x === 'number' && typeof loc.y === 'number');
  assert.ok(Math.min(Math.hypot((loc.x as number) - 10, (loc.y as number) - 10), Math.hypot((loc.x as number) - 90, (loc.y as number) - 90)) >= 50);
  assert.equal('x' in newLocation({ locations: [{ key: 'a', x: 10, y: 10 }, { key: 'b' }] }), false);
  assert.equal('x' in newLocation({ locations: [] }), false);
});

test('AI 生成剧本：输出格式里每个地点要写 x、y，出口要写 hidden；提示词讲了怎么摆', () => {
  const loc = (SCENARIO_SCHEMA as any).properties.locations.items;
  assert.ok(loc.required.includes('x') && loc.required.includes('y'));
  assert.ok(loc.properties.exits.items.required.includes('hidden'));
  assert.equal(loc.properties.exits.items.properties.hidden.type, 'boolean');
  assert.ok(SCENARIO_WRITER_SYSTEM.includes('每个地点写 x、y') && SCENARIO_WRITER_SYSTEM.includes('hidden: true'));
});

// ---------- 移动 ----------

test('移动：按最快的路线走，路过的地方算去过；时间不够只走到半路（或者还在原地）；赶路减半；同一次结算里的路程加起来算', () => {
  const s = secretInn();
  const a = character(1, 'lobby');
  const b = character(2, 'kitchen');
  let ctx = context(s, [a, b], { minutes: 30 });
  let r = run(ctx, 'move_character', { character: 1, location: 'cellar' });
  assert.equal(r.data.location, '地窖');
  assert.equal(r.data.route, '大堂 → 后厨和后院 → 地窖');
  assert.deepEqual(r.data.travel, { minutes: 2 });
  assert.deepEqual(r.data.passed_by, [{ place: '后厨和后院', people: ['角色2'] }], '路过的地方有谁');
  assert.deepEqual(ctx.characters.get(1)!.visited, ['lobby', 'kitchen', 'cellar']);
  assert.deepEqual(ctx.changes, [{ characterId: 1, text: '来到：地窖（路过后厨和后院）' }]);

  // 去当铺要 7 分钟，只有 5 分钟：走到街道为止
  ctx = context(s, [character(1, 'lobby')], { minutes: 5 });
  r = run(ctx, 'move_character', { character: 1, location: 'pawnshop' });
  assert.equal(r.data.arrived, false);
  assert.equal(r.data.stopped_at, '镇上街道');
  assert.equal(r.data.still_need_minutes, 5);
  assert.match(r.data.note, /只够走到「镇上街道」/);
  assert.equal(ctx.characters.get(1)!.location, 'street');
  // 剩下 3 分钟：再往回走 2 分钟够，再去当铺不够
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'lobby' }).data.location, '大堂');
  r = run(ctx, 'move_character', { character: 1, location: 'street' });
  assert.equal(r.data.arrived, false);
  assert.equal(r.data.location, '大堂');
  assert.match(r.data.note, /时间不够走到下一个地方/);
  assert.equal(ctx.characters.get(1)!.location, 'lobby');

  // 赶路：每一段减半（2→1、5→3），4 分钟就到
  ctx = context(s, [character(1, 'lobby')], { minutes: 4 });
  r = run(ctx, 'move_character', { character: 1, location: 'pawnshop', hurry: true });
  assert.equal(r.data.location, '钱记当铺');
  assert.deepEqual(r.data.travel, { minutes: 4, hurry: true });
  // 没给时间（老的调用方式）：不限
  ctx = context(s, [character(1, 'lobby')]);
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'pier' }).data.location, '码头');
});

test('移动：地图上没有路的要写怎么去的（不算路上的时间）；本来就在那里；死了的走不了', () => {
  const s = secretInn();
  const ctx = context(s, [character(1, 'lobby'), character(2, 'lobby', { dead: true })], { minutes: 10 });
  const no = run(ctx, 'move_character', { character: 1, location: 'island' });
  assert.equal(no.isError, true);
  assert.match(no.content, /地图上没有路/);
  assert.equal(ctx.characters.get(1)!.location, 'lobby');
  const ok = run(ctx, 'move_character', { character: 1, location: 'island', via: '搭渔船过去' });
  assert.equal(ok.data.location, '小岛');
  assert.equal(ok.data.via, '搭渔船过去');
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'island' }).data.note, '本来就在这里');
  assert.equal(run(ctx, 'move_character', { character: 2, location: 'kitchen' }).isError, true);
});

test('暗道：没发现的不走；主持人揭开（reveal_exit）以后走得通；走不到别处的从暗道走过去也算发现；合作的剧本里队友发现的也算', () => {
  const s = secretInn();
  let ctx = context(s, [character(1, 'cellar')]);
  let r = run(ctx, 'move_character', { character: 1, location: 'pier' });
  assert.equal(r.data.route, '地窖 → 后厨和后院 → 码头', '暗道还没发现：绕后厨');
  ctx = context(s, [character(1, 'cellar'), character(2, 'cellar')]);
  const bad = run(ctx, 'reveal_exit', { from: 'cellar', to: 'kitchen', characters: [1] });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /没有暗道/);
  r = run(ctx, 'reveal_exit', { from: 'pier', to: 'cellar', characters: [1, 2] });
  assert.deepEqual(r.data.found_by, ['角色1', '角色2']);
  assert.deepEqual(ctx.changes.map((c) => c.text), ['发现了暗道：码头 ↔ 地窖', '发现了暗道：码头 ↔ 地窖']);
  assert.deepEqual(run(ctx, 'reveal_exit', { from: 'cellar', to: 'pier', characters: [1] }).data.already_known, ['角色1']);
  r = run(ctx, 'move_character', { character: 1, location: 'pier' });
  assert.equal(r.data.route, '地窖 → 码头');
  assert.equal(r.data.secret_passage, undefined, '已经知道的暗道不算新发现');
  assert.deepEqual([...exitsFoundBy(ctx.world, 1)], [pathKey('cellar', 'pier')]);

  // 密室只有暗门进得去：直接走过去就是发现了
  ctx = context(s, [character(1, 'cellar')]);
  r = run(ctx, 'move_character', { character: 1, location: 'vault' });
  assert.equal(r.data.location, '密室');
  assert.deepEqual(r.data.secret_passage, ['地窖 → 密室']);
  assert.ok(exitsFoundBy(ctx.world, 1).has(pathKey('cellar', 'vault')));
  assert.equal(ctx.worldChanged, true);
  // 从密室那边（明门）走出来：也就知道了地窖那边的暗门，回去走得通
  ctx = context(s, [character(1, 'vault')]);
  run(ctx, 'move_character', { character: 1, location: 'cellar' });
  assert.ok(exitsFoundBy(ctx.world, 1).has(pathKey('cellar', 'vault')));
  assert.equal(ctx.changes.length, 1, '不另外说发现了暗道');

  // 合作的剧本：队友发现的暗道，自己也走得通；别的剧本不行
  const world = { ...emptyWorld(), exitsFound: { '2': [pathKey('cellar', 'pier')] } };
  ctx = context({ ...s, relation: 'coop' }, [character(1, 'cellar'), character(2, 'lobby')], { world });
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'pier' }).data.route, '地窖 → 码头');
  ctx = context({ ...s, relation: 'secrets' }, [character(1, 'cellar'), character(2, 'lobby')], { world });
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'pier' }).data.route, '地窖 → 后厨和后院 → 码头');
});

test('复查补的：写了 via 的不走暗道（也不算发现）；赶路按赶路的时间找路线；留在原地的人看见他真走的那条路', () => {
  const s = secretInn();
  let ctx = context(s, [character(1, 'lobby')], { minutes: 1 });
  const r = run(ctx, 'move_character', { character: 1, location: 'vault', via: '被人蒙着眼拖进去' });
  assert.equal(r.data.location, '密室');
  assert.equal(r.data.secret_passage, undefined);
  assert.equal(exitsFoundBy(ctx.world, 1).size, 0, 'via 的去法不算发现了暗道');
  // 一段段都是 1 分钟的路，赶路也快不了：赶路时走 4 分钟的直路（赶路 2 分钟）
  const chain: Scenario = valid({
    ...fixture(),
    locations: [
      ...fixture().locations,
      { key: 'a', name: '甲', description: '甲。', exits: [{ to: 'b', minutes: 1 }, { to: 'd', minutes: 4 }], features: [], x: 70, y: 80 },
      { key: 'b', name: '乙', description: '乙。', exits: [{ to: 'c', minutes: 1 }], features: [], x: 75, y: 90 },
      { key: 'c', name: '丙', description: '丙。', exits: [{ to: 'd', minutes: 1 }], features: [], x: 85, y: 90 },
      { key: 'd', name: '丁', description: '丁。', exits: [{ to: 'a', minutes: 4 }], features: [], x: 95, y: 80 },
    ],
  });
  ctx = context(chain, [character(1, 'a')], { minutes: 2 });
  let m = run(ctx, 'move_character', { character: 1, location: 'd', hurry: true });
  assert.equal(m.data.location, '丁');
  assert.equal(m.data.route, '甲 → 丁');
  assert.deepEqual(m.data.travel, { minutes: 2, hurry: true });
  ctx = context(chain, [character(1, 'a')], { minutes: 10 });
  assert.equal(run(ctx, 'move_character', { character: 1, location: 'd' }).data.route, '甲 → 乙 → 丙 → 丁', '不赶路的按平常的时间找');

  // 留在原地的人：看见他走的第一段（发现了暗道、从暗道走的，看不出往哪去了）
  const world = { ...emptyWorld(), exitsFound: { '1': [pathKey('cellar', 'pier')] } };
  ctx = context(s, [character(1, 'cellar'), character(2, 'cellar')], { world });
  run(ctx, 'move_character', { character: 1, location: 'pier' });
  assert.deepEqual(ctx.leftBehind(), { ids: [2], from: '地窖', to: null, far: false });
  ctx = context(s, [character(1, 'cellar'), character(2, 'cellar')]);
  run(ctx, 'move_character', { character: 1, location: 'pier' });
  assert.deepEqual(ctx.leftBehind(), { ids: [2], from: '地窖', to: '后厨和后院', far: true });
});

test('复查补的：没写位置的剧本，暗道是近路的不把两头拉到一起（只有暗门进得去的照样摆在门边）', () => {
  // 一条长路：甲—乙—丙—丁—戊—己，每段 10 分钟；甲和己之间有一条 1 分钟的暗道
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const chain: MapPlace[] = keys.map((k, i) => ({
    key: k,
    name: k,
    exits: [
      ...(i > 0 ? [{ to: keys[i - 1], minutes: 10 }] : []),
      ...(i < keys.length - 1 ? [{ to: keys[i + 1], minutes: 10 }] : []),
      ...(k === 'a' ? [{ to: 'f', minutes: 1, hidden: true }] : k === 'f' ? [{ to: 'a', minutes: 1, hidden: true }] : []),
    ],
  }));
  const pos = layoutPlaces(chain);
  const far = Math.hypot(pos.a.x - pos.f.x, pos.a.y - pos.f.y);
  const near = Math.hypot(pos.a.x - pos.b.x, pos.a.y - pos.b.y);
  assert.ok(far > near * 2, `暗道的两头摆得远：${far.toFixed(1)} 对 ${near.toFixed(1)}`);
  // 只有暗门进得去的密室：摆在门边，不扔到老远
  const room: MapPlace[] = [...chain.map((p) => (p.key === 'c' ? { ...p, exits: [...p.exits, { to: 'vault', minutes: 1, hidden: true }] } : p)), { key: 'vault', name: '密室', exits: [{ to: 'c', minutes: 1 }] }];
  const p2 = layoutPlaces(room);
  const toDoor = Math.hypot(p2.vault.x - p2.c.x, p2.vault.y - p2.c.y);
  const toEnd = Math.hypot(p2.vault.x - p2.f.x, p2.vault.y - p2.f.y);
  assert.ok(toDoor < toEnd, '密室挨着门');
});

test('动静（noise）：路程在 reach_minutes 以内、不在现场的活着的角色收到一句；声音传得过暗门；可以换个地点', () => {
  const s = secretInn();
  const people = [
    character(1, 'lobby'),
    character(2, 'kitchen'),
    character(3, 'pier'),
    character(4, 'pawnshop'),
    character(5, 'lobby'),
    character(6, 'kitchen', { dead: true }),
  ];
  let ctx = context(s, people);
  let r = run(ctx, 'noise', { text: '大堂里传来一声枪响。', reach_minutes: 5 });
  assert.deepEqual(r.data.heard_by, ['角色2（在后厨和后院）', '角色3（在码头）'], '码头走暗道只要 5 分钟；当铺 7 分钟听不到；同在大堂的、死了的不发');
  assert.equal(ctx.privateMessages.length, 0, '结算做完才定谁收到');
  ctx.settleNoise(ctx.audience());
  assert.deepEqual(ctx.privateMessages.map((m) => m.characterId), [2, 3]);
  ctx = context(s, people);
  r = run(ctx, 'noise', { text: '当铺那边有人喊救命。', reach_minutes: 5, location: 'pawnshop' });
  assert.deepEqual(r.data.heard_by, ['角色4（在钱记当铺）']);
  // 开了枪再走开：留在大堂的人看不到这次的叙述，单独收到枪声；跟到了后厨的人从叙述里知道，不另外发
  ctx = context(s, [character(1, 'lobby'), character(2, 'lobby'), character(3, 'kitchen')]);
  run(ctx, 'noise', { text: '一声枪响。', reach_minutes: 5 });
  run(ctx, 'move_character', { character: 1, location: 'kitchen' });
  ctx.settleNoise(ctx.audience());
  assert.deepEqual(ctx.privateMessages.map((m) => m.characterId), [2]);
  // 声音两头都传：只能往下跳的坑，坑底喊一声崖顶也听得到
  const pit = valid({
    ...fixture(),
    locations: [
      ...fixture().locations,
      { key: 'cliff', name: '崖顶', description: '崖顶。', exits: [{ to: 'pit', minutes: 1 }], features: [], x: 90, y: 80 },
      { key: 'pit', name: '坑底', description: '坑底。', exits: [], features: [], x: 90, y: 95 },
    ],
  });
  ctx = context(pit, [character(1, 'pit'), character(2, 'cliff')]);
  assert.deepEqual(run(ctx, 'noise', { text: '坑底有人喊救命。', reach_minutes: 2 }).data.heard_by, ['角色2（在崖顶）']);
  assert.equal(run(ctx, 'noise', { text: '', reach_minutes: 5 }).isError, true);
  assert.equal(run(ctx, 'noise', { text: '响声', reach_minutes: 'far' }).isError, true);
  assert.equal(run(ctx, 'noise', { text: '响声', reach_minutes: 5, location: 'moon' }).isError, true);
});

// ---------- 主持人、计时员看到的路程 ----------

test('主持规则有「地图和路程」；主持人看到从这里到各处的路程（key、经过哪里、还没发现的暗道）；计时员只看到走得通的地方和分钟；场外问答不列没发现的暗道', () => {
  for (const rules of [DM_RULES, DM_RULES_V2, DM_RULES_5E]) {
    assert.ok(rules.includes('# 地图和路程') && rules.includes('reveal_exit') && rules.includes('noise') && rules.includes('hurry'));
  }
  const s = secretInn();
  const me = character(1, 'kitchen');
  const dm = routeLines(s, emptyWorld(), [me], me);
  assert.match(dm, /码头（pier）8 分钟（赶路 4 分钟），走还没发现的暗道只要4 分钟/);
  assert.match(dm, /密室（vault）要走还没发现的暗道，3 分钟/);
  assert.match(dm, /小岛（island）地图上没有路/);
  assert.match(dm, /钱记当铺（pawnshop）8 分钟（赶路 5 分钟），经过大堂、镇上街道/);
  const context = buildDmContext({
    scenario: s,
    world: emptyWorld(),
    characters: [me],
    clues: [],
    actor: me,
    action: { content: '去码头', gameStart: 1320, minutes: 10, secret: false },
    pending: [],
    recent: [],
  } as any);
  assert.ok(context.includes(`从这里到各处的路程（最快的路）：${dm}`));

  // 计时员：只有他自己的地图上的地方（估时的说明玩家看得到）
  const routesOf = (who: Character, world: World = emptyWorld()) => knownRoutesText(mapViewOf(s, world, [who], { me: who, full: false }), who.location);
  const est = buildEstimateContext(s, me, '去码头看看', [], routesOf(me));
  assert.match(est, /从这里到各处的路程：大堂 1 分钟（赶路 1 分钟）；地窖 1 分钟（赶路 1 分钟）；码头 8 分钟（赶路 4 分钟）\n/);
  assert.ok(!est.includes('账房') && !est.includes('密室') && !est.includes('小岛') && !est.includes('pier'), '没去过、看不到的地方不给');
  const known = character(1, 'kitchen', { visited: ['kitchen', 'cellar'] });
  const found = { ...emptyWorld(), exitsFound: { '1': [pathKey('cellar', 'pier')] } };
  assert.match(buildEstimateContext(s, known, '去码头', [], routesOf(known)), /码头 8 分钟/);
  assert.match(buildEstimateContext(s, known, '去码头', [], routesOf(known, found)), /码头 4 分钟/, '发现了的暗道算');

  // 场外问答：从这里能去的不列没发现的暗道；他的地图上从这里到各处的路程
  const inCellar = character(1, 'cellar', { visited: ['lobby', 'kitchen', 'cellar'] });
  const view = mapViewOf(s, emptyWorld(), [inCellar], { me: inCellar, full: false });
  const answer = buildAnswerContext({ scenario: s, me: inCellar, clues: [], recent: [], gameTime: 1320, question: '码头怎么走？', knownExits: new Set(), routes: knownRoutesText(view, 'cellar', { path: true }) });
  assert.match(answer, /从这里能去：后厨和后院（1分钟）\n/);
  assert.match(answer, /从这里到地图上各处的路程：.*码头 9 分钟（赶路 5 分钟，经过后厨和后院）/);
});

test('假主持人估时：要去的地方按路程表算（赶路减半），睡觉、搜查照旧', () => {
  const s = secretInn();
  const me = character(1, 'lobby', { visited: ['lobby', 'street'] });
  const routes = knownRoutesText(mapViewOf(s, emptyWorld(), [me], { me, full: false }), 'lobby');
  const estimate = (content: string) => {
    const res = demoHandler({
      model: 'x',
      max_tokens: 100,
      system: [{ type: 'text', text: '计时员' }],
      messages: [{ role: 'user', content: buildEstimateContext(s, me, content, [], routes) }],
      output_config: { format: { type: 'json_schema', schema: {} } },
    } as any);
    return JSON.parse((res.content[0] as any).text).minutes;
  };
  assert.equal(estimate('前往「钱记当铺」'), 12);
  assert.equal(estimate('测试赶路去钱记当铺'), 9);
  assert.equal(estimate('睡一觉'), 480);
});

// ---------- 网页上的地图 ----------

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';
before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
});
after(async () => {
  await t.close();
});
const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);

/** 两个人的局：《雾港旅店》（data 换成改过的剧本），记者在大堂、侦探在二楼客房。 */
async function twoPlayerRoom(data?: Record<string, unknown>) {
  const room = (await as(t1)('POST', '/api/rooms', { name: '地图局', maxPlayers: 3 })).data.room;
  assert.equal((await as(t2)('POST', '/api/rooms/join', { code: room.joinCode })).status, 200);
  const chosen = await as(t1)('POST', `/api/rooms/${room.id}/scenario`, data ? { data } : { key: 'fog-harbor-inn' });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'reporter', name: '林小满' })).status, 200);
  assert.equal((await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'detective', name: '沈探' })).status, 200);
  const game = (await as(t1)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.map, null, '开局之前没有地图');
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  const ids = t.app.db.prepare('SELECT c.id, p.user_id FROM characters c JOIN players p ON p.id = c.player_id WHERE c.room_id = ? ORDER BY c.id').all(room.id) as { id: number; user_id: number }[];
  return { roomId: room.id as number, reporter: ids[0].id, detective: ids[1].id };
}
const place = (id: number, location: string, visited: string[]) =>
  t.app.db.prepare('UPDATE characters SET location = ?, visited = ? WHERE id = ?').run(location, JSON.stringify(visited), id);
const mapOf = async (cookie: string, roomId: number) => (await as(cookie)('GET', `/api/rooms/${roomId}/game`)).data.map;

test('地图页签：各有秘密的剧本里只看得到自己去过的、看得见的地方，和在同一个地点的人；自己找到的线索标在出自的地点；位置照剧本写的', async () => {
  const { roomId, reporter } = await twoPlayerRoom();
  let map = await mapOf(t1, roomId);
  assert.equal(map.full, false);
  assert.deepEqual(map.nodes.map((n: any) => n.key).sort(), ['guest-rooms', 'kitchen', 'ledger-room', 'lobby', 'street']);
  const lobby = map.nodes.find((n: any) => n.key === 'lobby');
  assert.deepEqual({ x: lobby.x, y: lobby.y, here: lobby.here, visited: lobby.visited }, { x: 50, y: 54, here: true, visited: true });
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'guest-rooms').people, [], '侦探在客房，记者看不到他');
  assert.deepEqual(map.bounds, { minX: 16, minY: 18, maxX: 86, maxY: 72 }, '范围按整张地图算');
  // 侦探到大堂来：同一个地点看得到
  const detectiveId = (t.app.db.prepare("SELECT id FROM characters WHERE room_id = ? AND role_key = 'detective'").get(roomId) as { id: number }).id;
  place(detectiveId, 'lobby', ['guest-rooms', 'lobby']);
  map = await mapOf(t1, roomId);
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'lobby').people, ['沈探']);
  // 记者去过后厨：码头、地窖看得到；拿到的线索标在出自的地点
  place(reporter, 'kitchen', ['lobby', 'kitchen']);
  const clueId = t.app.db.prepare("INSERT INTO clues (room_id, clue_key, found_by_character_id, found_game_time, created_at) VALUES (?, 'witness', ?, 0, 0)").run(roomId, reporter).lastInsertRowid;
  t.app.db.prepare("INSERT INTO knowledge (room_id, content_type, content_id, character_id, game_time, created_at) VALUES (?, 'clue', ?, ?, 0, 0)").run(roomId, clueId, reporter);
  map = await mapOf(t1, roomId);
  assert.ok(map.nodes.some((n: any) => n.key === 'pier') && map.nodes.some((n: any) => n.key === 'cellar'));
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'kitchen').clues, ['阿福看见的人']);
  assert.ok(!map.edges.some((e: any) => e.a === 'pier' && e.b === 'street'), '码头和街道都没去过：它们之间的路看不到');
  // 角色卡上的「从这里能去」
  const me = (await as(t1)('GET', `/api/rooms/${roomId}/game`)).data.me;
  assert.deepEqual(me.location.exits.map((e: any) => e.key).sort(), ['cellar', 'lobby', 'pier']);
});

test('地图页签：合作的剧本里一队人的地图是共享的（去过的地方、发现的暗道、队友在哪）；暗道没发现时「从这里能去」里没有', async () => {
  const data = fixture();
  data.relation = 'coop';
  data.locations.find((l: any) => l.key === 'cellar').exits.push({ to: 'pier', minutes: 3, hidden: true });
  data.locations.find((l: any) => l.key === 'pier').exits.push({ to: 'cellar', minutes: 3, hidden: true });
  const { roomId, reporter, detective } = await twoPlayerRoom(data);
  place(detective, 'cellar', ['guest-rooms', 'lobby', 'kitchen', 'cellar']);
  let map = await mapOf(t1, roomId);
  assert.ok(map.nodes.some((n: any) => n.key === 'cellar' && n.visited && n.people.includes('沈探')), '队友去过的地方、在哪都看得到');
  assert.ok(!map.edges.some((e: any) => e.hidden));
  let det = (await as(t2)('GET', `/api/rooms/${roomId}/game`)).data.me;
  assert.deepEqual(det.location.exits.map((e: any) => e.key), ['kitchen']);
  // 侦探发现了暗道：两个人的地图上都有；侦探的「从这里能去」也有
  t.app.db.prepare('UPDATE rooms SET world = ? WHERE id = ?').run(JSON.stringify({ exitsFound: { [String(detective)]: [pathKey('cellar', 'pier')] } }), roomId);
  map = await mapOf(t1, roomId);
  assert.ok(map.edges.some((e: any) => e.hidden && pathKey(e.a, e.b) === pathKey('cellar', 'pier')));
  det = (await as(t2)('GET', `/api/rooms/${roomId}/game`)).data.me;
  assert.deepEqual(det.location.exits.map((e: any) => e.key).sort(), ['kitchen', 'pier']);
  assert.ok(reporter > 0);
});

test('地图页签：结束以后看整张（暗道也标出来、大家最后在哪）；不在这一局里玩的管理员看整张、还标着 NPC；管理页也有整张地图', async () => {
  const data = fixture();
  data.locations.find((l: any) => l.key === 'cellar').exits.push({ to: 'pier', minutes: 3, hidden: true });
  const { roomId } = await twoPlayerRoom(data);
  // 管理员没加入：整张，带 NPC
  let map = await mapOf(admin, roomId);
  assert.equal(map.full, true);
  assert.equal(map.nodes.length, 8);
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'pawnshop').npcs, ['钱掌柜']);
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'lobby').people, ['林小满']);
  assert.ok(map.edges.some((e: any) => e.hidden));
  const detail = (await as(admin)('GET', `/api/admin/rooms/${roomId}`)).data;
  assert.equal(detail.map.full, true);
  assert.deepEqual(detail.map.nodes.find((n: any) => n.key === 'pier').npcs, ['老马']);
  // 玩家：还没结束只看得到自己的；结束以后整张，但不标 NPC
  assert.equal((await mapOf(t1, roomId)).full, false);
  assert.equal((await as(t1)('POST', `/api/rooms/${roomId}/status`, { status: 'ended' })).status, 200);
  map = await mapOf(t1, roomId);
  assert.equal(map.full, true);
  assert.equal(map.nodes.length, 8);
  assert.equal(map.nodes[0].npcs, undefined);
  assert.deepEqual(map.nodes.find((n: any) => n.key === 'guest-rooms').people, ['沈探']);
});

test('以前开的局：自带剧本存下来的那份没有地图上的位置，启动时照现在的剧本文件补上（地点对不上的不补，暗道不补）', async () => {
  const room = (await as(t1)('POST', '/api/rooms', { name: '老局', maxPlayers: 4, scenarioKey: 'mengzhu-ling' })).data.room;
  const other = (await as(t1)('POST', '/api/rooms', { name: '改过的老局', maxPlayers: 2, scenarioKey: 'qingxi-lantern-night' })).data.room;
  const strip = (roomId: number, rename = false) => {
    const data = JSON.parse((t.app.db.prepare('SELECT data FROM scenarios WHERE room_id = ?').get(roomId) as { data: string }).data);
    for (const l of data.locations) {
      delete l.x;
      delete l.y;
      for (const e of l.exits) delete e.hidden;
    }
    if (rename) data.locations[0].key = 'renamed-place';
    t.app.db.prepare('UPDATE scenarios SET data = ? WHERE room_id = ?').run(JSON.stringify(data), roomId);
  };
  strip(room.id);
  strip(other.id, true);
  t.app.engine.fillBuiltinMapPositions();
  const after = (roomId: number) => JSON.parse((t.app.db.prepare('SELECT data FROM scenarios WHERE room_id = ?').get(roomId) as { data: string }).data);
  const fixed = after(room.id);
  const file = builtin('mengzhu-ling.json');
  assert.deepEqual(
    fixed.locations.map((l: any) => [l.key, l.x, l.y]),
    file.locations.map((l: any) => [l.key, l.x, l.y]),
  );
  assert.ok(!JSON.stringify(fixed).includes('"hidden"'), '暗道不补');
  assert.ok(after(other.id).locations.every((l: any) => l.x === undefined), '地点对不上的不补');
});
