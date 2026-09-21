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
    editing: null        // 正在编辑的模型副本
  };

  function T(k, ...a) { return global.I18N.t(k, ...a); }

  /* ======================================================================
     打开 / 关闭 / Tab
     ====================================================================== */
  function open(tab) {
    const root = $('#settingsBackdrop');
    if (!root) return;
    Settings.openTab = tab || Settings.openTab || 'general';
    syncGeneralUI();
    syncTavilyUI();
    renderModelList();
    switchTab(Settings.openTab);
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

  function switchTab(name) {
    Settings.openTab = name;
    $$('#settingsBackdrop .tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('#settingsBackdrop .tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    // 标题始终为「设置」，不随标签页变化
    const title = $('#settingsTitle');
    if (title) title.textContent = T('settings');
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

    if (!Store.storageAvailable) {
      box.appendChild(el('div', { class: 'stat-card', style: { gridColumn: '1 / -1', borderColor: 'var(--warning)' } }, [
        el('div', { class: 'stat-label', style: { color: 'var(--warning)' }, text: 'localStorage unavailable — memory only' })
      ]));
    }
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
    renderTavilyParams();
    renderVersion();
  }

  /** 生成「可交给模型决定的参数」清单，并标出已被用户手动指定的项 */
  function renderTavilyParams() {
    const box = $('#tavilyParams');
    if (!box) return;
    clear(box);
    const forced = Store.getTavilyForced();
    const fmt = {
      topic: 'general | news | finance',
      search_depth: 'basic | advanced | fast | ultra-fast',
      chunks_per_source: '1 – 3',
      max_results: '1 – 20',
      time_range: 'day | week | month | year',
      start_date: 'YYYY-MM-DD',
      end_date: 'YYYY-MM-DD',
      include_answer: 'boolean',
      include_raw_content: 'boolean',
      include_images: 'boolean',
      include_image_descriptions: 'boolean',
      include_favicon: 'boolean',
      include_domains: 'string[]',
      exclude_domains: 'string[]',
      country: 'string',
      auto_parameters: 'boolean',
      include_usage: 'boolean'
    };
    const names = ['query'].concat(Store.TAVILY_PARAM_SCHEMA.map(f => f.key));
    names.forEach(name => {
      const isQuery = name === 'query';
      const isForced = !isQuery && Object.prototype.hasOwnProperty.call(forced, name);
      const chip = el('span', {
        class: 'tp-chip' + (isForced ? ' is-forced' : ''),
        title: isForced ? T('tavilyParamForced') : ''
      }, [
        el('span', { class: 'tp-name', text: name }),
        el('span', { class: 'tp-type', text: isQuery ? 'string' : (fmt[name] || 'any') })
      ]);
      if (isForced) chip.appendChild(el('i', { class: 'bi bi-lock-fill tp-lock' }));
      box.appendChild(chip);
    });
  }

  /* ---------- Tavily 手动指定参数 ---------- */

  /** 依据 schema 渲染「手动指定」表单（空值 = 交给模型决定） */
  function renderTavilyManual() {
    const box = $('#tavilyManual');
    if (!box) return;
    clear(box);
    const cur = Store.getTavily().params;
    const schema = Store.TAVILY_PARAM_SCHEMA || [];

    schema.forEach(f => {
      const row = el('div', { class: 'tm-row' });
      row.appendChild(el('label', { class: 'tm-label mono', for: 'tmp_' + f.key, text: f.key }));

      const ctrl = el('div', { class: 'tm-ctrl' });
      const v = cur[f.key];

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
  }

  /** 把「手动指定」表单写回存储 */
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
    renderTavilyParams();
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  function resetTavilyParams() {
    Store.saveTavily({ params: null });
    renderTavilyManual();
    renderTavilyParams();
    if (global.App && App.onModelChanged) App.onModelChanged();
    Toast.success(T('tavilyParamsCleared'));
  }

  /** Tavily 面板里所有输入的可编辑状态 */
  function setTavilyEditable(on) {
    ['#tavilyKey', '#btnTavilySave', '#btnTavilyResetParams'].forEach(sel => {
      const n = $(sel);
      if (n) n.disabled = !on;
    });
    $$('[data-tkey]', $('#tavilyManual') || document).forEach(n => { n.disabled = !on; });
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
            el('i', { class: 'bi bi-brain' }),
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

  /** 常用音色快捷填入（仍可自由输入其他音色 ID） */
  function renderVoicePresets() {
    const box = $('#voicePresets');
    if (!box) return;
    clear(box);
    const input = $('#mfVoice');
    (global.API && API.VOICE_PRESETS ? API.VOICE_PRESETS : []).forEach(v => {
      const chip = el('button', { class: 'voice-chip', type: 'button', text: v });
      chip.addEventListener('click', () => {
        if (!input) return;
        input.value = v;
        input.focus();
        $$('.voice-chip', box).forEach(c => c.classList.toggle('active', c.textContent === v));
      });
      box.appendChild(chip);
    });
    if (input) {
      $$('.voice-chip', box).forEach(c => c.classList.toggle('active', c.textContent === input.value));
    }
  }

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
      tools: $('#mfTools'),
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

    // 语音合成专属字段
    renderVoicePresets();
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
      // 生成图片 / 合成语音存在 IndexedDB，需要单独清空
      const done = () => {
        Toast.success(T('allCleared'));
        setTimeout(() => global.location.reload(), 500);
      };
      const jobs = [];
      if (global.ImageStore) jobs.push(ImageStore.clear().catch(() => false));
      if (global.AudioStore) jobs.push(AudioStore.clear().catch(() => false));
      if (jobs.length) Promise.all(jobs).then(done).catch(done);
      else done();
    });
  }

  function exportData() {
    const data = Store.exportData();
    if (!data.conversations.length && !data.models.length) {
      Toast.warning(T('noDataToExport'));
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'lynkllm-ce-backup-' + stamp() + '.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 300);
    Toast.success(T('exported'));
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function importData(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const obj = JSON.parse(fr.result);
        Store.importData(obj);
        Toast.success(T('imported'));
        setTimeout(() => global.location.reload(), 700);
      } catch (e) {
        Toast.error(T('importFailed'));
      }
    };
    fr.onerror = () => Toast.error(T('importFailed'));
    fr.readAsText(file);
  }

  /* ======================================================================
     事件绑定
     ====================================================================== */
  function bind() {
    const root = $('#settingsBackdrop');
    if (!root) return;

    $('#settingsClose').addEventListener('click', close);
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });

    $$('.tab', root).forEach(t => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
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

    // 模型类型子标签（全部 / 对话 / 图片）
    const kindTabs = $('#modelKindTabs');
    if (kindTabs) {
      kindTabs.addEventListener('click', e => {
        const btn = e.target.closest('.subtab');
        if (!btn) return;
        Settings.kindFilter = btn.dataset.kind || 'all';
        renderModelList();
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
  Settings.renderTavilyParams = renderTavilyParams;
  Settings.testTavily = testTavily;
  Settings.applyI18n = applyI18n;
  Settings.bind = bind;
  Settings.setSegmented = setSegmented;

  global.Settings = Settings;
})(window);
