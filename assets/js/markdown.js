/* ==========================================================================
   LynkLLM CE — Markdown / 富文本渲染
   依赖（均为可选，按需从 CDN 懒加载）：
     marked      — Markdown 解析
     DOMPurify   — HTML 净化（防 XSS）
     highlight.js— 代码高亮
     KaTeX       — LaTeX 公式
     mermaid     — 图表
   全部不可用时回退为纯文本展示，功能不中断。
   ========================================================================== */
(function (global) {
  'use strict';

  const doc = global.document;

  /* 数学公式文本前缀：绕过 HTML 净化对自定义属性的清洗 */
  const MATH_PREFIX = '\u2063MATH:';

  /* 支持在弹窗内直接预览的代码块语言 */
  const PREVIEW_LANGS = ['html', 'htm', 'xhtml'];

  const state = {
    marked: null,
    DOMPurify: null,
    hljs: null,
    katex: null,
    mermaid: null,
    mermaidId: 0,
    loading: {}
  };

  /* ---------- 通用脚本加载 ---------- */
  function loadScript(src) {
    if (state.loading[src]) return state.loading[src];
    state.loading[src] = new Promise((resolve, reject) => {
      const el = doc.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve(true);
      el.onerror = () => { delete state.loading[src]; reject(new Error('load failed: ' + src)); };
      doc.head.appendChild(el);
    });
    return state.loading[src];
  }

  const CDN = {
    marked: [
      'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
      'https://unpkg.com/marked@12.0.2/marked.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js'
    ],
    dompurify: [
      'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
      'https://unpkg.com/dompurify@3.1.6/dist/purify.min.js'
    ],
    hljs: [
      'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
      'https://unpkg.com/@highlightjs/cdn-assets@11.9.0/highlight.min.js'
    ],
    katex: [
      'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js',
      'https://unpkg.com/katex@0.16.9/dist/katex.min.js'
    ],
    mermaid: [
      'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js',
      'https://unpkg.com/mermaid@10.9.1/dist/mermaid.min.js'
    ]
  };

  function loadFirst(urls) {
    let p = Promise.reject(new Error('no url'));
    urls.forEach(u => {
      p = p.catch(() => loadScript(u));
    });
    return p;
  }

  function ensureMarked() {
    if (state.marked) return Promise.resolve(state.marked);
    if (global.marked) { state.marked = global.marked; return Promise.resolve(state.marked); }
    return loadFirst(CDN.marked).then(() => {
      state.marked = global.marked || null;
      console.info('[markdown] marked 就绪');
      return state.marked;
    });
  }

  function ensurePurify() {
    if (state.DOMPurify) return Promise.resolve(state.DOMPurify);
    if (global.DOMPurify) { state.DOMPurify = global.DOMPurify; return Promise.resolve(state.DOMPurify); }
    return loadFirst(CDN.dompurify).then(() => {
      state.DOMPurify = global.DOMPurify || null;
      return state.DOMPurify;
    }).catch(() => null);
  }

  function ensureHljs() {
    if (state.hljs) return Promise.resolve(state.hljs);
    if (global.hljs) { state.hljs = global.hljs; return Promise.resolve(state.hljs); }
    return loadFirst(CDN.hljs).then(() => {
      state.hljs = global.hljs || null;
      return state.hljs;
    }).catch(() => null);
  }

  function ensureKatex() {
    if (state.katex) return Promise.resolve(state.katex);
    if (global.katex) { state.katex = global.katex; return Promise.resolve(state.katex); }
    return loadFirst(CDN.katex).then(() => {
      state.katex = global.katex || null;
      return state.katex;
    }).catch(() => null);
  }

  function ensureMermaid() {
    if (state.mermaid) return Promise.resolve(state.mermaid);
    if (global.mermaid) {
      state.mermaid = bootMermaid(global.mermaid);
      return Promise.resolve(state.mermaid);
    }
    return loadFirst(CDN.mermaid).then(() => {
      state.mermaid = global.mermaid ? bootMermaid(global.mermaid) : null;
      return state.mermaid;
    }).catch(() => null);
  }

  function bootMermaid(lib) {
    try {
      lib.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
        fontFamily: 'inherit',
        flowchart: { htmlLabels: false, useMaxWidth: true },
        er: { useMaxWidth: true },
        gantt: { useMaxWidth: true }
      });
    } catch (e) { /* noop */ }
    return lib;
  }

  /** 主题切换后重建 mermaid */
  function resetMermaid() {
    state.mermaid = null;
  }

  /* ---------- marked 扩展 ---------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setupMarked(marked) {
    if (marked.__lynkPatched) return marked;

    // 关闭默认的 mangle / headerIds 兼容处理（不同版本 API 差异较大），
    // 使用自定义 renderer 全权接管。
    const renderer = new marked.Renderer();

    renderer.code = function (code, infostring, escaped) {
      // marked v5+ 传对象；v4- 传字符串
      let text = code, lang = infostring;
      if (code && typeof code === 'object') {
        text = code.text != null ? code.text : '';
        lang = code.lang || '';
      }
      text = text == null ? '' : String(text);
      const raw = lang ? String(lang).trim() : '';
      // 支持 ```js title="x" 与 ```js {1,3} 之类的附加信息
      const first = raw.split(/\s+/)[0] || '';
      const langName = first.replace(/^\{.*\}$/, '').toLowerCase();
      let title = '';
      const tm = raw.match(/title=["']([^"']+)["']/);
      if (tm) title = tm[1];

      if (langName === 'mermaid') {
        return '<div class="mermaid-block" data-mermaid="1"><pre class="mermaid-src">' +
          escapeHtml(text) + '</pre></div>';
      }

      // 可直接在弹窗内预览的代码块（HTML）
      const previewable = PREVIEW_LANGS.indexOf(langName) >= 0;

      const shownLang = langName || 'text';
      const head = '<div class="md-codeblock' + (text.split('\n').length > 34 ? ' collapsible' : '') +
        '"><div class="md-codeblock-head"><span class="md-codeblock-lang">' +
        escapeHtml(title || shownLang) + '</span><span class="md-codeblock-tools">' +
        (previewable ? '<button class="md-code-preview" type="button">__PREVIEWBTN__</button>' : '') +
        '<button class="md-code-copy" type="button" title="' + escapeHtml(title || shownLang) +
        '">__COPYBTN__</button></span></div>' +
        '<pre><code class="language-' + escapeHtml(langName || 'plaintext') + '">' +
        escapeHtml(text) + '</code></pre>' +
        (text.split('\n').length > 34 ? '<button class="md-code-expand" type="button">__EXPAND__</button>' : '') +
        '</div>';
      return head;
    };

    renderer.link = function (href, title, text) {
      let h = href, t = title, body = text;
      if (href && typeof href === 'object') {
        h = href.href; t = href.title; body = href.text;
      }
      return '<a href="' + escapeHtml(h || '#') + '"' +
        (t ? ' title="' + escapeHtml(t) + '"' : '') +
        ' target="_blank" rel="noopener noreferrer nofollow">' + body + '</a>';
    };

    renderer.image = function (href, title, text) {
      let h = href, t = title, alt = text;
      if (href && typeof href === 'object') {
        h = href.href; t = href.title; alt = href.text;
      }
      return '<img class="md-img" src="' + escapeHtml(h || '') + '" alt="' +
        escapeHtml(alt || '') + '"' + (t ? ' title="' + escapeHtml(t) + '"' : '') +
        ' loading="lazy" data-zoom="1">';
    };

    const opts = {
      renderer,
      gfm: true,
      breaks: true,
      pedantic: false,
      async: false
    };
    try {
      marked.setOptions(opts);
      marked.use && marked.use({ renderer, gfm: true, breaks: true });
    } catch (e) { /* 老版本 ignore */ }

    marked.__lynkPatched = true;
    marked.__lynkRenderer = renderer;
    marked.__lynkOpts = opts;
    return marked;
  }

  /* ---------- 预处理 / 后处理扩展 ---------- */

  /** GitHub Alerts： > [!NOTE] ... */
  function transformAlerts(md) {
    const lines = md.split('\n');
    const out = [];
    let i = 0;
    const icon = {
      note: 'bi-info-circle', tip: 'bi-lightbulb', important: 'bi-exclamation-square',
      warning: 'bi-exclamation-triangle', caution: 'bi-exclamation-octagon',
      success: 'bi-check-circle', error: 'bi-x-octagon'
    };
    const label = {
      note: 'Note', tip: 'Tip', important: 'Important',
      warning: 'Warning', caution: 'Caution', success: 'Success', error: 'Error'
    };
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|SUCCESS|ERROR)\]\s*(.*)$/i);
      if (!m) { out.push(lines[i]); i++; continue; }
      const indent = m[1];
      const kind = m[2].toLowerCase();
      const body = [];
      if (m[3]) body.push(m[3]);
      i++;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('');
      out.push(indent + '<div class="md-alert ' + kind + '">');
      out.push('');
      out.push(indent + '<div class="md-alert-title"><i class="bi ' + (icon[kind] || icon.note) +
        '"></i>' + (label[kind] || kind) + '</div>');
      out.push('');
      out.push(indent + body.join('\n').replace(/^/gm, indent));
      out.push('');
      out.push(indent + '</div>');
      out.push('');
    }
    return out.join('\n');
  }

  /** 任务列表：- [ ] / - [x]（marked v12 起内置支持已移除，这里自行转换）
   *  用元素 + CSS 呈现复选框，避免依赖 <input> 与原始 HTML 通过净化。 */
  function transformTaskLists(md) {
    return md.replace(/^([ \t]*)([-*+]|\d+\.)[ \t]+\[([ xX])\][ \t]+(.*)$/gm,
      (m, indent, bullet, mark, rest) => {
        const on = mark.toLowerCase() === 'x';
        return indent + bullet + ' <span class="task-check' + (on ? ' is-done' : '') +
          '" role="img" aria-label="' + (on ? 'done' : 'todo') + '"></span> ' + rest;
      });
  }

  /** Markdown Extra 定义列表：
   *      术语
   *      : 定义
   *  转换为 <dl><dt>..</dt><dd>..</dd></dl>，marked 本身不支持该语法。 */
  function transformDefLists(md) {
    const lines = md.split('\n');
    const out = [];
    let i = 0;
    let open = false;          // 是否已处于 <dl> 中
    const isTerm = (s) => s && !/^\s/.test(s) &&
      !/^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|:::|!!!|\||```|~~~|<)/.test(s);
    const defRe = /^[ \t]*[:~][ \t]+(.*)$/;

    const closeDl = () => { if (open) { out.push('</dl>'); out.push(''); open = false; } };

    while (i < lines.length) {
      const line = lines[i];

      // 定义项
      const d = line.match(defRe);
      if (d) {
        if (!open) {
          // 上一行是术语（需回退取出）
          const prev = out.length ? out[out.length - 1] : '';
          if (isTerm(prev)) {
            out.pop();
            out.push('');
            out.push('<dl class="md-dl">');
            out.push('<dt>' + prev.trim() + '</dt>');
          } else {
            out.push(line);
            i++;
            continue;
          }
          open = true;
        }
        out.push('<dd>' + d[1] + '</dd>');
        i++;
        continue;
      }

      // 连续定义（同一术语的多条）
      if (!d) closeDl();

      // 术语后紧跟空行的预览：暂存，遇到定义行再回退
      out.push(line);
      i++;
    }
    closeDl();
    return out.join('\n');
  }

  /** VitePress 容器：::: tip ... :::  & ::: details */
  function transformContainers(md) {
    const lines = md.split('\n');
    const out = [];
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = line.match(/^(\s*):::\s*([a-zA-Z-]+)\s*(.*)$/);
      if (open && open[2].toLowerCase() !== '') {
        const kind = open[2].toLowerCase();
        const title = (open[3] || '').trim();
        stack.push(kind);
        if (kind === 'details') {
          const summary = title || (global.I18N ? global.I18N.t('more') : 'Details');
          out.push('');
          out.push('<details class="md-container details"><summary>' + escapeHtml(summary) + '</summary>');
          out.push('');
        } else {
          out.push('');
          out.push('<div class="md-container ' + kind + '">');
          out.push('<div class="md-alert-title">' + escapeHtml(title || kind) + '</div>');
          out.push('');
        }
        continue;
      }
      if (/^\s*:::\s*$/.test(line) && stack.length) {
        const kind = stack.pop();
        out.push('');
        out.push(kind === 'details' ? '</details>' : '</div>');
        out.push('');
        continue;
      }
      // MkDocs admonition： !!! note
      const adm = line.match(/^(\s*)!!!\s*([a-zA-Z-]+)\s*"?([^"]*)"?\s*$/);
      if (adm) {
        const kind = adm[2].toLowerCase();
        const title = (adm[3] || '').trim();
        out.push('');
        out.push('<div class="md-container ' + kind + ' md-alert">');
        out.push('<div class="md-alert-title"><i class="bi bi-bookmark"></i>' +
          escapeHtml(title || kind) + '</div>');
        continue;
      }
      out.push(line);
    }
    while (stack.length) {
      const kind = stack.pop();
      out.push(kind === 'details' ? '</details>' : '</div>');
    }
    return out.join('\n');
  }

  /** 行内扩展：==高亮== ++下划线++ H~2~ X^2^ */
  function transformInlineExt(md) {
    return md
      .replace(/(^|[^=])==([^=\n]+?)==(?!=)/g, '$1<mark>$2</mark>')
      .replace(/(^|[^+])\+\+([^+\n]+?)\+\+(?!\+)/g, '$1<u>$2</u>')
      .replace(/(^|[^~])~([^~\s][^~\n]*?)~(?![~])/g, '$1<sub>$2</sub>')
      .replace(/\^([^\s^][^^\n]*?)\^(?![\^])/g, '<sup>$1</sup>');
  }

  /** 保护数学公式，避免被 marked 破坏 */
  function protectMath(md) {
    const blocks = [];
    let text = md;

    // 1) 围栏代码块先占位保护，防止其中的 $ 被误判
    const fences = [];
    text = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, (m) => {
      fences.push(m);
      return '\n@@FENCE' + (fences.length - 1) + '@@\n';
    });

    // 2) $$ ... $$
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => {
      blocks.push({ type: 'block', body: body.trim() });
      return '@@MATH' + (blocks.length - 1) + '@@';
    });

    // 3) \( ... \) 与 \[ ... \]
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m, body) => {
      blocks.push({ type: 'block', body: body.trim() });
      return '@@MATH' + (blocks.length - 1) + '@@';
    });
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (m, body) => {
      blocks.push({ type: 'inline', body: body.trim() });
      return '@@MATH' + (blocks.length - 1) + '@@';
    });

    // 4) 单 $ ... $ （同一行内，避免跨行误判）
    text = text.replace(/(^|[^\\$])\$([^\n$]+?)\$(?!\d)/g, (m, pre, body) => {
      if (!body.trim()) return m;
      if (!/[\\^_{}=+\-*/<>]|\b[a-zA-Z]{1,3}\b/.test(body)) return m;
      blocks.push({ type: 'inline', body: body.trim() });
      return pre + '@@MATH' + (blocks.length - 1) + '@@';
    });

    // 还原围栏
    text = text.replace(/@@FENCE(\d+)@@/g, (m, i) => fences[Number(i)]);
    return { text, blocks, fences };
  }

  function mathPlaceholder(kind, body, index) {
    // 生成真实元素，块级用 div、行内用 span。
    // 净化阶段会清掉 data-* 属性，因此正文通过 textContent 携带，
    // 增强阶段再按前缀解析 —— 这样不依赖任何属性即可还原。
    const payload = MATH_PREFIX + encodeURIComponent(body);
    if (kind === 'block') {
      return '<div class="math-block">' + escapeHtml(payload) + '</div>';
    }
    return '<span class="math-inline">' + escapeHtml(payload) + '</span>';
  }

  /* ---------- 主渲染流程 ---------- */

  /**
   * 渲染 Markdown 为 HTML 字符串（同步）
   * @param {string} md
   * @returns {string}
   */
  function toHtml(md) {
    const src = String(md == null ? '' : md);
    if (!state.marked) return '<div class="md-plaintext">' + escapeHtml(src) + '</div>';

    let text = src;

    // 未闭合的围栏代码块（流式输出时常见）—— 单独处理为纯文本块
    const unclosed = detectUnclosedFence(text);
    let trailing = '';
    if (unclosed) {
      trailing = text.slice(unclosed.index);
      text = text.slice(0, unclosed.index);
    }

    text = transformAlerts(text);
    text = transformContainers(text);
    text = transformTaskLists(text);
    text = transformDefLists(text);
    text = transformInlineExt(text);

    let blocks = [];
    try {
      const r = protectMath(text);
      text = r.text;
      blocks = r.blocks;
    } catch (e) { /* noop */ }

    // 还原数学占位：块级独立成行，行内直接嵌入
    text = text.replace(/@@MATH(\d+)@@/g, (m, i) => {
      const idx = Number(i);
      const b = blocks[idx];
      if (!b) return '';
      return b.type === 'block'
        ? '\n\n' + mathPlaceholder('block', b.body, idx) + '\n\n'
        : mathPlaceholder('inline', b.body, idx);
    });

    let html;
    try {
      const marked = state.marked;
      if (typeof marked.parse === 'function') html = marked.parse(text);
      else html = marked(text);
    } catch (e) {
      console.warn('[markdown] marked 解析失败：', e);
      html = '<div class="md-plaintext">' + escapeHtml(src) + '</div>';
    }

    // 代码块复制按钮文案
    const tCopy = global.I18N ? global.I18N.t('copy') : '复制';
    const tPreview = global.I18N ? global.I18N.t('htmlPreview') : '预览';
    const tExpand = global.I18N && global.I18N.lang === 'en' ? 'Show more' : '展开全部';
    html = html.split('__COPYBTN__').join(
      '<i class="bi bi-clipboard"></i>' + escapeHtml(tCopy)
    ).split('__PREVIEWBTN__').join(
      '<i class="bi bi-play-circle"></i>' + escapeHtml(tPreview)
    ).split('__EXPAND__').join(tExpand);

    // 表格包裹
    html = wrapTables(html);

    // 净化
    html = sanitize(html);

    // 回填数学占位（净化后再插入自定义节点）
    html = restoreMath(html, blocks);

    // 未闭合代码块
    if (trailing) {
      html += renderStreamingCode(trailing);
    }

    return html;
  }

  function detectUnclosedFence(text) {
    const lines = text.split('\n');
    let open = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (!m) continue;
      if (!open) {
        open = { fence: m[1][0], len: m[1].length, line: i, info: m[2].trim() };
      } else if (m[1][0] === open.fence && m[1].length >= open.len && m[2].trim() === '') {
        open = null;
      }
    }
    if (!open) return null;
    // 计算起始字符位置
    let idx = 0;
    for (let i = 0; i < open.line; i++) idx += lines[i].length + 1;
    return { index: idx, info: open.info };
  }

  function renderStreamingCode(raw) {
    const lines = raw.split('\n');
    const first = lines[0] || '';
    const info = first.replace(/^\s*[`~]{3,}/, '').trim();
    const body = lines.slice(1).join('\n');
    const lang = (info.split(/\s+/)[0] || 'text').replace(/^\{.*\}$/, '');
    return '<div class="md-streaming-code"><span class="sc-lang">' + escapeHtml(lang) +
      '</span>' + escapeHtml(body) + '</div>';
  }

  function wrapTables(html) {
    // 仅包裹顶层 table（marked 输出的 table 都是块级）
    return html.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="md-table-wrap"><table>$1</table></div>');
  }

  function sanitize(html) {
    const DP = state.DOMPurify;
    if (!DP) return html;
    try {
      return DP.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: false },
        ADD_TAGS: ['details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'u', 'abbr', 'progress', 'meter', 'figure', 'figcaption'],
        ADD_ATTR: ['target', 'rel', 'loading', 'data-zoom', 'data-expand', 'data-mermaid', 'start', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'align'],
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'video', 'audio', 'object', 'embed', 'script', 'link', 'meta', 'base'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'style']
      });
    } catch (e) {
      return html;
    }
  }

  function restoreMath(html, blocks) {
    if (!blocks || !blocks.length) return html;
    // 占位元素在净化时会丢失属性，但类名与文本会保留，这里直接使用即可；
    // 后续由 enhance() 依据文本前缀解码出公式源码。
    return html;
  }

  /* ---------- 渲染后增强（在真实 DOM 上执行） ---------- */

  /**
   * 对已插入 DOM 的 .md 容器做增强：高亮 / KaTeX / Mermaid
   * @param {HTMLElement} root
   * @returns {Promise<void>}
   */
  function enhance(root) {
    if (!root) return Promise.resolve();
    const settings = global.Store ? global.Store.getSettings() : { richRender: true };

    // 代码高亮
    const codeEls = root.querySelectorAll('.md-codeblock pre code');
    if (codeEls.length) {
      ensureHljs().then(hljs => {
        if (!hljs) return;
        codeEls.forEach(el => {
          if (el.dataset.hlDone) return;
          el.dataset.hlDone = '1';
          try {
            if (hljs.highlightElement) {
              hljs.highlightElement(el);
            } else if (hljs.highlight) {
              const lang = (el.className.match(/language-([\w-]+)/) || [])[1];
              const res = lang && hljs.getLanguage && hljs.getLanguage(lang)
                ? hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true })
                : hljs.highlightAuto(el.textContent);
              el.innerHTML = res.value;
              el.classList.add('hljs');
            }
          } catch (e) { /* 保留纯文本 */ }
        });
      });
    }

    // 代码块：复制 / 展开
    root.querySelectorAll('.md-codeblock').forEach(block => {
      if (block.dataset.bound === '1') return;
      block.dataset.bound = '1';
      const codeEl = block.querySelector('pre code');
      const copyBtn = block.querySelector('.md-code-copy');
      if (copyBtn && codeEl) {
        copyBtn.addEventListener('click', () => {
          UI.copyText(codeEl.textContent);
          const original = copyBtn.innerHTML;
          copyBtn.classList.add('done');
          copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>' + escapeHtml(global.I18N.t('copied'));
          setTimeout(() => {
            copyBtn.classList.remove('done');
            copyBtn.innerHTML = original;
          }, 1600);
        });
      }
      const expandBtn = block.querySelector('.md-code-expand');
      if (expandBtn) {
        expandBtn.addEventListener('click', () => {
          block.classList.remove('collapsible');
          expandBtn.remove();
        });
      }
      // HTML 代码块：弹窗在线预览
      const previewBtn = block.querySelector('.md-code-preview');
      if (previewBtn && codeEl) {
        previewBtn.addEventListener('click', () => {
          if (global.UI && UI.HtmlPreview) UI.HtmlPreview.open(codeEl.textContent);
        });
      }
    });

    const tasks = [];

    // LaTeX
    if (settings.richRender !== false) {
      const mathEls = root.querySelectorAll('.math-block, .math-inline');
      if (mathEls.length) {
        tasks.push(ensureKatex().then(katex => {
          if (!katex) return;
          mathEls.forEach(el => {
            if (el.dataset.katexDone) return;
            const text = el.textContent || '';
            if (text.indexOf(MATH_PREFIX) !== 0) return;   // 非占位元素，跳过
            el.dataset.katexDone = '1';
            const display = el.classList.contains('math-block');
            let src = '';
            try { src = decodeURIComponent(text.slice(MATH_PREFIX.length)); } catch (e) { src = text.slice(MATH_PREFIX.length); }
            try {
              katex.render(src, el, { displayMode: display, throwOnError: false, output: 'html' });
            } catch (e) { /* 保留原文 */ }
          });
        }).catch(() => {}));
      }

      // Mermaid
      const mmEls = root.querySelectorAll('.mermaid-block[data-mermaid]');
      if (mmEls.length) {
        mmEls.forEach((el, i) => {
          tasks.push(renderMermaid(el, i));
        });
      }
    }

    return Promise.all(tasks).then(() => {});
  }

  function renderMermaid(el, i) {
    if (el.dataset.mermaidDone) return Promise.resolve();
    el.dataset.mermaidDone = '1';
    const srcEl = el.querySelector('.mermaid-src');
    const code = srcEl ? srcEl.textContent : '';
    if (!code.trim()) return Promise.resolve();

    return ensureMermaid().then(mm => {
      if (!mm) {
        showMermaidError(el, code, 'Mermaid 加载失败');
        return;
      }
      const id = 'mmd_' + (++state.mermaidId) + '_' + i;
      return mm.render(id, code).then(res => {
        const svg = res && res.svg ? res.svg : '';
        el.innerHTML = svg + '<div class="mermaid-source-toggle"><i class="bi bi-code-slash"></i>' +
          (global.I18N && global.I18N.lang === 'en' ? 'Source' : '查看源码') + '</div>';
        const toggle = el.querySelector('.mermaid-source-toggle');
        if (toggle) {
          toggle.addEventListener('click', () => {
            const src = doc.createElement('pre');
            src.style.margin = '8px 0 0';
            src.style.textAlign = 'left';
            src.style.whiteSpace = 'pre-wrap';
            src.style.fontSize = '11.5px';
            src.textContent = code;
            if (el.querySelector('pre.mermaid-raw')) {
              el.querySelector('pre.mermaid-raw').remove();
            } else {
              src.className = 'mermaid-raw';
              el.appendChild(src);
            }
          });
        }
      }).catch(err => {
        showMermaidError(el, code, (err && err.message) || 'render error');
      });
    }).catch(err => {
      showMermaidError(el, code, (err && err.message) || 'load error');
    });
  }

  function showMermaidError(el, code, msg) {
    el.classList.add('is-error');
    el.innerHTML = '<div class="mermaid-err-title"><i class="bi bi-exclamation-triangle"></i>' +
      escapeHtml(msg) + '</div><pre>' + escapeHtml(code) + '</pre>';
  }

  /* ---------- 精简纯文本（用于搜索 / 标题） ---------- */
  function toPlainText(md) {
    let s = String(md || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
    s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
    s = s.replace(/[*_~`]/g, '');
    s = s.replace(/\$\$?([^$]*)\$\$?/g, '$1');
    s = s.replace(/\|/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  /* ---------- 初始化 ---------- */
  const ready = ensureMarked().then(m => {
    if (m) setupMarked(m);
    else console.warn('[markdown] marked 加载失败，将回退为纯文本渲染');
    // 净化库尽力加载
    ensurePurify();
    return !!m;
  }).catch(() => false);

  global.MD = {
    ready,
    toHtml,
    enhance,
    toPlainText,
    escapeHtml,
    resetMermaid,
    ensureMermaid,
    ensureKatex,
    ensureHljs,
    get markedReady() { return !!state.marked; },
    setTheme() { resetMermaid(); }
  };
})(window);
