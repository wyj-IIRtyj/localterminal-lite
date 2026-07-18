# LocalTerminal Lite

[English](README.md) · [Actions 教程](docs/ACTIONS_SETUP.zh-CN.md) · [GPT 预设指令](docs/GPT_INSTRUCTIONS.zh-CN.md) · [短提示词手册](docs/PROMPT_PLAYBOOK.zh-CN.md) · [隐私说明](docs/PRIVACY.zh-CN.md)

LocalTerminal Lite 的核心目的，是让 **ChatGPT 的普通 Chat 对话模式也能以可控方式在本地电脑上工作**。通过为自定义 GPT 配置 Action，或接入 ChatGPT App，普通 ChatGPT 对话就可以查看和编辑获准的本地项目、运行受约束的工具、协调多个工作 session 并汇报进展；用户始终通过本地 TUI 保留控制权。Lite 是 ChatGPT Chat 与本地电脑之间的桥梁，不是另一个聊天客户端。

LocalTerminal Lite 1.0.1 通过可审计、可继承的工作 session 层提供这座桥梁。它同时支持 ChatGPT **Actions** 和 **Apps（MCP）**，并提供多 session 协作、永久消息、声明式扩展、Git 风格实时 diff，以及覆盖整个终端窗口的中英双语 OpenTUI 界面。

![LocalTerminal Lite session 层级](docs/assets/tui/sessions-zh-CN.svg)

## 安装与启动

### 第一次安装

无需提前安装 Git、Node.js、Bun 或其他编程环境。安装脚本会在需要时安装 Bun、下载固定的 `v1.0.1` 源码包、安装锁定依赖、把 `localterminal-lite` 注册成当前用户的全局命令，然后启动 TUI。

#### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.0.1/scripts/install-macos.sh)"
```

#### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.0.1/scripts/install-windows.ps1 | iex"
```

直接运行远端脚本很方便，但也需要谨慎。执行前可以先检查 [macOS 安装脚本](scripts/install-macos.sh)或 [Windows 安装脚本](scripts/install-windows.ps1)。

首次启动的 TUI 会完成全部配置：语言、主题、授权工作区、监听地址、公网 URL、限制、Apps connector key 和 Actions token。不需要 `.env`，也不需要手动修改配置文件。

### 第二次及以后快速启动

重新打开一个终端、PowerShell 或命令提示符窗口，直接输入安装器为当前用户注册的全局命令。启动器会记住 Lite 的实际安装目录和 Bun 可执行文件，包括自定义安装位置。已经安装 `v1.0.0` 的用户可以再运行一次 `v1.0.1` 安装命令：安装器会识别有效的现有安装，只修复依赖和全局启动器，不会删除 Lite 配置。

```text
localterminal-lite
```

Lite 会继续使用此前通过 TUI 保存的配置。如果 ChatGPT 通过临时 Quick Tunnel 接入，还需要单独重新启动隧道；它的随机公网 URL 可能发生变化。

### 从源码安装

如果已经安装 Bun 1.3 或以上版本：

```bash
git clone https://github.com/wyj-IIRtyj/localterminal-lite.git
cd localterminal-lite
bun install --frozen-lockfile
bun run dev
```

## 选择连接方式

| 连接 | 适用场景 | Lite 显示的 endpoint |
| --- | --- | --- |
| GPT Actions | 为自定义 GPT 配置 OpenAPI Action。 | `https://你的域名/openapi.json` |
| ChatGPT Apps | 符合条件的工作区支持自定义 MCP app/connector。 | `https://你的域名/mcp/<隐藏的-connector-key>` |

一个 GPT 不能同时使用 Apps 和 Actions。Actions 用户请阅读隐私安全的[中文完整教程](docs/ACTIONS_SETUP.zh-CN.md)或[英文教程](docs/ACTIONS_SETUP.md)，其中包括 HTTPS 隧道、schema 导入、Bearer 认证、GPT 配置、预览测试和常见报错。

## 为什么只有三个 facade 工具

模型始终只看到三个操作：

- `extension_discover`：了解身份、具体工具、schema 和扩展注册方式；
- `extension_call`：调用工作区、Git、session、消息或自定义具体工具；
- `extension_register`：验证、upsert 或移除声明式扩展。

稳定的小接口避免 GPT 配置随工具增加而膨胀，具体能力仍可按需发现。Actions 中 operation ID 使用 camelCase（`extensionDiscover`、`extensionCall`、`extensionRegister`），语义相同。

```text
ChatGPT
  └─ extensionCall
       ├─ tool: session_register
       ├─ input: { mode: "root", name: "main" }
       └─ identity: { sessionId, sessionToken }  # bootstrap 后
```

