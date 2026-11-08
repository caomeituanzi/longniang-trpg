// V0.8.0：网页剧本编辑器——草稿（只有自己看得到，游客存不了，数量和大小有上限）、边写边检查、示例剧本、
// 用写好的剧本开局（照现有的流程：建对局 + 导入剧本，失败了把刚建的空对局删掉）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { SCENARIO_FORMAT, validateScenario } from '../server/game/scenario';
import { SCENARIO_BODY_LIMIT, SCENARIO_CHECK_MAX } from '../server/routes/game';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { blankScenario, DRAFTS_MAX, EDITOR_FORMAT, EDITOR_MAX_BYTES, EDITOR_MAX_CHARS, PROBLEMS_SHOWN, problemSection, problemTarget, type EditorCheck } from '../shared/editor';
import { clearBackups, readBackup, removeBackup, worthRestoring, writeBackup } from '../web/src/editor/backup';
import { fileName, jsonErrorMessage, locateInJson, newRole, problemElementIds, renameItemKey, setIn, switchRules, utf8Bytes } from '../web/src/editor/doc';
import { startTestApp } from './helpers';

const [, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;
let t: Awaited<ReturnType<typeof startTestApp>>;
let t1 = '';
let t2 = '';
let t3 = '';
let guest = '';

before(async () => {
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0 });
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
  guest = (await t.call('POST', '/api/auth/guest')).cookie!;
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const EXAMPLE_FILE = path.resolve(import.meta.dirname, '..', 'server', 'editor-example.json');
const example = (): Record<string, any> => JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));

