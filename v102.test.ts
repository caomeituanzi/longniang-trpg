// V1.0.2：对局页中间的正文区域变大。宽屏上开局以后正文有最小高度（窗口高度的四成，300～560px），
// 下面的输入框、等结果的行动、「你不在的时候」「在场的人」不会再把它挤得只剩几行；放不下时整页变高、往下滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../server/db';
import { compareVersions, postReleaseNotes, RELEASE_NOTES } from '../server/release-notes';
import { seedTestData } from '../server/seed-data';
import { APP_VERSION } from '../server/version';
import { BEFORE_WIPE } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('V1.0.2：版本号；更新公告只写正文区域变大了', () => {
  // 之后的版本（V1.1.0 起）版本号往上走，这一条公告还在
  assert.ok(compareVersions(JSON.parse(read('package.json')).version, '1.0.2') >= 0);
  assert.ok(compareVersions(APP_VERSION, '1.0.2') >= 0);
  const note = RELEASE_NOTES.find((n) => n.version === '1.0.2')!;
  assert.equal(RELEASE_NOTES[RELEASE_NOTES.findIndex((n) => n.version === '1.0.1') - 1], note, '新的在前面');
  assert.equal(note.title, 'V1.0.2 更新了什么');
  assert.match(note.body, /正文区域变大了/);
  assert.doesNotMatch(note.body, /DeepSeek|Claude|ChatGPT|GPT|OpenAI|中转站|管理|站长|额度/);
});

test('对局页的正文区域：开局以后宽屏上正文至少占窗口高度的四成，记录和右边一栏不按内容撑开；开团准备、窄屏照旧', () => {
  const css = read('web', 'src', 'styles', 'room.css');
  const at = css.indexOf('@media (min-width: 901px)');
  assert.ok(at > 0, '宽屏的规矩写在 room.css 里');
  const wide = css.slice(at);
  assert.match(wide, /\.room-story \{\s*height: auto;\s*min-height: max\(520px, calc\(100dvh - var\(--topbar-h\) - 40px - var\(--footer-h\)\)\);/);
  assert.match(wide, /\.room-story \.story > \.log \{\s*min-height: clamp\(300px, 40dvh, 560px\);\s*contain: size;/);
  assert.match(wide, /\.room-story \.side \{\s*contain: size;/);
  // 开团准备（没有 room-story）还是正好一屏
  assert.match(css, /\.room \{[^}]*height: calc\(100dvh - var\(--topbar-h\) - 40px - var\(--footer-h\)\);[^}]*min-height: 520px;/);
  assert.match(read('web', 'src', 'pages', 'Room.tsx'), /className=\{preparing \? 'room' : 'room room-story'\}/);
  // 窄屏的规矩没动
  assert.match(read('web', 'src', 'styles', 'narrow.css'), /\.room \{\s*height: auto;\s*min-height: 0;\s*\}[\s\S]*\.log \{\s*min-height: 280px;\s*max-height: 60dvh;/);
  // 构建好的网页里也有（测试用的是 web/dist）
  const assets = path.join(ROOT, 'web', 'dist', 'assets');
  if (fs.existsSync(assets)) {
    const built = fs.readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
    assert.match(built, /\.room-story \.story>\.log\{min-height:clamp\(300px,40dvh,560px\);contain:size\}/);
  }
});

test('更新公告：从 V1.0.0 升到 V1.0.2 补上 V1.0.1 的；从内测版直接升上来（删档）是 V1.0.0、V1.0.1、V1.0.2 三条', async () => {
  const now = Date.UTC(2026, 10, 3, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-v102-notes-'));
  try {
    const formal = openDatabase(path.join(dir, 'formal.db'), { onBackup: () => {} });
    try {
      assert.deepEqual(postReleaseNotes(formal, { now, version: '1.0.0' }), ['1.0.0']);
      assert.deepEqual(postReleaseNotes(formal, { now, version: '1.0.2' }), ['1.0.1', '1.0.2'], '跳着升级，中间那版的也补上');
      assert.deepEqual(postReleaseNotes(formal, { now, version: '1.0.2' }), [], '只发一次');
    } finally {
      formal.close();
    }
    const file = path.join(dir, 'beta.db');
    const beta = openDatabase(file, { onBackup: () => {}, upTo: BEFORE_WIPE });
    await seedTestData(beta, now);
    beta.prepare("INSERT INTO settings (key, value) VALUES ('release_notes_posted', '0.9.2') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    beta.close();
    const wiped = openDatabase(file, { onBackup: () => {} });
    try {
      assert.deepEqual(postReleaseNotes(wiped, { now, version: '1.0.2' }), ['1.0.0', '1.0.1', '1.0.2']);
    } finally {
      wiped.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
