'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const {QuestStore} = require('../src/store.cjs');

const FIXED = new Date('2026-10-14T14:00:00.000Z');
const SOURCE = 'Личные/Сервис.md';
const CONTENT = `---
id: service
custom_field: keep-me
task_details:
  fixture-check:
    blocked_by: []
    next_action: Проверить питание.
    custom_task_value: untouched
---

# Сервис

Моя заметка, которую нельзя потерять.

- [ ] Проверить сервис ^task-fixture-check

Ручной текст после задания.

## Источники

- [[Другой материал]]
`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'quest-store-'));
  const vault = path.join(directory,'vault');
  await fs.mkdir(path.join(vault,'Личные'),{recursive:true});
  await fs.writeFile(path.join(vault,SOURCE), options.content || CONTENT,'utf8');
  const store = new QuestStore(vault,{backupRoot:path.join(directory,'backups'),now:() => FIXED,...options.store});
  t.after(async () => { await store.close(); await fs.rm(directory,{recursive:true,force:true}); });
  const dispatch = async (type,payload,state) => store.dispatch({type,payload,revision:(state || await store.load()).revision});
  return {directory,vault,store,dispatch,source:path.join(vault,SOURCE)};
}

function frontmatter(content) { return YAML.parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]); }

test('imports Markdown as source, skips employer and hidden files without reading plugin credentials',async t => {
  const f = await fixture(t);
  for (const directory of ['Работа','.obsidian/plugins/secret','.trash','Сохранённое']) await fs.mkdir(path.join(f.vault,directory),{recursive:true});
  await fs.writeFile(path.join(f.vault,'Работа','Secret.md'),'---\nid: work-secret\n---\n- [ ] Employer secret ^task-employer\n');
  await fs.writeFile(path.join(f.vault,'.obsidian/plugins/secret/data.json'),'not even valid JSON');
  await fs.writeFile(path.join(f.vault,'.trash','Old.md'),'- [ ] Trash task ^task-trash\n');
  await fs.writeFile(path.join(f.vault,'Сохранённое','DocSpace.md'),'---\nid: docspace-docs\n---\n- [ ] Excluded employer ^task-employer2\n');
  const state = await f.store.load();
  assert.equal(state.quests.length,1);
  assert.equal(state.quests[0].id,'fixture-check');
  assert.equal(state.quests[0].createdAt,null);
  assert.equal(state.quests[0].completedAt,null);
  assert.equal(state.quests[0].description,'С чего начать: Проверить питание.');
  assert.equal(await fs.readFile(f.source,'utf8'),CONTENT);
});

test('edits title/description/status/calendar and preserves manual prose and unknown YAML',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('quest.update',{id:'fixture-check',title:'Проверить выключатель',description:'Моё описание\nВторая строка',urgent:true,plannedDate:'2026-10-15',dueDate:'2026-10-20'});
  state = await f.dispatch('quest.status',{id:'fixture-check',status:'in_progress'},state);
  const raw = await fs.readFile(f.source,'utf8');
  assert.match(raw,/- \[ \] Проверить выключатель \^task-fixture-check/);
  assert.match(raw,/Ручной текст после задания\./);
  assert.match(raw,/\[\[Другой материал\]\]/);
  const fm = frontmatter(raw);
  assert.equal(fm.custom_field,'keep-me');
  assert.equal(fm.task_details['fixture-check'].custom_task_value,'untouched');
  assert.equal(fm.task_details['fixture-check'].description,'Моё описание\nВторая строка');
  assert.equal(fm.task_details['fixture-check'].deadline,'2026-10-20');
  assert.equal(fm.task_details['fixture-check'].deadline_status,'confirmed');
  assert.equal(state.quests[0].status,'in_progress');
  assert.equal(state.quests[0].urgent,true);
  assert.equal(state.quests[0].plannedDate,'2026-10-15');
  assert.equal(state.quests[0].dueDate,'2026-10-20');
  const restarted = new QuestStore(f.vault,{backupRoot:path.join(f.directory,'backups'),now:() => FIXED});
  assert.deepEqual((await restarted.load()).quests,state.quests);
  await restarted.close();
  const backups = await fs.readdir(path.join(f.directory,'backups'));
  assert.ok(backups.length >= 3);
  const found = [];
  for (const entry of backups) {
    try { found.push(await fs.readFile(path.join(f.directory,'backups',entry,SOURCE),'utf8')); } catch {}
  }
  assert.ok(found.includes(CONTENT),'original Markdown backup exists outside vault');
});

