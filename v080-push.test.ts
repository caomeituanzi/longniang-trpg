// 时间按东京算（sw.js 把约团的时间按设备的本地时间写）
process.env.TZ = 'Asia/Tokyo';
// V0.8.0：浏览器推送（Web Push）：RFC 8291 加密、RFC 8292 VAPID、推送地址白名单、订阅和设备、推哪几类、
// 什么时候推（通知、私信、回合等你）、推送服务说订阅没了就删、游客和被封的不推、发一条试试、sw.js。

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, test } from 'node:test';
import { FakeProvider, say } from '../server/ai/fake';
import type { MessagesRequest, MessagesResponse, TextBlock } from '../server/ai/types';
import { SESSION_COOKIE, sessionId } from '../server/auth';
import { transaction } from '../server/db';
import { DM_PUSH_INTERVAL_MS, deviceLabel, endpointHash, JWT_CACHE_MAX, Push, QUEUE_PER_USER, scrubPushSecrets, SEND_TIMEOUT_MS, TURN_DELAY_MS } from '../server/push';
import { TEST_ACCOUNTS } from '../server/seed-data';
import {
  decryptPayload,
  encryptPayload,
  generateVapid,
  loadVapid,
  pushServiceHost,
  vapidAuthorization,
  vapidJwt,
  vapidSubject,
  type PushRequest,
} from '../server/webpush';
import { startTestApp } from './helpers';

const [ADMIN, T1, T2] = TEST_ACCOUNTS;
const MIN = 60_000;
const ROOT = path.resolve(import.meta.dirname, '..');
let now = Date.UTC(2026, 9, 28, 3, 0, 0);

// ==================== 纯函数：加密、VAPID、白名单 ====================

const b64 = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291 附录 A 的测试向量
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  content:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('加密：RFC 8291 附录 A 的测试向量逐字节一致；按 RFC 8188 解密得回原文', () => {
  const body = encryptPayload(b64(RFC.plaintext), RFC.uaPublic, RFC.auth, { salt: b64(RFC.salt), serverPrivateKey: b64(RFC.asPrivate) });
  assert.equal(body.toString('base64url'), RFC.content);
  // 头部：salt | rs = 4096 | idlen = 65 | 服务器这次的临时公钥
  assert.equal(body.subarray(0, 16).toString('base64url'), RFC.salt);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(body.subarray(21, 86).toString('base64url'), RFC.asPublic);
  assert.equal(decryptPayload(b64(RFC.content), RFC.uaPrivate, RFC.auth).toString(), 'When I grow up, I want to be a watermelon');
});

test('加密往返：随机的浏览器密钥、随机的 salt 和临时密钥，中文内容解密回来一样；每次加密的结果都不一样；密钥不对解不开', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const text = JSON.stringify({ title: '轮到你了', body: '「雾港旅店」就等你交行动了', url: '/room/1' });
  const a = encryptPayload(text, ua.getPublicKey(), auth);
  const b = encryptPayload(text, ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  assert.notEqual(a.toString('hex'), b.toString('hex'), '每次的 salt 和临时密钥都是新的');
  for (const body of [a, b]) assert.equal(decryptPayload(body, ua.getPrivateKey(), auth).toString(), text);
  assert.throws(() => decryptPayload(a, ua.getPrivateKey(), crypto.randomBytes(16)), 'auth 不对解不开');
  // 太长的不加密（一段最多 4096 字节）
  assert.throws(() => encryptPayload(Buffer.alloc(4080), ua.getPublicKey(), auth), /太长/);
  // 浏览器的公钥、auth 长度不对
  assert.throws(() => encryptPayload('x', crypto.randomBytes(64), auth));
  assert.throws(() => encryptPayload('x', ua.getPublicKey(), crypto.randomBytes(15)));
});

