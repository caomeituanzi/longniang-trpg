import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { CONFIG_ERROR_EXIT } from '../scripts/supervise.mjs';
import { DEFAULT_AI_SETTINGS, type AiSettings } from './ai/client';
import type { Effort } from './ai/types';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 读项目文件夹里的 .env 文件（API 密钥等设置放在这里，不会被打包、也不会上传）。
 * 已经在命令行里设置过的变量以命令行为准。
 */
function loadDotEnv(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // Windows 的记事本有时会在文件开头加一个看不见的 BOM，去掉它
  const values = parseEnv(text.replace(/^﻿/, '')) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

function fail(message: string): never {
  console.error(`\n${message}\n`);
  // 设置写错了，重启也没用：start.bat 看到这个退出码（78，见 scripts/supervise.mjs）就不自动重启（V0.8.0）
  process.exit(CONFIG_ERROR_EXIT);
}

function readPort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`PORT 设置得不对：「${raw}」。应该是 1 到 65535 之间的整数，比如 3001。`);
  }
  return port;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function readEffort(name: string, fallback: Effort): Effort {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!EFFORTS.includes(raw as Effort)) fail(`${name} 设置得不对：「${raw}」。只能是 ${EFFORTS.join('、')} 之一。`);
  return raw as Effort;
}

function readModel(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readProvider(): 'claude' | 'fake' {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === 'claude') return 'claude';
  if (raw === 'fake') return 'fake';
  return fail(`AI_PROVIDER 设置得不对：「${raw}」。平常不写；只想试流程、不调用任何 AI 时写 fake。`);
}

const aiSettings: AiSettings = {
  models: {
    dm: readModel('CLAUDE_DM_MODEL', DEFAULT_AI_SETTINGS.models.dm),
    scenario: readModel('CLAUDE_SCENARIO_MODEL', DEFAULT_AI_SETTINGS.models.scenario),
    misc: readModel('CLAUDE_MISC_MODEL', DEFAULT_AI_SETTINGS.models.misc),
    guard: readModel('CLAUDE_GUARD_MODEL', DEFAULT_AI_SETTINGS.models.guard),
    guide: readModel('CLAUDE_GUIDE_MODEL', DEFAULT_AI_SETTINGS.models.guide),
    review: readModel('CLAUDE_REVIEW_MODEL', DEFAULT_AI_SETTINGS.models.review),
  },
  effort: {
    dm: readEffort('CLAUDE_DM_EFFORT', DEFAULT_AI_SETTINGS.effort.dm),
    scenario: readEffort('CLAUDE_SCENARIO_EFFORT', DEFAULT_AI_SETTINGS.effort.scenario),
    misc: readEffort('CLAUDE_MISC_EFFORT', DEFAULT_AI_SETTINGS.effort.misc),
    guard: readEffort('CLAUDE_GUARD_EFFORT', DEFAULT_AI_SETTINGS.effort.guard),
    guide: readEffort('CLAUDE_GUIDE_EFFORT', DEFAULT_AI_SETTINGS.effort.guide),
    review: readEffort('CLAUDE_REVIEW_EFFORT', DEFAULT_AI_SETTINGS.effort.review),
  },
  // OpenRouter 上要用的模型，逗号隔开（管理员在网页上改过以后用网页上的）
  openrouterModels: (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
};

function readHstsMaxAge(): number | undefined {
  const raw = process.env.HSTS_MAX_AGE?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 63072000) {
    console.warn(`.env 里的 HSTS_MAX_AGE（${raw}）不对：要填 0～63072000 之间的整数（秒），先按默认的 180 天。`);
    return undefined;
  }
  return n;
}

export const config = {
  root: ROOT,
  port: readPort(),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? path.join(ROOT, 'data', 'game.db'),
  // 正式部署到 HTTPS 域名后设为 1，登录 Cookie 只走加密连接，并且告诉浏览器以后只用 HTTPS 访问
  secureCookies: process.env.COOKIE_SECURE === '1',
  // 正式上线后填网站的域名（多个用逗号隔开）：别的域名来的请求一律不处理
  siteHosts: (process.env.SITE_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  // HSTS 的有效期（秒）：访问者用 https 来的时候发，让浏览器以后只用 HTTPS。不填是 180 天，0 是不发
  hstsMaxAge: readHstsMaxAge(),
  // 浏览器推送（V0.8.0）的联系方式（邮箱或网址），推送服务有问题时找谁。不填就用 SITE_HOSTS 的第一个域名
  pushSubject: process.env.PUSH_SUBJECT?.trim() || undefined,
  dev: process.argv.includes('--dev'),
  webDir: path.join(ROOT, 'web'),
  webDist: path.join(ROOT, 'web', 'dist'),
  scenarioDir: path.join(ROOT, 'scenarios'),
  ai: {
    provider: readProvider(),
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined,
    // DeepSeek：设了密钥，管理页和开局时就能选 DeepSeek 的模型
    deepseekKey: process.env.DEEPSEEK_API_KEY?.trim() || undefined,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || undefined,
    // OpenRouter（或别家兼容 OpenAI 格式的服务，改 OPENROUTER_BASE_URL）：设了密钥，就能在管理页填要用的模型
    openrouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL?.trim() || undefined,
    // 中转站（V1.0.1）：兼容 OpenAI 格式的中转站，接口地址（RELAY_BASE_URL）和密钥都填了才能选 ChatGPT 的模型，没有默认的地址
    relayKey: process.env.RELAY_API_KEY?.trim() || undefined,
    relayBaseUrl: process.env.RELAY_BASE_URL?.trim() || undefined,
    settings: aiSettings,
  },
  // 测试用：现实时间快进60倍，行动的等待从15分钟变成15秒，游戏时钟也走得快60倍
  timeScale: process.env.QUICK_WAIT?.trim() === '1' ? 60 : 1,
};
