# LocalTerminal Lite v1.1.1

LocalTerminal Lite v1.1.1 is a stability, auditability, performance, and binary-installation release. It is the first public stable release after v1.0.1 to distribute verified standalone executables for macOS, Linux, and Windows, while preserving existing user configuration, workspace state, sessions, messages, history, and credentials.

## Highlights

- Multi-workspace processes can safely share one public port with explicit leader/member routing and automatic failover.
- Workspace selection is consistent across first-run setup, startup, and Settings, and now includes an explicit **Add a new workspace** action.
- Cluster membership is self-healing. A deleted registry is rebuilt from the live member record; malformed registries are reported as degraded instead of being misrepresented as an empty cluster.
- A single process on a port is shown as normal **single-workspace mode**. Shared-port process counts are based on persisted live members rather than UI fallback values.
- Non-Git workspaces are supported. The Diff view safely disables itself when Git is unavailable or the directory is not a repository.
- Diff processing is bounded: Git subprocesses have deadlines and output caps, and large or binary untracked files are sampled rather than loaded completely into memory.
- Apps and Actions now share one operation lifecycle. Logs show source, tool, sanitized complete arguments, start time, live `running` state, sanitized complete result, duration, and the final `completed`, `failed`, or `timeout` state in one logical record.
- High-frequency session activity and durable messages use a crash-recoverable incremental journal with periodic atomic snapshots. A 5,100-message persistence regression dropped from about 16 seconds to under 0.7 seconds in the local benchmark.
- TUI snapshots are revision-cached, so idle polling and interaction-only renders no longer deep-clone the full session/message state and Diff payload.
- Session and conversation grouping now use linear indexing before their final sorts. A synthetic 10,000-session continuation/child model dropped from about 468 ms to about 7 ms locally; grouping 100,000 messages took about 17 ms.
- Credential reveal is fail-closed without flicker: `V` press/repeat extends a 450ms deadline, while navigation, forms, or leaving an eligible screen hide credentials immediately. Unreliable unnamed release packets no longer briefly hide and re-show credentials between repeats.
- The macOS passive-lock helper remains active until the last LocalTerminal process exits.
- Workspace runtime leases are atomically published and released, including repeated A → B → C workspace switching.
- Architecture boundaries, ownership rules, coupling risks, and follow-up refactoring targets are documented.

## Binary release assets

The release publishes standalone executables and SHA-256 files for:

- macOS Apple Silicon (`darwin-arm64`)
- macOS Intel (`darwin-x64`)
- Linux ARM64 (`linux-arm64`)
- Linux x64 (`linux-x64`)
- Windows x64 (`windows-x64`)

The installers download only the matching platform asset. Git, Node.js, Bun, dependency installation, and a source checkout are no longer required for release installations.
The three x64 executables use Bun's baseline targets for compatibility with older CPUs that do not provide AVX. Windows verifies both the freshly expanded candidate and the installed copy with bounded retries before publishing the active-version pointer.

## One-command, lossless update

### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.1/scripts/install-macos.sh)"
```

### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.1/scripts/install-linux.sh)"
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.1/scripts/install-windows.ps1 | iex"
```

The same commands cover:

- the GitHub `v1.0.1` source-archive installation;
- intermediate development installations created during the v1.1.1 development cycle;
- an existing versioned binary installation;
- a clean first installation.

The migration recognizes the old source layout, moves it to a recovery backup under the user configuration directory, installs the platform binary into `releases/v1.1.1`, and atomically updates the `current` pointer. A failed migration restores the original installation; successful legacy backups are retained with bounded pruning. User configuration and workspace/session state live outside the program directory and are never deleted by the installer.

Git source checkouts are intentionally not overwritten. Continue updating a checkout with Git, or install the release binary into another `LOCALTERMINAL_LITE_HOME`.

## Updating after v1.1.1

LocalTerminal Lite checks GitHub Releases at startup. When Settings reports an available version, press `U` to run the matching platform installer. The updater downloads the new binary and checksum, installs it beside the old release, and atomically switches the `current` pointer. The active release and one rollback release are retained.

Installing an update does not replace code already loaded in running processes. In a shared-port group, restart member processes one at a time and restart the current leader last.

## Compatibility notes

- The current cluster protocol remains version `1`, allowing rolling restart between compatible v1.x members.
- Existing Apps and Actions credentials are preserved.
- Existing workspace registry, session state, message history, extension definitions, logs, and TUI settings are preserved.
- Users who changed the installation root should run the installer with the same `LOCALTERMINAL_LITE_HOME` value. The in-app updater carries the detected installation root automatically.

## Verification

This release passed type checking, production build, the complete automated test suite, dependency audit, standalone executable smoke tests, installer migration tests, and host/VM validation on macOS, Windows, and Linux ARM64. The release workflow repeats the complete suite and packaged-installer checks on all five native build runners before publishing assets.


## 中文说明

LocalTerminal Lite v1.1.1 是 v1.0.1 之后首个公开提供预编译二进制的稳定版本。macOS、Linux 和 Windows 安装器会下载对应平台的独立可执行文件并校验 SHA-256，不再要求用户预先安装 Git、Node.js 或 Bun。

本版本重点包括：

- 多工作区进程可共享同一个公开端口，并支持 leader/member 路由和自动故障转移。
- 集群注册表可根据存活成员记录真实自愈；损坏状态会明确进入降级，而不会伪装成空集群。
- Settings、首次启动和工作区选择器统一支持新增工作区。
- 外置卷暂时卸载、系统休眠恢复和目录权限暂时不可用时，运行时进入重新验证或降级状态，不会覆盖凭据，也不会卡死整个 TUI。
- 顶层渲染错误、异步错误和进程级异常均会记录日志并执行一次性安全关闭。
- 凭据只会在 `V` 按键重复维持的 450ms 截止时间内短暂显示；停止重复后自动隐藏，切换页面或打开表单会立即隐藏，不可靠的空名称 release 包不会再造成闪烁。
- macOS 被动锁屏 helper 已随二进制发行包一起安装，不再依赖 `$bunfs` 中不可访问的源码路径。
- 安装下载支持中断后续传；不完整安装目录可以在再次运行安装器时恢复。
- Apps 与 Actions 使用同一套调用生命周期；Logs 会在一条逻辑记录中显示来源、工具、脱敏后的完整参数与返回、开始时间、实时状态和耗时。
- 高频 session 活动和消息持久化改为可崩溃恢复的增量 journal 与周期性原子快照；本机 5100 条消息回归由约 16 秒降至 0.7 秒以内。
- TUI 快照按 revision 复用，空闲轮询和纯交互渲染不再深拷贝全部 session、消息和 Diff 数据。
- Session/会话分组改为线性索引后再排序；本机 10000 个 session 的合成长链场景由约 468ms 降至约 7ms，100000 条消息分组约 17ms。
- 三个 x64 资产使用 Bun baseline 目标，兼容不支持 AVX 的较旧 CPU；Windows 安装器会在切换当前版本前分别验证解压候选程序和安装后的程序副本，并对安全软件造成的瞬态启动干扰进行有界重试。
- 旧版源码安装、开发中间版本和已有二进制安装会在保留配置、工作区注册表、session、消息、历史、扩展、日志和凭据的前提下迁移。

本地门禁已完成类型检查、生产构建、完整测试、依赖审计以及 macOS 宿主机、Ubuntu ARM64 和 Windows 11 的安装启动验证。发布 workflow 还会在五个平台的真实 runner 上重新执行完整测试、独立二进制构建、安装包解析、部分下载续传、不完整安装恢复、安装后资源诊断、版本输出和校验文件验证，全部通过后才发布资产。
