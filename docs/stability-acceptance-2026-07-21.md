# LocalTerminal Lite 稳定性修复验收报告

> 本文保留上一阶段稳定性修复的验收快照。后续统一审计、性能优化、候选资产和虚拟机安装结果以 [v1.1.1 上线前验收记录](pre-release-acceptance-2026-07-21.md) 为准。

日期：2026-07-21
状态：本地修复完成，等待用户验收；未提交、未推送、未发布。

## 本轮结论

本轮不是通过隐藏日志或限制 UI 展示来掩盖故障，而是修复了产生卡死、重复探测、错误状态和错误契约的底层路径。

已处理用户报告的四个问题：

1. 大型仓库进入 Git Diff 页面导致进程卡死。
2. 控制通道在 Cloudflare 502 时重复探测和重复报错。
3. 健康轮询持续写入 `Control channel connected.`。
4. 按住 `v` 时凭据短暂隐藏后再次显示。

审查过程中额外修复：

- 共享端口的每个 Workspace 都启动独立控制通道监控器。
- 公共控制健康检查只验证任意 HTTP 2xx，未验证响应类型、产品或目标 Workspace 路由。
- 控制通道响应体读取无上限。
- 控制通道日志可能被错误归类为 `CONFIG`。
- 关闭流程中的 `shutting_down` 状态会被监控停止回调覆盖回 `active`。
- Resume 恢复会把仍在执行的长时 Action 错误标记为已清理。
- 任意业务结果中的 `{ timedOut: true }` 都会被误判为命令超时。
- GPTs Actions 的 OpenAPI 未显式暴露 `input.workspaceId`，导致多 Workspace 场景无法按 discover 结果注册 root。
- 更新事务缺少跨进程锁、安装超时、实际安装版本验证和程序 `current` 指针回滚。
- 更新锁一度可能被纳入更新快照；现已明确排除。
- 审计脱敏未覆盖 `connectorKey`、`secret`、`password`、`apiKey` 等字段。
- 原验收文档对 backend state sync、pending action 清理和程序回滚能力存在超出实现的表述，现已更正。

## 关键修复

### 1. Git Diff 卡死

`WorkspaceDiffTracker` 现在对不同资源分别设置硬预算：

- Git 输出字符数
- 最终渲染行数
- 未跟踪文件枚举输出
- 未跟踪文件数量
- 单文件采样大小
- Git 命令执行时间
- 未跟踪文件采样总时间

达到预算时会终止 Git 子进程，必要时升级为 `SIGKILL`，不会只停止接收输出而让 Git 在后台继续遍历。

默认最终渲染最多 2000 行；未跟踪普通文件只读取有界样本；未跟踪目录在 Git 源查询阶段折叠为单条目录记录，不递归展开虚拟环境或依赖树；停止 tracker 会中止正在执行的采集。自动刷新间隔由 2 秒调整为 10 秒，并且内容未变化时不更新渲染 revision，避免整棵 TUI 重绘。

TUI 会明确显示触发了哪一种源级预算，不把截断伪装成完整结果。

### 2. 控制通道重复错误和重复 connected

控制通道状态机不再在每次健康轮询中执行 `connected → checking → connected`。仅时间戳变化不会触发状态事件，因此稳定连接不会重复写入 connected 日志。

共享端口模式下，只有实际持有公共端口的 leader 启动外部控制通道监控器；成员 Workspace 不再重复探测同一个公共地址。leader 迁移后，新 leader 会接管监控。

同一次故障期间：

- 记录首次断线原因；
- 后续重试仍真实执行并更新 attempt/backoff 状态；
- 不反复写入相同错误正文；
- 仅记录一次 reconnecting；
- 恢复后记录一次 reconnected 并执行本地 runtime revalidation。

这不是 UI 去重：底层只保留一个监控所有者，状态机也不再产生虚假的重复 connected 事件。

### 3. 控制健康检查真实性

公共探测请求携带目标 `workspaceId`。cluster gateway 会确认该 Workspace 已注册，并反向请求该成员的内部 `/health`；目标 Workspace 不存在、内部不可达或处于 degraded/shutdown 时返回 503。

探测响应要求：

- 有界读取，最多 8192 字节；
- 有效 JSON；
- `ok: true`；
- `product: localterminal-lite`；
- 响应确认目标 Workspace。

任意 2xx HTML、错误产品、错误 Workspace 或损坏 JSON 不再被视为 connected。