test('VAPID：生成、存取；JWT 用公钥验得过签名，aud 是推送服务的 origin、exp 是 12 小时以后、sub 是联系方式；Authorization 头带着公钥', () => {
  const stored = generateVapid();
  assert.equal(b64(stored.publicKey).length, 65);
  assert.equal(b64(stored.publicKey)[0], 4);
  const keys = loadVapid(JSON.parse(JSON.stringify(stored)));
  assert.equal(keys.publicKey, stored.publicKey);
  assert.throws(() => loadVapid({ ...stored, publicKey: generateVapid().publicKey }), /对不上/);

  const at = Date.UTC(2026, 9, 28, 12, 0, 0);
  const jwt = vapidJwt(keys.privateKey, 'https://fcm.googleapis.com', 'https://trpg.example.com', at);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64(h).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b64(p).toString()), { aud: 'https://fcm.googleapis.com', exp: at / 1000 + 12 * 3600, sub: 'https://trpg.example.com' });
  assert.equal(b64(s).length, 64, 'ES256 的签名是 r|s 64 字节');
  const point = b64(stored.publicKey);
  const publicKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(s)));
  assert.ok(!crypto.verify('sha256', Buffer.from(`${h}.${p}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(s)));

  const header = vapidAuthorization(keys, 'https://web.push.apple.com', 'mailto:a@b.c', at);
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.ok(header.endsWith(`, k=${stored.publicKey}`));

  // 联系方式：PUSH_SUBJECT（只写邮箱的补 mailto:）→ 网站的域名 → mailto:admin@localhost
  assert.equal(vapidSubject('mailto:me@example.com', ['trpg.example.com']), 'mailto:me@example.com');
  assert.equal(vapidSubject('me@example.com'), 'mailto:me@example.com');
  assert.equal(vapidSubject('https://trpg.example.com'), 'https://trpg.example.com');
  assert.equal(vapidSubject(undefined, [' TRPG.example.com ', 'b.example.com']), 'https://trpg.example.com');
  assert.equal(vapidSubject('  ', []), 'mailto:admin@localhost');
});

test('推送地址白名单：只要 https、这几家推送服务、默认端口；别的地址（内网、别的域名、http、超长）都不要', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://push.services.mozilla.com/x'.replace('push.', 'a.push.'),
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%3d',
    'https://db5p.notify.windows.com/w/?token=BQYAAAB%3d',
    'https://web.push.apple.com/QGxyz',
    'https://api.push.apple.com/3/device/x',
  ];
  for (const url of ok) assert.ok(pushServiceHost(url), url);
  const bad = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com/x',
    'https://notify.windows.com/x',
    'https://a.b.notify.windows.com/w/?token=x',
    'https://-x.notify.windows.com/w/?token=x',
    'https://x-.notify.windows.com/w/?token=x',
    'https://deep.sub.push.apple.com/x',
    'https://a.b.push.services.mozilla.com/x',
    'https://' + 'x'.repeat(64) + '.notify.windows.com/x',
    'https://push.apple.com.evil.example/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://192.168.1.10/x',
    'https://example.com/x',
    'ftp://fcm.googleapis.com/x',
    'https://fcm.googleapis.com/a b',
    'https://fcm.googleapis.com/' + 'a'.repeat(2000),
    'not a url',
    '',
  ];
  for (const url of bad) assert.equal(pushServiceHost(url), null, url);
});

test('设备名：从浏览器标识粗略认出来，认不出是「浏览器」', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Windows · Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Windows · Edge'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPhone · Safari'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Android · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Mac · Safari'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Linux · Firefox'],
    ['node', '浏览器'],
    ['', '浏览器'],
  ];
  for (const [ua, label] of cases) assert.equal(deviceLabel(ua), label, ua);
  assert.equal(deviceLabel(undefined), '浏览器');
});

// ==================== sw.js ====================

/** 在一个假的 Service Worker 环境里跑 web/public/sw.js。 */
function loadServiceWorker() {
  const handlers: Record<string, (event: any) => void> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const windows: any[] = [];
  /** sw.js 发的请求；GET /api/push 回的内容。 */
  const fetched: { url: string; method: string; body: any }[] = [];
  let pushInfo: unknown = { publicKey: 'BAAA' };
  /** 重新订阅时用的选项；订阅出来的新订阅。 */
  const subscribed: any[] = [];
  const fresh = { endpoint: 'https://fcm.googleapis.com/fcm/send/new', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } }) };
  const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    fetched.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => pushInfo };
  };
  /** 不用真的 MessagePort（会让测试进程关不掉）。 */
  class FakeChannel {
    port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    port2 = { postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
  }
  const self: any = {
    location: { origin: 'https://trpg.example.com' },
    addEventListener: (name: string, fn: (event: any) => void) => (handlers[name] = fn),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: {
      showNotification: async (title: string, options: any) => void shown.push({ title, options }),
      pushManager: {
        subscribe: async (options: any) => {
          subscribed.push(options);
          return fresh;
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'web', 'public', 'sw.js'), 'utf8'), { self, URL, MessageChannel: FakeChannel, setTimeout, clearTimeout, fetch, atob });
  async function fire(name: string, event: any) {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  }
  return {
    shown,
    opened,
    windows,
    fetched,
    subscribed,
    setPushInfo: (value: unknown) => (pushInfo = value),
    push: (data: unknown) => fire('push', { data: { json: () => data } }),
    click: (url: unknown) => fire('notificationclick', { notification: { data: { url }, close: () => undefined } }),
    change: (oldSubscription: unknown, newSubscription: unknown) => fire('pushsubscriptionchange', { oldSubscription, newSubscription }),
  };
}

test('sw.js：页面开在前台不弹（always 的照样弹）；约团的时间按设备的本地时间写；点了通知切到开着的页面、让它自己换页，没有页面就开一个；站外地址不认', async () => {
  const sw = loadServiceWorker();
  const startsAt = Date.UTC(2026, 9, 30, 11, 0, 0); // 东京时间 10月30日 周五 20:00
  await sw.push({ title: '快开团了', body: '「雾港旅店」{time} 开始', url: '/room/3', tag: 'schedule-3', startsAt });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, '快开团了');
  assert.equal(sw.shown[0].options.body, '「雾港旅店」10月30日 周五 20:00 开始');
  assert.equal(sw.shown[0].options.icon, '/icon-192.png');
  assert.equal(sw.shown[0].options.tag, 'schedule-3');
  assert.equal(sw.shown[0].options.renotify, false, '没说要响的，替换的时候不再响');
  assert.deepEqual({ ...sw.shown[0].options.data }, { url: '/room/3' });

  // 有一个页面开在前台：不弹；always 的照样弹
  const page = {
    focused: true,
    visibilityState: 'visible',
    focusCalls: 0,
    messages: [] as unknown[],
    reply: true,
    navigated: [] as string[],
    async focus() {
      this.focusCalls++;
    },
    postMessage(message: unknown, ports: { postMessage: (m: unknown) => void }[]) {
      this.messages.push(message);
      if (this.reply) ports[0].postMessage('ok');
    },
    async navigate(url: string) {
      this.navigated.push(url);
    },
  };
  sw.windows.push(page);
  await sw.push({ title: '轮到你了', body: '就等你了', url: '/room/3', tag: 'turn-3' });
  assert.equal(sw.shown.length, 1, '页面在前台，不弹');
  await sw.push({ title: '龙娘跑团', body: '通知能收到了', url: '/account', tag: 'push-test', always: true, renotify: true });
  assert.equal(sw.shown.length, 2, 'always 的照样弹');
  assert.equal(sw.shown[1].options.renotify, true);
  page.focused = false;
  await sw.push({ title: '轮到你了', body: '就等你了', url: '/room/3' });
  assert.equal(sw.shown.length, 3, '页面不在前台，弹');
  assert.equal(sw.shown[2].options.tag, undefined);
  // 内容坏了也弹一条（不让浏览器替我们弹「网站在后台更新了」）
  await sw.push(null);
  assert.equal(sw.shown[3].title, '龙娘跑团');
  assert.deepEqual({ ...sw.shown[3].options.data }, { url: '/' });

  // 点了：切到开着的页面，让它自己换页
  await sw.click('/friends/p-abc');
  assert.equal(page.focusCalls, 1);
  // （sw.js 里建的对象是另一个运行环境的，比较前换成这边的）
  assert.deepEqual(JSON.parse(JSON.stringify(page.messages)), [{ type: 'push-open', url: '/friends/p-abc' }]);
  assert.deepEqual(page.navigated, []);
  // 页面没回应（旧的页面）：让浏览器打开那个地址
  page.reply = false;
  await sw.click('/room/3');
  assert.deepEqual(page.navigated, ['/room/3']);
  // 站外的地址不认，回首页
  page.reply = true;
  const evil = ['https://evil.example/', '//evil.example/x', '/\t/evil.example', '/\n/evil.example', '/\\evil.example', '\t//evil.example', 'javascript:alert(1)'];
  for (const url of evil) await sw.click(url);
  assert.deepEqual(
    page.messages.slice(-evil.length).map((m: any) => m.url),
    evil.map(() => '/'),
  );
  // 站内的照原样（查询、#）
  await sw.click('/room/3?tab=log#x');
  assert.equal((page.messages.at(-1) as any).url, '/room/3?tab=log#x');
  // 没有开着的页面：开一个新的
  sw.windows.length = 0;
  await sw.click('/notifications');
  assert.deepEqual(sw.opened, ['/notifications']);
});

test('sw.js：推送地址换了（pushsubscriptionchange）：用原来的选项重新订阅，交给服务器，删掉原来的地址；原来的选项拿不到就问服务器要公钥；失败就算了', async () => {
  const sw = loadServiceWorker();
  const key = new Uint8Array([4, 1, 2, 3]);
  const oldSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: { applicationServerKey: key } };
  await sw.change(oldSub, null);
  assert.equal(sw.subscribed.length, 1);
  assert.equal(sw.subscribed[0].userVisibleOnly, true);
  assert.equal(sw.subscribed[0].applicationServerKey, key, '用原来的公钥');
  assert.deepEqual(
    sw.fetched.map((f) => [f.method, f.url, f.body]),
    [
      ['POST', '/api/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } }],
      ['DELETE', '/api/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/old' }],
    ],
  );

  // 浏览器已经给了新的订阅：不用再订阅，直接交
  sw.fetched.length = 0;
  const given = { endpoint: 'https://fcm.googleapis.com/fcm/send/given', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/given', keys: {} }) };
  await sw.change(null, given);
  assert.equal(sw.subscribed.length, 1);
  assert.deepEqual(
    sw.fetched.map((f) => [f.method, f.body.endpoint]),
    [['POST', 'https://fcm.googleapis.com/fcm/send/given']],
  );

  // 原来的选项拿不到：问服务器要公钥（base64url 换成字节）
  sw.fetched.length = 0;
  sw.setPushInfo({ publicKey: 'BAECAw' });
  await sw.change({ endpoint: 'https://fcm.googleapis.com/fcm/send/old2', options: {} }, null);
  assert.equal(sw.fetched[0].url, '/api/push');
  assert.deepEqual([...sw.subscribed[1].applicationServerKey], [4, 1, 2, 3]);
  assert.equal(sw.fetched[1].method, 'POST');

  // 服务器不给（没登录）：算了，不抛错
  sw.fetched.length = 0;
  sw.setPushInfo(null);
  await sw.change(null, null);
  assert.equal(sw.subscribed.length, 2, '没有公钥，不订阅');
});

// ==================== 接口和什么时候推 ====================

function userText(req: MessagesRequest): string {
  const content = req.messages[0].content as string | TextBlock[];
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 假主持人：估时看行动里写的 [分钟 N]；结算只写一句叙述。 */
const fake = new FakeProvider(async (req): Promise<MessagesResponse> => {
  if (req.output_config?.format) {
    const minutes = Number(userText(req).match(/\[分钟 (\d+)\]/)?.[1] ?? 30);
    return say(JSON.stringify({ minutes, reason: '测试' }));
  }
  return say('叙述：照做了。');
});

/** 发出去的推送（假的推送服务收下的）；statusFor 决定推送服务回什么。 */
const sent: PushRequest[] = [];
let statusFor: (endpoint: string) => number = () => 201;

type Device = { endpoint: string; p256dh: string; auth: string; priv: Buffer };
const devices = new Map<string, Device>();

function newDevice(base = 'https://fcm.googleapis.com/fcm/send/'): Device {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const d = {
    endpoint: base + crypto.randomBytes(24).toString('base64url'),
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
    priv: ecdh.getPrivateKey(),
  };
  devices.set(d.endpoint, d);
  return d;
}

/** 推给浏览器的内容（用浏览器的私钥解开）。 */
function opened(req: PushRequest): any {
  const d = devices.get(req.endpoint);
  assert.ok(d, '发给了不认识的地址');
  return JSON.parse(decryptPayload(req.body, d.priv, d.auth).toString('utf8'));
}

let t: Awaited<ReturnType<typeof startTestApp>>;
let c: Record<'admin' | 't1' | 't2' | 'guest', string>;
type Who = keyof typeof c;
let dist: string;
const ids: Record<string, number> = {};
const publicIds: Record<string, string> = {};

before(async () => {
  // 网页的文件：只要 index.html 和原样复制的 sw.js、manifest（看服务器给的类型对不对）
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-push-web-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>龙娘跑团</title>');
  for (const f of ['sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, 'web', 'public', f), path.join(dist, f));
  t = await startTestApp({
    ai: fake,
    now: () => now,
    rng: () => 3,
    tickMs: 0,
    webDist: dist,
    pushSubject: 'mailto:owner@example.com',
    pushSend: async (req) => {
      sent.push(req);
      return { status: statusFor(req.endpoint) };
    },
  });
  c = {
    admin: await t.login(ADMIN.username, ADMIN.password),
    t1: await t.login(T1.username, T1.password),
    t2: await t.login(T2.username, T2.password),
    guest: (await t.call('POST', '/api/auth/guest')).cookie!,
  };
  for (const a of [ADMIN, T1, T2]) {
    const row = t.app.db.prepare('SELECT id, public_id FROM users WHERE username = ?').get(a.username) as { id: number; public_id: string };
    ids[a.username] = row.id;
    publicIds[a.username] = row.public_id;
  }
});
after(async () => {
  await t.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

const sub = (who: Who, d: Device, extra: Record<string, unknown> = {}) =>
  t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth }, ...extra }, c[who]);
/** GET /api/push；带着这台设备推送地址的哈希（网页也是这样问的，推送地址不进网址）。 */
const info = async (who: Who, endpoint?: string) =>
  (await t.call('GET', `/api/push${endpoint ? `?device=${endpointHash(endpoint)}` : ''}`, undefined, c[who])).data;
/** 等推送排完队、发完，返回这次新发出去的。 */
async function flush(): Promise<PushRequest[]> {
  await t.app.push.idle();
  return sent.splice(0);
}

test('网站文件：/manifest.webmanifest 是 application/manifest+json，/sw.js 是 JavaScript', async () => {
  const manifest = await fetch(`${t.base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  const m = await manifest.json();
  assert.equal(m.name, '龙娘跑团');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i: { src: string }) => i.src === '/icon-192.png'));
  const sw = await fetch(`${t.base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'sw.js 不长期缓存（改了要马上生效）');
  await sw.text();
  // 页面里引用了 manifest
  assert.match(fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'), /<link rel="manifest" href="\/manifest\.webmanifest"/);
});

test('游客 403；没登录 401', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/push', undefined],
    ['POST', '/api/push/subscriptions', { endpoint: newDevice().endpoint, keys: {} }],
    ['DELETE', '/api/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/x' }],
    ['DELETE', '/api/push/devices/1', undefined],
    ['PUT', '/api/push/prefs', { dm: false }],
    ['POST', '/api/push/test', undefined],
  ] as const) {
    assert.equal((await t.call(method, url, body, c.guest)).status, 403, `${method} ${url}`);
    assert.equal((await t.call(method, url, body)).status, 401, `${method} ${url}`);
  }
});

test('订阅：公钥、默认推哪几类；白名单外的地址、http、超长、密钥不对都拒绝；设备名从浏览器标识认；标出这台；换账号接管同一个地址；每人最多 10 台；删除', async () => {
  const first = await info('t1');
  assert.equal(b64(first.publicKey).length, 65);
  assert.deepEqual(first.prefs, { schedule: true, started: true, turn: true, dm: true, invites: true, other: false });
  assert.deepEqual(first.devices, []);
  assert.equal((await info('t2')).publicKey, first.publicKey, '全站一对密钥');

  const d = newDevice();
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/abc', 'https://evil.example/push', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com/' + 'x'.repeat(2001)]) {
    const r = await sub('t1', { ...d, endpoint });
    assert.equal(r.status, 400, endpoint.slice(0, 60));
  }
  assert.equal((await sub('t1', { ...d, endpoint: 'https://evil.example/push' })).data.error, '这个浏览器的推送服务用不了');
  // 密钥：长度不对、不是曲线上的点、不是字符串
  const badPoint = b64(d.p256dh);
  badPoint[64] ^= 1;
  for (const keys of [
    { p256dh: d.p256dh.slice(0, 40), auth: d.auth },
    { p256dh: badPoint.toString('base64url'), auth: d.auth },
    { p256dh: d.p256dh, auth: d.auth + 'AAAA' },
    { p256dh: 123, auth: d.auth },
    {},
  ]) {
    assert.equal((await t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys }, c.t1)).status, 400, JSON.stringify(keys).slice(0, 60));
  }
  assert.equal((await t.call('POST', '/api/push/subscriptions', 'x', c.t1)).status, 400);

  // 设备名从 User-Agent 认
  const res = await fetch(`${t.base}/api/push/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: c.t1,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()).device;
  assert.equal(created.label, 'Windows · Chrome');
  assert.equal(created.current, true);
  assert.equal(created.lastOkAt, null);
  let mine = await info('t1', d.endpoint);
  assert.equal(mine.devices.length, 1);
  assert.equal(mine.devices[0].current, true);
  assert.equal((await info('t1')).devices[0].current, undefined, '没带地址就不标');
  assert.equal((await info('t1', 'https://fcm.googleapis.com/fcm/send/other')).devices[0].current, undefined);
  // 推送地址本身放在网址里：不认（只认哈希）
  assert.equal((await t.call('GET', `/api/push?endpoint=${encodeURIComponent(d.endpoint)}`, undefined, c.t1)).data.devices[0].current, undefined);
  assert.equal((await t.call('GET', `/api/push?device=${encodeURIComponent(d.endpoint)}`, undefined, c.t1)).data.devices[0].current, undefined);

  // 只知道推送地址、密钥不一样（不是同一个浏览器）：抢不走
  const thief = newDevice();
  const grab = await t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: thief.p256dh, auth: thief.auth } }, c.t2);
  assert.equal(grab.status, 409);
  assert.equal(grab.data.error, '这个浏览器的通知已经在别的账号上打开了');
  assert.equal((await info('t1', d.endpoint)).devices[0].current, true, '还是 t1 的');
  const halfKeys = await t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: thief.auth } }, c.t2);
  assert.equal(halfKeys.status, 409, 'auth 不一样也不行');
  // 自己的设备换了密钥（同一个账号）：照样能交
  const rekey = newDevice();
  assert.equal((await t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: rekey.p256dh, auth: rekey.auth } }, c.t1)).status, 201);
  assert.equal((await t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, c.t1)).status, 201);

  // 同一个浏览器换了账号（密钥一样）：归新账号
  now += MIN;
  assert.equal((await sub('t2', d)).status, 201);
  assert.equal((await info('t1')).devices.length, 0);
  mine = await info('t2', d.endpoint);
  assert.equal(mine.devices.length, 1);
  assert.equal(mine.devices[0].createdAt, now);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(d.endpoint) as { n: number }).n, 1);
  // 再订阅一次（同一个账号）：不重复
  assert.equal((await sub('t2', d)).status, 201);
  assert.equal((await info('t2')).devices.length, 1);

  // 每人最多 10 台：第 11 台挤掉最旧的
  const many: Device[] = [];
  for (let i = 0; i < 11; i++) {
    now += 1000;
    const x = newDevice(i % 2 ? 'https://updates.push.services.mozilla.com/wpush/v2/' : 'https://wns2-par02p.notify.windows.com/w/?token=');
    many.push(x);
    assert.equal((await sub('t1', x)).status, 201);
  }
  const ten = (await info('t1')).devices;
  assert.equal(ten.length, 10);
  const endpoints = (t.app.db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(ids.tester1) as { endpoint: string }[]).map((r) => r.endpoint);
  assert.ok(!endpoints.includes(many[0].endpoint), '最旧的那台删掉了');
  assert.ok(endpoints.includes(many[10].endpoint));
  assert.ok(ten[0].createdAt >= ten[9].createdAt, '新的在前');

  // 关掉这台：按地址删（只删自己的）；在列表里删一台；删别人的设备 404
  assert.equal((await t.call('DELETE', '/api/push/subscriptions', { endpoint: many[10].endpoint }, c.t2)).status, 200);
  assert.equal((await info('t1')).devices.length, 10, '别人删不掉我的');
  assert.equal((await t.call('DELETE', '/api/push/subscriptions', { endpoint: many[10].endpoint }, c.t1)).status, 200);
  assert.equal((await info('t1')).devices.length, 9);
  assert.equal((await t.call('DELETE', '/api/push/subscriptions', { endpoint: many[10].endpoint }, c.t1)).status, 200, '已经没有了也算关掉了');
  assert.equal((await t.call('DELETE', '/api/push/subscriptions', {}, c.t1)).status, 400);
  const someone = (await info('t1')).devices[0];
  assert.equal((await t.call('DELETE', `/api/push/devices/${someone.id}`, undefined, c.t2)).status, 404);
  assert.equal((await t.call('DELETE', `/api/push/devices/${someone.id}`, undefined, c.t1)).status, 200);
  assert.equal((await t.call('DELETE', `/api/push/devices/${someone.id}`, undefined, c.t1)).status, 404);
  assert.equal((await info('t1')).devices.length, 8);
  // 收拾干净：t1 不留设备
  t.app.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(ids.tester1);
  await flush();
});

