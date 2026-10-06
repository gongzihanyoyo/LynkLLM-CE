/* ==========================================================================
   LynkLLM CE — MCP 客户端（Streamable HTTP 传输）
   --------------------------------------------------------------------------
   按 Model Context Protocol 的 Streamable HTTP 标准与外部工具服务器通信。
   零依赖，只用 fetch（经由 API.httpFetch，因此能用上「绕过 CORS」的增强脚本）。

   协议要点（都是实测出来的，改代码前先看这段）
   -------------------------------------------
   1. 所有请求都是 `POST {url}`，body 是 JSON-RPC 2.0。**没有** 独立的 /tools 之类端点，
      「列工具」「调工具」都走同一个 URL，靠 body 里的 method 区分。
   2. ⚠️ **`Accept` 必须同时包含 application/json 与 text/event-stream**，
      只写 application/json 的话官方 SDK 直接回 406：
        {"error":{"code":-32600,"message":"Not Acceptable: Client must accept both ..."}}
   3. `initialize` 的响应头里带 **`Mcp-Session-Id`**；之后每个请求都要把它带上。
      要在浏览器里读到这个响应头，服务器必须 `Access-Control-Expose-Headers` 暴露它
      （本项目的目标服务器返回 `*`，可以读到）。
   4. initialize 之后要发一条 **`notifications/initialized`** 通知（没有 id、无响应体），
      服务器回 202；不发的话部分实现会拒绝后续请求。
   5. 响应体可能是 **SSE**（`content-type: text/event-stream`，形如
      `event: message\ndata: {...}\n\n`），也可能是普通 JSON —— 两种都要能解析。
      所以不能无脑 `res.json()`。
   6. 会话失效（服务器重启等）返回 **404 + "Session not found"**。客户端要能自己
      重连一次再重试，否则用户会看到莫名其妙的失败。
   7. ⚠️ **工具执行出错不是传输错误**：协议规定返回 `result.isError = true`，
      HTTP 状态码仍然是 200。所以判断成败必须看 `isError`，只看 res.ok 会把
      失败当成成功。
   ========================================================================== */
