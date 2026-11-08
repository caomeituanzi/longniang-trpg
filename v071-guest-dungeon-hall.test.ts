// 时间按东京算
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

// V0.7.1：地下城从剧本大厅里单独拿出来（「地下城」页，和剧本大厅并列）；
// 游客能打开顶栏的每一页看看（我的对局、宠物、装扮、图鉴、社交、地下城……都是空的），要正式账号的事照样做不了；
// 游客在网页上点「注册」注册正式账号，原来的游客账号删掉。

const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';
let t2 = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler) });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const newGuest = async () => (await t.call('POST', '/api/auth/guest')).cookie!;
const publicId = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;

type Listed = {
  key: string;
  title: string;
  intro: string;
  category: string | null;
  players: { min: number; max: number };
  dungeon: { level: number; size: 'small' | 'large' } | null;
  authorUser: { displayName: string; self: boolean } | null;
  rating: { average: number | null; count: number };
};
type Dungeon = Listed & {
  records: { recent: { players: string[]; realMinutes: number }[]; fastest: { players: string[]; realMinutes: number } | null };
};

/** 对答案用：剧本文件夹里分区是地下城的剧本，按难度、小型在前排好。 */
function dungeonFiles(): string[] {
  const dir = t.app.engine.scenarioFolder;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ key: f.slice(0, -'.json'.length), s: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    .filter(({ s }) => s.category === 'dungeon')
    .sort((a, b) => a.s.dungeon.level - b.s.dungeon.level || (a.s.dungeon.size === 'large' ? 1 : 0) - (b.s.dungeon.size === 'large' ? 1 : 0))
    .map(({ key }) => key);
}

const dungeonHall = async (cookie: string) => (await as(cookie)('GET', '/api/dungeon-hall')).data.dungeons as Dungeon[];
const scenarioHall = async (cookie: string) => (await as(cookie)('GET', '/api/scenario-hall')).data.scenarios as Listed[];

// ==================== 地下城页 ====================

test('地下城页：只列分区是地下城的剧本，按难度排，带着简介、人数、通关记录；剧本大厅里没有地下城了', async () => {
  const dungeons = await dungeonHall(t1);
  assert.ok(dungeons.length >= 5, '自带五个地下城');
  assert.deepEqual(
    dungeons.map((d) => d.key),
    dungeonFiles(),
  );
  assert.ok(dungeons.every((d) => d.category === 'dungeon' && d.dungeon !== null));
  const levels = dungeons.map((d) => d.dungeon!.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), '按难度从低到高');
  const mine = dungeons[0];
  assert.equal(mine.key, 'dungeon-abandoned-mine');
  assert.deepEqual([mine.title, mine.dungeon, mine.players], ['废矿夜灯', { level: 1, size: 'small' }, { min: 1, max: 2 }]);
  assert.ok(mine.intro.length > 0);
  assert.deepEqual(mine.rating, { average: null, count: 0 });
  assert.deepEqual(mine.records, { recent: [], fastest: null });

  // 剧本大厅：别的五个分区（还有没写分区的老剧本，测试剧本《雾港旅店》就是），一个地下城也没有；
  // 5E 模组 V1.0.0 起在「模组」页；三边加起来是全部能用的剧本
  const hall = await scenarioHall(t1);
  assert.ok(hall.length > 0);
  assert.ok(!hall.some((s) => s.category === 'dungeon' || s.dungeon !== null));
  assert.deepEqual([...new Set(hall.flatMap((s) => (s.category ? [s.category] : [])))].sort(), ['adventure', 'combat', 'horror', 'puzzle', 'social']);
  const modules = (await as(t1)('GET', '/api/module-hall')).data.modules as Listed[];
  assert.ok(modules.length > 0);
  assert.deepEqual(
    [...hall, ...dungeons, ...modules].map((s) => s.key).sort(),
    t.app.works
      .listedScenarios()
      .map((s) => s.key)
      .sort(),
  );

  // 排行、图鉴里地下城照旧算
  assert.equal((await as(t1)('GET', '/api/rankings/works?category=dungeon')).status, 200);
  assert.ok((await as(t1)('GET', '/api/collection')).data.endings.some((e: { key: string }) => e.key === 'dungeon-abandoned-mine'));

  // 通关记录：只算通关的，最快的一次、最近的几次
  const run = t.app.db.prepare(
    `INSERT INTO dungeon_runs (room_id, room_created_at, scenario_key, scenario_title, level, size, result, players, members, real_minutes, game_minutes, created_at)
     VALUES (?, 1, 'dungeon-abandoned-mine', '废矿夜灯', 1, 'small', ?, 1, ?, ?, 60, ?)`,
  );
  run.run(9001, 'clear', JSON.stringify([{ name: '阿猎' }]), 95, Date.now() - 1000);
  run.run(9002, 'clear', JSON.stringify([{ name: '慧明' }]), 42, Date.now());
  run.run(9003, 'escape', JSON.stringify([{ name: '逃兵' }]), 5, Date.now());
  const guest = await newGuest();
  const records = (await dungeonHall(guest)).find((d) => d.key === 'dungeon-abandoned-mine')!.records;
  assert.deepEqual(records.fastest && [records.fastest.players, records.fastest.realMinutes], [['慧明'], 42]);
  assert.deepEqual(
    records.recent.map((r) => r.players[0]),
    ['慧明', '阿猎'],
  );
});