test('示例剧本：原创的（不和自带剧本重名），能通过检查，一个提醒都没有；网页和服务器的上限、格式名对得上', async () => {
  const data = example();
  const r = validateScenario(data);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(data.roles.length === 2 && data.npcs.length === 2 && data.endings.length === 2, '两个身份、两个 NPC、两个结局');
  assert.ok(data.locations.length >= 2 && data.locations.length <= 3, '两三个地点');
  const builtinTitles = fs
    .readdirSync(path.resolve(import.meta.dirname, '..', 'scenarios'))
    .map((f) => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', f), 'utf8')).title);
  assert.ok(!builtinTitles.includes(data.title), '不是自带的剧本');
  assert.equal(EDITOR_MAX_CHARS, SCENARIO_CHECK_MAX, '一份剧本的上限和导入剧本的一样');
  assert.equal(EDITOR_MAX_BYTES, SCENARIO_BODY_LIMIT, '请求体的上限和服务器的一样');
  assert.equal(EDITOR_FORMAT, SCENARIO_FORMAT);

  // 接口给的就是这个文件；游客也能拿
  const got = await as(guest)('GET', '/api/editor/example');
  assert.equal(got.status, 200);
  assert.deepEqual(got.data.data, data);
  assert.equal((await t.call('GET', '/api/editor/example')).status, 401, '要登录');
});

test('报错是哪个分区、第几项：路径换成分区，地下城和敌人算在 JSON 里', () => {
  assert.deepEqual(problemTarget('roles[2].name：不能为空'), { path: 'roles[2].name', message: '不能为空', section: 'roles', index: 2, key: null });
  assert.deepEqual(problemTarget('剧本.title：不能为空'), { path: 'title', message: '不能为空', section: 'basic', index: null, key: null });
  assert.equal(problemTarget('剧本.roles：至少要有1项').section, 'roles');
  assert.equal(problemTarget('players：min 不能比 max 大').section, 'basic');
  assert.equal(problemTarget('opening.known[1]：应该是不为空的文字').section, 'basic');
  assert.deepEqual(problemTarget('locations[1].exits[0].to：没有这个地点「x」'), {
    path: 'locations[1].exits[0].to',
    message: '没有这个地点「x」',
    section: 'locations',
    index: 1,
    key: null,
  });
  assert.deepEqual(problemTarget('truth.points「who」：只有一条线索指向这条真相'), {
    path: 'truth.points「who」',
    message: '只有一条线索指向这条真相',
    section: 'truth',
    index: null,
    key: 'who',
  });
  assert.equal(problemTarget('truth.points[3].text：不能为空').index, 3);
  assert.equal(problemTarget('dungeon.boss.enemy：dungeon.enemies 里没有「x」').section, 'json');
  assert.equal(problemTarget('enemies[0].tier：只能是 minion / elite / boss 之一').section, 'json');
  assert.equal(problemTarget('剧本：应该是一个对象 {…}').section, 'json');
  // 空白剧本的每一条报错都落在表单的分区里（不用去 JSON 里找）
  const blank = validateScenario(blankScenario());
  assert.ok(blank.errors.length > 5);
  for (const text of [...blank.errors, ...blank.warnings]) assert.notEqual(problemTarget(text).section, 'json', text);
  // 数分区用的快算法和完整的一样
  const texts = [...blank.errors, ...validateScenario({ ...example(), category: 'dungeon', dungeon: { boss: {} }, enemies: [{}] }).errors, '剧本：x', '剧本.：x', '剧：x', 'roles', 'x：y'];
  for (const text of texts) assert.equal(problemSection(text), problemTarget(text).section, text);
});

test('草稿：存、列、读、改、删；标题从剧本的 title 取（截断）；表单盖不到的字段原样存着', async () => {
  const data = { ...example(), title: '  我的第一个剧本  ', x_future: { note: '以后加的字段', list: [1, 2, 3] } };
  let r = await as(t1)('POST', '/api/editor/drafts', { data });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.draft.id as number;
  assert.equal(r.data.draft.title, '我的第一个剧本');

  r = await as(t1)('GET', `/api/editor/drafts/${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.draft.data, data, '原样存着（包括不认识的字段）');

  // 改：标题跟着变，太长的截断到 40 个字
  const long = '长'.repeat(50);
  r = await as(t1)('PUT', `/api/editor/drafts/${id}`, { data: { ...data, title: long } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft.title, '长'.repeat(40));
  assert.equal((await as(t1)('GET', `/api/editor/drafts/${id}`)).data.draft.data.title, long, '剧本里的标题不动');

  // 没写标题的也能存（还没写完）；不是对象的不行
  r = await as(t1)('POST', '/api/editor/drafts', { data: { format: SCENARIO_FORMAT } });
  assert.equal(r.status, 201);
  assert.equal(r.data.draft.title, '');
  const second = r.data.draft.id as number;
  assert.equal((await as(t1)('POST', '/api/editor/drafts', { data: [1, 2] })).status, 400);
  assert.equal((await as(t1)('POST', '/api/editor/drafts', { data: '剧本' })).status, 400);
  assert.equal((await as(t1)('POST', '/api/editor/drafts', {})).status, 400);

  // 列表：最近改过的在前面
  const list = (await as(t1)('GET', '/api/editor/drafts')).data;
  assert.equal(list.max, DRAFTS_MAX);
  assert.deepEqual(
    list.drafts.map((d: { id: number }) => d.id),
    [second, id],
  );

  r = await as(t1)('DELETE', `/api/editor/drafts/${second}`);
  assert.equal(r.status, 200);
  assert.equal((await as(t1)('GET', `/api/editor/drafts/${second}`)).status, 404);
  assert.equal((await as(t1)('DELETE', `/api/editor/drafts/${second}`)).status, 404);
  assert.equal((await as(t1)('GET', '/api/editor/drafts/abc')).status, 404);
});

test('别人的草稿看不到、改不了、删不掉（一律说没有）；游客存不了；没登录不行', async () => {
  const id = (await as(t1)('POST', '/api/editor/drafts', { data: { ...example(), title: '只给自己看' } })).data.draft.id;
  for (const [method, body] of [
    ['GET', undefined],
    ['PUT', { data: { title: '改掉' } }],
    ['DELETE', undefined],
  ] as const) {
    const r = await as(t2)(method, `/api/editor/drafts/${id}`, body);
    assert.equal(r.status, 404, method);
    assert.equal(r.data.error, '没有这份草稿（可能已经删了）');
  }
  assert.ok(!(await as(t2)('GET', '/api/editor/drafts')).data.drafts.some((d: { id: number }) => d.id === id));
  assert.equal((await as(t1)('GET', `/api/editor/drafts/${id}`)).data.draft.data.title, '只给自己看', '没被改掉');

  // 游客：能检查、能拿示例，存不了
  assert.equal((await as(guest)('POST', '/api/editor/drafts', { data: example() })).status, 403);
  assert.equal((await as(guest)('GET', '/api/editor/drafts')).status, 403);
  assert.equal((await as(guest)('PUT', `/api/editor/drafts/${id}`, { data: example() })).status, 403);
  assert.equal((await as(guest)('POST', '/api/editor/validate', { data: example() })).status, 200);
  // 没登录
  assert.equal((await t.call('GET', '/api/editor/drafts')).status, 401);
  assert.equal((await t.call('POST', '/api/editor/validate', { data: example() })).status, 401);
});

test('草稿的上限：每人 30 份；一份最多 10 万字（和导入剧本一样）；套得太深的不收', async () => {
  for (let i = 0; i < DRAFTS_MAX; i++) {
    const r = await as(t3)('POST', '/api/editor/drafts', { data: { title: `第${i + 1}份` } });
    assert.equal(r.status, 201, `第 ${i + 1} 份：${JSON.stringify(r.data)}`);
  }
  let r = await as(t3)('POST', '/api/editor/drafts', { data: { title: '再来一份' } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /最多存 30 份/);
  // 删掉一份就又能存了
  const first = (await as(t3)('GET', '/api/editor/drafts')).data.drafts.at(-1).id;
  assert.equal((await as(t3)('DELETE', `/api/editor/drafts/${first}`)).status, 200);
  assert.equal((await as(t3)('POST', '/api/editor/drafts', { data: { title: '再来一份' } })).status, 201);

  // 大小：写成 JSON 以后超过 10 万字
  const big = { ...example(), intro: 'x'.repeat(EDITOR_MAX_CHARS) };
  r = await as(t1)('POST', '/api/editor/drafts', { data: big });
  assert.equal(r.status, 413);
  assert.match(r.data.error, /剧本太长了（\d+个字），最多100000个字/);
  const mine = (await as(t1)('GET', '/api/editor/drafts')).data.drafts[0].id;
  assert.equal((await as(t1)('PUT', `/api/editor/drafts/${mine}`, { data: big })).status, 413);
  // 刚好不超过的能存
  const fits = { title: '刚好', intro: '' } as Record<string, string>;
  fits.intro = 'x'.repeat(EDITOR_MAX_CHARS - JSON.stringify(fits).length);
  assert.equal(JSON.stringify(fits).length, EDITOR_MAX_CHARS);
  assert.equal((await as(t1)('PUT', `/api/editor/drafts/${mine}`, { data: fits })).status, 200);

  // 套了很多层的（写乱了的 JSON）
  let deep: unknown = 'x';
  for (let i = 0; i < 40; i++) deep = [deep];
  r = await as(t1)('POST', '/api/editor/drafts', { data: { title: '很深', deep } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /层数太多/);
});

test('边写边检查：示例通过；有错误的列出来（原样的报错，标上分区和第几项）；只有提醒的也算通过；太大的不查', async () => {
  const check = async (data: unknown, cookie = t1) => {
    const r = await as(cookie)('POST', '/api/editor/validate', { data });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data as EditorCheck;
  };
  let c = await check(example());
  assert.equal(c.ok, true);
  assert.deepEqual(c.problems, []);
  assert.deepEqual([c.errors, c.warnings], [0, 0]);
  assert.ok(Object.values(c.sections).every((n) => n.errors === 0 && n.warnings === 0));
  assert.deepEqual(c.summary, { roles: 2, locations: 3, npcs: 2, truthPoints: 2, clues: 5, coreClues: 2, timeline: 2, worldEvents: 0, endings: 2, items: 0, shops: 0, dungeon: false, five: false, monsters: 0, treasure: 0 });

  // 有错误：身份没名字、线索的地点不存在、剧本没标题
  const broken = example();
  broken.title = '';
  broken.roles[0].name = '';
  broken.clues[0].location = 'nowhere';
  c = await check(broken);
  assert.equal(c.ok, false);
  const find = (text: string) => c.problems.find((p) => p.text === text);
  assert.deepEqual(find('roles[0].name：不能为空'), { level: 'error', text: 'roles[0].name：不能为空', section: 'roles', index: 0, key: null });
  assert.equal(c.errors, validateScenario(broken).errors.length);
  assert.deepEqual([c.sections.roles.errors, c.sections.clues.errors, c.sections.basic.errors], [1, 1, 1]);
  assert.equal(find('clues[0].location：没有这个地点「nowhere」')?.section, 'clues');
  assert.equal(find('剧本.title：不能为空')?.section, 'basic');
  // 和导入剧本时的报错一样（validateScenario 原样）
  assert.deepEqual(
    c.problems.filter((p) => p.level === 'error').map((p) => p.text),
    validateScenario(broken).errors,
  );

  // 只有提醒：一条真相只剩一条线索指向它
  const thin = example();
  thin.clues = thin.clues.filter((x: { key: string }) => x.key !== 'sticky-sleeve' && x.key !== 'children-words');
  c = await check(thin);
  assert.equal(c.ok, true, '提醒不挡开局');
  assert.deepEqual(
    c.problems.map((p) => [p.level, p.section, p.key]),
    [['warning', 'truth', 'taken-by-xiaoman']],
  );
  assert.deepEqual([c.errors, c.warnings, c.sections.truth.warnings], [0, 1, 1]);

  // 不是对象：照样告诉你哪里不对
  c = await check([1, 2, 3]);
  assert.equal(c.ok, false);
  assert.equal(c.problems[0].text, '剧本：应该是一个对象 {…}');
  assert.equal(c.problems[0].section, 'json');

  // 太大、没带内容的
  let r = await as(t1)('POST', '/api/editor/validate', { data: { ...example(), intro: 'x'.repeat(EDITOR_MAX_CHARS) } });
  assert.equal(r.status, 413);
  r = await as(t1)('POST', '/api/editor/validate', { text: 'x' });
  assert.equal(r.status, 400);
  // 游客也能检查
  assert.equal((await check(example(), guest)).ok, true);
});

test('检查限频率：按账号每分钟 20 次；按地址每分钟 30 次（一个地址能建好几个游客账号）；超过了说清楚', async () => {
  const limited = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0, rateLimits: true });
  try {
    const a = await limited.login(TESTER1.username, TESTER1.password);
    const b = await limited.login(TESTER2.username, TESTER2.password);
    const c = await limited.login(TESTER3.username, TESTER3.password);
    // ip：从 Cloudflare 隧道转进来的访客地址（不写是在这台电脑上打开的，不按地址算）
    const validate = (cookie: string, ip?: string) =>
      fetch(`${limited.base}/api/editor/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, ...(ip ? { 'cf-connecting-ip': ip } : {}) },
        body: JSON.stringify({ data: { title: '试试' } }),
      });
    for (let i = 0; i < 20; i++) assert.equal((await validate(a)).status, 200, `第 ${i + 1} 次`);
    let r = await validate(a);
    assert.equal(r.status, 429);
    assert.equal(((await r.json()) as { error: string }).error, '检查得太频繁了，过一会儿再试');
    assert.equal((await validate(b)).status, 200, '按账号算，别人不受影响');
    // 同一个地址换着账号查：加起来 30 次就不行了（每个账号都还没到 20 次）
    for (let i = 0; i < 15; i++) assert.equal((await validate(b, '203.0.113.7')).status, 200);
    for (let i = 0; i < 15; i++) assert.equal((await validate(c, '203.0.113.7')).status, 200);
    r = await validate(c, '203.0.113.7');
    assert.equal(r.status, 429);
    assert.equal((await validate(c, '198.51.100.9')).status, 200, '别的地址不受影响');
  } finally {
    await limited.close();
  }
});

