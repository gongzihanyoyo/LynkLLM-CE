/* ==========================================================================
   LynkLLM CE — 设置面板：常规 + 模型管理
   ========================================================================== */
(function (global) {
  'use strict';

  const { $, $$, el, clear, Toast, Popover, Confirm, copyText } = UI;

  const Settings = {
    openTab: 'general',
    editing: null   // 正在编辑的模型副本
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

    const sw = (id, v) => { const n = $(id); if (n) n.checked = !!v; };
    sw('#swRichRender', st.richRender);
    sw('#swShowTokens', st.showTokens);
    sw('#swStream', st.stream);

    renderAutoTitleUI(st);
    renderDataStats();

    // 静态文本 i18n
    applyI18n($('#settingsBackdrop'));
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
    Store.getModels().forEach(m => {
      sel.appendChild(el('option', { value: m.id, text: m.name + ' · ' + (m.model || '') }));
    });
    if (!Store.getModels().length) {
      sel.appendChild(el('option', { value: '', text: T('noModels') }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    if (st.titleModelId && Store.getModel(st.titleModelId)) sel.value = st.titleModelId;
    else sel.value = Store.getModels()[0].id;
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
     模型列表
     ====================================================================== */
  function renderModelList() {
    const box = $('#modelList');
    if (!box) return;
    clear(box);
    const models = Store.getModels();
    const curId = Chat.currentModelId();

    if (!models.length) {
      const empty = el('div', { class: 'empty-inline' }, [
        el('i', { class: 'bi bi-hdd-stack' }),
        el('div', { text: T('noModels') })
      ]);
      box.appendChild(empty);
      return;
    }

    models.forEach(m => {
      const card = el('div', { class: 'model-card' + (m.id === curId ? ' is-current' : '') });

      card.appendChild(el('div', { class: 'model-card-icon' }, [
        el('i', { class: 'bi ' + (m.supportsImages ? 'bi-image' : 'bi-cpu') })
      ]));

      const titleRow = el('div', { class: 'model-card-name' }, [document.createTextNode(m.name)]);
      if (m.id === curId) titleRow.appendChild(el('span', { class: 'model-tag', text: T('using') }));
      if (m.supportsImages) titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
        el('i', { class: 'bi bi-image' }), document.createTextNode(T('modelVision'))
      ]));
      titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
        el('i', { class: 'bi ' + (m.supportsStream ? 'bi-lightning-charge' : 'bi-dash-circle') }),
        document.createTextNode(m.supportsStream ? T('modelStream') : T('modelNoStream'))
      ]));
      if (m.thinkingLevels && m.thinkingLevels.length) {
        titleRow.appendChild(el('span', { class: 'model-tag muted' }, [
          el('i', { class: 'bi bi-brain' }),
          document.createTextNode(String(m.thinkingLevels.length))
        ]));
      }

      const metaText = [m.model || '—', shortenUrl(m.baseUrl)].filter(Boolean).join('  ·  ');
      const bodyNode = el('div', { class: 'model-card-body' }, [
        titleRow,
        el('div', { class: 'model-card-meta', text: metaText, title: m.baseUrl })
      ]);

      const actions = el('div', { class: 'model-card-actions' });

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
      // 若当前对话使用该模型，切到第一个
      const convs = Store.getConversations();
      let changed = false;
      convs.forEach(c => {
        if (c.modelId === m.id) {
          const first = Store.getModels()[0];
          c.modelId = first ? first.id : '';
          c.thinking = (first && first.thinkingLevels && first.thinkingLevels[0]) || '';
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
    { value: 'none', label: 'none — 关闭思考' },
    { value: 'off', label: 'off — 关闭思考（别名）' },
    { value: 'minimal', label: 'minimal — 最低' },
    { value: 'low', label: 'low — 低' },
    { value: 'medium', label: 'medium — 中' },
    { value: 'high', label: 'high — 高' },
    { value: 'xhigh', label: 'xhigh — 极高' },
    { value: 'maximum', label: 'maximum — 最高' },
    { value: 'auto', label: 'auto — 由模型自行决定' }
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
      system: $('#mfSystem'), vision: $('#mfVision'), stream: $('#mfStream')
    };
    const m = Settings.editing;
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

    const keyInput = f.key;
    keyInput.type = 'password';
    const eyeBtn = $('#btnToggleKey');
    if (eyeBtn && eyeBtn.firstElementChild) eyeBtn.firstElementChild.className = 'bi bi-eye';

    $('#modelEditTitle').textContent = isNew ? T('addModel') : T('editModel');
    const dl = $('#modelOptions');
    if (dl) clear(dl);
    hideTestResult();
    applyI18n($('#modelBackdrop'));
    UI.openModal($('#modelBackdrop'));
    setTimeout(() => f.name.focus(), 60);
  }

  function closeModelEditor() {
    UI.closeModal($('#modelBackdrop'));
    Settings.editing = null;
  }

  function readModelForm() {
    return {
      id: Settings.editing ? Settings.editing.id : '',
      name: $('#mfName').value.trim(),
      baseUrl: normalizeBaseUrl($('#mfBaseUrl').value),
      apiKey: $('#mfKey').value.trim(),
      model: $('#mfModel').value.trim(),
      contextLength: Number($('#mfContext').value) || 0,
      thinkingLevels: readThinkingLevels(),
      systemPrompt: $('#mfSystem').value,
      supportsImages: $('#mfVision').checked,
      supportsStream: $('#mfStream').checked
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
        fillModelOptions(res.models);
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

  function fillModelOptions(list) {
    const dl = $('#modelOptions');
    if (!dl) return;
    clear(dl);
    (list || []).forEach(m => {
      if (m && m.id) dl.appendChild(el('option', { value: m.id }));
    });
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
      fillModelOptions(list);
      if (hint) hint.textContent = list.length ? T('modelsFound', list.length) : T('modelsNone');
      Toast.success(list.length ? T('modelsFound', list.length) : T('modelsNone'));
      const input = $('#mfModel');
      if (input && !input.value && list.length) input.value = list[0].id;
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
      const keepTheme = Store.getSettings().theme;
      Store.clearAll();
      Toast.success(T('allCleared'));
      setTimeout(() => global.location.reload(), 500);
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
  Settings.renderDataStats = renderDataStats;
  Settings.renderTitleModelSelect = renderTitleModelSelect;
  Settings.syncGeneralUI = syncGeneralUI;
  Settings.applyI18n = applyI18n;
  Settings.bind = bind;
  Settings.setSegmented = setSegmented;

  global.Settings = Settings;
})(window);
