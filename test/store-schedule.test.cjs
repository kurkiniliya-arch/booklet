'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const {QuestStore} = require('../src/store.cjs');
const Schedule = require('../src/renderer/schedule.js');

const FIXED = new Date('2026-10-15T12:00:00Z');
async function fixture(t, recurrence = null, {checked = false,onBoard = false} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'quest-schedule-'));
  const vault = path.join(directory,'vault');
  const source = path.join(vault,'Личные','Проект.md');
  await fs.mkdir(path.dirname(source),{recursive:true});
  const fm = {id:'project',manual:'keep',task_details:{'schedule-task':{recurrence,onBoard,plannedDate:'2026-10-18',dueDate:'2026-11-01',manual_task:'keep'}}};
  const raw = `---\n${YAML.stringify(fm)}---\n\n# Личный проект\n\n- [${checked ? 'x' : ' '}] Практика ^task-schedule-task\n\nРучной текст.\n`;
  await fs.writeFile(source,raw,'utf8');
  const options = {backupRoot:path.join(directory,'backups'),now:() => FIXED};
  const store = new QuestStore(vault,options);
  const dispatch = async (type,payload,state) => store.dispatch({type,payload,revision:(state || await store.load()).revision});
  t.after(async () => { await store.close(); await fs.rm(directory,{recursive:true,force:true}); });
  return {directory,vault,source,store,dispatch,options,raw};
}
const weekly = () => ({kind:'weekly',weekdays:[2,4],startDate:'2026-10-01'});

test('new daily and weekly schedules persist without creating duplicate tasks or joining the board',async t => {
  const f = await fixture(t);
  let state = await f.store.load();
  const projectId = state.projects[0].id;
  state = await f.dispatch('quest.create',{projectId,title:'Каждый день',description:'',recurrence:{kind:'interval',intervalDays:1,startDate:'2026-10-15'}},state);
  state = await f.dispatch('quest.create',{projectId,title:'Вторник и четверг',description:'',recurrence:{kind:'weekly',weekdays:[4,2,2],startDate:'2026-10-01'}},state);
  assert.equal(state.quests.length,3);
  const daily = state.quests.find(quest => quest.title === 'Каждый день');
  const week = state.quests.find(quest => quest.title === 'Вторник и четверг');
  assert.equal(daily.recurrence.nextDate,'2026-10-15');
  assert.deepEqual(week.recurrence.weekdays,[2,4]);
  assert.equal(week.onBoard,false);
  assert.equal(Schedule.occurrencesForQuest(week,'2026-10-01','2026-10-31').length,9);
  assert.equal((await f.store.load()).quests.length,3);
});

test('completion selects one weekly occurrence, is idempotent and leaves independent dates and future pattern intact',async t => {
  const f = await fixture(t,weekly());
  let state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-13'});
  assert.equal(state.quests[0].recurrence.nextDate,'2026-10-15');
  assert.equal(state.quests[0].plannedDate,'2026-10-18');
  assert.equal(state.quests[0].dueDate,'2026-11-01');
  assert.equal(state.completions[0].occurrenceDate,'2026-10-13');
  const revision = state.revision;
  state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-13'},state);
  assert.equal(state.completions.length,1);
  assert.equal(state.revision,revision);
  state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-15'},state);
  assert.equal(state.quests[0].recurrence.nextDate,'2026-10-20');
  state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-22'},state);
  assert.equal(state.quests[0].recurrence.nextDate,'2026-10-20','future completion does not skip an earlier open date');
  const rows = Schedule.occurrencesForQuest(state.quests[0],'2026-10-13','2026-10-22',state.completions);
  assert.deepEqual(rows.map(row => [row.date,row.completed]),[['2026-10-13',true],['2026-10-15',true],['2026-10-20',false],['2026-10-22',true]]);
  assert.match(await fs.readFile(f.source,'utf8'),/- \[ \] Практика \^task-schedule-task/);
});

test('editing a rule and undoing an old occurrence retain the new rule and other past completions',async t => {
  const f = await fixture(t,weekly());
  let state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-13'});
  const first = state.completions[0].id;
  state = await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-15'},state);
  state = await f.dispatch('quest.update',{id:'schedule-task',recurrence:{kind:'weekly',weekdays:[1],startDate:'2026-10-01'}},state);
  state = await f.dispatch('completion.undo',{id:first},state);
  assert.deepEqual(state.quests[0].recurrence.weekdays,[1]);
  assert.equal(state.quests[0].recurrence.nextDate,'2026-10-19');
  assert.equal(state.completions.length,1);
  assert.equal(state.completions[0].occurrenceDate,'2026-10-15');
  const rows = Schedule.occurrencesForQuest(state.quests[0],'2026-10-13','2026-10-20',state.completions);
  assert.deepEqual(rows.map(row => [row.date,row.completed]),[['2026-10-15',true],['2026-10-19',false]]);
  const restarted = new QuestStore(f.vault,f.options);
  try {
    const fresh = await restarted.load();
    assert.deepEqual(fresh.quests,state.quests);
    assert.deepEqual(fresh.completions,state.completions);
  } finally { await restarted.close(); }
});