test('特别构造的大剧本（V0.8.0 安全审查）：检查很快，超了上限的列表只查前面的；列出来的问题最多 100 条，另给总数，回复不大', async () => {
  // n 从估计的大小往下减，减到不超过 10 万字
  const fit = (make: (n: number) => unknown, n: number) => {
    while (JSON.stringify(make(n)).length > EDITOR_MAX_CHARS) n -= 100;
    return make(n);
  };
  const cases: Record<string, unknown> = {
    // 很多地点（标识都一样），出口都指向排在最后的地点：以前每个出口都要把地点扫一遍
    exitsToLast: fit((n) => ({ format: SCENARIO_FORMAT, locations: [{ key: 'a', exits: Array.from({ length: n }, () => ({ to: 'z' })) }, ...Array.from({ length: n }, () => ({ key: 'a' })), { key: 'z' }] }), 4500),
    // 很多真相要点 × 很多线索：以前每条真相都要把线索扫一遍
    pointsTimesClues: fit((n) => ({ format: SCENARIO_FORMAT, truth: { points: Array.from({ length: n }, () => ({ key: 'p' })) }, clues: Array.from({ length: n }, () => ({ points: ['p'] })) }), 3500),
    // 一个起点有很多出口（可达性检查）
    manyExits: fit((n) => ({ format: SCENARIO_FORMAT, roles: [{ startLocation: 'a' }], locations: [{ key: 'a', exits: Array.from({ length: n }, () => ({ to: 'z' })) }, ...Array.from({ length: n }, () => ({ key: 'b' })), { key: 'z' }] }), 4500),
    // 地下城一种真相下的线索写了几千条（是对象，不是列表）
    variantClues: fit((n) => ({ format: SCENARIO_FORMAT, category: 'dungeon', rules: 2, dungeon: { variants: [{ clues: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'x'])) }] } }), 8000),
  };
  for (const [name, data] of Object.entries(cases)) {
    const t0 = performance.now();
    const result = validateScenario(data);
    const ms = performance.now() - t0;
    if (name !== 'variantClues') {
      assert.ok(ms < 150, `${name}：检查用了 ${ms.toFixed(0)} ms`);
      assert.ok(result.errors.length + result.warnings.length < 1000, `${name}：超了上限的列表只查前面的（现在 ${result.errors.length} 条错误）`);
    }
    const r = await as(t1)('POST', '/api/editor/validate', { data });
    assert.equal(r.status, 200, name);
    const c = r.data as EditorCheck;
    assert.equal(c.problems.length, PROBLEMS_SHOWN, `${name}：只列前 ${PROBLEMS_SHOWN} 条`);
    assert.deepEqual([c.errors, c.warnings], [result.errors.length, result.warnings.length], `${name}：给总数`);
    assert.equal(
      Object.values(c.sections).reduce((sum, n) => sum + n.errors + n.warnings, 0),
      c.errors + c.warnings,
      `${name}：每个分区的数加起来是总数`,
    );
    assert.deepEqual(
      c.problems.map((p) => p.text),
      [...result.errors, ...result.warnings].slice(0, PROBLEMS_SHOWN),
      `${name}：错误在前，原样`,
    );
    const bytes = Buffer.byteLength(JSON.stringify(c));
    assert.ok(bytes < 32 * 1024, `${name}：回复 ${bytes} 字节`);
  }
  // 超了上限的列表照样报「最多 N 项」
  const exits = validateScenario(cases.exitsToLast);
  assert.ok(exits.errors.includes('剧本.locations：最多40项'));
  assert.ok(exits.errors.includes('locations[0].exits：最多12项'));
  // 报错里带着特别长的内容的：截短
  const roles = example().roles;
  roles[0].startLocation = '长'.repeat(5000);
  const c = (await as(t1)('POST', '/api/editor/validate', { data: { ...example(), roles } })).data as EditorCheck;
  const text = c.problems.find((p) => p.text.startsWith('roles[0].startLocation：没有这个地点'))!.text;
  assert.equal([...text].length, 301);
  assert.ok(text.endsWith('…'));
});