test('completion persists across restart, reopening removes active history, imported completions have unknown dates',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('quest.status',{id:'fixture-check',status:'done'});
  assert.equal(state.quests[0].status,'done');
  assert.equal(state.quests[0].completedAt,FIXED.toISOString());
  assert.equal(state.completions.length,1);
  assert.equal(state.completions[0].completedAt,FIXED.toISOString());
  state = await f.store.load();
  assert.equal(state.completions.length,1);
  state = await f.dispatch('completion.undo',{id:state.completions[0].id},state);
  assert.equal(state.quests[0].status,'todo');
  assert.equal(state.completions.length,0);
  await fs.writeFile(f.source,(await fs.readFile(f.source,'utf8')).replace('- [ ] Проверить сервис','- [x] Проверить сервис'));
  state = await f.store.load();
  assert.equal(state.completions.length,1);
  assert.equal(state.completions[0].completedAt,null);
});

test('external edits refresh and stale queued commands conflict without losing edits',async t => {
  const f = await fixture(t);
  const initial = await f.store.load();
  const edited = CONTENT.replace('Проверить сервис','Новый текст вручную').replace('- [ ]','- [x]');
  await fs.writeFile(f.source,edited,'utf8');
  await assert.rejects(f.dispatch('quest.update',{id:'fixture-check',title:'Old stale edit'},initial),{code:'CONFLICT'});
  let state = await f.store.load();
  assert.equal(state.quests[0].title,'Новый текст вручную');
  assert.equal(state.quests[0].status,'done');
  assert.equal(state.quests[0].completedAt,null);
  const results = await Promise.allSettled([
    f.dispatch('quest.update',{id:'fixture-check',urgent:true},state),
    f.dispatch('quest.update',{id:'fixture-check',description:'Second concurrent draft'},state)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code,'CONFLICT');
  assert.match(await fs.readFile(f.source,'utf8'),/Новый текст вручную/);
});

test('project creation/edit and task addition roundtrip to Markdown',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('project.create',{title:'Новое хобби',description:'Описание направления'});
  const project = state.projects.find(value => value.title === 'Новое хобби');
  assert.ok(project);
  state = await f.dispatch('quest.create',{projectId:project.id,title:'Собрать модель',description:'Проверить комплект',urgent:false,plannedDate:null,dueDate:null},state);
  const quest = state.quests.find(value => value.title === 'Собрать модель');
  assert.ok(quest.sourcePath.startsWith('Новое хобби/'));
  const raw = await fs.readFile(path.join(f.vault,quest.sourcePath),'utf8');
  assert.match(raw,new RegExp(`\\^task-${quest.id}`));
  assert.equal(frontmatter(raw).task_details[quest.id].description,'Проверить комплект');
  state = await f.dispatch('project.update',{id:project.id,title:'Моделизм',description:'Обновлённое описание'},state);
  assert.equal(state.projects.find(value => value.id === project.id).description,'Обновлённое описание');
  assert.equal(state.projects.find(value => value.id === project.id).title,'Моделизм');
});

test('deleting task removes only checkbox and its metadata; deleting group preserves notes and prevents reimport',async t => {
  const f = await fixture(t);
  let state = await f.store.load();
  const projectId = state.projects[0].id;
  state = await f.dispatch('quest.delete',{id:'fixture-check'},state);
  assert.equal(state.quests.length,0);
  const raw = await fs.readFile(f.source,'utf8');
  assert.doesNotMatch(raw,/\^task-fixture-check/);
  assert.match(raw,/Моя заметка, которую нельзя потерять/);
  assert.equal(frontmatter(raw).custom_field,'keep-me');
  assert.equal(frontmatter(raw).task_details['fixture-check'],undefined);
  await fs.writeFile(f.source,CONTENT,'utf8');
  state = await f.store.load();
  assert.equal(state.quests.length,0,'deleted ID stays suppressed even if restored externally');
  state = await f.dispatch('project.delete',{id:projectId},state);
  assert.equal(state.projects.length,0);
  assert.equal(state.materials.length,0);
  assert.equal(await fs.readFile(f.source,'utf8'),CONTENT);
  state = await f.store.load();
  assert.equal(state.projects.length,0);
});

