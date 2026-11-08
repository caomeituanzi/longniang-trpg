process.env.TZ = 'Asia/Shanghai';
// V0.9.0：5E 规则（兼容第五版，SRD 5.2.1）。主持工具的结算（检定、先攻和轮次、攻击、怪物行动、倒地和死亡豁免、施法和专注、
// 狂暴、休息、物品和宝藏、出错时整次调用退回去）、给主持人的提示词；5E 角色卡（做卡、改卡、升级、删卡）、带进模组、
// 结局后的结算（剧本大厅的模组升一级、带出东西）；自带的入门模组《雾岭哑钟》。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { demoHandler, FakeProvider } from '../server/ai/fake';
import { monsterData, rules5e } from '../server/5e/rules-data';
import { DM_RULES, DM_RULES_5E, DM_RULES_V2, buildDmContext } from '../server/game/prompts';
import { newState5e } from '../server/game/rules5e';
import { validateScenario, type Scenario } from '../server/game/scenario';
import { Rules5eContext } from '../server/game/tools5e';
import { dmTools5e } from '../server/game/tools5e-defs';
import { emptyWorld, type Character, type World } from '../server/game/world';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { levelForXp, maxLevelFor, xpForLevel } from '../shared/5e/core';
import { RAGE_DAMAGE, RAGES, asiCount, expertiseCount, magicalSecretsCount, meetsMulticlassRequirement } from '../shared/5e/class-rules';
import { quickCard } from '../shared/5e/quick';
import { shopBuyPrice, shopSellRate } from '../shared/5e/shop';
import { armorTrained, cardIssues, cardProblems, computeSheet, finalAbilities, startingInventory, totalLevel, unmetMulticlass, weaponProficient } from '../shared/5e/sheet';
import type { Card5eData, ClassKey } from '../shared/5e/types';
import type { EditorCheck } from '../shared/editor';
import { ABILITIES, CONDITIONS, DAMAGE_TYPES, SKILL_KEYS } from '../shared/5e/core';
import { ITEM_INDEX } from '../shared/5e/item-index';
import { MONSTER_INDEX } from '../shared/5e/monster-index';
import { SKILL_NAME, skillEntries } from '../server/skill';
import { checkScenarioText } from '../skill/check-lib';
import { RELEASE_NOTES } from '../server/release-notes';
import { switchRules } from '../web/src/editor/doc';
import { startTestApp } from './helpers';

const RULES = rules5e();
const MODULE_FILE = path.resolve(import.meta.dirname, '..', 'scenarios', 'mistridge-silent-bell.json');
const MODULE: Scenario = validateScenario(JSON.parse(fs.readFileSync(MODULE_FILE, 'utf8'))).scenario!;
const ROLES = ['hired', 'traveler', 'kin', 'acolyte', 'friend'];

// ==================== 主持工具（只用程序，不开服务器） ====================

/** 一个 5E 角色：按推荐配置做的卡（tweak 可以改），生命值满的。 */
function pc5e(id: number, cls: ClassKey, opts: { location?: string; tweak?: (d: Card5eData) => void } = {}): Character {
  const data = quickCard(RULES, cls);
  opts.tweak?.(data);
  return {
    id,
    roomId: 1,
    playerId: id,
    userId: id,
    playerName: `玩家${id}`,
    roleKey: ROLES[id - 1],
    name: ['阿岚', '墨衡', '辛夷', '石牙'][id - 1],
    attributes: {} as Character['attributes'],
    specialties: [],
    appearance: '',
    goal: '',
    wounds: 0,
    stress: 0,
    conditions: [],
    items: [],
    location: opts.location ?? 'woods',
    visited: [opts.location ?? 'woods'],
    dead: false,
    pet: null,
    cardId: null,
    background: '',
    gear: [],
    v2: null,
    v5: newState5e(100 + id, data, computeSheet(data, RULES)),
    card5eId: 100 + id,
  };
}

/** 法师：准备燃烧之手、魔法飞弹、护盾术、睡眠术；戏法火焰箭、冷冻射线、法师之手。 */
const wizardSpells = (d: Card5eData) => {
  d.cantrips = ['fire-bolt', 'ray-of-frost', 'mage-hand'];
  d.spellbook = ['burning-hands', 'magic-missile', 'shield', 'sleep', 'mage-armor', 'thunderwave'];
  d.prepared = ['burning-hands', 'magic-missile', 'shield', 'sleep'];
};
/** 牧师：准备祝福术、虔诚护盾、疗伤术、治疗真言。 */
const clericSpells = (d: Card5eData) => {
  d.cantrips = ['sacred-flame', 'guidance', 'light'];
  d.prepared = ['bless', 'shield-of-faith', 'cure-wounds', 'healing-word'];
};

/** 一次结算：骰子按给的顺序掷（d20 也好、伤害骰也好），没给够就报错，免得程序多掷了没发现。 */
function ctx5e(characters: Character[], dice: number[], opts: { actorId?: number; world?: World; allowDeath?: boolean } = {}) {
  const rolls = [...dice];
  const ctx = new Rules5eContext({
    scenario: MODULE,
    world: opts.world ?? emptyWorld(),
    characters,
    clueHolders: new Map(),
    actorId: opts.actorId ?? characters[0].id,
    gameEnd: 100,
    rng: (sides) => {
      const v = rolls.shift();
      if (v === undefined) throw new Error(`骰子不够了（d${sides}）`);
      assert.ok(v >= 1 && v <= sides, `d${sides} 掷不出 ${v}`);
      return v;
    },
    allowDeath: opts.allowDeath ?? true,
    rules: RULES,
    srd: monsterData,
  });
  return { ctx, rolls };
}

/** 接着上一次结算的结果开始下一次（像引擎那样：世界、角色从上一次的副本来）。 */
function next(prev: Rules5eContext, dice: number[], actorId: number, allowDeath = true) {
  return ctx5e(structuredClone([...prev.characters.values()]), dice, { actorId, world: structuredClone(prev.world), allowDeath });
}

const run = (ctx: Rules5eContext, name: string, input: Record<string, unknown>) => {
  const r = ctx.execute(name, input);
  assert.ok(!r.isError, `${name} 出错：${r.content}`);
  return JSON.parse(r.content);
};

test('5E 的检定：熟练加值、属性调整值程序算；中毒有劣势；暗骰不给玩家看；技能、属性都没写报错', () => {
  const fighter = pc5e(1, 'fighter');
  const { ctx, rolls } = ctx5e([fighter], [12, 18, 4, 7, 9]);
  // 运动：力量 17（+3）+ 熟练 +2
  let r = run(ctx, 'check', { character: 1, skill: 'athletics', dc: 15, reason: '爬上老松树' });
  assert.equal(r.total, 17);
  assert.equal(r.success, true);
  assert.equal(ctx.cards.at(-1)!.d20!.kind, 'check');
  assert.equal(ctx.rolls.at(-1)!.attribute, 'athletics');
  // 中毒：检定有劣势，取低的那颗
  ctx.characters.get(1)!.v5!.conditions.push({ key: 'poisoned', note: '测试' });
  r = run(ctx, 'check', { character: 1, skill: 'athletics', dc: 15 });
  assert.equal(r.total, 4 + 5);
  assert.equal(r.success, false);
  assert.equal(r.mode, 'disadvantage');
  assert.ok(r.because.includes('劣势：中毒'));
  // 暗骰：记下来了，但不出骰子卡片
  const cards = ctx.cards.length;
  ctx.characters.get(1)!.v5!.conditions = [];
  r = run(ctx, 'check', { character: 1, skill: 'perception', dc: 10, hidden: true });
  assert.equal(r.total, 7 + 1);
  assert.equal(ctx.cards.length, cards);
  assert.equal(ctx.rolls.at(-1)!.hidden, true);
  // 没熟练的智力检定：智力 8（-1），没给 DC 就不说成没成
  r = run(ctx, 'check', { character: 1, ability: 'int', reason: '认古文' });
  assert.equal(r.total, 9 - 1);
  assert.equal(r.success, undefined);
  const bad = ctx.execute('check', { character: 1, dc: 10 });
  assert.ok(bad.isError);
  assert.match(bad.content, /skill（技能）或 ability（属性）/);
  assert.equal(rolls.length, 0);
});

test('5E 的战斗：先攻排序、攻击（凶蛮攻击者取高）、怪物行动、法术位、范围法术的伤害掷一次、出错整次退回、一轮都行动过了进下一轮', () => {
  const fighter = pc5e(1, 'fighter');
  const wizard = pc5e(2, 'wizard', { tweak: wizardSpells });
  // 先攻：怪物先掷（喽啰1 5+2、喽啰2 6+2），角色按编号（战士 18+1、法师 2+3）
  const { ctx, rolls } = ctx5e([fighter, wizard], [5, 6, 18, 2]);
  let r = run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 2 }], note: '林子里窜出两个地精' });
  const fight = () => ctx.world.fights5e.woods;
  assert.deepEqual(fight().order.map((o) => [o.id, o.initiative]), [['c1', 19], ['goblin-minion-2', 8], ['goblin-minion-1', 7], ['c2', 5]]);
  assert.deepEqual(fight().monsters.map((m) => m.name), ['破耳喽啰1', '破耳喽啰2']);
  assert.equal(r.round, 1);
  assert.equal(rolls.length, 0);

  // 战士用巨剑砍喽啰1：d20 15 + 5 命中 AC 12；伤害 2d6（3、4）+3，凶蛮攻击者再掷一次 2d6（6、6）取高
  rolls.push(15, 3, 4, 6, 6);
  r = run(ctx, 'attack', { character: 1, target: 'goblin-minion-1', weapon: 'greatsword', reason: '一剑劈过去' });
  assert.equal(r.hit, true);
  assert.equal(r.total, 20);
  assert.equal(r.damage, 12 + 3);
  assert.equal(r.enemy.defeated, true);
  assert.ok(r.notes.some((n: string) => n.includes('凶蛮攻击者')));
  assert.equal(ctx.cards.at(-1)!.combat?.hit, true);
  // 打倒下的报错
  assert.ok(ctx.execute('attack', { character: 1, target: 'goblin-minion-1', weapon: 'greatsword' }).isError);
  // 身上没有的武器：报错，告诉他能用什么
  const noWeapon = ctx.execute('attack', { character: 1, target: 'goblin-minion-2', weapon: 'longbow' });
  assert.ok(noWeapon.isError);
  assert.match(noWeapon.content, /greatsword（巨剑）/);

  // 轮到排在战士后面的喽啰2：匕首扎法师（AC 11），d20 10 + 4 命中，1d4（4）+2
  rolls.push(10, 4);
  r = run(ctx, 'monster_action', { enemy: 'goblin-minion-2', action: '匕首', targets: [2], reason: '扑向法师' });
  assert.equal(r.results[0].hit, true);
  assert.equal(r.results[0].damage, 6);
  assert.equal(ctx.characters.get(2)!.v5!.hp, 9 - 6);
  assert.equal(ctx.cards.at(-1)!.combat?.kind, 'enemy');
  ctx.finish();
  assert.deepEqual(fight().acted, ['goblin-minion-2', 'c1']);
  assert.equal(fight().round, 1, '法师还没行动，这一轮还没完');
  assert.equal(rolls.length, 0);

  // 法师的回合
  const two = next(ctx, [], 2);
  const c2 = two.ctx;
  // 魔法飞弹没写目标：报错，扣掉的法术位退回去
  const before = structuredClone(c2.characters.get(2)!.v5!.slotsUsed);
  const bad = c2.execute('cast_spell', { character: 2, spell: 'magic-missile', reason: '射飞弹' });
  assert.ok(bad.isError);
  assert.deepEqual(c2.characters.get(2)!.v5!.slotsUsed, before, '出错的那次调用什么都没改');
  // 没准备的法术
  assert.match(c2.execute('cast_spell', { character: 2, spell: 'thunderwave' }).content, /没有准备雷鸣波/);
  // 燃烧之手：喽啰2 敏捷豁免 12+2 对 DC 13（8+2+3）成功，3d6（6、5、4）减半 → 7，正好倒下
  two.rolls.push(12, 6, 5, 4);
  r = run(c2, 'cast_spell', { character: 2, spell: 'burning-hands', enemies: ['goblin-minion-2'], reason: '一扇火' });
  assert.equal(r.cast_at, '1 环法术位');
  assert.match(r.results[0].save, /14 对 DC 13，成功/);
  assert.match(r.results[0].damage, /受到 7 点火焰伤害（豁免成功，减半）.*倒下了/);
  assert.deepEqual(c2.characters.get(2)!.v5!.slotsUsed, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  c2.finish();
  // 两个角色都行动过了（怪物都倒下了）：进入第 2 轮
  assert.equal(c2.world.fights5e.woods.round, 2);
  assert.deepEqual(c2.world.fights5e.woods.acted, []);
  assert.ok(c2.events.includes('第 2 轮'));
  r = run(c2, 'end_combat', { note: '地精都倒下了' });
  assert.equal(r.ended, true);
  assert.equal(c2.world.fights5e.woods, undefined);
  assert.equal(two.rolls.length, 0);
});

