// 地图（V1.0.x）：地点之间的路程、最快的路线、暗道、地图上的位置。
// 服务器（主持工具走路、估时、给每个人看的地图）和网页（地图页签、剧本编辑器的小地图）共用，只用纯计算。
//
// 剧本里每个地点写着出口（exits）：通向哪个地点、路上要走几分钟（游戏时间）。hidden 的出口是暗门、暗道：
// 角色发现了（走过，或者主持人揭开）才画在地图上、才算走得通。地点可以写 x、y（0～100）定在地图上的位置，
// 没写的按路程远近自动摆。

export type MapExit = { to: string; minutes: number; hidden?: boolean };
export type MapPlace = { key: string; name: string; exits: MapExit[]; x?: number; y?: number };
export type Point = { x: number; y: number };

/** 地图坐标的范围：0～100。 */
export const MAP_SIZE = 100;

/** 一条路（不分方向）的标识：两头的 key 按顺序排好。记谁发现了哪条暗道时用。 */
export function pathKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 某个人能不能走这个出口。 */
export type CanUse = (from: string, exit: MapExit) => boolean;

/** 走得通的出口：不是暗道，或者是已经发现了的暗道（found 里是 pathKey）。 */
export function openExits(found: ReadonlySet<string> = new Set()): CanUse {
  return (from, e) => !e.hidden || found.has(pathKey(from, e.to));
}

/** 所有出口都算（暗道也算）：声音传得过暗门，自动摆位置也按完整的地形。 */
export const anyExit: CanUse = () => true;

/** 一条路线：path 从出发的地点到终点（含两头），steps 是每一段路的分钟数，minutes 是加起来的。 */
export type Route = { minutes: number; path: string[]; steps: number[] };

/** 赶路（跑、骑马、坐车）：路上的时间按一半算，每一段最少 1 分钟。 */
export function hurried(minutes: number): number {
  return Math.max(1, Math.ceil(minutes / 2));
}

/**
 * 从一个地点出发，到每个走得到的地点最快的路线（不含出发的地点）。
 * 时间一样的，经过的地点少的优先，再一样就按路上地点的 key 排：每次算出来都一样。
 */
export function routesFrom(places: readonly MapPlace[], from: string, canUse: CanUse = openExits()): Map<string, Route> {
  const byKey = new Map(places.map((p) => [p.key, p]));
  const best = new Map<string, Route>();
  if (!byKey.has(from)) return best;
  best.set(from, { minutes: 0, path: [from], steps: [] });
  const done = new Set<string>();
  const better = (a: Route, b: Route | undefined) =>
    !b || a.minutes < b.minutes || (a.minutes === b.minutes && (a.path.length < b.path.length || (a.path.length === b.path.length && a.path.join('>') < b.path.join('>'))));
  for (;;) {
    let cur: string | null = null;
    for (const [k, r] of best) if (!done.has(k) && (cur === null || better(r, best.get(cur)))) cur = k;
    if (cur === null) break;
    done.add(cur);
    const here = best.get(cur)!;
    for (const e of byKey.get(cur)?.exits ?? []) {
      if (!byKey.has(e.to) || done.has(e.to) || !canUse(cur, e)) continue;
      const next: Route = { minutes: here.minutes + e.minutes, path: [...here.path, e.to], steps: [...here.steps, e.minutes] };
      if (better(next, best.get(e.to))) best.set(e.to, next);
    }
  }
  best.delete(from);
  return best;
}

/** 赶路时的地图：每一段路的分钟数换成赶路的（按一半算、至少 1 分钟）。赶路要按这个找路线：一段段都是短路的，赶路也快不了多少。 */
export function hurriedPlaces(places: readonly MapPlace[]): MapPlace[] {
  return places.map((p) => ({ ...p, exits: p.exits.map((e) => ({ ...e, minutes: hurried(e.minutes) })) }));
}

/**
 * 不分方向的地图：声音两头都传得到。只能单向走的路（跳下去的坑）、上坡下坡不一样快的路，按两个方向里短的那个算。
 */
