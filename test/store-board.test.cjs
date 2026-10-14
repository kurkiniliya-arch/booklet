'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const {QuestStore} = require('../src/store.cjs');

const FIXED = new Date('2026-10-15T12:00:00.000Z');
const CONTENT = `---
id: personal-project
manual_field: keep
task_details:
  board-task:
    manual_task_field: keep-too
    plannedDate: 2026-10-18
    dueDate: 2026-10-20
    updatedAt: 2026-10-14T11:00:00.000Z
---

# Личный проект

Ручное описание проекта.

- [ ] Существующее задание ^task-board-task

Ручной текст после задания.
`;

async function fixture(t,content = CONTENT) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'quest-board-test-'));
  const vault = path.join(directory,'vault');
  const source = path.join(vault,'Личные','Проект.md');
  const backupRoot = path.join(directory,'backups');
  await fs.mkdir(path.dirname(source),{recursive:true});
  await fs.writeFile(source,content,'utf8');
  const options = {backupRoot,now:() => FIXED};
  const store = new QuestStore(vault,options);
  t.after(async () => { await store.close(); await fs.rm(directory,{recursive:true,force:true}); });
  const dispatch = async (type,payload,state) => store.dispatch({type,payload,revision:(state || await store.load()).revision});
  return {directory,vault,source,backupRoot,options,store,dispatch};
}
function details(raw) { return YAML.parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).task_details['board-task']; }

test('board defaults to false for all legacy statuses and requires an explicit true boolean in Markdown',async t => {
  const f = await fixture(t,`---
id: personal-project
task_details:
  doing: {status: in_progress}
  selected: {onBoard: true}
  string-value: {onBoard: "true"}
---
# Задания
- [ ] Очередь ^task-todo
- [ ] Выполняется ^task-doing
- [x] Выполнено ^task-done
- [ ] Выбрано ^task-selected
- [ ] Строка ^task-string-value
`);
  const state = await f.store.load();
  assert.deepEqual(state.quests.map(quest => [quest.id,quest.status,quest.onBoard]),[
    ['todo','todo',false],['doing','in_progress',false],['done','done',false],['selected','todo',true],['string-value','todo',false]
  ]);
});

test('selecting and deselecting a quest changes only membership and preserves source fields/IDs',async t => {
  const f = await fixture(t);
  let state = await f.store.load();
  const original = state.quests[0];
  state = await f.dispatch('quest.board',{id:original.id,onBoard:true},state);
  assert.deepEqual(state.quests[0],{...original,onBoard:true});
  const raw = await fs.readFile(f.source,'utf8');
  assert.equal(details(raw).onBoard,true);
  assert.equal(details(raw).manual_task_field,'keep-too');
  assert.match(raw,/manual_field: keep/);
  assert.match(raw,/Ручной текст после задания/);
  assert.match(raw,/- \[ \] Существующее задание \^task-board-task/);
  state = await f.dispatch('quest.board',{id:original.id,onBoard:false},state);
  assert.deepEqual(state.quests[0],original);
  assert.equal(details(await fs.readFile(f.source,'utf8')).onBoard,false);
});

test('adding to a column atomically selects and transitions, including completion and reopening semantics',async t => {
  const f = await fixture(t);
  let state = await f.store.load();
  const backupsBefore = (await fs.readdir(f.backupRoot)).length;
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:true,status:'in_progress'},state);
  assert.equal(state.quests[0].onBoard,true);
  assert.equal(state.quests[0].status,'in_progress');
  assert.equal((await fs.readdir(f.backupRoot)).length,backupsBefore + 1,'membership and status are one transaction');
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:true,status:'done'},state);
  assert.equal(state.quests[0].status,'done');
  assert.equal(state.quests[0].onBoard,true);
  assert.equal(state.quests[0].completedAt,FIXED.toISOString());
  assert.equal(state.completions.length,1);
  assert.match(await fs.readFile(f.source,'utf8'),/- \[x\] Существующее задание \^task-board-task/);
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:true,status:'todo'},state);
  assert.equal(state.quests[0].status,'todo');
  assert.equal(state.quests[0].onBoard,true);
  assert.equal(state.completions.length,0);
});

test('removing a completed quest preserves status, every date and completion history across restart',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('quest.board',{id:'board-task',onBoard:true,status:'done'});
  const before = state.quests[0];
  const history = state.completions;
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:false},state);
  assert.deepEqual(state.quests[0],{...before,onBoard:false});
  assert.deepEqual(state.completions,history);
  const reopened = new QuestStore(f.vault,f.options);
  try {
    const loaded = await reopened.load();
    assert.deepEqual(loaded.quests,state.quests);
    assert.deepEqual(loaded.completions,history);
  } finally { await reopened.close(); }
});

