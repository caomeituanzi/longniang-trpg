// 好几处都要用的小工具。

import { HttpError } from './http';

/** 今天（服务器这台电脑上的日历日）从什么时候开始：每天的次数、上限按它算。 */
export function dayStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 这个月（服务器这台电脑上的日历月）从什么时候开始。 */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** LIKE 查询里把 \、%、_ 转义（配合 ESCAPE '\\'）：用户输入的字当普通字来找。 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 看不见、却会捣乱的字符（V0.8.0 安全审查）：换行、制表这些控制字符；改文字方向的字符（U+200E、U+200F、U+061C、
 * U+202A～U+202E、U+2066～U+2069，比如把后面的字倒过来显示的 U+202E）；零宽字符（U+200B～U+200D、U+2060、U+FEFF）；
 * 软连字符、蒙古文元音分隔符；「标签字符」（U+E0000～U+E007F：看不见，AI 却读得到）。
 * 名字里有这些，能让名字看起来和别人的一样、把后面的字倒着显示，或者偷偷混进给主持 AI 的提示词。
 */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

/** 文字里有没有看不见的字符（见 INVISIBLE_RE）。名字这类短文字用它挡掉。 */
export function hasInvisibleChars(text: string): boolean {
  return INVISIBLE_RE.test(text);
}

/** 新起的名字里有看不见的字符时的报错：显示名、角色名、宠物名、角色卡名、群名、称号、AI 队友的名字都用这一句。 */
export const INVISIBLE_NAME_MESSAGE = '名字里有看不见的字符（换行、零宽字符、改文字方向的字符），删掉再试';

/** 新提交的名字有看不见的字符：报 400。已经存着的名字不查、照常显示（调用的地方只在名字新起、改了的时候用它）。 */
export function rejectInvisibleName(name: string): void {
  if (hasInvisibleChars(name)) throw new HttpError(400, INVISIBLE_NAME_MESSAGE);
}
