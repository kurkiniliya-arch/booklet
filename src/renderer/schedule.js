(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuestSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const stamp = date => Date.parse(`${date}T12:00:00Z`);
  function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = stamp(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10) === value;
  }
  function dateRequired(value) { if (!isDate(value)) throw new TypeError('Укажите корректную дату.'); return value; }
  function localDate(value = new Date()) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Некорректная дата.');
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  }
  function addDays(date, days) {
    dateRequired(date);
    if (!Number.isInteger(days)) throw new TypeError('Число дней должно быть целым.');
    const result = new Date(stamp(date) + days * DAY).toISOString().slice(0,10);
    if (!isDate(result)) throw new RangeError('Дата выходит за допустимые границы.');
    return result;
  }
  function isoWeekday(date) { const day = new Date(stamp(dateRequired(date))).getUTCDay(); return day || 7; }
  function timestamp(value) { return typeof value === 'string' && /T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
  function normalizeRecurrence(value, {plannedDate = null} = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = value.kind === undefined && value.intervalDays !== undefined ? 'interval' : value.kind;
    const startDate = [value.startDate, value.nextDate, plannedDate].find(isDate) || null;
    const runtime = {startDate,nextDate:isDate(value.nextDate) ? value.nextDate : null,lastCompletedAt:timestamp(value.lastCompletedAt)};
    if (kind === 'interval' && Number.isInteger(value.intervalDays) && value.intervalDays >= 1 && value.intervalDays <= 3660) return {kind,intervalDays:value.intervalDays,...runtime};
    if (kind === 'weekly' && Array.isArray(value.weekdays) && value.weekdays.length && value.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) return {kind,weekdays:[...new Set(value.weekdays)].sort((a,b) => a-b),...runtime};
    return null;
  }
  function validateRecurrence(value, options = {}) {
    if (value === null) return null;
    const normalized = normalizeRecurrence(value,options);
    if (!normalized) throw new TypeError('Выберите повторение: каждые 1–3660 дней или дни недели.');
    if (value.startDate != null && !isDate(value.startDate)) throw new TypeError('Укажите корректную дату начала повторений.');
    const explicitStart = [value.startDate,options.plannedDate].find(isDate);
    if (!explicitStart) throw new TypeError('Выберите дату начала повторений в календаре.');
    return {...normalized,startDate:explicitStart};
  }
  function isOccurrence(value, date) {
    const rule = normalizeRecurrence(value);
    if (!rule?.startDate || !isDate(date) || date < rule.startDate) return false;
    if (rule.kind === 'weekly') return rule.weekdays.includes(isoWeekday(date));
    return Math.round((stamp(date) - stamp(rule.startDate)) / DAY) % rule.intervalDays === 0;
  }
  function firstOnOrAfter(rule, fromDate) {
    if (!rule?.startDate) return null;
    const start = fromDate > rule.startDate ? fromDate : rule.startDate;
    if (rule.kind === 'interval') {
      const distance = Math.round((stamp(start) - stamp(rule.startDate)) / DAY);
      return addDays(rule.startDate,Math.ceil(distance / rule.intervalDays) * rule.intervalDays);
    }
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(start,offset);
      if (rule.weekdays.includes(isoWeekday(date))) return date;
    }
    return null;
  }
  function occurrenceDates(value, fromDate, toDate) {
    dateRequired(fromDate);
    dateRequired(toDate);
    const rule = normalizeRecurrence(value);
    if (!rule?.startDate || toDate < fromDate) return [];
    const dates = [];
    let next = firstOnOrAfter(rule,fromDate);
    while (next && next <= toDate) {
      dates.push(next);
      if (next === '9999-12-31') break;
      next = firstOnOrAfter(rule,addDays(next,1));
    }
    return dates;
  }
  function nextOccurrence(value, fromDate, completedDates = []) {
    dateRequired(fromDate);
    const rule = normalizeRecurrence(value);
    if (!rule?.startDate) return null;
    const completed = new Set(completedDates.filter(isDate));
    let next = firstOnOrAfter(rule,fromDate);
    while (next && completed.has(next)) {
      if (next === '9999-12-31') return null;
      next = firstOnOrAfter(rule,addDays(next,1));
    }
    return next;
  }
  function occurrencesForQuest(quest, fromDate, toDate, completions = []) {
    dateRequired(fromDate);
    dateRequired(toDate);
    if (!quest || toDate < fromDate) return [];
    const rule = normalizeRecurrence(quest.recurrence,{plannedDate:quest.plannedDate});
    const events = completions.filter(event => event.questId === quest.id);
    const rows = new Map();
    if (rule) {
      if (quest.status !== 'done') for (const date of occurrenceDates(rule,fromDate,toDate)) rows.set(date,{questId:quest.id,date,completed:false,completionId:null,completedAt:null,recurring:true});
    } else if (isDate(quest.plannedDate) && quest.plannedDate >= fromDate && quest.plannedDate <= toDate) {
      const event = events.find(item => item.kind === 'quest');
      rows.set(quest.plannedDate,{questId:quest.id,date:quest.plannedDate,completed:quest.status === 'done',completionId:event?.id || null,completedAt:event?.completedAt || quest.completedAt || null,recurring:false});
    }
    // Completed occurrences remain on their own dates even after the rule changes.
    // Legacy records with an unknown occurrenceDate are kept in history, never guessed.
    for (const event of events) {
      if (event.kind !== 'recurrence' || !isDate(event.occurrenceDate) || event.occurrenceDate < fromDate || event.occurrenceDate > toDate) continue;
      rows.set(event.occurrenceDate,{questId:quest.id,date:event.occurrenceDate,completed:true,completionId:event.id,completedAt:event.completedAt || null,recurring:true});
    }
    return [...rows.values()].sort((a,b) => a.date.localeCompare(b.date));
  }
  return {normalizeRecurrence,validateRecurrence,occurrenceDates,occurrencesForQuest,nextOccurrence,isOccurrence,isDate,addDays,localDate,isoWeekday};
});
