/* ==========================================================================
   LynkLLM CE — 本地存储层
   全部数据保存在 localStorage，提供内存缓存以降低读写开销。
   ========================================================================== */
(function (global) {
  'use strict';

  const NS = 'lynkllm.ce';
  const K = {
    settings: NS + '.settings',
    models: NS + '.models',
    conversations: NS + '.conversations',
    activeId: NS + '.activeConversationId',
    draft: NS + '.draft',
    confirmPrefs: NS + '.confirmPrefs',
    tavily: NS + '.tavily',
    mcp: NS + '.mcp',
    skills: NS + '.skills'
  };
  const SCHEMA_VERSION = 1;

  /**
   * 应用版本号：大版本.小版本.版本id（版本id = YYMMDDNN，NN 为当天第几次迭代）。
   * ⚠️ **字面量不在这里** —— 全仓唯一来源是 assets/js/version.js
   * （必须先于本文件加载），这里只是把它接出来，避免三处各写一份、升级时漏改。
   */
  const APP_VERSION = String((global && global.LYNKLLM_VERSION) || '0.0.0');

  /* ---------- 默认设置 ---------- */
  function defaultSettings() {
    return {
      version: SCHEMA_VERSION,
      theme: 'auto',            // light | dark | auto
      lang: 'auto',             // auto | zh-CN | en
      enterBehavior: 'send',    // send | newline
      autoTitleMode: 'chat',    // first | chat | model
      autoTitle: true,          // 兼容字段：autoTitleMode !== 'first'
      richRender: true,         // LaTeX + Mermaid
      showTokens: true,
      stream: true,
      streamRenderBatch: 8,     // 流式输出每累计 N 个片段刷新一次界面
      titleModelId: '',         // 指定模型总结时使用的模型
      sidebarWidth: 0,          // 侧栏拖拽后的固定宽度，0 表示按默认比例
      maxImages: 6,
      maxImageMB: 8,
      imageSize: '1024x1024',   // 图片生成默认分辨率
      imageCount: 1,            // 图片生成默认数量
      /* 联网搜索（Tavily）：on 开启 | off 关闭。
         ⚠️ 第 13 轮把语义从「auto/off」改成了「on/off」——开启即等于原来的 auto
         （由模型自行决定是否搜索）。旧值 'auto' 在 getSettings 里归一为 'on'。 */
      webSearch: 'on',
      maxToolRounds: 6,         // 单轮对话内最多工具调用轮数
      /* 单次对话（一条用户消息）内最多**工具调用次数**，含同一轮的并行调用。
         ⚠️ 0 = 不限制（用户第 19 轮明确要求），默认也是 0：这是新增的可选项，
         不改默认行为。它与 maxToolRounds 是两个维度：轮数是「问模型几次」，
         次数是「总共调了几个工具」（一轮可能并行调多个）。 */
      maxToolCalls: 0,
      /* Pyodide（浏览器里的 Python）：供模型做复杂计算的本地工具。
         默认关。开关在「+」菜单里（第 16 轮从设置页搬过去），运行时缓存由
         PyodideRunner 管理，不进 localStorage（太大且是静态资源）。 */
      pyodideEnabled: false,
      /* MCP 工具调用的安全审批（第 16 轮）：
         'always' 始终允许（默认，不打断）/ 'ask' 始终询问 / 'oncePerRound' 每轮询问一次。
         只作用于 **MCP** 工具；Tavily 等其它工具不受影响。 */
      mcpApproval: 'always',
      /* 代码执行超时（秒）：60 = 默认；**0 表示「留空，由模型按需决定」**。
         合法区间 [30, 300]，超范围或非法值一律归 0（自动）。 */
      pyodideTimeout: 60,

      /* --- 个性化外观 --- */
      fx: true,                 // 半透明模糊（毛玻璃）效果开关
      fxStrength: 45,           // 效果强度 0 - 100（越大越模糊、越透）
      bgBlur: 0,                // 背景图片自身的模糊强度 0 - 100（与 fx 无关）
      accent: '',               // 主题色，空字符串表示使用内置默认色
      bgRev: 0                  // 背景图片的变更版本号：背景图存在 IndexedDB，
                                // 只靠 storage 事件感知不到，用这个数字当信号让其它标签页重新读取
    };
  }

  /** 模型类型：对话 / 图片生成 / 语音合成（后续可在此扩展更多类型） */
  const MODEL_KINDS = ['chat', 'image', 'tts'];

  /**
   * 对话模型的 API 格式（第 17 轮）：
   *   chat      OpenAI Chat Completions（默认，也是图片 / 语音唯一支持的格式）
   *   responses OpenAI Responses
   *   anthropic Anthropic Messages
   * ⚠️ 与 api.js 里的 API_FORMATS 必须同序同值（那边按它拼端点与请求体）。
   */
  const API_FORMATS = ['chat', 'responses', 'anthropic'];

  /**
   * Tavily 参数：可供用户在设置面板里手动指定。
   * 留空表示「交给模型决定」；填写后前端强制生效，且不再出现在工具定义里。
   */
  const TAVILY_PARAM_SCHEMA = [
    { key: 'topic', type: 'enum', options: ['general', 'news', 'finance'] },
    { key: 'search_depth', type: 'enum', options: ['basic', 'advanced', 'fast', 'ultra-fast'] },
    { key: 'max_results', type: 'int', min: 1, max: 20, placeholder: '5' },
    { key: 'chunks_per_source', type: 'int', min: 1, max: 3, placeholder: '3' },
    { key: 'time_range', type: 'enum', options: ['day', 'week', 'month', 'year'] },
    { key: 'start_date', type: 'date', placeholder: 'YYYY-MM-DD' },
    { key: 'end_date', type: 'date', placeholder: 'YYYY-MM-DD' },
    { key: 'country', type: 'text', placeholder: 'china' },
    { key: 'include_domains', type: 'list', placeholder: 'example.com, a.com' },
    { key: 'exclude_domains', type: 'list', placeholder: 'b.com' },
    { key: 'include_answer', type: 'bool' },
    { key: 'include_raw_content', type: 'bool' },
    { key: 'include_images', type: 'bool' },
    { key: 'include_image_descriptions', type: 'bool' },
    { key: 'include_favicon', type: 'bool' },
    { key: 'auto_parameters', type: 'bool' },
    { key: 'include_usage', type: 'bool' }
  ];

  /** 图片生成分辨率预设（宽x高，统一用字母 x 分隔） */
  const IMAGE_SIZE_PRESETS = [
    { value: 'auto', label: '自动' },
    { value: '1024x1024', label: '1024×1024 · 1:1' },
    { value: '1536x1536', label: '1536×1536 · 1:1 大图' },
    { value: '2048x2048', label: '2048×2048 · 2K 方图' },
    { value: '1280x720', label: '1280×720 · 16:9 横版' },
    { value: '1536x864', label: '1536×864 · 16:9 高清' },
    { value: '720x1280', label: '720×1280 · 9:16 竖版' },
    { value: '864x1536', label: '864×1536 · 9:16 高清' },
    { value: '1024x768', label: '1024×768 · 4:3 横版' },
    { value: '768x1024', label: '768×1024 · 3:4 竖版' },
    { value: '1280x960', label: '1280×960 · 4:3 大图' },
    { value: '960x1280', label: '960×1280 · 3:4 大图' },
    { value: '512x512', label: '512×512 · 小图' }
  ];

  /* ---------- 安全读写 ---------- */
  let memoryFallback = {};
  let usingMemory = false;

  function hasLS() {
    try {
      const t = '__lynk_test__';
      global.localStorage.setItem(t, '1');
      global.localStorage.removeItem(t);
      return true;
    } catch (e) {
      return false;
    }
  }

  function rawGet(key) {
    if (usingMemory) return memoryFallback[key] === undefined ? null : memoryFallback[key];
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  /**
   * 存储写满时给出可见提示。
   * 过去这里只 console.warn，用户以为消息已保存、刷新后才发现丢失 —— 属于静默数据丢失，
   * 因此改成明确告知（每次会话最多提示一次，避免刷屏）。
   */
  let quotaWarned = false;
  function notifyQuotaExceeded() {
    if (quotaWarned) return;
    quotaWarned = true;
    try {
      const t = global.I18N && global.I18N.t;
      const msg = t
        ? t('storageFull')
        : 'Local storage is full — recent changes may not be saved.';
      if (global.UI && global.UI.Toast) global.UI.Toast.error(msg, { duration: 9000 });
      else console.warn('[store] 本地存储已满：', msg);
    } catch (e) {
      console.warn('[store] 本地存储已满，写入失败');
    }
  }

  function rawSet(key, value) {
    if (usingMemory) { memoryFallback[key] = value; return true; }
    try {
      global.localStorage.setItem(key, value);
      quotaWarned = false;          // 能写成功就复位，便于下次再满时重新提示
      return true;
    } catch (e) {
      const isQuota = !!(e && (e.name === 'QuotaExceededError' || e.code === 22
        || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'));
      if (isQuota) notifyQuotaExceeded();
      else console.warn('[store] 写入失败：', key, e && e.message);
      return false;
    }
  }

  function rawRemove(key) {
    if (usingMemory) { delete memoryFallback[key]; return; }
    try { global.localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  function readJSON(key, fallbackValue) {
    const raw = rawGet(key);
    if (!raw) return fallbackValue;
    try {
      const v = JSON.parse(raw);
      return v === null || v === undefined ? fallbackValue : v;
    } catch (e) {
      console.warn('[store] 解析失败，使用默认值：', key);
      return fallbackValue;
    }
  }

  function writeJSON(key, value) {
    try {
      return rawSet(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[store] 写入失败：', key, e);
      return false;
    }
  }

  /* ---------- ID ---------- */
  function uid(prefix) {
    const rnd = Math.random().toString(36).slice(2, 10);
    return (prefix || 'id') + '_' + Date.now().toString(36) + rnd;
  }

  /* ---------- 设置 ---------- */
  const Store = {
    NS, K, uid, SCHEMA_VERSION,

    /** 检查存储可用性 */
    init() {
      const ok = hasLS();
      if (!ok) {
        usingMemory = true;
        console.warn('[store] localStorage 不可用，已降级为内存存储（刷新后数据会丢失）');
      }
      Store._storageOk = ok;
      return ok;
    },

    get storageAvailable() { return !usingMemory; },

    /* ----- 设置 ----- */
    getSettings() {
      const s = readJSON(K.settings, null);
      const merged = Object.assign(defaultSettings(), s || {});
      // 类型归一化，防止损坏数据导致崩溃
      if (['light', 'dark', 'auto'].indexOf(merged.theme) < 0) merged.theme = 'auto';
      if (['auto', 'zh-CN', 'en'].indexOf(merged.lang) < 0) merged.lang = 'auto';
      if (['send', 'newline'].indexOf(merged.enterBehavior) < 0) merged.enterBehavior = 'send';
      if (['first', 'chat', 'model'].indexOf(merged.autoTitleMode) < 0) {
        // 兼容旧版本：仅有布尔 autoTitle
        merged.autoTitleMode = merged.autoTitle === false ? 'first' : 'chat';
      }
      merged.autoTitle = merged.autoTitleMode !== 'first';
      merged.richRender = merged.richRender !== false;
      merged.showTokens = merged.showTokens !== false;
      merged.stream = merged.stream !== false;
      merged.streamRenderBatch = Math.min(60, Math.max(1, Number(merged.streamRenderBatch) || 8));
      merged.sidebarWidth = Math.max(0, Number(merged.sidebarWidth) || 0);
      merged.maxImages = Math.min(20, Math.max(1, Number(merged.maxImages) || 6));
      merged.maxImageMB = Math.min(30, Math.max(1, Number(merged.maxImageMB) || 8));
      merged.imageCount = Math.min(6, Math.max(1, Number(merged.imageCount) || 1));
      merged.imageSize = typeof merged.imageSize === 'string' && merged.imageSize
        ? merged.imageSize : '1024x1024';
      // 联网搜索：on 开启 | off 关闭（旧版 'auto' 等价于开启）
      merged.webSearch = merged.webSearch === 'off' ? 'off' : 'on';
      // MCP：默认关闭的服务 id 列表（存在 settings 里作为全局默认，对话可再覆盖）
      merged.mcpDisabled = Array.isArray(merged.mcpDisabled)
        ? merged.mcpDisabled.filter(x => typeof x === 'string') : [];
      // 技能：与 MCP 同一套口径（默认关闭的技能 id 列表，对话可再覆盖）
      merged.skillsDisabled = Array.isArray(merged.skillsDisabled)
        ? merged.skillsDisabled.filter(x => typeof x === 'string') : [];
      merged.maxToolRounds = Math.min(12, Math.max(1, Number(merged.maxToolRounds) || 6));
      /* 非负整数：负数 / 非数字 → 0（= 不限制），小数向下取整。
         ⚠️ 边界必须在这里收紧，不能只信输入框的 min —— 手输、粘贴都能绕过它。 */
      {
        const raw = Number(merged.maxToolCalls);
        merged.maxToolCalls = (isFinite(raw) && raw > 0) ? Math.floor(raw) : 0;
      }
      merged.pyodideEnabled = merged.pyodideEnabled === true;
      merged.mcpApproval = ['always', 'ask', 'oncePerRound'].indexOf(merged.mcpApproval) >= 0
        ? merged.mcpApproval : 'always';
      /* 超时（秒）：留空/0 = **自动**（0 是专用哨兵，不是「0 秒」）；
         填了数字就**夹进 [30,300]** —— 用户写 999 应该得到 300，而不是被静默改成「自动」。
         ⚠️ 边界必须在这里收紧，不能只信输入框的 min/max：手输、粘贴都能绕过它们。
         ⚠️ 顺序很关键：先判「空/0 → 自动」，再夹范围 —— 反过来的话 0 会被夹成 30。 */
      {
        const raw = merged.pyodideTimeout;
        const isEmpty = (raw === '' || raw == null || Number(raw) === 0);
        if (isEmpty) {
          merged.pyodideTimeout = 0;
        } else {
          const t = Math.round(Number(raw));
          merged.pyodideTimeout = isFinite(t) ? Math.max(30, Math.min(300, t)) : 0;
        }
      }
      // 个性化：容错处理，避免坏数据导致界面异常
      merged.fx = merged.fx !== false;
      const fxRaw = Number(merged.fxStrength);
      merged.fxStrength = isNaN(fxRaw) ? 45 : Math.min(100, Math.max(0, Math.round(fxRaw)));
      merged.accent = /^#[0-9a-f]{6}$/i.test(String(merged.accent || '')) ? String(merged.accent).toLowerCase() : '';
      merged.bgRev = Math.max(0, Number(merged.bgRev) || 0);
      const bgBlurRaw = Number(merged.bgBlur);
      merged.bgBlur = isNaN(bgBlurRaw) ? 0 : Math.min(100, Math.max(0, Math.round(bgBlurRaw)));
      return merged;
    },

    saveSettings(patch) {
      const next = Object.assign(Store.getSettings(), patch || {});
      next.version = SCHEMA_VERSION;
      writeJSON(K.settings, next);
      return next;
    },

    resetSettings() {
      const d = defaultSettings();
      writeJSON(K.settings, d);
      return d;
    },

    /* ----- 模型 ----- */
    getModels() {
      const arr = readJSON(K.models, []);
      if (!Array.isArray(arr)) return [];
      return arr.filter(m => m && typeof m === 'object' && m.id).map(normalizeModel);
    },

    saveModels(list) {
      return writeJSON(K.models, (list || []).map(normalizeModel));
    },

    getModel(id) {
      if (!id) return null;
      return Store.getModels().find(m => m.id === id) || null;
    },

    upsertModel(model) {
      const list = Store.getModels();
      const m = normalizeModel(model);
      const i = list.findIndex(x => x.id === m.id);
      if (i >= 0) list[i] = m; else list.push(m);
      Store.saveModels(list);
      return m;
    },

    deleteModel(id) {
      const list = Store.getModels().filter(m => m.id !== id);
      Store.saveModels(list);
      return list;
    },

    /* ----- 联网搜索（Tavily）----- */
    getTavily() {
      const t = readJSON(K.tavily, null);
      return {
        apiKey: (t && typeof t.apiKey === 'string') ? t.apiKey.trim() : '',
        verifiedAt: (t && Number(t.verifiedAt)) || 0,
        params: normalizeTavilyParams(t && t.params)
      };
    },

    saveTavily(patch) {
      const next = Object.assign(Store.getTavily(), patch || {});
      if (patch && patch.params) next.params = normalizeTavilyParams(patch.params);
      writeJSON(K.tavily, next);
      return next;
    },

    /** 用户已手动指定（非空）的 Tavily 参数 */
    getTavilyForced() {
      return normalizeTavilyForced(Store.getTavily().params);
    },

    /* ----- MCP 服务器 ----- */
    getMcpServers() {
      const arr = readJSON(K.mcp, []);
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => s && typeof s === 'object' && s.id).map(normalizeMcpServer);
    },

    saveMcpServers(list) {
      return writeJSON(K.mcp, (list || []).map(normalizeMcpServer));
    },

    getMcpServer(id) {
      if (!id) return null;
      return Store.getMcpServers().find(s => s.id === id) || null;
    },

    upsertMcpServer(server) {
      const list = Store.getMcpServers();
      const s = normalizeMcpServer(server);
      const i = list.findIndex(x => x.id === s.id);
      if (i >= 0) list[i] = s; else list.push(s);
      Store.saveMcpServers(list);
      return s;
    },

    deleteMcpServer(id) {
      const list = Store.getMcpServers().filter(s => s.id !== id);
      Store.saveMcpServers(list);
      return list;
    },

    /** 全部处于「启用」状态的 MCP 服务器（全局默认 + 对话覆盖） */
    getEnabledMcpServers(conv) {
      const off = Store.getSettings().mcpDisabled || [];
      const overrides = (conv && conv.mcp && typeof conv.mcp === 'object') ? conv.mcp : {};
      return Store.getMcpServers().filter(s => {
        if (Object.prototype.hasOwnProperty.call(overrides, s.id)) return overrides[s.id] === true;
        return off.indexOf(s.id) < 0;
      });
    },

    /* ----- 技能（单文件 SKILL.md） -----
       ⚠️ 存的就是**用户填写的原文**（content）。name / description 只从
       头部 YAML 里**读出来用于界面展示**，不做校验、不做渲染 ——
       调用时整份文件原样交给模型（用户明确要求）。 */
    getSkills() {
      const arr = readJSON(K.skills, []);
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => s && typeof s === 'object' && s.id).map(normalizeSkill);
    },

    saveSkills(list) {
      return writeJSON(K.skills, (list || []).map(normalizeSkill));
    },

    getSkill(id) {
      if (!id) return null;
      return Store.getSkills().find(s => s.id === id) || null;
    },

    upsertSkill(skill) {
      const list = Store.getSkills();
      const s = normalizeSkill(skill);
      const i = list.findIndex(x => x.id === s.id);
      if (i >= 0) list[i] = s; else list.push(s);
      Store.saveSkills(list);
      return s;
    },

    deleteSkill(id) {
      const list = Store.getSkills().filter(s => s.id !== id);
      Store.saveSkills(list);
      return list;
    },

    /** 全部处于「启用」状态的技能（全局默认 + 对话覆盖），与 MCP 同一套口径 */
    getEnabledSkills(conv) {
      const off = Store.getSettings().skillsDisabled || [];
      const overrides = (conv && conv.skills && typeof conv.skills === 'object') ? conv.skills : {};
      return Store.getSkills().filter(s => {
        if (Object.prototype.hasOwnProperty.call(overrides, s.id)) return overrides[s.id] === true;
        return off.indexOf(s.id) < 0;
      });
    },

    /* ----- 对话 ----- */
    getConversations() {
      const arr = readJSON(K.conversations, []);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(c => c && typeof c === 'object' && c.id)
        .map(c => ({
          id: c.id,
          title: typeof c.title === 'string' ? c.title : '',
          titleAuto: c.titleAuto !== false,
          createdAt: Number(c.createdAt) || Date.now(),
          updatedAt: Number(c.updatedAt) || Number(c.createdAt) || Date.now(),
          // 置顶：pinnedAt 仅用于「置顶区内部」的排序（后置顶的排前面）
          pinned: c.pinned === true,
          pinnedAt: Number(c.pinnedAt) || 0,
          modelId: c.modelId || '',
          thinking: typeof c.thinking === 'string' ? c.thinking : '',
          imageSize: typeof c.imageSize === 'string' && c.imageSize ? c.imageSize : '',
          imageCount: Math.min(6, Math.max(1, Number(c.imageCount) || 1)),
          webSearch: (c.webSearch === 'off') ? 'off' : (c.webSearch === 'on' || c.webSearch === 'auto' ? 'on' : ''),
          /* MCP 开关：{ [serverId]: true|false }。缺省（没有该键）表示用全局默认，
             这样新增的服务器会自动生效，不需要逐条回填历史对话。 */
          mcp: (c.mcp && typeof c.mcp === 'object' && !Array.isArray(c.mcp)) ? c.mcp : {},
          /* 技能开关：与 mcp 同一套语义（第 18 轮）。
             ⚠️⚠️ 这里**必须**列进白名单：对话是逐字段重建的，漏了这个键
             `conv.skills` 会在每次读回时被**静默丢掉** →
             「+」菜单里拨动技能开关看起来毫无效果（真踩过，test19 (14)③④ 抓出来的）。 */
          skills: (c.skills && typeof c.skills === 'object' && !Array.isArray(c.skills)) ? c.skills : {},
          messages: Array.isArray(c.messages) ? c.messages.filter(isValidMessage) : []
        }));
    },

    saveConversations(list) {
      return writeJSON(K.conversations, list || []);
    },

    getConversation(id) {
      return Store.getConversations().find(c => c.id === id) || null;
    },

    upsertConversation(conv) {
      const list = Store.getConversations();
      const i = list.findIndex(c => c.id === conv.id);
      if (i >= 0) list[i] = conv; else list.unshift(conv);
      Store.saveConversations(list);
      return conv;
    },

    deleteConversation(id) {
      const list = Store.getConversations().filter(c => c.id !== id);
      Store.saveConversations(list);
      return list;
    },

    getActiveId() {
      const id = rawGet(K.activeId);
      if (!id) return '';
      return Store.getConversation(id) ? id : '';
    },

    setActiveId(id) {
      if (id) rawSet(K.activeId, id); else rawRemove(K.activeId);
    },

    /* ----- 草稿 ----- */
    getDraft(convId) {
      const d = readJSON(K.draft, {});
      return (d && d[convId]) || '';
    },

    setDraft(convId, text) {
      if (!convId) return;
      const d = readJSON(K.draft, {}) || {};
      if (text) d[convId] = text; else delete d[convId];
      const keys = Object.keys(d);
      if (keys.length > 40) delete d[keys[0]];
      writeJSON(K.draft, d);
    },

    /* ----- 确认偏好 ----- */
    getConfirmPrefs() {
      return readJSON(K.confirmPrefs, {}) || {};
    },

    setConfirmPref(key, value) {
      const p = Store.getConfirmPrefs();
      p[key] = !!value;
      writeJSON(K.confirmPrefs, p);
    },

    /* ----- 统计 / 清理 ----- */
    stats() {
      const convs = Store.getConversations();
      let msgs = 0;
      convs.forEach(c => { msgs += c.messages.length; });
      let bytes = 0;
      [K.settings, K.models, K.conversations, K.activeId, K.draft, K.confirmPrefs,
        K.tavily, K.mcp, K.skills].forEach(k => {
        const raw = rawGet(k);
        if (raw) bytes += raw.length * 2;
      });
      return {
        conversations: convs.length,
        messages: msgs,
        models: Store.getModels().length,
        mcpServers: Store.getMcpServers().length,
        bytes
      };
    },

    clearAll() {
      Object.keys(K).forEach(name => rawRemove(K[name]));
      memoryFallback = {};
    },

    /* ----- 导入 / 导出 ----- */
    exportData() {
      return {
        app: 'LynkLLM CE',
        appVersion: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        settings: Store.getSettings(),
        models: Store.getModels(),
        conversations: Store.getConversations(),
        tavily: Store.getTavily(),
        mcpServers: Store.getMcpServers(),
        /* 技能（第 18 轮）：与 MCP 服务器同级的独立配置，备份必须带上，
           否则用户换机器恢复后会静默丢掉全部技能。 */
        skills: Store.getSkills()
      };
    },

    importData(obj) {
      if (!obj || typeof obj !== 'object') throw new Error('invalid');
      let n = 0;
      if (obj.settings && typeof obj.settings === 'object') {
        Store.saveSettings(obj.settings);
        n++;
      }
      if (Array.isArray(obj.models)) {
        // 与已有配置按 id 合并
        const existing = Store.getModels();
        const map = {};
        existing.forEach(m => { map[m.id] = m; });
        obj.models.forEach(m => { if (m && m.id) map[m.id] = normalizeModel(m); });
        Store.saveModels(Object.keys(map).map(k => map[k]));
        n++;
      }
      if (Array.isArray(obj.conversations)) {
        const existing = Store.getConversations();
        const map = {};
        existing.forEach(c => { map[c.id] = c; });
        obj.conversations.forEach(c => { if (c && c.id) map[c.id] = c; });
        const merged = Object.keys(map).map(k => map[k])
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        Store.saveConversations(merged);
        n++;
      }
      if (obj.tavily && typeof obj.tavily === 'object') {
        Store.saveTavily({
          apiKey: String(obj.tavily.apiKey || ''),
          params: obj.tavily.params || null
        });
        n++;
      }
      if (Array.isArray(obj.mcpServers)) {
        // 与已有配置按 id 合并（同模型的处理）
        const existing = Store.getMcpServers();
        const map = {};
        existing.forEach(s => { map[s.id] = s; });
        obj.mcpServers.forEach(s => { if (s && s.id) map[s.id] = normalizeMcpServer(s); });
        Store.saveMcpServers(Object.keys(map).map(k => map[k]));
        n++;
      }
      if (Array.isArray(obj.skills)) {
        // 与已有配置按 id 合并（同 MCP 的处理）
        const existing = Store.getSkills();
        const map = {};
        existing.forEach(k0 => { map[k0.id] = k0; });
        obj.skills.forEach(k0 => { if (k0 && k0.id) map[k0.id] = normalizeSkill(k0); });
        Store.saveSkills(Object.keys(map).map(k1 => map[k1]));
        n++;
      }
      if (!n) throw new Error('empty');
      return n;
    },

    /** 底层逃生通道 */
    _raw: { get: rawGet, set: rawSet, remove: rawRemove, readJSON, writeJSON }
  };

  /* ---------- 归一化 ---------- */
  /** 统一去除首尾空白与末尾斜杠（保留协议中的 //） */
  function normalizeBaseUrl(raw) {
    let u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    u = u.replace(/\s+/g, '');
    u = u.replace(/\/+$/, '');
    return u;
  }

  function normalizeModel(m) {
    const kind = MODEL_KINDS.indexOf(m.kind) >= 0 ? m.kind : 'chat';   // chat | image | tts
    return {
      id: m.id || uid('model'),
      kind,
      name: String(m.name || '').trim() || 'Untitled',
      baseUrl: normalizeBaseUrl(m.baseUrl),
      /* API 格式：仅对话模型可选 —— 图片生成 / 语音合成在网页里写死了 OpenAI Chat 的
         端点与字段（/images/generations、audio 字段），非 chat 一律回落成 chat。 */
      apiFormat: (kind === 'chat' && API_FORMATS.indexOf(m.apiFormat) >= 0) ? m.apiFormat : 'chat',
      apiKey: String(m.apiKey || '').trim(),
      model: String(m.model || '').trim(),
      systemPrompt: typeof m.systemPrompt === 'string' ? m.systemPrompt : '',
      contextLength: Math.max(0, Number(m.contextLength) || 0),
      thinkingLevels: Array.isArray(m.thinkingLevels)
        ? m.thinkingLevels.map(s => String(s).trim()).filter(Boolean)
        : String(m.thinkingLevels || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
      supportsImages: !!m.supportsImages,
      supportsStream: m.supportsStream !== false,
      supportsTools: !!m.supportsTools,
      /* 该模型的请求是否交给油猴脚本转发以绕过 CORS（默认关闭） */
      corsBypass: m.corsBypass === true,
      /* ---- 语音合成（kind = tts）---- */
      voice: String(m.voice || '').trim(),                        // 音色 ID（留空则用服务商默认值）
      audioFormat: normalizeAudioFormat(m.audioFormat),           // wav | mp3 | pcm
      ttsInstruction: typeof m.ttsInstruction === 'string' ? m.ttsInstruction : '',
      createdAt: Number(m.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  /** 音频输出格式归一化 */
  function normalizeAudioFormat(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'mp3' || s === 'mpeg') return 'mp3';
    if (s === 'pcm' || s === 'pcm16') return 'pcm';
    return 'wav';
  }

  /* ---------- MCP 服务器 ---------- */

  /**
   * MCP 服务器配置归一化。
   * 目前只支持 Streamable HTTP 传输（协议端点就是一个 HTTP URL），
   * 因此地址只做去空白处理，不套用模型那套「去末尾斜杠」规则 ——
   * 有些实现把端点写成 `.../mcp/`，去掉斜杠反而 404。
   */
  function normalizeMcpServer(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    return {
      id: s.id || uid('mcp'),
      name: String(s.name || '').trim() || 'Unnamed MCP',
      url: String(s.url == null ? '' : s.url).trim().replace(/\s+/g, ''),
      /* 请求该服务器的请求是否交给油猴脚本转发以绕过 CORS（默认关闭） */
      corsBypass: s.corsBypass === true,
      /* 自定义 HTTP 头：数组 [{ name, value }]，便于界面里增删排序 */
      headers: normalizeHeaderList(s.headers),
      supportsStream: s.supportsStream !== false,
      /* 最近一次连通性测试结果（只作界面提示，不参与逻辑判断） */
      lastTest: (s.lastTest && typeof s.lastTest === 'object') ? {
        ok: s.lastTest.ok === true,
        ms: Math.max(0, Number(s.lastTest.ms) || 0),
        toolCount: Math.max(0, Number(s.lastTest.toolCount) || 0),
        at: Number(s.lastTest.at) || 0,
        error: typeof s.lastTest.error === 'string' ? s.lastTest.error : ''
      } : null,
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  /**
   * 解析单文件 SKILL.md：只关心头部 YAML 里的 `name` 与 `description`。
   *
   * ⚠️ 刻意**不做严格 YAML 解析、不做校验**（用户明确要求「不做额外渲染和校验处理」）：
   *    · 头部以 `---` 起止；里面的 `key: value` 逐行扫，值去掉首尾引号。
   *    · 没有头部时退化为「取第一个 # 标题当 name、第一段正文当 description」，
   *      这样用户随手贴一个纯 markdown 也能在列表里看出是什么。
   * 返回 { name, description }；正文**原样保留在 content 里**，调用时整份给模型。
   */
  function parseSkillMd(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const out = { name: '', description: '' };
    const lines = raw.split('\n');

    // 头部：首行（跳过空行）必须是 ---
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && lines[i].trim() === '---') {
      i++;
      const head = [];
      while (i < lines.length && lines[i].trim() !== '---') { head.push(lines[i]); i++; }
      head.forEach(line => {
        const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) return;
        const key = m[1].toLowerCase();
        if (key !== 'name' && key !== 'description') return;
        let v = m[2].trim();
        // 去掉包裹引号（单/双）
        if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
          v = v.slice(1, -1);
        }
        if (!out[key]) out[key] = v;
      });
    }

    // 兜底：从正文里取标题与首个非空段落
    if (!out.name) {
      const h = /^\s{0,3}#\s+(.+?)\s*$/m.exec(raw);
      if (h) out.name = h[1].trim();
    }
    if (!out.description) {
      const body = raw.replace(/^\s*---[\s\S]*?\n---\s*\n?/, '');
      const para = body.split(/\n\s*\n/).map(s => s.trim())
        .find(s => s && !/^#{1,6}\s/.test(s) && !/^[-*]\s/.test(s));
      if (para) out.description = para.replace(/\s+/g, ' ').slice(0, 200);
    }
    return out;
  }

  /** 技能归一化：name/description 始终与 content 头部保持同步 */
  function normalizeSkill(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    const content = String(s.content == null ? '' : s.content);
    const parsed = parseSkillMd(content);
    return {
      id: s.id || uid('skill'),
      // 用户没写 name 也不拦着，给个占位名，列表里仍然看得见
      name: String(s.name || parsed.name || '').trim() || 'Untitled Skill',
      description: String(s.description || parsed.description || '').trim(),
      content,
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  /** 自定义头归一化：兼容 [{name,value}] / {k:v} / "K: V" 文本三种输入 */
  function normalizeHeaderList(raw) {
    const out = [];
    const push = (name, value) => {
      const n = String(name == null ? '' : name).trim();
      if (!n) return;
      out.push({ name: n, value: String(value == null ? '' : value) });
    };
    if (Array.isArray(raw)) {
      raw.forEach(h => {
        if (h && typeof h === 'object') push(h.name, h.value);
        else if (typeof h === 'string') {
          const i = h.indexOf(':');
          if (i > 0) push(h.slice(0, i), h.slice(i + 1).trim());
        }
      });
    } else if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(k => push(k, raw[k]));
    } else if (typeof raw === 'string') {
      raw.split(/\r?\n|;/).forEach(line => {
        const i = line.indexOf(':');
        if (i > 0) push(line.slice(0, i), line.slice(i + 1).trim());
      });
    }
    return out;
  }

  /**
   * 把自定义头列表转成请求用的普通对象。
   * ⚠️ 内置头优先：用户填的 Content-Type / Accept / mcp-session-id 会被忽略，
   * 否则会把 JSON-RPC 的传输层打乱（比如把 Accept 改成 application/json 会直接 406）。
   */
  function headersToObject(list, reserved) {
    const reservedLower = (reserved || []).map(s => String(s).toLowerCase());
    const out = {};
    normalizeHeaderList(list).forEach(h => {
      const lower = h.name.toLowerCase();
      if (reservedLower.indexOf(lower) >= 0) return;
      if (lower === 'host' || lower === 'content-length') return;   // 浏览器禁止设置
      out[h.name] = h.value;
    });
    return out;
  }

  /* ---------- Tavily 参数归一化 ---------- */

  /** 把任意输入归一化为「完整参数表」（空值表示交给模型决定） */
  function normalizeTavilyParams(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    TAVILY_PARAM_SCHEMA.forEach(f => {
      const v = src[f.key];
      if (f.type === 'bool') {
        out[f.key] = (v === true || v === 'true') ? true : ((v === false || v === 'false') ? false : '');
      } else if (f.type === 'int') {
        const n = Number(v);
        out[f.key] = (v === '' || v === null || v === undefined || !isFinite(n) || !n)
          ? ''
          : Math.min(f.max, Math.max(f.min, Math.round(n)));
      } else if (f.type === 'enum') {
        const s = String(v == null ? '' : v).trim();
        out[f.key] = f.options.indexOf(s) >= 0 ? s : '';
      } else if (f.type === 'list') {
        const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，\n]/);
        out[f.key] = list.map(s => String(s).trim()).filter(Boolean);
      } else {
        out[f.key] = String(v == null ? '' : v).trim();
      }
    });
    return out;
  }

  /** 只保留真正填写了的项，用于强制指定 */
  function normalizeTavilyForced(params) {
    const full = normalizeTavilyParams(params);
    const out = {};
    Object.keys(full).forEach(k => {
      const v = full[k];
      if (v === '' || v === null || v === undefined) return;
      if (Array.isArray(v) && !v.length) return;
      out[k] = v;
    });
    return out;
  }

  function isValidMessage(m) {
    return m && typeof m === 'object' && m.role && (typeof m.content === 'string' || Array.isArray(m.content));
  }

  Store.normalizeModel = normalizeModel;
  Store.normalizeBaseUrl = normalizeBaseUrl;
  Store.normalizeMcpServer = normalizeMcpServer;
  Store.normalizeSkill = normalizeSkill;
  Store.parseSkillMd = parseSkillMd;
  Store.normalizeHeaderList = normalizeHeaderList;
  Store.headersToObject = headersToObject;
  Store.normalizeTavilyParams = normalizeTavilyParams;
  Store.normalizeTavilyForced = normalizeTavilyForced;
  Store.normalizeAudioFormat = normalizeAudioFormat;
  Store.defaultSettings = defaultSettings;
  Store.MODEL_KINDS = MODEL_KINDS;
  Store.API_FORMATS = API_FORMATS;
  Store.IMAGE_SIZE_PRESETS = IMAGE_SIZE_PRESETS;
  Store.TAVILY_PARAM_SCHEMA = TAVILY_PARAM_SCHEMA;
  Store.APP_VERSION = APP_VERSION;

  global.Store = Store;
})(window);
