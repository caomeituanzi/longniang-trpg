import { audit } from '../audit';
import { requireUser, requireViewer } from '../auth';
import { requireCredit } from '../credit';
import { asId, asObject, asOneOf, HttpError, type Router } from '../http';
import type { Deps } from '../app';

// 跑团本身的接口：选剧本、车卡、行动、场外问答、对白、协助、给东西、游戏状态。具体逻辑都在游戏引擎里。
// 玩家写的、要发给 AI 的内容（行动、提问、对白、角色名、导入的剧本、生成剧本的要求），
// 先做普通检查，再看额度，再发给 AI 检查内容，都没问题才真的提交。

/** 导入的剧本最多检查这么多字（剧本格式本身也有长度限制，正常的剧本远远到不了）。 */
export const SCENARIO_CHECK_MAX = 100_000;

/**
 * 发整份剧本的接口（导入剧本、管理员上传、剧本编辑器的检查和存草稿）的请求体上限（V0.8.0）：
 * 10 万字的中文剧本写成 JSON 大约 300KB，比一般接口的 256KB 大，这几个接口单独放到 400KB。
 */
export const SCENARIO_BODY_LIMIT = 400 * 1024;

/** 合并的输入框里，以问号开头的是问主持人的问题。 */
const QUESTION_PREFIX = /^[?？]+\s*/;

