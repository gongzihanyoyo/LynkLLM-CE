/* ==========================================================================
   LynkLLM CE — 生成图片的本地存储（IndexedDB）
   为什么不用 localStorage：生成的图片体积较大，localStorage 配额只有几 MB，
   而服务商返回的图片链接往往只有几小时到一天的有效期。
   因此这里把图片以 dataURL 形式落盘到 IndexedDB，并提供内存缓存让渲染保持同步。
   ========================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'lynkllm-ce';
  const DB_VERSION = 1;
  const STORE = 'images';

  let dbPromise = null;
  let available = true;

  /** 内存缓存：id -> dataURL（让已加载过的图片可以同步渲染） */
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
      console.warn('[imagestore] IndexedDB 不可用，图片将只保留在当前会话内存中：', err && err.message);
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
      console.warn('[imagestore] 事务失败：', err && err.message);
      return null;
    });
  }

  function wrap(request) { return { __req: request }; }

  /* ---------------------------------------------------------------------- */

  /**
   * 保存图片
   * @param {string} id 图片 id
   * @param {string} dataUrl dataURL 字符串
   * @param {object} [meta] { conversationId, messageId, name, mime, width, height, prompt }
   * @returns {Promise<boolean>}
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
  function getCached(id) {
    return cache.get(id) || null;
  }

  /** 批量删除 */
  function removeMany(ids) {
    const list = (ids || []).filter(Boolean);
    list.forEach(id => cache.delete(id));
    if (!list.length) return Promise.resolve(true);
    return tx('readwrite', store => {
      list.forEach(id => store.delete(id));
      return true;
    }).then(r => r !== null);
  }

  /**
   * 关闭当前连接。
   * deleteDatabase 会被「本页自己持有的连接」阻塞：不先关掉，onblocked 会被触发、
   * 删除请求一直挂起 —— 此后写入的数据会在页面关闭时被这个挂起的删除一起抹掉。
   */
  function closeDB() {
    return Promise.resolve(dbPromise).then(db => {
      try { if (db) db.close(); } catch (e) { /* noop */ }
      dbPromise = null;
    }).catch(() => { dbPromise = null; });
  }

  /** 清空全部图片 */
  function clear() {
    cache.clear();
    if (!global.indexedDB) return Promise.resolve(true);
    return closeDB().then(() => new Promise(resolve => {
      let req;
      try { req = global.indexedDB.deleteDatabase(DB_NAME); } catch (e) { resolve(false); return; }
      req.onsuccess = () => { dbPromise = null; resolve(true); };
      req.onerror = () => { dbPromise = null; resolve(false); };
      req.onblocked = () => { dbPromise = null; resolve(false); };
    }));
  }

  /** 统计：{ count, bytes } */
  function stats() {
    return tx('readonly', store => wrap(store.getAll())).then(list => {
      if (!list) return { count: cache.size, bytes: 0, available };
      let bytes = 0;
      list.forEach(r => { bytes += Number(r.bytes) || 0; });
      return { count: list.length, bytes, available };
    });
  }

  /** 列出全部记录（导出备份用），失败时返回空数组而不是抛错 */
  function list() {
    return tx('readonly', store => wrap(store.getAll())).then(recs => recs || []).catch(() => []);
  }

  /**
   * 把渲染结果里还没有 src 的图片补上（页面刷新后从 IndexedDB 重新加载）
   * @param {HTMLElement} root
   */
  function hydrate(root) {
    if (!root) return Promise.resolve();
    const pending = Array.prototype.slice
      .call(root.querySelectorAll('img[data-image-id]'))
      .filter(img => !img.getAttribute('src'));
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(img => {
      const id = img.getAttribute('data-image-id');
      return get(id).then(src => {
        if (!src) {
          img.closest('.gen-image') && img.closest('.gen-image').classList.add('is-missing');
          return;
        }
        img.setAttribute('src', src);
        const holder = img.closest('.gen-image');
        if (holder) holder.classList.add('is-ready');
      });
    }));
  }

  /** 导出为可下载的文件名 */
  function fileName(id, ext) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return 'lynkllm-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + String(id).slice(-6) + '.' + (ext || 'png');
  }

  /** dataURL → 扩展名 */
  function extOf(dataUrl, mime) {
    const m = String(mime || (String(dataUrl || '').match(/^data:([^;,]+)/) || [])[1] || 'image/png');
    if (/jpeg|jpg/i.test(m)) return 'jpg';
    if (/webp/i.test(m)) return 'webp';
    if (/gif/i.test(m)) return 'gif';
    return 'png';
  }

  /** 补全文件扩展名（用户给的名字可能不带后缀） */
  function withExt(name, ext) {
    const n = String(name || '').trim();
    const safe = n.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    if (!safe) return '';
    return /\.(png|jpe?g|webp|gif|bmp)$/i.test(safe) ? safe : safe + '.' + ext;
  }

  /** 清空内存缓存（用于释放内存或模拟冷启动） */
  function dropCache() { cache.clear(); }

  /**
   * 触发下载
   * @param {string} id 图片 id
   * @param {string} [name] 自定义文件名（可不带扩展名）
   * @param {string} [mime]
   */
  function download(id, name, mime) {
    return get(id).then(dataUrl => {
      if (!dataUrl) {
        UI.Toast.error(I18N.t('imageMissing'));
        return false;
      }
      const ext = extOf(dataUrl, mime);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = withExt(name, ext) || fileName(id, ext);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
      return true;
    });
  }

  /** 兜底：把图片放到新标签页（部分浏览器对 dataURL 下载有限制时） */
  function openInTab(id) {
    return get(id).then(dataUrl => {
      if (!dataUrl) { UI.Toast.error(I18N.t('imageMissing')); return false; }
      const w = global.open();
      if (w) { w.document.write('<title>image</title><img src="' + dataUrl + '" style="max-width:100%">'); w.document.close(); }
      return true;
    });
  }

  global.ImageStore = {
    save, get, getCached, removeMany, clear, stats, list, hydrate, download, openInTab,
    extOf, withExt, fileName, dropCache,
    get available() { return available; },
    get cacheSize() { return cache.size; }
  };
})(window);
