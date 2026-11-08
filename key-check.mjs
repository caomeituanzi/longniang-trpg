// 检查 API 密钥能不能用（start.bat 第一次问密钥、api-keys.bat 换密钥时用）。只用 Node 自带的功能。
// 每个检查返回：ok 是 true 能用；ok 是 false 带着原因（message）；ok 是 null 是连不上，没法检查（custom：用的是自己设的接口地址）。

import util from 'node:util';

/** 设置文件里某一项的值（没写、或者被 # 注释掉了是空字符串）。和服务器一样用 Node 自带的 parseEnv 读，行尾的 # 注释不算在值里。 */
export function envValue(text, key) {
  try {
    return String(util.parseEnv(text)[key] ?? '').trim();
  } catch {
    return '';
  }
}

async function getJson(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  } catch {
    return null;
  }
}

/** Claude：问一下有哪些模型，不花钱。密钥能用于好几个工作区时 workspace 是 true，要问用哪一个。 */
export async function checkClaude(key, workspace, env) {
  const base = (envValue(env, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const r = await getJson(`${base}/v1/models?limit=1`, {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    ...(workspace ? { 'anthropic-workspace-id': workspace } : {}),
  });
  if (!r) return { ok: null };
  if (r.ok) return { ok: true };
  const message = String(r.body?.error?.message ?? '');
  if (message.includes('anthropic-workspace-id')) return { ok: false, workspace: true };
  if (r.status === 401) return { ok: false, message: '这个密钥不对（Claude 说认证失败）。' };
  if (r.status === 403) return { ok: false, message: `Claude 拒绝了：没有权限，或者所在地区不在服务范围内。（${message}）` };
  return { ok: false, message: `Claude 返回了错误 ${r.status}。（${message}）` };
}

/** DeepSeek：问一下有哪些模型，不花钱（余额是 0 也能通过，充值另外看）。 */
export async function checkDeepSeek(key, env) {
  // 用了自己的接口地址（转发服务这类）：没法照官方的检查
  if (envValue(env, 'DEEPSEEK_BASE_URL')) return { ok: null, custom: true };
  const r = await getJson('https://api.deepseek.com/models', { Authorization: `Bearer ${key}` });
  if (!r) return { ok: null };
  if (r.ok) return { ok: true };
  if (r.status === 401) return { ok: false, message: '这个密钥不对（DeepSeek 说认证失败）。' };
  return { ok: false, message: `DeepSeek 返回了错误 ${r.status}。（${String(r.body?.error?.message ?? '')}）` };
}

/** OpenRouter：查这个密钥的花费上限；别家兼容的服务查模型列表。 */
export async function checkOpenRouter(key, env) {
  const base = (envValue(env, 'OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const official = /^https:\/\/openrouter\.ai\//.test(`${base}/`);
  const r = await getJson(official ? `${base}/key` : `${base}/models`, { Authorization: `Bearer ${key}` });
  if (!r) return { ok: null };
  if (r.ok) {
    const data = r.body?.data;
    if (!official || !data) return { ok: true };
    const money = (n) => `$${Number(n).toFixed(2)}`;
    const limit =
      typeof data.limit === 'number'
        ? `这个密钥的花费上限 ${money(data.limit)}${typeof data.limit_remaining === 'number' ? `，还剩 ${money(data.limit_remaining)}` : ''}。`
        : '这个密钥没设花费上限：可以在 OpenRouter 网站的 Keys 页面给它设一个。';
    return { ok: true, note: limit };
  }
  if (r.status === 401) return { ok: false, message: '这个密钥不对（OpenRouter 说认证失败）。' };
  return { ok: false, message: `返回了错误 ${r.status}。（${String(r.body?.error?.message ?? '')}）` };
}

/** 中转站（V1.0.1）：问一下有哪些模型，不花钱。接口地址（RELAY_BASE_URL）没有默认的，没填就检查不了。 */
export async function checkRelay(key, env) {
  const base = envValue(env, 'RELAY_BASE_URL').replace(/\/+$/, '');
  if (!base) return { ok: false, message: '还没有写中转站的接口地址（.env 的 RELAY_BASE_URL）。' };
  const r = await getJson(`${base}/models`, { Authorization: `Bearer ${key}` });
  if (!r) return { ok: null };
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, message: '这个密钥不对（中转站说认证失败）。' };
  return { ok: false, message: `中转站返回了错误 ${r.status}。（${String(r.body?.error?.message ?? '')}）` };
}

/** 四家的密钥：写在 .env 的哪一项、去哪里创建、长什么样。 */
export const KEYS = {
  claude: {
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    where: '在 https://platform.claude.com/settings/keys 创建，以 sk-ant- 开头',
    looksRight: (k) => k.startsWith('sk-ant-'),
    wrongShape: '这个看起来不像 Claude 的密钥（应该以 sk-ant- 开头）。',
  },
  deepseek: {
    label: 'DeepSeek',
    env: 'DEEPSEEK_API_KEY',
    where: '在 https://platform.deepseek.com 的 API keys 页面创建，以 sk- 开头',
    looksRight: (k) => k.startsWith('sk-') && !k.startsWith('sk-ant-') && !k.startsWith('sk-or-'),
    wrongShape: '这个看起来不像 DeepSeek 的密钥（以 sk- 开头；sk-ant- 开头的是 Claude 的，sk-or- 开头的是 OpenRouter 的）。',
  },
  openrouter: {
    label: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    where: '在 OpenRouter 网站的 Keys 页面创建，以 sk-or- 开头',
    // 别家兼容的服务（改了 OPENROUTER_BASE_URL）的密钥不一定是这个样子
    looksRight: (k, env) => k.startsWith('sk-or-') || !!envValue(env, 'OPENROUTER_BASE_URL'),
    wrongShape: '这个看起来不像 OpenRouter 的密钥（应该以 sk-or- 开头）。',
  },
  relay: {
    label: '中转站',
    env: 'RELAY_API_KEY',
    where: '在你用的中转站的网站上创建',
    // 各家中转站的密钥长得不一样：不是 Claude、OpenRouter 的就行
    looksRight: (k) => k.length >= 8 && !k.startsWith('sk-ant-') && !k.startsWith('sk-or-'),
    wrongShape: '这个看起来不像中转站的密钥（sk-ant- 开头的是 Claude 的，sk-or- 开头的是 OpenRouter 的）。',
  },
};
