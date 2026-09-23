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
    // 个性化：毛玻璃 / 主题色立即生效，背景图片从 IndexedDB 异步取回后再应用
    if (global.Personalize) {
      Personalize.apply(st);
      if (global.document) {
        global.document.documentElement.setAttribute('data-bg-rev', String(st.bgRev || 0));
      }
      Personalize.loadBackground();
    }

    bindGlobal();
    bindStorageSync();
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

    // 版本号（设置-常规底部）
    if (Settings.renderVersion) Settings.renderVersion();

    // PWA 快捷方式进入时的动作（?action=new / ?action=settings）
    handleLaunchAction();

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
     多标签页一致性
     --------------------------------------------------------------------------
     本应用的数据全在 localStorage。浏览器只在**其他**标签页写入时派发
     storage 事件，借它把外部改动手动反映到本页，避免出现
     "另一页明明改了模型 / 新建了对话，这一页还是旧的"。
     注意：
     - 正在生成时不动消息区，避免打断流式输出；
     - 不跟随 activeConversationId（每个标签页可以各自看不同的对话）；
     - 不理会 draft / confirmPrefs，否则会覆盖用户正在输入的内容。
     ====================================================================== */
  function bindStorageSync() {
    global.addEventListener('storage', e => {
      // e.key 为 null 表示对方调用了 clear()
      if (e.key && e.key.indexOf(Store.NS + '.') !== 0) return;
      if (e.key === Store.K.draft || e.key === Store.K.confirmPrefs) return;
      App.onExternalChange(e.key || '');
    });
  }

  /**
   * 另一个标签页改动了存储时的响应
   * @param {string} key 变化项（'' 表示整体被清空）
   */
  App.onExternalChange = function (key) {
    const all = !key;
    const settingsChanged = all || key === Store.K.settings;
    const modelSideChanged = all || key === Store.K.models || key === Store.K.tavily;
    const convsChanged = all || key === Store.K.conversations;

    if (settingsChanged) {
      const st = Store.getSettings();
      UI.Theme.apply(st.theme);
      I18N.set(st.lang);
      applyI18nStatic();
      App.updateComposerHint();
      if (global.Personalize) {
        Personalize.apply(st);
        // 背景图存在 IndexedDB，只能靠 bgRev 这个版本号判断是否需要重新读取
        const rev = String(st.bgRev || 0);
        const root = global.document.documentElement;
        if (root.getAttribute('data-bg-rev') !== rev) {
          root.setAttribute('data-bg-rev', rev);
          Personalize.loadBackground(true);
        }
      }
      if (global.Settings && Settings.syncGeneralUI) Settings.syncGeneralUI();
      if (global.Settings && Settings.syncPersonalizeUI) Settings.syncPersonalizeUI();
    }

    if (modelSideChanged) {
      // 模型列表与「联网搜索」chip 都依赖模型 / Tavily 配置
      App.onModelChanged();
    }

    if (convsChanged) {
      // 当前对话可能已被另一个标签页删除 → 回到新对话，避免指向不存在的记录
      if (Chat.convId && !Chat.pendingConv && !Store.getConversation(Chat.convId)) {
        Chat.startNewChat();
      }
      ConvList.render();
      if (!Chat.generating) Chat.renderMessages();
      App.onConversationChanged();
    } else if (modelSideChanged) {
      ConvList.render();   // 侧栏摘要里含模型名
    }
  };

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

    const countChip = $('#btnImageCount');
    if (countChip) countChip.addEventListener('click', e => {
      e.stopPropagation();
      if (Popover.isOpen()) { Popover.close(); return; }
      Chat.openImageCountPicker(countChip);
    });

    const sizeChip = $('#btnImageSize');
    if (sizeChip) sizeChip.addEventListener('click', e => {
      e.stopPropagation();
      if (Popover.isOpen()) { Popover.close(); return; }
      Chat.openImageSizePicker(sizeChip);
    });

    const searchChip = $('#btnWebSearch');
    if (searchChip) searchChip.addEventListener('click', e => {
      e.stopPropagation();
      if (Popover.isOpen()) { Popover.close(); return; }
      Chat.openWebSearchPicker(searchChip);
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
    // 模型的展示位置已移到每条 AI 回复下方，标题区不再重复显示
    const bits = [];
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
    // 切换对话后，输入框上的模型 / 思考强度 / 图片参数 / 联网搜索都要跟着换
    syncComposerForModel();
    if (Chat.updateContextWarning) Chat.updateContextWarning();
  };

  /**
   * 同步输入框上的模型相关控件（模型 chip、思考强度、图片参数、联网搜索）。
   * 与 Settings.renderModelList 分开，避免每次切换对话都重绘设置面板。
   */
  function syncComposerForModel() {
    const model = Chat.currentModel();
    const text = $('#modelChipText');
    const chip = $('#btnModel');
    if (text) text.textContent = model ? model.name : T('notConfigured');
    if (chip) chip.title = model ? (model.model + '  ·  ' + model.baseUrl) : T('addModelFirst');

    // 附件按钮（图片模型下用于图生图 / 图像编辑）
    const attach = $('#btnAttach');
    if (attach) attach.hidden = !(model && model.supportsImages);

    // 思考强度：图片 / 语音模型不适用，直接隐藏
    const isImage = !!(model && model.kind === 'image');
    const isTts = !!(model && model.kind === 'tts');
    const thinkChip = $('#btnThinking');
    const thinkText = $('#thinkingChipText');
    const levels = (model && model.thinkingLevels) || [];
    if (thinkChip) thinkChip.hidden = isImage || isTts || !levels.length;
    if (thinkText && levels.length) {
      const cur = Chat.currentThinking() || levels[0];
      thinkText.textContent = T('thinking') + ' · ' + cur;
    }

    // 图片生成：数量 / 分辨率
    const countChip = $('#btnImageCount');
    const sizeChip = $('#btnImageSize');
    if (countChip) countChip.hidden = !isImage;
    if (sizeChip) sizeChip.hidden = !isImage;
    if (isImage) {
      const countText = $('#imageCountChipText');
      if (countText) countText.textContent = T('genCountChip', Chat.currentImageCount());
      const sizeText = $('#imageSizeChipText');
      if (sizeText) sizeText.textContent = Chat.imageSizeLabel(Chat.currentImageSize());
      if (countChip) countChip.title = T('genCount');
      if (sizeChip) sizeChip.title = T('genSize');
    }

    // 联网搜索：仅当模型支持工具调用且已配置 Tavily Key 时出现
    const searchChip = $('#btnWebSearch');
    const canSearch = !!model && !isImage && !isTts && !!model.supportsTools && Chat.tavilyReady();
    if (searchChip) {
      searchChip.hidden = !canSearch;
      searchChip.title = T('webSearchDesc');
      searchChip.classList.toggle('off', canSearch && Chat.currentWebSearch() === 'off');
    }
    const searchText = $('#webSearchChipText');
    if (searchText && canSearch) {
      searchText.textContent = T('webSearch') + ' · '
        + (Chat.currentWebSearch() === 'off' ? T('webSearchOff') : T('webSearchAuto'));
    }

    // 输入框占位符随模型类型切换
    const ta = $('#input');
    if (ta) {
      const ph = isTts ? 'ttsInputPlaceholder'
        : (isImage ? 'imageInputPlaceholder' : 'inputPlaceholder');
      ta.setAttribute('placeholder', T(ph));
    }

    updateConvSub();
  }

  App.syncComposerForModel = syncComposerForModel;

  App.onModelChanged = function () {
    syncComposerForModel();
    // 换模型后上下文上限随之变化，重新评估用量提示
    if (Chat.updateContextWarning) Chat.updateContextWarning();
    if (Settings.openTab === 'models') Settings.renderModelList();
  };

  /** 语言切换后刷新所有静态与动态文本 */
  App.refreshI18n = function () {
    applyI18nStatic();
    Settings.syncGeneralUI();
    Settings.syncTavilyUI();
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
      ['#lightboxClose', 'aria-label', 'close'],
      ['#lightboxDownload', 'title', 'download'],
      ['#btnImageCount', 'title', 'genCount'],
      ['#btnImageSize', 'title', 'genSize'],
      ['#btnWebSearch', 'title', 'webSearchDesc']
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

  /* ======================================================================
     PWA：注册 Service Worker + 安装能力（全部相对路径，便于任意子目录部署）
     ====================================================================== */
  App.pwa = {
    installable: false,
    installed: false,
    swReady: false,
    prompt: null          // beforeinstallprompt 事件（仅当前会话有效）
  };

  function isStandalone() {
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      if (global.navigator.standalone === true) return true;   // iOS Safari
    } catch (e) { /* noop */ }
    return false;
  }

  function bindPwa() {
    App.pwa.installed = isStandalone();

    global.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();                 // 交给设置面板里的按钮触发
      App.pwa.prompt = e;
      App.pwa.installable = true;
      if (Settings.syncPwaUI) Settings.syncPwaUI();
    });

    global.addEventListener('appinstalled', () => {
      App.pwa.prompt = null;
      App.pwa.installable = false;
      App.pwa.installed = true;
      if (Settings.syncPwaUI) Settings.syncPwaUI();
      Toast.success(T('pwaInstalled'));
    });

    // 系统主题变化时同步 manifest 之外的浏览器 UI 颜色由 meta 控制，无需处理
  }

  /** 触发安装（由设置面板调用） */
  App.installPwa = function () {
    const p = App.pwa.prompt;
    if (!p) return Promise.resolve(false);
    p.prompt();
    return p.userChoice.then(choice => {
      App.pwa.prompt = null;
      App.pwa.installable = false;
      if (Settings.syncPwaUI) Settings.syncPwaUI();
      return !!(choice && choice.outcome === 'accepted');
    }).catch(() => false);
  };

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // 仅安全上下文可用（https / localhost / 127.0.0.1）
    const secure = global.isSecureContext
      || location.protocol === 'https:'
      || ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
    if (!secure) return;

    const ready = () => {
      let swUrl = 'sw.js';
      try { swUrl = new URL('sw.js', document.baseURI).href; } catch (e) { /* noop */ }
      navigator.serviceWorker.register(swUrl, { scope: './' }).then(() => {
        App.pwa.swReady = true;
        if (Settings.syncPwaUI) Settings.syncPwaUI();
      }).catch(err => {
        console.warn('[pwa] Service Worker 注册失败：', err && err.message);
      });
    };

    if (document.readyState === 'complete') ready();
    else global.addEventListener('load', ready);
  }

  /** 从 PWA 快捷方式进入时执行对应动作 */
  function handleLaunchAction() {
    let action = '';
    try { action = new URLSearchParams(location.search).get('action') || ''; } catch (e) { return; }
    if (!action) return;
    if (action === 'new') {
      Chat.startNewChat();
      ConvList.render();
      const ta = $('#input');
      if (ta) ta.focus();
    } else if (action === 'settings') {
      Settings.open('general');
    }
  }

  bindPwa();
  registerServiceWorker();
  boot();
  global.App = App;
})(window);