test('推哪几类：改一部分，别的不变；不认识的类、不是开关的值、空的都拒绝', async () => {
  let r = await t.call('PUT', '/api/push/prefs', { other: true, dm: false }, c.t1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.prefs, { schedule: true, started: true, turn: true, dm: false, invites: true, other: true });
  r = await t.call('PUT', '/api/push/prefs', { dm: true }, c.t1);
  assert.deepEqual(r.data.prefs, { schedule: true, started: true, turn: true, dm: true, invites: true, other: true });
  assert.deepEqual((await info('t1')).prefs, r.data.prefs);
  assert.deepEqual((await info('t2')).prefs.other, false, '别人的不变');
  for (const body of [{ email: true }, { dm: 'yes' }, { dm: 1 }, {}, [], 'x']) {
    assert.equal((await t.call('PUT', '/api/push/prefs', body, c.t1)).status, 400, JSON.stringify(body));
  }
  // 恢复默认
  assert.equal((await t.call('PUT', '/api/push/prefs', { other: false }, c.t1)).status, 200);
});

test('通知：按勾的类别推，开着网站也推（快开团的提醒页面在前台也弹）；关掉的那一类不推；推送服务收到的请求头、加密都对；推送服务说订阅没了就删', async () => {
  const d = newDevice();
  const apple = newDevice('https://web.push.apple.com/');
  assert.equal((await sub('t1', d)).status, 201);
  assert.equal((await sub('t1', apple)).status, 201);
  const social = t.app.social;
  const roomData = { roomId: 7, roomName: '雾港旅店' };

  // 不开着网站：两台都推
  social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
  let got = await flush();
  assert.equal(got.length, 2);
  const req = got.find((r) => r.endpoint === d.endpoint)!;
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers['Content-Type'], 'application/octet-stream');
  assert.equal(req.headers.TTL, String(12 * 3600));
  assert.equal(req.headers.Urgency, 'normal');
  const { publicKey } = await info('t1');
  const auth = req.headers.Authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(auth, req.headers.Authorization);
  assert.equal(auth[4], publicKey);
  const claims = JSON.parse(b64(auth[2]).toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:owner@example.com' });
  const point = b64(publicKey);
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${auth[1]}.${auth[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b64(auth[3])));
  assert.deepEqual(opened(req), { title: '对局开始了', body: '「雾港旅店」开始了', url: '/room/7', tag: 'room-7' });
  // 苹果的推送服务：不许收到推送却不弹，一律 always
  const toApple = got.find((r) => r.endpoint === apple.endpoint)!;
  assert.equal(JSON.parse(b64(toApple.headers.Authorization.split('.')[1]).toString()).aud, 'https://web.push.apple.com');
  assert.equal(opened(toApple).always, true);
  // 推送服务收下了：记下时间
  assert.ok((await info('t1')).devices.every((x: { lastOkAt: number | null }) => x.lastOkAt === now));

  // 开着网站（随便哪个页面）也推：家里电脑开着网页，出门的手机照样收得到（页面正在前台的那台，sw.js 不弹）
  const lobby = await t.openStream('/api/events', c.t1);
  await lobby.waitFor(() => true).catch(() => undefined);
  assert.ok(t.app.hub.isConnected(ids.tester1));
  social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
  got = await flush();
  assert.equal(got.length, 2);
  assert.equal(opened(got.find((r) => r.endpoint === d.endpoint)!).always, undefined, '不是 always：页面在前台的那台不弹');
  // 快开团的提醒：页面开在前台也弹
  const startsAt = now + 30 * MIN;
  social.notify(ids.tester1, 'schedule_reminder', { ...roomData, startsAt });
  got = await flush();
  assert.equal(got.length, 2);
  const reminder = opened(got.find((r) => r.endpoint === d.endpoint)!);
  assert.deepEqual(reminder, { title: '快开团了', body: '「雾港旅店」{time} 开始', url: '/room/7', tag: 'schedule-7', startsAt, always: true, renotify: true });
  assert.equal(got[0].headers.Urgency, 'high');
  assert.equal(got[0].headers.TTL, String(30 * 60), '推送服务替我们留到开始的时候');
  lobby.close();
  for (let i = 0; i < 100 && t.app.hub.isConnected(ids.tester1); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!t.app.hub.isConnected(ids.tester1));

  // 约团的另外几种：内容
  social.notify(ids.tester1, 'schedule_poll', { ...roomData, from: { publicId: publicIds.admin, displayName: '测试管理员' }, count: 3 });
  social.notify(ids.tester1, 'schedule_confirmed', { ...roomData, startsAt });
  social.notify(ids.tester1, 'schedule_cancelled', roomData);
  got = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.deepEqual(
    got.map((r) => opened(r)),
    [
      { title: '约团', body: '测试管理员在「雾港旅店」列了 3 个候选时间', url: '/room/7?schedule', tag: 'schedule-7' },
      { title: '定好时间了', body: '「雾港旅店」{time} 开始', url: '/room/7', tag: 'schedule-7', startsAt },
      { title: '约团取消了', body: '「雾港旅店」定好的时间取消了', url: '/room/7', tag: 'schedule-7' },
    ],
  );

  // 邀请和申请：点了去哪
  social.notify(ids.tester1, 'room_invite', { ...roomData, from: { publicId: publicIds.admin, displayName: '测试管理员' } });
  social.notify(ids.tester1, 'friend_request', { from: { publicId: publicIds.admin, displayName: '测试管理员' } });
  social.notify(ids.tester1, 'group_added', { from: { publicId: publicIds.admin, displayName: '测试管理员' }, groupId: 5, name: '周五团' });
  got = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.deepEqual(
    got.map((r) => [opened(r).body, opened(r).url]),
    [
      ['测试管理员邀请你加入「雾港旅店」', '/notifications'],
      ['测试管理员想加你好友', '/friends'],
      ['测试管理员把你拉进了群「周五团」', '/friends/g/5'],
    ],
  );

  // 其他通知默认关着；打开以后推，点了去通知页；关掉对局开始以后不推
  social.notify(ids.tester1, 'achievement', { key: 'x', title: '初出茅庐', how: '玩完一局', reward: 10 });
  assert.equal((await flush()).length, 0, '其他通知默认不推');
  await t.call('PUT', '/api/push/prefs', { other: true, started: false }, c.t1);
  social.notify(ids.tester1, 'achievement', { key: 'x', title: '初出茅庐', how: '玩完一局', reward: 10 });
  social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
  got = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.equal(got.length, 1);
  assert.deepEqual(
    (({ title, body, url }) => ({ title, body, url }))(opened(got[0])),
    { title: '龙娘跑团', body: '达成成就「初出茅庐」', url: '/notifications' },
  );
  // 警告、举报的回复这些：只说有一条，不带内容
  social.notify(ids.tester1, 'violation_warning', { message: '这是一段不该出现在锁屏上的话' });
  social.notify(ids.tester1, 'report_reply', { reportId: 1, kind: 'bug', reply: '管理员写的回复内容' });
  got = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.equal(got.length, 2);
  for (const r of got) assert.doesNotMatch(JSON.stringify(opened(r)), /不该出现|回复内容/);
  await t.call('PUT', '/api/push/prefs', { other: false, started: true }, c.t1);

  // 写通知的事务撤回了：不推
  assert.throws(() =>
    transaction(t.app.db, () => {
      social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
      throw new Error('撤回');
    }),
  );
  assert.equal((await flush()).length, 0);

  // 推送服务说订阅没了（410、404）：删掉；别的失败只记一行日志（不带完整的推送地址），订阅留着
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  try {
    statusFor = (endpoint) => (endpoint === apple.endpoint ? 410 : 500);
    social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
    assert.equal((await flush()).length, 2);
    let left = (await info('t1')).devices;
    assert.equal(left.length, 1, '410 的删掉了');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /fcm\.googleapis\.com.*500/);
    assert.ok(!errors[0].includes(d.endpoint.split('/').pop()!), '日志里没有完整的推送地址');
    statusFor = () => 404;
    social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
    await flush();
    left = (await info('t1')).devices;
    assert.equal(left.length, 0, '404 的也删掉了');
    // 推送服务连不上：记一行，不往外抛
    assert.equal((await sub('t1', d)).status, 201);
    statusFor = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    social.notify(ids.tester1, 'room_started', { ...roomData, by: '房主' });
    await flush();
    assert.match(errors.at(-1)!, /fcm\.googleapis\.com，ECONNREFUSED/);
    assert.equal((await info('t1')).devices.length, 1, '连不上的不删');
  } finally {
    console.error = original;
    statusFor = () => 201;
  }
  t.app.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(ids.tester1);
});

