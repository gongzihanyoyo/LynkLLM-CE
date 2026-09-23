/* ==========================================================================
   LynkLLM CE — 个性化外观
   --------------------------------------------------------------------------
   三件事：
   1. 半透明模糊（毛玻璃）：把开关与强度写成 html 上的两个属性 + CSS 变量。
      三档语义见下方 syncAttrs()；具体哪些元素生效由 styles.css 里
      `html[data-glass="on"] …`（只给半透明底）与 `html[data-fx="on"] …`（加模糊）决定；
   2. 主题色：把强调色派生为 --brand / --brand-hover / --brand-soft /
      --brand-text / --bg-active 五个变量（外加供玻璃底用的 --brand-rgb），
      深浅主题各用一套明暗补偿；
   3. 背景图片：体积可能很大（几 MB），因此存在 IndexedDB 而不是 localStorage，
      并保留内存缓存让首屏可以同步应用。

   设置项（fx / fxStrength / accent）本身很小，随其它设置一起存在 localStorage。
   ========================================================================== */
(function (global) {
  'use strict';

  const doc = global.document;

  const DB_NAME = 'lynkllm-ce-assets';
  const DB_VERSION = 1;
  const STORE = 'assets';
  const BG_ID = 'background';

  /** 内置主题色预设（第一个与默认 --brand 相同） */
  const ACCENTS = [
    '#4f6ef7', '#7c5cff', '#0ea5e9', '#06b6d4',
    '#10b981', '#84cc16', '#f59e0b', '#ef4444',
    '#ec4899', '#8b5cf6', '#64748b', '#0f766e'
  ];

  /** 默认强度：与 defaultSettings().fxStrength 保持一致 */
  const DEFAULT_STRENGTH = 45;
  /** 内置默认强调色（与 styles.css 的 --brand 一致），用于计算毛玻璃底色 */
  const DEFAULT_BRAND = '#4f6ef7';

  let dbPromise = null;
  let available = true;
  /** 背景图片的内存缓存（dataURL） */
  let bgCache = null;
  let bgLoaded = false;
  /**
   * 渲染用地址（Blob object URL）。**不能把 dataURL 直接塞进 CSS 变量**：
   * Chromium 对自定义属性的值有硬长度上限（实测 2,000,000 字符可以、
   * 4,000,000 字符就静默丢弃），而一张 1920px 的高细节壁纸 q0.86 编码后
   * base64 就可能到 2.7–4MB —— 结果是「背景图设了、也存住了，但页面上一片空白」。
   * object URL 只有几十个字符，彻底绕开这个限制。
   */
  let bgUrl = null;
  /** 当前生效的效果开关与强度 */
  const cur = { fx: true, fxStrength: DEFAULT_STRENGTH };

  /* ---------- IndexedDB：仅用于背景图片 ---------- */

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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { available = false; reject(req.error); };
      req.onblocked = () => { available = false; reject(new Error('blocked')); };
    }).catch(err => {
      console.warn('[personalize] IndexedDB 不可用，背景图片将只保留在当前会话：', err && err.message);
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
      console.warn('[personalize] 事务失败：', err && err.message);
      return null;
    });
  }

  function wrap(request) { return { __req: request }; }

  /* ---------- 颜色计算 ---------- */

  function parseHex(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function toHex(rgb) {
    return '#' + rgb.map(v => {
      const n = Math.max(0, Math.min(255, Math.round(v)));
      return n.toString(16).padStart(2, '0');
    }).join('');
  }

  /** 朝目标色插值：t 越大越接近 target */
  function mixToward(rgb, target, t) {
    return rgb.map((v, i) => v + (target[i] - v) * t);
  }

  const BLACK = [0, 0, 0];
  const WHITE = [255, 255, 255];

  function isDark() {
    return doc.documentElement.getAttribute('data-theme') === 'dark';
  }

  /** 由主题色派生整套强调色变量 */
  function applyAccent(accent) {
    const root = doc.documentElement;
    const keys = ['--brand', '--brand-hover', '--brand-soft', '--brand-text', '--bg-active', '--brand-rgb'];
    const custom = parseHex(accent);
    const rgb = custom || parseHex(DEFAULT_BRAND);
    const dark = isDark();

    // 毛玻璃的底色晕染始终设置（未自定义主题色时用内置色），保证模糊有可辨的层次
    root.style.setProperty('--fx-tint', 'rgba(' + rgb.join(', ') + ', ' + (dark ? 0.24 : 0.18) + ')');

    if (!custom) {
      // 空值 = 使用样式表里的内置默认色（--brand-rgb 在深浅主题下各有一套）
      keys.forEach(k => root.style.removeProperty(k));
      return;
    }
    const softA = dark ? 0.2 : 0.12;
    root.style.setProperty('--brand', toHex(rgb));
    root.style.setProperty('--brand-rgb', rgb.join(', '));   // 供毛玻璃品牌底色 --glass-brand 使用
    root.style.setProperty('--brand-hover', toHex(mixToward(rgb, dark ? WHITE : BLACK, dark ? 0.16 : 0.12)));
    root.style.setProperty('--brand-soft', 'rgba(' + rgb.join(', ') + ', ' + softA + ')');
    root.style.setProperty('--brand-text', toHex(mixToward(rgb, dark ? WHITE : BLACK, dark ? 0.32 : 0.2)));
    root.style.setProperty('--bg-active', 'rgba(' + rgb.join(', ') + ', ' + (dark ? 0.2 : 0.11) + ')');
  }

  /* ---------- 模糊效果 ---------- */

  /**
   * 强度 0-100 → 模糊半径 0-28px、玻璃层不透明度 .86-.50。
   * 强度越高：越模糊、背景越透。
   * 强度 0 时模糊为 0（半透明但完全不模糊），这是「半透明不模糊」这一档。
   */
  function fxValues(strength) {
    const s = Math.min(100, Math.max(0, Number(strength)));
    const v = isNaN(s) ? DEFAULT_STRENGTH : s;
    return {
      blur: Math.round(v * 0.28),
      alpha: Number((0.86 - v * 0.0036).toFixed(3))
    };
  }

  /**
   * 把状态写成 html 上的两个属性：
   *   data-fx    —— 是否需要 backdrop-filter（开关开启 **且** 强度大于 0）
   *   data-glass —— 面板 / 控件是否使用半透明底色（只跟开关有关）
   * 三档语义：
   *   开关关闭           → 全 off：完全不透明、无模糊（等价于原始外观）
   *   开关开启 + 强度 0   → glass=on / fx=off：半透明、无模糊
   *   开关开启 + 强度 > 0 → glass=on / fx=on：半透明 + 模糊
   */
  function syncAttrs() {
    const root = doc.documentElement;
    const on = cur.fx !== false;
    const v = fxValues(cur.fxStrength);
    const blurOn = on && v.blur > 0;
    root.setAttribute('data-fx', blurOn ? 'on' : 'off');
    root.setAttribute('data-glass', on ? 'on' : 'off');
    if (on) {
      root.style.setProperty('--fx-blur', v.blur + 'px');
      root.style.setProperty('--glass-a', String(v.alpha));
    } else {
      root.style.removeProperty('--fx-blur');
      root.style.removeProperty('--glass-a');
    }
  }

  /**
   * 应用模糊效果
   * @param {{fx?:boolean, fxStrength?:number}} settings 允许只给部分字段（滑块拖动预览）
   */
  function applyFx(settings) {
    const s = settings || {};
    if (s.fx !== undefined) cur.fx = s.fx !== false;
    if (s.fxStrength !== undefined) {
      const n = Number(s.fxStrength);
      cur.fxStrength = isNaN(n) ? DEFAULT_STRENGTH : n;
    }
    syncAttrs();
  }

  /* ---------- 背景图片 ---------- */

  /** dataURL → Blob（同步；避免 fetch(dataURL) 的异步涟漪） */
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('bad-data-url');
    const head = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mime = (head.match(/:(.*?)[;,]/) || [])[1] || 'image/*';
    if (!/;base64/i.test(head)) {
      return new Blob([decodeURIComponent(body)], { type: mime });
    }
    const bin = global.atob(body);
    const len = bin.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  /** 重建渲染地址：撤掉旧的 object URL，避免内存泄漏 */
  function syncBgUrl() {
    if (bgUrl) {
      try { global.URL.revokeObjectURL(bgUrl); } catch (e) { /* noop */ }
      bgUrl = null;
    }
    if (!bgCache) return;
    try {
      bgUrl = global.URL.createObjectURL(dataUrlToBlob(bgCache));
    } catch (e) {
      // 极端环境（无 Blob / URL）：退回 dataURL，但下面的守卫会如实报失败
      bgUrl = bgCache;
    }
  }

  function applyBackground() {
    const root = doc.documentElement;
    if (!bgCache) {
      root.style.removeProperty('--app-bg-image');
      root.removeAttribute('data-has-bg');
      syncAttrs();
      return;
    }
    if (!bgUrl) syncBgUrl();
    root.style.setProperty('--app-bg-image', 'url("' + bgUrl + '")');
    // 守卫：值太长时引擎会静默丢弃，这里必须自己确认，不能假设成功
    const written = root.style.getPropertyValue('--app-bg-image') !== '';
    if (written) root.setAttribute('data-has-bg', '1');
    else root.removeAttribute('data-has-bg');
    syncAttrs();
  }

  /**
   * 读取已保存的背景图片（默认只真正读一次盘）
   * @param {boolean} [force] 强制重新读取（另一个标签页改了背景图时用）
   */
  function loadBackground(force) {
    if (bgLoaded && !force) return Promise.resolve(bgCache);
    return tx('readonly', store => wrap(store.get(BG_ID))).then(rec => {
      bgLoaded = true;
      bgCache = (rec && rec.dataUrl) || null;
      syncBgUrl();
      applyBackground();
      return bgCache;
    });
  }

  /** 保存并应用背景图片（接受 dataURL；文件请先用 UI.fileToDataUrl 转换） */
  function setBackground(dataUrl) {
    if (!dataUrl) return Promise.resolve(false);
    bgCache = dataUrl;
    bgLoaded = true;
    syncBgUrl();
    applyBackground();
    return tx('readwrite', store => wrap(store.put({
      id: BG_ID,
      dataUrl,
      bytes: Math.round(dataUrl.length * 0.75),
      updatedAt: Date.now()
    }))).then(r => r !== null);
  }

  /** 移除已保存的背景图片（返回是否真的从本地存储移除成功） */
  function clearBackground() {
    bgCache = null;
    bgLoaded = true;
    syncBgUrl();
    applyBackground();
    return tx('readwrite', store => wrap(store.delete(BG_ID))).then(r => r !== null);
  }

  /**
   * 背景图当前的渲染状态（供设置页如实提示）
   * @returns {{has:boolean, url:string, usingFallback:boolean}}
   *   usingFallback=true 表示浏览器不支持 object URL，正在用 dataURL 直出
   *   （超长时可能渲染不出来）
   */
  function renderState() {
    return {
      has: !!bgCache,
      url: bgUrl || '',
      usingFallback: !!bgCache && bgUrl === bgCache
    };
  }

  /** 统计：{ count, bytes, available } —— 背景图片最多一条 */
  function stats() {
    return tx('readonly', store => wrap(store.getAll())).then(list => {
      if (!list) return { count: bgCache ? 1 : 0, bytes: 0, available };
      let bytes = 0;
      list.forEach(r => { bytes += Number(r.bytes) || 0; });
      return { count: list.length, bytes, available };
    });
  }

  /** 当前背景（同步，供导出使用） */
  function getBackground() { return bgCache; }

  function hasBackground() { return !!bgCache; }

  /* ---------- 统一入口 ---------- */

  /** 依据设置应用全部个性化项（主题色需在 data-theme 之后调用） */
  function apply(settings) {
    const st = settings || (global.Store ? Store.getSettings() : {});
    applyFx({ fx: st.fx, fxStrength: st.fxStrength });
    applyAccent(st.accent);
  }

  /** 关闭当前连接（与 ImageStore / AudioStore 同名的私有辅助，便于对照维护） */
  function closeDB() {
    return Promise.resolve(dbPromise).then(db => {
      try { if (db) db.close(); } catch (e) { /* noop */ }
      dbPromise = null;
    }).catch(() => { dbPromise = null; });
  }

  /** 清空（「清除所有本地数据」时调用） */
  function clear() {
    bgCache = null;
    bgLoaded = false;
    syncBgUrl();                    // 顺手撤掉 object URL，别留着占内存
    if (!global.indexedDB) return Promise.resolve(true);
    // 先关掉本页持有的连接：否则 deleteDatabase 会被自己阻塞，
    // 删除请求挂起期间写入的数据会在页面关闭时被一起抹掉。
    return closeDB().then(() => new Promise(resolve => {
      let req;
      try { req = global.indexedDB.deleteDatabase(DB_NAME); } catch (e) { resolve(false); return; }
      req.onsuccess = () => { dbPromise = null; applyBackground(); resolve(true); };
      req.onerror = () => { dbPromise = null; applyBackground(); resolve(false); };
      req.onblocked = () => { dbPromise = null; applyBackground(); resolve(false); };
    }));
  }

  global.Personalize = {
    ACCENTS,
    apply,
    stats,
    applyAccent,
    applyFx,
    fxValues,
    loadBackground,
    setBackground,
    clearBackground,
    getBackground,
    hasBackground,
    renderState,
    clear,
    get available() { return available; }
  };
})(window);
