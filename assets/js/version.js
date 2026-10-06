/* ==========================================================================
   LynkLLM CE — **全仓唯一的版本号来源**
   --------------------------------------------------------------------------
   以前版本号散在三处，升级时要同时改三个文件：
     · assets/js/store.js 的 APP_VERSION
     · index.html 的 <html data-lynkllm-ce="...">
     · sw.js 的 CACHE_VERSION
   漏改任何一处，现象都很隐蔽（最常见的是「页面已经显示新版本、Service Worker
   却还在用旧缓存」，查起来很费劲）。

   现在只有下面这一个字面量，另外两处都从它**派生**：
     · store.js   → 读 window/self.LYNKLLM_VERSION（本文件在它之前加载）
     · index.html → 本文件在浏览器里顺手把值写到 <html data-lynkllm-ce>
                    （源码里那个属性留空，只作为「这是 LynkLLM CE 页面」的身份标记）
     · sw.js      → 由注册 URL 的 ?v= 传入（见 app.js），SW 里解析出来；
                    SW 是独立作用域、拿不到 window，所以用这个办法而不是共享变量
   ⚠️ 本文件必须：① 在 store.js **之前**加载；② 进 sw.js 的 SHELL（否则离线打不开）。
   ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '1.4.26100602';

  global.LYNKLLM_VERSION = VERSION;

  /* 浏览器环境下把身份标记写到 <html> 上。
     ⚠️ SW / Worker 里没有 document，这里必须判一下。 */
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-lynkllm-ce', VERSION);
  }
})(typeof self !== 'undefined' ? self : this);