export function bothWays(places: readonly MapPlace[]): MapPlace[] {
  const out = new Map(places.map((p) => [p.key, { ...p, exits: [...p.exits] }]));
  for (const p of places) {
    for (const e of p.exits) {
      const back = out.get(e.to);
      if (!back) continue;
      const same = back.exits.find((x) => x.to === p.key);
      if (!same) back.exits.push({ to: p.key, minutes: e.minutes, ...(e.hidden ? { hidden: true } : {}) });
      else if (e.minutes < same.minutes) back.exits[back.exits.indexOf(same)] = { ...same, minutes: e.minutes };
    }
  }
  return [...out.values()];
}

/** 两个地点之间最快的路线；走不到是 null，同一个地点是 0 分钟。 */
export function routeBetween(places: readonly MapPlace[], from: string, to: string, canUse: CanUse = openExits()): Route | null {
  if (from === to) return { minutes: 0, path: [from], steps: [] };
  return routesFrom(places, from, canUse).get(to) ?? null;
}

/**
 * 沿着路线走，时间只有 budget 分钟：走到来得及到的最后一个地点为止。hurry：赶路，每一段按一半算。
 * 返回停下的地点、用掉的时间、路过的地点（不含出发和停下的地点）、离终点还差几分钟（到了是 0）。
 */
export function walkRoute(route: Route, budget: number, hurry = false): { stop: string; used: number; passed: string[]; left: number } {
  const steps = route.steps.map((m) => (hurry ? hurried(m) : m));
  let used = 0;
  let i = 0;
  while (i < steps.length && used + steps[i] <= budget) {
    used += steps[i];
    i++;
  }
  const total = steps.reduce((s, m) => s + m, 0);
  return { stop: route.path[i], used, passed: route.path.slice(1, i), left: total - used };
}

/** 把分钟写成「8 分钟」「1 小时 20 分钟」「1 天 3 小时」。 */
export function travelText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.round((minutes % (24 * 60)) / 60);
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}

// ---------- 地图上的位置 ----------

/** 自动摆位置时一段路有多长：路越远越长，但按对数放大（1 分钟和 5 小时的路不至于差几百倍）。 */
function edgeLength(minutes: number): number {
  return 1 + Math.log2(1 + minutes) / 3;
}

