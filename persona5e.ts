// AI 角色带的 5E 角色卡：和「我的角色 → 5E 角色」里做卡用的是同一套格式和检查。
// 存的时候只存卡上的选择、外貌和背景故事；名字用 AI 角色的名字，等级固定 1 级（AI 角色不升级）。
import { CARD2_APPEARANCE_MAX, CARD2_BACKGROUND_MAX } from '../shared/rules2';
import type { Persona5e, Persona5eSummary } from '../shared/personas';
import { autoEquip, cardProblems, computeSheet, startingInventory } from '../shared/5e/sheet';
import type { Card5eData } from '../shared/5e/types';
import { readCard5e, readCard5eLevel } from './cards5e';
import { rules5e } from './5e/rules-data';
import { HttpError } from './http';

function cleanText(v: unknown, max: number, label: string): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if ([...t].length > max) throw new HttpError(400, `${label}最多${max}个字`);
  return t;
}

/** 网页交来的 5E 角色卡：{ data, appearance, background }。选得不对、没做完的报出来。 */
export function parsePersona5e(raw: unknown): Persona5e {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '5E 角色卡的格式不对');
  const o = raw as Record<string, unknown>;
  const appearance = cleanText(o.appearance, CARD2_APPEARANCE_MAX, '外貌');
  const background = cleanText(o.background, CARD2_BACKGROUND_MAX, '背景故事');
  const input = readCard5e(o.data);
  const level = readCard5eLevel(o.data);
  const rules = rules5e();
  const { inventory, money } = startingInventory(input, rules);
  const data: Card5eData = {
    ...input,
    level,
    earned: 0,
    inventory,
    money,
    equipped: input.equipped ?? { armor: null, shield: null, main: null, off: null },
  };
  if (!input.equipped) data.equipped = autoEquip(data, rules);
  const problems = cardProblems(data, rules);
  if (problems.length) {
    throw new HttpError(400, `5E 角色卡还有${problems.length}处要改：${problems.slice(0, 5).join('；')}${problems.length > 5 ? '……' : ''}`);
  }
  return { data, appearance, background };
}

/** 数据库、请进对局时存下的样子里读出来的卡：坏了的当成没有。 */
export function readStoredPersona5e(raw: unknown): Persona5e | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!o.data || typeof o.data !== 'object' || Array.isArray(o.data)) return null;
  const data = o.data as Card5eData;
  if (data.v !== 1 || typeof data.class !== 'string' || !Array.isArray(data.inventory) || typeof data.equipped !== 'object' || !data.equipped) return null;
  return {
    data,
    appearance: typeof o.appearance === 'string' ? o.appearance : '',
    background: typeof o.background === 'string' ? o.background : '',
  };
}

/** 大厅卡片上的一句话。卡坏了抛错，调用的人当成没有。 */
export function persona5eSummary(card: Persona5e): Persona5eSummary {
  const sheet = computeSheet(card.data, rules5e());
  return {
    speciesName: sheet.speciesName,
    className: sheet.className,
    subclassName: sheet.subclassName,
    level: sheet.level,
    hpMax: sheet.hpMax,
    ac: sheet.ac,
    line: `${sheet.speciesName}${sheet.className} ${sheet.level} 级 · HP ${sheet.hpMax} · AC ${sheet.ac}`,
  };
}
