'use strict';

// Runs only against a disposable, generic vault. No personal files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function playwright() {
  try { return require('playwright'); } catch (original) {
    const candidates = [
      ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
      path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules'),
    ];
    for (const candidate of candidates) {
      try { return require(path.join(candidate, 'playwright')); } catch { /* Next installed runtime. */ }
    }
    throw new Error('Playwright is required for this smoke test. Install it locally or provide NODE_PATH.', { cause: original });
  }
}

const { _electron } = playwright();
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceName = path.join('Личные проекты', 'Сервис.md');
let temp;
let vault;
let source;
let application;
let page;
const checks = [];
const rendererErrors = [];

async function state() { return page.evaluate(() => window.questBook.load()); }

async function dispatch(type, payload) {
  return page.evaluate(async ({ type, payload }) => {
    const current = await window.questBook.load();
    return window.questBook.dispatch({ type, payload, revision: current.revision });
  }, { type, payload });
}

async function eventually(check, description, timeout = 12000) {
  const end = Date.now() + timeout;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await pause(100);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ''}`);
}

async function check(name, run) {
  await run();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function screenshot(name) {
  const wasVisible = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const visible = window.isVisible();
    if (!visible) window.showInactive();
    return visible;
  });
  try {
    await page.evaluate(() => Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]));
    await pause(200);
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const capture = await Promise.race([
        window.webContents.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Native screenshot timed out')), 5000)),
      ]);
      return capture.toPNG().toString('base64');
    });
    await fs.writeFile(path.join(temp, name), Buffer.from(encoded, 'base64'));
  } finally {
    if (!wasVisible) await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  }
}

async function fixture() {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-book-e2e-'));
  vault = path.join(temp, 'vault');
  source = path.join(vault, sourceName);
  await fs.mkdir(path.dirname(source), { recursive: true });
  const tasks = Array.from({ length: 45 }, (_, i) => `- [ ] Проверить пункт ${String(i + 1).padStart(2, '0')} ^task-fixture-item-${i + 1}`).join('\n');
  await fs.writeFile(source, `---\nid: fixture-source\ntype: project\narea: Личные проекты\ncustom_preserved_field: keep-me\ntask_details:\n  fixture-check:\n    description: Исходное описание задания.\n    blocked_by: []\n    custom_preserved_detail: keep-detail\n---\n# Домашняя техника\n\nЛичный материал для проверки приложения.\n\n## Задания\n\n- [ ] Проверить сервис ^task-fixture-check\n${tasks}\n\n## Мои заметки\n\nНЕ МЕНЯТЬ: ручной текст пользователя.\n`, 'utf8');
  await fs.mkdir(path.join(vault, 'Работа'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Работа', 'Исключённый проект.md'), '---\nid: employer-fixture\n---\n# Рабочий проект\n- [ ] Не импортировать ^task-employer-fixture\n', 'utf8');
  await fs.writeFile(path.join(temp, 'bootstrap.json'), JSON.stringify({
    projects: [{ id: 'fixture-project', title: 'Личные проекты', description: 'Общее описание направления.', sourceIds: ['fixture-source'] }],
    extraQuests: [{ id: 'fixture-recurring', projectId: 'fixture-project', title: 'Регулярная публикация', description: 'Проверка существующей повторяющейся задачи.', recurrence: { intervalDays: 2, nextDate: null, lastCompletedAt: null } }],
  }), 'utf8');
}

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.QUEST_BOOK_EXECUTABLE || require('electron'),
    args: [...(process.env.QUEST_BOOK_EXECUTABLE ? [] : [root]), '--vault', vault, '--bootstrap', path.join(temp, 'bootstrap.json'), '--user-data-dir', path.join(temp, 'profile'), '--test-mode'],
    cwd: root,
    env,
    timeout: 30000,
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.questBook));
  await eventually(async () => (await state()).connection.connected, 'temporary vault connected');
}

async function sourceSyncAndConflict() {
  const old = await state();
  const original = await fs.readFile(source, 'utf8');
  const edited = original.replace('Проверить сервис ^task-fixture-check', 'Проверить сервис извне ^task-fixture-check');
  await fs.writeFile(source, edited, 'utf8');
  const conflict = await page.evaluate(async revision => {
    try {
      await window.questBook.dispatch({ type: 'quest.update', payload: { id: 'fixture-check', title: 'НЕ ДОЛЖНО СОХРАНИТЬСЯ' }, revision });
      return null;
    } catch (error) { return { message: error.message, code: error.code }; }
  }, old.revision);
  assert.ok(conflict, 'stale revision must fail instead of overwriting externally edited Markdown');
  assert.match(conflict.message, /измен|conflict/i);
  assert.match(await fs.readFile(source, 'utf8'), /Проверить сервис извне/);
  const refreshed = await page.evaluate(() => window.questBook.refresh());
  assert.equal(refreshed.quests.find(q => q.id === 'fixture-check').title, 'Проверить сервис извне');
  await dispatch('quest.update', { id: 'fixture-check', description: 'Описание после внешнего изменения.' });
  const changed = await fs.readFile(source, 'utf8');
  assert.match(changed, /custom_preserved_field: keep-me/);
  assert.match(changed, /custom_preserved_detail: keep-detail/);
  assert.match(changed, /НЕ МЕНЯТЬ: ручной текст пользователя\./);
  assert.match(changed, /\^task-fixture-check/);
}

