import { requireUser, requireViewer } from '../auth';
import { requireCredit } from '../credit';
import { companionsOf, loadAiSeats } from '../game/companions';
import { loadCharacters, loadScenario } from '../game/world';
import { asId, type Router } from '../http';
import { parsePersonaInput, personaCheckText, textChanged } from '../personas';
import type { PersonaInviteRoom, PersonaSort } from '../../shared/personas';
import type { Deps } from '../app';

// AI 大厅（V1.1.0）：玩家自己做的 AI 角色。规则见 server/personas.ts；请进对局走 AI 补位的接口（PUT /api/rooms/:id/ai-seats/:roleKey { personaId }）。
// 看：游客也能看大厅（顶栏的每一页游客都能打开看看）；做、改、删、请进对局要正式账号。
// 名字、简介、人设会写进给 AI 的提示词：新建、改了文字的先做内容检查（花他自己的额度，和别的内容检查一样）。

export function registerPersonaRoutes(router: Router, { db, personas, safety, limiter, rooms, engine }: Deps) {
  // 看得到别人不公开的人设的：有「举报和大厅聊天」权限的管理员（和下架要的权限一样）
  const reviewer = (user: { isAdmin: boolean; permissions: string[] }) => user.isAdmin && user.permissions.includes('reports');

  /** 列表：?scope=hall（AI 大厅，公开的）或 mine（自己做的）；大厅可以 q 找名字、简介，sort=popular|new，offset 翻页。 */
  router.get('/api/ai-personas', (ctx) => {
    const user = requireViewer(ctx);
    const params = ctx.url.searchParams;
    const scope = params.get('scope') === 'mine' ? 'mine' : 'hall';
    if (scope === 'mine' && user.isGuest) return { personas: [], more: false };
    const sort: PersonaSort = params.get('sort') === 'new' ? 'new' : 'popular';
    const offset = Math.min(Number(params.get('offset')) || 0, 100_000);
    const q = (params.get('q') ?? '').slice(0, 40);
    return personas.list({ id: user.id, isAdmin: reviewer(user) }, { scope, q, sort, offset });
  });

  router.get('/api/ai-personas/:id', (ctx) => {
    const user = requireViewer(ctx);
    return { persona: personas.get(asId(ctx.params.id), { id: user.id, isAdmin: reviewer(user) }) };
  });

  // 新建：{ name, intro?, prompt, public?, card5e? }（card5e 和做 5E 角色卡的格式一样）
  router.post('/api/ai-personas', async (ctx) => {
    const user = requireUser(ctx);
    const input = parsePersonaInput(ctx.body);
    limiter.hit('persona', user.id);
    requireCredit(db, user.id);
    await safety.precheck(user.id, null, 'persona', personaCheckText(input));
    ctx.status = 201;
    return { persona: personas.create(user.id, input) };
  });

  // 修改：没写的项照旧；只改公开不公开的不用再检查内容。还在开团准备、请了它的对局跟着换（推给开着的页面）
  router.put('/api/ai-personas/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = asId(ctx.params.id);
    const before = personas.own(user.id, id);
    const input = parsePersonaInput(ctx.body, before);
    limiter.hit('persona', user.id);
    if (textChanged(before, input)) {
      requireCredit(db, user.id);
      await safety.precheck(user.id, null, 'persona', personaCheckText(input));
    }
    const { persona, rooms: changed } = personas.update(user.id, id, input);
    for (const roomId of changed) engine.pushGame(roomId);
    return { persona };
  });

  // 删掉：作者自己，或者有「举报和大厅聊天」权限的管理员（处理举报时下架：没结束的对局里换下来，记录里告诉大家）
  router.delete('/api/ai-personas/:id', (ctx) => {
    const user = requireUser(ctx);
    const { name, seats } = personas.remove(asId(ctx.params.id), { id: user.id, isAdmin: reviewer(user) });
    for (const s of seats) rooms.addLog(s.roomId, 'system', `「${s.roleName}」请来的 AI 角色被管理员下架了，改由主持人顺带演。`);
    for (const roomId of new Set(seats.map((s) => s.roomId))) engine.pushGame(roomId);
    return { ok: true, name };
  });

  /**
   * 能把这个 AI 角色请进去的对局：自己当房主、在开团准备、选好了剧本（地下城除外；5E 对局 V1.2.0 起也能请）、
   * 还有没人选的身份（主持人顺带演的、请了别的 AI 角色的也列出来，可以换成它）。
   */
  router.get('/api/ai-personas/:id/rooms', (ctx) => {
    const user = requireUser(ctx);
    const id = asId(ctx.params.id);
    personas.usable(id, user.id);
    const rows = db
      .prepare(
        `SELECT r.id, r.name FROM rooms r
         WHERE r.host_user_id = ? AND r.status = 'preparing' AND EXISTS (SELECT 1 FROM scenarios s WHERE s.room_id = r.id)
         ORDER BY r.created_at DESC LIMIT 30`,
      )
      .all(user.id) as { id: number; name: string }[];
    const rooms: PersonaInviteRoom[] = [];
    for (const r of rows) {
      const stored = loadScenario(db, r.id);
      if (!stored || stored.scenario.dungeon) continue;
      if (db.prepare("SELECT 1 FROM scenario_jobs WHERE room_id = ? AND status = 'running'").get(r.id)) continue;
      const taken = new Set(loadCharacters(db, r.id).map((c) => c.roleKey));
      const seats = companionsOf(stored.scenario, loadAiSeats(db, r.id), taken);
      const roles = stored.scenario.roles
        .filter((role) => !taken.has(role.key))
        .map((role) => ({ key: role.key, name: role.name, public: role.public, ai: seats.find((c) => c.roleKey === role.key)?.name ?? null }));
      if (roles.length) rooms.push({ roomId: r.id, name: r.name, scenarioTitle: stored.scenario.title, roles });
    }
    return { rooms };
  });
}
