import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { FakeProvider, reply, say } from '../server/ai/fake';
import { AiError, type MessagesRequest, type MessagesResponse } from '../server/ai/types';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

// 阶段3：AI 生成剧本、把文本剧本转成这里的格式（用假的剧本作者，不调用 Claude）

const [ADMIN, TESTER1, TESTER2] = TEST_ACCOUNTS;
const fog = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fog-harbor-inn.json'), 'utf8'));
const copy = <T>(v: T): T => structuredClone(v);

/** AI 生成的“剧本”：拿《雾港旅店》改个名字。 */
function generated(change?: (s: any) => void) {
  const s = copy(fog);
  s.title = '雾港旅店（AI）';
  change?.(s);
  return s;
}

const outline = {
  title: '雾港旅店（AI）',
  genre: fog.genre,
  tone: fog.tone,
  relation: 'secrets',
  stress: false,
  start: fog.start,
  premise: '大雾封港的旅店里死了一个账房先生。',
  truth: fog.truth,
  npcs: [],
  endings: fog.endings,
  roles: [],
};

/** 每一步的回复按顺序排好；gate 打开之前不回复（模拟 AI 在写）。 */
let script: { outline: unknown[]; details: unknown[]; fix: unknown[]; convert: unknown[] };
let gate: Promise<void> | null = null;

function userText(req: MessagesRequest): string {
  const content = req.messages[0].content;
  return typeof content === 'string' ? content : '';
}

const json = (v: unknown): MessagesResponse => (v instanceof Error ? (() => { throw v; })() : typeof v === 'function' ? v() : say(JSON.stringify(v)));

async function writer(req: MessagesRequest): Promise<MessagesResponse> {
  if (gate) await gate;
  const text = userText(req);
  const queue = text.startsWith('# 第一步')
    ? script.outline
    : text.startsWith('# 第二步')
      ? script.details
      : text.startsWith('# 修改剧本')
        ? script.fix
        : text.startsWith('# 转换剧本')
          ? script.convert
          : null;
  if (!queue) throw new Error(`不认识的请求：${text.slice(0, 20)}`);
  const next = queue.shift();
  if (next === undefined) throw new Error(`没有准备好的回复：${text.slice(0, 20)}`);
  return json(next);
}

const fake = new FakeProvider(writer);
let t: Awaited<ReturnType<typeof startTestApp>>;
let cookies: Record<'admin' | 'tester1' | 'tester2', string>;

before(async () => {
  t = await startTestApp({ ai: fake });
  cookies = {
    admin: await t.login(ADMIN.username, ADMIN.password),
    tester1: await t.login(TESTER1.username, TESTER1.password),
    tester2: await t.login(TESTER2.username, TESTER2.password),
  };
});

after(async () => {
  await t.close();
});

beforeEach(() => {
  script = { outline: [], details: [], fix: [], convert: [] };
  gate = null;
  fake.requests.length = 0;
  // 每个测试都从“接口接受结构化输出”开始
  (t.app.studio as unknown as { schemaRejected: boolean }).schemaRejected = false;
});

async function newRoom(maxPlayers = 4) {
  const r = await t.call('POST', '/api/rooms', { name: '工坊测试', maxPlayers }, cookies.tester1);
  assert.equal(r.status, 201);
  const roomId = r.data.room.id as number;
  assert.equal((await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, cookies.tester2)).status, 200);
  return roomId;
}

const request = { genre: '民国悬疑', tone: '', players: 4, days: 3, relation: 'auto', avoid: '虐待动物，血腥场面', want: '大雾封港' };
const generate = (roomId: number, body: unknown = request, who: keyof typeof cookies = 'tester1') =>
  t.call('POST', `/api/rooms/${roomId}/scenario/generate`, body, cookies[who]);
const job = async (roomId: number, who: keyof typeof cookies = 'tester1') => (await t.call('GET', `/api/rooms/${roomId}/scenario/job`, undefined, cookies[who])).data.job;
const stored = (roomId: number) => {
  const row = t.app.db.prepare('SELECT source, data FROM scenarios WHERE room_id = ?').get(roomId) as { source: string; data: string } | undefined;
  return row ? { source: row.source, scenario: JSON.parse(row.data) } : null;
};
const logTexts = async (roomId: number, who: keyof typeof cookies = 'tester2') =>
  ((await t.call('GET', `/api/rooms/${roomId}/log`, undefined, cookies[who])).data.entries as any[]).map((e) => e.text as string);

