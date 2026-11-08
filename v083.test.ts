process.env.TZ = 'Asia/Shanghai';
// V0.8.3：写剧本 skill（剧本编辑器里下载的 zip：说明、示例、检查脚本）；通知页的公告收起来（只改了网页）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { CATEGORY_KEYS } from '../shared/game';
import { ATTRIBUTE2_KEYS, CONSUMABLE_KEYS } from '../shared/rules2';
import { strictIssues as studioStrict } from '../server/game/studio';
import { strictIssues, validateScenario } from '../server/game/scenario';
import { SCENARIO_BODY_LIMIT } from '../server/routes/game';
import { RELEASE_NOTES } from '../server/release-notes';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { APP_VERSION } from '../server/version';
import { SKILL_NAME, SKILL_ZIP_NAME } from '../server/skill';
import { adviceIssues, checkScenarioText, jsonErrorAt, SKILL_BODY_LIMIT } from '../skill/check-lib';
import { startTestApp } from './helpers';

const [, TESTER1] = TEST_ACCOUNTS;
const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'server', 'editor-example.json'), 'utf8');

let t: Awaited<ReturnType<typeof startTestApp>>;
let t1: string;
let guest: string;
let files: Map<string, Buffer>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-skill-'));

/** 读 zip（只认这里用到的：不压缩和 deflate）。 */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, '不是 zip');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLength + extra;
  }
  return out;
}

const file = (name: string) => {
  const data = files.get(`${SKILL_NAME}/${name}`);
  assert.ok(data, `zip 里没有 ${name}：${[...files.keys()].join('、')}`);
  return data;
};

/** 用 zip 里的检查脚本检查一个剧本文件，返回打印的结果和退出码。 */
function runCheck(content: string): { code: number; out: string } {
  const script = path.join(tmp, 'check.mjs');
  if (!fs.existsSync(script)) fs.writeFileSync(script, file('scripts/check.mjs'));
  const target = path.join(tmp, `s-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(target, content);
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, target], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: e.stdout };
  }
}

before(async () => {
  t = await startTestApp();
  t1 = await t.login(TESTER1.username, TESTER1.password);
  guest = (await t.call('POST', '/api/auth/guest')).cookie!;
});

after(async () => {
  await t.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('写剧本 skill：正式账号、游客都能下载 zip，没登录不行', async () => {
  const res = await fetch(`${t.base}/api/editor/skill`, { headers: { cookie: t1 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="${SKILL_ZIP_NAME}"`));
  files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual([...files.keys()].sort(), [
    `${SKILL_NAME}/SKILL.md`,
    `${SKILL_NAME}/references/5e-items.md`,
    `${SKILL_NAME}/references/5e-monsters.md`,
    `${SKILL_NAME}/references/example.json`,
    `${SKILL_NAME}/scripts/check.mjs`,
    `${SKILL_NAME}/使用说明.txt`,
  ]);
  assert.equal((await fetch(`${t.base}/api/editor/skill`, { headers: { cookie: guest } })).status, 200);
  assert.equal((await fetch(`${t.base}/api/editor/skill`)).status, 401);
});

test('SKILL.md：名字和描述写在开头，版本号换成了现在的，格式里的每一项都讲到了', () => {
  const md = file('SKILL.md').toString('utf8');
  const head = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(md);
  assert.ok(head, 'SKILL.md 开头要有 name 和 description');
  assert.equal(head[1], SKILL_NAME);
  assert.ok([...head[2]].length <= 200, '描述太长');
  assert.ok(md.includes(`V${APP_VERSION}`) && !md.includes('{{'), '版本号没换上');
  assert.ok(file('使用说明.txt').toString('utf8').includes(`V${APP_VERSION}`));
  // 剧本格式里的字段、选项都要讲到（格式改了，skill 也要跟着改）
  const fields = [
    ...['format', 'rules', 'title', 'category', 'intro', 'author', 'genre', 'tone', 'players', 'expectedDays', 'relation', 'stress', 'start', 'safety'],
    ...['opening', 'background', 'situation', 'known', 'roles', 'public', 'secret', 'goal', 'startLocation', 'attributes', 'specialties', 'appearance'],
    ...['locations', 'exits', 'minutes', 'hidden', 'x', 'y', 'features', 'truth', 'summary', 'points', 'clues', 'content', 'location', 'how', 'check', 'modifier', 'core'],
    ...['npcs', 'identity', 'personality', 'knows', 'wants', 'speech', 'attitude', 'timeline', 'ifIgnored', 'endings', 'condition', 'result'],
    ...['enemies', 'tier', 'abilities', 'tweak', 'dungeon', 'level', 'size', 'exit', 'encounters', 'trigger', 'loot', 'reward', 'variants', 'boss', 'weaknesses', 'hint', 'shield'],
    ...ATTRIBUTE2_KEYS,
    ...CATEGORY_KEYS,
    ...CONSUMABLE_KEYS,
    ...['coop', 'secrets', 'versus', 'minion', 'elite', 'clear', 'escape', 'fail', 'small', 'large', 'gear', 'crystals', 'manual', 'legendary'],
  ];
  const missing = fields.filter((f) => !md.includes(`\`${f}\``) && !md.includes(`"${f}"`));
  assert.deepEqual(missing, [], `SKILL.md 没讲到：${missing.join('、')}`);
  // 示例就是编辑器的「打开示例」（原创的短剧本，不剧透自带的剧本）
  assert.equal(file('references/example.json').toString('utf8'), EXAMPLE);
});

