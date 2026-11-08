import os from 'node:os';
import type { AiClient } from './ai/client';
import { schemaVersion, type DB } from './db';
import { HttpError } from './http';
import { APP_VERSION, versionLabel } from './version';
import { zip } from './zip';

// 整局排查包（V0.6.0）：管理员（「管理所有对局」权限）把一局的全部情况打成一个 zip，出了问题拿去排查。
//   说明.txt  —— 包里有什么、注意事项
//   诊断.txt  —— 程序自动查一遍：卡住的行动、AI 报错和拒绝、被截断、违规、花费、对局状态
//   时间线.txt —— 叙述、行动、掷骰、AI 调用、违规、管理操作按时间排好
//   数据.json —— 原始数据：对局、剧本、成员、角色、行动、掷骰、记录、线索、撤回快照、AI 调用……
// 不带：密码、登录记录、登录地点、设备、邀请码、发给 AI 服务商的匿名编号；玩家的笔记只带有没有、多长，不带内容。
// 带着这一局的私密内容（身份秘密、悄悄话、只发给某个人的叙述），只给需要排查的人。

type Row = Record<string, unknown>;

/** 行动卡住多久算不正常：在结算的超过这么久、到点了还没结算超过这么久。 */
const STUCK_MS = 10 * 60_000;
/** AI 调用超过这么久算慢。 */
const SLOW_CALL_MS = 120_000;

function parseJsonFields(row: Row, fields: string[]): Row {
  const out: Row = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v) {
      try {
        out[f] = JSON.parse(v);
      } catch {
        // 不是 JSON 就原样留着
      }
    }
  }
  return out;
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

