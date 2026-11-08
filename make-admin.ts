import { ALL_PERMISSIONS } from '../shared/admin';
import { config } from './config';
import { DataTooNewError, openDatabase, transaction, type DB } from './db';

/**
 * 在运行服务器的这台电脑上改管理员（能碰到这台电脑的人就是最终说了算的人，所以不用登录）。
 *   npm run make-admin -- 用户名            设为管理员（全部权限）；网站还没有站长时，直接设为站长
 *   npm run make-admin -- 用户名 --owner    设为站长（原来的站长变成有全部权限的管理员）。站长账号进不去了，用这个换
 *   npm run make-admin -- 用户名 --remove   取消管理员（站长不能取消，先用 --owner 把站长换给别人）
 * 改完立即生效，对方不用重新登录。
 */
const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const remove = args.includes('--remove');
const owner = args.includes('--owner');

if (!username || (remove && owner)) {
  console.log('\n用法：npm run make-admin -- 用户名');
  console.log('设为站长：npm run make-admin -- 用户名 --owner');
  console.log('取消管理员：npm run make-admin -- 用户名 --remove\n');
  process.exit(1);
}

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

const ALL = JSON.stringify(ALL_PERMISSIONS);

try {
  const user = db.prepare('SELECT id, username, display_name, is_admin, is_owner, is_guest FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; display_name: string; is_admin: number; is_owner: number; is_guest: number }
    | undefined;
  const name = user ? `${user.display_name}（${user.username}）` : '';
  if (!user) {
    console.error(`\n找不到用户名为「${username}」的账号。可以在「管理」页的账号列表里核对用户名。\n`);
    process.exitCode = 1;
  } else if (user.is_guest) {
    console.error('\n游客账号不能当管理员，请让他注册一个正式账号。\n');
    process.exitCode = 1;
  } else if (remove) {
    if (user.is_owner) {
      console.error('\n这是站长的账号，不能直接取消。先用 --owner 把站长换给别人，再取消。\n');
      process.exitCode = 1;
    } else if (!user.is_admin) {
      console.log(`\n${name} 本来就不是管理员。\n`);
    } else {
      // 变回普通用户：不限额度也取消（和网页上撤销管理员一样）
      db.prepare("UPDATE users SET is_admin = 0, admin_perms = '[]', ai_unlimited = 0 WHERE id = ?").run(user.id);
      console.log(`\n已取消 ${name} 的管理员身份，不限额度也取消了。\n`);
    }
  } else if (owner || !db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) {
    if (user.is_owner) {
      console.log(`\n${name} 已经是站长了。\n`);
    } else {
      transaction(db, () => {
        // 原来的站长变成有全部权限的管理员（额度照旧不限）
        db.prepare('UPDATE users SET is_owner = 0, admin_perms = ?, ai_unlimited = 1 WHERE is_owner = 1').run(ALL);
        db.prepare("UPDATE users SET is_admin = 1, is_owner = 1, admin_perms = '[]', banned_at = NULL, ban_reason = NULL, banned_until = NULL WHERE id = ?").run(user.id);
      });
      console.log(`\n${name} 现在是站长了（最高权限，可以在「管理」→「管理员」里任命管理员、下发权限）。\n`);
    }
  } else if (user.is_owner) {
    console.log(`\n${name} 是站长，本来就有全部权限。\n`);
  } else {
    db.prepare('UPDATE users SET is_admin = 1, admin_perms = ? WHERE id = ?').run(ALL, user.id);
    console.log(`\n${name} 现在是管理员了（全部权限）。站长可以在「管理」→「管理员」里调整他的权限。\n`);
  }
} finally {
  db.close();
}