test('用写好的剧本开局：建对局 + 导入剧本（照现有的接口）；导入失败的把刚建的空对局删掉', async () => {
  // 示例能顺利装进一局
  let r = await as(t1)('POST', '/api/rooms', { name: '桂香斋', maxPlayers: 2, untimed: false, isPublic: false });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const roomId = r.data.room.id as number;
  r = await as(t1)('POST', `/api/rooms/${roomId}/scenario`, { data: example() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.scenario.title, '桂香斋的桂花糕');
  const stored = t.app.db.prepare('SELECT source FROM scenarios WHERE room_id = ?').get(roomId) as { source: string };
  assert.equal(stored.source, 'imported', '和导入剧本文件一样');

  // 有错误的剧本装不进去：说清楚原因，网页再把刚建的空对局删掉
  const broken = example();
  broken.roles[0].startLocation = 'nowhere';
  r = await as(t1)('POST', '/api/rooms', { name: '装不进去', maxPlayers: 2 });
  const emptyRoom = r.data.room.id as number;
  r = await as(t1)('POST', `/api/rooms/${emptyRoom}/scenario`, { data: broken });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /roles\[0\]\.startLocation：没有这个地点「nowhere」/);
  assert.equal((await as(t1)('DELETE', `/api/rooms/${emptyRoom}`)).status, 200);
  assert.equal((await as(t1)('GET', `/api/rooms/${emptyRoom}`)).status, 404);

  // 游客不能开局
  assert.equal((await as(guest)('POST', '/api/rooms', { name: '游客的局', maxPlayers: 2 })).status, 403);
});

