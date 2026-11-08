import { BETA_WIPE_SETTING } from './beta-wipe';
import { transaction, type DB } from './db';
import { getSetting, setSetting } from './settings';
import { APP_VERSION } from './version';

// 版本更新公告（V0.8.0 起）：每个版本改了什么，新版本第一次启动时自动发成一条全服公告。
// 公告是写给玩家看的：只写玩家用得到的改动，管理页加的功能、服务器内部的改动不写。
// 发布新版本时在 RELEASE_NOTES 最前面加一条（version 和 package.json 的版本号一样）。

export type ReleaseNote = { version: string; title: string; body: string };

/** 新的在前。标题不超过 40 个字，内容不超过 2000 个字（和管理员发公告的上限一样）。 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.1.0',
    title: 'V1.1.0 更新了什么',
    body: [
      '・顶栏多了「AI 大厅」：可以做自己的 AI 角色，起名字，写一句简介和人设（性格、说话的方式、经历），选公开还是不公开。公开的放进 AI 大厅，大家都能看人设、能请进自己的对局；不公开的只有自己能请。',
      '・身份比来的人多的时候，房主在开团准备里可以请一个 AI 角色来演没人选的身份：在「交给 AI 演」那一栏里挑自己的、或者 AI 大厅里公开的，也可以在 AI 大厅里点「请进对局」。开局以后它每一轮照自己的人设、只用自己的角色知道的事交行动，和大家的行动一起结算，交了什么大家看得到；在场的人说的话它也听得到，想让它帮忙就当面跟它说。它交行动用的 AI 费用由这一局的玩家平摊，结局的奖励只给玩家。',
      '・对局右边多了「地图」：去过的地方、看得到的去处、自己在哪；合作的剧本里队友在哪也画着。点一个地方看走过去要多久，「写成行动」把要去的地方填进输入框。走路按地图上的路程算时间，赶路能快一半；有的剧本藏着暗门、暗道，发现了才画出来、才走得通。对局结束以后谁都能看整张地图。',
      '・站位：一个地方里每个人站在哪。悄悄话只能说给身边的人，身边的人看得到你们凑在一起说话（嘈杂、昏暗的地方看不到）；悄悄做的事，离得近的人更容易察觉。打起来时近战只打得到站在一起的，躲在掩体后面更难被打中。换站位写在行动里。',
      '・剧本编辑器：「地点」上面多了小地图，可以拖着摆位置；出口可以设成暗门；地点里可以写站位（嘈杂、昏暗、掩体）。',
    ].join('\n'),
  },
  {
    version: '1.0.2',
    title: 'V1.0.2 更新了什么',
    body: ['・对局页中间的正文区域变大了，窗口矮的时候也能多看几段；下面的输入框放不下时，整页往下滚就能看到。'].join('\n'),
  },
  {
    version: '1.0.1',
    title: 'V1.0.1 更新了什么',
    body: ['・网站升级维护的时候，打开网站看到的维护页面上、已经开着的网页顶上那一行里，都写着交流 QQ 群号：1130127996。'].join('\n'),
  },
  {
    version: '1.0.0',
    title: 'V1.0.0 更新了什么',
    body: [
      '・龙娘跑团正式版上线了。内测时的账号、对局、公告和各种记录都清空了，大家重新注册，从头开始。',
      '・顶栏多了「模组」：5E 模组都放在这一页，按建议等级排，带自己的 5E 角色进去。剧本大厅里不再列 5E 模组。',
      '・普通剧本也能用 5E 规则玩：开局时勾上「用 5E 规则玩」，开团准备里也能切换。每个身份会自动转成一个 3 级的 5E 角色（职业、属性、技能照身份来），线索的检定换成技能和难度，打起来按 5E 的先攻、攻击结算。用的是转好的角色，不用自己的 5E 角色卡，打完也不升级、不带走东西。',
      '・页面最下面的「删档内测版」换成了「正式版」。',
    ].join('\n'),
  },
  {
    version: '0.9.2',
    title: 'V0.9.2 更新了什么',
    body: [
      '・剧本编辑器里写好的剧本，检查通过了可以直接点「投稿」，不用先开一局。分区和简介用「基本信息」里写的；整份剧本和导入的剧本一样，交上去之前会先检查内容。',
      '・AI 生成、导入的剧本，在开团准备里就能投稿；自己玩完一遍、对局结束以后，结局下面也能一键投稿。',
      '・剧本自己写了分区和简介的，投稿时不用再填一遍，确认一下就投；想改的点「改分区和简介」。',
      '・同一个剧本在编辑器里投过了，拿它开的局里显示的是那一份的审核情况，不会重复投；换了剧本的对局，新剧本照样能投。',
    ].join('\n'),
  },
  {
    version: '0.9.1',
    title: 'V0.9.1 更新了什么',
    body: [
      '・主持人结算一个行动要做很多步的时候（打仗、敌人多），不会再整次作废、同一个行动反复失败：步骤用完了，它会照已经掷好的骰子、做好的事把叙述写完。',
      '・主持人不会把同一下攻击、同一次检定重复算好几次。',
      '・估算一个行动要花多久，最多等 90 秒，等不到就按 30 分钟算，行动不会一直干等。',
      '・剧情笔记、场外问答、补课摘要给主持人留够了写的字数，不容易写不出来。',
    ].join('\n'),
  },
  {
    version: '0.9.0',
    title: 'V0.9.0 更新了什么',
    body: [
      '・5E 模组：剧本大厅多了「5E 模组」，用兼容第五版的 5E 规则，角色 1～5 级。先在「我的角色」的「5E 角色」里做一张卡：选职业、种族、背景，分配属性，再选技能、法术和装备，也可以点「按推荐填好」。规则页新加了「5E 模组」一节。',
      '・自带一个入门模组《雾岭哑钟》，3～5 人，建议 1 级。',
      '・对局里的角色面板能看到生命值、法术位、死亡豁免，还有正在打的仗：先攻顺序和敌人的生命值。掷骰换成了 d20。',
      '・剧本大厅里的 5E 模组走到结局，活着的角色升一级（在「5E 角色」里选这一级的新能力），带走这一局找到的东西和钱。',
      '・剧本编辑器和写剧本 skill 也能写 5E 模组了，怪物和宝藏有自己的分区。',
      '・网站升级维护时，开着的页面会提示「网站正在升级维护」，好了以后自动接上。',
      '・走到结局时还有人的行动没结算的，记录里会写明是谁的（这些行动不再结算）。',
      '・页面最下面的版本号后面写上了内测交流 QQ 群：1130127996。',
    ].join('\n'),
  },
  {
    version: '0.8.3',
    title: 'V0.8.3 更新了什么',
    body: [
      '・「通知」页的公告收起来了：没看过的照样展开，看过的只显示标题和时间，点一下展开；先列最近 5 条，更早的点「更早的公告」。',
      '・写剧本 skill：剧本编辑器里点「下载写剧本 skill」，交给自己用的 AI，它会按龙娘跑团的格式写新剧本，或者把现成的文字剧本转过来。写好的 .json 在编辑器里点「导入 .json 文件」，检查通过就能开局、投稿。',
    ].join('\n'),
  },
  {
    version: '0.8.2',
    title: 'V0.8.2 更新了什么',
    body: [
      '・头像菜单重新排了顺序：「我的主页」下面依次是「我的角色」「我的宠物」「我的背包」「我的装扮」。',
      '・个人主页上的四个数换成了：玩完的剧本（剧本大厅里的，重复玩也算）、通关的地下城（重复刷也算）、达成的结局、成就。下面依次是角色卡、宠物、剧本、成就、对局。',
    ].join('\n'),
  },
  {
    version: '0.8.1',
    title: 'V0.8.1 更新了什么',
    body: [
      '・宠物和装扮挪到了右上角的头像菜单里，改叫「我的宠物」「我的装扮」，就在「我的主页」下面。',
      '・个人主页上能看到自己培养的角色卡了：属性、专长、技能、身上的装备、切磋战绩、通关了几次地下城。不想给别人看的卡，在「我的角色」里把「在主页展示」去掉就行。',
    ].join('\n'),
  },
  {
    version: '0.8.0',
    title: 'V0.8.0 更新了什么',
    body: [
      '・约团：房主可以在对局里列几个时间，大家勾能不能来；房主定下以后通知所有人，开始前 30 分钟再提醒一次。「我的对局」里能看到下次什么时候开。',
      '・浏览器通知：在「账号设置」里打开以后，不开着网页也能收到约团、对局开始、轮到你行动、私信和邀请。iPhone、iPad 要先把网站添加到主屏幕。',
      '・AI 补位：人不够时，房主可以把没人选的身份交给 AI 演，他会跟着大家一起行动；晚到的朋友可以接替 AI 演的身份。',
      '・名场面：对局里喜欢的叙述可以收藏起来。',
      '・战报：可以生成一张这一局的战报图片，保存下来发给朋友。',
      '・剧本编辑器：剧本大厅里点「写一个剧本」，在网页上一块块填好，写完直接开一局。',
    ].join('\n'),
  },
];

/** 记下发到了哪个版本（设置里存版本号）。 */
export const RELEASE_NOTES_SETTING = 'release_notes_posted';

