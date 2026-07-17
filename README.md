# LocalTerminal Lite

LocalTerminal Lite 0.4.2 is a single-workspace development bridge with auditable, inheritable work sessions. It provides ChatGPT Apps (MCP), ChatGPT Actions (OpenAPI 3.1), a declarative extension registry, durable multi-session messages, and a full-window bilingual TUI.

The model-visible surface always contains exactly three facade tools:

- `extension_discover`
- `extension_register`
- `extension_call`

Concrete workspace, Git, session, message, and custom tools remain behind that facade.

## Install and run

```bash
git clone https://github.com/wyj-IIRtyj/localterminal-lite.git
cd localterminal-lite
npm install
npm run dev
```

No `.env` file is required. On first launch, the TUI configures language, theme, workspace, bind address, public URL, execution limits, Apps connector key, and Actions token. Press `c` later to change these settings safely.

For a previously configured non-interactive service:

```bash
npm run build
npm run start -- --headless
```

## TUI

The TUI is the owner control plane:

- `1`–`7` or Tab switches Overview, Sessions, Messages, Diff, Extensions, Settings, and Logs.
- Sessions shows one structured tree card per logical session. Continuation records stay inside the card, delegated children are indented like directories under their parent, and colored phase/presence badges remain visible. Enter opens the complete permanent history.
- Messages groups records by participant pair. Enter opens the complete two-way conversation.
- Diff continuously tracks staged, unstaged, and untracked workspace changes with Git-style file, hunk, and `+`/`-` lines.
- Up/Down or the mouse wheel scrolls long content immediately; PageUp/PageDown moves by a screen. Sessions, Messages, and Extensions use `j`/`k` for focused-item selection. Lite uses standard alternate-scroll mode instead of mouse reporting, so normal click-and-drag text selection remains owned by the terminal on macOS and Windows.
- `n` prepares a root session or creates a structured direct child under a selected root.
- `u` opens actions for the focused session. Passive prompt copying never revokes a controller; revoke is always explicit.
- `m` sends an owner-mediated session message.
- `e` / `x` add or remove declarative custom extensions.
- `c` edits all runtime configuration; `v` reveals credentials; `k` rotates connection credentials.
- `a` on Logs toggles sanitized factual tool calls from every session.
- `q` stops Lite.

The main screen uses the terminal alternate buffer, disables normal scrollback, and always renders exactly one terminal window. Each changed frame erases the remainder of every row and the unused screen area; unchanged frames produce no terminal output, preventing stale text and avoiding unnecessary selection disruption. ANSI-aware display-width wrapping preserves colors and wraps Chinese, paths, logs, diffs, summaries, and prompts to the current terminal width instead of discarding their tails. Key hints are contextual, responsive, and highlighted at the bottom instead of listing every application command at once.

Pending delegated sessions appear in a persistent red banner. Lite copies a handoff prompt to the clipboard, rings the terminal every 60 seconds, and sends an OS notification every five minutes until the session is claimed or cancelled. macOS uses native `pbcopy` and notifications; Windows/Linux use best-effort native commands and fall back to visible TUI text.

Only the TUI can permanently delete sessions. Before confirmation it displays the session name, state, objective, checkpoint/final summaries, children, message count, and permanent-history count. Deleting then requires the exact phrase shown by the TUI and cascades only through child sessions. Same-level continuation sessions remain and display a deleted-predecessor marker.

## Session identity

A Lite session is a work context, not a ChatGPT conversation ID. Its identity is:

```json
{
  "sessionId": "ses_...",
  "sessionToken": "returned-only-when-claimed"
}
```

Tokens are returned only when a controller claims a session. Lite persists only their hashes and removes identity and claim fields from audit records.

Unauthenticated callers can only:

1. create and claim a root with `session_register(mode=root)`; or
2. claim delegated/released unfinished work with `session_inherit(sessionId, claimCode)`.

The three commonly confused flows are distinct:

- resume/claim an existing unfinished session: `session_inherit`;
- continue immutable completed work: `session_register(...continuesSessionId)`;
- hand off the current controller: `session_release`, followed by `session_inherit` using the returned one-time claim code.

