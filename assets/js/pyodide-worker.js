/* ==========================================================================
   LynkLLM CE — Pyodide 执行 Worker
   --------------------------------------------------------------------------
   为什么放到 Worker 里跑：
     ① 用户代码可能很慢（大循环、复杂计算），放主线程会**冻住整个界面**；
     ② 需要「超时」能力 —— 主线程里没法安全中断同步的 Python 代码，
        而 Worker 直接 `terminate()` 就干净利落地停掉了，再重建一个即可。
   本文件是**经典 Worker**（不是 module worker），因为它要用 `importScripts`
   去加载 CDN 上的 pyodide.js（那个文件是 UMD 格式）。

   与主线程的协议（全部是普通对象，postMessage 可结构化克隆）：
     主 → Worker：{ type: 'boot', indexURL, packages }
                  { type: 'run', id, code }
     Worker → 主：{ type: 'ready', version }
                  { type: 'boot-error', message }
                  { type: 'stdout' | 'stderr', text }
                  { type: 'result', id, result }
                  { type: 'error', id, message, traceback }
   ========================================================================== */
'use strict';

let pyodide = null;
let booting = null;

/**
 * 当前正在执行的那次调用的 id。
 * ⚠️ 输出（stdout/stderr）必须**带上它**才能正确归属：Pyodide 的 stdout/stderr
 * 是「注册一次、长期有效」的回调，它自己不知道当前是哪次调用产生的输出。
 * 早先不带 id、主线程又只维护一个「当前回调」，于是**并发两次调用时
 * 前一次的 stdout 会被写进后一次的缓冲** —— 静默给错数据。
 */
let activeId = null;

/** 把执行串成队列：同一时刻只允许一段 Python 在跑（否则共享的 globals 会互相污染） */
let runChain = Promise.resolve();

function send(msg) {
  try { self.postMessage(msg); } catch (e) { /* 主线程可能已经没了 */ }
}

/** 上报一行输出（Pyodide 的 stdout/stderr 回调是「按行」给的），带上 runId */
function emitLine(kind, line) {
  send({ type: kind, text: String(line), runId: activeId });
}

function boot(indexURL, packages) {
  if (booting) return booting;
  booting = new Promise((resolve, reject) => {
    try {
      /* ⚠️ 用 importScripts 而不是 import()：CDN 上的 pyodide.js 是 UMD 构建，
         `import()` 它拿不到 loadPyodide。经典 Worker 才能 importScripts。 */
      importScripts(indexURL + 'pyodide.js');
    } catch (e) {
      reject(new Error('运行时脚本加载失败：' + (e && e.message ? e.message : e)));
      return;
    }
    if (typeof self.loadPyodide !== 'function') {
      reject(new Error('loadPyodide 未定义（运行时文件可能不完整）'));
      return;
    }
    self.loadPyodide({
      indexURL: indexURL,
      packages: packages || [],
      stdout: line => emitLine('stdout', line),
      stderr: line => emitLine('stderr', line)
    }).then(py => {
      pyodide = py;
      resolve(py);
    }).catch(err => {
      reject(err);
    });
  });
  return booting;
}

/**
 * 把 Python 的异常整理成两段：
 *   message   —— **一行**摘要（给界面标题、给模型看的重点）
 *   traceback —— 只保留 Python 自己的 traceback（**剔掉 JS 栈**）
 *
 * ⚠️ Pyodide 的 `PythonError.message` 其实是**整段 traceback**，
 * 而且 `.stack` 里还混着一堆 `at ... (pyodide.asm.js:...)` 的 JS 调用帧。
 * 直接透出会又长又乱，还会让模型误以为错误出在 JS 层。
 */
function formatError(err) {
  const raw = (err && err.message) ? String(err.message) : String(err);
  const lines = raw.split('\n');

  // 只取 Python 的 traceback 段：从 "Traceback" 开始，到最后一个非 JS 栈行为止
  let start = lines.findIndex(l => /^Traceback \(most recent call last\)/.test(l.trim()));
  if (start < 0) start = 0;
  const pyLines = lines.slice(start).filter(l => !/^\s+at .*\(https?:/.test(l));
  const traceback = pyLines.join('\n').trim();

  // 摘要：优先用「最后一行形如 XxxError: msg」的那句
  let message = '';
  for (let i = pyLines.length - 1; i >= 0; i--) {
    const l = pyLines[i].trim();
    if (/^[A-Za-z_.]*Error|^[A-Za-z_.]*Exception|^KeyboardInterrupt|^SystemExit/.test(l)) { message = l; break; }
  }
  if (!message) {
    const last = pyLines.filter(l => l.trim()).pop() || '';
    message = last.trim();
  }
  if (err && err.type && message.indexOf(err.type) !== 0) {
    message = err.type + (message ? ': ' + message : '');
  }
  return { message: message || String(err), traceback: traceback };
}

self.onmessage = function (e) {
  const d = e.data || {};

  if (d.type === 'boot') {
    boot(d.indexURL, d.packages).then(py => {
      let version = '';
      try {
        version = py.runPython('import sys; sys.version.split()[0]');
      } catch (err) { /* 拿不到版本不影响使用 */ }
      send({ type: 'ready', version: version });
    }).catch(err => {
      const info = formatError(err);
      send({ type: 'boot-error', message: info.message });
    });
    return;
  }

  if (d.type === 'run') {
    const id = d.id;
    /* ⚠️ 串行执行 + 执行期间把 activeId 指向自己。两层保护：
       ① 队列保证两段 Python 不会交错跑（否则共享的 globals 会互相污染）；
       ② 输出带 runId，即使将来有人改成并发，归属也不会错。 */
    runChain = runChain.then(() => boot(d.indexURL, d.packages)).then(async py => {
      activeId = id;
      /* ⚠️ 告诉主线程「现在真的开始执行了」——主线程据此才启动超时计时。
         不区分「排队/启动」与「执行」，冷启动那次会把 28s 的 wasm 编译
         也算进执行超时里，于是第一次调用动辄误报「执行超时」。 */
      send({ type: 'started', id: id });
      try {
        /* ⚠️ 刻意**不用** `loadPackagesFromImports()` 自动按 import 拉包：
           ① 它会在 stderr 打出 "…already loaded from default channel /
              No new packages to load" 这类噪声，混进用户看到的运行输出里；
           ② 更要紧的是**能力边界要可预测** —— 用户与模型都需要知道
              「能用什么、不能用什么」。自动拉包会让「能不能用」取决于
              网络与 CDN 上恰好有什么，边界就糊了。
           现在边界是明确的：**标准库 + 预载的 numpy**；import 别的东西
           会老老实实抛 ModuleNotFoundError。 */
        const result = await py.runPythonAsync(d.code);
        send({ type: 'result', id: id, result: result === undefined ? '' : String(result) });
      } catch (err) {
        const info = formatError(err);
        send({ type: 'error', id: id, message: info.message, traceback: info.traceback });
      } finally {
        activeId = null;
      }
    }).catch(err => {
      activeId = null;
      const info = formatError(err);
      send({ type: 'boot-error', message: info.message, id: d.id });
    });
  }
};
