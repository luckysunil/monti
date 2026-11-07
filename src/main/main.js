const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellEnv } = require('./shell-env');
const { createStores } = require('./store');
const { DEFAULT_MACHINE, evaluate, AUTH_FAILURE_PATTERN } = require('./auth');
const { SessionManager } = require('./sessions');
const { ProjectService } = require('./projects');
const { scanLibrary } = require('./library');
const { startServer } = require('./server');
const { streamTools, managerTools } = require('./tools');
const { Manager } = require('./manager');

const AUTH_SESSION = '__auth__';
const AUTH_POLL_MS = 2 * 60 * 1000;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CURL = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl';

let win = null;
let stores = null;
let sessions = null;
let projects = null;
let manager = null;
let server = null;
let machine = null;
let auth = { state: 'checking', account: null, reason: null };
let lastAuthProbe = 0;
let lastReload = 0;
const live = new Map(); // sessionId -> { state: 'working' | 'needs-you' | 'idle', message, at }

/* ---------- plumbing ---------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let stateTimer = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    send('state', buildState());
  }, 60);
}

function sessionStatus(id) {
  if (!sessions.isRunning(id)) return 'stopped';
  const l = live.get(id);
  return l ? l.state : 'idle';
}

function buildState() {
  return {
    machine: { name: machine.machineName, role: machine.role },
    projects: projects.snapshot(),
    sessions: sessions.list().map((s) => ({ ...s, status: sessionStatus(s.id), statusMessage: (live.get(s.id) || {}).message || null })),
    manager: manager.snapshot(),
  };
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

function probeAuthSoon() {
  const t = Date.now();
  if (t - lastAuthProbe < 10000) return;
  lastAuthProbe = t;
  refreshAuth();
}

function requireAuth() {
  if (auth.state !== 'ok') throw new Error('Sign in to Claude first.');
}

/* ---------- hooks: live status of each session ---------- */

function hookSettings() {
  const cmd = (event) =>
    `${CURL} -s -m 3 -X POST -H 'Authorization: Bearer ${server.token}' -H 'Content-Type: application/json' --data-binary @- '${server.url}/hook/${event}' >/dev/null 2>&1 || true`;
  const entry = (event) => [{ hooks: [{ type: 'command', command: cmd(event) }] }];
  return {
    hooks: {
      UserPromptSubmit: entry('UserPromptSubmit'),
      PostToolUse: entry('PostToolUse'),
      Notification: entry('Notification'),
      Stop: entry('Stop'),
      SessionEnd: entry('SessionEnd'),
    },
  };
}

function onHook(event, payload) {
  const id = payload && payload.session_id;
  const s = id && sessions.get(id);
  if (!s) return;
  const prev = live.get(id) || {};
  let next = prev.state || 'idle';
  let message = null;
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') next = 'working';
  else if (event === 'Stop') next = 'idle';
  else if (event === 'SessionEnd') next = 'idle';
  else if (event === 'Notification') {
    message = String(payload.message || '');
    next = /permission|approve|allow|needs your/i.test(message) ? 'needs-you' : 'idle';
  }
  live.set(id, { state: next, message, at: Date.now() });
  if (next === 'needs-you' && prev.state !== 'needs-you') {
    if (s.projectId) {
      try {
        projects.log(s.projectId, s.name, `needs you: ${message || 'waiting for your input'}`);
        projects.save(s.projectId);
      } catch {}
    }
    if (Notification.isSupported() && win && !win.isFocused()) {
      new Notification({ title: `${s.name} needs you`, body: message || 'Waiting for your input', silent: false }).show();
    }
  }
  pushState();
}

function streamStatusText(projectId, streamId) {
  const list = sessions.list().filter((x) => x.projectId === projectId && x.streamId === streamId);
  if (!list.length) return 'no sessions';
  return list.map((x) => `${x.name}: ${sessionStatus(x.id)}`).join(', ');
}

/* ---------- what each stream session is told ---------- */