test('5E 的倒地和死亡：生命值到 0 昏迷倒地；不打仗时每结算一次掷一次死亡豁免；倒地再受伤算失败；三次失败死；角色不会死时停在两次；一下打太重当场死', () => {
  const fighter = pc5e(1, 'fighter');
  const cleric = pc5e(3, 'cleric', { tweak: clericSpells });
  fighter.v5!.hp = 2;
  // 战士受 1d4（4）挥砍：生命值 0，倒地昏迷
  const { ctx, rolls } = ctx5e([fighter, cleric], [4], { actorId: 1 });
  let r = run(ctx, 'damage', { characters: [1], dice: '1d4', type: 'slashing', reason: '踩进了捕兽夹' });
  assert.match(r.results[0].downed, /倒下昏迷/);
  const s = () => ctx.characters.get(1)!.v5!;
  assert.equal(s().hp, 0);
  assert.deepEqual(s().death, { success: 0, failure: 0 });
  assert.deepEqual(s().conditions.map((c) => c.key).sort(), ['prone', 'unconscious']);
  assert.ok(ctx.events.some((e) => e.includes('阿岚倒下了')));
  // 昏迷着做不了检定
  assert.ok(ctx.execute('check', { character: 1, skill: 'athletics', dc: 10 }).isError);
  assert.equal(rolls.length, 0);

  // 牧师行动：同一地点倒地的战士先掷一次死亡豁免（8，失败）
  const b = next(ctx, [8, 1], 3);
  assert.ok(b.ctx.turnNotes.some((n) => n.startsWith('时间过去了一会儿') && n.includes('失败')));
  assert.deepEqual(b.ctx.characters.get(1)!.v5!.death, { success: 0, failure: 1 });
  // 倒地时又受伤：再算一次失败
  r = run(b.ctx, 'damage', { characters: [1], dice: '1d4', type: 'bludgeoning', reason: '落石' });
  assert.deepEqual(b.ctx.characters.get(1)!.v5!.death, { success: 0, failure: 2 });
  assert.equal(b.rolls.length, 0);

  // 角色不会死（房主选的）：掷出 1 也停在两次失败
  const safe = next(b.ctx, [1], 3, false);
  assert.equal(safe.ctx.characters.get(1)!.dead, false);
  assert.equal(safe.ctx.characters.get(1)!.v5!.death!.failure, 2);

  // 会死：掷出 1 算两次失败，死了
  const c = next(b.ctx, [1], 3);
  assert.equal(c.ctx.characters.get(1)!.dead, true);
  assert.ok(c.ctx.events.some((e) => e.includes('死亡豁免失败了三次，死了')));
  assert.ok(c.ctx.execute('heal', { characters: [1], dice: '1d8', reason: '晚了' }).isError, '死了的人不能治');

  // 疗伤术把倒地的人救醒：生命值 1 以上，死亡豁免清零
  const d = next(b.ctx, [15, 5, 3], 3);
  r = run(d.ctx, 'cast_spell', { character: 3, spell: 'cure-wounds', characters: [1], reason: '按住伤口念祷词' });
  assert.equal(r.results[0].healed, 5 + 3 + 2);
  assert.equal(d.ctx.characters.get(1)!.v5!.hp, 10);
  assert.equal(d.ctx.characters.get(1)!.v5!.death, null);
  assert.ok(!d.ctx.characters.get(1)!.v5!.conditions.some((x) => x.key === 'unconscious'));
  assert.ok(d.ctx.events.some((e) => e.includes('阿岚醒了过来')));

  // 一下的伤害减到 0 以后还剩不少于生命值上限：当场死
  const tough = pc5e(1, 'fighter');
  tough.v5!.hp = 5;
  const e = ctx5e([tough], [1]);
  r = run(e.ctx, 'damage', { characters: [1], dice: '1d4+20', type: 'necrotic', reason: '冢中的寒气' });
  assert.equal(e.ctx.characters.get(1)!.dead, true);
  assert.match(r.results[0].result, /死了/);
});

test('5E 的专注：同时只能专注一个，换一个前一个的效果就没了；受伤要做专注豁免，失败效果结束；法术位用完施不出来', () => {
  const fighter = pc5e(1, 'fighter');
  const cleric = pc5e(3, 'cleric', { tweak: clericSpells });
  const { ctx, rolls } = ctx5e([cleric, fighter], [], { actorId: 3 });
  const s = (id: number) => ctx.characters.get(id)!.v5!;
  let r = run(ctx, 'cast_spell', { character: 3, spell: 'bless', characters: [1, 3], reason: '为大家祝福' });
  assert.ok(r.concentration);
  assert.equal(s(3).concentration?.spell, 'bless');
  assert.ok(s(1).effects.some((e) => e.name === '祝福术'));
  r = run(ctx, 'cast_spell', { character: 3, spell: 'shield-of-faith', characters: [1], reason: '护住战士' });
  assert.equal(s(3).concentration?.spell, 'shield-of-faith');
  assert.ok(!s(1).effects.some((e) => e.name === '祝福术'), '换了专注，祝福术没了');
  assert.ok(s(1).effects.some((e) => e.name === '虔诚护盾'));
  assert.deepEqual(s(3).slotsUsed, [2, 0, 0, 0, 0, 0, 0, 0, 0]);
  // 法术位用完了：施不出来，什么都没改
  const none = ctx.execute('cast_spell', { character: 3, spell: 'cure-wounds', characters: [1] });
  assert.ok(none.isError);
  assert.match(none.content, /没有可用的法术位/);
  assert.equal(s(3).concentration?.spell, 'shield-of-faith');
  // 牧师受 10 点伤：专注豁免 DC 10（体质 16，+3；d20 5 → 8）失败，虔诚护盾结束
  rolls.push(10, 5);
  r = run(ctx, 'damage', { characters: [3], dice: '1d10', type: 'piercing', reason: '冷箭' });
  assert.match(r.results[0].concentration, /专注豁免失败（DC 10），虔诚护盾结束了/);
  assert.equal(s(3).concentration, null);
  assert.ok(!s(1).effects.some((e) => e.name === '虔诚护盾'));
  assert.equal(rolls.length, 0);
});

test('5E 的狂暴：钝击、穿刺、挥砍减半，别的伤害照旧，力量攻击加伤害；狂暴时不能施法；休息：短休花生命骰、长休回满；打仗时不能休息', () => {
  const barbarian = pc5e(4, 'barbarian');
  const { ctx, rolls } = ctx5e([barbarian], [10, 6], { actorId: 4 });
  const s = () => ctx.characters.get(4)!.v5!;
  let r = run(ctx, 'use_feature', { character: 4, feature: 'rage', reason: '怒吼一声' });
  assert.match(r.result, /狂暴（还剩 1 次）/);
  assert.ok(ctx.execute('use_feature', { character: 4, feature: 'rage' }).isError, '已经在狂暴了');
  r = run(ctx, 'damage', { characters: [4], dice: '1d10', type: 'slashing', reason: '弯刀' });
  assert.equal(r.results[0].damage, 5);
  r = run(ctx, 'damage', { characters: [4], dice: '1d6', type: 'fire', reason: '火把' });
  assert.equal(r.results[0].damage, 6);
  assert.equal(s().hp, 15 - 11);
  assert.equal(rolls.length, 0);
  // 打一只骷髅：巨斧命中，1d12（8）+3+狂暴 2；凶蛮攻击者重掷（2）不如原来的
  rolls.push(10, 12, 14, 8, 2);
  run(ctx, 'start_combat', { monsters: [{ monster: 'skeleton', count: 1 }] });
  r = run(ctx, 'attack', { character: 4, target: 'skeleton-1', weapon: 'greataxe' });
  assert.ok(r.notes.includes('狂暴 +2'));
  assert.equal(r.damage, 8 + 3 + 2);
  assert.equal(r.enemy.defeated, true);
  assert.ok(ctx.execute('rest', { kind: 'short' }).isError, '还在打仗，不能休息');
  run(ctx, 'end_combat', { note: '骷髅散了架' });
  assert.ok(!s().effects.some((e) => e.key === 'rage'), '战斗结束，狂暴跟着结束');
  // 短休：花一颗生命骰 d12（7）+ 体质 2
  rolls.push(7);
  r = run(ctx, 'rest', { kind: 'short', hit_dice: [{ character: 4, dice: 1 }], reason: '在火堆边歇一会儿' });
  assert.equal(s().hp, 4 + 9);
  assert.equal(s().hitDiceUsed, 1);
  assert.equal(s().used.rage, 0, '短休回一次狂暴');
  // 长休：生命值回满
  r = run(ctx, 'rest', { kind: 'long' });
  assert.equal(s().hp, 15);
  assert.equal(rolls.length, 0);
});