/** 本地时间（服务器的钟）：2026-10-27 06:59:12。 */
export function stamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clip(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : text === null || text === undefined ? '' : JSON.stringify(text);
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}……` : chars.join('');
}

function money(n: number) {
  return `$${n.toFixed(4)}`;
}

/** 工具名字连起来写，连着几个一样的写成「名字×几」：attack、monster_action×3。 */
export function countedNames(names: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < names.length; ) {
    let j = i;
    while (j < names.length && names[j] === names[i]) j++;
    out.push(j - i > 1 ? `${names[i]}×${j - i}` : names[i]);
    i = j;
  }
  return out.join('、');
}

export type DebugPackage = { filename: string; data: Buffer; summary: string };

export function buildDebugPackage(db: DB, ai: AiClient, roomId: number, exporter: { id: number; name: string }, now: number): DebugPackage {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as Row | undefined;
  if (!room) throw new HttpError(404, '对局不存在');
  const all = (sql: string, ...args: (number | string)[]) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: (number | string)[]) => db.prepare(sql).get(...args) as Row | undefined;

  // ---------- 原始数据 ----------
  const scenarioRow = one('SELECT * FROM scenarios WHERE room_id = ?', roomId);
  const players = all(
    `SELECT p.*, u.uid, u.username, u.display_name, u.public_id, u.is_admin, u.is_owner, u.is_guest, u.banned_at, u.deleted_at
     FROM players p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? ORDER BY p.id`,
    roomId,
  );
  const characters = all('SELECT * FROM characters WHERE room_id = ? ORDER BY id', roomId).map((r) =>
    parseJsonFields(r, ['attributes', 'specialties', 'conditions', 'items', 'visited', 'pet', 'gear']),
  );
  const actions = all('SELECT * FROM actions WHERE room_id = ? ORDER BY id', roomId).map((r) => parseJsonFields(r, ['result']));
  const rolls = all('SELECT * FROM rolls WHERE room_id = ? ORDER BY id', roomId).map((r) => parseJsonFields(r, ['detail']));
  const log = all('SELECT * FROM log_entries WHERE room_id = ? ORDER BY id', roomId).map((r) => parseJsonFields(r, ['data']));
  const clues = all('SELECT * FROM clues WHERE room_id = ? ORDER BY id', roomId);
  const knowledge = all('SELECT * FROM knowledge WHERE room_id = ? ORDER BY id', roomId);
  // 玩家的笔记：只带有没有、多长、分享给谁（内容连主持 AI 都看不到）
  const notes = all('SELECT * FROM notes WHERE room_id = ? ORDER BY id', roomId).map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'text' || k === 'content' || k === 'body') out[`${k}_length`] = typeof v === 'string' ? [...v].length : 0;
      else out[k] = v;
    }
    return out;
  });
  const snapshots = all('SELECT * FROM resolution_snapshots WHERE room_id = ? ORDER BY id', roomId).map((r) => parseJsonFields(r, ['state']));
  const aiCalls = all('SELECT * FROM ai_calls WHERE room_id = ? ORDER BY id', roomId);
  const shares = all(
    'SELECT s.* FROM ai_call_shares s JOIN ai_calls c ON c.id = s.call_id WHERE c.room_id = ? ORDER BY s.call_id, s.user_id',
    roomId,
  );
  const jobs = all('SELECT * FROM scenario_jobs WHERE room_id = ? ORDER BY id', roomId).map((r) => parseJsonFields(r, ['input', 'notes']));
  const violations = all('SELECT * FROM violations WHERE room_id = ? ORDER BY id', roomId);
  const joinRequests = all('SELECT * FROM join_requests WHERE room_id = ?', roomId);
  const invites = all('SELECT * FROM room_invites WHERE room_id = ? ORDER BY created_at', roomId);
  const roomRe = new RegExp(`对局 ${roomId}(?!\\d)`);
  const audits = all("SELECT a.*, u.display_name AS admin_name FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id WHERE a.detail LIKE ? ORDER BY a.id", `%对局 ${roomId}%`).filter(
    (a) => roomRe.test(String(a.detail)),
  );
  const reportRe = new RegExp(`"roomId":${roomId}(?!\\d)|/room/${roomId}(?!\\d)`);
  const reports = all("SELECT * FROM reports WHERE target LIKE ? OR context LIKE ? ORDER BY id", `%${roomId}%`, `%${roomId}%`)
    .filter((r) => reportRe.test(`${r.target ?? ''} ${r.context ?? ''}`))
    .map((r) => parseJsonFields(r, ['target', 'context']));
  const growth = all('SELECT * FROM pet_growth WHERE room_id = ? ORDER BY id', roomId);
  const diary = all('SELECT id, user_id, kind, title, status, room_created_at, created_at, length(text) AS text_length FROM pet_diary WHERE room_id = ? ORDER BY id', roomId);
  // V0.8.0：交给 AI 演的身份；约团（候选时间和谁勾了什么）
  const aiSeats = all('SELECT * FROM ai_seats WHERE room_id = ? ORDER BY created_at', roomId);
  const schedules = all('SELECT * FROM schedule_polls WHERE room_id = ? ORDER BY id', roomId);
  const scheduleSlots = all('SELECT s.* FROM schedule_slots s JOIN schedule_polls p ON p.id = s.poll_id WHERE p.room_id = ? ORDER BY s.id', roomId);
  const scheduleVotes = all(
    'SELECT v.* FROM schedule_votes v JOIN schedule_slots s ON s.id = v.slot_id JOIN schedule_polls p ON p.id = s.poll_id WHERE p.room_id = ? ORDER BY v.slot_id, v.user_id',
    roomId,
  );

  const roomParsed = parseJsonFields(room, ['world', 'style']);
  const scenarioParsed = scenarioRow ? parseJsonFields(scenarioRow, ['data']) : null;
  const scenarioData = (scenarioParsed?.data ?? null) as { title?: string; roles?: { key: string; name: string }[] } | null;

  const nameOfUser = new Map(players.map((p) => [Number(p.user_id), String(p.display_name)]));
  const nameOfCharacter = new Map(characters.map((c) => [Number(c.id), String(c.name)]));
  const who = (userId: unknown) => (userId === null || userId === undefined ? '—' : (nameOfUser.get(Number(userId)) ?? `账号 ${userId}`));

  // ---------- 诊断 ----------
  const findings: string[] = [];
  const warn = (text: string) => findings.push(`✖ ${text}`);
  const note = (text: string) => findings.push(`· ${text}`);

  const status = String(room.status);
  const stuckResolving = actions.filter((a) => a.status === 'resolving' && now - Number(a.submitted_at) > STUCK_MS);
  const overdue = actions.filter(
    (a) => a.status === 'waiting' && a.due_at !== null && Number(a.due_at) + STUCK_MS < now && status === 'running' && !room.paused_at && !room.frozen_at,
  );
  const failed = actions.filter((a) => a.status === 'failed');
  const retried = actions.filter((a) => Number(a.attempts) > 1);
  const refusedActions = actions.filter((a) => Number(a.refused) === 1);
  const callErrors = aiCalls.filter((c) => c.error);
  const refusals = aiCalls.filter((c) => c.stop_reason === 'refusal');
  const truncated = aiCalls.filter((c) => c.stop_reason === 'max_tokens');
  const slow = aiCalls.filter((c) => Number(c.duration_ms) > SLOW_CALL_MS);
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const totalCost = aiCalls.reduce((n, c) => n + Number(c.cost_usd || 0), 0);

  if (stuckResolving.length) warn(`有 ${stuckResolving.length} 个行动结算了超过 ${STUCK_MS / 60_000} 分钟还没好：${stuckResolving.map((a) => `#${a.id}`).join('、')}`);
  if (overdue.length) warn(`有 ${overdue.length} 个计时行动到点 ${STUCK_MS / 60_000} 分钟以后还没结算：${overdue.map((a) => `#${a.id}（到点 ${stamp(Number(a.due_at))}）`).join('、')}`);
  if (failed.length) warn(`有 ${failed.length} 个行动结算失败：${failed.map((a) => `#${a.id}（${clip(a.last_error, 80) || '没有记下原因'}）`).join('；')}`);
  if (refusedActions.length) warn(`有 ${refusedActions.length} 个行动被 AI 拒绝：${refusedActions.map((a) => `#${a.id}`).join('、')}`);
  if (callErrors.length) {
    warn(`AI 调用出错 ${callErrors.length} 次，最近几次：`);
    for (const c of callErrors.slice(-5)) findings.push(`    ${stamp(Number(c.created_at))} ${c.purpose} ${c.model}：${clip(c.error, 160)}`);
  }
  if (refusals.length) warn(`AI 拒绝回答 ${refusals.length} 次（stop_reason = refusal）：${refusals.map((c) => `调用 #${c.id}（${c.purpose}）`).join('、')}`);
  if (truncated.length) warn(`AI 的回复写到上限被截断 ${truncated.length} 次：${truncated.map((c) => `调用 #${c.id}（${c.purpose}）`).join('、')}`);
  if (slow.length) warn(`AI 调用超过 ${SLOW_CALL_MS / 1000} 秒的有 ${slow.length} 次，最慢 ${Math.round(Math.max(...slow.map((c) => Number(c.duration_ms))) / 1000)} 秒`);
  if (failedJobs.length) warn(`生成、转换剧本失败 ${failedJobs.length} 次：${failedJobs.map((j) => clip(j.error, 100)).join('；')}`);
  if (violations.length) warn(`这一局有 ${violations.length} 条违规记录（见时间线和数据里的 violations）`);
  if (retried.length) note(`有 ${retried.length} 个行动重试过结算：${retried.map((a) => `#${a.id}（${a.attempts} 次）`).join('、')}`);
  // V0.9.1：工具调用到了上限，最后单独让主持 AI 写的叙述（结果里的 notes）
  const wrappedUp = actions.filter((a) => {
    const notes = (a.result as { notes?: unknown } | null)?.notes;
    return Array.isArray(notes) && notes.length > 0;
  });
  if (wrappedUp.length) note(`有 ${wrappedUp.length} 个行动的工具调用到了上限，最后单独让主持 AI 照工具结果写的叙述：${wrappedUp.map((a) => `#${a.id}`).join('、')}`);
  if (room.frozen_at) warn(`对局从 ${stamp(Number(room.frozen_at))} 起被冻结（有成员被封号）`);
  if (room.paused_at) note(`对局从 ${stamp(Number(room.paused_at))} 起暂停着`);
  if (!scenarioRow && status !== 'preparing') warn('对局不在准备阶段，却没有剧本');
  const dead = characters.filter((c) => Number(c.dead) === 1);
  if (dead.length) note(`死了的角色：${dead.map((c) => c.name).join('、')}`);
  const waiting = actions.filter((a) => a.status === 'waiting');
  if (waiting.length) note(`在等结算的行动：${waiting.map((a) => `#${a.id}（${nameOfCharacter.get(Number(a.character_id)) ?? a.character_id}）`).join('、')}`);
  if (!findings.some((f) => f.startsWith('✖'))) findings.unshift('✔ 没查出明显的问题');

  const byPurpose = new Map<string, { n: number; cost: number }>();
  for (const c of aiCalls) {
    const k = `${c.purpose}（${c.model}）`;
    const e = byPurpose.get(k) ?? { n: 0, cost: 0 };
    e.n += 1;
    e.cost += Number(c.cost_usd || 0);
    byPurpose.set(k, e);
  }
  const byUser = new Map<string, number>();
  for (const s of shares) byUser.set(who(s.user_id), (byUser.get(who(s.user_id)) ?? 0) + Number(s.cost_usd || 0));
  const lastActivity = Math.max(
    Number(room.created_at),
    ...log.map((l) => Number(l.created_at)),
    ...actions.map((a) => Number(a.resolved_at ?? a.submitted_at)),
    ...aiCalls.map((c) => Number(c.created_at)),
  );

  const diagnosis = [
    `整局排查包：对局 ${roomId}「${room.name}」`,
    `导出时间：${stamp(now)}　导出的人：${exporter.name}　版本：${versionLabel()}（数据库第 ${schemaVersion(db)} 版）`,
    '',
    '# 概况',
    `状态：${status}${room.paused_at ? '（暂停）' : ''}${room.frozen_at ? '（冻结）' : ''}　建立：${stamp(Number(room.created_at))}　最后动静：${stamp(lastActivity)}`,
    `剧本：${scenarioData?.title ? `《${scenarioData.title}》` : '还没选'}${scenarioRow ? `（${scenarioRow.source}${scenarioRow.scenario_key ? `：${scenarioRow.scenario_key}` : ''}）` : ''}`,
    `主持模型：${room.dm_model ?? '默认'}　回合：${room.round_no}　主持风格：${room.style ?? '默认'}`,
    `成员 ${players.length} 人：${players.map((p) => `${p.display_name}${p.uid !== null ? `（UID ${p.uid}）` : ''}`).join('、') || '无'}`,
    `角色 ${characters.length} 个：${characters.map((c) => `${c.name}（伤势 ${c.wounds}、心智 ${c.stress}${Number(c.dead) ? '、死亡' : ''}）`).join('、') || '无'}`,
    `行动 ${actions.length} 个（${['waiting', 'resolving', 'done', 'withdrawn', 'failed'].map((s) => `${s} ${actions.filter((a) => a.status === s).length}`).join('，')}）；掷骰 ${rolls.length} 次；记录 ${log.length} 条`,
    `AI 调用 ${aiCalls.length} 次，一共 ${money(totalCost)}`,
    '',
    '# 自动检查',
    ...findings,
    '',
    '# 花费：按用途',
    ...[...byPurpose.entries()].map(([k, v]) => `${k}：${v.n} 次，${money(v.cost)}`),
    '',
    '# 花费：算在谁头上',
    ...([...byUser.entries()].map(([k, v]) => `${k}：${money(v)}`).length ? [...byUser.entries()].map(([k, v]) => `${k}：${money(v)}`) : ['（没有）']),
    '',
  ].join('\n');

  // ---------- 时间线 ----------
  type Line = { at: number; order: number; text: string };
  const lines: Line[] = [];
  const push = (at: unknown, order: number, text: string) => lines.push({ at: Number(at) || 0, order, text });
  push(room.created_at, 0, `建立对局「${room.name}」`);
  for (const l of log) {
    const data = l.data as { type?: string } | null;
    const vis = l.visibility === 'private' ? `（只给 ${who(l.target_user_id)}）` : '';
    const by = l.author_user_id ? `${who(l.author_user_id)}：` : '';
    push(l.created_at, 1, `记录 #${l.id} [${l.kind}${data?.type ? `/${data.type}` : ''}]${vis} ${by}${clip(l.text, 300)}`);
  }
  for (const a of actions) {
    const c = nameOfCharacter.get(Number(a.character_id)) ?? `角色 ${a.character_id}`;
    const flags = [Number(a.secret) ? '悄悄做' : '', a.assist_of ? `协助 #${a.assist_of}` : '', Number(a.pet_help) ? '宠物出手' : ''].filter(Boolean).join('、');
    push(
      a.submitted_at,
      2,
      `行动 #${a.id} ${c} 提交（${a.mode}${a.due_at ? `，到点 ${stamp(Number(a.due_at))}` : ''}${flags ? `，${flags}` : ''}）：${clip(a.content, 200)}`,
    );
    if (a.resolved_at) push(a.resolved_at, 3, `行动 #${a.id} ${a.status}${Number(a.attempts) > 1 ? `（试了 ${a.attempts} 次）` : ''}${a.last_error ? `，最后的错误：${clip(a.last_error, 160)}` : ''}`);
    else if (a.status !== 'waiting' && a.status !== 'resolving') push(a.submitted_at, 3, `行动 #${a.id} 现在是 ${a.status}${a.last_error ? `：${clip(a.last_error, 160)}` : ''}`);
  }
  for (const r of rolls) {
    push(
      r.created_at,
      4,
      `掷骰 #${r.id} ${nameOfCharacter.get(Number(r.character_id)) ?? r.character_id}：${r.attribute ?? ''} ${r.die1}+${r.die2}，总点数 ${r.total}，${r.outcome}${Number(r.hidden) ? '（暗骰）' : ''}${Number(r.pet_help) ? '（宠物出手）' : ''}${r.action_id ? `，行动 #${r.action_id}` : ''}`,
    );
  }
  for (const c of aiCalls) {
    // 这一回调用了哪些工具（V0.9.1 起有）：连着几个一样的写成「×几」
    let tools = '';
    try {
      const names = typeof c.tools === 'string' ? (JSON.parse(c.tools) as unknown) : null;
      if (Array.isArray(names) && names.length) tools = `，调用工具：${countedNames(names.map(String))}`;
    } catch {
      // 不是 JSON：不写
    }
    push(
      c.created_at,
      5,
      `AI #${c.id} ${c.purpose} ${c.model}：输入 ${c.input_tokens}（缓存读 ${c.cache_read_tokens}），输出 ${c.output_tokens}，${money(Number(c.cost_usd || 0))}，${Math.round(Number(c.duration_ms) / 100) / 10} 秒${c.stop_reason ? `，${c.stop_reason}` : ''}${tools}${c.action_id ? `，行动 #${c.action_id}` : ''}${c.request_id ? `，请求编号 ${c.request_id}` : ''}${c.error ? `，出错：${clip(c.error, 200)}` : ''}`,
    );
  }
  for (const v of violations) push(v.created_at, 6, `违规 #${v.id} ${who(v.user_id)} ${v.kind}/${v.source} → ${v.outcome}：${clip(v.reason, 120)}`);
  for (const j of jobs) {
    push(j.created_at, 7, `剧本任务 #${j.id} ${j.kind} 开始`);
    if (j.finished_at) push(j.finished_at, 7, `剧本任务 #${j.id} ${j.status}${j.error ? `：${clip(j.error, 160)}` : ''}`);
  }
  for (const a of audits) push(a.created_at, 8, `管理操作：${a.admin_name ?? '—'} ${a.action}：${clip(a.detail, 200)}`);
  for (const r of reports) push(r.created_at, 9, `${r.kind === 'bug' ? '问题反馈' : r.kind === 'feedback' ? '意见' : '举报'} #${r.id}（${who(r.reporter_id)}）：${clip(r.body, 160)}`);
  lines.sort((a, b) => a.at - b.at || a.order - b.order);
  const timeline = [`对局 ${roomId}「${room.name}」的时间线（服务器的钟）`, '', ...lines.map((l) => `[${stamp(l.at)}] ${l.text}`), ''].join('\n');

  const settings = {
    models: ai.models,
    switchedOff: ai.switchedOff,
    roomDmDefault: (() => {
      try {
        return ai.roomDmDefault(roomId);
      } catch {
        return null;
      }
    })(),
  };
  const data = {
    meta: {
      exportedAt: now,
      exportedAtText: stamp(now),
      exporter: exporter.name,
      appVersion: APP_VERSION,
      schemaVersion: schemaVersion(db),
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      timezoneOffsetMinutes: -new Date(now).getTimezoneOffset(),
      ai: settings,
    },
    room: roomParsed,
    scenario: scenarioParsed,
    players,
    characters,
    actions,
    rolls,
    log,
    clues,
    knowledge,
    notes,
    resolutionSnapshots: snapshots,
    aiCalls,
    aiCallShares: shares,
    scenarioJobs: jobs,
    violations,
    joinRequests,
    invites,
    reports,
    audits,
    petGrowth: growth,
    petDiary: diary,
    aiSeats,
    schedules,
    scheduleSlots,
    scheduleVotes,
  };

  const readme = [
    `龙娘跑团 整局排查包：对局 ${roomId}「${room.name}」`,
    `导出时间：${stamp(now)}，导出的人：${exporter.name}，版本：${versionLabel()}`,
    '',
    '诊断.txt    程序自动查一遍：卡住的行动、AI 报错和拒绝、被截断、违规、花费、对局状态',
    '时间线.txt  叙述、行动、掷骰、AI 调用、违规、管理操作，按时间排好（服务器的钟）',
    '数据.json   原始数据：对局、剧本、成员、角色、行动、掷骰、记录、线索、撤回快照、AI 调用、违规、举报、管理操作',
    '',
    '里面有这一局的私密内容（身份的秘密、悄悄话、只发给某个人的叙述），只发给需要排查的人。',
    '不含：密码、登录记录、登录地点、设备、邀请码、发给 AI 服务商的匿名编号；玩家的笔记只有长度，没有内容。',
    '',
  ].join('\n');

  const safeName = String(room.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || 'room';
  const d = new Date(now);
  const filename = `排查包-对局${roomId}-${safeName}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
  const body = zip(
    [
      { name: '说明.txt', data: readme },
      { name: '诊断.txt', data: diagnosis },
      { name: '时间线.txt', data: timeline },
      { name: '数据.json', data: `${JSON.stringify(data, null, 2)}\n` },
    ],
    now,
  );
  const summary = `对局 ${roomId}「${room.name}」：行动 ${actions.length} 个、记录 ${log.length} 条、AI 调用 ${aiCalls.length} 次`;
  return { filename, data: body, summary };
}
