# 45. One navigation sidebar and one project-aware draft flow

## Status

Accepted. Supersedes the dual creation behavior in ADR 0018.

## Context

Recent chats and projects lived in separate sidebar modes. Moving a chat could
hide it; different new-chat buttons persisted empty chats or opened drafts.
The composer copied inherited settings into overrides, so defaults could stop
working without the user choosing an override. Header search created a chat.

## Decision

Use one sidebar with projects, recent chats, search, and settings. Personal
memory is part of settings. Project pages provide Chats and Knowledge sections,
mobile navigation, a draft composer, and destination-side chat organization.

Every new-chat action navigates to a draft with optional project and input text.
Persist only on first send. Resolve user, project, chat, and per-send settings in
that order; persist only explicit chat overrides. The primary composer mode
retains all existing research budgets: Standard = brief, Research = extended,
Deep research = deep. Thinking effort remains a directly visible select showing its current value,
with no automatic remapping of saved preferences. User feedback rejected an
extra disclosure because it hid the selected effort and added an unnecessary click.

Search opens ordinary results without creating a chat. Search by meaning is an
explicit subsequent action using the existing model search. Current search
matches loaded chat titles/summaries/topics and fetched project filenames and
summaries. It reports file loading failures and visible-result limits.

## Consequences

Projects and chats remain visible together, and mobile routes always provide
navigation. Settings no longer need a dedicated activity rail. Native selects,
links, details menus, and a focus-managed dialog preserve keyboard/touch access.

We rejected keeping the rail and adding another mode because it would preserve
the navigation problem. We rejected merging reasoning and research into opaque
presets because they are distinct capabilities with existing saved preferences.
A search index can replace in-memory matching later without changing the
interaction; introducing one is not required for ordinary navigation search.