test('5E 的物品和宝藏：宝藏每处只能拿一次（记进这一局得到的），喝治疗药水回血；身上没有的东西报错', () => {
  const fighter = pc5e(1, 'fighter', { location: 'watchtower' });
  fighter.v5!.hp = 3;
  const { ctx, rolls } = ctx5e([fighter], [3, 3]);
  const s = () => ctx.characters.get(1)!.v5!;
  const money = s().money;
  let r = run(ctx, 'give_treasure', { character: 1, treasure: 'goblin-chest', reason: '撬开地精的箱子' });
  assert.deepEqual(r.got, ['治疗药水 ×2', '25 金币']);
  assert.equal(s().money, money + 2500);
  assert.deepEqual(s().gained, [{ key: 'potion-of-healing', qty: 2 }]);
  assert.equal(s().gainedMoney, 2500);
  assert.match(ctx.execute('give_treasure', { character: 1, treasure: 'goblin-chest' }).content, /已经被拿走了/);
  assert.equal(ctx.world.treasureTaken['goblin-chest'], 1);
  // 治疗药水：2d4+2
  r = run(ctx, 'use_item', { character: 1, item: 'potion-of-healing', reason: '灌下一瓶' });
  assert.equal(s().hp, 3 + 3 + 3 + 2);
  assert.equal(s().inventory.find((i) => i.key === 'potion-of-healing')?.qty, 1);
  assert.match(ctx.execute('use_item', { character: 1, item: 'antitoxin' }).content, /身上没有「antitoxin」/);
  assert.equal(rolls.length, 0);
  const xpBefore = s().data.xp ?? 0;
  r = run(ctx, 'award_xp', { character: 1, amount: 300, reason: '解决了地精' });
  assert.equal(s().data.xp, xpBefore + 300);
  assert.equal(r.xp, xpBefore + 300);
});

test('5E 的提示词：主持规则用 5E 的工具；剧本里有怪物数据块；正在打的仗写出这次结算轮到哪些敌人；只给这个模组用得上的工具', () => {
  assert.doesNotMatch(DM_RULES_5E, /roll_check|roll_opposed|enemy_attack|\bhurt\b/);
  assert.match(DM_RULES_5E, /cast_spell/);
  const names = dmTools5e(MODULE).map((t) => t.name);
  for (const n of ['check', 'attack', 'monster_action', 'cast_spell', 'give_treasure', 'award_xp', 'start_combat', 'end_game']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('roll_check'));
  assert.ok(!dmTools5e({ ...MODULE, monsters: [], treasure: [] }).some((t) => ['attack', 'give_treasure'].includes(t.name)), '没写怪物、宝藏的模组不给打仗、宝藏的工具');

  const fighter = pc5e(1, 'fighter');
  const wizard = pc5e(2, 'wizard', { tweak: wizardSpells });
  const { ctx } = ctx5e([fighter, wizard], [5, 6, 18, 2]);
  run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 2 }] });
  const text = buildDmContext({
    scenario: MODULE,
    world: ctx.world,
    characters: [...ctx.characters.values()],
    turnNotes: ['测试用的先处理的事'],
    clues: [],
    actor: ctx.characters.get(1)!,
    action: { content: '冲上去砍', gameStart: 600, minutes: 1 },
    pending: [],
    recent: [],
  });
  assert.match(text, /## 正在打的仗/);
  assert.match(text, /这次结算轮到的敌人（阿岚之后、下一个角色之前）：goblin-minion-2 破耳喽啰2、goblin-minion-1 破耳喽啰1/);
  assert.match(text, /测试用的先处理的事/);
  assert.match(text, /攻击（attack 的 weapon 填括号里的）：巨剑（greatsword）命中 \+5/);
  assert.match(text, /戏法（随意施放）：火焰箭（fire-bolt）/);
});

test('自带的入门模组《雾岭哑钟》：5E 模组、1 级、3～5 人；怪物都查得到数据块；自己写的怪物读得到充能和豁免', () => {
  assert.equal(MODULE.rules, '5e');
  assert.equal(MODULE.level, 1);
  assert.deepEqual(MODULE.players, { min: 3, max: 5 });
  const ironjaw = MODULE.monsters!.find((m) => m.key === 'ironjaw')!;
  assert.equal(ironjaw.stats!.hp, 33);
  const breath = ironjaw.stats!.actions.find((a) => a.name === '冢中寒息')!;
  assert.equal(breath.recharge, 5);
  assert.deepEqual(breath.save, { ability: 'con', dc: 11, onSuccess: 'half' });
  for (const m of MODULE.monsters!) assert.ok(m.stats || monsterData(m.monster!), m.key);
  // 自己写的怪物：第二段伤害能写 when，豁免失败的状态能写 saveCondition（写了就要写 save）
  const raw = JSON.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  raw.monsters.push({
    key: 'bog-hag',
    name: '沼婆',
    description: '测试用',
    stats: {
      ac: 12,
      hp: 20,
      cr: 1,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      actions: [
        { name: '爪', desc: '爪击', attack: 4, damage: [{ dice: '1d6+2', type: 'slashing' }, { dice: '1d6', type: 'poison', when: 'adv' }] },
        { name: '凝视', desc: '凝视', save: { ability: 'wis', dc: 11, onSuccess: 'none' }, saveCondition: 'frightened' },
        { name: '乱写', desc: '乱写', saveCondition: 'charmed', damage: [{ dice: '1d4', type: 'cold', when: 'adv' }] },
      ],
    },
  });
  const v = validateScenario(raw);
  const errors = v.errors.join('\n');
  assert.match(errors, /saveCondition（豁免失败后的状态）就要写 save/);
  assert.match(errors, /第一段伤害一直都有，不能写 when/);
  raw.monsters.at(-1).stats.actions.pop();
  const ok = validateScenario(raw);
  assert.deepEqual(ok.errors, []);
  const hag = ok.scenario!.monsters!.find((m) => m.key === 'bog-hag')!.stats!;
  assert.equal(hag.actions[0].damage[1].when, 'adv');
  assert.equal(hag.actions[1].saveCondition, 'frightened');
});

// ==================== 接口：5E 角色卡、带进模组、结局后的结算 ====================

const [, TESTER1, TESTER2, TESTER3] = TEST_ACCOUNTS;
const MIN = 60_000;
let t: Awaited<ReturnType<typeof startTestApp>>;
let t1: string;
let t2: string;
let t3: string;
let now = Date.parse('2026-10-29T10:00:00+08:00');

before(async () => {
  // 骰子：d20 都是 14，别的骰子取一半（向上取整）
  t = await startTestApp({ ai: new FakeProvider(demoHandler), tickMs: 0, now: () => now, rng: (sides) => (sides === 20 ? 14 : Math.ceil(sides / 2)) });
  t1 = await t.login(TESTER1.username, TESTER1.password);
  t2 = await t.login(TESTER2.username, TESTER2.password);
  t3 = await t.login(TESTER3.username, TESTER3.password);
});

