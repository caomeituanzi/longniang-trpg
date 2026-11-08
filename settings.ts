import type { DB } from './db';

// 全站设置，存在数据库里，管理员在「管理」页改。

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** 管理员的 AI 紧急开关：关掉以后所有 AI 调用都停下。 */
export function aiEnabled(db: DB): boolean {
  return getSetting(db, 'ai_enabled') !== '0';
}

/** 新的正式账号（注册、管理员新建）一开始的 AI 额度：有「发放额度」权限的管理员在「管理」→「账号」里改，没改过是 5 美元。 */
export const START_CREDIT_SETTING = 'start_credit_usd';
export const DEFAULT_START_CREDIT_USD = 5;
export const START_CREDIT_MAX_USD = 100;

export function startCredit(db: DB): number {
  const raw = getSetting(db, START_CREDIT_SETTING);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= START_CREDIT_MAX_USD ? value : DEFAULT_START_CREDIT_USD;
}

// ---------- 注册 ----------

/** 注册方式：invite 只能用邀请码（默认）；open 开放注册，不用邀请码也能注册。 */
export type RegistrationMode = 'invite' | 'open';
export const REGISTRATION_MODE_SETTING = 'registration_mode';

export function registrationMode(db: DB): RegistrationMode {
  return getSetting(db, REGISTRATION_MODE_SETTING) === 'open' ? 'open' : 'invite';
}

/** 应急开关：暂停注册。暂停时用邀请码注册、开放注册、新开游客都不行；已经有的账号照常用，管理员在管理页新建账号也照常。 */
export const REGISTRATION_PAUSED_SETTING = 'registration_paused';

export function registrationPaused(db: DB): boolean {
  return getSetting(db, REGISTRATION_PAUSED_SETTING) === '1';
}

/** 开放注册（没用邀请码）的新账号一开始的额度：比用邀请码注册的少，默认 1 美元；0 就是不送。 */
export const OPEN_START_CREDIT_SETTING = 'open_start_credit_usd';
export const DEFAULT_OPEN_START_CREDIT_USD = 1;

export function openStartCredit(db: DB): number {
  const raw = getSetting(db, OPEN_START_CREDIT_SETTING);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= START_CREDIT_MAX_USD ? value : DEFAULT_OPEN_START_CREDIT_USD;
}

/** 开放注册每天最多送出几份初始额度（按服务器这台电脑的日期算）：到了以后，当天再注册的账号没有初始额度。 */
export const OPEN_DAILY_TRIALS_SETTING = 'open_daily_trials';
export const DEFAULT_OPEN_DAILY_TRIALS = 10;
export const OPEN_DAILY_TRIALS_MAX = 1000;

export function openDailyTrials(db: DB): number {
  const raw = getSetting(db, OPEN_DAILY_TRIALS_SETTING);
  const value = raw === null ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= OPEN_DAILY_TRIALS_MAX ? value : DEFAULT_OPEN_DAILY_TRIALS;
}
