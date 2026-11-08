import { randomCode } from './auth';
import { transaction, type DB } from './db';
import { HttpError } from './http';

// 额度兑换码：管理员在管理页生成（金额、单次还是可重复、有效期；可以自己写兑换码，也可以随机生成），玩家在账号设置里输入兑换。
// 单次的：只能被一个人兑换一次。可重复的：每个账号各能兑换一次，到有效期为止。
// 兑换时额度直接加到账号上，同时记一条发放记录；所以删掉兑换码以后，已经兑换的额度不受影响。

/** 一个兑换码最多给多少美元（再多就在账号里直接发放）。 */
export const CREDIT_CODE_MAX_USD = 100;

/** 比对用的写法：去掉空格、短横线、下划线，字母换成大写（输入时这些都不管）。 */
export function normalizeCode(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s_-]+/g, '').toUpperCase();
}

/** 管理员自己写的兑换码：去掉空格、短横线、下划线以后是 4～24 个字母、数字或汉字。 */
export const CUSTOM_CODE_RULE = /^[\p{L}\p{N}]{4,24}$/u;

/** 随机兑换码：12 位（不用容易看错的字母和数字），显示成 4 位一组。 */
export function newRandomCode(db: DB): { code: string; display: string } {
  for (;;) {
    const code = randomCode(12);
    if (!db.prepare('SELECT 1 FROM credit_codes WHERE code = ?').get(code)) return { code, display: code.match(/.{4}/g)!.join('-') };
  }
}

type CodeRow = { id: number; display: string; amount_usd: number; reusable: number; note: string; expires_at: number; created_by: number | null };

/** 兑换。成功返回加了多少美元；兑换码不对、过期、用过了抛出说明。 */
export function redeemCreditCode(db: DB, userId: number, raw: string, now: number): { amount: number; code: string } {
  const code = normalizeCode(raw);
  if (!code) throw new HttpError(400, '请填写兑换码');
  return transaction(db, () => {
    const row = db.prepare('SELECT id, display, amount_usd, reusable, note, expires_at, created_by FROM credit_codes WHERE code = ?').get(code) as CodeRow | undefined;
    if (!row) throw new HttpError(404, '兑换码不对，或者已经删掉了');
    if (row.expires_at <= now) throw new HttpError(410, '这个兑换码已经过期了');
    if (db.prepare('SELECT 1 FROM credit_code_uses WHERE code_id = ? AND user_id = ?').get(row.id, userId)) {
      throw new HttpError(409, '你已经兑换过这个兑换码了');
    }
    if (row.reusable !== 1 && db.prepare('SELECT 1 FROM credit_code_uses WHERE code_id = ?').get(row.id)) {
      throw new HttpError(409, '这个兑换码已经被用过了');
    }
    db.prepare('INSERT INTO credit_code_uses (code_id, user_id, created_at) VALUES (?, ?, ?)').run(row.id, userId, now);
    db.prepare('UPDATE users SET ai_credit_usd = ai_credit_usd + ? WHERE id = ?').run(row.amount_usd, userId);
    db.prepare('INSERT INTO credit_grants (user_id, amount_usd, granted_by, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      row.amount_usd,
      row.created_by,
      `兑换码 ${row.display}${row.note ? `（${row.note}）` : ''}`,
      now,
    );
    return { amount: row.amount_usd, code: row.display };
  });
}
