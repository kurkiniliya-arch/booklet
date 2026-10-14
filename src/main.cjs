'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { QuestStore } = require('./store.cjs');

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
function windowSize(open) {
  const display = mainWindow ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
  const width = Math.min(open ? 1140 : 410, display.workAreaSize.width - 24);
  const height = Math.min(open ? 750 : 580, display.workAreaSize.height - 24);
  return { width: Math.max(320, width), height: Math.max(400, height), display };
}
function resizeBook(open) {
  openBook = open;
  const old = mainWindow.getBounds();
  const { width, height, display } = windowSize(open);
  const work = display.workArea;
  const x = Math.max(work.x, Math.min(Math.round(old.x + (old.width - width) / 2), work.x + work.width - width));
  const y = Math.max(work.y, Math.min(Math.round(old.y + (old.height - height) / 2), work.y + work.height - height));
  mainWindow.setBounds({ x, y, width, height });
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
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'close') mainWindow.close();
    else if (action === 'open-book') resizeBook(true);
    else if (action === 'close-book') resizeBook(false);
    else throw new Error('Неизвестное действие окна.');
    return true;
  });
}
async function createWindow() {
  const { width, height } = windowSize(true);
  mainWindow = new BrowserWindow({
    width, height, frame: false, transparent: true, backgroundColor: '#00000000',
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
  mainWindow.on('closed', () => { mainWindow = null; });
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
