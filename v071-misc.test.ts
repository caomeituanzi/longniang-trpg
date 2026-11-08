process.env.TZ = 'Asia/Shanghai';
// V0.7.1：合起来以后补的几处——导入的地下城能投稿、审核通过（投的是原来的整份剧本，不是随机定好的这一局），
// 投稿的分区要和剧本对得上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';
import { validateScenario, type Scenario } from '../server/game/scenario';
import { ResolutionContext } from '../server/game/tools';
import { emptyWorld, type Character } from '../server/game/world';

const [ADMIN, TESTER1] = TEST_ACCOUNTS;
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const readScenario = (file: string) => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', file), 'utf8'));

async function importedRoom(cookie: string, data: Record<string, unknown>, maxPlayers = 2) {
  const room = (await as(cookie)('POST', '/api/rooms', { name: `${data.title}的局`, maxPlayers })).data.room;
  const r = await as(cookie)('POST', `/api/rooms/${room.id}/scenario`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return room.id as number;
}

test('导入的地下城投稿：分区只能是「地下城」，投的是整份原剧本，审核通过放进地下城大厅', async () => {
  const mine = { ...readScenario('dungeon-abandoned-mine.json'), title: '自己写的矿洞' };
  delete mine.author;
  const roomId = await importedRoom(t1, mine);
  // 这一局用的是随机定好的一份：只剩一种变化、一个弱点
  const stored = t.app.db.prepare('SELECT data, original FROM scenarios WHERE room_id = ?').get(roomId) as { data: string; original: string | null };
  assert.ok(stored.original, '原来的整份剧本另外存着');
  assert.equal(JSON.parse(stored.original!).dungeon.variants.length, mine.dungeon.variants.length);
  assert.equal(JSON.parse(stored.data).dungeon.boss.weaknesses.length, 1);

  let r = await as(t1)('POST', `/api/rooms/${roomId}/submission`, { category: 'puzzle', intro: '老银洞里的光' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '这是地下城，分区要选「地下城」');
  r = await as(t1)('POST', `/api/rooms/${roomId}/submission`, { category: 'dungeon', intro: '封了十年的老银洞夜里亮起了光。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.submission.id;
  const full = (await as(admin)('GET', `/api/admin/submissions/${id}`)).data.scenario;
  assert.equal(full.dungeon.variants.length, mine.dungeon.variants.length, '投的是整份：变化一个不少');
  assert.equal(full.dungeon.boss.weaknesses.length, mine.dungeon.boss.weaknesses.length);
  r = await as(admin)('POST', `/api/admin/submissions/${id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const key = r.data.submission?.key ?? (t.app.db.prepare('SELECT scenario_key FROM scenario_submissions WHERE id = ?').get(id) as { scenario_key: string }).scenario_key;
  const hall = (await as(t1)('GET', '/api/dungeon-hall')).data.dungeons.map((s: { key: string }) => s.key);
  assert.ok(hall.includes(key), `通过的地下城在地下城大厅里：${hall.join(',')}`);
  const scenarioHall = (await as(t1)('GET', '/api/scenario-hall')).data.scenarios.map((s: { key: string }) => s.key);
  assert.ok(!scenarioHall.includes(key), '剧本大厅里没有它');
});

test('不是地下城的剧本不能投到「地下城」；升级以前装进来的地下城投不了稿', async () => {
  const qingxi = { ...readScenario('qingxi-lantern-night.json'), title: '自己写的灯会' };
  delete qingxi.author;
  const roomId = await importedRoom(t1, qingxi);
  const r = await as(t1)('POST', `/api/rooms/${roomId}/submission`, { category: 'dungeon', intro: '中秋夜的灯会' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '这不是地下城，不能投到「地下城」');

  // V0.7.0 装进来的地下城：只有随机定好的这一局
  const mine = { ...readScenario('dungeon-abandoned-mine.json'), title: '升级以前的矿洞' };
  delete mine.author;
  const old = await importedRoom(t1, mine);
  t.app.db.prepare('UPDATE scenarios SET original = NULL WHERE room_id = ?').run(old);
  const r2 = await as(t1)('POST', `/api/rooms/${old}/submission`, { category: 'dungeon', intro: '老银洞' });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.error, '这一局的地下城是升级以前装进来的，投不了稿：在新的一局里重新导入以后再投');
});

test('走到别处：留在原地的人只看得见他从哪个出口走的（隔着几个地方的说路上第一站，走不到的不说去哪）', () => {
  const base = validateScenario(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'))).scenario as Scenario;
  // 加一个从大堂的出口走不到的暗室（只有暗室通大堂，大堂没有门通暗室）
  const scenario: Scenario = { ...base, locations: [...base.locations, { ...base.locations[0], key: 'hidden-room', name: '暗室', exits: [{ to: 'lobby', minutes: 5 }] }] };
  const character = (id: number): Character => ({
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
    location: 'lobby',
    visited: ['lobby'],
    dead: false,
    pet: null,
    cardId: null,
    background: '',
    gear: [],
    v2: null,
  });
  const moved = (to: string) => {
    const ctx = new ResolutionContext({ scenario, world: emptyWorld(), characters: [character(1), character(2)], clueHolders: new Map(), actorId: 1, gameEnd: 1400, rng: () => 3 });
    // 地图上没有路的（V1.0.x）要写怎么去的
    assert.equal(ctx.execute('move_character', { character: 1, location: to, ...(to === 'hidden-room' ? { via: '从墙上的暗门钻进去' } : {}) }).isError, false);
    return ctx.leftBehind();
  };
  assert.deepEqual(moved('kitchen'), { ids: [2], from: '大堂', to: '后厨和后院', far: false });
  assert.deepEqual(moved('cellar'), { ids: [2], from: '大堂', to: '后厨和后院', far: true });
  assert.deepEqual(moved('hidden-room'), { ids: [2], from: '大堂', to: null, far: false });
});
