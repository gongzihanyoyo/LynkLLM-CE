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

const CACHE_VERSION = 'v1.3.26092701';
const CACHE = 'lynkllm-ce-' + CACHE_VERSION;

/** 预缓存的应用外壳（相对 Service Worker 所在目录） */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/css/markdown.css',
  './assets/js/i18n.js',
  './assets/js/store.js',
  './assets/js/markdown.js',
  './assets/js/api.js',
  './assets/js/ui.js',
  './assets/js/logos.js',
  './assets/js/zip.js',
  './assets/js/personalize.js',
  './assets/js/enhancer.js',
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
    }).then(() => self.skipWaiting())
  );
});

/* ---------- 激活：清理旧版本缓存 ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.indexOf('lynkllm-ce-') === 0 && k !== CACHE)
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
      caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
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

/* ---------- 供页面主动触发更新 ---------- */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
