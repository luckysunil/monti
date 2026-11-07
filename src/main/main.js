const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { shellEnv } = require('./shell-env');
const { createStores } = require('./store');
const { DEFAULT_MACHINE, evaluate, AUTH_FAILURE_PATTERN } = require('./auth');
const { SessionManager } = require('./sessions');

const AUTH_SESSION = '__auth__';
const AUTH_POLL_MS = 2 * 60 * 1000;

let win = null;
let stores = null;
let sessions = null;
let machine = null;
let auth = { state: 'checking', account: null, reason: null };
let lastAuthProbe = 0;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function loadMachine() {
  const saved = stores.machine.readJSON('machine.json', null);
  machine = {
    ...DEFAULT_MACHINE,
    ...(saved || {}),
    claudeAccount: { ...DEFAULT_MACHINE.claudeAccount, ...((saved && saved.claudeAccount) || {}) },
  };
  if (!saved) stores.machine.writeJSON('machine.json', machine);
}

async function refreshAuth() {
  const { env, claudeBin } = shellEnv();
  auth = await evaluate(claudeBin, env, machine);
  send('auth:changed', auth);
  return auth;
}

// A running session printed something that looks like an auth failure.
function probeAuthSoon() {
  const now = Date.now();
  if (now - lastAuthProbe < 10000) return;
  lastAuthProbe = now;
  refreshAuth();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Conductor',
    backgroundColor: '#0f1218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dev aid: CONDUCTOR_SCREENSHOT=/path/to.png saves the window a few seconds after launch.
  if (process.env.CONDUCTOR_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.CONDUCTOR_SCREENSHOT, image.toPNG());
      }, Number(process.env.CONDUCTOR_SCREENSHOT_DELAY || 5000));
    });
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    machineName: machine.machineName,
    role: machine.role,
    dataRoot: stores.data.root,
    claudeFound: Boolean(shellEnv().claudeBin),
    home: os.homedir(),
  }));

  ipcMain.handle('auth:status', () => auth);
  ipcMain.handle('auth:refresh', () => refreshAuth());

  ipcMain.handle('auth:login', (_e, { sso, cols, rows } = {}) => {
    const { claudeBin } = shellEnv();
    sessions.kill(AUTH_SESSION);
    const args = ['auth', 'login'];
    if (sso) args.push('--sso');
    sessions.spawn(AUTH_SESSION, claudeBin, args, os.homedir(), cols, rows);
    return true;
  });

  ipcMain.handle('auth:logout', () => {
    const { claudeBin, env } = shellEnv();
    return new Promise((resolve) => {
      execFile(claudeBin, ['auth', 'logout'], { env, timeout: 20000 }, () => resolve(refreshAuth()));
    });
  });

  ipcMain.handle('auth:confirm', (_e, { lockToOrg } = {}) => {
    machine.firstRunConfirmed = true;
    if (lockToOrg && auth.account && auth.account.orgId) {
      machine.claudeAccount.allowedOrgIds = [auth.account.orgId];
    }
    stores.machine.writeJSON('machine.json', machine);
    return refreshAuth();
  });

  ipcMain.handle('sessions:list', () => sessions.list());

  ipcMain.handle('sessions:create', (_e, { name, cwd }) => sessions.create({ name, cwd }));

  ipcMain.handle('sessions:rename', (_e, { id, name }) => sessions.rename(id, name));

  ipcMain.handle('sessions:remove', (_e, { id }) => sessions.remove(id));

  ipcMain.handle('sessions:start', (_e, { id, cols, rows }) => {
    if (auth.state !== 'ok') throw new Error('Sign in to Claude before starting a session.');
    return sessions.start(id, cols, rows);
  });

  ipcMain.on('sessions:write', (_e, { id, data }) => sessions.write(id, data));
  ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => sessions.resize(id, cols, rows));

  ipcMain.handle('dialog:folder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the folder this session works in',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.join(os.homedir(), 'Sandbox'),
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

app.whenReady().then(async () => {
  stores = createStores();
  loadMachine();
  const { env, claudeBin } = shellEnv();

  sessions = new SessionManager({
    store: stores.machine,
    claudeBin,
    env,
    projectsDir: path.join(os.homedir(), '.claude', 'projects'),
    onData: (id, data) => {
      send('sessions:data', { id, data });
      if (id !== AUTH_SESSION && AUTH_FAILURE_PATTERN.test(data)) probeAuthSoon();
    },
    onExit: (id, exitCode) => {
      send('sessions:exit', { id, exitCode });
      if (id === AUTH_SESSION) refreshAuth();
    },
  });

  registerIpc();
  createWindow();
  refreshAuth();
  setInterval(refreshAuth, AUTH_POLL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (sessions) sessions.killAll();
});

app.on('window-all-closed', () => {
  if (sessions) sessions.killAll();
  app.quit();
});
