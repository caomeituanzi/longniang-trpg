import fs from 'node:fs';
import path from 'node:path';

// 版本号和作者写在 package.json 里（发布新版本时只改那里）。网页底部、启动窗口、管理页都从这里读。
const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
  author?: string;
};

export const APP_VERSION: string = pkg.version;
export const APP_AUTHOR: string = pkg.author ?? '';

/** 给人看的版本号，比如 V0.3.0。 */
export function versionLabel(version: string = APP_VERSION): string {
  return `V${version}`;
}