test('one-off dates preserve board membership, and assigning/removing a recurrence does not join Kanban',async t => {
  const f = await fixture(t,null,{onBoard:true});
  let state = await f.dispatch('quest.update',{id:'schedule-task',plannedDate:'2026-10-21'});
  assert.equal(state.quests[0].onBoard,true);
  state = await f.dispatch('quest.update',{id:'schedule-task',recurrence:weekly()},state);
  assert.equal(state.quests[0].onBoard,false);
  await assert.rejects(f.dispatch('quest.board',{id:'schedule-task',onBoard:true},state),{code:'VALIDATION'});
  state = await f.dispatch('quest.board',{id:'schedule-task',onBoard:false},state);
  state = await f.dispatch('quest.update',{id:'schedule-task',recurrence:null},state);
  assert.equal(state.quests[0].onBoard,false);
  assert.equal(state.quests[0].plannedDate,'2026-10-21');
});

test('legacy unknown start remains unknown, ordinary description edits work, and no date/history is fabricated',async t => {
  const f = await fixture(t,{intervalDays:2,nextDate:null,lastCompletedAt:null},{onBoard:true});
  await fs.writeFile(f.source,f.raw.replace('plannedDate: 2026-10-18','plannedDate: null'),'utf8');
  const before = await fs.readFile(f.source,'utf8');
  let state = await f.store.load();
  assert.equal(state.quests[0].recurrence.startDate,null);
  assert.equal(state.quests[0].recurrence.nextDate,null);
  assert.equal(state.quests[0].onBoard,false);
  assert.equal(await fs.readFile(f.source,'utf8'),before);
  state = await f.dispatch('quest.update',{id:'schedule-task',description:'Уточнение'},state);
  assert.equal(state.quests[0].recurrence.startDate,null);
  await assert.rejects(f.dispatch('quest.update',{id:'schedule-task',recurrence:{kind:'interval',intervalDays:2,startDate:'bad'}},state),{code:'VALIDATION'});
  await assert.rejects(f.dispatch('quest.status',{id:'schedule-task',status:'done'},state),{code:'VALIDATION'});
  assert.equal(state.completions.length,0);
  state = await f.dispatch('quest.update',{id:'schedule-task',title:'Новое имя',recurrence:state.quests[0].recurrence},state);
  assert.equal(state.quests[0].recurrence.startDate,null);
});

test('invalid schedules, occurrence dates and stale edits cannot partially mutate notes/history',async t => {
  const f = await fixture(t,weekly());
  const state = await f.store.load();
  const before = await fs.readFile(f.source,'utf8');
  for (const recurrence of [{kind:'bad',intervalDays:2,startDate:'2026-10-15'},{kind:'weekly',weekdays:[],startDate:'2026-10-15'},{kind:'weekly',weekdays:[9],startDate:'2026-10-15'},{kind:'interval',intervalDays:2},{kind:'interval',intervalDays:2,nextDate:'2026-10-15'},{kind:'interval',intervalDays:2,startDate:'2026-02-30'}]) await assert.rejects(f.dispatch('quest.update',{id:'schedule-task',recurrence},state),{code:'VALIDATION'});
  await assert.rejects(f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-14'},state),{code:'VALIDATION'});
  assert.equal((await f.store.load()).revision,state.revision);
  assert.equal(await fs.readFile(f.source,'utf8'),before);
  await f.dispatch('quest.status',{id:'schedule-task',status:'done',occurrenceDate:'2026-10-15'},state);
  await assert.rejects(f.dispatch('quest.update',{id:'schedule-task',recurrence:{kind:'interval',intervalDays:1,startDate:'2026-10-15'}},state),{code:'CONFLICT'});
  assert.equal((await f.store.load()).completions.length,1);
});

test('external checked checkbox closes recurrence projection without reopening the series during load or edits',async t => {
  const f = await fixture(t,weekly(),{checked:true});
  let state = await f.store.load();
  assert.equal(state.quests[0].status,'done');
  assert.equal(state.quests[0].recurrence.nextDate,null);
  assert.deepEqual(Schedule.occurrencesForQuest(state.quests[0],'2026-10-01','2026-11-01',state.completions),[]);
  assert.equal(await fs.readFile(f.source,'utf8'),f.raw);
  state = await f.dispatch('quest.update',{id:'schedule-task',title:'Уточнённая серия',recurrence:state.quests[0].recurrence},state);
  assert.equal(state.quests[0].status,'done');
  state = await f.dispatch('quest.status',{id:'schedule-task',status:'todo'},state);
  assert.equal(Schedule.occurrencesForQuest(state.quests[0],'2026-10-13','2026-10-16',state.completions).length,2);
});

test('manual recurrence fields survive calendar changes and explicit plannedDate can initialize a new rule',async t => {
  const f = await fixture(t,{...weekly(),manual_recurrence:'keep'});
  let state = await f.dispatch('quest.update',{id:'schedule-task',recurrence:{kind:'interval',intervalDays:3,startDate:'2026-10-15'}});
  const raw = await fs.readFile(f.source,'utf8');
  const fm = YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(fm.task_details['schedule-task'].recurrence.manual_recurrence,'keep');
  assert.equal(fm.task_details['schedule-task'].manual_task,'keep');
  assert.match(raw,/Ручной текст/);
  state = await f.dispatch('quest.update',{id:'schedule-task',plannedDate:'2026-10-19',recurrence:{kind:'interval',intervalDays:1}},state);
  assert.equal(state.quests[0].recurrence.startDate,'2026-10-19');
});