test('adding a task to a known material preserves its original note',async t => {
  const f = await fixture(t);
  const initial = await f.store.load();
  const state = await f.dispatch('quest.create',{projectId:initial.projects[0].id,title:'Новое задание',description:'Детали',sourcePath:SOURCE},initial);
  assert.equal(state.quests.length,2);
  const raw = await fs.readFile(f.source,'utf8');
  assert.match(raw,/Ручной текст после задания/);
  assert.ok(raw.indexOf('Новое задание') < raw.indexOf('## Источники'));
});

test('invalid date/status/paths fail with no change to source',async t => {
  const f = await fixture(t);
  const state = await f.store.load();
  await assert.rejects(f.dispatch('quest.update',{id:'fixture-check',plannedDate:'2026-02-30'},state),{code:'VALIDATION'});
  await assert.rejects(f.dispatch('quest.status',{id:'fixture-check',status:'maybe'},state),{code:'VALIDATION'});
  await assert.rejects(f.dispatch('quest.create',{projectId:state.projects[0].id,title:'Bad',sourcePath:'../outside.md'},state),{code:'UNSAFE_PATH'});
  await assert.rejects(f.dispatch('quest.create',{projectId:state.projects[0].id,title:'Bad',sourcePath:'.obsidian/plugins/data.json'},state),{code:'UNSAFE_PATH'});
  await assert.rejects(f.dispatch('quest.update',{id:'fixture-check',title:'Bad\n- [x] Injected'},state),{code:'VALIDATION'});
  assert.equal(await fs.readFile(f.source,'utf8'),CONTENT);
  assert.equal((await f.store.load()).revision,state.revision);
});

test('bootstrap recurring quest retains interval, records history, schedules calendar days, and undo restores prior schedule',async t => {
  const f = await fixture(t);
  const bootstrap = path.join(f.directory,'bootstrap.json');
  await fs.writeFile(bootstrap,JSON.stringify({projects:[{id:'personal',title:'Личные дела',description:'Группа',sourceIds:['service']}],extraQuests:[{id:'repeat-video',projectId:'personal',sourceId:'service',title:'Видео через день',description:'Запись',recurrence:{intervalDays:2,nextDate:null,lastCompletedAt:null}}]}),'utf8');
  f.store.bootstrapFile = bootstrap;
  let state = await f.store.load();
  assert.equal(state.projects.length,1);
  assert.equal(state.quests.length,2);
  const quest = state.quests.find(value => value.id === 'repeat-video');
  assert.equal(quest.recurrence.intervalDays,2);
  assert.equal(quest.sourcePath,SOURCE);
  state = await f.dispatch('quest.status',{id:quest.id,status:'done'},state);
  assert.equal(state.quests.find(value => value.id === quest.id).status,'todo');
  assert.equal(state.quests.find(value => value.id === quest.id).plannedDate,'2026-10-16');
  assert.equal(state.completions[0].kind,'recurrence');
  assert.match(await fs.readFile(f.source,'utf8'),/- \[ \] Видео через день \^task-repeat-video/);
  state = await f.dispatch('completion.undo',{id:state.completions[0].id},state);
  assert.equal(state.quests.find(value => value.id === quest.id).plannedDate,null);
  assert.equal(state.quests.find(value => value.id === quest.id).recurrence.lastCompletedAt,null);
  assert.equal(state.completions.length,0);
  assert.equal((await f.store.load()).quests.length,2,'bootstrap does not duplicate on refresh');
});

test('malformed YAML is a visible warning and cannot be overwritten through create',async t => {
  const f = await fixture(t,{content:'---\nid: [bad\n---\n# Broken\n'});
  const state = await f.store.load();
  assert.equal(state.quests.length,0);
  assert.equal(state.connection.warnings.length,1);
  assert.match(state.connection.warnings[0],/YAML/);
  assert.equal(await fs.readFile(f.source,'utf8'),'---\nid: [bad\n---\n# Broken\n');
});

