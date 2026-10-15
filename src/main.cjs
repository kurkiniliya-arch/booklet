'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { QuestStore } = require('./store.cjs');
const { layoutFor, centerForLayouts, boundsAtCenter } = require('./window-layout.cjs');

const arg = name => {
  const exact = process.argv.indexOf(`--${name}`);
  if (exact >= 0 && process.argv[exact + 1] && !process.argv[exact + 1].startsWith('--')) return process.argv[exact + 1];
  const inline = process.argv.find(value => value.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
};
const testMode = process.argv.includes('--test-mode');
// Keep the existing profile when the visible product name changes.
app.setPath('userData', arg('user-data-dir') ? path.resolve(arg('user-data-dir')) : path.join(app.getPath('appData'), 'Quest Book'));
app.setName('Книга проектов');
app.setAppUserModelId('com.kurkiniliya.questbook');
protocol.registerSchemesAsPrivileged([{ scheme: 'questbook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let mainWindow;
let store;
let settings = {};
let latestState;
let watcher;
let watchTimer;
let queue = Promise.resolve();
let openBook = true;
let rotatedBook = false;
let windowLayout;
let turnAnchor;
let pollTimer;
let closing = false;
const UI_URL = 'questbook://app/index.html';
const emptyState = (warning = '') => ({
  version: 1, revision: '', projects: [], quests: [], materials: [], completions: [],
  connection: { connected: false, vaultPath: settings.vaultPath || '', lastSync: null, warnings: warning ? [warning] : [] }
});
function serialize(work) {
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
async function saveSettings() {
  const target = settingsFile();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(settings, null, 2), 'utf8');
  await fsp.rename(temp, target);
}
async function loadSettings() {
  try { settings = JSON.parse(await fsp.readFile(settingsFile(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') settings = { warning: 'Не удалось прочитать настройки подключения. Выберите хранилище заново.' }; }
}
function pushState(state) {
  latestState = state;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('questbook:changed', state);
}
async function refreshStore(push = false) {
  if (!store) return latestState || emptyState(settings.warning);
  const state = await store.load();
  if (push && state.revision !== latestState?.revision) pushState(state);
  else latestState = state;
  return state;
}
function stopWatching() {
  clearTimeout(watchTimer);
  clearInterval(pollTimer);
  if (watcher) watcher.close();
  watcher = null;
}
function watchVault(vaultPath) {
  stopWatching();
  const schedule = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => serialize(async () => {
      try { await refreshStore(true); }
      catch (error) { pushState({ ...(latestState || emptyState()), connection: { ...(latestState?.connection || {}), warnings: [`Не удалось обновить хранилище: ${error.message}`] } }); }
    }), 650);
  };
  try {
    watcher = fs.watch(vaultPath, { recursive: true }, (_type, filename) => {
      if (!filename) return schedule();
      const relative = filename.toString().replaceAll('\\', '/');
      if (relative.split('/').some(part => part.startsWith('.'))) return;
      if (/\.md$/i.test(relative) || relative === '90 Система/Quest Book.json') schedule();
    });
    watcher.on('error', schedule);
  } catch { /* Polling covers filesystems without reliable native watchers. */ }
  pollTimer = setInterval(schedule, 15000);
  pollTimer.unref();
}
async function connectVault(vaultPath, bootstrapFile) {
  const resolved = await fsp.realpath(vaultPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Выберите папку хранилища Obsidian.');
  if (!(await fsp.stat(path.join(resolved, '.obsidian')).catch(() => null))?.isDirectory() && !testMode) {
    throw new Error('В выбранной папке нет хранилища Obsidian (.obsidian).');
  }
  const nextStore = new QuestStore(resolved, {
    bootstrapFile,
    backupRoot: path.join(app.getPath('userData'), 'backups')
  });
  const initialState = await nextStore.load();
  stopWatching();
  await store?.close?.();
  store = nextStore;
  settings.vaultPath = resolved;
  delete settings.warning;
  await saveSettings();
  watchVault(resolved);
  pushState(initialState);
  return initialState;
}
function verifySender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== UI_URL) {
    throw new Error('Недопустимый источник команды.');
  }
}
function rpc(channel, work) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      verifySender(event);
      return { ok: true, data: await serialize(() => work(...args)) };
    } catch (error) {
      return { ok: false, error: { message: error.message || 'Не удалось выполнить действие.', code: error.code || 'FAILED' } };
    }
  });
}
function liveWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Окно книги уже закрыто.');
  return mainWindow;
}
function currentDisplay() {
  return mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
}
function currentLayout() {
  const bounds = liveWindow().getBounds();
  const fit = layoutFor(currentDisplay().workArea, {open: openBook, rotated: rotatedBook});
  return {...windowLayout, width: bounds.width, height: bounds.height, turnScale: fit.turnScale};
}
function applyLayout(layout, center, workArea) {
  liveWindow().setBounds(boundsAtCenter(layout, center, workArea));
  windowLayout = layout;
  return currentLayout();
}
function resizeBook(open, rotated = rotatedBook) {
  const window = liveWindow();
  const work = currentDisplay().workArea;
  const layout = layoutFor(work, {open, rotated});
  const center = centerForLayouts(window.getBounds(), work, [layout]);
  turnAnchor = null;
  const result = applyLayout(layout, center, work);
  openBook = open;
  rotatedBook = rotated;
  return {...result, turnScale: layout.turnScale};
}
function prepareTurn(rotated) {
  if (!openBook) throw new Error('Сначала откройте книгу.');
  if (turnAnchor) {
    if (turnAnchor.rotated !== rotated) throw new Error('Дождитесь завершения поворота книги.');
    return currentLayout();
  }
  if (rotatedBook === rotated) return currentLayout();
  const window = liveWindow();
  const display = currentDisplay();
  const work = {...display.workArea};
  const layout = layoutFor(work, {open: true, rotated, turning: true});
  const finalLayout = layoutFor(work, {open: true, rotated});
  const center = centerForLayouts(window.getBounds(), work, [layout, finalLayout]);
  const result = applyLayout(layout, center, work);
  turnAnchor = {rotated, displayId: display.id, workArea: work, center};
  return result;
}
function finishTurn(rotated) {
  if (!turnAnchor) return resizeBook(true, rotated);
  if (turnAnchor.rotated !== rotated) throw new Error('Положение книги не совпадает с начатым поворотом.');
  const display = screen.getAllDisplays().find(item => item.id === turnAnchor.displayId) || currentDisplay();
  const work = {...display.workArea};
  const layout = layoutFor(work, {open: true, rotated});
  const savedCenter = turnAnchor.center;
  const center = centerForLayouts({x: savedCenter.x, y: savedCenter.y, width: 0, height: 0}, work, [layout]);
  const result = applyLayout(layout, center, work);
  rotatedBook = rotated;
  openBook = true;
  turnAnchor = null;
  return result;
}
function installHandlers() {
  rpc('questbook:load', () => refreshStore());
  rpc('questbook:refresh', () => refreshStore(true));
  rpc('questbook:dispatch', async command => {
    if (!store) throw new Error('Сначала подключите хранилище Obsidian.');
    if (!command || typeof command !== 'object' || typeof command.type !== 'string' || JSON.stringify(command).length > 500000) throw new Error('Некорректная команда.');
    const state = await store.dispatch(command);
    pushState(state);
    return state;
  });
  rpc('questbook:choose-vault', async () => {
    const chosen = await dialog.showOpenDialog(mainWindow, { title: 'Выберите хранилище Obsidian', properties: ['openDirectory'] });
    if (chosen.canceled) return null;
    return connectVault(chosen.filePaths[0]);
  });
  rpc('questbook:open-source', async relative => {
    const state = latestState;
    const known = [...(state?.materials || []).map(item => item.path), ...(state?.quests || []).map(item => item.sourcePath)];
    if (typeof relative !== 'string' || !known.includes(relative) || !/\.md$/i.test(relative)) throw new Error('Заметка не найдена в подключённой базе.');
    const root = await fsp.realpath(settings.vaultPath);
    const full = await fsp.realpath(path.resolve(root, relative));
    const rel = path.relative(root, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Заметка находится вне хранилища.');
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(full)}`);
    return true;
  });
  rpc('questbook:window', action => {
    const type = typeof action === 'string' ? action : action && typeof action === 'object' && !Array.isArray(action) ? action.type : null;
    if (type === 'minimize') { liveWindow().minimize(); return true; }
    if (type === 'close') { liveWindow().close(); return true; }
    if (type === 'layout') return currentLayout();
    if (type === 'close-book') return resizeBook(false);
    if (type === 'open-book') {
      const rotated = typeof action === 'string' || action.rotated === undefined ? rotatedBook : action.rotated;
      if (typeof rotated !== 'boolean') throw new Error('Некорректное положение книги.');
      return resizeBook(true, rotated);
    }
    if (type === 'prepare-turn' || type === 'finish-turn') {
      if (!action || typeof action !== 'object' || typeof action.rotated !== 'boolean') throw new Error('Укажите положение книги для поворота.');
      return type === 'prepare-turn' ? prepareTurn(action.rotated) : finishTurn(action.rotated);
    }
    throw new Error('Неизвестное действие окна.');
  });
}
async function createWindow() {
  const work = currentDisplay().workArea;
  const initial = layoutFor(work, {open: true, rotated: rotatedBook});
  const initialBounds = boundsAtCenter(initial, {x: work.x + work.width / 2, y: work.y + work.height / 2}, work);
  openBook = true;
  turnAnchor = null;
  windowLayout = initial;
  mainWindow = new BrowserWindow({
    ...initialBounds, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    title: 'Книга проектов', icon: path.join(__dirname, '../assets/book.png'), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => { if (!testMode) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; turnAnchor = null; windowLayout = null; });
  await mainWindow.loadURL(UI_URL);
}

const gotLock = testMode || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const rendererRoot = path.join(__dirname, 'renderer');
    protocol.handle('questbook', request => {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      let filename;
      try { filename = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
      const target = path.resolve(rendererRoot, '.' + filename);
      const relative = path.relative(rendererRoot, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).href).catch(() => new Response('Not found', { status: 404 }));
    });
    await loadSettings();
    const vault = arg('vault') || settings.vaultPath;
    if (vault) {
      try { await connectVault(vault, arg('bootstrap')); }
      catch (error) { latestState = emptyState(`Хранилище не подключено: ${error.message}`); }
    }
    installHandlers();
    await createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(error => { dialog.showErrorBox('Книга проектов', error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    stopWatching();
    queue.finally(async () => { await store?.close?.(); app.quit(); });
  });
}
