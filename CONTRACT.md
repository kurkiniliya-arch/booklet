# Implementation contract

Desktop app for Windows. UI is Russian and follows the approved pixel parchment book. Fixed-size book, internal scroll, no content-driven window resizing. Views: journal, completed-history, monthly calendar, simple kanban (todo/in_progress/done). User-requested urgency; no recurrence editor. Existing Pokémon every-two-calendar-days recurrence is retained and supported as a data feature. No employer work content. No private vault data in repository.

## Shared state

```js
{
 version: 1, revision: 'opaque',
 projects: [{id,title,description}],
 quests: [{id,projectId,title,description,status:'todo'|'in_progress'|'done',onBoard:false,urgent:false,plannedDate:null,dueDate:null,createdAt,updatedAt,completedAt:null,sourcePath:null,recurrence:null}],
 materials: [{id,projectId,title,description,path}],
 completions: [{id,questId,projectId,title,description,completedAt,kind:'quest'|'recurrence'}],
 connection: {connected:true,vaultPath,lastSync,warnings:[]}
}
```

Dates plannedDate/dueDate are YYYY-MM-DD or null, timestamps ISO. Recurrence when present is `{intervalDays:2,nextDate:null,lastCompletedAt:null}`. A recurring quest stays open when marked done; a history event is appended and nextDate/plannedDate advances two calendar days. Completion history is separate from current task status. Reopening a completed one-off quest removes its active completion (or marks it reopened; UI should only show valid completions). Never fabricate old completion dates on import; unknown dates are null and shown as unknown.

Board membership is independent of status. Only quests with `onBoard === true` belong to Kanban; missing values default to false, including existing todo/in_progress/done quests. New quests start with `onBoard:false`. Status changes, completion, reopening and recurrence never implicitly add/remove a quest. A recurring quest completed on the board remains on the board in todo for its next occurrence.

## Renderer API on window.questBook

- `load()` -> state (disconnected empty state when vault not chosen)
- `dispatch({type,payload,revision})` -> updated state
- `chooseVault()` -> state or null when cancelled
- `refresh()` -> state
- `onChanged(callback)` -> unsubscribe. Callback receives refreshed state; renderer must preserve unsaved editor drafts.
- `windowAction('minimize'|'close'|'open-book'|'close-book')` -> void. Open/close-book also handles native dimensions, not task data.
- `openSource(path)` -> opens a known note in Obsidian, accepts only known source paths.

Dispatch operations:

- `project.create`: `{title,description}`
- `project.update`: `{id,title,description}`
- `project.delete`: `{id}` (explicit confirmation in UI)
- `quest.create`: `{projectId,title,description,urgent,plannedDate,dueDate,sourcePath?}`
- `quest.update`: `{id,projectId?,title?,description?,urgent?,plannedDate?,dueDate?}` (partial update)
- `quest.status`: `{id,status}`
- `quest.board`: `{id,onBoard,status?}` (onBoard is a required boolean; optional status is accepted only when onBoard is true)
- `quest.delete`: `{id}` (explicit confirmation in UI)
- `completion.undo`: `{id}` for an erroneous completion/history mark

`quest.board` changes membership and optional status in one transaction using the same completion/recurrence rules as `quest.status`. Removing a quest from the board changes only its membership; status, all dates and completion history stay unchanged. `quest.status` never changes membership. `quest.update` does not set membership; use `quest.board` explicitly.

## Storage module API (src/store.cjs)

`const {QuestStore}=require('./store.cjs')`

`new QuestStore(vaultPath,{bootstrapFile?, now?:()=>Date, backupRoot?})`

- `await store.load()` -> state
- `await store.dispatch(command)` -> state; validates types, dates, IDs, expected revision and serializes writes
- `await store.close()` optional cleanup

Store reads Markdown as task/description source of truth; application metadata/grouping/history in `90 Система/Quest Book.json`. Update existing task Markdown/frontmatter on changes, preserve unknown fields and unrelated/manual content. New group task notes can be created under root-level group folders. Existing task checkboxes + stable ^task-ID blocks must survive. New statuses, dates, urgency, boolean `onBoard` and descriptions live in task_details. Use `status` for in_progress, checkbox for done. Metadata JSON is app grouping/history/cache, not a replacement for Markdown. Read current Markdown on refresh; external edits should be reflected. Exclude .obsidian, .trash, hidden directories and employer work. Never load plugin data/keys. Back up changed source files outside the vault before mutation; safe path validation/no symlink traversal; no permanent file deletion. Deleted project grouping should not destroy source knowledge notes. Explicit task deletion removes that task only. Preserve materials as possible when deleting a grouping; do not silently reimport deleted groups/tasks on next load.

Optional local-only bootstrap JSON shape: `{projects:[{id,title,description,sourceIds:[...]}], taskOverrides:{'<id>':{title?,description?}}, extraQuests:[{id,projectId,title,description,recurrence:{intervalDays:2,nextDate:null,lastCompletedAt:null},sourceId?}]}`. Bootstrap supplied by CLI only on first initialization. Do not commit local bootstrap/private data. Generic fallback import groups notes by their root folder when no bootstrap.

Tests use temporary fixture vaults and a fixed injected clock, never real personal vault. Main owns settings/window/protocol/preload/packaging. UI owns src/renderer/** only. Storage owns src/store.cjs and test/store*.test.cjs. Shared contract changes must be announced.
