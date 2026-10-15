'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const Schedule = require('../src/renderer/schedule.js');
const modulePath = path.resolve(__dirname,'../src/renderer/schedule.js');

test('legacy interval rules retain unknown starts and can anchor from an existing explicit date', () => {
  assert.deepEqual(Schedule.normalizeRecurrence({intervalDays:2,nextDate:null,lastCompletedAt:null}),{kind:'interval',intervalDays:2,startDate:null,nextDate:null,lastCompletedAt:null});
  assert.equal(Schedule.normalizeRecurrence({intervalDays:2,nextDate:'2026-10-16'}).startDate,'2026-10-16');
  assert.deepEqual(Schedule.occurrenceDates({intervalDays:2},'2026-10-01','2026-10-31'),[]);
  assert.equal(Schedule.nextOccurrence({intervalDays:2},'2026-10-15'),null);
});

test('interval rules keep a fixed anchor through months, leap days and completed occurrences', () => {
  const rule = {kind:'interval',intervalDays:2,startDate:'2024-02-27'};
  assert.deepEqual(Schedule.occurrenceDates(rule,'2024-02-26','2024-03-04'),['2024-02-27','2024-02-29','2024-03-02','2024-03-04']);
  assert.equal(Schedule.nextOccurrence(rule,'2024-02-28',['2024-02-29','2024-03-04']),'2024-03-02');
  assert.equal(Schedule.isOccurrence(rule,'2024-03-01'),false);
  assert.equal(Schedule.isOccurrence(rule,'2024-03-02'),true);
});

test('weekly ISO Tuesday/Thursday projection is inclusive and deduplicates configured days', () => {
  const rule = Schedule.validateRecurrence({kind:'weekly',weekdays:[4,2,2],startDate:'2026-10-01'});
  assert.deepEqual(rule.weekdays,[2,4]);
  assert.deepEqual(Schedule.occurrenceDates(rule,'2026-10-11','2026-10-22'),['2026-10-13','2026-10-15','2026-10-20','2026-10-22']);
  assert.equal(Schedule.isoWeekday('2026-10-18'),7);
  assert.equal(Schedule.nextOccurrence(rule,'2026-10-15',['2026-10-15','2026-10-22']),'2026-10-20');
});

test('daily rule produces one occurrence per calendar date', () => {
  const rule = {kind:'interval',intervalDays:1,startDate:'2026-10-15'};
  assert.deepEqual(Schedule.occurrenceDates(rule,'2026-10-14','2026-10-18'),['2026-10-15','2026-10-16','2026-10-17','2026-10-18']);
});

test('completed instances retain their dates after rule changes and do not duplicate projected rows', () => {
  const quest = {id:'task',status:'todo',recurrence:{kind:'weekly',weekdays:[1],startDate:'2026-10-01'}};
  const completions = [{id:'past',questId:'task',kind:'recurrence',occurrenceDate:'2026-10-15',completedAt:'2026-10-15T10:00:00Z'},{id:'monday',questId:'task',kind:'recurrence',occurrenceDate:'2026-10-19',completedAt:'2026-10-15T11:00:00Z'},{id:'legacy-unknown',questId:'task',kind:'recurrence',completedAt:'2026-10-16T11:00:00Z'}];
  const rows = Schedule.occurrencesForQuest(quest,'2026-10-13','2026-10-20',completions);
  assert.deepEqual(rows.map(row => [row.date,row.completed,row.completionId]),[['2026-10-15',true,'past'],['2026-10-19',true,'monday']]);
  assert.equal(Schedule.occurrencesForQuest({...quest,recurrence:null},'2026-10-13','2026-10-20',completions).length,2);
  assert.equal(rows.some(row => row.date === '2026-10-16'),false,'unknown legacy occurrence date is never inferred');
});

test('an externally closed recurring series projects only known history', () => {
  const quest = {id:'task',status:'done',recurrence:{kind:'interval',intervalDays:1,startDate:'2026-10-01'}};
  assert.deepEqual(Schedule.occurrencesForQuest(quest,'2026-10-01','2026-10-31'),[]);
  const rows = Schedule.occurrencesForQuest(quest,'2026-10-01','2026-10-31',[{id:'event',questId:'task',kind:'recurrence',occurrenceDate:'2026-10-10',completedAt:null}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].date,'2026-10-10');
});

test('new rules require valid explicit starts and correctly typed intervals/weekdays', () => {
  for (const rule of [undefined,{}, {kind:'unknown',intervalDays:2,startDate:'2026-10-15'}, {kind:'interval',intervalDays:0,startDate:'2026-10-15'}, {kind:'interval',intervalDays:1.5,startDate:'2026-10-15'}, {kind:'weekly',weekdays:[],startDate:'2026-10-15'}, {kind:'weekly',weekdays:[0,8],startDate:'2026-10-15'}, {kind:'weekly',weekdays:['2'],startDate:'2026-10-15'}, {kind:'interval',intervalDays:2,nextDate:'2026-10-15'}, {kind:'interval',intervalDays:2,startDate:'2026-02-30'}]) assert.throws(() => Schedule.validateRecurrence(rule),TypeError);
  assert.equal(Schedule.validateRecurrence(null),null);
  assert.equal(Schedule.validateRecurrence({kind:'interval',intervalDays:2},{plannedDate:'2026-10-15'}).startDate,'2026-10-15');
});

test('browser UMD and store CommonJS share identical calendar behavior', () => {
  const context = vm.createContext({Date});
  vm.runInContext(fs.readFileSync(modulePath,'utf8'),context);
  const browser = context.QuestSchedule;
  const rule = {kind:'weekly',weekdays:[2,4],startDate:'2026-10-01'};
  assert.deepEqual(Array.from(browser.occurrenceDates(rule,'2026-10-01','2026-10-31')),Schedule.occurrenceDates(rule,'2026-10-01','2026-10-31'));
  const nearMidnight = new Date('2026-10-14T21:30:00Z');
  assert.equal(browser.localDate(nearMidnight),Schedule.localDate(nearMidnight));
});

test('date-only arithmetic survives DST jumps and both consumers agree near local midnight', () => {
  const script = `const fs=require('node:fs'),vm=require('node:vm');const p=process.argv[1];const s=require(p);const ctx=vm.createContext({Date});vm.runInContext(fs.readFileSync(p,'utf8'),ctx);const samples=['2026-03-08T04:30:00Z','2026-03-08T05:30:00Z','2026-11-01T03:30:00Z','2026-11-01T04:30:00Z'];console.log(JSON.stringify({dates:samples.map(x=>[s.localDate(new Date(x)),ctx.QuestSchedule.localDate(new Date(x))]),spring:s.occurrenceDates({kind:'interval',intervalDays:1,startDate:'2026-03-07'},'2026-03-07','2026-03-10'),fall:s.occurrenceDates({kind:'interval',intervalDays:1,startDate:'2026-10-31'},'2026-10-31','2026-11-03')}));`;
  const result = JSON.parse(execFileSync(process.execPath,['-e',script,modulePath],{env:{...process.env,TZ:'America/New_York'},encoding:'utf8'}));
  assert.deepEqual(result.dates,[['2026-03-07','2026-03-07'],['2026-03-08','2026-03-08'],['2026-10-31','2026-10-31'],['2026-11-01','2026-11-01']]);
  assert.deepEqual(result.spring,['2026-03-07','2026-03-08','2026-03-09','2026-03-10']);
  assert.deepEqual(result.fall,['2026-10-31','2026-11-01','2026-11-02','2026-11-03']);
});