test('私信：只说谁发来的、不带内容，点了去和他的私聊；开着网站也推；同一个人 2 分钟里只推一次', async () => {
  // 先成为好友
  assert.equal((await t.call('POST', '/api/friends', { username: T2.username }, c.t1)).status, 201);
  assert.equal((await t.call('POST', `/api/friends/${publicIds.tester1}/accept`, undefined, c.t2)).status, 200);
  const d = newDevice();
  assert.equal((await sub('t2', d)).status, 201);
  await flush();

  const secret = '今晚九点老地方见，别告诉别人';
  assert.equal((await t.call('POST', `/api/friends/${publicIds.tester2}/messages`, { text: secret }, c.t1)).status, 201);
  const got = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.equal(got.length, 1);
  const msg = opened(got[0]);
  assert.deepEqual(msg, { title: '私信', body: '测试玩家一给你发了私信', url: `/friends/${publicIds.tester1}`, tag: `dm-${publicIds.tester1}` });
  assert.doesNotMatch(JSON.stringify(msg), /老地方/);
  assert.equal(got[0].headers.Urgency, 'high');

  // 同一个人一条接一条地发：2 分钟里只推一次（手机不会一直响）
  assert.equal(DM_PUSH_INTERVAL_MS, 2 * MIN);
  for (const text of ['还在吗', '回个话', '喂']) {
    assert.equal((await t.call('POST', `/api/friends/${publicIds.tester2}/messages`, { text }, c.t1)).status, 201);
  }
  assert.equal((await flush()).length, 0, '2 分钟里同一个人只推一次');
  // 别人发来的照样推
  assert.equal((await t.call('POST', '/api/friends', { username: T2.username }, c.admin)).status, 201);
  assert.equal((await t.call('POST', `/api/friends/${publicIds.admin}/accept`, undefined, c.t2)).status, 200);
  await flush();
  assert.equal((await t.call('POST', `/api/friends/${publicIds.tester2}/messages`, { text: '周五来吗' }, c.admin)).status, 201);
  assert.deepEqual(
    (await flush()).filter((r) => r.endpoint === d.endpoint).map((r) => opened(r).body),
    ['测试管理员给你发了私信'],
  );
  // 过了 2 分钟：同一个人再发，又推一次（tag 一样，替换前面那条，不再响）；
  // 开着网站也推（他的手机照样要收到；页面正在前台的那台设备，sw.js 不弹）
  now += DM_PUSH_INTERVAL_MS;
  const s = await t.openStream('/api/events', c.t2);
  assert.ok(t.app.hub.isConnected(ids.tester2));
  assert.equal((await t.call('POST', `/api/friends/${publicIds.tester2}/messages`, { text: '在吗' }, c.t1)).status, 201);
  const again = (await flush()).filter((r) => r.endpoint === d.endpoint);
  assert.equal(again.length, 1);
  assert.equal(opened(again[0]).renotify, undefined);
  assert.equal(opened(again[0]).always, undefined);
  s.close();

  // 关掉了私信这一类：不推
  now += DM_PUSH_INTERVAL_MS;
  await t.call('PUT', '/api/push/prefs', { dm: false }, c.t2);
  assert.equal((await t.call('POST', `/api/friends/${publicIds.tester2}/messages`, { text: '在吗' }, c.t1)).status, 201);
  assert.equal((await flush()).length, 0);
  await t.call('PUT', '/api/push/prefs', { dm: true }, c.t2);
  t.app.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(ids.tester2);
});

