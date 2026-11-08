import type { Deps } from '../../app';
import {
  AI_ROLES,
  MODEL_GROUP_LABEL,
  MODEL_GROUP_SETTING,
  MODEL_GROUPS,
  modelSettingKey,
  OPENROUTER_MODEL_RE,
  OPENROUTER_MODELS_SETTING,
  type AiRole,
  type ModelGroup,
} from '../../ai/client';
import { KNOWN_MODELS } from '../../ai/pricing';
import { requireAdmin, requireOwner } from '../../auth';
import { asObject, HttpError, type Router } from '../../http';
import { roundUsd } from '../../money';
import { aiEnabled, getSetting, setSetting } from '../../settings';
import { adminLog } from './common';

// AI 总开关和模型：紧急停用、各项用哪个模型、各身份开局能选的主持模型、OpenRouter 上要用的模型。
// ChatGPT 的模型（V1.0.1）经中转站调用，和 Claude、DeepSeek 的一样直接列在选项里（设了 RELAY_API_KEY 才能选）。

export function registerAiRoutes(router: Router, deps: Deps) {
  const { db, engine, ai, now } = deps;
  const log = adminLog(deps);

  const ROLE_LABEL: Record<AiRole, string> = { dm: '主持', scenario: '写剧本', misc: '杂活', guard: '内容检查', guide: '向导', review: '审核' };

  function aiInfo() {
    const at = now();
    const sum = (since: number) =>
      roundUsd((db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_calls WHERE created_at >= ?').get(since) as { c: number }).c);
    return {
      enabled: aiEnabled(db),
      provider: ai.provider.name,
      ready: ai.provider.status.ready,
      message: ai.provider.status.message,
      /** 各家的 API 密钥设置了没有（测试用的假主持人只有一家）。 */
      providers: [
        { name: ai.provider.name, label: ai.provider.name === 'fake' ? '测试用的假主持人' : 'Claude', ...ai.provider.status },
        ...(ai.deepseek ? [{ name: ai.deepseek.name, label: 'DeepSeek', ...ai.deepseek.status }] : []),
        ...(ai.openrouter ? [{ name: ai.openrouter.name, label: 'OpenRouter', ...ai.openrouter.status }] : []),
        ...(ai.relay ? [{ name: ai.relay.name, label: '中转站', ...ai.relay.status }] : []),
      ],
      /**
       * OpenRouter 上要用的模型（管理员填的）。设了 OpenRouter 的密钥（或者用的是测试用的假主持人）才有这一项。
       * fromEnv：还没在网页上改过，用的是 .env 里 OPENROUTER_MODELS 写的。
       */
      openrouter:
        ai.openrouter || ai.provider.name === 'fake'
          ? { models: ai.openRouterModels, fromEnv: getSetting(db, OPENROUTER_MODELS_SETTING) === null }
          : null,
      /** 现在用的模型（网页上选过的优先）。 */
      models: ai.models,
      /** .env 里设的（没设就是默认的），点「恢复默认」就回到这个。 */
      defaults: ai.settings.models,
      /** 哪几项是在网页上选过的。 */
      chosen: Object.fromEntries(AI_ROLES.map((r) => [r, getSetting(db, modelSettingKey(r)) !== null])),
      roles: AI_ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })),
      options: ai.modelOptions(),
      /** 开局能选的主持模型，按房主的身份分（站长都能选，只有站长能改）。 */
      dmModelGroups: Object.fromEntries(MODEL_GROUPS.map((g) => [g, ai.allowedDmModels(g)])) as Record<ModelGroup, string[]>,
      effort: ai.settings.effort,
      cost: { total: sum(0), day: sum(at - 24 * 3600_000), week: sum(at - 7 * 24 * 3600_000) },
    };
  }

  router.get('/api/admin/ai', (ctx) => {
    requireAdmin(ctx, 'ai');
    return aiInfo();
  });

  // 紧急停用：{ enabled: false } 以后所有 AI 调用都停下，在等的行动留着，打开以后接着结算
  router.put('/api/admin/ai', (ctx) => {
    const admin = requireAdmin(ctx, 'ai');
    const enabled = asObject(ctx.body).enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, '请求格式不对');
    if (enabled === aiEnabled(db)) return { enabled };
    setSetting(db, 'ai_enabled', enabled ? '1' : '0');
    log(admin, enabled ? '打开 AI' : '紧急停用 AI', '');
    engine.onAiSwitch(enabled);
    return { enabled };
  });

  // 开局能选的主持模型，按房主的身份分（只有站长能改）：{ user: [模型], admin: [模型] }，每种身份至少留一个。
  // 普通用户开的局只能选「普通用户」那一栏的模型，「跟随网站设置」的不在里面就换成 DeepSeek 的小模型（见 AiClient.roomDmDefault）
  router.put('/api/admin/ai/dm-model-groups', (ctx) => {
    const owner = requireOwner(ctx);
    const body = asObject(ctx.body);
    const known = ai.knownModels();
    const next = {} as Record<ModelGroup, string[]>;
    for (const group of MODEL_GROUPS) {
      const list = body[group];
      if (!Array.isArray(list) || list.some((m) => typeof m !== 'string' || !known.includes(m))) {
        throw new HttpError(400, `${MODEL_GROUP_LABEL[group]}能用的模型只能从 ${known.join('、')} 里选`);
      }
      if (!list.length) throw new HttpError(400, `${MODEL_GROUP_LABEL[group]}至少要能用一个模型`);
      next[group] = known.filter((m) => list.includes(m));
    }
    const describe = (g: ModelGroup, list: string[]) =>
      `${MODEL_GROUP_LABEL[g]}：${list.length === known.length ? '全部' : list.map((m) => ai.modelName(m)).join('、')}`;
    const changes: string[] = [];
    for (const group of MODEL_GROUPS) {
      const before = ai.allowedDmModels(group);
      if (before.join() === next[group].join()) continue;
      setSetting(db, MODEL_GROUP_SETTING[group], JSON.stringify(next[group]));
      changes.push(describe(group, next[group]));
    }
    if (changes.length) log(owner, '改各身份能选的主持模型', changes.join('；'));
    return aiInfo();
  });

  // 切换模型，马上生效：{ models: { dm?: 模型 | null, … } }，null 是恢复 .env 里设的（默认的）
  router.put('/api/admin/ai/models', (ctx) => {
    const admin = requireAdmin(ctx, 'ai');
    const models = asObject(asObject(ctx.body).models);
    // 先都检查一遍，有一项不行就一项都不改
    const roles = AI_ROLES.filter((role) => role in models);
    for (const role of roles) {
      const value = models[role];
      if (value === null) continue;
      if (typeof value !== 'string' || !ai.isKnownModel(value)) throw new HttpError(400, `${ROLE_LABEL[role]}的模型只能选 ${ai.knownModels().join('、')}`);
      const usable = ai.modelUsable(value);
      if (!usable.ready) throw new HttpError(409, usable.message ?? '这个模型现在用不了');
    }
    const changes: string[] = [];
    for (const role of roles) {
      const value = models[role] as string | null;
      if (value === null) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(modelSettingKey(role));
        changes.push(`${ROLE_LABEL[role]}恢复默认（${ai.settings.models[role]}）`);
      } else {
        setSetting(db, modelSettingKey(role), value);
        changes.push(`${ROLE_LABEL[role]}改成 ${value}`);
      }
    }
    if (changes.length) log(admin, '切换 AI 模型', changes.join('；'));
    return aiInfo();
  });

  // OpenRouter 上要用的模型：{ models: ['openai/gpt-5.2', …] }。填了的模型就能在上面给各项选；正在用的不能删
  router.put('/api/admin/ai/openrouter-models', async (ctx) => {
    const admin = requireAdmin(ctx, 'ai');
    const raw = asObject(ctx.body).models;
    if (!Array.isArray(raw)) throw new HttpError(400, '请求格式不对');
    const models = [...new Set(raw.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean))];
    if (models.length > 30) throw new HttpError(400, '最多填 30 个模型');
    for (const m of models) {
      if (!OPENROUTER_MODEL_RE.test(m)) throw new HttpError(400, `「${m.slice(0, 60)}」不像模型的名字：照 OpenRouter 上的写法填，前面是哪一家，用斜杠隔开`);
      if (KNOWN_MODELS.includes(m)) throw new HttpError(400, `「${m}」是 Claude 或 DeepSeek 自己的模型，不用填在这里`);
    }
    // 能从 OpenRouter 拿到模型列表的话，查一下有没有填错的（拿不到就先存下，用的时候再报错）
    const listed = await ai.refreshCatalog(true);
    if (listed && listed.length) {
      const ids = new Set(listed.map((m) => m.id));
      const missing = models.filter((m) => !ids.has(m));
      if (missing.length) throw new HttpError(400, `OpenRouter 上没有这些模型：${missing.join('、')}`);
    }
    const removed = ai.openRouterModels.filter((m) => !models.includes(m));
    const current = ai.models;
    for (const role of AI_ROLES) {
      if (removed.includes(current[role])) throw new HttpError(409, `${current[role]} 正在给「${ROLE_LABEL[role]}」用，先在上面换成别的模型再删`);
    }
    setSetting(db, OPENROUTER_MODELS_SETTING, JSON.stringify(models));
    log(admin, '设置 OpenRouter 模型', models.length ? models.join('、') : '（清空了）');
    return aiInfo();
  });
}
