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

  const STREAM_MAX_WAIT = 600;         // 流式渲染最长等待（ms）：再慢也保证界面有反馈
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

  /** 助手头像节点 */
  function buildAvatar(isUser) {
    const avatar = el('div', { class: 'msg-avatar' });
    if (isUser) {
      avatar.appendChild(el('i', { class: 'bi bi-person-fill' }));
    } else {
      avatar.classList.add('has-logo');
      avatar.appendChild(el('img', { class: 'avatar-logo', src: 'assets/img/logo-64.png', alt: '' }));
    }
    return avatar;
  }

  /**
   * 表头里显示的名字：助手消息用「生成它的模型名」取代原来写死的「AI 助手」。
   * 优先取消息自带的 modelName，历史消息没有该字段时用当前对话配置的模型兜底。
   * @param {object} msg 消息
   * @param {string} [fallback] 兜底模型名（成批渲染时由调用方算一次，见 convFallbackModelName）
   */
  function assistantLabel(msg, fallback) {
    if (!msg || msg.role !== 'assistant') return T('assistant');
    return msg.modelName || fallback || T('assistant');
  }

  /**
   * 构建一条消息的 DOM。
   * 助手消息：表头（头像 + 模型名）在**消息框外面**，消息框整体位于表头下方；
   * 用户消息：同样把表头放在框外（「你」在头像左边），气泡位于头像下方、整体贴右。
   * @param {object} msg 消息
   * @param {object} [opts] { label } 表头文案
   */
  function buildMsgRow(msg, opts) {
    opts = opts || {};
    const isUser = msg.role === 'user';
    const avatar = buildAvatar(isUser);
    const body = el('div', { class: 'msg-body' });
    const dataset = { id: msg.id, role: msg.role };

    if (isUser) {
      /* 用户消息也走「表头在框外」的结构（与助手消息同构，只是整体右对齐）：
         「你」从气泡里移到外面，头像是在表头右侧、文字在头像左边；
         气泡整体挪到头像下方，不再与头像并排。 */
      const roleLabel = el('div', { class: 'msg-role', text: T('you') });
      const head = el('div', { class: 'msg-head' }, [avatar, roleLabel]);
      const col = el('div', { class: 'msg-col' }, [body]);
      const row = el('div', { class: 'msg-row user', dataset }, [head, col]);
      return { row, body, col, head, roleLabel };
    }

    const roleLabel = el('div', { class: 'msg-role', text: opts.label || T('assistant') });
    const head = el('div', { class: 'msg-head' }, [avatar, roleLabel]);
    const col = el('div', { class: 'msg-col' }, [body]);
    const row = el('div', { class: 'msg-row assistant', dataset }, [head, col]);
    return { row, body, col, head, roleLabel };
  }

  /**
   * 从 buildMsgRow 的返回值里取出要缓存到 Chat._nodes 的引用。
   * 一定要把 head / roleLabel 带上：syncActionBars() 靠它更新表头里的模型名。
   */
  function nodeRef(built) {
    return { row: built.row, body: built.body, col: built.col, head: built.head, roleLabel: built.roleLabel };
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
   * 思维链头部摘要：字数 + 本段耗时。
   * 耗时写法与联网搜索块（toolMetaText）保持一致，都是保留两位小数的秒。
   */
  function reasoningMetaText(text, ms) {
    const bits = [T('reasoningChars', String(text || '').length)];
    const n = Number(ms) || 0;
    if (n > 0) bits.push((n / 1000).toFixed(2) + 's');
    return bits.join(' · ');
  }

  /** 就地刷新思维链头部摘要（字数取正文实际内容，耗时取 dataset.ms） */
  function refreshReasoningMeta(box) {
    if (!box) return;
    const meta = box.querySelector('.reasoning-meta');
    const body = box.querySelector('.reasoning-body');
    if (meta && body) meta.textContent = reasoningMetaText(body.textContent, box.dataset.ms);
  }

  /**
   * 创建思维链折叠块。
   * @param {string} text 思维链内容
   * @param {'live'|'done'} mode live=仍在思考（默认展开），done=已开始输出正文（默认折叠）
   * @param {boolean} [forceOpen] 强制展开/折叠（用于保留用户手动切换的状态）
   * @param {number} [ms] 本段思考耗时（毫秒）
   */
  function buildReasoningBlock(text, mode, forceOpen, ms) {
    const live = mode === 'live';
    const open = forceOpen != null ? !!forceOpen : live;

    const box = el('div', { class: 'reasoning' + (open ? ' open' : '') + (live ? ' live' : ' collapsed-done') });
    box.dataset.ms = String(Number(ms) || 0);

    const head = el('button', { class: 'reasoning-head', type: 'button' }, [
      el('i', { class: 'bi bi-brain' }),
      el('span', { class: 'reasoning-label', text: live ? T('reasoningThinking') : T('reasoningDone') }),
      el('span', { class: 'reasoning-meta', text: reasoningMetaText(text, ms) }),
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
    const label = box.querySelector('.reasoning-label');
    const atBottom = body ? (body.scrollHeight - body.scrollTop - body.clientHeight < 24) : true;
    if (body) body.textContent = text || '';
    refreshReasoningMeta(box);
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
    refreshReasoningMeta(box);
    if (box.dataset.userToggled === '1') return;   // 尊重用户选择
    box.classList.remove('open');
    const head = box.querySelector('.reasoning-head');
    if (head) head.setAttribute('aria-expanded', 'false');
  }

  /* ======================================================================
     工具调用展示块（与思维链块同级）
     ====================================================================== */

  function toolIcon(tool) {
    if (tool.status === 'running') return 'bi-globe2';
    if (tool.status === 'error') return 'bi-exclamation-triangle-fill';
    return 'bi-globe2';
  }

  function toolLabel(tool) {
    if (tool.name === 'web_search' || !tool.name) return T('toolSearch');
    return tool.name;
  }

  function toolMetaText(tool) {
    if (tool.status === 'running') return T('toolSearching');
    if (tool.status === 'error') return T('toolSearchFailed');
    const n = (tool.results || []).length;
    const bits = [T('toolResultCount', n)];
    if (tool.ms) bits.push((tool.ms / 1000).toFixed(2) + 's');
    return bits.join(' · ');
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  function truncate(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function fillToolBody(body, tool) {
    clear(body);

    if (tool.status === 'running') {
      body.appendChild(el('div', { class: 'tool-status' }, [
        el('span', { class: 'thinking-dots' }, [el('span'), el('span'), el('span')]),
        el('span', { text: T('toolSearching') })
      ]));
    }

    if (tool.status === 'error') {
      body.appendChild(el('div', { class: 'tool-error', text: tool.error || T('toolSearchFailed') }));
    }

    if (tool.answer) {
      body.appendChild(el('div', { class: 'tool-answer' }, [
        el('div', { class: 'tool-answer-label', text: T('toolAnswer') }),
        el('div', { class: 'tool-answer-text', text: tool.answer })
      ]));
    }

    const results = tool.results || [];
    if (results.length) {
      const list = el('div', { class: 'tool-results' });
      results.forEach((r, i) => {
        const item = el('div', { class: 'tool-result' });
        const link = el('a', {
          class: 'tool-result-title',
          href: r.url || '#',
          target: '_blank',
          rel: 'noopener noreferrer'
        }, [
          el('span', { class: 'tool-result-idx', text: String(i + 1) }),
          el('span', { text: r.title || r.url || '' })
        ]);
        item.appendChild(link);
        const host = hostOf(r.url);
        if (host) item.appendChild(el('div', { class: 'tool-result-host', text: host }));
        if (r.content) item.appendChild(el('div', { class: 'tool-result-snippet', text: truncate(r.content, 240) }));
        list.appendChild(item);
      });
      body.appendChild(list);
    } else if (tool.status === 'done') {
      body.appendChild(el('div', { class: 'tool-empty', text: T('toolNoResult') }));
    }

    if (Array.isArray(tool.images) && tool.images.length) {
      const strip = el('div', { class: 'tool-images' });
      tool.images.slice(0, 6).forEach(im => {
        const src = typeof im === 'string' ? im : (im && (im.url || im.src));
        if (src) strip.appendChild(el('img', { src, alt: '', loading: 'lazy', dataset: { zoom: '1' } }));
      });
      if (strip.children.length) body.appendChild(strip);
    }

    const args = tool.args || {};
    const keys = Object.keys(args).filter(k => k !== '__raw');
    if (keys.length) {
      const det = el('details', { class: 'tool-params' });
      det.appendChild(el('summary', { text: T('toolParams') }));
      det.appendChild(el('pre', { text: JSON.stringify(args, null, 2) }));
      body.appendChild(det);
    }
  }

  /**
   * 构建工具调用折叠块
   * @param {object} tool { id, name, query, args, status, results, answer, error, ms, images }
   * @param {boolean} [live] 是否仍在进行中（默认展开）
   */
  function buildToolBlock(tool, live) {
    const running = tool.status === 'running';
    const open = live != null ? !!live : running;
    const cls = 'tool-call ' + (running ? 'live' : (tool.status === 'error' ? 'err' : 'done')) + (open ? ' open' : '');
    const box = el('div', { class: cls, dataset: { toolId: tool.id || '' } });

    const head = el('button', { class: 'tool-head', type: 'button' }, [
      el('i', { class: 'bi ' + toolIcon(tool) }),
      el('span', { class: 'tool-label', text: toolLabel(tool) }),
      el('span', { class: 'tool-query', text: tool.query ? ('“' + truncate(tool.query, 48) + '”') : '' }),
      el('span', { class: 'tool-meta', text: toolMetaText(tool) }),
      el('i', { class: 'bi bi-chevron-down tool-caret' })
    ]);
    head.addEventListener('click', () => {
      const isOpen = box.classList.toggle('open');
      head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    box.appendChild(head);

    const body = el('div', { class: 'tool-body' });
    fillToolBody(body, tool);
    box.appendChild(body);
    return box;
  }

  /** 就地更新工具块（状态 / 结果） */
  function updateToolBlock(box, tool) {
    if (!box) return;
    const running = tool.status === 'running';
    box.classList.toggle('live', running);
    box.classList.toggle('done', !running && tool.status !== 'error');
    box.classList.toggle('err', tool.status === 'error');
    const icon = box.querySelector('.tool-head > i.bi');
    if (icon) icon.className = 'bi ' + toolIcon(tool);
    const q = box.querySelector('.tool-query');
    if (q) q.textContent = tool.query ? ('“' + truncate(tool.query, 48) + '”') : '';
    const meta = box.querySelector('.tool-meta');
    if (meta) meta.textContent = toolMetaText(tool);
    const body = box.querySelector('.tool-body');
    if (body) fillToolBody(body, tool);
  }

  /* ======================================================================
     消息分段渲染：思维链段 / 工具调用段 / 中间正文段
     ====================================================================== */

  /**
   * 顺序渲染 msg.parts（思维链段 / 工具调用段 / 正文段）。
   * 无 parts 时回退到旧的 reasoning 字段。
   * @returns {HTMLElement[]} 需要做 Markdown 增强的正文容器
   */
  function renderParts(bodyEl, msg) {
    const parts = Array.isArray(msg.parts) ? msg.parts : null;
    const wraps = [];
    if (!parts || !parts.length) {
      if (msg.reasoning) bodyEl.appendChild(buildReasoningBlock(msg.reasoning, 'done', false));
      return wraps;
    }
    parts.forEach(p => {
      if (!p) return;
      if (p.type === 'reasoning') {
        if (p.text && String(p.text).trim()) {
          bodyEl.appendChild(buildReasoningBlock(p.text, 'done', false, p.ms));
        }
      } else if (p.type === 'tool') {
        bodyEl.appendChild(buildToolBlock(p, false));
      } else if (p.type === 'content' && p.text && String(p.text).trim()) {
        const wrap = el('div', { class: 'md-content' });
        try { wrap.innerHTML = MD.toHtml(p.text); } catch (e) {
          wrap.innerHTML = '<div class="md-plaintext">' + UI.escapeHtml(p.text) + '</div>';
        }
        bodyEl.appendChild(wrap);
        wraps.push(wrap);
      }
    });
    return wraps;
  }

  /** 助手消息渲染（含 Markdown 增强 / 生成图片画廊） */
  function renderAssistantBody(bodyEl, msg) {
    bodyEl.classList.add('md');
    if (msg.error) {
      clear(bodyEl);
      bodyEl.classList.remove('md');
      bodyEl.appendChild(buildErrorBlock(msg.error));
      return;
    }

    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    const hasParts = Array.isArray(msg.parts) && msg.parts.length > 0;
    const hasAudios = Array.isArray(msg.audios) && msg.audios.length > 0;

    if (!msg.content && !hasImages && !hasParts && !hasAudios) {
      // 只有思维链没有正文时也要展示思维链
      clear(bodyEl);
      if (msg.reasoning) bodyEl.appendChild(buildReasoningBlock(msg.reasoning, 'done', false));
      return;
    }

    clear(bodyEl);
    const wraps = [];
    if (hasParts) {
      // 有多段内容（思维链 / 搜索 / 正文交错）时按原始顺序渲染
      renderParts(bodyEl, msg).forEach(w => wraps.push(w));
    } else {
      // 历史消息中的思维链默认折叠，用户可展开
      if (msg.reasoning) {
        bodyEl.appendChild(buildReasoningBlock(msg.reasoning, 'done', false));
      }
      if (msg.content) {
        const contentWrap = el('div', { class: 'md-content' });
        try {
          contentWrap.innerHTML = MD.toHtml(msg.content);
        } catch (e) {
          console.error('[chat] 渲染失败', e);
          contentWrap.innerHTML = '<div class="md-plaintext">' + UI.escapeHtml(msg.content) + '</div>';
        }
        bodyEl.appendChild(contentWrap);
        wraps.push(contentWrap);
      }
    }
    wraps.forEach(w => MD.enhance(w).catch(() => {}));
    if (hasImages) {
      bodyEl.appendChild(buildImageGallery(msg));
      bodyEl.appendChild(buildImageMeta(msg));
      hydrateImages(bodyEl);
    }
    if (hasAudios) {
      // 合成语音：直接贴在消息文本后面
      const audioWrap = buildAudioList(msg);
      if (audioWrap) {
        bodyEl.appendChild(audioWrap);
        if (global.AudioStore) AudioStore.hydrate(audioWrap);
      }
    }
    if (msg.streaming) appendCursor(bodyEl);
  }

  /* ---------- 生成图片画廊 ---------- */
  /** 图片的可用地址：内存缓存 → 远端临时链接 → 内联 dataURL */
  function imageSrc(img) {
    if (!img) return '';
    if (global.ImageStore) {
      const cached = ImageStore.getCached(img.id);
      if (cached) return cached;
    }
    if (img.dataUrl) return img.dataUrl;
    if (img.url) return img.url;
    return '';
  }

  function buildImageGallery(msg) {
    const wrap = el('div', { class: 'gen-images' });
    const tile = tileSize(msg.imageSize);

    (msg.images || []).forEach(img => {
      if (!img || !img.id) return;
      const src = imageSrc(img);
      const figure = el('figure', {
        class: 'gen-image' + (src ? ' is-ready' : ' is-pending'),
        dataset: { imageId: img.id },
        style: tile.style
      });

      const node = el('img', {
        alt: img.name || 'generated image',
        dataset: { zoom: '1', imageId: img.id, imageName: img.name || '' },
        loading: 'lazy'
      });
      if (src) node.setAttribute('src', src);
      figure.appendChild(node);

      const bar = el('div', { class: 'gen-image-bar' });
      const dl = el('button', {
        class: 'gen-image-btn', type: 'button',
        title: T('download'), 'aria-label': T('download')
      }, [el('i', { class: 'bi bi-download' }), document.createTextNode(T('download'))]);
      dl.addEventListener('click', ev => {
        ev.stopPropagation();
        downloadImage(img);
      });
      bar.appendChild(dl);
      figure.appendChild(bar);

      wrap.appendChild(figure);
    });
    return wrap;
  }

  /**
   * 依据所选分辨率算出图片方块的比例与宽度，
   * 让横图 / 竖图都能按原比例占据合适的位置（高度大致恒定）
   */
  function tileSize(size) {
    const m = String(size || '').match(/^(\d{2,5})x(\d{2,5})$/);
    if (!m) return { style: {} };
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) return { style: {} };
    const ratio = w / h;
    const base = 340;                                   // 基准高度
    const width = Math.round(base * ratio);
    return {
      style: {
        aspectRatio: w + ' / ' + h,
        width: 'min(' + width + 'px, 100%)'
      }
    };
  }

  function buildImageMeta(msg) {
    const bits = [];
    if (msg.modelName) bits.push(T('generatedBy', msg.modelName));
    bits.push(T('imageCountOf', (msg.images || []).length));
    if (msg.imageSize) bits.push(String(msg.imageSize).replace('x', '×'));

    const meta = el('div', { class: 'gen-image-meta' }, [el('span', { text: bits.join(' · ') })]);

    const unsaved = (msg.images || []).filter(i => i && !i.saved).length;
    if (unsaved) {
      meta.appendChild(el('span', { class: 'gen-image-warn' }, [
        el('i', { class: 'bi bi-exclamation-triangle-fill' }),
        document.createTextNode(T('imageLocalWarn'))
      ]));
    } else if ((msg.images || []).length) {
      meta.appendChild(el('span', {}, [
        el('i', { class: 'bi bi-hdd' }),
        document.createTextNode(' ' + T('imageSavedLocal'))
      ]));
    }
    return meta;
  }

  /** 页面刷新后，把还没拿到 src 的生成图片从 IndexedDB 补回来 */
  function hydrateImages(root) {
    if (!global.ImageStore || !root) return;
    const list = UI.$$('img[data-image-id]', root).filter(i => !i.getAttribute('src'));
    if (!list.length) return;
    list.forEach(img => {
      const id = img.getAttribute('data-image-id');
      ImageStore.get(id).then(src => {
        if (!src) return;
        img.setAttribute('src', src);
        const fig = img.closest('.gen-image');
        if (fig) { fig.classList.remove('is-pending'); fig.classList.add('is-ready'); }
      });
    });
  }

  /* ======================================================================
     合成语音（TTS）播放
     ====================================================================== */

  /** 音频的可用地址：内存缓存 → 内联 dataURL */
  function audioSrc(audio) {
    if (!audio) return '';
    if (global.AudioStore) {
      const cached = AudioStore.getCached(audio.id);
      if (cached) return cached;
    }
    return audio.dataUrl || '';
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  /**
   * 构建单个音频播放块（浏览器原生 audio 组件）
   * @param {object} audio { id, text, voice, format, mime, ttsModelName, bytes, fileName, ext, pending, progress }
   */
  function buildAudioBlock(audio) {
    const box = el('div', {
      class: 'msg-audio' + (audio.pending ? ' is-pending' : ''),
      dataset: { audioId: audio.id || '' }
    });

    const head = el('div', { class: 'msg-audio-head' });
    head.appendChild(el('i', { class: 'bi bi-soundwave' }));

    const bits = [T('audioLabel')];
    if (audio.ttsModelName) bits.push(audio.ttsModelName);
    if (audio.voice) bits.push(audio.voice);
    head.appendChild(el('span', { class: 'msg-audio-label', text: bits.join(' · ') }));

    const metaEl = el('span', { class: 'msg-audio-meta' });
    if (audio.pending) {
      metaEl.textContent = audio.progress
        ? T('audioSynthesizingKb', Math.max(1, Math.round(audio.progress / 1024)))
        : T('audioSynthesizing');
    } else if (audio.bytes) {
      metaEl.textContent = formatBytes(audio.bytes);
    }
    head.appendChild(metaEl);

    if (!audio.pending) {
      const dl = el('button', {
        class: 'msg-audio-btn', type: 'button',
        title: T('download'), 'aria-label': T('download')
      }, [el('i', { class: 'bi bi-download' })]);
      dl.addEventListener('click', ev => { ev.stopPropagation(); downloadAudio(audio); });
      head.appendChild(dl);
    }
    box.appendChild(head);

    if (audio.pending) {
      box.appendChild(el('div', { class: 'msg-audio-loading' },
        [el('span', { class: 'thinking-dots' }, [el('span'), el('span'), el('span')])]));
      return box;
    }

    const player = el('audio', {
      class: 'msg-audio-player',
      controls: true,
      preload: 'metadata',
      dataset: { audioId: audio.id || '' }
    });
    const src = audioSrc(audio);
    if (src) player.setAttribute('src', src);
    // 元数据就绪后把时长补进标题行
    player.addEventListener('loadedmetadata', () => {
      if (!isFinite(player.duration) || !player.duration) return;
      const sec = player.duration.toFixed(1) + 's';
      metaEl.textContent = audio.bytes ? (sec + ' · ' + formatBytes(audio.bytes)) : sec;
    });
    box.appendChild(player);

    if (audio.text) {
      box.appendChild(el('div', { class: 'msg-audio-text', text: truncate(audio.text, 160) }));
    }
    return box;
  }

  /** 消息里的音频列表（紧跟在正文之后） */
  function buildAudioList(msg) {
    const list = (msg.audios || []).filter(a => a && a.id);
    if (!list.length) return null;
    const wrap = el('div', { class: 'msg-audios' });
    list.forEach(a => wrap.appendChild(buildAudioBlock(a)));
    return wrap;
  }

  /** 只重建某条消息的音频区域（合成完成 / 新增朗读时用） */
  function refreshMessageAudios(msg) {
    const node = Chat._nodes.get(msg.id);
    if (!node || !node.body) return null;
    const old = node.body.querySelector(':scope > .msg-audios');
    if (old) old.remove();
    const wrap = buildAudioList(msg);
    if (!wrap) return null;
    node.body.appendChild(wrap);
    if (global.AudioStore) AudioStore.hydrate(wrap);
    return wrap;
  }

  /* ---------- 消息音频的读写 ----------
     注意：getConv() 每次都会从存储重新解析出新的对象，
     因此对消息的修改必须「重新读取 → 按 id 定位 → 写回存储」，
     否则改动只存在于一份游离的副本里，刷新后就丢了。 */

  /** 取当前对话里最新的某条消息对象 */
  function liveMessage(messageId) {
    const conv = getConv();
    if (!conv) return null;
    return conv.messages.find(m => m.id === messageId) || null;
  }

  /** 给某条消息追加一条音频记录 */
  function addMessageAudio(messageId, audio) {
    const conv = getConv();
    if (!conv) return null;
    const target = conv.messages.find(m => m.id === messageId);
    if (!target) return null;
    if (!Array.isArray(target.audios)) target.audios = [];
    target.audios.push(audio);
    touch(conv);
    return target;
  }

  /** 更新某条消息里某条音频记录，返回更新后的【消息】对象 */
  function updateMessageAudio(messageId, audioId, patch) {
    const conv = getConv();
    if (!conv) return null;
    let touched = false;
    let target = null;
    conv.messages.forEach(m => {
      if (m.id !== messageId || !Array.isArray(m.audios)) return;
      target = m;
      m.audios.forEach(a => { if (a.id === audioId) { Object.assign(a, patch); touched = true; } });
    });
    if (touched) touch(conv);
    return target;
  }

  /** 移除某条消息里某条音频记录 */
  function removeMessageAudio(messageId, audioId) {
    const conv = getConv();
    if (!conv) return null;
    let removed = false;
    conv.messages.forEach(m => {
      if (m.id !== messageId || !Array.isArray(m.audios)) return;
      const i = m.audios.findIndex(a => a.id === audioId);
      if (i >= 0) { m.audios.splice(i, 1); removed = true; }
    });
    if (removed) touch(conv);
    return removed ? conv.messages.find(m => m.id === messageId) : null;
  }

  /** 下载合成语音 */
  function downloadAudio(audio) {
    if (!audio) return;
    if (global.AudioStore && (AudioStore.getCached(audio.id) || audio.saved)) {
      AudioStore.download(audio.id, audio.fileName, audio.ext);
      return;
    }
    if (audio.dataUrl) {
      const a = el('a', { href: audio.dataUrl, download: audio.fileName || 'audio.wav' });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
      return;
    }
    Toast.error(T('audioMissing'));
  }

  /* ---------- 朗读：模型选择 ---------- */

  /**
   * 已配置的 TTS 模型。
   * 每条消息都要判断"能不能朗读"，而 Store.getModels() 每次都会 JSON 解析一遍，
   * 长对话下会明显拖慢渲染（实测 120 条消息多花约 40%）。
   * 这里用「模型列表的原始字符串」做缓存键：读字符串远比解析便宜，模型一变即失效。
   */
  let ttsCache = { key: null, list: [] };

  function ttsModels() {
    let key = null;
    try {
      const raw = Store._raw && Store.K ? Store._raw.get(Store.K.models) : null;
      key = raw == null ? '' : raw;
    } catch (e) {
      key = null;   // 取不到就退回每次都重新解析
    }
    if (key === null || ttsCache.key !== key) {
      const list = Store.getModels().filter(m => m.kind === 'tts');
      if (key !== null) ttsCache = { key, list };
      return list;
    }
    return ttsCache.list;
  }

  function openSpeakPicker(anchorEl, msg) {
    const models = ttsModels();
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('readAloud') }));
    box.appendChild(el('div', { class: 'popover-desc', text: T('readAloudDesc') }));

    if (!models.length) {
      box.appendChild(el('div', { class: 'popover-item', role: 'button' }, [
        el('i', { class: 'bi bi-plus-circle' }),
        el('div', { class: 'pi-body' }, [el('div', { class: 'pi-title', text: T('readAloudNoModel') })])
      ])).addEventListener('click', () => {
        Popover.close();
        if (global.Settings) Settings.open('models');
      });
    } else {
      models.forEach(m => {
        const icon = (global.Logos && Logos.create) ? Logos.create(m, { size: 18 })
          : el('i', { class: 'bi bi-soundwave' });
        const info = [m.model, m.voice, String(m.audioFormat || '').toUpperCase()]
          .filter(Boolean).join('  ·  ');
        const item = el('button', { class: 'popover-item', type: 'button' }, [
          icon,
          el('div', { class: 'pi-body' }, [
            el('div', { class: 'pi-title', text: m.name }),
            el('div', { class: 'pi-desc', text: info })
          ])
        ]);
        item.addEventListener('click', () => {
          Popover.close();
          speakMessage(msg, m);
        });
        box.appendChild(item);
      });
    }

    Popover.open(anchorEl, box, { align: 'start', up: true, className: 'popover-tall' });
  }

  /** 该消息是否应该出现「朗读」按钮（仅对话模型的回复） */
  function canReadAloud(msg) {
    if (!ttsModels().length) return false;          // 没有语音模型时直接短路，避免多余计算
    if (!msg || msg.role !== 'assistant' || msg.error) return false;
    if (msg.kind === 'tts') return false;
    if (Array.isArray(msg.images) && msg.images.length) return false;
    return !!String(messageText(msg) || '').trim();
  }

  /**
   * 用指定 TTS 模型朗读某条消息，音频直接插到该消息文本后面
   * @param {object} msg 目标消息
   * @param {object} ttsModel TTS 模型配置
   */
  function speakMessage(msg, ttsModel) {
    const text = String(messageText(msg) || '').trim();
    if (!text) { Toast.warning(T('readAloudEmpty')); return Promise.resolve(null); }
    if (!ttsModel) { openSpeakPicker($('#btnSpeakDummy') || document.body, msg); return Promise.resolve(null); }

    // 同一条消息正在合成时不再重复发起（避免误连点浪费额度）
    const current = liveMessage(msg.id);
    if (current && Array.isArray(current.audios)
      && current.audios.some(a => a && a.pending)) {
      Toast.info(T('audioSynthesizing'));
      return Promise.resolve(null);
    }

    const id = Store.uid('aud');
    const pending = {
      id,
      pending: true,
      pendingSince: Date.now(),
      progress: 0,
      text,
      voice: ttsModel.voice || '',
      format: ttsModel.audioFormat,
      ttsModelId: ttsModel.id,
      ttsModelName: ttsModel.name
    };
    const messageId = msg.id;
    // 写回存储后再渲染，保证刷新后仍然存在
    const live = addMessageAudio(messageId, pending);
    const wrap = refreshMessageAudios(live || msg);
    const box = (wrap || (Chat._nodes.get(messageId) || {}).body || document)
      .querySelector('.msg-audio[data-audio-id="' + id + '"]');

    const st = settings();
    const controller = new AbortController();
    const started = Date.now();

    return API.synthesizeSpeech({
      model: ttsModel,
      text,
      voice: ttsModel.voice,
      format: ttsModel.audioFormat,
      instruction: ttsModel.ttsInstruction,
      stream: st.stream !== false && ttsModel.supportsStream !== false,
      signal: controller.signal,
      onProgress: bytes => {
        const meta = box && box.querySelector('.msg-audio-meta');
        if (meta) meta.textContent = T('audioSynthesizingKb', Math.max(1, Math.round(bytes / 1024)));
      }
    }).then(res => {
      const meta = {
        conversationId: (getConv() || {}).id || '',
        messageId,
        text,
        ttsModelId: ttsModel.id,
        ttsModelName: ttsModel.name,
        voice: ttsModel.voice || '',
        format: res.format,
        mime: res.mime,
        transcript: res.transcript || ''
      };
      const ext = (global.AudioStore ? AudioStore.extOf(res.dataUrl, res.mime) : 'wav');
      const fileName = 'lynkllm-' + String(messageId).slice(-6) + '-' + id.slice(-4) + '.' + ext;
      return (global.AudioStore
        ? AudioStore.save(id, res.dataUrl, meta)
        : Promise.resolve(false)
      ).then(saved => {
        const patch = {
          pending: false,
          progress: 0,
          bytes: res.bytes,
          mime: res.mime,
          format: res.format,
          elapsedMs: res.ms,
          saved: !!saved,
          ext,
          fileName
        };
        // 注意：这里**不能**把 dataUrl 塞回消息记录。
        // AudioStore.save() 在尝试写 IndexedDB 之前就已经写好了内存缓存，
        // 所以"落盘失败时仍能在本次会话播放"已经由缓存保证；
        // 而写入 dataUrl 会让几百 KB 的 base64 随对话一起进 localStorage，
        // 有撑爆配额、导致整条对话保存失败的风险。
        const updated = updateMessageAudio(messageId, id, patch);
        refreshMessageAudios(updated || live || msg);
        Toast.success(T('readAloudDone', ((Date.now() - started) / 1000).toFixed(1)));
        return updated;
      });
    }).catch(err => {
      const updated = removeMessageAudio(messageId, id);
      refreshMessageAudios(updated || live || msg);
      if (err && err.code === 'ABORTED') Toast.info(T('stopped'));
      else Toast.error((err && err.message) || T('readAloudFailed'), { duration: 6000 });
      return null;
    });
  }

  /** 直接以 TTS 模型作为当前对话模型时的合成流程 */
  function runSpeech(conv, model, opts) {
    opts = opts || {};
    Chat.generating = true;
    App && App.setGenerating && App.setGenerating(true);

    const placeholder = createStreamingPlaceholder();
    const box = $('#messages');
    if (placeholder.indicator && placeholder.indicator.lastChild) {
      placeholder.indicator.lastChild.textContent = T('audioSynthesizing');
    }
    if (box) {
      const prior = Chat._nodes.get('__pending__');
      if (prior && prior.row.parentNode) prior.row.remove();
      box.appendChild(placeholder.row);
    }
    Chat._nodes.set('__pending__', { row: placeholder.row, body: placeholder.body, col: placeholder.col, placeholder: true });
    scrollToBottom(true);

    const controller = new AbortController();
    Chat.controller = controller;

    const text = String(opts.text || '').trim();
    const st = settings();
    const started = Date.now();

    return API.synthesizeSpeech({
      model,
      text,
      voice: model.voice,
      format: model.audioFormat,
      instruction: model.ttsInstruction,
      stream: st.stream !== false && model.supportsStream !== false,
      signal: controller.signal,
      onProgress: bytes => {
        if (placeholder.indicator && placeholder.indicator.lastChild) {
          placeholder.indicator.lastChild.textContent =
            T('audioSynthesizingKb', Math.max(1, Math.round(bytes / 1024)));
        }
        scrollToBottom();
      }
    }).then(res => {
      const id = Store.uid('aud');
      const meta = {
        conversationId: conv.id,
        messageId: '',
        text,
        ttsModelId: model.id,
        ttsModelName: model.name,
        voice: model.voice || '',
        format: res.format,
        mime: res.mime,
        transcript: res.transcript || ''
      };
      const ext = (global.AudioStore ? AudioStore.extOf(res.dataUrl, res.mime) : 'wav');
      const fileName = 'lynkllm-' + String(id).slice(-6) + '.' + ext;
      const save = global.AudioStore ? AudioStore.save(id, res.dataUrl, meta) : Promise.resolve(false);
      return save.then(saved => {
        const audio = {
          id,
          text,
          voice: model.voice || '',
          format: res.format,
          mime: res.mime,
          ttsModelId: model.id,
          ttsModelName: model.name,
          bytes: res.bytes,
          saved: !!saved,
          ext,
          fileName
        };
        // 同上：不把音频 dataUrl 写进消息（避免占用 localStorage 配额）
        finishSpeech(conv, model, placeholder, {
          kind: 'tts',
          content: text,
          audios: [audio],
          usage: res.usage || null,
          via: res.via,
          elapsedMs: Date.now() - started
        });
        return audio;
      });
    }).catch(err => {
      if (err && err.code === 'ABORTED') {
        if (placeholder.row.parentNode) placeholder.row.remove();
        Chat._nodes.delete('__pending__');
        return null;
      }
      failGeneration(conv, placeholder, err, model);
      return null;
    }).then(r => {
      Chat.generating = false;
      Chat.controller = null;
      App && App.setGenerating && App.setGenerating(false);
      return r;
    });
  }

  /** TTS 消息落盘与渲染 */
  function finishSpeech(conv, model, placeholder, data) {
    const msg = Object.assign({
      id: Store.uid('msg'),
      role: 'assistant',
      modelName: (model && model.name) || '',
      model: (model && model.model) || '',
      createdAt: Date.now()
    }, data);

    if (msg.audios && msg.audios.length) {
      // 音频与消息通过 msg.audios[].id 关联，删除消息时按 id 清理
      msg.audios.forEach(a => { if (!a.messageId) a.messageId = msg.id; });
    }

    if (!msg.content && !(msg.audios || []).length) {
      failGeneration(conv, placeholder, new Error(T('requestFailed')), model);
      return;
    }

    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      const ctx = actionCtx();
      const built = buildMsgRow(msg, { label: assistantLabel(msg, ctx.modelFallback) });
      renderAssistantBody(built.body, msg);
      built.col.appendChild(buildFooter(msg, ctx, true));
      placeholder.row.parentNode.replaceChild(built.row, placeholder.row);
      Chat._nodes.set(msg.id, nodeRef(built));
    }
    Chat._nodes.delete('__pending__');

    conv.messages.push(msg);
    touch(conv);
    syncActionBars(conv);
    scrollToBottom();
    App && App.onConversationChanged && App.onConversationChanged();
  }

  /** 下载单张生成图片（优先本地副本，否则退回远端链接） */
  function downloadImage(img) {
    if (!img) return;
    if (global.ImageStore && (ImageStore.getCached(img.id) || img.saved)) {
      ImageStore.download(img.id, img.name, img.mime);
      return;
    }
    if (img.url) {
      const a = el('a', {
        href: img.url, download: img.name || 'image.png',
        target: '_blank', rel: 'noopener noreferrer'
      });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
      return;
    }
    Toast.error(T('imageMissing'));
  }

  /** 批量下载（拉开间隔，避免浏览器拦截连续下载） */
  function downloadImages(images) {
    const list = (images || []).filter(i => i && i.id);
    if (!list.length) return;
    list.forEach((img, i) => {
      setTimeout(() => downloadImage(img), i * 300);
    });
    if (list.length > 1) Toast.info(T('imageCountOf', list.length));
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

    const mkAction = (icon, label, cls, fn) => {
      const b = el('button', { class: 'msg-action' + (cls ? ' ' + cls : ''), type: 'button' }, [
        el('i', { class: 'bi ' + icon }), document.createTextNode(label)
      ]);
      b.addEventListener('click', () => fn());
      return b;
    };

    if (msg.role === 'assistant' && (msg.content || (Array.isArray(msg.parts) && msg.parts.length))) {
      bar.appendChild(mkAction('bi-clipboard', T('copy'), '', () => copyText(messageText(msg))));

      if (latest) {
        bar.appendChild(mkAction('bi-arrow-clockwise', T('regenerate'), '', () => ctx.onRegenerate(msg)));
      }
    }

    // 朗读：已配置 TTS 模型时，为每条对话模型的回复提供入口
    if (canReadAloud(msg)) {
      const btn = mkAction('bi-soundwave', T('readAloud'), 'speak', () => {
        if (Popover.isOpen()) { Popover.close(); return; }
        openSpeakPicker(btn, msg);
      });
      btn.title = T('readAloudDesc');
      bar.appendChild(btn);
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

    // 生成图片的消息：支持重新生成与整组下载
    if (msg.role === 'assistant' && Array.isArray(msg.images) && msg.images.length) {
      if (latest) {
        bar.appendChild(mkAction('bi-arrow-clockwise', T('regenerate'), '', () => ctx.onRegenerate(msg)));
      }
      if (msg.images.length > 1) {
        bar.appendChild(mkAction('bi-download', T('downloadAll'), '', () => downloadImages(msg.images)));
      }
    }

    // 任意消息均可单独删除
    bar.appendChild(mkAction('bi-trash3', T('delete'), 'danger', () => ctx.onDelete(msg)));

    return bar.children.length ? bar : null;
  }

  /* ---------- Token 用量行（回复正文下方、操作按钮上方） ---------- */
  function buildUsageRow(msg, ctx) {
    const st = settings();
    if (st.showTokens === false) return null;
    if (msg.role !== 'assistant') return null;

    let usage = msg.usage || null;
    if (!usage && ctx && ctx.getUsage) usage = ctx.getUsage(msg);
    if (!usage && !msg.speed) return null;

    const row = el('div', { class: 'msg-usage' });
    const chip = usage ? buildUsageChip(usage) : null;
    if (chip) row.appendChild(chip);

    // 平均输出速度（已排除工具调用耗时）
    const sp = msg.speed;
    if (sp && sp.tps > 0) {
      row.appendChild(el('span', {
        class: 'usage-speed',
        title: T('speedTip') + (sp.ms ? ('  ·  ' + (sp.ms / 1000).toFixed(2) + 's') : '')
      }, [
        el('i', { class: 'bi bi-speedometer2' }),
        el('b', { text: T('speed') }),
        document.createTextNode(' ' + sp.tps.toFixed(1) + ' ' + T('speedUnit'))
      ]));
    }

    return row.children.length ? row : null;
  }

  /* ---------- 生成模型行（操作按钮下方，始终可见） ---------- */
  /**
   * 历史消息（没有 modelName）的兜底模型名 —— 当前对话配置的模型。
   *
   * ⚠️ 只允许在「渲染一批消息」的入口调用一次，不要放进每条消息的循环里：
   * `getConv()` → `Store.getConversation()` 会把**整个 conversations 键**重新
   * JSON.parse 一遍，`Store.getModel()` 同理。对 120 条没有 modelName 的老消息，
   * 每条各查一次实测把渲染从 230ms 拖到 534ms，
   * 而 `syncActionBars()`（每次增删消息都会跑）单独就要 142ms。
   */
  function convFallbackModelName() {
    const conv = getConv();
    if (!conv) return '';
    const m = Store.getModel(conv.modelId);
    return (m && m.name) || '';
  }

  /**
   * 组装消息底部区域：先 Token 用量行，再操作按钮行。
   * 模型名不再放在这里 —— 它已经移到助手消息表头（见 assistantLabel / buildMsgRow）。
   * @param {object} msg 消息
   * @param {object} ctx 必须来自 actionCtx()
   * @param {boolean} isLatest 是否属于最新一轮
   * @returns {DocumentFragment}
   */
  function buildFooter(msg, ctx, isLatest) {
    const frag = document.createDocumentFragment();
    const usageRow = buildUsageRow(msg, ctx);
    if (usageRow) frag.appendChild(usageRow);
    const actions = buildActions(msg, ctx, isLatest);
    if (actions) frag.appendChild(actions);
    return frag;
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
      imageSize: opts.imageSize || settings().imageSize || '1024x1024',
      imageCount: Math.min(6, Math.max(1, Number(opts.imageCount || settings().imageCount) || 1)),
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

  /** 消息增删后，就地重建各条消息的底部区域（Token 行 + 操作条） */
  function syncActionBars(conv) {
    conv = conv || getConv();
    if (!conv) return;
    const latest = latestRoundIds(conv);
    // 兜底模型名成批算一次（见 convFallbackModelName 的说明）
    const fallback = convFallbackModelName();
    const ctx = actionCtx(fallback);
    conv.messages.forEach(msg => {
      const node = Chat._nodes.get(msg.id);
      if (!node || !node.col) return;
      // 表头里的模型名可能因为「重新生成 / 换模型」而变，一并同步
      if (node.roleLabel) node.roleLabel.textContent = assistantLabel(msg, fallback);
      const old = node.col.querySelectorAll(':scope > .msg-actions, :scope > .msg-usage, :scope > .msg-model');
      Array.prototype.forEach.call(old, n => n.remove());
      node.col.appendChild(buildFooter(msg, ctx, latest.has(msg.id)));
    });
  }

  /* ---------- 渲染整条会话 ---------- */
  /**
   * 清理「合成中途刷新页面」留下的悬空占位：
   * 超过 3 分钟仍是 pending 的音频记录不会再有人来收尾，直接丢弃。
   */
  function pruneStaleAudios(conv) {
    if (!conv) return;
    const now = Date.now();
    let changed = false;
    conv.messages.forEach(m => {
      if (!Array.isArray(m.audios) || !m.audios.length) return;
      const keep = m.audios.filter(a =>
        !(a && a.pending && now - (Number(a.pendingSince) || 0) > 180000));
      if (keep.length !== m.audios.length) { m.audios = keep; changed = true; }
    });
    if (changed) touch(conv);
  }

  function renderMessages() {
    const box = $('#messages');
    if (!box) return;
    const conv = getConv();
    Popover.close();
    hideStreamingCursorAll(box);
    pruneStaleAudios(conv);

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
    // 兜底模型名成批算一次（见 convFallbackModelName 的说明）
    const fallback = convFallbackModelName();
    const ctx = actionCtx(fallback);
    conv.messages.forEach(msg => {
      const built = buildMsgRow(msg, { label: assistantLabel(msg, fallback) });
      renderMessageBody(built.body, msg);
      built.col.appendChild(buildFooter(msg, ctx, latest.has(msg.id)));
      Chat._nodes.set(msg.id, nodeRef(built));
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

  /**
   * @param {string} [modelFallback] 老消息的兜底模型名；成批渲染时由调用方算一次传入
   *   （不传则现算一次，只用于「单条消息」的渲染路径）
   */
  function actionCtx(modelFallback) {
    return {
      onRegenerate: (msg) => regenerate(msg),
      onEdit: (msg) => editUserMessage(msg),
      onDelete: (msg) => deleteMessage(msg),
      modelFallback: modelFallback != null ? modelFallback : convFallbackModelName()
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
    const roleLabel = el('div', { class: 'msg-role', text: T('assistant') });
    const body = el('div', { class: 'msg-body' });
    const ind = el('div', { class: 'thinking-indicator' }, [
      el('span', { class: 'thinking-dots' }, [el('span'), el('span'), el('span')]),
      el('span', { text: '' })
    ]);
    body.appendChild(ind);
    const head = el('div', { class: 'msg-head' }, [avatar, roleLabel]);
    const col = el('div', { class: 'msg-col' }, [body]);
    const row = el('div', { class: 'msg-row assistant', dataset: { id, role: 'assistant' } }, [head, col]);
    // reasoningBox：思维链折叠块；contentBox：正文容器
    return { id, row, body, col, head, roleLabel, indicator: ind, reasoningBox: null, contentBox: null, phase: 'idle' };
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

  /* ======================================================================
     联网搜索（Tavily）
     ====================================================================== */

  /** 是否已配置 Tavily API Key */
  function tavilyReady() {
    return !!(Store.getTavily().apiKey || '').trim();
  }

  /** 当前对话的联网搜索模式：auto（由模型自行决定） | off（关闭） */
  function currentWebSearch() {
    const conv = getConv();
    const v = (conv && conv.webSearch) || settings().webSearch || 'auto';
    return v === 'off' ? 'off' : 'auto';
  }

  function setWebSearch(mode) {
    const v = mode === 'off' ? 'off' : 'auto';
    const conv = getConv();
    if (conv) { conv.webSearch = v; touch(conv); }
    else Store.saveSettings({ webSearch: v });
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  /** 该模型本轮是否启用联网搜索工具 */
  function webSearchActive(model) {
    return !!(model && model.supportsTools && tavilyReady() && currentWebSearch() !== 'off');
  }

  function openWebSearchPicker(anchorEl) {
    const cur = currentWebSearch();
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('webSearch') }));
    box.appendChild(el('div', { class: 'popover-desc', text: T('webSearchDesc') }));

    const opts = [
      { value: 'off', icon: 'bi-slash-circle', title: T('webSearchOff'), desc: T('webSearchOffDesc') },
      { value: 'auto', icon: 'bi-stars', title: T('webSearchAuto'), desc: T('webSearchAutoDesc') }
    ];
    opts.forEach(o => {
      const item = el('button', { class: 'popover-item' + (o.value === cur ? ' active' : ''), type: 'button' }, [
        el('i', { class: 'bi ' + o.icon }),
        el('div', { class: 'pi-body' }, [
          el('div', { class: 'pi-title', text: o.title }),
          el('div', { class: 'pi-desc', text: o.desc })
        ])
      ]);
      if (o.value === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
      item.addEventListener('click', () => {
        setWebSearch(o.value);
        Popover.close();
      });
      box.appendChild(item);
    });

    if (!tavilyReady()) {
      const warn = el('div', { class: 'popover-item', role: 'button' }, [
        el('i', { class: 'bi bi-key' }),
        el('div', { class: 'pi-body' }, [el('div', { class: 'pi-title', text: T('webSearchNeedTavily') })])
      ]);
      warn.addEventListener('click', () => {
        Popover.close();
        if (global.Settings) Settings.open('tavily');
      });
      box.appendChild(el('div', { class: 'popover-sep' }));
      box.appendChild(warn);
    }

    Popover.open(anchorEl, box, { align: 'start', up: true, width: 280 });
  }

  /* ======================================================================
     图片生成参数（数量 / 分辨率）
     ====================================================================== */

  function isImageModel(model) {
    return !!(model && model.kind === 'image');
  }

  /** 语音合成模型 */
  function isTtsModel(model) {
    return !!(model && model.kind === 'tts');
  }

  function currentImageCount() {
    const conv = getConv();
    const raw = conv && conv.imageCount ? conv.imageCount : settings().imageCount;
    return Math.min(6, Math.max(1, Number(raw) || 1));
  }

  function currentImageSize() {
    const conv = getConv();
    const raw = (conv && conv.imageSize) || settings().imageSize || '1024x1024';
    return String(raw);
  }

  /** 分辨率展示文案 */
  function imageSizeLabel(size) {
    const s = String(size || '');
    if (!s || s === 'auto') return T('genSizeAuto');
    return s.replace('x', '×');
  }

  function setImageCount(n) {
    const v = Math.min(6, Math.max(1, Number(n) || 1));
    Store.saveSettings({ imageCount: v });
    const conv = getConv();
    if (conv) { conv.imageCount = v; touch(conv); }
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  function setImageSize(size) {
    const v = String(size || '1024x1024');
    Store.saveSettings({ imageSize: v });
    const conv = getConv();
    if (conv) { conv.imageSize = v; touch(conv); }
    if (global.App && App.onModelChanged) App.onModelChanged();
  }

  function openImageCountPicker(anchorEl) {
    const cur = currentImageCount();
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('genCount') }));
    [1, 2, 3, 4, 5, 6].forEach(n => {
      const item = el('button', { class: 'popover-item' + (n === cur ? ' active' : ''), type: 'button' }, [
        el('i', { class: 'bi ' + (n === 1 ? 'bi-image' : 'bi-images') }),
        el('div', { class: 'pi-body' }, [el('div', { class: 'pi-title', text: T('genCountChip', n) })])
      ]);
      if (n === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
      item.addEventListener('click', () => { setImageCount(n); Popover.close(); });
      box.appendChild(item);
    });
    Popover.open(anchorEl, box, { align: 'start', up: true });
  }

  function openImageSizePicker(anchorEl) {
    const cur = currentImageSize();
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('genSize') }));

    const presets = (Store.IMAGE_SIZE_PRESETS || []).slice();
    if (!presets.some(p => p.value === cur)) {
      presets.unshift({ value: cur, label: imageSizeLabel(cur) });
    }
    presets.forEach(p => {
      const item = el('button', { class: 'popover-item' + (p.value === cur ? ' active' : ''), type: 'button' }, [
        el('i', { class: 'bi ' + (p.value === 'auto' ? 'bi-magic' : 'bi-aspect-ratio') }),
        el('div', { class: 'pi-body' }, [
          el('div', { class: 'pi-title', text: p.value === 'auto' ? T('genSizeAuto') : p.label })
        ])
      ]);
      if (p.value === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
      item.addEventListener('click', () => { setImageSize(p.value); Popover.close(); });
      box.appendChild(item);
    });

    box.appendChild(el('div', { class: 'popover-sep' }));

    // 自定义分辨率（不使用浏览器原生弹窗）
    const wrap = el('div', { style: { padding: '2px 6px 4px' } });
    const input = el('input', {
      class: 'input mono', type: 'text', placeholder: '1024x1024',
      style: { width: '100%' }
    });
    input.value = /^\d+x\d+$/.test(cur) ? cur : '';
    const row = el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } });
    const ok = el('button', { class: 'btn primary sm', type: 'button', text: T('save'), style: { flex: '1' } });
    const cancel = el('button', { class: 'btn sm', type: 'button', text: T('cancel'), style: { flex: '1' } });
    row.appendChild(ok);
    row.appendChild(cancel);
    wrap.appendChild(el('div', { class: 'popover-label', text: T('genSizeCustomTitle') }));
    wrap.appendChild(input);
    wrap.appendChild(row);
    box.appendChild(wrap);

    const commit = () => {
      const v = String(input.value || '').trim().toLowerCase().replace(/[×*]/g, 'x');
      if (!/^\d{2,5}x\d{2,5}$/.test(v)) {
        Toast.warning(T('genSizeInvalid'));
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
        return;
      }
      setImageSize(v);
      Popover.close();
    };
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', () => Popover.close());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); Popover.close(); }
      e.stopPropagation();
    });

    Popover.open(anchorEl, box, { align: 'start', up: true, width: 268, className: 'popover-tall' });
    // preventScroll：避免聚焦自定义输入框时把列表滚到底部
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 40);
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
    if (isImageModel(model) && !text) {
      Toast.warning(T('genImageEmptyPrompt'));
      return;
    }

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

    // 图片模型：走图片生成流程
    if (isImageModel(model)) {
      return runImageGeneration(conv, model, { prompt: text, images: userMsg.images });
    }
    // 语音合成模型：把输入文本直接合成音频
    if (isTtsModel(model)) {
      return runSpeech(conv, model, { text });
    }
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

    const ctx = actionCtx();
    const built = buildMsgRow(msg, { label: assistantLabel(msg, ctx.modelFallback) });
    renderMessageBody(built.body, msg);
    built.col.appendChild(buildFooter(msg, ctx, true));
    Chat._nodes.set(msg.id, nodeRef(built));
    box.appendChild(built.row);
    // 新消息入列后，之前的一轮不再是最新一轮 → 隐藏其「编辑 / 重新生成」
    syncActionBars(conv || getConv());
    scrollToBottom(true);
  }

  /* ---------- 核心请求 ---------- */
  /** 把一条本地消息展开为回传给 API 的消息序列（含多轮工具调用轨迹） */
  function expandForApi(m) {
    if (!m) return [];
    const trace = Array.isArray(m.toolTrace) ? m.toolTrace : null;
    const out = [];
    if (m.role === 'assistant' && trace && trace.length) {
      trace.forEach(t => {
        if (!t) return;
        if (Array.isArray(t.tool_calls) && t.tool_calls.length) {
          out.push({ role: 'assistant', content: t.content || '', tool_calls: t.tool_calls });
        } else if (t.tool_call_id) {
          out.push({ role: 'tool', tool_call_id: t.tool_call_id, content: t.content || '' });
        }
      });
      if (m.content) out.push({ role: 'assistant', content: m.content });
      return out;
    }
    out.push({ role: m.role, content: m.content, images: m.images });
    return out;
  }

  /** 消息的可复制文本：有分段时拼接所有正文段，否则用 content */
  function messageText(msg) {
    if (msg && msg.role === 'assistant' && Array.isArray(msg.parts) && msg.parts.length) {
      const t = msg.parts.filter(p => p && p.type === 'content' && p.text)
        .map(p => String(p.text)).join('\n\n');
      if (t) return t;
    }
    return (msg && msg.content) || '';
  }

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
    const useStream = st.stream && model.supportsStream !== false;
    const batch = Math.max(1, Number(st.streamRenderBatch) || 1);
    const maxRounds = Math.min(12, Math.max(1, Number(st.maxToolRounds) || 6));

    // 联网搜索：仅当模型声明支持工具调用、已配置 Tavily Key 且本轮开关不是 off
    const searchEnabled = webSearchActive(model);
    let tools = searchEnabled ? [API.tavilyTool(Store.getTavilyForced())] : null;

    // 回传给 API 的历史（工具轨迹会展开成多轮消息）
    const apiMessages = [];
    conv.messages.slice(-MAX_HISTORY_MESSAGES).forEach(m => {
      expandForApi(m).forEach(x => apiMessages.push(x));
    });

    /* ---------- 累计统计 ---------- */
    let outputTokens = 0;      // 各轮输出 token 之和（用于平均速度）
    let genMs = 0;             // 各轮请求耗时之和（不含工具执行耗时）
    let lastUsage = null;      // 用于展示的 token 明细（取最后一次真实用量）
    let reasoningAll = '';
    let lastContent = '';
    const parts = [];          // 展示与持久化的分段：reasoning / tool / content
    const toolTrace = [];      // 回放用的工具轨迹
    let rounds = 0;
    let aborted = false;
    let limitNoticed = false;

    /* ---------- 当前轮的流式状态 ---------- */
    let cur = null;
    let renderTimer = null;
    let pendingCount = 0;
    let lastRender = 0;

    function ensureIndicator() {
      const ind = placeholder.indicator;
      if (!ind) return null;
      if (ind.parentNode !== placeholder.body || placeholder.body.lastChild !== ind) {
        placeholder.body.appendChild(ind);
      }
      return ind;
    }

    function removeIndicator() {
      const ind = placeholder.indicator;
      if (ind && ind.parentNode) ind.remove();
    }

    function setIndicatorText(text) {
      const ind = ensureIndicator();
      if (ind && ind.lastChild) ind.lastChild.textContent = text == null ? '' : text;
    }

    function beginRound() {
      rounds++;
      cur = {
        reasoningText: '', contentText: '', reasoningBox: null, contentBox: null,
        reasoningT0: 0, reasoningMs: 0   // 本段思考的起止时间（用于显示「思考用时」）
      };
      setIndicatorText('');
      ensureIndicator();
      return cur;
    }

    /**
     * 本段思考结束：记下耗时并写进折叠块头部。
     * 触发时机是「思考转入正文 / 工具调用」，而不是整轮请求结束，
     * 否则会把正文生成的时间也算进思考耗时里。
     */
    function endReasoning() {
      if (!cur || !cur.reasoningT0 || cur.reasoningMs) return;
      cur.reasoningMs = Date.now() - cur.reasoningT0;
      if (cur.reasoningBox) {
        cur.reasoningBox.dataset.ms = String(cur.reasoningMs);
        refreshReasoningMeta(cur.reasoningBox);
      }
    }

    /** 流式渲染节流：累计 N 个片段才重绘一次，同时有最长等待兜底 */
    function renderContent(force) {
      if (!cur || !cur.contentBox) return;
      const now = Date.now();
      if (!force) {
        pendingCount++;
        if (pendingCount < batch && now - lastRender < STREAM_MAX_WAIT) {
          if (!renderTimer) {
            renderTimer = setTimeout(() => {
              renderTimer = null;
              pendingCount = 0;
              renderContent(true);
            }, STREAM_MAX_WAIT);
          }
          return;
        }
      }
      pendingCount = 0;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      lastRender = now;
      let html;
      try { html = MD.toHtml(cur.contentText); } catch (e) {
        html = '<div class="md-plaintext">' + UI.escapeHtml(cur.contentText) + '</div>';
      }
      cur.contentBox.innerHTML = html;
      // 流式期间跳过代码高亮 / 公式 / 图表等重活，结束后统一增强
      MD.enhance(cur.contentBox, { light: true }).catch(() => {});
    }

    /**
     * 折叠消息流里**已完成**的搜索块。
     * 三个调用时机（缺一个都会让多轮搜索堆一屏展开的块）：
     *   1. 开始新一段思考（pushReasoning）
     *   2. 开始新一次搜索（发起 tool_call 之前）
     *   3. 开始输出正文（pushContent）
     * 只收「已结束且当前展开」的块，正在进行中的那块保持展开。
     */
    function collapseDoneToolBlocks() {
      UI.$$('.tool-call', placeholder.body).forEach(box => {
        if (box.classList.contains('live') || !box.classList.contains('open')) return;
        box.classList.remove('open');
        const head = box.querySelector('.tool-head');
        if (head) head.setAttribute('aria-expanded', 'false');
      });
    }

    function pushReasoning(chunk) {
      if (!cur) beginRound();
      if (!cur.reasoningT0) cur.reasoningT0 = Date.now();
      cur.reasoningText += chunk;
      placeholder.body.classList.add('md');
      if (!cur.reasoningBox) {
        // 新一段思考：折叠上一段已完成的搜索过程，并开启新的一块（展开）
        collapseDoneToolBlocks();
        removeIndicator();
        cur.reasoningBox = buildReasoningBlock(cur.reasoningText, 'live', true);
        placeholder.body.appendChild(cur.reasoningBox);
        ensureIndicator();
      } else {
        updateReasoningBlock(cur.reasoningBox, cur.reasoningText, 'live');
      }
      scrollToBottom();
    }

    function pushContent(chunk, whole) {
      if (!cur) beginRound();
      cur.contentText = (whole != null && whole !== '') ? whole : (cur.contentText + (chunk || ''));
      if (!cur.contentBox) {
        removeIndicator();
        // 开始输出正文：本段思考结束，先定格耗时再折叠
        endReasoning();
        if (cur.reasoningBox) collapseReasoningBlock(cur.reasoningBox);
        // 正文开始也意味着搜索阶段结束，同样把已完成的搜索块收起来
        collapseDoneToolBlocks();
        cur.contentBox = el('div', { class: 'md-content' });
        placeholder.body.appendChild(cur.contentBox);
      }
      renderContent(false);
      scrollToBottom();
    }

    function accumulateUsage(res, roundContent, roundReasoning) {
      const u = res && res.usage;
      if (u && !u.estimated) {
        lastUsage = u;
        outputTokens += Number(u.output) || 0;
        return;
      }
      outputTokens += UI.estimateTokens(String(roundContent || '') + String(roundReasoning || ''));
    }

    /** 组装展示用用量：输入取最后一轮（已包含全部上下文），输出为各轮之和 */
    function buildUsage() {
      if (lastUsage) {
        const input = lastUsage.input != null ? Number(lastUsage.input) : null;
        const prevOut = Number(lastUsage.output) || 0;
        const total = input != null
          ? input + outputTokens
          : (lastUsage.total != null ? (Number(lastUsage.total) - prevOut + outputTokens) : null);
        return {
          inputHit: lastUsage.inputHit,
          inputMiss: lastUsage.inputMiss,
          input: input,
          output: outputTokens,
          total: total,
          reasoning: lastUsage.reasoning,
          estimated: false
        };
      }
      return outputTokens > 0 ? { estimated: true, total: outputTokens } : null;
    }

    /** 平均输出速度：只统计模型生成耗时（请求往返），不含工具执行时间 */
    function buildSpeed(usage) {
      const tokens = (usage && usage.output) || outputTokens;
      if (!tokens || genMs <= 0) return null;
      const tps = tokens / (genMs / 1000);
      if (!isFinite(tps) || tps <= 0) return null;
      return { tps: Math.round(tps * 10) / 10, tokens: tokens, ms: Math.round(genMs) };
    }

    /** 执行一批工具调用，并把工具块按序插入消息流 */
    async function execTools(calls, preContent) {
      const entry = {
        content: preContent || '',
        tool_calls: calls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments }
        }))
      };
      apiMessages.push({ role: 'assistant', content: entry.content, tool_calls: entry.tool_calls });
      toolTrace.push(entry);

      for (const c of calls) {
        const args = API.parseToolArgs(c.function.arguments);
        const tool = {
          type: 'tool',
          id: c.id,
          name: c.function.name,
          query: args && args.query ? String(args.query) : '',
          args,
          status: 'running',
          results: [],
          answer: '',
          images: [],
          ms: 0
        };
        parts.push(tool);

        // 开始搜索：本段思考结束（定格耗时），自动折叠刚才的思考过程
        endReasoning();
        if (cur && cur.reasoningBox) collapseReasoningBlock(cur.reasoningBox);
        /* ⚠️ 连续多轮搜索时，模型**可能不再输出思考段落就直接发起下一次搜索**
           （pushReasoning 不会被调用，而原先只有它触发折叠）→ 上一轮的搜索块
           就一直摊开着，一轮轮堆下去很难看。这里在新建工具块**之前**再收一次，
           保证「开始下一段搜索/思考/正文输出」三个时机都会折叠。 */
        collapseDoneToolBlocks();
        // 搜索进行态由工具块自身表达，这里不再重复显示状态文字
        removeIndicator();
        const node = buildToolBlock(tool, true);
        placeholder.body.appendChild(node);
        scrollToBottom();

        const t0 = Date.now();
        let payload;
        try {
          const r = await API.tavilySearch(args, Store.getTavily().apiKey, controller.signal, Store.getTavilyForced());
          tool.status = 'done';
          tool.query = tool.query || (r && r.query) || '';
          tool.results = (r && r.results) || [];
          tool.answer = (r && r.answer) || '';
          tool.images = (r && r.images) || [];
          tool.ms = Date.now() - t0;
          payload = API.formatTavilyForModel(r);
        } catch (e) {
          tool.ms = Date.now() - t0;
          if (e && e.code === 'ABORTED') {
            tool.status = 'error';
            tool.error = T('stopped');
            updateToolBlock(node, tool);
            throw e;
          }
          tool.status = 'error';
          tool.error = (e && e.message) || String(e);
          updateToolBlock(node, tool);
          payload = JSON.stringify({
            error: tool.error,
            note: 'Web search failed. Answer from your own knowledge and tell the user the search was unavailable.'
          });
        }
        updateToolBlock(node, tool);

        const toolMsg = { role: 'tool', tool_call_id: c.id, content: payload };
        apiMessages.push(toolMsg);
        toolTrace.push(toolMsg);
        // 工具结束：恢复「等待中」指示器，供下一轮思考 / 正文使用
        ensureIndicator();
        setIndicatorText('');
        scrollToBottom();
      }
    }

    async function runLoop() {
      while (true) {
        beginRound();
        const started = Date.now();
        let res = null;
        try {
          res = await API.chat({
            model,
            messages: apiMessages,
            stream: useStream,
            thinking: currentThinking(),
            tools,
            toolChoice: 'auto',
            signal: controller.signal,
            historyLimit: 0,
            onOpen: () => { placeholder.row.dataset.started = '1'; },
            onReasoning: (chunk) => { pushReasoning(chunk); },
            onDelta: (chunk, whole) => { pushContent(chunk, whole); }
          });
        } finally {
          genMs += Date.now() - started;
        }

        // 收尾本轮：思考块定稿并折叠，正文重绘为最终态
        const roundReasoning = (res && res.reasoning) || (cur ? cur.reasoningText : '');
        const roundContent = (res && res.content) || (cur ? cur.contentText : '');
        // 兜底：思考后既没有正文也没有工具调用（例如被中断）时，在这里定格耗时
        endReasoning();
        if (cur && cur.reasoningBox && cur.reasoningText) {
          updateReasoningBlock(cur.reasoningBox, cur.reasoningText, 'done');
          collapseReasoningBlock(cur.reasoningBox);
        }
        if (cur && cur.contentBox) renderContent(true);

        if (roundReasoning && String(roundReasoning).trim()) {
          parts.push({ type: 'reasoning', text: roundReasoning, ms: (cur && cur.reasoningMs) || 0 });
          reasoningAll += (reasoningAll ? '\n\n' : '') + roundReasoning;
        }
        if (roundContent && String(roundContent).trim()) {
          parts.push({ type: 'content', text: roundContent });
          lastContent = roundContent;
        }
        accumulateUsage(res, roundContent, roundReasoning);

        if (!res || res.aborted || res.partial) {
          aborted = !!(res && res.aborted);
          break;
        }

        const calls = ((res.toolCalls) || []).filter(c => c && c.function && c.function.name);
        if (!calls.length) break;
        if (!tools) break;   // 本轮已禁用工具但模型仍返回：不再处理，直接用已有正文

        await execTools(calls, roundContent);

        if (rounds >= maxRounds) {
          // 达到轮数上限：下一轮不再提供工具，强制模型给出结论
          tools = null;
          if (!limitNoticed) {
            limitNoticed = true;
            Toast.info(T('toolRoundsLimit', maxRounds));
          }
        }
      }
    }

    return runLoop().then(() => {
      const usage = buildUsage();
      finishGeneration(conv, model, placeholder, {
        content: lastContent,
        reasoning: reasoningAll,
        usage,
        parts,
        toolTrace,
        speed: buildSpeed(usage),
        aborted,
        searched: searchEnabled && toolTrace.length > 0
      });
      return { content: lastContent };
    }).catch(err => {
      const isAbort = err && err.code === 'ABORTED';
      if (isAbort && (lastContent || parts.length)) {
        const usage = buildUsage();
        finishGeneration(conv, model, placeholder, {
          content: lastContent,
          reasoning: reasoningAll,
          usage,
          parts,
          toolTrace,
          speed: buildSpeed(usage),
          aborted: true,
          searched: searchEnabled && toolTrace.length > 0
        });
        return null;
      }
      failGeneration(conv, placeholder, err, model);
      return null;
    }).then(r => {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      Chat.generating = false;
      Chat.controller = null;
      App && App.setGenerating && App.setGenerating(false);
      return r;
    });
  }

  /* ======================================================================
     图片生成
     ====================================================================== */

  function runImageGeneration(conv, model, opts) {
    opts = opts || {};
    Chat.generating = true;
    App && App.setGenerating && App.setGenerating(true);

    const box = $('#messages');
    const placeholder = createStreamingPlaceholder();
    if (placeholder.indicator && placeholder.indicator.lastChild) {
      placeholder.indicator.lastChild.textContent = T('genImagePending');
    }
    if (box) {
      const prior = Chat._nodes.get('__pending__');
      if (prior && prior.row.parentNode) prior.row.remove();
      box.appendChild(placeholder.row);
    }
    Chat._nodes.set('__pending__', { row: placeholder.row, body: placeholder.body, col: placeholder.col, placeholder: true });
    scrollToBottom(true);

    const controller = new AbortController();
    Chat.controller = controller;

    const size = currentImageSize();
    const count = currentImageCount();
    const prompt = String(opts.prompt || '').trim();

    return API.generateImage({
      model,
      prompt,
      n: count,
      size,
      images: opts.images || [],
      signal: controller.signal
    }).then(res => persistGeneratedImages(conv, model, res, { size, prompt }))
      .then(data => {
        finishImageGeneration(conv, model, placeholder, data);
        return data;
      })
      .catch(err => {
        if (err && err.code === 'ABORTED') {
          // 用户主动停止：移除占位，不产生错误消息
          if (placeholder.row.parentNode) placeholder.row.remove();
          Chat._nodes.delete('__pending__');
          return null;
        }
        failGeneration(conv, placeholder, err, model);
        return null;
      })
      .then(r => {
        Chat.generating = false;
        Chat.controller = null;
        App && App.setGenerating && App.setGenerating(false);
        return r;
      });
  }

  /** 把返回的图片落到 IndexedDB，并生成消息里的图片记录 */
  function persistGeneratedImages(conv, model, res, meta) {
    const list = (res && res.images) || [];
    const records = [];

    const handle = (item, index) => {
      const name = 'image-' + (index + 1);
      const id = Store.uid('img');
      const info = {
        conversationId: conv.id,
        prompt: meta.prompt,
        modelName: model.name,
        model: model.model
      };

      // 1) 直接就是 base64：直接落盘
      if (item.b64) {
        const dataUrl = API.b64ToDataUrl(item.b64);
        const mime = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
        return ImageStore.save(id, dataUrl, info).then(ok => {
          records.push({ id, name, mime, saved: !!ok, url: '' });
        });
      }

      if (!item.url) return Promise.resolve();

      // 2) 返回的是 URL：尽快下载成本地副本（链接通常有有效期）
      return API.fetchImageAsDataUrl(item.url).then(dataUrl => {
        const mime = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
        return ImageStore.save(id, dataUrl, info).then(ok => {
          records.push({ id, name, mime, saved: !!ok, url: '' });
        });
      }).catch(err => {
        // 跨域被拒等：保留临时链接，提示用户尽快下载
        console.warn('[chat] 生成图片本地保存失败：', err && err.message);
        records.push({ id, name, mime: 'image/png', saved: false, url: item.url });
      });
    };

    return list.reduce((chain, item, i) => chain.then(() => handle(item, i)), Promise.resolve())
      .then(() => ({
        content: '',
        images: records,
        imageSize: meta.size,
        modelName: model.name,
        model: model.model,
        via: (res && res.via) || 'images',
        createdAt: Date.now()
      }));
  }

  function finishImageGeneration(conv, model, placeholder, data) {
    const msg = Object.assign({
      id: Store.uid('msg'),
      role: 'assistant'
    }, data);

    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      const ctx = actionCtx();
      const built = buildMsgRow(msg, { label: assistantLabel(msg, ctx.modelFallback) });
      renderAssistantBody(built.body, msg);
      built.col.appendChild(buildFooter(msg, ctx, true));
      placeholder.row.parentNode.replaceChild(built.row, placeholder.row);
      Chat._nodes.set(msg.id, nodeRef(built));
    }
    Chat._nodes.delete('__pending__');

    conv.messages.push(msg);
    touch(conv);
    syncActionBars(conv);
    scrollToBottom();
    App && App.onConversationChanged && App.onConversationChanged();
    if (msg.images && msg.images.length) Toast.success(T('genImageDone', msg.images.length));
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

    // 分段（思维链 / 搜索过程 / 正文）与工具轨迹：有内容时才落盘
    if (Array.isArray(result.parts) && result.parts.length) data.parts = result.parts;
    if (Array.isArray(result.toolTrace) && result.toolTrace.length) data.toolTrace = result.toolTrace;
    if (result.speed) data.speed = result.speed;

    if (!data.content && !data.reasoning && !data.usage && !data.parts) {
      // 什么都没有：当作失败
      failGeneration(conv, placeholder, new Error(T('requestFailed')), model);
      return;
    }

    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      const ctx = actionCtx();
      const built = buildMsgRow(data, { label: assistantLabel(data, ctx.modelFallback) });
      renderAssistantBody(built.body, data);
      built.col.appendChild(buildFooter(data, ctx, true));
      placeholder.row.parentNode.replaceChild(built.row, placeholder.row);
      Chat._nodes.set(data.id, nodeRef(built));
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

  function failGeneration(conv, placeholder, err, model) {
    if (placeholder && placeholder.row && placeholder.row.parentNode) {
      placeholder.row.remove();
    }
    Chat._nodes.delete('__pending__');

    const errData = {
      id: Store.uid('msg'),
      role: 'assistant',
      content: '',
      modelName: (model && model.name) || '',
      model: (model && model.model) || '',
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
    // 图片模型：复用被移除的用户消息作为提示词，重新出图
    if (isImageModel(model)) {
      const lastUser = conv.messages.slice().reverse().find(m => m.role === 'user');
      runImageGeneration(conv, model, {
        prompt: lastUser ? lastUser.content : '',
        images: (lastUser && lastUser.images) || []
      });
      return;
    }
    // 语音模型：复用被移除的用户消息文本，重新合成（不能走对话补全）
    if (isTtsModel(model)) {
      const lastUser = conv.messages.slice().reverse().find(m => m.role === 'user');
      runSpeech(conv, model, { text: lastUser ? lastUser.content : '' });
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

      // 该消息生成的图片 / 音频一并清理
      if (global.ImageStore && Array.isArray(msg.images) && msg.images.length) {
        const ids = msg.images.filter(i => i && i.id).map(i => i.id);
        if (ids.length) ImageStore.removeMany(ids);
      }
      if (global.AudioStore && Array.isArray(msg.audios) && msg.audios.length) {
        const aids = msg.audios.filter(a => a && a.id).map(a => a.id);
        if (aids.length) AudioStore.removeMany(aids);
      }

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
      // 注意：以前只区分 image / chat，语音（tts）模型会被错分到「对话」组里
      const kindOf = m => {
        const k = m && m.kind;
        return (k === 'image' || k === 'tts') ? k : 'chat';
      };
      const groups = [
        { kind: 'chat', label: T('kindChat') },
        { kind: 'image', label: T('kindImage') },
        { kind: 'tts', label: T('kindTts') }
      ];
      const present = groups.filter(g => models.some(m => kindOf(m) === g.kind));
      const multiKind = present.length > 1;

      groups.forEach(g => {
        const list = models.filter(m => kindOf(m) === g.kind);
        if (!list.length) return;
        if (multiKind) box.appendChild(el('div', { class: 'popover-label', text: g.label }));

        list.forEach(m => {
          const item = el('button', { class: 'popover-item' + (m.id === cur ? ' active' : ''), type: 'button' });
          // 品牌图标
          const logo = Logos.create(m, { size: 16 });
          logo.classList.add('popover-logo');
          item.appendChild(logo);

          const body = el('div', { class: 'pi-body' }, [
            el('div', { class: 'pi-title', text: m.name }),
            el('div', { class: 'pi-desc', text: m.model || '—' })
          ]);
          item.appendChild(body);
          if (m.id === cur) item.appendChild(el('i', { class: 'bi bi-check2' }));
          item.addEventListener('click', () => {
            setModel(m.id);
            Popover.close();
            Toast.success(m.name);
          });
          box.appendChild(item);
        });
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
    off: { zh: '关闭', en: 'Off', icon: 'bi-dash-circle' },
    none: { zh: '关闭', en: 'None', icon: 'bi-dash-circle' },
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
      // 工具调用（含搜索结果回传）同样占用上下文
      if (Array.isArray(m.toolTrace)) {
        m.toolTrace.forEach(t => {
          if (!t) return;
          extra += UI.estimateTokens(String(t.content || ''));
          if (Array.isArray(t.tool_calls)) {
            t.tool_calls.forEach(c => {
              extra += UI.estimateTokens(String((c && c.function && c.function.arguments) || ''));
            });
          }
        });
      }
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
  Chat.buildUsageRow = buildUsageRow;
  Chat.buildFooter = buildFooter;
  Chat.assistantLabel = assistantLabel;
  Chat.buildUsageChip = buildUsageChip;
  Chat.messageText = messageText;
  Chat.expandForApi = expandForApi;
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
  Chat.tavilyReady = tavilyReady;
  Chat.currentWebSearch = currentWebSearch;
  Chat.setWebSearch = setWebSearch;
  Chat.webSearchActive = webSearchActive;
  Chat.openWebSearchPicker = openWebSearchPicker;
  Chat.currentModel = currentModel;
  Chat.currentModelId = currentModelId;
  Chat.currentModelName = currentModelName;
  Chat.currentThinking = currentThinking;
  Chat.handleFiles = handleFiles;
  Chat.openModelPicker = openModelPicker;
  Chat.openThinkingPicker = openThinkingPicker;
  Chat.isImageModel = isImageModel;
  Chat.isTtsModel = isTtsModel;
  Chat.ttsModels = ttsModels;
  Chat.speakMessage = speakMessage;
  Chat.openSpeakPicker = openSpeakPicker;
  Chat.canReadAloud = canReadAloud;
  Chat.runSpeech = runSpeech;
  Chat.buildAudioBlock = buildAudioBlock;
  Chat.refreshMessageAudios = refreshMessageAudios;
  Chat.downloadAudio = downloadAudio;
  Chat.currentImageCount = currentImageCount;
  Chat.currentImageSize = currentImageSize;
  Chat.imageSizeLabel = imageSizeLabel;
  Chat.setImageCount = setImageCount;
  Chat.setImageSize = setImageSize;
  Chat.openImageCountPicker = openImageCountPicker;
  Chat.openImageSizePicker = openImageSizePicker;
  Chat.runImageGeneration = runImageGeneration;
  Chat.downloadImage = downloadImage;
  Chat.downloadImages = downloadImages;
  Chat.hydrateImages = hydrateImages;
  Chat.updateCharCount = updateCharCount;
  Chat.scrollToBottom = scrollToBottom;
  Chat.forceScrollToBottom = forceScrollToBottom;
  Chat.makeFallbackTitle = makeFallbackTitle;
  Chat.buildErrorBlock = buildErrorBlock;

  global.Chat = Chat;
})(window);
