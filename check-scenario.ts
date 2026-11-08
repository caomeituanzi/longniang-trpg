import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_NAME } from '../shared/game';
import { RELATION_LABEL, validateScenario } from './game/scenario';
import { SIZE_LABEL } from '../shared/rules2';

// 检查一个剧本文件：npm run check-scenario -- scenarios/qingxi-lantern-night.json

const file = process.argv[2];
if (!file) {
  console.log('\n用法：npm run check-scenario -- 剧本文件.json\n');
  process.exit(1);
}

let data: unknown;
try {
  // 去掉 Windows 记事本可能加在文件开头的 BOM
  data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, ''));
} catch (err) {
  console.error(`\n读不了这个文件：${(err as Error).message}\n`);
  process.exit(1);
}

const { scenario, errors, warnings } = validateScenario(data);

if (errors.length) {
  console.log(`\n有 ${errors.length} 个错误，这个剧本还不能用：`);
  for (const e of errors) console.log(`  - ${e}`);
}
if (warnings.length) {
  console.log(`\n${warnings.length} 个提醒（不影响使用，但最好看一下）：`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (scenario) {
  console.log(
    `\n《${scenario.title}》通过检查：${scenario.category ? `${CATEGORY_NAME[scenario.category]}分区，` : '没写分区，'}${scenario.genre}，${scenario.players.min}～${scenario.players.max}人，` +
      `预计${scenario.expectedDays}天，${RELATION_LABEL[scenario.relation]}；` +
      `${scenario.locations.length}个地点、${scenario.clues.length}条线索、${scenario.npcs.length}个NPC、${scenario.endings.length}个结局。`,
  );
  if (scenario.rules === '5e') {
    console.log(`5E 模组：建议 ${scenario.level ?? 1} 级；${scenario.monsters?.length ?? 0}种怪物（${(scenario.monsters ?? []).filter((m) => m.stats).length}种自己写的数据块）、${scenario.treasure?.length ?? 0}处宝藏。`);
  }
  const d = scenario.dungeon;
  if (d) {
    console.log(
      `地下城：难度 ${d.level}，${SIZE_LABEL[d.size]}；${d.enemies.length}种敌人、${d.encounters.length}拨遇敌、${d.loot.length}处宝物、` +
        `${d.variants.length}种真相、首领有${d.boss.weaknesses.length}种弱点${d.boss.shield ? '、有护盾' : ''}。`,
    );
  }
}
console.log('');
process.exitCode = errors.length ? 1 : 0;
