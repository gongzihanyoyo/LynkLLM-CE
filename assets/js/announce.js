/**
 * 官方公告（第 22 轮新增功能）
 *
 * 行为：
 *  · 打开页面时从 GitHub 拉一份 Markdown；失败则退到 jsDelivr 镜像；
 *    两个都失败 → **只在控制台打印**，界面上一声不吭（用户明确要求）。
 *  · 所有语言共用**同一份**内容（里面的多语言由维护者在公告里自行处理）。
 *  · 校验值与本地上次「不再提示」记录相同 → 不显示；不同 → 显示。
 *  · 内容按 Markdown + HTML 混排渲染（走 MD.toHtml，净化层已在里面）。
 *  · 内容长时**弹窗内部滚动**，弹窗本身不滚。
 *
 * ⚠️ 校验值用 FNV-1a + 字节长度，**不用 crypto.subtle**：
 *    后者只在安全上下文可用，而这个应用常被部署在 http://192.168.x.x 的局域网上，
 *    那里 crypto.subtle 是 undefined。公告校验不该因此失效。
 *
 * ⚠️ 为什么不用 UI.Confirm：它只有「确认 / 取消」两个语义，且按 Esc / 点遮罩
 *    都归到「取消」——那样会把「随手关掉」误记成「不再提示」，这条公告就再也不弹了。
 *    所以这里自建一个弹窗（复用同一套 .modal-* 样式），三个出口分别处理。
 */
(function (global) {
  'use strict';

  /* 官方源 + 镜像。顺序即优先级：先直连 GitHub，失败再走 CDN 镜像。 */
  const SOURCES = [
    'https://raw.githubusercontent.com/gongzihanyoyo/LynkLLM-CE/refs/heads/main/announcement/latest.md',
    'https://cdn.jsdmirror.com/gh/gongzihanyoyo/LynkLLM-CE@main/announcement/latest.md'
  ];

  /** 单源超时：公告不是关键路径，等太久没意义 */
  const TIMEOUT_MS = 8000;

  let showing = false;      // 防止重复弹（例如 boot 后又被别处调用）

  /** 字符串 → UTF-8 字节 */
  function utf8Bytes(str) {
    try { return new TextEncoder().encode(str); }
    catch (e) { return null; }
  }

  /**
   * 内容校验值：FNV-1a 32 位 + 字节长度。
   * 对「同一份公告 = 同一串字符」这个用途足够；长度一并带上，
   * 避免不同内容撞到同一个 32 位值却长度相同的极端情况。
   */
  function checksum(text) {
    const bytes = utf8Bytes(String(text || ''));
    if (!bytes) return '';
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      /* FNV 素数 16777619，用位移模拟 32 位乘法（避免浮点精度问题） */
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      h = h >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) + ':' + bytes.length.toString(16);
  }

  /** 拉一个源；带超时，非 2xx 视为失败 */
  function fetchOne(url) {
    const ctrl = global.AbortController ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* noop */ } }, TIMEOUT_MS) : null;
    const opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    return global.fetch(url, opts)
      .then(r => {
        if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
        return r.text();
      })
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /** 依次尝试各个源；全部失败则抛错（由调用方决定只打日志） */
  function fetchAnnouncement(i) {
    const idx = i || 0;
    if (idx >= SOURCES.length) return Promise.reject(new Error('all sources failed'));
    return fetchOne(SOURCES[idx]).catch(err => {
      console.warn('[announce] 源不可用：' + SOURCES[idx] + '（' + (err && err.message) + '）');
      return fetchAnnouncement(idx + 1);
    });
  }

  function mk(tag, cls, text) {
    const n = global.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 渲染并弹出 */
  function show(text) {
    if (showing) return;
    showing = true;

    const doc = global.document;
    const T = global.I18N.t.bind(global.I18N);

    const backdrop = mk('div', 'modal-backdrop');
    const modal = mk('div', 'modal modal-md');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'announceTitle');

    const head = mk('div', 'modal-head');
    const title = mk('h2', 'modal-title', T('announceTitle'));
    title.id = 'announceTitle';
    const closeBtn = mk('button', 'icon-btn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', T('a11yClose'));
    const closeIcon = mk('i', 'bi bi-x-lg');
    closeBtn.appendChild(closeIcon);
    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = mk('div', 'modal-body');
    /* 复用 .md-content 的排版规则；.announce-body 只负责「内部滚动」 */
    const content = mk('div', 'announce-body md-content');
    /* ⚠️ MD.toHtml 内部已过净化层（DOMPurify 白名单，允许 HTML 混排），
       所以这里用 innerHTML 是安全的；关闭状态下会退化成全转义文本。 */
    content.innerHTML = global.MD ? MD.toHtml(text) : '';
    body.appendChild(content);

    const foot = mk('div', 'modal-foot');
    const neverBtn = mk('button', 'btn', T('announceNever'));
    neverBtn.type = 'button';
    const okBtn = mk('button', 'btn primary', T('announceOk'));
    okBtn.type = 'button';
    foot.appendChild(neverBtn);
    foot.appendChild(okBtn);

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    backdrop.appendChild(modal);

    const close = (remember) => {
      if (remember) {
        try { global.Store.saveSettings({ announceSeen: checksum(text) }); } catch (e) { /* 存不下就算了 */ }
      }
      showing = false;
      doc.removeEventListener('keydown', onKey, true);
      if (global.UI && UI.closeModal) UI.closeModal(backdrop, { onClosed: () => backdrop.remove() });
      else backdrop.remove();
    };
    const onKey = (e) => {
      if (e && e.key === 'Escape') { e.stopPropagation(); close(false); }
    };

    closeBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(false));
    neverBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    doc.addEventListener('keydown', onKey, true);

    doc.body.appendChild(backdrop);
    if (global.UI && UI.openModal) UI.openModal(backdrop);
    setTimeout(() => { try { okBtn.focus(); } catch (e) { /* noop */ } }, 30);
  }

  /**
   * 入口：打开页面时调用一次。
   * 关闭开关时**连请求都不发**（省流量、也尊重用户选择）。
   */
  function maybeShow() {
    try {
      const st = global.Store.getSettings();
      if (!st.announceOn) return Promise.resolve('off');
      if (!global.UI || !global.MD || !global.I18N) return Promise.resolve('not-ready');
      const ready = (global.MD.ready && typeof MD.ready.then === 'function') ? MD.ready : Promise.resolve();
      return ready
        .then(() => fetchAnnouncement(0))
        .then(text => {
          if (!text || !String(text).trim()) return 'empty';
          const h = checksum(text);
          if (global.Store.getSettings().announceSeen === h) return 'seen';
          show(text);
          return 'shown';
        })
        .catch(err => {
          /* 需求：获取失败只在控制台打印，UI 静默 */
          console.warn('[announce] 获取公告失败：', (err && err.message) || err);
          return 'failed';
        });
    } catch (e) {
      console.warn('[announce] 初始化失败：', (e && e.message) || e);
      return Promise.resolve('error');
    }
  }

  global.Announce = {
    maybeShow: maybeShow,
    checksum: checksum,
    SOURCES: SOURCES.slice()
  };
})(window);
