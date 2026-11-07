const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'app:info', 'state:get',
  'auth:status', 'auth:refresh', 'auth:login', 'auth:logout', 'auth:confirm', 'machine:setRole',
  'projects:createRepo', 'projects:createCustomer', 'projects:remove', 'projects:reload', 'projects:openMemory', 'projects:reveal',
  'streams:create', 'streams:update', 'streams:remove',
  'tasks:add', 'tasks:update', 'tasks:remove', 'tasks:approve',
  'todos:add', 'todos:update', 'todos:remove',
  'sessions:create', 'sessions:adopt', 'sessions:attach', 'sessions:rename', 'sessions:remove', 'sessions:stop', 'sessions:start', 'sessions:integrate',
  'library:scan',
  'manager:ask', 'manager:stop', 'manager:reset',
  'dialog:folder',
];

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('monti', {
  call: (channel, arg) => {
    if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    return ipcRenderer.invoke(channel, arg);
  },
  write: (id, data) => ipcRenderer.send('sessions:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', { id, cols, rows }),
  onState: on('state'),
  onAuth: on('auth:changed'),
  onManager: on('manager'),
  onData: on('sessions:data'),
  onExit: on('sessions:exit'),
  onMenuSignOut: on('menu:signout'),
});