test('AI 生成剧本：先写大纲再写完整的剧本，检查通过就存进这一局；真相谁也看不到，房主也能当玩家', async () => {
  const roomId = await newRoom();
  assert.equal((await generate(roomId, request, 'tester2')).status, 403, '只有房主能生成');
  assert.equal((await generate(roomId, { ...request, genre: '' })).status, 400);
  assert.equal((await generate(roomId, { ...request, players: 7 })).status, 400);
  assert.equal((await generate(roomId, { ...request, days: 0 })).status, 400);
  const tooFew = await generate(roomId, { ...request, players: 1 });
  assert.equal(tooFew.status, 400);
  assert.match(tooFew.data.error, /现在有2个人/);

  const watcher = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await watcher.waitFor((e) => e.event === 'presence');
  script.outline.push(outline);
  script.details.push(generated());
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));

  const started = await generate(roomId);
  assert.equal(started.status, 202);
  assert.equal(started.data.job.status, 'running');
  assert.equal(started.data.job.step, 'outline');
  assert.equal(started.data.job.by, TESTER1.displayName);
  assert.equal((await generate(roomId)).status, 409, '一次只能生成一个');
  // 生成的时候：不能开始、不能换现成的剧本；“我的对局”里显示在生成
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'running' }, cookies.tester1)).status, 409);
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester1)).status, 409);
  const lobby = (await t.call('GET', '/api/rooms', undefined, cookies.tester2)).data.rooms.find((r: any) => r.id === roomId);
  assert.equal(lobby.todo.setup, 'generating');

  open();
  await t.app.studio.idle();
  const done = await job(roomId, 'tester2');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.notes, []);
  await watcher.waitFor((e) => e.event === 'scenario-job' && e.data.status === 'done');
  assert.ok(watcher.events.some((e) => e.event === 'scenario-job' && e.data.step === 'details'), '每一步都推给这一局的人');

  // 两次调用：大纲、完整剧本。都是流式、先想后写、按格式输出，带房主的匿名编号
  assert.equal(fake.requests.length, 2);
  for (const req of fake.requests) {
    assert.equal(req.stream, true);
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.equal(req.output_config?.format?.type, 'json_schema');
    assert.match(req.system?.[0]?.text ?? '', /剧本作者/);
    assert.equal(req.metadata?.user_id?.length, 32);
  }
  assert.match(userText(fake.requests[0]), /题材：民国悬疑[\s\S]*玩家人数：4 人[\s\S]*不想出现的内容（雷点）：虐待动物，血腥场面/);
  assert.match(userText(fake.requests[1]), /# 大纲\n\{"title":"雾港旅店（AI）"/);

  // 存成“AI 生成”的剧本：人数、天数、雷点按房主填的
  const saved = stored(roomId)!;
  assert.equal(saved.source, 'generated');
  assert.deepEqual(saved.scenario.players, { min: 1, max: 4 });
  assert.equal(saved.scenario.expectedDays, 3);
  assert.deepEqual(saved.scenario.safety.avoid, ['虐待动物', '血腥场面']);
  const state = (await t.call('GET', `/api/rooms/${roomId}/game`, undefined, cookies.tester1)).data;
  assert.equal(state.scenario.title, '雾港旅店（AI）');
  assert.equal(state.scenario.source, 'generated');
  assert.ok(!JSON.stringify(state).includes(fog.truth.summary.slice(0, 20)), '真相不发给网页，房主也看不到');
  const texts = await logTexts(roomId);
  assert.ok(texts.includes('房主开始用 AI 生成剧本（民国悬疑，4人）'));
  assert.ok(texts.some((x) => x.startsWith('AI 生成了剧本《雾港旅店（AI）》')));
  watcher.close();
});

