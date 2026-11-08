// 服务器进程停了以后要不要自动重启（V0.8.0）：start.mjs 用它，自动测试直接测它。
// 纯函数，只用 JavaScript 自带的东西（start.mjs 不经过 tsx）。

/** 重启也解决不了的问题（设置写错了、端口被占用、数据是更新的版本留下的）：服务器用这个退出码退出，start.mjs 看到它就不重启。 */
export const CONFIG_ERROR_EXIT = 78;
/** 意外停了以后等几秒再重启。 */
export const RESTART_DELAY_MS = 5000;
/** 这么长的时间里…… */
export const RESTART_WINDOW_MS = 10 * 60_000;
/** ……已经自动重启了这么多次，再停就不重启了（多半一启动就出错，重启也没用）。 */
export const MAX_RESTARTS = 5;

/** 按 Ctrl+C、关窗口这类“叫它停下”的信号。 */
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
/** 按 Ctrl+C 结束的程序的退出码：130（Mac、Linux），Windows 的 STATUS_CONTROL_C_EXIT（有时按有符号数给）。 */
const CTRL_C_EXIT_CODES = new Set([130, 3221225786, -1073741510]);

/**
 * 服务器进程停了以后怎么办。
 * - code、signal：服务器进程的退出码、结束它的信号（没有是 null）；
 * - stopping：按了 Ctrl+C、关了窗口（start.mjs 自己也收到了停止的信号）；
 * - restarts：之前每次自动重启的时间（毫秒）；now：现在。
 * 返回其中一种：
 * - { action: 'exit', code }：停下是正常的（自己停的、按了 Ctrl+C、关窗口），start.mjs 也跟着退出；
 * - { action: 'stop', reason }：不再重启，提示看上面的报错。reason：'config' 是设置类的错误（退出码 78），'too-many' 是重启太多次了；
 * - { action: 'restart', delayMs }：等一会儿自动重启。
 *
 * @param {{ code?: number | null, signal?: string | null, stopping?: boolean, restarts?: number[], now?: number }} exit
 * @returns {{ action: 'exit', code: number } | { action: 'stop', reason: 'config' | 'too-many' } | { action: 'restart', delayMs: number }}
 */
export function afterServerExit({ code = null, signal = null, stopping = false, restarts = [], now = Date.now() }) {
  if (stopping || (signal !== null && STOP_SIGNALS.has(signal)) || (code !== null && CTRL_C_EXIT_CODES.has(code))) {
    return { action: 'exit', code: code ?? 0 };
  }
  if (code === 0) return { action: 'exit', code: 0 };
  if (code === CONFIG_ERROR_EXIT) return { action: 'stop', reason: 'config' };
  const recent = restarts.filter((at) => now - at < RESTART_WINDOW_MS);
  if (recent.length >= MAX_RESTARTS) return { action: 'stop', reason: 'too-many' };
  return { action: 'restart', delayMs: RESTART_DELAY_MS };
}
