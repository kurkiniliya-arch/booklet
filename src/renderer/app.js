'use strict';

(() => {
  const api = window.questBook;
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const materialExcerpt = value => String(value || 'Материал из хранилища Obsidian.').split(/^##\s/m)[0].replace(/\*\*([^*]+)\*\*/g, '$1').trim();
  const statusNames = { todo: 'К выполнению', in_progress: 'В процессе', done: 'Сделано' };
  const emptyState = { projects: [], quests: [], materials: [], completions: [], connection: { connected: false, warnings: [] } };
  let data = emptyState;
  let view = 'journal';
  let selectedProject = null;
  let selectedQuest = null;
  let selectedCompletion = null;
  let expanded = null;
  let query = '';
  let historyFilters = { query: '', projectId: '', from: '', to: '' };
  let boardFilters = { query: '', projectId: '', urgent: false };
  let selectedDay = today();
  let month = selectedDay.slice(0, 7);
  let draft = null;
  let dialogMode = null;
  let confirmation = null;
  let scheduleSelection = null;
  let busy = false;
  let open = true;
  let noticeTimer;

  function today() { return timestampDay(new Date().toISOString()); }
  function timestampDay(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  }
  function readableDate(value, options = {}) {
    if (!value) return 'Дата неизвестна';
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
    if (Number.isNaN(date.getTime())) return 'Дата неизвестна';
    return date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', ...options });
  }
  function shortDate(value) { return readableDate(value, { month: 'short' }); }
  function addDays(value, days) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
  function projectById(id) { return data.projects.find(project => project.id === id); }
  function questById(id) { return data.quests.find(quest => quest.id === id); }
  function projectName(id) { return projectById(id)?.title || 'Без проекта'; }
  function connected() { return Boolean(data.connection?.connected); }
  function matches(value, term) { return String(value || '').toLocaleLowerCase('ru').includes(term.toLocaleLowerCase('ru')); }
  function questsFor(id) { return data.quests.filter(quest => quest.projectId === id); }
  function sortQuests(quests) { return [...quests].sort((a, b) => Number(b.urgent) - Number(a.urgent) || String(a.plannedDate || '9999').localeCompare(String(b.plannedDate || '9999'))); }
  function dateEvents(day) { return sortQuests(data.quests.filter(quest => quest.status !== 'done' && (quest.plannedDate === day || quest.dueDate === day))); }
  function optionsForProjects(selected, all = false) { return `${all ? '<option value="">Все проекты</option>' : ''}${data.projects.map(project => `<option value="${esc(project.id)}" ${project.id === selected ? 'selected' : ''}>${esc(project.title)}</option>`).join('')}`; }
  function statusOptions(selected) { return Object.entries(statusNames).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }
  function badge(quest) { return `<span class="badge ${quest.status === 'in_progress' ? 'progress' : quest.status === 'done' ? 'done' : ''}">${statusNames[quest.status] || statusNames.todo}</span>${quest.urgent ? '<span class="badge urgent">! Срочно</span>' : ''}${quest.recurrence ? `<span class="badge">↻ ${quest.recurrence.intervalDays === 2 ? 'Через день' : `Каждые ${esc(quest.recurrence.intervalDays)} дн.`}</span>` : ''}`; }
  function taskStatusControl(quest, compact = false) { return `<label class="${compact ? '' : 'status-control'}"><span class="${compact ? 'sr-only' : ''}">Статус</span><select class="${compact ? 'small-select' : 'status-select'}" data-status-quest="${esc(quest.id)}" aria-label="Статус задания ${esc(quest.title)}">${statusOptions(quest.status)}</select></label>`; }

  function announce(message) { $('#announcer').textContent = message; }
  function notify(message, error = false) {
    clearTimeout(noticeTimer);
    const element = $('#notice');
    element.textContent = message;
    element.classList.toggle('error', error);
    element.hidden = false;
    announce(message);
    noticeTimer = setTimeout(() => { element.hidden = true; }, error ? 14000 : 4500);
  }

  function normalizeSelection() {
    if (!projectById(selectedProject)) selectedProject = data.projects[0]?.id || null;
    if (!projectById(expanded)) expanded = selectedProject;
    if (selectedQuest && !questById(selectedQuest)) selectedQuest = null;
    if (selectedCompletion && !data.completions.some(completion => completion.id === selectedCompletion)) selectedCompletion = null;
  }

  function acceptState(state, external = false) {
    if (!state || !Array.isArray(state.projects) || !Array.isArray(state.quests)) throw new Error('Приложение получило неполные данные хранилища.');
    const changed = data.revision && state.revision !== data.revision;
    data = { ...emptyState, ...state, materials: state.materials || [], completions: state.completions || [] };
    normalizeSelection();
    render();
    if (external && changed && draft) {
      draft.reloaded = true;
      const warning = $('#draft-refresh-note');
      if (warning) { warning.hidden = false; warning.textContent = 'Заметки обновились. Ваш черновик сохранён. Перед записью книга проверит, не возник ли конфликт.'; }
    }
  }

  function captureFocus() {
    const element = document.activeElement;
    if (!element || !$('#content').contains(element) || !element.id) return null;
    return { id: element.id, start: element.selectionStart, end: element.selectionEnd };
  }
  function restoreFocus(focus) {
    const element = focus && document.getElementById(focus.id);
    if (!element) return;
    element.focus({ preventScroll: true });
    if (typeof focus.start === 'number' && ['search', 'text'].includes(element.type)) element.setSelectionRange(focus.start, focus.end);
  }
  function render() {
    const focus = captureFocus();
    const scrollPositions = [...$('#content').querySelectorAll('[data-scroll]')].map(element => [element.dataset.scroll, element.scrollTop]);
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
    $('.pages').classList.toggle('wide', ['board', 'calendar'].includes(view));
    $('[data-action="new-quest"]').disabled = !connected() || !data.projects.length;
    $('#content').innerHTML = !connected() ? welcomeView() : view === 'history' ? historyView() : view === 'calendar' ? calendarView() : view === 'board' ? boardView() : journalView();
    scrollPositions.forEach(([key, top]) => { const element = [...$('#content').querySelectorAll('[data-scroll]')].find(item => item.dataset.scroll === key); if (element) element.scrollTop = top; });
    restoreFocus(focus);
    renderFooter();
  }
  function renderFooter() {
    const warnings = data.connection?.warnings || [];
    const connection = $('#connection');
    connection.classList.toggle('disconnected', !connected() || warnings.length > 0);
    const vaultName = String(data.connection?.vaultPath || '').split(/[\\/]/).filter(Boolean).pop();
    connection.textContent = connected() ? `${warnings.length ? '⚠ ' : ''}${vaultName || 'Obsidian'}${warnings.length ? ` · предупреждений: ${warnings.length}` : ''}` : 'Подключить Obsidian';
    connection.dataset.action = connected() ? 'connection-info' : 'choose-vault';
    connection.title = connected() ? `${data.connection.vaultPath || ''}\n${warnings.length ? warnings.join('\n') : 'Синхронизация с Obsidian подключена. Нажмите, чтобы посмотреть состояние.'}` : 'Выбрать папку хранилища';
    const active = data.quests.filter(quest => quest.status !== 'done').length;
    $('#summary').textContent = connected() ? `${active} открытых` : 'Личная книга дел';
    $('#cover-summary').textContent = connected() ? `${active} открытых заданий · свой темп` : 'Твои дела. Свой темп.';
    let resume = $('#resume-draft');
    if (draft && !$('#editor').open && open) {
      if (!resume) { resume = document.createElement('button'); resume.id = 'resume-draft'; resume.className = 'text-button'; resume.dataset.action = 'resume-draft'; resume.textContent = 'Черновик'; $('#summary').parentElement.insertBefore(resume, $('#summary')); }
    } else resume?.remove();
  }
  function welcomeView() {
    return '<section class="welcome"><div class="book-emblem" aria-hidden="true"><span></span></div><h1>Твоя книга проектов</h1><p>Выберите папку личного хранилища Obsidian. Здесь появятся проекты, задания и сохранённые материалы.</p><button class="button primary" data-action="choose-vault">Выбрать хранилище Obsidian</button><p class="caption">Изменения в книге сохраняются в вашем хранилище.</p></section>';
  }
  function journalView() {
    const term = query.trim();
    let groups = 0;
    const tree = data.projects.map(project => {
      const all = questsFor(project.id).filter(quest => quest.status !== 'done');
      const projectMatches = matches(`${project.title} ${project.description}`, term);
      const materialsMatch = data.materials.some(material => material.projectId === project.id && matches(`${material.title} ${material.description}`, term));
      const visible = sortQuests(all.filter(quest => !term || projectMatches || matches(`${quest.title} ${quest.description}`, term)));
      if (term && !projectMatches && !visible.length && !materialsMatch) return '';
      groups++;
      const isExpanded = Boolean(term) || expanded === project.id;
      return `<section class="project-group"><button class="project-toggle" data-project="${esc(project.id)}" aria-expanded="${isExpanded}"><span class="chevron" aria-hidden="true">${isExpanded ? '▾' : '▸'}</span><span class="group-label">${esc(project.title)}</span><span class="count">${all.length || '—'}</span></button><div class="project-quests" ${isExpanded ? '' : 'hidden'}>${visible.length ? visible.map(quest => `<button class="quest-row" data-quest="${esc(quest.id)}" aria-current="${selectedQuest === quest.id}"><span class="quest-dot ${quest.status === 'in_progress' ? 'progress' : ''}" aria-hidden="true">${quest.urgent ? '<span class="urgent-mark">!</span>' : quest.recurrence ? '↻' : quest.status === 'in_progress' ? '●' : '·'}</span><span class="quest-label">${esc(quest.title)}</span>${quest.plannedDate ? `<span class="quest-date">${esc(shortDate(quest.plannedDate))}</span>` : ''}</button>`).join('') : `<div class="empty">${term ? 'Совпадение в описании или материалах.' : 'Открытых заданий пока нет.'}</div>`}<div class="group-links"><button class="text-button" data-about="${esc(project.id)}">О проекте</button><button class="text-button" data-add-project-quest="${esc(project.id)}">+ Задание</button></div></div></section>`;
    }).join('');
    return `<div class="split"><section class="left-page" aria-label="Проекты и задания"><div class="page-heading"><h2>Мои проекты</h2><span class="caption">${data.projects.length}</span></div><label class="sr-only" for="journal-search">Найти задание или проект</label><input class="search" id="journal-search" type="search" placeholder="Найти задание или проект…" value="${esc(query)}" autocomplete="off"><nav class="tree scroll" data-scroll="tree" aria-label="Список проектов">${groups ? tree : '<div class="empty">Ничего не найдено.</div>'}</nav><div class="page-bottom"><button class="text-button" data-action="new-project">+ Добавить проект</button></div></section><section class="right-page" aria-label="Описание"><div class="detail scroll" data-scroll="detail-${esc(selectedQuest || selectedProject || '')}">${selectedQuest && questById(selectedQuest) ? questDetail(questById(selectedQuest)) : projectDetail(projectById(selectedProject))}</div></section></div>`;
  }
  function questDetail(quest, modal = false) {
    const recurringDoneToday = quest.recurrence && timestampDay(quest.recurrence.lastCompletedAt) === today();
    return `<div class="crumb">${esc(projectName(quest.projectId))} / Задание</div><h1>${esc(quest.title)}</h1><div class="status-line">${badge(quest)}</div><div class="divider"></div><p class="copy">${esc(quest.description || 'Описание пока не добавлено.')}</p>${quest.plannedDate || quest.dueDate ? `<div class="dates">${quest.plannedDate ? `<div class="date-item"><span>Запланировано</span>${esc(readableDate(quest.plannedDate))}</div>` : ''}${quest.dueDate ? `<div class="date-item"><span>Срок</span>${esc(readableDate(quest.dueDate))}</div>` : ''}</div>` : ''}${quest.recurrence ? `<p class="caption">${quest.recurrence.lastCompletedAt ? `Последняя отметка: ${esc(readableDate(quest.recurrence.lastCompletedAt))}. ` : ''}После выполнения задание останется открытым; следующая дата сдвинется на ${esc(quest.recurrence.intervalDays)} дня.</p>` : ''}<div class="actions"><button class="button ${quest.status === 'done' ? '' : 'primary'}" data-complete="${esc(quest.id)}" ${recurringDoneToday ? 'disabled' : ''}>${recurringDoneToday ? 'Отмечено сегодня' : quest.status === 'done' ? 'Вернуть в открытые' : quest.recurrence ? 'Отметить выполнение' : '✓ Выполнено'}</button><button class="text-button ${quest.urgent ? 'danger' : ''}" data-urgent="${esc(quest.id)}">${quest.urgent ? 'Убрать срочность' : 'Отметить срочным'}</button></div>${taskStatusControl(quest)}<div class="actions"><button class="text-button" data-edit-quest="${esc(quest.id)}">Редактировать задание</button><button class="text-button" data-plan-quest="${esc(quest.id)}">Запланировать</button>${quest.sourcePath ? `<button class="text-button" data-source="${esc(quest.sourcePath)}">В Obsidian ↗</button>` : ''}<button class="text-button danger" data-delete-quest="${esc(quest.id)}">Удалить</button></div>${!modal && quest.status === 'done' ? '<p class="caption section-label">Задание также доступно на странице «Завершённые».</p>' : ''}`;
  }
  function projectDetail(project) {
    if (!project) return '<div class="empty"><h2>Чистая страница</h2><p>Добавьте проект, чтобы собрать в нём свои задания.</p><div class="actions"><button class="button primary" data-action="new-project">Добавить проект</button></div></div>';
    const materials = data.materials.filter(material => material.projectId === project.id);
    return `<div class="crumb">Проект</div><h1>${esc(project.title)}</h1><div class="divider"></div><p class="copy">${esc(project.description || 'Описание пока не добавлено.')}</p><div class="actions"><button class="button primary" data-add-project-quest="${esc(project.id)}">+ Добавить задание</button><button class="text-button" data-edit-project="${esc(project.id)}">Редактировать</button></div>${materials.length ? `<h3 class="section-label">СОХРАНЁННЫЕ МАТЕРИАЛЫ</h3>${materials.map(material => `<article class="material"><h3>${esc(material.title)}</h3><p class="copy">${esc(materialExcerpt(material.description))}</p><div class="material-actions"><button class="text-button" data-material-quest="${esc(material.id)}">+ Добавить задание по материалу</button>${material.path ? `<button class="text-button" data-source="${esc(material.path)}">Открыть ↗</button>` : ''}</div></article>`).join('')}` : ''}<div class="actions"><button class="text-button danger" data-delete-project="${esc(project.id)}">Удалить проект</button></div>`;
  }
  function visibleCompletions() {
    return data.completions.filter(item => {
      const day = timestampDay(item.completedAt);
      return (!historyFilters.projectId || item.projectId === historyFilters.projectId) && matches(`${item.title} ${item.description}`, historyFilters.query) && (!historyFilters.from || day && day >= historyFilters.from) && (!historyFilters.to || day && day <= historyFilters.to);
    }).sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  }
  function historyView() {
    const completions = visibleCompletions();
    const selected = completions.find(item => item.id === selectedCompletion) || completions[0];
    selectedCompletion = selected?.id || null;
    let previousDay = null;
    const list = completions.map(item => { const day = timestampDay(item.completedAt); const heading = previousDay !== day ? `<div class="history-date">${esc(readableDate(day, { year: 'numeric' }))}</div>` : ''; previousDay = day; return `${heading}<button class="history-item" data-completion="${esc(item.id)}" aria-current="${selectedCompletion === item.id}"><strong>✓ ${esc(item.title)}</strong><span class="caption">${esc(projectName(item.projectId))}${item.kind === 'recurrence' ? ' · повторяемое задание' : ''}</span></button>`; }).join('');
    return `<div class="split"><section class="left-page"><div class="page-heading"><h2>Завершённые</h2><span class="count">${completions.length}</span></div><label class="sr-only" for="history-search">Найти завершённое задание</label><input class="search" id="history-search" type="search" placeholder="Найти завершённое задание…" value="${esc(historyFilters.query)}"><div class="filters"><label class="filter-label wide-field">Проект<select id="history-project">${optionsForProjects(historyFilters.projectId, true)}</select></label><label class="filter-label">С даты<input id="history-from" type="date" value="${esc(historyFilters.from)}"></label><label class="filter-label">По дату<input id="history-to" type="date" value="${esc(historyFilters.to)}"></label></div><button class="text-button" data-action="clear-history-filters">Сбросить фильтры</button>${historyFilters.from && historyFilters.to && historyFilters.from > historyFilters.to ? '<p class="inline-warning">Дата начала позже даты окончания.</p>' : ''}<div class="scroll" data-scroll="history" aria-label="История выполнений">${list || '<div class="empty">Здесь появятся выполненные задания. Если они уже есть, попробуйте сбросить фильтры.</div>'}</div></section><section class="right-page"><div class="detail scroll" data-scroll="completion-${esc(selected?.id || '')}">${selected ? `<div class="crumb">${esc(projectName(selected.projectId))} / Завершено</div><h1>${esc(selected.title)}</h1><div class="status-line"><span class="badge done">✓ ${esc(readableDate(selected.completedAt, { year: 'numeric' }))}</span>${selected.kind === 'recurrence' ? '<span class="badge">Отдельное выполнение</span>' : ''}</div><div class="divider"></div><p class="copy">${esc(selected.description || 'Описание не добавлено.')}</p><div class="actions">${questById(selected.questId) ? `<button class="text-button" data-quest="${esc(selected.questId)}">Открыть задание</button>` : ''}<button class="text-button" data-undo-completion="${esc(selected.id)}">Отменить отметку выполнения</button></div>` : '<div class="empty"><h2>Ещё одна глава</h2><p>Выполненные дела остаются здесь — с датой и описанием.</p></div>'}</div></section></div>`;
  }
  function boardView() {
    const quests = data.quests.filter(quest => (!boardFilters.projectId || quest.projectId === boardFilters.projectId) && (!boardFilters.urgent || quest.urgent) && matches(`${quest.title} ${quest.description}`, boardFilters.query));
    return `<div class="filter-line"><label class="sr-only" for="board-search">Поиск на доске</label><input class="search" id="board-search" type="search" placeholder="Найти на доске…" value="${esc(boardFilters.query)}"><label class="sr-only" for="board-project">Проект на доске</label><select class="small-select" id="board-project">${optionsForProjects(boardFilters.projectId, true)}</select><label><input type="checkbox" id="board-urgent" ${boardFilters.urgent ? 'checked' : ''}> Срочные</label><span class="caption">Перетащите задание или смените статус</span></div><div class="board">${Object.entries(statusNames).map(([status, title]) => { const items = sortQuests(quests.filter(quest => quest.status === status)); return `<section class="board-column" data-status="${status}" aria-label="${title}"><h2 class="board-heading">${title}<span class="count">${items.length}</span></h2><div class="board-list" data-scroll="board-${status}">${items.length ? items.map(quest => `<article class="board-card" draggable="true" data-drag-quest="${esc(quest.id)}"><button class="card-open" data-show-quest="${esc(quest.id)}">${quest.urgent ? '<span class="urgent-mark">! </span>' : ''}${esc(quest.title)}</button><span class="caption">${esc(projectName(quest.projectId))}${quest.recurrence ? ' · ↻' : ''}</span><div class="card-bottom">${taskStatusControl(quest, true)}<span class="caption">${quest.plannedDate ? esc(shortDate(quest.plannedDate)) : ''}</span></div></article>`).join('') : '<div class="board-empty">Пока пусто</div>'}</div></section>`; }).join('')}</div>`;
  }
  function calendarView() {
    const first = `${month}-01`;
    const firstDate = new Date(`${first}T12:00:00Z`);
    const offset = (firstDate.getUTCDay() + 6) % 7;
    const start = addDays(first, -offset);
    const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
    const tasks = dateEvents(selectedDay);
    const monthName = firstDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
    return `<div class="calendar-layout"><section class="calendar-main" aria-label="Календарь заданий"><div class="calendar-toolbar"><button class="arrow-button" data-action="previous-month" aria-label="Предыдущий месяц">‹</button><h2>${esc(monthName[0].toUpperCase() + monthName.slice(1))}</h2><button class="arrow-button" data-action="next-month" aria-label="Следующий месяц">›</button><button class="text-button" data-action="today">Сегодня</button></div><div class="calendar-weekdays" aria-hidden="true">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${days.map(day => { const events = dateEvents(day); return `<button class="calendar-day ${day.slice(0,7) !== month ? 'other-month' : ''} ${day === today() ? 'today' : ''}" data-day="${day}" aria-pressed="${selectedDay === day}" aria-label="${esc(readableDate(day))}, заданий: ${events.length}"><span class="day-number">${Number(day.slice(8))}</span>${events.slice(0, 2).map(quest => `<span class="day-event ${quest.urgent ? 'urgent' : ''}">${quest.dueDate === day ? '◆ ' : ''}${esc(quest.title)}</span>`).join('')}${events.length > 2 ? `<span class="day-more">ещё ${events.length - 2}</span>` : ''}</button>`; }).join('')}</div><p class="caption">◆ — срок задания · обычная запись — запланированный день</p></section><section class="calendar-side"><h2>${esc(readableDate(selectedDay))}</h2><p class="caption">${tasks.length ? `Заданий на день: ${tasks.length}` : 'День свободен'}</p><div class="day-list" data-scroll="day-${selectedDay}">${tasks.length ? tasks.map(quest => `<article class="day-task"><button class="card-open" data-show-quest="${esc(quest.id)}">${quest.urgent ? '<span class="urgent-mark">! </span>' : ''}${esc(quest.title)}</button><p class="caption">${esc(projectName(quest.projectId))}${quest.dueDate === selectedDay ? ' · срок' : ''}</p><div class="actions"><button class="text-button" data-complete="${esc(quest.id)}">✓ Выполнено</button><button class="text-button" data-plan-quest="${esc(quest.id)}">Перенести</button>${quest.plannedDate === selectedDay ? `<button class="text-button" data-unplan="${esc(quest.id)}">Убрать из плана</button>` : ''}</div></article>`).join('') : '<div class="empty">Можно выбрать существующее задание и назначить его на этот день.</div>'}</div><button class="button" data-action="schedule-existing" ${data.quests.some(quest => quest.status !== 'done') ? '' : 'disabled'}>+ Запланировать задание</button><button class="text-button" data-action="new-quest-on-day">Создать задание на этот день</button></section></div>`;
  }

  function showDialog(html, mode) {
    dialogMode = mode;
    $('#dialog-content').innerHTML = html;
    if (!$('#editor').open && open) $('#editor').showModal();
    renderFooter();
  }
  function hideDialog() {
    $('#editor').close();
    dialogMode = null;
    confirmation = null;
    scheduleSelection = null;
    renderFooter();
  }
  function dialogHeader(title, draftEditor = false) { return `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="dialog-close" data-action="hide-dialog" aria-label="${draftEditor ? 'Свернуть редактор, сохранив черновик' : 'Закрыть диалог'}">×</button></div>`; }
  function startDraft(kind, item = null, defaults = {}) {
    if (draft) { renderDraft(); notify('Открыт сохранённый черновик. Сохраните его или нажмите «Отмена».'); return; }
    draft = { kind, id: item?.id || null, revision: data.revision, title: item?.title || '', description: item?.description || '', projectId: item?.projectId || defaults.projectId || selectedProject || data.projects[0]?.id || '', urgent: Boolean(item?.urgent), plannedDate: item?.plannedDate || defaults.plannedDate || '', dueDate: item?.dueDate || '', sourcePath: item?.sourcePath || defaults.sourcePath || null, sourceTitle: defaults.sourceTitle || '', reloaded: false, conflict: false };
    renderDraft();
  }
  function renderDraft() {
    if (!draft) return;
    const project = draft.kind === 'project';
    const title = `${draft.id ? 'Редактировать' : 'Добавить'} ${project ? 'проект' : 'задание'}`;
    const remote = draft.id ? (project ? projectById(draft.id) : questById(draft.id)) : null;
    const comparison = draft.conflict ? `<div class="warning-box"><strong>Заметки изменились — черновик ещё не записан.</strong>${remote ? `<details><summary>Посмотреть текущую запись в Obsidian</summary><p class="copy">${esc(remote.title)}\n\n${esc(remote.description || 'Без описания')}${!project ? `\n\nПроект: ${esc(projectName(remote.projectId))}\nЗапланировано: ${esc(remote.plannedDate || 'не задано')}\nСрок: ${esc(remote.dueDate || 'не задан')}\nСрочно: ${remote.urgent ? 'да' : 'нет'}` : ''}</p></details>` : draft.id ? '<p>Эта запись больше не существует в хранилище.</p>' : '<p>Другие записи книги обновились.</p>'}${!draft.id || remote ? '<button class="text-button" type="button" data-action="resolve-draft">Сверено: сохранить мой вариант</button>' : ''}</div>` : '';
    showDialog(`${dialogHeader(title, true)}<form id="edit-form" class="form"><label class="field">Название<input name="title" id="edit-title" required maxlength="240" autocomplete="off" value="${esc(draft.title)}"></label><label class="field">Описание<textarea name="description" id="edit-description" rows="4" maxlength="30000">${esc(draft.description)}</textarea></label>${!project ? `<label class="field">Проект<select name="projectId" id="edit-project">${optionsForProjects(draft.projectId)}</select></label><div class="field-pair"><label class="field">Запланировать на<input name="plannedDate" id="edit-planned" type="date" value="${esc(draft.plannedDate)}"></label><label class="field">Срок, если есть<input name="dueDate" id="edit-due" type="date" value="${esc(draft.dueDate)}"></label></div><label class="checkbox-field"><input type="checkbox" name="urgent" id="edit-urgent" ${draft.urgent ? 'checked' : ''}> Срочное задание</label>${draft.sourceTitle ? `<p class="caption">По материалу: ${esc(draft.sourceTitle)}</p>` : ''}` : ''}<p id="draft-refresh-note" class="warning-box" ${draft.reloaded && !draft.conflict ? '' : 'hidden'}>Заметки обновились. Ваш черновик сохранён. Перед записью книга проверит, не возник ли конфликт.</p>${comparison}<p class="dialog-error" id="dialog-error" role="alert"></p><div class="form-actions"><button class="button primary" type="submit" ${draft.conflict ? 'disabled' : ''}>${draft.id ? 'Сохранить' : 'Добавить'}</button><button class="text-button" type="button" data-action="cancel-draft">Отмена</button></div><p class="draft-note">Крестик сворачивает редактор и сохраняет черновик до закрытия приложения.</p></form>`, 'draft');
    $('#edit-title').focus();
  }
  function showQuestModal(id) { const quest = questById(id); if (quest) showDialog(`${dialogHeader('Задание')}${questDetail(quest, true)}`, 'quest'); }
  function showDelete(kind, id) {
    const item = kind === 'project' ? projectById(id) : questById(id);
    if (!item) return;
    confirmation = { kind, id };
    showDialog(`${dialogHeader(`Удалить ${kind === 'project' ? 'проект' : 'задание'}?`)}<p class="copy">«${esc(item.title)}»</p><p class="warning-box">${kind === 'project' ? `Проект и его ${questsFor(id).length} заданий исчезнут из книги. Исходные заметки и материалы сохранятся в Obsidian.` : 'Задание будет удалено из книги и из списка задач в заметке. Остальной текст заметки сохранится.'}</p><p id="dialog-error" class="dialog-error" role="alert"></p><div class="actions"><button class="button danger-button" data-action="confirm-delete">Удалить</button><button class="text-button" data-action="hide-dialog">Отмена</button></div>`, 'delete');
  }
  function showSchedule(id = null) {
    scheduleSelection = { id, day: selectedDay, query: '' };
    const quest = questById(id);
    if (quest?.plannedDate) scheduleSelection.day = quest.plannedDate;
    renderSchedule();
  }
  function renderSchedule() {
    const selection = scheduleSelection;
    if (!selection) return;
    const quest = questById(selection.id);
    const tasks = sortQuests(data.quests.filter(item => item.status !== 'done' && matches(`${item.title} ${projectName(item.projectId)}`, selection.query)));
    showDialog(`${dialogHeader('Запланировать задание')}<form id="schedule-form" class="form">${quest ? `<p class="copy">${esc(quest.title)}</p>` : `<label class="field">Найти задание<input id="schedule-search" type="search" placeholder="Название или проект…" value="${esc(selection.query)}" autocomplete="off"></label><div class="schedule-list">${tasks.map(item => `<label class="schedule-option"><input type="radio" name="questId" value="${esc(item.id)}" ${selection.selectedId === item.id ? 'checked' : ''} required><span>${esc(item.title)}<span class="caption">${esc(projectName(item.projectId))}${item.plannedDate ? ` · ${esc(shortDate(item.plannedDate))}` : ''}</span></span></label>`).join('') || '<p class="empty">Заданий не найдено.</p>'}</div>`}<label class="field">День выполнения<input id="schedule-date" name="day" type="date" value="${esc(selection.day)}" required></label><p id="dialog-error" class="dialog-error" role="alert"></p><div class="form-actions"><button class="button primary" type="submit">Запланировать</button><button class="text-button" type="button" data-action="hide-dialog">Отмена</button></div></form>`, 'schedule');
  }
  function showConnection() {
    const warnings = data.connection?.warnings || [];
    showDialog(`${dialogHeader('Хранилище Obsidian')}<p class="copy">${esc(data.connection?.vaultPath || 'Хранилище не выбрано')}</p><p class="caption">${data.connection?.lastSync ? `Обновлено: ${esc(new Date(data.connection.lastSync).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))}` : 'Время синхронизации неизвестно.'}</p>${warnings.length ? `<div class="warning-box">${esc(warnings.join('\n\n'))}</div>` : '<p class="warning-box">Изменения сохраняются в заметки. Обновления из Obsidian появляются в книге автоматически.</p>'}<div class="actions"><button class="button" data-action="refresh">Обновить сейчас</button><button class="text-button" data-action="choose-vault">Выбрать другое хранилище</button></div>`, 'connection');
  }

  async function mutate(type, payload, success, after, revision = data.revision) {
    if (busy) return false;
    busy = true;
    document.body.setAttribute('aria-busy', 'true');
    const submit = $('#editor button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const next = await api.dispatch({ type, payload, revision });
      acceptState(next);
      after?.(next);
      if (success) notify(success);
      return true;
    } catch (error) {
      const message = `Не удалось сохранить: ${error.message || error}`;
      const inline = $('#dialog-error');
      if (inline) inline.textContent = message;
      notify(message, true);
      try { acceptState(await api.refresh(), true); } catch { /* Keep the current readable state and the user's draft. */ }
      if (draft && revision === draft.revision && /измен|conflict/i.test(message)) { draft.conflict = true; renderDraft(); $('#dialog-error').textContent = message; }
      return false;
    } finally { busy = false; document.body.removeAttribute('aria-busy'); if (submit?.isConnected) submit.disabled = false; }
  }
  async function saveDraft() {
    if (!draft) return;
    if (!draft.title.trim()) { $('#dialog-error').textContent = 'Введите название.'; return; }
    if (draft.kind === 'quest' && !projectById(draft.projectId)) { $('#dialog-error').textContent = 'Выберите существующий проект.'; return; }
    const current = { ...draft };
    const previousIds = new Set((current.kind === 'project' ? data.projects : data.quests).map(item => item.id));
    const payload = { ...(current.id ? { id: current.id } : {}), title: current.title.trim(), description: current.description.trim() };
    if (current.kind === 'quest') Object.assign(payload, { projectId: current.projectId, urgent: current.urgent, plannedDate: current.plannedDate || null, dueDate: current.dueDate || null, ...(!current.id && current.sourcePath ? { sourcePath: current.sourcePath } : {}) });
    await mutate(`${current.kind}.${current.id ? 'update' : 'create'}`, payload, 'Сохранено в Obsidian.', next => {
      const item = (current.kind === 'project' ? next.projects : next.quests).find(item => current.id ? item.id === current.id : !previousIds.has(item.id));
      if (item) { selectedProject = current.kind === 'project' ? item.id : item.projectId; expanded = selectedProject; selectedQuest = current.kind === 'quest' ? item.id : null; }
      draft = null;
      hideDialog();
      render();
    }, current.revision);
  }
  async function changeStatus(id, status) {
    const quest = questById(id);
    if (!quest) return;
    await mutate('quest.status', { id, status }, status === 'done' ? quest.recurrence ? 'Выполнение записано. Следующая дата запланирована.' : 'Задание выполнено — оно теперь в истории.' : 'Статус обновлён.', () => { if (dialogMode === 'quest') showQuestModal(id); });
  }
  async function chooseVault() {
    if (busy) return;
    if (draft) { notify('Перед сменой хранилища сохраните или отмените черновик.'); renderDraft(); return; }
    busy = true;
    try { const next = await api.chooseVault(); if (next) { hideDialog(); acceptState(next); notify('Хранилище подключено.'); } } catch (error) { notify(`Не удалось подключить хранилище: ${error.message || error}`, true); } finally { busy = false; }
  }
  async function refresh() {
    if (busy) return;
    try { acceptState(await api.refresh(), true); if (dialogMode === 'connection') showConnection(); notify('Книга обновлена.'); } catch (error) { notify(`Не удалось обновить книгу: ${error.message || error}`, true); }
  }
  function showBook(isOpen) {
    open = isOpen;
    if (!isOpen && $('#editor').open) $('#editor').close();
    $('#book').hidden = !isOpen;
    $('#cover-stage').hidden = isOpen;
    api.windowAction(isOpen ? 'open-book' : 'close-book');
    if (isOpen && draft && dialogMode === 'draft') renderDraft();
    renderFooter();
  }
  function moveMonth(offset) { const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + offset); month = date.toISOString().slice(0, 7); render(); }
  function selectQuest(id) { const quest = questById(id); if (!quest) return; selectedQuest = id; selectedProject = quest.projectId; expanded = selectedProject; view = 'journal'; hideDialog(); render(); }

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || busy && !['close-book', 'open-book', 'minimize', 'close'].includes(button.dataset.action)) return;
    const ds = button.dataset;
    if (ds.view) { view = ds.view; render(); return; }
    if (ds.project) { expanded = expanded === ds.project ? null : ds.project; selectedProject = ds.project; selectedQuest = null; render(); return; }
    if (ds.about) { selectedProject = ds.about; selectedQuest = null; render(); return; }
    if (ds.quest) { selectQuest(ds.quest); return; }
    if (ds.showQuest) { showQuestModal(ds.showQuest); return; }
    if (ds.completion) { selectedCompletion = ds.completion; render(); return; }
    if (ds.day) { selectedDay = ds.day; render(); return; }
    if (ds.editQuest) { startDraft('quest', questById(ds.editQuest)); return; }
    if (ds.editProject) { startDraft('project', projectById(ds.editProject)); return; }
    if (ds.addProjectQuest) { startDraft('quest', null, { projectId: ds.addProjectQuest }); return; }
    if (ds.materialQuest) { const material = data.materials.find(item => item.id === ds.materialQuest); if (material) startDraft('quest', null, { projectId: material.projectId, sourcePath: material.path, sourceTitle: material.title }); return; }
    if (ds.deleteQuest) { showDelete('quest', ds.deleteQuest); return; }
    if (ds.deleteProject) { showDelete('project', ds.deleteProject); return; }
    if (ds.complete) { const quest = questById(ds.complete); if (quest) await changeStatus(quest.id, quest.status === 'done' ? 'todo' : 'done'); return; }
    if (ds.urgent) { const quest = questById(ds.urgent); if (quest) await mutate('quest.update', { id: quest.id, urgent: !quest.urgent }, quest.urgent ? 'Срочность снята.' : 'Задание отмечено срочным.', () => { if (dialogMode === 'quest') showQuestModal(quest.id); }); return; }
    if (ds.planQuest) { showSchedule(ds.planQuest); return; }
    if (ds.unplan) { await mutate('quest.update', { id: ds.unplan, plannedDate: null }, 'День выполнения освобождён.'); return; }
    if (ds.undoCompletion) { await mutate('completion.undo', { id: ds.undoCompletion }, 'Отметка выполнения отменена.'); return; }
    if (ds.source) { try { await api.openSource(ds.source); } catch (error) { notify(`Не удалось открыть заметку: ${error.message || error}`, true); } return; }
    switch (ds.action) {
      case 'close-book': showBook(false); break;
      case 'open-book': showBook(true); break;
      case 'minimize': case 'close': api.windowAction(ds.action); break;
      case 'choose-vault': await chooseVault(); break;
      case 'refresh': await refresh(); break;
      case 'connection-info': showConnection(); break;
      case 'new-project': startDraft('project'); break;
      case 'new-quest': startDraft('quest'); break;
      case 'new-quest-on-day': startDraft('quest', null, { plannedDate: selectedDay }); break;
      case 'resume-draft': renderDraft(); break;
      case 'hide-dialog': hideDialog(); break;
      case 'cancel-draft': draft = null; hideDialog(); break;
      case 'resolve-draft': if (draft) { draft.revision = data.revision; draft.conflict = false; draft.reloaded = false; await saveDraft(); } break;
      case 'clear-history-filters': historyFilters = { query: '', projectId: '', from: '', to: '' }; render(); break;
      case 'previous-page': { const views = ['journal', 'history', 'calendar', 'board']; view = views[(views.indexOf(view) + views.length - 1) % views.length]; render(); break; }
      case 'next-page': { const views = ['journal', 'history', 'calendar', 'board']; view = views[(views.indexOf(view) + 1) % views.length]; render(); break; }
      case 'previous-month': moveMonth(-1); break;
      case 'next-month': moveMonth(1); break;
      case 'today': selectedDay = today(); month = selectedDay.slice(0, 7); render(); break;
      case 'schedule-existing': showSchedule(); break;
      case 'confirm-delete': { const target = confirmation; if (target) await mutate(`${target.kind}.delete`, { id: target.id }, target.kind === 'project' ? 'Проект удалён из книги.' : 'Задание удалено.', () => { if (draft?.id === target.id) draft = null; hideDialog(); render(); }); break; }
    }
  });
  document.addEventListener('input', event => {
    const element = event.target;
    if (draft && element.closest('#edit-form') && element.name) { draft[element.name] = element.type === 'checkbox' ? element.checked : element.value; return; }
    if (element.id === 'journal-search') { query = element.value; render(); }
    if (element.id === 'history-search') { historyFilters.query = element.value; render(); }
    if (element.id === 'board-search') { boardFilters.query = element.value; render(); }
    if (element.id === 'schedule-search' && scheduleSelection) { const caret = element.selectionStart; scheduleSelection.query = element.value; renderSchedule(); const input = $('#schedule-search'); input.focus(); input.setSelectionRange(caret, caret); }
    if (element.id === 'schedule-date' && scheduleSelection) scheduleSelection.day = element.value;
  });
  document.addEventListener('change', async event => {
    const element = event.target;
    if (draft && element.closest('#edit-form') && element.name) draft[element.name] = element.type === 'checkbox' ? element.checked : element.value;
    if (element.dataset.statusQuest) { const id = element.dataset.statusQuest; const status = element.value; if (busy) { element.value = questById(id)?.status || 'todo'; return; } await changeStatus(id, status); }
    const historyKeys = { 'history-project': 'projectId', 'history-from': 'from', 'history-to': 'to' };
    if (historyKeys[element.id]) { historyFilters[historyKeys[element.id]] = element.value; render(); }
    if (element.id === 'board-project') { boardFilters.projectId = element.value; render(); }
    if (element.id === 'board-urgent') { boardFilters.urgent = element.checked; render(); }
    if (element.name === 'questId' && scheduleSelection) scheduleSelection.selectedId = element.value;
  });
  document.addEventListener('submit', async event => {
    event.preventDefault();
    if (event.target.id === 'edit-form') await saveDraft();
    if (event.target.id === 'schedule-form' && scheduleSelection) {
      const selection = { ...scheduleSelection };
      const id = selection.id || selection.selectedId;
      if (!id || !selection.day) { $('#dialog-error').textContent = 'Выберите задание и день выполнения.'; return; }
      await mutate('quest.update', { id, plannedDate: selection.day }, 'Задание добавлено в календарь.', () => { selectedDay = selection.day; month = selection.day.slice(0, 7); hideDialog(); render(); });
    }
  });
  $('#editor').addEventListener('cancel', event => { event.preventDefault(); hideDialog(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); showBook(!open); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && draft && $('#editor').open && dialogMode === 'draft') { event.preventDefault(); $('#edit-form').requestSubmit(); }
  });
  document.addEventListener('dragstart', event => {
    const card = event.target.closest('[data-drag-quest]');
    if (!card || busy) { event.preventDefault(); return; }
    event.dataTransfer.setData('text/plain', card.dataset.dragQuest);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  document.addEventListener('dragend', () => document.querySelectorAll('.dragging,.drag-over').forEach(element => element.classList.remove('dragging', 'drag-over')));
  document.addEventListener('dragover', event => { const column = event.target.closest('.board-column'); if (column) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('drag-over'); } });
  document.addEventListener('dragleave', event => { const column = event.target.closest('.board-column'); if (column && !column.contains(event.relatedTarget)) column.classList.remove('drag-over'); });
  document.addEventListener('drop', async event => { const column = event.target.closest('.board-column'); if (!column) return; event.preventDefault(); document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over')); const id = event.dataTransfer.getData('text/plain'); const quest = questById(id); if (quest && quest.status !== column.dataset.status) await changeStatus(id, column.dataset.status); });

  async function initialize() {
    render();
    if (!api) { notify('Не удалось подключить настольное приложение. Откройте Книгу проектов через её ярлык.', true); return; }
    api.onChanged(state => { try { acceptState(state, true); } catch (error) { notify(`Ошибка обновления: ${error.message}`, true); } });
    try { acceptState(await api.load()); } catch (error) { notify(`Не удалось загрузить хранилище: ${error.message || error}`, true); }
  }
  initialize();
})();