test('unanchored tasks gain stable anchor on update; fenced examples are ignored',async t => {
  const f = await fixture(t,{content:'# Personal\n\n- [ ] Реальная задача\n\n```md\n- [ ] Пример ^task-not-real\n```\n'});
  let state = await f.store.load();
  assert.equal(state.quests.length,1);
  const id = state.quests[0].id;
  state = await f.dispatch('quest.update',{id,description:'Новое описание'},state);
  assert.equal(state.quests[0].id,id);
  assert.match(await fs.readFile(f.source,'utf8'),new RegExp(`\\^task-${id}`));
});

test('metadata corruption fails explicitly instead of replacing grouping/history',async t => {
  const f = await fixture(t);
  await f.store.load();
  await fs.writeFile(path.join(f.vault,'90 Система/Quest Book.json'),'broken JSON','utf8');
  await assert.rejects(f.store.load(),{code:'INVALID_METADATA'});
  assert.equal(await fs.readFile(f.source,'utf8'),CONTENT);
});

test('duplicate task IDs are visible and block ambiguous mutations',async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.vault,'Личные','Other.md'),CONTENT.replace('id: service','id: other-service'),'utf8');
  const state = await f.store.load();
  assert.equal(state.quests.length,1);
  assert.match(state.connection.warnings.join(' '),/Повторяется ID/);
  await assert.rejects(f.dispatch('quest.status',{id:'fixture-check',status:'done'},state),{code:'DUPLICATE_ID'});
});

test('bootstrap labels stop overriding external Markdown title and detail edits',async t => {
  const f = await fixture(t);
  const bootstrap = path.join(f.directory,'bootstrap.json');
  await fs.writeFile(bootstrap,JSON.stringify({projects:[{id:'personal',title:'Личные',sourceIds:['service']}],taskOverrides:{'fixture-check':{title:'Краткое название',description:'Краткое описание'}}}),'utf8');
  f.store.bootstrapFile = bootstrap;
  let state = await f.store.load();
  assert.equal(state.quests[0].title,'Краткое название');
  assert.equal(state.quests[0].description,'Краткое описание');
  const raw = (await fs.readFile(f.source,'utf8')).replace('Проверить сервис ^task-fixture-check','Исправлено вручную ^task-fixture-check').replace('Проверить питание.','Действие, которое я уточнил.');
  await fs.writeFile(f.source,raw,'utf8');
  state = await f.store.load();
  assert.equal(state.quests[0].title,'Исправлено вручную');
  assert.equal(state.quests[0].description,'С чего начать: Действие, которое я уточнил.');
});

test('group description edits change readable body and honor later manual body changes',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('project.create',{title:'Хобби',description:'Первое описание'});
  const project = state.projects.find(value => value.title === 'Хобби');
  const source = path.join(f.vault,'Хобби','Квесты.md');
  await fs.appendFile(source,'\nМой независимый текст.\n','utf8');
  state = await f.dispatch('project.update',{id:project.id,title:'Хобби',description:'Второе описание'});
  let raw = await fs.readFile(source,'utf8');
  assert.doesNotMatch(raw,/Первое описание/);
  assert.match(raw,/Второе описание/);
  assert.match(raw,/Мой независимый текст/);
  raw = raw.replace('<!-- quest-book:description:start -->\nВторое описание','<!-- quest-book:description:start -->\nПравка в Obsidian');
  await fs.writeFile(source,raw,'utf8');
  assert.equal((await f.store.load()).projects.find(value => value.id === project.id).description,'Правка в Obsidian');
});

