import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, randomCode, verifyPassword } from './auth';
import { transaction, type DB } from './db';
import { validateScenario } from './game/scenario';

/**
 * 本地测试用的账号。只用于在自己电脑上测试，正式开放给朋友之前请删掉或改掉这些账号。
 * 每次运行 npm run seed，这些账号的显示名和密码都会恢复成下面的值。
 */
export const TEST_ACCOUNTS = [
  { username: 'admin', displayName: '测试管理员', password: 'admin-trpg-2026', isAdmin: true },
  { username: 'tester1', displayName: '测试玩家一', password: 'tester1-trpg-2026', isAdmin: false },
  { username: 'tester2', displayName: '测试玩家二', password: 'tester2-trpg-2026', isAdmin: false },
  { username: 'tester3', displayName: '测试玩家三', password: 'tester3-lake-3135', isAdmin: false },
  { username: 'tester4', displayName: '测试玩家四', password: 'tester4-jade-6188', isAdmin: false },
  { username: 'tester5', displayName: '测试玩家五', password: 'tester5-lamp-8127', isAdmin: false },
] as const;

type Username = (typeof TEST_ACCOUNTS)[number]['username'];

const SCENARIO_DIR = path.resolve(import.meta.dirname, '..', 'scenarios');
/** 只给测试用的剧本（不随网站发布）：测试剧本《雾港旅店》。 */
export const TEST_SCENARIO_DIR = path.resolve(import.meta.dirname, '..', 'test', 'fixtures');

const DEMO_ROOMS: {
  name: string;
  host: Username;
  members: Username[];
  maxPlayers: number;
  scenario?: string;
  /** 预先建好的角色，开局就能玩。 */
  characters?: Partial<Record<Username, DemoCharacter>>;
  chat: [Username, string][];
  notes: Partial<Record<Username, string>>;
}[] = [
  {
    name: '单人试玩',
    host: 'admin',
    members: [],
    maxPlayers: 1,
    scenario: 'fog-harbor-inn',
    characters: {
      // 属性、专长、外貌按剧本里这个身份定好的
      admin: { name: '林小满', roleKey: 'reporter' },
    },
    chat: [],
    notes: { admin: '单人试玩：角色已经建好了，点「开始对局」就能玩。' },
  },
  {
    name: '雾港旅店',
    host: 'admin',
    members: ['tester1', 'tester2'],
    maxPlayers: 4,
    scenario: 'fog-harbor-inn',
    chat: [
      ['tester1', '我今晚九点以后才有空，先把角色想好。'],
      ['tester2', '收到，那我先去旅店前台问问情况。'],
    ],
    notes: {
      admin: '雾港旅店：老板娘说话吞吞吐吐，下次再问问。（这条笔记只有你自己能看到）',
      tester1: '雾港旅店：测试玩家一的笔记，别人看不到。',
    },
  },
  {
    name: '六人局',
    host: 'admin',
    members: ['tester1', 'tester2', 'tester3', 'tester4', 'tester5'],
    maxPlayers: 6,
    scenario: 'fog-harbor-inn',
    characters: {
      admin: { name: '林小满', roleKey: 'reporter' },
      tester1: { name: '许医生', roleKey: 'doctor' },
      tester2: { name: '沈探', roleKey: 'detective' },
      tester3: { name: '顾一鸣', roleKey: 'customs' },
      tester4: { name: '白少卿', roleKey: 'young-master' },
      tester5: { name: '阿海', roleKey: 'sailor' },
    },
    chat: [['admin', '六个人的角色都建好了，我随时可以开始。']],
    notes: {},
  },
  {
    name: '山寺夜话',
    host: 'tester1',
    members: ['admin'],
    maxPlayers: 4,
    chat: [['tester1', '剧本还没定，等大家有空再一起挑。']],
    notes: {
      admin: '山寺夜话：钟声一共响了三下。（和雾港旅店的笔记互相独立）',
    },
  },
];

type DemoCharacter = { name: string; roleKey: string };

/** 示例对局的剧本：先找 scenarios 文件夹，没有再找测试剧本。 */
function readScenario(key: string): string {
  const shipped = path.join(SCENARIO_DIR, `${key}.json`);
  const file = fs.existsSync(shipped) ? shipped : path.join(TEST_SCENARIO_DIR, `${key}.json`);
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const result = validateScenario(JSON.parse(text));
  if (!result.scenario) throw new Error(`剧本 ${key} 有错误：${result.errors.join('；')}`);
  return JSON.stringify(result.scenario);
}

/** 还在用上面公开的测试密码的账号（启动时提醒：同一个局域网里的人都能用它们登录）。 */
export async function accountsWithDefaultPassword(db: DB): Promise<string[]> {
  const open: string[] = [];
  for (const account of TEST_ACCOUNTS) {
    // 封了的测试账号登录不了（密码对了也只会看到被封禁），不算
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ? AND banned_at IS NULL').get(account.username) as { password_hash: string } | undefined;
    if (row && (await verifyPassword(account.password, row.password_hash))) open.push(account.username);
  }
  return open;
}

