# Frontend

See root `CLAUDE.md` for commands and architecture. Decisions behind the current
navigation and knowledge experience are in ADRs 0045 and 0046.

## Layout and navigation

Desktop uses two columns: a resizable navigation sidebar and the main pane. The
sidebar contains projects and recent chats together, with Search and New chat in
its header and Settings at the bottom. Settings contains Preferences and Personal
memory. `activePanel` remains persisted for compatibility, but `chats` and
`projects` both show the unified navigation; there is no activity rail.

At widths up to 720px navigation becomes a drawer. Both `ChatView` and
`ProjectView` have an opener. Route navigation closes the drawer. Every header
must remain usable at 320px. The app uses `--app-h`, maintained from
`visualViewport` by `lib/viewportHeight.ts`, so the phone keyboard does not scroll
chrome out of view. Form text on phones is at least 16px to avoid input zoom.

Routes: `/c/new` is an unsaved draft, `/c/:chatId` a conversation, and
`/p/:projectId` the project home. `?project=` supplies draft membership;
route state may carry draft text from the project composer or a file action.
All creation buttons open drafts, and only the first message creates a chat.

## Project home

`ProjectView.tsx` leads with the project description and a draft composer, then
Chats/Knowledge sections. Chats can be filtered or added from existing history.
Knowledge groups instructions, project files, and saved facts. Files open through
signed original URLs, expose descriptive inclusion choices, and can prepare a
question about that source. `?file=` opens Knowledge and locates the file.

Project metadata and member chats are reconciled into the shared store; file and
memory collections are local to the view. Requests are guarded by project identity.
Failed loads remain visible with Retry. File status refreshes every five seconds
while processing and on focus/visibility resume. Upload errors use the real file
ID after the upload request; retry finalizes that existing upload. A missing local
upload can be removed and uploaded again. The server marks processing status older
than fifteen minutes as an error for display.

Project facts can be added, edited and deleted. User-added/edited facts carry
`userEdited`; automatic reconciliation preserves them. Newly generated facts may
link to their source chat. The project-memory switch controls use and learning of
project facts, separately from files and instructions.

## Chat controls and settings

`ChatView.tsx` owns model and response mode in the composer. Mode labels map to
existing budgets: Standard = `brief`, Research = `extended`, Deep research =
`deep`. Thinking effort is directly visible alongside response mode and remains an
independent session override. The header project select assigns drafts and moves saved chats.
A project chip links to the project home on desktop; mobile retains the selector.

`draftModelSettings` contains explicit chat overrides, not copied defaults.
Effective values merge model defaults, user preferences, project settings, chat
settings, then session reasoning overrides. Chat creation persists only the
explicit overrides. "Use inherited settings" clears them. The project default
model uses `null` on PATCH to clear the override.

`ChatDetailsDialog` contains custom instructions, privacy, answer length, advanced
tools, Info, and Share. A chat action opens Share directly. Custom instructions
are edited locally and saved on blur/close. Settings toggles save immediately,
with failures surfaced. `ProjectDetailsDialog` edits description, instructions,
memory, model default, and overrides. `ToolsPanel` puts infrequent controls in an
Advanced tools disclosure. `PreferencesPanel` owns global defaults.

Private is the shortcut for sensitive plus auto-delete. Detailed controls still
separate using memory, updating shared knowledge, and deletion. Hidden chats are
excluded from recent chats, project lists, and navigation search until explicitly
revealed in the list filter. The backend independently enforces isolation.

## Search and actions

`SearchDialog` matches titles, summaries, topics and project filenames/descriptions.
Search does not create a chat. Results link to the chat or specific project file.
The scope selects Everywhere or a project. File fetch failures and the 100 visible
result limit are explicit. "Ask AI to search by meaning" uses `pendingSearch` and
the existing forced `search_history` tool flow in a new conversation.

`ItemMenu` supplies consistent, touch-accessible native details menus. `Dialog`
provides semantics, Escape, focus trapping and focus restoration. Use real links
for navigation and buttons for actions. Share links default to snapshots; live
links remain an explicit option.

## Streaming and recovery

Read `docs/realtime-reliability.md` before changing streaming or polling. The WS
client in `api/ws.ts` reads credentials at connect/reconnect through a token
provider installed by App. Every frame is routed by `chatId`. Zustand
`sendingByChat`/`streamingByChat` allow multiple conversations in flight.

ChatView recovers by refetching messages rather than reattaching a socket. It polls
while HTTP reports a live stream and exposes reconnect after bounded failures.
Unsent text is retained until delivery acknowledgment. Do not overwrite a live
stream with an unconditional focus refetch. Models are cached for first paint and
revalidated outside the initial chats/preferences/projects loading gate.

## Tests and development

- `npm --prefix frontend run build`: TypeScript plus Vite.
- `npm --prefix frontend test`: Vitest unit tests.
- `npm run test:e2e -- e2e/ux-workflows.spec.ts`: live project/search/knowledge flows
  and 320, 390, 768 and 1440px layout checks. Deploy before these tests.
- Screenshots belong in `.screenshots/YYYY-MM-DD-description.jpg`.

Local development uses VITE variables from `frontend/.deploy-env`; deployments
write them from Terraform outputs. Do not commit tokens, auth state, or credentials.