export function registerGameRoutes(router: Router, { db, rooms, engine, studio, safety, limiter, now, works }: Deps) {
  // scenarios 文件夹里能选的剧本（就是 engine.listScenarios()，文件没变时不重新读）
  router.get('/api/scenarios', (ctx) => {
    requireUser(ctx);
    return { scenarios: works.listedScenarios() };
  });

  // 游戏状态。不在这一局里的人（观看）只给公开的部分
  router.get('/api/rooms/:id/game', (ctx) => {
    const user = requireViewer(ctx);
    return engine.gameState(asId(ctx.params.id), user.id);
  });

  // 上次离开以后这一局发生了什么（只有自己的角色知道的部分）
  router.get('/api/rooms/:id/catchup', (ctx) => {
    const user = requireUser(ctx);
    // until：只算到这一条为止。页面打开后再来问摘要写好没有时带上，免得把刚刚在线看到的也算进去
    const until = ctx.url.searchParams.get('until');
    return engine.catchup(asId(ctx.params.id), user.id, until ? asId(until) : null);
  });

  // 房主（或能管这一局的管理员）选剧本：{ key: 文件名 }，或者导入 { data: 剧本内容 }（导入的先检查内容）
  router.post('/api/rooms/:id/scenario', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const { by } = rooms.requireManager(roomId, user.id, '只有房主能选剧本');
    const body = asObject(ctx.body);
    const choice = engine.parseScenarioChoice(roomId, { key: body.key, data: body.data });
    if (choice.source === 'imported') {
      requireCredit(db, user.id);
      const text = JSON.stringify(choice.scenario);
      if (text.length > SCENARIO_CHECK_MAX) throw new HttpError(400, `剧本太长了（${text.length}个字），最多${SCENARIO_CHECK_MAX}个字`);
      await safety.precheck(user.id, roomId, 'scenario', text);
      rooms.requireManager(roomId, user.id, '只有房主能选剧本');
    }
    engine.applyScenarioChoice(roomId, choice, by);
    if (by !== '房主') audit(db, user.id, '替对局选剧本', `对局 ${roomId}：《${choice.scenario.title}》`, now());
    rooms.notifyHall(roomId);
    return engine.gameState(roomId, user.id);
  }, { bodyLimit: SCENARIO_BODY_LIMIT });

  // 用不用 5E 规则玩这个剧本（V1.0.0 5E mod）：{ on: true | false }。只有房主（或能管这一局的管理员），开局前
  router.put('/api/rooms/:id/scenario/mod5e', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    const on = asObject(ctx.body).on;
    if (typeof on !== 'boolean') throw new HttpError(400, '请求格式不对');
    engine.setMod5e(roomId, user.id, on);
    rooms.notifyHall(roomId);
    return engine.gameState(roomId, user.id);
  });

  // AI 生成剧本、把文本剧本转成这里的格式：在后台做，进度通过推送告诉这一局的人
  router.post('/api/rooms/:id/scenario/generate', async (ctx) => {
    const user = requireUser(ctx);
    const job = await studio.generate(asId(ctx.params.id), user.id, ctx.body);
    ctx.status = 202;
    return { job };
  });

  router.post('/api/rooms/:id/scenario/convert', async (ctx) => {
    const user = requireUser(ctx);
    const job = await studio.convert(asId(ctx.params.id), user.id, ctx.body);
    ctx.status = 202;
    return { job };
  });

  // 最近一次生成或转换的情况；取消正在进行的
  router.get('/api/rooms/:id/scenario/job', (ctx) => {
    const user = requireViewer(ctx);
    return { job: studio.latest(asId(ctx.params.id), user.id) };
  });

  router.delete('/api/rooms/:id/scenario/job', (ctx) => {
    const user = requireUser(ctx);
    return { job: studio.cancel(asId(ctx.params.id), user.id) };
  });

  // 房主看完整剧本（包括真相）。AI 生成的剧本第一次看时，记录里会告诉大家
  router.get('/api/rooms/:id/scenario/full', (ctx) => {
    const user = requireUser(ctx);
    return engine.revealScenario(asId(ctx.params.id), user.id);
  });

  // 选身份、起名字：{ roleKey, name }。属性、专长、外貌是身份定好的。名字会发给主持 AI，改过的先检查。
  // 开局前可以改名字；开局以后还没建角色的人照样能建（中途加入）
  router.put('/api/rooms/:id/character', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const text = engine.checkCharacter(roomId, user.id, ctx.body);
    if (text !== null) {
      requireCredit(db, user.id);
      await safety.precheck(user.id, roomId, 'character', text);
    }
    engine.saveCharacter(roomId, user.id, ctx.body);
    return engine.gameState(roomId, user.id);
  });

  // 背包里换装备：{ slot, item }；item 为空就是脱下来
  router.put('/api/rooms/:id/equipment', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    engine.equipItem(roomId, user.id, body.slot, body.item);
    return engine.gameState(roomId, user.id);
  });

  // 局内升级：经验够了以后提交升级后的选择
  router.post('/api/rooms/:id/level-up', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    engine.levelUpInRoom(roomId, user.id, body.data);
    return engine.gameState(roomId, user.id);
  });

  // 在主持人打开的商店里买一件自定义道具
  router.post('/api/rooms/:id/shop/buy', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    engine.buyShopItem(roomId, user.id, body.shop, body.item);
    return engine.gameState(roomId, user.id);
  });

  router.post('/api/rooms/:id/shop/sell', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    engine.sellShopItem(roomId, user.id, body.shop, body.item);
    return engine.gameState(roomId, user.id);
  });

  router.post('/api/rooms/:id/shop/leave', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    engine.leaveShop(roomId, user.id);
    return engine.gameState(roomId, user.id);
  });

  /**
   * 合并的输入框：{ text, as?: 'auto' | 'action' | 'question', secret?: true }。
   * 以「？」开头、或者 as 是 question 的，是问主持人的问题（不花游戏时间，回答只有自己看得到）；
   * 其他的当成行动交上去，主持人估时的时候发现其实是在问问题，就改成提问（as 是 action 时不改）。
   * secret：悄悄做，同一地点的人看不到交了什么。
   */
  router.post('/api/rooms/:id/act', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const as = body.as === undefined ? 'auto' : asOneOf(body.as, ['auto', 'action', 'question'] as const, '请求格式不对');
    if (as === 'question' || QUESTION_PREFIX.test(text)) {
      const { question } = engine.validateQuestion(roomId, user.id, text.replace(QUESTION_PREFIX, ''));
      requireCredit(db, user.id);
      await safety.precheck(user.id, roomId, 'question', question);
      engine.ask(roomId, user.id, question);
      ctx.status = 202;
      return { kind: 'question' };
    }
    const { content } = engine.validateAction(roomId, user.id, text);
    requireCredit(db, user.id);
    await safety.precheck(user.id, roomId, 'action', content);
    const action = engine.submitAction(roomId, user.id, content, { secret: body.secret === true, convertible: as === 'auto', petHelp: body.petHelp === true });
    ctx.status = 201;
    return { kind: 'action', action };
  });

  router.post('/api/rooms/:id/actions', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    const { content } = engine.validateAction(roomId, user.id, body.content);
    requireCredit(db, user.id);
    await safety.precheck(user.id, roomId, 'action', content);
    const action = engine.submitAction(roomId, user.id, body.content, { secret: body.secret === true, petHelp: body.petHelp === true });
    ctx.status = 201;
    return { action };
  });

  router.delete('/api/rooms/:id/actions/:actionId', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    engine.withdrawAction(roomId, user.id, asId(ctx.params.actionId));
    return { withdrawn: true };
  });

  router.post('/api/rooms/:id/actions/:actionId/retry', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    // 重试要再调用一次 AI，钱记在他名下
    requireCredit(db, user.id);
    engine.retryAction(roomId, user.id, asId(ctx.params.actionId));
    return { retried: true };
  });

  // 协助同一地点另一个角色还在等结果的行动：{ note?: 附带的一句话 }。花掉自己这一次行动，跟着那个行动一起结算
  router.post('/api/rooms/:id/actions/:actionId/assist', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const targetId = asId(ctx.params.actionId);
    const note = ctx.body === undefined ? undefined : asObject(ctx.body).note;
    const { note: text } = engine.validateAssist(roomId, user.id, targetId, note);
    if (text) {
      requireCredit(db, user.id);
      await safety.precheck(user.id, roomId, 'action', text);
    }
    const action = engine.assist(roomId, user.id, targetId, note);
    ctx.status = 201;
    return { action };
  });

  // 对白：角色当面说的话，同一地点的角色马上看到：{ text, to?: 角色编号（悄悄话） }。不花游戏时间
  router.post('/api/rooms/:id/say', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    const { text } = engine.validateSay(roomId, user.id, body.text, body.to);
    limiter.hit('say', user.id);
    // 对白之后会给主持 AI 看：和行动一样先检查
    requireCredit(db, user.id);
    await safety.precheck(user.id, roomId, 'dialogue', text);
    ctx.status = 201;
    return engine.say(roomId, user.id, body.text, body.to);
  });

  // 把自己的一件东西交给同一地点的另一个角色：{ item, to: 角色编号 }
  router.post('/api/rooms/:id/give', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const body = asObject(ctx.body);
    return engine.giveItem(roomId, user.id, body.item, body.to);
  });

  // 把自己知道的线索告诉别人：{ to: [角色编号] } 或 { to: 'all' }
  router.post('/api/rooms/:id/clues/:key/share', (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    return engine.shareClue(roomId, user.id, ctx.params.key, asObject(ctx.body).to);
  });

  // 场外问主持人：问题和回答其他玩家看不到，回答稍后通过推送送到
  router.post('/api/rooms/:id/ask', async (ctx) => {
    const user = requireUser(ctx);
    const roomId = asId(ctx.params.id);
    rooms.requireMember(roomId, user.id);
    const raw = asObject(ctx.body).question;
    const { question } = engine.validateQuestion(roomId, user.id, raw);
    requireCredit(db, user.id);
    await safety.precheck(user.id, roomId, 'question', question);
    engine.ask(roomId, user.id, raw);
    ctx.status = 202;
    return { asked: true };
  });
}
