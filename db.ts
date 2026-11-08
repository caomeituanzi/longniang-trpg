import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { backupDatabase } from './backup';
import { getSetting, setSetting } from './settings';
import { APP_VERSION, versionLabel } from './version';

// Node 自带的 SQLite 加载时会提示“实验性功能”。它在本项目用得很稳，这条提示只会让人误以为出错了，所以屏蔽掉。
const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  originalEmitWarning(warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncType;

// 每一项是一次数据库升级，按顺序执行，执行过的不会重复执行。以后加字段就往后追加，不要改已有的。
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    note TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    used_by INTEGER REFERENCES users(id),
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    host_user_id INTEGER NOT NULL REFERENCES users(id),
    join_code TEXT NOT NULL UNIQUE,
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 6),
    model TEXT NOT NULL CHECK (model IN ('claude', 'deepseek')),
    status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'running', 'paused', 'ended')),
    always_timed INTEGER NOT NULL DEFAULT 0,
    time_ratio REAL NOT NULL DEFAULT 1.0,
    min_wait_minutes INTEGER NOT NULL DEFAULT 15,
    max_wait_minutes INTEGER NOT NULL DEFAULT 120,
    game_clock INTEGER,
    cost_limit_usd REAL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE players (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('host', 'player')),
    joined_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    UNIQUE (room_id, user_id)
  );
  CREATE INDEX players_user ON players(user_id);

  CREATE TABLE characters (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    attributes TEXT NOT NULL DEFAULT '{}',
    specialties TEXT NOT NULL DEFAULT '[]',
    wounds INTEGER NOT NULL DEFAULT 0,
    stress INTEGER NOT NULL DEFAULT 0,
    conditions TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    location TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE scenarios (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('generated', 'imported')),
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE clues (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    scenario_clue_key TEXT NOT NULL,
    found_by_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    found_game_time INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE knowledge (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL CHECK (content_type IN ('clue', 'log', 'event')),
    content_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (content_type, content_id, character_id)
  );

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    shared_with TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    UNIQUE (room_id, author_user_id)
  );

  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'resolving', 'done', 'withdrawn')),
    mode TEXT NOT NULL CHECK (mode IN ('timed', 'round')),
    submitted_at INTEGER NOT NULL,
    due_at INTEGER,
    game_minutes INTEGER,
    resolved_at INTEGER
  );
  CREATE INDEX actions_due ON actions(status, due_at);

  CREATE TABLE rolls (
    id INTEGER PRIMARY KEY,
    action_id INTEGER REFERENCES actions(id) ON DELETE CASCADE,
    attribute TEXT,
    modifier INTEGER NOT NULL DEFAULT 0,
    die1 INTEGER NOT NULL,
    die2 INTEGER NOT NULL,
    total INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('narration', 'ooc', 'system')),
    visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'private')),
    target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    game_time INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX log_room ON log_entries(room_id, id);

  CREATE TABLE ai_calls (
    id INTEGER PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  `,
  // 第2次：开始真正跑团。
  // 角色、行动、掷骰、线索、知情、剧本、AI调用这几张表在第1版里还没用过（一定是空的），直接按新结构重建。
  `
  DROP TABLE knowledge;
  DROP TABLE clues;
  DROP TABLE rolls;
  DROP TABLE actions;
  DROP TABLE characters;
  DROP TABLE scenarios;
  DROP TABLE ai_calls;

  CREATE TABLE scenarios (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('builtin', 'generated', 'imported')),
    scenario_key TEXT,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE characters (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes TEXT NOT NULL,
    specialties TEXT NOT NULL,
    appearance TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    wounds INTEGER NOT NULL DEFAULT 0,
    stress INTEGER NOT NULL DEFAULT 0,
    conditions TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    location TEXT,
    visited TEXT NOT NULL DEFAULT '[]',
    dead INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (room_id, role_key)
  );

  -- 行动：waiting 等待中，resolving 结算中，done 完成，withdrawn 撤回，failed AI结算失败（可以撤回或重试）
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'resolving', 'done', 'withdrawn', 'failed')),
    mode TEXT NOT NULL CHECK (mode IN ('timed', 'round')),
    round INTEGER,
    submitted_at INTEGER NOT NULL,
    due_at INTEGER,
    game_start INTEGER,
    game_minutes INTEGER,
    estimate_note TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    result TEXT,
    resolved_at INTEGER
  );
  CREATE INDEX actions_due ON actions(status, mode, due_at);
  CREATE INDEX actions_room ON actions(room_id, status);
  CREATE INDEX actions_character ON actions(character_id, status);

  CREATE TABLE rolls (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    action_id INTEGER REFERENCES actions(id) ON DELETE CASCADE,
    character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    attribute TEXT,
    modifier INTEGER NOT NULL DEFAULT 0,
    die1 INTEGER NOT NULL,
    die2 INTEGER NOT NULL,
    total INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    created_at INTEGER NOT NULL
  );

  -- 一条剧本线索在一局里只记一次（第一次被谁找到）；之后谁知道它，记在知情表里
  CREATE TABLE clues (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    clue_key TEXT NOT NULL,
    found_by_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    found_game_time INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (room_id, clue_key)
  );

  -- 知情表：哪个角色知道哪条线索、看得到哪条叙述。发给玩家的内容都先按它过滤。
  CREATE TABLE knowledge (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL CHECK (content_type IN ('clue', 'log', 'event')),
    content_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    game_time INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (content_type, content_id, character_id)
  );
  CREATE INDEX knowledge_character ON knowledge(character_id, content_type);

  CREATE TABLE ai_calls (
    id INTEGER PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ai_calls_room ON ai_calls(room_id);

  -- world：NPC的变化、已经处理过的时间线事件、结局，JSON格式
  ALTER TABLE rooms ADD COLUMN world TEXT NOT NULL DEFAULT '{}';
  -- 游戏时钟：game_clock 是 clock_real_base 那一刻的游戏分钟数；clock_real_base 为空表示时钟停着
  ALTER TABLE rooms ADD COLUMN clock_real_base INTEGER;
  ALTER TABLE rooms ADD COLUMN round_no INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN paused_at INTEGER;

  -- 叙述卡片附带的结构化数据（掷骰、线索、行动内容等）
  ALTER TABLE log_entries ADD COLUMN data TEXT;

  -- 第1版里“进行中”的对局还没有剧本，退回准备阶段，选好剧本再开始
  UPDATE rooms SET status = 'preparing' WHERE status IN ('running', 'paused');
  `,
  // 第3次：建对局时不再能选 DeepSeek。以前选了 DeepSeek 的对局（DeepSeek 没接入，一直开不了）改成 Claude 主持。
  `
  UPDATE rooms SET model = 'claude' WHERE model = 'deepseek';
  -- 测试数据（npm run seed）在「山寺夜话」里放过一句说这局选了 DeepSeek 的聊天，换成新版测试数据里的那句
  UPDATE log_entries SET text = '剧本还没定，等大家有空再一起挑。'
    WHERE kind = 'ooc' AND text = '这一局选的是DeepSeek，用来测试另一种模型的设置。';
  `,
  // 第4次：尽量别让违规内容影响 API 账号。
  `
  -- 每个账号一个随机的匿名编号，调用 Claude 时带上（metadata.user_id），不用用户名
  ALTER TABLE users ADD COLUMN ai_ref TEXT;
  UPDATE users SET ai_ref = lower(hex(randomblob(16))) WHERE ai_ref IS NULL;
  -- AI调用记录：替谁做的调用、Anthropic 给的请求编号（出了问题找 Anthropic 时要用）
  ALTER TABLE ai_calls ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE ai_calls ADD COLUMN request_id TEXT;
  -- 被 Anthropic 安全机制拒绝过的行动：不能再重试，只能撤回
  ALTER TABLE actions ADD COLUMN refused INTEGER NOT NULL DEFAULT 0;
  `,
  // 第5次：阶段2，多人的细节。
  `
  -- 线索是谁告诉他的（自己找到的是空）
  ALTER TABLE knowledge ADD COLUMN source_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL;
  -- 离开对局页面那一刻，这一局最新一条记录的编号：之后的记录就是“你不在时发生的事”；left_at 是离开的时间
  ALTER TABLE players ADD COLUMN seen_log_id INTEGER;
  ALTER TABLE players ADD COLUMN left_at INTEGER;
  -- 上次给他写的“你不在时发生了什么”的摘要，同一段记录不重复写
  ALTER TABLE players ADD COLUMN catchup_after_id INTEGER;
  ALTER TABLE players ADD COLUMN catchup_until_id INTEGER;
  ALTER TABLE players ADD COLUMN catchup_text TEXT;
  -- 主持AI的长期记忆：更早的剧情压缩成的摘要，以及摘要写到了哪一条记录
  ALTER TABLE rooms ADD COLUMN story_summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE rooms ADD COLUMN summary_until_log_id INTEGER NOT NULL DEFAULT 0;
  `,
  // 6：阶段3，AI 生成剧本、把文本剧本转成结构化剧本的任务；房主看过完整剧本的时间
  `
  CREATE TABLE scenario_jobs (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('generate', 'convert')),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
    step TEXT,
    fix_round INTEGER NOT NULL DEFAULT 0,
    input TEXT NOT NULL,
    error TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX scenario_jobs_room ON scenario_jobs(room_id, id);
  ALTER TABLE scenarios ADD COLUMN revealed_at INTEGER;
  `,
  // 7：阶段4，每人 AI 额度、封号和违规记录、全站 AI 开关、使用规则、撤回结算用的快照
  `
  -- 每人 AI 额度：发放的总额（美元，累计，默认 5）；ai_unlimited 表示不限
  ALTER TABLE users ADD COLUMN ai_credit_usd REAL NOT NULL DEFAULT 5;
  ALTER TABLE users ADD COLUMN ai_unlimited INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN banned_at INTEGER;
  ALTER TABLE users ADD COLUMN ban_reason TEXT;
  ALTER TABLE users ADD COLUMN rules_agreed_at INTEGER;

  -- 每次 AI 调用算到谁头上：自己的调用全算自己，多人共用的按人平摊
  CREATE TABLE ai_call_shares (
    call_id INTEGER NOT NULL REFERENCES ai_calls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cost_usd REAL NOT NULL,
    PRIMARY KEY (call_id, user_id)
  );
  CREATE INDEX ai_call_shares_user ON ai_call_shares(user_id);
  -- 以前记下的、替某个人做的调用，补上归属
  INSERT INTO ai_call_shares (call_id, user_id, cost_usd)
    SELECT c.id, c.user_id, c.cost_usd FROM ai_calls c JOIN users u ON u.id = c.user_id WHERE c.cost_usd > 0;

  -- 管理员发放额度的记录
  CREATE TABLE credit_grants (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_usd REAL NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  -- 违规记录：发给 AI 之前检查出来的（precheck），被 Anthropic 拒绝的（refusal）
  CREATE TABLE violations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('precheck', 'refusal')),
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    reason TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('banned', 'flagged', 'blocked')),
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX violations_time ON violations(created_at);

  -- 全站设置（AI 紧急停用开关等）
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 撤回、重新结算用：结算前各角色的状态、对局的状态，以及这次结算新加的记录、线索、知情。每局只留最近几次
  CREATE TABLE resolution_snapshots (
    id INTEGER PRIMARY KEY,
    action_id INTEGER NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX resolution_snapshots_room ON resolution_snapshots(room_id, id);
  `,
  // 8：大厅。房主把对局设成公开以后，它出现在大厅里，谁都能直接加入（不用对局码）
  `
  ALTER TABLE rooms ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX rooms_public ON rooms(is_public, status);
  `,
  // 9：V0.2.0。UID（从 0 开始按注册顺序编号，只有管理员看得到）；游客；管理员备注；头像和个人主页；好友、私聊、屏蔽；
  // 通知、公告、大厅聊天、举报和反馈；对局邀请；行动可以悄悄做、可以协助别人的行动
  `
  ALTER TABLE users ADD COLUMN uid INTEGER;
  -- 现有账号编号：最先建的、没被封的管理员（升级以后的站长）是 0，其他账号按注册先后从 1 开始；没有这样的管理员就都按注册先后从 0 开始
  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY (id = (SELECT MIN(id) FROM users WHERE is_admin = 1 AND banned_at IS NULL)) DESC, id) - 1 AS n FROM users
  )
  UPDATE users SET uid = (SELECT n FROM ordered WHERE ordered.id = users.id);
  CREATE UNIQUE INDEX users_uid ON users(uid);
  -- 发出去过的最大 UID：删掉的账号（游客）的 UID 不会再给别人
  CREATE TABLE uid_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
  INSERT INTO uid_counter (id, last) VALUES (1, (SELECT COALESCE(MAX(uid), -1) FROM users));
  -- 以后新建的账号自动接着编号（注册、游客、测试数据、哪条路建的都一样）
  CREATE TRIGGER users_assign_uid AFTER INSERT ON users WHEN NEW.uid IS NULL
  BEGIN
    UPDATE uid_counter SET last = MAX(last, (SELECT COALESCE(MAX(uid), -1) FROM users)) + 1 WHERE id = 1;
    UPDATE users SET uid = (SELECT last FROM uid_counter WHERE id = 1) WHERE id = NEW.id;
  END;

  -- 站长：最高权限，只有一个（升级时是编号最小的、没被封的管理员；一个都没有就先空着，启动时会提示用 make-admin 指定）。
  -- 只有站长能任命管理员、给管理员下发权限
  ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
  -- 管理员有哪些权限（JSON 数组，见 shared/admin.ts）；站长不看这一项，什么都能做
  ALTER TABLE users ADD COLUMN admin_perms TEXT NOT NULL DEFAULT '[]';
  UPDATE users SET is_owner = 1 WHERE id = (SELECT id FROM users WHERE is_admin = 1 AND banned_at IS NULL ORDER BY uid LIMIT 1);
  CREATE UNIQUE INDEX users_owner ON users(is_owner) WHERE is_owner = 1;
  -- 以前的管理员什么都能做、额度不限：升级以后照旧（站长以后可以再改）
  UPDATE users SET admin_perms = '["users","credit","ban","rooms","invites","announce","reports","ai","system","audit"]', ai_unlimited = 1
    WHERE is_admin = 1 AND is_owner = 0;

  -- 游客：只能看大厅、观看公开对局的故事，没有额度
  ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;
  -- 管理员在后台给账号写的备注（只有管理员看得到）
  ALTER TABLE users ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';
  -- 个人主页：一句话介绍；要不要展示自己的对局和战绩
  ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN show_rooms INTEGER NOT NULL DEFAULT 1;
  -- 最近一次在线（打开网站）的时间
  ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
  -- 头像最后一次换的时间（没有头像是 NULL）；图片本身单独放一张表，查账号时不用把图片也读出来
  ALTER TABLE users ADD COLUMN avatar_at INTEGER;
  -- 登录输错：各处加起来的次数只算最近一段时间的（这是最后一次输错的时间）
  ALTER TABLE users ADD COLUMN failed_login_at INTEGER;
  -- 成功登录过这个账号的地方（网络地址的哈希，不存地址本身）：从这些地方登录，不受“整个账号锁定”影响，别人锁不住你
  CREATE TABLE login_places (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place TEXT NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, place)
  );
  CREATE TABLE avatars (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data BLOB NOT NULL
  );

  -- 好友：发起的人、对方、状态（等对方同意 / 已经是好友）
  CREATE TABLE friendships (
    id INTEGER PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    UNIQUE (requester_id, addressee_id)
  );
  CREATE INDEX friendships_addressee ON friendships(addressee_id, status);

  -- 好友之间的私聊
  CREATE TABLE direct_messages (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX direct_messages_pair ON direct_messages(sender_id, recipient_id, id);
  CREATE INDEX direct_messages_unread ON direct_messages(recipient_id, read_at);

  -- 屏蔽：被屏蔽的人不能给他发私信、加他好友、邀请他进对局；大厅聊天里看不到被屏蔽的人说的话
  CREATE TABLE blocks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );

  -- 通知（右上角的铃铛）：好友申请、对局邀请、对局开始了、举报有了回复……
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  CREATE INDEX notifications_unread ON notifications(user_id, read_at);

  -- 对局邀请：房主（或管理员）邀请好友，对方点“加入”就能进来，不用对局码
  CREATE TABLE room_invites (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );

  -- 公告：发给全服（all）、某种身份的人（guest / user / admin），或者指定的人（users，名单在 announcement_targets）
  CREATE TABLE announcements (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('all', 'guest', 'user', 'admin', 'users')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE announcement_targets (
    announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, user_id)
  );
  CREATE TABLE announcement_reads (
    announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (announcement_id, user_id)
  );

  -- 大厅聊天（世界频道）；管理员删掉的留着记录，显示成“被管理员删除了”
  CREATE TABLE lobby_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  -- 举报（report：某个人、某条聊天）、意见（feedback：给管理员提意见）、bug（报告网站的问题）。
  -- target 是被举报的内容的快照；steps 是 bug 怎么出现的；context 是报 bug 时自动附上的页面、浏览器、版本、最近的报错。
  -- outcome 是处理结果：bug 是 confirmed（已确认）/ fixed（已修复）/ not-a-bug（不是问题）/ need-info（需要更多信息），其他是 handled
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('report', 'feedback', 'bug')),
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target TEXT,
    body TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '',
    context TEXT,
    created_at INTEGER NOT NULL,
    handled_at INTEGER,
    handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    outcome TEXT,
    reply TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX reports_open ON reports(handled_at, id);

  -- 管理员操作记录：谁、什么时候、做了什么（封号、改身份、发额度、重置密码、删对局、发公告、改模型……）
  CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- 这一局的主持用哪个模型（房主开局时选）；NULL 是跟随网站的设置
  ALTER TABLE rooms ADD COLUMN dm_model TEXT;

  -- 行动：secret 是悄悄做（同一地点的人看不到你交了什么）；assist_of 是协助别人的哪个行动（跟着那个行动一起结算）
  ALTER TABLE actions ADD COLUMN secret INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE actions ADD COLUMN assist_of INTEGER REFERENCES actions(id) ON DELETE SET NULL;
  CREATE INDEX actions_assist ON actions(assist_of);
  `,
  // 10：V0.3.0。站长可以删除账号：删掉的账号留着一行（对局里的角色、记录还在），登录不了，名字换成「已删除的账号」，用户名放出来。
  // 新的管理员权限「剧本管理」：以前有「管理所有对局」权限的管理员一起给上
  `
  ALTER TABLE users ADD COLUMN deleted_at INTEGER;
  UPDATE users SET admin_perms = json_insert(admin_perms, '$[#]', 'scenarios')
    WHERE is_admin = 1 AND is_owner = 0
      AND EXISTS (SELECT 1 FROM json_each(users.admin_perms) WHERE value = 'rooms')
      AND NOT EXISTS (SELECT 1 FROM json_each(users.admin_perms) WHERE value = 'scenarios');
  `,
  // 11：V0.3.1。按顺序的 UID 只给正式账号：游客换成 8 位数，不占顺序号；
  // 正式账号（包括删掉的）重新排成连续的号：0 号（站长）不动，其余按原来的先后从 1 开始
  `
  UPDATE users SET uid = 10000000 + (id * 61803397) % 90000000 WHERE is_guest = 1;
  CREATE TEMP TABLE uid_order AS
    SELECT id, ROW_NUMBER() OVER (ORDER BY uid) AS n FROM users WHERE is_guest = 0 AND uid > 0;
  -- 先挪到负数再排：直接改的话，中途会和还没改的账号撞号
  UPDATE users SET uid = -1 - uid WHERE id IN (SELECT id FROM uid_order);
  UPDATE users SET uid = (SELECT n FROM uid_order WHERE uid_order.id = users.id) WHERE id IN (SELECT id FROM uid_order);
  DROP TABLE uid_order;
  -- 删掉的正式账号的用户名是 deleted-UID，跟着新的号改（先换成临时的名字，免得中途重名）
  UPDATE users SET username = 'deleted-tmp-' || id WHERE is_guest = 0 AND deleted_at IS NOT NULL;
  UPDATE users SET username = 'deleted-' || uid WHERE is_guest = 0 AND deleted_at IS NOT NULL;
  UPDATE uid_counter SET last = (SELECT COALESCE(MAX(uid), -1) FROM users WHERE is_guest = 0) WHERE id = 1;
  DROP TRIGGER users_assign_uid;
  CREATE TRIGGER users_assign_uid AFTER INSERT ON users WHEN NEW.uid IS NULL AND NEW.is_guest = 0
  BEGIN
    UPDATE uid_counter SET last = MAX(last, (SELECT COALESCE(MAX(uid), -1) FROM users WHERE is_guest = 0)) + 1 WHERE id = 1;
    UPDATE users SET uid = (SELECT last FROM uid_counter WHERE id = 1) WHERE id = NEW.id;
  END;
  -- 游客一般在建的时候就给了随机的 8 位数；别的地方没给的，按编号算一个（不会和别人重复）
  CREATE TRIGGER users_assign_guest_uid AFTER INSERT ON users WHEN NEW.uid IS NULL AND NEW.is_guest = 1
  BEGIN
    UPDATE users SET uid = 10000000 + (NEW.id * 61803397) % 90000000 WHERE id = NEW.id;
  END;
  `,
  // 12：V0.3.2。删掉的正式账号把 UID 空出来：新注册的、管理员新建的正式账号用空着的最小的号（不再一直往后排）。
  // 删掉的账号的用户名换成 deleted- 加一串随机字符（以前带着 UID，号给了别人以后会对不上）。
  // 记下账号是谁建的（管理员在管理页新建的才有）。
  // 公开编号：个人主页、头像的网址用它，不用用户名（用户名只有本人和管理员看得到，别人要知道完整的用户名才能加好友）
  `
  UPDATE users SET uid = NULL, username = 'deleted-' || lower(hex(randomblob(6))) WHERE is_guest = 0 AND deleted_at IS NOT NULL;
  ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN public_id TEXT;
  UPDATE users SET public_id = 'p-' || lower(hex(randomblob(8)));
  CREATE UNIQUE INDEX users_public_id ON users(public_id);
  CREATE TRIGGER users_assign_public_id AFTER INSERT ON users WHEN NEW.public_id IS NULL
  BEGIN
    UPDATE users SET public_id = 'p-' || lower(hex(randomblob(8))) WHERE id = NEW.id;
  END;
  -- 通知里存着的发起人：用户名换成公开编号，头像的地址也跟着换
  UPDATE notifications SET data = json_remove(json_set(data,
      '$.from.publicId', (SELECT u.public_id FROM users u WHERE u.username = json_extract(notifications.data, '$.from.username')),
      '$.from.avatar', (SELECT CASE WHEN u.avatar_at IS NULL THEN NULL ELSE '/api/avatars/' || u.public_id || '?v=' || u.avatar_at END
                        FROM users u WHERE u.username = json_extract(notifications.data, '$.from.username'))
    ), '$.from.username')
    WHERE json_type(data, '$.from.username') = 'text';
  -- 额度兑换码：管理员生成，玩家在账号设置里兑换。单次的只能被一个人用一次；可重复的每个人各能用一次，到有效期为止。
  -- 删掉兑换码以后不能再兑换；已经兑换的额度不受影响（兑换时已经加进额度、记进发放记录了）
  -- code：比对用的写法（去掉空格、短横线、下划线，字母换成大写）；display：显示给人看的写法（管理员自己写的照原样，随机的 4 位一组）
  CREATE TABLE credit_codes (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    reusable INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE credit_code_uses (
    id INTEGER PRIMARY KEY,
    code_id INTEGER NOT NULL REFERENCES credit_codes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (code_id, user_id)
  );
  DROP TRIGGER users_assign_uid;
  -- 空着的最小的号：0 空着就是 0，不然是某个正式账号的号加一、而且没人用的那些里最小的
  CREATE TRIGGER users_assign_uid AFTER INSERT ON users WHEN NEW.uid IS NULL AND NEW.is_guest = 0
  BEGIN
    UPDATE users SET uid = (
      SELECT MIN(c.n) FROM (
        SELECT 0 AS n
        UNION ALL
        SELECT u.uid + 1 FROM users u WHERE u.is_guest = 0 AND u.uid IS NOT NULL
      ) c
      WHERE NOT EXISTS (SELECT 1 FROM users x WHERE x.uid = c.n)
    ) WHERE id = NEW.id;
  END;
  DROP TABLE uid_counter;
  `,
  // 13：V0.4.4。封号可以定时长：banned_until 是到时间自动解封的时间，空着就是一直封着，等管理员解封
  // （以前的封号、违规自动封的都是这样）
  `
  ALTER TABLE users ADD COLUMN banned_until INTEGER;
  `,
  // 14：V0.4.5。大厅里加入公开的对局要房主同意（join_requests）；有成员被封号的对局冻结到他解封（rooms.frozen_at）；
  // 违规第一次警告、第二次封号（violations 多了 warned 和 dismissed）。
  // 开放注册（不用邀请码也能注册）时防一个人注册好几个号领初始额度：
  // signups 记下每个注册的账号是怎么注册的、在哪个网络（只存哈希）、送了多少初始额度、没送的话为什么；
  // devices 记下每个浏览器（存在浏览器里的一个随机编号，这里只存哈希）登录过哪些账号。
  // 同一个网络、同一个浏览器 30 天里只送一份初始额度；开放注册每天送出的份数也有上限
  `
  CREATE TABLE signups (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    via TEXT NOT NULL CHECK (via IN ('invite', 'open')),
    place TEXT NOT NULL,
    device TEXT,
    credit_usd REAL NOT NULL,
    withheld TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX signups_place ON signups(place, created_at);
  CREATE INDEX signups_created ON signups(created_at);
  CREATE TABLE devices (
    device TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (device, user_id)
  );
  CREATE INDEX devices_user ON devices(user_id);
  -- 违规改成第一次警告、第二次封号：结果多一种 warned（警告了）；管理员标成误判的（dismissed）不算次数。
  -- SQLite 改不了表上的 CHECK，只能换一张新表
  CREATE TABLE violations_new (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('precheck', 'refusal')),
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    reason TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('banned', 'warned', 'flagged', 'blocked')),
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    dismissed INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO violations_new (id, user_id, room_id, kind, source, content, category, reason, outcome, created_at, reviewed_at, reviewed_by)
    SELECT id, user_id, room_id, kind, source, content, category, reason, outcome, created_at, reviewed_at, reviewed_by FROM violations;
  DROP TABLE violations;
  ALTER TABLE violations_new RENAME TO violations;
  CREATE INDEX violations_time ON violations(created_at);
  CREATE INDEX violations_user ON violations(user_id);
  -- 一局里有成员被封号：冻结到他解封（frozen_at）；冻结时正在进行的会暂停，frozen_paused 记着解封以后要自动接着进行
  ALTER TABLE rooms ADD COLUMN frozen_at INTEGER;
  ALTER TABLE rooms ADD COLUMN frozen_paused INTEGER NOT NULL DEFAULT 0;
  -- 在大厅里申请加入公开的对局：房主（或能管这一局的管理员）同意了才进来，处理过、撤回的就删掉
  CREATE TABLE join_requests (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  `,

  // ---------- 第 15 版（V0.5.0）：剧本投稿和作者、关注作者；宠物和龙晶 ----------
  `
  -- 房主把这一局 AI 生成、导入的剧本投稿到剧本大厅：管理员审核，通过的存成 scenarios 文件夹里的文件（scenario_key）
  CREATE TABLE scenario_submissions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    intro TEXT NOT NULL,
    data TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    reason TEXT NOT NULL DEFAULT '',
    scenario_key TEXT,
    created_at INTEGER NOT NULL,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at INTEGER
  );
  CREATE INDEX scenario_submissions_status ON scenario_submissions(status, id);
  CREATE INDEX scenario_submissions_user ON scenario_submissions(user_id, id);
  -- 剧本大厅里用户投稿的剧本是谁写的（自带的、管理员上传的没有这一行，作者写在剧本文件里）
  CREATE TABLE scenario_authors (
    scenario_key TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id INTEGER REFERENCES scenario_submissions(id) ON DELETE SET NULL,
    published_at INTEGER NOT NULL
  );
  CREATE INDEX scenario_authors_user ON scenario_authors(user_id);
  -- 关注作者：作者有新作品通过审核时，关注的人收到通知
  CREATE TABLE follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, author_id)
  );
  CREATE INDEX follows_author ON follows(author_id);
  -- 龙晶：宠物的货币，记在账号上（还没养宠物时玩完剧本得的也记着）
  ALTER TABLE users ADD COLUMN crystals INTEGER NOT NULL DEFAULT 0;
  -- 宠物：每个正式账号一只。饱食度、精力按 state_at 那一刻的值和过去的时间算；打工中的记着哪份工、什么时候回来
  CREATE TABLE pets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image_type TEXT,
    image BLOB,
    image_at INTEGER,
    title TEXT,
    satiety REAL NOT NULL,
    energy REAL NOT NULL,
    state_at INTEGER NOT NULL,
    job TEXT,
    job_started_at INTEGER,
    job_ends_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pets_job ON pets(job_ends_at);
  -- 玩完剧本的成长：一局只算一次（对局删了也不丢）。attribute 是剧本分区对应的属性，剧本没有分区的是 NULL（只给龙晶）。
  -- 对局删掉以后编号可能给新的对局再用：认一局要连着它建的时间（room_created_at）一起认
  CREATE TABLE pet_growth (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    attribute TEXT,
    scenario_title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (room_id, room_created_at, user_id)
  );
  CREATE INDEX pet_growth_user ON pet_growth(user_id);
  -- 背包：吃的、提神茶、改名卡的个数；买过的称号（个数是 1）
  CREATE TABLE pet_items (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_id, item)
  );
  -- 龙晶的每一笔进出：打工、玩完剧本、买东西、换额度、管理员发
  CREATE TABLE crystal_ledger (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX crystal_ledger_user ON crystal_ledger(user_id, id);
  -- 龙晶换 AI 额度：每人每月、全站每月的上限按这张表算
  CREATE TABLE crystal_exchanges (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    crystals INTEGER NOT NULL,
    cny REAL NOT NULL,
    usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX crystal_exchanges_time ON crystal_exchanges(created_at);
  CREATE INDEX crystal_exchanges_user ON crystal_exchanges(user_id, created_at);
  -- 带进这一局的宠物（只陪伴）：带进来那一刻的名字和介绍，JSON
  ALTER TABLE characters ADD COLUMN pet TEXT;
  `,

  // ---------- 第 16 版（V0.6.0）：宠物切磋、串门、远行、日记、装扮；结局图鉴、成就、账号的称号；剧本评分、作者分成；
  // 主持风格、骰子皮肤、宠物出手；限时活动 ----------
  `
  -- 称号从宠物身上改到账号上（没养宠物也能戴成就得来的称号）；骰子皮肤
  ALTER TABLE users ADD COLUMN title TEXT;
  ALTER TABLE users ADD COLUMN dice_skin TEXT;
  UPDATE users SET title = (SELECT p.title FROM pets p WHERE p.user_id = users.id)
    WHERE id IN (SELECT user_id FROM pets WHERE title IS NOT NULL);
  -- 宠物戴着的装扮；远行：去的是 near（附近转转）还是 far（出远门），什么时候回来
  ALTER TABLE pets ADD COLUMN outfit TEXT;
  ALTER TABLE pets ADD COLUMN trip TEXT;
  ALTER TABLE pets ADD COLUMN trip_started_at INTEGER;
  ALTER TABLE pets ADD COLUMN trip_ends_at INTEGER;
  CREATE INDEX pets_trip ON pets(trip_ends_at);
  -- 串门：喂吃的（item 是喂的东西）、摸摸头；rewarded 是这一次给了两边龙晶（每天第一次）
  CREATE TABLE pet_visits (
    id INTEGER PRIMARY KEY,
    visitor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('feed', 'pat')),
    item TEXT,
    rewarded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pet_visits_pair ON pet_visits(visitor_id, owner_id, created_at);
  CREATE INDEX pet_visits_owner ON pet_visits(owner_id, id);
  -- 宠物主页上的留言：主人、写的人能删，管理员能删（删了留着一行，举报里看得到原文）
  CREATE TABLE pet_notes (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX pet_notes_owner ON pet_notes(owner_id, id);
  CREATE INDEX pet_notes_author ON pet_notes(author_id, created_at);
  -- 宠物的日记（玩完一局写的，room_id 和 room_created_at 认是哪一局，一局只写一篇）和明信片（远行带回来的）。
  -- 日记要等 AI 写：先存一行 status = 'writing'，写好了改成 'done'
  CREATE TABLE pet_diary (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('diary', 'postcard')),
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    room_id INTEGER,
    room_created_at INTEGER,
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('writing', 'done')),
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, room_id, room_created_at)
  );
  CREATE INDEX pet_diary_user ON pet_diary(user_id, id);
  -- 结局图鉴：剧本大厅里的剧本（scenario_key）每个结局第一次达成的时间
  CREATE TABLE endings_reached (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario_key TEXT NOT NULL,
    ending_key TEXT NOT NULL,
    ending_title TEXT NOT NULL,
    scenario_title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scenario_key, ending_key)
  );
  CREATE INDEX endings_reached_scenario ON endings_reached(scenario_key);
  -- 成就：key 是成就的编号（活动称号是 event-活动编号），title 是得到的称号
  CREATE TABLE achievements (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  -- 剧本评分：每人每个剧本一条，能改；短评被管理员删了以后星还在
  CREATE TABLE scenario_ratings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario_key TEXT NOT NULL,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    comment_deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, scenario_key)
  );
  CREATE INDEX scenario_ratings_key ON scenario_ratings(scenario_key);
  -- 作者分成：投稿的剧本被别人玩完一局给作者的龙晶（一局只给一次）
  CREATE TABLE author_plays (
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    scenario_key TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, room_created_at)
  );
  CREATE INDEX author_plays_author ON author_plays(author_id, created_at);
  -- 限时活动：哪些分区的剧本龙晶翻倍（JSON）、限时商品（JSON）、活动称号（空的是没有）；ends_at 那一刻结束
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    categories TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  -- 第一个活动：万圣节（日本时间 10 月 28 日 0 点到 11 月 4 日 0 点）
  INSERT INTO events (name, starts_at, ends_at, categories, items, title, created_at)
    VALUES ('万圣节', 1793113200000, 1793718000000, '["horror"]', '["outfit-pumpkin","outfit-ghost","dice-pumpkin"]', '南瓜灯',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  -- 自带角色卡：每个正式账号可以做几张。属性按点数记（10 点 = +1，JSON），专长、带着的装备是 JSON。
  -- growth 是已经用掉的成长点，pending 是攒着还没用的（加起来最多 30）；used_at 是第一次带进剧本的时间（用过以后不能重新分点）
  CREATE TABLE character_cards (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    appearance TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT '',
    attributes TEXT NOT NULL,
    specialties TEXT NOT NULL,
    gear TEXT NOT NULL DEFAULT '[]',
    growth INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX character_cards_user ON character_cards(user_id);
  -- 角色卡的经历：带着它玩完的剧本（一局只算一次），points 是这一局给的成长点
  CREATE TABLE card_history (
    card_id INTEGER NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    scenario_title TEXT NOT NULL,
    ending_title TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (card_id, room_id, room_created_at)
  );
  -- 这一局的角色是用哪张角色卡建的（用剧本身份自带的是 NULL）；角色卡上写的背景（发给主持 AI）；带进来的装备（JSON）
  ALTER TABLE characters ADD COLUMN card_id INTEGER REFERENCES character_cards(id) ON DELETE SET NULL;
  ALTER TABLE characters ADD COLUMN background TEXT NOT NULL DEFAULT '';
  ALTER TABLE characters ADD COLUMN gear TEXT;
  -- 开宝箱的记录（宝箱本身记在背包 pet_items 里，key 是 chest）：开出了什么（JSON）
  CREATE TABLE chest_opens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chest_opens_user ON chest_opens(user_id, id);
  -- 主持风格（JSON：文风、难度、会不会死、语言；没设是默认）
  ALTER TABLE rooms ADD COLUMN style TEXT;
  -- 宠物出手：交行动时勾了「让宠物帮一把」；结算里宠物帮着重掷的那一次检定
  ALTER TABLE actions ADD COLUMN pet_help INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rolls ADD COLUMN pet_help INTEGER NOT NULL DEFAULT 0;
  -- 网站向导的对话（每人留最近几十条）：接着问的时候带上最近几轮，不信网页传来的“以前的对话”
  CREATE TABLE guide_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX guide_messages_user ON guide_messages(user_id, id);
  -- 剧本大厅里的剧本每走到一次结局记一行（玩完了几次、几个人玩完、各个结局被达成过几次；作者看得到结局分布）
  CREATE TABLE scenario_finishes (
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    scenario_key TEXT NOT NULL,
    ending_key TEXT,
    ending_title TEXT,
    players INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, room_created_at)
  );
  CREATE INDEX scenario_finishes_key ON scenario_finishes(scenario_key);
  -- 玩过的人私下给作者的反馈（和公开的短评分开）；作者可以回复一次（能改），可以删（deleted_at）
  CREATE TABLE scenario_feedback (
    id INTEGER PRIMARY KEY,
    scenario_key TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    reply TEXT,
    replied_at INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX scenario_feedback_author ON scenario_feedback(author_id, id);
  CREATE INDEX scenario_feedback_user ON scenario_feedback(user_id, scenario_key);
  -- AI 审核（投稿、举报）：AI 的意见只给管理员参考，最后由管理员裁决。同一份可以审几次，看最新的一次
  CREATE TABLE ai_reviews (
    id INTEGER PRIMARY KEY,
    target_type TEXT NOT NULL CHECK (target_type IN ('submission', 'report')),
    target_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    verdict TEXT,
    summary TEXT NOT NULL DEFAULT '',
    details TEXT,
    model TEXT,
    error TEXT,
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX ai_reviews_target ON ai_reviews(target_type, target_id, id);
  `,

  // ---------- 第 17 版（V0.7.0）：规则第二版、角色卡和装备、地下城、角色切磋；头像框 ----------
  `
  -- 头像框（「装扮」页）
  ALTER TABLE users ADD COLUMN avatar_frame TEXT;
  -- 角色卡改成规则第二版：属性是七项整数（JSON），gear 是穿着的装备 {"weapon":id,"armor":id,"accessory":id}（gear_items 的 id），
  -- growth 是用掉的成长点，pending 是攒着没用的（不封顶）。第 16 版的角色卡没有入口、没有用过，按旧规则写的行清掉
  DELETE FROM card_history;
  UPDATE characters SET card_id = NULL WHERE card_id IS NOT NULL;
  DELETE FROM character_cards;
  DELETE FROM chest_opens;
  ALTER TABLE character_cards ADD COLUMN duel_wins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE character_cards ADD COLUMN duel_losses INTEGER NOT NULL DEFAULT 0;
  -- 学会的技能（JSON，技能编号，从秘籍研读来的）
  ALTER TABLE character_cards ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
  -- 卡的经历（地下城）：结果（clear 通关、escape 逃出来、fail 失败、dead 死了）、难度、带出来的东西（JSON）
  ALTER TABLE card_history ADD COLUMN scenario_key TEXT;
  ALTER TABLE card_history ADD COLUMN result TEXT;
  ALTER TABLE card_history ADD COLUMN level INTEGER;
  ALTER TABLE card_history ADD COLUMN loot TEXT;
  -- 账号的装备：同一种、同一稀有度只有一件（再得到折成龙晶）。base 是装备的种类（shared/gear2.ts），传奇的另有编号
  CREATE TABLE gear_items (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base TEXT NOT NULL,
    rarity TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, base, rarity)
  );
  -- 地下城里的角色（规则第二版）：生命值、精神值、濒死、失控、带进来的道具、这一局捡到的东西（JSON）
  ALTER TABLE characters ADD COLUMN v2 TEXT;
  -- 角色是用哪张角色卡建的（card_id，第 16 版加的）：「我的角色」、个人主页、切磋时每张卡都要查它在不在还没结束的局里
  CREATE INDEX characters_card ON characters(card_id);
  -- 地下城的通关记录：每一局走到结局记一行（结果、几个人、谁、真实用了多久、游戏里过了多久）
  CREATE TABLE dungeon_runs (
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    scenario_key TEXT,
    scenario_title TEXT NOT NULL,
    level INTEGER NOT NULL,
    size TEXT NOT NULL,
    result TEXT NOT NULL,
    players INTEGER NOT NULL,
    members TEXT NOT NULL,
    real_minutes INTEGER NOT NULL,
    game_minutes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, room_created_at)
  );
  CREATE INDEX dungeon_runs_key ON dungeon_runs(scenario_key, created_at);
  -- 角色切磋：谁挑战谁、用的哪张卡、谁赢了、每一轮（JSON）、两边各得了多少龙晶
  CREATE TABLE card_duels (
    id INTEGER PRIMARY KEY,
    challenger_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenger_card INTEGER REFERENCES character_cards(id) ON DELETE SET NULL,
    defender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    defender_card INTEGER REFERENCES character_cards(id) ON DELETE SET NULL,
    winner TEXT NOT NULL CHECK (winner IN ('challenger', 'defender')),
    detail TEXT NOT NULL,
    challenger_reward INTEGER NOT NULL DEFAULT 0,
    defender_reward INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX card_duels_challenger ON card_duels(challenger_id, created_at);
  CREATE INDEX card_duels_defender ON card_duels(defender_id, created_at);
  -- 常用的页面要的索引：大厅、「我的对局」按每一局最后一条记录的时间排（不用把这一局的记录全读一遍）；
  -- 剧本大厅、排行、管理页数每个剧本开过几局（不用把每一局存的整份剧本都读一遍）
  CREATE INDEX log_room_time ON log_entries(room_id, created_at);
  CREATE INDEX scenarios_key ON scenarios(source, scenario_key);
  -- 群聊（「社交」里）：群主（没有了就是最早进群的人）、解散了的（管理员还看得到记录）
  CREATE TABLE chat_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    disbanded_at INTEGER,
    disbanded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  -- 群成员：看到了哪一条（之后的算没读）
  CREATE TABLE chat_group_members (
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX chat_group_members_user ON chat_group_members(user_id);
  -- 群消息：system 是「谁进群了」这类提示；撤回的留着原文（管理员看得到），deleted_by 是谁撤回的
  CREATE TABLE chat_group_messages (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX chat_group_messages_group ON chat_group_messages(group_id, id);
  -- 使用规则加了一条「管理员看得到网站上的所有内容，包括私信和群聊」：以前同意过的正式账号下次登录时重新看一遍、再同意一次
  UPDATE users SET rules_agreed_at = NULL WHERE is_guest = 0 AND deleted_at IS NULL;
  `,
  // 18（V0.7.1）：去掉「始终计时」，加「不计时」（人不齐时在线的人也照样一轮一轮结算）；商城里管理员上架的商品；地下城投稿用的原剧本
  `
  UPDATE rooms SET always_timed = 0;
  ALTER TABLE rooms ADD COLUMN untimed INTEGER NOT NULL DEFAULT 0;
  -- 管理员上架的商品（自带的商品下架记在设置 shop_hidden 里）：kind 是 gear（ref 是 种类:稀有度）、manual（ref 是技能）、
  -- chest（宝箱）、item（ref 是吃的用的、地下城道具的编号）、title（自己起名字的称号，name 就是称号）；
  -- count：一份里有几个（道具、宝箱可以几个一起卖，别的都是 1）；下架了的 removed_at 有时间（买过的人照样有）
  CREATE TABLE shop_listings (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('gear', 'manual', 'chest', 'item', 'title')),
    ref TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
    price INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  -- 地下城装进对局时随机定下这一局的变化（rollDungeonRun），data 存的是定好的这一局；original 存原来的整份剧本，
  -- 投稿用它（定好的那一份少了别的变化和弱点，审核过不了）。别的剧本 original 是 NULL，投稿用 data
  ALTER TABLE scenarios ADD COLUMN original TEXT;
  `,
  // 19（V0.8.0）：约团、浏览器推送、AI 补位、名场面、网页剧本编辑器、稳定性
  `
  -- ===== 约团 =====
  -- 约团：房主列几个候选时间，成员勾能不能来，房主定下一个，开始前 30 分钟提醒。时间都是 UTC 毫秒。
  -- status：open 正在勾、confirmed 定下了、cancelled 作废了（房主取消了，或者重新列了时间）；一局同时只有一个 open 或 confirmed 的。
  -- created_by：谁列的（房主）。confirmed_slot_id、starts_at：定下的是哪个时间、几点开始（和那个候选时间一样，提醒按它查）。
  -- reminded_at：开始前的提醒发过的时间（发过就不再发，重启也不重复）
  CREATE TABLE schedule_polls (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'cancelled')),
    confirmed_slot_id INTEGER,
    starts_at INTEGER,
    reminded_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX schedule_polls_room ON schedule_polls(room_id);
  CREATE UNIQUE INDEX schedule_polls_active ON schedule_polls(room_id) WHERE status IN ('open', 'confirmed');
  -- 每分钟找快开始、还没提醒的
  CREATE INDEX schedule_polls_due ON schedule_polls(status, starts_at);
  -- 候选时间（一个约团 1～6 个）
  CREATE TABLE schedule_slots (
    id INTEGER PRIMARY KEY,
    poll_id INTEGER NOT NULL REFERENCES schedule_polls(id) ON DELETE CASCADE,
    starts_at INTEGER NOT NULL
  );
  CREATE INDEX schedule_slots_poll ON schedule_slots(poll_id);
  -- 每个人对每个时间勾的：yes 能来、maybe 也许、no 来不了（没勾的没有这一行）。显示时只算现在的成员
  CREATE TABLE schedule_votes (
    slot_id INTEGER NOT NULL REFERENCES schedule_slots(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answer TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (slot_id, user_id)
  );
  CREATE INDEX schedule_votes_user ON schedule_votes(user_id);
  -- ===== 约团完 =====

  -- ===== 浏览器推送 =====
  -- 浏览器推送的订阅：一个浏览器一条。endpoint 是推送服务给的地址（唯一：同一个浏览器换了账号就归新账号）；
  -- p256dh、auth 是浏览器给的加密用的公钥和密钥（base64url）；label 是从浏览器标识认出来的设备名；
  -- last_ok_at 是最近一次推送服务收下的时间。服务器自己的密钥（VAPID）存在设置 push_vapid 里。
  -- session_id：订阅时的那次登录。退出登录、改密码、「退出其他设备」、封号删掉了登录，这台设备的订阅跟着删掉；
  -- 登录过期了的不发（重新登录后网页会再交一次，绑到新的登录上）
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id, created_at);
  CREATE INDEX push_subscriptions_session ON push_subscriptions(session_id);
  -- 每人推哪几类（JSON：{ schedule, started, turn, dm, invites, other }）；没有这一行就按默认的
  CREATE TABLE push_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- ===== 浏览器推送完 =====

  -- ===== AI 补位 =====
  -- 房主在准备阶段把没人选的身份交给 AI 演（主持 AI 顺带演，当作跟着大家的队友；不建角色、不建账号）。
  -- name 是 AI 队友的名字（房主没起名字就是身份的名字）。换剧本时清掉；对局删了一起删
  CREATE TABLE ai_seats (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, role_key)
  );
  -- 开局以后中途加入的玩家接替 AI 队友、又换了名字时，记下他之前在故事里叫什么（只给主持 AI 看；别的角色是空的）
  ALTER TABLE characters ADD COLUMN former_name TEXT;
  -- ===== AI 补位完 =====

  -- ===== 名场面 =====
  -- 成员收藏的对局记录（私人的，别人看不到谁收藏了什么）。撤回结算会删掉那次的记录：收藏跟着删（log_id 的外键）；
  -- 账号、对局删了也一起删。索引：按人按局列出来（room_id + user_id，也给删对局时用）、删记录时按 log_id 找
  CREATE TABLE highlights (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    log_id INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, log_id)
  );
  CREATE INDEX highlights_room_user ON highlights(room_id, user_id);
  CREATE INDEX highlights_log ON highlights(log_id);
  -- ===== 名场面完 =====

  -- ===== 剧本编辑器 =====
  -- 网页剧本编辑器的草稿：data 是整份剧本的 JSON 文本（可以还没写完、有错误），title 从 data.title 取（列表里显示）。
  -- 只有自己看得到；账号删了一起删
  CREATE TABLE scenario_drafts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX scenario_drafts_user ON scenario_drafts(user_id, updated_at);
  -- ===== 剧本编辑器完 =====

  -- ===== 稳定性 =====
  -- ===== 稳定性完 =====
  SELECT 1;
  `,
  // 20（V0.8.1）：角色卡在不在个人主页上展示（默认展示，主人在「我的角色」里改）
  `
  ALTER TABLE character_cards ADD COLUMN on_profile INTEGER NOT NULL DEFAULT 1;
  `,
  // 21（V0.9.0）：5E 规则。5E 角色卡和龙娘角色卡分开存：data 是卡上的全部选择（JSON，shared/5e/types.ts 的 Card5eData：
  // 职业、种族、背景、属性、技能、法术、装备、等级……）。on_profile：在不在个人主页上展示。
  // 打完的 5E 模组记在 card5e_history：那时几级、活没活下来、算不算（counted：剧本大厅里的模组才升级、带出东西）、带出来的东西。
  // 对局里的 5E 角色：card5e_id 是用哪张 5E 卡进来的，v5 是这一局的状态（生命值、法术位、资源、状态、物品，JSON）
  `
  CREATE TABLE cards5e (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    appearance TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    on_profile INTEGER NOT NULL DEFAULT 1,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cards5e_user ON cards5e(user_id);
  CREATE TABLE card5e_history (
    card_id INTEGER NOT NULL REFERENCES cards5e(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL,
    room_created_at INTEGER NOT NULL,
    scenario_key TEXT,
    scenario_title TEXT NOT NULL,
    ending_title TEXT,
    level INTEGER NOT NULL,
    survived INTEGER NOT NULL,
    counted INTEGER NOT NULL,
    loot TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (card_id, room_id, room_created_at)
  );
  ALTER TABLE characters ADD COLUMN card5e_id INTEGER REFERENCES cards5e(id) ON DELETE SET NULL;
  ALTER TABLE characters ADD COLUMN v5 TEXT;
  CREATE INDEX characters_card5e ON characters(card5e_id);
  `,
  // 22（V0.9.1）：每次 AI 调用这一回调用了哪些工具（JSON 数组，工具的名字，没调用是空），整局排查包里看得到主持 AI 每一轮在做什么
  `
  ALTER TABLE ai_calls ADD COLUMN tools TEXT;
  `,
  // 23（V1.0.0 正式版）：删档。内测的数据全部清掉，正式版从零开始：所有账号（包括站长，升级以后重新建）、对局、公告，
  // 投稿和评分、游玩记录、排行，聊天、好友、通知，举报、违规、操作记录、AI 花费记录，邀请码、兑换码。
  // 留下网站的设置（settings：AI 模型和开关、商城价格、注册方式……）、限时活动、商城上架的商品。升级前照常先备份整个数据库。
  // 有数据的才记一笔（beta_wipe）：清掉了多少；投稿通过的剧本文件（scenarios 里的 sub-*.json）由程序挪进备份文件夹（beta-wipe.ts）。
  // 版本更新公告发到了哪一版也忘掉：像全新的网站一样只发 V1.0.0 的那一条（从 V0.8.x 升级上来，不补发 V0.9.x 的）
  `
  INSERT OR REPLACE INTO settings (key, value)
    SELECT 'beta_wipe', json_object(
      'pending', 1,
      'users', (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND deleted_at IS NULL),
      'guests', (SELECT COUNT(*) FROM users WHERE is_guest = 1),
      'rooms', (SELECT COUNT(*) FROM rooms),
      'announcements', (SELECT COUNT(*) FROM announcements),
      'submissions', (SELECT COUNT(*) FROM scenario_submissions),
      'at', CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
    WHERE EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM rooms);
  DELETE FROM settings WHERE key = 'release_notes_posted';
  DELETE FROM rooms;
  DELETE FROM invites;
  DELETE FROM announcements;
  DELETE FROM chat_groups;
  DELETE FROM credit_codes;
  DELETE FROM scenario_authors;
  DELETE FROM scenario_submissions;
  DELETE FROM users;
  DELETE FROM achievements;
  DELETE FROM actions;
  DELETE FROM admin_audit;
  DELETE FROM ai_call_shares;
  DELETE FROM ai_calls;
  DELETE FROM ai_reviews;
  DELETE FROM ai_seats;
  DELETE FROM announcement_reads;
  DELETE FROM announcement_targets;
  DELETE FROM author_plays;
  DELETE FROM avatars;
  DELETE FROM blocks;
  DELETE FROM card5e_history;
  DELETE FROM card_duels;
  DELETE FROM card_history;
  DELETE FROM cards5e;
  DELETE FROM character_cards;
  DELETE FROM characters;
  DELETE FROM chat_group_members;
  DELETE FROM chat_group_messages;
  DELETE FROM chest_opens;
  DELETE FROM clues;
  DELETE FROM credit_code_uses;
  DELETE FROM credit_grants;
  DELETE FROM crystal_exchanges;
  DELETE FROM crystal_ledger;
  DELETE FROM devices;
  DELETE FROM direct_messages;
  DELETE FROM dungeon_runs;
  DELETE FROM endings_reached;
  DELETE FROM follows;
  DELETE FROM friendships;
  DELETE FROM gear_items;
  DELETE FROM guide_messages;
  DELETE FROM highlights;
  DELETE FROM join_requests;
  DELETE FROM knowledge;
  DELETE FROM lobby_messages;
  DELETE FROM log_entries;
  DELETE FROM login_places;
  DELETE FROM notes;
  DELETE FROM notifications;
  DELETE FROM pet_diary;
  DELETE FROM pet_growth;
  DELETE FROM pet_items;
  DELETE FROM pet_notes;
  DELETE FROM pet_visits;
  DELETE FROM pets;
  DELETE FROM players;
  DELETE FROM push_prefs;
  DELETE FROM push_subscriptions;
  DELETE FROM reports;
  DELETE FROM resolution_snapshots;
  DELETE FROM rolls;
  DELETE FROM room_invites;
  DELETE FROM scenario_drafts;
  DELETE FROM scenario_feedback;
  DELETE FROM scenario_finishes;
  DELETE FROM scenario_jobs;
  DELETE FROM scenario_ratings;
  DELETE FROM scenarios;
  DELETE FROM schedule_polls;
  DELETE FROM schedule_slots;
  DELETE FROM schedule_votes;
  DELETE FROM sessions;
  DELETE FROM signups;
  DELETE FROM violations;
  `,
  // 24（V1.0.x 站位）：角色在一个地点里站在哪（剧本里这个地点的站位，或者主持人起的短名字）；没特别站在哪、和大家在一起是 NULL。
  // 换地点时清空。只在主持人结算时改（和位置一样随结算写回）
  `
  ALTER TABLE characters ADD COLUMN spot TEXT;
  `,
  // 25（V1.1.0 AI 大厅）：玩家自己做的 AI 角色（名字、简介、人设）。public：放进 AI 大厅（谁都看得到人设、能邀请）；
  // 不公开的只有作者自己能请进对局。编号不重复使用（AUTOINCREMENT：删掉以后新做的不会拿到同一个编号，按旧的举报下架不会删错）。
  // invites：请它进过对局（开了局）的不同房主有几个，作者自己不算（大厅按它排）；ai_persona_invites 记着谁请过。
  // 交给 AI 演的身份可以请一个 AI 角色来演：persona 是请进来那一刻的样子（JSON：名字、简介、人设、作者），之后作者改了、删了，这一局照旧；
  // persona_id 是大厅里的那个（删掉了就空着）。没有 persona 的照旧是主持人顺带演
  `
  CREATE TABLE ai_personas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    intro TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    invites INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ai_personas_user ON ai_personas(user_id);
  CREATE INDEX ai_personas_hall ON ai_personas(public, invites);
  CREATE TABLE ai_persona_invites (
    persona_id INTEGER NOT NULL REFERENCES ai_personas(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (persona_id, user_id)
  );
  ALTER TABLE ai_seats ADD COLUMN persona_id INTEGER REFERENCES ai_personas(id) ON DELETE SET NULL;
  ALTER TABLE ai_seats ADD COLUMN persona TEXT;
  CREATE INDEX ai_seats_persona ON ai_seats(persona_id);
  `,
  // 26（AI 角色的 5E 角色卡）：作者做 AI 角色时可以顺带做一张 5E 角色卡（和「我的角色 → 5E 角色」一样的卡），
  // 请进 5E 对局时按它算生命值、AC、职业和法术。card5e 是 JSON：{ data: Card5eData, appearance, background }；没做是 NULL。
  `
  ALTER TABLE ai_personas ADD COLUMN card5e TEXT;
  `,
];

/** 数据是更新的版本留下的（数据库的版本比这个程序认识的新）：打开会弄坏数据，不打开。 */
export class DataTooNewError extends Error {}

/** 数据库现在是第几版（就是执行过几次升级）。 */
export function schemaVersion(db: DB): number {
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/**
 * 打开数据库，需要的话先升级。
 * 已经有数据、要升级时（换了新版本），升级前先在 backups 文件夹里备份一份；onBackup 收到备份文件的路径。
 * upTo 只给测试用：只升级到第几版（测以前的升级时停在第 22 版，不让第 23 版的正式版删档把要看的数据清掉）。
 */
export function openDatabase(
  file: string,
  options: { onBackup?: (file: string, from: number, to: number) => void; upTo?: number } = {},
): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate(db, file, options.onBackup ?? defaultOnBackup, Math.min(options.upTo ?? MIGRATIONS.length, MIGRATIONS.length));
    // 记下最后是哪个版本打开的：数据被更新的版本用过、又拿旧版本打开时，提示里能说出是哪个版本
    setSetting(db, 'app_version', APP_VERSION);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function defaultOnBackup(file: string, from: number, to: number) {
  console.log(`数据库要从第 ${from} 版升级到第 ${to} 版，升级前先备份了一份：${file}`);
}

/** 数据库的版本比这个程序认识的新（被更新的版本用过）时，打开会弄坏数据：抛出 DataTooNewError。不改数据库，只读的连接也能用。 */
export function assertNotTooNew(db: DB, file: string) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  const current = hasTable ? schemaVersion(db) : 0;
  if (current <= MIGRATIONS.length) return;
  let by = '';
  try {
    const last = getSetting(db, 'app_version');
    if (last) by = ` ${versionLabel(last)}`;
  } catch {
    // 没有设置表：说不出是哪个版本
  }
  throw new DataTooNewError(
    `这份数据（${file}）被更新的版本${by}用过，数据库已经是第 ${current} 版；这个版本（${versionLabel()}）只认识到第 ${MIGRATIONS.length} 版，打不开它。\n` +
      '请用新版本启动。要回到这个版本，用这个版本自己的数据，或者 backups 文件夹里升级前的备份（见 README「用备份恢复」）。',
  );
}

function migrate(db: DB, file: string, onBackup: (file: string, from: number, to: number) => void, upTo: number) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  const current = row?.version ?? 0;
  assertNotTooNew(db, file);
  // 已经有数据、要升级：先备份。全新的数据库（第 0 版）不用备份
  if (current > 0 && current < upTo && file !== ':memory:') {
    onBackup(backupDatabase(db, file, 'upgrade'), current, upTo);
  }
  for (let version = current; version < upTo; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    });
  }
}

/** 每个数据库现在套了几层事务（事务里再调用自己开事务的函数时，里面那层用保存点）。 */
const depthOf = new WeakMap<DB, number>();

export function transaction<T>(db: DB, fn: () => T): T {
  const depth = depthOf.get(db) ?? 0;
  const savepoint = `nested_${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  depthOf.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  } finally {
    depthOf.set(db, depth);
  }
}