使用项目提供的 [GPT 预设指令](docs/GPT_INSTRUCTIONS.zh-CN.md)避免 API 分层错误；向普通用户提供[短提示词手册](docs/PROMPT_PLAYBOOK.zh-CN.md)，不需要长篇提示词。

## 可审计协作

Lite session 是工作上下文，不是 ChatGPT 对话 ID。

- 新任务通过 `session_register(mode=root)` 创建并领取 root。
- Root 可以用结构化任务包创建多个直接子 session；子 session 不得创建孙 session。
- `session_inherit` 使用一次性 claim code 领取 pending、stale、released 或 revoked 的未完成工作。
- Completed 工作不可变。续作必须创建同级 `session_register(...continuesSessionId)`，不能调用 `session_inherit`。
- 每轮工作都以结构化 `session_checkpoint` 结束。
- 消息永久保存，发送者身份不可伪造；事件在显式 ACK 前会重复投递。
- 追加式 JSONL 历史记录任务包、checkpoint、消息、状态事件和脱敏工具审计。

## TUI 用户控制面板

七个全屏页面分别是：概览、会话、消息、差异、扩展、设置和日志。

![LocalTerminal Lite 概览](docs/assets/tui/overview-zh-CN.svg)

- 鼠标滚轮和键盘滚动由 OpenTUI 原生 ScrollBox viewport 处理。
- 拖动框选由 renderer 管理，通过 OSC 52 和系统剪贴板复制。
- Continuation 保留在一个逻辑 session 卡片内；委派子项像目录一样缩进，并保留 phase/presence 颜色。
- Enter 可打开完整 session 历史或双向消息对话。
- Diff 展示 staged、unstaged 和 untracked 工作区变化。
- Logs 可以显示所有 session 的脱敏事实工具调用。
- 所有设置和凭据轮换都在 TUI 内完成。

输入优先级固定为：模态框 → 当前表单控件 → 当前页面 → 全局快捷键。OpenTUI 负责 alternate screen 生命周期、鼠标解析、布局、换行、增量绘制和终端恢复。

## 安全与隐私

Lite 以本地运行为主，没有项目遥测。所选工作区是真实的读写安全边界：请使用专用项目，检查 Diff 和 Logs，保持凭据隐藏，并在不需要公网访问时停止隧道。

- 连接凭据保存在操作系统用户配置目录；
- 只持久化 session token 的哈希；
- 审计参数会清除 identity、authorization、claim code、消息正文和 content；
- 只有 TUI 用户能够永久删除 session 与历史。

请阅读[隐私说明与部署模板](docs/PRIVACY.zh-CN.md)。发布带 Actions 的公开 GPT 时，隐私政策必须准确覆盖发布者自己的 endpoint 和数据流。

漏洞请按照 [SECURITY.md](SECURITY.md) 的私密流程报告，不要在包含凭据或私有源码的公开 Issue 中提交。

## 文档地图

| 文档 | 中文 | English |
| --- | --- | --- |
| GPT Actions 完整配置 | [打开](docs/ACTIONS_SETUP.zh-CN.md) | [Open](docs/ACTIONS_SETUP.md) |
| 推荐 GPT 预设指令 | [打开](docs/GPT_INSTRUCTIONS.zh-CN.md) | [Open](docs/GPT_INSTRUCTIONS.md) |
| 特定场景短提示词 | [打开](docs/PROMPT_PLAYBOOK.zh-CN.md) | [Open](docs/PROMPT_PLAYBOOK.md) |
| 隐私与部署模板 | [打开](docs/PRIVACY.zh-CN.md) | [Open](docs/PRIVACY.md) |

## 开发与验证

要求 Bun 1.3 或以上版本。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run dev
```

测试覆盖 OpenAPI 3.1、Actions/Apps 身份、控制权接管、固定 checkpoint 计时、父子完成审计、事件 ACK、订阅、永久历史、脱敏、迁移、删除、continuation、OpenTUI 滚轮和拖动框选。

首次 TUI 配置完成后，可以无界面运行：

```bash
bun run build
bun run start -- --headless
```

## 开源协议

项目使用 [Apache License 2.0](LICENSE)，允许个人和商业使用、修改及再分发，并提供明确的专利授权。第三方依赖保留各自协议。

LocalTerminal Lite 是独立开源项目，与 OpenAI 或 Cloudflare 没有关联，也未获得其背书。ChatGPT、OpenAI 和 Cloudflare 名称仅用于说明互操作性。