### 4. 按住 v 的凭据闪烁

终端协议可能在连续 `v` repeat 之间发送空名称 release 包。旧逻辑把任意 release 立即当作隐藏，再由下一次 repeat 重新显示，因此发生闪烁。

现逻辑由 `v` press/repeat 延长 450ms 的短截止时间；不可靠 release 包不再立即清零。停止重复输入后，截止时间仍会自动隐藏凭据；切换页面、打开表单或离开允许页面仍立即隐藏。

### 5. GPTs Actions 多 Workspace 启动契约

OpenAPI 的 `ExtensionToolInput` 现在显式声明 `workspaceId`，root 注册示例也包含 discover 返回的 Workspace ID。

自动化测试已通过真实共享端口 HTTP 路径完成：

1. 获取 `/openapi.json`；
2. 调用 `/actions/extensions/discover`；
3. 从返回结果选择第二个 Workspace；
4. 调用 `/actions/extensions/call`；
5. 使用 `session_register` 和显式 `workspaceId` 成功创建 root。

### 6. Runtime lifecycle 和 Action 审计

关闭流程最终持久化为 `stopped`，不再被控制监控器覆盖为 `active`。

Resume 恢复不再清理仍在内存中执行的 Action。只有具备真实命令结果结构的 `timedOut` 才会记录 `ACTION_TIMEOUT`；业务对象中的同名字段不会被误判。

审计参数与错误信息增加 `connectorKey`、`secret`、`password`、`apiKey` 和 URL 查询参数等脱敏规则。

### 7. 更新事务

更新流程新增：

- 跨进程 `update.lock`；
- 死进程遗留锁回收；
- 安装器总超时；Unix 使用独立进程组终止完整脚本树，Windows 使用 `taskkill /T`；
- `current` 指向版本验证；
- 安装二进制存在性验证；
- 实际执行 `localterminal-lite --version` 验证；
- 失败后恢复配置数据；
- 若旧 release 仍存在，原子恢复旧 `current` 指针；
- 备份裁剪失败不覆盖主事务结果；
- `update.lock` 不进入更新快照。

本轮没有下载或执行真实发布包；真实安装验证逻辑由注入式故障测试和本地版本目录模拟覆盖。

## 本地验证结果

- `bun run typecheck`：通过
- `bun run build`：通过
- `bun test --timeout 120000 test/lite.test.mjs`：58 pass / 0 fail
- `node --test test/cli-regression.test.mjs test/docs.test.mjs test/stability-regression.test.mjs`：17 pass / 0 fail
- 总计：75 pass / 0 fail
- `git diff --check`：通过
- `bun audit`：No vulnerabilities found
- 常见私钥、OpenAI key、GitHub token 模式扫描：未在当前 diff 中发现匹配

新增门禁覆盖：

- 大型 tracked diff 的行数硬预算和进程终止；
- 未变化 diff 不增加渲染 revision；
- 多次健康轮询只产生一次 connected；
- 502/1033/timeout/backend unavailable 分类与恢复；
- 共享端口只有一个控制监控器；
- 公开 Actions schema 的 discover → workspace register 端到端流程；
- 业务 `timedOut` 字段不被误判；
- 关闭后 lifecycle 为 stopped；
- 更新并发锁及新建锁文件写入竞态；
- 失败更新恢复旧程序 current 指针；旧 release 缺失时明确记录 partial failure；
- 更新数据、凭据和 Workspace root 隔离。

## 未覆盖和验收要求

以下内容不能由本地自动化替代：

1. 已使用当前构建直接对真实 CosyVoice 工作区执行 Diff tracker：24ms 完成、172 行、约 37MB RSS、无残留 Git 进程；`.venv` 等未跟踪目录被明确折叠。尚未由用户在实际 TUI 中进行视觉与交互验收。
2. 尚未执行真实 macOS 睡眠/唤醒；自动化覆盖时间跳变、Workspace 退化与恢复、显式 revalidation。
3. 尚未使用真实 Cloudflare Tunnel 制造 502/1033；自动化覆盖响应分类、退避、单监控所有权、目标 Workspace 健康校验和恢复。
4. 尚未下载或安装真实发布包。
5. 当前 diff 未提交、未推送，因此没有属于当前修改的 Windows/Linux/macOS CI 结果。

## 发布状态

- 未创建 Release
- 未创建 tag
- 未执行发布
- 未提交或推送当前修改
