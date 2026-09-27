/* ==========================================================================
   LynkLLM CE — Pyodide 运行时（主线程侧 API）
   --------------------------------------------------------------------------
   给模型提供「本地 Python 计算」能力。设计与几个关键决定：

   ① **运行时缓存在 Cache Storage 里，缓存名刻意不带应用版本号**
      （`lynkllm-ce-pyodide`）：那是 ~14MB 的静态资源，不能因为网页升个
      小版本就作废、让用户重下。清除由设置页显式触发。
      ⚠️ Cache Storage 是**同源共享**的：页面自己写、Service Worker 负责读
      （worker 里的 importScripts/fetch 会被 SW 拦截并命中这份缓存）。
      这样「下载」不依赖 SW 是否已接管页面，更可靠。

   ② **下载由页面自己 `cache.put`，而不是靠 SW 顺带缓存**：
      这样才能读到 Content-Length、给出真实进度；也顺手保证了
      「下载完成」= 「缓存里确实有」。

   ③ **执行放在 Worker 里**（见 pyodide-worker.js）：不冻界面 + 能超时。

   ④ **首次真正跑代码前会重新确认运行时可用**：缓存被清掉/损坏时给出
      可读错误，而不是抛一堆 wasm 报错。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ⚠️ 版本固定：跟着 Pyodide 的发布走，不跟应用版本。
     换版本时记得同时改 SW 里的 PYODIDE_CACHE 名字，否则旧文件会被命中。 */
  const PYODIDE_VERSION = '0.29.5';
  const INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';
  const RUNTIME_CACHE = 'lynkllm-ce-pyodide-v1';

  /** 预加载的第三方包。numpy 只多 2.7MB，对「复杂计算」的收益很大 */
  const PACKAGES = ['numpy'];

  /** 判断「已下载」用的探针文件 —— 它是运行时里最大、最不可缺的一个 */
  const PROBE_FILE = 'pyodide.asm.wasm';

  const DEFAULT_TIMEOUT = 30000;   // 单次执行默认 30s（**不含**启动与排队，见 run()）
  const MAX_TIMEOUT = 120000;
  /* ⚠️ 安全网：执行超时是「收到 started 才开始计」的（这样冷启动编译 wasm 的
     28 秒不会被算进去）。代价是——万一 started 那条消息丢了，就再也没人计时了。
     所以这里再挂一个**兜底闹钟**（覆盖 启动 + 排队 + 执行），
     宁可晚一点报错，绝不能永远挂着。 */
  const HARD_CEILING_MS = 180000;

  let worker = null;
  let workerReady = null;          // Promise
  let seq = 0;
  const pending = new Map();       // id -> { resolve, reject, out, timer }
  /* ⚠️ 这里**不能**用「一个模块级回调」来表达"当前那次执行"：
     Pyodide 的 stdout/stderr 回调是注册一次长期有效的，而 Worker 那边已经
     把输出打上了 `runId`。按 id 路由到各自的缓冲，才不会出现
     「并发两次调用时前一次的 stdout 写进后一次」这种静默错数据。 */

  const T = (k, fb) => {
    const v = global.I18N && I18N.t ? I18N.t(k) : '';
    return (v && v !== k) ? v : (fb || k);
  };

  function makeError(message, extra) {
    const e = new Error(message);
    Object.assign(e, extra || {});
    return e;
  }

  /* ---------- 缓存读写（页面侧） ---------- */

  function cacheOpen() {
    if (!global.caches) {
      return Promise.reject(makeError(T('pyNoCache', '当前环境不支持本地缓存，无法下载运行时'),
        { code: 'PY_NO_CACHE' }));
    }
    return global.caches.open(RUNTIME_CACHE);
  }

  /** 运行时是否已经完整下载到本地 */
  function isDownloaded() {
    return cacheOpen().then(cache =>
      cache.match(INDEX_URL + PROBE_FILE).then(res => !!res)
    ).catch(() => false);
  }

  /** 已缓存的文件数与总字节数（设置页显示用） */
  function cacheStats() {
    return cacheOpen().then(cache =>
      cache.keys().then(keys => {
        if (!keys.length) return { files: 0, bytes: 0, downloaded: false };
        let bytes = 0;
        return Promise.all(keys.map(req => cache.match(req).then(res => {
          if (!res || !res.headers) return null;
          // 优先用我们自己记的真实大小（见 fetchWithProgress 的说明）
          const len = Number(res.headers.get('X-Lynk-Size'))
            || Number(res.headers.get('content-length')) || 0;
          bytes += len;
          return null;
        }))).then(() => ({ files: keys.length, bytes: bytes, downloaded: true }));
      })
    ).catch(() => ({ files: 0, bytes: 0, downloaded: false }));
  }

  /** 清除运行时（停掉 Worker，避免它继续持有旧的 wasm 实例） */
  function clear() {
    killWorker();
    if (!global.caches) return Promise.resolve(false);
    return global.caches.delete(RUNTIME_CACHE).catch(() => false);
  }

  /* ---------- 下载 ---------- */

  function fetchWithProgress(url, onProgress) {
    return fetch(url, { cache: 'no-store' }).then(res => {
      if (!res.ok) throw makeError('HTTP ' + res.status + ' — ' + url, { status: res.status });
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !res.body.getReader || !total) {
        // 环境不支持流式读取 → 退回一次性读（进度只在完成时跳一下）
        return res.blob().then(blob => {
          if (onProgress) onProgress(blob.size, total || blob.size);
          return new Response(blob, { status: 200, statusText: 'OK', headers: res.headers });
        });
      }
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) return null;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(received, total);
        return pump();
      });
      return pump().then(() => {
        const blob = new Blob(chunks);
        /* ⚠️ 必须把原始响应头带上（尤其是 Content-Type）：
           Pyodide 用 WebAssembly.instantiateStreaming 加载 wasm，
           响应头里没有 application/wasm 的话会直接失败。
           ⚠️ 另加一个 X-Lynk-Size 记录**真实字节数**：CDN 的
           Content-Length 是压缩后的大小（实测 wasm 8.2MB 只报 ~1MB），
           直接拿它当「占用体积」会明显偏小、误导用户。 */
        const headers = new Headers(res.headers);
        headers.set('X-Lynk-Size', String(blob.size));
        return new Response(blob, { status: 200, statusText: 'OK', headers: headers });
      });
    });
  }

  /**
   * 下载运行时到本地缓存。
   * @param {(info:{done:number,total:number,file:string,percent:number})=>void} [onProgress]
   */
  function download(onProgress) {
    let lock = null;
    let files = [];
    return fetch(INDEX_URL + 'pyodide-lock.json', { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw makeError('HTTP ' + res.status, { status: res.status });
        return res.json();
      })
      .then(json => {
        lock = json;
        /* 核心文件是固定的几个；分包（numpy…）的文件名要从 lock 里读，
           不能写死 —— 它带着 ABI/版本号，跨版本会变。 */
        files = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm',
          'python_stdlib.zip', 'pyodide-lock.json'];
        (PACKAGES || []).forEach(name => {
          const p = lock && lock.packages && lock.packages[name];
          if (p && p.file_name) files.push(p.file_name);
        });
        // 去重（lock 里可能和核心文件重名）
        files = files.filter((f, i) => files.indexOf(f) === i);
      })
      .then(() => cacheOpen())
      .then(cache => {
        const total = files.length;
        const failed = [];
        const step = i => {
          if (i >= total) return Promise.resolve();
          const file = files[i];
          const url = INDEX_URL + file;
          const report = (received, size) => {
            if (onProgress) {
              onProgress({ done: i, total: total, file: file, received: received, size: size });
            }
          };
          report(0, 0);
          return fetchWithProgress(url, report).then(response =>
            /* ⚠️⚠️ 这个 `cache.put` **必须 await**。
               早先写成 `.catch(() => {})` 不管它（fire-and-forget），结果是：
               `download()` 已经在跑「下一步」甚至已经 resolve 了，而前面几个
               `put` 还在写 —— 实测 6 个文件只落库了 3 个（恰好是排在前面的
               pyodide.js / pyodide.asm.js / pyodide.asm.wasm 没写完），
               于是「已下载」是假的，离线启动直接超时。
               一句话：**「下载完成」必须等于「缓存写完」。** */
            cache.put(url, response.clone()).catch(err => {
              failed.push(file + ': ' + ((err && err.message) || err));
            }).then(() => {
              if (onProgress) {
                onProgress({ done: i + 1, total: total, file: file, received: 1, size: 1 });
              }
              return step(i + 1);
            })
          );
        };
        return step(0).then(() => {
          /* 有文件没写进去就是没下载成功 —— 如实报错，别让界面显示「已下载」。
             （落盘失败却报成功，用户下次离线时会撞上一个无法解释的启动失败。） */
          if (failed.length) {
            throw makeError(T('pyDownloadFailed', '运行时下载失败') + ' — ' + failed.join('; '),
              { code: 'PY_CACHE_PUT_FAILED', failed: failed });
          }
          /* 再验一次「探针文件真的在缓存里」：put 报成功但条目不在的情况
             （磁盘满、配额被清）也要在这一步暴露，而不是留到离线启动时才炸。 */
          return cache.match(INDEX_URL + PROBE_FILE).then(hit => {
            if (!hit) {
              throw makeError(T('pyDownloadFailed', '运行时下载失败') + ' — ' + PROBE_FILE,
                { code: 'PY_CACHE_VERIFY_FAILED' });
            }
            return true;
          });
        });
      })
      .then(() => {
        /* ⚠️ 下载完**顺手把解释器起起来**（不阻塞调用方）：
           Pyodide 首次启动要编译/初始化 wasm，实测**约 28 秒** —— 如果
           留到模型第一次调用时才做，很可能会撞上工具超时，用户看到的是
           「Python 超时」而不是「正在准备运行时」。这里在设置页里就把它
           预热掉，等用户回到对话时已经是热的（后续每次执行只要几秒）。
           失败不影响「已下载」这个事实，首次调用时会再试一次。 */
        bootRuntime().catch(() => null);
        return true;
      });
  }

  /** 运行时是否已经热好（下载之后会自动预热） */
  function isWarm() { return !!workerReady; }

  /** 真正把 Python 解释器起来（会读缓存，很快） */
  function bootRuntime() {
    if (workerReady) return workerReady;
    workerReady = new Promise((resolve, reject) => {
      let w;
      try {
        w = new global.Worker('assets/js/pyodide-worker.js');
      } catch (e) {
        reject(makeError(T('pyNoWorker', '无法创建 Worker（当前环境不支持）'), { code: 'PY_NO_WORKER' }));
        return;
      }
      worker = w;
      const timer = setTimeout(() => {
        cleanup();
        reject(makeError(T('pyBootTimeout', 'Python 运行时启动超时'), { code: 'PY_BOOT_TIMEOUT' }));
      }, 60000);
      const cleanup = () => { clearTimeout(timer); w.removeEventListener('message', onMsg); };

      function onMsg(e) {
        const d = e.data || {};
        if (d.type === 'ready') { cleanup(); resolve(d.version || ''); return; }
        if (d.type === 'boot-error') {
          cleanup();
          reject(makeError(d.message || T('pyBootFailed', 'Python 运行时启动失败'), { code: 'PY_BOOT_FAILED' }));
        }
      }
      w.addEventListener('message', onMsg);
      /* 通用分发（stdout/stderr/result/error）与启动握手是**两个**监听器：
         握手只管 ready/boot-error，跑代码的结果由 attachWorker 处理。
         两者都挂在同一个 Worker 上，互不干扰。 */
      attachWorker(w);
      w.postMessage({ type: 'boot', indexURL: INDEX_URL, packages: PACKAGES });
    }).catch(err => {
      workerReady = null;      // 允许下次重试
      killWorker();
      throw err;
    });
    return workerReady;
  }

  function killWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* noop */ }
      worker = null;
    }
    workerReady = null;
    // 还在等结果的调用要立刻失败，别让它们永远挂着
    pending.forEach(p => {
      clearTimeout(p.timer);
      p.reject(makeError(T('pyAborted', '执行已中止'), { code: 'PY_ABORTED' }));
    });
    pending.clear();
  }

  /** 全局消息分发：输出按 `runId` 归位到对应那次执行 */
  function attachWorker(w) {
    w.addEventListener('message', e => {
      const d = e.data || {};
      if (d.type === 'stdout' || d.type === 'stderr') {
        const target = d.runId != null ? pending.get(d.runId) : null;
        if (target) {
          target.out[d.type] += (target.out[d.type] ? '\n' : '') + d.text;
          if (target.onLine) target.onLine(d.type, d.text);
        }
        return;
      }
      if (d.type === 'boot-error') {
        // 运行中途运行时挂了：把当前这次执行标失败
        pending.forEach(p => {
          clearTimeout(p.timer);
          p.reject(makeError(d.message || T('pyBootFailed', 'Python 运行时启动失败'), { code: 'PY_BOOT_FAILED' }));
        });
        pending.clear();
        return;
      }
      if (d.type === 'started') {
        /* 真正开始执行了 → 这时候才起执行超时（见 pyodide-worker 里的说明）。
           ⚠️ 必须经由 pending 条目上的 `armTimeout` 调用：那个闭包定义在 run()
           的 Promise 内部，这里直接写 `armTimeout(t)` 是取不到的（会 ReferenceError）。 */
        const t = pending.get(d.id);
        if (t && !t.timer && typeof t.armTimeout === 'function') t.timer = t.armTimeout(t);
        return;
      }
      if (d.type !== 'result' && d.type !== 'error') return;
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.type === 'error') {
        p.resolve({ stdout: p.out.stdout, stderr: p.out.stderr, result: '',
          error: d.message || 'error', traceback: d.traceback || '' });
      } else {
        p.resolve({ stdout: p.out.stdout, stderr: p.out.stderr, result: d.result || '',
          error: '', traceback: '' });
      }
    });
  }

  /**
   * 执行一段 Python。
   * @param {string} code
   * @param {object} [opts] { timeout, signal, onLine }
   * @returns {Promise<{stdout,stderr,result,error,traceback,ms}>}
   */
  function run(code, opts) {
    opts = opts || {};
    const started = Date.now();
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, Number(opts.timeout) || DEFAULT_TIMEOUT));
    const out = { stdout: '', stderr: '' };
    /* 输出累积由 attachWorker 按 runId 直接写进 `out`（见那里的说明），
       这里不需要任何"全局当前回调"的状态。 */

    if (opts.signal && opts.signal.aborted) {
      return Promise.reject(makeError(T('pyAborted', '执行已中止'), { code: 'PY_ABORTED' }));
    }

    return bootRuntime().then(() => {
      if (!worker) throw makeError(T('pyAborted', '执行已中止'), { code: 'PY_ABORTED' });
      const id = ++seq;
      return new Promise((resolve, reject) => {
        /* ⚠️ 计时**不在这里**起：这里是「刚排进队列」，前面可能还压着别的执行、
           而且解释器可能还没启动（冷启动要编译 wasm，实测约 28 秒）。
           把等待时间算进「执行超时」会导致第一次调用动辄误报超时。
           真正开始执行时 Worker 会发 `started`，那时才起表（见下面的 armTimeout）。 */
        const armTimeout = (entry) => setTimeout(() => {
          /* ⚠️ 超时必须 terminate 而不是「喊停」：Python 是同步执行的，
             没法在 Worker 里安全打断。终止后 Worker 会被重建（下次调用时），
             这正是放在 Worker 里跑的意义。 */
          pending.delete(id);
          killWorker();
          reject(makeError(T('pyTimeout', '执行超时（{0} 秒）').replace('{0}', String(Math.round(timeout / 1000))),
            { code: 'PY_TIMEOUT', stdout: out.stdout, stderr: out.stderr }));
        }, timeout);   // ← 执行计时：由 started 触发
        const clearAll = () => {
          const entry = pending.get(id);
          if (entry) {
            if (entry.timer) clearTimeout(entry.timer);
            if (entry.hard) clearTimeout(entry.hard);
          }
        };
        /* 兜底闹钟：无论卡在哪一步，最多这么久必须出结果（见 HARD_CEILING_MS 说明） */
        const hard = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          killWorker();
          reject(makeError(T('pyTimeout', '执行超时（{0} 秒）').replace('{0}', String(Math.round(timeout / 1000))),
            { code: 'PY_TIMEOUT', stdout: out.stdout, stderr: out.stderr }));
        }, timeout + HARD_CEILING_MS);

        pending.set(id, {
          resolve: r => { clearAll(); resolve(Object.assign({ ms: Date.now() - started }, r)); },
          reject: e => { clearAll(); reject(e); },
          out: out, timer: null, hard: hard, armTimeout: armTimeout, timeout: timeout,
          /* 本次执行自己的输出回调：由 attachWorker 按 runId 找到这条记录后再调 */
          onLine: opts.onLine || null
        });
        const onAbort = () => {
          const entry = pending.get(id);
          if (entry && entry.timer) clearTimeout(entry.timer);
          if (entry && entry.hard) clearTimeout(entry.hard);
          pending.delete(id);
          killWorker();
          reject(makeError(T('pyAborted', '执行已中止'), { code: 'PY_ABORTED' }));
        };
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
        worker.postMessage({ type: 'run', id: id, code: code, indexURL: INDEX_URL, packages: PACKAGES });
      });
    }).catch(err => {
      throw err;
    });
  }

  /** 已经在跑吗（设置页用来避免重复操作） */
  function isBusy() { return pending.size > 0; }

  global.PyodideRunner = {
    VERSION: PYODIDE_VERSION,
    INDEX_URL: INDEX_URL,
    RUNTIME_CACHE: RUNTIME_CACHE,
    PACKAGES: PACKAGES,
    PROBE_FILE: PROBE_FILE,
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    isDownloaded: isDownloaded,
    isWarm: isWarm,
    cacheStats: cacheStats,
    download: download,
    clear: clear,
    boot: bootRuntime,
    run: run,
    isBusy: isBusy,
    kill: killWorker,
    /** 测试用：把已建好的 worker 接上消息分发（内部调用） */
    _attach: attachWorker
  };
})(window);
