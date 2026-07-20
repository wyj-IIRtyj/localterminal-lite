# LocalTerminal Lite v1.1.0

LocalTerminal Lite v1.1.0 is the first binary-distributed release. It replaces source-archive installation with verified standalone executables for macOS, Linux, and Windows while preserving existing user configuration, workspace state, sessions, messages, history, and credentials.

## Highlights

- Multi-workspace processes can safely share one public port with explicit leader/member routing and automatic failover.
- Workspace selection is consistent across first-run setup, startup, and Settings, and now includes an explicit **Add a new workspace** action.
- Cluster membership is self-healing. A deleted registry is rebuilt from the live member record; malformed registries are reported as degraded instead of being misrepresented as an empty cluster.
- A single process on a port is shown as normal **single-workspace mode**. Shared-port process counts are based on persisted live members rather than UI fallback values.
- Non-Git workspaces are supported. The Diff view safely disables itself when Git is unavailable or the directory is not a repository.
- Diff processing is bounded: Git subprocesses have deadlines and output caps, and large or binary untracked files are sampled rather than loaded completely into memory.
- Credential reveal is fail-closed: releasing `V`, changing tabs, opening a form, or leaving an eligible screen immediately hides credentials.
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

## One-command, lossless update

### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.0/scripts/install-macos.sh)"
```

### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.0/scripts/install-linux.sh)"
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wyj-IIRtyj/localterminal-lite/v1.1.0/scripts/install-windows.ps1 | iex"
```

The same commands cover:

- the GitHub `v1.0.1` source-archive installation;
- intermediate development installations created during the v1.1.0 development cycle;
- an existing versioned binary installation;
- a clean first installation.

The migration recognizes the old source layout, temporarily backs it up, installs the platform binary into `releases/v1.1.0`, atomically updates the `current` pointer, and removes the backup only after success. A failed migration restores the original installation. User configuration and workspace/session state live outside the program directory and are never deleted by the installer.

Git source checkouts are intentionally not overwritten. Continue updating a checkout with Git, or install the release binary into another `LOCALTERMINAL_LITE_HOME`.

## Updating after v1.1.0

LocalTerminal Lite checks GitHub Releases at startup. When Settings reports an available version, press `U` to run the matching platform installer. The updater downloads the new binary and checksum, installs it beside the old release, and atomically switches the `current` pointer. The active release and one rollback release are retained.

Installing an update does not replace code already loaded in running processes. In a shared-port group, restart member processes one at a time and restart the current leader last.

## Compatibility notes

- The current cluster protocol remains version `1`, allowing rolling restart between compatible v1.x members.
- Existing Apps and Actions credentials are preserved.
- Existing workspace registry, session state, message history, extension definitions, logs, and TUI settings are preserved.
- Users who changed the installation root should run the installer with the same `LOCALTERMINAL_LITE_HOME` value. The in-app updater carries the detected installation root automatically.

## Verification

Before tagging this release, the project requires type checking, production build, the complete automated test suite, dependency audit, standalone executable smoke tests, installer migration tests, and native validation on macOS, Windows, and Linux.


## 中文说明

LocalTerminal Lite v1.1.0 是首个采用预编译二进制分发的版本。macOS、Linux 和 Windows 安装器会下载对应平台的独立可执行文件并校验 SHA-256，不再要求用户预先安装 Git、Node.js 或 Bun。

本版本重点包括：

- 多工作区进程可共享同一个公开端口，并支持 leader/member 路由和自动故障转移。
- 集群注册表可根据存活成员记录真实自愈；损坏状态会明确进入降级，而不会伪装成空集群。
- Settings、首次启动和工作区选择器统一支持新增工作区。
- 外置卷暂时卸载、系统休眠恢复和目录权限暂时不可用时，运行时进入重新验证或降级状态，不会覆盖凭据，也不会卡死整个 TUI。
- 顶层渲染错误、异步错误和进程级异常均会记录日志并执行一次性安全关闭。
- 凭据只会在按住 `V` 时短暂显示；松开按键、切换页面、打开表单或终端未提供可靠 key-up 事件时都会自动隐藏。
- macOS 被动锁屏 helper 已随二进制发行包一起安装，不再依赖 `$bunfs` 中不可访问的源码路径。
- 安装下载支持中断后续传；不完整安装目录可以在再次运行安装器时恢复。
- 旧版源码安装、开发中间版本和已有二进制安装会在保留配置、工作区注册表、session、消息、历史、扩展、日志和凭据的前提下迁移。

发布门禁要求五个平台在真实 runner 上完成类型检查、生产构建、完整测试、独立二进制构建、安装包解析、部分下载续传、不完整安装恢复、安装后资源诊断、版本输出和校验文件验证。macOS、Ubuntu ARM64 与 Windows 11 还需在本机 Parallels 虚拟机或宿主机上完成安装命令验证。