after(async () => {
  await t.close();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) => t.call(method, url, body, cookie);
const userOf = (username: string) => t.app.db.prepare('SELECT id, public_id FROM users WHERE username = ?').get(username) as { id: number; public_id: string };

test('5E 角色卡：游客能看规则数据、不能做卡；做卡时物品和钱服务器照起始装备算；选得不对说哪里不对；长休能换的随时能换；没打过模组的 1 级卡能重做', async () => {
  const guest = (await t.call('POST', '/api/auth/guest')).cookie!;
  const rules = await as(guest)('GET', '/api/5e/rules');
  assert.equal(rules.status, 200);
  assert.equal(rules.data.classes.length, 12);
  assert.equal(rules.data.species.length, 10);
  assert.equal(rules.data.backgrounds.length, 12);
  assert.equal((await as(guest)('GET', '/api/5e/monsters/goblin-boss')).data.monster.ac, 17);
  assert.equal((await as(guest)('POST', '/api/cards5e', { name: '游客', data: quickCard(RULES, 'fighter') })).status, 403);

  const data = quickCard(RULES, 'fighter');
  // 交来的物品和钱不算数：服务器照起始装备算
  const made = await as(t1)('POST', '/api/cards5e', { name: '阿岚', appearance: '高个子，背着一把巨剑', background: '退伍的老兵', data: { ...data, inventory: [{ key: 'plate-armor', qty: 9 }], money: 999999 } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const card = made.data.card;
  assert.equal(card.data.level, 1);
  assert.equal(card.data.money, 1800);
  assert.ok(!card.data.inventory.some((i: { key: string }) => i.key === 'plate-armor'));
  assert.ok(card.data.inventory.some((i: { key: string; qty: number }) => i.key === 'oil' && i.qty === 2), '地城探索套组拆开放进背包');
  assert.ok(!card.data.inventory.some((i: { key: string }) => i.key === 'flask'));
  assert.equal(card.sheet.hpMax, 13);
  assert.equal(card.sheet.ac, 17);
  assert.equal(card.editable, true);
  assert.equal((await as(t1)('GET', '/api/cards5e')).data.cards.length, 1);

  // 选得不对：技能选多了、属性不是标准数组
  const wrong = await as(t1)('POST', '/api/cards5e', { name: '错的', data: { ...data, classSkills: ['history', 'insight', 'perception'], base: { ...data.base, str: 18 } } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /角色卡还有\d+处要改/);
  assert.equal((await as(t1)('POST', '/api/cards5e', { name: '没职业', data: { ...data, class: 'pirate' } })).status, 400);
  assert.equal((await as(t1)('POST', '/api/cards5e', { name: '阿岚', data })).status, 409, '同名');

  // 长休能换的：拿链枷
  let r = await as(t1)('PUT', `/api/cards5e/${card.id}`, { rest: { equipped: { ...card.data.equipped, main: 'flail' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.data.equipped.main, 'flail');
  // 身上没有的东西拿不了
  r = await as(t1)('PUT', `/api/cards5e/${card.id}`, { rest: { equipped: { ...card.data.equipped, main: 'longbow' } } });
  assert.equal(r.status, 400);
  // 还没打过模组的 1 级卡：整张重做（换成野蛮人）
  r = await as(t1)('PUT', `/api/cards5e/${card.id}`, { data: quickCard(RULES, 'barbarian') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.sheet.className, '野蛮人');
  r = await as(t1)('PUT', `/api/cards5e/${card.id}`, { data: quickCard(RULES, 'fighter') });
  assert.equal(r.data.card.sheet.className, '战士');
  // 没挣到等级不能升级
  assert.equal((await as(t1)('POST', `/api/cards5e/${card.id}/level-up`, { data: quickCard(RULES, 'fighter', { level: 2 }) })).status, 409);
  // 别人的卡看不到、改不了
  assert.equal((await as(t2)('PUT', `/api/cards5e/${card.id}`, { name: '偷来的' })).status, 404);
});

test('5E 模组：只能带 5E 角色卡；开打、攻击、还手、施法、宝藏走 5E 的工具；走到结局，活着的升一级、带出这一局得到的东西；死了的照旧；通知、个人主页', async () => {
  const fighterCard = (await as(t1)('GET', '/api/cards5e')).data.cards[0];
  const wizardData = quickCard(RULES, 'wizard');
  const wizardCard = (await as(t2)('POST', '/api/cards5e', { name: '墨衡', appearance: '瘦高，抱着一本厚书', data: wizardData })).data.card;
  const clericCard = (await as(t3)('POST', '/api/cards5e', { name: '辛夷', data: quickCard(RULES, 'cleric') })).data.card;

  // 大厅里看得到规则和建议等级
  const hall = (await as(t1)('GET', '/api/scenarios')).data;
  const listed = (hall.scenarios ?? hall).find((s: { key: string }) => s.key === 'mistridge-silent-bell');
  assert.ok(listed, '剧本大厅里有《雾岭哑钟》');
  assert.equal(listed.rules, '5e');
  assert.deepEqual(listed.module5e, { level: 1 });

  const room = (await as(t1)('POST', '/api/rooms', { name: '雾岭', maxPlayers: 4, scenarioKey: 'mistridge-silent-bell' })).data.room;
  const code = (t.app.db.prepare('SELECT join_code FROM rooms WHERE id = ?').get(room.id) as { join_code: string }).join_code;
  for (const c of [t2, t3]) assert.equal((await as(c)('POST', '/api/rooms/join', { code })).status, 200);
  // V1.2.0 起：5E 模组的身份也能交给 AI 演（它自己带一张 5E 卡补位，有完整面板）
  const seat = await as(t1)('PUT', `/api/rooms/${room.id}/ai-seats/kin`, {});
  assert.equal(seat.status, 200, JSON.stringify(seat.data));
  assert.ok(seat.data.companions.some((c: { roleKey: string }) => c.roleKey === 'kin'), '5E 模组的身份交给 AI 了');
  let r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hired', name: '随便' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /只能带自己的 5E 角色/);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hired', cardId: wizardCard.id })).status, 404, '别人的卡');
  r = await as(t1)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'hired', cardId: fighterCard.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.me.name, '阿岚');
  assert.equal(r.data.me.v5.hp, 13);
  assert.equal(r.data.me.v5.className, '战士');
  assert.equal((await as(t2)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'traveler', cardId: wizardCard.id })).status, 200);
  assert.equal((await as(t3)('PUT', `/api/rooms/${room.id}/character`, { roleKey: 'acolyte', cardId: clericCard.id })).status, 200);
  // 在一局里的卡不能改、不能删
  assert.equal((await as(t1)('DELETE', `/api/cards5e/${fighterCard.id}`)).status, 409);
  assert.equal((await as(t1)('PUT', `/api/cards5e/${fighterCard.id}`, { rest: { prepared: [] } })).status, 409);
  assert.equal((await as(t1)('POST', `/api/rooms/${room.id}/status`, { status: 'running' })).status, 200);

  const game = async (cookie: string) => (await as(cookie)('GET', `/api/rooms/${room.id}/game`)).data;
  // 背包换装备：主手、双手武器占副手；副手只能单手武器或盾牌
  let g0 = await game(t1);
  const oneHand = g0.me.v5.inventory.find((i: { kind: string; twoHanded: boolean }) => i.kind === 'weapon' && !i.twoHanded);
  const twoHand = g0.me.v5.inventory.find((i: { kind: string; twoHanded: boolean }) => i.kind === 'weapon' && i.twoHanded);
  assert.ok(oneHand && twoHand, '战士有单双手武器');
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/equipment`, { slot: 'main', item: oneHand.key })).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/equipment`, { slot: 'off', item: oneHand.key })).status, 200);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/equipment`, { slot: 'main', item: twoHand.key })).status, 200);
  g0 = await game(t1);
  assert.equal(g0.me.v5.equipment.main, twoHand.key);
  assert.equal(g0.me.v5.equipment.off, null);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/equipment`, { slot: 'off', item: oneHand.key })).status, 409);
  assert.equal((await as(t1)('PUT', `/api/rooms/${room.id}/equipment`, { slot: 'main', item: oneHand.key })).status, 200);
  g0 = await game(t1);
  assert.equal(g0.me.v5.equipment.main, oneHand.key);
  async function act(cookie: string, content: string) {
    const res = await as(cookie)('POST', `/api/rooms/${room.id}/actions`, { content });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    await t.app.engine.idle();
    now += 125 * MIN;
    t.app.engine.tick();
    await t.app.engine.idle();
  }
  // 别人看到的是种族、职业、等级
  assert.ok((await game(t2)).others.some((o: { name: string; class5e: string }) => o.name === '阿岚' && o.class5e === '矮人战士 1 级'));

  await act(t1, '测试开打：林子里的狼扑过来了');
  let g = await game(t1);
  assert.ok(g.fight5e, '开打以后看得到战斗');
  assert.equal(g.fight5e.monsters[0].name, '黑松林的狼');
  assert.equal(g.fight5e.round, 1);
  await act(t1, '测试攻击：一剑劈过去');
  g = await game(t1);
  assert.ok(g.fight5e.monsters[0].hp < g.fight5e.monsters[0].hpMax, '打中了');
  const log = (await as(t1)('GET', `/api/rooms/${room.id}/log`)).data;
  const entries = log.entries ?? log;
  assert.ok(entries.some((e: { data?: { rolls?: { d20?: { kind: string } }[] } }) => e.data?.rolls?.some((x) => x.d20?.kind === 'attack')), '记录里有攻击的骰子卡片');
  await act(t2, '测试施法：念一道咒语');
  await act(t2, '四处看看');
  await act(t2, '测试施法');
  // 法师死在这一局：结算时卡照旧
  const wizardChar = t.app.db.prepare('SELECT id FROM characters WHERE room_id = ? AND card5e_id = ?').get(room.id, wizardCard.id) as { id: number };
  t.app.db.prepare('UPDATE characters SET dead = 1 WHERE id = ?').run(wizardChar.id);
  await act(t1, '测试攻击：再砍一下');
  g = await game(t1);
  assert.ok(g.fight5e === null || g.fight5e.monsters.every((m: { defeated: boolean }) => m.defeated) || g.fight5e.monsters[0].hp < g.fight5e.monsters[0].hpMax);
  await act(t1, '测试结束战斗');
  g = await game(t1);
  assert.equal(g.fight5e, null);
  await act(t1, '测试宝物：找村长领赏钱');
  g = await game(t1);
  assert.equal(g.me.v5.money, 1800 + 5000);
  assert.deepEqual(g.me.v5.gained, []);
  assert.equal(g.me.v5.gainedMoney, 5000);
  // 牧师只交了一个行动（不到三个）：不算
  await act(t3, '四处看看');
  // 牧师又交了一个还没到时间的行动：走到结局时不再结算，记录里说一声是谁的
  const clericChar = t.app.db.prepare('SELECT id FROM characters WHERE room_id = ? AND card5e_id = ?').get(room.id, clericCard.id) as { id: number };
  const late = t.app.db
    .prepare("INSERT INTO actions (room_id, character_id, content, status, mode, submitted_at, due_at) VALUES (?, ?, '去推石板', 'waiting', 'timed', ?, ?)")
    .run(room.id, clericChar.id, now, now + 1000 * MIN).lastInsertRowid;
  await act(t1, '测试结局：钟声敲响，雾散了');
  g = await game(t1);
  assert.ok(g.ending, '走到了结局');
  assert.equal((t.app.db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.id) as { status: string }).status, 'ended');
  assert.equal((t.app.db.prepare('SELECT status FROM actions WHERE id = ?').get(late) as { status: string }).status, 'withdrawn');
  const endLog = (await as(t1)('GET', `/api/rooms/${room.id}/log`)).data;
  assert.ok(
    (endLog.entries ?? endLog).some((e: { kind: string; text: string }) => e.kind === 'system' && e.text === '对局结束了，辛夷还没结算的行动不再结算'),
    '记录里说了谁的行动不再结算',
  );

  const mine = (await as(t1)('GET', '/api/cards5e')).data.cards[0];
  assert.equal(mine.data.earned, 1, '剧本大厅里的模组：活着回来挣到一级');
  assert.equal(mine.data.level, 1, '升级要自己在「5E 角色」里做');
  assert.equal(mine.data.money, 1800 + 5000, '这一局得到的钱带出来了');
  assert.equal(mine.history[0].title, '雾岭哑钟');
  assert.equal(mine.history[0].survived, true);
  assert.equal(mine.history[0].counted, true);
  assert.deepEqual(mine.history[0].loot, ['50 金币']);
  assert.equal(mine.editable, false, '打过模组的卡不能整张重做');
  const notes = (await as(t1)('GET', '/api/notifications')).data.items;
  const done = notes.find((n: { kind: string }) => n.kind === 'card5e_done');
  assert.ok(done, '收到结算通知');
  assert.equal(done.data.levelUp, true);

  const dead = (await as(t2)('GET', '/api/cards5e')).data.cards[0];
  assert.equal(dead.data.earned, 0, '死了的不升级');
  assert.equal(dead.data.money, wizardCard.data.money, '死了的卡照旧');
  assert.deepEqual(dead.data.inventory, wizardCard.data.inventory);
  assert.equal(dead.history[0].survived, false);
  const cleric = (await as(t3)('GET', '/api/cards5e')).data.cards[0];
  assert.equal(cleric.history.length, 0, '交的行动不到三个，不算');

  // 升到 2 级：照新一级做选择（打过的卡，职业、背景、属性这些不能变）
  const level2 = quickCard(RULES, 'fighter', { level: 2 });
  r = await as(t1)('POST', `/api/cards5e/${mine.id}/level-up`, { data: { ...level2, masteries: ['flail', 'greatsword', 'javelin', 'spear'] } });
  assert.equal(r.status, 400, '2 级战士只能精通三种武器');
  // 职业、种族、背景、属性这些交来了也不算，照卡上的
  r = await as(t1)('POST', `/api/cards5e/${mine.id}/level-up`, { data: { ...level2, class: 'wizard', base: { str: 18, dex: 18, con: 18, int: 18, wis: 18, cha: 18 } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.data.level, 2);
  assert.equal(r.data.card.data.class, 'fighter');
  assert.equal(r.data.card.data.base.str, 15);
  assert.equal(r.data.card.data.earned, 0);
  assert.equal(r.data.card.data.money, 1800 + 5000, '升级不动身上的东西');
  assert.equal(r.data.card.sheet.hpMax, 13 + 6 + 2 + 1);

  // 个人主页：5E 角色（种族、职业、等级、打过几个模组）
  const profile = (await as(t2)('GET', `/api/users/${userOf(TESTER1.username).public_id}`)).data;
  assert.deepEqual(
    profile.cards5e.map((c: { name: string; className: string; level: number; modules: number }) => [c.name, c.className, c.level, c.modules]),
    [['阿岚', '战士', 2, 1]],
  );
  assert.equal((await as(t1)('PUT', `/api/cards5e/${mine.id}`, { onProfile: false })).status, 200);
  assert.deepEqual((await as(t2)('GET', `/api/users/${userOf(TESTER1.username).public_id}`)).data.cards5e, []);
});

