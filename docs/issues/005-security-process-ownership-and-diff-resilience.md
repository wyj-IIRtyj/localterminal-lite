# Issue 005: Credential exposure, process ownership, passive-lock lifecycle, and Diff resilience

## Status

Resolved in the next release candidate.

## Severity

Critical release blocker.

## Defects and root causes

1. Credential reveal handled key-name filtering before release events. Some terminal release packets therefore failed to hide credentials.
2. The header displayed a static running label and exposed no shared-port member count or leader/member role.
3. The installation-global passive-lock helper was stopped by every workspace runtime during close rather than only by the last live LocalTerminal process.
4. Diff loaded complete untracked files before applying a display limit. Large binaries could exhaust memory or stall the TUI. Git subprocesses also lacked a hard deadline.

## Resolution

- Added a fail-closed credential visibility state machine. Every release packet hides credentials regardless of key name; navigation and ineligible contexts also clear visibility.
- Added runtime process topology and exposed shared port, member count, current role, and PID in the header.
- Added global live-process enumeration. A runtime releases its own lease first and stops passive lock only when no other live LocalTerminal PID remains.
- Added bounded Git subprocess execution, output caps, `--no-textconv`, canonical path containment, stat-before-read, and bounded file sampling. Binary and oversized files are represented without whole-file reads.
- Extracted TUI contracts to remove controller/presenter import cycles.

## Regression coverage

- Empty/unknown key-name release packets hide credentials.
- Two shared-port runtimes report one leader, one member, and member count two.
- Passive lock remains alive while another runtime lease exists; existing coverage verifies the final process stops it.
- A sparse 256 MiB `bun.exe` is sampled and classified as binary in under five seconds, then deleted.
- Full import-graph review verifies no known TUI contract cycles.
