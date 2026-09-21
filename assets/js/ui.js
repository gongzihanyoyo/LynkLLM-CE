/* ==========================================================================
   LynkLLM CE — UI 基础组件：Toast / Popover / 确认弹窗 / 图标 / 工具函数
   全部为页面内提示，不使用浏览器原生弹窗。
   ========================================================================== */
(function (global) {
  'use strict';

  const doc = global.document;

  /* ---------- DOM 小工具 ---------- */
  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      });
    }
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function debounce(fn, wait) {
    let t = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), wait || 200);
    };
  }

  function throttle(fn, wait) {
    let last = 0, timer = null, lastArgs = null;
    return function () {
      const now = Date.now(), ctx = this;
      lastArgs = arguments;
      if (now - last >= (wait || 100)) {
        last = now;
        fn.apply(ctx, lastArgs);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null; last = Date.now(); fn.apply(ctx, lastArgs);
        }, (wait || 100) - (now - last));
      }
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function copyText(text, opts) {
    opts = opts || {};
    const done = () => Toast.success(I18N.t('copiedToClipboard'));
    const fail = () => {
      // 降级：临时 textarea + execCommand
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        doc.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = doc.execCommand && doc.execCommand('copy');
        doc.body.removeChild(ta);
        if (ok) done(); else Toast.error(I18N.t('copyFailed'));
      } catch (e) {
        Toast.error(I18N.t('copyFailed'));
      }
    };
    if (global.navigator && navigator.clipboard && global.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else {
      fail();
    }
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('read error'));
      fr.readAsDataURL(file);
    });
  }

  /** 压缩图片，降低 token / 存储开销 */
  function compressImage(dataUrl, maxSide, quality) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const limit = maxSide || 1280;
        if (w <= limit && h <= limit) return resolve(dataUrl);
        const scale = Math.min(limit / w, limit / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        try {
          const cv = doc.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const out = cv.toDataURL('image/jpeg', quality || 0.85);
          resolve(out && out.length < dataUrl.length ? out : dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ---------- Toast ---------- */
  const Toast = (function () {
    const ICONS = {
      success: 'bi-check-circle-fill',
      error: 'bi-x-circle-fill',
      warning: 'bi-exclamation-triangle-fill',
      info: 'bi-info-circle-fill'
    };
    const MAX = 4;
    let layer = null;

    function ensure() {
      if (!layer) layer = $('#toastLayer');
      return layer;
    }

    function remove(node) {
      if (!node || node.__removing) return;
      node.__removing = true;
      node.classList.add('out');
      setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
    }

    function show(type, message, opts) {
      opts = opts || {};
      const L = ensure();
      if (!L) return { close() {} };
      const duration = opts.duration != null ? opts.duration : (type === 'error' ? 5200 : 2600);

      const body = el('div', { class: 't-body' });
      body.textContent = message;

      const closeBtn = el('button', { class: 't-close', type: 'button', 'aria-label': I18N.t('close') },
        [el('i', { class: 'bi bi-x-lg' })]);
      closeBtn.addEventListener('click', () => remove(node));

      const node = el('div', { class: 'toast ' + type, role: 'status' }, [
        el('i', { class: 'bi t-icon ' + (ICONS[type] || ICONS.info) }),
        body,
        opts.dismissible === false ? null : closeBtn
      ]);

      L.appendChild(node);

      // 限制同时显示数量
      const all = $$('.toast', L);
      if (all.length > MAX) all.slice(0, all.length - MAX).forEach(remove);

      let timer = null;
      if (duration > 0) {
        timer = setTimeout(() => remove(node), duration);
        node.addEventListener('mouseenter', () => { clearTimeout(timer); });
        node.addEventListener('mouseleave', () => { timer = setTimeout(() => remove(node), 1200); });
      }
      return { close: () => { clearTimeout(timer); remove(node); } };
    }

    return {
      show,
      success: (m, o) => show('success', m, o),
      error: (m, o) => show('error', m, o),
      warning: (m, o) => show('warning', m, o),
      info: (m, o) => show('info', m, o),
      clear() { const L = ensure(); if (L) clear(L); }
    };
  })();

  /* ---------- Popover ---------- */
  const Popover = (function () {
    let layer = null, current = null, anchor = null;
    const GAP = 8;

    function ensure() { if (!layer) layer = $('#popoverLayer'); return layer; }

    function close(opts) {
      if (!current) return;
      opts = opts || {};
      doc.removeEventListener('keydown', onKey, true);
      global.removeEventListener('resize', close);
      global.removeEventListener('scroll', onScroll, true);
      const node = current;
      current = null;
      const a = anchor;
      anchor = null;

      const teardown = () => {
        if (node && node.parentNode) node.parentNode.removeChild(node);
        // 只有当被关闭的节点仍是当前节点时才隐藏图层，
        // 否则会把紧接其后打开的新 popover 一并清掉
        if (current) return;
        const L = ensure();
        if (L) {
          L.hidden = true;
          L.removeEventListener('mousedown', onLayerDown);
        }
      };

      const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce || opts.instant) {
        teardown();
      } else {
        // 先播放退场动画，再真正移除节点
        node.classList.add('closing');
        setTimeout(teardown, 160);
      }

      if (a && a.classList) a.classList.remove('menu-open');
      if (typeof Popover.__onClose === 'function') {
        const cb = Popover.__onClose;
        Popover.__onClose = null;
        cb();
      }
    }

    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    function onScroll(e) { if (current && e.target !== current && !current.contains(e.target)) close(); }
    function onLayerDown(e) {
      if (current && (current.contains(e.target) || (anchor && anchor.contains(e.target)))) return;
      close();
    }

    /**
     * @param {HTMLElement} anchorEl
     * @param {HTMLElement} content
     * @param {object} opts { width, align: 'start'|'end'|'center', up, className }
     */
    function open(anchorEl, content, opts) {
      opts = opts || {};
      if (current) close();
      const L = ensure();
      if (!L) return;
      L.hidden = false;

      const pop = el('div', { class: 'popover' + (opts.className ? ' ' + opts.className : '') }, [content]);
      pop.setAttribute('role', 'dialog');
      L.appendChild(pop);
      // 清理上一轮退场动画残留的节点（如果有）
      Array.prototype.slice.call(L.querySelectorAll('.popover.closing')).forEach(function (old) {
        if (old !== pop && old.parentNode) old.parentNode.removeChild(old);
      });

      current = pop;
      anchor = anchorEl;
      if (anchorEl && anchorEl.classList) anchorEl.classList.add('menu-open');

      position(pop, anchorEl, opts);

      // 延迟挂载全局关闭监听，避免触发本次打开的同一次点击/按键立即关闭
      setTimeout(() => {
        if (!current) return;
        L.addEventListener('mousedown', onLayerDown);
        doc.addEventListener('keydown', onKey, true);
        global.addEventListener('resize', close);
        global.addEventListener('scroll', onScroll, true);
      }, 0);

      return pop;
    }

    function position(pop, anchorEl, opts) {
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const vw = doc.documentElement.clientWidth;
      const vh = doc.documentElement.clientHeight;
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;

      let left;
      if (opts.align === 'end') left = r.right - pw;
      else if (opts.align === 'center') left = r.left + r.width / 2 - pw / 2;
      else left = r.left;

      left = Math.max(8, Math.min(left, vw - pw - 8));

      // 优先向上弹出（输入区在底部）
      const spaceAbove = r.top;
      const spaceBelow = vh - r.bottom;
      let up = opts.up;
      if (up === undefined) up = spaceAbove > ph + GAP || spaceAbove > spaceBelow;

      let top;
      if (up) {
        top = r.top - ph - GAP;
        if (top < 8) { top = r.bottom + GAP; up = false; }
      } else {
        top = r.bottom + GAP;
        if (top + ph > vh - 8) { top = Math.max(8, vh - ph - 8); }
      }

      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      pop.style.visibility = 'visible';
      if (up) pop.classList.add('up');
    }

    return { open, close, isOpen: () => !!current, reposition: (o) => current && anchor && position(current, anchor, o || {}) };
  })();

  /* ---------- 确认弹窗 ---------- */
  const Confirm = (function () {
    let resolveFn = null;
    let root, titleEl, textEl, okBtn, cancelBtn, closeBtn, noAskWrap, noAskInput, noAskLabel;

    function init() {
      if (root) return;
      root = $('#confirmBackdrop');
      titleEl = $('#confirmTitle');
      textEl = $('#confirmText');
      okBtn = $('#confirmOk');
      cancelBtn = $('#confirmCancel');
      closeBtn = $('#confirmClose');
      noAskWrap = $('#confirmNoAskWrap');
      noAskInput = $('#confirmNoAsk');
      noAskLabel = $('#confirmNoAskLabel');

      okBtn.addEventListener('click', () => settle(true));
      cancelBtn.addEventListener('click', () => settle(false));
      closeBtn.addEventListener('click', () => settle(false));
      root.addEventListener('mousedown', e => { if (e.target === root) settle(false); });
      doc.addEventListener('keydown', e => {
        if (root.hidden) return;
        if (e.key === 'Escape') { e.stopPropagation(); settle(false); }
        else if (e.key === 'Enter') { e.stopPropagation(); settle(true); }
      });
    }

    function settle(v) {
      if (!root || root.hidden || root.classList.contains('closing')) return;
      const prefs = noAskWrap && !noAskWrap.hidden ? { key: noAskWrap.dataset.key, value: noAskInput.checked } : null;
      const fn = resolveFn;
      resolveFn = null;
      closeModal(root);
      if (fn) fn({ confirmed: v, noAsk: prefs });
    }

    /**
     * @returns {Promise<{confirmed:boolean, noAsk:object|null}>}
     */
    function ask(opts) {
      init();
      return new Promise(resolve => {
        resolveFn = resolve;
        titleEl.textContent = opts.title || I18N.t('confirmTitle');
        textEl.textContent = opts.text || '';
        okBtn.textContent = opts.okText || I18N.t('delete');
        cancelBtn.textContent = opts.cancelText || I18N.t('cancel');
        okBtn.className = 'btn ' + (opts.danger === false ? 'primary' : 'danger');

        if (opts.noAskKey) {
          noAskWrap.hidden = false;
          noAskWrap.dataset.key = opts.noAskKey;
          noAskInput.checked = false;
          noAskLabel.textContent = opts.noAskLabel || I18N.t('noAskAgain');
        } else {
          noAskWrap.hidden = true;
          delete noAskWrap.dataset.key;
        }

        // 始终挂到 body 末尾：确保确认弹窗盖在设置 / 模型编辑等弹窗之上
        doc.body.appendChild(root);
        root.hidden = false;
        root.classList.remove('closing');
        setTimeout(() => okBtn.focus(), 30);
        syncBodyScrollLock();
      });
    }

    return { ask };
  })();

  /* ---------- 主题 ---------- */
  const Theme = (function () {
    let media = null;

    function systemTheme() {
      try {
        if (!media && global.matchMedia) media = global.matchMedia('(prefers-color-scheme: dark)');
        return media && media.matches ? 'dark' : 'light';
      } catch (e) { return 'light'; }
    }

    function apply(setting) {
      const mode = setting || 'auto';
      const resolved = mode === 'auto' ? systemTheme() : mode;
      const root = doc.documentElement;
      root.setAttribute('data-theme', resolved);
      root.setAttribute('data-theme-mode', mode);
      const meta = doc.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f1115' : '#ffffff');
      if (global.MD && MD.setTheme) MD.setTheme();
      return resolved;
    }

    function watch(cb) {
      try {
        if (!media && global.matchMedia) media = global.matchMedia('(prefers-color-scheme: dark)');
        if (!media) return;
        const handler = () => {
          if (doc.documentElement.getAttribute('data-theme-mode') === 'auto') {
            apply('auto');
            if (cb) cb('auto');
          }
        };
        if (media.addEventListener) media.addEventListener('change', handler);
        else if (media.addListener) media.addListener(handler);
      } catch (e) { /* noop */ }
    }

    return { apply, watch, systemTheme, current: () => doc.documentElement.getAttribute('data-theme') };
  })();

  /* ---------- 模态框辅助 ---------- */
  const CLOSE_MS = 200;      // 与 CSS 中的退场动画时长保持一致
  const closeTimers = new WeakMap();

  function syncBodyScrollLock() {
    const anyOpen = ['#settingsBackdrop', '#confirmBackdrop', '#modelBackdrop', '#previewBackdrop'].some(sel => {
      const n = $(sel);
      return n && !n.hidden && !n.classList.contains('closing');
    });
    doc.body.style.overflow = anyOpen ? 'hidden' : '';
  }

  function openModal(node) {
    if (!node) return;
    // 若正在退场，取消并直接复用
    const t = closeTimers.get(node);
    if (t) { clearTimeout(t); closeTimers.delete(node); }
    node.classList.remove('closing');
    node.hidden = false;
    syncBodyScrollLock();
  }

  function closeModal(node, opts) {
    if (!node || node.hidden || node.classList.contains('closing')) return;
    opts = opts || {};
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const finish = () => {
      closeTimers.delete(node);
      node.hidden = true;
      node.classList.remove('closing');
      syncBodyScrollLock();
      if (typeof opts.onClosed === 'function') opts.onClosed();
    };

    if (reduce || opts.instant) { finish(); return; }

    node.classList.add('closing');
    syncBodyScrollLock();   // 已在退场的弹窗不再占用滚动锁
    closeTimers.set(node, setTimeout(finish, CLOSE_MS));
  }

  /** 立即关闭（跳过动画），用于页面卸载等场景 */
  function closeModalNow(node) {
    closeModal(node, { instant: true });
  }

  /* ---------- 图片预览（页面内 Lightbox，不使用原生弹窗） ---------- */
  const Lightbox = (function () {
    let box = null, imgEl = null, closeEl = null, dlEl = null;
    let bound = false;
    let lastFocus = null;
    let currentSrc = '';
    let currentId = '';
    let currentName = '';

    function ensure() {
      if (box) return box;
      box = $('#lightbox');
      imgEl = $('#lightboxImg');
      closeEl = $('#lightboxClose');
      dlEl = $('#lightboxDownload');
      if (!box) return null;
      box.addEventListener('click', ev => {
        // 点击遮罩或任意非图片区域关闭
        if (ev.target === box || ev.target === closeEl || (closeEl && closeEl.contains(ev.target))) {
          ev.preventDefault();
          close();
        }
      });
      if (closeEl) {
        closeEl.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); close(); }
        });
      }
      if (dlEl) {
        dlEl.addEventListener('click', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          downloadCurrent();
        });
      }
      return box;
    }

    /** 下载当前预览的图片：优先本地副本，否则退回链接下载 */
    function downloadCurrent() {
      if (currentId && global.ImageStore) {
        ImageStore.download(currentId, currentName);
        return;
      }
      if (!currentSrc) return;
      const a = doc.createElement('a');
      a.href = currentSrc;
      a.download = 'image.png';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      doc.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
    }

    /**
     * 打开预览
     * @param {string} src 图片地址
     * @param {string} [alt]
     * @param {object} [opts] { imageId, name } 本地图片时用于下载
     */
    function open(src, alt, opts) {
      if (!src) return false;
      if (!ensure()) return false;
      opts = opts || {};
      lastFocus = doc.activeElement;
      box.classList.remove('closing');
      currentSrc = src;
      currentId = opts.imageId || '';
      currentName = opts.name || '';
      if (imgEl) {
        imgEl.setAttribute('src', src);
        imgEl.setAttribute('alt', alt || '');
      }
      if (dlEl) dlEl.hidden = false;
      box.hidden = false;
      doc.body.classList.add('lb-open');
      openModal();
      if (closeEl && closeEl.focus) { try { closeEl.focus(); } catch (e) {} }
      return true;
    }

    function close() {
      if (!box || box.hidden || box.classList.contains('closing')) return;
      const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const finish = () => {
        box.hidden = true;
        box.classList.remove('closing');
        doc.body.classList.remove('lb-open');
        if (imgEl) imgEl.removeAttribute('src');
        currentSrc = '';
        currentId = '';
        currentName = '';
        closeModal();
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
        lastFocus = null;
      };
      if (reduce) { finish(); return; }
      box.classList.add('closing');
      setTimeout(finish, 190);
    }

    function isOpen() { return !!(box && !box.hidden); }

    /** 事件委托：任意 [data-zoom] 图片点击放大 */
    function bind() {
      if (bound) return;
      bound = true;
      ensure();
      doc.addEventListener('click', ev => {
        const t = ev.target;
        if (!t || t.nodeType !== 1) return;
        if (t.tagName !== 'IMG' || !t.hasAttribute('data-zoom')) return;
        const src = t.currentSrc || t.getAttribute('src');
        if (!src) return;
        ev.preventDefault();
        // 流式渲染过程中图片可能被重建，先取当前地址
        open(src, t.getAttribute('alt') || '', {
          imageId: t.getAttribute('data-image-id') || '',
          name: t.getAttribute('data-image-name') || ''
        });
      });
      doc.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && isOpen()) { ev.stopPropagation(); close(); }
      });
    }

    return { open, close, isOpen, bind, downloadCurrent };
  })();

  /* ==========================================================================
     HTML 代码块在线预览（沙箱 iframe + srcdoc）
     - iframe 不含 allow-same-origin，预览内容处于独立源，无法访问本应用的
       localStorage（其中保存着 API Key），同时仍可执行脚本、表单与弹窗。
     - 预览内脚本的报错通过 postMessage 回传，展示在弹窗底部。
     ========================================================================== */
  const HtmlPreview = (function () {
    let box = null, frame = null, errBox = null, errText = null;
    let lastFocus = null;
    let code = '';
    let messageBound = false;

    /* 注入到预览文档中的错误上报脚本 */
    const RUNTIME = [
      '(function(){',
      'function send(m){try{parent.postMessage({__lynkPreview:1,message:String(m)},"*");}catch(e){}}',
      'window.addEventListener("error",function(e){',
      'var t=e&&e.target&&e.target.tagName;',
      'if(t&&(t==="IMG"||t==="LINK"||t==="SCRIPT")){',
      'send("Failed to load "+t+": "+(e.target.src||e.target.href||""));return;}',
      'send((e&&e.message||"Unknown error")+(e&&e.lineno?(" (line "+e.lineno+")"):""));',
      '},true);',
      'window.addEventListener("unhandledrejection",function(e){',
      'var r=e&&e.reason;send("Unhandled rejection: "+((r&&r.message)||r));});',
      '})();'
    ].join('');

    const BASE_STYLE = '<style>' +
      'html{-webkit-text-size-adjust:100%}' +
      'body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,' +
      '"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;' +
      'color:#1f2328;background:#fff;word-break:break-word}' +
      'img,video,canvas,svg{max-width:100%}' +
      'a{color:#2f6fed}' +
      'table{border-collapse:collapse}td,th{padding:6px 10px;border:1px solid #dcdfe4}' +
      '<\/style>';

    /** 组装可预览的完整 HTML 文档 */
    function buildDoc(src) {
      const text = String(src == null ? '' : src);
      const head = '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<script>' + RUNTIME + '<\/script>';

      const isFull = /<!doctype\s+html|<html[\s>]/i.test(text);
      if (!isFull) {
        return '<!DOCTYPE html><html><head>' + head + BASE_STYLE + '</head><body>' +
          text + '</body></html>';
      }

      let doc = text;
      if (/<head[\s>]/i.test(doc)) {
        doc = doc.replace(/<head([^>]*)>/i, '<head$1>' + head);
      } else if (/<html[\s>]/i.test(doc)) {
        doc = doc.replace(/<html([^>]*)>/i, '<html$1><head>' + head + '</head>');
      } else {
        doc = head + doc;
      }
      return doc;
    }

    function ensure() {
      if (box) return box;
      box = $('#previewBackdrop');
      if (!box) return null;
      frame = $('#previewFrame');
      errBox = $('#previewError');
      errText = $('#previewErrorText');

      const closeBtn = $('#previewClose');
      const copyBtn = $('#previewCopy');
      const refreshBtn = $('#previewRefresh');
      if (closeBtn) closeBtn.addEventListener('click', close);
      if (copyBtn) copyBtn.addEventListener('click', () => copyText(code));
      if (refreshBtn) refreshBtn.addEventListener('click', render);
      box.addEventListener('mousedown', ev => { if (ev.target === box) close(); });

      doc.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && isOpen()) { ev.stopPropagation(); close(); }
      }, true);

      if (!messageBound) {
        messageBound = true;
        global.addEventListener('message', ev => {
          if (!isOpen() || !frame || ev.source !== frame.contentWindow) return;
          const d = ev.data;
          if (!d || typeof d !== 'object' || !d.__lynkPreview) return;
          showError(String(d.message || ''));
        });
      }
      return box;
    }

    function render() {
      if (!frame) return;
      hideError();
      try {
        frame.srcdoc = buildDoc(code);
      } catch (e) {
        showError((e && e.message) || String(e));
      }
    }

    function showError(msg) {
      if (!errBox) return;
      errBox.hidden = false;
      if (errText) errText.textContent = I18N.t('previewError') + ' ' + msg;
    }

    function hideError() {
      if (!errBox) return;
      errBox.hidden = true;
      if (errText) errText.textContent = '';
    }

    /** @param {string} src 代码块中的 HTML 源码 */
    function open(src) {
      if (!ensure()) return;
      code = String(src == null ? '' : src);
      lastFocus = doc.activeElement;
      box.classList.remove('closing');
      box.hidden = false;
      openModal(box);
      render();
      const closeBtn = $('#previewClose');
      if (closeBtn && closeBtn.focus) { try { closeBtn.focus(); } catch (e) { /* noop */ } }
    }

    function close() {
      if (!box || box.hidden || box.classList.contains('closing')) return;
      closeModal(box, {
        onClosed: () => {
          hideError();
          try { frame.removeAttribute('srcdoc'); } catch (e) { /* noop */ }
          code = '';
          if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* noop */ } }
          lastFocus = null;
        }
      });
    }

    function isOpen() { return !!(box && !box.hidden && !box.classList.contains('closing')); }

    return { open, close, isOpen, ensure };
  })();

  /* ---------- Token 估算 ---------- */
  /**
   * 粗略估算文本 token 数：ASCII 约 4 字符 1 token，其余字符（中日韩等）约 1 字符 1 token。
   * 仅用于本地提示，不参与实际请求。
   * @param {string} text
   * @returns {number}
   */
  function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    if (!s) return 0;
    let ascii = 0, other = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++;
      else other++;
    }
    return Math.ceil(ascii / 4) + other;
  }

  /* ---------- 滚动到底部按钮 ---------- */
  function setupScrollBottom(scroller, button) {
    if (!scroller || !button) return;
    const check = throttle(() => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      button.hidden = distance < 120;
    }, 120);
    scroller.addEventListener('scroll', check, { passive: true });
    button.addEventListener('click', () => smoothTo(scroller, scroller.scrollHeight));
    check();
    return { refresh: check };
  }

  function smoothTo(scroller, top) {
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !scroller.scrollTo) { scroller.scrollTop = top; return; }
    try {
      scroller.scrollTo({ top, behavior: 'smooth' });
    } catch (e) { scroller.scrollTop = top; }
  }

  /* ---------- 自动高度 textarea ---------- */
  function autoResize(ta, maxHeight) {
    ta.style.height = 'auto';
    const max = maxHeight || 220;
    const h = Math.min(ta.scrollHeight, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }

  global.UI = {
    $, $$, el, clear, debounce, throttle, escapeHtml, copyText, formatBytes,
    fileToDataUrl, compressImage, Toast, Popover, Confirm, Theme, Lightbox,
    HtmlPreview, estimateTokens,
    openModal, closeModal, closeModalNow, syncBodyScrollLock,
    setupScrollBottom, smoothTo, autoResize
  };
})(window);