/** 由 key 算出来的、每次都一样的小随机数（0～1），自动摆位置的起点用。 */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 两两之间最短的路有多长（按自动摆位置用的长度）；withHidden：暗道算不算。 */
function pairDistances(places: readonly MapPlace[], withHidden: boolean): number[][] {
  const n = places.length;
  const index = new Map(places.map((p, i) => [p.key, i]));
  const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  for (const [i, p] of places.entries()) {
    for (const e of p.exits) {
      const j = index.get(e.to);
      if (j === undefined || j === i || (e.hidden && !withHidden)) continue;
      const len = edgeLength(e.minutes);
      if (len < d[i][j]) d[i][j] = d[j][i] = len;
    }
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

/**
 * 地点之间按路程的远近：先只按明路算（暗道是近路的，不把两头拉到一起：不然没写位置的剧本，地图上挨着的两个「远处」就露了暗道）；
 * 明路走不到的（只有暗门进得去的密室），才按暗道算；都走不到的算成最远的再远一点。
 */
function layoutDistances(places: readonly MapPlace[]): number[][] {
  const open = pairDistances(places, false);
  const all = places.some((p) => p.exits.some((e) => e.hidden)) ? pairDistances(places, true) : open;
  const d = open.map((row, i) => row.map((v, j) => (Number.isFinite(v) ? v : all[i][j])));
  let far = 1;
  for (const row of d) for (const v of row) if (Number.isFinite(v) && v > far) far = v;
  return d.map((row) => row.map((v) => (Number.isFinite(v) ? v : far + 1)));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 地图上每个地点的位置（0～100）。剧本写了 x、y 的照写的；没写的按路程远近自动摆：
 * 路近的摆得近，写了位置的地点不动，最后把挤在一起的推开一点。同一个剧本每次摆出来都一样。
 */
export function layoutPlaces(places: readonly MapPlace[]): Record<string, Point> {
  const n = places.length;
  const out: Record<string, Point> = {};
  const fixed = places.map((p) => typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (fixed.every(Boolean)) {
    for (const p of places) out[p.key] = { x: p.x!, y: p.y! };
    return out;
  }
  if (n === 1) {
    out[places[0].key] = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    return out;
  }
  const d = layoutDistances(places);
  // 一个单位的路程在地图上占多长：地点越多越短，大致铺满地图
  const unit = MAP_SIZE / (Math.sqrt(n) * 1.6 + 1);
  const pos: Point[] = places.map((p, i) => {
    if (fixed[i]) return { x: p.x! / unit, y: p.y! / unit };
    // 起点：绕着中心按顺序排一圈，再加一点由 key 算出来的偏移，免得一开始就叠在一起
    const angle = (2 * Math.PI * i) / n + hash01(p.key) * 0.5;
    const r = (Math.sqrt(n) * 0.8) * (0.6 + hash01(`${p.key}#r`) * 0.4);
    return { x: MAP_SIZE / 2 / unit + r * Math.cos(angle), y: MAP_SIZE / 2 / unit + r * Math.sin(angle) };
  });
  // 按路程摆（stress majorization 的逐点迭代：每个点挪到让它和别的点的距离最接近路程的地方）
  for (let iter = 0; iter < 300; iter++) {
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const w = 1 / (d[i][j] * d[i][j]);
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const len = Math.hypot(dx, dy) || 1e-6;
        sx += w * (pos[j].x + (d[i][j] * dx) / len);
        sy += w * (pos[j].y + (d[i][j] * dy) / len);
        sw += w;
      }
      pos[i] = { x: sx / sw, y: sy / sw };
    }
  }
  let pts = pos.map((p) => ({ x: p.x * unit, y: p.y * unit }));
  // 一个写了位置的地点都没有：整体挪进地图里（留边），保持长宽比例
  if (!fixed.some(Boolean)) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(maxX - minX, maxY - minY, 1e-6);
    const scale = (MAP_SIZE * 0.84) / span;
    const offX = (MAP_SIZE - (maxX - minX) * scale) / 2;
    const offY = (MAP_SIZE - (maxY - minY) * scale) / 2;
    pts = pts.map((p) => ({ x: offX + (p.x - minX) * scale, y: offY + (p.y - minY) * scale }));
  }
  // 挤在一起的推开（写了位置的不动），再收进 2～98 里
  const gap = Math.min(14, MAP_SIZE / Math.sqrt(n) / 1.4);
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pts[j].x - pts[i].x;
        const dy = pts[j].y - pts[i].y;
        const len = Math.hypot(dx, dy);
        if (len >= gap) continue;
        moved = true;
        const ux = len ? dx / len : Math.cos(i + j);
        const uy = len ? dy / len : Math.sin(i + j);
        const push = (gap - len) / (fixed[i] || fixed[j] ? 1 : 2);
        if (!fixed[i]) pts[i] = { x: pts[i].x - ux * push, y: pts[i].y - uy * push };
        if (!fixed[j]) pts[j] = { x: pts[j].x + ux * push, y: pts[j].y + uy * push };
      }
    }
    if (!moved) break;
  }
  places.forEach((p, i) => {
    out[p.key] = fixed[i] ? { x: p.x!, y: p.y! } : { x: round1(Math.min(98, Math.max(2, pts[i].x))), y: round1(Math.min(98, Math.max(2, pts[i].y))) };
  });
  return out;
}

// ---------- 给玩家看的地图 ----------

/** 地图上的一个地点（玩家看到的）。people：在那里、看得到的角色名字。clues：自己知道的线索里，出自这里的（标题）。 */
export type MapNode = {
  key: string;
  name: string;
  x: number;
  y: number;
  visited: boolean;
  here: boolean;
  clues: string[];
  people: string[];
  /** 管理员看全图时：在那里的 NPC。 */
  npcs?: string[];
};

/**
 * 地图上的一条路：a、b 两头（key 按顺序排好），ab 是从 a 走到 b 要几分钟，ba 是从 b 走到 a（上山下山可以不一样）；
 * 没有的那个方向是只能单向走的（或者那个方向的门还没发现）。hidden：是暗道（看得见的出口里有暗门、暗道：发现了的，或者看全图时）。
 */
export type MapEdge = { a: string; b: string; ab?: number; ba?: number; hidden?: boolean };

