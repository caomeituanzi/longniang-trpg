import type { Deps } from '../../app';
import { audit } from '../../audit';
import type { User } from '../../auth';
import type { DB } from '../../db';
import { HttpError } from '../../http';
import { cnyRate, limitText, moneyText, readCurrency, readNumber, roundCents, toUsd, type Currency } from '../../money';

// 管理页好几个区都要用的：记操作记录、读要发多少额度（账号里发额度、发公告时一起发额度）。

/** 记一条操作记录（admin_audit）：哪个管理员、做了什么。 */
export function adminLog({ db, now }: Pick<Deps, 'db' | 'now'>) {
  return (admin: User, action: string, detail: string) => audit(db, admin.id, action, detail, now());
}

/** 一笔发放（负数是收回）：记账用的美元，和写进操作记录的样子（填的是人民币就写人民币）。 */
export type Grant = { usd: number; currency: Currency; text: string };

/** 发放多少：{ amount, currency }（currency 不写是美元；人民币按汇率换成美元记）。按分四舍五入，最多相当于 1000 美元。 */
export function readAmount(db: DB, body: Record<string, unknown>): Grant {
  const currency = readCurrency(body);
  const rate = cnyRate(db);
  const amount = readNumber(body.amount);
  if (amount === null || amount === 0 || Math.abs(toUsd(amount, currency, rate)) > 1000 + 1e-9) {
    throw new HttpError(400, `额度要填一个不是 0 的数，最多 ${limitText(1000, currency, rate)}`);
  }
  const rounded = roundCents(amount);
  if (rounded === 0) throw new HttpError(400, `额度最少 ${currency === 'CNY' ? '0.01 元' : '0.01 美元'}`);
  const usd = toUsd(rounded, currency, rate);
  return { usd, currency, text: moneyText(rounded, currency, usd, true) };
}