Unauthenticated `extension_discover` returns only these bootstrap instructions. Every other concrete tool call and every extension registry change requires identity.

Actions must include `identity` on every authenticated facade request. Apps may omit it only after one explicit verified identity call binds the current `openai/session` hint. That hint is never allowed to create, inherit, or independently identify a Lite session.

Root bootstrap example:

```json
{
  "tool": "session_register",
  "input": { "mode": "root", "name": "main", "role": "lead" }
}
```

Authenticated call example:

```json
{
  "tool": "message_send",
  "identity": { "sessionId": "ses_sender", "sessionToken": "..." },
  "input": { "to": "ses_recipient", "body": "Please review this change." }
}
```

## Collaboration lifecycle

Session work phase and controller presence are independent:

- phase: `pending | working | waiting | blocked | completed | cancelled`
- presence: `unclaimed | claimed | stale`

A root can delegate multiple direct children. Children cannot delegate grandchildren. Delegation requires `objective`, `background`, `deliverables`, `acceptanceCriteria`, and `constraints`; the inheriting child also receives a bounded projection of parent summaries and recent audit activity.

After the first ordinary work call, a checkpoint window starts and later calls do not reset it:

- 2 minutes: a `checkpoint_due` event is created.
- 5 minutes: ordinary work is blocked until `session_checkpoint`.
- 15 minutes without tool activity: the controller becomes stale and its token is invalidated.

Before ending a work turn, call `session_checkpoint` with a 1–4000 character summary and the current phase. Optional fields include next steps, blockers, artifacts, milestone, and tags. Completing a session makes it immutable and releases its controller. A root cannot complete while direct children remain non-terminal; Lite returns `CHILD_REVIEW_REQUIRED` with child checkpoints, unread messages, and pending events.

Continuing terminal work creates a same-level session with `continuesSessionId`; terminal sessions are never reopened.

## Events, messages, and history

Every authenticated facade response includes up to five unacknowledged events for that session. Unacknowledged events repeat until `session_events_ack`; acknowledgement never deletes history. Events include messages, child creation, subscription progress, milestones, phase changes, blocked/completed/stale state, checkpoint reminders, claims, releases, and revocations.

Message sender identity is always the authenticated session. `message_send` accepts a recipient name or ID, `message_list` includes both sent and received records, and `message_conversation` returns one two-way thread. Roots automatically subscribe to direct children, and any session can subscribe to another session with `session_subscribe`.

Persistence uses schema v2:

- `.localterminal-lite/state.json` stores current materialized state, subscriptions, controller hashes, Apps bindings, events, and extensions.
- `.localterminal-lite/history/<sessionId>.jsonl` permanently appends task packages, checkpoints, messages, state events, and sanitized tool audits.

Audit argument snapshots are capped at 4000 characters. Identity, token, authorization, claim-code, body, and content fields are redacted. Automatic context inheritance remains a projection capped at 16000 characters, with up to 10 recent tool calls and 20 recent messages while prioritizing objectives, final summaries, and unread messages. Models can page through the complete permanent structured record with `session_history`; the TUI owner view can scroll the complete local record directly.

Existing schema-v1 state migrates automatically: sessions become roots, old statuses map to phases, presence becomes stale, messages move into permanent history, and old ChatGPT client-session hints no longer grant identity.

## Connect ChatGPT

The Overview tab prints both endpoints, but masks the Apps connector path by default. Press `v` only when intentionally revealing credentials:

- Apps: `https://your-domain.example/mcp/<connector-key>`
- Actions schema: `https://your-domain.example/openapi.json`

The Actions document is OpenAPI `3.1.0`, exposes exactly three operations, and uses a concrete object at `components.schemas`. Configure its Bearer authentication with the token shown in the Settings tab.

## Verify

```bash
npm run typecheck
npm test
```

The suite covers Actions and Apps identity, controller takeover, fixed checkpoint timing, parent/child completion, event delivery and ACK, subscriptions, durable history, redaction, v1 migration, deletion, and continuation.
