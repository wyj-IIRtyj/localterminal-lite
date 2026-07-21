# LocalTerminal Lite v1.1.1 上线前验收记录

日期：2026-07-21
状态：这是发布前验收快照。本地候选版本已完成代码、性能、资产和虚拟机验收；项目所有者随后已授权在最终文档与门禁通过后发布 v1.1.1。实际发布状态以 GitHub Releases 为准。

## 功能与审计

- Apps Connector 与 Actions API 复用同一调用生命周期和审计结构。
- 模型开始调用时写入同一 action ID 的 `running` 记录，包含来源、工具、开始时间、Workspace、session 和脱敏后的完整参数。
- 返回后更新为 `completed`、`failed` 或 `timeout`，补充完成时间、耗时、错误和脱敏后的完整结果。
- TUI Logs 默认显示调用明细；本地与跨 Workspace 日志按 action ID 合并，不重复显示开始/结束两条逻辑记录。
- 审计写入前处理 token、authorization、claim code、connector key、credential、secret、password、API key、body/content 和敏感 URL 查询参数；运行时回调只接收已脱敏记录。

## 性能结果

- 高频 session touch、消息和事件改为可恢复 JSONL journal，达到 1000 条或 4 MiB 后合并为原子状态快照。
- 5100 条消息持久化回归由约 16 秒降至约 0.7 秒，约 23 倍提升；重启后的 journal replay 与 revision 一致性已覆盖。
- TUI snapshot 按 runtime revision 复用，空闲轮询和纯交互渲染不再重复深拷贝全部状态和 Diff。
- Diff revision 使用有界元数据，不再为了空闲刷新克隆最多 2000 行内容。
- Session continuation/child 分组使用 origin cache 和 parent index；10000 个 session 的合成基准由约 468ms 降至约 7ms，约 65 倍提升。
- 100000 条消息的 conversation 分组基准约 17ms。

## 发布资产

本地 `release/` 已生成并校验以下候选包及相邻 SHA-256 文件：

- `localterminal-lite-darwin-arm64.tar.gz`
- `localterminal-lite-darwin-x64.tar.gz`
- `localterminal-lite-linux-arm64.tar.gz`
- `localterminal-lite-linux-x64.tar.gz`
- `localterminal-lite-windows-x64.zip`

压缩包包含编译程序；两个 macOS 包同时包含 `mac-one-shot-awake-lock.swift`。三个 x64 目标显式使用 Bun baseline runtime，降低旧 CPU 的 AVX 依赖。`release/` 已加入 `.gitignore`，避免本地候选资产被误提交。

## 原生安装与启动

### macOS ARM64 宿主机

- 使用当前候选 tar.gz、SHA-256 和 `scripts/install-macos.sh` 安装到隔离目录。
- `--verify-installation` 返回 macOS helper 路径，`--version` 返回 `1.1.1`。
- 使用隔离配置启动 `--headless`，`/health` 返回 `product=localterminal-lite`、`version=1.1.1`，随后正常终止运行时。
- Intel baseline 包在 Rosetta 下从完整压缩包执行资源自检和版本检查通过。

### Ubuntu 24.04.3 ARM64（Parallels）

- 使用当前 Linux ARM64 候选包和真实 `scripts/install-linux.sh` 安装。
- 安装后资源自检与版本检查通过。
- 实际启动 headless runtime，`127.0.0.1:43210/health` 返回正确产品、版本和 Workspace 成员，然后正常终止运行时。

### Windows 11 ARM64 + x64 兼容层（Parallels）

- 使用 Windows x64 baseline zip、SHA-256 和真实 `scripts/install-windows.ps1` 安装。
- VM 实测发现 Defender/安全扫描可能短暂干扰刚解压或刚复制的 109 MiB 可执行文件；安装器现对候选文件和安装后文件分别进行最多 10 次有界校验，校验成功前不会更新 `current`。
- `.cmd` launcher、资源自检和 `--version` 均通过。
- 实际启动 x64 headless runtime，`127.0.0.1:43211/health` 返回正确产品、版本和 Workspace 成员，然后正常终止运行时。

Linux x64 的真实 runner 验证仍由 tag 前 GitHub Actions `ubuntu-24.04` 门禁负责；本机 Docker daemon 未运行，因此本轮没有把容器模拟冒充为真实验证。

## 自动化门禁

- `bun run build`：通过
- `bun test --timeout 120000 test/*.test.mjs`：76 pass / 0 fail（候选资产、baseline target 和 Windows 重试修改后的最终回归）
- `git diff --check`：通过
- 发布 workflow 固定 Bun `1.3.14`，对五个平台显式声明编译 target，并在 runner 中执行类型检查、完整测试、二进制 smoke test、打包、校验和和真实安装器测试。

## 发布交接

- 本记录生成时尚未 commit、push、创建 tag、GitHub Release 或上传资产。
- 项目所有者已授权在最终文档一致性检查和发布门禁通过后发布 v1.1.1。
- 手动安装与本地候选包验证见 `docs/MANUAL_INSTALL.md`；当前公开发布状态以 GitHub Releases 为准。