/** 正式版：V1.0.0 删了内测的档，从这一版重新开始。 */
const FORMAL_RELEASE = '1.0.0';

/** 比较两个版本号（0.8.0、0.10.1）：a 新返回正数，一样返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 新版本第一次启动：把还没发过的版本更新说明发成全服公告，返回这次发了哪几个版本。
 * - 以前发到过某个版本：这次发比它新、又不比现在的版本新的那几条（跳着升级的，中间几版的也补上），旧的先发；
 * - 从来没发过（V0.8.0 以前的数据、全新的网站）：只发现在这个版本的。
 *   内测的数据升级上来、删了档的（V1.0.0 的数据库第 23 版，记着 beta_wipe）：发正式版（V1.0.0）以来的每一条，
 *   从内测版直接升到 V1.0.1 以后的版本，也能看到 V1.0.0 那条（写着删档的事），不补发内测时的。
 * - 拿旧版本打开（现在的版本比发到过的旧）：什么都不做。
 * 发公告的人记成站长（没有站长就不写）。只在正式启动时调用（server/index.ts），测试和命令行工具不发。
 */
export function postReleaseNotes(db: DB, opts: { now: number; version?: string; notes?: ReleaseNote[] }): string[] {
  const version = opts.version ?? APP_VERSION;
  const notes = (opts.notes ?? RELEASE_NOTES).filter((n) => compareVersions(n.version, version) <= 0).sort((a, b) => compareVersions(a.version, b.version));
  const last = getSetting(db, RELEASE_NOTES_SETTING);
  if (last !== null && compareVersions(version, last) <= 0) return [];
  const wiped = last === null && getSetting(db, BETA_WIPE_SETTING) !== null;
  const todo =
    last !== null
      ? notes.filter((n) => compareVersions(n.version, last) > 0)
      : notes.filter((n) => compareVersions(n.version, version) === 0 || (wiped && compareVersions(n.version, FORMAL_RELEASE) >= 0));
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  transaction(db, () => {
    const insert = db.prepare("INSERT INTO announcements (title, body, audience, created_by, created_at) VALUES (?, ?, 'all', ?, ?)");
    for (const n of todo) insert.run(n.title.slice(0, 40), n.body.slice(0, 2000), owner?.id ?? null, opts.now);
    setSetting(db, RELEASE_NOTES_SETTING, version);
  });
  return todo.map((n) => n.version);
}
