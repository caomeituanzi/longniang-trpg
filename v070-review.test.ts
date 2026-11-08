// 时间按东京算
process.env.TZ = 'Asia/Tokyo';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

// V0.7.0 发布前独立审查找出来、修掉的问题：同一份道具带进两个地下城、撤回结算多扣道具、撤回已经结算的地下城结局、
// 「我的举报」看得到对方撤回的原文、普通管理员撤回站长的群消息、翻聊天记录不记操作记录、屏蔽了还能切磋。

const [OWNER, T1, T2, , , T5] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = new Date(2026, 10, 4, 14, 0, 0).getTime();
let t: Awaited<ReturnType<typeof startTestApp>>;
const cookie: Record<string, string> = {};
const as = (username: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie[username]);
const userId = (username: string) => (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
const pub = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const potions = (username: string) =>
  (t.app.db.prepare("SELECT count FROM pet_items WHERE user_id = ? AND item = 'potion'").get(userId(username)) as { count: number } | undefined)?.count ?? 0;
const SHEET = { attributes: { strength: 2, constitution: 1, agility: 1, intellect: 0, perception: 1, will: 0, charm: -1 }, specialties: ['剑术', '攀爬'] };

/** 一个最小的地下城：一个地点放着一瓶药水，第一个结局是通关。 */
function mini(): Record<string, unknown> {
  return {
    format: 'longniang-trpg/scenario@1',
    title: '审查用的地窖',
    category: 'dungeon',
    rules: 2,
    genre: '奇幻',
    tone: '紧张',
    players: { min: 1, max: 2 },
    expectedDays: 1,
    relation: 'coop',
    stress: false,
    start: { label: '入夜', day: 1, time: '20:00' },
    opening: { background: '地窖里闹老鼠。', situation: '你们站在地窖里。', known: ['地窖很深'] },
    roles: [
      { key: 'hunter', name: '猎人', public: '猎人', secret: '', goal: '清掉鼠患', startLocation: 'cellar' },
      { key: 'monk', name: '游僧', public: '游僧', secret: '', goal: '清掉鼠患', startLocation: 'cellar' },
    ],
    locations: [
      { key: 'entrance', name: '地窖口', description: '台阶。', exits: [{ to: 'cellar', minutes: 2 }], features: [] },
      { key: 'cellar', name: '地窖', description: '酒坛。', exits: [{ to: 'entrance', minutes: 2 }], features: [] },
    ],
    truth: { summary: '鼠王占了地窖。', points: [{ key: 'king', text: '鼠王怕火' }] },
    clues: [{ key: 'burnt', title: '烧焦的毛', content: '墙角有烧焦的鼠毛。', location: 'cellar', points: ['king'], how: '搜墙角', check: null, core: true }],
    npcs: [],
    timeline: [],
    endings: [
      { key: 'win', title: '鼠患平息', condition: '打倒鼠王', summary: '安静了。', result: 'clear' },
      { key: 'lost', title: '鼠口之下', condition: '全都倒下', summary: '没了。', result: 'fail' },
    ],
    dungeon: {
      level: 1,
      size: 'small',
      exit: 'entrance',
      enemies: [{ key: 'rk', name: '鼠王', tier: 'boss', description: '鼠王', abilities: [] }],
      encounters: [],
      loot: [{ key: 'p', places: ['cellar'], how: '箱子里', reward: { kind: 'item', item: 'potion', count: 1 } }],
      variants: [
        { key: 'a', title: '甲', truth: '甲', clues: {}, npcs: {} },
        { key: 'b', title: '乙', truth: '乙', clues: {}, npcs: {} },
      ],
      boss: { enemy: 'rk', location: 'cellar', weaknesses: [{ key: 'f', text: '怕火', hint: '烧焦的毛' }, { key: 'g', text: '怕猫', hint: '烧焦的毛' }], shield: '' },
    },
  };
}

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0, rng: (s: number) => Math.min(4, s), petRng: () => 0 });
  t.app.db.prepare(`UPDATE users SET is_admin = 1, admin_perms = '["reports"]' WHERE username = ?`).run(T5.username);
  for (const a of [OWNER, T1, T2, T5]) cookie[a.username] = await t.login(a.username, a.password);
  fs.writeFileSync(path.join(t.app.engine.scenarioFolder, 'review-dungeon.json'), JSON.stringify(mini()));
});

