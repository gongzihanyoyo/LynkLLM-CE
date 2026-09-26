/* ==========================================================================
   LynkLLM CE — 油猴脚本增强桥（可选）
   --------------------------------------------------------------------------
   职责：在**不装脚本时提供零成本的降级**的前提下，为「需要绕过 CORS」的模型
   提供一条由油猴脚本转发的请求通道。

   设计要点
   ---------
   1. **纯粹的增量**：本模块不接管全局 fetch。只有「模型显式开启了绕过 CORS」
      且「目标 origin 命中该模型的 Base URL」时，才把这一次请求交给脚本；
      其余一律走浏览器原生 fetch。脚本没装 / 没连接时自动退回原生路径，
      所以原有功能全部独立可用。
   2. **返回真正的 Response**：`request()` 用 ReadableStream 把脚本回传的分片
      包成一个标准 `Response`，因此 api.js 里读 `res.body.getReader()` 的流式
      解析代码一个字都不用改。
   3. **握手协议**（与 LynkLLM-CE-Enhancer.user.js 一一对应）：
      页面 → 脚本  document 上的 CustomEvent `lynkllm-ce:connect`     {version}
      脚本 → 页面  <html data-lynkllm-enhancer="<版本>">               （已安装）
                   <html data-lynkllm-enhancer-connected="1">         （已确认）
                   document 事件 `lynkllm-ce:enhancer-state`          {state}
      页面 → 脚本  `lynkllm-ce:http-request`  {id, url, method, headers, body}
      脚本 → 页面  `lynkllm-ce:http-meta`     {id, status, statusText, headers}
                   `lynkllm-ce:http-chunk`    {id, data}   （data 为 base64）
                   `lynkllm-ce:http-end`      {id}
                   `lynkllm-ce:http-error`    {id, message}
      页面 → 脚本  `lynkllm-ce:http-abort`    {id}
      所有 detail 都是 **JSON 字符串**：油猴脚本跑在隔离的 JS 世界里，
      直接传对象在部分管理器/浏览器下会抛「Permission denied」，走字符串最稳。
   ========================================================================== */
