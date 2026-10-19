/* ==========================================================================
   LynkLLM CE — Service Worker（PWA 离线支持）
   策略：
   - 应用外壳（HTML/CSS/JS/图标）：预缓存，安装即可离线打开
   - 导航请求：网络优先，失败时回退到缓存的 index.html
   - 同源静态资源：stale-while-revalidate
   - 白名单 CDN（图标 / 样式 / 公式）：stale-while-revalidate
   - 其余跨域请求（模型 API、Tavily 等）：完全直连，绝不缓存
   全部使用相对路径，方便部署在任意子目录。
   ========================================================================== */
'use strict';

/**
 * 缓存版本号：**由注册 URL 的 ?v= 传入**（见 app.js 的 serviceWorker.register）。
 * ⚠️ 这里刻意不再写死版本号 —— 全仓唯一来源是 assets/js/version.js。
 * 为什么不用 importScripts 去读它：SW 是独立作用域、拿不到 window；
 * 而 importScripts 会在**每次启动**同步拉一次网络，离线时失败会让整个 SW 无法启动。
 * 走 URL 参数则没有任何额外请求，而且「版本变了 → 注册 URL 变了 → 浏览器自动判定
 * 有新 SW」，顺带把「改了版本却没触发更新」这个坑也堵住了。
 */
const CACHE_VERSION = 'v' + (function () {
  try {
    return new URL(self.location.href).searchParams.get('v') || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
})();
const CACHE = 'lynkllm-ce-' + CACHE_VERSION;

/** 预缓存的应用外壳（相对 Service Worker 所在目录） */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/css/markdown.css',
  './assets/js/i18n.js',
  './assets/js/version.js',
  './assets/js/store.js',
  './assets/js/markdown.js',
  './assets/js/api.js',
  './assets/js/ui.js',
  './assets/js/logos.js',
  './assets/js/zip.js',
  './assets/js/personalize.js',
  './assets/js/enhancer.js',
  './assets/js/announce.js',
  './assets/js/imagestore.js',
  './assets/js/audiostore.js',
  './assets/js/conversations.js',
  './assets/js/mcp.js',
  './assets/js/pyodide-runner.js',
  './assets/js/pyodide-worker.js',
  './assets/js/chat.js',
  './assets/js/settings.js',
  './assets/js/app.js',
  './assets/img/favicon.ico',
  './assets/img/favicon-16.png',
  './assets/img/favicon-32.png',
  './assets/img/apple-touch-icon.png',
  './assets/img/logo-64.png',
  './assets/img/logo-128.png',
  './assets/img/logo-192.png',
  './assets/img/logo-256.png',
  './assets/img/logo-512.png',
  './assets/img/logo-maskable-512.png',
  './assets/img/avatar.png'
];

/* --------------------------------------------------------------------------
   Pyodide 运行时缓存
   --------------------------------------------------------------------------
   ⚠️ 这份缓存**刻意不跟着 CACHE_VERSION 走**：运行时是 ~14MB 的静态资源，
   不能因为网页升个小版本就作废、让用户重下。它的生命周期由设置页
   「下载 / 清除运行时」显式控制。
   ⚠️ 写入是**页面侧**完成的（pyodide-runner.js 自己 `cache.put`，
   这样能读 Content-Length 给进度）；这里只负责**读**：
   Worker 里 `importScripts` / `fetch` 打向 CDN 时命中它。
   ⚠️ cacheFirst（不是 stale-while-revalidate）：运行时文件按版本固定不变，
   每次都回源只会白耗流量；升级靠换版本号 + 换缓存名。
   -------------------------------------------------------------------------- */
const PYODIDE_PREFIX = 'https://cdn.jsdelivr.net/pyodide/';
const PYODIDE_CACHE = 'lynkllm-ce-pyodide-v1';

function pyodideFetch(request) {
  return caches.open(PYODIDE_CACHE).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      // 没缓存过就直连（例如用户还没点「下载」就已经在跑了）
      return fetch(request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      });
    })
  );
}

/** 允许缓存的第三方 CDN 主机（其余跨域请求一律直连） */
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'cdn.coolcdn.cn',
  'cdn.busuanzi.cc',
  'unpkg.com'
];

function isCdnHost(host) {
  return CDN_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

/* ---------- 安装：预缓存外壳 ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      // 单个资源失败不应导致整体安装失败
      return Promise.all(SHELL.map(url =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
      ));
    }).then(() => {
      /* ⚠️ 第 21 轮修一个体验/稳定性问题（L10）：原来这里**无条件** skipWaiting()，
         于是「用户正看着一段流式回答时恰好发了个新版本」→ 旧 SW 立刻被终止 →
         **正在进行的流被中断**（用户看到的是回答半途断掉）。
         现在改成：新 SW 先停在「已安装待接管」，由页面在**空闲时**发信号再接管。
         ⚠️⚠️ 但**绝不能把「等信号」放进 event.waitUntil**（第一版就这么写的）：
         安装没结束它就还不是 waiting，页面根本无从发信号 →
         **死锁**（实测 SW 卡在 installing 十几秒不动、页面连 controller 都没有）。
         所以这里只负责把外壳预缓存完，然后另起一个**不阻塞安装**的兜底计时器。 */
      startActivationFallback();
    })
  );
});