after(async () => {
  await t.close();
});

async function dungeonRoom(username: string, cardId: number, bag: Record<string, number>) {
  const room = (await as(username)('POST', '/api/rooms', { name: '地窖', maxPlayers: 1, scenarioKey: 'review-dungeon' })).data.room;
  const put = await as(username)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hunter', cardId, bag });
  return { room, put };
}

async function act(username: string, roomId: number, content: string) {
  const res = await as(username)('POST', `/api/rooms/${roomId}/actions`, { content });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await t.app.engine.idle();
  now += 125 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();
}

test('带进地下城还没用掉的道具占着：同一份道具不能同时带进两个地下城', async () => {
  const a = (await as(T1.username)('POST', '/api/cards', { name: '甲卡', ...SHEET })).data.card;
  const b = (await as(T1.username)('POST', '/api/cards', { name: '乙卡', ...SHEET })).data.card;
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'potion', 2) ON CONFLICT (user_id, item) DO UPDATE SET count = 2").run(userId(T1.username));
  const first = await dungeonRoom(T1.username, a.id, { potion: 2 });
  assert.equal(first.put.status, 200, JSON.stringify(first.put.data));
  const second = await dungeonRoom(T1.username, b.id, { potion: 1 });
  assert.deepEqual([second.put.status, second.put.data.error], [409, '背包里的治疗药水有 2 个带进了别的地下城，只剩 0 个能带']);
  assert.equal((await as(T1.username)('PUT', `/api/rooms/${second.room.id}/character`, { roleKey: 'hunter', cardId: b.id, bag: {} })).status, 200, '不带道具照样能进');
  // 第一局结束了，道具就空出来了（没用掉的还在账号里）
  await as(T1.username)('POST', `/api/rooms/${first.room.id}/status`, { status: 'ended' });
  assert.equal((await as(T1.username)('PUT', `/api/rooms/${second.room.id}/character`, { roleKey: 'hunter', cardId: b.id, bag: { potion: 2 } })).status, 200);
  assert.equal(potions(T1.username), 2);
});

