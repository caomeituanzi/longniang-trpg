import type { Deps } from '../../app';
import { requireAdmin } from '../../auth';
import { asInt, asObject, asOneOf, HttpError, type Router } from '../../http';
import {
  CNY_RATE_MAX,
  CNY_RATE_MIN,
  CNY_RATE_SETTING,
  cnyRate,
  limitText,
  moneyText,
  readCurrency,
  readNumber,
  roundCents,
  toUsd,
} from '../../money';
import {
  OPEN_DAILY_TRIALS_MAX,
  OPEN_DAILY_TRIALS_SETTING,
  OPEN_START_CREDIT_SETTING,
  openDailyTrials,
  openStartCredit,
  REGISTRATION_MODE_SETTING,
  REGISTRATION_PAUSED_SETTING,
  registrationMode,
  registrationPaused,
  setSetting,
  START_CREDIT_MAX_USD,
  START_CREDIT_SETTING,
  startCredit,
  type RegistrationMode,
} from '../../settings';
import { trialsToday } from '../../signup';
import { adminLog } from './common';

// 注册和额度的设置：新账号的初始额度；注册方式、应急开关、开放注册的初始额度；汇率。

export function registerRegistrationRoutes(router: Router, deps: Deps) {
  const { db, now } = deps;
  const log = adminLog(deps);

  // 新的正式账号（注册、管理员新建）一开始的额度（有「发放额度」权限）：{ amount, currency }，0～100 美元（人民币按汇率换算）。
  // 已经有的账号不变
  router.put('/api/admin/start-credit', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    const currency = readCurrency(body);
    const rate = cnyRate(db);
    const raw = readNumber(body.amount);
    if (raw === null || raw < 0 || toUsd(raw, currency, rate) > START_CREDIT_MAX_USD + 1e-9) {
      throw new HttpError(400, `初始额度要填 0～${limitText(START_CREDIT_MAX_USD, currency, rate)}`);
    }
    const rounded = roundCents(raw);
    const usd = Math.min(toUsd(rounded, currency, rate), START_CREDIT_MAX_USD);
    const before = startCredit(db);
    if (Math.abs(usd - before) > 1e-9) {
      setSetting(db, START_CREDIT_SETTING, String(usd));
      log(admin, '改新账号的初始额度', `${before.toFixed(2)} 美元 → ${moneyText(rounded, currency, usd)}`);
    }
    return { startCredit: startCredit(db) };
  });

  const MODE_LABEL: Record<RegistrationMode, string> = { invite: '只能用邀请码', open: '开放注册' };
  const registrationView = () => ({
    mode: registrationMode(db),
    paused: registrationPaused(db),
    /** 开放注册（没用邀请码）的新账号送多少初始额度（美元）。 */
    openStartCredit: openStartCredit(db),
    /** 开放注册每天最多送出几份初始额度，今天已经送了几份。 */
    openDailyTrials: openDailyTrials(db),
    trialsToday: trialsToday(db, now()),
  });

  // 看注册的设置：有「注册邀请码」「发放额度」「账号管理」其中一项权限
  router.get('/api/admin/registration', (ctx) => {
    requireAdmin(ctx, ['invites', 'credit', 'users']);
    return registrationView();
  });

  // 注册方式（有「注册邀请码」权限）：{ mode: 'invite' 只能用邀请码 | 'open' 开放注册 }
  router.put('/api/admin/registration/mode', (ctx) => {
    const admin = requireAdmin(ctx, 'invites');
    const mode = asOneOf(asObject(ctx.body).mode, ['invite', 'open'] as const, '注册方式不对');
    const before = registrationMode(db);
    if (mode !== before) {
      setSetting(db, REGISTRATION_MODE_SETTING, mode);
      log(admin, '改注册方式', `${MODE_LABEL[before]} → ${MODE_LABEL[mode]}`);
    }
    return registrationView();
  });

  // 应急开关（有「注册邀请码」权限）：{ paused: true 暂停注册 | false 恢复 }。
  // 暂停时用邀请码注册、开放注册、新开游客都不行；已经有的账号照常用，管理员在管理页新建账号也照常
  router.put('/api/admin/registration/pause', (ctx) => {
    const admin = requireAdmin(ctx, 'invites');
    const paused = asObject(ctx.body).paused;
    if (typeof paused !== 'boolean') throw new HttpError(400, '请求格式不对');
    if (paused !== registrationPaused(db)) {
      setSetting(db, REGISTRATION_PAUSED_SETTING, paused ? '1' : '0');
      log(admin, paused ? '暂停注册' : '恢复注册', paused ? '用邀请码注册、开放注册、新开游客都停了' : MODE_LABEL[registrationMode(db)]);
    }
    return registrationView();
  });

  // 开放注册的初始额度（有「发放额度」权限）：{ amount, currency, daily }。
  // amount：没用邀请码注册的新账号送多少，0～100 美元（人民币按汇率换算），0 是不送；daily：每天最多送出几份
  router.put('/api/admin/registration/trial', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    const currency = readCurrency(body);
    const rate = cnyRate(db);
    const raw = readNumber(body.amount);
    if (raw === null || raw < 0 || toUsd(raw, currency, rate) > START_CREDIT_MAX_USD + 1e-9) {
      throw new HttpError(400, `初始额度要填 0～${limitText(START_CREDIT_MAX_USD, currency, rate)}`);
    }
    const daily = asInt(body.daily, { min: 0, max: OPEN_DAILY_TRIALS_MAX, message: `每天最多送出几份要填 0～${OPEN_DAILY_TRIALS_MAX}` });
    const rounded = roundCents(raw);
    const usd = Math.min(toUsd(rounded, currency, rate), START_CREDIT_MAX_USD);
    const before = { usd: openStartCredit(db), daily: openDailyTrials(db) };
    if (Math.abs(usd - before.usd) > 1e-9 || daily !== before.daily) {
      setSetting(db, OPEN_START_CREDIT_SETTING, String(usd));
      setSetting(db, OPEN_DAILY_TRIALS_SETTING, String(daily));
      log(
        admin,
        '改开放注册的初始额度',
        `${before.usd.toFixed(2)} 美元、每天最多 ${before.daily} 份 → ${moneyText(rounded, currency, usd)}、每天最多 ${daily} 份`,
      );
    }
    return registrationView();
  });

  // 汇率（有「发放额度」权限）：{ rate }，1 美元换多少人民币。网页上的人民币按它换算，填人民币发额度时也按它换成美元记
  router.put('/api/admin/cny-rate', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const raw = readNumber(asObject(ctx.body).rate);
    if (raw === null || raw < CNY_RATE_MIN || raw > CNY_RATE_MAX) throw new HttpError(400, `汇率要填 ${CNY_RATE_MIN}～${CNY_RATE_MAX}（1 美元换多少人民币）`);
    const rate = Math.round(raw * 10_000) / 10_000;
    const before = cnyRate(db);
    if (rate !== before) {
      setSetting(db, CNY_RATE_SETTING, String(rate));
      log(admin, '改汇率', `1 美元 = ${before} 元 → ${rate} 元`);
    }
    return { cnyRate: rate };
  });
}