async function apiRoundTrip() {
  let current = await dispatch('project.create', { title: 'Тестовое направление', description: 'Первая строка.\nВторая строка.' });
  const project = current.projects.find(p => p.title === 'Тестовое направление');
  assert.ok(project);
  current = await dispatch('quest.create', { projectId: project.id, title: 'Новое задание', description: 'Первое описание.', urgent: false, plannedDate: null, dueDate: null });
  const quest = current.quests.find(q => q.projectId === project.id);
  assert.ok(quest);
  const plannedDate = '2026-11-12';
  current = await dispatch('quest.update', { id: quest.id, title: 'Обновлённое задание', description: 'Редактированное описание.\nСледующая строка.', urgent: true, plannedDate, dueDate: '2026-11-13' });
  assert.equal(current.quests.find(q => q.id === quest.id).urgent, true);
  assert.equal(current.quests.find(q => q.id === quest.id).plannedDate, plannedDate);
  current = await dispatch('quest.status', { id: quest.id, status: 'in_progress' });
  assert.equal(current.quests.find(q => q.id === quest.id).status, 'in_progress');
  current = await dispatch('quest.status', { id: quest.id, status: 'done' });
  const completed = current.quests.find(q => q.id === quest.id);
  const completion = current.completions.find(c => c.questId === quest.id);
  assert.ok(completed.completedAt && completion);
  current = await dispatch('completion.undo', { id: completion.id });
  assert.notEqual(current.quests.find(q => q.id === quest.id).status, 'done');
  assert.equal(current.completions.filter(c => c.questId === quest.id).length, 0);
  await dispatch('quest.status', { id: quest.id, status: 'in_progress' });
  await application.close();
  application = null;
  await launch();
  current = await state();
  const reloaded = current.quests.find(q => q.id === quest.id);
  assert.equal(reloaded.title, 'Обновлённое задание');
  assert.equal(reloaded.description, 'Редактированное описание.\nСледующая строка.');
  assert.equal(reloaded.urgent, true);
  assert.equal(reloaded.plannedDate, plannedDate);
  assert.equal(reloaded.dueDate, '2026-11-13');
  assert.equal(reloaded.status, 'in_progress');
  current = await dispatch('quest.delete', { id: quest.id });
  assert.equal(current.quests.some(q => q.id === quest.id), false);
  current = await dispatch('project.delete', { id: project.id });
  assert.equal(current.projects.some(p => p.id === project.id), false);
  current = await page.evaluate(() => window.questBook.refresh());
  assert.equal(current.projects.some(p => p.id === project.id), false);
  assert.equal(current.quests.some(q => q.id === quest.id), false);
}

async function recurrence() {
  const before = (await state()).quests.find(q => q.id === 'fixture-recurring');
  let current = await dispatch('quest.status', { id: 'fixture-recurring', status: 'done' });
  const recurring = current.quests.find(q => q.id === 'fixture-recurring');
  assert.notEqual(recurring.status, 'done');
  assert.ok(recurring.plannedDate);
  assert.equal(recurring.recurrence.nextDate, recurring.plannedDate);
  assert.equal(current.completions.filter(c => c.questId === recurring.id).length, 1);
  const event = current.completions.find(c => c.questId === recurring.id);
  current = await dispatch('completion.undo', { id: event.id });
  assert.equal(current.completions.filter(c => c.questId === recurring.id).length, 0);
  assert.equal(current.quests.find(q => q.id === recurring.id).plannedDate, before.plannedDate);
}