test('schema3 index follows Markdown mutations and preserves unrelated project fields and links',async t => {
  const f = await fixture(t);
  const indexPath = path.join(f.vault,'90 Система','Индекс.json');
  await fs.mkdir(path.dirname(indexPath),{recursive:true});
  const index = {schema_version:3,generated_at:'2026-01-01',custom:'keep',projects:[{id:'service',title:'Сервис',path:SOURCE,custom:'also keep',sources:[{id:'source',title:'Source'}],tasks:[{id:'fixture-check',state:'open',text:'Проверить сервис',custom_task:'preserve'}]}],relations:[{from:'service',to:'other',type:'uses'}]};
  await fs.writeFile(indexPath,JSON.stringify(index),'utf8');
  let state = await f.dispatch('quest.update',{id:'fixture-check',title:'Новый заголовок',urgent:true});
  state = await f.dispatch('quest.status',{id:'fixture-check',status:'done'},state);
  const changed = JSON.parse(await fs.readFile(indexPath,'utf8'));
  assert.equal(changed.custom,'keep');
  assert.equal(changed.projects[0].custom,'also keep');
  assert.equal(changed.projects[0].tasks[0].custom_task,'preserve');
  assert.equal(changed.projects[0].tasks[0].text,'Новый заголовок');
  assert.equal(changed.projects[0].tasks[0].state,'done');
  assert.equal(changed.projects[0].tasks[0].urgent,true);
  assert.deepEqual(changed.relations,index.relations);
  assert.deepEqual(changed.projects[0].sources,index.projects[0].sources);
});

test('external reopen invalidates old completion date instead of reusing it when checked again',async t => {
  const f = await fixture(t);
  let state = await f.dispatch('quest.status',{id:'fixture-check',status:'done'});
  assert.equal(state.completions[0].completedAt,FIXED.toISOString());
  await fs.writeFile(f.source,(await fs.readFile(f.source,'utf8')).replace('- [x]','- [ ]'),'utf8');
  state = await f.store.load();
  assert.equal(state.completions.length,0);
  await fs.writeFile(f.source,(await fs.readFile(f.source,'utf8')).replace('- [ ]','- [x]'),'utf8');
  state = await f.store.load();
  assert.equal(state.completions[0].completedAt,null);
  state = await f.dispatch('quest.update',{id:'fixture-check',urgent:true},state);
  assert.equal(state.completions[0].completedAt,null);
});

test('undoing repeated completions in arbitrary order does not resurrect a removed occurrence',async t => {
  const f = await fixture(t,{content:CONTENT.replace('blocked_by: []','recurrence: {intervalDays: 2, nextDate: null, lastCompletedAt: null}\n    blocked_by: []')});
  let state = await f.dispatch('quest.status',{id:'fixture-check',status:'done'});
  const first = state.completions[0].id;
  state = await f.dispatch('quest.status',{id:'fixture-check',status:'done'},state);
  const second = state.completions[1].id;
  state = await f.dispatch('completion.undo',{id:first},state);
  assert.equal(state.quests[0].recurrence.lastCompletedAt,FIXED.toISOString());
  state = await f.dispatch('completion.undo',{id:second},state);
  assert.equal(state.completions.length,0);
  assert.equal(state.quests[0].recurrence.lastCompletedAt,null);
  assert.equal(state.quests[0].plannedDate,null);
});

test('filesystem junctions are skipped and cannot be used as note destinations',async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory,'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'Private.md'),'# Private\n- [ ] Private ^task-private','utf8');
  try { await fs.symlink(outside,path.join(f.vault,'Linked'),'junction'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Platform does not permit symlink fixtures'); return; } throw error; }
  const state = await f.store.load();
  assert.equal(state.quests.length,1);
  assert.match(state.connection.warnings.join(' '),/ссылка файловой системы/);
  await assert.rejects(f.dispatch('quest.create',{projectId:state.projects[0].id,title:'Unsafe',sourcePath:'Linked/Private.md'},state),{code:'UNSAFE_PATH'});
});

test('a moved quest survives deleting its original grouping without moving or deleting its source',async t => {
  const f = await fixture(t);
  let state = await f.store.load();
  const oldProject = state.projects[0].id;
  state = await f.dispatch('project.create',{title:'Другая группа',description:''},state);
  const newProject = state.projects.find(value => value.id !== oldProject).id;
  state = await f.dispatch('quest.update',{id:'fixture-check',projectId:newProject},state);
  const before = await fs.readFile(f.source,'utf8');
  state = await f.dispatch('project.delete',{id:oldProject},state);
  assert.equal(state.quests.length,1);
  assert.equal(state.quests[0].projectId,newProject);
  assert.equal(state.quests[0].sourcePath,SOURCE);
  assert.equal(await fs.readFile(f.source,'utf8'),before);
  assert.equal((await f.store.load()).quests.length,1);
});
