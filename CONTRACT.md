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
- `windowAction('minimize'|'close')` -> true; existing string actions remain supported.
- `windowAction('layout')` -> layout without resizing (startup/preflight).
- `windowAction('open-book'|'close-book')` -> layout; open preserves the remembered orientation, close uses a uniformly scaled 410×580 cover and clears an unfinished turn.
- `windowAction({type:'open-book',rotated:boolean})` -> final open-book layout (also restores the chosen orientation after the cover).
- `windowAction({type:'prepare-turn',rotated:boolean})` -> layout for the square animation window.
- `windowAction({type:'finish-turn',rotated:boolean})` -> final layout for the target orientation.
- `openSource(path)` -> opens a known note in Obsidian, accepts only known source paths.

Window layout is `{width,height,scale,stageWidth,stageHeight,rotated,open,turning,turnScale,duration}` in device-independent pixels. The open book always has a fixed 1140×750 stage: `rotated:false` is landscape, `rotated:true` is the whole stage turned clockwise 90°. The cover stage is 410×580. Final scale is `min(1, workWidth/targetWidth, workHeight/targetHeight)`; width/height are rounded up from that same scale, never independently capped. Animation scale is `min(1, (workWidth-24)/hypot(1140,750), (workHeight-24)/hypot(1140,750))`, with a square native window large enough for every intermediate angle. `duration` is the recommended turn duration in milliseconds (420). The renderer centers the fixed stage and uses one scale for both axes.

Turn sequence: read `layout`, shrink the stage to `turnScale` in the old native window, call `prepare-turn`, rotate at the returned scale, call `finish-turn`, then grow to the returned final scale. Main fixes a common center for animation/final windows, clamped to fit both on the selected monitor. Work-area changes are rechecked on each operation. Closing the cover cancels the turn anchor; calling object `open-book` or `finish-turn` without a prepared turn safely restores a final layout for error recovery. A closed native window rejects pending IPC normally. Book dimensions never follow its content and window actions never mutate quest data.

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
