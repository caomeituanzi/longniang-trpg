import { strictIssues, validateScenario } from '../server/game/scenario';

// 写剧本 skill 的检查（V0.8.3）：scripts/check.mjs 用（skill/check.ts 打包出来的），测试也直接用这里。
// 检查和网站导入剧本时完全一样（错误必须改、提醒建议改），再加上 AI 写的剧本要做到的更严的几条。

/** 网站收剧本的请求最多这么大（和 server/routes/game.ts 的 SCENARIO_BODY_LIMIT 一样，测试里核对）。 */
export const SKILL_BODY_LIMIT = 400 * 1024;

export type SkillCheck = {
  /** 0 没有错误；1 有错误（导入不了）；2 用法不对、读不了文件（这里不会出现，check.ts 用）。 */
  code: 0 | 1;
  errors: string[];
  warnings: string[];
  strict: string[];
  /** 篇幅建议（写新剧本时照着来；转换来的剧本照原作）：不影响导入。 */
  advice: string[];
  /** 打印出来的结果，一行一项。 */
  lines: string[];
};

/** 写新剧本时的篇幅（和网站让 AI 生成剧本时的要求一样）：[最少, 最多]。 */
export const SKILL_SIZES = {
  intro: [60, 150],
  points: [3, 6],
  locations: [5, 10],
  npcs: [3, 8],
  timeline: [4, 8],
  endings: [2, 4],
} as const;

/** 篇幅建议：简介的字数，真相要点、地点、NPC、时间线、结局的个数。 */
export function adviceIssues(data: unknown): string[] {
  const s = (data ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const range = (what: string, n: number, [min, max]: readonly [number, number], unit: string) => {
    if (n < min || n > max) out.push(`${what}建议 ${min}～${max} ${unit}，现在是 ${n} ${unit}`);
  };
  if (typeof s.intro === 'string' && s.intro.trim()) range('简介（intro）', [...s.intro.trim()].length, SKILL_SIZES.intro, '字');
  const truth = (s.truth ?? {}) as { points?: unknown };
  range('真相要点（truth.points）', count(truth.points), SKILL_SIZES.points, '条');
  range('地点（locations）', count(s.locations), SKILL_SIZES.locations, '个');
  range('NPC（npcs）', count(s.npcs), SKILL_SIZES.npcs, '个');
  range('时间线（timeline）', count(s.timeline), SKILL_SIZES.timeline, '条');
  range('结局（endings）', count(s.endings), SKILL_SIZES.endings, '个');
  return out;
}

/**
 * 找出 JSON 第一个写错的地方（第几个字符），没错返回 -1。JSON.parse 报错时用：
 * 新版 Node 的报错有时不说位置，这里按 JSON 的写法自己走一遍。
 */
export function jsonErrorAt(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const string = () => {
    i++;
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\\') {
        const n = text[i + 1] ?? '';
        if (n === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if (n && '"\\/bfnrt'.includes(n)) i += 2;
        else fail();
        continue;
      }
      // 字符串里不能直接换行（要写成 \n）
      if (c < ' ') fail();
      i++;
    }
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') return string();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (number) {
      i += number[0].length;
      return;
    }
    fail();
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (pos) {
    return typeof pos === 'number' ? pos : -1;
  }
}

/** JSON 写错时：第几行第几列，和那一行的内容。 */
function where(text: string, message: string): string[] {
  let pos = jsonErrorAt(text);
  if (pos < 0) {
    const m = /position (\d+)/.exec(message);
    if (!m) return [];
    pos = Number(m[1]);
  }
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const start = before.lastIndexOf('\n') + 1;
  const column = pos - start + 1;
  const end = text.indexOf('\n', pos);
  const content = text.slice(start, end < 0 ? undefined : end).replace(/\r$/, '');
  return [`第 ${line} 行第 ${column} 列：`, `  ${[...content].slice(0, 120).join('')}`];
}

function numbered(title: string, items: string[]): string[] {
  return items.length ? [title, ...items.map((x, i) => `  ${i + 1}. ${x}`)] : [];
}

/** 检查一份剧本文件的文字。 */
export function checkScenarioText(raw: string): SkillCheck {
  const text = raw.replace(/^\uFEFF/, '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = where(text, message);
    const error = `不是合法的 JSON${at.length ? `，${at[0].replace(/：$/, '')}附近有问题` : ''}`;
    return {
      code: 1,
      errors: [error],
      warnings: [],
      strict: [],
      advice: [],
      lines: [
        '不是合法的 JSON。',
        ...at,
        `（${message.replace(/\s+/g, ' ')}）`,
        '常见原因：结尾多了逗号、少了逗号或引号、用了中文引号“”当 JSON 的引号、写了注释、字符串里直接换了行。',
      ],
    };
  }
  const { errors, warnings: allWarnings } = validateScenario(data);
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > SKILL_BODY_LIMIT - 1024) {
    errors.push(`剧本太长了：网站一次最多收 ${Math.floor(SKILL_BODY_LIMIT / 1024)}KB，删掉一些内容再试`);
  }
  const strict = strictIssues(data);
  // 一条真相只有一条线索时，网站的提醒说「再加一条」，更严的要求说「至少 3 条」：只留更严的那一条，免得两种说法打架
  const strictPoints = new Set(strict.map((x) => /^truth\.points「([^」]+)」/.exec(x)?.[1]).filter(Boolean));
  const warnings = allWarnings.filter((w) => {
    const point = /^truth\.points「([^」]+)」：只有一条线索/.exec(w)?.[1];
    return !point || !strictPoints.has(point);
  });
  const advice = adviceIssues(data);
  const title = typeof (data as { title?: unknown } | null)?.title === 'string' ? `《${(data as { title: string }).title}》` : '';
  const lines = [
    `剧本${title}`,
    ...numbered('错误（必须改，有错误网站导入不了）：', errors),
    ...numbered('提醒（建议改）：', warnings),
    ...numbered('更严的要求（AI 写的剧本也要做到）：', strict),
    ...numbered('篇幅建议（写新剧本时照着来；转换来的剧本照原作，不用硬凑）：', advice),
    errors.length
      ? `结果：有 ${errors.length} 个错误，导入不了。`
      : warnings.length || strict.length
        ? `结果：没有错误，能导入；还有 ${warnings.length + strict.length} 条提醒和更严的要求，最好也改掉。`
        : advice.length
          ? `结果：全部通过（篇幅建议 ${advice.length} 条，看情况改）。`
          : '结果：全部通过。',
  ];
  return { code: errors.length ? 1 : 0, errors, warnings, strict, advice, lines };
}