test('生成的剧本有问题：把问题交给 AI 改，改好了再存；改了两次还不行就算失败，不说具体问题免得剧透', async () => {
  const roomId = await newRoom();
  // 第一次：一条线索放在不存在的地点，另一条真相只剩两条线索 → 改一次就好
  script.outline.push(outline);
  script.details.push(
    generated((s) => {
      s.clues[0].location = 'nowhere';
      s.clues = s.clues.filter((c: any) => !['register', 'raincoat'].includes(c.key));
    }),
  );
  script.fix.push(generated());
  assert.equal((await generate(roomId)).status, 202);
  await t.app.studio.idle();
  const fixed = await job(roomId);
  assert.equal(fixed.status, 'done');
  assert.equal(fixed.fixRound, 1);
  const issues = userText(fake.requests[2]);
  assert.match(issues, /^# 修改剧本/);
  assert.match(issues, /clues\[0\]\.location：没有这个地点「nowhere」/);
  assert.match(issues, /truth\.points「killer」：只有2条线索指向这条真相，至少要3条/);

  // 第二次：怎么改都不对 → 失败
  fake.requests.length = 0;
  const broken = generated((s) => (s.clues[0].location = 'nowhere'));
  script.outline.push(outline);
  script.details.push(broken);
  script.fix.push(broken, broken);
  assert.equal((await generate(roomId)).status, 202);
  await t.app.studio.idle();
  const failed = await job(roomId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /让 AI 改了2次还没改好。为了不剧透/);
  assert.ok(!failed.error.includes('nowhere'));
  assert.equal(fake.requests.length, 4, '大纲、细节、改两次');
  assert.equal(stored(roomId)!.scenario.clues[0].location, fog.clues[0].location, '上一次生成好的剧本还在');
});

test('转换文本剧本：原文太短太长都不收；转换出来的存成导入的剧本，人数夹在1～6，提醒给房主看', async () => {
  const roomId = await newRoom();
  const convert = (text: string, who: keyof typeof cookies = 'tester1') => t.call('POST', `/api/rooms/${roomId}/scenario/convert`, { text }, cookies[who]);
  assert.equal((await convert('太短了')).status, 400);
  assert.equal((await convert('字'.repeat(60_001))).status, 400);
  assert.equal((await convert('一份剧本'.repeat(50), 'tester2')).status, 403);

  script.convert.push(
    generated((s) => {
      s.title = '转换来的剧本';
      s.players = { min: 2, max: 9 };
      // 一条单向的路：只是提醒，不用改
      s.locations[1].exits = [];
    }),
  );
  const original = `《一个小剧本》\n${'旅店里发生了命案。'.repeat(30)}`;
  const started = await convert(original);
  assert.equal(started.status, 202);
  assert.equal(started.data.job.step, 'converting');
  await t.app.studio.idle();
  const done = await job(roomId);
  assert.equal(done.status, 'done');
  assert.ok(done.notes.some((n: string) => n.includes('回不来')), '提醒留给房主看');

  const sent = userText(fake.requests[0]);
  assert.match(sent, /^# 转换剧本/);
  assert.ok(sent.includes(`<<<\n${original}\n>>>`));
  assert.match(sent, /这一局现在有 2 个成员/);
  const saved = stored(roomId)!;
  assert.equal(saved.source, 'imported');
  assert.deepEqual(saved.scenario.players, { min: 2, max: 6 });
  assert.ok((await logTexts(roomId)).includes('房主导入了剧本《转换来的剧本》'));
});

test('取消、拒绝、写不完：取消了就不存；被安全机制拒绝、超出长度都算失败；删除对局时停下', async () => {
  const roomId = await newRoom();
  // 房主取消
  script.outline.push(outline);
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  assert.equal((await generate(roomId)).status, 202);
  assert.equal((await t.call('DELETE', `/api/rooms/${roomId}/scenario/job`, undefined, cookies.tester2)).status, 403);
  const cancelled = await t.call('DELETE', `/api/rooms/${roomId}/scenario/job`, undefined, cookies.tester1);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, 'cancelled');
  open();
  await t.app.studio.idle();
  assert.equal((await job(roomId)).status, 'cancelled');
  assert.equal(stored(roomId), null);
  assert.equal((await t.call('DELETE', `/api/rooms/${roomId}/scenario/job`, undefined, cookies.tester1)).status, 409);
  gate = null;

  // 被安全机制拒绝
  script.outline.push(() => ({ ...reply([], 'refusal'), stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }));
  await generate(roomId);
  await t.app.studio.idle();
  const refused = await job(roomId);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /安全机制拒绝/);

  // 写得太长没写完
  script.outline.push(() => reply([{ type: 'text', text: '{"title":' }], 'max_tokens'));
  await generate(roomId);
  await t.app.studio.idle();
  assert.match((await job(roomId)).error, /没写完/);

  // 接口嫌输出格式太复杂：改成不用结构化输出再要一次
  fake.requests.length = 0;
  script.outline.push(new AiError('Claude 返回了错误（400）（Schema is too complex for compilation）', false, 400), outline);
  script.details.push(generated());
  await generate(roomId);
  await t.app.studio.idle();
  assert.equal((await job(roomId)).status, 'done');
  assert.equal(fake.requests[1].output_config?.format, undefined);
  assert.match(userText(fake.requests[1]), /# 输出格式\n只输出一个 JSON 对象，不要别的文字[\s\S]*"additionalProperties":false/);
  assert.equal(fake.requests[2].output_config?.format, undefined, '记住了接口不接受，后面几步直接把格式写进提示里');

  // 生成到一半删除对局：停下，不出错
  script.outline.push(outline);
  gate = new Promise((resolve) => (open = resolve));
  await generate(roomId);
  assert.equal((await t.call('DELETE', `/api/rooms/${roomId}`, undefined, cookies.tester1)).status, 200);
  open();
  await t.app.studio.idle();
  assert.equal(t.app.db.prepare('SELECT COUNT(*) AS n FROM scenario_jobs WHERE room_id = ?').get(roomId)!.n, 0);
});

test('房主看完整剧本：只有房主能看；AI 生成的剧本第一次看时，记录里告诉大家', async () => {
  const roomId = await newRoom();
  script.outline.push(outline);
  script.details.push(generated());
  await generate(roomId);
  await t.app.studio.idle();
  assert.equal((await t.call('GET', `/api/rooms/${roomId}/scenario/full`, undefined, cookies.tester2)).status, 403);
  const full = await t.call('GET', `/api/rooms/${roomId}/scenario/full`, undefined, cookies.tester1);
  assert.equal(full.status, 200);
  assert.equal(full.data.scenario.truth.summary, fog.truth.summary);
  await t.call('GET', `/api/rooms/${roomId}/scenario/full`, undefined, cookies.tester1);
  assert.equal((await logTexts(roomId)).filter((x) => x === '房主看了完整剧本，包括真相和线索').length, 1, '只说一次');

  // 现成的剧本：房主本来就能看文件，不用说
  const other = await newRoom();
  await t.call('POST', `/api/rooms/${other}/scenario`, { key: 'fog-harbor-inn' }, cookies.tester1);
  assert.equal((await t.call('GET', `/api/rooms/${other}/scenario/full`, undefined, cookies.tester1)).status, 200);
  assert.ok(!(await logTexts(other)).some((x) => x.includes('看了完整剧本')));
});

test('服务器重启时还在生成的，标成失败', async () => {
  const roomId = await newRoom();
  t.app.db
    .prepare("INSERT INTO scenario_jobs (room_id, user_id, kind, status, step, input, created_at, updated_at) VALUES (?, NULL, 'generate', 'running', 'details', '{}', 1, 1)")
    .run(roomId);
  t.app.studio.recover();
  const last = await job(roomId);
  assert.equal(last.status, 'failed');
  assert.match(last.error, /服务器重启了/);
  assert.equal(last.by, '已注销的账号');
});

test('改的过程中越改越糟：用之前那份能用的剧本，不白花钱', async () => {
  const roomId = await newRoom();
  // 第一份能用，只是有一条真相只剩两条线索；后面两次改坏了（引用了不存在的地点）
  const almost = generated((s) => (s.clues = s.clues.filter((c: any) => !['register', 'raincoat'].includes(c.key))));
  const broken = generated((s) => (s.clues[0].location = 'nowhere'));
  script.outline.push(outline);
  script.details.push(almost);
  script.fix.push(broken, broken);
  await generate(roomId);
  await t.app.studio.idle();
  const done = await job(roomId);
  assert.equal(done.status, 'done');
  assert.equal(done.fixRound, 2);
  const saved = stored(roomId)!.scenario;
  assert.equal(saved.clues.length, almost.clues.length, '存的是第一份');
  assert.equal(saved.clues[0].location, fog.clues[0].location);
  // 第二次改的时候，交给 AI 的还是那份能用的，不是改坏的那份
  assert.ok(!userText(fake.requests[3]).includes('nowhere'));
});

test('生成、转换期间：新成员不能超过要的人数；转换时先不让新的人进来；结束对局就停下；别人看不到检查出的问题', async () => {
  const roomId = await newRoom();
  const code = (await t.call('GET', `/api/rooms/${roomId}`, undefined, cookies.tester1)).data.room.joinCode;
  const join = () => t.call('POST', '/api/rooms/join', { code }, cookies.admin);

  // 按2个人生成：第三个人进不来
  script.outline.push(outline);
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  await generate(roomId, { ...request, players: 2 });
  const full = await join();
  assert.equal(full.status, 409);
  assert.match(full.data.error, /正在按2个人生成剧本/);
  // 准备阶段直接结束：生成停下
  assert.equal((await t.call('POST', `/api/rooms/${roomId}/status`, { status: 'ended' }, cookies.tester1)).status, 200);
  open();
  await t.app.studio.idle();
  assert.equal((await job(roomId)).status, 'cancelled');
  assert.equal(stored(roomId), null);

  // 转换期间先不让新的人进来；转出来的剧本人数比现在的成员少，会把上限提到成员数
  const other = await newRoom();
  const otherCode = (await t.call('GET', `/api/rooms/${other}`, undefined, cookies.tester1)).data.room.joinCode;
  script.convert.push(
    generated((s) => {
      s.title = '两人剧本';
      s.players = { min: 1, max: 1 };
      s.locations[1].exits = [];
    }),
  );
  gate = new Promise((resolve) => (open = resolve));
  const started = await t.call('POST', `/api/rooms/${other}/scenario/convert`, { text: '一份剧本'.repeat(50) }, cookies.tester1);
  assert.equal(started.status, 202);
  const blocked = await t.call('POST', '/api/rooms/join', { code: otherCode }, cookies.admin);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /房主正在准备剧本/);
  open();
  await t.app.studio.idle();
  assert.equal((await job(other)).status, 'done');
  assert.deepEqual(stored(other)!.scenario.players, { min: 1, max: 2 });
  // 检查出的提醒里有地点、线索的名字：只给房主看
  assert.ok((await job(other, 'tester1')).notes.length > 0);
  assert.deepEqual((await job(other, 'tester2')).notes, []);
  const after = await t.call('POST', '/api/rooms/join', { code: otherCode }, cookies.admin);
  assert.equal(after.status, 409, '转完以后按剧本的人数算：这个剧本最多2个人');
  assert.match(after.data.error, /满员了（2人）/);
});

test('转换失败时，具体的错误只给房主看；推送也一样', async () => {
  const roomId = await newRoom();
  const watcher = await t.openStream(`/api/rooms/${roomId}/events`, cookies.tester2);
  await watcher.waitFor((e) => e.event === 'presence');
  const broken = generated((s) => (s.clues[0].location = 'nowhere'));
  script.convert.push(broken);
  script.fix.push(broken, broken);
  await t.call('POST', `/api/rooms/${roomId}/scenario/convert`, { text: '一份剧本'.repeat(50) }, cookies.tester1);
  await t.app.studio.idle();
  const forHost = await job(roomId, 'tester1');
  assert.equal(forHost.status, 'failed');
  assert.match(forHost.error, /nowhere/);
  const forOthers = await job(roomId, 'tester2');
  assert.equal(forOthers.error, '没有成功');
  const pushed = await watcher.waitFor((e) => e.event === 'scenario-job' && e.data.status === 'failed');
  assert.equal(pushed.data.error, '没有成功');
  assert.ok(!JSON.stringify(watcher.events).includes('nowhere'));
  watcher.close();
});
