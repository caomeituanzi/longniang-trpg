import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outcomeFor, outcomeOdds } from '../shared/rules';
import {
  actionBlocker,
  applyGrowth,
  applyHarm,
  check,
  checkInputError,
  FRESH_STATE,
  opposed,
  penaltiesFor,
  resolveCheck,
  validateNewCharacter,
  type CheckInput,
  type Rng,
} from '../server/game/rules';

/** 按顺序吐出给定点数的“骰子”。 */
function fixedRng(...faces: number[]): Rng {
  return () => {
    const next = faces.shift();
    if (next === undefined) throw new Error('骰子不够用了');
    return next;
  };
}

const base: CheckInput = { attribute: 'perception', attributeValue: 1, specialty: null, modifier: 0, assisted: false, penalties: [] };

test('检定结果按总点数分档，两个6必是大成功，两个1必是大失败', () => {
  assert.equal(outcomeFor(4, 6, 10), 'success');
  assert.equal(outcomeFor(4, 5, 9), 'partial');
  assert.equal(outcomeFor(3, 4, 7), 'partial');
  assert.equal(outcomeFor(3, 3, 6), 'failure');
  assert.equal(outcomeFor(6, 6, 7), 'critical'); // 减值再多，两个6也是大成功
  assert.equal(outcomeFor(1, 1, 9), 'fumble'); // 加值再多，两个1也是大失败
});

test('属性0和+2时各档的概率', () => {
  const zero = outcomeOdds(0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(zero).map(([k, v]) => [k, Math.round(v * 36)])),
    { critical: 1, success: 5, partial: 15, failure: 14, fumble: 1 },
  );
  const plus2 = outcomeOdds(2);
  assert.deepEqual(
    Object.fromEntries(Object.entries(plus2).map(([k, v]) => [k, Math.round(v * 36)])),
    { critical: 1, success: 14, partial: 15, failure: 5, fumble: 1 },
  );
  assert.ok(Math.abs(Object.values(plus2).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('检定把属性、专长、修正、协助、减值都算进去，并列出明细', () => {
  const r = resolveCheck([3, 4], {
    ...base,
    specialty: '侦探',
    modifier: -1,
    assisted: true,
    penalties: [{ reason: '重伤', value: -1 }],
  });
  assert.equal(r.total, 3 + 4 + 1 + 1 - 1 + 1 - 1);
  assert.equal(r.outcome, 'partial');
  assert.deepEqual(
    r.parts.map((p) => p.label),
    ['骰子', '感知', '专长「侦探」', '情境修正', '协助', '重伤'],
  );
  assert.equal(check(base, fixedRng(5, 5)).total, 11);
});

test('AI给的检定参数不合规时会被拒绝', () => {
  assert.equal(checkInputError({ attribute: 'charm', modifier: 2 }), null);
  assert.match(checkInputError({ attribute: 'charm', modifier: 3 })!, /修正/);
  assert.match(checkInputError({ attribute: 'charm', modifier: 0.5 })!, /修正/);
  assert.match(checkInputError({ attribute: 'luck' as never, modifier: 0 })!, /属性/);
});

test('对抗：点数高的赢，平局维持原状', () => {
  const a = { ...base, attributeValue: 2 };
  const b = { ...base, attributeValue: 0 };
  assert.equal(opposed(a, b, fixedRng(3, 3, 4, 4)).winner, 'tie'); // 8 对 8
  assert.equal(opposed(a, b, fixedRng(3, 3, 3, 3)).winner, 'a');
  assert.equal(opposed(a, b, fixedRng(1, 2, 6, 5)).winner, 'b');
});

test('重伤、崩溃和状态标签带来减值；心智关掉时不算', () => {
  const state = { ...FRESH_STATE, wounds: 2, stress: 2, conditions: [{ name: '中毒', effect: '头晕', penalty: -1 }] };
  assert.deepEqual(
    penaltiesFor(state, true).map((p) => p.reason),
    ['重伤', '崩溃', '中毒'],
  );
  assert.deepEqual(
    penaltiesFor(state, false).map((p) => p.reason),
    ['重伤', '中毒'],
  );
  assert.deepEqual(penaltiesFor({ ...FRESH_STATE, wounds: 1 }, true), []);
});

test('濒死和失控不能行动；濒死时再受伤就死亡', () => {
  assert.equal(actionBlocker(FRESH_STATE, true), null);
  assert.match(actionBlocker({ ...FRESH_STATE, wounds: 3 }, true)!, /濒死/);
  assert.match(actionBlocker({ ...FRESH_STATE, stress: 3 }, true)!, /失控/);
  assert.equal(actionBlocker({ ...FRESH_STATE, stress: 3 }, false), null);

  const hurt = applyHarm(FRESH_STATE, 'wounds', 1);
  assert.equal(hurt.state.wounds, 1);
  assert.equal(applyHarm({ ...FRESH_STATE, wounds: 2 }, 'wounds', 2).died, true);
  assert.equal(applyHarm({ ...FRESH_STATE, wounds: 3 }, 'wounds', 1).state.dead, true);
  assert.equal(applyHarm({ ...FRESH_STATE, wounds: 2 }, 'wounds', -1).state.wounds, 1);
  assert.equal(applyHarm({ ...FRESH_STATE, stress: 2 }, 'stress', 5).state.stress, 3);
  assert.equal(applyHarm({ ...FRESH_STATE, stress: 3 }, 'stress', 1).died, false);
});

test('车卡：属性要把 +2、+1、+1、0、-1 各用一次，专长两个且不重复', () => {
  const good = {
    name: ' 苏小满 ',
    roleKey: 'reporter',
    attributes: { body: -1, agility: 0, intellect: 1, perception: 2, charm: 1 },
    specialties: ['速记', '打听消息'],
    appearance: '短发，总揣着一支钢笔',
    goal: '把新闻登上头版',
  };
  const ok = validateNewCharacter(good, ['reporter', 'doctor']);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.name, '苏小满');

  const bad = validateNewCharacter(
    { ...good, roleKey: 'king', attributes: { ...good.attributes, charm: 2 }, specialties: ['速记', '速记'] },
    ['reporter'],
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.length, 3);
    assert.ok(bad.errors.some((e) => e.includes('身份')));
    assert.ok(bad.errors.some((e) => e.includes('各用一次')));
    assert.ok(bad.errors.some((e) => e.includes('不能一样')));
  }
});

test('成长：属性最高到+3，专长不能重复', () => {
  const attrs = { body: 3, agility: 0, intellect: 1, perception: 2, charm: -1 };
  assert.equal(applyGrowth(attrs, [], { type: 'attribute', key: 'body' }).ok, false);
  const up = applyGrowth(attrs, [], { type: 'attribute', key: 'charm' });
  assert.ok(up.ok && up.attributes.charm === 0);
  assert.equal(applyGrowth(attrs, ['医生'], { type: 'specialty', name: '医生' }).ok, false);
  const learned = applyGrowth(attrs, ['医生'], { type: 'specialty', name: '开锁' });
  assert.ok(learned.ok && learned.specialties.length === 2);
});