test('账号删了，草稿跟着删掉', async () => {
  const db = t.app.db;
  const userId = Number(
    db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('draft-owner', '写剧本的人', '!', 0)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO scenario_drafts (user_id, title, data, created_at, updated_at) VALUES (?, '草稿', '{}', 0, 0)").run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scenario_drafts WHERE user_id = ?').get(userId) as { n: number }).n, 0);
});

// ---------- 编辑页里改剧本用的小工具（web/src/editor/doc.ts，不碰浏览器） ----------

test('表单改一处：不动原来的那一份，表单盖不到的字段原样留着；写 undefined 是删掉', () => {
  const doc = { title: '旧', x_future: { deep: [1, 2] }, dungeon: { level: 3 }, roles: [{ key: 'a', name: '甲', extra: true }, { key: 'b' }] };
  const next = setIn(doc, ['roles', 0, 'name'], '乙') as typeof doc;
  assert.equal(doc.roles[0].name, '甲', '原来的没动');
  assert.equal(next.roles[0].name, '乙');
  assert.equal(next.roles[0].extra, true);
  assert.equal(next.x_future, doc.x_future, '没碰到的原样留着（同一个对象）');
  assert.equal(next.dungeon, doc.dungeon);
  assert.equal(next.roles[1], doc.roles[1]);
  assert.deepEqual(Object.keys(next), Object.keys(doc), '字段的顺序不变');
  assert.equal('title' in (setIn(doc, ['title'], undefined) as object), false);
  assert.deepEqual(setIn({}, ['players', 'max'], 4), { players: { max: 4 } });
});

test('改标识：引用它的地方跟着改（地点、真相要点、地下城里的地点和线索）；撞上别的标识就只改这一项', () => {
  const doc = example();
  const backyard = doc.locations.findIndex((l: { key: string }) => l.key === 'backyard');
  let next = renameItemKey(doc, 'locations', backyard, 'yard') as Record<string, any>;
  assert.deepEqual(validateScenario(next).errors, [], '改完照样通过检查');
  assert.equal(next.npcs.find((n: { key: string }) => n.key === 'xiaoman').location, 'yard');
  assert.ok(next.clues.filter((c: { location: string }) => c.location === 'yard').length === 2);
  assert.ok(next.locations[0].exits.some((e: { to: string }) => e.to === 'yard'));
  assert.equal(next.roles, doc.roles, '没引用它的部分不动');

  next = renameItemKey(doc, 'truth.points', 0, 'who') as Record<string, any>;
  assert.deepEqual(validateScenario(next).errors, []);
  assert.ok(next.clues[0].points.includes('who'));

  // 撞上了别的地点的标识：只改这一项（检查会说重复了），别的地点的引用不能被改走
  next = renameItemKey(doc, 'locations', backyard, 'shop-front') as Record<string, any>;
  assert.equal(next.npcs.find((n: { key: string }) => n.key === 'xiaoman').location, 'backyard');
  assert.ok(validateScenario(next).errors.some((e) => e.includes('key「shop-front」重复了')));

  // 地下城：出口、首领在哪、遇敌和宝物的候选地点、几种真相下的线索和 NPC 也跟着改
  const mine = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', 'dungeon-abandoned-mine.json'), 'utf8'));
  let renamed = mine;
  for (const kind of ['locations', 'clues', 'npcs'] as const) {
    (mine[kind] as { key: string }[]).forEach((item, i) => {
      renamed = renameItemKey(renamed, kind, i, `${item.key}-x`);
    });
  }
  assert.deepEqual(validateScenario(renamed).errors, [], '地下城里引用的地方都跟着改了');
  assert.ok(renamed.dungeon.boss.location.endsWith('-x'));
});

test('换规则：身份的属性按新规则换算（擅长的还是高），线索的检定换成新规则的属性；换来换去都能通过检查', () => {
  const doc = example();
  const one = switchRules(doc, 1) as Record<string, any>;
  assert.equal(one.rules, 1);
  assert.deepEqual(validateScenario(one).errors, []);
  assert.equal(one.roles[0].attributes.charm, 2, '魅力最高的还是魅力最高');
  assert.equal(one.roles[1].attributes.body, 2, '力量最高的换成体魄最高');
  const two = switchRules(one, 2) as Record<string, any>;
  assert.deepEqual(validateScenario(two).errors, []);
  assert.equal(Object.values(two.roles[0].attributes as Record<string, number>).reduce((s, x) => s + x, 0), 4);
  // 新加的身份：每种规则下的属性都是对的
  assert.deepEqual(validateScenario({ ...doc, roles: [...doc.roles, { ...newRole(doc), name: '新来的', public: '路人', goal: '看热闹', specialties: ['跑腿', '吆喝'] }], players: { min: 1, max: 3 } }).errors, []);
  assert.equal('attributes' in newRole({ ...doc, category: 'dungeon' }), false, '地下城的身份不写属性');
});

test('点了问题跳到哪：按路径找输入框，找不到就找它所在的那一项、那一个分区；JSON 里按键名找', () => {
  assert.deepEqual(problemElementIds({}, { path: 'roles[2].name', key: null, section: 'roles' }), ['ed-roles-2-name', 'ed-roles-2', 'ed-roles', 'ed-section-roles']);
  assert.deepEqual(problemElementIds(example(), { path: 'truth.points「given-to-children」', key: 'given-to-children', section: 'truth' }), [
    'ed-truth-points-1',
    'ed-truth-points',
    'ed-truth',
    'ed-section-truth',
  ]);
  const text = JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scenarios', 'dungeon-abandoned-mine.json'), 'utf8')), null, 2);
  const at = locateInJson(text, 'dungeon.boss.enemy')!;
  assert.equal(text.slice(at.start, at.end), '"enemy"');
  assert.ok(text.lastIndexOf('"boss":', at.start) > text.indexOf('"dungeon":'), '找的是 dungeon.boss 里的那个');
  assert.equal(locateInJson(text, 'nothing.here'), null);
  // JSON 写错了：说第几行第几列
  let message = '';
  try {
    JSON.parse('{\n"a": 1,,\n}');
  } catch (err) {
    message = jsonErrorMessage(err, '{\n"a": 1,,\n}');
  }
  assert.match(message, /^JSON 格式不对（第 2 行第 \d+ 列附近）$/);
  assert.equal(fileName('桂香斋/的:桂花糕?'), '桂香斋 的 桂花糕.json');
  assert.equal(fileName('  '), '未命名剧本.json');
});

test('发整份剧本的接口单独放宽请求体上限（400KB）：快 10 万字的中文剧本能检查、能存、能导入开局；再大的说清楚上限；别的接口照旧', async () => {
  // 9.2 万字的中文：写成请求有 270KB 左右，比一般接口的 256KB 大（以前就存不了、查不了）
  const big = example();
  big.intro = '雾'.repeat(92_000 - JSON.stringify(big).length);
  const bytes = Buffer.byteLength(JSON.stringify({ data: big }));
  assert.ok(bytes > 256 * 1024 && JSON.stringify(big).length <= EDITOR_MAX_CHARS, `${bytes} 字节`);
  assert.equal((await as(t1)('POST', '/api/editor/validate', { data: big })).status, 200);
  const saved = await as(t1)('POST', '/api/editor/drafts', { data: big });
  assert.equal(saved.status, 201);
  assert.equal((await as(t1)('PUT', `/api/editor/drafts/${saved.data.draft.id}`, { data: big })).status, 200);
  // 导入剧本（用写好的剧本开局走的就是它）：请求体放得下，剩下的照导入的规矩查（简介最多 300 字）
  const room = (await as(t1)('POST', '/api/rooms', { name: '大剧本', maxPlayers: 2 })).data.room;
  const imported = await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { data: big });
  assert.equal(imported.status, 400);
  assert.match(imported.data.error, /剧本\.intro：最多300个字/);
  // 管理员上传剧本也一样放宽
  const admin = await t.login(TEST_ACCOUNTS[0].username, TEST_ACCOUNTS[0].password);
  const uploaded = await as(admin)('POST', '/api/admin/scenarios', { key: 'big-story', data: big });
  assert.equal(uploaded.status, 400);
  assert.match(uploaded.data.error, /剧本\.intro：最多300个字/);

  // 超过 400KB 的：说清楚上限
  const huge = { ...example(), intro: '雾'.repeat(140_000) };
  let r = await as(t1)('POST', '/api/editor/validate', { data: huge });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, '内容太长了：最多 400KB');
  r = await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { data: huge });
  assert.equal(r.data.error, '内容太长了：最多 400KB');
  r = await as(admin)('POST', '/api/admin/scenarios', { key: 'big-story', data: huge });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, '内容太长了：最多 400KB');
  // 别的接口照旧是 256KB
  r = await as(t1)('POST', `/api/rooms/${room.id}/chat`, { text: '雾'.repeat(90_000) });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, '内容太长了');
});

