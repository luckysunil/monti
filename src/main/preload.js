const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('conductor', {
  info: () => ipcRenderer.invoke('app:info'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    refresh: () => ipcRenderer.invoke('auth:refresh'),
    login: (opts) => ipcRenderer.invoke('auth:login', opts),
    logout: () => ipcRenderer.invoke('auth:logout'),
    confirm: (opts) => ipcRenderer.invoke('auth:confirm', opts),
    onChange: on('auth:changed'),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (s) => ipcRenderer.invoke('sessions:create', s),
    rename: (id, name) => ipcRenderer.invoke('sessions:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('sessions:remove', { id }),
    start: (id, cols, rows) => ipcRenderer.invoke('sessions:start', { id, cols, rows }),
    write: (id, data) => ipcRenderer.send('sessions:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', { id, cols, rows }),
    onData: on('sessions:data'),
    onExit: on('sessions:exit'),
  },
});
