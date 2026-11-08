import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../server/ai/client';
import { createApp, type App, type AppOptions } from '../server/app';
import { seedTestData, TEST_SCENARIO_DIR } from '../server/seed-data';

// 自动测试共用的小工具：用临时数据库启动一个完整的服务器，像浏览器一样调用接口。

export type Res = { status: number; data: any; cookie: string | null };
export type Event = { event: string; data: any };

/** 自带的剧本加上测试剧本《雾港旅店》，复制到测试自己的文件夹里：上传、删除剧本不会动到项目里的文件。 */
export function testScenarioDir(dir: string): string {
  const out = path.join(dir, 'scenarios');
  fs.mkdirSync(out, { recursive: true });
  for (const from of [path.resolve(import.meta.dirname, '..', 'scenarios'), TEST_SCENARIO_DIR]) {
    for (const f of fs.readdirSync(from).filter((name) => name.endsWith('.json'))) fs.copyFileSync(path.join(from, f), path.join(out, f));
  }
  return out;
}

/**
 * 四项都用 Opus 5.5：V0.4.1 以前的默认。有些测试的数字（花费、额度用完的时机）是照 Opus 的价格写的，用它们照旧。
 * V0.4.1 起默认四项都用 DeepSeek V4.1 Flash 1017（DEFAULT_AI_SETTINGS）。
 */
export const OPUS_SETTINGS: AiSettings = {
  ...DEFAULT_AI_SETTINGS,
  models: { dm: 'claude-opus-5-5', scenario: 'claude-opus-5-5', misc: 'claude-opus-5-5', guard: 'claude-opus-5-5', guide: 'claude-opus-5-5', review: 'claude-opus-5-5' },
};

/**
 * 数据库第 22 版（V0.9.1、V0.9.2）。测以前的升级时只升级到这里（openDatabase 的 upTo）：
 * 第 23 版（V1.0.0 正式版）的删档会把要看的数据清掉，删档另外在 v100.test.ts 里测。
 */
export const BEFORE_WIPE = 22;

export async function startTestApp(options: Partial<AppOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-test-'));
  // 频率限制默认关掉（测试一下子发很多请求）；专门测限制的测试再打开
  const app: App = createApp({
    dbPath: path.join(dir, 'test.db'),
    webDist: path.join(dir, 'dist'),
    scenarioDir: testScenarioDir(dir),
    rateLimits: false,
    // 隐藏成就看几点玩完、玩得多快：以前的测试里的数字会对不上，默认关掉（专门的测试再打开）
    hiddenAchievements: false,
    // 每天自动备份（V0.8.0）：测试里不备份（专门的测试再打开）
    autoBackup: false,
    ...options,
  });
  // V0.4.5 起普通用户开的局只能选站长允许的主持模型（默认只有 DeepSeek 的）。以前的测试按以前的规矩：什么模型都能选；
  // 专门测这条规矩的测试（v045）自己改回来
  app.db.prepare("INSERT INTO settings (key, value) VALUES ('dm_models_user', '\"all\"') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  // V0.5.0 起大厅聊天每人每 5 秒才能说一句。以前的测试一下子发好几句：不限；专门测这条规矩的测试（v050）自己改回来
  app.db.prepare("INSERT INTO settings (key, value) VALUES ('lobby_slow_seconds', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  // 测试账号的注册时间按测试用的时钟记（用真的时间的话，测试里的时钟比现在早时，公告之类的先后就对不上了）
  const seeded = await seedTestData(app.db, options.now?.());
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const streams: { close: () => void }[] = [];

  async function call(method: string, url: string, body?: unknown, cookie?: string): Promise<Res> {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie()[0];
    return { status: res.status, data: text ? JSON.parse(text) : null, cookie: setCookie ? setCookie.split(';')[0] : null };
  }

  async function login(username: string, password: string): Promise<string> {
    const res = await call('POST', '/api/auth/login', { username, password });
    assert.equal(res.status, 200, `登录失败：${JSON.stringify(res.data)}`);
    assert.ok(res.cookie);
    return res.cookie;
  }

  /** 打开一条推送连接（也就是“在线”），收集收到的事件。 */
  async function openStream(url: string, cookie: string) {
    const controller = new AbortController();
    const res = await fetch(base + url, { headers: { cookie }, signal: controller.signal });
    assert.equal(res.status, 200);
    const events: Event[] = [];
    const waiters: { pred: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ended = false;
    let onEnd: () => void = () => {};
    const endedPromise = new Promise<void>((resolve) => (onEnd = resolve));
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            const parsed = { event, data: JSON.parse(data) };
            events.push(parsed);
            for (const w of [...waiters]) {
              if (w.pred(parsed)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(parsed);
              }
            }
          }
        }
      } catch {
        // 关闭连接时会走到这里
      }
      ended = true;
      onEnd();
    })();
    const stream = {
      events,
      /** 等一个满足条件的事件；from 之前收到的事件也算。 */
      waitFor(pred: (e: Event) => boolean, from = 0): Promise<Event> {
        const found = events.slice(from).find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          waiters.push({ pred, resolve });
          setTimeout(() => reject(new Error('等待推送超时')), 3000).unref();
        });
      },
      /** 服务器已经把这条连接关掉了。 */
      get ended() {
        return ended;
      },
      /** 等服务器关掉这条连接。 */
      waitEnded(): Promise<void> {
        return new Promise((resolve, reject) => {
          void endedPromise.then(resolve);
          setTimeout(() => reject(new Error('等连接关闭超时')), 3000).unref();
        });
      },
      close() {
        controller.abort();
      },
    };
    streams.push(stream);
    return stream;
  }

  async function close() {
    for (const s of streams) s.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { app, base, call, login, openStream, close, inviteCode: seeded.inviteCode };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