/** at：账号、对局记的时间（自动测试用假的时钟时传进来，免得和测试里的时间对不上）。 */
export async function seedTestData(db: DB, at?: number) {
  const now = at ?? Date.now();
  const ids = {} as Record<Username, number>;

  for (const account of TEST_ACCOUNTS) {
    const hash = await hashPassword(account.password);
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(account.username) as { id: number } | undefined;
    if (existing) {
      // 测试账号直接算作同意过使用规则，也解除封禁，方便反复测试
      db.prepare(
        `UPDATE users SET display_name = ?, password_hash = ?, is_admin = ?, failed_logins = 0, locked_until = NULL,
           banned_at = NULL, ban_reason = NULL, banned_until = NULL, rules_agreed_at = COALESCE(rules_agreed_at, ?) WHERE id = ?`,
      ).run(account.displayName, hash, account.isAdmin ? 1 : 0, now, existing.id);
      ids[account.username] = existing.id;
    } else {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, rules_agreed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(account.username, account.displayName, hash, account.isAdmin ? 1 : 0, now, now);
      ids[account.username] = Number(lastInsertRowid);
    }
  }

  // 测试管理员是站长（网站还没有站长的时候）
  db.prepare('UPDATE users SET is_owner = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)').run(ids.admin);

  const createdRooms: string[] = [];
  for (const demo of DEMO_ROOMS) {
    const existing = db.prepare('SELECT id, status FROM rooms WHERE name = ? AND host_user_id = ?').get(demo.name, ids[demo.host]) as
      | { id: number; status: string }
      | undefined;
    if (existing) {
      // 以前 seed 出来的对局还没有剧本：补上，就能直接开始
      const hasScenario = db.prepare('SELECT 1 FROM scenarios WHERE room_id = ?').get(existing.id);
      if (demo.scenario && !hasScenario && existing.status === 'preparing') {
        db.prepare("INSERT INTO scenarios (room_id, source, scenario_key, data, created_at) VALUES (?, 'builtin', ?, ?, ?)").run(
          existing.id,
          demo.scenario,
          readScenario(demo.scenario),
          now,
        );
      }
      continue;
    }
    transaction(db, () => {
      let code = randomCode(6);
      while (db.prepare('SELECT 1 FROM rooms WHERE join_code = ?').get(code)) code = randomCode(6);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO rooms (name, host_user_id, join_code, max_players, model, status, created_at)
           VALUES (?, ?, ?, ?, 'claude', 'preparing', ?)`,
        )
        .run(demo.name, ids[demo.host], code, demo.maxPlayers, now);
      const roomId = Number(lastInsertRowid);
      const addPlayer = db.prepare('INSERT INTO players (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
      const playerIds = {} as Record<Username, number>;
      playerIds[demo.host] = Number(addPlayer.run(roomId, ids[demo.host], 'host', now).lastInsertRowid);
      for (const member of demo.members) playerIds[member] = Number(addPlayer.run(roomId, ids[member], 'player', now).lastInsertRowid);

      const addLog = db.prepare('INSERT INTO log_entries (room_id, kind, author_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)');
      addLog.run(roomId, 'system', null, '测试对局已创建', now);
      demo.chat.forEach(([who, text], i) => addLog.run(roomId, 'ooc', ids[who], text, now + i + 1));

      const addNote = db.prepare('INSERT INTO notes (room_id, author_user_id, content, updated_at) VALUES (?, ?, ?, ?)');
      for (const [who, content] of Object.entries(demo.notes)) addNote.run(roomId, ids[who as Username], content, now);

      if (demo.scenario) {
        db.prepare("INSERT INTO scenarios (room_id, source, scenario_key, data, created_at) VALUES (?, 'builtin', ?, ?, ?)").run(
          roomId,
          demo.scenario,
          readScenario(demo.scenario),
          now,
        );
      }
      for (const [who, c] of Object.entries(demo.characters ?? {}) as [Username, DemoCharacter][]) {
        const role = validateScenario(JSON.parse(readScenario(demo.scenario!))).scenario!.roles.find((r) => r.key === c.roleKey)!;
        db.prepare(
          `INSERT INTO characters (room_id, player_id, role_key, name, attributes, specialties, appearance, goal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)`,
        ).run(roomId, playerIds[who], c.roleKey, c.name, JSON.stringify(role.attributes), JSON.stringify(role.specialties), role.appearance, now);
      }
    });
    createdRooms.push(demo.name);
  }

  // 一个没用过的邀请码，方便测试注册
  let invite = db
    .prepare("SELECT code FROM invites WHERE note = '测试注册用' AND used_by IS NULL AND expires_at > ?")
    .get(now) as { code: string } | undefined;
  if (!invite) {
    const code = randomCode(8);
    db.prepare('INSERT INTO invites (code, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
      code,
      ids.admin,
      '测试注册用',
      now + 30 * 24 * 60 * 60 * 1000,
      now,
    );
    invite = { code };
  }

  return { ids, createdRooms, inviteCode: invite.code };
}
