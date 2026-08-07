# 9. Consolidate item-scoped settings into one dialog per item

## Status

Accepted

## Context

Chat and project settings were previously spread across a header pill, a header cog popover, and sidebar sub-tabs of a multi-tab `PreferencesPanel`. This split meant some fields — a project's `description`/`instructions`/`memoryEnabled` — had two independently-editable copies: one in the old Preferences "This project" tab, one inline on the project page. That was a real bug (two live editors racing writes to the same DynamoDB field), not just visual clutter.

Alternatives considered:

1. **Keep settings spread across their historical locations**, fix the specific duplicate-editor bug in place without touching the broader layout.
2. **Consolidate into one modal per scope.** Defaults live on a dedicated page (`PreferencesPanel.tsx`, reached via the left rail — nothing item-scoped belongs there). Item-scoped overrides for a *specific* chat or project live in exactly one dialog each (`ChatDetailsDialog.tsx` / `ProjectDetailsDialog.tsx`), reached via a cog next to that item, sharing one modal shell (`Dialog.tsx`).

## Decision

Option 2. `ChatDetailsDialog.tsx` is literally the same component for a not-yet-created `/c/new` draft and a saved chat — handed either the draft state or the saved chat's fields — splitting into Settings/Info tabs only once there's something to show in an Info tab. `ToolsPanel.tsx`, `ModelTuningPanel.tsx`, and `PrefControls.tsx`'s `ToggleRow`/`EffortRow` are shared between the chat and project dialogs, so a given toggle looks and behaves identically wherever it appears.

## Consequences

- Eliminates the class of bug that motivated this by construction — there is now exactly one editor for a project's `description`/`instructions`/`memoryEnabled`, not two.
- New per-item settings have one clear home (that item's dialog) instead of a three-way judgment call between header/popover/sidebar.
- The rule of thumb — "defaults are a page, item-scoped settings are a dialog" — is a convention enforced by habit, not structurally. A future feature could still get bolted onto the header again without someone reading this ADR (or the note in `frontend/CLAUDE.md`) first.
