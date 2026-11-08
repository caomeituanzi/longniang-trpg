import type { DB } from './db';
import { HttpError } from './http';
import { getSetting } from './settings';

// 金额：账本都按美元记（AI 的价格是美元标的）。网页上每个人自己选看人民币还是美元（默认人民币），按汇率换算。
// 管理员发额度、生成兑换码、设新账号的初始额度时也可以填人民币，按汇率换成美元记：
// 换成的美元不四舍五入到分，换回人民币显示时还是填的那个数（汇率改了以后跟着变）。

export type Currency = 'USD' | 'CNY';

export const CNY_RATE_SETTING = 'usd_cny_rate';
/** 默认汇率：1 美元换多少人民币（2026年10月23日的市场汇率约 6.68）。有「发放额度」权限的管理员在「管理」→「账号」里改。 */
export const DEFAULT_CNY_RATE = 6.68;
export const CNY_RATE_MIN = 1;
export const CNY_RATE_MAX = 20;

export function cnyRate(db: DB): number {
  const raw = getSetting(db, CNY_RATE_SETTING);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value >= CNY_RATE_MIN && value <= CNY_RATE_MAX ? value : DEFAULT_CNY_RATE;
}

/** 填的是哪种钱：不写是美元（以前的请求）。 */
export function readCurrency(body: Record<string, unknown>): Currency {
  if (body.currency === undefined || body.currency === 'USD') return 'USD';
  if (body.currency === 'CNY') return 'CNY';
  throw new HttpError(400, '币种只能是人民币或美元');
}

/** 金额按分四舍五入。不是数返回 null。 */
export function readNumber(raw: unknown): number | null {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const roundCents = (n: number) => Math.round(n * 100) / 100;

/** 美元保留到小数点后 4 位：额度、AI 的花费给人看的时候用。 */
export const roundUsd = (n: number) => Math.round(n * 10000) / 10000;

/** 填的钱换成美元。 */
export function toUsd(amount: number, currency: Currency, rate: number): number {
  return currency === 'CNY' ? amount / rate : amount;
}

/** 上限写成填的那种钱：「1000 美元」「¥6680.00（1000 美元）」。 */
export function limitText(maxUsd: number, currency: Currency, rate: number): string {
  return currency === 'CNY' ? `¥${(maxUsd * rate).toFixed(2)}（${maxUsd} 美元）` : `${maxUsd} 美元`;
}

/** 写进操作记录的金额：填的人民币后面带上折成多少美元。signed：正数前面加 + 号。 */
export function moneyText(amount: number, currency: Currency, usd: number, signed = false): string {
  if (currency === 'USD') return `${signed && amount > 0 ? '+' : ''}${amount.toFixed(2)} 美元`;
  const sign = amount < 0 ? '-' : signed ? '+' : '';
  return `${sign}¥${Math.abs(amount).toFixed(2)}（约 ${Math.abs(usd).toFixed(2)} 美元）`;
}

/** 一笔美元写成某种钱给人看（报错用）。 */
export function showMoney(usd: number, currency: Currency, rate: number): string {
  return currency === 'CNY' ? `¥${(usd * rate).toFixed(2)}` : `${usd.toFixed(2)} 美元`;
}