test('写剧本的编辑器：换成 5E（线索的检定换成属性 + DC、加上建议等级；身份的属性和专长不用、留着）能过检查，换回来也能过；5E 模组的怪物、宝藏有错标在「怪物和宝藏」', async () => {
  const example = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'server', 'editor-example.json'), 'utf8'));
  const five = switchRules(example, '5e');
  assert.deepEqual(validateScenario(five).errors, []);
  assert.equal(five.level, 1);
  assert.deepEqual(five.roles, example.roles, '身份的属性、专长留着（5E 不用），换回来还在');
  const checks = (five.clues as { check?: Record<string, unknown> }[]).filter((c) => c.check).map((c) => c.check!);
  assert.ok(checks.length > 0 && checks.every((c) => typeof c.ability === 'string' && typeof c.dc === 'number'));
  for (const rules of [1, 2] as const) assert.deepEqual(validateScenario(switchRules(five, rules)).errors, [], `换回第${rules}版`);
  assert.deepEqual(switchRules(five, example.rules ?? 1).roles, example.roles);
  // 5E 里新加的身份没有属性、专长；换回去给一套默认的，检查会要求填专长
  const added = { ...five, roles: [...(five.roles as unknown[]), { key: 'new', name: '新人', public: '刚到镇上', secret: '', goal: '找到失踪的人', startLocation: example.locations[0].key, appearance: '' }] };
  assert.equal(validateScenario(added).errors.length, 0);
  assert.ok(validateScenario(switchRules(added, 2)).errors.every((e) => e.startsWith('roles[2].specialties')));
  // 技能检定换回来用技能的属性
  const skilled = { ...five, clues: (five.clues as Record<string, unknown>[]).map((c, i) => (i === 0 ? { ...c, check: { skill: 'stealth', dc: 10 } } : c)) };
  assert.deepEqual((switchRules(skilled, 2).clues as Record<string, unknown>[])[0].check, { attribute: 'agility', modifier: 1 });

  const module = () => JSON.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  let c = (await as(t1)('POST', '/api/editor/validate', { data: module() })).data as EditorCheck;
  assert.equal(c.ok, true, JSON.stringify(c.problems));
  assert.deepEqual([c.summary.five, c.summary.monsters, c.summary.treasure], [true, 6, module().treasure.length]);
  const broken = module();
  broken.monsters[0].monster = 'nope';
  broken.treasure[0].items[0].item = 'nope';
  c = (await as(t1)('POST', '/api/editor/validate', { data: broken })).data as EditorCheck;
  assert.equal(c.ok, false);
  assert.deepEqual(
    c.problems.map((p) => [p.section, p.index, p.text]),
    [
      ['monsters', 0, 'monsters[0].monster：没有这个怪物「nope」（要用 SRD 怪物表里的 key）'],
      ['monsters', 0, 'treasure[0].items[0].item：没有这个物品「nope」（要用 SRD 物品表或自定义道具的 key；武器、护甲后面可以加 +1、+2、+3）'],
    ],
  );
  assert.equal(c.sections.monsters.errors, 2);
});

test('写剧本 skill：讲到了 5E 模组的每个字段和选项，带着 SRD 的怪物表、物品表（附 SRD 的署名）；检查脚本照样查 5E 模组', async () => {
  const entries = new Map((await skillEntries()).map((e) => [e.name.slice(SKILL_NAME.length + 1), String(e.data)]));
  const md = entries.get('SKILL.md')!;
  const fields = [
    ...['monsters', 'treasure', 'monster', 'stats', 'cr', 'ac', 'hp', 'skill', 'ability', 'dc', 'items', 'item', 'count', 'gold'],
    ...['traits', 'actions', 'bonusActions', 'reactions', 'attack', 'damage', 'dice', 'type', 'when', 'save', 'onSuccess', 'saveCondition', 'recharge', 'perDay', 'multiattack'],
    ...['size', 'alignment', 'hitDice', 'speed', 'saves', 'skills', 'resist', 'vulnerable', 'immune', 'conditionImmune', 'senses', 'languages'],
    ...['adv', 'if', 'or', 'half', 'none', '5e'],
    ...ABILITIES,
    ...SKILL_KEYS,
    ...DAMAGE_TYPES,
    ...CONDITIONS,
  ];
  const missing = fields.filter((f) => !md.includes(`\`${f}\``) && !md.includes(`"${f}"`));
  assert.deepEqual(missing, [], `SKILL.md 没讲到：${missing.join('、')}`);
  assert.doesNotMatch(md, /比如/);
  const monsters = entries.get('references/5e-monsters.md')!;
  const items = entries.get('references/5e-items.md')!;
  for (const [text, keys] of [
    [monsters, MONSTER_INDEX.map((m) => m.key)],
    [items, ITEM_INDEX.map((i) => i.key)],
  ] as const) {
    assert.deepEqual(keys.filter((k) => !text.includes(`| \`${k}\` |`)), []);
    assert.ok(text.includes('System Reference Document 5.2.1') && text.includes('creativecommons.org/licenses/by/4.0'), 'SRD 的署名');
  }
  // 泛指的「+1 武器」、拆开以前的「治疗药水」不在物品表里（宝藏写 longsword+1、potion-of-healing）
  assert.ok(!ITEM_INDEX.some((i) => ['weapon-1', 'armor-1', 'shield-1', 'potions-of-healing', 'spell-scroll'].includes(i.key)));

  // 检查脚本：自带的 5E 模组没有错误；怪物、物品写错了照网站的报错
  const ok = checkScenarioText(fs.readFileSync(MODULE_FILE, 'utf8'));
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  const broken = JSON.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  broken.monsters[1].monster = 'beholder';
  const bad = checkScenarioText(JSON.stringify(broken));
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.errors, ['monsters[1].monster：没有这个怪物「beholder」（要用 SRD 怪物表里的 key）']);
});

test('V0.9.0 的更新公告写给玩家：5E 模组、5E 角色、入门模组、维护时的提示；不提商标和模型的名字', () => {
  const note = RELEASE_NOTES.find((n) => n.version === '0.9.0')!;
  assert.ok(note, '有 V0.9.0 的更新说明');
  assert.ok([...note.title].length <= 40 && [...note.body].length <= 2000);
  for (const word of [/5E 模组/, /5E 角色/, /雾岭哑钟/, /升一级/, /正在升级维护/, /QQ 群：1130127996/]) assert.match(note.body, word);
  assert.doesNotMatch(note.body, /D&D|龙与地下城|Claude|DeepSeek|管理|Cloudflare|Worker/);
});

test('按推荐做卡：精灵法师选高等精灵，战士选木精灵；种族、血统给了的戏法和法术不再挑，魔法学徒不挑法术书里有的；特性里卓尔的黑暗视觉不重复、血统法术到了那一级才列', () => {
  const wizard = quickCard(RULES, 'wizard', { species: 'elf', background: 'sage' });
  assert.equal(wizard.lineage, 'elven-lineage-high-elf');
  assert.equal(quickCard(RULES, 'fighter', { species: 'elf' }).lineage, 'elven-lineage-wood-elf');
  assert.ok(!wizard.cantrips.includes('prestidigitation'), '高等精灵的魔法伎俩不用职业的戏法再学');
  const mi = wizard.originFeats.find((f) => f.key === 'magic-initiate')!;
  assert.ok(mi.spell && !wizard.spellbook.includes(mi.spell) && !wizard.prepared.includes(mi.spell));
  assert.ok(!(mi.cantrips ?? []).some((c) => wizard.cantrips.includes(c) || c === 'prestidigitation'));
  // 自己选的时候选重了：说哪里重了
  const twice = { ...wizard, cantrips: ['prestidigitation', ...wizard.cantrips.slice(1)] };
  assert.ok(cardIssues(twice, RULES).some((i) => i.section === 'spells' && i.text === '「魔法伎俩」种族已经给了，换一个别的'), JSON.stringify(cardIssues(twice, RULES)));
  const mi2 = { ...wizard, prepared: [...wizard.prepared.slice(1), mi.spell!] };
  assert.ok(cardProblems(mi2, RULES).some((t) => t.includes('魔法学徒已经给了')));

  const drow = { ...quickCard(RULES, 'wizard', { species: 'elf' }), lineage: 'elven-lineage-drow' };
  const names = (d: Card5eData) => computeSheet(d, RULES).features.map((f) => f.key);
  assert.deepEqual(names(drow).filter((k) => k.startsWith('darkvision')), ['darkvision-120']);
  assert.equal(computeSheet(drow, RULES).darkvision, 120);
  assert.ok(names(drow).includes('lineage-spell-dancing-lights'));
  assert.ok(!names(drow).includes('lineage-spell-faerie-fire') && !names(drow).includes('lineage-spell-darkness'), '1 级还没有妖火、黑暗术');
  const drow5 = { ...quickCard(RULES, 'wizard', { species: 'elf', level: 5 }), lineage: 'elven-lineage-drow' };
  assert.ok(names(drow5).includes('lineage-spell-faerie-fire') && names(drow5).includes('lineage-spell-darkness'));
});

