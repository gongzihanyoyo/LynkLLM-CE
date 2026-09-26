/* ==========================================================================
   LynkLLM CE — 设置面板：常规 + 模型管理
   ========================================================================== */
(function (global) {
  'use strict';

  const { $, $$, el, clear, Toast, Popover, Confirm, copyText } = UI;

  const Settings = {
    openTab: 'general',
    kindFilter: 'all',   // all | chat | image —— 模型列表的子分类
    modelQuery: '',      // 模型列表的搜索关键词
    editing: null,       // 正在编辑的模型副本
    editingMcp: null     // 正在编辑的 MCP 服务器副本
  };

  function T(k, ...a) { return global.I18N.t(k, ...a); }

  /* ======================================================================
     打开 / 关闭 / Tab
     ====================================================================== */
  function open(tab) {
    const root = $('#settingsBackdrop');
    if (!root) return;
    const alreadyOpen = !root.hidden && !root.classList.contains('closing');
    Settings.openTab = tab || Settings.openTab || 'general';
    syncGeneralUI();
    syncTavilyUI();
    syncPersonalizeUI();
    renderModelList();
    renderMcpList();
    renderShortcutTable();
    switchTab(Settings.openTab, { animate: alreadyOpen });
    if (alreadyOpen) return;
    // 一次性把三个自建下拉的显示文字对齐到各自 <select> 的当前值
    // （代码里直接改 .value 不会触发 change，所以这里统一刷一遍）
    if (global.UI && UI.Select) UI.Select.refreshAll(root);
    UI.openModal(root);
    setTimeout(() => {
      const active = root.querySelector('.tab.active');
      if (active) active.focus();
    }, 40);
  }

  function close() {
    Popover.close();
    UI.closeModal($('#settingsBackdrop'));
  }

  /* ----------------------------------------------------------------------
     Tab 切换
     ----------------------------------------------------------------------
     切换时同时做两件事：
     1. 旧面板向左滑出、新面板从右滑入（反向切换时方向相反）；
     2. 弹窗高度从旧面板高度平滑过渡到新面板高度。
     实现要点：旧面板临时改成 position:absolute（脱离文档流，这样量到的高度
     只由新面板决定），把量出的高度写成 .tab-panels 的显式 height 并交给
     CSS transition 过渡；期间把 modal-body 的 flex 改成 0 1 auto，
     否则 flex:1 的 flex-basis:0% 会让 height 失效。
     ---------------------------------------------------------------------- */

  const TAB_ANIM_MS = 360;
  let tabAnim = null;
  let toolAnim = null;      // 「工具」子标签的高度过渡（与顶层 tab 的 tabAnim 各自独立）

  const TAB_ORDER = ['general', 'personalize', 'models', 'tools', 'shortcuts', 'about'];
  function tabIndex(name) {
    const i = TAB_ORDER.indexOf(name);
    return i < 0 ? 0 : i;
  }

  /* 每个工具子标签的 id；后续加工具在这里追加一项，
     并在 index.html 的 #toolTabs 里加按钮、加 .tool-panel 即可。 */
  const TOOL_TABS = ['tavily', 'mcp'];
  let curTool = 'tavily';

  /**
   * 顶层 tab 名的兼容映射。
   * 第 12 轮把 Tavily 从顶层 tab 移进了「工具」的子标签，
   * 但 Settings.open('tavily') 这个入口还在被别处调用（例如「+」菜单里的
   * 「需配置 Tavily Key」入口），所以老的 id 要能继续用 —— 统一归一到 tools。
   * 第 13 轮同理：Settings.open('mcp') 来自「+」菜单的 MCP 子菜单。
   */
  function normalizeTab(name) {
    if (name === 'tavily') return 'tools';
    if (name === 'mcp') return 'tools';
    return name;
  }

  /**
   * 切换「工具」里的子标签。
   *
   * 高度要平滑过渡（用户第 14 轮反馈：切 Tavily↔MCP 时弹窗高度是「跳」的）。
   * 复用顶层 tab 那套办法 —— 显式写 height 交给 CSS transition：
   *   ① 量旧高度并写死（同时临时把 flex 改成 0 1 auto，
   *      ⚠️ 否则 `.modal-body` 的 flex:1 = flex-basis:0% 会让 height 失效）；
   *   ② 换面板；
   *   ③ 量新高度、写回去，过渡由 `.tab-panels` 上的 transition 完成；
   *   ④ 动画结束后把显式值清掉，恢复自适应。
   * 动画期间加 `.is-animating` 隐藏那两根一闪而过的滚动条（同顶层 tab 的理由）。
   */
  function switchTool(name, opts) {
    if (TOOL_TABS.indexOf(name) < 0) return;
    const animate = !!(opts && opts.animate) && !reducedMotion();
    const panelsEl = $('#settingsBackdrop') && $('#settingsBackdrop').querySelector('.tab-panels');
    const root = $('#settingsBackdrop');
    curTool = name;

    const fromPanel = root ? root.querySelector('.tool-panel.active') : null;
    const toPanel = root ? root.querySelector('.tool-panel[data-tool-panel="' + name + '"]') : null;

    const applyTabs = () => {
      $$('#settingsBackdrop .subtab[data-tool]').forEach(b => {
        const on = b.dataset.tool === name;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $$('#settingsBackdrop .tool-panel').forEach(p => {
        p.classList.toggle('active', p.dataset.toolPanel === name);
      });
    };

    if (!animate || !panelsEl || !fromPanel || !toPanel || fromPanel === toPanel) {
      applyTabs();
      return;
    }

    runHeightTransition(panelsEl, applyTabs);
  }

  /**
   * 通用的「换内容 → 高度平滑过渡」包装。
   * @param {HTMLElement} el 高度由内容决定、且 CSS 上带 height transition 的容器
   * @param {Function} mutate 真正做 DOM 切换的动作
   */
  function runHeightTransition(el, mutate) {
    if (toolAnim) { toolAnim.cleanup(); toolAnim = null; }
    const h0 = el.offsetHeight;

    el.classList.add('is-animating');
    el.style.transition = 'none';
    el.style.flex = '0 1 auto';      // ⚠️ flex:1 时 height 不生效
    el.style.height = h0 + 'px';

    mutate();

    // 先放开高度量出目标值，再写回旧值 → 强制重排 → 恢复过渡 → 写新值
    el.style.height = 'auto';
    const h1 = el.offsetHeight;
    el.style.height = h0 + 'px';
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = h1 + 'px';

    const finish = () => {
      if (toolAnim) toolAnim.timer = null;
      el.style.transition = 'none';
      el.style.height = '';
      el.style.flex = '';
      el.classList.remove('is-animating');
      requestAnimationFrame(() => { el.style.transition = ''; });
      toolAnim = null;
    };
    const timer = setTimeout(finish, TAB_ANIM_MS + 60);
    toolAnim = { timer, cleanup: () => { clearTimeout(timer); finish(); } };
  }

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function setActiveTab(panels, target) {
    panels.forEach(p => p.classList.toggle('active', p === target));
  }

  function runTabTransition(panelsEl, from, to, panels) {
    if (tabAnim) { tabAnim.cleanup(); tabAnim = null; }

    const forward = tabIndex(to.dataset.panel) > tabIndex(from.dataset.panel);
    const h0 = panelsEl.offsetHeight;

    // 动画期间隐藏滚动条：高度过渡会让内容暂时高于视口、旧面板还会横向溢出，
    // 不处理的话切页瞬间会闪出纵向 + 横向两根滚动条（CSS 见 .tab-panels.is-animating）
    panelsEl.classList.add('is-animating');

    // 锁定当前高度 + 关掉过渡，避免这一帧就跳变
    panelsEl.style.transition = 'none';
    panelsEl.style.flex = '0 1 auto';
    panelsEl.style.height = h0 + 'px';

    from.classList.remove('active');
    from.classList.add('leaving');
    to.classList.add('active', 'entering');
    panels.forEach(p => { if (p !== from && p !== to) p.classList.remove('active'); });
    if (!forward) { from.classList.add('back'); to.classList.add('back'); }

    // 新面板已在正常流里：临时放开高度量出目标值
    panelsEl.style.height = 'auto';
    const h1 = panelsEl.offsetHeight;
    panelsEl.style.height = h0 + 'px';
    void panelsEl.offsetHeight;          // 强制重排，让 h0 真正生效
    panelsEl.style.transition = '';      // 恢复 CSS 里的 height 过渡（非线性缓动）
    panelsEl.style.height = h1 + 'px';

    const finish = () => {
      if (tabAnim) tabAnim.timer = null;
      panelsEl.style.transition = 'none';
      panelsEl.style.height = '';
      panelsEl.style.flex = '';
      from.classList.remove('leaving', 'back');
      to.classList.remove('entering', 'back');
      panelsEl.classList.remove('is-animating');
      requestAnimationFrame(() => { panelsEl.style.transition = ''; });
      tabAnim = null;
    };
    const timer = setTimeout(finish, TAB_ANIM_MS + 60);
    tabAnim = { timer, cleanup: () => { clearTimeout(timer); finish(); } };
  }

  /**
   * @param {string} name 目标面板
   * @param {{animate?:boolean}} [opts] animate=true 且弹窗已打开时才播放动画
   */
  function switchTab(name, opts) {
    const root = $('#settingsBackdrop');
    /* 老的 'tavily' / 'mcp' 入口归一成 'tools'（并选中对应子标签）。
       ⚠️ 这两个入口分别来自「+」菜单里的两个地方，别当死代码删掉。 */
    if (name === 'tavily' || name === 'mcp') curTool = name;
    name = normalizeTab(name);
    Settings.openTab = name;
    if (!root) return;

    const tabs = $$('#settingsBackdrop .tab');
    const panels = $$('#settingsBackdrop .tab-panel');
    tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // 标题始终为「设置」，不随标签页变化
    const title = $('#settingsTitle');
    if (title) title.textContent = T('settings');

    const panelsEl = root.querySelector('.tab-panels');
    const from = panels.find(p => p.classList.contains('active'));
    const to = panels.find(p => p.dataset.panel === name);
    if (!to) return;
    // 进入「工具」时同步子标签的显示
    if (name === 'tools') switchTool(curTool);
    if (from === to) return;

    if (global.UI && UI.Select) UI.Select.refreshAll(root);

    const animate = !!(opts && opts.animate) && !!panelsEl && !reducedMotion();
    if (!animate) { setActiveTab(panels, to); return; }
    runTabTransition(panelsEl, from, to, panels);
  }

  /* ======================================================================
     常规面板同步
     ====================================================================== */
  function syncGeneralUI() {
    const st = Store.getSettings();

    // 分段控件
    setSegmented('#segTheme', st.theme);
    setSegmented('#segEnter', st.enterBehavior);

    const sel = $('#selLang');
    if (sel) sel.value = st.lang;

    const batch = $('#selStreamBatch');
    if (batch) batch.value = String(st.streamRenderBatch);

    const sw = (id, v) => { const n = $(id); if (n) n.checked = !!v; };
    sw('#swRichRender', st.richRender);
    sw('#swShowTokens', st.showTokens);
    sw('#swStream', st.stream);

    renderAutoTitleUI(st);
    renderDataStats();
    renderVersion();
    syncPwaUI();

    // 静态文本 i18n
    applyI18n($('#settingsBackdrop'));
    // ⚠️ applyI18n 会把 [data-i18n] 的文本刷成字典里的静态默认值，
    // 油猴连接状态是**动态**文案，必须紧跟在它后面重新写一遍，
    // 否则每次打开设置都会把「已连接」显示成「未连接」。
    syncEnhancerUI();
  }

  /** 版本号（大版本.小版本.版本id） */
  function renderVersion() {
    const ver = $('#appVersion');
    if (ver) ver.textContent = 'v' + (Store.APP_VERSION || '—');
  }

  /** PWA 安装状态：可安装时显示按钮，已安装时显示状态 */
  function syncPwaUI() {
    const btn = $('#btnPwaInstall');
    const status = $('#pwaStatus');
    const desc = $('#pwaDesc');
    const pwa = (global.App && App.pwa) || {};
    const installed = !!pwa.installed;
    const canInstall = !!pwa.installable && !installed;

    if (btn) btn.hidden = !canInstall;
    if (status) {
      status.hidden = canInstall;
      status.textContent = installed ? T('pwaInstalled') : T('pwaUnavailable');
      status.classList.toggle('ok', installed);
    }
    if (desc) {
      desc.textContent = installed ? T('pwaInstalled')
        : (canInstall ? T('pwaDesc') : T('pwaUnavailable'));
    }
  }

  /**
   * 「自动对话标题」合并控件：
   *   first  — 直接取第一条用户消息
   *   chat   — 用当前对话所选模型总结
   *   model  — 用指定模型总结
   */
  function renderAutoTitleUI(st) {
    const sel = $('#selAutoTitle');
    if (sel) {
      const mode = autoTitleMode(st);
      sel.value = mode;
      syncTitleModelRow(mode);
    }
    renderTitleModelSelect(st);
  }

  function autoTitleMode(st) {
    const m = st.autoTitleMode;
    if (m === 'first' || m === 'chat' || m === 'model') return m;
    // 兼容旧版本数据：autoTitle=false 等价于「第一条消息」
    return st.autoTitle === false ? 'first' : 'chat';
  }

  function syncTitleModelRow(mode) {
    const row = $('#rowTitleModel');
    if (row) row.hidden = mode !== 'model';
  }

  function setSegmented(sel, value) {
    const root = $(sel);
    if (!root) return;
    $$('button', root).forEach(b => b.classList.toggle('active', b.dataset.value === value));
    root.dataset.value = value;
  }

  function renderTitleModelSelect(st) {
    const sel = $('#selTitleModel');
    if (!sel) return;
    clear(sel);
    // 标题总结只支持对话模型
    const models = Store.getModels().filter(m => m.kind !== 'image');
    models.forEach(m => {
      sel.appendChild(el('option', { value: m.id, text: m.name + ' · ' + (m.model || '') }));
    });
    if (!models.length) {
      sel.appendChild(el('option', { value: '', text: T('noModels') }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    if (st.titleModelId && Store.getModel(st.titleModelId)) sel.value = st.titleModelId;
    else sel.value = models[0].id;
    // 选项是动态生成的，填完要同步自建下拉的显示文字（UI.Select 见 ui.js）
    if (global.UI && UI.Select) UI.Select.refresh(sel);
  }

  function renderDataStats() {
    const box = $('#dataStats');
    if (!box) return;
    const s = Store.stats();
    clear(box);
    const mk = (v, label) => el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-val', text: String(v) }),
      el('div', { class: 'stat-label', text: label })
    ]);
    box.appendChild(mk(s.conversations, T('statConversations')));
    box.appendChild(mk(s.messages, T('statMessages')));
    box.appendChild(mk(s.models, T('statModels')));
    // MCP 服务器数：与模型数同级（都在 localStorage 里）
    box.appendChild(mk(s.mcpServers || 0, T('statMcp')));
    box.appendChild(mk(UI.formatBytes(s.bytes), T('storageUsage')));

    // 生成图片 / 合成语音分别存在各自的 IndexedDB 库中，体积异步统计
    const idbCard = (labelKey, store) => {
      const card = mk('—', T(labelKey));
      box.appendChild(card);
      if (!store) return;
      store.stats().then(st => {
        if (!card.parentNode) return;
        card.firstChild.textContent = String(st.count);
        card.lastChild.textContent = T(labelKey) + (st.bytes ? ' · ' + UI.formatBytes(st.bytes) : '');
        card.title = st.available ? '' : 'IndexedDB unavailable';
      }).catch(() => {});
    };
    idbCard('statImages', global.ImageStore);
    idbCard('statAudios', global.AudioStore);
    // 背景图片存在 Personalize 自己的库里，容易漏统计
    idbCard('statBackground', global.Personalize);

    if (!Store.storageAvailable) {
      box.appendChild(el('div', { class: 'stat-card', style: { gridColumn: '1 / -1', borderColor: 'var(--warning)' } }, [
        el('div', { class: 'stat-label', style: { color: 'var(--warning)' }, text: 'localStorage unavailable — memory only' })
      ]));
    }
  }

  /* ======================================================================
     个性化（毛玻璃 / 背景图片 / 主题色）
     ====================================================================== */
  /* ======================================================================
     油猴脚本增强（可选）
     ====================================================================== */

  /** 渲染「安装油猴」的下拉菜单（4 个扩展商店入口） */
  function renderTmMenu() {
    const menu = $('#ddInstallTmMenu');
    if (!menu || !global.Enhancer) return;
    clear(menu);
    Enhancer.TM_LINKS.forEach(item => {
      const a = el('a', {
        class: 'dropdown-item', href: item.url, target: '_blank', rel: 'noopener noreferrer'
      }, [
        el('i', { class: 'bi bi-box-arrow-up-right' }),
        el('span', { text: item.label })
      ]);
      menu.appendChild(a);
    });
  }

  function toggleTmMenu(force) {
    const menu = $('#ddInstallTmMenu');
    const btn = $('#btnInstallTm');
    if (!menu || !btn) return;
    const show = force != null ? force : menu.hidden;
    menu.hidden = !show;
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  /** 把连接状态写到设置页的指示灯上 */
  function syncEnhancerUI() {
    const pill = $('#enhancerStatus');
    const text = $('#enhancerStatusText');
    if (!pill || !text) return;
    const st = global.Enhancer ? Enhancer.getState() : 'off';
    const map = {
      connected: ['on', T('usConnected')],
      connecting: ['waiting', T('usConnecting')],
      declined: ['declined', T('usDeclined')],
      off: ['off', T('usDisconnected')]
    };
    const hit = map[st] || map.off;
    pill.dataset.state = hit[0];
    text.textContent = hit[1];
    const ver = global.Enhancer && Enhancer.getScriptVersion();
    const hint = $('#enhancerHint');
    if (hint) hint.textContent = (st === 'connected' && ver) ? ('v' + ver) : '';
    // 开关行上的提示也要跟着变（开着重连上/断开时）
    applyCorsBypassUI();
  }

  function bindEnhancerUI() {
    renderTmMenu();

    const btnTm = $('#btnInstallTm');
    if (btnTm) {
      btnTm.addEventListener('click', e => {
        e.stopPropagation();
        toggleTmMenu();
      });
    }
    // 点空白处收起下拉
    global.document.addEventListener('click', () => toggleTmMenu(false));

    const btnScript = $('#btnInstallScript');
    if (btnScript) {
      btnScript.addEventListener('click', () => {
        if (!global.Enhancer) return;
        /* ⚠️ 顺序很重要：**先复制、再开新标签页**。
           反过来会出现「返回页面后弹『复制失败，请手动选择文本』」：
           global.open() 把焦点移走，之后的 navigator.clipboard.writeText()
           会因为文档失去焦点抛 NotAllowedError（降级用的 execCommand 同样失败），
           于是复制Text 的失败分支报了错 —— 而这次复制只是给私有部署用户的
           附带便利，失败不该打扰主流程。所以：先复制（此时仍有焦点），
           并且用 silent 模式，失败就安静跳过。 */
        const local = Enhancer.scriptUrl();
        if (local) UI.copyText(local, { silent: true });
        // 直接打开脚本的安装链接（Tampermonkey 会接管并弹出安装页）
        global.open(Enhancer.INSTALL_URL, '_blank', 'noopener');
      });
    }

    const swCors = $('#mfCorsBypass');
    if (swCors) swCors.addEventListener('change', applyCorsBypassUI);

    if (global.Enhancer) {
      Enhancer.onChange(syncEnhancerUI);
      Enhancer.connect();          // 打开设置页时主动尝试握手
    }
    syncEnhancerUI();
  }

  function syncPersonalizeUI() {
    const st = Store.getSettings();
    const sw = $('#swFx');
    if (sw) sw.checked = st.fx !== false;

    const rng = $('#rngFxStrength');
    if (rng) rng.value = String(st.fxStrength);
    const val = $('#fxStrengthVal');
    if (val) val.textContent = String(st.fxStrength);

    const row = $('#rowFxStrength');
    if (row) row.classList.toggle('is-disabled', st.fx === false);

    const bgRng = $('#rngBgBlur');
    if (bgRng) bgRng.value = String(st.bgBlur || 0);
    const bgVal = $('#bgBlurVal');
    if (bgVal) bgVal.textContent = String(st.bgBlur || 0);
    // 没选背景图时「背景模糊」无从谈起，置灰
    const bgRow = $('#rowBgBlur');
    if (bgRow) bgRow.classList.toggle('is-disabled', !(global.Personalize && Personalize.hasBackground()));

    renderAccentPresets(st.accent);
    const color = $('#accentColor');
    if (color) color.value = st.accent || (global.Personalize ? Personalize.ACCENTS[0] : '#4f6ef7');

    renderBgPreview();
  }

  /** 主题色预设色块 */
  function renderAccentPresets(current) {
    const box = $('#accentPresets');
    if (!box) return;
    clear(box);
    const list = (global.Personalize ? Personalize.ACCENTS : []);
    const cur = String(current || '').toLowerCase();
    list.forEach(hex => {
      const btn = el('button', {
        class: 'accent-chip' + (hex.toLowerCase() === cur ? ' active' : ''),
        type: 'button',
        title: hex,
        dataset: { accent: hex }
      }, [el('i', { class: 'bi bi-check2' })]);
      // 自定义属性必须用 setProperty（Object.assign 到 style 上不会生效）
      btn.style.setProperty('--chip', hex);
      btn.addEventListener('click', () => saveAccent(hex));
      box.appendChild(btn);
    });
    // 「默认」项：清空自定义色，回到内置配色
    const def = el('button', {
      class: 'accent-chip accent-default' + (cur ? '' : ' active'),
      type: 'button',
      title: T('accentDefault'),
      dataset: { accent: '' }
    }, [el('i', { class: 'bi bi-slash-circle' })]);
    def.addEventListener('click', () => saveAccent(''));
    box.appendChild(def);
  }

  function saveAccent(hex) {
    Store.saveSettings({ accent: hex || '' });
    const st = Store.getSettings();
    if (global.Personalize) Personalize.applyAccent(st.accent);
    renderAccentPresets(st.accent);
    const color = $('#accentColor');
    if (color && st.accent) color.value = st.accent;
  }

  function renderBgPreview() {
    const box = $('#bgPreview');
    const img = $('#bgPreviewImg');
    const meta = $('#bgPreviewMeta');
    const clearBtn = $('#btnBgClear');
    const url = global.Personalize ? Personalize.getBackground() : null;
    if (clearBtn) clearBtn.hidden = !url;
    // 没有背景图时「背景模糊」没有作用对象，置灰
    const blurRow = $('#rowBgBlur');
    if (blurRow) blurRow.classList.toggle('is-disabled', !url);
    if (!box) return;
    if (!url) { box.hidden = true; if (img) img.removeAttribute('src'); return; }
    box.hidden = false;
    if (img) img.setAttribute('src', url);
    if (meta) meta.textContent = url.slice(0, 5) + '… · ' + UI.formatBytes(Math.round(url.length * 0.75));
  }

  function pickBackground(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { Toast.error(T('bgPickFailed')); return; }
    Toast.info(T('bgLoading'));
    UI.fileToDataUrl(file)
      .then(dataUrl => UI.compressImage(dataUrl, 1920, 0.86))
      .then(dataUrl => (global.Personalize ? Personalize.setBackground(dataUrl) : false))
      .then(persisted => {
        renderBgPreview();
        if (persisted) {
          // 落盘成功才通知其它标签页重新读取（否则它们读了也是空的）
          Store.saveSettings({ bgRev: Date.now() });
          Toast.success(T('bgApplied'));
        } else {
          // 本次会话内仍然可见，但刷新后会丢 —— 如实告知，别让用户以为已经存住了
          Toast.warning(T('bgNotSaved'), { duration: 9000 });
        }
      })
      .catch(() => Toast.error(T('bgPickFailed')));
  }

  function clearBackground() {
    if (!global.Personalize) return;
    Personalize.clearBackground().then(ok => {
      Store.saveSettings({ bgRev: Date.now() });
      renderBgPreview();
      if (ok === false) Toast.warning(T('bgClearFailed'), { duration: 7000 });
      else Toast.success(T('bgCleared'));
    });
  }

  function applyI18n(root) {
    $$('[data-i18n]', root).forEach(n => { n.textContent = T(n.dataset.i18n); });
    $$('[data-i18n-attr]', root).forEach(n => {
      const spec = n.dataset.i18nAttr || '';
      spec.split(',').forEach(pair => {
        const [attr, key] = pair.split(':');
        if (attr && key) n.setAttribute(attr.trim(), T(key.trim()));
      });
    });
  }

  /* ======================================================================
     Tavily 联网搜索
     ====================================================================== */
  function syncTavilyUI() {
    const t = Store.getTavily();
    const input = $('#tavilyKey');
    if (input && document.activeElement !== input) input.value = t.apiKey || '';
    renderTavilyManual();
    renderVersion();
  }

  /* ---------- Tavily 搜索参数 ---------- */

  /**
   * 某一项的取值范围（显示在配置区里，替代原先独立的「可用参数」清单）
   * @param {object} f schema 项
   */
  function tavilyRange(f) {
    if (!f) return '';
    if (f.type === 'enum') return (f.options || []).join(' | ');
    if (f.type === 'int') return f.min + ' – ' + f.max;
    if (f.type === 'bool') return 'true | false';
    if (f.type === 'list') return T('tavilyRangeList');
    if (f.type === 'date') return 'YYYY-MM-DD';
    return T('tavilyRangeText');
  }

  /** 依据 schema 渲染「搜索参数」表单（空值 = 交给模型决定） */
  function renderTavilyManual() {
    const box = $('#tavilyManual');
    if (!box) return;
    clear(box);
    const cur = Store.getTavily().params;
    const schema = Store.TAVILY_PARAM_SCHEMA || [];

    schema.forEach(f => {
      const v = cur[f.key];
      const isSet = !(v === '' || v == null || (Array.isArray(v) && !v.length));

      const row = el('div', { class: 'tm-row' + (isSet ? ' is-set' : '') });
      row.appendChild(el('label', { class: 'tm-label', for: 'tmp_' + f.key }, [
        el('span', { class: 'tm-key mono', text: f.key }),
        el('span', { class: 'tm-range', text: tavilyRange(f) })
      ]));

      const ctrl = el('div', { class: 'tm-ctrl' });

      if (f.type === 'enum') {
        const wrap = el('div', { class: 'select-wrap' });
        const sel = el('select', { class: 'select', id: 'tmp_' + f.key, dataset: { tkey: f.key } });
        sel.appendChild(el('option', { value: '', text: T('tavilyAuto') }));
        f.options.forEach(o => sel.appendChild(el('option', { value: o, text: o })));
        sel.value = v || '';
        sel.addEventListener('change', saveTavilyParams);
        wrap.appendChild(sel);
        wrap.appendChild(el('i', { class: 'bi bi-chevron-down' }));
        ctrl.appendChild(wrap);
      } else if (f.type === 'bool') {
        const wrap = el('div', { class: 'select-wrap' });
        const sel = el('select', { class: 'select', id: 'tmp_' + f.key, dataset: { tkey: f.key } });
        sel.appendChild(el('option', { value: '', text: T('tavilyAuto') }));
        sel.appendChild(el('option', { value: 'true', text: T('tavilyOn') }));
        sel.appendChild(el('option', { value: 'false', text: T('tavilyOff') }));
        sel.value = (v === true) ? 'true' : ((v === false) ? 'false' : '');
        sel.addEventListener('change', saveTavilyParams);
        wrap.appendChild(sel);
        wrap.appendChild(el('i', { class: 'bi bi-chevron-down' }));
        ctrl.appendChild(wrap);
      } else {
        const isList = f.type === 'list';
        const input = el('input', {
          class: 'input mono',
          id: 'tmp_' + f.key,
          type: f.type === 'int' ? 'number' : 'text',
          placeholder: f.placeholder || '',
          dataset: { tkey: f.key },
          autocomplete: 'off',
          spellcheck: 'false'
        });
        if (f.type === 'int') {
          input.setAttribute('min', String(f.min));
          input.setAttribute('max', String(f.max));
        }
        input.value = isList ? (v || []).join(', ') : (v == null ? '' : v);
        input.addEventListener('change', saveTavilyParams);
        ctrl.appendChild(input);
      }

      row.appendChild(ctrl);
      box.appendChild(row);
    });

    /* 这些下拉是**每次渲染时动态创建**的，初始化时的 UI.Select.enhance() 覆盖不到，
       所以这里补一次（enhance 是幂等的，重复调用无副作用）。 */
    if (global.UI && UI.Select) UI.Select.enhance(box);
  }

  /** 把「搜索参数」表单写回存储 */
  function saveTavilyParams() {
    const box = $('#tavilyManual');
    if (!box) return;
    const raw = {};
    $$('[data-tkey]', box).forEach(node => {
      const key = node.dataset.tkey;
      const field = (Store.TAVILY_PARAM_SCHEMA || []).find(f => f.key === key);
      if (!field) return;
      if (field.type === 'list') {
        raw[key] = String(node.value || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      } else if (field.type === 'int') {
        raw[key] = node.value === '' ? '' : Number(node.value);
      } else {
        raw[key] = node.value;
      }
    });
    Store.saveTavily({ params: raw });
    renderTavilyManual();
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  function resetTavilyParams() {
    Store.saveTavily({ params: null });
    renderTavilyManual();
    if (global.App && App.onModelChanged) App.onModelChanged();
    Toast.success(T('tavilyParamsCleared'));
  }

  /** Tavily 面板里所有输入的可编辑状态 */
  function setTavilyEditable(on) {
    ['#tavilyKey', '#btnTavilySave', '#btnTavilyResetParams'].forEach(sel => {
      const n = $(sel);
      if (n) n.disabled = !on;
    });
    const box = $('#tavilyManual');
    $$('[data-tkey]', box || document).forEach(n => { n.disabled = !on; });
    // 原生控件被置灰后，自建下拉的按钮也要跟着置灰（它才是用户点得到的那个）
    if (box && global.UI && UI.Select) UI.Select.refreshAll(box);
  }

  function showTavilyResult(type, title, body) {
    const box = $('#tavilyResult');
    if (!box) return;
    box.hidden = false;
    box.className = 'test-result ' + type;
    clear(box);
    const icons = { ok: 'bi-check-circle-fill', err: 'bi-x-circle-fill', pending: 'bi-arrow-repeat' };
    box.appendChild(el('div', { class: 'tr-title' }, [
      el('i', { class: 'bi ' + (icons[type] || 'bi-info-circle') }),
      document.createTextNode(title)
    ]));
    if (body) box.appendChild(el('pre', { text: body }));
  }

  function hideTavilyResult() {
    const box = $('#tavilyResult');
    if (box) { box.hidden = true; clear(box); }
  }

  function readTavilyKey() {
    const input = $('#tavilyKey');
    return input ? input.value.trim() : '';
  }

  function saveTavilyKey(silent) {
    const key = readTavilyKey();
    Store.saveTavily({ apiKey: key });
    if (!silent) Toast.success(T('tavilySaved'));
    if (global.App && App.onModelChanged) App.onModelChanged();
    return key;
  }

  function testTavily() {
    const key = readTavilyKey();
    if (!key) { Toast.error(T('tavilyNeedKey')); $('#tavilyKey').focus(); return; }
    // 先落盘再测试，避免用户以为已保存
    Store.saveTavily({ apiKey: key });

    showTavilyResult('pending', T('tavilyTesting'), '');
    const btn = $('#btnTavilyTest');
    btn.disabled = true;
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'bi bi-arrow-repeat';

    API.testTavily(key).then(res => {
      Store.saveTavily({ apiKey: key, verifiedAt: Date.now() });
      showTavilyResult('ok', T('tavilyOk', res.ms, res.results), res.sample ? ('sample: ' + res.sample) : '');
      Toast.success(T('tavilyOk', res.ms, res.results));
      if (global.App && App.onModelChanged) App.onModelChanged();
    }).catch(err => {
      showTavilyResult('err', T('tavilyFail'), (err && err.message) || String(err));
      Toast.error(T('tavilyFail'));
    }).then(() => {
      btn.disabled = false;
      if (icon) icon.className = 'bi bi-plug';
    });
  }

  /* ======================================================================
     模型列表（含类型子标签）
     ====================================================================== */

  /** 更新子标签的选中态与数量 */
  function renderKindTabs() {
    const tabs = $('#modelKindTabs');
    if (!tabs) return;
    const all = Store.getModels();
    const counts = { all: all.length, chat: 0, image: 0, tts: 0 };
    all.forEach(m => { counts[m.kind] = (counts[m.kind] || 0) + 1; });

    $$('.subtab', tabs).forEach(btn => {
      const kind = btn.dataset.kind;
      btn.classList.toggle('active', kind === Settings.kindFilter);
      btn.setAttribute('aria-selected', kind === Settings.kindFilter ? 'true' : 'false');
      let count = btn.querySelector('.subtab-count');
      if (!count) {
        count = el('span', { class: 'subtab-count' });
        btn.appendChild(count);
      }
      count.textContent = String(counts[kind] || 0);
    });
  }

  /** 关键词命中：名称 / 模型 ID / Base URL / 类型 */
  function matchModel(m, q) {
    if (!q) return true;
    const kindWords = m.kind === 'image' ? 'image 图片'
      : (m.kind === 'tts' ? 'tts speech 语音 朗读' : 'chat 对话');
    const hay = [m.name, m.model, m.baseUrl, kindWords, m.voice]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function syncModelSearchUI() {
    const box = $('#modelSearchInput');
    if (box && document.activeElement !== box) box.value = Settings.modelQuery || '';
    const clr = $('#btnClearModelSearch');
    if (clr) clr.hidden = !Settings.modelQuery;
  }

  function renderModelList() {
    const box = $('#modelList');
    if (!box) return;
    clear(box);
    renderKindTabs();
    syncModelSearchUI();

    const all = Store.getModels();
    const curId = Chat.currentModelId();
    const kind = Settings.kindFilter || 'all';
    const q = (Settings.modelQuery || '').trim().toLowerCase();
    const byKind = kind === 'all' ? all : all.filter(m => m.kind === kind);
    const models = q ? byKind.filter(m => matchModel(m, q)) : byKind;

    if (!models.length) {
      const icon = (all.length && q) ? 'bi-search'
        : (kind === 'image' ? 'bi-image'
          : (kind === 'tts' ? 'bi-soundwave' : (kind === 'chat' ? 'bi-chat-dots' : 'bi-hdd-stack')));
      const text = (all.length && q) ? T('modelsNoMatch') : (all.length ? T('modelsEmptyKind') : T('noModels'));
      const empty = el('div', { class: 'empty-inline' }, [
        el('i', { class: 'bi ' + icon }),
        el('div', { text })
      ]);
      box.appendChild(empty);
      return;
    }

    models.forEach(m => {
      const card = el('div', { class: 'model-card' + (m.id === curId ? ' is-current' : '') });

      // 品牌图标（按关键词自动匹配，匹配不到回退为通用图标）
      card.appendChild(Logos.create(m, { size: 20 }));

      const titleRow = el('div', { class: 'model-card-name' }, [document.createTextNode(m.name)]);
      if (m.id === curId) titleRow.appendChild(el('span', { class: 'model-tag', text: T('using') }));
      if (m.kind === 'image' || m.kind === 'tts') {
        titleRow.appendChild(el('span', { class: 'model-tag kind' }, [
          el('i', { class: 'bi ' + (m.kind === 'tts' ? 'bi-soundwave' : 'bi-image') }),
          document.createTextNode(m.kind === 'tts' ? T('kindTts') : T('kindImage'))
        ]));
      }
      if (m.supportsImages) titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
        el('i', { class: 'bi bi-image' }),
        document.createTextNode(m.kind === 'image' ? T('fVisionImage') : T('modelVision'))
      ]));
      if (m.kind === 'tts') {
        titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi bi-lightning-charge' }),
          document.createTextNode(m.supportsStream ? T('modelStream') : T('modelNoStream'))
        ]));
        if (m.voice) titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi bi-mic' }), document.createTextNode(m.voice)
        ]));
        if (m.audioFormat) titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi bi-file-earmark-music' }),
          document.createTextNode(String(m.audioFormat).toUpperCase())
        ]));
      }
      if (m.kind === 'chat') {
        titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi ' + (m.supportsStream ? 'bi-lightning-charge' : 'bi-dash-circle') }),
          document.createTextNode(m.supportsStream ? T('modelStream') : T('modelNoStream'))
        ]));
        if (m.supportsTools) {
          titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
            el('i', { class: 'bi bi-tools' }),
            document.createTextNode(T('modelTools'))
          ]));
        }
        if (m.thinkingLevels && m.thinkingLevels.length) {
          titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
            /* ⚠️ 这里原来写的是 bi-brain —— bootstrap-icons 里**没有**这个图标，
               所以一直是个隐形的空位（不报错，只是什么都不显示）。
               本项目所有图标都来自 bootstrap-icons 1.13.1，换图标前先确认存在。 */
            el('i', { class: 'bi bi-lightbulb' }),
            document.createTextNode(String(m.thinkingLevels.length))
          ]));
        }
      }

      const metaText = [m.model || '—', shortenUrl(m.baseUrl)].filter(Boolean).join('  ·  ');
      const bodyNode = el('div', { class: 'model-card-body' }, [
        titleRow,
        el('div', { class: 'model-card-meta', text: metaText, title: m.baseUrl })
      ]);

      const actions = el('div', { class: 'model-card-actions' });

      // 图片模型同样可以设为当前对话模型（对话区会切换为图片模式）
      const btnUse = el('button', {
        class: 'icon-btn', type: 'button', title: T('setAsCurrent'), 'aria-label': T('setAsCurrent')
      }, [el('i', { class: 'bi bi-check2-circle' })]);
      btnUse.addEventListener('click', () => {
        Chat.setModel(m.id);
        renderModelList();
        Toast.success(T('currentlyUsing') + ': ' + m.name);
      });
      if (m.id !== curId) actions.appendChild(btnUse);

      const btnEdit = el('button', { class: 'icon-btn', type: 'button', title: T('edit'), 'aria-label': T('edit') },
        [el('i', { class: 'bi bi-pencil' })]);
      btnEdit.addEventListener('click', () => openModelEditor(m));
      actions.appendChild(btnEdit);

      const btnDel = el('button', { class: 'icon-btn danger', type: 'button', title: T('delete'), 'aria-label': T('delete') },
        [el('i', { class: 'bi bi-trash3' })]);
      btnDel.addEventListener('click', () => removeModel(m));
      actions.appendChild(btnDel);

      card.appendChild(bodyNode);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function shortenUrl(u) {
    if (!u) return '';
    return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /* ======================================================================
     MCP 服务器管理（结构对齐「模型」页：列表 + 卡片 + 编辑弹窗）
     ====================================================================== */

  /** 渲染服务器列表 */
  function renderMcpList() {
    const box = $('#mcpList');
    if (!box) return;
    clear(box);

    const servers = Store.getMcpServers();
    if (!servers.length) {
      box.appendChild(el('div', { class: 'empty-inline' }, [
        el('i', { class: 'bi bi-puzzle' }),
        el('div', { text: T('mcpEmpty') }),
        el('div', { class: 'empty-inline-sub', text: T('mcpEmptySub') })
      ]));
      return;
    }

    const conv = global.Chat ? Chat.getConv() : null;
    servers.forEach(s => {
      const card = el('div', { class: 'model-card mcp-card' });
      card.appendChild(el('div', { class: 'mcp-logo' }, [el('i', { class: 'bi bi-plug' })]));

      const titleRow = el('div', { class: 'model-card-name' }, [
        document.createTextNode(s.name || 'Unnamed MCP')
      ]);
      // 当前是否对这条对话生效（一眼看出「加了但被关掉了」）
      const on = global.Chat ? Chat.mcpServerEnabled(s.id) : true;
      titleRow.appendChild(el('span', { class: 'model-tag ' + (on ? '' : 'muted') }, [
        el('i', { class: 'bi ' + (on ? 'bi-check-circle-fill' : 'bi-slash-circle') }),
        document.createTextNode(on ? T('mcpEnabled') : T('mcpDisabled'))
      ]));
      if (s.lastTest && s.lastTest.ok) {
        titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi bi-tools' }),
          document.createTextNode(T('mcpToolCount', s.lastTest.toolCount))
        ]));
      } else if (s.lastTest && s.lastTest.ok === false) {
        titleRow.appendChild(el('span', { class: 'model-tag danger' }, [
          el('i', { class: 'bi bi-exclamation-triangle-fill' }),
          document.createTextNode(T('mcpUnverified'))
        ]));
      }
      if (s.corsBypass) titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
        el('i', { class: 'bi bi-shield-shaded' }), document.createTextNode(T('fCorsBypass'))
      ]));

      const headerCount = (s.headers || []).length;
      const metaBits = [shortenUrl(s.url)];
      if (headerCount) metaBits.push(T('mcpHeaderCount', headerCount));
      const bodyNode = el('div', { class: 'model-card-body' }, [
        titleRow,
        el('div', { class: 'model-card-meta', text: metaBits.filter(Boolean).join('  ·  '), title: s.url })
      ]);

      const actions = el('div', { class: 'model-card-actions' });

      const btnToggle = el('button', {
        class: 'icon-btn', type: 'button', title: on ? T('mcpDisable') : T('mcpEnable'),
        'aria-label': on ? T('mcpDisable') : T('mcpEnable')
      }, [el('i', { class: 'bi ' + (on ? 'bi-toggle-on' : 'bi-toggle-off') })]);
      btnToggle.addEventListener('click', () => {
        if (!global.Chat) return;
        Chat.setMcpServerEnabled(s.id, !on);
        renderMcpList();
      });
      actions.appendChild(btnToggle);

      const btnEdit = el('button', {
        class: 'icon-btn', type: 'button', title: T('edit'), 'aria-label': T('edit')
      }, [el('i', { class: 'bi bi-pencil' })]);
      btnEdit.addEventListener('click', () => openMcpEditor(s));
      actions.appendChild(btnEdit);

      const btnDel = el('button', {
        class: 'icon-btn danger', type: 'button', title: T('delete'), 'aria-label': T('delete')
      }, [el('i', { class: 'bi bi-trash' })]);
      btnDel.addEventListener('click', () => removeMcpServer(s));
      actions.appendChild(btnDel);

      card.appendChild(bodyNode);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function removeMcpServer(s) {
    Confirm.ask({
      title: T('deleteMcpTitle'),
      text: T('deleteMcpText', s.name || s.url),
      okText: T('delete')
    }).then(r => {
      if (!r.confirmed) return;
      Store.deleteMcpServer(s.id);
      if (global.Mcp) Mcp.forget(s.id);       // 会话与工具缓存一并作废
      if (global.Enhancer) Enhancer.syncOrigins();   // 白名单里删掉这个 origin
      renderMcpList();
      if (global.Chat) Chat.renderMessages();  // 消息里的工具块不受影响，但标签依赖服务器名
      Toast.success(T('deleted'));
    });
  }

  /* ---------- 自定义 HTTP 头编辑 ---------- */

  /** 渲染一行「名称 : 值」输入；返回该行的 DOM */
  function headerRow(header) {
    const row = el('div', { class: 'kv-row' });
    const name = el('input', {
      class: 'input mono kv-name', type: 'text', placeholder: 'Authorization',
      autocomplete: 'off', spellcheck: 'false'
    });
    name.value = (header && header.name) || '';
    const value = el('input', {
      class: 'input mono kv-value', type: 'text', placeholder: 'Bearer xxx',
      autocomplete: 'off', spellcheck: 'false'
    });
    value.value = (header && header.value) || '';
    const del = el('button', {
      class: 'icon-btn tiny', type: 'button', title: T('delete'), 'aria-label': T('delete')
    }, [el('i', { class: 'bi bi-x-lg' })]);
    del.addEventListener('click', () => {
      const box = row.parentNode;
      if (box) box.removeChild(row);
    });
    row.appendChild(name);
    row.appendChild(el('span', { class: 'kv-colon', text: ':' }));
    row.appendChild(value);
    row.appendChild(del);
    return row;
  }

  function renderHeaderRows(list) {
    const box = $('#mcpHeaderList');
    if (!box) return;
    clear(box);
    (list || []).forEach(h => box.appendChild(headerRow(h)));
  }

  function readHeaderRows() {
    const box = $('#mcpHeaderList');
    if (!box) return [];
    const out = [];
    $$('#mcpHeaderList .kv-row').forEach(row => {
      const n = row.querySelector('.kv-name');
      const v = row.querySelector('.kv-value');
      const name = n ? n.value.trim() : '';
      if (!name) return;            // 名称为空的行直接丢弃（用户加了行但没填）
      out.push({ name, value: v ? v.value : '' });
    });
    return out;
  }

  /* ---------- 编辑弹窗 ---------- */

  function openMcpEditor(server) {
    const isNew = !server;
    Settings.editingMcp = server
      ? JSON.parse(JSON.stringify(server))
      : { id: '', name: '', url: '', corsBypass: false, headers: [], supportsStream: true };

    const s = Settings.editingMcp;
    const f = {
      name: $('#mcpName'), url: $('#mcpUrl'),
      cors: $('#mcpCorsBypass'), stream: $('#mcpStream')
    };
    f.name.value = s.name || '';
    f.url.value = s.url || '';
    f.cors.checked = s.corsBypass === true;
    f.stream.checked = s.supportsStream !== false;
    renderHeaderRows(s.headers || []);

    $('#mcpEditTitle').textContent = isNew ? T('addMcp') : T('editMcp');
    hideMcpTestResult();
    applyI18n($('#mcpBackdrop'));
    applyMcpCorsUI();     // 必须在 applyI18n 之后：动态提示会被 i18n 刷回默认文案
    UI.openModal($('#mcpBackdrop'));
    setTimeout(() => f.name.focus(), 60);
  }

  function closeMcpEditor() {
    UI.closeModal($('#mcpBackdrop'));
    Settings.editingMcp = null;
  }

  /** 与模型页的 applyCorsBypassUI 同构：开着但脚本没连上时如实提醒 */
  /**
   * 「绕过 CORS」那一行的说明文字（三态）：
   *   ① 页面 https + 地址 http（混合内容）→ 说明**非连脚本不可**，这是最有用的一句；
   *   ② 开关开着但脚本没连 → 如实提醒本次仍按普通方式发送；
   *   ③ 其余 → 默认文案。
   */
  function applyMcpCorsUI() {
    const sw = $('#mcpCorsBypass');
    if (!sw) return;
    const hint = $('#mcpCorsHint');
    if (!hint) return;
    if (!hint.dataset.baseText) hint.dataset.baseText = T('fCorsBypassHint');

    const urlInput = $('#mcpUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    const mixed = !!(url && global.Enhancer && Enhancer.isMixedContent && Enhancer.isMixedContent(url));

    if (mixed) {
      hint.textContent = (global.Enhancer && Enhancer.connected())
        ? T('mcpMixedHintOk')
        : T('mcpMixedHint');
      hint.classList.add('is-warning');
      return;
    }
    hint.classList.remove('is-warning');
    if (sw.checked && global.Enhancer && !Enhancer.connected()) {
      hint.textContent = T('usBypassNotReady');
    } else {
      hint.textContent = hint.dataset.baseText;
    }
  }

  function readMcpForm() {
    const base = Settings.editingMcp || {};
    return Store.normalizeMcpServer({
      id: base.id || '',
      name: $('#mcpName').value.trim(),
      url: $('#mcpUrl').value.trim(),
      corsBypass: $('#mcpCorsBypass').checked,
      supportsStream: $('#mcpStream').checked,
      headers: readHeaderRows(),
      lastTest: base.lastTest || null,
      createdAt: base.createdAt || 0
    });
  }

  function saveMcp() {
    const s = readMcpForm();
    if (!s.name) { Toast.warning(T('mcpNeedName')); $('#mcpName').focus(); return; }
    if (!s.url) { Toast.warning(T('mcpNeedUrl')); $('#mcpUrl').focus(); return; }
    if (!/^https?:\/\//i.test(s.url)) {
      Toast.warning(T('mcpUrlScheme')); $('#mcpUrl').focus(); return;
    }
    Store.upsertMcpServer(s);
    if (global.Mcp) Mcp.forget(s.id);      // 地址/头可能变了，旧会话与工具缓存必须作废
    /* ⚠️ 地址或「绕过 CORS」开关变了 → 增强脚本的转发白名单必须跟着更新。
       不刷新的话，脚本会按旧白名单把这个新 origin 拒掉，
       用户只能刷新页面才生效（和模型侧是同一个坑）。 */
    if (global.Enhancer) Enhancer.syncOrigins();
    closeMcpEditor();
    renderMcpList();
    Toast.success(T('saved'));
    // 保存后如实提醒「这样连不上」，而不是等用户去撞墙
    warnIfMixedContent(s);
  }

  /**
   * 保存/测试时如果发现「页面 https + 地址 http」，明确告诉用户怎么办。
   * 这种请求浏览器一定会拦（混合内容），只有增强脚本能救。
   */
  function warnIfMixedContent(s) {
    if (!global.Enhancer || !Enhancer.isMixedContent) return false;
    if (!Enhancer.isMixedContent(s.url)) return false;
    if (Enhancer.connected()) {
      Toast.info(T('mcpMixedViaScript'));       // 已连接 → 会被自动转发，只是告知
    } else {
      Toast.warning(T('mcpMixedNeedScript'), { duration: 9000 });
    }
    return true;
  }

  /** 连通性测试：initialize + tools/list，把结果与耗时如实回显 */
  function testMcp() {
    const s = readMcpForm();
    if (!s.url) { Toast.warning(T('mcpNeedUrl')); $('#mcpUrl').focus(); return; }
    if (!/^https?:\/\//i.test(s.url)) { Toast.warning(T('mcpUrlScheme')); $('#mcpUrl').focus(); return; }
    if (!global.Mcp) return;
    // 混合内容且脚本没连：直说，别让用户等一次注定失败的请求
    if (warnIfMixedContent(s)) { hideMcpTestResult(); return; }

    const box = $('#mcpTestResult');
    const btn = $('#btnMcpTest');
    if (box) {
      box.hidden = false;
      box.className = 'test-result pending';
      clear(box);
      box.appendChild(el('div', { class: 'tr-line' }, [
        el('span', { class: 'thinking-dots' }, [el('span'), el('span'), el('span')]),
        el('span', { text: T('mcpTesting') })
      ]));
    }
    if (btn) btn.disabled = true;

    Mcp.test(s).then(r => {
      if (btn) btn.disabled = false;
      if (!box) return;
      box.className = 'test-result ' + (r.ok ? 'ok' : 'fail');
      clear(box);
      if (r.ok) {
        box.appendChild(el('div', { class: 'tr-line' }, [
          el('i', { class: 'bi bi-check-circle-fill' }),
          el('span', { text: T('mcpTestOk', r.toolCount, r.ms) })
        ]));
        const info = r.serverInfo || {};
        const bits = [];
        if (info.name) bits.push(info.name + (info.version ? ' ' + info.version : ''));
        if (r.protocolVersion) bits.push('protocol ' + r.protocolVersion);
        if (bits.length) box.appendChild(el('div', { class: 'tr-sub', text: bits.join(' · ') }));
        if (r.tools && r.tools.length) {
          const names = el('div', { class: 'tr-tools' });
          r.tools.slice(0, 24).forEach(t => names.appendChild(el('span', { class: 'tr-tool', text: t.name })));
          if (r.tools.length > 24) names.appendChild(el('span', { class: 'tr-tool muted', text: '+' + (r.tools.length - 24) }));
          box.appendChild(names);
        }
      } else {
        box.appendChild(el('div', { class: 'tr-line' }, [
          el('i', { class: 'bi bi-exclamation-triangle-fill' }),
          el('span', { text: T('mcpTestFail') })
        ]));
        box.appendChild(el('div', { class: 'tr-sub', text: r.error || '' }));
      }
      // 把测试结果记进配置，列表卡片上能看出「这台是否验证过」
      const rec = { ok: !!r.ok, ms: r.ms || 0, toolCount: r.toolCount || 0, at: Date.now(), error: r.error || '' };
      /* ⚠️ 两个地方都要写：
         · Settings.editingMcp —— 新建还没保存时，配置只存在这里，
           不写它的话「测完再点保存」会把结果丢掉（踩过）。
         · Store —— 已保存的服务器，立刻落到存储里。 */
      if (Settings.editingMcp) Settings.editingMcp.lastTest = rec;
      const cur = Store.getMcpServer(s.id);
      if (cur) {
        cur.lastTest = rec;
        Store.upsertMcpServer(cur);
        renderMcpList();
      }
    });
  }

  function hideMcpTestResult() {
    const box = $('#mcpTestResult');
    if (box) { box.hidden = true; clear(box); }
    const btn = $('#btnMcpTest');
    if (btn) btn.disabled = false;
  }

  function bindMcpUI() {
    const add = $('#btnAddMcp');
    if (add) add.addEventListener('click', () => openMcpEditor(null));

    const close2 = $('#mcpEditClose');
    if (close2) close2.addEventListener('click', closeMcpEditor);
    const cancel = $('#mcpCancel');
    if (cancel) cancel.addEventListener('click', closeMcpEditor);
    const save = $('#mcpSave');
    if (save) save.addEventListener('click', saveMcp);
    const test = $('#btnMcpTest');
    if (test) test.addEventListener('click', testMcp);

    const addHeader = $('#btnAddMcpHeader');
    if (addHeader) addHeader.addEventListener('click', () => {
      const box = $('#mcpHeaderList');
      if (box) {
        const row = headerRow(null);
        box.appendChild(row);
        const n = row.querySelector('.kv-name');
        if (n) n.focus();
      }
    });

    const sw = $('#mcpCorsBypass');
    if (sw) sw.addEventListener('change', applyMcpCorsUI);
    /* 地址一边敲一边刷提示：用户输入 http:// 的瞬间就该看到「混合内容」的说明，
       而不是等点了保存才发现连不上。 */
    const urlInput = $('#mcpUrl');
    if (urlInput) urlInput.addEventListener('input', applyMcpCorsUI);

    // 背景遮罩点击关闭
    const backdrop = $('#mcpBackdrop');
    if (backdrop) backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeMcpEditor();
    });

    // 工具子标签按钮（带高度过渡）
    $$('#settingsBackdrop .subtab[data-tool]').forEach(b => {
      b.addEventListener('click', () => switchTool(b.dataset.tool, { animate: true }));
    });
  }

  /* ======================================================================
     快捷键表格
     ----------------------------------------------------------------------
     ⚠️ 内容来自 App.shortcutList()（= app.js 里那张 SHORTCUTS 分派表），
     这里不另抄一份。这样「设置页写了但没实现」永远不会发生。
     ====================================================================== */
  function renderShortcutTable() {
    const box = $('#shortcutTable');
    if (!box) return;
    clear(box);

    const list = (global.App && App.shortcutList) ? App.shortcutList() : [];
    if (!list.length) return;

    // 按分组归拢，保持 SHORTCUTS 里的声明顺序
    const groups = [];
    list.forEach(item => {
      let g = groups.find(x => x.key === item.groupKey);
      if (!g) { g = { key: item.groupKey, items: [] }; groups.push(g); }
      g.items.push(item);
    });

    groups.forEach(g => {
      const wrap = el('div', { class: 'shortcut-group' });
      wrap.appendChild(el('div', { class: 'group-title', text: T(g.key) }));

      const table = el('table', { class: 'shortcut-table' });
      const thead = el('thead');
      const hr = el('tr');
      hr.appendChild(el('th', { text: T('scColKeys') }));
      hr.appendChild(el('th', { text: T('scColAction') }));
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = el('tbody');
      g.items.forEach(item => {
        const tr = el('tr');
        const kbdCell = el('td', { class: 'sc-keys' });
        // 每个键位一个 <kbd>，看起来像键帽
        App.shortcutKeysText(item.keys).split(' + ').forEach((k, i) => {
          if (i) kbdCell.appendChild(el('span', { class: 'sc-plus', text: '+' }));
          kbdCell.appendChild(el('kbd', { text: k }));
        });
        tr.appendChild(kbdCell);
        tr.appendChild(el('td', { class: 'sc-desc', text: T(item.labelKey) }));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      box.appendChild(wrap);
    });
  }

  function removeModel(m) {
    Confirm.ask({
      title: T('deleteModelTitle'),
      text: T('deleteModelText', m.name),
      okText: T('delete')
    }).then(r => {
      if (!r.confirmed) return;
      Store.deleteModel(m.id);
      // 若当前对话使用该模型，优先切到同类型的第一个模型
      const rest = Store.getModels();
      const sameKind = rest.filter(x => x.kind === m.kind);
      const fallback = sameKind[0] || rest[0] || null;
      let changed = false;
      Store.getConversations().forEach(c => {
        if (c.modelId === m.id) {
          c.modelId = fallback ? fallback.id : '';
          c.thinking = (fallback && fallback.thinkingLevels && fallback.thinkingLevels[0]) || '';
          Store.upsertConversation(c);
          changed = true;
        }
      });
      if (changed && global.App) App.onModelChanged();
      renderModelList();
      renderTitleModelSelect(Store.getSettings());
      renderDataStats();
      Toast.success(T('modelDeleted'));
    });
  }

  /* ======================================================================
     模型编辑弹窗
     ====================================================================== */

  /** 预置思考强度选项（按强度递增排列，勾选顺序即为此顺序） */
  const THINKING_PRESETS = [
    { value: 'none', label: 'none — 关闭' },
    { value: 'off', label: 'off — 关闭（别名）' },
    { value: 'minimal', label: 'minimal — 最低' },
    { value: 'low', label: 'low — 低' },
    { value: 'medium', label: 'medium — 中' },
    { value: 'high', label: 'high — 高' },
    { value: 'xhigh', label: 'xhigh — 极高' },
    { value: 'maximum', label: 'maximum — 最高' },
    { value: 'auto', label: 'auto — 自动' }
  ];

  /** 渲染思考强度勾选网格 */
  function renderThinkingLevels(selected) {
    const box = $('#mfThinkingLevels');
    if (!box) return;
    clear(box);
    const sel = (selected || []).map(s => String(s).trim().toLowerCase());
    THINKING_PRESETS.forEach(p => {
      const id = 'tp_' + p.value;
      const input = el('input', { type: 'checkbox', id, value: p.value });
      input.checked = sel.indexOf(p.value) >= 0;
      const row = el('label', { class: 'check-row', for: id }, [
        input, el('span', { text: p.label })
      ]);
      box.appendChild(row);
    });
    // 记录自定义值（历史数据里可能有预置项之外的值）
    const extra = sel.filter(v => !THINKING_PRESETS.some(p => p.value === v));
    box.dataset.extra = extra.join(',');
  }

  /** 读取勾选的思考强度，按预置顺序返回（保证顺序稳定） */
  function readThinkingLevels() {
    const box = $('#mfThinkingLevels');
    if (!box) return [];
    const checked = $$('input[type="checkbox"]:checked', box).map(i => i.value);
    const ordered = THINKING_PRESETS.map(p => p.value).filter(v => checked.indexOf(v) >= 0);
    const extra = (box.dataset.extra || '').split(',').map(s => s.trim()).filter(Boolean);
    // 保留历史自定义值，但排除已勾选的
    extra.forEach(v => { if (ordered.indexOf(v) < 0) ordered.push(v); });
    return ordered;
  }

  function setAllThinkingLevels(on) {
    const box = $('#mfThinkingLevels');
    if (!box) return;
    $$('input[type="checkbox"]', box).forEach(i => { i.checked = !!on; });
  }

  /* ---------- 语音合成（TTS）专属控件 ---------- */

  /** 输出格式下拉（取值来自 API.AUDIO_FORMATS） */
  function renderAudioFormats() {
    const sel = $('#mfAudioFormat');
    if (!sel) return;
    const cur = sel.value;
    clear(sel);
    const list = (global.API && API.AUDIO_FORMATS) ? API.AUDIO_FORMATS : [{ value: 'wav', label: 'WAV' }];
    list.forEach(f => {
      sel.appendChild(el('option', { value: f.value, text: T('audioFormat_' + f.value) }));
    });
    sel.value = cur && list.some(f => f.value === cur) ? cur : list[0].value;
    if (global.UI && UI.Select) UI.Select.refresh(sel);
  }

  /** 规范化 Base URL：去空白、去末尾斜杠（保留协议部分的 //） */
  function normalizeBaseUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/\s+/g, '');
    // 去掉末尾的一个或多个斜杠
    u = u.replace(/\/+$/, '');
    return u;
  }

  function openModelEditor(model) {
    const isNew = !model;
    Settings.editing = model ? JSON.parse(JSON.stringify(model)) : null;
    const f = {
      name: $('#mfName'), baseUrl: $('#mfBaseUrl'), key: $('#mfKey'),
      model: $('#mfModel'), context: $('#mfContext'),
      system: $('#mfSystem'), vision: $('#mfVision'), stream: $('#mfStream'),
      tools: $('#mfTools'), corsBypass: $('#mfCorsBypass'),
      voice: $('#mfVoice'), audioFormat: $('#mfAudioFormat'), ttsInstruction: $('#mfTtsInstruction')
    };
    const m = Settings.editing;
    // 新建时沿用当前子分类作为默认类型
    const kind = m ? (m.kind || 'chat')
      : (['image', 'tts'].indexOf(Settings.kindFilter) >= 0 ? Settings.kindFilter : 'chat');

    f.name.value = m ? m.name : '';
    f.baseUrl.value = m ? m.baseUrl : '';
    f.key.value = m ? m.apiKey : '';
    f.model.value = m ? m.model : '';
    f.context.value = m && m.contextLength ? m.contextLength : '';
    renderThinkingLevels(m ? m.thinkingLevels : []);
    const hint = $('#fetchModelsHint');
    if (hint) hint.textContent = T('fModelHint');
    f.system.value = m ? m.systemPrompt : '';
    f.vision.checked = m ? !!m.supportsImages : false;
    f.stream.checked = m ? m.supportsStream !== false : true;
    if (f.tools) f.tools.checked = m ? !!m.supportsTools : true;
    if (f.corsBypass) f.corsBypass.checked = m ? m.corsBypass === true : false;

    // 语音合成专属字段
    renderAudioFormats();
    if (f.voice) f.voice.value = m ? (m.voice || '') : '';
    if (f.audioFormat) f.audioFormat.value = (m && m.audioFormat) || 'wav';
    if (f.ttsInstruction) f.ttsInstruction.value = m ? (m.ttsInstruction || '') : '';

    setSegmented('#segModelKind', kind);
    renderModelChoices([]);

    const keyInput = f.key;
    keyInput.type = 'password';
    const eyeBtn = $('#btnToggleKey');
    if (eyeBtn && eyeBtn.firstElementChild) eyeBtn.firstElementChild.className = 'bi bi-eye';

    $('#modelEditTitle').textContent = isNew ? T('addModel') : T('editModel');
    hideTestResult();
    applyI18n($('#modelBackdrop'));
    // 放在 applyI18n 之后：类型相关的文案由这里按当前类型覆盖
    applyKindUI(kind);
    applyCorsBypassUI();      // 同上：动态提示要在 i18n 之后覆盖
    UI.openModal($('#modelBackdrop'));
    setTimeout(() => f.name.focus(), 60);
  }

  function currentFormKind() {
    const seg = $('#segModelKind');
    const v = seg && seg.dataset.value;
    return (v === 'image' || v === 'tts') ? v : 'chat';
  }

  /**
   * 依据模型类型调整表单：
   * - 对话：全部字段
   * - 图片：隐藏上下文 / 思考强度 / 系统提示词 / 流式输出 / 工具调用，保留图片输入
   * - 语音：隐藏上下文 / 思考强度 / 系统提示词 / 工具调用 / 图片输入，显示音色与格式
   */
  function applyKindUI(kind) {
    const isImage = kind === 'image';
    const isTts = kind === 'tts';
    const isChat = !isImage && !isTts;
    const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; };
    show('#rowContext', isChat);
    show('#rowThinking', isChat);
    show('#rowSystem', isChat);
    show('#rowStream', !isImage);          // 语音模型也支持流式合成
    show('#rowTools', isChat);
    show('#rowVision', !isTts);            // 语音模型不涉及图片输入
    show('#ttsFields', isTts);

    const visionLabel = $('#mfVisionLabel');
    if (visionLabel) visionLabel.textContent = T(isImage ? 'fVisionImage' : 'fVision');

    const kindHint = $('#kindHint');
    if (kindHint) {
      kindHint.textContent = T(isTts ? 'kindTtsDesc' : (isImage ? 'kindImageDesc' : 'kindChatDesc'));
    }

    // 模型名占位提示随类型变化
    const modelInput = $('#mfModel');
    if (modelInput) {
      modelInput.setAttribute('placeholder',
        isTts ? 'mimo-v2.5-tts' : (isImage ? 'qwen-image-3.0' : 'deepseek-flash'));
    }
    const nameInput = $('#mfName');
    if (nameInput) {
      nameInput.setAttribute('placeholder',
        isTts ? '例如：小米 MiMo 语音' : (isImage ? '例如：通义万相' : '例如：DeepSeek 官方'));
    }
  }

  function closeModelEditor() {
    UI.closeModal($('#modelBackdrop'));
    Settings.editing = null;
  }

  /**
   * 「绕过 CORS 限制」开关所在的字段行。
   * 三种模型类型都能用（图片 / 语音同样可能撞上跨域），所以不做类型隐藏。
   */
  function applyCorsBypassUI() {
    const sw = $('#mfCorsBypass');
    if (!sw) return;
    const on = sw.checked;
    const hint = sw.closest('.setting-row') && sw.closest('.setting-row').querySelector('.sl-desc');
    // 开着但脚本没连上时，如实提醒「本次仍按普通方式发送」
    if (hint && on && global.Enhancer && !Enhancer.connected()) {
      if (!hint.dataset.baseText) hint.dataset.baseText = hint.textContent;
      hint.textContent = T('usBypassNotReady');
    } else if (hint && hint.dataset.baseText) {
      hint.textContent = hint.dataset.baseText;
    }
  }

  function readModelForm() {
    const kind = currentFormKind();
    const voiceEl = $('#mfVoice');
    const fmtEl = $('#mfAudioFormat');
    const insEl = $('#mfTtsInstruction');
    return {
      id: Settings.editing ? Settings.editing.id : '',
      kind,
      name: $('#mfName').value.trim(),
      baseUrl: normalizeBaseUrl($('#mfBaseUrl').value),
      apiKey: $('#mfKey').value.trim(),
      model: $('#mfModel').value.trim(),
      contextLength: Number($('#mfContext').value) || 0,
      thinkingLevels: readThinkingLevels(),
      systemPrompt: $('#mfSystem').value,
      supportsImages: kind === 'tts' ? false : $('#mfVision').checked,
      supportsStream: $('#mfStream').checked,
      supportsTools: kind === 'tts' ? false : ($('#mfTools') ? $('#mfTools').checked : false),
      // 绕过 CORS：开启后该模型的请求交给油猴脚本转发（默认关闭）
      corsBypass: $('#mfCorsBypass') ? $('#mfCorsBypass').checked : false,
      /* 语音合成专属 */
      voice: voiceEl ? voiceEl.value.trim() : '',
      audioFormat: fmtEl ? fmtEl.value : 'wav',
      ttsInstruction: insEl ? insEl.value : ''
    };
  }

  function saveModel() {
    const data = readModelForm();
    // 回写规范化后的 Base URL，让用户看到实际保存的值
    const urlInput = $('#mfBaseUrl');
    if (urlInput && urlInput.value !== data.baseUrl) urlInput.value = data.baseUrl;

    if (!data.name) data.name = data.model || T('untitled');
    if (!data.baseUrl || !data.apiKey) {
      Toast.error(T('fillRequired'));
      (!data.baseUrl ? $('#mfBaseUrl') : $('#mfKey')).focus();
      return;
    }
    if (!data.model) {
      Toast.error(T('fillModelName'));
      $('#mfModel').focus();
      return;
    }

    const isNew = !Settings.editing;
    const saved = Store.upsertModel(data);
    closeModelEditor();
    renderModelList();
    renderTitleModelSelect(Store.getSettings());
    renderDataStats();
    // 模型的「绕过 CORS」开关可能刚变过，把最新白名单同步给增强脚本
    if (global.Enhancer) Enhancer.syncOrigins();
    Toast.success(isNew ? T('modelAdded') : T('modelSaved'));

    // 若当前对话没有模型，自动选中新模型
    const conv = Chat.getConv();
    if (conv && !Store.getModel(conv.modelId)) {
      Chat.setModel(saved.id);
      if (global.App) App.onModelChanged();
    } else if (global.App) {
      App.onModelChanged();
    }
  }

  /* ---------- 测试连通性 ---------- */
  function showTestResult(type, title, body) {
    const box = $('#testResult');
    if (!box) return;
    box.hidden = false;
    box.className = 'test-result ' + type;
    clear(box);
    const icons = { ok: 'bi-check-circle-fill', err: 'bi-x-circle-fill', pending: 'bi-arrow-repeat' };
    box.appendChild(el('div', { class: 'tr-title' }, [
      el('i', { class: 'bi ' + (icons[type] || 'bi-info-circle') }),
      document.createTextNode(title)
    ]));
    if (body) box.appendChild(el('pre', { text: body }));
  }

  function hideTestResult() {
    const box = $('#testResult');
    if (box) { box.hidden = true; clear(box); }
  }

  function testConnection() {
    const data = readModelForm();
    if (!data.baseUrl) { Toast.error(T('fillRequired')); $('#mfBaseUrl').focus(); return; }
    if (!data.model) { Toast.error(T('fillModelName')); $('#mfModel').focus(); return; }

    showTestResult('pending', T('testing'), '');
    const btn = $('#btnTestConn');
    btn.disabled = true;

    API.testConnection(data).then(res => {
      if (res.via === 'models') {
        const extra = res.warning ? ('chat/completions: ' + res.warning) : '';
        showTestResult('ok', T('testOkModels', res.models.length, res.ms), extra);
        renderModelChoices(res.models);
      } else {
        const lines = [];
        if (res.model) lines.push('model: ' + res.model);
        if (res.content) lines.push('reply: ' + res.content);
        if (res.usage) lines.push('usage: ' + JSON.stringify(res.usage));
        showTestResult('ok', T('testOk', res.ms), lines.join('\n'));
      }
      Toast.success(T('testOk', res.ms));
    }).catch(err => {
      showTestResult('err', T('testFail'), (err && err.message) || String(err));
      Toast.error(T('testFail'));
    }).then(() => {
      btn.disabled = false;
    });
  }

  /**
   * 渲染 /models 查询结果。
   * 刻意不自动填充输入框，也不使用原生 datalist —— 由用户从下方列表中显式点选。
   */
  function renderModelChoices(list) {
    const box = $('#modelChoices');
    if (!box) return;
    clear(box);
    const models = (list || []).filter(m => m && m.id);
    if (!models.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const input = $('#mfModel');

    models.forEach(m => {
      const item = el('button', {
        class: 'model-choice' + (input && input.value === m.id ? ' active' : ''),
        type: 'button'
      }, [
        el('span', { class: 'model-choice-name', text: m.id }),
        m.owned ? el('span', { class: 'model-choice-own', text: m.owned }) : null
      ]);
      item.addEventListener('click', () => {
        if (input) { input.value = m.id; input.focus(); }
        $$('.model-choice', box).forEach(b => b.classList.remove('active'));
        item.classList.add('active');
      });
      box.appendChild(item);
    });

    box.appendChild(el('div', { class: 'model-choices-foot', text: T('modelChoicesHint') }));
  }

  function fetchModels() {
    const data = readModelForm();
    if (!data.baseUrl || !data.apiKey) { Toast.error(T('fillRequired')); return; }
    const btn = $('#btnFetchModels');
    const hint = $('#fetchModelsHint');
    btn.disabled = true;
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'bi bi-arrow-repeat';
    if (hint) hint.textContent = T('fetchingModels');

    API.listModels(data).then(list => {
      renderModelChoices(list);
      if (hint) hint.textContent = list.length ? T('modelsFound', list.length) : T('modelsNone');
      Toast.success(list.length ? T('modelsFound', list.length) : T('modelsNone'));
      // 不自动填充模型名，交给用户从列表中点选
    }).catch(err => {
      if (hint) hint.textContent = (err && err.message) || T('requestFailed');
      Toast.error((err && err.message) || T('requestFailed'));
    }).then(() => {
      btn.disabled = false;
      if (icon) icon.className = 'bi bi-cloud-arrow-down';
    });
  }

  /* ======================================================================
     清除数据 / 导入导出
     ====================================================================== */
  function clearAll() {
    Confirm.ask({
      title: T('clearAllTitle'),
      text: T('clearAllText'),
      okText: T('clearAllBtn')
    }).then(r => {
      if (!r.confirmed) return;
      Store.clearAll();
      // 生成图片 / 合成语音 / 背景图片存在 IndexedDB，需要单独清空
      const done = () => {
        Toast.success(T('allCleared'));
        setTimeout(() => global.location.reload(), 500);
      };
      const jobs = [];
      if (global.ImageStore) jobs.push(ImageStore.clear().catch(() => false));
      if (global.AudioStore) jobs.push(AudioStore.clear().catch(() => false));
      if (global.Personalize) jobs.push(Personalize.clear().catch(() => false));
      if (jobs.length) Promise.all(jobs).then(done).catch(done);
      else done();
    });
  }

  /* ---------- 备份（ZIP） ---------- */

  const BACKUP_JSON = 'lynkllm-ce-backup.json';

  /** 文件名安全化 */
  function safeId(id) {
    return String(id || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'x';
  }

  /** mime → 扩展名 */
  function extOfMime(mime, fallback) {
    const m = String(mime || '');
    if (/jpe?g/i.test(m)) return 'jpg';
    if (/png/i.test(m)) return 'png';
    if (/webp/i.test(m)) return 'webp';
    if (/gif/i.test(m)) return 'gif';
    if (/mpeg|mp3/i.test(m)) return 'mp3';
    if (/ogg/i.test(m)) return 'ogg';
    if (/webm/i.test(m)) return 'webm';
    if (/wav/i.test(m)) return 'wav';
    return fallback || 'bin';
  }

  /** 从记录里取出可序列化的元数据（去掉体积很大的 dataUrl） */
  function assetMeta(rec, extra) {
    const meta = {};
    Object.keys(rec || {}).forEach(k => {
      if (k === 'dataUrl') return;
      meta[k] = rec[k];
    });
    return Object.assign(meta, extra || {});
  }

  /** 让出主线程一次。导出的素材可能有上百 MB，base64 解码 + CRC 全是同步计算，
      不主动让出就会让界面整整冻结几秒（实测 48MB 备份会卡住 4.1 秒）。 */
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /** 每累计处理这么多字符（约等于这么多字节的素材）就让出一次主线程 */
  const YIELD_EVERY = 3 * 1024 * 1024;

  /**
   * 把 IndexedDB 里的素材逐个打包进文件列表，期间周期性让出主线程
   * @param {Array} records IndexedDB 记录（含 dataUrl）
   * @param {string} dir 包内目录前缀
   * @param {string} fallbackExt 无法从 mime 判断时用的扩展名
   * @param {Array} manifest 清单数组（收集元数据）
   * @param {Array} sink 文件列表（收集实际字节）
   */
  function packAssets(records, dir, fallbackExt, manifest, sink) {
    let pending = 0;
    return (records || []).reduce((chain, rec) => chain.then(() => {
      if (!rec || !rec.dataUrl) return null;
      const parsed = Zip.dataUrlToBytes(rec.dataUrl);
      if (!parsed) return null;
      const path = dir + safeId(rec.id) + '.' + extOfMime(parsed.mime, fallbackExt);
      sink.push({ name: path, data: parsed.bytes });
      manifest.push(assetMeta(rec, { path, mime: parsed.mime }));
      pending += rec.dataUrl.length;
      if (pending >= YIELD_EVERY) { pending = 0; return yieldToUI(); }
      return null;
    }), Promise.resolve());
  }

  /**
   * 组装备份 ZIP（不触发下载，便于测试与复用）
   * @returns {Promise<Blob>}
   */
  /**
   * 组装备份包。
   * @param {object} [opts]
   * @param {string[]} [opts.conversationIds] 只导出这些对话（用于「导出当前对话」）。
   *        传了它就**只打包这些对话引用到的素材** —— 否则一台机器上几十张图片
   *        会被塞进一份「单条对话」的导出里，既慢又莫名其妙。
   */
  function buildBackup(opts) {
    opts = opts || {};
    const only = Array.isArray(opts.conversationIds) && opts.conversationIds.length
      ? opts.conversationIds : null;

    const data = Store.exportData();
    if (only) {
      data.conversations = data.conversations.filter(c => only.indexOf(c.id) >= 0);
    }

    // 需要打包的素材 id：只导单条对话时按引用收集
    let assetFilter = null;
    if (only) {
      const ids = { image: {}, audio: {} };
      data.conversations.forEach(c => {
        (c.messages || []).forEach(m => {
          (m.images || []).forEach(im => { if (im && im.id) ids.image[im.id] = 1; });
          (m.audios || []).forEach(a => { if (a && a.id) ids.audio[a.id] = 1; });
        });
      });
      assetFilter = ids;
    }

    const jobs = [
      global.ImageStore ? ImageStore.list() : Promise.resolve([]),
      global.AudioStore ? AudioStore.list() : Promise.resolve([]),
      global.Personalize ? Personalize.loadBackground() : Promise.resolve(null)
    ];

    return Promise.all(jobs).then(res => {
      const pick = (list, kind) => assetFilter
        ? (list || []).filter(r => r && assetFilter[kind][r.id])
        : (list || []);
      const images = pick(res[0], 'image');
      const audios = pick(res[1], 'audio');
      const files = [];
      data.assets = { images: [], audio: [], background: null };

      return packAssets(images, 'assets/images/', 'png', data.assets.images, files)
        .then(() => packAssets(audios, 'assets/audio/', 'wav', data.assets.audio, files))
        .then(() => {
          /* 背景图属于「个性化外观」，不是单条对话的一部分 →
             只在整机备份时带走，导出单条对话时跳过（否则每份对话都驮着一张壁纸）。 */
          const bg = (!only && global.Personalize) ? Personalize.getBackground() : null;
          if (bg) {
            const parsed = Zip.dataUrlToBytes(bg);
            if (parsed) {
              const path = 'assets/background.' + extOfMime(parsed.mime, 'jpg');
              files.push({ name: path, data: parsed.bytes });
              data.assets.background = { path, mime: parsed.mime };
            }
          }

          // 清单放在最前面，便于人工检查压缩包内容
          files.unshift({ name: BACKUP_JSON, data: JSON.stringify(data, null, 2) });

          return Zip.create(files);
        });
    });
  }

  /** 导出：组包 → 触发下载 */
  function exportData() {
    const data = Store.exportData();
    if (!data.conversations.length && !data.models.length) Toast.warning(T('noDataToExport'));
    Toast.info(T('exporting'));

    // 打包是同步的重活（base64 解码 + CRC 计算），先让提示渲染出来再开工
    setTimeout(() => {
      buildBackup().then(blob => {
        downloadBlob(blob, 'lynkllm-ce-backup-' + stamp() + '.zip');
        Toast.success(T('exported') + ' · ' + UI.formatBytes(blob.size));
      }).catch(err => {
        const code = err && err.message;
        Toast.error(code === 'too-large' ? T('exportTooLarge') : T('exportFailed'), { duration: 8000 });
      });
    }, 40);
  }

  /** 触发浏览器下载一个 Blob */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 400);
  }

  /** 文件名里安全的对话标题 */
  function slugForFile(s) {
    return String(s || '').trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')   // 各平台文件名禁用字符
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'conversation';
  }

  /**
   * 导出**当前对话**（快捷键 Ctrl+S）。
   * 复用整机备份那套 ZIP 组包，但只带这条对话及其引用到的素材，
   * 所以对方导入后图片/语音都还在。
   */
  function exportConversation(convId) {
    const id = convId || (global.Chat && Chat.convId) || '';
    const conv = id ? Store.getConversation(id) : null;
    if (!conv) { Toast.warning(T('exportNoConv')); return Promise.resolve(false); }

    Toast.info(T('exporting'));
    return new Promise(resolve => {
      // 与整机导出同理：先让提示渲染出来，再做同步的重活
      setTimeout(() => {
        buildBackup({ conversationIds: [id] }).then(blob => {
          downloadBlob(blob, 'lynkllm-ce-chat-' + slugForFile(conv.title) + '-' + stamp() + '.zip');
          Toast.success(T('exported') + ' · ' + UI.formatBytes(blob.size));
          resolve(true);
        }).catch(err => {
          const code = err && err.message;
          Toast.error(code === 'too-large' ? T('exportTooLarge') : T('exportFailed'), { duration: 8000 });
          resolve(false);
        });
      }, 40);
    });
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function readFileBuffer(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('read-failed'));
      fr.readAsArrayBuffer(file);
    });
  }

  function decodeText(buf) {
    try {
      return new TextDecoder('utf-8').decode(buf);
    } catch (e) {
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return decodeURIComponent(escape(s));
    }
  }

  /**
   * 应用一份备份内容（ZIP 或旧版 JSON，按文件头自动识别）
   * @param {ArrayBuffer} ab
   * @returns {Promise<{kind:string, sections?:number, assets?:number}>}
   */
  function applyBackupBuffer(ab) {
    const u8 = new Uint8Array(ab);
    // 以文件头为准（PK\x03\x04），不只看扩展名；否则按旧版 JSON 处理
    const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;
    return isZip ? importZip(ab) : importJsonBuffer(ab);
  }

  function importData(file) {
    if (!file) return;
    Toast.info(T('importing'));
    readFileBuffer(file)
      .then(ab => applyBackupBuffer(ab))
      .then(res => {
        // 附件没能全部还原时如实告知，避免"提示成功、实际少了图"这种静默损失
        const missing = res && res.expected ? Math.max(0, res.expected - (res.assets || 0)) : 0;
        if (missing > 0) {
          Toast.warning(T('importPartial', missing), { duration: 10000 });
          setTimeout(() => global.location.reload(), 4000);   // 留出读提示的时间
        } else {
          Toast.success(T('imported'));
          setTimeout(() => global.location.reload(), 800);
        }
      })
      .catch(err => {
        const code = err && err.message;
        Toast.error(code === 'empty-backup' ? T('importEmpty')
          : (code === 'not-zip' || code === 'bad-archive' || code === 'bad-entry'
            ? T('importNotBackup') : T('importFailed')),
          { duration: 8000 });
      });
  }

  function importJsonBuffer(ab) {
    const obj = JSON.parse(decodeText(new Uint8Array(ab)));
    const n = Store.importData(obj);
    return Promise.resolve({ kind: 'json', sections: n });
  }

  /**
   * 定位备份清单。
   * 位置与文件名都不做硬性要求 —— 现实中很常见的操作是「解压出来看看，再重新压缩」，
   * 于是清单会跑到 `my-backup-2026/lynkllm-ce-backup.json` 这样多套一层的位置；
   * 也可能被用户改成一个更好记的名字。因此以**内容**为准识别。
   * @returns {object|null} 命中的条目
   */
  function pickManifest(entries) {
    const isDir = n => /\/$/.test(String(n));
    // 清单只可能是很小的 JSON，跳过明显过大的文件，避免为了探测去解码几十 MB
    const PROBE_MAX = 32 * 1024 * 1024;
    const pool = entries.filter(e => !isDir(e.name) && e.data
      && e.data.length <= PROBE_MAX && /\.json$/i.test(e.name));
    // 固定名优先，其余按条目顺序（我们导出的包会把清单放在最前面）
    const ordered = pool.filter(e => /(^|\/)lynkllm-ce-backup\.json$/i.test(e.name))
      .concat(pool.filter(e => !/(^|\/)lynkllm-ce-backup\.json$/i.test(e.name)));

    for (const e of ordered) {
      const text = decodeText(e.data);
      if (/"app"\s*:\s*"LynkLLM/.test(text)
        || (/"schemaVersion"\s*:/.test(text) && /"conversations"\s*:/.test(text))) {
        return e;
      }
    }
    return null;
  }

  /** 从 ZIP 备份里恢复配置与全部资源 */
  function importZip(ab) {
    return Zip.read(ab).then(entries => {
      const map = new Map();
      entries.forEach(e => map.set(e.name, e.data));

      const manifestEntry = pickManifest(entries);
      if (!manifestEntry) throw new Error('empty-backup');

      const obj = JSON.parse(decodeText(manifestEntry.data));
      // 资源路径相对「清单所在目录」解析：多套一层目录时前缀会不一样
      const cut = manifestEntry.name.lastIndexOf('/');
      const baseDir = cut >= 0 ? manifestEntry.name.slice(0, cut + 1) : '';
      const look = p => (p ? (map.get(baseDir + p) || map.get(p) || null) : null);
      const sections = Store.importData(obj);

      const assets = obj.assets || {};
      // 清单里声明了几个附件，就期望还原几个：差多少说明备份包不完整（被截断或被人为删过文件）
      const expected = (assets.images || []).length + (assets.audio || []).length
        + (assets.background ? 1 : 0);
      const jobs = [];
      let restored = 0;

      // 逐个还原并周期性让出主线程：base64 编码同样是同步重活，
      // 一次性对几十个附件做编码会让界面冻结好几秒。
      const restoreAssets = (list, store) => (list || []).reduce((chain, a) => chain.then(() => {
        if (!store) return null;
        const bytes = look(a.path);
        if (!bytes || !a.id) return null;
        const meta = assetMeta(a, null);
        delete meta.path;
        delete meta.bytes;      // 交由 save() 按实际内容重新计算
        meta.mime = a.mime;
        restored++;
        jobs.push(store.save(a.id, Zip.bytesToDataUrl(bytes, a.mime), meta));
        return bytes.length >= YIELD_EVERY ? yieldToUI() : null;
      }), Promise.resolve());

      return restoreAssets(assets.images, global.ImageStore)
        .then(() => restoreAssets(assets.audio, global.AudioStore))
        .then(() => {
          const bgBytes = assets.background ? look(assets.background.path) : null;
          if (bgBytes && global.Personalize) {
            restored++;
            // 与「选择本地图片」走同一套压缩：备份里的背景图可能是任意尺寸，
            // 原样塞进去会白白撑大 IndexedDB（也拖慢下次导出）
            jobs.push(UI.compressImage(Zip.bytesToDataUrl(bgBytes, assets.background.mime), 1920, 0.86)
              .then(dataUrl => Personalize.setBackground(dataUrl)));
          }
          return Promise.all(jobs);
        })
        .then(() => ({ kind: 'zip', sections, assets: restored, expected }));
    });
  }

  /* ======================================================================
     事件绑定
     ====================================================================== */
  function bind() {
    const root = $('#settingsBackdrop');
    if (!root) return;

    $('#settingsClose').addEventListener('click', close);
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });

    bindEnhancerUI();
    bindMcpUI();

    $$('.tab', root).forEach(t => {
      t.addEventListener('click', () => switchTab(t.dataset.tab, { animate: true }));
    });

    // 主题
    const segTheme = $('#segTheme');
    segTheme.addEventListener('click', e => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      const v = btn.dataset.value;
      Store.saveSettings({ theme: v });
      setSegmented('#segTheme', v);
      UI.Theme.apply(v);
    });

    // Enter 行为
    const segEnter = $('#segEnter');
    segEnter.addEventListener('click', e => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      const v = btn.dataset.value;
      Store.saveSettings({ enterBehavior: v });
      setSegmented('#segEnter', v);
      if (global.App && App.updateComposerHint) App.updateComposerHint();
    });

    // 语言
    $('#selLang').addEventListener('change', e => {
      const v = e.target.value;
      Store.saveSettings({ lang: v });
      global.I18N.set(v);
      if (global.App) App.refreshI18n();
    });

    // 流式渲染节流：每累计 N 个片段刷新一次界面
    const batchSel = $('#selStreamBatch');
    if (batchSel) {
      batchSel.addEventListener('change', e => {
        Store.saveSettings({ streamRenderBatch: Number(e.target.value) || 1 });
      });
    }

    /* ---- 个性化 ---- */

    // 毛玻璃开关
    const swFx = $('#swFx');
    if (swFx) {
      swFx.addEventListener('change', () => {
        Store.saveSettings({ fx: swFx.checked });
        const st = Store.getSettings();
        if (global.Personalize) Personalize.applyFx(st);
        const row = $('#rowFxStrength');
        if (row) row.classList.toggle('is-disabled', !swFx.checked);
      });
    }

    // 效果强度（拖动时实时预览，松手落盘）
    const rng = $('#rngFxStrength');
    if (rng) {
      const preview = () => {
        const v = Number(rng.value);
        const val = $('#fxStrengthVal');
        if (val) val.textContent = String(v);
        if (global.Personalize) Personalize.applyFx({ fx: true, fxStrength: v });
      };
      rng.addEventListener('input', preview);
      rng.addEventListener('change', () => {
        Store.saveSettings({ fxStrength: Number(rng.value) });
        // 落盘后按真实设置回填，避免与开关状态不一致
        if (global.Personalize) Personalize.applyFx(Store.getSettings());
      });
    }

    // 背景模糊（拖动实时预览，松手落盘）
    const bgBlurRng = $('#rngBgBlur');
    if (bgBlurRng) {
      const previewBg = () => {
        const v = Number(bgBlurRng.value);
        const val = $('#bgBlurVal');
        if (val) val.textContent = String(v);
        if (global.Personalize) Personalize.applyBgBlur(v);
      };
      bgBlurRng.addEventListener('input', previewBg);
      bgBlurRng.addEventListener('change', () => {
        Store.saveSettings({ bgBlur: Number(bgBlurRng.value) });
        if (global.Personalize) Personalize.applyBgBlur(Store.getSettings().bgBlur);
      });
    }

    // 背景图片
    const bgPick = $('#btnBgPick');
    const bgFile = $('#bgFileInput');
    if (bgPick && bgFile) {
      bgPick.addEventListener('click', () => bgFile.click());
      bgFile.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (f) pickBackground(f);
        e.target.value = '';     // 允许重复选择同一张图
      });
    }
    const bgClear = $('#btnBgClear');
    if (bgClear) bgClear.addEventListener('click', clearBackground);

    // 主题色
    const color = $('#accentColor');
    if (color) {
      color.addEventListener('input', () => saveAccent(color.value));
      color.addEventListener('change', () => saveAccent(color.value));
    }
    const accentReset = $('#btnAccentReset');
    if (accentReset) accentReset.addEventListener('click', () => {
      saveAccent('');
      Toast.success(T('accentResetDone'));
    });

    // 模型类型子标签（全部 / 对话 / 图片 / 语音）
    const kindTabs = $('#modelKindTabs');
    if (kindTabs) {
      kindTabs.addEventListener('click', e => {
        const btn = e.target.closest('.subtab');
        if (!btn) return;
        Settings.kindFilter = btn.dataset.kind || 'all';
        renderModelList();
      });
    }

    // 「工具」里的子标签（当前只有 Tavily；后续工具复用同一段逻辑）
    const toolTabs = $('#toolTabs');
    if (toolTabs) {
      toolTabs.addEventListener('click', e => {
        const btn = e.target.closest('.subtab');
        if (!btn || !btn.dataset.tool) return;
        switchTool(btn.dataset.tool);
      });
    }

    // 模型搜索
    const mSearch = $('#modelSearchInput');
    if (mSearch) {
      mSearch.addEventListener('input', () => {
        Settings.modelQuery = mSearch.value;
        const clr = $('#btnClearModelSearch');
        if (clr) clr.hidden = !Settings.modelQuery;
        // 只重绘列表，输入焦点保持在搜索框
        renderModelList();
      });
      mSearch.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); Settings.modelQuery = ''; mSearch.value = ''; renderModelList(); }
        e.stopPropagation();
      });
    }
    const mClear = $('#btnClearModelSearch');
    if (mClear) {
      mClear.addEventListener('click', () => {
        Settings.modelQuery = '';
        const i = $('#modelSearchInput');
        if (i) { i.value = ''; i.focus(); }
        renderModelList();
      });
    }

    // Tavily
    const tavilyKey = $('#tavilyKey');
    if (tavilyKey) {
      tavilyKey.addEventListener('change', () => saveTavilyKey(true));
      tavilyKey.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveTavilyKey(false); }
      });
    }
    const tglTavily = $('#btnToggleTavilyKey');
    if (tglTavily) {
      tglTavily.addEventListener('click', () => {
        const input = $('#tavilyKey');
        const isPwd = input.type === 'password';
        input.type = isPwd ? 'text' : 'password';
        const i = tglTavily.firstElementChild;
        if (i) i.className = isPwd ? 'bi bi-eye-slash' : 'bi bi-eye';
      });
    }
    const btnTavilySave = $('#btnTavilySave');
    if (btnTavilySave) btnTavilySave.addEventListener('click', () => saveTavilyKey(false));
    const btnTavilyTest = $('#btnTavilyTest');
    if (btnTavilyTest) btnTavilyTest.addEventListener('click', testTavily);

    const btnResetParams = $('#btnTavilyResetParams');
    if (btnResetParams) btnResetParams.addEventListener('click', resetTavilyParams);

    const btnPwa = $('#btnPwaInstall');
    if (btnPwa) btnPwa.addEventListener('click', () => {
      if (global.App && App.installPwa) {
        App.installPwa().then(ok => {
          Toast[ok ? 'success' : 'info'](ok ? T('pwaInstalled') : T('pwaUnavailable'));
          syncPwaUI();
        });
      }
    });

    // 模型编辑：类型切换
    const segKind = $('#segModelKind');
    if (segKind) {
      segKind.addEventListener('click', e => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        const v = btn.dataset.value;
        setSegmented('#segModelKind', v);
        applyKindUI(v);
      });
    }

    // 开关
    const bindSwitch = (id, key, after) => {
      const n = $(id);
      if (!n) return;
      n.addEventListener('change', () => {
        Store.saveSettings({ [key]: n.checked });
        if (after) after(n.checked);
      });
    };
    bindSwitch('#swRichRender', 'richRender', () => {
      Chat.renderMessages();
    });
    bindSwitch('#swShowTokens', 'showTokens', () => {
      Chat.renderMessages();
    });
    bindSwitch('#swStream', 'stream');

    // 自动对话标题：三选一 + 指定模型
    const selAuto = $('#selAutoTitle');
    if (selAuto) {
      selAuto.addEventListener('change', e => {
        const mode = e.target.value;
        const patch = { autoTitleMode: mode, autoTitle: mode !== 'first' };
        // 切到「指定模型」时，若尚未指定则默认选第一个模型
        if (mode === 'model') {
          const cur = Store.getSettings().titleModelId;
          if (!cur || !Store.getModel(cur)) {
            const first = Store.getModels()[0];
            if (first) patch.titleModelId = first.id;
          }
        }
        Store.saveSettings(patch);
        syncTitleModelRow(mode);
        renderTitleModelSelect(Store.getSettings());
      });
    }

    // 标题模型
    const selTitle = $('#selTitleModel');
    if (selTitle) {
      selTitle.addEventListener('change', e => {
        Store.saveSettings({ titleModelId: e.target.value });
      });
    }

    // 数据
    $('#btnClearAll').addEventListener('click', clearAll);
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#importInput').click());
    $('#importInput').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      importData(f);
    });

    // 模型管理
    $('#btnAddModel').addEventListener('click', () => openModelEditor(null));
    $('#modelEditClose').addEventListener('click', closeModelEditor);
    $('#modelCancel').addEventListener('click', closeModelEditor);
    $('#modelSave').addEventListener('click', saveModel);
    $('#btnTestConn').addEventListener('click', testConnection);
    $('#btnFetchModels').addEventListener('click', fetchModels);
    $('#btnThinkingAll').addEventListener('click', () => setAllThinkingLevels(true));
    $('#btnThinkingNone').addEventListener('click', () => setAllThinkingLevels(false));
    $('#btnToggleKey').addEventListener('click', () => {
      const input = $('#mfKey');
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      const i = $('#btnToggleKey').firstElementChild;
      if (i) i.className = isPwd ? 'bi bi-eye-slash' : 'bi bi-eye';
    });

    // Base URL 失焦时自动规范化（去掉末尾斜杠）
    const urlInput = $('#mfBaseUrl');
    if (urlInput) {
      urlInput.addEventListener('blur', () => {
        const v = normalizeBaseUrl(urlInput.value);
        if (v !== urlInput.value) urlInput.value = v;
      });
      urlInput.addEventListener('paste', () => {
        setTimeout(() => {
          const v = normalizeBaseUrl(urlInput.value);
          if (v !== urlInput.value) urlInput.value = v;
        }, 0);
      });
    }

    const backdrop = $('#modelBackdrop');
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModelEditor(); });

    // 表单内回车提交
    ['#mfName', '#mfBaseUrl', '#mfKey', '#mfModel', '#mfContext'].forEach(sel => {
      const n = $(sel);
      if (n) n.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveModel(); }
      });
    });
  }

  Settings.open = open;
  Settings.close = close;
  Settings.switchTab = switchTab;
  Settings.renderModelList = renderModelList;
  Settings.renderKindTabs = renderKindTabs;
  Settings.renderDataStats = renderDataStats;
  Settings.renderTitleModelSelect = renderTitleModelSelect;
  Settings.renderModelChoices = renderModelChoices;
  Settings.applyKindUI = applyKindUI;
  Settings.syncGeneralUI = syncGeneralUI;
  Settings.renderVersion = renderVersion;
  Settings.syncPwaUI = syncPwaUI;
  Settings.syncTavilyUI = syncTavilyUI;
  Settings.renderTavilyManual = renderTavilyManual;
  Settings.syncPersonalizeUI = syncPersonalizeUI;
  Settings.syncEnhancerUI = syncEnhancerUI;
  Settings.applyCorsBypassUI = applyCorsBypassUI;
  Settings.renderAccentPresets = renderAccentPresets;
  Settings.pickBackground = pickBackground;
  Settings.clearBackground = clearBackground;
  Settings.buildBackup = buildBackup;
  Settings.applyBackupBuffer = applyBackupBuffer;
  Settings.testTavily = testTavily;
  Settings.applyI18n = applyI18n;
  Settings.bind = bind;
  Settings.setSegmented = setSegmented;
  /* 第 13 轮新增 */
  Settings.exportConversation = exportConversation;
  Settings.downloadBlob = downloadBlob;
  Settings.switchTool = switchTool;
  Settings.renderMcpList = renderMcpList;
  Settings.renderShortcutTable = renderShortcutTable;
  Settings.openModelEditor = openModelEditor;
  Settings.openMcpEditor = openMcpEditor;
  Settings.closeMcpEditor = closeMcpEditor;
  Settings.readMcpForm = readMcpForm;
  Settings.saveMcp = saveMcp;
  Settings.testMcp = testMcp;
  Settings.applyMcpCorsUI = applyMcpCorsUI;
  Settings.renderHeaderRows = renderHeaderRows;
  Settings.readHeaderRows = readHeaderRows;

  global.Settings = Settings;
})(window);
