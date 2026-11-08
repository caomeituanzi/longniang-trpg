import { readFileSync } from 'node:fs';
import { checkScenarioText } from './check-lib';

// 写剧本 skill 里的检查脚本（V0.8.3）。下载 skill 时由 server/skill.ts 用 esbuild 打包成 scripts/check.mjs，
// 不用装别的东西，Node.js 18 以上就能运行：
//   node scripts/check.mjs 剧本.json
// 退出码：0 没有错误；1 有错误（导入不了）；2 用法不对、读不了文件。

function main(argv: string[]): number {
  const file = argv[0];
  if (!file) {
    console.log('用法：node check.mjs 剧本.json');
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.log(`读不了这个文件：${file}`);
    return 2;
  }
  const result = checkScenarioText(text);
  console.log(result.lines.join('\n'));
  return result.code;
}

process.exitCode = main(process.argv.slice(2));
