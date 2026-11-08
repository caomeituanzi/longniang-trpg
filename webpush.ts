import crypto from 'node:crypto';

// 浏览器推送的底层（V0.8.0）：服务器自己的密钥和签名（VAPID，RFC 8292）、给浏览器的内容加密（RFC 8291，
// 按 RFC 8188 的 aes128gcm 格式）、推送地址白名单、发出去。只用 node:crypto 和全局 fetch，不加依赖。
// 这里都是纯函数：随机的部分（salt、这一次的临时密钥）、发送都能从外面传进来，测试不联网。

// ==================== 服务器的密钥（VAPID） ====================

/** 存进设置（push_vapid）的样子：公钥是 65 字节未压缩点的 base64url（给浏览器订阅用），私钥是 JWK。 */
export type StoredVapid = { publicKey: string; privateKey: crypto.webcrypto.JsonWebKey };

/** 用的时候：公钥（base64url）和私钥。 */
export type VapidKeys = { publicKey: string; privateKey: crypto.KeyObject };

/** 新生成一对 P-256（prime256v1）密钥。 */
export function generateVapid(): StoredVapid {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicPointOf(jwk).toString('base64url'), privateKey: jwk };
}

/** JWK 里的 x、y 拼成 65 字节的未压缩点（0x04 | x | y）。 */
function publicPointOf(jwk: crypto.webcrypto.JsonWebKey): Buffer {
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  if (x.length !== 32 || y.length !== 32) throw new Error('VAPID 密钥的格式不对');
  return Buffer.concat([Buffer.from([4]), x, y]);
}

/** 从设置里读出来的密钥换成能用的；格式不对、公钥私钥对不上抛错。 */
export function loadVapid(stored: StoredVapid): VapidKeys {
  if (!stored || typeof stored !== 'object' || !stored.privateKey || stored.privateKey.crv !== 'P-256' || !stored.privateKey.d) {
    throw new Error('VAPID 密钥的格式不对');
  }
  // 两个 JsonWebKey 类型字段相同，只是 Web Crypto 的版本少一个索引签名；运行时就是同一个对象。
  const privateKey = crypto.createPrivateKey({ key: stored.privateKey as crypto.JsonWebKey, format: 'jwk' });
  const publicKey = publicPointOf(stored.privateKey).toString('base64url');
  if (publicKey !== stored.publicKey) throw new Error('VAPID 的公钥和私钥对不上');
  return { publicKey, privateKey };
}

/** VAPID 的 JWT（ES256）：aud 是推送服务的 origin，exp 是现在 + 12 小时，sub 是联系方式。 */
export function vapidJwt(privateKey: crypto.KeyObject, audience: string, subject: string, nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** 发给推送服务的 Authorization 请求头：vapid t=<JWT>, k=<公钥>。 */
export function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, nowMs: number): string {
  return `vapid t=${vapidJwt(keys.privateKey, audience, subject, nowMs)}, k=${keys.publicKey}`;
}

/**
 * VAPID 的 sub（推送服务有问题时找谁）：.env 里的 PUSH_SUBJECT（邮箱或者网址；只写了邮箱的补上 mailto:）；
 * 没设就用网站的域名（SITE_HOSTS 的第一个）拼成 https://…；再没有就是 mailto:admin@localhost。
 */
export function vapidSubject(explicit: string | undefined, siteHosts: readonly string[] = []): string {
  const s = explicit?.trim();
  if (s) {
    if (/^(mailto:|https:\/\/)/i.test(s)) return s;
    return s.includes('@') ? `mailto:${s}` : `https://${s.replace(/\/+$/, '')}`;
  }
  const host = siteHosts.map((h) => h.trim().toLowerCase()).find(Boolean);
  return host ? `https://${host}` : 'mailto:admin@localhost';
}

// ==================== 加密（RFC 8291 + RFC 8188 aes128gcm） ====================

/** 每一段（record）多大：内容 + 1 字节分隔 + 16 字节校验码不能超过它。推送的内容只有一段。 */
export const RECORD_SIZE = 4096;

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/** 加密用的 CEK 和 NONCE（RFC 8291 第 3.4 节）。 */
function deriveKeys(ecdhSecret: Buffer, auth: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, auth, keyInfo, 32);
  return {
    cek: hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce: hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  };
}

function toBytes(value: Buffer | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'base64url') : value;
}

export type EncryptOptions = {
  /** 测试用：固定的 salt（16 字节）。不传是随机的。 */
  salt?: Buffer;
  /** 测试用：这一次的服务器临时私钥（32 字节）。不传是新生成的。 */
  serverPrivateKey?: Buffer;
};

