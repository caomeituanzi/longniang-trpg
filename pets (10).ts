import { audit, who } from '../audit';
import { requireAdmin, requireLogin, requireUser, requireViewer } from '../auth';
import { asId, asInt, asObject, asOneOf, asString, HttpError, STREAMING, type Router } from '../http';
import { EXCHANGE_LIMITS, PET_DESCRIPTION_MAX, PET_IMAGE_MAX_BYTES, PET_NAME_MAX, type AdminPetsOverview } from '../../shared/pets';
import { sniffImage } from './social';
import type { Deps } from '../app';

// 宠物（V0.5.0）：养、改名字（用掉一张改名卡）和介绍、换图、喂食、打工、远行、日记、串门；称号、骰子皮肤、装扮；
// 管理员改换额度的设置、发龙晶。逻辑在 pets.ts。
// V0.7.0：买东西、换额度挪到商城（routes/shop.ts）；宠物留言、宠物排行去掉了。
// 宠物的名字和介绍带进剧本时才发给主持 AI，那时候和角色名一起检查内容（见 game.ts 的选身份）。

const NAME_RULE = { max: PET_NAME_MAX, message: `名字要在1～${PET_NAME_MAX}个字之间` };

function description(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || [...value.trim()].length > PET_DESCRIPTION_MAX) throw new HttpError(400, `介绍最多${PET_DESCRIPTION_MAX}个字`);
  return value.trim();
}