test('实跑一局发现的：链甲的隐匿劣势；专注的说明不乱写；偷袭敌人时怪物先攻劣势；打到一半来的援兵这一轮不再动手；先攻同分的不换位置；开打时说这次结算轮到谁', () => {
  // 链甲：隐匿检定劣势（情境优势和它抵消）
  const fighter = pc5e(1, 'fighter');
  assert.equal(computeSheet(fighter.v5!.data, RULES).stealthDis, '链甲');
  let { ctx } = ctx5e([fighter], [15, 3]);
  let r = run(ctx, 'check', { character: 1, skill: 'stealth', dc: 10, reason: '摸过去' });
  assert.equal(r.mode, 'disadvantage');
  assert.ok(r.because.includes('劣势：穿着链甲'));
  ({ ctx } = ctx5e([fighter], [3]));
  r = run(ctx, 'check', { character: 1, skill: 'stealth', dc: 10, advantage: true, reason: '哨兵在打瞌睡' });
  assert.equal(r.mode, 'normal');
  assert.ok(r.because.includes('优势：情境') && r.because.includes('劣势：穿着链甲'));
  assert.equal(computeSheet(pc5e(2, 'wizard').v5!.data, RULES).stealthDis, null);

  // 专注：之前没在专注，就不写「之前的专注结束了」
  const cleric = pc5e(3, 'cleric', { tweak: clericSpells });
  ({ ctx } = ctx5e([cleric, fighter], [], { actorId: 3 }));
  r = run(ctx, 'cast_spell', { character: 3, spell: 'bless', characters: [1, 3], reason: '为大家祝福' });
  assert.ok(!/之前/.test(r.concentration), r.concentration);
  r = run(ctx, 'cast_spell', { character: 3, spell: 'shield-of-faith', characters: [1], reason: '护住战士' });
  assert.match(r.concentration, /之前专注的祝福术结束了/);

  // 偷袭敌人：怪物的先攻劣势（掷两颗取低）；开打的结果里说这次结算是谁的回合、轮到哪些敌人
  const wizard = pc5e(2, 'wizard', { tweak: wizardSpells });
  let rolls: number[];
  ({ ctx, rolls } = ctx5e([fighter, wizard], [17, 4, 10, 2]));
  r = run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 1 }], enemies_surprised: true, note: '摸到哨兵背后' });
  const fight = () => ctx.world.fights5e.woods;
  assert.deepEqual(fight().order.map((o) => [o.id, o.initiative]), [['c1', 11], ['goblin-minion-1', 6], ['c2', 5]]);
  assert.equal(rolls.length, 0);
  assert.match(r.this_turn, /^这次结算就是阿岚这一轮的回合/);
  assert.match(r.this_turn, /这次结算轮到的敌人（阿岚之后、下一个角色之前）：goblin-minion-1/);

  // 打到一半来的援兵：先攻比这次行动的人高的，这一轮已经轮过了
  const c2 = next(ctx, [20, 1], 2);
  run(c2.ctx, 'start_combat', { monsters: [{ monster: 'goblin-warrior', count: 2 }], note: '塔楼里冲出来两个' });
  const f2 = c2.ctx.world.fights5e.woods;
  const warriors = f2.order.filter((o) => o.id.startsWith('goblin-warrior'));
  assert.deepEqual(warriors.map((o) => [o.id, o.initiative]), [['goblin-warrior-1', 22], ['goblin-warrior-2', 3]]);
  assert.ok(f2.acted.includes('goblin-warrior-1'), '先攻 22 的这一轮已经轮过了');
  assert.ok(!f2.acted.includes('goblin-warrior-2'), '先攻 3 的这一轮还没到');

  // 奥术回复：短休时自动用；玩家想留着就填 keep_recovery；用 use_feature 报错说清楚
  const w2 = pc5e(2, 'wizard', { tweak: wizardSpells });
  w2.v5!.slotsUsed = [1, 0, 0, 0, 0, 0, 0, 0, 0];
  ({ ctx } = ctx5e([w2], [], { actorId: 2 }));
  run(ctx, 'rest', { kind: 'short', keep_recovery: [2], reason: '先留着' });
  assert.deepEqual(ctx.characters.get(2)!.v5!.slotsUsed, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const wrong = ctx.execute('use_feature', { character: 2, feature: 'arcane-recovery', reason: '奥术回复' });
  assert.ok(wrong.isError);
  assert.match(wrong.content, /奥术回复在短休（rest）时自动用/);
  r = run(ctx, 'rest', { kind: 'short', reason: '喘口气' });
  assert.deepEqual(ctx.characters.get(2)!.v5!.slotsUsed, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(r.results[0].changes.some((x: string) => x.includes('奥术回复')));

  // 喝药水：结果里写实际回了多少（满了就说满了）
  const hurt = pc5e(1, 'fighter');
  hurt.v5!.hp = 11;
  hurt.v5!.inventory.push({ key: 'potion-of-healing', qty: 1 });
  ({ ctx } = ctx5e([hurt], [2, 3]));
  r = run(ctx, 'use_item', { character: 1, item: 'potion-of-healing', reason: '喝一口' });
  assert.equal(r.result, '阿岚恢复 2 点生命值（掷出 7，生命值 11 → 13，满了）');

  // 先攻同分：角色在怪物前面，同一边的照原来的先后（加了援兵重新排也不换）
  const a = pc5e(1, 'fighter');
  const b = pc5e(2, 'fighter');
  ({ ctx } = ctx5e([a, b], [9, 10, 10]));
  run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 1 }] });
  assert.deepEqual(ctx.world.fights5e.woods.order.map((o) => o.id), ['c1', 'c2', 'goblin-minion-1']);
  const c3 = next(ctx, [9], 1);
  run(c3.ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 1 }] });
  assert.deepEqual(c3.ctx.world.fights5e.woods.order.map((o) => o.id), ['c1', 'c2', 'goblin-minion-1', 'goblin-minion-2']);
});

test('实跑一局发现的（二）：别处的仗用 location 收拾；协助动作程序记着；「到下一个回合结束」的状态到时候去掉；敌人身上能记数；提示词和模组讲清楚', () => {
  // 在冢门前敲钟，墓室里的骷髅倒回壁龛：update_enemy、end_combat 填那个地点；不填时报错说哪里在打仗
  const inBarrow = pc5e(1, 'fighter', { location: 'barrow' });
  const atGate = pc5e(2, 'wizard', { location: 'barrow-gate', tweak: wizardSpells });
  let { ctx } = ctx5e([inBarrow, atGate], [15, 3, 4]);
  run(ctx, 'start_combat', { monsters: [{ monster: 'skeleton', count: 2 }], note: '骷髅从壁龛里爬起来' });
  const gate = next(ctx, [], 2).ctx;
  let bad = gate.execute('update_enemy', { enemy: 'skeleton-1', gone: true, note: '钟声' });
  assert.ok(bad.isError);
  assert.match(bad.content, /墨衡这里没有在打仗；现在在打仗的地方：古冢墓室（barrow）。行动影响到那里的战斗时，用 location 填那个地点/);
  bad = gate.execute('attack', { character: 2, target: 'skeleton-1', weapon: 'dagger', reason: '扔匕首' });
  assert.ok(bad.isError);
  assert.match(bad.content, /现在在打仗的地方：古冢墓室（barrow）；要参加那里的战斗得先走过去/);
  bad = gate.execute('end_combat', { note: '钟声', location: 'inn' });
  assert.ok(bad.isError);
  assert.match(bad.content, /「inn」没有在打仗；现在在打仗的地方：古冢墓室（barrow）/);
  for (const id of ['skeleton-1', 'skeleton-2']) run(gate, 'update_enemy', { enemy: id, gone: true, note: '钟声传进墓室，它倒回了壁龛', location: 'barrow' });
  assert.ok(gate.events.includes('冢中骷髅1退出了战斗：钟声传进墓室，它倒回了壁龛'), gate.events.join('｜'));
  run(gate, 'end_combat', { note: '骷髅都倒回了壁龛', location: 'barrow' });
  assert.equal(gate.world.fights5e?.barrow, undefined);

  // 协助：攻击——同伴下一次打那个敌人有优势，用一次就没了；检定——下一次属性检定有优势；协助的人下回合开始就失效
  const fighter = pc5e(1, 'fighter');
  const wizard = pc5e(2, 'wizard', { tweak: wizardSpells });
  ({ ctx } = ctx5e([fighter, wizard], [10, 15, 2], { actorId: 2 }));
  run(ctx, 'start_combat', { monsters: [{ monster: 'goblin-minion', count: 1 }] });
  assert.ok(ctx.execute('use_feature', { character: 2, feature: 'help', target_character: 2, reason: '自己帮自己' }).isError);
  let r = run(ctx, 'use_feature', { character: 2, feature: 'help', target_character: 1, enemies: ['goblin-minion-1'], reason: '用法杖戳地精，让它分心' });
  assert.match(r.result, /协助阿岚：牵制住破耳喽啰，阿岚下一次攻击它有优势（到墨衡下回合开始前有效）/);
  let c1 = next(ctx, [2, 3], 1).ctx;
  r = run(c1, 'attack', { character: 1, target: 'goblin-minion-1', weapon: 'greatsword', reason: '砍地精' });
  const card = c1.cards.at(-1)!;
  assert.equal(card.d20!.mode, 'advantage');
  assert.match(card.d20!.note ?? '', /优势：墨衡的协助/);
  assert.ok(!c1.characters.get(1)!.v5!.effects.some((e) => e.key === 'help'), '协助用一次就没了');

  ({ ctx } = ctx5e([fighter, wizard], [], { actorId: 2 }));
  run(ctx, 'use_feature', { character: 2, feature: 'help', target_character: 1, reason: '在旁边扶着' });
  c1 = next(ctx, [4, 17], 1).ctx;
  r = run(c1, 'check', { character: 1, skill: 'athletics', dc: 15, reason: '爬上墙' });
  assert.equal(r.mode, 'advantage');
  assert.ok(r.because.includes('优势：墨衡的协助'));
  assert.ok(!c1.characters.get(1)!.v5!.effects.some((e) => e.key === 'help'));
  run(ctx, 'use_feature', { character: 2, feature: 'help', target_character: 1, reason: '再扶一次' });
  const later = next(ctx, [], 2).ctx;
  assert.ok(!later.characters.get(1)!.v5!.effects.some((e) => e.key === 'help'), '协助的人下回合开始，没用上的协助就没了');
  const far = pc5e(3, 'cleric', { location: 'inn', tweak: clericSpells });
  ({ ctx } = ctx5e([fighter, wizard, far], [], { actorId: 2 }));
  bad = ctx.execute('use_feature', { character: 2, feature: 'help', target_character: 3, reason: '隔空帮忙' });
  assert.ok(bad.isError);
  assert.match(bad.content, /辛夷不在墨衡身边，协助不了/);

  // 「到他下一个回合结束」：钟声让铁颚王恐慌，他这一回合攻击有劣势，回合结束（这次结算做完）就去掉；敌人身上记着钟敲了几声
  const ringer = pc5e(2, 'wizard', { location: 'barrow', tweak: wizardSpells });
  ({ ctx } = ctx5e([ringer], [20, 2, 5, 2], { actorId: 2 }));
  run(ctx, 'start_combat', { monsters: [{ monster: 'ironjaw', count: 1 }], note: '铁颚王站了起来' });
  const boss = ctx.world.fights5e.barrow.monsters[0];
  r = run(ctx, 'condition', { enemies: [boss.id], add: [{ condition: 'frightened', until: 'own_turn_end' }], reason: '钟声' });
  assert.match(JSON.stringify(r.results), new RegExp(`恐慌（到${boss.name}下一个回合结束）`));
  r = run(ctx, 'update_enemy', { enemy: boss.id, note: '敲了第一声', mark: '钟在棺床前敲了一声' });
  assert.equal(r.mark, '钟在棺床前敲了一声');
  run(ctx, 'monster_action', { enemy: boss.id, action: '锈铁长剑', targets: [2], reason: '劈向敲钟的人' });
  const swing = ctx.cards.at(-1)!;
  assert.equal(swing.d20!.mode, 'disadvantage');
  assert.ok(ctx.world.fights5e.barrow.monsters[0].conditions.some((x) => x.key === 'frightened'), '他的回合还没结束，恐慌还在');
  ctx.finish();
  assert.ok(!ctx.world.fights5e.barrow.monsters[0].conditions.some((x) => x.key === 'frightened'), '回合结束，恐慌去掉了');
  assert.ok(ctx.events.includes(`${boss.name}不再恐慌`));
  const text = buildDmContext({
    scenario: MODULE,
    world: ctx.world,
    characters: [...ctx.characters.values()],
    clues: [],
    actor: ctx.characters.get(2)!,
    action: { content: '再敲一声', gameStart: 600, minutes: 1 },
    pending: [{ characterName: '辛夷', content: '去推石板' }],
    recent: [],
  });
  assert.match(text, /记着：钟在棺床前敲了一声/);
  assert.match(text, /辛夷：「去推石板」（这些之后各自结算：这次的叙述不要替它们写结果/);
  // 角色身上的：到他自己下一个回合结束（他的回合开始了，这次结算做完去掉）
  ({ ctx } = ctx5e([fighter, wizard], [], { actorId: 2 }));
  run(ctx, 'condition', { characters: [1], add: [{ condition: 'prone', until: 'own_turn_end' }], reason: '被撞倒' });
  ctx.finish();
  c1 = next(ctx, [], 1).ctx;
  assert.ok(c1.characters.get(1)!.v5!.conditions.some((x) => x.key === 'prone'), '他的回合里还倒着');
  c1.finish();
  assert.ok(!c1.characters.get(1)!.v5!.conditions.some((x) => x.key === 'prone'));

  // 提示词：协助、until、mark、别处的仗、开打以前写好的行动、结局时发宝藏；还在争取别的结局时先不结束
  for (const re of [/use_feature 的 help/, /填 until/, /update_enemy 的 mark/, /填那个地点的 location/, /打起来以前写好的行动/, /在调用 end_game 的同一次结算里用 give_treasure 发掉/]) assert.match(DM_RULES_5E, re);
  for (const rules of [DM_RULES, DM_RULES_V2, DM_RULES_5E]) assert.match(rules, /角色们明摆着还在争取另一个结局/);
  // 模组：钟声的结局要回了村才算；敲三声是三个动作；冢睡着时铁颚王也睡着，钟抬到棺床前才惊醒；宝藏结局前发；贝丝的账一笔勾销
  const ending = MODULE.endings.find((e) => e.key === 'bell-rings')!;
  assert.match(ending.condition, /平安回到了村子，角色们也不再进古冢/);
  assert.match(JSON.stringify(MODULE.monsters), /敲一声是一个动作；几个人可以轮流敲/);
  assert.match(JSON.stringify(MODULE.locations), /把钟抬到棺床前要敲，他就惊醒过来动手/);
  assert.ok(MODULE.treasure!.filter((t) => /结局前发给/.test(t.how)).length === 2);
  assert.match(JSON.stringify(MODULE.npcs), /这笔账就一笔勾销/);
});

