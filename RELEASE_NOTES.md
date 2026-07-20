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
