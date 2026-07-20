# Issue 003: Workspace selection and settings use inconsistent runtime state

## Status

Resolved in the next release candidate.

## Severity

High. The defect misrepresents live workspace state, pre-fills settings with values that differ from the running process, and exposes inconsistent selection behavior between startup and Settings.

## Symptoms

1. The currently running workspace is shown as inactive in Settings.
2. Values pre-filled for editing can differ from the values shown in the running-process settings panel, especially when port `0` resolves to an actual bound port.
3. Startup workspace selection hides workspaces active in another process, while Settings shows them. Users cannot understand why entries disappear, and the two interfaces behave differently.

## Root cause

Three UI paths independently reconstructed workspace state:

- startup filtered the registry before rendering;
- Settings rebuilt status labels using PID checks that intentionally classify the current PID as inactive;
- the settings panel displayed effective runtime values while the edit form used configured values.

There was no shared domain model for current, active-elsewhere, and inactive workspace states. The generic form model also had no disabled-option capability, encouraging callers to hide unavailable entries.

## Resolution

A shared `workspace-selection` domain module now owns:

- workspace identity comparison;
- current-process, active-elsewhere, and inactive classification;
- effective host, port, and PID display values;
- selection index and answer resolution;
- whether an entry is visible but unavailable.

Both startup and Settings consume the same model. Running workspaces remain visible and are rendered as disabled rather than removed. The current workspace is explicitly shown as running in this process and remains selectable. Settings edit defaults use the effective bound runtime port, matching the running-process panel.

The generic form system now supports disabled options consistently for keyboard, mouse, validation, badges, and navigation.

## Regression coverage

Tests verify that:

- the current workspace is shown as running with the current runtime host, bound port, and PID;
- another active workspace is visible and disabled;
- startup no longer filters active records;
- startup and Settings use the same workspace model;
- the settings edit model uses the effective runtime port;
- workspace cards expose disabled state and distinct status tone.

## Release requirement

Type checking, build, the complete automated test suite, and UI state-model tests must pass before release.
