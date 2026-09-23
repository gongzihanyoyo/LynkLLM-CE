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
    tavily: NS + '.tavily'
  };
  const SCHEMA_VERSION = 1;

  /** 应用版本号：大版本.小版本.版本id（版本id = YYMMDDNN，NN 为当天第几次迭代） */
  const APP_VERSION = '1.1.26092301';

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
      webSearch: 'auto',        // 联网搜索（Tavily）：auto 由模型自行决定 | off 关闭
      maxToolRounds: 6,         // 单轮对话内最多工具调用轮数

      /* --- 个性化外观 --- */
      fx: true,                 // 半透明模糊（毛玻璃）效果开关
      fxStrength: 45,           // 效果强度 0 - 100（越大越模糊、越透）
      accent: '',               // 主题色，空字符串表示使用内置默认色
      bgRev: 0                  // 背景图片的变更版本号：背景图存在 IndexedDB，
                                // 只靠 storage 事件感知不到，用这个数字当信号让其它标签页重新读取
    };
  }

  /** 模型类型：对话 / 图片生成 / 语音合成（后续可在此扩展更多类型） */
  const MODEL_KINDS = ['chat', 'image', 'tts'];

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
      if (['auto', 'off'].indexOf(merged.webSearch) < 0) merged.webSearch = 'auto';
      merged.maxToolRounds = Math.min(12, Math.max(1, Number(merged.maxToolRounds) || 6));
      // 个性化：容错处理，避免坏数据导致界面异常
      merged.fx = merged.fx !== false;
      const fxRaw = Number(merged.fxStrength);
      merged.fxStrength = isNaN(fxRaw) ? 45 : Math.min(100, Math.max(0, Math.round(fxRaw)));
      merged.accent = /^#[0-9a-f]{6}$/i.test(String(merged.accent || '')) ? String(merged.accent).toLowerCase() : '';
      merged.bgRev = Math.max(0, Number(merged.bgRev) || 0);
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
          modelId: c.modelId || '',
          thinking: typeof c.thinking === 'string' ? c.thinking : '',
          imageSize: typeof c.imageSize === 'string' && c.imageSize ? c.imageSize : '',
          imageCount: Math.min(6, Math.max(1, Number(c.imageCount) || 1)),
          webSearch: (c.webSearch === 'off' || c.webSearch === 'auto') ? c.webSearch : '',
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
      [K.settings, K.models, K.conversations, K.activeId, K.draft, K.confirmPrefs, K.tavily].forEach(k => {
        const raw = rawGet(k);
        if (raw) bytes += raw.length * 2;
      });
      return {
        conversations: convs.length,
        messages: msgs,
        models: Store.getModels().length,
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
        tavily: Store.getTavily()
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
    return {
      id: m.id || uid('model'),
      kind: MODEL_KINDS.indexOf(m.kind) >= 0 ? m.kind : 'chat',   // chat | image | tts
      name: String(m.name || '').trim() || 'Untitled',
      baseUrl: normalizeBaseUrl(m.baseUrl),
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
  Store.normalizeTavilyParams = normalizeTavilyParams;
  Store.normalizeTavilyForced = normalizeTavilyForced;
  Store.normalizeAudioFormat = normalizeAudioFormat;
  Store.defaultSettings = defaultSettings;
  Store.MODEL_KINDS = MODEL_KINDS;
  Store.IMAGE_SIZE_PRESETS = IMAGE_SIZE_PRESETS;
  Store.TAVILY_PARAM_SCHEMA = TAVILY_PARAM_SCHEMA;
  Store.APP_VERSION = APP_VERSION;

  global.Store = Store;
})(window);
