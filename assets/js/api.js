/* ==========================================================================
   LynkLLM CE — OpenAI 兼容 API 客户端
   支持：流式（SSE）/ 非流式对话、模型列表查询、连通性测试、多模态消息
   ========================================================================== */
(function (global) {
  'use strict';

  const DEFAULT_TIMEOUT = 180000; // 3 分钟无数据则超时

  /* ---------- URL 处理 ---------- */
  /**
   * 网络请求统一入口。
   * 只有在「模型开启了绕过 CORS」且「增强脚本已连接」时，才交给油猴脚本转发；
   * 其余情况一律走浏览器原生 fetch —— 所以不装脚本时全部功能照常可用。
   * @see assets/js/enhancer.js
   */
  /**
   * 取 i18n 文案。
   * ⚠️ 第 20 轮新增：原先本模块的错误消息全是**硬编码中文**，
   * 切到英文时「请求超时」「网络请求失败」这些仍然显示中文。
   * i18n.js 在 api.js 之前加载，所以正常情况下 I18N 一定在；
   * 万一不在（脚本没加载上来），宁可显示键名也不要崩。
   */
  function t(key) {
    try { return (global.I18N && global.I18N.t) ? global.I18N.t(key) : key; } catch (e) { return key; }
  }

  function httpFetch(url, init) {
    const E = global.Enhancer;
    if (E && E.shouldBypass(url)) return E.request(url, init);
    // ⚠️ 这里刻意用 **global.fetch**（调用时才解析）而不是在模块加载时
    // 绑死一个原生实现：后者会让「替换 window.fetch 做桩」的测试与其它
    // 用户脚本失效 —— 那不必要地改变了应用原本的可观测行为。
    // 用 global.fetch 也没有递归风险：它是原生实现，不是 httpFetch 自己。
    return global.fetch(url, init);
  }

  function joinUrl(base, path) {
    let b = String(base || '').trim();
    if (!b) throw new Error(t('errNoBaseUrl'));
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
   * @param {object} opts { historyLimit, skillsPrompt }
   */
  function buildMessages(messages, model, opts) {
    opts = opts || {};
    const out = [];
    const sys = (model && model.systemPrompt) ? String(model.systemPrompt).trim() : '';
    if (sys) out.push({ role: 'system', content: sys });
    /* 技能（模型不支持工具调用时）：**另起一条** system 消息 ——
       与上面用户自己写的系统提示词互不干扰（用户明确要求「分开」）。 */
    const skills = String(opts.skillsPrompt || '').trim();
    if (skills) out.push({ role: 'system', content: skills });

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
          /* replay：上一轮的思考块（Anthropic / Responses 在工具轮里要求回传，见上文） */
          out.push({
            role: 'assistant',
            content: typeof m.content === 'string' ? m.content : '',
            tool_calls: m.tool_calls,
            replay: m.replay
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

  /**
   * 档位别名 → 规范化后的 effort。
   * 返回 `''` 表示「交给供应商自己决定」（auto / default / 未配置）。
   *
   * ⚠️ 三种线格式的**开关语义完全不同**，所以这里只做「读档位」这一件事，
   *    写出线上参数由下面各家的函数分别负责（详见那段长注释）。
   */
  function effortOf(level) {
    if (!level) return '';
    const l = String(level).trim().toLowerCase();
    if (!l || l === 'auto' || l === 'default') return '';
    if (l === 'off' || l === 'none' || l === 'disabled') return 'none';
    if (l === 'on' || l === 'enable' || l === 'enabled') return 'medium';
    // 其他自定义值：原样下传（各家不认时由服务端报错）
    return /^[a-z0-9_-]+$/.test(l) ? l : '';
  }

  /** Chat Completions 的思考强度（OpenAI 系写法） */
  function thinkingPayload(level) {
    const e = effortOf(level);
    return e ? { reasoning_effort: e } : {};
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

  /* ==========================================================================
     技能（Skills，单文件 SKILL.md）—— 第 18 轮
     --------------------------------------------------------------------------
     两种用法，取决于模型**支不支持工具调用**：

       · 支持 → 下发一个 `load_skill` 工具（只暴露 name + description），
         模型需要时自己调用，**那时**才把整份文件作为工具结果给它；
       · 不支持 → 把已启用技能的全文作为**独立的一条 system 消息**注入，
         与模型编辑页里用户写的系统提示词**分开**（互不覆盖）。

     用户明确要求：不做额外的渲染与校验，调用时整份原文交给模型。
     ========================================================================== */

  const SKILL_TOOL_NAME = 'load_skill';

  /** 已启用技能 → `load_skill` 工具定义（没有技能时返回 null）。 */
  function skillTool(skills) {
    const list = (skills || []).filter(s => s && s.name);
    if (!list.length) return null;
    const lines = list.map(s => '- ' + s.name + ': ' + (s.description || '(no description)'));
    const desc = [
      'Load the full instructions of a Skill by name and follow them.',
      'A Skill is a SKILL.md document: the user has enabled the ones listed below.',
      'Call this tool as soon as the request matches a skill — do not guess its content.',
      '',
      'Available skills:'
    ].concat(lines).join('\n');
    return {
      type: 'function',
      function: {
        name: SKILL_TOOL_NAME,
        description: desc,
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: list.map(s => s.name),
              description: 'Name of the skill to load, exactly as listed above.'
            }
          },
          required: ['name']
        }
      }
    };
  }

  /**
   * 已启用技能 → 一段**独立**的系统说明（模型不支持工具调用时用）。
   * 只放用户勾选的那些，且全部塞进同一条消息里（用户要求）。
   */
  function skillSystemPrompt(skills) {
    const list = (skills || []).filter(s => s && s.content);
    if (!list.length) return '';
    const body = list.map(s => {
      const head = '### ' + s.name + (s.description ? ' — ' + s.description : '');
      return head + '\n\n' + s.content;
    }).join('\n\n---\n\n');
    return 'The user has enabled the following Skills (SKILL.md documents). '
      + 'Treat them as authoritative instructions and follow the relevant one when the task matches.\n\n'
      + body;
  }

  /** 按名字取技能（`load_skill` 的入参可能带空格/大小写差异，这里做一次松弛匹配） */
  function findSkillByName(skills, name) {
    const want = String(name == null ? '' : name).trim().toLowerCase();
    if (!want) return null;
    const list = skills || [];
    return list.find(s => String(s.name || '').trim().toLowerCase() === want)
      || list.find(s => String(s.name || '').trim().toLowerCase().indexOf(want) >= 0)
      || null;
  }

  /** `load_skill` 的工具结果 = 整份 SKILL.md 原文 */
  function formatSkillForModel(skill) {
    if (!skill) {
      return JSON.stringify({
        error: 'skill not found',
        note: 'No skill with that name is enabled. Continue without it and tell the user.'
      });
    }
    return String(skill.content || '');
  }

  /* ==========================================================================
     API 格式适配（第 17 轮）
     --------------------------------------------------------------------------
     对话模型支持三种线格式：
       chat       OpenAI Chat Completions   POST {base}/chat/completions   （默认）
       responses  OpenAI Responses          POST {base}/responses
       anthropic  Anthropic Messages        POST {base}/v1/messages

     ⚠️ 图片 / 语音模型**始终**走 chat —— 在 Store.normalizeModel 里已经固定，
        所以这层适配只影响对话。

     设计取向：**只翻译线格式，不动上层**。chat.js 拿到的结果形状与原来完全一致
     （content / reasoning / toolCalls / usage / model / usedStream），
     工具定义也仍以 OpenAI 的形状传进来，由这里转写各家的写法。
     ========================================================================== */

  const API_FORMATS = ['chat', 'responses', 'anthropic'];

  /** 读取模型配置里的格式（非法值一律回落到 chat） */
  function formatOf(model) {
    const f = model && model.apiFormat;
    return API_FORMATS.indexOf(f) >= 0 ? f : 'chat';
  }

  /**
   * Anthropic 端点的拼接：**原样用用户填的 base，只追加端点段**。
   *
   * ⚠️ 第 18 轮按用户要求**去掉了「自动补 /v1」**：以前是 `{base}/v1/messages`，
   *    现在是 `{base}/messages` —— 版本段由用户自己在 base 里写清。
   *    所以编辑页的示例给的是 `https://api.anthropic.com/v1`（见 settings.js），
   *    拼出来正好是 `…/v1/messages`。
   *    好处：像 DeepSeek 的 `https://api.deepseek.com/anthropic/v1` 这类
   *    「版本段不在末尾」的网关不会再被拼错。
   */
  function anthropicBase(base) {
    const b = String(base == null ? '' : base).trim().replace(/\/+$/, '');
    if (!b) throw new Error(t('errNoBaseUrl'));
    return b;
  }

  /** base 末尾已经写到端点段时原样用，避免出现 /messages/messages */
  function anthropicUrl(base, seg) {
    const b = anthropicBase(base);
    const re = new RegExp('/' + seg + '$', 'i');
    return re.test(b) ? b : b + '/' + seg;
  }

  /** 把 base 末尾误填的端点段去掉后再拼，避免出现 /responses/responses */
  function responsesUrl(base) {
    const b = String(base == null ? '' : base).trim().replace(/\/+$/, '');
    if (!b) throw new Error(t('errNoBaseUrl'));
    if (/\/responses$/i.test(b)) return b;
    return joinUrl(b, '/responses');
  }

  /** 对话请求的完整地址（按格式） */
  function endpointFor(base, format) {
    if (format === 'responses') return responsesUrl(base);
    if (format === 'anthropic') return anthropicUrl(base, 'messages');
    return chatUrl(base);
  }

  /** 模型列表的完整地址（按格式）——Anthropic 挂在同一个 base 下 */
  function modelsEndpointFor(base, format) {
    if (format === 'anthropic') return anthropicUrl(base, 'models');
    return modelsUrl(base);
  }

  /**
   * 各格式的请求头。
   * ⚠️ Anthropic 用 `x-api-key` 而**不是** `Authorization: Bearer`；
   *    浏览器直连官方 API 还要求显式声明 `anthropic-dangerous-direct-browser-access`，
   *    否则会被 CORS 直接挡掉（第三方兼容网关不认这个头也无害）。
   */
  function formatHeaders(apiKey, format, extra) {
    if (format !== 'anthropic') return headers(apiKey, extra);
    const h = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    }, extra || {});
    const k = String(apiKey == null ? '' : apiKey).trim();
    if (k) h['x-api-key'] = k;
    return h;
  }

  /* ---------- 消息 / 工具的格式转写 ---------- */

  /**
   * 把 OpenAI 形状的消息表拆成「系统提示 + 其余」。
   * ⚠️ 第 18 轮起返回的是**数组**（blocks）而不是拼好的字符串 —— 因为技能注入
   *    会产生**第二条** system 消息，而用户要求它跟模型编辑页的系统提示词**分开**，
   *    不能在这里就拼成一坨（Anthropic 用块数组、Responses 用独立的 system 项来表达）。
   */
  function splitSystem(list) {
    const blocks = [];
    const rest = [];
    (list || []).forEach(m => {
      if (m && m.role === 'system') {
        const t = typeof m.content === 'string' ? m.content : '';
        if (t) blocks.push(t);
        return;
      }
      rest.push(m);
    });
    return { blocks, rest };
  }

  /**
   * ⚠️⚠️ **思考内容必须原样回传**（踩过，非可选）：
   * 这些端点处于 thinking 模式时，上一轮助手消息里的思考块会在下一轮被校验 ——
   * 少了它服务端直接 400：
   *   Anthropic: The `content[].thinking` in the thinking mode must be passed back to the API.
   *   Responses: The `reasoning_text` in the thinking mode must be passed back to the API.
   * 触发条件是「该助手消息后面紧跟工具结果」（也就是工具调用的那一轮），
   * 所以 api.js 把思考块随结果一起返回（`replay`），chat.js 记进本轮轨迹，
   * 下一轮再由下面的转写函数放回去。实测：
   *   · Anthropic 的 thinking 块**空串也接受**（兜底可用），signature 非必需但照带；
   *   · Responses 的空 reasoning_text **不接受**，必须带真实文本。
   */

  /** 取 Responses 的 reasoning 项里的文本（不同实现放在 content[] 或 summary[]） */
  function reasoningTextOf(item) {
    const parts = [];
    (Array.isArray(item && item.content) ? item.content : []).forEach(c => {
      if (c && typeof c.text === 'string') parts.push(c.text);
    });
    (Array.isArray(item && item.summary) ? item.summary : []).forEach(x => {
      if (x && x.text) parts.push(x.text);
    });
    return parts.join('');
  }

  /** 文本内容里的 dataURL 图片 → Anthropic 的 base64 source */
  function dataUrlToAnthropicSource(url) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(String(url || ''));
    if (!m) return null;
    return { type: 'base64', media_type: m[1], data: m[2] };
  }

  /** OpenAI 形状 → Responses 的 input 数组 */
  function toResponsesInput(list) {
    const input = [];
    (list || []).forEach(m => {
      if (!m) return;
      if (m.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: m.tool_call_id || '',
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content)
        });
        return;
      }
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : '';
        /* 思考内容必须先于 function_call 回放，否则服务端拒收（见上面那段说明） */
        if (m.replay && m.replay.format === 'responses') {
          (m.replay.reasoning || []).forEach(r => {
            if (!r || !r.text) return;
            const item = { type: 'reasoning', content: [{ type: 'reasoning_text', text: r.text }] };
            if (r.id) item.id = r.id;
            if (r.encrypted) item.encrypted_content = r.encrypted;
            input.push(item);
          });
        }
        if (text.trim()) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach(tc => {
          input.push({
            type: 'function_call',
            call_id: (tc && tc.id) || '',
            name: (tc && tc.function && tc.function.name) || '',
            arguments: (tc && tc.function && tc.function.arguments) || ''
          });
        });
        return;
      }
      // user
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => {
          if (!p) return null;
          if (p.type === 'text') return { type: 'input_text', text: p.text || '' };
          if (p.type === 'image_url') {
            const url = (p.image_url && p.image_url.url) || p.image_url || '';
            return url ? { type: 'input_image', image_url: url } : null;
          }
          return null;
        }).filter(Boolean);
        input.push({ role: 'user', content: parts.length ? parts : [{ type: 'input_text', text: '' }] });
        return;
      }
      input.push({ role: 'user', content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : '' }] });
    });
    return input;
  }

  /** OpenAI 形状 → Anthropic 的 messages 数组（tool_result 必须并进 user 消息） */
  function toAnthropicMessages(list) {
    const out = [];
    (list || []).forEach(m => {
      if (!m) return;
      if (m.role === 'tool') {
        const block = {
          type: 'tool_result',
          tool_use_id: m.tool_call_id || '',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content)
        };
        const last = out[out.length - 1];
        // 连续的多个工具结果要合成**一条** user 消息，否则 Anthropic 会拒
        if (last && last.role === 'user' && last.__toolResult) last.content.push(block);
        else out.push({ role: 'user', content: [block], __toolResult: true });
        return;
      }
      if (m.role === 'assistant') {
        const blocks = [];
        const text = typeof m.content === 'string' ? m.content : '';
        /* thinking 块必须在最前面；空串也接受（见上面的说明），所以无文本时给空块兜底 */
        if (m.replay && m.replay.format === 'anthropic') {
          const th = m.replay.thinking || [];
          if (th.length) {
            th.forEach(t => {
              const b = { type: 'thinking', thinking: (t && t.text) || '' };
              if (t && t.signature) b.signature = t.signature;
              blocks.push(b);
            });
          } else if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
            blocks.push({ type: 'thinking', thinking: '' });
          }
        }
        if (text.trim()) blocks.push({ type: 'text', text });
        (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach(tc => {
          if (!tc || !tc.function || !tc.function.name) return;
          blocks.push({
            type: 'tool_use',
            id: tc.id || ('toolu_' + Math.random().toString(36).slice(2)),
            name: tc.function.name,
            input: parseToolArgs(tc.function.arguments)
          });
        });
        if (blocks.length) out.push({ role: 'assistant', content: blocks });
        return;
      }
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => {
          if (!p) return null;
          if (p.type === 'text') return { type: 'text', text: p.text || '' };
          if (p.type === 'image_url') {
            const url = (p.image_url && p.image_url.url) || p.image_url || '';
            const src = dataUrlToAnthropicSource(url);
            return src ? { type: 'image', source: src } : null;   // 只支持 dataURL 内联，外链读不到
          }
          return null;
        }).filter(Boolean);
        out.push({ role: 'user', content: parts.length ? parts : [{ type: 'text', text: '' }] });
        return;
      }
      out.push({ role: 'user', content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }] });
    });
    out.forEach(m => { delete m.__toolResult; });
    return out;
  }

  /** OpenAI 形状的工具定义 → Responses（平铺） */
  function toResponsesTools(params) {
    const tools = normalizeTools(params.tools);
    if (!tools) return null;
    return tools.map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }));
  }

  /** OpenAI 形状的工具定义 → Anthropic（input_schema） */
  function toAnthropicTools(params) {
    const tools = normalizeTools(params.tools);
    if (!tools) return null;
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  }

  /* ---------- 思考强度 → 各家线格式参数（第 18 轮重做） ----------
     ⚠️⚠️ 上一版的 bug：选了 `none` 时**把参数整个省略**，以为「不传就是关」。
     实际是「不传 → 服务端按自己的默认走」，而 DeepSeek 的默认是**开思考**
     → 用户选了 none 仍然思考。三家的实测（打真接口，同一句提示词）：

       格式        不传        关闭写法                        结果
       chat       50 字       reasoning_effort:'none'          0 字 ✅
       responses 100 字       reasoning:{effort:'none'}        0 字 ✅
       anthropic  45 字       thinking:{type:'disabled'}       0 字 ✅
                            （Anthropic 的顶层 `effort` 不被采纳）

     **结论：「关」必须显式传出去，不能靠省略。**
     `auto`/未配置 才是唯一「不传、交给供应商」的情况。 */

  /** Responses：`reasoning.effort`（none 也要发，否则服务端默认开思考） */
  function responsesReasoning(level) {
    const e = effortOf(level);
    if (!e) return null;
    const map = { maximum: 'max' };                 // UI 用词 → 接口用词
    return { effort: map[e] || e };
  }

  /**
   * Anthropic：**开关看 `thinking.type`，强度用 `adaptive` + 顶层 `effort`**。
   * ⚠️ 新版模型已弃用 `budget_tokens`（传了会 400），所以不再走 enabled+budget；
   *    Anthropic 的 effort 词表是 low/medium/high/xhigh/max，UI 的 minimal 归到 low。
   * 返回 null = 这两个字段都不发（auto，交给供应商决定）。
   */
  function anthropicThinkingPayload(level) {
    const e = effortOf(level);
    if (!e) return null;
    if (e === 'none') return { thinking: { type: 'disabled' } };
    const map = {
      minimal: 'low', low: 'low', medium: 'medium',
      high: 'high', xhigh: 'xhigh', maximum: 'max', max: 'max'
    };
    return { thinking: { type: 'adaptive' }, effort: map[e] || e };
  }

  /** 这个 thinking 负载是否「思考处于开启态」（决定要不要回避 temperature） */
  function thinkingEnabled(th) {
    return !!(th && th.thinking && th.thinking.type !== 'disabled');
  }

  /** Anthropic 的 max_tokens 是**必填**；开思考时给大一点的默认值 */
  function anthropicMaxTokens(params, thinkingOn) {
    const want = Number(params.maxTokens) || 0;
    if (want > 0) return want;
    return thinkingOn ? 8192 : 4096;
  }

  /** 请求体：Anthropic Messages */
  function buildAnthropicBody(model, params, stream) {
    const all = buildMessages(params.messages, model, {
      historyLimit: params.historyLimit, skillsPrompt: params.skillsPrompt
    });
    const { blocks, rest } = splitSystem(all);
    const body = {
      model: model.model,
      messages: toAnthropicMessages(rest),
      stream: !!stream
    };
    /* system 支持「字符串」或「文本块数组」。只有一条时给字符串（兼容性最好）；
       多条（模型系统提示词 + 技能）时给**块数组**，两者保持独立。 */
    if (blocks.length === 1) body.system = blocks[0];
    else if (blocks.length > 1) body.system = blocks.map(t => ({ type: 'text', text: t }));
    const th = anthropicThinkingPayload(params.thinking);
    body.max_tokens = anthropicMaxTokens(params, thinkingEnabled(th));
    if (th) Object.assign(body, th);
    // 思考开着时 temperature 会被服务端忽略/拒绝，索性不发
    if (params.temperature != null && !thinkingEnabled(th)) body.temperature = params.temperature;
    const tools = toAnthropicTools(params);
    if (tools) {
      body.tools = tools;
      body.tool_choice = { type: params.toolChoice === 'required' ? 'any' : (params.toolChoice === 'none' ? 'none' : 'auto') };
    }
    return body;
  }

  /** 请求体：OpenAI Responses */
  function buildResponsesBody(model, params, stream) {
    const all = buildMessages(params.messages, model, {
      historyLimit: params.historyLimit, skillsPrompt: params.skillsPrompt
    });
    const { blocks, rest } = splitSystem(all);
    /* Responses 的 system 有两个位置：instructions（字符串）与 input 里的
       `{role:'system'}` 项。用它们把「模型系统提示词」和「技能」**分开**：
       第一条走 instructions，其余作为独立的 system 项插到 input 最前面。 */
    const input = toResponsesInput(rest);
    if (blocks.length > 1) {
      blocks.slice(1).reverse().forEach(t => {
        input.unshift({ role: 'system', content: [{ type: 'input_text', text: t }] });
      });
    }
    const body = {
      model: model.model,
      input: input,
      stream: !!stream
    };
    if (blocks.length) body.instructions = blocks[0];
    const reas = responsesReasoning(params.thinking);
    if (reas) body.reasoning = reas;
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.maxTokens) body.max_output_tokens = params.maxTokens;
    const tools = toResponsesTools(params);
    if (tools) {
      body.tools = tools;
      if (params.toolChoice) body.tool_choice = params.toolChoice;
    }
    return body;
  }

  /** 各家的 usage → parseUsage 认识的形状（Anthropic / Responses 用 input/output_tokens） */
  function usageOf(u, content) {
    if (!u || typeof u !== 'object') return parseUsage(u, content);
    const isNew = (u.input_tokens != null || u.output_tokens != null)
      && u.prompt_tokens == null && u.completion_tokens == null;
    if (!isNew) return parseUsage(u, content);
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    /* ⚠️ 第 18 轮补：`cache_creation_input_tokens` 也是**输入**的一部分
       （往缓存里写的那一段，服务端同样按输入计费）。之前只加了 cacheRead，
       在「首次把长上下文写进缓存」的那一轮会把输入算少。
       DeepSeek 恒为 0，所以对本项目的日常测试没影响；接真 Anthropic 时才有差别。 */
    const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
    const input = Number(u.input_tokens) || 0;
    const details = u.input_tokens_details || {};
    const outDetails = u.output_tokens_details || {};
    /* ⚠️ Anthropic 的 input_tokens **不含**缓存部分，命中/写入量单独给在
       cache_read_input_tokens / cache_creation_input_tokens 里；这里合成
       「总输入 = 未命中 + 命中 + 写入」，与 OpenAI 系的语义对齐，用量条才不会少算。 */
    return parseUsage({
      prompt_tokens: input + cacheRead + cacheCreate,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: Number(u.total_tokens) || undefined,
      prompt_cache_hit_tokens: cacheRead || undefined,
      prompt_cache_miss_tokens: (input + cacheCreate) || undefined,
      prompt_tokens_details: { cached_tokens: Number(details.cached_tokens) || undefined },
      completion_tokens_details: { reasoning_tokens: Number(outDetails.reasoning_tokens) || undefined }
    }, content);
  }

  /** 非流式响应归一化（两种新格式） */
  function parseFormattedOnce(format, json) {
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    const model = (json && json.model) || '';
    let replay = null;
    if (format === 'anthropic') {
      const thinking = [];
      const blocks = (json && json.content) || [];
      (Array.isArray(blocks) ? blocks : []).forEach(b => {
        if (!b) return;
        if (b.type === 'text') content += b.text || '';
        else if (b.type === 'thinking') {
          reasoning += b.thinking || '';
          thinking.push({ text: b.thinking || '', signature: b.signature || '' });
        }
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || '', type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) }
          });
        }
      });
      replay = { format: 'anthropic', thinking };
    } else {
      const reasItems = [];
      const output = (json && json.output) || [];
      (Array.isArray(output) ? output : []).forEach(item => {
        if (!item) return;
        if (item.type === 'reasoning') {
          const t = reasoningTextOf(item);
          reasoning += t;
          if (t) reasItems.push({ id: item.id || '', encrypted: item.encrypted_content || '', text: t });
        } else if (item.type === 'message') {
          (item.content || []).forEach(c => {
            if (c && (c.type === 'output_text' || c.type === 'text')) content += c.text || '';
          });
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id || item.id || '', type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '' }
          });
        }
      });
      // 少数兼容层直接给 output_text
      if (!content && typeof json.output_text === 'string') content = json.output_text;
      replay = { format: 'responses', reasoning: reasItems };
    }
    return { content, reasoning, toolCalls, model, replay, usage: usageOf(json && json.usage, content) };
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
    if (!model.baseUrl) return Promise.reject(makeError(t('errNoBaseUrl'), { code: 'NO_BASE_URL' }));
    if (!model.model) return Promise.reject(makeError(t('errNoModel'), { code: 'NO_MODEL' }));

    const useStream = !!params.stream && model.supportsStream !== false;
    if (useStream) return chatStream(params);
    return chatOnce(params);
  }

  function chatOnce(params) {
    const model = params.model;
    /* Responses / Anthropic 走各自的实现；chat 沿用下面这段（改动最小） */
    const format = formatOf(model);
    if (format !== 'chat') return chatOnceFormatted(params, format);
    const controller = linkAbort(params.signal);
    const timeout = makeTimeout(controller, DEFAULT_TIMEOUT);

    const body = {
      model: model.model,
      messages: buildMessages(params.messages, model, { historyLimit: params.historyLimit, skillsPrompt: params.skillsPrompt }),
      stream: false
    };
    Object.assign(body, thinkingPayload(params.thinking));
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.maxTokens) body.max_tokens = params.maxTokens;
    applyTools(body, params);

    let url;
    try { url = chatUrl(model.baseUrl); } catch (e) { return Promise.reject(e); }

    return httpFetch(url, {
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
    const format = formatOf(model);
    if (format !== 'chat') return chatStreamFormatted(params, format);
    const controller = linkAbort(params.signal);

    const body = {
      model: model.model,
      messages: buildMessages(params.messages, model, { historyLimit: params.historyLimit, skillsPrompt: params.skillsPrompt }),
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

    return httpFetch(url, {
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
        throw makeError(t('errTimeout'), { code: 'TIMEOUT' });
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

  /* ==========================================================================
     Responses / Anthropic 的对话实现
     ========================================================================== */

  /**
   * SSE 行解析器：`event:` 与 `data:` 分两行给出，这里把它们合成一次回调。
   * （Responses 的事件名也写在 data 的 type 里，两家都取得到。）
   */
  function makeSSEParser(onEvent) {
    let evName = '';
    return function feedLine(line) {
      const t = String(line == null ? '' : line).trim();
      if (!t || t.startsWith(':')) return;              // 空行 / 心跳注释
      if (t.startsWith('event:')) { evName = t.slice(6).trim(); return; }
      if (!t.startsWith('data:')) return;               // id: / retry: 等忽略
      const data = t.slice(5).trim();
      const name = evName;
      evName = '';
      if (!data || data === '[DONE]') return;
      const obj = tryParseJSON(data);
      if (!obj) return;
      onEvent(name, obj);
    };
  }

  /** 非流式对话（Responses / Anthropic） */
  function chatOnceFormatted(params, format) {
    const model = params.model;
    const controller = linkAbort(params.signal);
    const timeout = makeTimeout(controller, DEFAULT_TIMEOUT);

    let url;
    try { url = endpointFor(model.baseUrl, format); } catch (e) { return Promise.reject(e); }
    const body = format === 'anthropic'
      ? buildAnthropicBody(model, params, false)
      : buildResponsesBody(model, params, false);

    return httpFetch(url, {
      method: 'POST',
      headers: formatHeaders(model.apiKey, format),
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
      /* ⚠️ 两家在 HTTP 200 时也可能把失败写在正文里（Anthropic 是
         {type:'error', error:{message}}，Responses 是 {error:{message}}），
         不判一下就会被当成「空回复」，用户只看到一句话都没有。 */
      if (json && json.error && (json.error.message || json.error.type)) {
        throw makeError(String(json.error.message || json.error.type), { code: 'API_ERROR' });
      }
      const r = parseFormattedOnce(format, json);
      const out = {
        content: r.content || '',
        reasoning: r.reasoning || '',
        toolCalls: r.toolCalls,
        replay: r.replay,
        usage: r.usage,
        raw: json,
        aborted: false,
        model: r.model
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

  /** 流式对话（Responses / Anthropic） */
  function chatStreamFormatted(params, format) {
    const model = params.model;
    const controller = linkAbort(params.signal);

    let timedOut = false;
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch (e) {} }, DEFAULT_TIMEOUT);
    };
    bump();

    let url;
    try { url = endpointFor(model.baseUrl, format); } catch (e) { return Promise.reject(e); }
    const body = format === 'anthropic'
      ? buildAnthropicBody(model, params, true)
      : buildResponsesBody(model, params, true);

    const st = {
      full: '',
      reasoning: '',
      usage: null,
      model: '',
      usedStream: false
    };
    const toolAcc = [];               // 统一的工具调用槽位（finalizeToolCalls 认识的形状）
    const blocks = {};                // Anthropic：content block index → {type,id,name,json}
    const calls = {};                 // Responses：item key → {index,id,name,args}
    let callSeq = 0;
    /* 回传用：这一轮产生的思考内容（Anthropic 是 thinking 块，Responses 是 reasoning 项）。
       ⚠️ 必须收集 —— 工具调用轮里服务端要求把它们原样带回来，见上方说明。 */
    const thinkBlocks = {};           // Anthropic：block index → {text, signature}
    const reasItems = {};             // Responses：item key → {id, encrypted, text}
    let reasSeq = 0;
    let lastReasKey = '';
    const replayOf = () => {
      if (format === 'anthropic') {
        const thinking = Object.keys(thinkBlocks)
          .sort((a, b) => Number(a) - Number(b))
          .map(k => thinkBlocks[k])
          .filter(t => t);
        return { format: 'anthropic', thinking };
      }
      let reasoning = Object.keys(reasItems).map(k => reasItems[k]).filter(r => r && r.text);
      /* 兜底：只收到 reasoning_summary 之类、没挂到 item 上时，用累计文本合成一条 */
      if (!reasoning.length && st.reasoning) {
        reasoning = [{ id: '', encrypted: '', text: st.reasoning }];
      }
      return { format: 'responses', reasoning };
    };

    const pushDelta = (piece) => {
      if (!piece) return;
      st.full += piece;
      if (params.onDelta) params.onDelta(piece, st.full);
    };
    const pushReasoning = (t) => {
      if (!t) return;
      st.reasoning += t;
      if (params.onReasoning) params.onReasoning(t);
    };
    /* 把两家各自的归并结果写进统一的 toolAcc（收尾时 finalizeToolCalls 直接用它）。
       ⚠️⚠️ 这里必须**真的写入 toolAcc** —— 只发通知不写槽位是踩过的坑：
       界面上能看到「正在调用工具」，但最终 toolCalls 是空的，
       表现成「模型不调工具 / 调了却不执行」，且没有任何报错。 */
    const syncTools = () => {
      if (format === 'anthropic') {
        Object.keys(blocks).forEach(k => {
          const b = blocks[k];
          if (!b || b.type !== 'tool_use') return;
          toolAcc[b.index] = { id: b.id, type: 'function', function: { name: b.name, arguments: b.json } };
        });
      } else {
        Object.keys(calls).forEach(k => {
          const c = calls[k];
          toolAcc[c.index] = { id: c.id, type: 'function', function: { name: c.name, arguments: c.args } };
        });
      }
      if (params.onToolCallDelta) params.onToolCallDelta(finalizeToolCalls(toolAcc));
    };

    const applyAnthropic = (evName, obj) => {
      const type = obj.type || evName || '';
      if (type === 'message_start') {
        st.usedStream = true;
        const msg = obj.message || {};
        if (msg.model) st.model = msg.model;
        if (msg.usage) st.usage = msg.usage;
        return;
      }
      if (type === 'content_block_start') {
        st.usedStream = true;
        const b = obj.content_block || {};
        if (b.type === 'tool_use') {
          blocks[obj.index] = { type: 'tool_use', index: Number(obj.index), id: b.id || '', name: b.name || '', json: '' };
          syncTools();
        } else if (b.type === 'text') pushDelta(b.text);
        else if (b.type === 'thinking') {
          thinkBlocks[obj.index] = { text: b.thinking || '', signature: b.signature || '' };
          pushReasoning(b.thinking);
        }
        return;
      }
      if (type === 'content_block_delta') {
        st.usedStream = true;
        const d = obj.delta || {};
        if (d.type === 'text_delta') pushDelta(d.text);
        else if (d.type === 'thinking_delta') {
          if (!thinkBlocks[obj.index]) thinkBlocks[obj.index] = { text: '', signature: '' };
          thinkBlocks[obj.index].text += (d.thinking || '');
          pushReasoning(d.thinking);
        } else if (d.type === 'signature_delta') {
          if (thinkBlocks[obj.index]) thinkBlocks[obj.index].signature = d.signature || '';
        } else if (d.type === 'input_json_delta') {
          const b = blocks[obj.index];
          if (b) { b.json += (d.partial_json || ''); syncTools(); }
        }
        return;                                   // signature_delta 等忽略
      }
      if (type === 'message_delta') {
        if (obj.usage && obj.usage.output_tokens != null) {
          st.usage = Object.assign({}, st.usage || {}, { output_tokens: obj.usage.output_tokens });
        }
        return;
      }
      if (type === 'error') {
        throw makeError((obj.error && obj.error.message) || t('errStream'), { code: 'STREAM_ERROR' });
      }
      /* content_block_stop / message_stop：归并已在增量里做完，无需处理 */
    };

    const registerCall = (key, item) => {
      const exist = calls[key];
      if (exist) {
        if (item.name) exist.name = item.name;
        if (item.call_id) exist.id = item.call_id;
        if (item.arguments) exist.args = item.arguments;
        return exist;
      }
      const c = {
        index: callSeq++,
        id: item.call_id || item.id || '',
        name: item.name || '',
        args: item.arguments || ''
      };
      calls[key] = c;
      return c;
    };

    const applyResponses = (evName, obj) => {
      const type = obj.type || evName || '';
      if (type === 'response.created' || type === 'response.in_progress') {
        st.usedStream = true;
        if (obj.response && obj.response.model) st.model = obj.response.model;
        return;
      }
      if (type === 'response.output_text.delta') { st.usedStream = true; pushDelta(obj.delta); return; }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        st.usedStream = true;
        const key = obj.item_id || lastReasKey;
        if (key) {
          if (!reasItems[key]) reasItems[key] = { id: obj.item_id || '', encrypted: '', text: '' };
          reasItems[key].text += (obj.delta || '');
        }
        pushReasoning(obj.delta);
        return;
      }
      if (type === 'response.output_item.added') {
        st.usedStream = true;
        const item = obj.item || {};
        if (item.type === 'function_call') {
          registerCall(obj.item_id || item.id || String(obj.output_index), item);
          syncTools();
        } else if (item.type === 'reasoning') {
          const key = item.id || obj.item_id || ('r' + (reasSeq++));
          reasItems[key] = { id: item.id || '', encrypted: item.encrypted_content || '', text: reasoningTextOf(item) };
          lastReasKey = key;
        }
        return;
      }
      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const key = obj.item_id || String(obj.output_index);
        const c = calls[key];
        if (c) {
          if (type.endsWith('.delta')) c.args += (obj.delta || '');
          else if (obj.arguments != null) c.args = obj.arguments;
          syncTools();
        }
        return;
      }
      if (type === 'response.output_item.done') {
        const item = obj.item || {};
        if (item.type === 'function_call') {
          registerCall(obj.item_id || item.id || String(obj.output_index), item);
          syncTools();
        } else if (item.type === 'message') {
          /* 没收到增量（少数兼容层只给终态）时补一次正文 */
          if (!st.full) {
            (item.content || []).forEach(c => { if (c && c.text) pushDelta(c.text); });
          }
        } else if (item.type === 'reasoning') {
          const t = reasoningTextOf(item);
          const key = item.id || obj.item_id || lastReasKey;
          if (key) {
            if (!reasItems[key]) reasItems[key] = { id: item.id || '', encrypted: item.encrypted_content || '', text: '' };
            if (!reasItems[key].text) reasItems[key].text = t;
          }
          if (!st.reasoning && t) pushReasoning(t);
        }
        return;
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        const resp = obj.response || {};
        if (resp.usage) st.usage = resp.usage;
        if (resp.model) st.model = resp.model;
        st.usedStream = true;
        /* 整段只给了终态的兼容层：把 output 拆出来补上 */
        if (!st.full && !Object.keys(calls).length) {
          const r = parseFormattedOnce('responses', resp);
          if (r.reasoning) pushReasoning(r.reasoning);
          if (r.content) pushDelta(r.content);
          r.toolCalls.forEach(tc => {
            registerCall(tc.id || ('slot' + callSeq), { call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
          });
          syncTools();
        }
        return;
      }
      if (type === 'response.failed' || type === 'error') {
        const msg = (obj.response && obj.response.error && obj.response.error.message)
          || (obj.error && obj.error.message) || (obj.error && obj.error.code) || t('errResponse');
        throw makeError(String(msg), { code: 'STREAM_ERROR' });
      }
    };

    const apply = format === 'anthropic' ? applyAnthropic : applyResponses;

    return httpFetch(url, {
      method: 'POST',
      headers: formatHeaders(model.apiKey, format, { Accept: 'text/event-stream' }),
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

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const reader = (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder !== 'undefined')
        ? res.body.getReader() : null;

      // 网关把流式请求当普通 JSON 处理，或浏览器不支持流式读取
      if (!reader || ct.indexOf('text/event-stream') < 0) {
        return res.text().then(t => {
          clearTimeout(timer);
          if (/^\s*(data:|event:)/.test(t)) {
            const feed = makeSSEParser((n, o) => apply(n, o));
            t.split(/\r?\n/).forEach(feed);
            st.usedStream = true;
            return;
          }
          const parsed = tryParseJSON(t);
          if (!parsed) { pushDelta(t); return; }
          const r = parseFormattedOnce(format, parsed);
          if (r.model) st.model = r.model;
          if (r.reasoning) pushReasoning(r.reasoning);
          if (r.content) pushDelta(r.content);
          r.toolCalls.forEach(tc => registerCall(tc.id || ('slot' + (callSeq++)), {
            call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments
          }));
          syncTools();
          if (parsed.usage) st.usage = parsed.usage;
        });
      }

      const decoder = new TextDecoder('utf-8');
      const feed = makeSSEParser((n, o) => apply(n, o));
      let buffer = '';

      const pump = () => reader.read().then(({ done, value }) => {
        if (done) return;
        bump();
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          feed(line);
        }
        return pump();
      });

      return pump().then(() => { clearTimeout(timer); });
    }).then(() => {
      clearTimeout(timer);
      const out = {
        content: st.full,
        reasoning: st.reasoning,
        toolCalls: finalizeToolCalls(toolAcc),
        replay: replayOf(),
        usage: usageOf(st.usage, st.full),
        usedStream: st.usedStream,
        model: st.model,
        aborted: false
      };
      if (params.onDone) params.onDone(out);
      return out;
    }).catch(err => {
      clearTimeout(timer);
      if (timedOut) throw makeError(t('errTimeout'), { code: 'TIMEOUT' });
      const ne = normalizeFetchError(err, controller);
      if (ne.code === 'ABORTED' && st.full) {
        return {
          content: st.full, reasoning: st.reasoning, replay: replayOf(),
          toolCalls: finalizeToolCalls(toolAcc), usage: usageOf(st.usage, st.full),
          aborted: true, partial: true
        };
      }
      if (ne.code === 'NETWORK' && st.full) {
        return {
          content: st.full, reasoning: st.reasoning, replay: replayOf(),
          toolCalls: finalizeToolCalls(toolAcc), usage: usageOf(st.usage, st.full),
          aborted: true, partial: true, networkError: ne
        };
      }
      throw ne;
    });
  }

  /* ---------- 模型列表 ---------- */
  function listModels(model) {
    const format = formatOf(model);
    let url;
    try { url = modelsEndpointFor(model.baseUrl, format); } catch (e) { return Promise.reject(e); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    return httpFetch(url, {
      method: 'GET',
      headers: formatHeaders(model.apiKey, format),
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
    if (!model.baseUrl) return Promise.reject(makeError(t('errNoBaseUrl'), { code: 'NO_BASE_URL' }));
    if (!model.model) return Promise.reject(makeError(t('errNoModel'), { code: 'NO_MODEL' }));
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

    return httpFetch(url, {
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

    return httpFetch(url, {
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
    return httpFetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
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
     语音合成（TTS，OpenAI 兼容）
     --------------------------------------------------------------------------
     主路径（MiMo-TTS 等文档写法）：POST {base}/chat/completions
       Body: { model, messages: [{role:'user',content:风格提示?},
                                  {role:'assistant',content:待朗读文本}],
               audio: { voice, format }, stream? }
       返回： choices[0].message.audio.data（base64）
              流式时为 choices[0].delta.audio.data 的 base64 分片
     回退路径（OpenAI 官方 /audio/speech）：POST {base}/audio/speech
       Body: { model, input, voice, response_format }

     实测（mimo-v2.5-tts）：24kHz / 单声道 / 16bit；format=wav 返回完整 RIFF；
     流式时每片各自带 RIFF 头，需剥壳后重拼；pcm 为裸流，播放前需补 WAV 头。
     ========================================================================== */

  const TTS_TIMEOUT = 300000;         // 合成长文本可能较慢
  const TTS_SPEECH_URL = '/audio/speech';
  const TTS_SAMPLE_RATE = 24000;      // 无 WAV 头信息时的兜底采样率
  const TTS_CHANNELS = 1;
  const TTS_BITS = 16;

  /** 可供选择的输出格式 */
  const AUDIO_FORMATS = [
    { value: 'wav', label: 'WAV', mime: 'audio/wav' },
    { value: 'mp3', label: 'MP3', mime: 'audio/mpeg' },
    { value: 'pcm', label: 'PCM（播放前自动包装为 WAV）', mime: 'audio/wav' }
  ];

  function normalizeAudioFormat(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'mp3' || s === 'mpeg') return 'mp3';
    if (s === 'pcm' || s === 'pcm16') return 'pcm';
    return 'wav';
  }

  function mimeOfFormat(format) {
    return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  }

  /* ---------- 二进制小工具（播放所需的容器拼装） ---------- */

  function b64ToBytes(b64) {
    const s = String(b64 || '');
    if (!s) return new Uint8Array(0);
    const bin = global.atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToDataUrl(bytes, mime) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return 'data:' + (mime || 'audio/wav') + ';base64,' + global.btoa(bin);
  }

  function concatBytes(list) {
    let total = 0;
    (list || []).forEach(b => { total += b.length; });
    const out = new Uint8Array(total);
    let off = 0;
    (list || []).forEach(b => { out.set(b, off); off += b.length; });
    return out;
  }

  function isRiff(bytes) {
    return !!(bytes && bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45);
  }

  /** 读取 WAV 的格式信息 */
  function wavFmt(bytes) {
    if (!isRiff(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      const size = view.getUint32(off + 4, true);
      if (id === 'fmt ' && off + 8 + 16 <= bytes.length) {
        return {
          channels: view.getUint16(off + 8, true) || TTS_CHANNELS,
          sampleRate: view.getUint32(off + 12, true) || TTS_SAMPLE_RATE,
          bits: view.getUint16(off + 22, true) || TTS_BITS
        };
      }
      if (!size) break;
      off += 8 + size + (size % 2);
    }
    return null;
  }

  /** 取出 WAV 里的纯 PCM 数据；不是 WAV 则原样返回 */
  function wavDataChunk(bytes) {
    if (!isRiff(bytes)) return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      const size = view.getUint32(off + 4, true);
      if (id === 'data') {
        const start = off + 8;
        return bytes.subarray(start, Math.min(bytes.length, start + size));
      }
      if (!size) break;
      off += 8 + size + (size % 2);
    }
    return bytes.subarray(Math.min(44, bytes.length));
  }

  /** 用 PCM 数据拼出可播放的 WAV */
  function pcmToWav(pcm, sampleRate, channels, bits) {
    const rate = sampleRate || TTS_SAMPLE_RATE;
    const ch = channels || TTS_CHANNELS;
    const bps = (bits || TTS_BITS) / 8;
    const blockAlign = ch * bps;
    const out = new Uint8Array(44 + pcm.length);
    const view = new DataView(out.buffer);
    const wr = (off, str) => { for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i); };
    wr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    wr(8, 'WAVE');
    wr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, ch, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bits || TTS_BITS, true);
    wr(36, 'data');
    view.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
  }

  /**
   * 把若干音频分片组装成可播放的 dataURL。
   * - pcm ：裸流，补 WAV 头
   * - wav ：分片可能各自带 RIFF 头（MiMo 流式即如此），剥壳后重拼
   * - mp3 ：帧自包含，直接拼接
   */
  function assembleAudio(pieces, format) {
    const list = (pieces || []).filter(b => b && b.length);
    if (!list.length) return null;
    const fmt = normalizeAudioFormat(format);

    if (fmt === 'mp3') {
      const bytes = concatBytes(list);
      return { dataUrl: bytesToDataUrl(bytes, 'audio/mpeg'), mime: 'audio/mpeg', bytes: bytes.length, format: 'mp3' };
    }

    // 采样率优先从 WAV 头里读，读不到再用兜底值
    let info = null;
    for (const b of list) { info = wavFmt(b); if (info) break; }
    const pcm = concatBytes(list.map(wavDataChunk));
    const wav = pcmToWav(pcm, info && info.sampleRate, info && info.channels, info && info.bits);
    return {
      dataUrl: bytesToDataUrl(wav, 'audio/wav'),
      mime: 'audio/wav',
      bytes: wav.length,
      format: fmt,
      sampleRate: (info && info.sampleRate) || TTS_SAMPLE_RATE
    };
  }

  /** 构造 TTS 请求（chat/completions 路径） */
  function buildTtsMessages(text, instruction) {
    const msgs = [];
    const style = String(instruction || '').trim();
    if (style) msgs.push({ role: 'user', content: style });
    msgs.push({ role: 'assistant', content: text });
    return msgs;
  }

  /**
   * 语音合成
   * @param {object} params
   *   model     {object} TTS 模型配置
   *   text      {string} 待朗读文本
   *   voice     {string} 音色（可选）
   *   format    {string} wav | mp3 | pcm
   *   instruction {string} 风格 / 语气提示（可选，作为 user 消息）
   *   stream    {boolean}
   *   signal    {AbortSignal}
   *   onProgress {(bytes:number)=>void}
   * @returns {Promise<{dataUrl,mime,bytes,format,ms,usage,transcript,via,streamed}>}
   */
  function synthesizeSpeech(params) {
    const p = params || {};
    const model = p.model || {};
    const text = String(p.text == null ? '' : p.text).trim();
    if (!text) return Promise.reject(makeError('朗读文本为空', { code: 'NO_TEXT' }));
    if (!model.baseUrl) return Promise.reject(makeError(t('errNoBaseUrl'), { code: 'NO_BASE_URL' }));
    if (!model.model) return Promise.reject(makeError(t('errNoModel'), { code: 'NO_MODEL' }));

    const format = normalizeAudioFormat(p.format || model.audioFormat);
    const stream = !!p.stream && model.supportsStream !== false;
    const voice = String(p.voice || model.voice || '').trim();
    const started = Date.now();

    const controller = linkAbort(p.signal);
    const timer = makeTimeout(controller, TTS_TIMEOUT);

    const fallback = err => speechFallback(Object.assign({}, p, { model, text, voice, format, controller }))
      .then(res => res, ferr => { throw (ferr && ferr.code ? ferr : err); });

    return ttsViaChat({ model, text, voice, format, stream, instruction: p.instruction, controller, onProgress: p.onProgress })
      .then(res => Object.assign(res, { ms: Date.now() - started, via: 'chat', streamed: stream }))
      .catch(err => {
        if (err && err.code === 'ABORTED') throw err;
        // 仅当「网关不认识 audio 参数 / 未实现音频输出」时才退化到官方接口，
        // 避免网络类错误导致重复计费请求
        const status = err && err.status;
        const unsupported = (err && err.code === 'NO_AUDIO_DATA')
          || status === 400 || status === 404 || status === 405 || status === 422;
        if (!unsupported) throw err;
        return fallback(err);
      })
      .then(res => { clearTimeout(timer); return res; })
      .catch(err => { clearTimeout(timer); throw normalizeFetchError(err, controller); });
  }

  /** 路径一：chat/completions + audio 参数（MiMo-TTS 文档写法） */
  function ttsViaChat(o) {
    const body = {
      model: o.model.model,
      messages: buildTtsMessages(o.text, o.instruction),
      audio: { format: o.format }
    };
    if (o.voice) body.audio.voice = o.voice;
    if (o.stream) body.stream = true;

    let url;
    try { url = chatUrl(o.model.baseUrl); } catch (e) { return Promise.reject(e); }

    return httpFetch(url, {
      method: 'POST',
      headers: headers(o.model.apiKey),
      body: JSON.stringify(body),
      signal: o.controller.signal,
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
      // 请求了流式，但网关可能直接忽略 stream 返回一次性 JSON（不少网关如此）。
      // 此时按非流式解析，而不是把它当成"格式不对"失败掉。
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      const isSse = ctype.indexOf('event-stream') >= 0;
      if (o.stream && isSse) return readAudioStream(res, o.format, o.onProgress);
      if (o.stream && ctype.indexOf('json') >= 0) {
        return res.json().then(json => parseTtsJson(json, o.format, true));
      }
      if (o.stream && !isSse) {
        // 既不是 SSE 也不是 JSON：读成文本，交给下面统一报错
        return res.text().then(t => {
          throw makeError('网关未按流式返回音频（Content-Type: ' + (ctype || 'unknown') + '）',
            { code: 'NO_AUDIO_DATA', raw: t.slice(0, 300) });
        });
      }
      return res.json().then(json => parseTtsJson(json, o.format, false));
    });
  }

  /** 从 chat/completions 的 JSON 响应里取出音频 */
  function parseTtsJson(json, format, wasStreamRequested) {
    const choice = (json && json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const audio = msg.audio || {};
    if (!audio.data) {
      throw makeError('该接口未返回音频数据（可能不支持 audio 参数）', {
        code: 'NO_AUDIO_DATA',
        raw: JSON.stringify(json).slice(0, 300)
      });
    }
    const assembled = assembleAudio([b64ToBytes(audio.data)], format);
    if (!assembled) throw makeError('音频数据为空', { code: 'NO_AUDIO_DATA' });
    return Object.assign(assembled, {
      usage: parseUsage(json.usage, '') || null,
      transcript: audio.transcript || '',
      audioId: audio.id || '',
      // 网关忽略了 stream 时如实标记，便于上层知道并未真正流式
      streamed: false,
      streamIgnored: !!wasStreamRequested
    });
  }

  /** 读取流式音频（SSE，音频分片在 choices[].delta.audio.data） */
  function readAudioStream(res, format, onProgress) {
    if (!res.body || !res.body.getReader) {
      return Promise.reject(makeError('当前浏览器不支持流式读取', { code: 'NO_STREAM' }));
    }
    const reader = res.body.getReader();
    const decoder = new global.TextDecoder();
    const pieces = [];
    let buf = '';
    let usage = null;
    let bytes = 0;
    let transcript = '';

    function handle(obj) {
      if (obj && obj.usage) usage = obj.usage;
      const ch = (obj && obj.choices && obj.choices[0]) || {};
      const au = (ch.delta && ch.delta.audio) || (ch.message && ch.message.audio) || null;
      if (!au) return;
      if (au.transcript) transcript = au.transcript;
      if (!au.data) return;
      const raw = b64ToBytes(au.data);
      if (!raw.length) return;
      pieces.push(raw);
      bytes += raw.length;
      if (onProgress) { try { onProgress(bytes); } catch (e) { /* noop */ } }
    }

    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (s.indexOf('data:') !== 0) continue;
          const d = s.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          let o; try { o = JSON.parse(d); } catch (e) { continue; }
          handle(o);
        }
        return pump();
      });
    }

    return pump().then(() => {
      const assembled = assembleAudio(pieces, format);
      if (!assembled) throw makeError('未收到任何音频数据', { code: 'NO_AUDIO_DATA' });
      return Object.assign(assembled, {
        usage: parseUsage(usage, '') || null,
        transcript,
        audioId: ''
      });
    });
  }

  /** 路径二：OpenAI 官方 /audio/speech */
  function speechFallback(o) {
    const url = joinUrl(o.model.baseUrl, TTS_SPEECH_URL);
    const body = {
      model: o.model.model,
      input: o.text,
      response_format: o.format === 'pcm' ? 'wav' : o.format
    };
    if (o.voice) body.voice = o.voice;

    return httpFetch(url, {
      method: 'POST',
      headers: headers(o.model.apiKey),
      body: JSON.stringify(body),
      signal: o.controller.signal,
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
      return res.arrayBuffer().then(ab => {
        const bytes = new Uint8Array(ab);
        if (!bytes.length) throw makeError('音频数据为空', { code: 'NO_AUDIO_DATA' });
        // 有些网关会以 200 + JSON 返回错误信息；不能把 JSON 当音频存下来
        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        const looksJson = ctype.indexOf('json') >= 0
          || (bytes[0] === 0x7b && bytes[1] === 0x22)          // {"
          || (bytes[0] === 0x5b && bytes[1] === 0x7b);          // [{
        if (looksJson) {
          let text = '';
          try { text = new TextDecoder().decode(bytes).slice(0, 300); } catch (e) { /* noop */ }
          throw makeError('该接口未返回音频（返回了 JSON 响应）', {
            code: 'NO_AUDIO_DATA',
            raw: text,
            status: res.status
          });
        }
        const fmt = normalizeAudioFormat(body.response_format);
        const assembled = assembleAudio([bytes], fmt);
        return Object.assign(assembled, { usage: null, transcript: '', audioId: '', via: 'speech' });
      });
    });
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

  /** 用户可以在设置里手动指定的 Tavily 参数（query 始终由模型决定） */
  const TAVILY_FORCED_KEYS = [
    'auto_parameters', 'topic', 'search_depth', 'chunks_per_source', 'max_results',
    'time_range', 'start_date', 'end_date', 'include_answer', 'include_raw_content',
    'include_images', 'include_image_descriptions', 'include_favicon',
    'include_domains', 'exclude_domains', 'country', 'include_usage'
  ];

  /**
   * 从用户配置里挑出「已指定」的参数：空字符串 / null / 空数组 视为未指定。
   * @returns {object} 仅含用户真正填写的项
   */
  function pickForcedTavily(src) {
    const out = {};
    const a = src || {};
    TAVILY_FORCED_KEYS.forEach(k => {
      const v = a[k];
      if (v === '' || v === null || v === undefined) return;
      if (Array.isArray(v) && !v.length) return;
      out[k] = v;
    });
    return out;
  }

  /**
   * 依据工具参数构造 Tavily 请求体，并补上服务端默认值。
   * 除 query 外全部可选，模型可自由指定；用户在设置里手动指定的项强制生效。
   * @param {object} args   模型给出的参数
   * @param {object} [forced] 用户手动指定的参数（优先级高于模型）
   */
  function buildTavilyBody(args, forced) {
    const a = Object.assign({}, args || {}, pickForcedTavily(forced));
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
  function tavilySearch(args, apiKey, signal, forced) {
    const key = String(apiKey || '').trim();
    if (!key) return Promise.reject(makeError('未配置 Tavily API Key', { code: 'NO_TAVILY_KEY' }));

    const body = buildTavilyBody(args, forced);
    if (!body.query) return Promise.reject(makeError('搜索关键词不能为空', { code: 'NO_QUERY' }));

    const controller = linkAbort(signal);
    const timer = makeTimeout(controller, TAVILY_TIMEOUT);
    const started = Date.now();

    return httpFetch(TAVILY_SEARCH_URL, {
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

  /**
   * 供模型使用的 Tavily 搜索工具定义。
   * 用户在设置里手动指定的参数会从工具定义中移除 —— 这些值由前端强制生效，不再交给模型决定。
   * @param {object} [forced] 用户手动指定的参数
   */
  function tavilyTool(forced) {
    const props = {
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
    };

    // 用户已手动指定的项：从工具定义里摘掉，模型无法也不需再设置
    Object.keys(pickForcedTavily(forced)).forEach(k => { delete props[k]; });

    return {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the live web with Tavily. Use it whenever the answer depends on '
          + 'up-to-date facts, news, prices, weather, releases, people, or anything you are '
          + 'unsure about. You may call it multiple times with different queries. '
          + 'Prefer precise, keyword-rich queries.',
        parameters: {
          type: 'object',
          properties: props,
          required: ['query']
        }
      }
    };
  }

  /* ---------- Python（Pyodide）工具 ---------- */

  /* 工具名：保持简短、可读，且符合 OpenAI 的 ^[a-zA-Z0-9_-]{1,64}$ */
  const PY_TOOL_NAME = 'run_python';

  /* ⚠️ 这段描述**必须完整讲清能力边界**（用户明确要求），
     而且要写得让模型能据此做对决策 —— 它决定了模型会不会滥用、会不会
     一上来就 import pandas、会不会声称「我把文件存到你电脑上了」。
     下面每一条都是根据实际实现写的（改了实现就要回来改这里）：
       · 能跑：CPython 3.13 标准库 + 预装的 numpy 2.x
       · 不能：网络（无 socket）、第三方包（除 numpy）、子进程、持久化文件系统
       · 有超时（默认 30 秒）
       · 要 print() 才有输出；最后一行表达式的值也会回传，但不要依赖它
       · 变量不在多次调用之间保持（每次是干净的解释器状态）      */
  const PY_TOOL_DESCRIPTION = [
    'Run Python 3.13 code in the user\'s browser (Pyodide/WebAssembly) and return its output. '
      + 'Use this for any real computation — arithmetic beyond a couple of terms, data munging, '
      + 'statistics, string/date/regex work — instead of computing in your head.',
    '',
    'AVAILABLE:',
    '- The full Python 3.13 standard library: math, statistics, decimal, fractions, random, '
      + 'itertools, functools, collections, re, json, csv, datetime, hashlib, base64, zlib, '
      + 'textwrap, unicodedata, and so on.',
    '- numpy 2.x is preinstalled — `import numpy as np` works.',
    '',
    'NOT AVAILABLE (these will fail — do not attempt them):',
    '- NO network: requests/urllib/http.client/socket cannot reach the internet or localhost. '
      + 'There is no outbound connectivity at all.',
    '- NO third-party packages other than numpy. pandas, scipy, sympy, matplotlib, sklearn, torch '
      + 'etc. raise ModuleNotFoundError. pip/micropip is not available either.',
    '- NO subprocess/os.system/multiprocessing.',
    '- NO persistent filesystem and NO access to the user\'s real files or the chat attachments. '
      + 'You may write to the in-memory virtual FS, but it is discarded and never reaches the '
      + 'user\'s computer. Never claim you saved a file for the user.',
    '- NO plots/GUI output: matplotlib figures cannot be displayed. Return numbers or text instead.',
    '',
    'HOW TO USE IT:',
    '- print() everything you need back, with clear labels. Values are returned as text.',
    '- Each call starts from a clean interpreter: variables do NOT persist between calls. '
      + 'Put everything one task needs into a single code block.',
    '- The value of the last expression is also returned, but always print() as well.',
    '- Execution is capped at about 30 seconds and then killed — bound every loop '
      + '(e.g. sum the first 10**6 terms) instead of running unbounded work.',
    '- On error you get the Python traceback. Read it, fix the code, and call again.'
  ].join('\n');

  /* 执行超时的合法区间（秒）。⚠️ 与 store.js 的归一化、pyodide-runner 的
     MAX_TIMEOUT 必须一致 —— 三处都写死一个数字容易漂，所以在这里集中定义。 */
  const PY_TIMEOUT_MIN = 30;
  const PY_TIMEOUT_MAX = 300;

  /** 把任意输入夹到合法区间；非法/留空则返回 fallback */
  function clampPyTimeout(v, fallback) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.max(PY_TIMEOUT_MIN, Math.min(PY_TIMEOUT_MAX, n));
  }

  /**
   * 供模型使用的 Python 工具定义。
   * @param {number} [fixedTimeout] 用户在设置里固定的超时（秒）。
   *        **0 / 省略** = 留空，由模型按需决定 → 此时把 `timeout` 做成参数暴露出去。
   */
  function pythonTool(fixedTimeout) {
    const auto = !(fixedTimeout >= PY_TIMEOUT_MIN && fixedTimeout <= PY_TIMEOUT_MAX);
    const props = {
      code: {
        type: 'string',
        description: 'The Python source to execute. Include the imports you need. '
          + 'Use print() for anything you want returned. '
          + 'Example: "import statistics\nxs = [2,4,4,4,5,5,7,9]\n'
          + 'print(\'mean\', statistics.mean(xs))\nprint(\'stdev\', statistics.stdev(xs))"'
      }
    };
    let desc = PY_TOOL_DESCRIPTION;
    if (auto) {
      /* 留空模式：把超时交给模型，但必须写明区间，否则它会随便传个大数 */
      props.timeout = {
        type: 'integer',
        minimum: PY_TIMEOUT_MIN,
        maximum: PY_TIMEOUT_MAX,
        description: 'Optional wall-clock limit in seconds for this call. Must be between '
          + PY_TIMEOUT_MIN + ' and ' + PY_TIMEOUT_MAX + '. Defaults to 60. '
          + 'Raise it (up to ' + PY_TIMEOUT_MAX + ') only for genuinely heavy work; '
          + 'values outside the range are clamped.'
      };
      desc += '\n\nTIMEOUT: you may pass an optional `timeout` (seconds, '
        + PY_TIMEOUT_MIN + '-' + PY_TIMEOUT_MAX + ', default 60). '
        + 'Execution is killed once it elapses, so keep loops bounded.';
    } else {
      desc += '\n\nTIMEOUT: each call is limited to ' + fixedTimeout + ' seconds and is then '
        + 'killed — bound every loop so the work finishes in time.';
    }
    return {
      type: 'function',
      function: {
        name: PY_TOOL_NAME,
        description: desc,
        parameters: { type: 'object', properties: props, required: ['code'] }
      }
    };
  }

  /**
   * 把执行结果压成给模型看的文本。
   * 刻意把 stdout / stderr / 返回值 / traceback 分段标出来 —— 模型据此判断
   * 「是没输出」还是「报错了」，比糊成一坨更不容易误读。
   */
  function formatPythonForModel(res, opts) {
    opts = opts || {};
    const max = opts.maxChars || 16000;
    const parts = [];
    const out = String((res && res.stdout) || '');
    const err = String((res && res.stderr) || '');
    const ret = String((res && res.result) || '');
    const tb = String((res && res.traceback) || '');

    if (out) parts.push('stdout:\n' + out);
    if (err) parts.push('stderr:\n' + err);
    if (ret) parts.push('return value: ' + ret);
    if (res && res.error) {
      parts.push('ERROR: ' + res.error);
      if (tb) parts.push('traceback:\n' + tb);
    }
    if (!parts.length) parts.push('(the code ran successfully but produced no output — '
      + 'remember to print() anything you want to see)');

    let text = parts.join('\n\n');
    if (text.length > max) text = text.slice(0, max) + '\n…[truncated]';
    return text;
  }

  /* ---------- MCP 工具 ---------- */

  /**
   * 把一批已启用的 MCP 服务器转成 OpenAI 工具定义数组。
   * 需要先拿到各自的工具清单，所以这是个异步函数；任何一个服务器连不上都**不**影响其它，
   * 失败的只记进 errors 里（界面据此提示，而不是让整轮对话失败）。
   * @param {Array} servers 已启用的 MCP 服务器（Store.getEnabledMcpServers()）
   * @returns {Promise<{tools:Array, errors:Array, byName:Object}>}
   */
  function buildMcpTools(servers, opts) {
    opts = opts || {};
    const list = (servers || []).filter(s => s && s.url);
    if (!list.length || !global.Mcp) return Promise.resolve({ tools: [], errors: [], byName: {} });

    return Promise.all(list.map(s =>
      global.Mcp.listTools(s, { signal: opts.signal }).then(tools => ({ server: s, tools }))
        .catch(err => ({ server: s, tools: [], error: (err && err.message) || String(err) }))
    )).then(results => {
      const tools = [];
      const errors = [];
      const byName = {};
      results.forEach(r => {
        if (r.error) {
          errors.push({ serverId: r.server.id, serverName: r.server.name, error: r.error });
          return;
        }
        r.tools.forEach(t => {
          /* ⚠️ 工具名必须符合 OpenAI 的 ^[a-zA-Z0-9_-]{1,64}$，否则整次请求会被网关 400。
             所以统一用 mcp__<serverSlug>__<toolName> 的形式派发（见 mcp.js）。 */
          const name = global.Mcp.externalName(r.server, t.name);
          if (byName[name]) return;   // 撞名（同 slug 的两台服务器）只保留先到的一个
          byName[name] = { server: r.server, toolName: t.name, tool: t };
          tools.push({
            type: 'function',
            function: {
              name,
              description: buildMcpToolDescription(r.server, t),
              parameters: sanitizeSchema(t.inputSchema)
            }
          });
        });
      });
      return { tools, errors, byName };
    });
  }

  /** 给工具描述加上服务器前缀，让模型知道工具来自哪里 */
  function buildMcpToolDescription(server, tool) {
    const head = '[' + (server.name || 'MCP') + '] ';
    const desc = String(tool.description || '').trim() || ('MCP tool ' + tool.name);
    return (head + desc).slice(0, 1024);
  }

  /**
   * 清洗 MCP 的 inputSchema，让它能被各家网关接受。
   * - 丢掉 JSON Schema 里 OpenAI 不认的顶层键（$schema / title / additionalProperties 保留）
   * - 没有 properties 时补一个空对象，避免个别网关报 400
   */
  function sanitizeSchema(schema) {
    const s = (schema && typeof schema === 'object' && !Array.isArray(schema)) ? schema : {};
    const props = (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties))
      ? s.properties : {};
    const out = { type: 'object', properties: props };
    if (Array.isArray(s.required) && s.required.length) {
      const keys = Object.keys(props);
      out.required = s.required.filter(k => keys.indexOf(k) >= 0);
      if (!out.required.length) delete out.required;
    }
    if (s.additionalProperties === false) out.additionalProperties = false;
    return out;
  }

  /**
   * 把 MCP 工具的返回压成给模型看的文本。
   * 工具自己通常已经返回 JSON 文本，这里只做长度保护，避免一次调用撑爆上下文。
   */
  function formatMcpForModel(res, opts) {
    opts = opts || {};
    const max = opts.maxChars || 12000;
    const text = (res && res.text) || '';
    const body = text.length > max ? (text.slice(0, max) + '\n…[truncated]') : text;
    if (res && res.isError) {
      return JSON.stringify({
        error: body || 'tool failed',
        note: 'The MCP tool reported an error. Tell the user what went wrong; '
          + 'do not pretend the operation succeeded.'
      });
    }
    return body || '(empty result)';
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
      return makeError(t('errNetwork'), { code: 'NETWORK' });
    }
    if (err instanceof TypeError) {
      return makeError(t('errNetwork'), { code: 'NETWORK' });
    }
    return err;
  }

  global.API = {
    chat,
    listModels,
    testConnection,
    /* 统一出口：MCP 客户端（mcp.js）也走它，因此同样能用上「绕过 CORS」的增强脚本 */
    httpFetch,
    makeError,
    parseUsage,
    thinkingPayload,
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
    /* API 格式（第 17 轮）：chat / responses / anthropic */
    API_FORMATS,
    formatOf,
    endpointFor,
    modelsEndpointFor,
    formatHeaders,
    /* 请求体构造：导出是为了能在「排查线格式」时直接打印出来对照，
       比抓包快得多（第 17 轮就是靠它定位到工具清单没进去的）。 */
    buildAnthropicBody,
    buildResponsesBody,
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
    pickForcedTavily,
    formatTavilyForModel,
    /* Python（Pyodide） */
    pythonTool,
    formatPythonForModel,
    clampPyTimeout,
    PY_TOOL_NAME,
    PY_TIMEOUT_MIN,
    PY_TIMEOUT_MAX,
    /* 技能（SKILL.md） */
    skillTool,
    skillSystemPrompt,
    formatSkillForModel,
    findSkillByName,
    SKILL_TOOL_NAME,
    /* MCP */
    buildMcpTools,
    sanitizeSchema,
    formatMcpForModel,
    TAVILY_TOPICS,
    TAVILY_DEPTHS,
    TAVILY_TIME_RANGES,
    TAVILY_FORCED_KEYS,
    TAVILY_SEARCH_URL,
    /* 语音合成（TTS） */
    synthesizeSpeech,
    parseTtsJson,
    assembleAudio,
    pcmToWav,
    wavDataChunk,
    wavFmt,
    isRiff,
    b64ToBytes,
    bytesToDataUrl,
    normalizeAudioFormat,
    mimeOfFormat,
    AUDIO_FORMATS,
    TTS_SAMPLE_RATE
  };
})(window);
