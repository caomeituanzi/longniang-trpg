// V0.9.1：主持 AI 一步一步调用工具到了上限，不再整次作废（照工具结果单独写叙述）；原地打转的调用不再做第二遍；
// 剧情笔记这些给够字数、写不出来时说清楚为什么；每次 AI 调用记下调用了哪些工具（整局排查包里看得到）。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { AiClient } from '../server/ai/client';
import { demoHandler, FakeProvider, say, useTools } from '../server/ai/fake';
import { AiError, type MessagesRequest, type MessagesResponse, type TextBlock, type ToolResultBlock } from '../server/ai/types';
import { MIGRATIONS, openDatabase } from '../server/db';
import { countedNames } from '../server/debug-export';
import { MAX_TURNS, summarizeStory, WRAP_UP_NOTE } from '../server/game/dm';
import { DM_RULES, DM_RULES_5E, DM_RULES_V2 } from '../server/game/prompts';
import { RELEASE_NOTES } from '../server/release-notes';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

const [ADMIN, TESTER1] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 30, 3, 0, 0);

function firstText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * 假主持人：估时看 [分钟 N]；行动里写了「测试打转」就一轮只调用一个工具（每轮让阿福的态度变一下），一直到上限；
 * 只写叙述的那一次照工具结果写一句；别的行动直接写叙述。剧情笔记写一句。
 */
async function dm(req: MessagesRequest): Promise<MessagesResponse> {
  const context = firstText(req);
  if (req.output_config?.format) {
    const minutes = Number(context.match(/\[分钟 (\d+)\]/)?.[1] ?? 10);
    return say(JSON.stringify({ minutes, reason: '测试', kind: 'action', violation: false, category: 'none' }));
  }
  if (context.includes('# 这次结算里已经调用过的工具和结果')) return say('叙述：阿福的态度变了又变，最后缩在柜台后面不吭声了。');
  if (!req.tools?.length) return say('笔记：测试');
  if (!context.includes('测试打转')) return say('叙述：什么也没发生。');
  const turns = req.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => (b as ToolResultBlock).type === 'tool_result')).length;
  return useTools({ name: 'update_npc', input: { npc: 'afu', attitude: `第${turns + 1}步`, reason: '打转' } });
}

const fake = new FakeProvider(dm);
let t: Awaited<ReturnType<typeof startTestApp>>;
let admin = '';
let t1 = '';

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0 });
  admin = await t.login(ADMIN.username, ADMIN.password);
  t1 = await t.login(TESTER1.username, TESTER1.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);

