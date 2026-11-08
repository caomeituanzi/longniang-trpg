import { verifyPassword } from './auth';
import { config } from './config';
import { DataTooNewError, openDatabase, type DB } from './db';
import { seedTestData, TEST_ACCOUNTS } from './seed-data';

// 只在自己电脑上测试用：建六个测试账号、四个示例对局和一个注册邀请码。测试账号的密码是公开的（写在 seed-data.ts 里），
// 所以已经有真正的站长（不是测试账号 admin）的数据里不加：朋友们在用的网站上不能多出谁都能登录的账号。

let db: DB;
try {
  db = openDatabase(config.dbPath);
} catch (err) {
  // 数据是更新的版本留下的：说清楚就退出
  if (err instanceof DataTooNewError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
const [TEST_OWNER] = TEST_ACCOUNTS;
const owner = db.prepare('SELECT username, password_hash FROM users WHERE is_owner = 1').get() as { username: string; password_hash: string } | undefined;
if (owner && !(owner.username === TEST_OWNER.username && (await verifyPassword(TEST_OWNER.password, owner.password_hash)))) {
  db.close();
  console.error('\n这份数据里已经有站长了（不是测试账号）：测试账号的密码是公开的，不往这里加。');
  console.error('要用测试账号试，另外解压一份，装好依赖（npm install）以后先运行 npm run seed，再双击 start.bat。\n');
  process.exit(1);
}
const { createdRooms, inviteCode } = await seedTestData(db);
db.close();

const base = `http://localhost:${config.port}`;
console.log('\n测试数据已准备好（只用于本地测试）。\n');
console.log('测试账号：');
for (const a of TEST_ACCOUNTS) {
  console.log(`  ${a.displayName.padEnd(6, '　')}  用户名 ${a.username.padEnd(8)}  密码 ${a.password}${a.isAdmin ? '  （管理员）' : ''}`);
}
console.log(
  `\n测试对局：单人试玩（admin 一个人，角色已建好）、雾港旅店（3人，剧本已选好）、六人局（6个账号，角色都已建好）、山寺夜话（2人）` +
    `${createdRooms.length ? '' : '，之前已经建好，这次没有重复创建'}`,
);
console.log(`测试用邀请码：${inviteCode}  注册链接：${base}/register?code=${inviteCode}\n`);