/** 一条路从 from 那头出发要几分钟（走不了是 undefined）。 */
export function edgeMinutes(e: MapEdge, from: string): number | undefined {
  return from === e.a ? e.ab : from === e.b ? e.ba : undefined;
}

/** 玩家看到的地图。bounds 是整张地图的范围（没看到的地方也算在里面，地图不会越走越挪）；full：整张都看得到（对局结束了、管理员）。 */
export type MapView = {
  nodes: MapNode[];
  edges: MapEdge[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  full: boolean;
};

/**
 * 一个人（或者合作剧本里的一队人）看得到的地点和路：
 * 去过的地点；从去过的地点出发、看得见的出口（不是暗道，或者发现了的暗道）通向的地点。
 * 路只画从去过的地点看得见的那些（两个都没去过的地点之间有没有路，看不出来）。full：全部都画（暗道标出来）。
 */
export function visibleMap(
  places: readonly MapPlace[],
  opts: { visited: ReadonlySet<string>; found: ReadonlySet<string>; here: string | null; full?: boolean },
): { nodes: Set<string>; edges: MapEdge[] } {
  const keys = new Set(places.map((p) => p.key));
  const canSee = openExits(opts.found);
  const nodes = new Set<string>();
  if (opts.full) for (const k of keys) nodes.add(k);
  else {
    for (const k of opts.visited) if (keys.has(k)) nodes.add(k);
    if (opts.here && keys.has(opts.here)) nodes.add(opts.here);
    for (const p of places) {
      if (!nodes.has(p.key) || !(opts.visited.has(p.key) || p.key === opts.here)) continue;
      for (const e of p.exits) if (keys.has(e.to) && canSee(p.key, e)) nodes.add(e.to);
    }
  }
  // 路：从去过的地点看得见的出口（看全图时是所有出口）；两个方向各自要几分钟、算不算暗道，只算这个人看得见的出口
  const byKey = new Map(places.map((p) => [p.key, p]));
  const seen = (from: string, e: MapExit) => !!opts.full || canSee(from, e);
  const pairs = new Map<string, [string, string]>();
  for (const p of places) {
    if (!nodes.has(p.key)) continue;
    if (!opts.full && !opts.visited.has(p.key) && p.key !== opts.here) continue;
    for (const e of p.exits) {
      if (!nodes.has(e.to) || e.to === p.key || !seen(p.key, e)) continue;
      const k = pathKey(p.key, e.to);
      if (!pairs.has(k)) pairs.set(k, p.key < e.to ? [p.key, e.to] : [e.to, p.key]);
    }
  }
  const edges: MapEdge[] = [];
  for (const [a, b] of pairs.values()) {
    const ways = (from: string, to: string) => byKey.get(from)?.exits.filter((e) => e.to === to && seen(from, e)) ?? [];
    const there = ways(a, b);
    const back = ways(b, a);
    const edge: MapEdge = { a, b };
    if (there.length) edge.ab = Math.min(...there.map((e) => e.minutes));
    if (back.length) edge.ba = Math.min(...back.map((e) => e.minutes));
    // 有一头是暗门（看得见的出口里有暗道）就画成暗道：从明的那一头推得开的暗门也算
    if ([...there, ...back].some((e) => e.hidden)) edge.hidden = true;
    edges.push(edge);
  }
  return { nodes, edges };
}

/**
 * 在看得到的地图上从 from 出发到各处最快的路线：地图页签的地点卡片、场外问答用。
 * 看得到的路都走得通（画出来的暗道就是发现了的）。
 */
export function routesOnView(
  view: { nodes: readonly { key: string; name: string }[]; edges: readonly MapEdge[] },
  from: string,
  hurry = false,
): Map<string, Route> {
  const places: MapPlace[] = view.nodes.map((n) => ({ key: n.key, name: n.name, exits: [] }));
  const byKey = new Map(places.map((p) => [p.key, p]));
  for (const e of view.edges) {
    if (e.ab !== undefined) byKey.get(e.a)?.exits.push({ to: e.b, minutes: e.ab });
    if (e.ba !== undefined) byKey.get(e.b)?.exits.push({ to: e.a, minutes: e.ba });
  }
  return routesFrom(hurry ? hurriedPlaces(places) : places, from, anyExit);
}