test('skill 里的检查脚本单独就能运行：结果和网站导入时的检查一样，再加上更严的要求', () => {
  const ok = runCheck(EXAMPLE);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /《桂香斋的桂花糕》/);
  // 示例为了好读写得很短：能导入，只有篇幅建议
  assert.match(ok.out, /结果：全部通过（篇幅建议 5 条，看情况改）。/);
  assert.match(ok.out, /地点（locations）建议 5～10 个，现在是 3 个/);
  assert.doesNotMatch(ok.out, /错误|提醒|更严的要求/);

  // 属性加起来不对、引用了没有的地点：错误，导入不了
  const bad = JSON.parse(EXAMPLE);
  bad.roles[0].attributes.charm = 3;
  bad.clues[0].location = 'nowhere';
  bad.clues.pop();
  const r = runCheck(JSON.stringify(bad, null, 2));
  assert.equal(r.code, 1);
  for (const e of validateScenario(bad).errors) assert.ok(r.out.includes(e), `少了：${e}`);
  assert.match(r.out, /七项属性加起来要正好是 4，现在是 5/);
  assert.match(r.out, /更严的要求/);
  assert.match(r.out, /只有2条线索指向这条真相，至少要3条/);

  // 一条真相只剩一条线索：网站的提醒（再加一条）和更严的要求（至少 3 条）只留更严的那一条
  const one = JSON.parse(EXAMPLE);
  one.clues = one.clues.filter((c: { key: string }) => c.key !== 'sticky-sleeve' && c.key !== 'children-words');
  const r1 = runCheck(JSON.stringify(one));
  assert.match(r1.out, /truth\.points「taken-by-xiaoman」：只有1条线索指向这条真相，至少要3条/);
  assert.doesNotMatch(r1.out, /taken-by-xiaoman」：只有一条线索指向这条真相；最好再加一条/);
  assert.ok(validateScenario(one).warnings.some((w) => w.includes('「taken-by-xiaoman」：只有一条线索')), '网站的检查照旧提醒');

  // JSON 写错了：说出第几行第几列
  const broken = runCheck('{\n  "title": "x",\n  "roles": [1, 2,],\n}\n');
  assert.equal(broken.code, 1);
  assert.match(broken.out, /第 3 行第 18 列/);
  assert.match(broken.out, /"roles": \[1, 2,\],/);

  // 带 BOM 的文件也认
  assert.equal(runCheck(`﻿${EXAMPLE}`).code, 0);
});

test('检查：自带的剧本都能通过；JSON 出错的位置找得准；大小上限和网站一样', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'scenarios')).filter((x) => x.endsWith('.json'))) {
    const r = checkScenarioText(fs.readFileSync(path.join(ROOT, 'scenarios', f), 'utf8'));
    assert.equal(r.code, 0, `${f}：${r.lines.join('\n')}`);
    assert.deepEqual(r.strict, [], `${f}：${r.strict.join('、')}`);
  }
  // 篇幅建议：简介字数和各部分的个数，不影响导入
  assert.deepEqual(adviceIssues({ intro: '字'.repeat(60), truth: { points: [1, 2, 3] }, locations: [1, 2, 3, 4, 5], npcs: [1, 2, 3], timeline: [1, 2, 3, 4], endings: [1, 2] }), []);
  assert.deepEqual(adviceIssues({ intro: '字'.repeat(151), truth: { points: [] }, locations: Array(11).fill(1), npcs: [], timeline: Array(9).fill(1), endings: Array(5).fill(1) }), [
    '简介（intro）建议 60～150 字，现在是 151 字',
    '真相要点（truth.points）建议 3～6 条，现在是 0 条',
    '地点（locations）建议 5～10 个，现在是 11 个',
    'NPC（npcs）建议 3～8 个，现在是 0 个',
    '时间线（timeline）建议 4～8 条，现在是 9 条',
    '结局（endings）建议 2～4 个，现在是 5 个',
  ]);
  assert.equal(SKILL_BODY_LIMIT, SCENARIO_BODY_LIMIT);
  const huge = { ...JSON.parse(EXAMPLE), intro: '字'.repeat(140_000) };
  assert.ok(checkScenarioText(JSON.stringify(huge)).errors.some((e) => e.includes('剧本太长了')));
  assert.ok(!checkScenarioText(EXAMPLE).errors.length);

  for (const good of ['{}', '[]', '{"a": [1, -2.5e3, true, false, null, "x\\n\\u4e2d"]}', ' "s" ']) assert.equal(jsonErrorAt(good), -1, good);
  assert.equal(jsonErrorAt('{"a": 1,}'), 8);
  assert.equal(jsonErrorAt('{"a": 1 "b": 2}'), 8);
  assert.equal(jsonErrorAt('{"a": “x”}'), 6);
  assert.equal(jsonErrorAt('{"a": "x\ny"}'), 8);
  assert.equal(jsonErrorAt('// 注释\n{}'), 0);
  assert.equal(jsonErrorAt('{"a": 1} 2'), 9);
  // 更严的要求从 studio 挪到了 scenario.ts，studio 里照样能用
  assert.equal(studioStrict, strictIssues);
});

test('V0.8.3 的更新公告写给玩家：通知页的公告、写剧本 skill', () => {
  const note = RELEASE_NOTES.find((n) => n.version === '0.8.3');
  assert.ok(note);
  assert.match(note.body, /公告/);
  assert.match(note.body, /下载写剧本 skill/);
  assert.match(note.body, /导入 \.json 文件/);
  assert.doesNotMatch(note.body, /管理/);
});
