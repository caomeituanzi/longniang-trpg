// 群聊（V0.7.0）：建群、发消息、未读数、撤回、拉人、移出、退群、改群名、解散、举报；管理员看所有群的记录。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

const [ADMIN, T1, T2, T3, T4] = TEST_ACCOUNTS;
let now = new Date(2026, 10, 3, 20, 0, 0).getTime();
let t: Awaited<ReturnType<typeof startTestApp>>;
const cookie: Record<string, string> = {};

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), now: () => now, tickMs: 0 });
  for (const a of [ADMIN, T1, T2, T3, T4]) cookie[a.username] = await t.login(a.username, a.password);
  // 一 和 二、三是好友；四谁的好友都不是
  for (const other of [T2, T3]) {
    assert.equal((await as(T1.username)('POST', '/api/friends', { username: other.username })).status, 201);
    assert.equal((await as(other.username)('POST', '/api/friends', { username: T1.username })).status, 200);
  }
});

after(async () => {
  await t.close();
});

const as = (username: string) => (method: string, url: string, body?: unknown) => {
  now += 1000;
  return t.call(method, url, body, cookie[username]);
};
const pub = (username: string) => (t.app.db.prepare('SELECT public_id FROM users WHERE username = ?').get(username) as { public_id: string }).public_id;
const badges = async (username: string) => (await as(username)('GET', '/api/me/badges')).data;
const lastAudit = () => t.app.db.prepare('SELECT action, detail FROM admin_audit ORDER BY id DESC LIMIT 1').get() as { action: string; detail: string };

let groupId = 0;

