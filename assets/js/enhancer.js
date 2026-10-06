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

  /**
   * **临时**白名单：只在一次 `withOrigins()` 调用期间有效。
   * 用途见 `withOrigins()` 的说明 —— 给「编辑中、尚未保存」的配置做连通性测试。
   * ⚠️ 随时可能被清空，不要把它当成持久状态。
   */
  const transientOrigins = [];

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
    if (ver) { scriptVersion = ver; scriptUpToDate = null; }
    if (changed) listeners.forEach(fn => { try { fn(state); } catch (e) { /* noop */ } });
    /* 连上之后顺手自检一次脚本版本（让设置页能提示「该重新安装了」） */
    if (next === 'connected') checkScriptVersion();
  }

  /* ---------- 脚本版本自检（第 20 轮） ----------
   * 动机：脚本逻辑变了要重新安装才生效，但页面**此前完全没有这个提示** ——
   * 用户装了新应用却继续用旧脚本，会以为「改了却没生效」。
   *
   * ⚠️ 关键设计：页面**不**硬编码「期望的脚本版本」。
   * 那样会变成**第二个要维护的版本号**（脚本升一次要改两处，漏一处就误报）。
   * 这里改成：拉一次服务器上的脚本文件、从里面读 `@version` 与**已安装版本**比对，
   * 于是「脚本发了新版」这件事页面**不需要知道任何常量**就能发现。
   *
   * 加 cache-busting 参数：同源静态资源走的是 stale-while-revalidate，
   * 不加参数很可能读到的是**旧副本**，那就永远查不出「有新版」。
   */
  let scriptUpToDate = null;      // true=已是最新 / false=有新版 / null=还没查或查不到
  let latestScriptVersion = '';   // 服务器上那份的版本

  function checkScriptVersion() {
    if (!scriptVersion) return Promise.resolve(null);
    /* ⚠️ 这里**不能**调 scriptUrl()：那是导出对象上的方法，不是模块内的函数，
       直接调用会 ReferenceError（第一版就是这么写的，被「无 JS 报错」断言当场抓住）。
       与 scriptUrl() 的实现保持一致即可。 */
    const url = global.location.origin + '/' + SCRIPT_FILE;
    if (!/^https?:/i.test(url)) return Promise.resolve(null);
    return global.fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' })
      .then(r => (r && r.ok) ? r.text() : '')
      .then(txt => {
        const m = /@version\s+(\S+)/.exec(txt || '');
        if (!m) return null;
        latestScriptVersion = m[1];
        scriptUpToDate = (latestScriptVersion === scriptVersion);
        listeners.forEach(fn => { try { fn(state); } catch (e) { /* noop */ } });
        return scriptUpToDate;
      })
      .catch(() => null);         // 离线/取不到就不知道，不打扰用户
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

  /**
   * 是否「非走桥不可」。⚠️ 第 15 轮起**不再用它做自动转发**：
   * 用户明确要求「开关就是唯一的控制手段，不要在连 http 时自动强制走脚本」。
   * 保留这个函数只是为了在**请求失败**时能给出更准的原因说明。
   */
  function mustRoute(url) {
    return isMixedContent(url);
  }

  /**
   * 汇总「允许被转发」的目标 origin 集合。来源**三类**：
   *   ① 开启了绕过 CORS 的**模型** Base URL；
   *   ② 开启了「绕过CORS/混合内容限制」的 **MCP 服务器**；
   *   ③ `withOrigins()` 期间临时放行的来源（编辑中、尚未保存的配置，见该函数）。
   *
   * ⚠️ 第 15 轮**去掉了**原来「命中混合内容就自动纳入」的那一类。
   * 用户明确要求：不要在连 http 时自动强制走脚本 —— 开关是唯一控制手段。
   * （自动纳入的本意是「混合内容下开关没表达力」，但它带来的是**隐藏行为**：
   * 用户没开开关却发现请求走了脚本，难以理解。宁可让它在失败时给出准确原因。）
   * 第 ③ 类不是例外：它没有推翻「开关是唯一控制手段」——恰恰相反，
   * 它只在**用户当场开着那个开关、并在同一个弹窗里发起请求**时生效，
   * 且随调用结束立刻收回，不跨越任何用户不可见的边界。
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
    servers.forEach(s => { if (s && s.corsBypass) add(s.url); });

    // 第三类：`withOrigins()` 期间临时纳入的来源（仅测试用，随调随收）
    transientOrigins.forEach(add);

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
   * 在**本次调用期间**把若干个地址的 origin 临时纳入转发白名单，然后执行 fn。
   *
   * 为什么需要它
   * ------------
   * 设置页的「测试连接 / 获取模型列表」用的是**表单里尚未保存**的配置，
   * 那个 origin 自然不在已保存的白名单里 —— 于是 `shouldBypass()` 判false，
   * 这次请求被交给浏览器原生 fetch。用户看到的现象因此是：
   * **右上角明明写着「已连接」、开关也开着，一点测试却直接走了浏览器请求**
   * （HTTP 地址撞混合内容、跨域地址撞 CORS）。第 17 轮反馈的正是这个。
   *
   * 语义上这也说得通：开关开着 = 「这份配置的请求走脚本」，
   * 与它有没有落盘无关。所以这里把「编辑中的来源」也算进白名单，
   * 但**只限这一次调用**，结束立刻收回，不留隐藏行为。
   *
   * @param {Array<string>} urls 需要临时放行的地址（取 origin 比对）
   * @param {Function} fn 真正发请求的函数（其内部所有请求都享受放行）
   * @returns {Promise<any>} fn 的结果
   */
  function withOrigins(urls, fn) {
    const added = [];
    (urls || []).forEach(raw => {
      if (!raw) return;
      try {
        const o = new global.URL(raw, global.location.href).origin;
        if (o && o !== 'null' && transientOrigins.indexOf(o) < 0) {
          transientOrigins.push(o);
          added.push(o);
        }
      } catch (e) { /* 地址还没填好：那就没有可放行的来源 */ }
    });
    // 脚本侧还有一道独立校验，白名单变了要同步过去，否则会被它拒掉
    if (added.length) syncOrigins();

    const release = () => {
      if (!added.length) return;
      added.forEach(o => {
        const i = transientOrigins.indexOf(o);
        if (i >= 0) transientOrigins.splice(i, 1);
      });
      added.length = 0;
      syncOrigins();
    };

    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(v => { release(); return v; }, e => { release(); throw e; });
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
      origins: bypassOrigins(),
      /* ⚠️ 第 20 轮：把页面语言告诉脚本。脚本的**授权确认弹窗**是注入页面的 UI，
         之前整段硬编码中文 → 英文用户看到的是中文（而那是个安全相关的弹窗）。
         为什么不在脚本里直接读 <html lang>？因为脚本跑在 document-start，
         那时应用还没把 lang 改成用户选的语言（index.html 里静态是 zh-CN）。
         握手发生在应用启动之后，这时读到的才是真语言 —— 所以走握手传递最准。 */
      lang: (global.I18N && global.I18N.lang) || ''
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
      /* ⚠️ 第 20 轮：原先这里是硬编码中文后缀，英文界面下错误尾巴是中文 */
      let suffix;
      try { suffix = (global.I18N && global.I18N.t) ? global.I18N.t('errForwardFailed') : ''; } catch (e) { suffix = ''; }
      if (suffix) err.message = err.message + suffix;
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
    withOrigins,
    isMixedContent,
    mustRoute,
    nativeFetchBlockedReason,
    request,
    httpFetch,
    /** 给设置页用：把脚本地址完整拼出来（私有部署时自动跟随当前站点） */
    scriptUrl() {
      return global.location.origin + '/' + SCRIPT_FILE;
    },
    /** 脚本版本自检（连上时自动跑一次，也可手动调） */
    checkScriptVersion,
    /** true=已最新 / false=有新版 / null=未知 */
    isScriptUpToDate: () => scriptUpToDate,
    getLatestScriptVersion: () => latestScriptVersion
  };
})(window);