(function (global) {
  'use strict';

  const doc = global.document;
  const EV = {
    connect: 'lynkllm-ce:connect',
    state: 'lynkllm-ce:enhancer-state',
    request: 'lynkllm-ce:http-request',
    meta: 'lynkllm-ce:http-meta',
    chunk: 'lynkllm-ce:http-chunk',
    end: 'lynkllm-ce:http-end',
    error: 'lynkllm-ce:http-error',
    abort: 'lynkllm-ce:http-abort',
    abortAck: 'lynkllm-ce:http-abort-ack'
  };

  /** 页面版本 —— 让脚本能判断「脚本太旧 / 页面太旧」 */
  const PAGE_VERSION = (global.Store && Store.APP_VERSION) || '0.0.0';

  /** 增强脚本文件的固定地址（私有部署时同目录即可取到） */
  const SCRIPT_FILE = 'LynkLLM-CE-Enhancer.user.js';
  /* ⚠️ 这里**不能**对 url 参数做 encodeURIComponent：
     Tampermonkey 的 script_installation.php 直接把 hash 后面的内容当 URL 用，
     百分号编码（%3A%2F%2F）会让它解析失败 → 脚本装不上。
     编码后的形态：…#url=https%3A%2F%2Flynkllm-ce.pages.dev%2F…
     （用户实测反馈「URL 编码会导致油猴扩展无法解析」，所以这里保持原文。 */
  const INSTALL_URL = 'https://www.tampermonkey.net/script_installation.php#url=' +
    'https://lynkllm-ce.pages.dev/' + SCRIPT_FILE;

  /** 油猴扩展的安装入口 */
  const TM_LINKS = [
    {
      label: 'Chrome',
      url: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo'
    },
    {
      label: 'Edge',
      url: 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd'
    },
    {
      label: 'Firefox',
      url: 'https://addons.mozilla.org/firefox/addon/tampermonkey'
    },
    {
      label: 'Crxsoso',
      url: 'https://www.crxsoso.com/search?keyword=Tampermonkey&store=chrome'
    }
  ];

  /** 连接状态：'off'（脚本未安装/未连接） | 'connected' | 'connecting' | 'declined' */
  let state = 'off';
  let scriptVersion = '';

  /** 在途请求：id → { controller, abort } */
  const pending = {};
  let seq = 0;

  const listeners = [];

  /* ---------- 基础工具 ---------- */

  function emit(event, payload) {
    try {
      doc.dispatchEvent(new CustomEvent(event, { detail: JSON.stringify(payload || {}) }));
    } catch (e) { /* 事件通道不可用就当没有脚本 */ }
  }

  /** 文档是否已能安全派发事件 / 读取属性 */
  function docsReady() {
    try { return !!doc.documentElement; } catch (e) { return false; }
  }

  function parseDetail(ev) {
    try { return JSON.parse(ev.detail); } catch (e) { return null; }
  }

  function uid() {
    seq += 1;
    return 'r' + Date.now().toString(36) + '_' + seq;
  }

  /** base64 → Uint8Array（分片回传用，跨世界只能走字符串） */
  function b64ToBytes(b64) {
    const bin = global.atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- 状态 ---------- */

  function setState(next, ver) {
    const changed = state !== next;
    state = next;
    if (ver) scriptVersion = ver;
    if (changed) listeners.forEach(fn => { try { fn(state); } catch (e) { /* noop */ } });
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  const getState = () => state;
  const getScriptVersion = () => scriptVersion;
  /** 是否已连接（只有已连接才允许走桥） */
  const connected = () => state === 'connected';

  /* ---------- 命中判定：哪些请求值得走桥 ---------- */

  /**
   * 当前页面与目标 URL 是否构成**混合内容**（https 页面去请求 http 资源）。
   *
   * 浏览器在这种情况下会直接拦截请求（控制台报 Mixed Content），
   * **原生 fetch 100% 失败，没有任何配置能救** —— 唯一出路是让增强脚本
   * （跑在扩展的特权上下文里，不受混合内容策略约束）替我们发。
   * 本地 MCP 服务大多是 http://127.0.0.1:xxxx，而线上页面是 https，
   * 所以这条路径很常见。
   */
  function isMixedContent(url) {
    try {
      const page = global.location;
      if (!page || page.protocol !== 'https:') return false;
      const u = new global.URL(url, page.href);
      return u.protocol === 'http:';
    } catch (e) { return false; }
  }

  /** 该地址是否「非走桥不可」（混合内容时无论如何都要转发） */
  function mustRoute(url) {
    return isMixedContent(url);
  }

  /**
   * 汇总「允许被转发」的目标 origin 集合。来源有三类：
   *   ① 开启了绕过 CORS 的**模型** Base URL；
   *   ② 开启了绕过 CORS 的 **MCP 服务器**；
   *   ③ **命中混合内容的 MCP 服务器**（页面 https、地址 http）。
   *      这一类不看开关：开关关掉也照样会被浏览器拦死，所以开关此时
   *      没有表达力，直接纳入白名单才有意义 —— 否则用户看到的就是
   *      「开关都开了还是预检失败」（第 13 轮的真实反馈）。
   *
   * ⚠️ 用 origin 而不是整条 URL 做匹配：同一个网关/服务下的多个端点
   * （`/v1/chat/completions`、`/mcp` 等）都该走同一条通道。
   * ⚠️ 这份列表会**发给脚本**，脚本侧还要独立校验一遍
   * （它用的是 `@match` 全站宽匹配，必须自己收紧）。
   */
  function bypassOrigins() {
    const out = [];
    const add = (raw) => {
      if (!raw) return;
      try {
        const o = new global.URL(raw, global.location.href).origin;
        if (o && o !== 'null' && out.indexOf(o) < 0) out.push(o);
      } catch (e) { /* URL 还没填好，跳过 */ }
    };
    if (!global.Store) return out;

    let models = [];
    try { models = Store.getModels() || []; } catch (e) { models = []; }
    models.forEach(m => { if (m && m.corsBypass) add(m.baseUrl); });

    let servers = [];
    try { servers = Store.getMcpServers ? (Store.getMcpServers() || []) : []; } catch (e) { servers = []; }
    servers.forEach(s => {
      if (!s || !s.url) return;
      if (s.corsBypass || mustRoute(s.url)) add(s.url);
    });

    return out;
  }

  /**
   * 这次请求要不要交给脚本？
   * 「已连接」+「URL 命中白名单」才为真。
   * （混合内容的 MCP 地址已被 bypassOrigins() 无条件纳入，这里不必开特例分支。）
   */
  function shouldBypass(url) {
    if (!connected()) return false;
    let origin;
    try { origin = new global.URL(url, global.location.href).origin; } catch (e) { return false; }
    return bypassOrigins().indexOf(origin) >= 0;
  }

  /**
   * 这个地址在当前页面下**能不能走原生 fetch**？
   * 不能的话只有两条路：接上增强脚本，或者把地址换成 https。
   * 界面据此给出可操作的提示，而不是笼统的「网络请求失败」。
   */
  function nativeFetchBlockedReason(url) {
    if (!isMixedContent(url)) return '';
    if (connected()) return '';               // 已连接 → 会被转发，不受影响
    return 'mixed-content';
  }

  /* ---------- 握手 ---------- */

  /** 读取脚本写在 <html> 上的标记（脚本先于页面执行时也认） */
  function detectAttr() {
    const root = doc.documentElement;
    const ver = root.getAttribute('data-lynkllm-enhancer');
    if (!ver) return false;
    scriptVersion = ver;
    if (root.getAttribute('data-lynkllm-enhancer-connected') === '1') {
      setState('connected', ver);
    } else if (root.getAttribute('data-lynkllm-enhancer-declined') === '1') {
      setState('declined', ver);
    } else {
      setState('connecting', ver);
    }
    return true;
  }

  /** 主动发起一次连接请求（脚本收到后会弹确认框，或直接用已存的授权放行） */
  function connect() {
    const found = detectAttr();
    if (found && state === 'connected') {
      // 已连上：不再弹确认框，但仍要把**最新的白名单**同步过去。
      // 否则「连上之后又给某个模型开了绕过开关」会被脚本按旧白名单拒掉，
      // 用户只能刷新页面才能生效。
      syncOrigins();
      return;
    }
    if (found && state === 'declined') {
      // 用户明确拒绝过：不再重复弹确认框，但脚本仍可凭已保存的授权主动连上
      emitConnect({ silent: true });
      return;
    }
    setState(found ? 'connecting' : 'off');
    emitConnect();
  }

  /**
   * 只把「允许转发的来源」同步给脚本（不触发任何确认流程）。
   * 模型列表变化后调用，保证脚本的白名单始终是最新的。
   */
  function syncOrigins() {
    if (!scriptVersion) return;
    emit(EV.connect, { version: PAGE_VERSION, origins: bypassOrigins(), silent: true, update: true });
  }

  /**
   * 发出握手请求。
   * 一定带上 `origins`：脚本侧会再做一次独立校验（不完全信任页面），
   * 只有落在这些来源里的请求才会被转发 —— 这是脚本那头「宽匹配所有域名」
   * 的必要配套安全措施。
   */
  function emitConnect(extra) {
    const payload = {
      version: PAGE_VERSION,
      href: global.location.href,
      origins: bypassOrigins()
    };
    if (extra) Object.keys(extra).forEach(k => { payload[k] = extra[k]; });
    emit(EV.connect, payload);
  }

  /* ---------- 响应式桥 ---------- */

  /**
   * 发一个请求，返回标准 Response。
   * 流式与非流式共用同一条路径 —— 因为返回的就是真正的 Response，
   * 调用方原有逻辑（res.ok / res.json() / res.body.getReader()）无需区分。
   * @param {string} url
   * @param {object} [init] 与 fetch 的第二个参数一致（支持 method/headers/body/signal）
   * @returns {Promise<Response>}
   */
  function request(url, init) {
    init = init || {};
    if (!connected()) return Promise.reject(makeErr('enhancer-not-connected', 'enhancer offline'));

    const id = uid();
    const headers = normalizeHeaders(init.headers);
    const body = typeof init.body === 'string' ? init.body : (init.body == null ? null : null);
    if (init.body != null && typeof init.body !== 'string') {
      // 桥只支持字符串体（本项目所有请求都是 JSON 字符串）；其它类型不冒险转发
      return Promise.reject(makeErr('enhancer-unsupported-body', 'body must be a string'));
    }

    let controllerRef = null;
    const stream = new global.ReadableStream({
      start(c) { controllerRef = c; }
    });

    return new Promise((resolve, reject) => {
      // ⚠️ 三个「只做一次」的标志必须分开。早期版本用一个共用的 settled 守卫，
      // 结果 meta 一到达就把 settled 置位，随后 end 被守卫挡掉、ReadableStream
      // 永远不 close —— 表现是「响应头/分片都收到了，但读正文永远不结束」。
      let resolved = false;   // Response 已交出
      let closed = false;     // 流已关闭

      const drop = () => { delete pending[id]; };

      pending[id] = {
        // 必须等脚本回报「响应头」之后再构造 Response —— Response 的 status
        // 一旦构造就定死，先给 200 再想改成 401 是做不到的，而 api.js 要靠
        // res.ok / res.status 判断成败。分片比 meta 早到不会丢：
        // ReadableStream 内部会排队缓冲，等下游接上读取器再吐出。
        meta: (m) => {
          if (resolved) return;
          resolved = true;
          try {
            resolve(new global.Response(stream, {
              status: Number(m.status) || 200,
              statusText: m.statusText || '',
              headers: m.headers || {}
            }));
          } catch (e) {
            closed = true;
            drop();
            reject(makeErr('enhancer-bad-response', String(e && e.message || e)));
          }
        },
        err: (err) => {
          if (closed) return;
          closed = true;
          drop();
          try { controllerRef.error(err); } catch (e) { /* noop */ }
          // meta 还没来就失败 → 直接把 Promise 打回；已经 resolve 过则只让流报错
          if (!resolved) { resolved = true; reject(err); }
        },
        chunk: (bytes) => {
          if (closed) return;
          try { controllerRef.enqueue(bytes); } catch (e) { /* 下游已取消 */ }
        },
        end: () => {
          if (closed) return;
          closed = true;
          drop();
          try { controllerRef.close(); } catch (e) { /* noop */ }
        }
      };

      // 上游取消（用户点了停止）→ 通知脚本中止底层请求
      if (init.signal) {
        if (init.signal.aborted) {
          closed = true;
          drop();
          resolved = true;
          reject(makeErr('aborted', 'aborted'));
          return;
        }
        init.signal.addEventListener('abort', () => {
          emit(EV.abort, { id });
          if (closed) return;
          closed = true;
          drop();
          try { controllerRef.error(makeErr('aborted', 'aborted')); } catch (e) { /* noop */ }
          if (!resolved) { resolved = true; reject(makeErr('aborted', 'aborted')); }
        }, { once: true });
      }

      emit(EV.request, {
        id,
        url,
        method: (init.method || 'GET').toUpperCase(),
        headers,
        body,
        pageVersion: PAGE_VERSION
      });
    });
  }

  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof global.Headers !== 'undefined' && h instanceof global.Headers) {
      h.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(h)) {
      h.forEach(pair => { if (pair && pair.length === 2) out[pair[0]] = pair[1]; });
      return out;
    }
    Object.keys(h).forEach(k => { out[k] = String(h[k]); });
    return out;
  }

  function makeErr(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  /* ---------- 来自脚本的消息 ---------- */

  function bind() {
    doc.addEventListener(EV.state, ev => {
      const d = parseDetail(ev);
      if (!d) return;
      if (d.state === 'ready') {
        // 脚本先于页面就绪：立刻回一次握手，别等页面自己的启动时序
        if (docsReady()) emitConnect();
        return;
      }
      if (d.state === 'connected') setState('connected', d.version);
      else if (d.state === 'declined') setState('declined', d.version || scriptVersion);
      else if (d.state === 'pending') setState('connecting', d.version || scriptVersion);
      else setState('off', d.version || '');
    });

    doc.addEventListener(EV.meta, ev => {
      const d = parseDetail(ev);
      if (!d || !d.id) return;
      const p = pending[d.id];
      if (p) p.meta(d);
    });

    doc.addEventListener(EV.chunk, ev => {
      const d = parseDetail(ev);
      if (!d || !d.id || typeof d.data !== 'string') return;
      const p = pending[d.id];
      if (p) p.chunk(b64ToBytes(d.data));
    });

    doc.addEventListener(EV.end, ev => {
      const d = parseDetail(ev);
      if (!d || !d.id) return;
      const p = pending[d.id];
      if (p) p.end();
    });

    doc.addEventListener(EV.error, ev => {
      const d = parseDetail(ev);
      if (!d || !d.id) return;
      const p = pending[d.id];
      if (p) p.err(makeErr(d.code || 'enhancer-error', d.message || 'enhancer request failed'));
    });
  }

  /* ---------- 统一入口 ---------- */

  /**
   * 页面里所有网络请求的统一入口：需要走桥就走桥，否则原样走浏览器 fetch。
   * api.js 里 9 处 fetch 都换成它，语义与 fetch 完全一致。
   */
  function httpFetch(url, init) {
    if (shouldBypass(url)) return request(url, init).catch(err => {
      // 桥失败时如实抛出 —— 不要静默退回 fetch：那会让「绕过 CORS」变成
      // 「有时候能通有时候不能通」，用户无从判断。错误信息里带上提示。
      err.message = err.message + '（增强脚本转发失败，可在设置中检查连接状态）';
      throw err;
    });
    return global.fetch(url, init);
  }

  /* ---------- 初始化 ----------
     事件监听必须在脚本加载时就挂上：脚本可能比页面先跑完，
     它写在 <html> 上的连接标记要靠 detectAttr() 读；而脚本回传的分片
     可能在任何时刻到达，晚注册就会丢消息。 */
  function init() {
    bind();
    detectAttr();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  global.Enhancer = {
    EV,
    bind,
    TM_LINKS,
    SCRIPT_FILE,
    INSTALL_URL,
    PAGE_VERSION,
    detectAttr,
    connect,
    syncOrigins,
    onChange,
    getState,
    getScriptVersion,
    connected,
    bypassOrigins,
    shouldBypass,
    isMixedContent,
    mustRoute,
    nativeFetchBlockedReason,
    request,
    httpFetch,
    /** 给设置页用：把脚本地址完整拼出来（私有部署时自动跟随当前站点） */
    scriptUrl() {
      return global.location.origin + '/' + SCRIPT_FILE;
    }
  };
})(window);