test('ordinary status/undo operations never select or deselect a quest',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('quest.status',{id:'board-task',status:'in_progress'});
  assert.equal(state.quests[0].onBoard,false);
  state = await f.dispatch('quest.status',{id:'board-task',status:'done'},state);
  assert.equal(state.quests[0].onBoard,false);
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:true},state);
  state = await f.dispatch('completion.undo',{id:state.completions[0].id},state);
  assert.equal(state.quests[0].onBoard,true);
  state = await f.dispatch('quest.status',{id:'board-task',status:'done'},state);
  assert.equal(state.quests[0].onBoard,true);
});

test('recurring completion remains selected in todo, with persisted occurrence and schedule',async t => {
  const f = await fixture(t,CONTENT.replace('manual_task_field: keep-too','manual_task_field: keep-too\n    recurrence: {intervalDays: 2, nextDate: null, lastCompletedAt: null}'));
  let state = await f.dispatch('quest.board',{id:'board-task',onBoard:true,status:'done'});
  assert.equal(state.quests[0].onBoard,true);
  assert.equal(state.quests[0].status,'todo');
  assert.equal(state.quests[0].plannedDate,'2026-10-17');
  assert.equal(state.completions[0].kind,'recurrence');
  const before = state.quests[0];
  const history = state.completions;
  const restarted = new QuestStore(f.vault,f.options);
  try { assert.deepEqual((await restarted.load()).quests,state.quests); } finally { await restarted.close(); }
  state = await f.dispatch('quest.board',{id:'board-task',onBoard:false},state);
  assert.deepEqual(state.quests[0],{...before,onBoard:false});
  assert.deepEqual(state.completions,history);
});

test('new quests and bootstrap extra quests start outside the board',async t => {
  const f = await fixture(t);
  const bootstrap = path.join(f.directory,'bootstrap.json');
  await fs.writeFile(bootstrap,JSON.stringify({projects:[{id:'personal',title:'Личные',sourceIds:['personal-project']}],extraQuests:[{id:'new-extra',projectId:'personal',sourceId:'personal-project',title:'Повторение',description:'',recurrence:{intervalDays:2,nextDate:null,lastCompletedAt:null}}]}),'utf8');
  f.store.bootstrapFile = bootstrap;
  let state = await f.store.load();
  assert.equal(state.quests.find(quest => quest.id === 'new-extra').onBoard,false);
  state = await f.dispatch('quest.create',{projectId:'personal',title:'Новое задание',description:''},state);
  const created = state.quests.find(quest => quest.title === 'Новое задание');
  assert.equal(created.onBoard,false);
  const raw = await fs.readFile(path.join(f.vault,created.sourcePath),'utf8');
  assert.match(raw,/onBoard: false/);
});

test('invalid board payloads fail before any source or history mutation',async t => {
  const f = await fixture(t);
  const initial = await f.store.load();
  const original = await fs.readFile(f.source,'utf8');
  const invalid = [
    {id:'board-task'},
    {id:'board-task',onBoard:'true'},
    {id:'board-task',onBoard:1},
    {id:'board-task',onBoard:null},
    {id:'board-task',onBoard:[]},
    {id:'board-task',onBoard:true,status:'unknown'},
    {id:'board-task',onBoard:true,status:null},
    {id:'board-task',onBoard:false,status:'done'},
    {id:'board-task',onBoard:false,status:'todo'}
  ];
  for (const payload of invalid) await assert.rejects(f.dispatch('quest.board',payload,initial),{code:'VALIDATION'});
  assert.equal((await f.store.load()).revision,initial.revision);
  assert.equal(await fs.readFile(f.source,'utf8'),original);
  assert.deepEqual((await f.store.load()).completions,initial.completions);
});

test('external board edits reflect immediately and stale membership edits conflict',async t => {
  const f = await fixture(t);
  const initial = await f.store.load();
  await fs.writeFile(f.source,CONTENT.replace('manual_task_field: keep-too','manual_task_field: keep-too\n    onBoard: true'),'utf8');
  await assert.rejects(f.dispatch('quest.board',{id:'board-task',onBoard:false},initial),{code:'CONFLICT'});
  assert.equal((await f.store.load()).quests[0].onBoard,true);
});
