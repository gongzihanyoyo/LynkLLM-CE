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
      tabPersonalize: '个性化',
      tabModels: '模型',
      tabTools: '工具',
      toolTavily: 'Tavily',

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

      streamBatch: '流式渲染节流',
      streamBatchDesc: '每累计 N 个输出片段才刷新一次界面。输出过快导致页面卡顿时可调大该值（最长 600ms 也会刷新一次）',
      streamBatch1: '1 · 每个片段立即刷新（最流畅）',

      titleModel: '标题总结所用模型',
      titleModelDesc: '选择用于生成标题的模型',

      dataSection: '数据',
      clearAll: '清除所有本地数据',
      clearAllDesc: '删除全部对话记录、模型配置、设置，以及生成的图片 / 语音与背景图，不可恢复',
      clearAllBtn: '立即清除',
      exportData: '导出 / 导入备份',
      exportDataDesc: '导出为 ZIP 备份包（含配置、对话与生成的图片 / 语音），或从备份恢复',
      exportBtn: '导出',
      importBtn: '导入',
      aboutDesc: '纯前端 AI 对话客户端 · 所有数据仅保存在本机浏览器',
      openSource: '开源仓库',
      pwaTitle: '安装为应用',
      pwaDesc: '安装到桌面 / 主屏幕，以独立窗口离线运行',
      pwaInstallBtn: '安装',
      pwaInstalled: '已安装为应用',
      pwaUnavailable: '当前环境不支持安装（或已在独立窗口中运行）',
      pwaOfflineReady: '离线资源已就绪',

      modelsDesc: '管理你自己的 OpenAI 兼容接入。配置与密钥仅保存在本机浏览器。',
      addModel: '新增模型',
      editModel: '编辑模型',
      modelNotice: '当前仅支持 OpenAI 兼容格式。',
      modelSearchPlaceholder: '搜索模型（名称 / 模型 ID / Base URL）',
      modelsNoMatch: '没有匹配的模型',
      clearModelSearch: '清除搜索',

      /* ---- Tavily 联网搜索 ---- */
      tavilyHint: '通过 Tavily 为 AI 提供联网搜索，需要模型支持 Tool Call。',
      tavilyOfficial: '前往官网',
      tavilyKey: 'API Key',
      tavilyKeyPh: 'tvly-dev-...',
      tavilyNotice: 'Key 仅保存在本机浏览器，不会上传到任何服务器。',
      tavilyTesting: '正在测试 Tavily 连通性…',
      tavilyOk: 'Tavily 连接成功，耗时 {0} ms，返回 {1} 条结果',
      tavilyFail: 'Tavily 连接失败',
      tavilyNeedKey: '请先填写 Tavily API Key',
      tavilySaved: 'Tavily 配置已保存',

      /* ---- 工具调用 ---- */
      fTools: '支持工具调用（Tool Call）',
      webSearch: '联网搜索',
      webSearchAuto: '自动',
      webSearchOff: '关闭',
      webSearchDesc: '是否允许模型自主调用 Tavily 搜索工具',
      webSearchAutoDesc: '需要时模型自行决定是否搜索',
      webSearchOffDesc: '本轮不使用联网搜索',
      webSearchNeedTavily: '配置 Tavily API Key 后可用',
      modelTools: '工具',

      toolSearch: '联网搜索',
      toolSearching: '正在搜索…',
      toolSearched: '搜索完成',
      toolSearchFailed: '搜索失败',
      toolResultCount: '{0} 条结果',
      toolParams: '搜索参数',
      toolNoResult: '没有找到相关结果',
      toolAnswer: '摘要',
      toolRoundsLimit: '已达到工具调用轮数上限，回答可能不完整',
      toolDisabled: '联网搜索已关闭',
      toolInProgress: '正在调用工具…',

      speed: '速度',
      speedUnit: 'Token/s',
      speedTip: '平均输出速度（已排除工具调用耗时）',
      version: '版本',

      /* ---- 模型类型 ---- */
      kindAll: '全部',
      kindChat: '对话',
      kindImage: '图片',
      kindChatDesc: '用于文字对话的模型',
      kindImageDesc: '用于文生图 / 图生图的模型',
      fKind: '模型类型',
      fKindHintChat: '用于文字对话的模型',
      modelsEmptyKind: '该分类下还没有模型',
      modelChoicesHint: '从上方列表中选择，或直接手动输入',

      fDisplayName: '显示名称',
      fDisplayNamePh: '例如：DeepSeek 官方',
      fBaseUrlHint: '形如 https://host/v1，程序会自动拼接 /chat/completions（图片模型则拼接 /images/generations），并自动去除末尾斜杠',
      fModel: '模型',
      fModelHint: '点击右侧按钮可自动查询可用模型',
      fContext: '上下文长度（tokens）',
      fContextHint: '仅用于本地估算与提示，不会强制截断',
      fThinking: '思考强度支持列表',
      fThinkingOrder: '勾选顺序即为强度递增顺序',
      selectAll: '全选',
      selectNone: '清空',
      fSystem: '系统提示词',
      fCapabilities: '能力',
      fVision: '图片输入',
      fVisionImage: '图片输入',
      fStream: '支持流式输出（SSE）',
      testConn: '连通性测试',
      cancel: '取消',
      save: '保存',

      inputPlaceholder: '给 LynkLLM CE 发送消息…',
      imageInputPlaceholder: '输入图片生成需求…',
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
      download: '下载',
      downloadAll: '下载全部',

      genCount: '生成数量',
      genSize: '分辨率',
      genCountChip: '{0} 张',
      genSizeAuto: '自动',
      genSizeCustom: '自定义…',
      genSizeCustomTitle: '自定义分辨率',
      genSizeInvalid: '分辨率格式应为 宽x高，例如 1024x1024',
      genImagePending: '正在生成图片…耗时较长，请稍候',
      genImageDone: '已生成 {0} 张图片',
      genImageFailed: '图片生成失败',
      genImageEmptyPrompt: '请先描述你想要的画面',
      generatedBy: '由 {0} 生成',
      imageSavedLocal: '已保存到本地',
      imageLocalWarn: '图片链接不允许跨域读取，已保留临时链接，请尽快下载',
      imageMissing: '图片已不存在',
      imageCountOf: '{0} 张',
      imageModeTip: '当前使用图片模型，发送后将直接生成图片',

      deleteMessage: '删除消息',
      deleteMsgTitle: '删除消息',
      deleteMsgText: '确定要删除这条消息吗？此操作不可恢复。',
      msgDeleted: '消息已删除',

      htmlPreview: 'HTML 预览',
      previewError: '预览中的脚本报错：',

      untitled: '新对话',
      pinnedSection: '置顶',
      pin: '置顶',
      unpin: '取消置顶',
      pinned: '已置顶',
      unpinned: '已取消置顶',
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
      generatedBy: '由 {0} 生成',
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
      exported: '备份已导出',
      importing: '正在恢复备份…',
      imported: '备份已恢复',
      importFailed: '导入失败：文件格式不正确',
      importPartial: '备份已恢复，但有 {0} 个附件未能还原（备份包可能不完整）',
      importEmpty: '导入失败：备份包里没有找到数据清单',
      importNotBackup: '导入失败：这不是有效的备份包',
      noDataToExport: '暂无数据可导出',
      exporting: '正在打包备份…',
      exportFailed: '导出失败',
      exportTooLarge: '备份体积过大，请先清理部分生成的图片或语音后再试',
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
      statImages: '生成图片',
      statAudios: '合成语音',
      statBackground: '背景图片',
      storageFull: '本地存储已满，最近的改动可能未能保存。请删除部分旧对话或生成的图片 / 语音后重试。',
      storageUsage: '占用空间',

      welcomeTitle: '有什么可以帮你的？',
      welcomeDesc: 'LynkLLM CE 是一个纯前端 AI 对话客户端，所有对话与密钥都只保存在这台设备的浏览器中。',

      modelNoVision: '不支持图片',
      modelVision: '图片输入',
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
      clearSearch: '清除搜索',

      /* ---- 语音合成（TTS）---- */
      kindTts: '语音',
      kindTtsDesc: '用于语音合成的模型（把文字读成音频）',
      fVoice: '音色（voice）',
      fVoiceHint: '留空则使用服务商的默认音色',
      fAudioFormat: '输出格式（format）',
      fAudioFormatHint: 'PCM 为裸流，程序会在播放前自动包装为 WAV',
      fTtsInstruction: '朗读指令（风格 / 语气，可选）',
      fTtsInstructionHint: '作为 user 消息发送，用于控制情感与语气',
      audioFormat_wav: 'WAV',
      audioFormat_mp3: 'MP3',
      audioFormat_pcm: 'PCM（播放前自动包装为 WAV）',
      ttsInputPlaceholder: '输入需要朗读的文本…',
      audioLabel: '语音',
      audioSynthesizing: '正在合成语音…',
      audioSynthesizingKb: '正在合成语音… 已接收 {0} KB',
      audioMissing: '音频文件不存在',
      readAloud: '朗读',
      readAloudDesc: '选择语音模型朗读这条回复',
      readAloudNoModel: '还没有语音模型，点此前往配置',
      readAloudEmpty: '这条回复没有可朗读的文本',
      readAloudFailed: '语音合成失败',
      readAloudDone: '语音已生成（{0}s）',

      /* ---- 个性化 ---- */
      fxSection: '半透明模糊',
      fxToggle: '启用毛玻璃效果',
      fxToggleDesc: '标题栏、侧栏、输入框、按钮、弹窗等界面元素使用半透明模糊质感。关闭后界面恢复完全不透明',
      fxStrength: '效果强度',
      fxStrengthDesc: '数值越大，模糊越明显、界面越通透；调到 0 时保留半透明但不做模糊',
      bgSection: '背景图片',
      bgImage: '自定义背景',
      bgImageDesc: '选择一张本地图片作为界面背景，仅保存在本机浏览器；关闭上方效果开关后界面不透明，背景图会被遮住',
      bgBlur: '背景模糊',
      bgBlurDesc: '对背景图片本身做模糊，让前景文字更易读。与上方的毛玻璃效果相互独立',
      bgPick: '选择图片',
      bgClear: '移除',
      bgLoading: '正在处理图片…',
      bgApplied: '背景图片已应用',
      bgNotSaved: '背景图片已应用，但未能保存到本机（浏览器存储不可用），刷新后会丢失',
      bgCleared: '背景图片已移除',
      bgClearFailed: '未能移除已保存的背景图片（浏览器存储不可用）',
      bgPickFailed: '图片处理失败，请换一张试试',
      accentSection: '主题色',
      accentDesc: '用于按钮、链接、选中态等强调色。深浅主题会自动调整明暗以保证可读性。',
      accentCustom: '自定义颜色',
      accentCustomDesc: '用取色器选择任意颜色',
      accentReset: '恢复默认',

      /* ---- 油猴脚本增强 ---- */
      usSection: '油猴脚本增强',
      usScriptDesc: '安装后可帮助绕过部分接口的 CORS 限制',
      usScriptTitle: '增强脚本',
      usInstallTm: '安装油猴',
      usInstallScript: '安装脚本',
      usStatusLabel: '连接状态',
      usConnected: '已连接',
      usDisconnected: '未连接',
      usConnecting: '等待确认…',
      usDeclined: '已拒绝',
      usNeedTm: '请先在上方安装 Tampermonkey 扩展，再安装增强脚本',
      usScriptUrlCopied: '脚本地址已复制到剪贴板',
      usBypassNotReady: '该模型开启了「绕过 CORS 限制」，但增强脚本未连接，本次按普通方式发送',
      fCorsBypass: '绕过 CORS 限制',
      fCorsBypassHint: '开启后该模型的请求交由增强脚本转发，可绕过浏览器跨域限制（需已连接）',
      accentDefault: '默认配色',
      accentResetDone: '已恢复默认主题色',

      /* ---- Tavily 手动参数 ---- */
      tabAbout: '关于',
      tavilyManualTitle: '搜索参数',
      tavilyManualDesc: '每项右侧标注了可用取值范围。填写后将在请求中强制生效，且不再交给模型决定；留空则仍由模型在调用时自行指定。',
      tavilyResetParams: '清空手动配置',
      tavilyParamsCleared: '已清空手动配置',
      tavilyRangeList: '多个值，用逗号分隔',
      tavilyRangeText: '文本',
      tavilyAuto: '交给模型',
      tavilyOn: '开启',
      tavilyOff: '关闭'
    },

    en: {
      appName: 'LynkLLM CE',
      newChat: 'New chat',
      searchPlaceholder: 'Search conversations',
      settings: 'Settings',
      tabGeneral: 'General',
      tabPersonalize: 'Appearance',
      tabModels: 'Models',
      tabTools: 'Tools',
      toolTavily: 'Tavily',

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

      streamBatch: 'Streaming render throttle',
      streamBatchDesc: 'Refresh the view only after N streamed chunks. Increase it if fast output freezes the page (a refresh is forced at least every 600ms)',
      streamBatch1: '1 · refresh on every chunk (smoothest)',

      titleModel: 'Model for title summary',
      titleModelDesc: 'Pick the model used to generate titles',

      dataSection: 'Data',
      clearAll: 'Clear all local data',
      clearAllDesc: 'Delete every conversation, model config and setting, plus generated images, audio and the background image. This cannot be undone.',
      clearAllBtn: 'Clear now',
      exportData: 'Export / Import backup',
      exportDataDesc: 'Export a ZIP backup (config, conversations, generated images and audio), or restore one',
      exportBtn: 'Export',
      importBtn: 'Import',
      aboutDesc: 'Local-first AI chat client · everything stays in this browser',
      openSource: 'Open source',
      pwaTitle: 'Install as app',
      pwaDesc: 'Install to your home screen and run offline in its own window',
      pwaInstallBtn: 'Install',
      pwaInstalled: 'Installed as an app',
      pwaUnavailable: 'Installation is not available here (or already running in standalone mode)',
      pwaOfflineReady: 'Offline assets ready',

      modelsDesc: 'Manage your own OpenAI-compatible endpoints. Configs and keys never leave this browser.',
      addModel: 'Add model',
      editModel: 'Edit model',
      modelNotice: 'Only OpenAI-compatible APIs are supported.',
      modelSearchPlaceholder: 'Search models (name / model ID / Base URL)',
      modelsNoMatch: 'No matching models',
      clearModelSearch: 'Clear search',

      /* ---- Tavily web search ---- */
      tavilyHint: 'Give the AI live web search through Tavily. The model must support Tool Call.',
      tavilyOfficial: 'Open website',
      tavilyKey: 'API Key',
      tavilyKeyPh: 'tvly-dev-...',
      tavilyNotice: 'The key is stored in this browser only and is never uploaded anywhere.',
      tavilyTesting: 'Testing Tavily connectivity…',
      tavilyOk: 'Tavily connected in {0} ms · {1} result(s)',
      tavilyFail: 'Tavily connection failed',
      tavilyNeedKey: 'Enter your Tavily API Key first',
      tavilySaved: 'Tavily settings saved',

      /* ---- Tool calling ---- */
      fTools: 'Supports tool calling (Tool Call)',
      webSearch: 'Web search',
      webSearchAuto: 'Auto',
      webSearchOff: 'Off',
      webSearchDesc: 'Let the model decide when to call the Tavily search tool',
      webSearchAutoDesc: 'The model decides whether to search',
      webSearchOffDesc: 'Do not use web search for this turn',
      webSearchNeedTavily: 'Configure a Tavily API Key to enable this',
      modelTools: 'Tools',

      toolSearch: 'Web search',
      toolSearching: 'Searching…',
      toolSearched: 'Search finished',
      toolSearchFailed: 'Search failed',
      toolResultCount: '{0} result(s)',
      toolParams: 'Parameters',
      toolNoResult: 'No results found',
      toolAnswer: 'Answer',
      toolRoundsLimit: 'Tool-call round limit reached — the answer may be incomplete',
      toolDisabled: 'Web search is off',
      toolInProgress: 'Calling a tool…',

      speed: 'Speed',
      speedUnit: 'Token/s',
      speedTip: 'Average output speed (tool-call time excluded)',
      version: 'Version',

      kindAll: 'All',
      kindChat: 'Chat',
      kindImage: 'Image',
      kindChatDesc: 'Models used for text conversations',
      kindImageDesc: 'Models used for text-to-image / image editing',
      fKind: 'Model type',
      fKindHintChat: 'Models used for text conversations',
      modelsEmptyKind: 'No models in this category yet',
      modelChoicesHint: 'Pick from the list above, or type the model name manually',

      fDisplayName: 'Display name',
      fDisplayNamePh: 'e.g. DeepSeek Official',
      fBaseUrlHint: 'Like https://host/v1 — /chat/completions is appended automatically (or /images/generations for image models), and any trailing slash is removed',
      fModel: 'Model',
      fModelHint: 'Click the button on the right to fetch available models',
      fContext: 'Context length (tokens)',
      fContextHint: 'Used for local estimation and display only',
      fThinking: 'Supported reasoning levels',
      fThinkingOrder: 'The ticked order is the ascending strength order',
      selectAll: 'Select all',
      selectNone: 'Clear',
      fSystem: 'System prompt',
      fCapabilities: 'Capabilities',
      fVision: 'Image input',
      fVisionImage: 'Image input',
      fStream: 'Supports streaming (SSE)',
      testConn: 'Test connection',
      cancel: 'Cancel',
      save: 'Save',

      inputPlaceholder: 'Message LynkLLM CE…',
      imageInputPlaceholder: 'Describe the image you want…',
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
      download: 'Download',
      downloadAll: 'Download all',

      genCount: 'Image count',
      genSize: 'Resolution',
      genCountChip: '{0} images',
      genSizeAuto: 'Auto',
      genSizeCustom: 'Custom…',
      genSizeCustomTitle: 'Custom resolution',
      genSizeInvalid: 'Resolution must look like WIDTHxHEIGHT, e.g. 1024x1024',
      genImagePending: 'Generating images… this can take a while',
      genImageDone: 'Generated {0} image(s)',
      genImageFailed: 'Image generation failed',
      genImageEmptyPrompt: 'Describe the image you want first',
      generatedBy: 'Generated by {0}',
      imageSavedLocal: 'Saved locally',
      imageLocalWarn: 'This image URL blocks cross-origin reads — only a temporary link is kept. Please download it soon.',
      imageMissing: 'Image no longer available',
      imageCountOf: '{0} image(s)',
      imageModeTip: 'An image model is selected — sending will generate images',

      deleteMessage: 'Delete message',
      deleteMsgTitle: 'Delete message',
      deleteMsgText: 'Delete this message? This cannot be undone.',
      msgDeleted: 'Message deleted',

      htmlPreview: 'HTML preview',
      previewError: 'Script error in preview: ',

      untitled: 'New chat',
      pinnedSection: 'Pinned',
      pin: 'Pin to top',
      unpin: 'Unpin',
      pinned: 'Pinned to top',
      unpinned: 'Unpinned',
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
      generatedBy: 'Generated by {0}',
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
      exporting: 'Packing backup…',
      exported: 'Backup exported',
      exportFailed: 'Export failed',
      exportTooLarge: 'Backup is too large — delete some generated images or audio and try again',
      importing: 'Restoring backup…',
      imported: 'Backup restored',
      importFailed: 'Import failed: invalid file',
      importPartial: 'Backup restored, but {0} attachment(s) could not be recovered (the archive may be incomplete)',
      importEmpty: 'Import failed: no data manifest inside the archive',
      importNotBackup: 'Import failed: not a valid backup archive',
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
      statImages: 'Generated images',
      statAudios: 'Generated audio',
      statBackground: 'Background image',
      storageFull: 'Local storage is full — recent changes may not be saved. Delete some old conversations, images or audio and try again.',
      storageUsage: 'Storage',

      welcomeTitle: 'What can I help you with?',
      welcomeDesc: 'LynkLLM CE is a local-first AI chat client. Conversations and keys stay in this browser.',

      modelNoVision: 'No image input',
      modelVision: 'Image input',
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
      clearSearch: 'Clear search',

      /* ---- Text to speech ---- */
      kindTts: 'Speech',
      kindTtsDesc: 'Text-to-speech models (turn text into audio)',
      fVoice: 'Voice',
      fVoiceHint: 'Leave empty to use the provider default',
      fAudioFormat: 'Output format',
      fAudioFormatHint: 'PCM is a raw stream — it is wrapped into WAV automatically before playback',
      fTtsInstruction: 'Speaking instruction (style / tone, optional)',
      fTtsInstructionHint: 'Sent as a user message to control emotion and tone',
      audioFormat_wav: 'WAV',
      audioFormat_mp3: 'MP3',
      audioFormat_pcm: 'PCM (auto-wrapped as WAV)',
      ttsInputPlaceholder: 'Enter the text to be read aloud…',
      audioLabel: 'Speech',
      audioSynthesizing: 'Synthesising speech…',
      audioSynthesizingKb: 'Synthesising speech… {0} KB received',
      audioMissing: 'Audio file not found',
      readAloud: 'Read aloud',
      readAloudDesc: 'Pick a speech model to read this reply aloud',
      readAloudNoModel: 'No speech model configured yet — click to set one up',
      readAloudEmpty: 'This reply has no text to read',
      readAloudFailed: 'Speech synthesis failed',
      readAloudDone: 'Audio generated ({0}s)',

      /* ---- Tavily manual parameters ---- */
      /* ---- Appearance ---- */
      fxSection: 'Translucent blur',
      fxToggle: 'Enable frosted glass',
      fxToggleDesc: 'Top bar, sidebar, composer, buttons and dialogs get a translucent blurred finish. Turn it off for a fully opaque interface',
      fxStrength: 'Effect strength',
      fxStrengthDesc: 'Higher values mean a stronger blur and a more see-through interface. At 0 the surface stays translucent but is not blurred',
      bgSection: 'Background image',
      bgImage: 'Custom background',
      bgImageDesc: 'Pick a local image as the app background. It stays in this browser. With the effect above turned off the interface is opaque and the image is hidden',
      bgBlur: 'Background blur',
      bgBlurDesc: 'Blur the background image itself so foreground text stays readable. Independent of the frosted glass above',
      bgPick: 'Choose image',
      bgClear: 'Remove',
      bgLoading: 'Processing image…',
      bgApplied: 'Background applied',
      bgNotSaved: 'Background applied, but it could not be saved locally (browser storage unavailable) — it will be lost on refresh',
      bgCleared: 'Background removed',
      bgClearFailed: 'Could not remove the saved background image (browser storage unavailable)',
      bgPickFailed: 'Could not process that image, please try another one',
      accentSection: 'Accent color',
      accentDesc: 'Used for buttons, links and selected states. Light and dark themes adjust the shade automatically for readability.',
      accentCustom: 'Custom color',
      accentCustomDesc: 'Pick any color with the color picker',
      accentReset: 'Reset',

      /* ---- Userscript enhancer ---- */
      usSection: 'Userscript enhancer',
      usScriptDesc: 'Once installed, it can help bypass CORS limits on some endpoints',
      usScriptTitle: 'Enhancer script',
      usInstallTm: 'Install Tampermonkey',
      usInstallScript: 'Install script',
      usStatusLabel: 'Connection',
      usConnected: 'Connected',
      usDisconnected: 'Not connected',
      usConnecting: 'Waiting for confirmation…',
      usDeclined: 'Declined',
      usNeedTm: 'Install the Tampermonkey extension above first, then install the enhancer script',
      usScriptUrlCopied: 'Script URL copied to clipboard',
      usBypassNotReady: '“Bypass CORS” is on for this model but the enhancer script is not connected; sending the request normally',
      fCorsBypass: 'Bypass CORS',
      fCorsBypassHint: 'Route this model’s requests through the enhancer script to bypass browser CORS limits (requires a connection)',
      accentDefault: 'Default palette',
      accentResetDone: 'Accent color reset',

      tabAbout: 'About',
      tavilyManualTitle: 'Search parameters',
      tavilyManualDesc: 'Each row shows its accepted range on the right. A filled value is forced in the request and no longer offered to the model; leave it empty to let the model decide.',
      tavilyResetParams: 'Clear manual settings',
      tavilyParamsCleared: 'Manual settings cleared',
      tavilyRangeList: 'Multiple values, comma separated',
      tavilyRangeText: 'Text',
      tavilyAuto: 'Let the model decide',
      tavilyOn: 'On',
      tavilyOff: 'Off'
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