test('房主撤回一次用了道具的结算：扣掉的道具退回账号；重新结算再用才再扣', async () => {
  const card = (await as(T2.username)('POST', '/api/cards', { name: '丙卡', ...SHEET })).data.card;
  t.app.db.prepare("INSERT INTO pet_items (user_id, item, count) VALUES (?, 'potion', 2) ON CONFLICT (user_id, item) DO UPDATE SET count = 2").run(userId(T2.username));
  const { room, put } = await dungeonRoom(T2.username, card.id, { potion: 1 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  await as(T2.username)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  await act(T2.username, room.id, '测试喝药：灌下一瓶');
  assert.equal(potions(T2.username), 1, '用掉一瓶，从账号里扣');
  let game = (await as(T2.username)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.me.v2.bag.potion ?? 0, 0);
  const undo = await as(T2.username)('POST', `/api/rooms/${room.id}/host/undo`, {});
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(potions(T2.username), 2, '撤回以后退回账号');
  game = (await as(T2.username)('GET', `/api/rooms/${room.id}/game`)).data;
  assert.equal(game.me.v2.bag.potion, 1, '身上带着的也退回来了');
});

test('地下城按结局结算过以后，结局不能撤回', async () => {
  const card = (await as(T2.username)('POST', '/api/cards', { name: '丁卡', ...SHEET })).data.card;
  const { room } = await dungeonRoom(T2.username, card.id, {});
  await as(T2.username)('POST', `/api/rooms/${room.id}/status`, { status: 'running' });
  await act(T2.username, room.id, '看看四周');
  await act(T2.username, room.id, '再看看');
  await act(T2.username, room.id, '测试结局2');
  const page = (await as(T2.username)('GET', '/api/cards')).data;
  assert.equal(page.cards.find((c: { id: number }) => c.id === card.id).history[0].result, 'fail');
  const host = (await as(T2.username)('GET', `/api/rooms/${room.id}/host`)).data;
  assert.match(host.last.blocked, /已经按结局结算过了/);
  const undo = await as(T2.username)('POST', `/api/rooms/${room.id}/host/undo`, {});
  assert.equal(undo.status, 409);
  assert.match(undo.data.error, /已经按结局结算过了/);
});

test('「我的举报」只说举报的是哪一类，不把原文（可能是对方后来撤回了的）还给举报的人', async () => {
  for (const [a, b] of [
    [T1, T2],
    [T2, T1],
  ]) {
    await as(a.username)('POST', '/api/friends', { username: b.username });
  }
  const g = (await as(T1.username)('POST', '/api/groups', { name: '举报测试群', members: [pub(T2.username)] })).data.group;
  const m = (await as(T1.username)('POST', `/api/groups/${g.id}/messages`, { text: '说了就撤回的话' })).data.message;
  await as(T1.username)('DELETE', `/api/groups/${g.id}/messages/${m.id}`);
  const r = await as(T2.username)('POST', '/api/reports', { kind: 'report', body: '撤回了也要举报', target: { type: 'group', id: m.id } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mine = (await as(T2.username)('GET', '/api/reports/mine')).data.reports as { id: number; target: unknown }[];
  assert.deepEqual(mine.find((x) => x.id === r.data.id)?.target, { type: 'group' });
  assert.ok(!JSON.stringify(mine).includes('说了就撤回的话'));
  // 管理员在举报里照样看得到原文
  const admin = (await as(OWNER.username)('GET', '/api/admin/reports')).data.reports as { id: number; target: { text?: string } }[];
  assert.equal(admin.find((x) => x.id === r.data.id)?.target.text, '说了就撤回的话');
});

test('群聊：站长的消息只有站长自己能撤回；管理员翻聊天记录（包括往前翻）都记进操作记录，十分钟里只记一次', async () => {
  await as(OWNER.username)('POST', '/api/friends', { username: T1.username });
  await as(T1.username)('POST', '/api/friends', { username: OWNER.username });
  const g = (await as(OWNER.username)('POST', '/api/groups', { name: '站长的群', members: [pub(T1.username)] })).data.group;
  const said = (await as(OWNER.username)('POST', `/api/groups/${g.id}/messages`, { text: '站长说的话' })).data.message;
  const other = (await as(T1.username)('POST', `/api/groups/${g.id}/messages`, { text: '玩家说的话' })).data.message;
  const denied = await as(T5.username)('DELETE', `/api/admin/groups/${g.id}/messages/${said.id}`);
  assert.deepEqual([denied.status, denied.data.error], [403, '站长的消息只有站长自己能撤回']);
  assert.equal((await as(T5.username)('DELETE', `/api/admin/groups/${g.id}/messages/${other.id}`)).status, 200);

  const audits = () => (t.app.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = '查看群聊记录' AND admin_id = ?").get(userId(T5.username)) as { n: number }).n;
  const before = audits();
  const page = await as(T5.username)('GET', `/api/admin/groups/${g.id}?before=999999999999`);
  assert.equal(page.status, 200);
  assert.equal(audits(), before + 1, '带 before 也记');
  await as(T5.username)('GET', `/api/admin/groups/${g.id}`);
  assert.equal(audits(), before + 1, '十分钟里反复翻只记一次');
  now += 11 * MIN;
  await as(T5.username)('GET', `/api/admin/groups/${g.id}`);
  assert.equal(audits(), before + 2);
});

test('屏蔽了（谁屏蔽谁都算）就不能切磋', async () => {
  const mine = (await as(T1.username)('GET', '/api/cards')).data.cards[0];
  const theirs = (await as(T2.username)('GET', '/api/cards')).data.cards[0];
  assert.equal((await as(T2.username)('POST', '/api/blocks', { user: T1.username })).status, 200);
  const r = await as(T1.username)('POST', `/api/cards/${mine.id}/duel`, { opponent: theirs.id });
  assert.deepEqual([r.status, r.data.error], [403, '你们之间有屏蔽，不能切磋']);
  await as(T2.username)('DELETE', `/api/blocks/${T1.username}`);
  assert.equal((await as(T1.username)('POST', `/api/cards/${mine.id}/duel`, { opponent: theirs.id })).status, 200);
});