test('被封号的、删掉的账号不推（删掉的连订阅一起删）', async () => {
  const d = newDevice();
  assert.equal((await sub('t2', d)).status, 201);
  t.app.db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(now, ids.tester2);
  t.app.social.notify(ids.tester2, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
  assert.equal((await flush()).length, 0);
  t.app.db.prepare('UPDATE users SET banned_at = NULL WHERE id = ?').run(ids.tester2);
  t.app.social.notify(ids.tester2, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
  assert.equal((await flush()).length, 1, '解封以后照样推');

  // 删掉的账号（软删除）：不推，订阅删掉
  const victim = t.app.db.prepare("SELECT id FROM users WHERE username = 'tester5'").get() as { id: number };
  const c5 = await t.login(TEST_ACCOUNTS[5].username, TEST_ACCOUNTS[5].password);
  const d5 = newDevice();
  assert.equal((await t.call('POST', '/api/push/subscriptions', { endpoint: d5.endpoint, keys: { p256dh: d5.p256dh, auth: d5.auth } }, c5)).status, 201);
  t.app.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(now, victim.id);
  t.app.social.notify(victim.id, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
  assert.equal((await flush()).length, 0);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(victim.id) as { n: number }).n, 0);
  t.app.db.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(victim.id);
  t.app.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(ids.tester2);
});

test('发一条试试：发给自己的所有设备，页面开在前台也弹；没有设备 409；每人 30 秒最多一次', async () => {
  assert.equal((await t.call('POST', '/api/push/test', undefined, c.t1)).status, 409);
  const a = newDevice();
  const b = newDevice('https://updates.push.services.mozilla.com/wpush/v2/');
  assert.equal((await sub('t1', a)).status, 201);
  assert.equal((await sub('t1', b)).status, 201);
  let r = await t.call('POST', '/api/push/test', undefined, c.t1);
  assert.equal(r.status, 200);
  assert.equal(r.data.sent, 2);
  const got = await flush();
  assert.equal(got.length, 2);
  assert.deepEqual(opened(got[0]), { title: '龙娘跑团', body: '通知能收到了', url: '/account', tag: 'push-test', always: true, renotify: true });
  r = await t.call('POST', '/api/push/test', undefined, c.t1);
  assert.equal(r.status, 429);
  assert.equal((await flush()).length, 0);
  // 别人不受影响
  const other = newDevice();
  assert.equal((await sub('t2', other)).status, 201);
  assert.equal((await t.call('POST', '/api/push/test', undefined, c.t2)).status, 200);
  await flush();
  now += 29_000;
  assert.equal((await t.call('POST', '/api/push/test', undefined, c.t1)).status, 429);
  now += 1_000;
  assert.equal((await t.call('POST', '/api/push/test', undefined, c.t1)).status, 200);
  assert.equal((await flush()).length, 2);
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
});

test('订阅跟着登录：「退出其他设备」、改密码以后别的设备不再收；退出登录订阅跟着删；重新登录后网页再交一次就接上；登录过期的不发', async () => {
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
  /** 这个登录在数据库里的会话编号。 */
  const sid = (cookie: string) => sessionId(decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)))!;
  const rows = () => t.app.db.prepare('SELECT endpoint, session_id FROM push_subscriptions ORDER BY id').all() as { endpoint: string; session_id: string }[];
  const subscribe = (cookie: string, d: Device) => t.call('POST', '/api/push/subscriptions', { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, cookie);
  const notify = async () => {
    t.app.social.notify(ids.tester1, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
    return (await flush()).map((r) => r.endpoint).sort();
  };

  // t1 在手机和电脑上各登录一次，都打开了通知：订阅记着各自的登录
  const phone = await t.login(T1.username, T1.password);
  const laptop = await t.login(T1.username, T1.password);
  const dPhone = newDevice('https://web.push.apple.com/');
  const dLaptop = newDevice();
  assert.equal((await subscribe(phone, dPhone)).status, 201);
  assert.equal((await subscribe(laptop, dLaptop)).status, 201);
  assert.deepEqual(
    rows().map((r) => r.session_id),
    [sid(phone), sid(laptop)],
  );
  assert.deepEqual(await notify(), [dLaptop.endpoint, dPhone.endpoint].sort());

  // 在电脑上点「退出其他设备」：手机的登录没了，手机的订阅跟着删掉，不再收
  assert.equal((await t.call('POST', '/api/auth/logout-others', undefined, laptop)).status, 200);
  assert.deepEqual(
    rows().map((r) => r.endpoint),
    [dLaptop.endpoint],
  );
  assert.deepEqual(await notify(), [dLaptop.endpoint]);
  assert.equal((await t.call('GET', '/api/push', undefined, laptop)).data.devices.length, 1);

  // 手机上重新登录、打开网站：网页把这台的订阅再交一次，绑到新的登录上，又能收到
  const phone2 = await t.login(T1.username, T1.password);
  assert.equal((await subscribe(phone2, dPhone)).status, 201);
  assert.equal(rows().find((r) => r.endpoint === dPhone.endpoint)?.session_id, sid(phone2));
  assert.deepEqual(await notify(), [dLaptop.endpoint, dPhone.endpoint].sort());
  // 同一个浏览器再交一次（每个标签页一次）：还是一条，换成这次的登录
  const phone3 = await t.login(T1.username, T1.password);
  assert.equal((await subscribe(phone3, dPhone)).status, 201);
  assert.equal(rows().length, 2);
  assert.equal(rows().find((r) => r.endpoint === dPhone.endpoint)?.session_id, sid(phone3));

  // 退出登录：服务器删掉这次登录，这台的订阅跟着删掉（网页没来得及先删也一样）
  assert.equal((await t.call('POST', '/api/auth/logout', undefined, phone3)).status, 200);
  assert.deepEqual(
    rows().map((r) => r.endpoint),
    [dLaptop.endpoint],
  );
  assert.deepEqual(await notify(), [dLaptop.endpoint]);

  // 电脑上的登录过期了：不发，设备列表里也没有；重新登录、网页再交一次就接上
  t.app.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, sid(laptop));
  assert.deepEqual(await notify(), []);
  const laptop2 = await t.login(T1.username, T1.password);
  assert.deepEqual((await t.call('GET', '/api/push', undefined, laptop2)).data.devices, []);
  assert.equal((await t.call('POST', '/api/push/test', undefined, laptop2)).status, 409, '没有收得到的设备');
  assert.equal((await subscribe(laptop2, dLaptop)).status, 201);
  assert.deepEqual(await notify(), [dLaptop.endpoint]);

  // 改密码：别的登录全没了，那些设备不再收（改密码的这台还在）
  const T3 = TEST_ACCOUNTS[3];
  const here = await t.login(T3.username, T3.password);
  const there = await t.login(T3.username, T3.password);
  const dHere = newDevice();
  const dThere = newDevice('https://updates.push.services.mozilla.com/wpush/v2/');
  assert.equal((await subscribe(here, dHere)).status, 201);
  assert.equal((await subscribe(there, dThere)).status, 201);
  const t3 = (t.app.db.prepare('SELECT id FROM users WHERE username = ?').get(T3.username) as { id: number }).id;
  t.app.social.notify(t3, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
  assert.equal((await flush()).length, 2);
  assert.equal((await t.call('POST', '/api/auth/password', { currentPassword: T3.password, newPassword: 'tester3-changed-2026' }, here)).status, 200);
  t.app.social.notify(t3, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
  assert.deepEqual(
    (await flush()).map((r) => r.endpoint),
    [dHere.endpoint],
  );

  // 被封号：登录全删掉，订阅也没了
  t.app.safety.ban(t3, '测试封号', null);
  assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(t3) as { n: number }).n, 0);
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
  // 上面「退出其他设备」把一开始的登录也退掉了：后面的测试重新登录
  c.t1 = await t.login(T1.username, T1.password);
});

