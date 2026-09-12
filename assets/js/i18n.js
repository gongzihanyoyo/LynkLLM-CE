/* ==========================================================================
   LynkLLM CE — 国际化
   ========================================================================== */
(function (global) {
  'use strict';

  const DICT = {
    'zh-CN': {
      appName: 'LynkLLM CE',
      newChat: '新建对话',
      searchPlaceholder: '搜索对话标题',
      settings: '设置',
      tabGeneral: '常规',
      tabModels: '模型',

      theme: '外观主题',
      themeDesc: '深浅色模式',
      themeLight: '浅色',
      themeDark: '深色',
      themeAuto: '跟随系统',

      enterBehavior: 'Enter 键行为',
      enterBehaviorDesc: '编辑器内按 Enter 与 Shift+Enter 的动作',
      enterSend: 'Enter 发送',
      enterNewline: 'Enter 换行',

      language: '界面语言',
      languageDesc: '界面文本的显示语言',
      langAuto: '跟随系统',

      autoTitle: '自动对话标题',
      autoTitleDesc: '新对话完成后如何生成标题',
      autoTitleFirst: '第一条消息',
      autoTitleChat: '对话模型总结',
      autoTitleModel: '指定模型总结',

      renderRich: '增强内容渲染',
      renderRichDesc: '渲染 LaTeX 公式与 Mermaid 图表（按需从 CDN 加载，可能略慢）',

      showTokens: '显示 Token 用量',
      showTokensDesc: '在每条 AI 回复下方显示输入/输出 Token 详情',

      streamOutput: '流式输出',
      streamOutputDesc: '全局开关，实际是否生效取决于模型配置',

      titleModel: '标题总结所用模型',
      titleModelDesc: '选择用于生成标题的模型',

      dataSection: '数据',
      clearAll: '清除所有本地数据',
      clearAllDesc: '删除全部对话记录、模型配置与设置，不可恢复',
      clearAllBtn: '立即清除',
      exportData: '导出 / 导入配置',
      exportDataDesc: '导出为 JSON 文件用于备份，或从备份恢复',
      exportBtn: '导出',
      importBtn: '导入',
      aboutDesc: '纯前端 AI 对话客户端 · 所有数据仅保存在本机浏览器',
      openSource: '开源仓库',

      modelsDesc: '管理你自己的 OpenAI 兼容接入。配置与密钥仅保存在本机浏览器。',
      addModel: '新增模型',
      editModel: '编辑模型',
      modelNotice: '请确认服务商支持跨域调用（CORS），当前仅支持 OpenAI 兼容格式。',

      fDisplayName: '显示名称',
      fDisplayNamePh: '例如：DeepSeek 官方',
      fBaseUrlHint: '形如 https://host/v1，程序会自动拼接 /chat/completions，并自动去除末尾斜杠',
      fModel: '模型',
      fModelHint: '点击右侧按钮可从 /models 自动查询可用模型',
      fContext: '上下文长度（tokens）',
      fContextHint: '仅用于本地估算与提示，不会强制截断',
      fThinking: '思考强度支持列表',
      fThinkingHint: '勾选该模型支持的思考强度；全部不勾选表示不支持思考强度切换。第一项为默认值。',
      fThinkingOrder: '勾选顺序即为强度递增顺序',
      selectAll: '全选',
      selectNone: '清空',
      fSystem: '系统提示词',
      fCapabilities: '能力',
      fVision: '支持图片识别（多模态）',
      fStream: '支持流式输出（SSE）',
      testConn: '连通性测试',
      cancel: '取消',
      save: '保存',

      inputPlaceholder: '给 LynkLLM CE 发送消息…',
      send: '发送',
      stop: '停止生成',
      uploadImage: '上传图片',
      rename: '重命名',
      delete: '删除',
      more: '更多',
      copy: '复制',
      copied: '已复制',
      regenerate: '重新生成',
      edit: '编辑',
      resend: '重新发送',
      scrollBottom: '滚动到底部',
      refresh: '刷新',

      deleteMessage: '删除消息',
      deleteMsgTitle: '删除消息',
      deleteMsgText: '确定要删除这条消息吗？此操作不可恢复。',
      msgDeleted: '消息已删除',

      htmlPreview: 'HTML 预览',
      previewError: '预览中的脚本报错：',

      untitled: '新对话',
      you: '你',
      assistant: 'AI 助手',
      notConfigured: '未配置模型',
      selectModel: '选择模型',
      noModels: '还没有配置任何模型',
      addModelFirst: '请先在设置中添加模型接入',
      clickToAdd: '前往添加',
      thinking: '思考强度',
      defaultOption: '默认',
      currentlyUsing: '当前使用',

      reasoning: '思考过程',
      reasoningDone: '已深度思考',
      reasoningThinking: '正在思考…',
      reasoningChars: '{0} 字',
      reasoningExpand: '展开思考过程',
      reasoningCollapse: '收起思考过程',
      sidebarWidthReset: '侧栏宽度已复位',

      confirmTitle: '确认操作',
      deleteConvTitle: '删除对话',
      deleteConvText: '确定要删除对话「{0}」吗？此操作不可恢复。',
      deleteModelTitle: '删除模型',
      deleteModelText: '确定要删除模型「{0}」吗？',
      clearAllTitle: '清除所有本地数据',
      clearAllText: '将删除全部对话记录、模型配置与界面设置，且不可恢复。确定继续吗？',
      noAskAgain: '不再询问',

      convDeleted: '对话已删除',
      modelDeleted: '模型已删除',
      modelSaved: '模型已保存',
      modelAdded: '模型已添加',
      settingsSaved: '设置已保存',
      allCleared: '已清除全部本地数据',
      renamed: '已重命名',
      titleRenamed: '标题已更新',
      exported: '已导出配置文件',
      imported: '配置已导入',
      importFailed: '导入失败：文件格式不正确',
      noDataToExport: '暂无数据可导出',
      attachmentAdded: '已添加 {0} 张图片',
      attachmentRemoved: '已移除图片',
      imageOnly: '暂时只支持上传图片',
      imageTooLarge: '图片过大（超过 {0}MB）：{1}',
      maxImages: '最多上传 {0} 张图片',
      visionUnsupported: '当前模型不支持图片识别，已自动忽略附件',
      emptyInput: '请输入内容后再发送',
      generating: '正在生成回复…',
      stopped: '已停止生成',
      generationStopped: '生成已中断',
      requestFailed: '请求失败',
      networkError: '网络请求失败，请检查 Base URL、Key 与网络连接',
      aborted: '已取消',
      noConversation: '对话不存在',
      titleSummarizing: '正在总结标题…',
      titleDone: '标题已更新',
      searchNoResult: '没有找到匹配的对话',
      listEmpty: '还没有对话，点击上方「新建对话」开始',

      today: '今天',
      yesterday: '昨天',
      last7Days: '过去 7 天',
      last30Days: '过去 30 天',
      earlier: '更早',

      msgCount: '{0} 条消息',
      tokenInHit: '输入（缓存）',
      tokenInMiss: '输入（非缓存）',
      tokenOut: '输出',
      tokenTotal: '总计',
      tokenEstimated: '估算',
      tokensUnit: 'tokens',

      ctxWarn: '当前对话已使用约 {0}% 的上下文（{1} / {2} tokens），接近模型上限，建议新建对话或删除较早的消息。',
      ctxDanger: '当前对话已使用约 {0}% 的上下文（{1} / {2} tokens），可能超出模型上限，建议新建对话或删除较早的消息。',

      testing: '正在测试连通性…',
      testOk: '连接成功，耗时 {0} ms',
      testOkModels: '连接成功，返回 {0} 个模型，耗时 {1} ms',
      testFail: '连接失败',

      fetchingModels: '正在查询可用模型…',
      modelsFound: '查询到 {0} 个模型',
      modelsNone: '未查询到模型列表，可手动填写',
      fillRequired: '请填写 Base URL 和 API Key',
      fillModelName: '请填写模型名称',

      statConversations: '对话数',
      statMessages: '消息数',
      statModels: '模型数',
      storageUsage: '占用空间',

      welcomeTitle: '有什么可以帮你的？',
      welcomeDesc: 'LynkLLM CE 是一个纯前端 AI 对话客户端，所有对话与密钥都只保存在这台设备的浏览器中。',

      modelNoVision: '不支持图片',
      modelVision: '支持图片',
      modelStream: '流式',
      modelNoStream: '非流式',
      contextLen: '上下文',
      using: '使用中',
      setAsCurrent: '设为当前',

      copiedToClipboard: '已复制到剪贴板',
      copyFailed: '复制失败，请手动选择文本',

      imagePreview: '图片预览',
      close: '关闭',

      history: '历史对话',
      modelList: '模型列表',
      thinkingLevels: '思考强度',
      clearSearch: '清除搜索'
    },

    en: {
      appName: 'LynkLLM CE',
      newChat: 'New chat',
      searchPlaceholder: 'Search conversations',
      settings: 'Settings',
      tabGeneral: 'General',
      tabModels: 'Models',

      theme: 'Appearance',
      themeDesc: 'Light or dark color scheme',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeAuto: 'System',

      enterBehavior: 'Enter key behavior',
      enterBehaviorDesc: 'What Enter and Shift+Enter do in the editor',
      enterSend: 'Enter to send',
      enterNewline: 'Enter for newline',

      language: 'Language',
      languageDesc: 'Language of the interface',
      langAuto: 'System',

      autoTitle: 'Automatic chat title',
      autoTitleDesc: 'How a title is created once a new chat gets its first reply',
      autoTitleFirst: 'First message',
      autoTitleChat: 'Summarize with chat model',
      autoTitleModel: 'Summarize with a specific model',

      renderRich: 'Enhanced rendering',
      renderRichDesc: 'Render LaTeX formulas and Mermaid diagrams (loaded from CDN on demand)',

      showTokens: 'Show token usage',
      showTokensDesc: 'Display input/output token details under each AI reply',

      streamOutput: 'Streaming output',
      streamOutputDesc: 'Global switch; actual behavior depends on the model configuration',

      titleModel: 'Model for title summary',
      titleModelDesc: 'Pick the model used to generate titles',

      dataSection: 'Data',
      clearAll: 'Clear all local data',
      clearAllDesc: 'Delete every conversation, model config and setting. This cannot be undone.',
      clearAllBtn: 'Clear now',
      exportData: 'Export / Import',
      exportDataDesc: 'Export a JSON backup, or restore from one',
      exportBtn: 'Export',
      importBtn: 'Import',
      aboutDesc: 'Local-first AI chat client · everything stays in this browser',
      openSource: 'Open source',

      modelsDesc: 'Manage your own OpenAI-compatible endpoints. Configs and keys never leave this browser.',
      addModel: 'Add model',
      editModel: 'Edit model',
      modelNotice: 'Make sure your provider allows cross-origin calls (CORS). Only OpenAI-compatible APIs are supported.',

      fDisplayName: 'Display name',
      fDisplayNamePh: 'e.g. DeepSeek Official',
      fBaseUrlHint: 'Like https://host/v1 — /chat/completions is appended automatically, and any trailing slash is removed',
      fModel: 'Model',
      fModelHint: 'Click the button to auto-discover models from /models',
      fContext: 'Context length (tokens)',
      fContextHint: 'Used for local estimation and display only',
      fThinking: 'Supported reasoning levels',
      fThinkingHint: 'Tick the levels this model supports. None ticked means the model has no reasoning control. The first one is the default.',
      fThinkingOrder: 'The ticked order is the ascending strength order',
      selectAll: 'Select all',
      selectNone: 'Clear',
      fSystem: 'System prompt',
      fCapabilities: 'Capabilities',
      fVision: 'Supports image input (multimodal)',
      fStream: 'Supports streaming (SSE)',
      testConn: 'Test connection',
      cancel: 'Cancel',
      save: 'Save',

      inputPlaceholder: 'Message LynkLLM CE…',
      send: 'Send',
      stop: 'Stop generating',
      uploadImage: 'Upload image',
      rename: 'Rename',
      delete: 'Delete',
      more: 'More',
      copy: 'Copy',
      copied: 'Copied',
      regenerate: 'Regenerate',
      edit: 'Edit',
      resend: 'Resend',
      scrollBottom: 'Scroll to bottom',
      refresh: 'Refresh',

      deleteMessage: 'Delete message',
      deleteMsgTitle: 'Delete message',
      deleteMsgText: 'Delete this message? This cannot be undone.',
      msgDeleted: 'Message deleted',

      htmlPreview: 'HTML preview',
      previewError: 'Script error in preview: ',

      untitled: 'New chat',
      you: 'You',
      assistant: 'Assistant',
      notConfigured: 'No model configured',
      selectModel: 'Select model',
      noModels: 'No model configured yet',
      addModelFirst: 'Add a model endpoint in Settings first',
      clickToAdd: 'Add one now',
      thinking: 'Reasoning',
      defaultOption: 'Default',
      currentlyUsing: 'In use',

      reasoning: 'Reasoning',
      reasoningDone: 'Thought process',
      reasoningThinking: 'Thinking…',
      reasoningChars: '{0} chars',
      reasoningExpand: 'Expand reasoning',
      reasoningCollapse: 'Collapse reasoning',
      sidebarWidthReset: 'Sidebar width reset',

      confirmTitle: 'Please confirm',
      deleteConvTitle: 'Delete conversation',
      deleteConvText: 'Delete “{0}”? This cannot be undone.',
      deleteModelTitle: 'Delete model',
      deleteModelText: 'Delete model “{0}”?',
      clearAllTitle: 'Clear all local data',
      clearAllText: 'All conversations, model configs and settings will be permanently deleted. Continue?',
      noAskAgain: "Don't ask again",

      convDeleted: 'Conversation deleted',
      modelDeleted: 'Model deleted',
      modelSaved: 'Model saved',
      modelAdded: 'Model added',
      settingsSaved: 'Settings saved',
      allCleared: 'All local data cleared',
      renamed: 'Renamed',
      titleRenamed: 'Title updated',
      exported: 'Config exported',
      imported: 'Config imported',
      importFailed: 'Import failed: invalid file',
      noDataToExport: 'Nothing to export',
      attachmentAdded: 'Added {0} image(s)',
      attachmentRemoved: 'Image removed',
      imageOnly: 'Only images are supported for now',
      imageTooLarge: 'Image too large (over {0}MB): {1}',
      maxImages: 'Up to {0} images',
      visionUnsupported: 'This model has no vision support — attachments ignored',
      emptyInput: 'Please type something first',
      generating: 'Generating…',
      stopped: 'Generation stopped',
      generationStopped: 'Generation was interrupted',
      requestFailed: 'Request failed',
      networkError: 'Network error. Check the Base URL, API key and your connection.',
      aborted: 'Cancelled',
      noConversation: 'Conversation not found',
      titleSummarizing: 'Summarizing title…',
      titleDone: 'Title updated',
      searchNoResult: 'No matching conversations',
      listEmpty: 'No conversations yet — start one above',

      today: 'Today',
      yesterday: 'Yesterday',
      last7Days: 'Previous 7 days',
      last30Days: 'Previous 30 days',
      earlier: 'Earlier',

      msgCount: '{0} messages',
      tokenInHit: 'Input (cached)',
      tokenInMiss: 'Input (uncached)',
      tokenOut: 'Output',
      tokenTotal: 'Total',
      tokenEstimated: 'estimated',
      tokensUnit: 'tokens',

      ctxWarn: 'About {0}% of the context window is used ({1} / {2} tokens) — close to the model limit. Consider a new chat or deleting older messages.',
      ctxDanger: 'About {0}% of the context window is used ({1} / {2} tokens) — the model limit may be exceeded. Consider a new chat or deleting older messages.',

      testing: 'Testing connection…',
      testOk: 'Connected in {0} ms',
      testOkModels: 'Connected · {0} models · {1} ms',
      testFail: 'Connection failed',

      fetchingModels: 'Fetching models…',
      modelsFound: '{0} models found',
      modelsNone: 'No model list returned — enter one manually',
      fillRequired: 'Base URL and API Key are required',
      fillModelName: 'Model name is required',

      statConversations: 'Chats',
      statMessages: 'Messages',
      statModels: 'Models',
      storageUsage: 'Storage',

      welcomeTitle: 'What can I help you with?',
      welcomeDesc: 'LynkLLM CE is a local-first AI chat client. Conversations and keys stay in this browser.',

      modelNoVision: 'No vision',
      modelVision: 'Vision',
      modelStream: 'Stream',
      modelNoStream: 'Non-stream',
      contextLen: 'Context',
      using: 'In use',
      setAsCurrent: 'Set as current',

      copiedToClipboard: 'Copied to clipboard',
      copyFailed: 'Copy failed — select the text manually',

      imagePreview: 'Image preview',
      close: 'Close',

      history: 'Conversations',
      modelList: 'Models',
      thinkingLevels: 'Reasoning effort',
      clearSearch: 'Clear search'
    }
  };

  const FALLBACK = 'zh-CN';

  let current = FALLBACK;

  function normalize(lang) {
    if (!lang) return null;
    const l = String(lang).toLowerCase();
    if (l.startsWith('zh')) return 'zh-CN';
    if (l.startsWith('en')) return 'en';
    return null;
  }

  function systemLang() {
    const list = (global.navigator && (global.navigator.languages || [global.navigator.language])) || [];
    const arr = Array.isArray(list) ? list : [list];
    for (const l of arr) {
      const n = normalize(l);
      if (n) return n;
    }
    return FALLBACK;
  }

  function resolve(setting) {
    if (!setting || setting === 'auto') return systemLang();
    return normalize(setting) || FALLBACK;
  }

  const I18N = {
    dict: DICT,
    resolve,
    systemLang,
    get lang() { return current; },

    set(setting) {
      current = resolve(setting);
      if (global.document && global.document.documentElement) {
        global.document.documentElement.setAttribute('lang', current);
      }
      return current;
    },

    /** 取翻译，支持 {0} {1} 占位 */
    t(key, ...args) {
      const table = DICT[current] || DICT[FALLBACK];
      let s = table[key];
      if (s === undefined) s = DICT[FALLBACK][key];
      if (s === undefined) s = key;
      if (args.length) {
        s = s.replace(/\{(\d+)\}/g, (m, i) => {
          const v = args[Number(i)];
          return v === undefined || v === null ? '' : String(v);
        });
      }
      return s;
    },

    /** 生成相对时间描述 */
    formatTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
      const y = new Date(now.getTime() - 864e5);
      if (d.toDateString() === y.toDateString()) {
        return (current === 'en' ? 'Yesterday' : '昨天') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
      if (d.getFullYear() === now.getFullYear()) {
        return (d.getMonth() + 1) + (current === 'en' ? '/' : '月') + d.getDate() + (current === 'en' ? '' : '日');
      }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
  };

  global.I18N = I18N;
})(window);