/* ---------- 激活：清理旧版本缓存 ---------- */
/**
 * ⚠️⚠️ 这些缓存**不能**被版本清理删掉。
 *
 * 这里修的是一个真实且很严重的 bug：清理规则原来是「名字以 `lynkllm-ce-` 开头
 * 且不等于当前 CACHE 就删」。而 Pyodide 运行时缓存叫 `lynkllm-ce-pyodide-v1` ——
 * **正好也以 `lynkllm-ce-` 开头**，于是每次 Service Worker 激活（装新版本、
 * 或首次安装后接管页面）都会把 14MB 的运行时缓存**删掉**。
 *
 * 后果：用户下载完运行时，页面上看着是好的；等 SW 一接管 / 一升级，
 * 运行时就不见了 —— 表现为「明明下载过，刷新后又要重新下载」，
 * 而且完全静默（没有任何报错）。
 *
 * 现在显式豁免。以后再往 `lynkllm-ce-` 前缀下加**不该随版本消失**的缓存，
 * 记得一并加进这个列表。
 */
const KEEP_CACHES = [
  PYODIDE_CACHE        // 运行时：生命周期由设置页的「下载/清除」按钮控制
];

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.indexOf('lynkllm-ce-') === 0 && k !== CACHE && KEEP_CACHES.indexOf(k) < 0)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/** stale-while-revalidate：先给缓存，后台顺带更新（用于第三方 CDN，省流量） */
function staleWhileRevalidate(request) {
  return caches.open(CACHE).then(cache =>
    cache.match(request).then(cached => {
      const network = fetch(request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return cached || network.then(res => res || caches.match(request).then(r => r || Response.error()));
    })
  );
}

/**
 * 网络优先：在线时始终拿最新代码（应用更新后不会出现新旧混用），
 * 离线时回退到缓存。
 */
function networkFirst(request) {
  return fetch(request).then(res => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
    }
    return res;
  }).catch(() =>
    caches.match(request).then(r => r || Response.error())
  );
}

/** 导航请求：网络优先，离线时回退到缓存首页 */
function handleNavigation(request) {
  return fetch(request).then(res => {
    if (res && res.ok) {
      const copy = res.clone();
      /* ⚠️ 第 21 轮修：原来**无论请求的是哪个 URL** 都写进 './index.html'，
         于是访问任何带查询参数的地址都会把离线首页缓存改写掉
         （`caches.match(request)` 先按导航 URL 查、查不到才落到 './index.html'，
         两边键对不上，等于靠兜底撑着，而且兜底那份还可能被反复改写）。
         现在：按**请求 URL** 存一份（精确命中），再额外维护 './index.html'
         作为离线兜底首页。 */
      caches.open(CACHE).then(c => Promise.all([
        c.put(request, copy.clone()),
        c.put('./index.html', copy)
      ]).catch(() => {}));
    }
    return res;
  }).catch(() =>
    caches.match(request).then(r => r || caches.match('./index.html')).then(r =>
      r || new Response(
        '<!doctype html><meta charset="utf-8"><title>离线</title>'
        + '<body style="font-family:system-ui;padding:40px;text-align:center">'
        + '<h1>离线</h1><p>暂无网络，且本地还没有缓存到页面。请联网后重试。</p>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    )
  );
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;                     // 模型 / 搜索接口均为 POST，直连

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 页面导航
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    // 自己的资源：优先走网络，保证拿到最新代码；离线时用缓存
    event.respondWith(networkFirst(request));
    return;
  }

  /* ⚠️ 这一条必须排在下面的 isCdnHost 之前：jsdelivr 也在 CDN_HOSTS 里，
     但 Pyodide 要进**独立且持久**的那份缓存，不能被通用分支抢走
     （通用分支用的是会随版本清理的 CACHE）。 */
  if (request.url.indexOf(PYODIDE_PREFIX) === 0) {
    event.respondWith(pyodideFetch(request));
    return;
  }

  if (isCdnHost(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // 其他跨域资源（模型 API、Tavily、图片直链等）不拦截
});

/* ---------- 新 SW 的接管时机（L10） ---------- */

/** 页面一直没发信号时的兜底：到点无条件接管，保证更新不会「永远不生效」 */
const DEFER_MAX_MS = 90000;

let activationTimer = null;

/** 兜底计时器：**不参与** event.waitUntil（否则会卡住安装，见 install 里的说明） */
function startActivationFallback() {
  if (activationTimer) clearTimeout(activationTimer);
  activationTimer = setTimeout(() => {
    activationTimer = null;
    self.skipWaiting().catch(() => null);
  }, DEFER_MAX_MS);
}

/** 页面说「现在可以接管了」→ 立刻接管 */
function activateNow() {
  if (activationTimer) { clearTimeout(activationTimer); activationTimer = null; }
  return self.skipWaiting().catch(() => null);
}

/* ---------- 供页面主动触发更新 ---------- */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') activateNow();
  /* 页面的「我现在空闲」信号（见 app.js 的 App.swIdle）：只在**确实有更新在等**时才接管 */
  if (data.type === 'RESUME_ACTIVATION') {
    /* ⚠️ 这里**不能**加 `self.registration.waiting === self` 的守卫：
       那是**客户端视角**的属性 —— 在「等待中的那个 SW 自己」里它并不指向自己，
       于是守卫恒为假、信号永远被忽略（实测：页面发了、SW 也收到了，就是不接管）。
       无脑调用即可：已经是 active 的 SW 调 skipWaiting 会抛 InvalidStateError，
       我们 catch 掉，没有任何副作用。 */
    activateNow();
  }
  if (data.type === 'VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
