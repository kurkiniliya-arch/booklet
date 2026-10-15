'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const YAML = require('yaml');
const Schedule = require('./renderer/schedule.js');

const META_PATH = '90 Система/Quest Book.json';
const INDEX_PATH = '90 Система/Индекс.json';
const EXCLUDED_ROOTS = new Set(['работа', 'work', '90 система']);
const EMPLOYER_IDS = /^(?:docspace(?:-|$)|docsmate(?:-|$)|jrxml-report$|career-ipr$)/i;
const VALID_STATUSES = new Set(['todo', 'in_progress', 'done']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function fail(message, code = 'VALIDATION') { const error = new Error(message); error.code = code; throw error; }
function text(value, name, {required = false, max = 100000} = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`Некорректное поле «${name}».`);
  if (required && !value.trim()) fail(`Заполните поле «${name}».`);
  return required ? value.trim() : value;
}
function validDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function date(value, name) { if (!validDate(value)) fail(`Некорректная дата «${name}».`); return value; }
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && /T/.test(value) ? value : null; }
const localDate = Schedule.localDate;
function recurrence(value, plannedDate = null) { return Schedule.normalizeRecurrence(value,{plannedDate}); }
function recurrenceRuntime(rule, id, completions, today, keepLast = true) {
  if (!rule) return null;
  const events = completions.filter(event => event.questId === id && event.kind === 'recurrence');
  const completedDates = events.map(event => event.occurrenceDate).filter(Schedule.isDate);
  const latest = events.map(event => iso(event.completedAt)).filter(Boolean).sort((a,b) => Date.parse(b) - Date.parse(a))[0];
  return {...rule,nextDate:rule.startDate ? Schedule.nextOccurrence(rule,today,completedDates) : null,lastCompletedAt:latest || (keepLast ? rule.lastCompletedAt : null)};
}
function ruleKey(rule) { return rule ? JSON.stringify([rule.kind,rule.intervalDays || null,rule.weekdays || null,rule.startDate]) : null; }
function preserveRecurrenceFields(previous, rule) {
  if (!rule) return null;
  const known = new Set(['kind','intervalDays','weekdays','startDate','nextDate','lastCompletedAt']);
  const extra = Object.fromEntries(Object.entries(asObject(previous)).filter(([key]) => !known.has(key)));
  return {...extra,...rule};
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes(':') || path.isAbsolute(value) || path.win32.isAbsolute(value)) fail('Недопустимый путь к заметке.', 'UNSAFE_PATH');
  const normalized = value.replace(/\\/g, '/');
  const pieces = normalized.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.startsWith('.') || /[<>"|?*]/.test(piece))) fail('Недопустимый путь к заметке.', 'UNSAFE_PATH');
  return pieces.join('/');
}
function inside(parent, child) { const relative = path.relative(parent, child); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
async function rejectAbsoluteLinks(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('Резервная папка не должна проходить через ссылку файловой системы.', 'UNSAFE_PATH'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
function safeName(value) {
  const result = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 90);
  return result && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) && !result.startsWith('.') ? result : 'Проект';
}
function noteContent(note) {
  if (!note.doc) return note.body;
  return `${note.bom}---${note.eol}${note.doc.toString({lineWidth:0}).replace(/\r?\n/g, note.eol).replace(new RegExp(`${note.eol === '\r\n' ? '\\r\\n' : '\\n'}$`), '')}${note.eol}---${note.eol}${note.body}`;
}
function ensureDoc(note) { if (!note.doc) { note.doc = new YAML.Document({}); note.bom = ''; } }
function setDetail(note, id, update) {
  ensureDoc(note);
  const current = asObject(note.doc.getIn(['task_details', id], true)?.toJSON());
  for (const [key, value] of Object.entries(update)) current[key] = value;
  note.doc.setIn(['task_details', id], note.doc.createNode(current));
}
function parseNote(relative, raw) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const clean = raw.slice(bom.length);
  const front = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const doc = front ? YAML.parseDocument(front[1], {strict:true, uniqueKeys:true}) : null;
  if (doc?.errors.length) fail(`Не удалось прочитать YAML в «${relative}»: ${doc.errors[0].message.split('\n')[0]}`, 'INVALID_MARKDOWN');
  const fm = asObject(doc?.toJS({maxAliasCount:100}));
  const body = front ? clean.slice(front[0].length) : clean;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(relative, '.md');
  const id = typeof fm.id === 'string' ? fm.id : `note-${hash(relative).slice(0, 20)}`;
  const tasks = [];
  let fence = null;
  const lines = body.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const fenced = lines[line].match(/^\s*(`{3,}|~{3,})/);
    if (fenced) { if (!fence) fence = fenced[1][0]; else if (fence === fenced[1][0]) fence = null; continue; }
    if (fence) continue;
    const match = lines[line].match(/^(\s*[-*+]\s+)\[([ xX])\]\s+(.+?)(?:\s+\^task-([A-Za-z0-9_-]+))?\s*$/);
    if (!match) continue;
    const taskId = match[4] || `import-${hash(`${relative}\0${match[3]}\0${tasks.length}`).slice(0, 20)}`;
    const detail = asObject(asObject(fm.task_details)[taskId]);
    tasks.push({id:taskId,line,prefix:match[1],checked:match[2].toLowerCase() === 'x',title:match[3],anchored:!!match[4],detail});
  }
  return {relative,raw,bom,doc,fm,body,eol,title,id,tasks};
}
function description(note) {
  const lines = note.body.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^##\s+(?:Источники|Материалы|Связи)\s*$/i.test(line)) break;
    if (/^#\s/.test(line) || /^\s*[-*+]\s+\[[ xX]\]/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}
function groupDescription(note) {
  const managed = note.body.match(/<!-- quest-book:description:start -->\r?\n([\s\S]*?)\r?\n<!-- quest-book:description:end -->/);
  return managed ? managed[1] : typeof note.fm.quest_book_description === 'string' ? note.fm.quest_book_description : null;
}
function editGroupDescription(note, next, previous) {
  const block = `<!-- quest-book:description:start -->${note.eol}${next}${note.eol}<!-- quest-book:description:end -->`;
  if (/<!-- quest-book:description:start -->[\s\S]*?<!-- quest-book:description:end -->/.test(note.body)) {
    note.body = note.body.replace(/<!-- quest-book:description:start -->[\s\S]*?<!-- quest-book:description:end -->/, () => block);
  } else if (previous && note.body.includes(previous)) {
    note.body = note.body.replace(previous,() => block);
  } else {
    const heading = note.body.match(/^#\s+.+(?:\r?\n|$)/m);
    const position = heading ? heading.index + heading[0].length : 0;
    note.body = `${note.body.slice(0,position)}${note.eol}${block}${note.eol}${note.body.slice(position)}`;
  }
}
function taskDescription(note, detail) {
  if (typeof detail.description === 'string') return detail.description;
  const pieces = [];
  if (typeof detail.next_action === 'string' && detail.next_action) pieces.push(`С чего начать: ${detail.next_action}`);
  if (typeof detail.done_when === 'string' && detail.done_when) pieces.push(`Готово, когда: ${detail.done_when}`);
  if (Array.isArray(detail.steps) && detail.steps.length) {
    const existing = detail.steps.filter(step => typeof step?.text === 'string').map((step, i) => `${i + 1}. ${step.text}`);
    if (existing.length) pieces.push(`Шаги:\n${existing.join('\n')}`);
  }
  if (pieces.length) return pieces.join('\n\n');
  return note.body.split(/\r?\n/).find(line => line.trim() && !/^\s*(?:#|[-*+]\s+\[|<!--)/.test(line))?.trim() || '';
}
function editCheckbox(note, task, {title = task.title, checked = task.checked, remove = false} = {}) {
  const lines = note.body.split(/\r?\n/);
  if (remove) lines.splice(task.line, 1);
  else lines[task.line] = `${task.prefix}[${checked ? 'x' : ' '}] ${title} ^task-${task.id}`;
  note.body = lines.join(note.eol);
}
function appendTask(note, id, title, detail) {
  const line = `- [ ] ${title} ^task-${id}${note.eol}`;
  const sourceHeading = note.body.search(/^##\s+Источники\s*$/m);
  if (sourceHeading >= 0) note.body = `${note.body.slice(0, sourceHeading).replace(/\s*$/, '')}${note.eol}${note.eol}${line}${note.eol}${note.body.slice(sourceHeading)}`;
  else note.body = `${note.body.replace(/\s*$/, '')}${note.eol}${note.eol}${line}`;
  setDetail(note, id, detail);
}

class QuestStore {
  constructor(vaultPath, options = {}) {
    this.vaultPath = vaultPath ? path.resolve(vaultPath) : null;
    this.bootstrapFile = options.bootstrapFile || null;
    this.now = options.now || (() => new Date());
    this.backupRoot = options.backupRoot || (this.vaultPath ? path.join(os.homedir(), 'Quest Book Backups', hash(this.vaultPath).slice(0, 16)) : null);
    this.queue = Promise.resolve();
    this.closed = false;
  }
  _enqueue(callback) {
    const result = this.queue.then(() => { if (this.closed) fail('Хранилище закрыто.', 'CLOSED'); return callback(); });
    this.queue = result.catch(() => {});
    return result;
  }
  load() { return this._enqueue(() => this._load()); }
  dispatch(command) { return this._enqueue(() => this._dispatch(command)); }
  async close() { await this.queue; this.closed = true; }

  async _path(relative, {createParents = false} = {}) {
    relative = relativePath(relative);
    const parts = relative.split('/');
    let current = this.vaultPath;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (createParents && i < parts.length - 1) { await fs.mkdir(current); stat = await fs.lstat(current); }
        else continue;
      }
      if (stat?.isSymbolicLink()) fail(`Ссылка файловой системы запрещена: «${relative}».`, 'UNSAFE_PATH');
      if (i < parts.length - 1 && stat && !stat.isDirectory()) fail(`Папка недоступна: «${relative}».`, 'UNSAFE_PATH');
      if (i === parts.length - 1 && stat && !stat.isFile()) fail(`Ожидался файл: «${relative}».`, 'UNSAFE_PATH');
    }
    if (!inside(this.vaultPath, current)) fail('Путь за пределами хранилища.', 'UNSAFE_PATH');
    return current;
  }
  async _readOptional(relative) {
    const full = await this._path(relative);
    try { return await fs.readFile(full, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async _scan() {
    const rootStat = await fs.lstat(this.vaultPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Выберите обычную папку хранилища Obsidian.', 'UNSAFE_PATH');
    const warnings = [];
    const notes = [];
    const fingerprint = [];
    const walk = async (directory, prefix = '') => {
      const entries = (await fs.readdir(directory, {withFileTypes:true})).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || (!prefix && EXCLUDED_ROOTS.has(entry.name.toLocaleLowerCase('ru')))) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { warnings.push(`Пропущена ссылка файловой системы: ${relative}`); continue; }
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const raw = await this._readOptional(relative);
          fingerprint.push([relative, hash(raw)]);
          try {
            const note = parseNote(relative, raw);
            if (!EMPLOYER_IDS.test(note.id) && !/^(?:работа|work)$/i.test(note.fm.area || '')) notes.push(note);
          } catch (error) { warnings.push(error.message); }
        }
      }
    };
    await walk(this.vaultPath);
    const metadataRaw = await this._readOptional(META_PATH);
    const indexRaw = await this._readOptional(INDEX_PATH);
    let index = null;
    if (indexRaw !== null) {
      try { const parsed = JSON.parse(indexRaw); if (parsed.schema_version === 3 && Array.isArray(parsed.projects)) index = parsed; else warnings.push('Индекс.json имеет другой формат: задания читаются из Markdown, старый индекс не изменяется.'); }
      catch { warnings.push('Индекс.json повреждён: задания читаются из Markdown, старый индекс не изменяется.'); }
    }
    let metadata = null;
    if (metadataRaw !== null) {
      try { metadata = JSON.parse(metadataRaw); } catch { fail('Файл Quest Book.json повреждён. Исходные заметки сохранены; восстановите файл из резервной копии.', 'INVALID_METADATA'); }
      if (metadata.version !== 1 || !Array.isArray(metadata.projects) || !Array.isArray(metadata.completions)) fail('Неизвестный формат Quest Book.json.', 'INVALID_METADATA');
    }
    fingerprint.push([META_PATH, metadataRaw === null ? null : hash(metadataRaw)]);
    fingerprint.push([INDEX_PATH, indexRaw === null ? null : hash(indexRaw)]);
    return {notes,metadata,metadataRaw,index,indexRaw,warnings,revision:hash(JSON.stringify(fingerprint))};
  }
  _freshMetadata() { return {version:1,projects:[],questProjects:{},deletedQuestIds:[],deletedProjectIds:[],excludedPaths:[],completions:[],taskOverrides:{},taskObservations:{}}; }
  _fallbackGroup(metadata, note) {
    const root = note.relative.includes('/') ? note.relative.split('/')[0] : 'Личные проекты';
    const id = `group-${hash(root).slice(0, 16)}`;
    if (metadata.deletedProjectIds.includes(id)) return null;
    let project = metadata.projects.find(item => item.id === id);
    if (!project) { project = {id,title:root,description:'',sourceIds:[],sourcePaths:[]}; metadata.projects.push(project); }
    if (!project.sourceIds.includes(note.id)) project.sourceIds.push(note.id);
    if (!project.sourcePaths.includes(note.relative)) project.sourcePaths.push(note.relative);
    return project;
  }
  _groupFor(metadata, note) {
    if (metadata.excludedPaths.includes(note.relative)) return null;
    return metadata.projects.find(project => project.notePath === note.relative || project.sourcePaths?.includes(note.relative) || project.sourceIds?.includes(note.id)) || this._fallbackGroup(metadata, note);
  }
  async _initialize(scan) {
    const metadata = this._freshMetadata();
    let bootstrap = {};
    if (this.bootstrapFile) {
      try { bootstrap = JSON.parse(await fs.readFile(this.bootstrapFile, 'utf8')); } catch { fail('Не удалось прочитать начальную структуру проектов.', 'INVALID_BOOTSTRAP'); }
    }
    const ids = new Set();
    for (const item of bootstrap.projects || []) {
      const id = text(item.id, 'ID проекта', {required:true,max:150});
      if (ids.has(id)) fail('Повторяется ID проекта в начальной структуре.', 'INVALID_BOOTSTRAP');
      ids.add(id);
      const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds.filter(value => typeof value === 'string' && !EMPLOYER_IDS.test(value)) : [];
      metadata.projects.push({id,title:text(item.title,'Название',{required:true,max:500}),description:typeof item.description === 'string' ? item.description : '',sourceIds,sourcePaths:scan.notes.filter(note => sourceIds.includes(note.id)).map(note => note.relative)});
    }
    metadata.taskOverrides = asObject(bootstrap.taskOverrides);
    for (const [id,override] of Object.entries(metadata.taskOverrides)) {
      const note = scan.notes.find(value => value.tasks.some(task => task.id === id));
      const task = note?.tasks.find(value => value.id === id);
      if (task && override && typeof override === 'object') {
        override.sourceTitle = task.title;
        override.sourceDescription = taskDescription(note,task.detail);
      } else delete metadata.taskOverrides[id];
    }
    for (const note of scan.notes) this._groupFor(metadata, note);
    const writes = new Map();
    for (const item of bootstrap.extraQuests || []) {
      if (!metadata.projects.some(project => project.id === item.projectId)) continue;
      const id = text(item.id,'ID задания',{required:true,max:150});
      if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('Недопустимый ID задания в начальной структуре.', 'INVALID_BOOTSTRAP');
      if (scan.notes.some(note => note.tasks.some(task => task.id === id))) continue;
      const project = metadata.projects.find(value => value.id === item.projectId);
      const note = scan.notes.find(value => value.id === item.sourceId) || await this._groupNote(project, scan, writes);
      const now = this.now().toISOString();
      appendTask(note, id, text(item.title,'Название',{required:true,max:1000}), {description:typeof item.description === 'string' ? item.description : '',status:'todo',onBoard:false,urgent:false,plannedDate:null,dueDate:null,createdAt:now,updatedAt:now,completedAt:null,recurrence:recurrence(item.recurrence)});
      writes.set(note.relative,{original:note.raw,content:noteContent(note)});
      metadata.questProjects[id] = project.id;
    }
    this._observe(metadata,scan.notes,writes,true);
    writes.set(META_PATH,{original:null,content:JSON.stringify(metadata,null,2) + '\n'});
    this._syncIndex(scan,writes);
    await this._commit(writes, scan.revision);
    return this._scan();
  }
  _state(scan) {
    const metadata = scan.metadata;
    metadata.questProjects = asObject(metadata.questProjects);
    metadata.deletedQuestIds ||= [];
    metadata.deletedProjectIds ||= [];
    metadata.excludedPaths ||= [];
    metadata.taskOverrides = asObject(metadata.taskOverrides);
    const quests = [];
    const materials = [];
    const warnings = [...scan.warnings];
    const seen = new Set();
    for (const note of scan.notes) {
      const group = this._groupFor(metadata,note);
      if (group && note.relative !== group.notePath) materials.push({id:note.id,projectId:group.id,title:note.title,description:description(note),path:note.relative});
      for (const task of note.tasks) {
        if (metadata.deletedQuestIds.includes(task.id)) continue;
        if (seen.has(task.id)) { warnings.push(`Повторяется ID задания ${task.id}; проверьте заметку «${note.relative}».`); continue; }
        seen.add(task.id);
        const detail = task.detail;
        const override = asObject(metadata.taskOverrides[task.id]);
        const assignedId = metadata.questProjects[task.id];
        if (assignedId && metadata.deletedProjectIds.includes(assignedId)) continue;
        const projectId = metadata.projects.some(project => project.id === assignedId) ? assignedId : group?.id;
        if (!projectId) continue;
        const schedule = recurrenceRuntime(recurrence(detail.recurrence,detail.plannedDate),task.id,metadata.completions,localDate(this.now()));
        const status = task.checked ? 'done' : detail.status === 'in_progress' ? 'in_progress' : 'todo';
        const observation = asObject(asObject(metadata.taskObservations)[task.id]);
        const doneAt = task.checked && observation.invalidCompletedAt !== detail.completedAt ? iso(detail.completedAt) : null;
        const sourceDescription = taskDescription(note,detail);
        quests.push({id:task.id,projectId,title:typeof override.title === 'string' && override.sourceTitle === task.title ? override.title : task.title,description:typeof detail.description === 'string' ? detail.description : typeof override.description === 'string' && override.sourceDescription === sourceDescription ? override.description : sourceDescription,status,onBoard:!schedule && detail.onBoard === true,urgent:detail.urgent === true,plannedDate:validDate(detail.plannedDate) ? detail.plannedDate : null,dueDate:validDate(detail.dueDate) ? detail.dueDate : validDate(detail.deadline) ? detail.deadline : null,createdAt:iso(detail.createdAt),updatedAt:iso(detail.updatedAt),completedAt:doneAt,sourcePath:note.relative,recurrence:schedule && status === 'done' ? {...schedule,nextDate:null} : schedule});
      }
    }
    const projects = metadata.projects.filter(project => !metadata.deletedProjectIds.includes(project.id)).map(project => {
      const note = scan.notes.find(value => value.relative === project.notePath);
      const projectDescription = note ? groupDescription(note) : null;
      return {id:project.id,title:note?.title || project.title,description:projectDescription ?? project.description ?? ''};
    });
    const completions = metadata.completions.filter(event => projects.some(project => project.id === event.projectId) && (event.kind === 'recurrence' || quests.some(quest => quest.id === event.questId && (quest.status === 'done' || quest.recurrence)))).map(clone);
    for (const quest of quests) {
      if (quest.status === 'done' && !completions.some(event => event.questId === quest.id && event.kind === 'quest')) completions.push({id:`import-completion-${quest.id}`,questId:quest.id,projectId:quest.projectId,title:quest.title,description:quest.description,completedAt:quest.completedAt,kind:'quest'});
    }
    return {version:1,revision:scan.revision,projects,quests,materials,completions,connection:{connected:true,vaultPath:this.vaultPath,lastSync:this.now().toISOString(),warnings}};
  }
  async _load() {
    if (!this.vaultPath) return {version:1,revision:'disconnected',projects:[],quests:[],materials:[],completions:[],connection:{connected:false,vaultPath:null,lastSync:null,warnings:[]}};
    let scan = await this._scan();
    if (!scan.metadata) scan = await this._initialize(scan);
    else if (this._observe(scan.metadata,scan.notes)) {
      await this._commit(new Map([[META_PATH,{original:scan.metadataRaw,content:JSON.stringify(scan.metadata,null,2) + '\n'}]]),scan.revision);
      scan = await this._scan();
    }
    return this._state(scan);
  }
  _observe(metadata,notes,writes = new Map(),fromApplication = false) {
    const before = JSON.stringify([metadata.taskObservations,metadata.completions]);
    metadata.taskObservations = asObject(metadata.taskObservations);
    for (let note of notes) {
      if (writes.has(note.relative)) note = parseNote(note.relative,writes.get(note.relative).content);
      for (const task of note.tasks) {
        const previous = asObject(metadata.taskObservations[task.id]);
        let invalidCompletedAt = previous.invalidCompletedAt || null;
        if (!fromApplication && previous.checked === true && !task.checked) {
          invalidCompletedAt = iso(task.detail.completedAt);
          metadata.completions = metadata.completions.filter(event => !(event.questId === task.id && event.kind === 'quest'));
        }
        if (fromApplication && writes.has(note.relative) && task.detail.completedAt !== invalidCompletedAt) invalidCompletedAt = null;
        metadata.taskObservations[task.id] = {checked:task.checked,invalidCompletedAt};
      }
    }
    return before !== JSON.stringify([metadata.taskObservations,metadata.completions]);
  }
  async _groupNote(project, scan, writes) {
    if (project.notePath) {
      const existing = scan.notes.find(note => note.relative === project.notePath);
      if (existing) return existing;
      if (await this._readOptional(project.notePath) !== null) fail('Заметка проекта не может быть безопасно изменена.', 'INVALID_MARKDOWN');
    }
    if (EXCLUDED_ROOTS.has(safeName(project.title).toLocaleLowerCase('ru'))) fail('Это название зарезервировано для служебной или рабочей папки. Выберите другое название.');
    let relative = project.notePath || `${safeName(project.title)}/Задания.md`;
    if (!project.notePath && await this._readOptional(relative) !== null) relative = `${safeName(project.title)}/Задания ${hash(project.id).slice(0,8)}.md`;
    if (await this._readOptional(relative) !== null) fail('Невозможно создать заметку проекта: имя занято.', 'CONFLICT');
    const raw = `---\nid: ${JSON.stringify(`quest-book-${project.id}`)}\nquest_book_project: ${JSON.stringify(project.id)}\nquest_book_title: ${JSON.stringify(project.title)}\nquest_book_description: ${JSON.stringify(project.description || '')}\n---\n\n# ${project.title}\n\n<!-- quest-book:description:start -->\n${project.description || ''}\n<!-- quest-book:description:end -->\n`;
    const note = parseNote(relative,raw);
    note.raw = null;
    project.notePath = relative;
    project.sourcePaths ||= [];
    if (!project.sourcePaths.includes(relative)) project.sourcePaths.push(relative);
    scan.notes.push(note);
    writes.set(relative,{original:null,content:noteContent(note)});
    return note;
  }
  async _dispatch(command) {
    if (!this.vaultPath) fail('Сначала выберите хранилище Obsidian.', 'DISCONNECTED');
    if (!command || typeof command !== 'object' || !asObject(command.payload)) fail('Некорректная команда.');
    let scan = await this._scan();
    if (!scan.metadata) scan = await this._initialize(scan);
    if (typeof command.revision !== 'string' || command.revision !== scan.revision) fail('Заметки изменились. Обновите книгу и повторите изменение; ваш черновик сохранён.', 'CONFLICT');
    const state = this._state(scan);
    const metadata = scan.metadata;
    const writes = new Map();
    const payload = asObject(command.payload);
    const stamp = this.now();
    const now = stamp.toISOString();
    const lookupProject = id => { const project = metadata.projects.find(value => value.id === id && !metadata.deletedProjectIds.includes(id)); if (!project) fail('Проект не найден.', 'NOT_FOUND'); return project; };
    const lookupQuest = id => {
      const quest = state.quests.find(value => value.id === id);
      if (!quest) fail('Задание не найдено.', 'NOT_FOUND');
      const found = scan.notes.flatMap(note => note.tasks.filter(task => task.id === id).map(task => ({note,task})));
      if (found.length !== 1) fail('ID задания повторяется в заметках. Сначала устраните дубликат.', 'DUPLICATE_ID');
      return {quest,...found[0]};
    };
    const saveNote = note => writes.set(note.relative,{original:note.raw,content:noteContent(note)});
    const title = value => { const result = text(value,'Название',{required:true,max:1000}); if (/[\r\n]/.test(result)) fail('Название должно занимать одну строку.'); return result; };
    const descriptionText = value => text(value,'Описание');
    const fields = p => {
      const result = {};
      if (own(p,'description')) result.description = descriptionText(p.description);
      if (own(p,'urgent')) { if (typeof p.urgent !== 'boolean') fail('Некорректный признак срочности.'); result.urgent = p.urgent; }
      if (own(p,'plannedDate')) result.plannedDate = date(p.plannedDate,'Запланировано');
      if (own(p,'dueDate')) {
        result.dueDate = date(p.dueDate,'Срок');
        result.deadline = result.dueDate;
        result.deadline_status = result.dueDate ? 'confirmed' : 'unknown';
      }
      return result;
    };
    const editRecurrence = (value, id, previous, priorRule, payload) => {
      if (value === null) return null;
      let rule;
      try { rule = Schedule.validateRecurrence(value,{plannedDate:own(payload,'plannedDate') ? payload.plannedDate : null}); }
      catch (error) {
        const normalized = recurrence(value);
        if (normalized && priorRule && value.startDate == null && !normalized.startDate && ruleKey(normalized) === ruleKey(priorRule)) rule = priorRule;
        else fail(error.message);
      }
      rule.lastCompletedAt = priorRule?.lastCompletedAt || null;
      return preserveRecurrenceFields(previous,recurrenceRuntime(rule,id,metadata.completions,localDate(stamp)));
    };
    const changeStatus = ({quest,note,task}, status, occurrenceDate) => {
      if (occurrenceDate !== undefined && (!quest.recurrence || status !== 'done')) fail('Дата появления применяется только к выполнению повторяющегося задания.');
      if (quest.status === status && !(quest.recurrence && status === 'done')) return false;
      if (quest.recurrence && status === 'done') {
        if (quest.status === 'done') fail('Серия закрыта. Сначала возобновите её, чтобы отмечать отдельные появления.');
        const chosenDate = occurrenceDate === undefined ? quest.recurrence.nextDate : occurrenceDate;
        if (!quest.recurrence.startDate) fail('Сначала выберите дату начала повторений в календаре.');
        if (!Schedule.isDate(chosenDate) || !Schedule.isOccurrence(quest.recurrence,chosenDate)) fail('Выберите дату, которая входит в расписание задания.');
        if (metadata.completions.some(event => event.questId === quest.id && event.kind === 'recurrence' && event.occurrenceDate === chosenDate)) return false;
        const event = {id:`completion-${crypto.randomUUID()}`,questId:quest.id,projectId:quest.projectId,title:quest.title,description:quest.description,completedAt:now,kind:'recurrence',occurrenceDate:chosenDate};
        metadata.completions.push(event);
        editCheckbox(note,task,{checked:false});
        const nextRule = recurrenceRuntime(quest.recurrence,quest.id,metadata.completions,localDate(stamp));
        setDetail(note,quest.id,{status:'todo',onBoard:false,completedAt:null,updatedAt:now,recurrence:preserveRecurrenceFields(task.detail.recurrence,nextRule)});
      } else {
        metadata.completions = metadata.completions.filter(event => !(event.questId === quest.id && event.kind === 'quest'));
        if (status === 'done') metadata.completions.push({id:`completion-${crypto.randomUUID()}`,questId:quest.id,projectId:quest.projectId,title:quest.title,description:quest.description,completedAt:now,kind:'quest'});
        editCheckbox(note,task,{checked:status === 'done'});
        setDetail(note,quest.id,{status,completedAt:status === 'done' ? now : null,updatedAt:now});
        metadata.taskObservations[quest.id] = {checked:status === 'done',invalidCompletedAt:null};
      }
      return true;
    };
    switch (command.type) {
      case 'project.create': {
        const project = {id:`project-${crypto.randomUUID()}`,title:title(payload.title),description:descriptionText(payload.description ?? ''),sourceIds:[],sourcePaths:[]};
        metadata.projects.push(project);
        await this._groupNote(project,scan,writes);
        break;
      }
      case 'project.update': {
        const project = lookupProject(payload.id);
        const previousDescription = state.projects.find(value => value.id === project.id).description;
        project.description = previousDescription;
        if (own(payload,'title')) project.title = title(payload.title);
        if (own(payload,'description')) project.description = descriptionText(payload.description);
        const note = await this._groupNote(project,scan,writes);
        ensureDoc(note);
        note.doc.set('quest_book_title',project.title);
        note.doc.set('quest_book_description',project.description);
        if (own(payload,'description')) editGroupDescription(note,project.description,previousDescription);
        const lines = note.body.split(/\r?\n/);
        const heading = lines.findIndex(line => /^#\s+/.test(line));
        if (heading >= 0) lines[heading] = `# ${project.title}`;
        note.body = lines.join(note.eol);
        saveNote(note);
        break;
      }
      case 'project.delete': {
        const project = lookupProject(payload.id);
        metadata.deletedProjectIds.push(project.id);
        for (const material of state.materials.filter(value => value.projectId === project.id)) if (!metadata.excludedPaths.includes(material.path)) metadata.excludedPaths.push(material.path);
        if (project.notePath && !metadata.excludedPaths.includes(project.notePath)) metadata.excludedPaths.push(project.notePath);
        for (const quest of state.quests.filter(value => value.projectId === project.id)) metadata.questProjects[quest.id] = project.id;
        metadata.projects = metadata.projects.filter(value => value.id !== project.id);
        break;
      }
      case 'quest.create': {
        const project = lookupProject(payload.projectId);
        const questTitle = title(payload.title);
        const newFields = fields(payload);
        const id = `quest-${crypto.randomUUID()}`;
        if (own(payload,'recurrence')) newFields.recurrence = editRecurrence(payload.recurrence,id,null,null,payload);
        let note;
        if (payload.sourcePath != null) {
          const relative = relativePath(payload.sourcePath);
          note = scan.notes.find(value => value.relative === relative);
          if (!note || !state.materials.some(value => value.path === relative && value.projectId === project.id)) fail('Выберите материал этого проекта.', 'UNSAFE_PATH');
        } else note = await this._groupNote(project,scan,writes);
        appendTask(note,id,questTitle,{description:'',status:'todo',onBoard:false,urgent:false,plannedDate:null,dueDate:null,createdAt:now,updatedAt:now,completedAt:null,...newFields});
        metadata.questProjects[id] = project.id;
        saveNote(note);
        break;
      }
      case 'quest.update': {
        const {quest,note,task} = lookupQuest(payload.id);
        const update = {...fields(payload),updatedAt:now};
        if (own(payload,'recurrence')) {
          update.recurrence = editRecurrence(payload.recurrence,quest.id,task.detail.recurrence,quest.recurrence,payload);
          if (update.recurrence || quest.recurrence) update.onBoard = false;
          if (update.recurrence && !quest.recurrence && task.checked) { editCheckbox(note,task,{checked:false}); update.status = 'todo'; update.completedAt = null; }
        }
        if (own(payload,'projectId')) { lookupProject(payload.projectId); metadata.questProjects[quest.id] = payload.projectId; }
        if (own(payload,'title')) { editCheckbox(note,task,{title:title(payload.title),checked:update.status === 'todo' ? false : task.checked}); if (metadata.taskOverrides[quest.id]) delete metadata.taskOverrides[quest.id].title; }
        else if (!task.anchored) editCheckbox(note,task,{checked:update.status === 'todo' ? false : task.checked});
        if (own(payload,'description') && metadata.taskOverrides[quest.id]) delete metadata.taskOverrides[quest.id].description;
        setDetail(note,quest.id,update);
        for (const event of metadata.completions.filter(value => value.questId === quest.id && value.kind === 'quest')) {
          if (own(payload,'projectId')) event.projectId = payload.projectId;
          if (own(payload,'title')) event.title = payload.title.trim();
          if (own(payload,'description')) event.description = payload.description;
        }
        saveNote(note);
        break;
      }
      case 'quest.status': {
        if (!VALID_STATUSES.has(payload.status)) fail('Неизвестный статус задания.');
        const target = lookupQuest(payload.id);
        if (changeStatus(target,payload.status,payload.occurrenceDate)) saveNote(target.note);
        break;
      }
      case 'quest.board': {
        if (typeof payload.onBoard !== 'boolean') fail('Некорректный признак размещения на доске.');
        const hasStatus = own(payload,'status');
        if (hasStatus && !payload.onBoard) fail('При удалении с доски нельзя менять статус задания.');
        if (hasStatus && !VALID_STATUSES.has(payload.status)) fail('Неизвестный статус задания.');
        const target = lookupQuest(payload.id);
        if (payload.onBoard && target.quest.recurrence) fail('Повторяющиеся задания планируются в календаре, а не на доске.');
        const statusChanged = hasStatus && changeStatus(target,payload.status);
        if (target.quest.onBoard !== payload.onBoard || target.task.detail.onBoard === true && !payload.onBoard || statusChanged) {
          if (!target.task.anchored && !statusChanged) editCheckbox(target.note,target.task);
          setDetail(target.note,target.quest.id,{onBoard:payload.onBoard});
          saveNote(target.note);
        }
        break;
      }
      case 'quest.delete': {
        const {quest,note,task} = lookupQuest(payload.id);
        editCheckbox(note,task,{remove:true});
        if (note.doc?.hasIn(['task_details',quest.id])) note.doc.deleteIn(['task_details',quest.id]);
        metadata.deletedQuestIds.push(quest.id);
        metadata.completions = metadata.completions.filter(event => event.questId !== quest.id);
        delete metadata.taskOverrides[quest.id];
        saveNote(note);
        break;
      }
      case 'completion.undo': {
        const event = state.completions.find(value => value.id === payload.id);
        if (!event) fail('Запись истории не найдена.', 'NOT_FOUND');
        const {quest,note,task} = lookupQuest(event.questId);
        metadata.completions = metadata.completions.filter(value => value.id !== event.id);
        if (event.kind === 'recurrence') {
          if (quest.recurrence) {
            const nextRule = recurrenceRuntime(quest.recurrence,quest.id,metadata.completions,localDate(stamp),false);
            setDetail(note,quest.id,{updatedAt:now,recurrence:preserveRecurrenceFields(task.detail.recurrence,nextRule)});
            saveNote(note);
          }
        } else {
          editCheckbox(note,task,{checked:false});
          setDetail(note,quest.id,{status:'todo',updatedAt:now,completedAt:null});
          saveNote(note);
        }
        break;
      }
      default: fail('Неизвестная команда.');
    }
    this._observe(metadata,scan.notes,writes,true);
    writes.set(META_PATH,{original:scan.metadataRaw,content:JSON.stringify(metadata,null,2) + '\n'});
    this._syncIndex(scan,writes);
    await this._commit(writes,scan.revision);
    return this._load();
  }
  _syncIndex(scan,writes) {
    if (!scan.index) return;
    const index = clone(scan.index);
    let changed = false;
    for (const [relative,value] of writes) {
      if (!/\.md$/i.test(relative)) continue;
      const note = parseNote(relative,value.content);
      let project = index.projects.find(item => item.path === relative);
      if (!project) {
        project = {id:note.id,type:'project',area:relative.includes('/') ? relative.split('/')[0] : '',title:note.title,path:relative,status:'active',updated:localDate(this.now()),evidence_date:localDate(this.now()),depends_on:[],related:[],relations:[],sources:[],tasks:[],source_ids:[],merged_ids:[]};
        index.projects.push(project);
        if (project.area && Array.isArray(index.areas) && !index.areas.some(area => area.name === project.area)) index.areas.push({name:project.area,directory:`${project.area}/`});
      }
      const oldTasks = Array.isArray(project.tasks) ? project.tasks : [];
      project.tasks = note.tasks.map(task => ({...asObject(oldTasks.find(item => item.id === task.id)),...task.detail,id:task.id,text:task.title,state:task.checked ? 'done' : 'open',block_id:`task-${task.id}`}));
      project.updated = localDate(this.now());
      project.title = note.title;
      changed = true;
    }
    if (changed) {
      index.generated_at = localDate(this.now());
      writes.set(INDEX_PATH,{original:scan.indexRaw,content:JSON.stringify(index,null,2) + '\n'});
    }
  }
  async _commit(writes, expectedRevision) {
    if (inside(this.vaultPath,path.resolve(this.backupRoot))) fail('Резервные копии должны находиться вне хранилища.', 'UNSAFE_PATH');
    await rejectAbsoluteLinks(this.backupRoot);
    if ((await this._scan()).revision !== expectedRevision) fail('Файлы изменились во время сохранения. Повторите действие после обновления.', 'CONFLICT');
    const changes = [...writes].filter(([,value]) => value.original !== value.content);
    if (!changes.length) return;
    const backupDirectory = path.join(this.backupRoot,`${this.now().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`);
    await fs.mkdir(backupDirectory,{recursive:true});
    await rejectAbsoluteLinks(backupDirectory);
    const manifest = {createdAt:this.now().toISOString(),files:changes.map(([relative,value]) => ({path:relative,existed:value.original !== null}))};
    for (const [relative,value] of changes) {
      await this._path(relative);
      const current = await this._readOptional(relative);
      if (current !== value.original) fail('Файл изменился перед сохранением. Изменения не применены.', 'CONFLICT');
      if (value.original !== null) {
        const backupFile = path.join(backupDirectory,...relative.split('/'));
        await fs.mkdir(path.dirname(backupFile),{recursive:true});
        await fs.writeFile(backupFile,value.original,{encoding:'utf8',flag:'wx'});
      }
    }
    await fs.writeFile(path.join(backupDirectory,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
    const applied = [];
    try {
      for (const [relative,value] of changes) {
        if (await this._readOptional(relative) !== value.original) fail('Файл изменился во время сохранения.', 'CONFLICT');
        const full = await this._path(relative,{createParents:true});
        const temporary = path.join(path.dirname(full),`.quest-book-${crypto.randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary,value.content,{encoding:'utf8',flag:'wx'});
          await this._path(relative);
          if (await this._readOptional(relative) !== value.original) fail('Файл изменился во время сохранения.', 'CONFLICT');
          await fs.rename(temporary,full);
          applied.push([relative,value]);
        } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
    } catch (error) {
      for (const [relative,value] of applied.reverse()) {
        try {
          if (await this._readOptional(relative) !== value.content) continue;
          const full = await this._path(relative);
          if (value.original !== null) await fs.writeFile(full,value.original,'utf8');
          else {
            const recover = path.join(backupDirectory,'created-during-rollback',...relative.split('/'));
            await fs.mkdir(path.dirname(recover),{recursive:true});
            await fs.rename(full,recover);
          }
        } catch { /* Original bytes are retained in the transaction backup. */ }
      }
      throw error;
    }
  }
}

module.exports = {QuestStore};