function briefFor(s) {
  const p = projects.get(s.projectId);
  const stream = s.streamId ? p.data.streams.find((x) => x.id === s.streamId) : null;
  const where = stream
    ? `Your stream: "${stream.name}"${stream.description ? ` — ${stream.description}` : ''}. Workspace: ${s.cwd}${stream.workspace.branch ? ` (git branch ${stream.workspace.branch})` : ''}.`
    : `You are a general session for this project, working in ${s.cwd}.`;
  return `You are working inside Monti, a dashboard where the owner runs several Claude sessions in parallel.
Project: "${p.data.name}" (${p.meta.type}) at ${p.meta.root}.
${where}
Other sessions work on other streams in parallel, in their own folders. Stay within your workspace.

Monti tools (mcp__monti__*) keep the owner's overview accurate:
- Call get_context first to see your task list, dependencies and the project memory.
${stream ? `- If your stream has no tasks, propose 3–8 small tasks with add_tasks (effort in hours: 1, 2, 3, 5 or 8). Add a checkpoint wherever the owner should decide or review.
- Call start_task before working on a task and complete_task with a one-line note when it's done.
- When you need the owner's judgement, call request_review with a clear question, then stop and wait for their reply.` : '- Use list_todos, add_todo and complete_todo for follow-ups.'}
- At milestones, keep the project memory current with update_memory ("Current state", "Next steps", "Key decisions"); keep it short.
- Before stopping for the day, write a short handoff with write_handoff.
- Work is local-first: don't push to remotes or create GitHub repos unless the owner asks.`;
}

function buildArgs(s, { resume }) {
  const args = [];
  if (s.projectId) {
    const mcp = { mcpServers: { monti: { type: 'http', url: `${server.url}/mcp/s-${s.id}`, headers: { Authorization: `Bearer ${server.token}` } } } };
    args.push('--allowedTools', 'mcp__monti', '--mcp-config', JSON.stringify(mcp));
  }
  // --settings takes one value, so it safely precedes the optional prompt arguments.
  args.push('--settings', JSON.stringify(hookSettings()));
  if (!resume && s.projectId) {
    try {
      args.push('--append-system-prompt', briefFor(s));
    } catch {}
  }
  return args;
}

function toolsFor(scope) {
  const ctx = { projects, sessions, projectsDir: PROJECTS_DIR, statusOf: streamStatusText, sessionStatus };
  if (scope === 'manager') return managerTools(ctx);
  if (scope.startsWith('s-')) {
    const s = sessions.get(scope.slice(2));
    if (!s || !s.projectId) return null;
    try {
      projects.get(s.projectId);
    } catch {
      return null;
    }
    return streamTools(ctx, s);
  }
  return null;
}

