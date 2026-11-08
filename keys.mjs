// 管理 API 密钥：看看 Claude、DeepSeek、OpenRouter、中转站（V1.0.1，还要填接口地址）的密钥设置了没有，换一个、删掉，打开或关掉测试用的假主持人。
// 改的是项目文件夹里的 .env，不用自己打开记事本找那一行。Windows 双击 api-keys.bat，Mac 双击 api-keys.command，
// 或者在项目文件夹里运行 node scripts/keys.mjs。改完要重新启动服务器才生效。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import { checkClaude, checkDeepSeek, checkOpenRouter, checkRelay, envValue, KEYS } from './key-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

function say(text = '') {
  console.log(text);
}

// ---------- 一问一答：整个过程共用一个读取器，一次粘贴了好几行也不会丢；输入被关掉了返回 null ----------

let reader = null;
let inputEnded = false;
const lines = [];
const waiting = [];

function ask(question) {
  process.stdout.write(question);
  // 先用已经读到、还没用掉的（一次粘贴了好几行）；都用完了、输入也关了才算没有
  if (lines.length) return Promise.resolve(lines.shift().trim());
  if (inputEnded) {
    process.stdout.write('\n');
    return Promise.resolve(null);
  }
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin });
    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    reader.on('close', () => {
      inputEnded = true;
      for (const next of waiting.splice(0)) next(null);
    });
  }
  return new Promise((resolve) => waiting.push((line) => resolve(line === null ? null : line.trim())));
}

function bye(code = 0) {
  reader?.close();
  process.exit(code);
}

// ---------- 设置文件 ----------

function readEnv() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '') : '';
}

