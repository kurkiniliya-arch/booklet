'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function request(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || 'Не удалось выполнить действие.');
    error.code = response?.error?.code || 'FAILED';
    throw error;
  }
  return response.data;
}

contextBridge.exposeInMainWorld('questBook', {
  load: () => request('questbook:load'),
  refresh: () => request('questbook:refresh'),
  dispatch: command => request('questbook:dispatch', command),
  chooseVault: () => request('questbook:choose-vault'),
  openSource: path => request('questbook:open-source', path),
  windowAction: action => request('questbook:window', action),
  onChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Ожидается функция.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('questbook:changed', listener);
    return () => ipcRenderer.removeListener('questbook:changed', listener);
  }
});
