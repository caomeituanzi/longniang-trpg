import fs from 'node:fs';
import path from 'node:path';
import { audit } from './audit';
import { backupDir, stamp } from './backup';
import type { DB } from './db';
import { hiddenScenarios, setScenarioHidden } from './game/scenario-library';
import { getSetting, setSetting } from './settings';

// V1.0.0 正式版的删档（数据库第 23 版的升级做的，见 db.ts）：数据库里内测的数据升级时已经清掉了，这里做剩下的两件事：
// 投稿通过的剧本文件（scenarios 里的 sub-*.json，作者的账号都没了）挪进备份文件夹；记一笔操作记录（网站自动）。
// 服务器启动时、start.bat 建站长账号之前都会调用，只做一次（beta_wipe 里的 pending 记着还没做）。

export const BETA_WIPE_SETTING = 'beta_wipe';

export type BetaWipe = {
  users: number;
  guests: number;
  rooms: number;
  announcements: number;
  submissions: number;
  at: number;
  /** 还没把投稿通过的剧本文件挪走。 */
  pending?: number;
  /** 挪走的剧本文件放在哪（没有要挪的是 null）。 */
  movedTo?: string | null;
  moved?: string[];
};

export function betaWipeOf(db: DB): BetaWipe | null {
  try {
    const raw = getSetting(db, BETA_WIPE_SETTING);
    return raw ? (JSON.parse(raw) as BetaWipe) : null;
  } catch {
    return null;
  }
}

/** 投稿通过的剧本存成的文件：sub-编号.json（同名的时候是 sub-编号-2.json）。 */
const SUBMISSION_FILE = /^sub-\d+(-\d+)?\.json$/;

/**
 * 删档的收尾：还没做的话，把投稿通过的剧本文件挪进备份文件夹（backups/v1-wipe-时间/scenarios），记一笔操作记录。
 * 这次做了返回这次删档的情况（启动窗口里说一声）；早就做过、没删档的数据（全新的网站）返回 null。
 * 挪文件出错不抛出：写进 problems，剧本留在原地照样能用。
 */
export function finishBetaWipe(db: DB, opts: { scenarioDir: string; dbPath: string; now?: number }): (BetaWipe & { problems: string[] }) | null {
  const wipe = betaWipeOf(db);
  if (!wipe?.pending) return null;
  const at = opts.now ?? Date.now();
  const problems: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(opts.scenarioDir).filter((f) => SUBMISSION_FILE.test(f)).sort();
  } catch {
    files = [];
  }
  let movedTo: string | null = null;
  const moved: string[] = [];
  if (files.length) {
    const base = opts.dbPath === ':memory:' ? path.join(opts.scenarioDir, '..', 'backups') : backupDir(opts.dbPath);
    let target = path.join(base, `v1-wipe-${stamp(new Date(at))}`);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(base, `v1-wipe-${stamp(new Date(at))}-${i}`);
    try {
      fs.mkdirSync(path.join(target, 'scenarios'), { recursive: true });
      movedTo = target;
    } catch (err) {
      problems.push(`没能建备份文件夹 ${target}（${err instanceof Error ? err.message : err}），投稿通过的剧本文件都没有挪`);
    }
    if (movedTo) {
      const hidden = hiddenScenarios(db);
      for (const file of files) {
        try {
          fs.copyFileSync(path.join(opts.scenarioDir, file), path.join(movedTo, 'scenarios', file));
          fs.rmSync(path.join(opts.scenarioDir, file));
          moved.push(file);
          // 下架的记录跟着文件走：以后再放进一个同名的剧本，不会一上来就是下架的
          const key = path.basename(file, '.json');
          if (hidden.has(key)) setScenarioHidden(db, key, false);
        } catch (err) {
          problems.push(`没能挪走 ${file}（${err instanceof Error ? err.message : err}）：它还在 scenarios 文件夹里，剧本大厅里还看得到，不要的话关掉服务器以后手动删掉`);
        }
      }
    }
  }
  const done: BetaWipe = { ...wipe, pending: 0, movedTo, moved };
  delete done.pending;
  setSetting(db, BETA_WIPE_SETTING, JSON.stringify(done));
  audit(
    db,
    null,
    '正式版删档',
    `升级到 V1.0.0 时清掉了内测的数据：${wipe.users} 个账号、${wipe.rooms} 局对局、${wipe.announcements} 条公告、${wipe.submissions} 份投稿${moved.length ? `；投稿通过的剧本文件 ${moved.length} 个挪进了 ${movedTo}` : ''}`,
    at,
  );
  return { ...done, problems };
}

/** 启动窗口里说一声删档的情况（finishBetaWipe 这次做了的时候）。 */
export function betaWipeLines(w: BetaWipe & { problems: string[] }): string[] {
  const lines = [
    `V1.0.0 正式版：内测的数据已经清空了（${w.users} 个账号、${w.rooms} 局对局、${w.announcements} 条公告、${w.submissions} 份投稿，还有聊天、通知、角色卡、宠物、评分和排行这些）。`,
    '  网站的设置（AI 模型和开关、商城、注册方式）、限时活动留着；清空前的整个数据库在 backups 文件夹里「升级前自动备份」的那一份。',
  ];
  if (w.moved?.length) lines.push(`  投稿通过的剧本文件挪进了：${w.movedTo}`);
  for (const p of w.problems) lines.push(`  注意：${p}`);
  return lines;
}