async function uiSmoke() {
  const book = page.locator('#book');
  await book.waitFor({ state: 'visible' });
  const initialBounds = await book.boundingBox();
  const windowBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.ok(initialBounds.width > 500 && initialBounds.height > 300);
  for (const name of ['Завершённые', 'Календарь', 'Доска', 'Квесты']) {
    await page.getByRole('button', { name, exact: true }).click();
    const bounds = await book.boundingBox();
    assert.equal(bounds.width, initialBounds.width, `${name}: book width must stay fixed`);
    assert.equal(bounds.height, initialBounds.height, `${name}: book height must stay fixed`);
  }
  const docSize = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth,
    viewportHeight: innerHeight,
    viewportWidth: innerWidth,
  }));
  assert.ok(docSize.height <= docSize.viewportHeight && docSize.width <= docSize.viewportWidth, 'long task lists must not make the window scroll');
  await page.getByRole('button', { name: 'Закрыть книгу', exact: true }).click();
  await page.locator('#cover-stage').waitFor({ state: 'visible' });
  await eventually(async () => (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).width < windowBounds.width, 'native window becomes a cover');
  await page.getByRole('button', { name: 'Открыть книгу →', exact: true }).click();
  await book.waitFor({ state: 'visible' });
  await eventually(async () => (await book.boundingBox()).width === initialBounds.width, 'open book returns to its previous fixed width');
  assert.ok(await page.locator('.tree').evaluate(element => element.scrollHeight > element.clientHeight), 'long task list scrolls inside the book');

  const saveEditor = async () => {
    await page.locator('#edit-form button[type="submit"]').click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
  };
  await page.locator('[data-action="new-project"]').click();
  await page.getByLabel('Название', { exact: true }).fill('Направление из интерфейса');
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Описание направления.');
  await saveEditor();
  const project = (await state()).projects.find(item => item.title === 'Направление из интерфейса');
  assert.ok(project, 'project created through the UI');
  await page.locator(`[data-edit-project="${project.id}"]`).click();
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Изменённое описание направления.');
  await saveEditor();
  assert.equal((await state()).projects.find(item => item.id === project.id).description, 'Изменённое описание направления.');

  await page.locator('[data-action="new-quest"]').click();
  await page.getByLabel('Название', { exact: true }).fill('Интерфейсный квест');
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Первое описание квеста.\nВторая строка.');
  await page.locator('#edit-project').selectOption(project.id);
  await page.getByLabel('Срочный квест', { exact: true }).check();
  assert.equal(await page.getByLabel(/Повторение|Периодичность/).count(), 0, 'no recurrence editor');
  await saveEditor();
  let quest = (await state()).quests.find(item => item.title === 'Интерфейсный квест');
  assert.ok(quest?.urgent);
  await page.locator(`[data-edit-quest="${quest.id}"]`).click();
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Новое описание квеста.\nЕщё одна строка.');
  await saveEditor();
  assert.equal((await state()).quests.find(item => item.id === quest.id).description, 'Новое описание квеста.\nЕщё одна строка.');
  await page.locator(`[data-urgent="${quest.id}"]`).click();
  await eventually(async () => !(await state()).quests.find(item => item.id === quest.id).urgent, 'urgency cleared in UI');
  await page.locator(`[data-urgent="${quest.id}"]`).click();
  await eventually(async () => (await state()).quests.find(item => item.id === quest.id).urgent, 'urgency set in UI');

  await page.locator('[data-view="calendar"]').click();
  const today = await page.locator('.calendar-day.today').getAttribute('data-day');
  assert.ok(today);
  const planned = new Date(`${today}T12:00:00Z`);
  planned.setUTCDate(planned.getUTCDate() + 1);
  const tomorrow = planned.toISOString().slice(0, 10);
  await page.locator('[data-action="schedule-existing"]').click();
  await page.locator('#schedule-search').fill('Интерфейсный квест');
  await page.locator(`input[name="questId"][value="${quest.id}"]`).check();
  await page.getByLabel('День выполнения', { exact: true }).fill(tomorrow);
  await page.locator('#schedule-form button[type="submit"]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal((await state()).quests.find(item => item.id === quest.id).plannedDate, tomorrow);
  assert.ok(await page.locator(`.calendar-day[data-day="${tomorrow}"]`).innerText().then(value => value.includes('Интерфейсный квест')));
  await screenshot('calendar.png');

  await page.locator('[data-view="board"]').click();
  await page.locator('#board-project').selectOption(project.id);
  await page.locator(`[data-status-quest="${quest.id}"]`).selectOption('in_progress');
  await eventually(async () => (await state()).quests.find(item => item.id === quest.id).status === 'in_progress', 'Kanban status selector moves a card');
  const card = page.locator(`[data-drag-quest="${quest.id}"]`);
  await card.dragTo(page.locator('.board-column[data-status="done"]'));
  await eventually(async () => (await state()).quests.find(item => item.id === quest.id).status === 'done', 'Kanban drag moves a card to done');
  assert.equal(await page.locator(`.board-column[data-status="done"] [data-drag-quest="${quest.id}"]`).count(), 1);
  await screenshot('board.png');

  await page.locator('[data-view="history"]').click();
  await page.locator('#history-project').selectOption(project.id);
  assert.equal(await page.locator('[data-completion]').count(), 1);
  await page.locator('#history-from').fill(tomorrow);
  await page.locator('#history-from').press('Tab');
  assert.equal(await page.locator('[data-completion]').count(), 0, 'date filter excludes earlier completion');
  await page.locator('#history-from').fill(today);
  await page.locator('#history-to').fill(today);
  await page.locator('#history-to').press('Tab');
  assert.equal(await page.locator('[data-completion]').count(), 1, 'completion appears for its actual day');
  await page.locator('[data-undo-completion]').click();
  await eventually(async () => (await state()).quests.find(item => item.id === quest.id).status !== 'done', 'undo completion from history');

  await page.locator('[data-view="journal"]').click();
  await page.locator('#journal-search').fill('Интерфейсный квест');
  await page.locator(`[data-quest="${quest.id}"]`).click();
  await page.locator(`[data-delete-quest="${quest.id}"]`).click();
  await page.locator('[data-action="confirm-delete"]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal((await state()).quests.some(item => item.id === quest.id), false);
  await page.locator('#journal-search').fill('');
  await page.locator(`[data-delete-project="${project.id}"]`).click();
  await page.locator('[data-action="confirm-delete"]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal((await state()).projects.some(item => item.id === project.id), false);

  await page.locator('#journal-search').fill('Проверить сервис извне');
  await page.locator('[data-quest="fixture-check"]').click();
  await page.locator('[data-edit-quest="fixture-check"]').click();
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Несохранённый черновик должен остаться.');
  await page.keyboard.press('Control+b');
  await page.locator('#cover-stage').waitFor({ state: 'visible' });
  await page.keyboard.press('Control+b');
  await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('textbox', { name: 'Описание', exact: true }).inputValue(), 'Несохранённый черновик должен остаться.', 'closing and reopening the book preserves the editor draft');
  const raw = await fs.readFile(source, 'utf8');
  await fs.writeFile(source, raw.replace('Проверить сервис извне ^task-fixture-check', 'Проверить сервис извне снова ^task-fixture-check'), 'utf8');
  await page.locator('#draft-refresh-note').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('textbox', { name: 'Описание', exact: true }).inputValue(), 'Несохранённый черновик должен остаться.');
  await page.locator('#edit-form button[type="submit"]').click();
  await eventually(async () => /измен|обнов|конфликт|свер/i.test(await page.locator('#dialog-error').innerText()), 'stale editor asks for conflict review');
  assert.match(await fs.readFile(source, 'utf8'), /Проверить сервис извне снова/);
  assert.equal(await page.getByRole('textbox', { name: 'Описание', exact: true }).inputValue(), 'Несохранённый черновик должен остаться.');
  await page.locator('[data-action="cancel-draft"]').click();
  await page.locator('#journal-search').fill('');
  const finalBounds = await book.boundingBox();
  assert.equal(finalBounds.width, initialBounds.width);
  assert.equal(finalBounds.height, initialBounds.height);
  await screenshot('journal.png');
}

