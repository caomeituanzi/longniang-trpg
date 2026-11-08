import type { DB } from './db';
import { HttpError } from './http';
import { roundUsd } from './money';
import type { Credit } from '../shared/game';

// 每人的 AI 额度：管理员发放的总额（默认 5 美元，累计，不按月清零），减去记在他名下的花费。
// 站长、被设成“不限”的人没有上限（其他管理员要不要不限，由站长决定）。

const money = (n: number) => `$${n.toFixed(2)}`;

export function creditOf(db: DB, userId: number): Credit {
  const user = db.prepare('SELECT is_owner, ai_credit_usd, ai_unlimited FROM users WHERE id = ?').get(userId) as
    | { is_owner: number; ai_credit_usd: number; ai_unlimited: number }
    | undefined;
  const { spent } = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_call_shares WHERE user_id = ?').get(userId) as {
    spent: number;
  };
  const total = user?.ai_credit_usd ?? 0;
  const unlimited = !!user && (user.is_owner === 1 || user.ai_unlimited === 1);
  return { spent: roundUsd(spent), total: roundUsd(total), unlimited, remaining: unlimited ? null : roundUsd(total - spent) };
}

/** 额度用完了（不限额度的人永远不会用完）。 */
export function outOfCredit(db: DB, userId: number): boolean {
  const c = creditOf(db, userId);
  return c.remaining !== null && c.remaining <= 0;
}

/** 额度用完了就不能再发起新的 AI 调用（交行动、提问、生成剧本）；已经在等的行动照样结算。 */
export function requireCredit(db: DB, userId: number) {
  const c = creditOf(db, userId);
  if (c.remaining !== null && c.remaining <= 0) {
    throw new HttpError(403, `你的 AI 额度用完了（已经用了 ${money(c.spent)}，一共 ${money(c.total)}），请找管理员发放额度`);
  }
}
