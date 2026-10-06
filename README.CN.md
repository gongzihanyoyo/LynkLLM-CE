<div align="center">

<img width="100" height="100" alt="Logo" src="https://github.com/user-attachments/assets/a801019d-c62a-4c86-adf6-61c1c47f6735" />

# LynkLLM-CE

轻量级 BYOK AI 聊天网页客户端

<a href="https://github.com/gongzihanyoyo/LynkLLM-CE/blob/main/LICENSE"><img src="https://img.shields.io/github/license/gongzihanyoyo/LynkLLM-CE" alt="License" /></a>
<a href="https://github.com/gongzihanyoyo/LynkLLM-CE/releases"><img src="https://img.shields.io/github/release/gongzihanyoyo/LynkLLM-CE" alt="Latest" /></a>

by [**Jitaimei Studio**](https://www.jitaimei.top)

[English](https://github.com/gongzihanyoyo/LynkLLM-CE/blob/main/README.md) | **简体中文**

</div>

## 功能特性

- [x] 无需下载，打开即用。
- [x] 数据存储于本地，隐私性强。
- [x] 直连接口不中转，高速输出。
- [x] 支持 OpenAI Chat、OpenAI Responses 和 Anthropic 三大 API 格式。
- [x] 可自由管理多个模型，支持对话、图像、TTS模型接入。
- [x] 支持接入 [Tavily](https://www.tavily.com)，让 AI 自动搜索信息。
- [x] 提供上下文长度警告，防止因过长导致意外中断。
- [x] 支持 Python 调用（由 Pyodide 提供支持），为 AI 提供本地复杂计算支持。
- [x] 支持自由导入和管理多个 SKILL.md，使模型能够按照既定规则运行。
- [x] 提供 MCP 连接支持，扩展更多能力。
- [x] 提供[油猴脚本](https://www.tampermonkey.net/script_installation.php#url=https://lynkllm-ce.pages.dev/LynkLLM-CE-Enhancer.user.js)以绕过 CORS 或混合内容限制。

<img width="2800" height="1486" alt="ScreenShot-1" src="https://github.com/user-attachments/assets/122329ee-9072-4cf4-a026-5f770d26b3ca" />

<details>
<summary>查看更多截图</summary>

<img width="2800" height="1489" alt="ScreenShot-2" src="https://github.com/user-attachments/assets/d4446130-aca4-44a3-a547-b53208c66725" />
<img width="2800" height="1486" alt="ScreenShot-3" src="https://github.com/user-attachments/assets/ef466ed2-56ad-46fd-ad54-7aedbe09e8ba" />
<img width="2800" height="1490" alt="ScreenShot-4" src="https://github.com/user-attachments/assets/88ce93e2-1121-4e65-9048-be6d5a4b72c6" />
<img width="2800" height="1489" alt="ScreenShot-5" src="https://github.com/user-attachments/assets/99ab757f-06e9-4ead-a58d-0c5b9f4a9447" />

</details>

## 在线体验

[lynkllm-ce.pages.dev](https://lynkllm-ce.pages.dev)

*\* 此演示站点上的版本可能比 GitHub 上的代码更新，因此可以在这里体验到新功能 ~~和新bug~~ 。*

## 注意事项

- 对于部分存在 CORS 或混合内容限制的 API，请[安装增强脚本](https://www.tampermonkey.net/script_installation.php#url=https://lynkllm-ce.pages.dev/LynkLLM-CE-Enhancer.user.js)。

## 许可证

[MIT License](https://github.com/gongzihanyoyo/LynkLLM-CE/blob/main/LICENSE)

## 免责声明

- 我们仅提供对话界面框架，不对 AI 生成的内容负责。
- 在使用 AI 生成内容时，请自觉遵守所在地区的法律法规。

## 联系我们

- [邮箱 gongzihanyoyo@163.com](mailto:gongzihanyoyo@163.com)
- [B站 @gongzihanyoyo](https://space.bilibili.com/2104835974)

## 备注

根据我们的实际测试，以下平台明确支持 CORS 调用，因此你无需使用增强脚本即可使用：

- [DeepSeek API](https://platform.deepseek.com)
- [千问 AI 平台](https://www.qianwenai.com)
- [小米 MiMo API](https://platform.xiaomimimo.com)
- [Z-AI BigModel](https://www.bigmodel.cn)
- OrcaRouter

欢迎补充更多相关信息。
