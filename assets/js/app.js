/* ==========================================================================
   LynkLLM CE — 应用入口：初始化、事件绑定、响应式
   ========================================================================== */
(function (global) {
  'use strict';

  const { $, $$, el, clear, Toast, Popover, Confirm } = UI;

  function T(k, ...a) { return global.I18N.t(k, ...a); }

  const App = {
    ready: false,
    generating: false,
    titleBusy: false
  };

  const SIDEBAR_BREAKPOINT = 860;

  /* ======================================================================
     初始化
     ====================================================================== */
  function init() {
    Store.init();

    const st = Store.getSettings();
    I18N.set(st.lang);
    UI.Theme.apply(st.theme);
    UI.Theme.watch();

    bindGlobal();
    Settings.bind();
    ConvList.bind();
    bindComposer();
    bindSidebar();
    UI.Lightbox.bind();

    applyI18nStatic();

    // 选择要打开的对话
    const activeId = Store.getActiveId();
    const convs = Store.getConversations().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (activeId) {
      Chat.convId = activeId;
    } else if (convs.length) {
      Chat.convId = convs[0].id;
      Store.setActiveId(Chat.convId);
    }

    ConvList.render();
    Chat.renderMessages();
    App.onConversationChanged();
    App.onModelChanged();
    App.updateComposerHint();
    updateConvSub();

    // 自动创建默认模型（首次使用）
    maybeSeedExample();

    // 隐藏启动动画
    const boot = $('#app-loading');
    const app = $('#app');
    if (app) app.hidden = false;
    if (boot) {
      boot.classList.add('hide');
      setTimeout(() => boot.remove(), 300);
    }

    App.ready = true;

    // 预热 Markdown 解析器
    if (global.MD) MD.ready.then(() => {});

    // 提示存储不可用
    if (!Store.storageAvailable) {
      setTimeout(() => Toast.warning(
        global.I18N.lang === 'en'
          ? 'localStorage is unavailable. Data will be lost on refresh.'
          : '当前浏览器 localStorage 不可用，数据在刷新后会丢失。',
        { duration: 8000 }
      ), 800);
    }
  }

  /** 首次运行时准备一个空白视图（不落盘，等用户发出第一条消息才成为正式对话） */
  function maybeSeedExample() {
    if (Store.getConversations().length) return;
    Chat.startNewChat();
  }

  /* ======================================================================
     全局事件
     ====================================================================== */
  function bindGlobal() {
    // 主题切换后重建 mermaid 配置
    // （Theme.apply 已调用 MD.setTheme）

    // 点击外部关闭侧栏
    const backdrop = $('#sidebarBackdrop');
    if (backdrop) backdrop.addEventListener('click', closeSidebar);

    // 键盘快捷键
    document.addEventListener('keydown', e => {
      // Esc 关闭弹层
      if (e.key === 'Escape') {
        if (Popover.isOpen()) { Popover.close(); return; }
      }
      // Ctrl/Cmd + K：聚焦搜索
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openSidebar();
        const s = $('#searchInput');
        if (s) { s.focus(); s.select(); }
        return;
      }
      // Ctrl/Cmd + Shift + O：新建对话
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        Chat.startNewChat();
        const ta0 = $('#input');
        if (ta0) ta0.focus();
        return;
      }
      // Ctrl/Cmd + B：切换侧栏
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        if (isMobile()) toggleSidebar();
        return;
      }
    });

    // 窗口尺寸变化
    global.addEventListener('resize', UI.debounce(() => {
      if (!isMobile()) closeSidebar();
      Popover.close();
    }, 150));

    // 关闭弹窗的通用处理
    document.addEventListener('visibilitychange', () => { /* reserved */ });
  }

  /* ======================================================================
     侧边栏
     ====================================================================== */
  function isMobile() {
    return document.documentElement.clientWidth <= SIDEBAR_BREAKPOINT;
  }

  let backdropTimer = null;

  function openSidebar() {
    const sb = $('#sidebar');
    const bd = $('#sidebarBackdrop');
    if (!sb) return;
    if (backdropTimer) { clearTimeout(backdropTimer); backdropTimer = null; }
    sb.classList.add('open');
    if (bd) {
      bd.classList.remove('closing');
      bd.hidden = false;
    }
  }

  function closeSidebar() {
    const sb = $('#sidebar');
    const bd = $('#sidebarBackdrop');
    if (!sb) return;
    sb.classList.remove('open');
    if (!bd || bd.hidden) return;
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { bd.hidden = true; return; }
    bd.classList.add('closing');
    if (backdropTimer) clearTimeout(backdropTimer);
    backdropTimer = setTimeout(() => {
      backdropTimer = null;
      bd.hidden = true;
      bd.classList.remove('closing');
    }, 180);
  }

  function toggleSidebar() {
    const sb = $('#sidebar');
    if (!sb) return;
    if (sb.classList.contains('open')) closeSidebar(); else openSidebar();
  }

  function bindSidebar() {
    const open = $('#btnSidebarOpen');
    const close = $('#btnSidebarToggle');
    if (open) open.addEventListener('click', openSidebar);
    if (close) close.addEventListener('click', closeSidebar);
    bindResizer();
  }

  App.closeSidebarOnMobile = function () { if (isMobile()) closeSidebar(); };

  /* ======================================================================
     侧栏宽度拖拽（仅桌面端）
     ====================================================================== */
  const RESIZER_MIN = 240;
  const RESIZER_MAX = 720;

  function sidebarLimits() {
    // 主区至少保留 380px，避免聊天区被挤没
    const avail = document.documentElement.clientWidth;
    const maxByView = Math.max(RESIZER_MIN + 40, avail - 380);
    return { min: RESIZER_MIN, max: Math.min(RESIZER_MAX, maxByView) };
  }

  function applySidebarWidth(px) {
    const { min, max } = sidebarLimits();
    const w = Math.round(Math.min(max, Math.max(min, px)));
    document.documentElement.style.setProperty('--sidebar-pref-w', w + 'px');
    document.documentElement.setAttribute('data-sidebar-fixed', '1');
    return w;
  }

  function clearSidebarWidth() {
    document.documentElement.style.removeProperty('--sidebar-pref-w');
    document.documentElement.removeAttribute('data-sidebar-fixed');
  }

  /** 恢复上次拖拽保存的宽度 */
  function restoreSidebarWidth() {
    const st = Store.getSettings();
    const saved = Number(st.sidebarWidth) || 0;
    if (saved > 0 && !isMobile()) applySidebarWidth(saved);
  }

  function bindResizer() {
    const bar = $('#sidebarResizer');
    const sidebar = $('#sidebar');
    if (!bar || !sidebar) return;

    let dragging = false;
    let startX = 0;
    let startW = 0;
    let lastW = 0;
    let rafId = 0;
    let pendingX = 0;

    function onMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      pendingX = x;
      if (rafId) return;
      rafId = global.requestAnimationFrame
        ? global.requestAnimationFrame(flush)
        : setTimeout(flush, 16);
    }

    function flush() {
      rafId = 0;
      if (!dragging) return;
      lastW = applySidebarWidth(startW + (pendingX - startX));
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      if (rafId) {
        (global.cancelAnimationFrame || clearTimeout)(rafId);
        rafId = 0;
      }
      // 持久化
      if (lastW) Store.saveSettings({ sidebarWidth: lastW });
      // 拖拽结束后重排滚动到底部按钮
      if (App.onConversationChanged) App.onConversationChanged();
    }

    function onDown(e) {
      if (isMobile()) return;
      // 只响应左键
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      lastW = Math.round(startW);
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      document.addEventListener('touchcancel', onUp);
      e.preventDefault();
    }

    bar.addEventListener('mousedown', onDown);
    bar.addEventListener('touchstart', onDown, { passive: false });

    // 双击复位为默认比例
    bar.addEventListener('dblclick', () => {
      clearSidebarWidth();
      Store.saveSettings({ sidebarWidth: 0 });
      Toast.info(T('sidebarWidthReset'));
      if (App.onConversationChanged) App.onConversationChanged();
    });

    // 键盘微调（可访问性）：左右箭头 ±16px，Home/End 到极值
    bar.addEventListener('keydown', e => {
      if (isMobile()) return;
      const cur = sidebar.getBoundingClientRect().width;
      const { min, max } = sidebarLimits();
      let next = null;
      if (e.key === 'ArrowLeft') next = cur - 16;
      else if (e.key === 'ArrowRight') next = cur + 16;
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next === null) return;
      e.preventDefault();
      const w = applySidebarWidth(next);
      Store.saveSettings({ sidebarWidth: w });
      if (App.onConversationChanged) App.onConversationChanged();
    });

    // 初次进入恢复宽度
    restoreSidebarWidth();

    // 窗口变化时重新夹取，避免侧栏吃掉整个视口
    global.addEventListener('resize', UI.debounce(() => {
      if (isMobile()) { clearSidebarWidth(); return; }
      const st = Store.getSettings();
      if (Number(st.sidebarWidth) > 0) applySidebarWidth(Number(st.sidebarWidth));
    }, 160));
  }

  /* ======================================================================
     输入区
     ====================================================================== */
  function bindComposer() {
    const ta = $('#input');
    const composer = $('#composer');
    const sendBtn = $('#btnSend');
    const stopBtn = $('#btnStop');
    const attachBtn = $('#btnAttach');
    const fileInput = $('#fileInput');
    const modelChip = $('#btnModel');
    const thinkChip = $('#btnThinking');

    if (ta) {
      ta.addEventListener('focus', () => composer && composer.classList.add('is-focus'));
      ta.addEventListener('blur', () => composer && composer.classList.remove('is-focus'));

      ta.addEventListener('input', () => {
        UI.autoResize(ta);
        Chat.updateCharCount();
        const draft = ta.value;
        const id = Chat.convId;
        if (id) UI.debounce(() => Store.setDraft(id, draft), 500)();
      });

      ta.addEventListener('keydown', e => {
        const st = Store.getSettings();
        const isEnter = e.key === 'Enter';
        if (!isEnter) return;

        // 输入法组合中不处理
        if (e.isComposing || e.keyCode === 229) return;

        const wantSend = st.enterBehavior === 'send';
        if (e.shiftKey) {
          // Shift+Enter 反向行为
          if (wantSend) return;               // 换行（默认行为）
          e.preventDefault();
          doSend();
          return;
        }
        // 无修饰键
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (wantSend) {
          e.preventDefault();
          doSend();
        }
        // 否则保持换行默认行为
      });

      ta.addEventListener('paste', e => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === 'file' && /^image\//.test(it.type)) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          Chat.handleFiles(files);
        }
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (stopBtn) stopBtn.addEventListener('click', () => Chat.stopGeneration());
    if (attachBtn) attachBtn.addEventListener('click', () => fileInput && fileInput.click());
    if (fileInput) {
      fileInput.addEventListener('change', e => {
        Chat.handleFiles(e.target.files);
        e.target.value = '';
      });
    }

    if (modelChip) modelChip.addEventListener('click', e => {
      e.stopPropagation();
      if (Popover.isOpen()) { Popover.close(); return; }
      Chat.openModelPicker(modelChip);
    });

    if (thinkChip) thinkChip.addEventListener('click', e => {
      e.stopPropagation();
      if (Popover.isOpen()) { Popover.close(); return; }
      Chat.openThinkingPicker(thinkChip);
    });

    const settingsBtn = $('#btnSettings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => {
      Settings.open('general');
      App.closeSidebarOnMobile();
    });

    // 拖拽上传
    bindDragDrop();

    // 滚动到底部按钮
    UI.setupScrollBottom($('#messages'), $('#btnScrollBottom'));
  }

  function doSend() {
    if (App.generating) return;
    Chat.send();
  }

  function bindDragDrop() {
    const main = $('#main');
    const composer = $('#composer');
    if (!main) return;
    let overlay = null;
    let depth = 0;

    const show = () => {
      if (overlay) return;
      overlay = el('div', { class: 'drop-overlay' }, [
        el('div', { class: 'drop-overlay-inner' }, [
          el('i', { class: 'bi bi-image' }),
          el('div', { text: global.I18N.lang === 'en' ? 'Drop images to attach' : '松开以添加图片' })
        ])
      ]);
      document.body.appendChild(overlay);
      if (composer) composer.classList.add('is-dragover');
    };
    const hide = () => {
      depth = 0;
      if (overlay) { overlay.remove(); overlay = null; }
      if (composer) composer.classList.remove('is-dragover');
    };

    main.addEventListener('dragenter', e => {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      depth++;
      show();
    });
    main.addEventListener('dragover', e => {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    main.addEventListener('dragleave', e => {
      depth--;
      if (depth <= 0) hide();
    });
    main.addEventListener('drop', e => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      hide();
      const files = e.dataTransfer.files;
      if (files && files.length) Chat.handleFiles(files);
    });
  }

  App.updateComposerHint = function () {
    const hint = $('#composerHint');
    if (!hint) return;
    const st = Store.getSettings();
    const enter = st.enterBehavior === 'send';
    const mainKey = enter
      ? (global.I18N.lang === 'en' ? 'Enter to send' : 'Enter 发送')
      : (global.I18N.lang === 'en' ? 'Enter for newline' : 'Enter 换行');
    const altKey = enter
      ? (global.I18N.lang === 'en' ? 'Shift+Enter for newline' : 'Shift+Enter 换行')
      : (global.I18N.lang === 'en' ? 'Shift+Enter to send' : 'Shift+Enter 发送');
    hint.className = 'composer-hint';
    hint.textContent = mainKey + ' · ' + altKey;
  };

  /* ======================================================================
     状态同步
     ====================================================================== */
  App.setGenerating = function (on) {
    App.generating = !!on;
    const sendBtn = $('#btnSend');
    const stopBtn = $('#btnStop');
    if (sendBtn) sendBtn.hidden = App.generating;
    if (stopBtn) stopBtn.hidden = !App.generating;
  };

  App.setTitleBusy = function (on) {
    App.titleBusy = !!on;
    const sub = $('#convSub');
    if (!sub) return;
    if (App.titleBusy) {
      sub.dataset.busy = '1';
      sub.textContent = T('titleSummarizing');
    } else {
      delete sub.dataset.busy;
      updateConvSub();
    }
  };

  function updateConvSub() {
    const sub = $('#convSub');
    if (!sub || sub.dataset.busy === '1') return;
    const conv = Chat.getConv();
    if (!conv) { sub.textContent = ''; return; }
    const model = Store.getModel(conv.modelId);
    const bits = [];
    if (model) bits.push(model.name);
    bits.push(I18N.formatTime(conv.updatedAt || conv.createdAt));
    if (conv.messages.length) bits.push(T('msgCount', conv.messages.length));
    sub.textContent = bits.join(' · ');
  }

  App.onConversationChanged = function () {
    const conv = Chat.getConv();
    const titleEl = $('#convTitle');
    if (titleEl) {
      const t = conv ? (conv.title || T('untitled')) : 'LynkLLM CE';
      titleEl.textContent = t;
      titleEl.title = t;
    }
    updateConvSub();
    ConvList.render();
    if (Chat.updateContextWarning) Chat.updateContextWarning();
  };

  App.onModelChanged = function () {
    const model = Chat.currentModel();
    const text = $('#modelChipText');
    const chip = $('#btnModel');
    if (text) text.textContent = model ? model.name : T('notConfigured');
    if (chip) chip.title = model ? (model.model + '  ·  ' + model.baseUrl) : T('addModelFirst');

    // 附件按钮
    const attach = $('#btnAttach');
    if (attach) attach.hidden = !(model && model.supportsImages);

    // 思考强度
    const thinkChip = $('#btnThinking');
    const thinkText = $('#thinkingChipText');
    const levels = (model && model.thinkingLevels) || [];
    if (thinkChip) thinkChip.hidden = !levels.length;
    if (thinkText && levels.length) {
      const cur = Chat.currentThinking() || levels[0];
      thinkText.textContent = T('thinking') + ' · ' + cur;
    }

    updateConvSub();
    // 换模型后上下文上限随之变化，重新评估用量提示
    if (Chat.updateContextWarning) Chat.updateContextWarning();
    if (Settings.openTab === 'models') Settings.renderModelList();
  };

  /** 语言切换后刷新所有静态与动态文本 */
  App.refreshI18n = function () {
    applyI18nStatic();
    Settings.syncGeneralUI();
    Settings.renderModelList();
    ConvList.render();
    Chat.renderMessages();
    Chat.renderAttachmentBar();
    App.onConversationChanged();
    App.onModelChanged();
    App.updateComposerHint();
    App.setTitleBusy(App.titleBusy);
    document.title = 'LynkLLM CE';
  };

  function applyI18nStatic() {
    $$('[data-i18n]').forEach(n => {
      if (n.closest('#settingsBackdrop')) return; // 设置面板单独处理
      n.textContent = T(n.dataset.i18n);
    });
    $$('[data-i18n-attr]').forEach(n => {
      const spec = n.dataset.i18nAttr || '';
      spec.split(',').forEach(pair => {
        const [attr, key] = pair.split(':');
        if (attr && key) n.setAttribute(attr.trim(), T(key.trim()));
      });
    });
    // 静态 aria-label / title
    const map = [
      ['#btnSidebarToggle', 'aria-label', 'close'],
      ['#btnSidebarOpen', 'aria-label', 'history'],
      ['#btnAttach', 'title', 'uploadImage'],
      ['#btnSend', 'title', 'send'],
      ['#btnSend', 'aria-label', 'send'],
      ['#btnStop', 'title', 'stop'],
      ['#btnStop', 'aria-label', 'stop'],
      ['#btnScrollBottom', 'aria-label', 'scrollBottom'],
      ['#btnClearSearch', 'aria-label', 'clearSearch'],
      ['#lightboxClose', 'aria-label', 'close']
    ];
    map.forEach(([sel, attr, key]) => {
      const n = $(sel);
      if (n) n.setAttribute(attr, T(key));
    });
    Settings.applyI18n($('#settingsBackdrop'));
    Settings.applyI18n($('#modelBackdrop'));
  }

  App.applyI18nStatic = applyI18nStatic;

  /* ======================================================================
     启动
     ====================================================================== */
  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  boot();
  global.App = App;
})(window);