test('建群：只能拉自己的好友；群名要写；被拉的人收到通知；群里有一条「建了群」的提示', async () => {
  let r = await as(T1.username)('POST', '/api/groups', { name: '跑团小分队', members: [pub(T4.username)] });
  assert.equal(r.status, 403, '四不是好友');
  r = await as(T1.username)('POST', '/api/groups', { name: '', members: [pub(T2.username)] });
  assert.equal(r.status, 400);
  r = await as(T1.username)('POST', '/api/groups', { name: '跑团小分队', members: [] });
  assert.equal(r.status, 400, '至少拉一个好友');
  r = await as(T1.username)('POST', '/api/groups', { name: '跑团小分队', members: [pub(T2.username)] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  groupId = r.data.group.id;
  assert.equal(r.data.group.members, 2);
  assert.equal(r.data.group.owner, true);
  const notes = (await as(T2.username)('GET', '/api/notifications')).data.items as { kind: string; data: { groupId: number } }[];
  assert.ok(notes.some((n) => n.kind === 'group_added' && n.data.groupId === groupId));
  const detail = (await as(T2.username)('GET', `/api/groups/${groupId}`)).data;
  assert.equal(detail.owner, false);
  assert.equal(detail.messages[0].kind, 'system');
  assert.match(detail.messages[0].text, /建了群/);
  assert.equal((await as(T3.username)('GET', `/api/groups/${groupId}`)).status, 404, '不在群里的看不到');
});

test('发消息：别人的未读数加一，看过以后清零；自己发的不算未读', async () => {
  const r = await as(T1.username)('POST', `/api/groups/${groupId}/messages`, { text: '今晚八点开《废矿夜灯》' });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.mine, true);
  assert.equal((await badges(T2.username)).groups, 1);
  assert.equal((await badges(T1.username)).groups, 0);
  const list = (await as(T2.username)('GET', '/api/groups')).data.groups;
  assert.equal(list[0].unread, 1);
  assert.match(list[0].last.text, /废矿夜灯/);
  await as(T2.username)('POST', `/api/groups/${groupId}/read`);
  assert.equal((await badges(T2.username)).groups, 0);
  assert.equal((await as(T2.username)('POST', `/api/groups/${groupId}/messages`, { text: 'x'.repeat(501) })).status, 400);
});

test('拉人：群里谁都能拉自己的好友；群主能移出别人，别人不能；自己能退群', async () => {
  let r = await as(T2.username)('POST', `/api/groups/${groupId}/members`, { members: [pub(T3.username)] });
  assert.equal(r.status, 403, '三不是二的好友');
  r = await as(T1.username)('POST', `/api/groups/${groupId}/members`, { members: [pub(T3.username)] });
  assert.equal(r.status, 200);
  assert.equal(r.data.members.length, 3);
  r = await as(T2.username)('DELETE', `/api/groups/${groupId}/members/${pub(T3.username)}`);
  assert.equal(r.status, 403, '只有群主能移出别人');
  r = await as(T1.username)('DELETE', `/api/groups/${groupId}/members/${pub(T3.username)}`);
  assert.equal(r.status, 200);
  assert.equal((await as(T3.username)('GET', `/api/groups/${groupId}`)).status, 404);
  // 再拉回来，他自己退群
  await as(T1.username)('POST', `/api/groups/${groupId}/members`, { members: [pub(T3.username)] });
  r = await as(T3.username)('DELETE', `/api/groups/${groupId}/members/me`);
  assert.equal(r.data.left, true);
  const texts = ((await as(T1.username)('GET', `/api/groups/${groupId}`)).data.messages as { text: string }[]).map((m) => m.text);
  assert.ok(texts.some((x) => x.includes('被群主移出了群')));
  assert.ok(texts.some((x) => x.includes('退出了群')));
});

test('撤回：自己的随时能撤回，别人的不行；屏蔽了的人发的消息看不到，也不算未读', async () => {
  const mine = (await as(T2.username)('POST', `/api/groups/${groupId}/messages`, { text: '说错了' })).data.message;
  assert.equal((await as(T1.username)('DELETE', `/api/groups/${groupId}/messages/${mine.id}`)).status, 403);
  assert.equal((await as(T2.username)('DELETE', `/api/groups/${groupId}/messages/${mine.id}`)).status, 200);
  const seen = ((await as(T1.username)('GET', `/api/groups/${groupId}`)).data.messages as { id: number; text: string; withdrawn: string | null }[]).find(
    (m) => m.id === mine.id,
  );
  assert.deepEqual([seen?.text, seen?.withdrawn], ['', 'self']);
  await as(T1.username)('POST', `/api/groups/${groupId}/read`);
  // 一屏蔽了二：二的消息在一那边不显示、不算未读
  assert.equal((await as(T1.username)('POST', '/api/blocks', { user: pub(T2.username) })).status, 200);
  await as(T2.username)('POST', `/api/groups/${groupId}/messages`, { text: '在吗' });
  assert.equal((await badges(T1.username)).groups, 0);
  const last = ((await as(T1.username)('GET', `/api/groups/${groupId}`)).data.messages as { text: string; hidden?: boolean }[]).at(-1);
  assert.deepEqual([last?.text, last?.hidden], ['', true]);
  await as(T1.username)('DELETE', `/api/blocks/${pub(T2.username)}`);
  // 屏蔽会删掉好友关系：加回来
  assert.equal((await as(T1.username)('POST', '/api/friends', { username: T2.username })).status, 201);
  assert.equal((await as(T2.username)('POST', '/api/friends', { username: T1.username })).status, 200);
});

test('举报群消息：群里的人能举报别人发的；不在群里的不行', async () => {
  const m = (await as(T2.username)('POST', `/api/groups/${groupId}/messages`, { text: '这是一条要被举报的话' })).data.message;
  let r = await as(T3.username)('POST', '/api/reports', { kind: 'report', body: '骂人', target: { type: 'group', id: m.id } });
  assert.equal(r.status, 404);
  r = await as(T1.username)('POST', '/api/reports', { kind: 'report', body: '骂人', target: { type: 'group', id: m.id } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = t.app.db.prepare('SELECT target FROM reports WHERE id = ?').get(r.data.id) as { target: string };
  assert.equal(JSON.parse(row.target).groupName, '跑团小分队');
});

test('改群名、解散：只有群主能做；解散以后从大家的列表里消失', async () => {
  assert.equal((await as(T2.username)('PUT', `/api/groups/${groupId}`, { name: '新名字' })).status, 403);
  const r = await as(T1.username)('PUT', `/api/groups/${groupId}`, { name: '周五跑团' });
  assert.equal(r.data.name, '周五跑团');
  assert.equal((await as(T2.username)('DELETE', `/api/groups/${groupId}`)).status, 403);
  assert.equal((await as(T1.username)('DELETE', `/api/groups/${groupId}`)).status, 200);
  assert.equal((await as(T2.username)('GET', '/api/groups')).data.groups.length, 0);
  assert.equal((await as(T2.username)('GET', `/api/groups/${groupId}`)).status, 404);
});

test('群主退群：最早进群的人接着当群主；最后一个人退了，群就解散了', async () => {
  const g = (await as(T1.username)('POST', '/api/groups', { name: '三人行', members: [pub(T2.username), pub(T3.username)] })).data.group;
  await as(T1.username)('DELETE', `/api/groups/${g.id}/members/me`);
  const d = (await as(T2.username)('GET', `/api/groups/${g.id}`)).data;
  assert.equal(d.owner, true, '二接着当群主');
  assert.match(d.messages.at(-1).text, /成了群主/);
  await as(T2.username)('DELETE', `/api/groups/${g.id}/members/me`);
  await as(T3.username)('DELETE', `/api/groups/${g.id}/members/me`);
  const row = t.app.db.prepare('SELECT disbanded_at FROM chat_groups WHERE id = ?').get(g.id) as { disbanded_at: number | null };
  assert.ok(row.disbanded_at, '没人了就解散');
});

test('管理员：有「举报和大厅聊天」权限才能看所有的群（解散了的也在）；撤回的消息看得到原文；撤回、解散记进操作记录', async () => {
  assert.equal((await as(T1.username)('GET', '/api/admin/groups')).status, 403);
  const list = (await as(ADMIN.username)('GET', '/api/admin/groups')).data.groups as { id: number; name: string; disbandedAt: number | null }[];
  const old = list.find((g) => g.id === groupId);
  assert.ok(old && old.disbandedAt, '解散了的也看得到');
  const detail = (await as(ADMIN.username)('GET', `/api/admin/groups/${groupId}`)).data;
  assert.equal(lastAudit().action, '查看群聊记录');
  const withdrawn = detail.messages.find((m: { withdrawnText: string | null }) => m.withdrawnText);
  assert.equal(withdrawn.withdrawnText, '说错了', '撤回的看得到原文');
  // 搜成员的名字
  const found = (await as(ADMIN.username)('GET', `/api/admin/groups?q=${encodeURIComponent('测试玩家二')}`)).data.groups as { id: number }[];
  assert.ok(found.some((g) => g.id === groupId));
  // 新开一个群：管理员撤回一条、解散
  const g = (await as(T1.username)('POST', '/api/groups', { name: '新群', members: [pub(T3.username)] })).data.group;
  const m = (await as(T3.username)('POST', `/api/groups/${g.id}/messages`, { text: '违规的话' })).data.message;
  let r = await as(ADMIN.username)('DELETE', `/api/admin/groups/${g.id}/messages/${m.id}`);
  assert.equal(r.status, 200);
  assert.equal(lastAudit().action, '撤回群聊消息');
  const seen = ((await as(T1.username)('GET', `/api/groups/${g.id}`)).data.messages as { id: number; withdrawn: string | null }[]).find((x) => x.id === m.id);
  assert.equal(seen?.withdrawn, 'admin');
  r = await as(ADMIN.username)('POST', `/api/admin/groups/${g.id}/disband`);
  assert.equal(r.status, 200);
  assert.equal(lastAudit().action, '解散群聊');
  assert.equal((await as(T1.username)('GET', `/api/groups/${g.id}`)).status, 404);
  assert.equal((await as(ADMIN.username)('POST', `/api/admin/groups/${g.id}/disband`)).status, 409);
});

test('管理员看私信：有「举报和大厅聊天」权限才能看；按人找；看的时候记进操作记录', async () => {
  await as(T1.username)('POST', `/api/friends/${pub(T3.username)}/messages`, { text: '明天几点？' });
  await as(T3.username)('POST', `/api/friends/${pub(T1.username)}/messages`, { text: '晚上八点' });
  assert.equal((await as(T1.username)('GET', '/api/admin/dms')).status, 403);
  const pairs = (await as(ADMIN.username)('GET', `/api/admin/dms?q=${encodeURIComponent('测试玩家三')}`)).data.pairs as {
    a: { publicId: string };
    b: { publicId: string };
    messages: number;
    last: string;
  }[];
  const pair = pairs.find((p) => [p.a.publicId, p.b.publicId].includes(pub(T1.username)));
  assert.ok(pair, '找得到一和三的私信');
  assert.equal(pair.messages, 2);
  assert.equal(pair.last, '晚上八点');
  const thread = (await as(ADMIN.username)('GET', `/api/admin/dms/${pub(T3.username)}/${pub(T1.username)}`)).data;
  assert.deepEqual(
    thread.messages.map((m: { text: string }) => m.text),
    ['明天几点？', '晚上八点'],
  );
  assert.equal(lastAudit().action, '查看私信记录');
});

test('使用规则写明管理员看得到所有内容（包括私信和群聊）；升级时以前同意过的人要重新同意', async () => {
  const { USAGE_RULES } = await import('../shared/usage-rules');
  const rule = USAGE_RULES.find((r) => r.title === '管理员看得到所有内容');
  assert.ok(rule && rule.fresh && /私信/.test(rule.text) && /群聊/.test(rule.text));
  const { MIGRATIONS } = await import('../server/db');
  assert.match(MIGRATIONS[16], /UPDATE users SET rules_agreed_at = NULL WHERE is_guest = 0/);
});
