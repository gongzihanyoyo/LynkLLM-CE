/* ==========================================================================
   LynkLLM CE — 对话引擎与消息渲染
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = UI.$;
  const el = UI.el;
  const clear = UI.clear;
  const copyText = UI.copyText;
  const Toast = UI.Toast;
  const Popover = UI.Popover;

  const STREAM_RENDER_INTERVAL = 70;   // 流式渲染节流（ms）
  const MAX_HISTORY_MESSAGES = 60;     // 发送给 API 的最大历史条数

  const Chat = {
    convId: '',
    /** 尚未落盘的临时对话（新建后、首条消息发出前） */
    pendingConv: null,
    pendingImages: [],
    generating: false,
    controller: null,
    /** 消息 id -> DOM 节点（用于流式增量更新） */
    _nodes: new Map()
  };

  function T(k, ...a) { return global.I18N.t(k, ...a); }
  function settings() { return Store.getSettings(); }

  /* ======================================================================
     消息 DOM
     ====================================================================== */

  function buildMsgRow(msg) {
    const isUser = msg.role === 'user';
    const avatar = el('div', { class: 'msg-avatar' });
    if (isUser) {
      avatar.appendChild(el('i', { class: 'bi bi-person-fill' }));
    } else {
      avatar.classList.add('has-logo');
      avatar.appendChild(el('img', { class: 'avatar-logo', src: 'assets/img/logo-64.png', alt: '' }));
    }

    const roleLabel = el('div', { class: 'msg-role' },
      [isUser ? T('you') : T('assistant')]);

    const body = el('div', { class: 'msg-body' });

    const col = el('div', { class: 'msg-col' }, [roleLabel, body]);
    const row = el('div', {
      class: 'msg-row ' + (isUser ? 'user' : 'assistant'),
      dataset: { id: msg.id, role: msg.role }
    }, [avatar, col]);

    return { row, body, col };
  }

  /** 用户消息渲染 */
  function renderUserBody(bodyEl, msg) {
    clear(bodyEl);
    bodyEl.classList.remove('md');
    const imgs = Array.isArray(msg.images) ? msg.images.filter(i => i && i.dataUrl) : [];
    if (imgs.length) {
      const wrap = el('div', { class: 'msg-images' });
      imgs.forEach(img => {
        wrap.appendChild(el('img', {
          class: 'msg-thumb', src: img.dataUrl, alt: img.name || 'image',
          loading: 'lazy', dataset: { zoom: '1' }
        }));
      });
      bodyEl.appendChild(wrap);
    }
    if (msg.content) {
      bodyEl.appendChild(el('div', { class: 'md-user-text', text: msg.content }));
      bodyEl.firstChild.style.whiteSpace = 'pre-wrap';
    }
  }

  /* ---------- 思维链折叠块 ---------- */
  /**
   * 创建思维链折叠块。
   * @param {string} text 思维链内容
   * @param {'live'|'done'} mode live=仍在思考（默认展开），done=已开始输出正文（默认折叠）
   * @param {boolean} [forceOpen] 强制展开/折叠（用于保留用户手动切换的状态）
   */
  function buildReasoningBlock(text, mode, forceOpen) {
    const live = mode === 'live';
    const open = forceOpen != null ? !!forceOpen : live;

    const box = el('div', { class: 'reasoning' + (open ? ' open' : '') + (live ? ' live' : ' collapsed-done') });

    const head = el('button', { class: 'reasoning-head', type: 'button' }, [
      el('i', { class: 'bi bi-brain' }),
      el('span', { class: 'reasoning-label', text: live ? T('reasoningThinking') : T('reasoningDone') }),
      el('span', { class: 'reasoning-meta', text: T('reasoningChars', String(text || '').length) }),
      el('i', { class: 'bi bi-chevron-down reasoning-caret' })
    ]);

    const body = el('div', { class: 'reasoning-body', text: text || '' });

    head.addEventListener('click', () => {
      const isOpen = box.classList.toggle('open');
      head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      // 用户手动操作后，标记以免被自动折叠覆盖
      box.dataset.userToggled = '1';
    });
    head.setAttribute('aria-expanded', open ? 'true' : 'false');

    box.appendChild(head);
    box.appendChild(body);
    return box;
  }

  /** 就地更新思维链块内容（流式场景，避免重建导致滚动跳动） */
  function updateReasoningBlock(box, text, mode) {
    if (!box) return;
    const body = box.querySelector('.reasoning-body');
    const meta = box.querySelector('.reasoning-meta');
    const label = box.querySelector('.reasoning-label');
    const atBottom = body ? (body.scrollHeight - body.scrollTop - body.clientHeight < 24) : true;
    if (body) body.textContent = text || '';
    if (meta) meta.textContent = T('reasoningChars', String(text || '').length);
    if (label) label.textContent = mode === 'live' ? T('reasoningThinking') : T('reasoningDone');
    box.classList.toggle('live', mode === 'live');
    // 用户未手动干预时跟随内容自动滚动
    if (atBottom && body) body.scrollTop = body.scrollHeight;
  }

  /** 思维链从「思考中」切换到「已完成」：自动折叠（除非用户手动展开过） */
  function collapseReasoningBlock(box) {
    if (!box) return;
    box.classList.remove('live');
    box.classList.add('collapsed-done');
    const label = box.querySelector('.reasoning-label');
    if (label) label.textContent = T('reasoningDone');
    // 头部文案与计数在折叠态也保持更新
    const meta = box.querySelector('.reasoning-meta');
    const body = box.querySelector('.reasoning-body');
    if (meta && body) meta.textContent = T('reasoningChars', String(body.textContent || '').length);
    if (box.dataset.userToggled === '1') return;   // 尊重用户选择
    box.classList.remove('open');
    const head = box.querySelector('.reasoning-head');
    if (head) head.setAttribute('aria-expanded', 'false');
  }

  /** 助手消息渲染（含 Markdown 增强） */
  function renderAssistantBody(bodyEl, msg) {
    bodyEl.classList.add('md');
    if (msg.error) {
      clear(bodyEl);
      bodyEl.classList.remove('md');
      bodyEl.appendChild(buildErrorBlock(msg.error));
      return;
    }
    if (!msg.content) {
      // 只有思维链没有正文时也要展示思维链
      if (msg.reasoning) {
        clear(bodyEl);
        bodyEl.appendChild(buildReasoningBlock(msg.reasoning, 'done', false));
        return;
      }
      clear(bodyEl);
      return;
    }
    let html;
    try {
      html = MD.toHtml(msg.content);
    } catch (e) {
      console.error('[chat] 渲染失败', e);
      html = '<div class="md-plaintext">' + UI.escapeHtml(msg.content) + '</div>';
    }
    clear(bodyEl);
    // 历史消息中的思维链默认折叠，用户可展开
    if (msg.reasoning) {
      bodyEl.appendChild(buildReasoningBlock(msg.reasoning, 'done', false));
    }
    const contentWrap = el('div', { class: 'md-content' });
    contentWrap.innerHTML = html;
    bodyEl.appendChild(contentWrap);
    MD.enhance(contentWrap).catch(() => {});
    if (msg.streaming) appendCursor(bodyEl);
  }

  function appendCursor(bodyEl) {
    let c = bodyEl.querySelector(':scope > .cursor-blink');
    if (!c) {
      c = el('span', { class: 'cursor-blink' });
      bodyEl.appendChild(c);
    }
  }

  function removeCursor(bodyEl) {
    const c = bodyEl.querySelector(':scope > .cursor-blink');
    if (c) c.remove();
  }

  function buildErrorBlock(err) {
    const box = el('div', { class: 'msg-error' });
    box.appendChild(el('div', { class: 'err-title' }, [
      el('i', { class: 'bi bi-exclamation-triangle-fill' }),
      err.title || T('requestFailed')
    ]));
    if (err.message) box.appendChild(el('div', { text: err.message }));
    if (err.detail) {
      const det = el('details');
      det.appendChild(el('summary', { text: 'raw response' }));
      det.appendChild(el('pre', { text: String(err.detail).slice(0, 2000) }));
      box.appendChild(det);
    }
    return box;
  }

  /* ---------- Token 用量 ---------- */
  /** 四项固定顺序：输入（缓存） · 输入（非缓存） · 输出 · 总计 */
  function buildUsageChip(usage, opts) {
    opts = opts || {};
    if (!usage) return null;
    const chip = el('span', { class: 'token-usage', title: T('tokensUnit') });
    chip.appendChild(el('i', { class: 'bi bi-bar-chart-line' }));

    const num = (v) => (v == null || isNaN(v)) ? '—' : String(v);

    if (usage.estimated) {
      chip.appendChild(el('span', {}, [
        el('b', { text: '~' + num(usage.total) }),
        document.createTextNode(' ' + T('tokenEstimated'))
      ]));
      return chip;
    }

    const hit = usage.inputHit != null ? usage.inputHit : 0;
    const miss = usage.inputMiss != null
      ? usage.inputMiss
      : (usage.input != null ? Math.max(0, usage.input - hit) : null);
    const out = usage.output != null ? usage.output : null;
    const total = usage.total != null
      ? usage.total
      : ((miss != null || hit != null || out != null) ? ((miss || 0) + (hit || 0) + (out || 0)) : null);

    const parts = [
      [T('tokenInHit'), num(hit)],
      [T('tokenInMiss'), num(miss)],
      [T('tokenOut'), num(out)],
      [T('tokenTotal'), num(total)]
    ];

    parts.forEach((p, i) => {
      if (i) chip.appendChild(el('span', { text: '·' }));
      const item = el('span', { class: 'tu-item' }, [
        el('b', { text: p[0] }),
        document.createTextNode(' ' + p[1])
      ]);
      // 缓存命中为 0 时弱化显示，避免视觉噪音
      if (i === 0 && !hit) item.classList.add('tu-zero');
      chip.appendChild(item);
    });

    return chip;
  }

  /* ---------- 消息操作条 ---------- */
  /**
   * @param {object} msg 消息
   * @param {object} ctx 操作回调
   * @param {boolean} [isLatest] 是否属于最新一轮对话；非最新轮次隐藏「编辑 / 重新生成」
   */
  function buildActions(msg, ctx, isLatest) {
    const latest = isLatest !== false;
    const bar = el('div', { class: 'msg-actions' });
    const st = settings();

    const mkAction = (icon, label, cls, fn) => {
      const b = el('button', { class: 'msg-action' + (cls ? ' ' + cls : ''), type: 'button' }, [
        el('i', { class: 'bi ' + icon }), document.createTextNode(label)
      ]);
      b.addEventListener('click', () => fn());
      return b;
    };

    if (msg.role === 'assistant' && msg.content) {
      bar.appendChild(mkAction('bi-clipboard', T('copy'), '', () => copyText(msg.content)));

      if (latest) {
        bar.appendChild(mkAction('bi-arrow-clockwise', T('regenerate'), '', () => ctx.onRegenerate(msg)));
      }

      if (st.showTokens !== false && msg.usage) {
        const chip = buildUsageChip(msg.usage);
        if (chip) bar.appendChild(chip);
      } else if (st.showTokens !== false && ctx.getUsage) {
        const u = ctx.getUsage(msg);
        if (u) { const c = buildUsageChip(u); if (c) bar.appendChild(c); }
      }
    }

    if (msg.role === 'user') {
      bar.appendChild(mkAction('bi-clipboard', T('copy'), '', () => copyText(msg.content || '')));
      if (latest) {
        bar.appendChild(mkAction('bi-pencil', T('edit'), '', () => ctx.onEdit(msg)));
      }
    }

    if (msg.error && msg.role === 'assistant' && latest) {
      bar.appendChild(mkAction('bi-arrow-repeat', T('regenerate'), '', () => ctx.onRegenerate(msg)));
    }

    // 任意消息均可单独删除
    bar.appendChild(mkAction('bi-trash3', T('delete'), 'danger', () => ctx.onDelete(msg)));

    return bar.children.length ? bar : null;
  }

  /* ======================================================================
     对话操作
     ====================================================================== */

  /**
   * 新建对话。
   * 注意：这里只创建一个「未落盘」的临时对话（pending），不会立即写入存储，
   * 因此也不会出现在侧边栏列表中；直到用户发出第一条消息时才正式保存。
   */
  function newConversation(opts) {
    opts = opts || {};
    const pending = Chat.pendingConv;
    if (pending && !pending.messages.length && !opts.force) {
      // 复用尚未使用的临时对话，避免产生多个空壳
      if (opts.modelId) pending.modelId = opts.modelId;
      if (opts.thinking != null) pending.thinking = opts.thinking;
      return pending;
    }
    const conv = {
      id: Store.uid('conv'),
      title: '',
      titleAuto: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId: opts.modelId || Chat.lastModelId || '',
      thinking: opts.thinking || '',
      messages: [],
      pending: true
    };
    Chat.pendingConv = conv;
    return conv;
  }

  function getConv() {
    if (!Chat.convId) return null;
    const pending = Chat.pendingConv;
    if (pending && pending.id === Chat.convId) return pending;
    return Store.getConversation(Chat.convId);
  }

  /** 更新对话时间戳并持久化（临时对话不入库） */
  function touch(conv) {
    if (!conv) return;
    conv.updatedAt = Date.now();
    if (!conv.pending) Store.upsertConversation(conv);
    updateContextWarning();
  }

  /** 首次发送消息时把临时对话正式写入存储 */
  function commitPending(conv) {
    if (!conv || !conv.pending) return false;
    // 移除临时标记，保持落盘数据结构与历史版本一致
    delete conv.pending;
    if (Chat.pendingConv === conv) Chat.pendingConv = null;
    conv.updatedAt = Date.now();
    Store.upsertConversation(conv);
    Store.setActiveId(conv.id);
    return true;
  }

  /** 丢弃当前未落盘的临时对话 */
  function discardPending() {
    const pending = Chat.pendingConv;
    if (!pending) return;
    if (pending.id === Chat.convId) Chat.convId = '';
    Chat.pendingConv = null;
  }

  function setConversation(id) {
    if (Chat.pendingConv && Chat.pendingConv.id !== id) Chat.pendingConv = null;
    Chat.convId = id;
    const conv = getConv();
    if (conv && !conv.pending) Store.setActiveId(id);
    Chat.pendingImages = [];
    renderAttachmentBar();
    renderMessages();
    if (global.App && App.onConversationChanged) App.onConversationChanged();
  }

  /** 开始一个新对话（视图立即切换，列表等待首条消息） */
  function startNewChat() {
    const conv = newConversation();
    Chat.convId = conv.id;
    Chat.pendingImages = [];
    renderAttachmentBar();
    renderMessages();
    if (global.App && App.onConversationChanged) App.onConversationChanged();
    return conv;
  }

  /** 计算「最新一轮」消息 id 集合：最后一条用户消息 + 其后的所有助手消息 */
  function latestRoundIds(conv) {
    const ids = new Set();
    if (!conv || !conv.messages.length) return ids;
    const msgs = conv.messages;
    let lastUserIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') lastUserIdx = i;
    }
    msgs.forEach((m, i) => {
      if (m.role === 'user') {
        if (i === lastUserIdx) ids.add(m.id);
      } else if (i > lastUserIdx) {
        ids.add(m.id);
      }
    });
    return ids;
  }

  /** 消息增删后，就地重建各条消息的操作条（控制编辑/重新生成的显示） */
  function syncActionBars(conv) {
    conv = conv || getConv();
    if (!conv) return;
    const latest = latestRoundIds(conv);
    conv.messages.forEach(msg => {
      const node = Chat._nodes.get(msg.id);
      if (!node || !node.col) return;
      const old = node.col.querySelector(':scope > .msg-actions');
      if (old) old.remove();
      const actions = buildActions(msg, actionCtx(), latest.has(msg.id));
      if (actions) node.col.appendChild(actions);
    });
  }

  /* ---------- 渲染整条会话 ---------- */
  function renderMessages() {
    const box = $('#messages');
    if (!box) return;
    const conv = getConv();
    Popover.close();
    hideStreamingCursorAll(box);

    if (!conv || !conv.messages.length) {
      renderEmptyState(box, !conv);
      Chat._nodes.clear();
      updateContextWarning();
      return;
    }

    clear(box);
    Chat._nodes.clear();

    const latest = latestRoundIds(conv);
    const frag = document.createDocumentFragment();
    conv.messages.forEach(msg => {
      const built = buildMsgRow(msg);
      renderMessageBody(built.body, msg);
      const actions = buildActions(msg, actionCtx(), latest.has(msg.id));
      if (actions) built.col.appendChild(actions);
      Chat._nodes.set(msg.id, { row: built.row, body: built.body, col: built.col });
      frag.appendChild(built.row);
    });

    // 等待中的占位消息
    if (Chat.generating) {
      const placeholder = createStreamingPlaceholder();
      frag.appendChild(placeholder.row);
      Chat._nodes.set(placeholder.id, placeholder);
    }

    box.appendChild(frag);
    updateContextWarning();
  }

  function renderMessageBody(bodyEl, msg) {
    if (msg.role === 'user') renderUserBody(bodyEl, msg);
    else renderAssistantBody(bodyEl, msg);
  }

  function actionCtx() {
    return {
      onRegenerate: (msg) => regenerate(msg),
      onEdit: (msg) => editUserMessage(msg),
      onDelete: (msg) => deleteMessage(msg)
    };
  }

  function hideStreamingCursorAll(box) {
    UI.$$('.cursor-blink', box).forEach(c => c.remove());
  }

  function renderEmptyState(box, noConv) {
    clear(box);
    const wrap = el('div', { class: 'empty-state' });
    wrap.appendChild(el('img', { class: 'empty-logo', src: 'assets/img/logo-128.png', alt: '' }));
    wrap.appendChild(el('div', { class: 'empty-title', text: T('welcomeTitle') }));
    wrap.appendChild(el('div', { class: 'empty-desc', text: T('welcomeDesc') }));
    box.appendChild(wrap);
    if (noConv) console.info('[chat] 暂无对话，等待用户开始新对话');
  }

  /* ---------- 流式占位 ---------- */
  function createStreamingPlaceholder() {
    const id = 'streaming_' + Date.now();
    const avatar = el('div', { class: 'msg-avatar has-logo' });
    avatar.appendChild(el('img', { class: 'avatar-logo', src: 'assets/img/logo-64.png', alt: '' }));
    const roleLabel = el('div', { class: 'msg-role' }, [T('assistant')]);
    const body = el('div', { class: 'msg-body' });
    const ind = el('div', { class: 'thinking-indicator' }, [
      el('span', { class: 'thinking-dots' }, [el('span'), el('span'), el('span')]),
      el('span', { text: '' })
    ]);
    body.appendChild(ind);
    const col = el('div', { class: 'msg-col' }, [roleLabel, body]);
    const row = el('div', { class: 'msg-row assistant', dataset: { id, role: 'assistant' } }, [avatar, col]);
    // reasoningBox：思维链折叠块；contentBox：正文容器
    return { id, row, body, col, indicator: ind, reasoningBox: null, contentBox: null, phase: 'idle' };
  }

  function updatePlaceholderState(placeholder, state, text) {
    if (!placeholder) return;
    const label = placeholder.indicator && placeholder.indicator.lastChild;
    if (label) label.textContent = text || '';
    if (state === 'thinking') {
      // 思考阶段：保留思维链块，只把「思考中」指示器放在最前面
      if (placeholder.body.firstChild !== placeholder.indicator) {
        placeholder.body.insertBefore(placeholder.indicator, placeholder.body.firstChild);
      }
      // 思考中若还没有正文容器则移除旧的正文
      if (placeholder.contentBox && !placeholder.contentBox.textContent) {
        placeholder.contentBox.remove();
        placeholder.contentBox = null;
      }
    }
  }

  /** 切换到正文阶段：移除指示器，保留并折叠思维链，建立正文容器 */
  function enterContentPhase(placeholder) {
    if (!placeholder) return;
    if (placeholder.indicator && placeholder.indicator.parentNode) {
      placeholder.indicator.remove();
    }
    placeholder.phase = 'content';
    if (placeholder.reasoningBox) collapseReasoningBlock(placeholder.reasoningBox);
    if (!placeholder.contentBox) {
      placeholder.contentBox = el('div', { class: 'md-content' });
      placeholder.body.appendChild(placeholder.contentBox);
    }
  }

  /* ======================================================================
     发送 / 生成
     ====================================================================== */

  function currentModelId() {
    const conv = getConv();
    if (conv && conv.modelId) return conv.modelId;
    const models = Store.getModels();
    if (!models.length) return '';
    const last = Chat.lastModelId && models.find(m => m.id === Chat.lastModelId);
    return (last ? last.id : models[0].id);
  }

  function currentModel() {
    return Store.getModel(currentModelId());
  }

  function currentModelName() {
    const m = currentModel();
    return m ? m.name : '';
  }

  function setModel(id) {
    const conv = getConv();
    if (!conv) return;
    conv.modelId = id;
    // 思考强度重置为该模型默认值
    const m = Store.getModel(id);
    conv.thinking = (m && m.thinkingLevels && m.thinkingLevels.length) ? m.thinkingLevels[0] : '';
    touch(conv);
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  function currentThinking() {
    const conv = getConv();
    return (conv && conv.thinking) || '';
  }

  function setThinking(level) {
    const conv = getConv();
    if (!conv) return;
    conv.thinking = level;
    touch(conv);
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  /** 发送当前输入框内容 */
  function send(opts) {
    opts = opts || {};
    if (Chat.generating) { Toast.info(T('generating')); return; }

    const ta = $('#input');
    const text = (opts.text != null ? opts.text : (ta ? ta.value : '')).trim();
    const images = opts.images || Chat.pendingImages.slice();
    if (!text && !images.length) { Toast.warning(T('emptyInput')); return; }

    let conv = getConv();
    if (!conv) {
      conv = newConversation();
      Chat.convId = conv.id;
    }

    const model = Store.getModel(conv.modelId) || currentModel();
    if (!model) {
      Toast.error(T('addModelFirst'));
      if (global.Settings) Settings.open('models');
      return;
    }
    if (!conv.modelId) { conv.modelId = model.id; }

    const userMsg = {
      id: Store.uid('msg'),
      role: 'user',
      content: text,
      images: images.filter(i => i && i.dataUrl),
      createdAt: Date.now()
    };
    conv.messages.push(userMsg);

    // 首条消息 → 标题
    // 「第一条消息」模式：立即用消息内容作标题；
    // 「对话模型总结 / 指定模型总结」模式：先放临时标题，等首轮回复后再总结替换。
    if (!conv.title) {
      conv.title = makeFallbackTitle(text, images.length);
      conv.titleAuto = true;
    }
    // 首条消息发出时才把对话正式写入存储（此时才出现在列表中）
    if (!commitPending(conv)) touch(conv);

    Chat.pendingImages = [];
    if (ta) { ta.value = ''; UI.autoResize(ta); }
    renderAttachmentBar();
    updateCharCount();

    // 追加用户消息 DOM
    appendMessageToDOM(userMsg, conv);

    App && App.onConversationChanged && App.onConversationChanged();

    return runCompletion(conv, model);
  }

  function makeFallbackTitle(text, imgCount) {
    let t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) t = imgCount ? (global.I18N.lang === 'en' ? '[Image]' : '[图片]') : '';
    if (t.length > 40) t = t.slice(0, 40) + '…';
    return t || T('untitled');
  }

  function appendMessageToDOM(msg, conv) {
    const box = $('#messages');
    if (!box) return;
    const empty = box.querySelector('.empty-state');
    if (empty) empty.remove();

    const built = buildMsgRow(msg);
    renderMessageBody(built.body, msg);
    const actions = buildActions(msg, actionCtx(), true);
    if (actions) built.col.appendChild(actions);
    Chat._nodes.set(msg.id, { row: built.row, body: built.body, col: built.col });
    box.appendChild(built.row);
    // 新消息入列后，之前的一轮不再是最新一轮 → 隐藏其「编辑 / 重新生成」
    syncActionBars(conv || getConv());
    scrollToBottom(true);
  }

  /* ---------- 核心请求 ---------- */
  function runCompletion(conv, model, opts) {
    opts = opts || {};
    Chat.generating = true;
    App && App.setGenerating && App.setGenerating(true);

    // 占位
    const box = $('#messages');
    const placeholder = createStreamingPlaceholder();
    if (box) {
      const prior = Chat._nodes.get('__pending__');
      if (prior && prior.row.parentNode) prior.row.remove();
      box.appendChild(placeholder.row);
    }
    Chat._nodes.set('__pending__', { row: placeholder.row, body: placeholder.body, col: placeholder.col, placeholder: true });

    const controller = new AbortController();
    Chat.controller = controller;

    const st = settings();
    let full = '';
    let reasoning = '';
    let lastRender = 0;
    let dirty = false;
    let renderTimer = null;

    function doRender(force) {
      const now = Date.now();
      if (!placeholder.body) return;
      if (!force && now - lastRender < STREAM_RENDER_INTERVAL) {
        dirty = true;
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderTimer = null;
            if (dirty) { dirty = false; doRender(true); }
          }, STREAM_RENDER_INTERVAL);
        }
        return;
      }
      lastRender = now;
      dirty = false;
      placeholder.body.classList.add('md');
      let html;
      try { html = MD.toHtml(full); } catch (e) { html = '<div class="md-plaintext">' + UI.escapeHtml(full) + '</div>'; }
      enterContentPhase(placeholder);
      const target = placeholder.contentBox || placeholder.body;
      target.innerHTML = html;
      MD.enhance(target).catch(() => {});
    }

    const history = conv.messages.map(m => ({
      role: m.role, content: m.content, images: m.images
    })).filter(m => m.role === 'user' || (m.role === 'assistant' && m.content));
    const apiMessages = history.slice(-MAX_HISTORY_MESSAGES);

    const apiOpts = {
      model,
      messages: apiMessages,
      stream: st.stream && model.supportsStream !== false,
      thinking: currentThinking(),
      signal: controller.signal,
      historyLimit: 0,
      onOpen: () => {
        placeholder.row.dataset.started = '1';
      },
      onReasoning: (chunk) => {
        reasoning += chunk;
        placeholder.body.classList.add('md');
        // 首次收到思维链：建立折叠块（思考中默认展开）
        if (!placeholder.reasoningBox) {
          if (placeholder.indicator && placeholder.indicator.lastChild) {
            placeholder.indicator.lastChild.textContent = '';
          }
          const box = buildReasoningBlock(reasoning, 'live', true);
          placeholder.reasoningBox = box;
          placeholder.body.insertBefore(box, placeholder.body.firstChild);
        } else {
          updateReasoningBlock(placeholder.reasoningBox, reasoning, placeholder.phase === 'content' ? 'done' : 'live');
        }
        scrollToBottom();
      },
      onDelta: (chunk, whole) => {
        full = whole;
        // 正文开始输出：折叠思维链，切换到正文阶段
        if (placeholder.phase !== 'content') {
          enterContentPhase(placeholder);
        }
        doRender(false);
        scrollToBottom();
      }
    };

    return API.chat(apiOpts).then(res => {
      if (res && res.content) full = res.content;
      if (res && res.reasoning) reasoning = res.reasoning;
      finishGeneration(conv, model, placeholder, {
        content: full,
        reasoning,
        usage: res && res.usage,
        aborted: !!(res && res.aborted),
        partial: !!(res && res.partial)
      });
      return res;
    }).catch(err => {
      const isAbort = err && err.code === 'ABORTED';
      if (isAbort && full) {
        finishGeneration(conv, model, placeholder, { content: full, reasoning, aborted: true });
        return;
      }
      failGeneration(conv, placeholder, err);
    }).then(r => {
      Chat.generating = false;
      Chat.controller = null;
      App && App.setGenerating && App.setGenerating(false);
      return r;
    });
  }

  function finishGeneration(conv, model, placeholder, result) {
    // 移除占位 DOM，改为正式消息
    const data = {
      id: Store.uid('msg'),
      role: 'assistant',
      content: result.content || '',
      reasoning: result.reasoning || '',
      usage: result.usage || null,
      modelName: (model && model.name) || '',
      model: (model && model.model) || '',
      aborted: !!result.aborted,
      createdAt: Date.now()
    };

    if (!data.content && !data.reasoning && !data.usage) {
      // 什么都没有：当作失败
      failGeneration(conv, placeholder, new Error(T('requestFailed')));
      return;
    }

    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      const built = buildMsgRow(data);
      renderAssistantBody(built.body, data);
      const actions = buildActions(data, actionCtx(), true);
      if (actions) built.col.appendChild(actions);
      placeholder.row.parentNode.replaceChild(built.row, placeholder.row);
      Chat._nodes.set(data.id, { row: built.row, body: built.body, col: built.col });
    }
    Chat._nodes.delete('__pending__');

    conv.messages.push(data);
    touch(conv);
    syncActionBars(conv);
    scrollToBottom();
    App && App.onConversationChanged && App.onConversationChanged();

    // 首轮对话完成后按设置生成标题
    maybeAutoTitle(conv, model);
  }

  /** 判断是否需要自动生成标题 */
  function maybeAutoTitle(conv, model) {
    const st = settings();
    const mode = st.autoTitleMode || 'chat';

    // 「第一条消息」模式：在发送时已由 makeFallbackTitle 处理
    if (mode === 'first') return;

    // 仅首个用户轮次
    const userTurns = conv.messages.filter(m => m.role === 'user').length;
    if (userTurns !== 1) return;
    const hasReply = conv.messages.some(m => m.role === 'assistant' && m.content);
    if (!hasReply) return;

    summarizeTitle(conv, model, mode).catch(() => {});
  }

  function failGeneration(conv, placeholder, err) {
    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      placeholder.row.remove();
    }
    Chat._nodes.delete('__pending__');

    const errData = {
      id: Store.uid('msg'),
      role: 'assistant',
      content: '',
      error: {
        title: T('requestFailed'),
        message: (err && err.message) || String(err),
        detail: (err && err.body) || ''
      },
      createdAt: Date.now()
    };
    conv.messages.push(errData);
    touch(conv);
    appendMessageToDOM(errData, conv);

    Toast.error((err && err.message) || T('requestFailed'), { duration: 6000 });
    App && App.onConversationChanged && App.onConversationChanged();
  }

  function stopGeneration() {
    if (!Chat.generating || !Chat.controller) return;
    try { Chat.controller.abort(); } catch (e) { /* noop */ }
    Toast.info(T('stopped'));
  }

  /** 重新生成指定助手消息 */
  function regenerate(msg) {
    if (Chat.generating) { Toast.info(T('generating')); return; }
    const conv = getConv();
    if (!conv) return;
    const idx = conv.messages.findIndex(m => m.id === msg.id);
    if (idx < 0) return;
    const model = Store.getModel(conv.modelId) || currentModel();
    if (!model) { Toast.error(T('addModelFirst')); return; }

    // 从该消息起（含）删除后续内容
    const removed = conv.messages.splice(idx);
    touch(conv);
    removed.forEach(m => {
      const n = Chat._nodes.get(m.id);
      if (n && n.row.parentNode) n.row.remove();
      Chat._nodes.delete(m.id);
    });
    syncActionBars(conv);

    if (!conv.messages.some(m => m.role === 'user')) {
      renderMessages();
      return;
    }
    runCompletion(conv, model);
  }

  /** 编辑用户消息并重发 */
  function editUserMessage(msg) {
    if (Chat.generating) { Toast.info(T('generating')); return; }
    const conv = getConv();
    if (!conv) return;
    const ta = $('#input');
    if (!ta) return;

    const idx = conv.messages.findIndex(m => m.id === msg.id);
    if (idx < 0) return;

    // 删除该消息及其之后的所有内容
    const removed = conv.messages.splice(idx);
    removed.forEach(m => {
      const n = Chat._nodes.get(m.id);
      if (n && n.row.parentNode) n.row.remove();
      Chat._nodes.delete(m.id);
    });

    ta.value = msg.content || '';
    Chat.pendingImages = Array.isArray(msg.images) ? msg.images.slice() : [];
    renderAttachmentBar();
    UI.autoResize(ta);
    updateCharCount();
    ta.focus();
    Toast.info(T('edit'));
    touch(conv);
    syncActionBars(conv);
    App && App.onConversationChanged && App.onConversationChanged();
  }

  /** 删除单条消息（含确认弹窗，可勾选「不再询问」） */
  function deleteMessage(msg) {
    if (Chat.generating) { Toast.info(T('generating')); return; }
    if (!msg) return;
    const conv0 = getConv();
    if (!conv0) return;

    const prefs = Store.getConfirmPrefs();
    const doDelete = () => {
      const conv = getConv();
      if (!conv) return;
      const idx = conv.messages.findIndex(m => m.id === msg.id);
      if (idx < 0) return;

      conv.messages.splice(idx, 1);
      touch(conv);

      const node = Chat._nodes.get(msg.id);
      if (node && node.row.parentNode) node.row.remove();
      Chat._nodes.delete(msg.id);

      if (!conv.messages.length) renderMessages();
      else syncActionBars(conv);

      App && App.onConversationChanged && App.onConversationChanged();
      Toast.success(T('msgDeleted'));
    };

    if (prefs.deleteMessage) { doDelete(); return; }

    UI.Confirm.ask({
      title: T('deleteMsgTitle'),
      text: T('deleteMsgText'),
      okText: T('delete'),
      noAskKey: 'deleteMessage'
    }).then(r => {
      if (!r.confirmed) return;
      if (r.noAsk && r.noAsk.value) Store.setConfirmPref(r.noAsk.key, true);
      doDelete();
    });
  }

  /* ======================================================================
     标题总结
     ====================================================================== */
  /**
   * @param {object} conv 目标对话
   * @param {object} usedModel 当前对话所用模型（mode='chat' 时使用）
   * @param {'chat'|'model'} mode chat=用对话模型，model=用指定模型
   */
  function summarizeTitle(conv, usedModel, mode) {
    const st = settings();
    mode = mode || st.autoTitleMode || 'chat';
    if (mode === 'first') return Promise.resolve();

    const titleModel = mode === 'model'
      ? (Store.getModel(st.titleModelId) || usedModel)
      : usedModel;
    if (!titleModel) return Promise.resolve();

    App && App.setTitleBusy && App.setTitleBusy(true);

    const userMsg = conv.messages.find(m => m.role === 'user');
    const asstMsg = conv.messages.find(m => m.role === 'assistant' && m.content);
    if (!userMsg || !asstMsg) { App && App.setTitleBusy && App.setTitleBusy(false); return Promise.resolve(); }

    const prompt = global.I18N.lang === 'en'
      ? 'Summarize the topic of the conversation below as a short title of at most 10 words. '
        + 'Reply with the title only, no quotes, no punctuation at the end, and use the language of the user.\n\n'
        + 'User: ' + String(userMsg.content).slice(0, 700) + '\n\nAssistant: ' + String(asstMsg.content).slice(0, 700)
      : '请为下面的对话总结一个简短标题，不超过 12 个字。只回复标题本身，'
        + '不要引号、不要句末标点，使用与用户相同的语言。\n\n'
        + '用户：' + String(userMsg.content).slice(0, 700) + '\n\n助手：' + String(asstMsg.content).slice(0, 700);

    // 若该模型可关闭思考，则关闭思考以省 token、加快响应
    const thinkOpts = thinkingForTitle(titleModel);

    return API.chat(Object.assign({
      model: titleModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      maxTokens: 512,
      temperature: 0.3
    }, thinkOpts)).then(res => {
      // 部分推理模型会把预算耗在 reasoning 上导致 content 为空，
      // 此时从 reasoning 中尝试提取标题。
      let title = (res && res.content) || '';
      if (!title && res && res.reasoning) {
        title = extractTitleFromReasoning(res.reasoning);
      }
      title = title.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').replace(/[。.!！?？:：]+$/g, '').trim();
      title = title.split('\n')[0].trim();
      if (title.length > 40) title = title.slice(0, 40);
      if (!title) return;

      const fresh = Store.getConversation(conv.id);
      if (!fresh) return;
      if (fresh.messages.filter(m => m.role === 'user').length > 1) return; // 用户已继续发问，不覆盖
      fresh.title = title;
      fresh.titleAuto = true;
      Store.upsertConversation(fresh);
      App && App.onConversationChanged && App.onConversationChanged();
    }).catch(err => {
      console.warn('[title] 总结失败：', err && err.message);
    }).then(() => {
      App && App.setTitleBusy && App.setTitleBusy(false);
    });
  }

  /**
   * 标题总结专用的思考参数：若模型支持关闭思考（none/off/minimal），
   * 则关闭思考；否则不传，交给服务端默认行为。
   */
  function thinkingForTitle(model) {
    const levels = (model && model.thinkingLevels) || [];
    if (!levels.length) return {};
    const lower = levels.map(l => String(l).toLowerCase());
    const off = ['none', 'off', 'minimal'].find(v => lower.indexOf(v) >= 0);
    if (off) return { thinking: off };
    return {};   // 无法关闭思考，保持默认
  }

  /** 从推理文本里尽力提取一个标题 */
  function extractTitleFromReasoning(text) {
    const s = String(text || '');
    // 常见输出：标题：xxx   /   “xxx”   /   最终答案：xxx
    const labeled = s.match(/(?:标题|题目|答案|final(?:\s*answer)?|title)\s*[:：]\s*[“"'「]?([^”"'」\n]{1,30})/i);
    if (labeled && labeled[1]) return labeled[1].trim();
    const quoted = s.match(/[“"'「]([^”"'」\n]{2,24})[”"'」]/);
    if (quoted && quoted[1]) return quoted[1].trim();
    return '';
  }

  /* ======================================================================
     附件
     ====================================================================== */
  function renderAttachmentBar() {
    const wrap = $('#attachments');
    if (!wrap) return;
    clear(wrap);
    if (!Chat.pendingImages.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    Chat.pendingImages.forEach((img, i) => {
      const item = el('div', { class: 'attach-item' });
      item.appendChild(el('img', { src: img.dataUrl, alt: img.name || '' }));
      const rm = el('button', {
        class: 'attach-remove', type: 'button',
        title: T('delete'), 'aria-label': T('delete')
      }, [el('i', { class: 'bi bi-x' })]);
      rm.addEventListener('click', () => {
        Chat.pendingImages.splice(i, 1);
        renderAttachmentBar();
      });
      item.appendChild(rm);
      wrap.appendChild(item);
    });
  }

  function handleFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    const st = settings();
    const model = currentModel();
    const max = st.maxImages;

    const images = files.filter(f => /^image\//.test(f.type));
    if (!images.length) { Toast.warning(T('imageOnly')); return; }
    if (files.length > images.length) Toast.warning(T('imageOnly'));
    if (!model || !model.supportsImages) {
      Toast.warning(T('visionUnsupported'), { duration: 4000 });
      return;
    }

    const room = max - Chat.pendingImages.length;
    if (room <= 0) { Toast.warning(T('maxImages', max)); return; }
    const use = images.slice(0, room);
    if (images.length > room) Toast.warning(T('maxImages', max));

    Promise.all(use.map(f => {
      if (f.size > st.maxImageMB * 1024 * 1024) {
        Toast.error(T('imageTooLarge', st.maxImageMB, f.name));
        return null;
      }
      return UI.fileToDataUrl(f)
        .then(url => UI.compressImage(url, 1280, 0.85))
        .then(url => ({ id: Store.uid('img'), name: f.name, dataUrl: url, size: f.size }))
        .catch(() => { Toast.error(T('imageOnly')); return null; });
    })).then(list => {
      const ok = list.filter(Boolean);
      if (!ok.length) return;
      Chat.pendingImages = Chat.pendingImages.concat(ok);
      renderAttachmentBar();
      Toast.success(T('attachmentAdded', ok.length));
    });
  }

  /* ======================================================================
     模型 / 思考强度 选择器
     ====================================================================== */
  function openModelPicker(anchorEl) {
    const models = Store.getModels();
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('modelList') }));

    if (!models.length) {
      const empty = el('div', { class: 'popover-item' }, [
        el('i', { class: 'bi bi-plus-circle' }),
        el('span', { text: T('addModelFirst') })
      ]);
      empty.addEventListener('click', () => {
        Popover.close();
        if (global.Settings) Settings.open('models');
      });
      box.appendChild(empty);
    } else {
      const cur = currentModelId();
      models.forEach(m => {
        const item = el('button', { class: 'popover-item' + (m.id === cur ? ' active' : ''), type: 'button' });
        const body = el('div', { class: 'pi-body' }, [
          el('div', { class: 'pi-title', text: m.name }),
          el('div', { class: 'pi-desc', text: m.model || '—' })
        ]);
        item.appendChild(el('i', { class: 'bi ' + (m.supportsImages ? 'bi-image' : 'bi-cpu') }));
        item.appendChild(body);
        if (m.id === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
        item.addEventListener('click', () => {
          setModel(m.id);
          Popover.close();
          Toast.success(m.name);
        });
        box.appendChild(item);
      });
    }

    box.appendChild(el('div', { class: 'popover-sep' }));
    const manage = el('button', { class: 'popover-item', type: 'button' }, [
      el('i', { class: 'bi bi-sliders2' }), el('span', { text: T('tabModels') })
    ]);
    manage.addEventListener('click', () => {
      Popover.close();
      if (global.Settings) Settings.open('models');
    });
    box.appendChild(manage);

    Popover.open(anchorEl, box, { align: 'start' });
  }

  function openThinkingPicker(anchorEl) {
    const model = currentModel();
    if (!model || !model.thinkingLevels || !model.thinkingLevels.length) return;
    const cur = currentThinking() || model.thinkingLevels[0];
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('thinkingLevels') }));
    model.thinkingLevels.forEach(level => {
      const label = levelLabel(level);
      const item = el('button', { class: 'popover-item' + (level === cur ? ' active' : ''), type: 'button' });
      item.appendChild(el('i', { class: 'bi ' + levelIcon(level) }));
      item.appendChild(el('div', { class: 'pi-body' }, [
        el('div', { class: 'pi-title', text: label })
      ]));
      if (level === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
      item.addEventListener('click', () => {
        setThinking(level);
        Popover.close();
      });
      box.appendChild(item);
    });
    Popover.open(anchorEl, box, { align: 'start' });
  }

  const LEVEL_MAP = {
    auto: { zh: '自动', en: 'Auto', icon: 'bi-magic' },
    off: { zh: '关闭思考', en: 'Off', icon: 'bi-dash-circle' },
    none: { zh: '关闭思考', en: 'None', icon: 'bi-dash-circle' },
    minimal: { zh: '最低', en: 'Minimal', icon: 'bi-chevron-down' },
    low: { zh: '低', en: 'Low', icon: 'bi-chevron-double-down' },
    medium: { zh: '中', en: 'Medium', icon: 'bi-dash' },
    high: { zh: '高', en: 'High', icon: 'bi-chevron-double-up' },
    xhigh: { zh: '极高', en: 'Very high', icon: 'bi-chevron-bar-up' },
    maximum: { zh: '最高', en: 'Maximum', icon: 'bi-arrow-bar-up' }
  };

  function levelLabel(level) {
    const key = String(level).toLowerCase();
    const m = LEVEL_MAP[key];
    if (m) return (global.I18N.lang === 'en' ? m.en : m.zh) + '  ·  ' + level;
    return level;
  }
  function levelIcon(level) {
    const m = LEVEL_MAP[String(level).toLowerCase()];
    return m ? m.icon : 'bi-sliders';
  }

  /* ======================================================================
     输入框
     ====================================================================== */

  /* ---------- 上下文用量预警 ---------- */
  const CTX_WARN_RATIO = 0.75;     // 达到上限 75% 起提示
  const CTX_DANGER_RATIO = 0.9;    // 达到上限 90% 升级为警告

  /**
   * 估算当前对话累计占用的 token：
   * 若历史消息里有服务端返回的真实 usage，则以它为基准，再叠加其后新增消息的估算值。
   */
  function estimateContextTokens(conv, model) {
    const msgs = (conv && conv.messages) || [];
    let base = 0;
    let startIdx = 0;
    let exact = false;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const u = msgs[i].usage;
      if (msgs[i].role === 'assistant' && u && !u.estimated && (u.total != null || u.input != null)) {
        base = u.total != null ? Number(u.total) || 0 : (Number(u.input) || 0) + (Number(u.output) || 0);
        startIdx = i + 1;
        exact = true;
        break;
      }
    }

    let extra = 0;
    for (let i = startIdx; i < msgs.length; i++) {
      const m = msgs[i];
      const text = typeof m.content === 'string' ? m.content : '';
      extra += UI.estimateTokens(MD.toPlainText ? MD.toPlainText(text) : text);
      // 图片无法精确估算，按保守常量粗计
      if (Array.isArray(m.images) && m.images.length) extra += m.images.length * 256;
    }

    // 没有真实 usage 时，系统提示词也要计入
    const sys = (!exact && model && model.systemPrompt) ? UI.estimateTokens(model.systemPrompt) : 0;
    return base + extra + sys;
  }

  function formatNum(n) {
    try { return Number(n).toLocaleString(global.I18N.lang === 'en' ? 'en-US' : 'zh-CN'); }
    catch (e) { return String(n); }
  }

  /** 依据当前对话的估算用量，在输入框内显示 / 隐藏上下文预警 */
  function updateContextWarning() {
    const box = $('#composerWarn');
    const textEl = $('#composerWarnText');
    if (!box || !textEl) return;

    const hide = () => { box.hidden = true; box.classList.remove('err'); textEl.textContent = ''; };

    const conv = getConv();
    const model = Store.getModel(conv ? conv.modelId : '') || currentModel();
    const limit = model ? Number(model.contextLength) || 0 : 0;
    if (!conv || !conv.messages.length || limit <= 0) { hide(); return; }

    const used = estimateContextTokens(conv, model);
    const ratio = used / limit;
    if (ratio < CTX_WARN_RATIO) { hide(); return; }

    const danger = ratio >= CTX_DANGER_RATIO;
    box.hidden = false;
    box.classList.toggle('err', danger);
    textEl.textContent = T(
      danger ? 'ctxDanger' : 'ctxWarn',
      Math.round(ratio * 100),
      formatNum(used),
      formatNum(limit)
    );
  }

  function updateCharCount() {
    const ta = $('#input');
    const cc = $('#charCount');
    if (!ta || !cc) return;
    const len = ta.value.length;
    if (len > 200) {
      cc.hidden = false;
      cc.textContent = String(len);
    } else {
      cc.hidden = true;
    }
  }

  function scrollToBottom(instant) {
    const box = $('#messages');
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    if (instant || nearBottom) {
      if (instant) box.scrollTop = box.scrollHeight;
      else UI.smoothTo(box, box.scrollHeight);
    }
  }

  function forceScrollToBottom() {
    const box = $('#messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* ====================================================================== */
  Chat.renderMessages = renderMessages;
  Chat.renderAttachmentBar = renderAttachmentBar;
  Chat.renderUserBody = renderUserBody;
  Chat.renderAssistantBody = renderAssistantBody;
  Chat.buildMsgRow = buildMsgRow;
  Chat.buildActions = buildActions;
  Chat.buildUsageChip = buildUsageChip;
  Chat.actionCtx = actionCtx;
  Chat.newConversation = newConversation;
  Chat.startNewChat = startNewChat;
  Chat.getConv = getConv;
  Chat.setConversation = setConversation;
  Chat.discardPending = discardPending;
  Chat.latestRoundIds = latestRoundIds;
  Chat.syncActionBars = syncActionBars;
  Chat.send = send;
  Chat.stopGeneration = stopGeneration;
  Chat.regenerate = regenerate;
  Chat.deleteMessage = deleteMessage;
  Chat.updateContextWarning = updateContextWarning;
  Chat.estimateContextTokens = estimateContextTokens;
  Chat.setModel = setModel;
  Chat.setThinking = setThinking;
  Chat.currentModel = currentModel;
  Chat.currentModelId = currentModelId;
  Chat.currentModelName = currentModelName;
  Chat.currentThinking = currentThinking;
  Chat.handleFiles = handleFiles;
  Chat.openModelPicker = openModelPicker;
  Chat.openThinkingPicker = openThinkingPicker;
  Chat.updateCharCount = updateCharCount;
  Chat.scrollToBottom = scrollToBottom;
  Chat.forceScrollToBottom = forceScrollToBottom;
  Chat.makeFallbackTitle = makeFallbackTitle;
  Chat.buildErrorBlock = buildErrorBlock;

  global.Chat = Chat;
})(window);
