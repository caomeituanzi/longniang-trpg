import type { Deps } from '../../app';
import { requireAdmin } from '../../auth';
import { CREDIT_CODE_MAX_USD, CUSTOM_CODE_RULE, newRandomCode, normalizeCode } from '../../credit-codes';
import { asId, asInt, asObject, asString, HttpError, type Router } from '../../http';
import { cnyRate, limitText, moneyText, readCurrency, readNumber, roundCents, toUsd } from '../../money';
import { adminLog } from './common';

// 额度兑换码。有「发放额度」权限的管理员生成、删除。删掉以后不能再兑换，已经兑换的额度不受影响

export function registerCreditCodeRoutes(router: Router, deps: Deps) {
  const { db, now } = deps;
  const log = adminLog(deps);

  type CreditCodeRow = {
    id: number;
    display: string;
    amount_usd: number;
    reusable: number;
    note: string;
    expires_at: number;
    created_at: number;
    by_name: string | null;
    uses: number;
    used_names: string | null;
  };
  const CREDIT_CODE_SELECT = `
    SELECT c.id, c.display, c.amount_usd, c.reusable, c.note, c.expires_at, c.created_at, u.display_name AS by_name,
      (SELECT COUNT(*) FROM credit_code_uses x WHERE x.code_id = c.id) AS uses,
      (SELECT group_concat(n, '、') FROM (SELECT v.display_name AS n FROM credit_code_uses x JOIN users v ON v.id = x.user_id
         WHERE x.code_id = c.id ORDER BY x.id LIMIT 20)) AS used_names
    FROM credit_codes c LEFT JOIN users u ON u.id = c.created_by`;

  /** status：active 还能兑换；used 单次的已经被用了；expired 过期了。 */
  function toCreditCode(r: CreditCodeRow, at: number) {
    const status = r.expires_at <= at ? 'expired' : r.reusable !== 1 && r.uses > 0 ? 'used' : 'active';
    return {
      id: r.id,
      code: r.display,
      amount: r.amount_usd,
      reusable: r.reusable === 1,
      note: r.note,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      by: r.by_name,
      uses: r.uses,
      /** 兑换过的人（最早的 20 个）。 */
      usedBy: r.used_names ? r.used_names.split('、') : [],
      status,
    };
  }

  router.get('/api/admin/credit-codes', (ctx) => {
    requireAdmin(ctx, 'credit');
    const at = now();
    const rows = db.prepare(`${CREDIT_CODE_SELECT} ORDER BY c.id DESC LIMIT 300`).all() as CreditCodeRow[];
    return { codes: rows.map((r) => toCreditCode(r, at)) };
  });

  // 生成：{ amount（美元）, reusable（true：每个人各能用一次；false：只能一个人用一次）, days（有效期）, code?（自己写的兑换码，不写就随机）, note? }
  router.post('/api/admin/credit-codes', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    // 额度可以填人民币（currency: 'CNY'），按汇率换成美元记
    const currency = readCurrency(body);
    const rate = cnyRate(db);
    const raw = readNumber(body.amount);
    if (raw === null || raw <= 0 || toUsd(raw, currency, rate) > CREDIT_CODE_MAX_USD + 1e-9) {
      throw new HttpError(400, `额度要在 0～${limitText(CREDIT_CODE_MAX_USD, currency, rate)}之间`);
    }
    const rounded = roundCents(raw);
    if (rounded <= 0) throw new HttpError(400, `额度至少 ${currency === 'CNY' ? '0.01 元' : '0.01 美元'}`);
    const amount = toUsd(rounded, currency, rate);
    const reusable = body.reusable === true;
    const days = asInt(body.days, { min: 1, max: 365, message: '有效期要在1～365天之间' });
    const note = body.note === undefined || body.note === '' ? '' : asString(body.note, { max: 40, message: '备注最多40个字' });
    let code: string;
    let display: string;
    if (typeof body.code === 'string' && body.code.trim()) {
      display = body.code.trim().slice(0, 60);
      code = normalizeCode(display);
      if (!CUSTOM_CODE_RULE.test(code)) throw new HttpError(400, '兑换码要用 4～24 个字母、数字或汉字（空格、短横线、下划线不算）');
      if (db.prepare('SELECT 1 FROM credit_codes WHERE code = ?').get(code)) throw new HttpError(409, '这个兑换码已经有了，换一个');
    } else {
      ({ code, display } = newRandomCode(db));
    }
    const at = now();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO credit_codes (code, display, amount_usd, reusable, note, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(code, display, amount, reusable ? 1 : 0, note, at + days * 24 * 60 * 60 * 1000, admin.id, at);
    log(admin, '生成兑换码', `${display}：${currency === 'CNY' ? moneyText(rounded, currency, amount) : `${amount} 美元`}，${reusable ? '可重复（每人一次）' : '单次'}，${days}天有效${note ? `（${note}）` : ''}`);
    ctx.status = 201;
    return { code: toCreditCode(db.prepare(`${CREDIT_CODE_SELECT} WHERE c.id = ?`).get(Number(lastInsertRowid)) as CreditCodeRow, at) };
  });

  router.delete('/api/admin/credit-codes/:id', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const id = asId(ctx.params.id);
    const row = db.prepare('SELECT display FROM credit_codes WHERE id = ?').get(id) as { display: string } | undefined;
    if (!row) throw new HttpError(404, '没有这个兑换码');
    db.prepare('DELETE FROM credit_codes WHERE id = ?').run(id);
    log(admin, '删除兑换码', row.display);
    return { ok: true };
  });
}