test('网页上的小工具：按 UTF-8 算字节；浏览器里暂存没保存的内容（按账号、按草稿分开，退出登录全删；浏览器不让存也不出错）', () => {
  for (const text of ['abc', '雾港旅店', 'é', '😀龙', 'x\ud800', '\udc00y', '']) assert.equal(utf8Bytes(text), Buffer.byteLength(text), JSON.stringify(text));

  // 没有 localStorage（或者不让用）：读不到，写、删都不出错
  assert.equal(readBackup(1, null), null);
  writeBackup(1, null, { at: 1, base: null, data: {} });
  clearBackups(1);

  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = fake;
  try {
    writeBackup(1, null, { at: 10, base: null, data: { title: '新的' } });
    writeBackup(1, 5, { at: 20, base: 15, data: { title: '五号' } });
    writeBackup(2, 5, { at: 30, base: 15, data: { title: '别人的五号' } });
    assert.deepEqual(readBackup(1, 5), { at: 20, base: 15, data: { title: '五号' } });
    assert.equal(readBackup(2, 5)?.data.title, '别人的五号', '按账号分开');
    store.set('editor-unsaved:1:7', '{坏了');
    assert.equal(readBackup(1, 7), null, '坏了的当成没有');
    removeBackup(1, 5);
    assert.equal(readBackup(1, 5), null);
    clearBackups(1);
    assert.deepEqual([...store.keys()], ['editor-unsaved:2:5'], '退出登录只删自己的');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }

  // 要不要问「恢复」：和服务器上的不一样，而且比服务器上的新
  const server = JSON.stringify({ title: '服务器上的' });
  assert.equal(worthRestoring({ at: 100, base: 50, data: { title: '服务器上的' } }, server, 50), false, '一样的不用恢复');
  assert.equal(worthRestoring({ at: 100, base: 50, data: { title: '改了' } }, server, 50), true, '在服务器这一份上改的');
  assert.equal(worthRestoring({ at: 40, base: 30, data: { title: '改了' } }, server, 50), false, '服务器上后来又存过');
  assert.equal(worthRestoring({ at: 60, base: 30, data: { title: '改了' } }, server, 50), true, '暂存得比服务器上最后存的晚');
  assert.equal(worthRestoring({ at: 1, base: null, data: { title: '改了' } }, server, null), true, '新草稿');
});