test('新背景：艺人、平民英雄、公会工匠；选多才多艺能补三个技能', () => {
  const bg = RULES.backgrounds.find((b) => b.key === 'entertainer')!;
  assert.equal(bg.name, '艺人');
  assert.deepEqual(bg.skills, ['acrobatics', 'performance']);
  assert.equal(bg.tool, 'disguise-kit');
  assert.equal(bg.toolText, '易容工具、一种乐器');
  assert.equal(bg.feat, 'skilled');
  assert.equal(bg.feature?.name, '人见人爱');
  assert.ok(bg.equipment[0].items.some((i) => i.key === 'lute'));
  const card = quickCard(RULES, 'fighter', { background: 'entertainer' });
  card.originFeats = [{ key: 'skilled', source: 'background', skills: ['arcana', 'history', 'nature'] }];
  assert.deepEqual(cardProblems(card, RULES), []);
  const folk = RULES.backgrounds.find((b) => b.key === 'folk-hero')!;
  assert.equal(folk.name, '平民英雄');
  assert.equal(folk.feat, 'savage-attacker');
  assert.equal(folk.feature?.name, '好客乡民');
  const guild = RULES.backgrounds.find((b) => b.key === 'guild-artisan')!;
  assert.equal(guild.name, '公会工匠');
  assert.equal(guild.feature?.name, '公会成员');
  assert.ok(guild.equipmentText.includes('会费'));
});

test('职业和背景的起始装备分开：法师选士兵只多士兵背景的装备，不会有战士职业的链甲、巨剑', () => {
  const wizard = quickCard(RULES, 'wizard', { background: 'soldier' });
  const inv = startingInventory(wizard, RULES).inventory;
  assert.ok(inv.some((i) => i.key === 'spear'), '士兵背景有矛');
  assert.equal(inv.some((i) => i.key === 'chain-mail'), false);
  assert.equal(inv.some((i) => i.key === 'greatsword'), false);
});

test('第二批背景：隐士、贵族、化外之民、水手、流浪儿的数据和特性', () => {
  const keys = ['hermit', 'noble', 'outlander', 'sailor', 'urchin'];
  for (const key of keys) assert.ok(RULES.backgrounds.some((b) => b.key === key), key);
  assert.deepEqual(
    RULES.backgrounds.filter((b) => keys.includes(b.key)).map((b) => b.name),
    ['隐士', '贵族', '化外之民', '水手', '流浪儿'],
  );
  const hermit = RULES.backgrounds.find((b) => b.key === 'hermit')!;
  assert.deepEqual(hermit.skills, ['medicine', 'religion']);
  assert.equal(hermit.tool, 'herbalism-kit');
  assert.equal(hermit.languageChoices, 1);
  const noble = RULES.backgrounds.find((b) => b.key === 'noble')!;
  assert.equal(noble.feature?.name, '特权地位');
  assert.equal(noble.toolText, '一种赌具');
  assert.equal(noble.languageChoices, 1);
  const outlander = RULES.backgrounds.find((b) => b.key === 'outlander')!;
  assert.equal(outlander.feature?.name, '漂泊者');
  assert.equal(outlander.languageChoices, 1);
  // 智者删掉，研究员给了贤者
  assert.ok(!RULES.backgrounds.some((b) => b.key === 'sage-classic'));
  const sage = RULES.backgrounds.find((b) => b.key === 'sage')!;
  assert.equal(sage.feature?.name, '研究员');
  const sailor = RULES.backgrounds.find((b) => b.key === 'sailor')!;
  assert.equal(sailor.feature?.name, '船家路子');
  assert.equal(sailor.toolText, '领航工具、载具（水运）');
  const urchin = RULES.backgrounds.find((b) => b.key === 'urchin')!;
  assert.equal(urchin.feature?.name, '城中秘密');
  assert.equal(urchin.toolText, '易容工具、盗贼工具');
});

test('原有的侍僧、罪犯、士兵也有单独的背景特性', () => {
  const feature = (key: string) => RULES.backgrounds.find((b) => b.key === key)?.feature?.name;
  assert.equal(feature('acolyte'), '信仰庇护');
  assert.equal(feature('criminal'), '罪犯接头人');
  assert.equal(feature('soldier'), '军衔');
  const acolyte = RULES.backgrounds.find((b) => b.key === 'acolyte')!;
  assert.ok(acolyte.feature?.text.includes('神庙、圣坛'));
  const soldier = RULES.backgrounds.find((b) => b.key === 'soldier')!;
  assert.ok(soldier.feature?.text.includes('临时征用简单的装备或马匹'));
});

test('背景可选语言：隐士、贵族、化外之民各选一门，选项是通用语、矮人语、精灵语、巨人语、侏儒语、地精语、半身人语、兽人语', () => {
  const card = quickCard(RULES, 'wizard', { background: 'hermit' });
  assert.ok(cardProblems(card, RULES).some((p) => p.includes('要选 1 门语言')));
  card.languages = ['elvish'];
  assert.ok(!cardProblems(card, RULES).some((p) => p.includes('语言')));
  const dup = { ...card, languages: ['elvish', 'elvish'] as ('elvish')[] };
  assert.ok(cardProblems(dup, RULES).some((p) => p.includes('语言不能重复')));
});

test('半精灵：中型、30 尺、黑暗视觉、精类血统、多才多艺、魅力 +2 再选两项各 +1、通用语和精灵语再选一门', () => {
  const sp = RULES.species.find((s) => s.key === 'half-elf')!;
  assert.equal(sp.name, '半精灵');
  assert.equal(sp.size, 'medium');
  assert.equal(sp.speed, 30);
  assert.equal(sp.darkvision, 60);
  assert.deepEqual(sp.traits, ['darkvision-60', 'half-elf-fey-ancestry', 'skill-versatility']);
  assert.deepEqual(sp.abilityBonus?.fixed, { cha: 2 });
  assert.equal(sp.abilityBonus?.choose, 2);
  assert.equal(sp.skillChoices, 2);
  assert.deepEqual(sp.languages, { fixed: ['common', 'elvish'], choices: 1 });
  assert.deepEqual(sp.lineages.map((l) => l.name), ['半木精灵', '半高精灵', '半卓尔']);
  assert.equal(sp.lineageLabel, '半精灵血统');

  const card = quickCard(RULES, 'fighter', { species: 'half-elf' });
  assert.equal(card.speciesBonus?.cha, 2);
  assert.equal(Object.keys(card.speciesBonus ?? {}).length, 3);
  assert.equal(card.speciesSkills?.length, 2);
  assert.equal(card.speciesLanguages?.length, 1);
  assert.deepEqual(cardProblems(card, RULES), []);
  const sheet = computeSheet(card, RULES);
  assert.ok(sheet.abilities.cha >= 10);
});

test('牧师可以选择神祇：被遗忘的国度和非人类神祇都能选，别的职业不能选', () => {
  const cleric = quickCard(RULES, 'cleric');
  assert.ok(cleric.deity);
  assert.deepEqual(cardProblems(cleric, RULES), []);
  const noDeity = { ...cleric, deity: null };
  assert.ok(cardProblems(noDeity, RULES).some((p) => p.includes('选一个神祇')));
  const wrong = { ...cleric, deity: 'no-such-god' };
  assert.ok(cardProblems(wrong, RULES).some((p) => p.includes('没有这个神祇')));
  const fighter = quickCard(RULES, 'fighter');
  assert.ok(cardProblems({ ...fighter, deity: 'fr-1' }, RULES).some((p) => p.includes('只有牧师')));
});

test('商店价格：游说每 +1 收购价加 5 个百分点、买价降 5%，都有上下限', () => {
  assert.equal(shopSellRate(50, 0), 50);
  assert.equal(shopSellRate(50, 1), 55);
  assert.equal(shopSellRate(50, -1), 45);
  assert.equal(shopSellRate(90, 10), 100);
  assert.equal(shopSellRate(10, -10), 0);
  assert.equal(shopSellRate(0, 10), 0);

  assert.equal(shopBuyPrice(100, 0), 100);
  assert.equal(shopBuyPrice(100, 1), 95);
  assert.equal(shopBuyPrice(100, 3), 85);
  assert.equal(shopBuyPrice(100, 10), 50);
  assert.equal(shopBuyPrice(100, 20), 50);
  assert.equal(shopBuyPrice(100, -2), 100);
  assert.equal(shopBuyPrice(1, 10), 1);
  assert.equal(shopBuyPrice(0, 10), 0);
});

