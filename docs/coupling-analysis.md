# Coupling Analysis and Improvement Plan

## Method

The source import graph was calculated across all `src/**/*.ts` and `src/**/*.tsx` files. The review also considered file size, lifecycle ownership, shared mutable state, subprocess boundaries, and whether presentation layers rebuild domain state.

## Current graph findings

Before this review the graph contained two cycles:

```text
tui/state -> tui/workspace-selector -> tui/form-model -> tui/state
tui/state -> tui/workspace-selector -> tui/state
```

The cause was that `FormQuestion`, navigation types, and reconfiguration contracts were declared in the large controller module. Pure form and selector modules therefore depended on orchestration, while orchestration depended back on them.

These contracts now live in `tui/contracts.ts`. `form-model` and `workspace-selector` depend only on the contract module, removing the known cycles.

Highest fan-in modules during the review:

| Module | Importers | Interpretation |
|---|---:|---|
| `types.ts` | 26 | Expected shared domain schema; keep dependency-free |
| `tui/state.ts` | 19 | Excessive presentation/orchestration coupling |
| `server.ts` | 11 | Runtime facade used by UI and tests |
| `instances.ts` | 10 | Catalog and process-lease service |
| `tui/screens/shared.tsx` | 7 | Expected shared rendering primitives |

Highest fan-out modules:

| Module | Direct internal dependencies | Risk |
|---|---:|---|
| `tui/App.tsx` | 16 | Composition root; acceptable, but no domain logic should be added |
| `server.ts` | 16 | Runtime composition plus lifecycle; beyond extraction threshold |
| `tui/state.ts` | 13 | God-controller risk |
| `tui/index.tsx` | 10 | Renderer/bootstrap composition |
| `tui/Setup.tsx` | 7 | Setup currently knows configuration and selector details |

## Defects caused by coupling

### UI reconstructed runtime state

Setup, startup selection, Settings, and Header independently interpreted process/workspace state. This produced inconsistent names, paths, status, disabled options, port values, and leader visibility.

Mitigation implemented:

- `workspace-selection.ts`: domain classification
- `tui/workspace-selector.ts`: complete selector presenter
- `runtime-settings.ts`: effective runtime configuration
- `LiteRuntime.processTopology()`: process/cluster status

### Resource ownership crossed scopes

The passive-lock helper is global, but `LiteRuntime.close()` treated it as runtime-owned. Workspace process leases were persistent records without a release lifecycle. Session helpers, workspace runtimes, cluster members, and global helpers were controlled from the same shutdown method without explicit ownership documentation.

Mitigation implemented:

- workspace lease publish/release lifecycle
- global active-process enumeration
- last-process-only passive-lock shutdown
- ownership rules documented in `architecture.md`

### Optional Git capability ran in the main UI lifecycle

Diff combined subprocess execution, repository capability detection, untracked-file enumeration, binary detection, file loading, formatting, scheduling, and UI snapshot state. An unbounded `readFile()` made a single workspace file capable of destabilizing the whole TUI.

Mitigation implemented:

- bounded file sampling
- subprocess timeout and output cap
- binary and oversized-file degradation
- realpath boundary checks
- non-Git capability state

## Remaining architectural debt

### `store.ts` is oversized

At roughly 850 lines it owns session lifecycle, controller credentials, app bindings, messages, events, subscriptions, checkpoints, temporal transitions, journal/snapshot persistence, history, and audit redaction.

Recommended extraction sequence:

1. `SessionRepository`: state loading, atomic persistence, lookups.
2. `ControllerService`: claim, release, revoke, stale recovery.
3. `MessageEventService`: messages, subscriptions, event ACK.
4. `CheckpointPolicy`: completion rules, reminders, stale transitions.
5. `AuditHistoryWriter`: immutable history and redaction.

Keep `LiteStore` as a compatibility facade until callers migrate.

### `tui/state.ts` is a god controller

It coordinates update installation, sessions, messaging, extensions, settings, notifications, clipboard, passive lock, and runtime replacement.

Recommended extraction sequence:

- `SessionCommands`
- `MessageCommands`
- `ExtensionCommands`
- `SettingsCommands`
- `UpdateCommands`

Each command service should depend on narrow interfaces instead of `LiteRuntime` directly. `TuiController` should expose snapshots and delegate use cases.

### `server.ts` mixes runtime lifecycle and HTTP composition

It currently owns process startup, cluster membership, election, public/internal servers, route registration, passive lock startup, lease publication, and logging.

Recommended extraction sequence:

- `RuntimeLifecycle`: start/close and cleanup ordering
- `ClusterNode`: registration, heartbeat, election, topology
- `HttpEndpoints`: local routes and public gateway construction
- `RuntimeLease`: workspace lease publication/release

Do not split until integration tests cover leader failover, repeated reconfiguration, and last-process shutdown; those tests now exist for the highest-risk paths.

### Persistent catalog and transient leases share one schema

`workspaces.json` currently combines durable catalog metadata with runtime lease fields. The lifecycle is now correct, but schema separation would reduce stale-state risk.

Recommended next schema:

```text
workspaces.json       durable id/path/label/stateDir/lastSeen
runtime-leases.json   pid/memberId/workspaceId/host/port/heartbeat
```

Migrate atomically and preserve backward reading for one release cycle.

## Enforced design rules

1. Shared UI behavior must expose one complete presenter/view model, not only helper functions.
2. Global resources cannot be stopped from workspace-scoped cleanup without a global liveness check.
3. Every persisted transient field needs publish, refresh, release, stale-reap, and migration semantics.
4. Subprocesses require deadlines, bounded output, and deterministic termination.
5. File inspection requires stat-before-read, bounded reads, realpath containment, and binary handling.
6. Security UI state must fail closed on a bounded repeat deadline, blur/navigation, ineligible context, and component teardown; unreliable release packets must not cause flicker.
7. Composition roots may have high fan-out but must not contain domain decisions.
8. Contract/type modules must not import orchestration modules.

## Completion criteria for future refactors

A refactor is not complete merely because helpers are shared. It must demonstrate:

- no duplicate final model construction;
- no import cycles;
- lifecycle integration tests, not only pure-function tests;
- identical rendered model inputs across equivalent entry points;
- explicit ownership comments for global/process/workspace/session resources;
- complete typecheck, build, tests, diff check, and dependency audit.
