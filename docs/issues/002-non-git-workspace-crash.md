# Issue 002: Non-Git workspace crashes or destabilizes the TUI

## Status

Resolved in the next release candidate.

## Severity

Critical release blocker. LocalTerminal Lite supports arbitrary directories as workspaces, so Git cannot be treated as a mandatory runtime dependency or workspace invariant.

## Symptoms

Entering or switching to a directory that is not a Git repository can terminate or destabilize the TUI. The Diff subsystem continuously invokes `git diff HEAD` and `git status` on a fixed interval, producing repeated fatal Git errors for a supported workspace type.

## Root cause

`WorkspaceDiffTracker` assumed every workspace was a Git work tree. It started two Git processes immediately and repeated them every two seconds. Error capture converted an individual failure into a snapshot error, but did not change the capability state, so the unsupported operation continued indefinitely.

This violated the architecture boundary between the core workspace runtime and the optional Git-backed Diff feature.

## Resolution

The Diff tracker now performs an explicit one-time capability probe using `git rev-parse --is-inside-work-tree`.

- Git repository: normal tracked and untracked diff collection continues.
- Non-Git directory: Diff is disabled for that tracker instance without an error or repeated Git processes.
- Git executable unavailable: Diff is disabled with a distinct user-facing status.

The TUI now displays a stable explanatory message instead of treating a non-Git directory as a fatal or dirty state.

## Regression coverage

An automated test creates a plain temporary directory, refreshes and starts the periodic tracker, and verifies that:

- no exception or snapshot error is produced;
- the workspace is classified as `not-git-repository`;
- the periodic tracker remains stable;
- no diff lines are fabricated.

## Release requirement

The complete typecheck, build, automated test suite, and a direct non-Git runtime/TUI-controller smoke test must pass before release.
