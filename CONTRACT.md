# Implementation contract

Desktop app for Windows. UI is Russian and follows the approved pixel parchment book. Fixed-size book, internal scroll, no content-driven window resizing. Views: journal, completed-history, monthly calendar, simple kanban (todo/in_progress/done). User-requested urgency; calendar recurrence editor for every N days or selected weekdays. Existing Pokémon every-two-calendar-days recurrence is retained. No employer work content. No private vault data in repository.

## Shared state

```js
{
 version: 1, revision: 'opaque',
 projects: [{id,title,description}],
 quests: [{id,projectId,title,description,status:'todo'|'in_progress'|'done',onBoard:false,urgent:false,plannedDate:null,dueDate:null,createdAt,updatedAt,completedAt:null,sourcePath:null,recurrence:null}],
 materials: [{id,projectId,title,description,path}],
 completions: [{id,questId,projectId,title,description,completedAt,kind:'quest'|'recurrence',occurrenceDate?}],
 connection: {connected:true,vaultPath,lastSync,warnings:[]}
}
```

Dates plannedDate/dueDate are YYYY-MM-DD or null, timestamps ISO. Recurrence is null or one of:

- `{kind:'interval',intervalDays:N,startDate,nextDate,lastCompletedAt}` with N an integer from 1 to 3660.
- `{kind:'weekly',weekdays:[1,2,3,4,5,6,7],startDate,nextDate,lastCompletedAt}` with one or more ISO weekdays (Monday=1, Sunday=7), stored sorted and unique.

`startDate` anchors the rule. `nextDate` is the first uncompleted scheduled date on or after the current local calendar day, or null when the start is unknown. `lastCompletedAt` is an ISO timestamp or null. Legacy `{intervalDays:2,nextDate:null,lastCompletedAt:null}` remains valid on read: normalize its kind to interval and start from an existing explicit startDate, nextDate or plannedDate, otherwise preserve null without inventing today's date. New/changed schedules require a startDate; an explicitly supplied plannedDate may provide the fallback. A title-only edit without recurrence leaves the rule untouched; roundtripping the same unconfigured legacy rule is also accepted.

Recurring occurrences are generated for the visible date range, never copied into separate quests. `quest.status` with done records the selected `occurrenceDate`; a missing date uses nextDate, while a rule without a start is rejected until the user schedules it. An explicit future occurrence can be completed early without moving neighboring dates. Completion of one occurrence keeps the quest open in todo, never shifts startDate or the future pattern, and does not modify independent plannedDate/dueDate. The same occurrence cannot create duplicate history. `completion.undo` removes only that event and recalculates nextDate using the current rule, preserving later rule edits and other history. Past completed occurrenceDate rows remain visible even after changing or removing a rule. Legacy history without an occurrenceDate stays in history; never infer a scheduled date from its completion timestamp. An externally checked recurring Markdown checkbox closes the series: keep status done, project only known history, and resume explicitly through quest.status todo. Reopening a completed one-off quest removes its active completion. Unknown completion dates stay null.

For one-off quests, board membership is independent of status and dates. Only quests with `onBoard === true` belong to Kanban; missing values default to false, including existing todo/in_progress/done quests. New quests start with `onBoard:false`. Recurring quests belong to the calendar: return onBoard:false even for legacy data that says true, without rewriting files on load; setting a recurrence clears membership, and quest.board with onBoard:true rejects recurring quests. Removing a recurring quest from the board remains allowed. One-off status, completion, reopening and scheduling never change board membership.

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
- `quest.create`: `{projectId,title,description,urgent,plannedDate,dueDate,sourcePath?,recurrence?}`
- `quest.update`: `{id,projectId?,title?,description?,urgent?,plannedDate?,dueDate?,recurrence?}` (partial update; recurrence:null removes the rule)
- `quest.status`: `{id,status,occurrenceDate?}` (occurrenceDate only for marking a recurring occurrence done)
- `quest.board`: `{id,onBoard,status?}` (onBoard is a required boolean; optional status is accepted only when onBoard is true)
- `quest.delete`: `{id}` (explicit confirmation in UI)
- `completion.undo`: `{id}` for an erroneous completion/history mark

`quest.board` changes membership and optional status in one transaction using the same completion rules as `quest.status`. Removing a quest from the board changes only its membership; status, all dates and completion history stay unchanged. For one-off quests, `quest.status` never changes membership. `quest.update` does not accept an onBoard field; use `quest.board` explicitly. Assigning a recurrence clears membership because recurring tasks belong to the calendar.

`src/renderer/schedule.js` is the shared pure UMD/CJS date module (`window.QuestSchedule` in the renderer). Exports: `normalizeRecurrence(value,{plannedDate?})`, `validateRecurrence(value,{plannedDate?})` (throws on invalid/new unconfigured rules), `occurrenceDates(rule,fromDate,toDate)` (inclusive string[]), `isOccurrence(rule,date)`, `nextOccurrence(rule,fromDate,completedDates=[])`, `occurrencesForQuest(quest,fromDate,toDate,completions=[])`, `isDate`, `addDays`, `localDate`, `isoWeekday`. Occurrence rows are `{questId,date,completed,completionId,completedAt,recurring}`. Completed rows include their exact history ID for undo and to avoid duplicate completion controls. Date arithmetic uses UTC calendar days, never 24-hour local-time offsets; store and renderer both get today through localDate in the same system zone. A recurring calendar picker updates recurrence.startDate; a one-off picker updates plannedDate.

## Storage module API (src/store.cjs)

`const {QuestStore}=require('./store.cjs')`

`new QuestStore(vaultPath,{bootstrapFile?, now?:()=>Date, backupRoot?})`

- `await store.load()` -> state
- `await store.dispatch(command)` -> state; validates types, dates, IDs, expected revision and serializes writes
- `await store.close()` optional cleanup

Store reads Markdown as task/description source of truth; application metadata/grouping/history in `90 Система/Quest Book.json`. Update existing task Markdown/frontmatter on changes, preserve unknown fields and unrelated/manual content. New group task notes can be created under root-level group folders. Existing task checkboxes + stable ^task-ID blocks must survive. New statuses, dates, urgency, boolean `onBoard` and descriptions live in task_details. Use `status` for in_progress, checkbox for done. Metadata JSON is app grouping/history/cache, not a replacement for Markdown. Read current Markdown on refresh; external edits should be reflected. Exclude .obsidian, .trash, hidden directories and employer work. Never load plugin data/keys. Back up changed source files outside the vault before mutation; safe path validation/no symlink traversal; no permanent file deletion. Deleted project grouping should not destroy source knowledge notes. Explicit task deletion removes that task only. Preserve materials as possible when deleting a grouping; do not silently reimport deleted groups/tasks on next load.

Optional local-only bootstrap JSON shape: `{projects:[{id,title,description,sourceIds:[...]}], taskOverrides:{'<id>':{title?,description?}}, extraQuests:[{id,projectId,title,description,recurrence:{intervalDays:2,nextDate:null,lastCompletedAt:null},sourceId?}]}`. Bootstrap supplied by CLI only on first initialization. Do not commit local bootstrap/private data. Generic fallback import groups notes by their root folder when no bootstrap.

Tests use temporary fixture vaults and a fixed injected clock, never real personal vault. Main owns settings/window/protocol/preload/packaging. UI owns src/renderer/** only. Storage owns src/store.cjs and test/store*.test.cjs. Shared contract changes must be announced.
