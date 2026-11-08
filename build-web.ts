import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { config } from './config';
import { APP_AUTHOR, APP_VERSION } from './version';

const ENTRY = 'web/src/main.tsx';
/** 原样复制到网站根目录的文件（浏览器标签页图标、手机桌面图标），文件名固定。 */
const PUBLIC_DIR = path.join(config.webDir, 'public');

function buildOptions(dev: boolean): esbuild.BuildOptions {
  return {
    absWorkingDir: config.root,
    entryPoints: [ENTRY],
    bundle: true,
    outdir: 'web/dist/assets',
    // 正式构建的文件名带内容哈希，浏览器可以放心长期缓存
    entryNames: dev ? '[name]' : '[name]-[hash]',
    // 代码里 import 的图片（标志）也放进 assets，文件名带哈希
    assetNames: dev ? '[name]' : '[name]-[hash]',
    loader: { '.webp': 'file', '.png': 'file' },
    publicPath: '/assets',
    format: 'esm',
    target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
    jsx: 'automatic',
    minify: !dev,
    sourcemap: dev ? 'linked' : false,
    metafile: true,
    define: {
      __DEV__: JSON.stringify(dev),
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __APP_AUTHOR__: JSON.stringify(APP_AUTHOR),
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
    logLevel: 'warning',
  };
}

function writeIndexHtml(metafile: esbuild.Metafile) {
  const output = Object.entries(metafile.outputs).find(([, info]) => info.entryPoint === ENTRY);
  if (!output) throw new Error('构建结果里找不到入口文件');
  const [jsFile, info] = output;
  const toUrl = (file: string) => '/' + path.relative('web/dist', file).split(path.sep).join('/');
  const tags = [
    info.cssBundle ? `<link rel="stylesheet" href="${toUrl(info.cssBundle)}">` : '',
    `<script type="module" src="${toUrl(jsFile)}"></script>`,
  ]
    .filter(Boolean)
    .join('\n    ');
  const template = fs.readFileSync(path.join(config.webDir, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(config.webDist, 'index.html'), template.replace('<!-- ASSETS -->', tags));
}

function copyPublic() {
  if (fs.existsSync(PUBLIC_DIR)) fs.cpSync(PUBLIC_DIR, config.webDist, { recursive: true });
}

export async function buildWeb() {
  fs.rmSync(config.webDist, { recursive: true, force: true });
  const result = await esbuild.build(buildOptions(false));
  writeIndexHtml(result.metafile!);
  copyPublic();
}

/** 开发模式：网页源码一改就重新构建，构建完调用 onRebuild。 */
export async function watchWeb(onRebuild: () => void) {
  fs.rmSync(config.webDist, { recursive: true, force: true });
  fs.mkdirSync(config.webDist, { recursive: true });
  copyPublic();
  const ctx = await esbuild.context({
    ...buildOptions(true),
    plugins: [
      {
        name: 'write-index-html',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length || !result.metafile) return;
            writeIndexHtml(result.metafile);
            onRebuild();
          });
        },
      },
    ],
  });
  await ctx.watch();
  return ctx;
}