test('轮到你：回合模式下别人都交了、就等你，3 分钟以后还在等才推（开着网站也推）；同一轮只推一次；交了就不推；关掉这一类不推', async () => {
  // 两个人的局：记者（房主 t1）、侦探（t2），两个人都开着这一局的页面：回合模式
  const r = await t.call('POST', '/api/rooms', { name: '周五的雾港', maxPlayers: 4 }, c.t1);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.room.id as number;
  assert.equal((await t.call('POST', '/api/rooms/join', { code: r.data.room.joinCode }, c.t2)).status, 200);
  assert.equal((await t.call('POST', `/api/rooms/${id}/scenario`, { key: 'fog-harbor-inn' }, c.t1)).status, 200);
  assert.equal((await t.call('PUT', `/api/rooms/${id}/character`, { name: '林小满', roleKey: 'reporter' }, c.t1)).status, 200);
  assert.equal((await t.call('PUT', `/api/rooms/${id}/character`, { name: '沈探', roleKey: 'detective' }, c.t2)).status, 200);
  const s1 = await t.openStream(`/api/rooms/${id}/events`, c.t1);
  const s2 = await t.openStream(`/api/rooms/${id}/events`, c.t2);
  await s2.waitFor((e) => e.event === 'presence' && e.data.online.length === 2);
  assert.equal((await t.call('POST', `/api/rooms/${id}/status`, { status: 'running' }, c.t1)).status, 200);
  const game = async (who: Who) => (await t.call('GET', `/api/rooms/${id}/game`, undefined, c[who])).data;
  assert.equal((await game('t1')).mode, 'round');
  const d2 = newDevice();
  const d1 = newDevice();
  assert.equal((await sub('t2', d2)).status, 201);
  assert.equal((await sub('t1', d1)).status, 201);
  await t.app.engine.idle();
  await flush();

  // 第一轮：林小满交了，等沈探
  const start = now;
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions`, { content: '翻看大堂的住客登记簿 [分钟 20]' }, c.t1)).status, 201);
  await t.app.engine.idle();
  const round1 = await game('t1');
  assert.equal(round1.round.number, 1);
  assert.deepEqual(t.app.engine.roundWaitingFor(id), { round: 1, userIds: [ids.tester2] });
  now = start + 2 * MIN;
  t.app.push.checkTurns();
  assert.equal((await flush()).length, 0, '还没到 3 分钟');
  now = start + TURN_DELAY_MS;
  t.app.push.checkTurns();
  let got = await flush();
  assert.equal(got.length, 1, '只推给还没交的沈探');
  assert.equal(got[0].endpoint, d2.endpoint);
  assert.deepEqual(opened(got[0]), { title: '轮到你了', body: '「周五的雾港」就等你交行动了', url: `/room/${id}`, tag: `turn-${id}`, renotify: true });
  assert.equal(got[0].headers.Urgency, 'high');
  // 同一轮不再推：引擎又问了几次（有人刷新、在线情况变了），过了很久也一样
  t.app.engine.syncRoom(id);
  t.app.engine.syncRoom(id);
  now += 10 * MIN;
  t.app.push.checkTurns();
  assert.equal((await flush()).length, 0);

  // 沈探交了：这一轮结算，进入第二轮
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions`, { content: '在二楼客房翻刘贵的行李 [分钟 30]' }, c.t2)).status, 201);
  await t.app.engine.idle();
  assert.equal((await game('t2')).round.number, 2);
  assert.equal(t.app.engine.roundWaitingFor(id), null, '还没有人交：不算在等谁');

  // 第二轮：沈探先交，等林小满；林小满 3 分钟以内交了：不推
  const start2 = now;
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions`, { content: '下楼看看 [分钟 10]' }, c.t2)).status, 201);
  await t.app.engine.idle();
  assert.deepEqual(t.app.engine.roundWaitingFor(id), { round: 2, userIds: [ids.tester1] });
  now = start2 + MIN;
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions`, { content: '和老板娘聊聊天气 [分钟 10]' }, c.t1)).status, 201);
  await t.app.engine.idle();
  now = start2 + TURN_DELAY_MS + MIN;
  t.app.push.checkTurns();
  assert.equal((await flush()).length, 0, '交了就不推');

  // 第三轮：关掉了「轮到你」的不推
  await t.call('PUT', '/api/push/prefs', { turn: false }, c.t2);
  const start3 = now;
  assert.equal((await t.call('POST', `/api/rooms/${id}/actions`, { content: '去码头 [分钟 10]' }, c.t1)).status, 201);
  await t.app.engine.idle();
  assert.deepEqual(t.app.engine.roundWaitingFor(id)?.userIds, [ids.tester2]);
  now = start3 + TURN_DELAY_MS;
  t.app.push.checkTurns();
  assert.equal((await flush()).length, 0);
  await t.call('PUT', '/api/push/prefs', { turn: true }, c.t2);

  s1.close();
  s2.close();
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
});

