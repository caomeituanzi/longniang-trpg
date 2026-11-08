import { requireUser, requireViewer } from '../auth';
import { checkScenario, Drafts, editorExample } from '../drafts';
import { asId, asObject, HttpError, STREAMING, type Router } from '../http';
import { scenarioSkillZip, SKILL_ZIP_NAME } from '../skill';
import { SCENARIO_BODY_LIMIT } from './game';
import { DRAFTS_MAX } from '../../shared/editor';
import type { Deps } from '../app';

// 网页剧本编辑器（V0.8.0）：草稿、检查。
// 草稿只有正式账号能存，只能看、改自己的（别人的一律说没有）；游客也能写、能检查、能导出，只是存不了。
// 用写好的剧本开局不在这里：网页照现有的流程，先建对局，再用导入剧本的接口装进去（那里有内容检查、要 AI 额度）。

/** 发整份剧本的接口：请求体上限和导入剧本一样放宽（10 万字的中文剧本大约 300KB）。 */
const SCENARIO_BODY = { bodyLimit: SCENARIO_BODY_LIMIT };

export function registerEditorRoutes(router: Router, { db, limiter, now }: Deps) {
  const drafts = new Drafts(db, now);

  router.get('/api/editor/drafts', (ctx) => {
    const user = requireUser(ctx);
    return { drafts: drafts.list(user.id), max: DRAFTS_MAX };
  });

  router.get('/api/editor/drafts/:id', (ctx) => {
    const user = requireUser(ctx);
    return { draft: drafts.get(user.id, asId(ctx.params.id)) };
  });

  // 存一份新的：{ data: 整份剧本 }，标题从 data.title 取
  router.post('/api/editor/drafts', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('editorSave', user.id);
    const draft = drafts.create(user.id, asObject(ctx.body).data);
    ctx.status = 201;
    return { draft };
  }, SCENARIO_BODY);

  router.put('/api/editor/drafts/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = asId(ctx.params.id);
    limiter.hit('editorSave', user.id);
    return { draft: drafts.update(user.id, id, asObject(ctx.body).data) };
  }, SCENARIO_BODY);

  router.delete('/api/editor/drafts/:id', (ctx) => {
    const user = requireUser(ctx);
    drafts.remove(user.id, asId(ctx.params.id));
    return { deleted: true };
  });

  // 边写边检查：{ data } → { ok, problems（最多 100 条）, errors, warnings, sections, summary }。
  // 游客也能用：按地址、按账号都限频率，太大的不查
  router.post('/api/editor/validate', (ctx) => {
    const user = requireViewer(ctx);
    limiter.hitAddress('editorCheckAddress', ctx.req);
    limiter.hit('editorCheck', user.id);
    const body = asObject(ctx.body);
    if (!('data' in body)) throw new HttpError(400, '请求格式不对：没有剧本内容（data）');
    return checkScenario(body.data);
  }, SCENARIO_BODY);

  // 新建时的「示例」：一份很短的原创剧本（不是自带的剧本，不剧透）
  router.get('/api/editor/example', (ctx) => {
    requireViewer(ctx);
    return { data: editorExample() };
  });

  // 写剧本 skill（V0.8.3）：zip，交给自己的 AI 写剧本、转换文字剧本（server/skill.ts）。游客也能下载
  router.get('/api/editor/skill', async (ctx) => {
    requireViewer(ctx);
    const data = await scenarioSkillZip();
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${SKILL_ZIP_NAME}"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(data);
    return STREAMING;
  });
}