/* ---------- window ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: 'Monti',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => {
    if (Date.now() - lastReload > 5000) {
      lastReload = Date.now();
      projects.reloadAll();
      projects.refreshAllGit();
      pushState();
    }
  });

  // Dev aid: MONTI_SCREENSHOT=/path/to.png saves the window a few seconds after launch.
  if (process.env.MONTI_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.MONTI_SCREENSHOT_JS) await win.webContents.executeJavaScript(process.env.MONTI_SCREENSHOT_JS).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.MONTI_SCREENSHOT, image.toPNG());
      }, Number(process.env.MONTI_SCREENSHOT_DELAY || 5000));
    });
  }
}

/* ---------- IPC ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    const out = await fn(arg || {});
    pushState();
    return out;
  });
}

function runningSessionFor(projectId, streamId) {
  return sessions.list().find((x) => x.projectId === projectId && x.streamId === streamId && x.running);
}

function typeInto(id, text) {
  if (!sessions.write(id, text)) return false;
  setTimeout(() => sessions.write(id, '\r'), 350);
  return true;
}

function registerIpc() {
  handle('app:info', () => ({
    machineName: machine.machineName,
    role: machine.role,
    dataRoot: stores.data.root,
    claudeFound: Boolean(shellEnv().claudeBin),
    home: os.homedir(),
  }));
  handle('state:get', () => buildState());

  // account
  handle('auth:status', () => auth);
  handle('auth:refresh', () => refreshAuth());
  handle('auth:login', ({ sso, cols, rows }) => {
    const { claudeBin } = shellEnv();
    sessions.kill(AUTH_SESSION);
    const args = ['auth', 'login'];
    if (sso) args.push('--sso');
    sessions.spawn(AUTH_SESSION, claudeBin, args, os.homedir(), cols, rows);
    return true;
  });
  handle('auth:logout', () => {
    const { claudeBin, env } = shellEnv();
    return new Promise((resolve) => execFile(claudeBin, ['auth', 'logout'], { env, timeout: 20000 }, () => resolve(refreshAuth())));
  });
  handle('auth:confirm', ({ lockToOrg }) => {
    machine.firstRunConfirmed = true;
    if (lockToOrg && auth.account && auth.account.orgId) machine.claudeAccount.allowedOrgIds = [auth.account.orgId];
    stores.machine.writeJSON('machine.json', machine);
    return refreshAuth();
  });
  handle('machine:setRole', ({ role }) => {
    machine.role = role === 'pull-only' ? 'pull-only' : 'owner';
    stores.machine.writeJSON('machine.json', machine);
    return machine.role;
  });

  // projects
  handle('projects:createRepo', (a) => projects.createRepoProject(a));
  handle('projects:createCustomer', (a) => projects.createCustomerProject(a));
  handle('projects:remove', ({ id }) => {
    for (const s of sessions.list().filter((x) => x.projectId === id)) sessions.update(s.id, { projectId: null, streamId: null });
    projects.removeProject(id);
  });
  handle('projects:reload', () => {
    projects.reloadAll();
    projects.refreshAllGit();
  });
  handle('projects:openMemory', ({ id }) => shell.openPath(path.join(projects.get(id).meta.root, 'AGENTS.md')));
  handle('projects:reveal', ({ id }) => shell.openPath(projects.get(id).meta.root));

  // streams
  handle('streams:create', async ({ projectId, startSession, ...rest }) => {
    const s = await projects.createStream(projectId, rest);
    let session = null;
    if (startSession) {
      const p = projects.get(projectId);
      session = sessions.create({
        name: s.name,
        cwd: projects.workspacePath(p, s),
        projectId,
        streamId: s.id,
        initialPrompt: 'Start on this stream: call get_context, plan tasks if there are none, then begin the first task.',
      });
    }
    return { stream: s, session };
  });
  handle('streams:update', ({ projectId, streamId, patch }) => projects.updateStream(projectId, streamId, patch));
  handle('streams:remove', ({ projectId, streamId }) => {
    for (const s of sessions.list().filter((x) => x.streamId === streamId)) sessions.update(s.id, { streamId: null });
    projects.removeStream(projectId, streamId);
  });

  // tasks
  handle('tasks:add', ({ projectId, streamId, tasks }) => projects.addTasks(projectId, streamId, tasks, { by: 'you' }));
  handle('tasks:update', ({ projectId, streamId, taskId, patch }) => projects.updateTask(projectId, streamId, taskId, patch, 'you'));
  handle('tasks:remove', ({ projectId, streamId, taskId }) => projects.removeTask(projectId, streamId, taskId));
  handle('tasks:approve', ({ projectId, streamId, taskId, note }) => {
    const t = projects.task(projectId, streamId, taskId);
    const question = t.question || t.title;
    projects.updateTask(projectId, streamId, taskId, { status: 'done', note: note ? `you: ${note}` : 'approved by you' }, 'you');
    const run = runningSessionFor(projectId, streamId);
    const delivered = run ? typeInto(run.id, `[Monti] The owner answered "${question}": ${note || 'Approved, go ahead.'}`) : false;
    return { delivered };
  });

  // to-dos
  handle('todos:add', ({ projectId, title, due }) => projects.addTodo(projectId, { title, due, by: 'you' }));
  handle('todos:update', ({ projectId, todoId, patch }) => projects.updateTodo(projectId, todoId, patch, 'you'));
  handle('todos:remove', ({ projectId, todoId }) => projects.removeTodo(projectId, todoId));

  // sessions
  handle('sessions:create', ({ projectId, streamId, name, cwd, initialPrompt }) => {
    let folder = cwd;
    if (!folder && projectId) {
      const p = projects.get(projectId);
      const s = streamId ? projects.stream(projectId, streamId) : null;
      folder = s ? projects.workspacePath(p, s) : p.meta.root;
    }
    if (!folder) throw new Error('Choose a folder for this session.');
    return sessions.create({ name, cwd: folder, projectId: projectId || null, streamId: streamId || null, initialPrompt });
  });
  handle('sessions:adopt', ({ id, cwd, title, projectId, streamId }) => {
    const existing = sessions.get(id);
    if (existing) return existing;
    return sessions.create({ id, name: title, cwd, projectId: projectId || null, streamId: streamId || null, kind: 'library' });
  });
  handle('sessions:attach', ({ id, projectId, streamId }) => sessions.update(id, { projectId: projectId || null, streamId: streamId || null }));
  handle('sessions:rename', ({ id, name }) => sessions.update(id, { name }));
  handle('sessions:remove', ({ id }) => {
    live.delete(id);
    sessions.remove(id);
  });
  handle('sessions:stop', ({ id }) => sessions.kill(id));
  handle('sessions:start', ({ id, cols, rows }) => {
    requireAuth();
    return sessions.start(id, cols, rows);
  });
  handle('sessions:integrate', ({ projectId }) => {
    if (machine.role === 'pull-only') throw new Error('This Mac is pull-only, so it does not integrate branches.');
    const p = projects.get(projectId);
    const done = p.data.streams.filter((s) => s.workspace.branch && (s.status === 'done' || (s.tasks.length && s.tasks.every((t) => t.status === 'done'))));
    const all = p.data.streams.filter((s) => s.workspace.branch);
    if (!all.length) throw new Error('No stream has its own branch yet, so there is nothing to integrate.');
    const list = (done.length ? done : all).map((s) => `${s.workspace.branch} (${s.name})`).join(', ');
    const base = (p.git && p.git.branch) || 'main';
    return sessions.create({
      name: 'Integrate branches',
      cwd: p.meta.root,
      projectId,
      kind: 'integrator',
      initialPrompt: `Integrate these stream branches into ${base}: ${list}. For each one: show me what it changes, merge it, resolve simple conflicts and ask me about anything non-obvious, then run the tests. Do not push. Finish with a short summary and update the project memory's "Current state".`,
    });
  });
  ipcMain.on('sessions:write', (_e, { id, data }) => sessions.write(id, data));
  ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => sessions.resize(id, cols, rows));

  // library
  handle('library:scan', () => scanLibrary(PROJECTS_DIR));

  // manager
  handle('manager:ask', ({ text }) => {
    requireAuth();
    manager.ask(text);
  });
  handle('manager:stop', () => manager.stop());
  handle('manager:reset', () => manager.reset());

  handle('dialog:folder', async ({ title }) => {
    const res = await dialog.showOpenDialog(win, {
      title: title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.join(os.homedir(), 'Sandbox'),
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

/* ---------- boot ---------- */

