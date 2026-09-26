// ==UserScript==
// @name         LynkLLM-CE-Enhancer
// @namespace    https://github.com/gongzihanyoyo/LynkLLM-CE
// @version      1.2.26092601
// @description  LynkLLM CE 可选增强：按需为指定模型转发请求，绕过浏览器 CORS 限制（支持流式输出）
// @icon         https://lynkllm-ce.pages.dev/assets/img/favicon.ico
// @license      MIT
// @author       Jitaimei Studio™
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ==========================================================================
   LynkLLM CE 增强脚本
   --------------------------------------------------------------------------
   这是一个**纯可选**的增强件：LynkLLM CE 网页本体不依赖它，装与不装都能正常使用。
   只有网页里「模型显式开启了『绕过 CORS 限制』」的请求才会经由本脚本转发。

   为什么需要它
   ------------
   纯前端应用直接 fetch 第三方大模型网关时，会受浏览器同源策略约束：
   对方没给 CORS 响应头就直接失败，而且这是**浏览器层面**的限制，
   网页侧写什么都绕不过去。油猴扩展（Tampermonkey 等）拥有跨域请求权限，
   由它转发即可绕过。

   安全措施（脚本的 @match 是「匹配所有域名」，所以必须自己把口子收紧）
   ------------------------------------------------------
   1. **必须由网页主动亮明身份**：脚本什么都不做，直到页面在 document 上
      派发 `lynkllm-ce:connect`。页面身份靠 `<html data-lynkllm-ce="<版本>">` 确认
      （LynkLLM CE 本体在 index.html 上静态声明），别的站点伪造不了这个属性
      与整套握手流程。
   2. **每个来源单独授权**：确认弹窗按 origin 记录（GM.setValue），
      换一个站点/端口会再问一次。用户还可以勾「不再提示」跳过后续询问。
   3. **只转发白名单目标 + 只转发 http(s)**：脚本自身再独立校验一遍
      目标 origin 是否在「网页声明的授权列表」里，不信任页面传什么就发什么。
   4. **不接管全局 fetch**：脚本不 patch 任何页面的网络 API，
      只在被请求时做一次转发，因此不会影响宿主页面的其它行为。
   5. **可随时撤销**：`GM_deleteValue` 清掉授权即恢复未连接状态；
      在油猴面板里禁用/删除本脚本也立刻失效。
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     常量 / 状态
     --------------------------------------------------------------------- */

  var SCRIPT_VERSION = '1.2.26092601';
  var PAGE_TAG = 'data-lynkllm-ce';                 // 网页本体在 <html> 上的身份标记
  var ATTR_INSTALLED = 'data-lynkllm-enhancer';     // 脚本 → 页面：已安装
  var ATTR_OK = 'data-lynkllm-enhancer-connected';  // 脚本 → 页面：已授权
  var ATTR_DENY = 'data-lynkllm-enhancer-declined'; // 脚本 → 页面：已拒绝

  var EV = {
    connect: 'lynkllm-ce:connect',
    state: 'lynkllm-ce:enhancer-state',
    request: 'lynkllm-ce:http-request',
    meta: 'lynkllm-ce:http-meta',
    chunk: 'lynkllm-ce:http-chunk',
    end: 'lynkllm-ce:http-end',
    error: 'lynkllm-ce:http-error',
    abort: 'lynkllm-ce:http-abort'
  };

  var KEY_TRUST = 'trusted:';                       // + origin
  var KEY_SKIP_ASK = 'skipConfirm';                 // 「不再提示」
  var KEY_DENY = 'denied:';                         // + origin

  var MAX_BODY = 24 * 1024 * 1024;                  // 单次请求体上限，防误用
  var TIMEOUT = 300000;                             // 5 分钟（长回答 + 推理可能很久）

  /** 在途请求：id → { abort } */
  var inflight = {};
  /** 本轮「网页声明的可绕过 origin」——由握手时的页面配置给出，作为转发白名单 */
  var allowedOrigins = [];
  var confirmed = false;                             // 本次会话是否已授权
  var dialogEl = null;

  /* ---------------------------------------------------------------------
     基础工具
     --------------------------------------------------------------------- */

  function log() {
    try { console.log.apply(console, ['[LynkLLM 增强]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function parseDetail(ev) {
    try { return JSON.parse(ev.detail); } catch (e) { return null; }
  }

  /** 页面 → 脚本 */
  function emitToPage(name, payload) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload || {}) }));
    } catch (e) { /* 事件通道不可用时静默：网页会退回原生请求 */ }
  }

  function bytesToB64(u8) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }

  /* GM 存储的兼容包装。这里有两个坑，都必须处理：
     1. **函数名有两种**：老式的 `GM_setValue` 与新式的 `GM.setValue`。
        管理器只注入 `@grant` 里声明的那个 —— 本脚本两个都申请，
        并在运行时优先挑**真正存在**的那个。
        （早期版本只 declare 了 `GM.setValue` 却在代码里调 `GM_setValue`：
         在只注入新式的管理器里，授权与「不再提示」会静默存不下来，
         表现为**每次打开网页都要重新确认一次**。）
     2. **返回值有两种**：同步返回，或返回 Promise。下面统一按 Promise 处理。 */
  function gmFn(underscore, dotted) {
    if (typeof window[underscore] === 'function') return window[underscore];
    try {
      if (dotted && typeof dotted === 'function') return dotted;
    } catch (e) { /* noop */ }
    return null;
  }

  function gmGet(key, fallback) {
    return new Promise(function (resolve) {
      var fn;
      try { fn = gmFn('GM_getValue', typeof GM !== 'undefined' && GM && GM.getValue); }
      catch (e) { fn = null; }
      if (!fn) return resolve(fallback);
      try {
        var r = fn(key, fallback);
        if (r && typeof r.then === 'function') r.then(v => resolve(v === undefined ? fallback : v), () => resolve(fallback));
        else resolve(r === undefined ? fallback : r);
      } catch (e) { resolve(fallback); }
    });
  }

  function gmSet(key, value) {
    return new Promise(function (resolve) {
      var fn;
      try { fn = gmFn('GM_setValue', typeof GM !== 'undefined' && GM && GM.setValue); }
      catch (e) { fn = null; }
      if (!fn) return resolve(false);
      try {
        var r = fn(key, value);
        if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
        else resolve(true);
      } catch (e) { resolve(false); }
    });
  }

  function gmDel(key) {
    return new Promise(function (resolve) {
      var fn;
      try { fn = gmFn('GM_deleteValue', typeof GM !== 'undefined' && GM && GM.deleteValue); }
      catch (e) { fn = null; }
      if (!fn) return resolve(false);
      try {
        var r = fn(key);
        if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
        else resolve(true);
      } catch (e) { resolve(false); }
    });
  }

  /* ---------------------------------------------------------------------
     页面标记与状态广播
     --------------------------------------------------------------------- */

  function markInstalled() {
    try { document.documentElement.setAttribute(ATTR_INSTALLED, SCRIPT_VERSION); } catch (e) {}
  }

  function setState(state) {
    var root = document.documentElement;
    try {
      if (state === 'connected') {
        root.setAttribute(ATTR_OK, '1');
        root.removeAttribute(ATTR_DENY);
      } else if (state === 'declined') {
        root.removeAttribute(ATTR_OK);
        root.setAttribute(ATTR_DENY, '1');
      } else {
        root.removeAttribute(ATTR_OK);
        root.removeAttribute(ATTR_DENY);
      }
    } catch (e) {}
    emitToPage(EV.state, { state: state, version: SCRIPT_VERSION });
  }

  /* ---------------------------------------------------------------------
     确认弹窗（尽量贴近 LynkLLM CE 的设计语言）
     --------------------------------------------------------------------- */

  var CSS = [
    '.lk-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
    'background:rgba(8,10,14,.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);',
    'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;',
    'animation:lk-fade .16s ease}',
    '@keyframes lk-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes lk-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
    '.lk-modal{width:min(420px,calc(100vw - 32px));border-radius:16px;padding:22px 22px 16px;',
    'background:#fff;color:#14181f;border:1px solid #e3e6eb;box-shadow:0 24px 60px rgba(15,23,42,.28);',
    'animation:lk-pop .2s cubic-bezier(.22,.68,.06,1)}',
    '@media (prefers-color-scheme:dark){.lk-modal{background:#191d24;color:#e9edf3;border-color:#2a303a}}',
    '.lk-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
    '.lk-logo{width:34px;height:34px;border-radius:10px;flex-shrink:0;object-fit:cover;background:#4f6ef7}',
    '.lk-title{font-size:15px;font-weight:700}',
    '.lk-body{font-size:13px;color:#5b6472;margin-bottom:14px}',
    '.lk-body code{background:rgba(127,140,165,.14);border-radius:5px;padding:1px 5px;font-size:12px}',
    '.lk-scope{display:flex;align-items:center;gap:8px;font-size:12px;color:#5b6472;background:rgba(127,140,165,.1);',
    'border-radius:9px;padding:9px 11px;margin-bottom:14px}',
    '.lk-scope b{color:#14181f;font-weight:600}',
    '.lk-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#5b6472;margin-bottom:16px;cursor:pointer;user-select:none}',
    '.lk-check input{width:15px;height:15px;accent-color:#4f6ef7;cursor:pointer}',
    '.lk-foot{display:flex;gap:9px;justify-content:flex-end}',
    '.lk-btn{height:36px;padding:0 16px;border-radius:9px;border:1px solid #e3e6eb;background:#f7f8fa;color:#14181f;',
    'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .13s}',
    '.lk-btn:hover{background:#eef0f4}',
    '.lk-btn.primary{background:#4f6ef7;border-color:#4f6ef7;color:#fff}',
    '.lk-btn.primary:hover{background:#3b55d9}',
    '@media (prefers-color-scheme:dark){.lk-body,.lk-scope,.lk-check{color:#9aa4b2}.lk-scope b{color:#e9edf3}',
    '.lk-btn{background:#232830;border-color:#2f3641;color:#e9edf3}.lk-btn:hover{background:#2b313b}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('lk-enhancer-css')) return;
    var st = document.createElement('style');
    st.id = 'lk-enhancer-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function closeDialog() {
    if (dialogEl && dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    dialogEl = null;
  }

  /**
   * 显示确认弹窗。
   * @param {string} origin 将要被授权的来源（仅用于展示与记录）
   * @returns {Promise<boolean>} 用户是否同意
   */
  function askConfirm(origin) {
    return new Promise(function (resolve) {
      injectCss();
      closeDialog();

      var wrap = document.createElement('div');
      wrap.className = 'lk-backdrop';

      var modal = document.createElement('div');
      modal.className = 'lk-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      var head = document.createElement('div');
      head.className = 'lk-head';
      var logo = document.createElement('img');
      logo.className = 'lk-logo';
      logo.alt = '';
      // 用当前站点的图标；取不到就留品牌底色
      logo.src = location.origin + '/assets/img/logo-64.png';
      logo.onerror = function () { logo.style.visibility = 'hidden'; };
      var title = document.createElement('div');
      title.className = 'lk-title';
      title.textContent = 'LynkLLM CE 增强脚本';
      head.appendChild(logo);
      head.appendChild(title);

      var body = document.createElement('div');
      body.className = 'lk-body';
      body.innerHTML = '网页请求与增强脚本建立连接。<br>连接后，网页中<b>开启了「绕过 CORS 限制」的模型</b>'
        + '会把请求交给本脚本转发，从而绕过浏览器的跨域限制。<br>'
        + '<b>不建立连接也不影响其它任何功能。</b>';

      var scope = document.createElement('div');
      scope.className = 'lk-scope';
      var scopeIco = document.createElement('span');
      scopeIco.textContent = '🔒';
      var scopeTxt = document.createElement('div');
      scopeTxt.innerHTML = '授权范围：<b>' + escapeHtml(origin) + '</b><br>仅转发该站点声明的模型接口，'
        + '不会读取或上传你的任何本地数据。';
      scope.appendChild(scopeIco);
      scope.appendChild(scopeTxt);

      var label = document.createElement('label');
      label.className = 'lk-check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      var cbTxt = document.createElement('span');
      cbTxt.textContent = '不再提示（以后自动连接）';
      label.appendChild(cb);
      label.appendChild(cbTxt);

      var foot = document.createElement('div');
      foot.className = 'lk-foot';
      var btnNo = document.createElement('button');
      btnNo.className = 'lk-btn';
      btnNo.type = 'button';
      btnNo.textContent = '不连接';
      var btnYes = document.createElement('button');
      btnYes.className = 'lk-btn primary';
      btnYes.type = 'button';
      btnYes.textContent = '连接';
      foot.appendChild(btnNo);
      foot.appendChild(btnYes);

      modal.appendChild(head);
      modal.appendChild(body);
      modal.appendChild(scope);
      modal.appendChild(label);
      modal.appendChild(foot);
      wrap.appendChild(modal);
      (document.body || document.documentElement).appendChild(wrap);
      dialogEl = wrap;

      function done(ok) {
        var skip = cb.checked;
        closeDialog();
        var jobs = [];
        if (ok) {
          jobs.push(gmSet(KEY_TRUST + location.origin, Date.now()));
          jobs.push(gmDel(KEY_DENY + location.origin));
        } else {
          jobs.push(gmSet(KEY_DENY + location.origin, Date.now()));
        }
        if (skip) jobs.push(gmSet(KEY_SKIP_ASK, true));
        Promise.all(jobs).then(function () { resolve(ok); });
      }

      btnYes.addEventListener('click', function () { done(true); });
      btnNo.addEventListener('click', function () { done(false); });
      // 点遮罩 = 拒绝（与网页里其它弹窗一致，避免误判为同意）
      wrap.addEventListener('mousedown', function (e) {
        if (e.target === wrap) done(false);
      });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(false); }
      });
      setTimeout(function () { btnYes.focus(); }, 40);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------------
     握手
     --------------------------------------------------------------------- */

  /** 页面是不是 LynkLLM CE 本体（认它自己写的标记，别站点伪造不了整套流程） */
  function isLynkPage() {
    try { return !!document.documentElement.getAttribute(PAGE_TAG); } catch (e) { return false; }
  }

  /**
   * 处理网页的连接请求。
   * @param {object} d { version, href, silent }
   */
  function onConnect(d) {
    if (!isLynkPage()) return;                    // 不是目标站点，一声不吭

    // 页面声明「哪些 origin 允许被转发」，脚本再独立校验一遍（不完全信任页面）
    if (Array.isArray(d.origins)) {
      allowedOrigins = d.origins.filter(function (o) {
        return typeof o === 'string' && /^https?:/.test(o);
      });
    }

    Promise.all([
      gmGet(KEY_TRUST + location.origin, 0),
      gmGet(KEY_SKIP_ASK, false),
      gmGet(KEY_DENY + location.origin, 0)
    ]).then(function (res) {
      var trusted = !!res[0];
      var skipAsk = !!res[1];
      var denied = !!res[2];

      if (trusted || (skipAsk && !denied)) {
        confirmed = true;
        setState('connected');
        log('已连接（' + (trusted ? '本页已授权' : '已勾选不再提示') + '），可转发 ' + allowedOrigins.length + ' 个来源');
        return;
      }
      // 用户拒绝过、或页面说「静默」→ 不弹窗，保持未连接
      if (denied || d.silent) { setState('declined'); return; }

      // 弹窗确认期间先标成「等待确认」，网页据此显示「等待确认…」
      emitToPage(EV.state, { state: 'pending', version: SCRIPT_VERSION });
      askConfirm(location.origin).then(function (ok) {
        confirmed = !!ok;
        setState(ok ? 'connected' : 'declined');
        log(ok ? '用户已授权' : '用户拒绝了连接');
      });
    });
  }

  /* ---------------------------------------------------------------------
     请求转发
     --------------------------------------------------------------------- */

  /** 目标是否真的被允许转发（脚本侧的第二道校验） */
  function originAllowed(url) {
    var o;
    try { o = new URL(url, location.href).origin; } catch (e) { return false; }
    if (!/^https?:/.test(o)) return false;
    return allowedOrigins.indexOf(o) >= 0;
  }

  function toHeaders(raw) {
    var out = [];
    if (!raw) return out;
    Object.keys(raw).forEach(function (k) {
      if (raw[k] != null) out.push([k, String(raw[k])]);
    });
    return out;
  }

  function onRequest(d) {
    if (!confirmed) {
      emitToPage(EV.error, { id: d.id, code: 'enhancer-offline', message: '增强脚本未连接' });
      return;
    }
    if (!d || typeof d.url !== 'string') return;
    if (!originAllowed(d.url)) {
      emitToPage(EV.error, { id: d.id, code: 'enhancer-origin-denied', message: '该地址不在授权范围内：' + d.url });
      return;
    }
    if (typeof d.body === 'string' && d.body.length > MAX_BODY) {
      emitToPage(EV.error, { id: d.id, code: 'enhancer-body-too-large', message: '请求体过大' });
      return;
    }

    var sent = 0;          // 已经回传给页面的字节数
    var metaSent = false;
    var handle = null;

    function pushMeta(res) {
      if (metaSent) return;
      metaSent = true;
      var hs = {};
      // GM_xmlhttpRequest 的 responseHeaders 是 "k: v\r\nk: v" 原始串
      String(res.responseHeaders || '').split(/\r?\n/).forEach(function (line) {
        var i = line.indexOf(':');
        if (i > 0) hs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      emitToPage(EV.meta, {
        id: d.id,
        status: res.status || 200,
        statusText: res.statusText || '',
        headers: hs
      });
    }

    /** 把新到的字节切片回传（base64，跨 JS 世界只能走字符串） */
    function pushProgress(res) {
      pushMeta(res);
      var buf = res.response;
      if (!buf) return;
      var u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : null;
      if (!u8 || u8.length <= sent) return;
      var fresh = u8.subarray(sent);
      sent = u8.length;
      emitToPage(EV.chunk, { id: d.id, data: bytesToB64(fresh) });
    }

    try {
      handle = GM_xmlhttpRequest({
        method: d.method || 'POST',
        url: d.url,
        headers: (function () {
          var h = {};
          toHeaders(d.headers).forEach(function (p) { h[p[0]] = p[1]; });
          return h;
        })(),
        data: d.body == null ? undefined : d.body,
        responseType: 'arraybuffer',
        timeout: TIMEOUT,
        // 关键的流式来源：onprogress 会带着「到目前为止累计的响应」多次触发，
        // 我们只把新增部分切片发回去。若管理器不派发 onprogress，
        // 下面的 onload 仍会把完整响应一次性送回 —— 退化成非流式，但功能不丢。
        onprogress: pushProgress,
        onload: function (res) {
          pushProgress(res);            // 补发最后一段
          delete inflight[d.id];
          emitToPage(EV.end, { id: d.id });
        },
        onerror: function (res) {
          delete inflight[d.id];
          emitToPage(EV.error, {
            id: d.id, code: 'enhancer-network',
            message: (res && res.error) || '网络请求失败（目标可能不可达，或被扩展拒绝）'
          });
        },
        ontimeout: function () {
          delete inflight[d.id];
          emitToPage(EV.error, { id: d.id, code: 'enhancer-timeout', message: '请求超时' });
        },
        onabort: function () {
          delete inflight[d.id];
          emitToPage(EV.error, { id: d.id, code: 'aborted', message: '请求已取消' });
        }
      });
    } catch (e) {
      emitToPage(EV.error, { id: d.id, code: 'enhancer-throw', message: String(e && e.message || e) });
      return;
    }

    inflight[d.id] = {
      abort: function () { try { if (handle && handle.abort) handle.abort(); } catch (e) {} }
    };
  }

  function onAbort(d) {
    var it = d && inflight[d.id];
    if (it) { it.abort(); delete inflight[d.id]; }
  }

  /* ---------------------------------------------------------------------
     事件绑定
     --------------------------------------------------------------------- */

  var bound = false;

  function bind() {
    if (bound) return;      // boot() 会跑两次（document-start + DOMContentLoaded），
    bound = true;           // 重复绑定会让一次握手触发两个确认弹窗
    document.addEventListener(EV.connect, function (ev) {
      var d = parseDetail(ev);
      if (d) onConnect(d);
    });
    document.addEventListener(EV.request, function (ev) {
      var d = parseDetail(ev);
      if (d) onRequest(d);
    });
    document.addEventListener(EV.abort, function (ev) {
      var d = parseDetail(ev);
      if (d) onAbort(d);
    });
  }

  /* ---------------------------------------------------------------------
     启动
     --------------------------------------------------------------------- */

  // 只在「页面确实是 LynkLLM CE」时才留下痕迹，避免污染其它所有站点
  var announced = false;

  function boot() {
    if (!isLynkPage()) return;
    bind();
    markInstalled();
    if (announced) return;
    announced = true;
    log('已注入 v' + SCRIPT_VERSION + '，等待网页握手…');
    // 页面可能比脚本先执行完，主动补一次「我在这儿」的信号，
    // 让网页不必依赖它自己那侧的轮询
    emitToPage(EV.state, { state: 'ready', version: SCRIPT_VERSION });
  }

  if (document.readyState === 'loading') {
    // 身份标记写在 index.html 的 <html> 上，document-start 时已可读
    boot();
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
