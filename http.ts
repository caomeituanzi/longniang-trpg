import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { User } from './auth';

/**
 * 访问者是不是用 HTTPS 连进来的：服务器自己就是 TLS，或者前面的代理（Cloudflare Tunnel）说访问者用的是 https
 * （X-Forwarded-Proto、CF-Visitor）。这两个请求头别人可以在局域网里伪造，但伪造成 https 只会让他自己的 Cookie 多带一个 Secure，
 * 没有好处；经过 Cloudflare 的请求，这两个头由 Cloudflare 填，改不了。
 */
export function viaHttps(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  if (first === 'https') return true;
  const visitor = req.headers['cf-visitor'];
  return typeof visitor === 'string' && /"scheme"\s*:\s*"https"/.test(visitor);
}

/** 从 Cloudflare 转过来、但访问者用的是 http:// 的请求（要跳到 https://）。 */
export function cloudflareHttp(req: IncomingMessage): boolean {
  const visitor = req.headers['cf-visitor'];
  if (typeof visitor === 'string') return /"scheme"\s*:\s*"http"/.test(visitor);
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  return first === 'http' && req.headers['cf-connecting-ip'] !== undefined;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  cookies: Record<string, string>;
  user: User | null;
  status: number;
  setCookies: string[];
};

/** 处理函数返回 STREAMING 表示它自己接管了响应（比如 SSE 推送），框架不再写 JSON。 */
export const STREAMING = Symbol('streaming');

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

/** 路由的选项（V0.8.0）：bodyLimit 是这个接口的请求体最多多少字节（不写是 BODY_LIMIT；整份剧本这种大的单独放宽）。 */
export type RouteOptions = { bodyLimit?: number };

type Route = { method: string; parts: string[]; handler: Handler; bodyLimit?: number };

export class Router {
  private routes: Route[] = [];

  get(pattern: string, handler: Handler) {
    this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler, opts: RouteOptions = {}) {
    this.add('POST', pattern, handler, opts);
  }
  put(pattern: string, handler: Handler, opts: RouteOptions = {}) {
    this.add('PUT', pattern, handler, opts);
  }
  delete(pattern: string, handler: Handler) {
    this.add('DELETE', pattern, handler);
  }

  private add(method: string, pattern: string, handler: Handler, opts: RouteOptions = {}) {
    this.routes.push({ method, parts: splitPath(pattern), handler, bodyLimit: opts.bodyLimit });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; bodyLimit?: number } | 'wrong-method' | null {
    const parts = splitPath(pathname);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchParts(route.parts, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params, bodyLimit: route.bodyLimit };
    }
    return pathMatched ? 'wrong-method' : null;
  }

  /** 被前面登记的同方法路由整个挡住、永远轮不到的路由（测试用：新加的路由别和旧的撞车）。 */
  shadowed(): string[] {
    const out: string[] = [];
    this.routes.forEach((later, j) => {
      const blocker = this.routes.slice(0, j).find((earlier) => earlier.method === later.method && covers(earlier.parts, later.parts));
      if (blocker) out.push(`${later.method} /${later.parts.join('/')} 被 /${blocker.parts.join('/')} 挡住了`);
    });
    return out;
  }
}

/** a 能匹配的路径包含 b 能匹配的所有路径。 */
function covers(a: string[], b: string[]) {
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || (!b[i].startsWith(':') && seg === b[i]));
}

function splitPath(p: string) {
  return p.split('/').filter(Boolean);
}

function matchParts(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.startsWith(':')) {
      try {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return params;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${opts.maxAgeSeconds}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

const BODY_LIMIT = 256 * 1024;

/** limit：这个接口的请求体最多多少字节（单独放宽了的，超了的时候说上限是多少）。 */
export async function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, limit === BODY_LIMIT ? '内容太长了' : `内容太长了：最多 ${Math.floor(limit / 1024)}KB`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  // 只接受 JSON：别的网站没法用普通表单冒充你提交
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, '请求格式不对');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式不对');
  }
}

/** 大于这么多字节的回复压缩一下再发（5E 的规则数据、长的对局记录；V0.9.0）。 */
const GZIP_OVER = 16 * 1024;

/** 浏览器说了能收 gzip 压缩的回复。 */
export function acceptsGzip(req: IncomingMessage): boolean {
  const v = req.headers['accept-encoding'];
  return /\bgzip\b/i.test(Array.isArray(v) ? v.join(',') : (v ?? ''));
}

export function sendJson(res: ServerResponse, status: number, data: unknown, setCookies: string[] = [], gzip = false) {
  const text = JSON.stringify(data);
  const headers: Record<string, string | string[]> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  const body = Buffer.from(text, 'utf8');
  if (gzip && body.length > GZIP_OVER) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers);
    res.end(gzipSync(body, { level: 6 }));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

// ---- 请求内容校验 ----

export function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不对');
  return body as Record<string, unknown>;
}

export function asString(
  value: unknown,
  opts: { min?: number; max: number; pattern?: RegExp; message: string; trim?: boolean },
): string {
  if (typeof value !== 'string') throw new HttpError(400, opts.message);
  const text = opts.trim === false ? value : value.trim();
  const length = [...text].length;
  if (length < (opts.min ?? 1) || length > opts.max) throw new HttpError(400, opts.message);
  if (opts.pattern && !opts.pattern.test(text)) throw new HttpError(400, opts.message);
  return text;
}

export function asInt(value: unknown, opts: { min: number; max: number; message: string }): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new HttpError(400, opts.message);
  }
  return n;
}

export function asOneOf<T extends string>(value: unknown, options: readonly T[], message: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new HttpError(400, message);
  return value as T;
}

export function asId(value: string | undefined): number {
  if (!value || !/^\d{1,12}$/.test(value)) throw new HttpError(404, '没有找到');
  return Number(value);
}
