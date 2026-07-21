# Issue 001: Workspace state desynchronization during cluster leader shutdown

## Status

Resolved in v1.1.1.

## Severity

High. The defect can temporarily make an available LocalTerminal Lite installation report that no workspace is registered, interrupting authenticated development sessions and producing misleading `WORKSPACE_UNAVAILABLE` or `NOT_FOUND` responses.

## Symptoms

During a cluster leader shutdown or restart, Actions calls can receive:

- `WORKSPACE_UNAVAILABLE: No LocalTerminal Lite workspace is registered on this port.`
- Follow-up session calls can report `NOT_FOUND: No workspace owns this session.`

The workspace and its persisted session state still exist; the public gateway and cluster registry disagree briefly about availability.

## Root cause

`LiteRuntime.close()` removed the leader from the shared cluster registry before closing the public HTTP gateway. During that ordering window, the gateway continued accepting traffic while its router observed an empty or incomplete member list. The response therefore represented an internal shutdown race rather than the actual workspace state.

## Resolution

Shutdown ordering now follows the externally visible lifecycle:

1. Stop heartbeat and election timers.
2. Stop accepting public traffic.
3. Remove the member from the cluster registry.
4. Close MCP transports and the internal server.

This prevents a live public endpoint from advertising an already-unregistered workspace state.

## Regression coverage

The shared-port failover integration test now asserts that the leader is no longer accepting public traffic at the exact point its cluster registration is removed. Existing coverage also verifies that a follower takes over the public port and that sessions owned by a surviving workspace remain routable after leader exit.

## Release requirement

Satisfied for v1.1.1: type checking, build, the complete automated test suite, and shared-port failover testing pass.