async function main() {
  await fixture();
  await launch();
  await check('imports a generic source vault and excludes employer projects', async () => {
    const current = await state();
    assert.equal(current.quests.some(q => q.id === 'fixture-check'), true);
    assert.equal(current.quests.some(q => q.id === 'employer-fixture'), false);
    assert.equal(current.quests.find(q => q.id === 'fixture-check').completedAt, null);
  });
  await check('source edits synchronize and stale writes preserve external content', sourceSyncAndConflict);
  await check('public API CRUD, urgency, scheduling, completion, undo and restart persistence', apiRoundTrip);
  await check('existing recurrence records history and remains active', recurrence);
  await check('book UI, editors, history, calendar, Kanban and fixed bounds', uiSmoke);
  assert.deepEqual(rendererErrors, [], 'renderer must not produce uncaught errors');
  process.stdout.write(`\n${checks.length} desktop smoke checks passed.\n`);
}

main().catch(async error => {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error}\n`);
  if (page && temp) await screenshot('failure.png').catch(() => {});
  process.stderr.write(`Fixture retained for diagnosis: ${temp || '(not created)'}\n`);
}).finally(async () => {
  if (application) await application.close().catch(() => {});
  if (!process.exitCode && temp && !process.env.QUEST_BOOK_KEEP_E2E) {
    const parent = path.resolve(os.tmpdir());
    const target = path.resolve(temp);
    assert.ok(target.startsWith(`${parent}${path.sep}`) && path.basename(target).startsWith('quest-book-e2e-'));
    await fs.rm(target, { recursive: true, force: true });
  } else if (temp) process.stdout.write(`Artifacts: ${temp}\n`);
});
