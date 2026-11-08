process.env.TZ = 'Asia/Shanghai';
// V0.7.1：主持规则补上模拟第二局（垭口的第五个人）里发现的空白。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DM_RULES, DM_RULES_V2 } from '../server/game/prompts';
import { DM_TOOLS } from '../server/game/tools';
import { dmTools2 } from '../server/game/tools2';
import { readFileSync } from 'node:fs';
import { validateScenario } from '../server/game/scenario';

const loadScenarioFile = (file: string) => {
  const result = validateScenario(JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(result.scenario, `${file} 读不进来`);
  return result.scenario;
};

test('V0.7.1 主持规则：地图之外、能当证据的话、和 NPC 动手（两版规则都有）', () => {
  for (const rules of [DM_RULES, DM_RULES_V2]) {
    assert.match(rules, /地图之外：move_character 只能去剧本写了的地点/);
    assert.match(rules, /不让他一走了之、绕过整个剧本/);
    assert.match(rules, /能当证据用的话也是新情报/);
    assert.match(rules, /那天夜里外头根本没起风/);
    assert.match(rules, /和 NPC 动手/);
    assert.match(rules, /update_npc 记/);
  }
  // 第二版：普通剧本没有敌人数值，打 NPC 不用战斗工具；伤的轻重看对方手里有什么
  assert.match(DM_RULES_V2, /不用战斗工具，一两次 roll_opposed/);
  assert.match(DM_RULES_V2, /空手轻，刀棍中，枪和要命的狠招重/);
  // 给 NPC 治伤：没有生命值，记在 update_npc 上
  assert.match(DM_RULES_V2, /给 NPC 包扎、治伤也一样（该检定照样检定），heal 只给角色用/);
  assert.match(DM_RULES, /被绑住、被治好，用 update_npc 记在他身上/);
  // 恢复给了数：生命值和精神值都有
  assert.match(DM_RULES_V2, /包扎（通常要检定）回 2～4 点生命值，好好休息一阵 4～8/);
  assert.match(DM_RULES_V2, /歇口气、被人安抚回 1～3 点精神值，踏踏实实睡一觉 4～8/);
});

test('V0.7.1 工具说明：heal 的精神值给了数，update_npc 能记受伤和被制住', () => {
  const scenario = loadScenarioFile('scenarios/dungeon-abandoned-mine.json');
  const heal = dmTools2(scenario).find((t) => t.name === 'heal');
  assert.ok(heal);
  const props = (heal.input_schema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props.mp.description ?? '', /歇口气、被人安抚一般 1～3，踏踏实实睡一觉 4～8/);
  assert.match(props.hp.description ?? '', /包扎一般 2～4，好好休息一阵 4～8/);
  const npc = DM_TOOLS.find((t) => t.name === 'update_npc');
  assert.ok(npc);
  assert.match(npc.description, /受了伤、被制住/);
  // 第二版也用同一个 update_npc
  assert.ok(dmTools2(scenario).some((t) => t.name === 'update_npc' && /受了伤、被制住/.test(t.description)));
});