export function registerPetRoutes(router: Router, { db, pets, petPlay, diary, shop, limiter, now }: Deps) {
  // 宠物页。游客也能打开看看（没有宠物，也养不了：养、打工、远行……都要正式账号）
  router.get('/api/pet', (ctx) => {
    const user = requireViewer(ctx);
    return pets.page(user.id);
  });

  // 养一只：{ name, description }
  router.post('/api/pet', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    const name = asString(body.name, NAME_RULE);
    limiter.hit('pet', user.id);
    pets.create(user.id, name, description(body.description));
    ctx.status = 201;
    return pets.page(user.id);
  });

  // 改介绍；改名字要用掉一张改名卡：{ name?, description? }
  router.put('/api/pet', (ctx) => {
    const user = requireUser(ctx);
    const body = asObject(ctx.body);
    limiter.hit('pet', user.id);
    pets.update(user.id, {
      name: body.name === undefined ? undefined : asString(body.name, NAME_RULE),
      description: body.description === undefined ? undefined : description(body.description),
    });
    return pets.page(user.id);
  });

  // 换图：{ image: 'data:image/webp;base64,…' }。只收 PNG、JPEG、WebP，按文件内容认格式
  router.put('/api/pet/image', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('pet', user.id);
    const image = asObject(ctx.body).image;
    const match = typeof image === 'string' ? /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
    if (!match) throw new HttpError(400, '请选择一张图片');
    const data = Buffer.from(match[1], 'base64');
    if (data.length > PET_IMAGE_MAX_BYTES) throw new HttpError(413, `图片太大了，最大 ${PET_IMAGE_MAX_BYTES / 1024} KB`);
    const type = sniffImage(data);
    if (!type) throw new HttpError(400, '只能用 PNG、JPEG 或 WebP 图片');
    pets.setImage(user.id, type, data);
    return pets.page(user.id);
  });

  router.delete('/api/pet/image', (ctx) => {
    const user = requireUser(ctx);
    pets.removeImage(user.id);
    return pets.page(user.id);
  });

  // 宠物的图（地址里是主人的公开编号，带着换图的时间，可以一直缓存）
  router.get('/api/pets/:ref/image', (ctx) => {
    requireLogin(ctx);
    const row = pets.image(ctx.params.ref ?? '');
    if (!row) throw new HttpError(404, '没有图');
    ctx.res.writeHead(200, {
      'Content-Type': row.type,
      'Content-Length': row.data.byteLength,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Content-Disposition': 'inline',
    });
    ctx.res.end(Buffer.from(row.data));
    return STREAMING;
  });

  // 喂吃的、喝提神茶：{ item }（「我的背包」里用）
  router.post('/api/pet/use', (ctx) => {
    const user = requireUser(ctx);
    const item = asObject(ctx.body).item;
    pets.use(user.id, typeof item === 'string' ? item : '');
    return pets.page(user.id);
  });

  // ==================== 称号（账号的）、骰子皮肤、装扮：「装扮」页用 ====================

  // 能戴的称号（商城买的、成就得来的）和戴着的
  router.get('/api/me/titles', (ctx) => {
    const user = requireUser(ctx);
    return { options: pets.titleOptions(user.id), current: pets.titleKey(user.id) };
  });

  router.put('/api/me/title', (ctx) => {
    const user = requireUser(ctx);
    const title = asObject(ctx.body).title;
    if (title !== null && typeof title !== 'string') throw new HttpError(400, '请求格式不对');
    pets.setTitle(user.id, title);
    return { options: pets.titleOptions(user.id), current: pets.titleKey(user.id) };
  });

  // 骰子皮肤：{ dice: key | null }（null 是普通的）。返回「装扮」页
  router.put('/api/pet/dice', (ctx) => {
    const user = requireUser(ctx);
    const dice = asObject(ctx.body).dice;
    if (dice !== null && typeof dice !== 'string') throw new HttpError(400, '请求格式不对');
    pets.setDiceSkin(user.id, dice);
    return shop.wardrobe(user.id);
  });

  // 宠物装扮：{ outfit: key | null }。返回「装扮」页
  router.put('/api/pet/outfit', (ctx) => {
    const user = requireUser(ctx);
    const outfit = asObject(ctx.body).outfit;
    if (outfit !== null && typeof outfit !== 'string') throw new HttpError(400, '请求格式不对');
    pets.setOutfit(user.id, outfit);
    return shop.wardrobe(user.id);
  });

  // ==================== V0.6.0：远行、日记 ====================

  // 远行：{ kind: 'near' | 'far' }；叫回来
  router.post('/api/pet/trip', (ctx) => {
    const user = requireUser(ctx);
    const kind = asObject(ctx.body).kind;
    pets.startTrip(user.id, typeof kind === 'string' ? kind : '');
    return pets.page(user.id);
  });

  router.delete('/api/pet/trip', (ctx) => {
    const user = requireUser(ctx);
    pets.recallTrip(user.id);
    return pets.page(user.id);
  });

  // 日记和明信片（只有主人看得到；游客没有宠物，是空的）
  router.get('/api/pet/diary', (ctx) => {
    const user = requireViewer(ctx);
    return { entries: diary.list(user.id) };
  });

  // ==================== V0.6.0：串门 ====================

  // 串门：{ kind: 'feed' | 'pat', item? }
  router.post('/api/pets/:ref/visit', (ctx) => {
    const user = requireUser(ctx);
    limiter.hit('petPlay', user.id);
    const body = asObject(ctx.body);
    const kind = asOneOf(body.kind, ['feed', 'pat'] as const, '请求格式不对');
    return petPlay.visit(user.id, ctx.params.ref ?? '', kind, typeof body.item === 'string' ? body.item : null);
  });

  // 打工：{ job }；不干了
  router.post('/api/pet/job', (ctx) => {
    const user = requireUser(ctx);
    const job = asObject(ctx.body).job;
    pets.startJob(user.id, typeof job === 'string' ? job : '');
    return pets.page(user.id);
  });

  router.delete('/api/pet/job', (ctx) => {
    const user = requireUser(ctx);
    pets.quitJob(user.id);
    return pets.page(user.id);
  });

  // ==================== 管理员（发放额度权限） ====================

  router.get('/api/admin/pets', (ctx): AdminPetsOverview => {
    requireAdmin(ctx, 'credit');
    const recent = db
      .prepare(
        `SELECT e.crystals, e.cny, e.created_at, u.display_name, u.uid FROM crystal_exchanges e JOIN users u ON u.id = e.user_id
         ORDER BY e.id DESC LIMIT 30`,
      )
      .all() as { crystals: number; cny: number; created_at: number; display_name: string; uid: number | null }[];
    return {
      exchange: pets.exchangeSettings(),
      siteUsedThisMonth: pets.exchangedThisMonth(null),
      recent: recent.map((r) => ({ crystals: r.crystals, yuan: r.cny, at: r.created_at, name: r.display_name, uid: r.uid })),
    };
  });

  // 换额度的设置：{ enabled, rate, userCap, siteCap }
  router.put('/api/admin/pets/exchange', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const body = asObject(ctx.body);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, '请说明开还是关');
    const next = {
      enabled: body.enabled,
      rate: asInt(body.rate, { min: 1, max: EXCHANGE_LIMITS.rateMax, message: `多少龙晶换 1 元要填 1～${EXCHANGE_LIMITS.rateMax}` }),
      userCap: asInt(body.userCap, { min: 0, max: EXCHANGE_LIMITS.userCapMax, message: `每人每月最多换几元要填 0～${EXCHANGE_LIMITS.userCapMax}` }),
      siteCap: asInt(body.siteCap, { min: 0, max: EXCHANGE_LIMITS.siteCapMax, message: `全站每月最多换几元要填 0～${EXCHANGE_LIMITS.siteCapMax}` }),
    };
    const before = pets.exchangeSettings();
    pets.setExchangeSettings(next);
    const text = (s: typeof next) => (s.enabled ? `开着，${s.rate} 龙晶换 1 元，每人每月 ${s.userCap} 元，全站每月 ${s.siteCap} 元` : '关着');
    audit(db, admin.id, '改龙晶换额度', `${text(before)} → ${text(next)}`, now());
    return { exchange: pets.exchangeSettings(), siteUsedThisMonth: pets.exchangedThisMonth(null) };
  });

  // 发龙晶（负数是收回）：{ amount, note }。龙晶能换额度，所以和发额度一样：管理员不能给自己发，管理员的号只有站长能动，站长的号别人不能动
  router.post('/api/admin/users/:id/crystals', (ctx) => {
    const admin = requireAdmin(ctx, 'credit');
    const userId = asId(ctx.params.id);
    const target = db.prepare('SELECT is_guest, is_admin, is_owner, deleted_at FROM users WHERE id = ?').get(userId) as
      | { is_guest: number; is_admin: number; is_owner: number; deleted_at: number | null }
      | undefined;
    if (!target || target.deleted_at !== null) throw new HttpError(404, '没有这个用户');
    if (target.is_guest === 1) throw new HttpError(400, '游客没有龙晶');
    if (userId === admin.id) {
      if (!admin.isOwner) throw new HttpError(400, '不能给自己发龙晶');
    } else if (target.is_owner === 1) {
      throw new HttpError(403, '站长的账号不能被改龙晶');
    } else if (target.is_admin === 1 && !admin.isOwner) {
      throw new HttpError(403, '只有站长能对管理员改龙晶');
    }
    const body = asObject(ctx.body);
    const amount = typeof body.amount === 'number' ? body.amount : NaN;
    const note = body.note === undefined || body.note === '' ? '' : asString(body.note, { max: 60, message: '备注最多60个字' });
    const balance = pets.grant(admin.id, userId, amount, note);
    audit(db, admin.id, amount > 0 ? '发龙晶' : '收回龙晶', `${who(db, userId)}：${amount > 0 ? '+' : ''}${amount}${note ? `（${note}）` : ''}，现在 ${balance}`, now());
    return pets.adminSummary(userId);
  });
}
