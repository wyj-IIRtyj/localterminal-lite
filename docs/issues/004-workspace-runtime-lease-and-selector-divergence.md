# Issue 004: Workspace runtime leases and selector rendering diverge after repeated switching

## Status

Resolved in v1.1.1.

## Severity

Critical release blocker. Repeated workspace switching corrupts the user-visible runtime state and causes startup and Settings selectors to disagree about identity, status, and availability.

## User-visible symptoms

- Workspaces previously visited by the same process remain marked as running.
- A later LocalTerminal process can see several unrelated workspaces as active under the same PID and port.
- Startup selection and Settings selection render different card content for the same registry records.
- The current workspace can be indistinguishable from a stale runtime record.

## Root causes

### Runtime lease lifecycle was incomplete

The registry mixed durable workspace catalog data with a transient runtime lease (`lastPid`, `lastHost`, and `lastPort`). Runtime startup published the lease only on the clustered path, and runtime shutdown never released it. Reconfiguring A → B → C therefore left the same PID attached to every previously selected workspace.

The standalone `port: 0` path returned before publishing its actual bound port, so its registry state was incomplete even before switching.

### Selector construction was only partially shared

Callers shared low-level status helpers but still assembled the final TUI question independently. This allowed labels, descriptions, badges, fallback selection, and disabled states to diverge despite using some common functions.

## Resolution

- `LiteRuntime.start()` now publishes a runtime lease on every startup path, using the actual bound port.
- `LiteRuntime.close()` releases only the lease belonging to its workspace and PID.
- Registry mutations use the existing cross-process lock and atomic replacement path.
- A shared `buildWorkspaceSelectorModel()` now produces the complete selector view model and `FormQuestion` for Setup, startup selection, and Settings.
- All selectors therefore use the same workspace title, full path, status badge, selected index, and disabled state.

## Regression coverage

An integration test performs A → B → C → A using real `LiteRuntime` instances and asserts after each transition that:

- exactly one workspace owns the current PID while running;
- the lease belongs to the selected workspace;
- the registry stores the actual bound port;
- closing releases the lease;
- after the sequence no stale PID remains.

The same test builds startup and Settings selectors from the resulting registry and verifies identical titles and descriptions (`A`, `B`, `C` plus their full paths), while allowing only the intentionally different current-process status.

## Release requirement

Satisfied for v1.1.1: type checking, build, the complete automated test suite, repeated-switch integration coverage, and duplicate selector-construction review pass.
