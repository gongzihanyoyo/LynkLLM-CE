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
    if (lower.endsWith('/images/generations')) {
      if (path === '/images/generations') return b;
      b = b.slice(0, -'/images/generations'.length);
    }
    if (lower.endsWith('/models') && path === '/models') return b;
    if (lower.endsWith('/models')) b = b.slice(0, -'/models'.length);
    // 若未带版本段，也不强行补全（兼容第三方网关，如 https://api.xxx.com）
    return b + path;
  }

  function chatUrl(base) { return joinUrl(base, '/chat/completions'); }
  function modelsUrl(base) { return joinUrl(base, '/models'); }
  function imagesUrl(base) { return joinUrl(base, '/images/generations'); }

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
    let list = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));

    // 上下文裁剪（按消息条数做保守限制）
    if (opts.historyLimit && list.length > opts.historyLimit) {
      list = list.slice(list.length - opts.historyLimit);
    }

    list.forEach(m => {
      if (m.role === 'assistant') {
        // 带工具调用的助手消息：必须原样回传给服务端
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          out.push({
            role: 'assistant',
            content: typeof m.content === 'string' ? m.content : '',
            tool_calls: m.tool_calls
          });
          return;
        }
        if (typeof m.content === 'string' && m.content.trim()) {
          out.push({ role: 'assistant', content: m.content });
        }
        return;
      }
      if (m.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: m.tool_call_id || '',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
        });
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

  /* ---------- 工具调用（Tool Call）---------- */

  /** 工具定义归一化：仅接受 { type:'function', function:{ name, description, parameters } } */
  function normalizeTools(tools) {
    if (!Array.isArray(tools) || !tools.length) return null;
    const out = [];
    tools.forEach(t => {
      if (!t || typeof t !== 'object') return;
      const fn = (t.type === 'function' && t.function) ? t.function : null;
      if (!fn || !fn.name) return;
      out.push({
        type: 'function',
        function: {
          name: String(fn.name),
          description: String(fn.description || ''),
          parameters: fn.parameters || { type: 'object', properties: {} }
        }
      });
    });
    return out.length ? out : null;
  }

  /** 把工具定义写入请求体 */
  function applyTools(body, params) {
    const tools = normalizeTools(params.tools);
    if (!tools) return;
    body.tools = tools;
    body.tool_choice = params.toolChoice || 'auto';
  }

  /** 空白的工具调用槽位 */
  function emptyToolCall() {
    return { id: '', type: 'function', function: { name: '', arguments: '' } };
  }

  /**
   * 合并流式返回的 tool_calls 片段。
   * 各家网关的分片方式不同：name 通常整块下发，arguments 逐字符下发。
   * 这里对 name 做去重累加，对 arguments 直接累加。
   */
  function mergeToolCallDeltas(acc, deltas) {
    if (!Array.isArray(deltas)) return acc;
    deltas.forEach((d, fallbackIndex) => {
      if (!d || typeof d !== 'object') return;
      const idx = (d.index != null && !isNaN(Number(d.index))) ? Number(d.index) : fallbackIndex;
      if (!acc[idx]) acc[idx] = emptyToolCall();
      const slot = acc[idx];
      if (d.id) slot.id = String(d.id);
      if (d.type) slot.type = String(d.type);
      const fn = d.function || d.function_call;
      if (fn) {
        if (fn.name) {
          const n = String(fn.name);
          const cur = slot.function.name;
          if (!cur) slot.function.name = n;
          else if (cur === n) { /* 重复下发，忽略 */ }
          else if (n.indexOf(cur) === 0) slot.function.name = n;      // 整块覆盖分片
          else slot.function.name = cur + n;                          // 真·分片
        }
        if (fn.arguments) slot.function.arguments += String(fn.arguments);
      }
    });
    return acc;
  }

  /** 去掉空洞并补齐 id，得到最终的工具调用列表 */
  function finalizeToolCalls(acc) {
    if (!acc) return [];
    const out = [];
    acc.forEach((slot, i) => {
      if (!slot || !slot.function || (!slot.function.name && !slot.function.arguments)) return;
      out.push({
        id: slot.id || ('call_' + i + '_' + Date.now().toString(36)),
        type: 'function',
        function: {
          name: slot.function.name || '',
          arguments: slot.function.arguments || ''
        }
      });
    });
    return out;
  }

  /** 从非流式响应中提取 tool_calls */
  function extractToolCalls(message) {
    if (!message || !Array.isArray(message.tool_calls)) return [];
    return message.tool_calls.map((tc, i) => ({
      id: tc.id || ('call_' + i + '_' + Date.now().toString(36)),
      type: 'function',
      function: {
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || ''
      }
    })).filter(t => t.function.name);
  }

  /** 安全解析工具参数 */
  function parseToolArgs(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return {};
    try {
      const v = JSON.parse(s);
      return (v && typeof v === 'object') ? v : {};
    } catch (e) {
      // 少数模型会给出非严格 JSON，退化为空对象并保留原文
      return { __raw: s };
    }
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
    applyTools(body, params);

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
      const message = (choice && choice.message) || {};
      let content = message.content;
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      }
      if (content == null) content = '';
      const reasoning = message.reasoning_content;
      const toolCalls = extractToolCalls(message);
      const usage = parseUsage(json && json.usage, content);
      const out = {
        content: content || '',
        reasoning: reasoning || '',
        toolCalls,
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
    applyTools(body, params);

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
    const toolAcc = [];

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
            if (r.toolCalls && r.toolCalls.length) mergeToolCallDeltas(toolAcc, r.toolCalls.map((c, i) => ({
              index: i, id: c.id, type: c.type, function: c.function
            })));
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
            mergeToolCallDeltas(toolAcc, (choice.message || {}).tool_calls);
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
          if (delta.tool_calls) {
            mergeToolCallDeltas(toolAcc, delta.tool_calls);
            params.onToolCallDelta && params.onToolCallDelta(finalizeToolCalls(toolAcc));
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
        toolCalls: finalizeToolCalls(toolAcc),
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
          toolCalls: finalizeToolCalls(toolAcc),
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
          toolCalls: finalizeToolCalls(toolAcc),
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
    const toolAcc = [];
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
      if (delta.tool_calls) mergeToolCallDeltas(toolAcc, delta.tool_calls);
      let piece = delta.content;
      if (Array.isArray(piece)) piece = piece.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      if (typeof piece === 'string' && piece) handlers.onDelta && handlers.onDelta(piece);
      else if (choice.text) handlers.onDelta && handlers.onDelta(choice.text);
    }
    return { usage, toolCalls: finalizeToolCalls(toolAcc) };
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

  /* ==========================================================================
     图片生成
     --------------------------------------------------------------------------
     主路径：OpenAI 兼容协议 POST {base}/images/generations
       body: { model, prompt, n, size: "宽x高"|"auto", image?(图生图) }
       resp: { created, data: [{ url } | { b64_json }], usage }
     回退路径：部分网关未实现 /images/generations，只把图片模型挂在
       /chat/completions 上，此时改用对话接口并在返回内容中解析图片。
     ========================================================================== */

  const IMAGE_TIMEOUT = 600000;   // 图像生成耗时较长，给 10 分钟

  /** 尺寸归一化：'自动' / 空 → 'auto'，其余统一为「宽x高」 */
  function normalizeSize(size) {
    const s = String(size == null ? '' : size).trim().toLowerCase();
    if (!s || s === 'auto' || s === '自动') return 'auto';
    const m = s.match(/^(\d{2,5})\s*[x*×]\s*(\d{2,5})$/);
    if (m) return m[1] + 'x' + m[2];
    return s;
  }

  /** 从任意响应里尽力提取图片地址 */
  function extractImages(json) {
    const out = [];
    if (!json) return out;

    const push = (item) => {
      if (!item) return;
      if (typeof item === 'string') { out.push({ url: item }); return; }
      if (item.b64_json) { out.push({ b64: item.b64_json, revisedPrompt: item.revised_prompt }); return; }
      if (item.url) { out.push({ url: item.url, revisedPrompt: item.revised_prompt }); return; }
      // 少数网关用 image_url 包装
      const u = item.image_url && (item.image_url.url || item.image_url);
      if (typeof u === 'string' && u) { out.push({ url: u, revisedPrompt: item.revised_prompt }); }
    };

    if (Array.isArray(json.data)) json.data.forEach(push);
    if (!out.length && Array.isArray(json.images)) json.images.forEach(push);

    const choice = json.choices && json.choices[0];
    if (choice && choice.message) {
      if (Array.isArray(choice.message.images)) choice.message.images.forEach(push);
      const content = choice.message.content;
      if (typeof content === 'string' && content) {
        collectUrlsFromText(content).forEach(u => out.push({ url: u }));
      } else if (Array.isArray(content)) {
        content.forEach(part => {
          if (part && (part.type === 'image_url' || part.image_url)) {
            const u = part.image_url && (part.image_url.url || part.image_url);
            if (typeof u === 'string' && u) out.push({ url: u });
          }
        });
      }
    }
    // 去重
    const seen = {};
    return out.filter(o => {
      const k = o.url || o.b64;
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /** 从文本（markdown / HTML / 裸链接）里抓取图片地址 */
  function collectUrlsFromText(text) {
    const urls = [];
    const re = /(?:!\[[^\]]*\]\(\s*|<img[^>]+src=["'])(https?:\/\/[^\s)"'<>]+)|(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif|bmp|tiff)(?:\?[^\s)"'<>]*)?)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const u = m[1] || m[2];
      if (u) urls.push(u);
    }
    return urls;
  }

  /**
   * 生成图片
   * @param {object} params
   *   model          {object} 图片模型配置
   *   prompt         {string}
   *   n              {number} 生成数量
   *   size           {string} '自动' | 'auto' | '1024x1024'
   *   images         {Array<{dataUrl:string}>} 图生图输入（可选）
   *   signal         {AbortSignal}
   *   onProgress     {(stage:string, info:object)=>void}
   *   allowFallback  {boolean} 是否允许回退到 /chat/completions（默认允许）
   * @returns {Promise<{images:Array, usage:object|null, via:string, raw:any, model:string}>}
   */
  function generateImage(params) {
    const model = params.model || {};
    if (!model.baseUrl) return Promise.reject(makeError('未配置 Base URL', { code: 'NO_BASE_URL' }));
    if (!model.model) return Promise.reject(makeError('未配置模型名称', { code: 'NO_MODEL' }));
    const prompt = String(params.prompt || '').trim();
    if (!prompt) return Promise.reject(makeError('提示词不能为空', { code: 'NO_PROMPT' }));

    const started = Date.now();
    const notify = (stage, info) => { if (params.onProgress) params.onProgress(stage, info || {}); };
    notify('start', {});

    return imageViaImagesEndpoint(params).then(res => {
      notify('done', { ms: Date.now() - started });
      return res;
    }).catch(err => {
      const canFallback = params.allowFallback !== false && isEndpointMissing(err);
      if (!canFallback) throw err;
      // 该网关没有 /images/generations：改用 /chat/completions 再试一次
      console.warn('[api] /images/generations 不可用，回退到 /chat/completions：', err && err.message);
      notify('fallback', {});
      return imageViaChatEndpoint(params).then(res => {
        notify('done', { ms: Date.now() - started, via: 'chat' });
        return res;
      });
    });
  }

  /** 该错误是否代表「接口不存在」 */
  function isEndpointMissing(err) {
    if (!err) return false;
    if (err.status === 404 || err.status === 405 || err.status === 501) return true;
    if (err.code === 'NETWORK') return false;
    const msg = String(err.message || '').toLowerCase();
    return /not\s*found|no\s*such|unsupported|未实现|不存在|invalid\s*url|url\s*error/.test(msg);
  }

  /** 主路径：POST /images/generations */
  function imageViaImagesEndpoint(params) {
    const model = params.model;
    const controller = linkAbort(params.signal);
    const timer = makeTimeout(controller, IMAGE_TIMEOUT);

    const size = normalizeSize(params.size);
    const body = {
      model: model.model,
      prompt: String(params.prompt || '').trim(),
      n: Math.min(6, Math.max(1, Number(params.n) || 1))
    };
    if (size) body.size = size;
    if (params.negativePrompt) body.negative_prompt = String(params.negativePrompt);
    if (params.seed !== '' && params.seed != null) body.seed = Number(params.seed);

    const input = (params.images || []).filter(i => i && i.dataUrl);
    if (input.length) {
      const urls = input.map(i => i.dataUrl);
      body.image = urls.length === 1 ? urls[0] : urls;
    }

    let url;
    try { url = imagesUrl(model.baseUrl); } catch (e) { return Promise.reject(e); }

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
      clearTimeout(timer);
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
      if (json && json.error) {
        throw makeError(json.error.message || '图片生成失败', { body: JSON.stringify(json.error) });
      }
      const images = extractImages(json);
      if (!images.length) throw makeError('接口未返回图片', { code: 'NO_IMAGE', body: JSON.stringify(json).slice(0, 500) });
      return {
        images,
        usage: parseImageUsage(json && json.usage),
        via: 'images',
        model: (json && json.model) || model.model,
        raw: json
      };
    }).catch(err => {
      clearTimeout(timer);
      throw normalizeFetchError(err, controller);
    });
  }

  /** 回退路径：把图片模型当对话模型调用 */
  function imageViaChatEndpoint(params) {
    const model = params.model;
    const controller = linkAbort(params.signal);
    const timer = makeTimeout(controller, IMAGE_TIMEOUT);

    const parts = [{ type: 'text', text: String(params.prompt || '').trim() }];
    (params.images || []).filter(i => i && i.dataUrl).forEach(i => {
      parts.push({ type: 'image_url', image_url: { url: i.dataUrl } });
    });

    const size = normalizeSize(params.size);
    const body = {
      model: model.model,
      messages: [{ role: 'user', content: parts }],
      n: Math.min(6, Math.max(1, Number(params.n) || 1)),
      stream: false
    };
    // 这类网关多数沿用 DashScope 原生尺寸写法，用 * 分隔
    if (size && size !== 'auto') body.size = size.replace(/x/g, '*');

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
      clearTimeout(timer);
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
      if (json && json.error) {
        throw makeError(json.error.message || '图片生成失败', { body: JSON.stringify(json.error) });
      }
      const images = extractImages(json);
      if (!images.length) {
        throw makeError('该接口未返回图片，可能不支持图片生成', { code: 'NO_IMAGE', body: JSON.stringify(json).slice(0, 500) });
      }
      return {
        images,
        usage: parseImageUsage(json && json.usage),
        via: 'chat',
        model: (json && json.model) || model.model,
        raw: json
      };
    }).catch(err => {
      clearTimeout(timer);
      throw normalizeFetchError(err, controller);
    });
  }

  /** 图片用量（与 token 用量不同，仅做展示） */
  function parseImageUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const count = Number(u.output_image_count);
    const w = Number(u.output_width);
    const h = Number(u.output_height);
    if (!count && !w && !h) return null;
    return {
      count: isNaN(count) ? null : count,
      width: isNaN(w) ? null : w,
      height: isNaN(h) ? null : h,
      inputCount: isNaN(Number(u.input_image_count)) ? null : Number(u.input_image_count)
    };
  }

  /**
   * 下载远端图片并转成 dataURL（服务商链接通常有有效期，需要尽快落到本地）
   * @param {string} url
   * @returns {Promise<string>} dataURL
   */
  function fetchImageAsDataUrl(url) {
    return fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(res => {
        if (!res.ok) throw makeError('HTTP ' + res.status, { status: res.status });
        return res.blob();
      })
      .then(blob => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(makeError('图片读取失败'));
        fr.readAsDataURL(blob);
      }))
      .catch(err => {
        // 跨域被拒时给出可识别的错误码，便于上层降级处理
        if (err && (err.code === 'NETWORK' || err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message)))) {
          throw makeError('图片链接不允许跨域读取', { code: 'IMG_CORS' });
        }
        throw err;
      });
  }

  /**
   * 把 b64_json 归一化为 dataURL
   */
  function b64ToDataUrl(b64, mime) {
    const s = String(b64 || '');
    if (!s) return '';
    if (s.startsWith('data:')) return s;
    return 'data:' + (mime || 'image/png') + ';base64,' + s;
  }

  /* ==========================================================================
     Tavily 联网搜索
     --------------------------------------------------------------------------
     官方接口：POST https://api.tavily.com/search
       Header: Authorization: Bearer <api key>
       Body:   { query, topic, search_depth, chunks_per_source, max_results,
                 time_range, start_date, end_date, include_answer,
                 include_raw_content, include_images, include_image_descriptions,
                 include_favicon, include_domains, exclude_domains, country,
                 auto_parameters, include_usage }
     返回：  { query, answer, results: [{ title, url, content, score, raw_content }],
               images, response_time, request_id, usage }
     ========================================================================== */

  const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
  const TAVILY_TIMEOUT = 60000;

  const TAVILY_TOPICS = ['general', 'news', 'finance'];
  const TAVILY_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast'];
  const TAVILY_TIME_RANGES = ['day', 'week', 'month', 'year'];

  function pickEnum(v, allowed, fallback) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return allowed.indexOf(s) >= 0 ? s : fallback;
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function strList(v, limit) {
    let arr = v;
    if (typeof arr === 'string') arr = arr.split(/[,，\s]+/);
    if (!Array.isArray(arr)) return [];
    return arr.map(s => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, limit || 20);
  }

  /** 日期归一化：接受 YYYY-MM-DD，其他格式返回 '' */
  function normalizeDate(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? s : '';
  }

  /** include_answer：支持 true / false / 'basic' / 'advanced' */
  function normalizeIncludeAnswer(v) {
    if (v === true || v === 'true') return true;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'basic' || s === 'advanced') return s;
    return false;
  }

  /**
   * 依据工具参数构造 Tavily 请求体，并补上服务端默认值。
   * 除 query 外全部可选，模型可自由指定；未指定时使用此处的默认值。
   */
  function buildTavilyBody(args) {
    const a = args || {};
    const body = {
      query: String(a.query == null ? '' : a.query).trim(),
      auto_parameters: a.auto_parameters === true,
      topic: pickEnum(a.topic, TAVILY_TOPICS, 'general'),
      search_depth: pickEnum(a.search_depth, TAVILY_DEPTHS, 'basic'),
      chunks_per_source: clampInt(a.chunks_per_source, 1, 3, 3),
      max_results: clampInt(a.max_results, 1, 20, 5),
      include_answer: normalizeIncludeAnswer(a.include_answer),
      include_raw_content: a.include_raw_content === true || a.include_raw_content === 'true',
      include_images: a.include_images === true || a.include_images === 'true',
      include_image_descriptions: a.include_image_descriptions === true || a.include_image_descriptions === 'true',
      include_favicon: a.include_favicon === true || a.include_favicon === 'true',
      include_domains: strList(a.include_domains),
      exclude_domains: strList(a.exclude_domains),
      country: a.country ? String(a.country).trim().toLowerCase() : ''
    };

    // 以下字段留空时直接省略，避免服务端拒绝
    const tr = pickEnum(a.time_range, TAVILY_TIME_RANGES, '');
    if (tr) body.time_range = tr;
    const sd = normalizeDate(a.start_date);
    const ed = normalizeDate(a.end_date);
    if (sd) body.start_date = sd;
    if (ed) body.end_date = ed;
    if (!body.country) delete body.country;
    if (a.include_usage === true || a.include_usage === 'true') body.include_usage = true;

    if (a.search_depth === 'advanced' || a.search_depth === 'fast' || a.search_depth === 'ultra-fast') {
      // 这些深度才支持 chunks_per_source；basic 下传了也无害，但保持精简
    }
    if (body.search_depth === 'basic') delete body.chunks_per_source;
    return body;
  }

  /**
   * 调用 Tavily 搜索
   * @param {object} args 搜索参数（见 buildTavilyBody）
   * @param {string} apiKey
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>} 归一化后的 { query, answer, results, images, responseTime, requestId, usage }
   */
  function tavilySearch(args, apiKey, signal) {
    const key = String(apiKey || '').trim();
    if (!key) return Promise.reject(makeError('未配置 Tavily API Key', { code: 'NO_TAVILY_KEY' }));

    const body = buildTavilyBody(args);
    if (!body.query) return Promise.reject(makeError('搜索关键词不能为空', { code: 'NO_QUERY' }));

    const controller = linkAbort(signal);
    const timer = makeTimeout(controller, TAVILY_TIMEOUT);
    const started = Date.now();

    return fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(res => {
      clearTimeout(timer);
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
      const results = (json && Array.isArray(json.results) ? json.results : []).map((r, i) => ({
        title: String((r && r.title) || '').trim() || ('Result ' + (i + 1)),
        url: String((r && r.url) || ''),
        content: String((r && r.content) || ''),
        rawContent: (r && r.raw_content) || '',
        score: (r && typeof r.score === 'number') ? r.score : null,
        favicon: (r && r.favicon) || ''
      }));
      return {
        query: (json && json.query) || body.query,
        answer: (json && json.answer) || '',
        results,
        images: (json && Array.isArray(json.images)) ? json.images : [],
        followUp: (json && json.follow_up_questions) || null,
        responseTime: (json && json.response_time) || ((Date.now() - started) / 1000),
        requestId: (json && json.request_id) || '',
        usage: (json && json.usage) || null,
        params: body
      };
    }).catch(err => {
      clearTimeout(timer);
      throw normalizeFetchError(err, controller);
    });
  }

  /** Tavily 连通性测试：用一次最小查询验证 Key 是否可用 */
  function testTavily(apiKey) {
    const started = Date.now();
    return tavilySearch({ query: 'Tavily API connectivity test', max_results: 1 }, apiKey)
      .then(res => ({
        ok: true,
        ms: Date.now() - started,
        results: res.results.length,
        responseTime: res.responseTime,
        sample: res.results.length ? res.results[0].title : ''
      }));
  }

  /**
   * 把搜索结果压缩成给模型看的文本（控制长度，避免撑爆上下文）
   */
  function formatTavilyForModel(res, opts) {
    opts = opts || {};
    const maxContent = opts.maxContent || 1200;
    const lines = [];
    if (res.answer) lines.push('Answer summary: ' + res.answer);
    (res.results || []).forEach((r, i) => {
      const content = opts.raw ? (r.rawContent || r.content) : r.content;
      let text = String(content || '');
      if (text.length > maxContent) text = text.slice(0, maxContent) + '…';
      lines.push([
        '[' + (i + 1) + '] ' + r.title,
        'URL: ' + r.url,
        text ? 'Content: ' + text : ''
      ].filter(Boolean).join('\n'));
    });
    if (!lines.length) lines.push('No results found.');
    return lines.join('\n\n');
  }

  /** 供模型使用的 Tavily 搜索工具定义（参数尽量完整开放） */
  function tavilyTool() {
    return {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the live web with Tavily. Use it whenever the answer depends on '
          + 'up-to-date facts, news, prices, weather, releases, people, or anything you are '
          + 'unsure about. You may call it multiple times with different queries or settings. '
          + 'Prefer precise, keyword-rich queries (and set topic="news" for current events).',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query. Be specific and keyword-rich, e.g. "LynkLLM CE 版本更新".'
            },
            topic: {
              type: 'string',
              enum: TAVILY_TOPICS,
              description: 'general (default) for any topic, news for current events, finance for market data.'
            },
            search_depth: {
              type: 'string',
              enum: TAVILY_DEPTHS,
              description: 'basic (default) balances speed and quality; advanced is slower but more thorough; '
                + 'fast / ultra-fast trade quality for latency.'
            },
            chunks_per_source: {
              type: 'integer',
              minimum: 1,
              maximum: 3,
              description: 'Number of content chunks returned per source. Only meaningful for advanced / fast / ultra-fast. Default 3.'
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description: 'How many results to return. Default 5. Use 1–3 for a quick fact, more for research.'
            },
            time_range: {
              type: 'string',
              enum: TAVILY_TIME_RANGES,
              description: 'Restrict results to the last day / week / month / year.'
            },
            start_date: {
              type: 'string',
              description: 'Only results published on or after this date, format YYYY-MM-DD.'
            },
            end_date: {
              type: 'string',
              description: 'Only results published on or before this date, format YYYY-MM-DD.'
            },
            include_answer: {
              type: 'boolean',
              description: 'Ask Tavily for a short generated answer in addition to the raw results.'
            },
            include_raw_content: {
              type: 'boolean',
              description: 'Return the cleaned full page text of each result (much longer).'
            },
            include_images: {
              type: 'boolean',
              description: 'Also return images related to the query.'
            },
            include_image_descriptions: {
              type: 'boolean',
              description: 'Include a short description for every returned image.'
            },
            include_favicon: {
              type: 'boolean',
              description: 'Include each result’s favicon URL.'
            },
            include_domains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Whitelist: only search inside these domains, e.g. ["arxiv.org"].'
            },
            exclude_domains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Blacklist: never return results from these domains.'
            },
            country: {
              type: 'string',
              description: 'Boost results from a specific country (topic="general" only), e.g. "china", "united states".'
            },
            auto_parameters: {
              type: 'boolean',
              description: 'Let Tavily pick topic / search_depth automatically from the query. Default false.'
            },
            include_usage: {
              type: 'boolean',
              description: 'Return credit usage information for this request.'
            }
          },
          required: ['query']
        }
      }
    };
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
    generateImage,
    fetchImageAsDataUrl,
    b64ToDataUrl,
    normalizeSize,
    extractImages,
    buildMessages,
    chatUrl,
    modelsUrl,
    imagesUrl,
    joinUrl,
    parseUsage,
    thinkingPayload,
    /* 工具调用 */
    normalizeTools,
    normalizeToolCalls: finalizeToolCalls,
    mergeToolCallDeltas,
    parseToolArgs,
    /* Tavily */
    tavilySearch,
    testTavily,
    tavilyTool,
    buildTavilyBody,
    formatTavilyForModel,
    TAVILY_TOPICS,
    TAVILY_DEPTHS,
    TAVILY_TIME_RANGES,
    TAVILY_SEARCH_URL
  };
})(window);