test('图腾武者道途：3 级选熊、鹰或狼；选了子职必须选图腾，其他子职不能选', () => {
  const card = quickCard(RULES, 'barbarian', { level: 3 });
  card.subclass = 'path-of-the-totem-warrior';
  card.totem = 'bear';
  assert.equal(cardProblems(card, RULES).filter((p) => p.includes('图腾')).length, 0);
  const noTotem = { ...card, totem: null };
  assert.ok(cardProblems(noTotem, RULES).some((p) => p.includes('选一个图腾精魄')));
  const wrong = { ...card, totem: 'fox' };
  assert.ok(cardProblems(wrong, RULES).some((p) => p.includes('没有这个图腾精魄')));
  const other = quickCard(RULES, 'barbarian', { level: 3 });
  other.subclass = 'path-of-the-berserker';
  other.totem = 'wolf';
  assert.ok(cardProblems(other, RULES).some((p) => p.includes('只有图腾武者')));
});

test('经验表：1～20 级阈值和升级判定', () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(5), 6500);
  assert.equal(xpForLevel(6), 14000);
  assert.equal(xpForLevel(20), 355000);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(299), 1);
  assert.equal(levelForXp(300), 2);
  assert.equal(levelForXp(6500), 5);
  assert.equal(levelForXp(355000), 20);
});

test('野蛮人 1～20 级：狂暴次数、狂暴伤害和 20 级上限', () => {
  assert.equal(maxLevelFor('barbarian'), 20);
  assert.equal(maxLevelFor('wizard'), 20);
  assert.deepEqual(RAGES, [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 10]);
  assert.deepEqual(RAGE_DAMAGE, [2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
  const c = quickCard(RULES, 'barbarian', { level: 20 });
  c.asi = Array.from({ length: 5 }, () => ({ str: 2 }));
  const sheet = computeSheet(c, RULES);
  assert.equal(sheet.level, 20);
  assert.equal(sheet.resources.find((r) => r.key === 'rage')?.max, 10);
  assert.equal(sheet.abilities.str, 24, '原初斗士：力量 +4，上限 24');
});

test('野蛮人不屈勇武：18 级力量检定总值低于力量值时，直接按力量值算', () => {
  const barbarian = pc5e(4, 'barbarian', { tweak: (d) => { d.level = 18; } });
  const { ctx } = ctx5e([barbarian], [1], { actorId: 4 });
  const score = computeSheet(barbarian.v5!.data, RULES).abilities.str;
  const r = run(ctx, 'check', { character: 4, ability: 'str', dc: 5, reason: '搬开石头' });
  assert.equal(r.total, score);
  assert.match(r.indomitable_might, /不屈勇武/);
  assert.equal(r.success, true);
});

test('野蛮人两个道途的特性各自归位，不串到另一个道途', () => {
  const berserker = RULES.subclasses.find((s) => s.key === 'path-of-the-berserker')!;
  const totem = RULES.subclasses.find((s) => s.key === 'path-of-the-totem-warrior')!;
  assert.deepEqual(berserker.features.map((f) => [f.level, f.key]), [
    [3, 'berserker-frenzy'],
    [6, 'berserker-mindless-rage'],
    [10, 'berserker-intimidating-presence'],
    [14, 'berserker-retaliation'],
  ]);
  assert.deepEqual(berserker.features.map((f) => RULES.features[f.key].name), ['狂怒', '无我狂暴', '威慑之姿', '报偿']);
  assert.deepEqual(totem.features.map((f) => [f.level, f.key]), [
    [3, 'totem-spirit-seeker'],
    [3, 'totem-spirit'],
    [6, 'totem-aspect-of-the-beast'],
    [10, 'totem-spirit-walker'],
    [14, 'totem-totemic-attunement'],
  ]);
  assert.deepEqual(totem.features.map((f) => RULES.features[f.key].name), ['精魄寻者', '图腾精魄', '兽之形', '精魄行者', '图腾同调']);
  assert.ok(!totem.features.some((f) => f.key.startsWith('berserker-')));
  assert.ok(!berserker.features.some((f) => f.key.startsWith('totem-')));
});

test('吟游诗人：2 级休憩曲、3 级专精、6 级反迷惑、10/14/18 级魔法奥秘、20 级先发激励', () => {
  const bard = RULES.classes.find((c) => c.key === 'bard')!;
  const byLevel = (n: number) => bard.levels.find((l) => l.level === n)?.features ?? [];
  assert.ok(byLevel(2).includes('bard-song-of-rest-1'));
  assert.ok(byLevel(3).includes('bard-expertise'));
  assert.ok(byLevel(6).includes('bard-countercharm'));
  assert.ok(byLevel(10).includes('bard-magical-secrets-1'));
  assert.ok(byLevel(14).includes('bard-magical-secrets-2'));
  assert.ok(byLevel(18).includes('bard-magical-secrets-3'));
  assert.ok(byLevel(20).includes('bard-superior-inspiration'));
  assert.equal(asiCount(20, 'bard'), 5);
  assert.equal(expertiseCount('bard', 3), 2);
  assert.equal(expertiseCount('bard', 10), 4);
});

test('逸闻学院：3 级附赠熟练和语出惊人，6 级额外魔法奥秘，14 级超凡技艺', () => {
  const lore = RULES.subclasses.find((s) => s.key === 'college-of-lore')!;
  assert.deepEqual(lore.features.map((f) => [f.level, f.key]), [
    [3, 'lore-bonus-proficiencies'],
    [3, 'lore-cutting-words'],
    [6, 'lore-additional-magical-secrets'],
    [14, 'lore-peerless-skill'],
  ]);
  assert.equal(magicalSecretsCount(6, 'college-of-lore'), 2);
  assert.equal(magicalSecretsCount(10, 'college-of-lore'), 4);
  assert.equal(magicalSecretsCount(14, 'college-of-lore'), 6);
  assert.equal(magicalSecretsCount(18, 'college-of-lore'), 8);
  assert.equal(magicalSecretsCount(6, 'path-of-the-berserker'), 0);
});

test('勇气学院：3 级中甲/盾牌/军用武器熟练，6 级额外攻击，14 级战斗魔法', () => {
  const valor = RULES.subclasses.find((s) => s.key === 'college-of-valor')!;
  assert.deepEqual(valor.features.map((f) => [f.level, f.key]), [
    [3, 'valor-bonus-proficiencies'],
    [3, 'valor-combat-inspiration'],
    [6, 'valor-extra-attack'],
    [14, 'valor-battle-magic'],
  ]);
  const card = quickCard(RULES, 'bard', { level: 6 });
  card.subclass = 'college-of-valor';
  const cls = RULES.classes.find((c) => c.key === 'bard')!;
  const martial = RULES.weapons.find((w) => w.category === 'martial')!;
  assert.equal(armorTrained(card, cls, 'medium'), true);
  assert.equal(armorTrained(card, cls, 'shield'), true);
  assert.equal(weaponProficient(card, cls, martial), true);
  assert.ok(RULES.features['valor-extra-attack'].text.includes('两次'));
});

test('兼职：总等级等于主职业加兼职等级，重复职业和超过 20 级会被检查出来', () => {
  const card = quickCard(RULES, 'bard', { level: 3 });
  card.multiclass = [{ class: 'fighter', level: 2 }];
  assert.equal(totalLevel(card), 5);
  const sheet = computeSheet(card, RULES);
  assert.equal(sheet.totalLevel, 5);
  assert.equal(sheet.pb, 3, '熟练加值按总等级 5 算');
  assert.equal(cardProblems(card, RULES).filter((p) => p.includes('兼职') || p.includes('总等级')).length, 0);
  assert.ok(cardProblems({ ...card, multiclass: [{ class: 'bard', level: 1 }] }, RULES).some((p) => p.includes('重复兼职')));
  assert.ok(cardProblems({ ...card, level: 20, multiclass: [{ class: 'fighter', level: 2 }] }, RULES).some((p) => p.includes('总等级不能超过 20')));
  const low = { str: 8, dex: 8, con: 10, int: 8, wis: 8, cha: 8 };
  assert.equal(meetsMulticlassRequirement('wizard', low), false);
  assert.equal(meetsMulticlassRequirement('barbarian', { ...low, str: 13 }), true);
  assert.equal(meetsMulticlassRequirement('fighter', { ...low, dex: 13 }), true);
  assert.equal(meetsMulticlassRequirement('monk', { ...low, dex: 13, wis: 13 }), true);
  assert.equal(meetsMulticlassRequirement('paladin', { ...low, str: 13, cha: 13 }), true);
  const weak = quickCard(RULES, 'bard', { level: 1 });
  weak.base = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
  weak.bgBonus = {};
  weak.speciesBonus = {};
  weak.asi = [];
  weak.multiclass = [{ class: 'fighter', level: 1 }];
  assert.deepEqual(unmetMulticlass(weak).sort(), ['bard', 'fighter']);
});

test('通用专长：警觉、运动员、演员、冲锋手、强弩专家、防御式决斗、双持客都能选', () => {
  for (const key of ['alert-2014', 'athlete', 'actor', 'charger', 'crossbow-expert', 'defensive-duelist', 'dual-wielder']) {
    const f = RULES.feats.find((x) => x.key === key);
    assert.ok(f, key);
    assert.equal(f.type, 'general');
  }
  const card = quickCard(RULES, 'wizard', { level: 4 });
  card.asi = [{}];
  card.asiFeats = [{ key: 'alert-2014' }];
  assert.equal(cardProblems(card, RULES).filter((p) => p.includes('专长')).length, 0);
  const before = finalAbilities({ ...card, asiFeats: [] }).str;
  const after = finalAbilities({ ...card, asiFeats: [{ key: 'athlete', ability: 'str' }] }).str;
  assert.equal(after, before + 1);
});

test('牧师 1～20 级：法术位到 9 环、引导神力 3/休、神圣干预和摧毁不死', () => {
  const card = quickCard(RULES, 'cleric', { level: 20 });
  const sheet = computeSheet(card, RULES);
  assert.ok(sheet.spell);
  assert.equal(sheet.spell.slots.length, 9);
  assert.deepEqual(sheet.spell.slots, [4, 3, 3, 3, 3, 2, 2, 1, 1]);
  assert.equal(sheet.resources.find((r) => r.key === 'channel-divinity')?.max, 3);
  const names = sheet.features.map((f) => f.name);
  assert.ok(names.includes('神圣干预'));
  assert.ok(names.includes('神圣干预增效'));
  assert.ok(names.includes('摧毁不死生物（CR 4）'));
});