app.whenReady().then(async () => {
  app.setName('Monti');
  stores = createStores();
  loadMachine();
  const { env, claudeBin } = shellEnv();

  projects = new ProjectService({ machineStore: stores.machine, dataRoot: stores.data.root, onChange: pushState });
  server = await startServer({ onHook, toolsFor });

  sessions = new SessionManager({
    store: stores.machine,
    claudeBin,
    env,
    projectsDir: PROJECTS_DIR,
    buildArgs,
    onChange: pushState,
    onData: (id, data) => {
      send('sessions:data', { id, data });
      if (id !== AUTH_SESSION && AUTH_FAILURE_PATTERN.test(data)) probeAuthSoon();
    },
    onExit: (id, exitCode) => {
      live.delete(id);
      send('sessions:exit', { id, exitCode });
      if (id === AUTH_SESSION) refreshAuth();
    },
  });

  manager = new Manager({
    store: stores.machine,
    claudeBin,
    env,
    cwd: stores.data.root,
    projectsDir: PROJECTS_DIR,
    server,
    addDirs: () => projects.snapshot().filter((p) => !p.missing).map((p) => p.root),
    onChange: (snap) => send('manager', snap),
  });

  registerIpc();
  createWindow();
  projects.refreshAllGit();
  refreshAuth();
  setInterval(refreshAuth, AUTH_POLL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (sessions) sessions.killAll();
  if (manager) manager.stop();
});

app.on('window-all-closed', () => {
  if (sessions) sessions.killAll();
  app.quit();
});
