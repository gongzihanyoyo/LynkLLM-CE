/* ==========================================================================
   LynkLLM CE — OpenAI 兼容 API 客户端
   支持：流式（SSE）/ 非流式对话、模型列表查询、连通性测试、多模态消息
   ========================================================================== */
(function (global) {
  'use strict';

  const DEFAULT_TIMEOUT = 180000; // 3 分钟无数据则超时

  /* ---------- URL 处理 ---------- */
  function joinUrl(base, path) {
    let b = String(base || '').trim();
    if (!b) throw new Error('Base URL 为空');
    // 去掉尾部斜杠
    b = b.replace(/\/+$/, '');
    // 用户可能已经写到了 /chat/completions
    const lower = b.toLowerCase();
    if (lower.endsWith('/chat/completions')) {
      if (path === '/chat/completions') return b;
      b = b.slice(0, -'/chat/completions'.length);
    }
    if (lower.endsWith('/models') && path === '/models') return b;
    if (lower.endsWith('/models')) b = b.slice(0, -'/models'.length);
    // 若未带版本段，也不强行补全（兼容第三方网关，如 https://api.xxx.com）
    return b + path;
  }

  function chatUrl(base) { return joinUrl(base, '/chat/completions'); }
  function modelsUrl(base) { return joinUrl(base, '/models'); }

  /* ---------- 请求头 ---------- */
  function headers(apiKey, extra) {
    const h = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }, extra || {});
    if (apiKey) h['Authorization'] = 'Bearer ' + String(apiKey).trim();
    return h;
  }

  /* ---------- 错误归一化 ---------- */
  function makeError(message, extra) {
    const e = new Error(message || '请求失败');
    if (extra) Object.assign(e, extra);
    return e;
  }

  function extractErrorMessage(status, bodyText) {
    let detail = '';
    try {
      const j = JSON.parse(bodyText);
      detail = (j.error && (j.error.message || j.error.type)) || j.message ||
        (typeof j.detail === 'string' ? j.detail : '');
      if (!detail && j.error) detail = JSON.stringify(j.error);
      if (typeof detail === 'object') detail = JSON.stringify(detail);
    } catch (e) {
      detail = (bodyText || '').slice(0, 500);
    }
    const base = 'HTTP ' + status;
    return detail ? base + ' — ' + detail : base;
  }

  /* ---------- 消息构造 ---------- */

  /**
   * 将本地消息转为 API 消息
   * @param {Array} messages 本地消息数组
   * @param {object} model 模型配置
   * @param {object} opts { historyLimit }
   */
  function buildMessages(messages, model, opts) {
    opts = opts || {};
    const out = [];
    const sys = (model && model.systemPrompt) ? String(model.systemPrompt).trim() : '';
    if (sys) out.push({ role: 'system', content: sys });

    const vision = !!(model && model.supportsImages);
    let list = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant'));

    // 上下文裁剪（按消息条数做保守限制）
    if (opts.historyLimit && list.length > opts.historyLimit) {
      list = list.slice(list.length - opts.historyLimit);
    }

    list.forEach(m => {
      if (m.role === 'assistant') {
        if (typeof m.content === 'string' && m.content.trim()) {
          out.push({ role: 'assistant', content: m.content });
        }
        return;
      }
      // user
      const images = Array.isArray(m.images) ? m.images : [];
      if (images.length && vision) {
        const parts = [];
        const text = typeof m.content === 'string' ? m.content.trim() : '';
        if (text) parts.push({ type: 'text', text });
        images.forEach(img => {
          if (img && img.dataUrl) {
            parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
          }
        });
        if (!parts.length) parts.push({ type: 'text', text: '' });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' });
      }
    });

    return out;
  }

  /* ---------- 思考强度参数 ---------- */
  function thinkingPayload(level) {
    if (!level) return {};
    const l = String(level).toLowerCase();
    if (l === 'auto' || l === 'default') return {};
    if (l === 'off' || l === 'none' || l === 'disabled') {
      return { reasoning_effort: 'none' };
    }
    if (['low', 'medium', 'high', 'minimal', 'xhigh', 'maximum'].indexOf(l) >= 0) {
      return { reasoning_effort: l };
    }
    if (l === 'on' || l === 'enable' || l === 'enabled') {
      return { reasoning_effort: 'medium' };
    }
    // 其他自定义值：按 reasoning_effort 原样传递
    if (/^[a-z0-9_-]+$/.test(l)) return { reasoning_effort: l };
    return {};
  }

  /* ---------- 用量解析 ---------- */
  function parseUsage(u, content) {
    if (!u || typeof u !== 'object') {
      if (content && typeof content === 'string') {
        return { estimated: true, total: Math.ceil(content.length / 2) };
      }
      return null;
    }
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const total = Number(u.total_tokens) || (prompt + completion);
    let hit = Number(u.prompt_cache_hit_tokens);
    if (isNaN(hit)) hit = Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
    if (isNaN(hit)) hit = Number(u.cache_read_input_tokens);
    let miss = Number(u.prompt_cache_miss_tokens);
    if (isNaN(miss)) miss = Number(u.prompt_tokens_details && u.prompt_tokens_details.miss_tokens);
    if (isNaN(hit)) hit = null;
    if (isNaN(miss)) miss = (hit != null ? Math.max(0, prompt - hit) : null);
    const reasoning = Number(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens);
    return {
      inputMiss: miss,
      inputHit: hit,
      input: prompt,
      output: completion,
      total: total,
      reasoning: isNaN(reasoning) ? null : reasoning,
      estimated: false
    };
  }

  /* ---------- 主体：聊天补全 ---------- */

  /**
   * @param {object} params
   *   model       {object} 模型配置
   *   messages    {Array}  本地消息
   *   stream      {boolean}
   *   thinking    {string}
   *   signal      {AbortSignal}
   *   onDelta     {(text:string, full:string)=>void}
   *   onReasoning {(text:string)=>void}
   *   onOpen      {()=>void}
   *   temperature {number}
   *   maxTokens   {number}
   *   historyLimit {number}
   * @returns {Promise<{content:string, usage:object|null, raw:any, aborted:boolean}>}
   */
  function chat(params) {
    const model = params.model || {};
    if (!model.baseUrl) return Promise.reject(makeError('未配置 Base URL', { code: 'NO_BASE_URL' }));
    if (!model.model) return Promise.reject(makeError('未配置模型名称', { code: 'NO_MODEL' }));

    const useStream = !!params.stream && model.supportsStream !== false;
    if (useStream) return chatStream(params);
    return chatOnce(params);
  }

  function chatOnce(params) {
    const model = params.model;
    const controller = linkAbort(params.signal);
    const timeout = makeTimeout(controller, DEFAULT_TIMEOUT);

    const body = {
      model: model.model,
      messages: buildMessages(params.messages, model, { historyLimit: params.historyLimit }),
      stream: false
    };
    Object.assign(body, thinkingPayload(params.thinking));
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.maxTokens) body.max_tokens = params.maxTokens;

    let url;
    try { url = chatUrl(model.baseUrl); } catch (e) { return Promise.reject(e); }

    return fetch(url, {
      method: 'POST',
      headers: headers(model.apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(res => {
      clearTimeout(timeout);
      if (!res.ok) {
        return res.text().then(t => {
          throw makeError(extractErrorMessage(res.status, t), { status: res.status, body: t });
        }).catch(err => {
          if (err && err.status) throw err;
          throw makeError('HTTP ' + res.status, { status: res.status });
        });
      }
      return res.json();
    }).then(json => {
      const choice = json && json.choices && json.choices[0];
      let content = '';
      if (choice) {
        const msg = choice.message || {};
        content = msg.content;
        if (Array.isArray(content)) {
          content = content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
        }
        if ((content == null || content === '') && msg.reasoning_content) {
          content = '';
        }
      }
      const reasoning = choice && choice.message && choice.message.reasoning_content;
      const usage = parseUsage(json && json.usage, content);
      const out = {
        content: content || '',
        reasoning: reasoning || '',
        usage,
        raw: json,
        aborted: false,
        model: json && json.model
      };
      if (params.onDelta && out.content) params.onDelta(out.content, out.content);
      if (params.onReasoning && out.reasoning) params.onReasoning(out.reasoning);
      if (params.onDone) params.onDone(out);
      return out;
    }).catch(err => {
      clearTimeout(timeout);
      throw normalizeFetchError(err, controller);
    });
  }

  function chatStream(params) {
    const model = params.model;
    const controller = linkAbort(params.signal);

    const body = {
      model: model.model,
      messages: buildMessages(params.messages, model, { historyLimit: params.historyLimit }),
      stream: true,
      stream_options: { include_usage: true }
    };
    Object.assign(body, thinkingPayload(params.thinking));
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.maxTokens) body.max_tokens = params.maxTokens;

    let url;
    try { url = chatUrl(model.baseUrl); } catch (e) { return Promise.reject(e); }

    let timedOut = false;
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch (e) {} }, DEFAULT_TIMEOUT);
    };
    bump();

    let full = '';
    let reasoningAll = '';
    let usage = null;
    let usedStream = false;
    let respModel = '';

    return fetch(url, {
      method: 'POST',
      headers: headers(model.apiKey, { Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(res => {
      if (!res.ok) {
        return res.text().then(t => {
          throw makeError(extractErrorMessage(res.status, t), { status: res.status, body: t });
        }).catch(err => {
          if (err && err.status) throw err;
          throw makeError('HTTP ' + res.status, { status: res.status });
        });
      }
      if (params.onOpen) params.onOpen();

      // 部分网关流式返回 content-type: application/json
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const isSSE = ct.indexOf('text/event-stream') >= 0;
      const reader = (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder !== 'undefined')
        ? res.body.getReader() : null;

      // 非 SSE 响应（网关把 stream 请求当普通 JSON 处理），或浏览器不支持流式读取
      if (!reader || !isSSE) {
        // 无法流式：整体读取文本后解析
        return res.text().then(t => {
          clearTimeout(timer);
          // 可能是被标记为 JSON 但实际是 SSE 文本
          if (/^\s*data:/.test(t)) {
            const r = consumeSSE(t, {
              onDelta: (d) => { full += d; params.onDelta && params.onDelta(d, full); },
              onReasoning: (d) => { reasoningAll += d; params.onReasoning && params.onReasoning(d); },
              onUsage: (u) => { usage = u; }
            });
            usedStream = true;
            if (r.usage) usage = r.usage;
            return {};
          }
          const parsed = tryParseJSON(t);
          if (!parsed) {
            full = t;
            params.onDelta && params.onDelta(t, t);
            return {};
          }
          const choice = parsed.choices && parsed.choices[0];
          if (choice) {
            let c = (choice.message || {}).content || choice.text || '';
            if (Array.isArray(c)) c = c.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
            const rc = (choice.message || {}).reasoning_content || '';
            full = c || '';
            reasoningAll = rc || '';
            respModel = parsed.model || '';
            if (rc) params.onReasoning && params.onReasoning(rc);
            if (full) params.onDelta && params.onDelta(full, full);
          }
          usage = parsed.usage || null;
          return {};
        });
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let done = false;

      function pump() {
        return reader.read().then(({ done: finished, value }) => {
          if (finished) { done = true; return; }
          bump();
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            handleLine(line);
          }
          return pump();
        });
      }

      function handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith(':')) return;           // 注释/心跳
        if (!trimmed.startsWith('data:')) return;      // event: / id: 等忽略
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { done = true; return; }
        const obj = tryParseJSON(data);
        if (!obj) return;
        usedStream = true;
        const choice = obj.choices && obj.choices[0];
        if (obj.model) respModel = obj.model;
        if (obj.usage) usage = obj.usage;

        if (choice) {
          const delta = choice.delta || {};
          const rc = delta.reasoning_content != null ? delta.reasoning_content
            : (delta.reasoning != null ? delta.reasoning : null);
          if (rc) {
            reasoningAll += rc;
            params.onReasoning && params.onReasoning(rc);
          }
          let piece = delta.content;
          if (Array.isArray(piece)) piece = piece.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
          if (typeof piece === 'string' && piece) {
            full += piece;
            params.onDelta && params.onDelta(piece, full);
          }
          if (!piece && choice.text) {
            full += choice.text;
            params.onDelta && params.onDelta(choice.text, full);
          }
        }
      }

      return pump().then(() => {
        clearTimeout(timer);
      });
    }).then(() => {
      clearTimeout(timer);
      const out = {
        content: full,
        reasoning: reasoningAll,
        usage: parseUsage(usage, full),
        usedStream,
        model: respModel,
        aborted: false
      };
      if (params.onDone) params.onDone(out);
      return out;
    }).catch(err => {
      clearTimeout(timer);
      if (timedOut) {
        throw makeError('请求超时（长时间未收到数据）', { code: 'TIMEOUT' });
      }
      const ne = normalizeFetchError(err, controller);
      // 若已经收到部分内容，则视为可用的部分结果
      if (ne.code === 'ABORTED' && full) {
        return {
          content: full,
          reasoning: reasoningAll,
          usage: parseUsage(usage, full),
          aborted: true,
          partial: true
        };
      }
      if (ne.code === 'NETWORK' && full) {
        // 网络中断但已有内容：返回部分结果并附带警告
        return {
          content: full,
          reasoning: reasoningAll,
          usage: parseUsage(usage, full),
          aborted: true,
          partial: true,
          networkError: ne
        };
      }
      throw ne;
    });
  }

  function consumeSSE(text, handlers) {
    let usage = null;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const obj = tryParseJSON(data);
      if (!obj) continue;
      if (obj.usage) usage = obj.usage;
      const choice = obj.choices && obj.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.reasoning_content) handlers.onReasoning && handlers.onReasoning(delta.reasoning_content);
      let piece = delta.content;
      if (Array.isArray(piece)) piece = piece.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      if (typeof piece === 'string' && piece) handlers.onDelta && handlers.onDelta(piece);
      else if (choice.text) handlers.onDelta && handlers.onDelta(choice.text);
    }
    return { usage };
  }

  /* ---------- 模型列表 ---------- */
  function listModels(model) {
    let url;
    try { url = modelsUrl(model.baseUrl); } catch (e) { return Promise.reject(e); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    return fetch(url, {
      method: 'GET',
      headers: headers(model.apiKey),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(res => {
      clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(t => { throw makeError(extractErrorMessage(res.status, t), { status: res.status }); });
      }
      return res.json();
    }).then(json => {
      const arr = (json && (json.data || json.models)) || [];
      if (!Array.isArray(arr)) return [];
      return arr.map(m => {
        if (typeof m === 'string') return { id: m };
        return { id: m.id || m.name || m.model || '', owned: m.owned_by || m.owned || '' };
      }).filter(m => m.id);
    }).catch(err => {
      clearTimeout(timer);
      throw normalizeFetchError(err, controller);
    });
  }

  /* ---------- 连通性测试 ---------- */
  function testConnection(model) {
    const started = Date.now();
    const probe = Object.assign({}, model, {
      supportsStream: false
    });
    const messages = [{ role: 'user', content: 'ping' }];
    return chat({
      model: probe,
      messages,
      stream: false,
      maxTokens: 8
    }).then(res => ({
      ok: true,
      ms: Date.now() - started,
      model: res.model || probe.model,
      content: (res.content || '').slice(0, 200),
      usage: res.usage
    })).catch(err => {
      // 有些服务不支持 max_tokens=8 之类的小参数，再试一次纯 /models
      return listModels(model).then(list => ({
        ok: true,
        ms: Date.now() - started,
        via: 'models',
        models: list,
        warning: err.message
      }));
    });
  }

  /* ---------- 工具 ---------- */
  function tryParseJSON(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function makeTimeout(controller, ms) {
    return setTimeout(() => { try { controller.abort(); } catch (e) {} }, ms);
  }

  function linkAbort(signal) {
    const c = new AbortController();
    if (signal) {
      if (signal.aborted) c.abort();
      else signal.addEventListener('abort', () => { try { c.abort(); } catch (e) {} }, { once: true });
    }
    c.__external = signal;
    return c;
  }

  function normalizeFetchError(err, controller) {
    if (err && err.name === 'AbortError') {
      if (controller && controller.__external && controller.__external.aborted) {
        return makeError('已取消', { code: 'ABORTED' });
      }
      return makeError('已取消', { code: 'ABORTED' });
    }
    if (err && err.message && /Failed to fetch|NetworkError|Load failed|network/i.test(err.message)) {
      return makeError('网络请求失败：可能是跨域被拒绝、Base URL 错误或网络不可用', { code: 'NETWORK' });
    }
    if (err instanceof TypeError) {
      return makeError('网络请求失败：可能是跨域被拒绝、Base URL 错误或网络不可用', { code: 'NETWORK' });
    }
    return err;
  }

  global.API = {
    chat,
    listModels,
    testConnection,
    buildMessages,
    chatUrl,
    modelsUrl,
    joinUrl,
    parseUsage,
    thinkingPayload
  };
})(window);