/** 写一项：已经有这一行就改掉（先找没注释的，再找注释掉的），没有就加在最后。value 是 null 时注释掉这一行（等于删掉）。 */
function setEnvValue(key, value) {
  let text = readEnv();
  const active = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const commented = new RegExp(`^[ \\t]*#[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const line = value === null ? `# ${key}=` : `${key}=${value}`;
  if (active.test(text)) text = text.replace(active, line);
  else if (value === null) return;
  else if (commented.test(text)) text = text.replace(commented, line);
  else text = `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

/** 只露出开头和最后 4 位。 */
function mask(key) {
  return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '（已设置）';
}

/** 中转站（V1.0.1）的接口地址：没有默认的，用哪一家填哪一家。返回 false 是没填好（不往下问密钥）。 */
async function editRelayUrl() {
  const base = envValue(readEnv(), 'RELAY_BASE_URL');
  say();
  say(`中转站的接口地址：${base || '还没设置'}`);
  const answer = await ask(`输入接口地址（到 /v1 为止，以 https:// 开头，在中转站的网站上看）${base ? '；直接回车用现在的' : ''}：`);
  if (answer === null) bye();
  const url = answer.replace(/\s+/g, '').replace(/\/+$/, '');
  if (!url) {
    if (!base) say('没有接口地址，中转站用不了。');
    return !!base;
  }
  if (!/^https?:\/\/[^/]+/.test(url)) {
    say('接口地址要以 https:// 开头。');
    return false;
  }
  setEnvValue('RELAY_BASE_URL', url);
  say('接口地址存进 .env 了。');
  return true;
}

async function editKey(which) {
  const item = KEYS[which];
  if (which === 'relay' && !(await editRelayUrl())) return false;
  let env = readEnv();
  const current = envValue(env, item.env);
  say();
  say(`${item.label} 的 API 密钥：${current ? mask(current) : '还没设置'}`);
  const input = await ask(`粘贴新的密钥再按回车（${item.where}）${current ? '；输入「删掉」删除现在的' : ''}；直接回车返回：`);
  if (input === null) bye();
  const key = input.replace(/\s+/g, '');
  if (!key) return false;
  if (key === '删掉') {
    if (!current) return false;
    setEnvValue(item.env, which === 'claude' ? '' : null);
    if (which === 'claude') setEnvValue('ANTHROPIC_WORKSPACE_ID', null);
    say(`删掉了 ${item.label} 的密钥。`);
    return true;
  }
  if (!item.looksRight(key, env)) {
    say(item.wrongShape);
    return false;
  }
  say('正在检查密钥……');
  let workspace = which === 'claude' ? envValue(env, 'ANTHROPIC_WORKSPACE_ID') : '';
  let result =
    which === 'claude'
      ? await checkClaude(key, workspace, env)
      : which === 'deepseek'
        ? await checkDeepSeek(key, env)
        : which === 'relay'
          ? await checkRelay(key, env)
          : await checkOpenRouter(key, env);
  while (result.workspace) {
    say('这个密钥能用于好几个工作区，要说清楚用哪一个：在 Claude 控制台的 Workspaces 页面复制工作区编号（wrkspc_ 开头）。');
    const answer = await ask('工作区编号（直接回车不存这个密钥）：');
    if (answer === null) bye();
    workspace = answer.replace(/\s+/g, '');
    if (!workspace) return false;
    result = await checkClaude(key, workspace, env);
  }
  if (result.ok === false) {
    say(`${result.message}没有存，再试一次吧。`);
    return false;
  }
  setEnvValue(item.env, key);
  if (which === 'claude' && workspace) setEnvValue('ANTHROPIC_WORKSPACE_ID', workspace);
  if (result.ok === true) say(`密钥可以用，已经存进 .env。${result.note ?? ''}`);
  else if (result.custom) say('用的是自己设的接口地址，没法检查，密钥先存下了。启动以后 AI 用不了的话，网页上会说明原因。');
  else say('现在连不上，没法检查。密钥先存下了，启动以后 AI 用不了的话，网页上会说明原因。');
  if (envValue(readEnv(), 'AI_PROVIDER').toLowerCase() === 'fake') say('现在开着测试用的假主持人：要用真的 AI，在第 5 项里关掉它。');
  return true;
}

async function toggleFake() {
  const env = readEnv();
  const on = envValue(env, 'AI_PROVIDER').toLowerCase() === 'fake';
  say();
  if (on) {
    const anyKey = Object.values(KEYS).some((k) => envValue(env, k.env));
    if (!anyKey) say('注意：还没有设置任何 API 密钥，关掉假主持人以后 AI 用不了，先在上面设一个密钥。');
    const answer = await ask('现在用的是测试用的假主持人。关掉它、改用真的 AI 吗？输入 y 再按回车：');
    if (answer === null) bye();
    if (answer.toLowerCase() !== 'y') return false;
    setEnvValue('AI_PROVIDER', null);
    say('关掉了假主持人，下次启动用真的 AI。');
    return true;
  }
  const answer = await ask('打开测试用的假主持人吗？打开以后不调用任何 AI、不花钱，叙述是固定的套话。输入 y 再按回车：');
  if (answer === null) bye();
  if (answer.toLowerCase() !== 'y') return false;
  setEnvValue('AI_PROVIDER', 'fake');
  say('打开了假主持人。');
  return true;
}

// ---------- 开始 ----------

if (typeof util.parseEnv !== 'function') {
  say(`你的 Node.js 是 ${process.versions.node}，太旧了。先双击 start.bat（Mac 是 start.command），它会告诉你怎么更新。`);
  await ask('按回车键关闭这个窗口。');
  bye(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
say(`龙娘跑团 V${pkg.version}：管理 API 密钥`);
if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  say('已经建好设置文件 .env（在项目文件夹里，里面存着你的 API 密钥，不要发给别人）。');
}

let changed = false;
for (;;) {
  const env = readEnv();
  const fake = envValue(env, 'AI_PROVIDER').toLowerCase() === 'fake';
  const show = (k) => {
    const v = envValue(env, KEYS[k].env);
    return v ? mask(v) : '还没设置';
  };
  say();
  say(`  1. Claude       ${show('claude')}`);
  say(`  2. DeepSeek     ${show('deepseek')}`);
  say(`  3. OpenRouter   ${show('openrouter')}`);
  say(`  4. 中转站       ${show('relay')}`);
  say(`  5. 假主持人     ${fake ? '开着（不调用 AI）' : '关着'}`);
  const choice = await ask('要改哪一项？输入编号再按回车（直接回车退出）：');
  if (choice === null || choice === '' || choice === '0') break;
  if (choice === '1') changed = (await editKey('claude')) || changed;
  else if (choice === '2') changed = (await editKey('deepseek')) || changed;
  else if (choice === '3') changed = (await editKey('openrouter')) || changed;
  else if (choice === '4') changed = (await editKey('relay')) || changed;
  else if (choice === '5') changed = (await toggleFake()) || changed;
  else say('只能输入 1 到 5。');
}

if (changed) {
  const port = Number(envValue(readEnv(), 'PORT')) || 3000;
  const { serverRunning } = await import('./upgrade.mjs');
  say();
  if (await serverRunning(port)) say('服务器正开着：关掉它的黑色窗口，再双击 start.bat（Mac 是 start.command），改的才生效。');
  else say('下次启动服务器时生效。');
}
say();
bye();
