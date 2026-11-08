import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { CATCHUP_SYSTEM, DM_RULES } from '../server/game/prompts';
import { DM_TOOLS } from '../server/game/tools';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { startTestApp } from './helpers';

// V0.4.3：主持人的叙述一律用第三人称、写角色的全名（同一地点的人都看得到一个人的公开行动，写「你」分不清是谁）。

const [, TESTER1, TESTER2] = TEST_ACCOUNTS;
const MIN = 60_000;
let now = Date.UTC(2026, 9, 27, 3, 0, 0);
const fake = new FakeProvider(demoHandler);

let t: Awaited<ReturnType<typeof startTestApp>>;
const cookies: Record<string, string> = {};

before(async () => {
  t = await startTestApp({ ai: fake, now: () => now, tickMs: 0 });
  for (const a of [TESTER1, TESTER2]) cookies[a.username] = await t.login(a.username, a.password);
});

after(async () => {
  await t.close();
});

const call = (method: string, url: string, who: string, body?: unknown) => t.call(method, url, body, cookies[who]);
const reporter = {
  name: '林小满',
  roleKey: 'reporter',
  attributes: { body: 0, agility: 1, intellect: 2, perception: 1, charm: -1 },
  specialties: ['打听消息', '速记'],
  appearance: '短头发，挂着相机',
  goal: '登上头版',
};
// 医生和记者一开始都在大堂
const doctor = { ...reporter, name: '许望舒', roleKey: 'doctor', specialties: ['急救', '辨认药物'], appearance: '', goal: '' };

test('给主持 AI 的规矩：旁白用第三人称、写全名，不用「你」（对白里照常）；单独告诉一个人的、你不在时的摘要也一样', () => {
  assert.match(DM_RULES, /旁白一律用第三人称/);
  assert.match(DM_RULES, /角色卡上的名字（全名），行动的角色也一样/);
  assert.match(DM_RULES, /对白（引号里的话）照常说话/);
  assert.doesNotMatch(DM_RULES, /用第二人称/);
  assert.match(CATCHUP_SYSTEM, /用第三人称写，不用“你”/);
  assert.doesNotMatch(CATCHUP_SYSTEM, /用第二人称/);
  const privateMessage = DM_TOOLS.find((tool) => tool.name === 'private_message');
  const text = (privateMessage?.input_schema as { properties: { text: { description: string } } }).properties.text.description;
  assert.match(text, /第三人称、写他的全名，不用“你”/);
});

test('两个人在同一个地方：一个人的行动结果另一个人也看得到，叙述里写的是行动的人的名字，不是「你」', async () => {
  const room = (await call('POST', '/api/rooms', 'tester1', { name: '第三人称', maxPlayers: 2 })).data.room;
  assert.equal((await call('POST', '/api/rooms/join', 'tester2', { code: room.joinCode })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${room.id}/scenario`, 'tester1', { key: 'fog-harbor-inn' })).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${room.id}/character`, 'tester1', reporter)).status, 200);
  assert.equal((await call('PUT', `/api/rooms/${room.id}/character`, 'tester2', doctor)).status, 200);
  assert.equal((await call('POST', `/api/rooms/${room.id}/status`, 'tester1', { status: 'running' })).status, 200);

  assert.equal((await call('POST', `/api/rooms/${room.id}/actions`, 'tester1', { content: '在大堂里四处看看' })).status, 201);
  await t.app.engine.idle();
  now += 60 * MIN;
  t.app.engine.tick();
  await t.app.engine.idle();

  const story = (who: string) =>
    t.call('GET', `/api/rooms/${room.id}/log`, undefined, cookies[who]).then((r) => r.data.entries as { kind: string; text: string }[]);
  for (const who of ['tester1', 'tester2']) {
    const resolution = (await story(who)).find((e) => e.kind === 'narration' && e.text.includes('试着「在大堂里四处看看」'));
    assert.ok(resolution, `${who} 看得到这次结算`);
    assert.match(resolution.text, /林小满试着「在大堂里四处看看」/);
    assert.doesNotMatch(resolution.text, /你/);
  }
});
