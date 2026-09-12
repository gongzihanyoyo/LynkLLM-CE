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
    confirmPrefs: NS + '.confirmPrefs'
  };
  const SCHEMA_VERSION = 1;

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
      titleModelId: '',         // 指定模型总结时使用的模型
      sidebarWidth: 0,          // 侧栏拖拽后的固定宽度，0 表示按默认比例
      maxImages: 6,
      maxImageMB: 8
    };
  }

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

  function rawSet(key, value) {
    if (usingMemory) { memoryFallback[key] = value; return true; }
    try {
      global.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      // 配额超限等：尝试清理后重试一次
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        return false;
      }
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
      merged.sidebarWidth = Math.max(0, Number(merged.sidebarWidth) || 0);
      merged.maxImages = Math.min(20, Math.max(1, Number(merged.maxImages) || 6));
      merged.maxImageMB = Math.min(30, Math.max(1, Number(merged.maxImageMB) || 8));
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
      [K.settings, K.models, K.conversations, K.activeId, K.draft, K.confirmPrefs].forEach(k => {
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
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        settings: Store.getSettings(),
        models: Store.getModels(),
        conversations: Store.getConversations()
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
      createdAt: Number(m.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  function isValidMessage(m) {
    return m && typeof m === 'object' && m.role && (typeof m.content === 'string' || Array.isArray(m.content));
  }

  Store.normalizeModel = normalizeModel;
  Store.normalizeBaseUrl = normalizeBaseUrl;
  Store.defaultSettings = defaultSettings;

  global.Store = Store;
})(window);
