/* ==========================================================================
   LynkLLM CE — 模型品牌图标（Lobe Icons）
   依据模型「显示名称 / 模型 ID / Base URL」中的关键词自动匹配品牌图标。
   图标来自 @lobehub/icons-static-svg（CDN 按需加载），匹配不到时回退为通用图标。
   ========================================================================== */
(function (global) {
  'use strict';

  const { $, el } = UI;

  const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.0/icons/';

  /**
   * 关键词 → 图标名，按顺序匹配，先命中者优先。
   * 前面的规则更具体，后面的更宽泛，避免短词误伤。
   */
  const RULES = [
    // ---- 图像生成类品牌 ----
    { icon: 'jimeng', re: /jimeng|即梦/i },
    { icon: 'kling', re: /kling|可灵/i },
    { icon: 'midjourney', re: /midjourney|\bmj\b/i },
    { icon: 'flux', re: /flux|black[\s-]?forest/i },
    { icon: 'stability', re: /stabilit|stable[\s-]?diffusion|sdxl|\bsd[-_ ]?[0-9x]|\bsd3/i },
    { icon: 'ideogram', re: /ideogram/i },
    { icon: 'recraft', re: /recraft/i },
    { icon: 'luma', re: /luma|ray2|ray-2/i },
    { icon: 'runway', re: /runway|gen-?[34]/i },
    { icon: 'pika', re: /pika/i },
    { icon: 'vidu', re: /vidu|生数/i },
    { icon: 'cogview', re: /cogview|清影/i },
    { icon: 'comfyui', re: /comfy/i },
    { icon: 'nanobanana', re: /nano[\s-]?banana/i },
    { icon: 'dalle', re: /dall[\s-]?e|gpt[\s-]?image/i },

    // ---- 对话/多模态大模型品牌 ----
    { icon: 'qwen', re: /qwen|通义|千问|tongyi|dashscope|万相|wanx|wan[0-9]|z[\s-]?image/i },
    { icon: 'deepseek', re: /deepseek|深度求索/i },
    { icon: 'doubao', re: /doubao|豆包|seedream|seedance|seed[\s-]?(edit|image)/i },
    { icon: 'volcengine', re: /volc|火山/i },
    { icon: 'chatglm', re: /\bglm\b|chatglm|智谱|zhipu|清言/i },
    { icon: 'kimi', re: /kimi|moonshot|月之暗面/i },
    { icon: 'minimax', re: /minimax|abab|海螺/i },
    { icon: 'hunyuan', re: /hunyuan|混元/i },
    { icon: 'wenxin', re: /wenxin|ernie|文心/i },
    { icon: 'spark', re: /spark|星火|讯飞|iflytek/i },
    { icon: 'stepfun', re: /stepfun|step[\s-]?[0-9]|阶跃/i },
    { icon: 'sensenova', re: /sensenova|商汤|sensechat|日日新/i },
    { icon: 'baichuan', re: /baichuan|百川/i },
    { icon: 'internlm', re: /internlm|书生|浦语/i },
    { icon: 'skywork', re: /skywork|天工/i },
    { icon: 'longcat', re: /longcat|龙猫/i },
    { icon: 'minimax', re: /\babab\b/i },
    { icon: 'claude', re: /claude|anthropic/i },
    { icon: 'gemini', re: /gemini|gemma|\bimagen\b|veo/i },
    { icon: 'google', re: /google|palm|bard/i },
    { icon: 'openai', re: /\bgpt\b|gpt-|chatgpt|\bo[1-4](-|$)|openai|codex/i },
    { icon: 'grok', re: /grok|\bxai\b/i },
    { icon: 'mistral', re: /mistral|mixtral|codestral/i },
    { icon: 'meta', re: /\bmeta\b|llama/i },
    { icon: 'cohere', re: /cohere|command[\s-]?r/i },
    { icon: 'perplexity', re: /perplexity|sonar/i },
    { icon: 'groq', re: /groq/i },
    { icon: 'nvidia', re: /nvidia|nemotron/i },
    { icon: 'azure', re: /azure/i },
    { icon: 'bedrock', re: /bedrock|\baws\b|titan/i },
    { icon: 'vertexai', re: /vertex/i },
    { icon: 'openrouter', re: /openrouter/i },
    { icon: 'ollama', re: /ollama/i },
    { icon: 'together', re: /together/i },
    { icon: 'fireworks', re: /fireworks/i },
    { icon: 'replicate', re: /replicate/i },
    { icon: 'novita', re: /novita/i },
    { icon: 'deepinfra', re: /deepinfra/i },
    { icon: 'hyperbolic', re: /hyperbolic/i },
    { icon: 'sambanova', re: /sambanova/i },
    { icon: 'modelscope', re: /modelscope|魔搭/i },
    { icon: 'siliconcloud', re: /siliconflow|siliconcloud|硅基流动/i },
    { icon: 'pixverse', re: /pixverse|爱诗/i },
    { icon: 'hailuo', re: /hailuo/i },
    { icon: 'tencent', re: /tencent|腾讯/i },
    { icon: 'bytedance', re: /bytedance|字节/i },
    { icon: 'alibaba', re: /alibaba|阿里/i },
    { icon: 'baidu', re: /baidu|百度/i },
    { icon: 'microsoft', re: /microsoft|phi-|copilot/i }
  ];

  const CACHE = {};      // iconName -> 'color' | 'mono' | 'missing'

  function haystack(model) {
    if (!model) return '';
    return [model.name, model.model, model.baseUrl].filter(Boolean).join(' ');
  }

  /** 匹配图标名，匹配不到返回 '' */
  function matchIcon(model) {
    const text = haystack(model);
    if (!text) return '';
    for (let i = 0; i < RULES.length; i++) {
      if (RULES[i].re.test(text)) return RULES[i].icon;
    }
    return '';
  }

  function colorUrl(name) { return CDN_BASE + name + '-color.svg'; }
  function monoUrl(name) { return CDN_BASE + name + '.svg'; }

  /** 回退用的通用图标（按模型类型区分：图片 / 语音 / 对话） */
  function fallbackIconName(model) {
    const kind = model && model.kind;
    if (kind === 'image') return 'bi-image';
    if (kind === 'tts') return 'bi-soundwave';
    return 'bi-cpu';
  }

  function buildFallback(model, cls) {
    return el('i', { class: (cls || '') + ' bi ' + fallbackIconName(model), 'aria-hidden': 'true' });
  }

  /**
   * 生成模型图标节点
   * @param {object} model 模型配置
   * @param {object} [opts] { size: number, fallbackClass: string }
   * @returns {HTMLElement}
   */
  function create(model, opts) {
    opts = opts || {};
    const icon = matchIcon(model);
    const size = opts.size || 18;

    if (!icon) {
      const wrap = el('span', { class: 'model-logo is-fallback' });
      wrap.style.setProperty('--logo-size', size + 'px');
      wrap.appendChild(buildFallback(model, opts.fallbackClass));
      return wrap;
    }

    const wrap = el('span', { class: 'model-logo' });
    wrap.style.setProperty('--logo-size', size + 'px');
    const img = el('img', {
      class: 'model-logo-img' + (CACHE[icon] === 'mono' ? ' is-mono' : ''),
      alt: '',
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
      draggable: 'false'
    });

    img.addEventListener('error', () => {
      if (img.dataset.fallback === '1') {
        // 彩色与单色都失败：退回通用图标
        CACHE[icon] = 'missing';
        const f = buildFallback(model, opts.fallbackClass);
        if (wrap.parentNode) wrap.parentNode.replaceChild(f, wrap);
        return;
      }
      img.dataset.fallback = '1';
      img.classList.add('is-mono');
      CACHE[icon] = 'mono';
      img.src = monoUrl(icon);
    });

    img.addEventListener('load', () => {
      if (!img.dataset.fallback) CACHE[icon] = 'color';
    });

    img.src = colorUrl(icon);
    wrap.appendChild(img);
    return wrap;
  }

  /** 在容器内插入（或替换）模型图标 */
  function render(container, model, opts) {
    if (!container) return null;
    const node = create(model, opts);
    container.appendChild(node);
    return node;
  }

  global.Logos = {
    create, render, matchIcon, colorUrl, monoUrl, CDN_BASE, RULES,
    isKnown: (name) => !!name && CACHE[name] !== 'missing'
  };
})(window);