/** 解压排查包（和 v060 的测试一样，自己读 ZIP 的中央目录）。 */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const data = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test('一个行动要做很多步：做到上限照样结算出来（叙述照工具结果写），结果里记着；每次 AI 调用记下调用了哪些工具；整局排查包里看得到', async () => {
  const room = (await as(t1)('POST', '/api/rooms', { name: '打转测试', maxPlayers: 2 })).data.room;
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' })).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'doctor', name: '许医生' })).status, 200);
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
  const r = await as(t1)('POST', `/api/rooms/${room.id}/actions`, { content: '一遍遍追问阿福 测试打转 [分钟 10]' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await t.app.engine.idle();
  now += 20 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();

  const action = t.app.db.prepare('SELECT id, status, attempts, result FROM actions WHERE room_id = ?').get(room.id) as { id: number; status: string; attempts: number; result: string };
  assert.equal(action.status, 'done', '没有作废');
  assert.equal(action.attempts, 0);
  const result = JSON.parse(action.result);
  assert.equal(result.narration, '叙述：阿福的态度变了又变，最后缩在柜台后面不吭声了。');
  assert.deepEqual(result.notes, [WRAP_UP_NOTE]);
  assert.equal(result.trace.length, MAX_TURNS);
  const world = JSON.parse((t.app.db.prepare('SELECT world FROM rooms WHERE id = ?').get(room.id) as { world: string }).world);
  assert.equal(world.npcs.afu.attitude, `第${MAX_TURNS}步`, '每一步都记下了');

  const calls = t.app.db.prepare("SELECT tools FROM ai_calls WHERE action_id = ? AND purpose = 'resolve' ORDER BY id").all(action.id) as { tools: string | null }[];
  assert.equal(calls.length, MAX_TURNS + 1);
  assert.deepEqual(JSON.parse(calls[0].tools!), ['update_npc']);
  assert.equal(calls.at(-1)!.tools, null, '只写叙述的那一次没有工具');

  const res = await fetch(`${t.base}/api/admin/rooms/${room.id}/debug-package`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  const timeline = files.get('时间线.txt')!.toString('utf8');
  assert.match(timeline, /AI #\d+ resolve [^\n]*，调用工具：update_npc，行动 #\d+/);
  const diagnosis = files.get('诊断.txt')!.toString('utf8');
  assert.match(diagnosis, new RegExp(`有 1 个行动的工具调用到了上限，最后单独让主持 AI 照工具结果写的叙述：#${action.id}`));
});

test('剧情笔记写不出来、写到一半被截断：报错里说清楚为什么（之前只说「没有写出剧情笔记」）', async () => {
  const run = async (response: MessagesResponse) => {
    const ai = new AiClient(openDatabase(':memory:'), new FakeProvider(() => response));
    return summarizeStory({ ai, previous: '', entries: [], meta: { roomId: null } });
  };
  await assert.rejects(run({ ...say(''), stop_reason: 'max_tokens' }), (err: unknown) => err instanceof AiError && err.retryable && err.message === '没有写出剧情笔记（想得太久，回复的字数用完了）');
  await assert.rejects(run(say('')), (err: unknown) => err instanceof AiError && /没有写出剧情笔记（回复是空的，stop_reason=end_turn/.test(err.message));
  await assert.rejects(run({ ...say('写到一半'), stop_reason: 'max_tokens' }), (err: unknown) => err instanceof AiError && err.message === '剧情笔记写到一半被截断了');
  assert.equal(await run(say('一份笔记')), '一份笔记');
});

test('工具的名字连着一样的写成「×几」；数据库第 22 版；主持规则里写着能一起调用的工具一次调用完；V0.9.1 的更新公告', () => {
  assert.equal(countedNames(['attack', 'monster_action', 'monster_action', 'monster_action', 'condition', 'attack']), 'attack、monster_action×3、condition、attack');
  assert.equal(countedNames([]), '');
  assert.ok(MIGRATIONS.length >= 22);
  assert.match(MIGRATIONS[21], /ALTER TABLE ai_calls ADD COLUMN tools TEXT/);
  for (const rules of [DM_RULES, DM_RULES_V2, DM_RULES_5E]) assert.match(rules, /一次回复里可以同时调用好几个工具：互相不依赖的/);
  assert.match(DM_RULES_5E, /几个敌人各自的行动、多重攻击的几下/);
  const note = RELEASE_NOTES.find((n) => n.version === '0.9.1')!;
  assert.ok(note && [...note.title].length <= 40 && [...note.body].length <= 2000);
  for (const word of [/不会再整次作废/, /重复算好几次/, /最多等 90 秒/]) assert.match(note.body, word);
  assert.doesNotMatch(note.body, /DeepSeek|Claude|管理|排查包/);
});

test('假主持人认「测试打转」：一轮只调用一个工具，到了上限照样写出叙述（自己在电脑上不接 AI 也能验）', async () => {
  fake.handler = demoHandler;
  try {
    const room = (await as(t1)('POST', '/api/rooms', { name: '假主持人打转', maxPlayers: 2 })).data.room;
    assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/scenario`, { key: 'fog-harbor-inn' })).status, 200);
    assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'doctor', name: '许医生' })).status, 200);
    assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);
    assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/actions`, { content: '在大堂里转来转去 测试打转' })).status, 201);
    await t.app.engine.idle();
    now += 3 * 60 * MIN;
    t.app.engine.tick();
    await t.app.engine.idle();
    const action = t.app.db.prepare('SELECT status, result FROM actions WHERE room_id = ?').get(room.id) as { status: string; result: string };
    assert.equal(action.status, 'done');
    const result = JSON.parse(action.result);
    assert.deepEqual(result.notes, [WRAP_UP_NOTE]);
    assert.match(result.narration, new RegExp(`许医生这一下做了太多步，程序让主持人照已经做完的 ${MAX_TURNS} 步写叙述`));
  } finally {
    fake.handler = dm;
  }
});