(function (global) {
  'use strict';

  /** 客户端支持的协议版本（initialize 时上报；服务端可能回一个它自己的） */
  const PROTOCOL_VERSION = '2025-06-18';
  const CLIENT_INFO = { name: 'LynkLLM-CE', version: '1.0' };

  const TIMEOUT_CONNECT = 20000;
  const TIMEOUT_LIST = 20000;
  const TIMEOUT_CALL = 120000;

  /* 这些头由本模块自己管理，用户在界面上填的会被忽略 ——
     填错了会直接把 JSON-RPC 的传输层打乱（例如把 Accept 改成 application/json → 406）。 */
  const RESERVED_HEADERS = [
    'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version',
    'host', 'content-length', 'origin', 'referer'
  ];

  /** 会话缓存：server.id -> { sessionId, protocolVersion, at } */
  const sessions = {};

  /** 工具列表缓存：server.id -> { tools, at, signature } */
  const toolCache = {};

  const LIST_TTL = 60000;   // 工具列表缓存 60 秒，避免每轮对话都重列一遍

  const T = (k, fb) => {
    const v = global.I18N && I18N.t ? I18N.t(k) : '';
    return (v && v !== k) ? v : (fb || k);
  };

  function makeError(message, extra) {
    const e = new Error(message);
    Object.assign(e, extra || {});
    return e;
  }

  /** 一次请求的「配置指纹」：地址或自定义头变了，缓存的会话/工具都要作废 */
  function signatureOf(server) {
    const hs = (server.headers || []).map(h => h.name.toLowerCase() + '=' + h.value).join('&');
    return server.url + '|' + (server.corsBypass ? '1' : '0') + '|' + hs;
  }

  function effectiveHeaders(server, extra) {
    // 用户自定义头（剔除保留头）打底，再叠上本模块管理的头
    const user = global.Store && Store.headersToObject
      ? Store.headersToObject(server.headers, RESERVED_HEADERS)
      : {};
    return Object.assign(user, extra || {});
  }

  function headersOf(res) {
    // 兼容 Headers 对象与老式 XHR 风格
    try {
      if (res.headers && typeof res.headers.get === 'function') return res.headers;
    } catch (e) { /* noop */ }
    return null;
  }

  function sessionIdOf(res) {
    const h = headersOf(res);
    if (!h) return '';
    return h.get('mcp-session-id') || h.get('Mcp-Session-Id') || '';
  }

  function contentTypeOf(res) {
    const h = headersOf(res);
    if (!h) return '';
    return String(h.get('content-type') || '').toLowerCase();
  }

  /**
   * 解析 MCP 响应体。
   * SSE 与纯 JSON 两种形态都要支持（见文件头第 5 条）。
   * @param {string} text
   * @param {string} ctype
   * @param {number|string} wantId 关心的 JSON-RPC id（SSE 里可能夹带多条消息，只取匹配的）
   */
  function parseBody(text, ctype, wantId) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const messages = [];
    if (ctype.indexOf('text/event-stream') >= 0 || /^event:/.test(raw) || /^data:/.test(raw)) {
      raw.split(/\r?\n/).forEach(line => {
        const m = /^data:\s*(.*)$/.exec(line);
        if (!m) return;
        const payload = m[1].trim();
        if (!payload || payload === '[DONE]') return;
        try { messages.push(JSON.parse(payload)); } catch (e) { /* 跳过坏行 */ }
      });
    } else {
      try {
        const j = JSON.parse(raw);
        // 顺手兼容「响应体是数组」的实现（批量 JSON-RPC）
        if (Array.isArray(j)) j.forEach(x => messages.push(x));
        else messages.push(j);
      } catch (e) {
        throw makeError(T('mcpErrBadResponse', '服务器返回的不是合法 JSON') + '：' + raw.slice(0, 200),
          { code: 'MCP_BAD_RESPONSE', body: raw });
      }
    }

    if (!messages.length) return null;
    if (wantId === undefined || wantId === null) return messages[0];
    // 优先返回 id 匹配的那条；没有匹配就退回最后一条（有些实现不回 id）
    const hit = messages.find(m => m && String(m.id) === String(wantId));
    return hit || messages[messages.length - 1];
  }

  /**
   * 发一次 JSON-RPC 请求。
   * @returns {Promise<{result:object, error:object, sessionId:string, res:Response}>}
   */
  function rpc(server, method, params, opts) {
    opts = opts || {};

    /* ⚠️ 这里**不做**「混合内容就提前拒绝」的检查（第 15 轮改）。
       原因：那是**替浏览器下判断**。https 页面请求 http 地址**通常**会被拦，
       但并非所有情况都如此（浏览器版本 / 目标地址 / 策略都可能不同），
       提前拒绝等于把「本来能通」的情况也一并堵死，用户还看不到真实错误。
       正确做法：照常发请求；**失败了**再根据上下文把原因说清楚
       （见 normalizeError 里的混合内容分支）。 */

    const useSession = opts.session !== undefined ? opts.session : (sessions[server.id] || {}).sessionId;
    const id = opts.notify ? undefined : (rpc._seq = (rpc._seq || 0) + 1);

    const body = { jsonrpc: '2.0', method: method };
    if (id !== undefined) body.id = id;
    if (params !== undefined) body.params = params;

    const headers = effectiveHeaders(server, {
      'Content-Type': 'application/json',
      // ⚠️ 必须是这两个（见文件头第 2 条），少一个官方 SDK 就 406
      'Accept': 'application/json, text/event-stream'
    });
    if (useSession) headers['Mcp-Session-Id'] = useSession;
    // 初始化之后按规范带上协商好的协议版本
    const pv = opts.protocolVersion || (sessions[server.id] || {}).protocolVersion;
    if (pv && method !== 'initialize') headers['MCP-Protocol-Version'] = pv;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(makeError('timeout', { code: 'TIMEOUT' })), opts.timeout || TIMEOUT_LIST);
    // 外部 signal（用户点「停止」）也要能中断
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }

    const doFetch = (global.API && API.httpFetch) ? API.httpFetch : global.fetch.bind(global);

    return doFetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(res => {
      const sid = sessionIdOf(res) || useSession || '';
      const ctype = contentTypeOf(res);

      if (res.status === 202 || res.status === 204) {
        return { result: null, error: null, sessionId: sid, res };
      }
      return res.text().then(text => {
        const msg = parseBody(text, ctype, id);
        if (!res.ok) {
          const detail = (msg && msg.error && msg.error.message) || text.slice(0, 200) || ('HTTP ' + res.status);
          throw makeError(detail, {
            code: 'MCP_HTTP_' + res.status,
            status: res.status,
            sessionExpired: res.status === 404 && /session/i.test(detail)
          });
        }
        if (!msg) {
          if (opts.notify) return { result: null, error: null, sessionId: sid, res };
          throw makeError(T('mcpErrBadResponse', '服务器返回的不是合法 JSON'), { code: 'MCP_BAD_RESPONSE' });
        }
        if (msg.error) {
          throw makeError((msg.error && msg.error.message) || 'MCP error',
            { code: 'MCP_RPC_' + (msg.error.code || ''), rpcError: msg.error });
        }
        return { result: msg.result, error: null, sessionId: sid, res };
      });
    }).catch(err => {
      throw normalizeError(err, server.url);
    }).finally(() => clearTimeout(timer));
  }

  /**
   * 把底层错误翻译成用户看得懂的话。
   * @param {Error} err
   * @param {string} [url] 出错的地址（用于判断「混合内容」这种具体原因）
   */
  function normalizeError(err, url) {
    if (!err) return makeError('unknown');
    if (err.name === 'AbortError' || (err.code === 'TIMEOUT')) {
      return makeError(T('mcpErrTimeout', '连接超时'), { code: 'TIMEOUT' });
    }
    if (err.code && String(err.code).indexOf('MCP_') === 0) return err;
    // 网络层错误：浏览器只会给一句「Failed to fetch」，这里翻译成可操作的话
    const isNet = /failed to fetch|networkerror|load failed/i.test(String(err.message || ''));
    if (isNet) {
      /* 混合内容（https 页面 → http 地址）是最常见、也最难自己猜到的原因，
         单独给一句更准确的话。注意这是**失败之后**的解释，不是提前拦。
         ⚠️ 注意：loopback（127.0.0.1 / localhost）在部分浏览器里不受混合内容
         限制，所以这条路能走通就不要报错 —— 我们只在**真的失败**时才这么说。 */
      const mixed = url && global.Enhancer && Enhancer.isMixedContent && Enhancer.isMixedContent(url);
      if (mixed) {
        return makeError(T('mcpErrMixedContent',
          '网络请求失败：当前页面是 HTTPS，而这个地址是 HTTP，浏览器可能拦截了这类请求（混合内容）。'
          + '可在上方打开「绕过CORS/混合内容限制」并连接增强脚本后由它转发，'
          + '或把 MCP 服务改为 HTTPS。'),
        { code: 'MCP_MIXED_CONTENT', cause: err });
      }
      return makeError(T('mcpErrNetwork', '网络请求失败（可能是跨域被拦截、地址不可达或服务未启动）'),
        { code: 'MCP_NETWORK', cause: err });
    }
    return err;
  }

  /** 建立会话：initialize + notifications/initialized */
  function connect(server, opts) {
    opts = opts || {};
    return rpc(server, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    }, { timeout: opts.timeout || TIMEOUT_CONNECT, signal: opts.signal }).then(r => {
      const result = r.result || {};
      sessions[server.id] = {
        sessionId: r.sessionId || '',
        url: server.url,
        protocolVersion: String(result.protocolVersion || PROTOCOL_VERSION),
        serverInfo: result.serverInfo || null,
        instructions: result.instructions || '',
        capabilities: result.capabilities || {},
        at: Date.now(),
        signature: signatureOf(server)
      };
      // 通知：没有 id，也不等响应体
      return rpc(server, 'notifications/initialized', undefined, {
        notify: true,
        session: r.sessionId,
        protocolVersion: sessions[server.id].protocolVersion,
        timeout: 8000
      }).catch(() => null).then(() => sessions[server.id]);
    });
  }

  /** 确保已有可用会话（地址/头变了会重建） */
  function ensureSession(server, opts) {
    const s = sessions[server.id];
    if (s && s.signature === signatureOf(server)) return Promise.resolve(s);
    if (s) forget(server.id);
    return connect(server, opts);
  }

  /** 带「会话过期自动重连一次」的请求包装 */
  function withRetry(server, fn, opts) {
    return fn().catch(err => {
      if (!err || !err.sessionExpired) throw err;
      forget(server.id);
      return ensureSession(server, opts).then(fn);
    });
  }

  /**
   * 忘掉某台服务器的会话与工具缓存。
   *
   * ⚠️ 顺手**尽力**给服务器发一个 DELETE 终止会话（Streamable HTTP 规范里的
   * 「客户端主动结束会话」）。不做这件事的后果实测过：服务器会在内存里
   * 一直累积会话，攒到几十个之后连 `initialize` 都明显变慢。
   * 纯尽力而为 —— 不支持 DELETE 的实现会回 405，忽略即可，绝不影响主流程。
   */
  function forget(serverId) {
    const s = sessions[serverId];
    if (s && s.sessionId && s.url) {
      try { terminateSession(s.url, s.sessionId); } catch (e) { /* noop */ }
    }
    delete sessions[serverId];
    delete toolCache[serverId];
  }

  function forgetAll() {
    Object.keys(sessions).forEach(k => forget(k));
    Object.keys(toolCache).forEach(k => delete toolCache[k]);
  }

  /** 尽力终止一个远端会话（不等待、不报错） */
  function terminateSession(url, sessionId) {
    const doFetch = (global.API && API.httpFetch) ? API.httpFetch : global.fetch.bind(global);
    doFetch(url, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    }).catch(() => {});
  }

  /**
   * 列出服务器提供的工具。
   * @returns {Promise<Array<{name,description,inputSchema}>>}
   */
  function listTools(server, opts) {
    opts = opts || {};
    const cached = toolCache[server.id];
    if (!opts.force && cached && cached.signature === signatureOf(server)
      && (Date.now() - cached.at) < LIST_TTL) {
      return Promise.resolve(cached.tools);
    }
    return withRetry(server, () => ensureSession(server, opts).then(() =>
      rpc(server, 'tools/list', {}, { timeout: TIMEOUT_LIST, signal: opts.signal }).then(r => {
        const tools = ((r.result && r.result.tools) || []).map(normalizeTool).filter(t => t.name);
        toolCache[server.id] = { tools, at: Date.now(), signature: signatureOf(server) };
        return tools;
      })
    ), opts);
  }

  function normalizeTool(t) {
    return {
      name: String((t && t.name) || '').trim(),
      description: String((t && t.description) || '').trim(),
      inputSchema: (t && t.inputSchema && typeof t.inputSchema === 'object')
        ? t.inputSchema : { type: 'object', properties: {} }
    };
  }

  /**
   * 调用一个工具。
   * @returns {Promise<{isError:boolean, text:string, structured:any, content:Array, ms:number}>}
   */
  function callTool(server, toolName, args, opts) {
    opts = opts || {};
    const started = Date.now();
    return withRetry(server, () => ensureSession(server, opts).then(() =>
      rpc(server, 'tools/call', { name: toolName, arguments: args || {} }, {
        timeout: opts.timeout || TIMEOUT_CALL,
        signal: opts.signal
      }).then(r => {
        const result = r.result || {};
        return {
          isError: result.isError === true,     // ⚠️ 成败看这个，不看 HTTP 状态码
          text: contentToText(result.content),
          structured: result.structuredContent !== undefined ? result.structuredContent : null,
          content: Array.isArray(result.content) ? result.content : [],
          ms: Date.now() - started
        };
      })
    ), opts);
  }

  /** 把 MCP 的 content 数组压成纯文本（模型与界面都用它） */
  function contentToText(content) {
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    return content.map(c => {
      if (!c || typeof c !== 'object') return c == null ? '' : String(c);
      if (c.type === 'text') return String(c.text || '');
      if (c.type === 'image') return '[image ' + (c.mimeType || '') + ']';
      if (c.type === 'audio') return '[audio ' + (c.mimeType || '') + ']';
      if (c.type === 'resource') {
        const r = c.resource || {};
        return '[resource ' + (r.uri || '') + ']' + (r.text ? '\n' + r.text : '');
      }
      if (c.type === 'resource_link') return '[link ' + (c.uri || '') + ']';
      return JSON.stringify(c);
    }).filter(Boolean).join('\n');
  }

  /**
   * 连通性测试：连一次并列出工具。
   * 失败也要返回结构化结果（而不是抛异常），界面直接拿它渲染提示。
   */
  function test(server, opts) {
    opts = opts || {};
    forget(server.id);      // 测试就是「重连一次」，不要命中旧会话
    const started = Date.now();
    return connect(server, opts).then(session =>
      listTools(server, { force: true, signal: opts.signal }).then(tools => ({
        ok: true,
        ms: Date.now() - started,
        toolCount: tools.length,
        tools,
        serverInfo: session.serverInfo,
        protocolVersion: session.protocolVersion,
        instructions: session.instructions || ''
      }))
    ).catch(err => ({
      ok: false,
      ms: Date.now() - started,
      toolCount: 0,
      tools: [],
      error: (err && err.message) || String(err),
      code: (err && err.code) || ''
    }));
  }

  /* ---------- 工具名映射 ---------- */

  /* OpenAI 的工具名只允许 [a-zA-Z0-9_-]，且最多 64 字符。
     因此 MCP 工具要「命名空间化」：mcp__<serverSlug>__<toolName>。
     分隔符用双下划线，和官方 MCP 客户端（mcp__server__tool）保持一致。 */
  const NAME_PREFIX = 'mcp__';
  const NAME_SEP = '__';

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  }

  /** MCP 工具 → 模型可见的工具名 */
  function externalName(server, toolName) {
    const slug = slugify(server.id || server.name).slice(0, 16);
    return (NAME_PREFIX + slug + NAME_SEP + String(toolName)).slice(0, 64);
  }

  /** 模型返回的工具名 → { serverId, toolName }（不是 MCP 工具则返回 null） */
  function parseExternalName(name, servers) {
    const s = String(name || '');
    if (s.indexOf(NAME_PREFIX) !== 0) return null;
    const rest = s.slice(NAME_PREFIX.length);
    const i = rest.indexOf(NAME_SEP);
    if (i < 0) return null;
    const slug = rest.slice(0, i);
    let toolName = rest.slice(i + NAME_SEP.length);
    // 名字可能被 64 字符截断过，先按原样找，再退化到前缀匹配
    const list = servers || [];
    let hit = list.find(x => slugify(x.id || x.name).slice(0, 16) === slug);
    if (!hit) {
      // 兜底：用扩展名反查（服务器重命名 / slug 冲突时）
      hit = list.find(x => s.indexOf(NAME_PREFIX + slugify(x.id || x.name).slice(0, 16) + NAME_SEP) === 0);
    }
    if (!hit) return null;
    // 若工具名被 64 字符截断，尝试用服务器真实工具名补全
    const cached = toolCache[hit.id];
    if (cached) {
      const exact = cached.tools.find(t => t.name === toolName);
      if (!exact) {
        const cand = cached.tools.filter(t => externalName(hit, t.name) === s);
        if (cand.length === 1) toolName = cand[0].name;
      }
    }
    return { serverId: hit.id, server: hit, toolName };
  }

  global.Mcp = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    connect,
    ensureSession,
    listTools,
    callTool,
    test,
    forget,
    forgetAll,
    contentToText,
    externalName,
    parseExternalName,
    slugify,
    NAME_PREFIX,
    NAME_SEP,
    /** 测试/调试用：当前会话与缓存状态 */
    _state() {
      return {
        sessions: JSON.parse(JSON.stringify(sessions)),
        toolCache: Object.keys(toolCache).reduce((acc, k) => {
          acc[k] = { count: toolCache[k].tools.length, at: toolCache[k].at };
          return acc;
        }, {})
      };
    }
  };
})(window);
