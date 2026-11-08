import type { Deps } from '../../app';
import { permissionsOf, requireAdmin } from '../../auth';
import { requireCredit } from '../../credit';
import { validateScenario } from '../../game/scenario';
import {
  deleteScenarioFile,
  hiddenScenarios,
  isBuiltinScenario,
  isRetiredScenario,
  readScenarioFile,
  RETIRED_NAME_MESSAGE,
  SCENARIO_KEY_RE,
  scenarioFileExists,
  scenarioLibrary,
  setScenarioHidden,
  writeScenarioFile,
} from '../../game/scenario-library';
import { asObject, asString, HttpError, type Router } from '../../http';
import { PERMISSION_LABEL, type AdminPermission } from '../../../shared/admin';
import { SCENARIO_BODY_LIMIT, SCENARIO_CHECK_MAX } from '../game';
import { adminLog } from './common';

// 现成的剧本（scenarios 文件夹里的文件）：自带的只能上架、下架（删了升级时又会回来），上传的还能替换、删除。

export function registerScenarioFileRoutes(router: Router, deps: Deps) {
  const { db, engine, safety, works } = deps;
  const log = adminLog(deps);

  const library = () => scenarioLibrary(db, engine.scenarioFolder);

  /** 等了一会儿（内容检查）以后再看一次：账号还在、还是管理员、还有这项权限。 */
  function requireStillAdmin(id: number, perm: AdminPermission) {
    const row = db.prepare('SELECT is_admin, is_owner, admin_perms, banned_at, deleted_at FROM users WHERE id = ?').get(id) as
      | { is_admin: number; is_owner: number; admin_perms: string; banned_at: number | null; deleted_at: number | null }
      | undefined;
    if (!row || row.deleted_at !== null || row.banned_at !== null || !row.is_admin || !permissionsOf(row).includes(perm)) {
      throw new HttpError(403, `你的「${PERMISSION_LABEL[perm]}」权限刚刚被收回了，这次没有保存`);
    }
  }

  function scenarioKey(raw: unknown): string {
    const key = typeof raw === 'string' ? raw : '';
    if (!scenarioFileExists(engine.scenarioFolder, key)) throw new HttpError(404, '没有这个剧本');
    return key;
  }

  function titleOf(key: string): string {
    const { scenario } = readScenarioFile(engine.scenarioFolder, key);
    return scenario ? `《${scenario.title}》（${key}）` : key;
  }

  router.get('/api/admin/scenarios', (ctx) => {
    requireAdmin(ctx, 'scenarios');
    return { scenarios: library() };
  });

  // 一个剧本的全文（包括真相和各个身份的秘密）
  router.get('/api/admin/scenarios/:key', (ctx) => {
    requireAdmin(ctx, 'scenarios');
    const key = scenarioKey(ctx.params.key);
    const { scenario, errors } = readScenarioFile(engine.scenarioFolder, key);
    return { key, builtin: isBuiltinScenario(key), hidden: hiddenScenarios(db).has(key), scenario, errors };
  });

  // 上架、下架：下架的建对局时选不到，已经选了它的对局照常玩
  router.put('/api/admin/scenarios/:key/hidden', (ctx) => {
    const admin = requireAdmin(ctx, 'scenarios');
    const key = scenarioKey(ctx.params.key);
    const hidden = asObject(ctx.body).hidden;
    if (typeof hidden !== 'boolean') throw new HttpError(400, '请说明是上架还是下架');
    if (hiddenScenarios(db).has(key) === hidden) throw new HttpError(409, hidden ? '这个剧本已经下架了' : '这个剧本没有下架');
    setScenarioHidden(db, key, hidden);
    // 下架已通过审核的投稿：删掉审核已过记录，作者才能重新投稿
    if (hidden) works.takeDown(key);
    log(admin, hidden ? '下架剧本' : '上架剧本', titleOf(key));
    return { scenarios: library() };
  });

  // 上传剧本：{ key: 文件名, data: 剧本内容, replace: 覆盖同名的上传剧本 }。先检查格式，再像导入的剧本一样做内容检查
  router.post('/api/admin/scenarios', async (ctx) => {
    const admin = requireAdmin(ctx, 'scenarios');
    const body = asObject(ctx.body);
    const key = asString(body.key, { max: 200, message: '请填写剧本的文件名' }).trim().toLowerCase();
    if (!SCENARIO_KEY_RE.test(key)) throw new HttpError(400, '剧本的文件名只能用小写字母、数字和短横线');
    if (isBuiltinScenario(key)) throw new HttpError(409, '和自带的剧本重名了，换一个文件名');
    if (isRetiredScenario(key)) throw new HttpError(409, RETIRED_NAME_MESSAGE);
    const replace = body.replace === true;
    if (scenarioFileExists(engine.scenarioFolder, key) && !replace) throw new HttpError(409, '已经有同名的剧本了');
    const result = validateScenario(body.data);
    if (!result.scenario) {
      const n = result.errors.length;
      throw new HttpError(400, `剧本有${n}处错误：${result.errors.slice(0, 5).join('；')}${n > 5 ? '……' : ''}`);
    }
    const text = JSON.stringify(result.scenario);
    if (text.length > SCENARIO_CHECK_MAX) throw new HttpError(400, `剧本太长了（${text.length}个字），最多${SCENARIO_CHECK_MAX}个字`);
    requireCredit(db, admin.id);
    await safety.precheck(admin.id, null, 'scenario', text);
    // 内容检查要等一会儿：这期间权限可能被收回了，同名的剧本也可能刚被别人传上来，都按现在的样子再看一次
    requireStillAdmin(admin.id, 'scenarios');
    const exists = scenarioFileExists(engine.scenarioFolder, key);
    writeScenarioFile(engine.scenarioFolder, key, result.scenario, replace);
    log(admin, exists ? '替换剧本' : '上传剧本', `《${result.scenario.title}》（${key}）`);
    ctx.status = exists ? 200 : 201;
    return { scenarios: library() };
  }, { bodyLimit: SCENARIO_BODY_LIMIT });

  // 删除上传的剧本（自带的不能删，可以下架）。已经选了它的对局照常玩：对局里存着一份
  router.delete('/api/admin/scenarios/:key', (ctx) => {
    const admin = requireAdmin(ctx, 'scenarios');
    const key = scenarioKey(ctx.params.key);
    const title = titleOf(key);
    deleteScenarioFile(db, engine.scenarioFolder, key);
    works.takeDown(key);
    log(admin, '删除剧本', title);
    return { scenarios: library() };
  });
}
