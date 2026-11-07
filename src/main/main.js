const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
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
const { Planner } = require('./planner');

const AUTH_SESSION = '__auth__';
const KICKOFF = 'Start on this stream: call get_context, plan tasks if there are none, then begin the first task.';
const AUTH_POLL_MS = 2 * 60 * 1000;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CURL = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl';

let win = null;
let stores = null;
let sessions = null;
let projects = null;
let manager = null;
let planner = null;
let server = null;
let machine = null;
let auth = { state: 'checking', account: null, reason: null };
let lastAuthProbe = 0;
let signedOut = false; // set when the owner signs out from Monti, cleared on the next sign-in
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
    planning: planner.snapshot(),
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
  if (auth.account) signedOut = false;
  else if (signedOut) auth = { state: 'signed-out', account: null, reason: null };
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

// What a planned stream owns and which interfaces it provides or uses.
function contractBrief(p, stream) {
  const ifaces = (p.data.plan && p.data.plan.interfaces) || [];
  const pick = (names) => ifaces.filter((i) => (names || []).includes(i.name));
  const fmt = (list) => list.map((i) => `- ${i.name} (${i.kind}, ${i.location || 'location tbd'}${i.exists ? '' : ', not written yet'}):\n${String(i.definition || '').trim().split('\n').map((l) => `    ${l}`).join('\n')}`).join('\n');
  const deps = (stream.dependsOn || []).map((d) => p.data.streams.find((x) => x.id === d)).filter(Boolean);
  const parts = [];
  if (stream.ownedPaths && stream.ownedPaths.length) {
    parts.push(`Your stream owns these paths: ${stream.ownedPaths.join(', ')}. Only change files there. If you need a change in a path another stream owns, ask the owner with request_review instead of editing it.`);
  }
  const provides = pick(stream.provides);
  const consumes = pick(stream.consumes);
  if (provides.length) parts.push(`Interfaces you implement (keep to these contracts exactly):\n${fmt(provides)}`);
  if (consumes.length) parts.push(`Interfaces you use (code against these, not other streams' internals; use a stub or mock if the provider isn't finished):\n${fmt(consumes)}`);
  if (provides.length || consumes.length) parts.push('All contracts are in .monti/interfaces.md in the main project folder. Changing a contract needs the owner\'s approval through request_review.');
  if (deps.length) parts.push(`This stream depends on: ${deps.map((d) => d.name).join(', ')}. When they have finished and been merged, merge the latest main branch into your branch before continuing.`);
  return parts.length ? `\n${parts.join('\n\n')}\n` : '';
}

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
${stream ? contractBrief(p, stream) : ''}

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

function startPlanning(projectId, goal) {
  requireAuth();
  const p = projects.get(projectId);
  if (p.meta.type !== 'repo') throw new Error('Planning from code works for repo projects.');
  const g = goal != null ? goal : (p.data.plan && p.data.plan.goal) || null;
  planner
    .run({
      projectId,
      root: p.meta.root,
      name: p.data.name,
      goal: g,
      existing: p.data.streams,
      onPlan: (plan) => projects.applyPlan(projectId, plan, g),
    })
    .catch(() => {});
  pushState();
  return true;
}

function streamDone(s) {
  return s.status === 'done' || (s.tasks.length > 0 && s.tasks.every((t) => t.status === 'done'));
}

// Starts a session for every stream that can run now: not done, dependencies done, no session yet.
async function startReadyStreams(projectId) {
  requireAuth();
  const p = projects.get(projectId);
  const created = [];
  for (const s of p.data.streams) {
    if (streamDone(s)) continue;
    const deps = (s.dependsOn || []).map((d) => p.data.streams.find((x) => x.id === d)).filter(Boolean);
    if (deps.some((d) => !streamDone(d))) continue;
    if (sessions.list().some((x) => x.projectId === projectId && x.streamId === s.id)) continue;
    const cwd = await projects.ensureWorkspace(projectId, s.id);
    created.push(sessions.create({ name: s.name, cwd, projectId, streamId: s.id, initialPrompt: KICKOFF }));
  }
  return created;
}

function toolsFor(scope) {
  const ctx = { projects, sessions, projectsDir: PROJECTS_DIR, statusOf: streamStatusText, sessionStatus, plan: startPlanning };
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

function buildMenu() {
  const signOut = { label: 'Sign Out…', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu:signout') };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Monti', submenu: [{ role: 'about' }, { type: 'separator' }, signOut, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

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
  // Signing out stops every session and the Manager, then signs Claude Code out on this Mac.
  // Sessions keep their IDs, so they resume where they left off after the next sign-in.
  handle('auth:logout', () => {
    const { claudeBin, env } = shellEnv();
    sessions.killAll();
    manager.stop();
    live.clear();
    signedOut = true;
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
  handle('projects:createRepo', async ({ autoPlan, goal, ...a }) => {
    const id = await projects.createRepoProject(a);
    if (autoPlan && auth.state === 'ok') startPlanning(id, goal || null);
    return id;
  });
  handle('projects:plan', ({ id, goal }) => startPlanning(id, goal));
  handle('projects:stopPlan', ({ id }) => planner.stop(id));
  handle('streams:startReady', ({ projectId }) => startReadyStreams(projectId));
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
  handle('projects:openFile', ({ id, rel }) => {
    const root = projects.get(id).meta.root;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root)) throw new Error('That file is outside the project.');
    return shell.openPath(target);
  });

  // streams
  handle('streams:create', async ({ projectId, startSession, ...rest }) => {
    const s = await projects.createStream(projectId, rest);
    let session = null;
    if (startSession) {
      session = sessions.create({
        name: s.name,
        cwd: await projects.ensureWorkspace(projectId, s.id),
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
  handle('sessions:create', async ({ projectId, streamId, name, cwd, initialPrompt }) => {
    let folder = cwd;
    if (!folder && projectId) {
      const p = projects.get(projectId);
      folder = streamId ? await projects.ensureWorkspace(projectId, streamId) : p.meta.root;
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

  planner = new Planner({ claudeBin, env, onChange: pushState });

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
  buildMenu();
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
  if (planner) for (const id of planner.runs.keys()) planner.stop(id);
  if (manager) manager.stop();
});

app.on('window-all-closed', () => {
  if (sessions) sessions.killAll();
  app.quit();
});