test('计时器里出错（数据库被锁住之类）：兜住，只记一行日志，不往外抛（不会让服务器停下来）', async () => {
  const d = newDevice();
  assert.equal((await sub('t2', d)).status, 201);
  const roomId = (t.app.db.prepare('SELECT id FROM rooms ORDER BY id LIMIT 1').get() as { id: number }).id;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  // 问「这一轮还在等谁」时数据库出错
  const push = new Push({
    db: t.app.db,
    now: () => now,
    subject: 'mailto:owner@example.com',
    send: async () => ({ status: 201 }),
    turnDelayMs: 0,
    roundWaitingFor: () => {
      throw new Error('database is locked\n    at somewhere');
    },
  });
  try {
    push.roundWaiting(roomId, [ids.tester2]);
    // 计时器到点（1 秒后）照样跑：出错兜住，记一行
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.deepEqual(errors, ['浏览器推送：看「轮到你」时出错：database is locked at somewhere']);
    // 直接调用也不往外抛
    push.roundWaiting(roomId, [ids.tester2]);
    assert.doesNotThrow(() => push.checkTurns());
  } finally {
    console.error = original;
    push.stop();
    t.app.db.prepare('DELETE FROM push_subscriptions').run();
  }
});

/** 等到条件成立（最多等 1 秒）。 */
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), '等不到');
}