/** 一个最小的地下城（导入、投稿用）：小型，两种真相，首领两个弱点。 */
function homemadeDungeon(level: number): Record<string, unknown> {
  return {
    format: 'longniang-trpg/scenario@1',
    title: '自家地窖',
    category: 'dungeon',
    rules: 2,
    intro: '村口老宅的地窖里闹鼠患，进去清干净就行。',
    author: '测试玩家一',
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
      level,
      size: 'small',
      exit: 'entrance',
      enemies: [
        { key: 'rat', name: '大老鼠', tier: 'minion', description: '猫一样大的老鼠', abilities: ['一拥而上'] },
        { key: 'rat-king', name: '鼠王', tier: 'boss', description: '几只老鼠尾巴缠在一起', abilities: ['尖啸：所有人精神值 -2'] },
      ],
      encounters: [{ key: 'pack', title: '鼠群', enemies: [{ enemy: 'rat', count: 2 }], places: ['cellar'], trigger: '走进去就遇上' }],
      loot: [
        { key: 'potions', places: ['cellar'], how: '酒坛后面的箱子', reward: { kind: 'item', item: 'potion', count: 2 } },
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

/** tester1、tester2 收到的某一种通知（这个剧本的）。 */
async function notes(cookie: string, kind: string, key: string) {
  const items = (await as(cookie)('GET', '/api/notifications')).data.items as { kind: string; data: { category?: string | null; key?: string } }[];
  return items.filter((n) => n.kind === kind && n.data.key === key);
}

test('用户的地下城（作者是用户的）：在地下城页，带着作者、按难度排，不在剧本大厅；给作者反馈的回复通知里写着分区', async () => {
  // 投稿通过的样子：剧本文件夹里有这个文件，作者记在 scenario_authors 里
  const key = 'sub-test-cellar';
  fs.writeFileSync(path.join(t.app.engine.scenarioFolder, `${key}.json`), JSON.stringify(homemadeDungeon(5)));
  t.app.db
    .prepare('INSERT INTO scenario_authors (scenario_key, user_id, submission_id, published_at) VALUES (?, (SELECT id FROM users WHERE username = ?), NULL, ?)')
    .run(key, TESTER1.username, Date.now());

  const dungeons = await dungeonHall(t1);
  const work = dungeons.find((d) => d.key === key)!;
  assert.ok(work, '在地下城页');
  assert.deepEqual([work.title, work.dungeon, work.authorUser?.displayName, work.authorUser?.self], ['自家地窖', { level: 5, size: 'small' }, TESTER1.displayName, true]);
  const levels = dungeons.map((d) => d.dungeon!.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), '用户的地下城也按难度排在中间');
  assert.ok(levels.indexOf(5) > 0 && levels.indexOf(5) < levels.length - 1);
  assert.equal((await dungeonHall(t2)).find((d) => d.key === key)!.authorUser?.self, false);
  assert.ok(!(await scenarioHall(t1)).some((s) => s.key === key), '不在剧本大厅');

  // 给作者的反馈有了回复：通知里写着分区（网页上的按钮去地下城页）。玩过（用它开过局）才能写反馈
  assert.equal((await as(t2)('POST', '/api/rooms', { name: '试试地窖', maxPlayers: 1, scenarioKey: key })).status, 201);
  const r = await as(t2)('POST', `/api/scenario-hall/${key}/feedback`, { text: '鼠王有点难打。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const feedbackId = (t.app.db.prepare('SELECT id FROM scenario_feedback WHERE scenario_key = ?').get(key) as { id: number }).id;
  assert.equal((await as(t1)('PUT', `/api/feedback/${feedbackId}/reply`, { text: '下次调低一点。' })).status, 200);
  assert.equal((await notes(t2, 'feedback_reply', key))[0]?.data.category, 'dungeon');
});

test('投稿通过的通知、关注的作者有新作品的通知里写着分区（地下城的按钮去地下城页）', async () => {
  // tester2 关注 tester1；tester1 导入一份剧本投稿，管理员通过
  assert.equal((await as(t2)('POST', `/api/users/${publicId(TESTER1.username)}/follow`)).status, 200);
  const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
  const room = (await as(t1)('POST', '/api/rooms', { name: '雾港', maxPlayers: 4 })).data.room;
  let r = await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { data: { ...fog, title: '雾港新篇' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await as(t1)('POST', `/api/rooms/${room.id}/submission`, { category: 'adventure', intro: '海边小镇起了大雾，旅店里出了事，你们得在雾散之前查清楚。' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.submission.id as number;
  r = await as(admin)('POST', `/api/admin/submissions/${id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const key = (t.app.db.prepare('SELECT scenario_key FROM scenario_submissions WHERE id = ?').get(id) as { scenario_key: string }).scenario_key;
  assert.equal((await notes(t1, 'submission_result', key))[0]?.data.category, 'adventure');
  assert.equal((await notes(t2, 'new_work', key))[0]?.data.category, 'adventure');
  // 不是地下城：在剧本大厅，不在地下城页
  assert.ok((await scenarioHall(t1)).some((s) => s.key === key));
  assert.ok(!(await dungeonHall(t1)).some((d) => d.key === key));
});

// ==================== 游客：顶栏的每一页都能打开看看 ====================

test('游客：顶栏各页的接口都能看（我的对局、宠物、装扮、商城、图鉴、社交、地下城），都是空的；头像菜单里的我的背包、我的角色照旧打不开', async () => {
  const guest = await newGuest();
  const get = async (url: string) => {
    const r = await as(guest)('GET', url);
    assert.equal(r.status, 200, `${url}：${JSON.stringify(r.data)}`);
    return r.data;
  };
  assert.deepEqual((await get('/api/rooms')).rooms, []);
  const pet = await get('/api/pet');
  assert.deepEqual([pet.pet, pet.games], [null, []]);
  assert.deepEqual((await get('/api/pet/diary')).entries, []);
  const wardrobe = await get('/api/wardrobe');
  assert.deepEqual(
    [wardrobe.frames, wardrobe.dice, wardrobe.titles, wardrobe.outfits, wardrobe.pet, wardrobe.frame, wardrobe.diceSkin, wardrobe.title],
    [[], [], [], [], null, null, null, null],
  );
  // 商城（V0.7.1 另外改的）：游客能看，买不了（见下一个测试）
  await get('/api/shop');
  const book = await get('/api/collection');
  assert.ok(book.endings.length > 0);
  assert.ok(book.endings.every((e: { reached: unknown[] }) => e.reached.length === 0));
  assert.deepEqual([book.places, book.outfits, book.dice, book.achievements], [[], [], [], []]);
  assert.deepEqual(await get('/api/friends'), { friends: [], incoming: [], outgoing: [], blocked: [] });
  assert.deepEqual(await get('/api/follows'), { following: [], followers: 0 });
  assert.deepEqual(await get('/api/groups'), { groups: [] });
  assert.deepEqual(
    (await get('/api/dungeon-hall')).dungeons.map((d: { key: string }) => d.key),
    (await dungeonHall(t1)).map((d) => d.key),
  );
  assert.deepEqual((await get('/api/scenario-hall')).submissions, []);
  // 点开一个地下城的评分和短评（没玩过：不能评，看不到短评）
  const detail = await get('/api/scenario-hall/dungeon-abandoned-mine');
  assert.deepEqual([detail.canRate, detail.comments], [false, null]);
  for (const url of ['/api/bag', '/api/cards', '/api/me/crystals']) {
    assert.equal((await as(guest)('GET', url)).status, 403, url);
  }
});

test('游客：要正式账号的事照样做不了（养宠物、戴装扮、加好友、建群、关注、开局、评分、建卡、买东西……）', async () => {
  const guest = await newGuest();
  const guestId = (await as(guest)('GET', '/api/auth/me')).data.user.id as number;
  for (const [method, url, body] of [
    ['POST', '/api/pet', { name: '小游' }],
    ['PUT', '/api/pet', { description: '介绍' }],
    ['POST', '/api/pet/job', { job: 'courier' }],
    ['POST', '/api/pet/trip', { kind: 'near' }],
    ['POST', '/api/pet/use', { item: 'fish' }],
    ['PUT', '/api/me/frame', { frame: null }],
    ['PUT', '/api/pet/dice', { dice: null }],
    ['PUT', '/api/pet/outfit', { outfit: null }],
    ['PUT', '/api/me/title', { title: null }],
    ['POST', '/api/friends', { username: TESTER1.username }],
    ['POST', '/api/groups', { name: '游客群', members: [publicId(TESTER1.username)] }],
    ['POST', `/api/users/${publicId(TESTER1.username)}/follow`, undefined],
    ['POST', '/api/rooms', { name: '游客的地下城', maxPlayers: 1, scenarioKey: 'dungeon-abandoned-mine' }],
    ['POST', '/api/rooms/join', { code: 'ABCDEF' }],
    ['PUT', '/api/scenario-hall/dungeon-abandoned-mine/rating', { stars: 5, comment: '' }],
    ['POST', '/api/scenario-hall/dungeon-abandoned-mine/feedback', { text: '你好' }],
    ['POST', '/api/cards', { name: '游客的卡' }],
    ['POST', '/api/chests/open', undefined],
    ['POST', '/api/shop/buy', { item: 'fish' }],
  ] as const) {
    const r = await as(guest)(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}：${JSON.stringify(r.data)}`);
  }
  assert.equal(t.app.db.prepare('SELECT 1 FROM pets WHERE user_id = ?').get(guestId), undefined);
  assert.equal(t.app.db.prepare('SELECT 1 FROM rooms WHERE host_user_id = ?').get(guestId), undefined);
  assert.equal(t.app.db.prepare('SELECT 1 FROM follows WHERE follower_id = ?').get(guestId), undefined);
});

test('游客在网页上注册正式账号：原来的游客账号删掉、推送连接断开，新账号登录着；正式账号注册照旧', async () => {
  const guest = await newGuest();
  const guestId = (await as(guest)('GET', '/api/auth/me')).data.user.id as number;
  const stream = await t.openStream('/api/events', guest);
  await stream.waitFor((e) => e.event === 'badges');
  const invite = async () => (await as(admin)('POST', '/api/admin/invites', { note: '游客注册' })).data.invite.code as string;
  const r = await as(guest)('POST', '/api/auth/register', {
    inviteCode: await invite(),
    username: 'from_guest',
    displayName: '游客转正',
    password: 'from-guest-pass-1',
    agreeRules: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.isGuest, false);
  await stream.waitEnded();
  assert.equal(t.app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(guestId), undefined, '游客账号删掉了');
  assert.equal((await as(guest)('GET', '/api/auth/me')).data.user, null, '游客的登录作废了');
  const me = (await as(r.cookie!)('GET', '/api/auth/me')).data.user;
  assert.deepEqual([me.username, me.isGuest], ['from_guest', false]);

  // 没登录的人注册：照旧，不删任何人
  const users = (t.app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const fresh = await t.call('POST', '/api/auth/register', {
    inviteCode: await invite(),
    username: 'plain_newbie',
    displayName: '新来的',
    password: 'plain-newbie-pass-1',
    agreeRules: true,
  });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, users + 1);
});
