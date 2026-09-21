/* ==========================================================================
   LynkLLM CE — 合成语音的本地存储（IndexedDB）
   与生成图片同理：音频体积不小（数秒 WAV 可达数百 KB），localStorage 放不下，
   因此以 dataURL 形式落盘到 IndexedDB，并提供内存缓存让渲染保持同步。
   使用独立数据库，避免与 ImageStore 的版本升级互相冲突。
   ========================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'lynkllm-ce-audio';
  const DB_VERSION = 1;
  const STORE = 'audio';

  let dbPromise = null;
  let available = true;

  /** 内存缓存：id -> dataURL（让本次会话内已合成的音频可以同步渲染） */
  const cache = new Map();

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        if (!global.indexedDB) throw new Error('IndexedDB unavailable');
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        available = false;
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { available = false; reject(req.error); };
      req.onblocked = () => { available = false; reject(new Error('blocked')); };
    }).catch(err => {
      console.warn('[audiostore] IndexedDB 不可用，音频将只保留在当前会话内存中：', err && err.message);
      return null;
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(db => {
      if (!db) return null;
      return new Promise((resolve, reject) => {
        let t;
        try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
        const store = t.objectStore(STORE);
        let result;
        try { result = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }).catch(err => {
      console.warn('[audiostore] 事务失败：', err && err.message);
      return null;
    });
  }

  function wrap(request) { return { __req: request }; }

  /**
   * 保存音频
   * @param {string} id
   * @param {string} dataUrl
   * @param {object} [meta] { conversationId, messageId, text, ttsModelId, ttsModelName, voice, format, mime, transcript }
   */
  function save(id, dataUrl, meta) {
    if (!id || !dataUrl) return Promise.resolve(false);
    cache.set(id, dataUrl);
    const record = Object.assign({
      id,
      dataUrl,
      bytes: Math.round(dataUrl.length * 0.75),
      createdAt: Date.now()
    }, meta || {});
    return tx('readwrite', store => wrap(store.put(record))).then(r => r !== null);
  }

  /** 读取（先内存缓存，再 IndexedDB） */
  function get(id) {
    if (!id) return Promise.resolve(null);
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    return tx('readonly', store => wrap(store.get(id))).then(rec => {
      if (rec && rec.dataUrl) {
        cache.set(id, rec.dataUrl);
        return rec.dataUrl;
      }
      return null;
    });
  }

  /** 同步读取（仅内存缓存，用于首屏渲染） */
  function getCached(id) { return cache.get(id) || null; }

  function removeMany(ids) {
    const list = (ids || []).filter(Boolean);
    list.forEach(id => cache.delete(id));
    if (!list.length) return Promise.resolve(true);
    return tx('readwrite', store => {
      list.forEach(id => store.delete(id));
      return true;
    }).then(r => r !== null);
  }

  function clear() {
    cache.clear();
    if (!global.indexedDB) return Promise.resolve(true);
    return new Promise(resolve => {
      let req;
      try { req = global.indexedDB.deleteDatabase(DB_NAME); } catch (e) { resolve(false); return; }
      req.onsuccess = () => { dbPromise = null; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  }

  function stats() {
    return tx('readonly', store => wrap(store.getAll())).then(list => {
      if (!list) return { count: cache.size, bytes: 0, available };
      let bytes = 0;
      list.forEach(r => { bytes += Number(r.bytes) || 0; });
      return { count: list.length, bytes, available };
    });
  }

  /**
   * 把渲染结果里还没有 src 的音频补上（页面刷新后从 IndexedDB 重新加载）
   * @param {HTMLElement} root
   */
  function hydrate(root) {
    if (!root) return Promise.resolve();
    const pending = Array.prototype.slice
      .call(root.querySelectorAll('audio[data-audio-id]'))
      .filter(a => !a.getAttribute('src'));
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(a => {
      const id = a.getAttribute('data-audio-id');
      return get(id).then(src => {
        const holder = a.closest('.msg-audio');
        if (!src) {
          if (holder) holder.classList.add('is-missing');
          return;
        }
        a.setAttribute('src', src);
        if (holder) { holder.classList.remove('is-pending'); holder.classList.add('is-ready'); }
      });
    }));
  }

  /** 清空内存缓存 */
  function dropCache() { cache.clear(); }

  /** 触发下载 */
  function download(id, name, ext) {
    return get(id).then(dataUrl => {
      if (!dataUrl) {
        UI.Toast.error(I18N.t('audioMissing'));
        return false;
      }
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = name || ('lynkllm-audio-' + String(id).slice(-6) + '.' + (ext || 'wav'));
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
      return true;
    });
  }

  /** dataURL → 扩展名 */
  function extOf(dataUrl, mime) {
    const m = String(mime || (String(dataUrl || '').match(/^data:([^;,]+)/) || [])[1] || 'audio/wav');
    if (/mpeg|mp3/i.test(m)) return 'mp3';
    if (/ogg/i.test(m)) return 'ogg';
    if (/webm/i.test(m)) return 'webm';
    return 'wav';
  }

  global.AudioStore = {
    save, get, getCached, removeMany, clear, stats, hydrate, download, extOf, dropCache,
    get available() { return available; },
    get cacheSize() { return cache.size; }
  };
})(window);