test('签名缓存有上限：推送服务的主机再多，记着的签名不超过上限', async () => {
  const push = t.app.push as any;
  for (let i = 0; i < JWT_CACHE_MAX + 20; i++) {
    assert.equal((await sub('t2', newDevice(`https://wns2-x${i}.notify.windows.com/w/?token=`))).status, 201);
    push.deliver(ids.tester2, null, { title: '龙娘跑团', body: 'x', url: '/', tag: 'x', ttl: 60, urgency: 'normal' });
    await flush();
  }
  assert.ok(push.jwts.size <= JWT_CACHE_MAX, `记着 ${push.jwts.size} 条签名`);
  assert.ok(push.jwts.has(`https://wns2-x${JWT_CACHE_MAX + 19}.notify.windows.com`), '最近用的还在');
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
});

test('排队：每个账号最多排 20 条（多的不发，记一行），别的账号照样排得上；快开团的提醒先发、不受上限；推送服务 5 秒不回应算失败', async () => {
  assert.equal(SEND_TIMEOUT_MS, 5000);
  assert.equal(QUEUE_PER_USER, 20);
  // 推送服务不回应：等我们放行
  const calls: { req: PushRequest; release: (status: number) => void }[] = [];
  const push = new Push({
    db: t.app.db,
    now: () => now,
    subject: 'mailto:owner@example.com',
    send: (req, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ req, release: (status) => resolve({ status }) });
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  }) as any;
  assert.equal((await sub('t2', newDevice())).status, 201);
  assert.equal((await sub('t1', newDevice())).status, 201);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  const msg = (tag: string) => ({ title: '龙娘跑团', body: 'x', url: '/', tag, ttl: 60, urgency: 'normal' });
  try {
    for (let i = 0; i < 30; i++) push.deliver(ids.tester2, null, msg(`n${i}`));
    assert.equal(calls.length, 4, '同时只发 4 条');
    assert.equal(push.queue.length, QUEUE_PER_USER, '这个账号最多排 20 条');
    assert.equal(errors.length, 1, '多的不发，只记一行');
    assert.match(errors[0], /排队的太多了/);
    // 别的账号照样排得上
    push.deliver(ids.tester1, null, msg('t1'));
    assert.equal(push.queue.length, QUEUE_PER_USER + 1);
    // 快开团的提醒（always 的）：这个账号排满了也排得上，而且先发
    push.deliver(ids.tester2, null, { ...msg('reminder'), always: true });
    calls[0].release(201);
    await waitUntil(() => calls.length === 5);
    assert.equal(opened(calls[4].req).tag, 'reminder');
    calls[1].release(201);
    await waitUntil(() => calls.length === 6);
    assert.equal(opened(calls[5].req).tag, 'n4', '然后按先后');
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
    push.stop();
    await push.idle();
    t.app.db.prepare('DELETE FROM push_subscriptions').run();
  }
});

test('日志里不留完整的推送地址和签名（只写主机名）', async () => {
  const fcm = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ';
  const wns = 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%3dsecret';
  const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSJ9.c2lnbmF0dXJl';
  const text = scrubPushSecrets(`fetch failed: ${fcm} ${wns} Authorization: vapid t=${jwt}, k=BPublicKey; ${jwt}`);
  for (const secret of ['APA91b', 'dQw4w9', 'BQYAAAB', 'secret', 'eyJ0eXAi', 'c2lnbmF0dXJl']) assert.ok(!text.includes(secret), `${secret}：${text}`);
  assert.match(text, /https:\/\/fcm\.googleapis\.com\//);
  assert.match(text, /https:\/\/wns2-par02p\.notify\.windows\.com\//);

  // 发送时出错，错误说明里带着推送地址和签名：日志里只有主机名
  const d = newDevice();
  assert.equal((await sub('t1', d)).status, 201);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  try {
    statusFor = (endpoint) => {
      throw new Error(`unexpected response from ${endpoint} (Authorization: vapid t=${jwt}, k=x)`);
    };
    t.app.social.notify(ids.tester1, 'room_started', { roomId: 7, roomName: '雾港旅店', by: '房主' });
    await flush();
  } finally {
    console.error = original;
    statusFor = () => 201;
  }
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^浏览器推送没发出去：fcm\.googleapis\.com，/);
  assert.ok(!errors[0].includes(d.endpoint.split('/').pop()!), errors[0]);
  assert.ok(!errors[0].includes('eyJ0eXAi'), errors[0]);
  t.app.db.prepare('DELETE FROM push_subscriptions').run();
});

test('推给浏览器的内容一定不超过 3000 字节，截短一定会停（地址太长换成通知页）', async () => {
  const { encodeMessage } = await import('../server/push');
  const cases = [
    { title: '标题', body: '正文'.repeat(50), url: '/room/1?x=' + 'a'.repeat(2950), tag: 't' },
    { title: '\u0001'.repeat(100), body: '\u0001'.repeat(5000), url: '/room/1', tag: '\u0001'.repeat(100) },
    { title: '标题', body: '"'.repeat(500), url: '/' + '"'.repeat(299), tag: '"'.repeat(200) },
  ];
  for (const message of cases) {
    const text = encodeMessage(message);
    assert.ok(Buffer.byteLength(text) <= 3000, `${Buffer.byteLength(text)} 字节`);
    const parsed = JSON.parse(text);
    assert.ok(parsed.url.startsWith('/'));
  }
  assert.equal(JSON.parse(encodeMessage(cases[0])).url, '/notifications', '太长的地址换成通知页');
  // 正常的不动
  assert.deepEqual(JSON.parse(encodeMessage({ title: '轮到你了', body: '「雾港」就等你了', url: '/room/3', tag: 'turn-3', renotify: true })), {
    title: '轮到你了',
    body: '「雾港」就等你了',
    url: '/room/3',
    tag: 'turn-3',
    renotify: true,
  });
});

test('电脑时钟往回调了很多（超过 24.8 天）：「轮到你」的计时器不会每毫秒转一圈', async () => {
  const d = newDevice();
  assert.equal((await sub('t2', d)).status, 201);
  const roomId = (t.app.db.prepare('SELECT id FROM rooms ORDER BY id LIMIT 1').get() as { id: number }).id;
  let clock = now;
  let checks = 0;
  const warnings: string[] = [];
  const onWarning = (w: Error) => void warnings.push(w.name);
  process.on('warning', onWarning);
  const push = new Push({
    db: t.app.db,
    now: () => clock,
    subject: 'mailto:owner@example.com',
    roundWaitingFor: () => ({ round: 1, userIds: [ids.tester2] }),
    send: async () => ({ status: 201 }),
    turnDelayMs: 0,
  });
  const check = push.checkTurns.bind(push);
  push.checkTurns = () => {
    checks++;
    check();
  };
  try {
    push.roundWaiting(roomId, [ids.tester2]);
    // 计时器到点之前，时钟往回调了 30 天
    clock -= 30 * 24 * 3600_000;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(checks, 1, `1.5 秒里看了 ${checks} 次`);
    assert.deepEqual(warnings, []);
  } finally {
    process.off('warning', onWarning);
    push.stop();
    t.app.db.prepare('DELETE FROM push_subscriptions').run();
  }
});
