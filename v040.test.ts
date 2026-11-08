import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app';
import { openDatabase } from '../server/db';
import { TEST_ACCOUNTS } from '../server/seed-data';
import { ALL_PERMISSIONS } from '../shared/admin';
import { testScenarioDir } from './helpers';

// V0.4.0：第一次运行只建站长账号（start.bat 发现还没有数据时运行 npm run reset -- --first-run），不建测试账号，朋友们拿邀请码自己注册。

const RESET = path.resolve(import.meta.dirname, '..', 'server', 'reset.ts');
const SEED = path.resolve(import.meta.dirname, '..', 'server', 'seed.ts');

/** 运行一个命令行脚本，按顺序回答（不是在窗口里运行，按行读）。 */
function runScript(args: string[], dbPath: string, port: number, input = '') {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

/** npm run reset -- --first-run（start.bat 发现还没有数据时就这样运行）。 */
const firstRun = (dbPath: string, scenarios: string, port: number, input: string) =>
  runScript([RESET, '--first-run', `--scenario-dir=${scenarios}`], dbPath, port, input);

/** npm run seed */
const seed = (dbPath: string, port: number) => runScript([SEED], dbPath, port);

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function users(dbPath: string) {
  const db = openDatabase(dbPath, { onBackup: () => {} });
  try {
    return (db.prepare('SELECT username, display_name, uid, is_owner, is_admin, is_guest FROM users ORDER BY id').all() as Record<string, unknown>[]).map((u) => ({ ...u }));
  } finally {
    db.close();
  }
}

test('第一次运行：只建站长账号（0 号），不问「清空」、不建测试账号、不备份、不挪剧本文件；AI 关着；朋友拿邀请码注册是 1 号', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-first-'));
  try {
    const port = await freePort();
    const scenarios = testScenarioDir(dir);
    const scenarioFiles = fs.readdirSync(scenarios).sort();
    assert.ok(scenarioFiles.includes('fog-harbor-inn.json'), '有一个不是自带的剧本文件（像自己放进去的那样）');
    const dbPath = path.join(dir, 'data', 'game.db');

    // 端口上有服务器开着：不建，叫你关掉以后再双击 start.bat
    const busy = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => busy.listen(port, '127.0.0.1', resolve));
    try {
      const r = await firstRun(dbPath, scenarios, port, 'boss\n\nboss-pass-2026\nboss-pass-2026\n');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /服务器还开着.*再双击 start\.bat/);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
    assert.ok(!fs.existsSync(dbPath), '没有建数据库');

    // 问到一半输入断了（比如关掉了窗口）：什么都不建，下次双击 start.bat 还会问
    let r = await firstRun(dbPath, scenarios, port, 'boss\n');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /没有读到输入，什么都没改/);
    assert.ok(!fs.existsSync(dbPath), '没有建数据库');

    // 答完：用户名、密码不合要求会重新问
    r = await firstRun(dbPath, scenarios, port, 'b!\nboss\n大当家\nshort\nboss-pass-2026\nboss-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /第一次运行，先建你的站长账号/);
    assert.doesNotMatch(r.out, /确定清空吗|会删掉|备份|挪/);
    assert.match(r.out, /用户名要用3～20位字母、数字或下划线/);
    assert.match(r.out, /密码至少8位/);
    assert.match(r.out, /站长账号：boss（UID 0）/);
    assert.match(r.out, /AI：关着/);
    assert.match(r.out, /「管理」→「邀请码」/);
    assert.deepEqual(fs.readdirSync(scenarios).sort(), scenarioFiles, '剧本文件一个都没挪');
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'backups')), '新建的数据库不用备份');

    assert.deepEqual(users(dbPath), [{ username: 'boss', display_name: '大当家', uid: 0, is_owner: 1, is_admin: 1, is_guest: 0 }]);
    const db = openDatabase(dbPath, { onBackup: () => {} });
    try {
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.deepEqual([count('rooms'), count('invites'), count('announcements')], [0, 0, 0], '没有示例对局、测试邀请码');
      const owner = db.prepare('SELECT admin_perms, rules_agreed_at FROM users').get() as { admin_perms: string; rules_agreed_at: number | null };
      assert.deepEqual(JSON.parse(owner.admin_perms), [...ALL_PERMISSIONS]);
      assert.ok(owner.rules_agreed_at);
      assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'ai_enabled'").get() as { value: string }).value, '0');
      assert.deepEqual(
        (db.prepare('SELECT action, detail FROM admin_audit').all() as Record<string, unknown>[]).map((a) => ({ ...a })),
        [{ action: '建站长账号', detail: '第一次运行时建了站长账号' }],
      );
    } finally {
      db.close();
    }

    // 已经有数据了再运行：什么都不做
    r = await firstRun(dbPath, scenarios, port, 'other\n\nother-pass-2026\nother-pass-2026\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已经有数据了/);
    assert.equal(users(dbPath).length, 1);

    // 有了真正的站长：npm run seed 不往里加测试账号（测试账号的密码是公开的）
    r = await seed(dbPath, port);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /已经有站长了.*不往这里加/);
    assert.doesNotMatch(r.out, /admin-trpg-2026/);
    assert.equal(users(dbPath).length, 1);

    // 打开网站：站长能登录，测试账号登录不了；站长生成邀请码，朋友注册是 1 号
    const app = createApp({ dbPath, webDist: path.join(dir, 'dist'), scenarioDir: scenarios, rateLimits: false });
    const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
    const post = (url: string, body: unknown, cookie?: string) =>
      fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    try {
      const login = await post('/api/auth/login', { username: 'boss', password: 'boss-pass-2026' });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie()[0].split(';')[0];
      for (const account of TEST_ACCOUNTS) {
        assert.equal((await post('/api/auth/login', { username: account.username, password: account.password })).status, 401, `${account.username} 不存在`);
      }
      const invite = await (await post('/api/admin/invites', { note: '朋友' }, cookie)).json();
      const reg = await post('/api/auth/register', {
        inviteCode: invite.invite.code,
        username: 'friend1',
        displayName: '朋友',
        password: 'friend-pass-1',
        agreeRules: true,
      });
      assert.equal(reg.status, 201);
      assert.equal((app.db.prepare("SELECT uid FROM users WHERE username = 'friend1'").get() as { uid: number }).uid, 1);
      const ai = await (await fetch(`${base}/api/admin/ai`, { headers: { cookie } })).json();
      assert.equal(ai.enabled, false);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run seed：还没有数据、或者站长是测试账号 admin 的一份里照常加测试账号；站长改过密码的、站长不是 admin 的都不加', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-seed-'));
  try {
    const port = await freePort();
    const dbPath = path.join(dir, 'data', 'game.db');
    let r = await seed(dbPath, port);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /测试数据已准备好/);
    const seeded = users(dbPath);
    assert.equal(seeded.length, TEST_ACCOUNTS.length);
    assert.deepEqual(seeded[0], { username: 'admin', display_name: '测试管理员', uid: 0, is_owner: 1, is_admin: 1, is_guest: 0 });
    // 再运行一次：测试账号的密码恢复成文件里的值
    r = await seed(dbPath, port);
    assert.equal(r.code, 0, r.out);
    assert.equal(users(dbPath).length, TEST_ACCOUNTS.length);
    // 测试站长的密码改过了：当它是真正在用的网站，不动
    const db = openDatabase(dbPath, { onBackup: () => {} });
    db.prepare("UPDATE users SET password_hash = 'changed' WHERE username = 'admin'").run();
    db.close();
    r = await seed(dbPath, port);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /已经有站长了/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