/**
 * 加密一条推送：p256dh 是浏览器的公钥（65 字节），auth 是浏览器给的 16 字节密钥（都可以是 base64url）。
 * 返回：salt(16) | rs(4) | idlen(1)=65 | 这一次的服务器临时公钥(65) | 密文（内容 + 0x02 分隔 + GCM 校验码）。
 */
export function encryptPayload(plaintext: Buffer | string, p256dh: Buffer | string, auth: Buffer | string, opts: EncryptOptions = {}): Buffer {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  if (data.length + 1 + 16 > RECORD_SIZE) throw new Error('推送的内容太长了');
  const uaPublic = toBytes(p256dh);
  const authSecret = toBytes(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('浏览器的推送公钥不对');
  if (authSecret.length !== 16) throw new Error('浏览器的推送密钥不对');
  const salt = opts.salt ?? crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error('salt 要 16 字节');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.serverPrivateKey) ecdh.setPrivateKey(opts.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(uaPublic), authSecret, uaPublic, asPublic, salt);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, encrypted]);
}

/**
 * 按 RFC 8188 解密（浏览器那边做的事；测试用来对照）。uaPrivateKey 是浏览器的私钥（32 字节），auth 是那 16 字节密钥。
 * 内容可以分成好几段；每段去掉末尾的 0 填充和分隔符（最后一段是 0x02，前面的是 0x01）。
 */
export function decryptPayload(body: Buffer, uaPrivateKey: Buffer | string, auth: Buffer | string): Buffer {
  if (body.length < 21) throw new Error('内容太短');
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  if (rs < 18 || body.length < 21 + idlen) throw new Error('头部不对');
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(toBytes(uaPrivateKey));
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(asPublic), toBytes(auth), ecdh.getPublicKey(), asPublic, salt);
  const records = body.subarray(21 + idlen);
  const out: Buffer[] = [];
  for (let seq = 0, at = 0; at < records.length; seq++, at += rs) {
    const record = records.subarray(at, Math.min(at + rs, records.length));
    if (record.length < 17) throw new Error('有一段太短');
    const last = at + rs >= records.length;
    // 每一段的 nonce：NONCE 和段号（96 位，高位是 0）异或，只用改最后 4 字节
    const iv = Buffer.from(nonce);
    iv.writeUInt32BE((iv.readUInt32BE(8) ^ seq) >>> 0, 8);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, iv);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (end < 0 || plain[end] !== (last ? 2 : 1)) throw new Error('分隔符不对');
    out.push(plain.subarray(0, end));
  }
  return Buffer.concat(out);
}

// ==================== 推送地址白名单（防 SSRF） ====================

/** 推送地址最长多少字符（Windows 的推送地址比较长）。 */
export const ENDPOINT_MAX = 2000;

/** 只接受这几家浏览器的推送服务：谷歌（Chrome、安卓）、Mozilla（Firefox）、微软（Edge）、苹果（Safari）。 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
/**
 * 这几家另外用的主机：后缀前面只能有一段名字（微软的 wns2-par02p.notify.windows.com、苹果的 *.push.apple.com 这种），
 * 不认多段的子域名（a.b.notify.windows.com）。
 */
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 推送地址能用的话返回它的主机名（日志里只写这个，不写完整的地址），不能用返回 null：只要 https、白名单里的主机、默认端口。 */
export function pushServiceHost(endpoint: string): string | null {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > ENDPOINT_MAX || /[\s\u0000-\u001f\u007f]/.test(endpoint)) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (PUSH_HOSTS.includes(host)) return host;
  const suffix = PUSH_HOST_SUFFIXES.find((x) => host.endsWith(x));
  return suffix && HOST_LABEL.test(host.slice(0, -suffix.length)) ? host : null;
}

/** 苹果的推送服务：Safari 不许收到推送却不弹通知（几次以后会取消订阅），所以发给它的一律要弹。 */
export function isApplePush(host: string): boolean {
  return host === 'web.push.apple.com' || host.endsWith('.push.apple.com');
}

// ==================== 发出去 ====================

export type PushRequest = { endpoint: string; headers: Record<string, string>; body: Buffer };

/** 把一条推送发给推送服务，返回 HTTP 状态码。测试里换成假的（不联网）。 */
export type PushSender = (req: PushRequest, signal: AbortSignal) => Promise<{ status: number }>;

/** 默认：用 fetch 发；不跟着跳转（防止被引到别的地址）。超时由调用的地方给的 signal 管。 */
export const fetchSender: PushSender = async (req, signal) => {
  const res = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: new Uint8Array(req.body), redirect: 'error', signal });
  // 推送服务回的说明用不着，读掉好让连接空出来
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status };
};
