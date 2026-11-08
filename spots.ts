// 站位（V1.0.x）：一个地点里谁站在哪。不画平面图、不算几米远，只分「在不在身边」：同一个站位的就是身边的人。
// 剧本可以给地点写几个站位，带上属性；主持人也可以按情况起短名字（那样的站位没有属性）。没特别站在哪（null）就是和大家在一起。
// 服务器（主持工具、悄悄话、战斗）和网页（在场的人、角色卡、战斗面板、剧本编辑器）共用。

/** 站位的属性：嘈杂（说话、动静被盖住）、昏暗（看不清）、掩体（远程打不着）。 */
export type SpotFlag = 'noisy' | 'dark' | 'cover';
export const SPOT_FLAGS: readonly SpotFlag[] = ['noisy', 'dark', 'cover'];
export const SPOT_FLAG_LABEL: Record<SpotFlag, string> = { noisy: '嘈杂', dark: '昏暗', cover: '掩体' };

/** 剧本里地点的一个站位。 */
export type Spot = { name: string; noisy?: boolean; dark?: boolean; cover?: boolean };

/** 站位的名字最多几个字；一个地点最多几个站位。 */
export const SPOT_NAME_MAX = 12;
export const SPOTS_MAX = 8;

/** 地点里和站位有关的部分：写好的站位，整个地点嘈杂、昏暗。 */
export type SpotPlace = { spots?: readonly Spot[]; noisy?: boolean; dark?: boolean };

/** 一个站位实际的属性：地点本身嘈杂、昏暗的，站在哪都一样；站位自己再加（掩体只有站位有）。没特别站在哪只看地点的。 */
export function spotFlags(place: SpotPlace | undefined, spot: string | null | undefined): Record<SpotFlag, boolean> {
  const own = spot ? place?.spots?.find((s) => s.name === spot) : undefined;
  return { noisy: !!place?.noisy || !!own?.noisy, dark: !!place?.dark || !!own?.dark, cover: !!own?.cover };
}

/** 属性写成「嘈杂、昏暗」（没有是空字符串）。 */
export function flagText(flags: Record<SpotFlag, boolean>): string {
  return SPOT_FLAGS.filter((f) => flags[f])
    .map((f) => SPOT_FLAG_LABEL[f])
    .join('、');
}

/** 两个人是不是在身边（同一个站位；都没特别站在哪也算）。 */
export function sameSpot(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || null) === (b || null);
}

/** 没特别站在哪时的叫法。主持人照着写回来的（「大家中间」）也当成没特别站在哪。 */
export const MIDDLE = '大家中间';

/** 去掉换行、首尾空白和引号（「」『』""）。 */
function normalize(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/^[「『"“]+|[」』"”]+$/g, '')
    .trim();
}

/** 主持人、程序写进来的站位名：去掉换行、首尾空白和引号，最多 SPOT_NAME_MAX 个字；空的、「大家中间」是 null（回到大家中间）。 */
export function cleanSpot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = [...normalize(raw)].slice(0, SPOT_NAME_MAX).join('').trim();
  return name && name !== MIDDLE ? name : null;
}

/**
 * 主持人写的站位，对上这个地点剧本里写的站位：照抄了提示里带的属性（「壁炉边（嘈杂）」）的，去掉括号里的部分
 * （去掉以后对得上剧本里的才去掉，不然照原样记下）。「大家中间」是 null。
 */
export function matchSpot(place: SpotPlace | undefined, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const full = normalize(raw);
  const spots = place?.spots ?? [];
  if (spots.some((x) => x.name === full)) return full;
  const bare = full.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();
  if (bare !== full) {
    if (!bare || bare === MIDDLE) return null;
    if (spots.some((x) => x.name === bare)) return bare;
  }
  return cleanSpot(full);
}

/** 站位写给人看：「窗边」；没特别站在哪是「大家中间」。 */
export function spotName(spot: string | null | undefined): string {
  return spot || MIDDLE;
}

/** 网页上看的一个站位：名字和属性。 */
export type SpotView = { name: string; flags: SpotFlag[] };

/** 地点的站位写给网页：每个站位自己的属性（不含整个地点的），和整个地点的属性（嘈杂、昏暗）。 */
export function placeSpots(place: SpotPlace | undefined): { spots: SpotView[]; flags: SpotFlag[] } {
  return {
    spots: (place?.spots ?? []).map((x) => ({ name: x.name, flags: SPOT_FLAGS.filter((f) => !!x[f]) })),
    flags: (['noisy', 'dark'] as const).filter((f) => !!place?.[f]),
  };
}

/** 网页上站位的属性（地点的加上站位自己的），列成「嘈杂、昏暗」。 */
export function viewFlagText(place: { spots: readonly SpotView[]; flags: readonly SpotFlag[] } | null | undefined, spot: string | null | undefined): string {
  const own = spot ? place?.spots.find((x) => x.name === spot)?.flags ?? [] : [];
  const all = new Set<SpotFlag>([...(place?.flags ?? []), ...own]);
  return SPOT_FLAGS.filter((f) => all.has(f))
    .map((f) => SPOT_FLAG_LABEL[f])
    .join('、');
}
