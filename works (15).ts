import { avatarUrl, hasPermission, identityOf, requireAdmin, requireUser, requireViewer } from '../auth';
import { requireCredit } from '../credit';
import { asId, asObject, asOneOf, asString, HttpError, type Router } from '../http';
import { CATEGORY_KEYS } from '../../shared/game';
import { frameOf } from '../../shared/pets';
import { REJECT_REASON_MAX, SUBMISSION_INTRO_MAX, type DungeonHallEntry } from '../../shared/works';
import type { Deps } from '../app';
import { SCENARIO_BODY_LIMIT, SCENARIO_CHECK_MAX } from './game';

// 剧本大厅（V0.5.0）：列出剧本、房主投稿、管理员审核、关注作者。逻辑在 works.ts。
// V0.7.1：地下城单独一页（「地下城」），不在剧本大厅里列；V1.0.0：5E 模组也单独一页（「模组」）。

export function registerWorksRoutes(router: Router, { works, social, safety, limiter, db, reviewer, cards }: Deps) {
  // 剧本大厅：能用的剧本（地下城不在这里）；正式账号还带着自己的投稿（地下城的投稿也在）
  router.get('/api/scenario-hall', (ctx) => {
    const viewer = requireViewer(ctx);
    return { scenarios: works.scenarioHall(viewer.id), submissions: viewer.isGuest ? [] : works.mine(viewer.id) };
  });

  // 地下城（V0.7.1）：分区是地下城的剧本，按难度排，每个带着通关记录。游客也能看
  router.get('/api/dungeon-hall', (ctx) => {
    const viewer = requireViewer(ctx);
    return { dungeons: works.dungeonHall(viewer.id).map((s): DungeonHallEntry => ({ ...s, records: cards.clearRecords(s.key) })) };
  });

  // 模组（V1.0.0）：5E 模组单独一页，按建议等级排。游客也能看
  router.get('/api/module-hall', (ctx) => {
    const viewer = requireViewer(ctx);
    return { modules: works.moduleHall(viewer.id) };
  });

  // ==================== 排行（V0.7.0「排行」页）、我的作品、给作者的反馈（V0.6.0） ====================

  // 作品榜：?category=分区（不写或者 all 是全部）&by=rating（好评）| plays（游玩次数）
  router.get('/api/rankings/works', (ctx) => {
    const viewer = requireViewer(ctx);
    const rawCategory = ctx.url.searchParams.get('category');
    const category = rawCategory === null || rawCategory === '' || rawCategory === 'all' ? null : asOneOf(rawCategory, CATEGORY_KEYS, '没有这个分区');
    const by = asOneOf(ctx.url.searchParams.get('by') ?? 'rating', ['rating', 'plays'] as const, '只能按好评或者游玩次数排');
    return works.workRankings(viewer.id, category, by);
  });

  // 作者榜：作品被玩完的局数
  router.get('/api/rankings/authors', (ctx) => {
    const viewer = requireViewer(ctx);
    return works.authorRankings(viewer.id);
  });

  // 我的作品：每部作品的数据、结局分布、全部短评、收到的反馈
  router.get('/api/my-works', (ctx) => {
    const user = requireUser(ctx);
    return { works: works.myWorks(user.id) };
  });

  // 给作者写反馈：{ text }
  router.post('/api/scenario-hall/:key/feedback', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('feedback', user.id);
    const text = asObject(ctx.body).text;
    const mine = works.sendFeedback(user.id, ctx.params.key ?? '', typeof text === 'string' ? text : '');
    ctx.status = 201;
    return { mine };
  });

  // 作者回复反馈：{ text }
  router.put('/api/feedback/:id/reply', (ctx) => {
    const user = requireUser(ctx);
    const text = asObject(ctx.body).text;
    works.replyFeedback(user.id, asId(ctx.params.id), typeof text === 'string' ? text : '');
    return { works: works.myWorks(user.id) };
  });

  // 删反馈：作者删收到的、写的人删自己写的、管理员（处理举报）删别人的
  router.delete('/api/feedback/:id', (ctx) => {
    const user = requireUser(ctx);
    works.deleteFeedback(user.id, asId(ctx.params.id), hasPermission(user, 'reports'));
    return { ok: true };
  });

  // ==================== 评分和结局图鉴（V0.6.0） ====================

  // 点开一个剧本：评分、短评（玩完过的人、作者、管理员才看得到）、我的评分、我达成的结局
  router.get('/api/scenario-hall/:key', (ctx) => {
    const viewer = requireViewer(ctx);
    return works.detail(viewer.id, ctx.params.key ?? '', viewer.isAdmin);
  });

  // 打分、写短评：{ stars: 1～5, comment }
  router.put('/api/scenario-hall/:key/rating', (ctx) => {
    const user = requireUser(ctx);
    const key = ctx.params.key ?? '';
    const body = asObject(ctx.body);
    limiter.hit('rating', user.id);
    works.rate(user.id, key, typeof body.stars === 'number' ? body.stars : NaN, typeof body.comment === 'string' ? body.comment : '');
    return works.detail(user.id, key, user.isAdmin);
  });

  // 管理员删一条短评（星留着）
  router.delete('/api/admin/ratings/:id/comment', (ctx) => {
    const admin = requireAdmin(ctx, 'reports');
    works.deleteComment(admin.id, asId(ctx.params.id));
    return { ok: true };
  });

  // ==================== 投稿 ====================

  // 这一局的投稿情况（只有房主有）
  router.get('/api/rooms/:id/submission', (ctx) => {
    const user = requireUser(ctx);
    return { submission: works.roomState(asId(ctx.params.id), user.id) };
  });

  // 投稿：{ category 分区, intro 简介 }。简介发出去之前也检查内容（和导入的剧本一样，违规第一次警告、第二次封号）。
  // 一键投稿（V0.9.2）：不写分区、简介的，用剧本自己写的（剧本里没写的还是要填）
  router.post('/api/rooms/:id/submission', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const body = asObject(ctx.body);
    const own = body.category === undefined || body.intro === undefined ? works.submitDefaults(roomId, user.id) : null;
    const category = body.category === undefined ? own?.category : asOneOf(body.category, CATEGORY_KEYS, '请选一个分区');
    if (!category) throw new HttpError(400, '请选一个分区');
    const introMessage = `简介要在1～${SUBMISSION_INTRO_MAX}个字之间`;
    const intro = body.intro === undefined ? own?.intro : asString(body.intro, { max: SUBMISSION_INTRO_MAX, message: introMessage });
    if (!intro || [...intro].length > SUBMISSION_INTRO_MAX) throw new HttpError(400, introMessage);
    works.checkSubmit(roomId, user.id, category);
    limiter.hit('submission', user.id);
    requireCredit(db, user.id);
    await safety.precheck(user.id, roomId, 'submission', intro);
    // 检查要等一会儿，这期间情况可能变了：submit 里会再检查一遍
    const submission = works.submit(roomId, user.id, category, intro);
    ctx.status = 201;
    return { submission, state: works.roomState(roomId, user.id) };
  });

  // 剧本编辑器里写好的剧本直接投稿（V0.9.2）：{ data: 剧本 }，分区、简介用剧本里写的。
  // 整份剧本发出去之前检查内容（和导入剧本一样；投稿交上来以后会发给 AI 审核）
  router.post(
    '/api/editor/submission',
    async (ctx) => {
      const user = requireUser(ctx);
      const data = asObject(ctx.body).data;
      const scenario = works.checkDraftSubmit(user.id, data);
      const text = JSON.stringify(scenario);
      if (text.length > SCENARIO_CHECK_MAX) throw new HttpError(400, `剧本太长了（${text.length}个字），最多${SCENARIO_CHECK_MAX}个字`);
      limiter.hit('submission', user.id);
      requireCredit(db, user.id);
      await safety.precheck(user.id, null, 'draft', text);
      // 检查要等一会儿，这期间情况可能变了：submitDraft 里会再检查一遍
      const submission = works.submitDraft(user.id, data);
      ctx.status = 201;
      return { submission };
    },
    { bodyLimit: SCENARIO_BODY_LIMIT },
  );

  // 我的投稿（新的在前）：剧本编辑器里看写的这个剧本投过没有
  router.get('/api/submissions', (ctx) => {
    const user = requireUser(ctx);
    return { submissions: works.mine(user.id) };
  });

  // 撤回还没审的投稿
  router.delete('/api/submissions/:id', (ctx) => {
    const user = requireUser(ctx);
    return { submission: works.withdraw(user.id, asId(ctx.params.id)) };
  });

  // ==================== 关注作者 ====================

  // 我关注的人（社交页的「关注」列表）：新关注的在前；带着他在剧本大厅里有几部作品、最新的一部。
  // 游客不能关注别人、也没人关注游客：社交页照样能打开看看，这里是空的
  router.get('/api/follows', (ctx) => {
    const user = requireViewer(ctx);
    if (user.isGuest) return { following: [], followers: 0 };
    const rows = db
      .prepare(
        `SELECT u.id, u.public_id, u.display_name, u.is_admin, u.is_owner, u.is_guest, u.avatar_at, u.avatar_frame, f.created_at
         FROM follows f JOIN users u ON u.id = f.author_id
         WHERE f.follower_id = ? AND u.deleted_at IS NULL AND u.banned_at IS NULL ORDER BY f.created_at DESC`,
      )
      .all(user.id) as {
      id: number;
      public_id: string;
      display_name: string;
      is_admin: number;
      is_owner: number;
      is_guest: number;
      avatar_at: number | null;
      avatar_frame: string | null;
      created_at: number;
    }[];
    const hall = works.hall(user.id);
    return {
      following: rows.map((r) => {
        const mine = hall.filter((s) => s.authorUser?.publicId === r.public_id);
        return {
          publicId: r.public_id,
          displayName: r.display_name,
          avatar: avatarUrl(r.public_id, r.avatar_at),
          identity: identityOf(r),
          frame: frameOf(r.avatar_frame),
          since: r.created_at,
          works: mine.length,
          latest: mine[0] ? { key: mine[0].key, title: mine[0].title, category: mine[0].category } : null,
        };
      }),
      followers: works.followers(user.id),
    };
  });

  function author(ref: string | undefined) {
    const target = ref ? social.findUser(ref) : undefined;
    if (!target || target.banned_at !== null) throw new HttpError(404, '没有这个用户');
    return target;
  }

  router.post('/api/users/:ref/follow', (ctx) => {
    const user = requireUser(ctx);
    const target = author(ctx.params.ref);
    works.follow(user.id, target.id);
    return { following: true, followers: works.followers(target.id) };
  });

  router.delete('/api/users/:ref/follow', (ctx) => {
    const user = requireUser(ctx);
    const target = author(ctx.params.ref);
    works.unfollow(user.id, target.id);
    return { following: false, followers: works.followers(target.id) };
  });

  // ==================== 管理员审核（剧本管理权限） ====================

  router.get('/api/admin/submissions', (ctx) => {
    requireAdmin(ctx, 'scenarios');
    return { submissions: works.adminList() };
  });

  // 投稿的全文（包括真相）
  router.get('/api/admin/submissions/:id', (ctx) => {
    requireAdmin(ctx, 'scenarios');
    return works.adminView(asId(ctx.params.id));
  });

  router.post('/api/admin/submissions/:id/approve', (ctx) => {
    const admin = requireAdmin(ctx, 'scenarios');
    works.approve(admin.id, asId(ctx.params.id));
    return { submissions: works.adminList() };
  });

  // 不通过：{ reason } 告诉投稿的人为什么
  router.post('/api/admin/submissions/:id/reject', (ctx) => {
    const admin = requireAdmin(ctx, 'scenarios');
    const reason = asString(asObject(ctx.body).reason, { max: REJECT_REASON_MAX, message: `原因要在1～${REJECT_REASON_MAX}个字之间` });
    works.reject(admin.id, asId(ctx.params.id), reason);
    return { submissions: works.adminList() };
  });

  // ==================== AI 审核（V0.6.0） ====================

  // 让 AI（重新）审一遍：{ target: submission | report, id }。投稿要「剧本管理」权限，举报要「处理举报」权限
  router.post('/api/admin/ai-reviews', (ctx) => {
    const body = asObject(ctx.body);
    const target = asOneOf(body.target, ['submission', 'report'] as const, '请求格式不对');
    const admin = requireAdmin(ctx, target === 'submission' ? 'scenarios' : 'reports');
    const id = asId(String(body.id ?? ''));
    return { review: reviewer.start(target, id, admin.id) };
  });

  router.get('/api/admin/ai-reviews/:target/:id', (ctx) => {
    const target = asOneOf(ctx.params.target, ['submission', 'report'] as const, '请求格式不对');
    requireAdmin(ctx, target === 'submission' ? 'scenarios' : 'reports');
    return { review: reviewer.latest(target, asId(ctx.params.id)) };
  });
}
