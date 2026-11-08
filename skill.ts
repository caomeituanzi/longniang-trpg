import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { SRD_ATTRIBUTION } from '../shared/5e/core';
import { ITEM_INDEX } from '../shared/5e/item-index';
import { MONSTER_INDEX } from '../shared/5e/monster-index';
import { CR_LABEL } from '../shared/5e/types';
import { config } from './config';
import { APP_VERSION } from './version';
import { zip, type ZipEntry } from './zip';

// 写剧本 skill（V0.8.3）：剧本编辑器里下载的 zip。玩家交给自己的 AI（Claude 等支持 skill 的工具），
// 让它按龙娘跑团的格式写新剧本，或者把现成的文字剧本转过来，写好的 .json 在编辑器里导入。zip 里是：
//   longniang-scenario-writer/SKILL.md               说明（skill/longniang-scenario-writer/SKILL.md）
//   longniang-scenario-writer/使用说明.txt             给人看的
//   longniang-scenario-writer/references/example.json 一份很短的原创示例剧本（编辑器的「打开示例」，不剧透自带的剧本）
//   longniang-scenario-writer/scripts/check.mjs       检查剧本的脚本（skill/check.ts 打包出来，node 18 以上直接运行）
//   longniang-scenario-writer/references/5e-monsters.md、5e-items.md  5E 模组用的 SRD 怪物表、物品表（V0.9.0，从索引生成）
// 文字里的 {{APP_VERSION}} 换成现在的版本号。第一次下载时打包，之后用内存里的。

export const SKILL_NAME = 'longniang-scenario-writer';
export const SKILL_ZIP_NAME = `${SKILL_NAME}.zip`;

const SKILL_DIR = path.join(config.root, 'skill', SKILL_NAME);
const CHECK_ENTRY = path.join(config.root, 'skill', 'check.ts');
const EXAMPLE = path.join(config.root, 'server', 'editor-example.json');

/** 说明文字里的 {{APP_VERSION}} 换成现在的版本号。 */
export function skillText(file: string): string {
  return fs.readFileSync(path.join(SKILL_DIR, file), 'utf8').replaceAll('{{APP_VERSION}}', APP_VERSION);
}

/** 把检查脚本打包成一个文件（不依赖别的包）。 */
export async function bundleCheckScript(): Promise<string> {
  const result = await esbuild.build({
    absWorkingDir: config.root,
    entryPoints: [CHECK_ENTRY],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: ['node18'],
    legalComments: 'none',
    // 中文原样写，打开脚本也看得懂
    charset: 'utf8',
    logLevel: 'silent',
    banner: { js: `// 龙娘跑团 V${APP_VERSION} 的剧本检查（写剧本 skill）。用法：node check.mjs 剧本.json` },
  });
  return result.outputFiles[0].text;
}

/** 5E 模组的怪物表（V0.9.0）：monsters 里写 "monster": key 时从这里挑。按挑战等级从低到高排。 */
export function monsterReference(): string {
  const rows = [...MONSTER_INDEX].sort((a, b) => a.cr - b.cr || a.key.localeCompare(b.key));
  return [
    '# SRD 怪物表',
    '',
    '5E 模组的 `monsters` 里写 `"monster": key` 时，key 从这张表里选（大小写、短横线都要一样）。按挑战等级从低到高排；挑战等级怎么配，见 SKILL.md 的「5E 模组」。',
    '',
    '| key | 名字 | 挑战等级 | 类型 |',
    '|---|---|---|---|',
    ...rows.map((m) => `| \`${m.key}\` | ${m.name} | ${CR_LABEL(m.cr)} | ${m.type} |`),
    '',
    `龙娘跑团 V${APP_VERSION}。怪物的数据译自 SRD 5.2.1：`,
    '',
    SRD_ATTRIBUTION,
    '',
  ].join('\n');
}

const ITEM_KIND_TITLE: Record<(typeof ITEM_INDEX)[number]['kind'], string> = {
  weapon: '武器（key 后面加 +1、+2、+3 是魔法武器，`longsword+1` 这样）',
  armor: '护甲和盾牌（key 后面加 +1、+2、+3 是魔法护甲、盾牌，`chain-mail+1`、`shield+1` 这样）',
  gear: '冒险装备、工具（`potion-of-healing` 治疗药水也在这里）',
  magic: '魔法物品',
};

/** 5E 模组的物品表（V0.9.0）：treasure 的 items 里写的 key 从这里挑。 */
export function itemReference(): string {
  const lines = ['# SRD 物品表', '', '5E 模组的 `treasure` 里，每件物品的 `item` 写这张表里的 key（大小写、短横线都要一样）。'];
  for (const kind of ['weapon', 'armor', 'gear', 'magic'] as const) {
    lines.push('', `## ${ITEM_KIND_TITLE[kind]}`, '', '| key | 名字 |', '|---|---|');
    for (const i of ITEM_INDEX.filter((x) => x.kind === kind)) lines.push(`| \`${i.key}\` | ${i.name} |`);
  }
  lines.push('', `龙娘跑团 V${APP_VERSION}。物品的数据译自 SRD 5.2.1：`, '', SRD_ATTRIBUTION, '');
  return lines.join('\n');
}

export async function skillEntries(): Promise<ZipEntry[]> {
  return [
    { name: `${SKILL_NAME}/SKILL.md`, data: skillText('SKILL.md') },
    { name: `${SKILL_NAME}/使用说明.txt`, data: skillText('使用说明.txt') },
    { name: `${SKILL_NAME}/references/example.json`, data: fs.readFileSync(EXAMPLE) },
    { name: `${SKILL_NAME}/references/5e-monsters.md`, data: monsterReference() },
    { name: `${SKILL_NAME}/references/5e-items.md`, data: itemReference() },
    { name: `${SKILL_NAME}/scripts/check.mjs`, data: await bundleCheckScript() },
  ];
}

let cached: Promise<Buffer> | null = null;

/** 下载用的 zip（打包一次，之后用内存里的；打包失败下次再试）。 */
export function scenarioSkillZip(): Promise<Buffer> {
  cached ??= skillEntries()
    .then((entries) => zip(entries))
    .catch((err: unknown) => {
      cached = null;
      throw err;
    });
  return cached;
}
