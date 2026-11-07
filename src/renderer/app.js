/* Monti renderer: state, navigation, dock, Manager, modals and the account gate. */
const AUTH_SESSION = '__auth__';
const KICKOFF = 'Start on this stream: call get_context, plan tasks if there are none, then begin the first task.';

let state = { machine: { name: '', role: 'owner' }, projects: [], sessions: [], manager: { busy: false, messages: [] } };
let auth = { state: 'checking' };
let info = null;
let loginTerm = null;
let manageOpen = false;

const ui = {
  view: { kind: 'welcome' },
  selected: {}, // projectId -> streamId
  active: {}, // view key -> sessionId
  answering: null,
  menu: null,
  library: { items: null, q: '', folder: '', loading: false },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const currentProject = () => (ui.view.kind === 'project' ? state.projects.find((p) => p.id === ui.view.id) : null);
const viewKey = () => (ui.view.kind === 'project' ? ui.view.id : 'loose');
const selectedStream = (p) => (p ? p.streams.find((s) => s.id === ui.selected[p.id]) || p.streams[0] : null);
const saveUi = () => store.set('ui', { view: ui.view, selected: ui.selected, active: ui.active });

/* ---------- rendering ---------- */

function render() {
  renderMachine();
  renderNav();
  renderOverview();
  renderDock();
  renderWatch();
}

function renderMachine() {
  $('#machine-name').textContent = state.machine.name || (info && info.machineName) || '';
  $('#machine-role').textContent = state.machine.role === 'pull-only' ? '· pull-only' : '';
  const a = auth.account;
  const el = $('#machine-acct');
  el.className = `acct ${auth.state === 'ok' ? 'ok' : auth.state === 'checking' ? '' : 'bad'}`;
  el.innerHTML = `<span>${esc(auth.state === 'checking' ? 'Checking Claude login…' : a ? `${a.email || a.orgName} · ${a.subscriptionType || a.authMethod}` : 'Not signed in')}</span>`;
}

function renderNav() {
  const item = (p) => {
    const cur = ui.view.kind === 'project' && ui.view.id === p.id;
    return `<button class="item" data-nav="${p.id}" aria-current="${cur}"><span class="kind">${p.type === 'repo' ? 'repo' : 'cust'}</span><span class="label">${esc(p.name)}</span>${projectNeedsYou(state, p) ? '<span class="dot" title="Something needs you"></span>' : ''}</button>`;
  };
  const repos = state.projects.filter((p) => p.type === 'repo');
  const custs = state.projects.filter((p) => p.type === 'customer');
  const loose = state.sessions.filter((s) => !s.projectId).length;
  $('#nav').innerHTML = `
    <h6>Projects<button data-act="new-project" data-type="repo" title="New repo project">+</button></h6>${repos.map(item).join('') || '<div class="none">No repo projects yet</div>'}
    <h6>Customers<button data-act="new-project" data-type="customer" title="New customer">+</button></h6>${custs.map(item).join('') || '<div class="none">No customers yet</div>'}
    <h6>Everything else</h6>
    <button class="item" data-nav="library" aria-current="${ui.view.kind === 'library'}"><span class="kind">⌕</span><span class="label">Session library</span>${loose ? `<span class="count">${loose}</span>` : ''}</button>
    <button class="item" disabled><span class="kind">@</span><span class="label">Email</span><span class="soon">later</span></button>`;
}

function renderOverview() {
  const root = $('#overview');
  // Keep what's being typed and where the cursor is across re-renders.
  const values = {};
  for (const el of $$('input[id], select[id], textarea[id]', root)) if (el.type !== 'checkbox') values[el.id] = el.value;
  const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
  const sel = focused && document.activeElement.selectionStart != null ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scroll = root.scrollTop;
  root.innerHTML = renderOverviewHTML(state, ui);
  for (const [id, v] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el && root.contains(el)) el.value = v;
  }
  if (focused) {
    const el = document.getElementById(focused);
    if (el) {
      el.focus();
      if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch {}
    }
  }
  root.scrollTop = scroll;
}

function dockSessions() {
  const p = currentProject();
  if (p) return state.sessions.filter((s) => s.projectId === p.id);
  return state.sessions.filter((s) => !s.projectId);
}

function renderDock() {
  const list = dockSessions();
  const key = viewKey();
  let active = list.find((s) => s.id === ui.active[key]);
  if (!active) {
    const p = currentProject();
    const sel = selectedStream(p);
    active = (sel && list.find((s) => s.streamId === sel.id)) || list[0] || null;
    if (active) ui.active[key] = active.id;
  }
  const p = currentProject();
  const streamName = (s) => (p && s.streamId ? (p.streams.find((x) => x.id === s.streamId) || {}).name : null);
  $('#tabs').innerHTML = list.map((s) => {
    const label = streamName(s) && streamName(s) !== s.name ? `${s.name} · ${streamName(s)}` : s.name;
    return `<button class="tab" role="tab" data-tab="${s.id}" aria-selected="${active && active.id === s.id}" title="${esc(short(s.cwd))} · ${SESSION_LABEL[s.status] || ''}">
      <span class="b ${s.status}"></span>${esc(label)}${s.status === 'needs-you' ? ' ⚠' : ''}<span class="close" data-close="${s.id}" title="Close session">×</span></button>`;
  }).join('') + `<button class="tab add" data-act="dock-new">+ New session</button>${active ? `<span class="dock-label">${esc(short(active.cwd))}</span>` : ''}`;

  const empty = $('#dock-empty');
  empty.innerHTML = p
    ? `<b>No sessions in ${esc(p.name)} yet</b><span>Pick a ${p.type === 'repo' ? 'stream' : 'workstream'} above and press Start session, or click + New session.</span>`
    : '<b>No open sessions</b><span>Resume one from the Session library, or click + New session to start Claude in any folder.</span>';
  Terminals.show(active ? active.id : null, active);
}

function renderWatch() {
  const live = state.sessions.filter((s) => s.running);
  $('#watch').innerHTML = live.length
    ? live.map((s) => `<span class="${s.status}" title="${esc(SESSION_LABEL[s.status])}">${esc(s.name)}</span>`).join('')
    : '<span>No sessions running</span>';
}

/* ---------- navigation ---------- */

function go(view) {
  ui.view = view;
  ui.menu = null;
  ui.answering = null;
  saveUi();
  if (view.kind === 'library' && !ui.library.items) loadLibrary();
  render();
}

function activateSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const wanted = s.projectId ? { kind: 'project', id: s.projectId } : ui.view.kind === 'welcome' ? { kind: 'welcome' } : { kind: 'library' };
  ui.active[s.projectId || 'loose'] = id;
  if (s.projectId && s.streamId) ui.selected[s.projectId] = s.streamId;
  if (wanted.kind !== ui.view.kind || wanted.id !== ui.view.id) go(wanted);
  else { saveUi(); render(); }
}

async function loadLibrary() {
  ui.library.loading = true;
  renderOverview();
  try {
    ui.library.items = await call('library:scan');
  } finally {
    ui.library.loading = false;
    renderOverview();
  }
}

/* ---------- sessions ---------- */

async function createSession(arg) {
  const s = await call('sessions:create', arg);
  state.sessions = [...state.sessions.filter((x) => x.id !== s.id), { ...s, status: 'stopped', running: false }];
  activateSession(s.id);
  return s;
}

async function openStreamSession(p, s, forceNew) {
  const existing = sessionsOf(state, p.id, s.id);
  if (existing.length && !forceNew) return activateSession(existing[0].id);
  const n = existing.length + 1;
  return createSession({ projectId: p.id, streamId: s.id, name: n > 1 ? `${s.name} ${n}` : s.name, initialPrompt: forceNew ? null : KICKOFF });
}

async function closeSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`Close "${s.name}"? Claude stops, but the conversation stays in Claude Code history and in the Session library.`)) return;
  await call('sessions:remove', { id });
  Terminals.dispose(id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  render();
}

/* ---------- Manager ---------- */

function openMgr(open = true) {
  $('#app').classList.toggle('mgr-off', !open);
  store.set('mgrOpen', open);
  requestAnimationFrame(() => Terminals.refit());
}

function askManager(text) {
  openMgr(true);
  if (state.manager.busy) return toast('The Manager is still answering. Wait or press Stop.');
  call('manager:ask', { text }).catch(() => {});
}

function suggestions() {
  const p = currentProject();
  const s = selectedStream(p);
  const out = ['What needs my judgement right now?', 'Summarise every running session'];
  if (p) out.push(`Where does ${p.name} stand?`);
  if (p && s) out.push(`What has ${s.name} done so far?`, `Break down ${s.name} into tasks`);
  return out;
}

function renderChat() {
  const m = state.manager;
  const msgs = m.messages.map((x) => {
    if (x.role === 'user') return `<div class="msg me">${esc(x.text)}</div>`;
    const tools = x.parts.filter((p) => p.kind === 'tool');
    const text = x.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n');
    return `<div class="msg">${tools.length ? `<div class="tools">${[...new Set(tools.map((t) => t.label))].map((l) => `<span>${esc(l)}</span>`).join('')}</div>` : ''}
      ${text ? md(text) : !x.done ? '<span class="thinking">Thinking…</span>' : ''}${x.error ? `<div class="err">${esc(x.error)}</div>` : ''}</div>`;
  }).join('');
  const intro = m.messages.length ? '' : '<div class="msg">I can see every project, stream and session in Monti. Ask what any thread did, what needs your judgement, or have me break a stream into small tasks with effort estimates.</div>';
  const chat = $('#chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = `${intro}${msgs}${m.busy ? '' : `<div class="sugg">${suggestions().map((s) => `<button type="button" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}`;
  if (atBottom || m.busy) chat.scrollTop = chat.scrollHeight;
  $('#mgr-stop').hidden = !m.busy;
  $('#mgr-send').disabled = m.busy;
}

/* ---------- modals ---------- */

function openModal(html, { onSubmit, bind } = {}) {
  const card = $('#modal-card');
  card.innerHTML = `<form id="modal-form" style="display:grid;gap:14px">${html}</form>`;
  $('#modal').hidden = false;
  const form = $('#modal-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      if (onSubmit) await onSubmit(form);
      closeModal();
    } catch {
      if (btn) btn.disabled = false;
    }
  };
  form.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  if (bind) bind(form);
  requestAnimationFrame(() => form.querySelector('input:not([type=radio]):not([type=checkbox]), select')?.focus());
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal-card').innerHTML = '';
}

function folderPicker(form, btnSel, outSel, title, onPick) {
  form.querySelector(btnSel).onclick = async () => {
    const f = await call('dialog:folder', { title });
    if (!f) return;
    const out = form.querySelector(outSel);
    out.textContent = short(f);
    out.dataset.path = f;
    if (onPick) onPick(f);
  };
}

function projectModal(type = 'repo', mode = 'existing') {
  openModal(`
    <h1>New project</h1>
    <div class="seg" role="group"><button type="button" data-type="repo" aria-pressed="${type === 'repo'}">Repo</button><button type="button" data-type="customer" aria-pressed="${type === 'customer'}">Customer</button></div>
    <div data-pane="repo" ${type === 'repo' ? '' : 'hidden'} style="display:grid;gap:12px">
      <div class="radios">
        <label><input type="radio" name="mode" value="existing" ${mode === 'existing' ? 'checked' : ''}><b>Existing folder</b><small>A repo you already work in. If it isn't a git repo yet, Monti runs git init.</small></label>
        <label><input type="radio" name="mode" value="new" ${mode === 'new' ? 'checked' : ''}><b>New repo</b><small>Creates the folder, runs git init and makes a first local commit. No GitHub repo.</small></label>
      </div>
      <div class="field" data-when="existing"><span>Folder</span><div class="pick"><span class="path" id="pm-folder">No folder chosen</span><button class="btn" type="button" id="pm-pick">Choose…</button></div></div>
      <div class="field" data-when="new"><span>Create inside</span><div class="pick"><span class="path" id="pm-parent" data-path="${esc(HOME)}/Sandbox">${esc('~/Sandbox')}</span><button class="btn" type="button" id="pm-pick-parent">Choose…</button></div></div>
      <label class="field"><span>Project name</span><input id="pm-name" placeholder="e.g. dex-intraday" autocomplete="off"></label>
      <label class="check"><input type="checkbox" id="pm-memory" checked> Add project memory: <code>AGENTS.md</code>, linked from <code>CLAUDE.md</code></label>
    </div>
    <div data-pane="customer" ${type === 'customer' ? '' : 'hidden'} style="display:grid;gap:12px">
      <label class="field"><span>Customer name</span><input id="pm-cname" placeholder="e.g. Acme Logistics" autocomplete="off"></label>
      <p class="hint">Saved as a local folder in <code>~/Monti/customers/</code>, with its own project memory, to-dos and workstreams.</p>
    </div>
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Create project</button></div>`, {
    bind(form) {
      let t = type;
      const sync = () => {
        const m = form.querySelector('input[name=mode]:checked').value;
        $$('[data-when]', form).forEach((el) => { el.hidden = el.dataset.when !== m; });
      };
      $$('.seg button', form).forEach((b) => b.onclick = () => {
        t = b.dataset.type;
        $$('.seg button', form).forEach((x) => x.setAttribute('aria-pressed', x === b));
        $$('[data-pane]', form).forEach((el) => { el.hidden = el.dataset.pane !== t; });
        form.dataset.type = t;
      });
      form.dataset.type = t;
      $$('input[name=mode]', form).forEach((r) => r.onchange = sync);
      sync();
      folderPicker(form, '#pm-pick', '#pm-folder', 'Choose the repo folder', (f) => {
        const n = form.querySelector('#pm-name');
        if (!n.value) n.value = f.split('/').pop();
      });
      folderPicker(form, '#pm-pick-parent', '#pm-parent', 'Create the new repo inside…');
    },
    async onSubmit(form) {
      let id;
      if (form.dataset.type === 'customer') {
        const name = form.querySelector('#pm-cname').value.trim();
        if (!name) { toast('Give the customer a name.', true); throw new Error('name'); }
        id = await call('projects:createCustomer', { name });
      } else {
        const m = form.querySelector('input[name=mode]:checked').value;
        const name = form.querySelector('#pm-name').value.trim();
        const folder = form.querySelector('#pm-folder').dataset.path;
        const parent = form.querySelector('#pm-parent').dataset.path;
        if (m === 'existing' && !folder) { toast('Choose the repo folder.', true); throw new Error('folder'); }
        if (!name) { toast('Give the project a name.', true); throw new Error('name'); }
        id = await call('projects:createRepo', { name, mode: m, folder, parent, addMemory: form.querySelector('#pm-memory').checked });
      }
      state = await api.call('state:get');
      go({ kind: 'project', id });
    },
  });
}

function streamModal(p) {
  const repo = p.type === 'repo';
  const canWorktree = repo && p.git && p.git.hasCommits;
  openModal(`
    <h1>New ${repo ? 'stream' : 'workstream'} in ${esc(p.name)}</h1>
    <label class="field"><span>Name</span><input id="sm-name" placeholder="${repo ? 'e.g. Signal engine' : 'e.g. QBR deck'}" autocomplete="off"></label>
    <label class="field"><span>What it covers (one line)</span><input id="sm-desc" placeholder="${repo ? 'e.g. Intraday momentum signals' : 'e.g. Quarterly review for Thursday'}" autocomplete="off"></label>
    <label class="field"><span>Kind</span><select id="sm-tag">
      ${repo ? '<option value="new">New feature</option><option value="existing">Existing feature (change or fix)</option>' : ''}
      <option value="doc">Doc</option><option value="deck">Deck</option><option value="other">Other</option></select></label>
    <div class="field"><span>Where it works</span><div class="radios">
      ${repo ? `<label><input type="radio" name="ws" value="worktree" ${canWorktree ? 'checked' : 'disabled'}><b>Own branch and folder</b><small>${canWorktree ? `A git worktree on branch <code>monti/&lt;name&gt;</code>, next to the repo, so it never collides with other streams.` : 'Needs at least one commit in the repo.'}</small></label>` : ''}
      <label><input type="radio" name="ws" value="root" ${canWorktree ? '' : 'checked'}><b>Project folder</b><small>Works directly in <code>${esc(short(p.root))}</code>.</small></label>
      <label><input type="radio" name="ws" value="folder"><b>docs/ or decks/ subfolder</b><small>Good for writing and slides.</small></label>
    </div></div>
    ${p.streams.length ? `<div class="field"><span>Waits for (optional)</span><div class="checks">${p.streams.map((s) => `<label><input type="checkbox" name="dep" value="${s.id}"> ${esc(s.name)}</label>`).join('')}</div></div>` : ''}
    <label class="check"><input type="checkbox" id="sm-start" checked> Start a Claude session now and let it plan tasks and begin</label>
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Create</button></div>`, {
    bind(form) {
      form.querySelector('#sm-tag').onchange = (e) => {
        if (['doc', 'deck'].includes(e.target.value)) form.querySelector('input[name=ws][value=folder]').checked = true;
      };
    },
    async onSubmit(form) {
      const name = form.querySelector('#sm-name').value.trim();
      if (!name) { toast('Give it a name.', true); throw new Error('name'); }
      const res = await call('streams:create', {
        projectId: p.id,
        name,
        description: form.querySelector('#sm-desc').value,
        tag: form.querySelector('#sm-tag').value,
        workspaceMode: form.querySelector('input[name=ws]:checked').value,
        dependsOn: $$('input[name=dep]:checked', form).map((x) => x.value),
        startSession: form.querySelector('#sm-start').checked,
      });
      ui.selected[p.id] = res.stream.id;
      state = await api.call('state:get');
      if (res.session) activateSession(res.session.id);
      else render();
    },
  });
}

function looseSessionModal() {
  openModal(`
    <h1>New session</h1>
    <label class="field"><span>Name</span><input id="ls-name" placeholder="e.g. Quick prototype" autocomplete="off"></label>
    <div class="field"><span>Folder</span><div class="pick"><span class="path" id="ls-folder">No folder chosen</span><button class="btn" type="button" id="ls-pick">Choose…</button></div></div>
    <p class="hint">Not part of a project. You can attach it to one later from the Session library.</p>
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Start session</button></div>`, {
    bind(form) { folderPicker(form, '#ls-pick', '#ls-folder', 'Choose the folder this session works in'); },
    async onSubmit(form) {
      const name = form.querySelector('#ls-name').value.trim();
      const cwd = form.querySelector('#ls-folder').dataset.path;
      if (!name || !cwd) { toast('Give it a name and choose a folder.', true); throw new Error('x'); }
      await createSession({ name, cwd });
    },
  });
}

function attachModal(lib) {
  const projects = state.projects;
  if (!projects.length) return toast('Create a project first, then attach sessions to it.');
  openModal(`
    <h1>Attach to a project</h1>
    <p>“${esc(lib.title)}” <span class="hint">· ${esc(short(lib.cwd))}</span></p>
    <label class="field"><span>Project</span><select id="am-project">${projects.map((p) => `<option value="${p.id}" ${lib.cwd && lib.cwd.startsWith(p.root) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Stream</span><select id="am-stream"></select></label>
    <p class="hint">The session keeps working in its original folder. Attaching only groups it with the project in Monti.</p>
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Attach and resume</button></div>`, {
    bind(form) {
      const fill = () => {
        const p = projects.find((x) => x.id === form.querySelector('#am-project').value);
        form.querySelector('#am-stream').innerHTML = `<option value="">No stream (general)</option>${p.streams.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}`;
      };
      form.querySelector('#am-project').onchange = fill;
      fill();
    },
    async onSubmit(form) {
      const projectId = form.querySelector('#am-project').value;
      const streamId = form.querySelector('#am-stream').value || null;
      const existing = state.sessions.find((s) => s.id === lib.id);
      if (existing) await call('sessions:attach', { id: lib.id, projectId, streamId });
      else await call('sessions:adopt', { id: lib.id, cwd: lib.cwd, title: lib.title, projectId, streamId });
      state = await api.call('state:get');
      activateSession(lib.id);
    },
  });
}

/* ---------- actions ---------- */

async function onAction(act, el, e) {
  const p = currentProject();
  const s = selectedStream(p);
  const taskId = el.closest('[data-t]')?.dataset.t;
  const task = s && taskId ? s.tasks.find((t) => t.id === taskId) : null;
  switch (act) {
    case 'toggle-menu': ui.menu = ui.menu === el.dataset.menuId ? null : el.dataset.menuId; return renderOverview();
    case 'new-project': return projectModal(el.dataset.type || 'repo', el.dataset.mode || 'existing');
    case 'go-library': e.preventDefault(); return go({ kind: 'library' });
    case 'ask-manager': ui.menu = null; renderOverview(); return askManager(el.dataset.q);
    case 'dock-new':
      if (p) {
        if (s) return openStreamSession(p, s, true);
        return createSession({ projectId: p.id, name: `${p.name} · general` });
      }
      return looseSessionModal();
    case 'general-session': ui.menu = null; return createSession({ projectId: p.id, name: `${p.name} · general` });
    case 'reveal': ui.menu = null; renderOverview(); return call('projects:reveal', { id: p.id });
    case 'open-memory': ui.menu = null; renderOverview(); return call('projects:openMemory', { id: p.id });
    case 'reload': ui.menu = null; return call('projects:reload');
    case 'remove-project':
      ui.menu = null;
      if (!confirm(`Remove ${p.name} from Monti on this Mac? Nothing is deleted: its folder, AGENTS.md and .monti data stay where they are, and you can add it again.`)) return renderOverview();
      await call('projects:remove', { id: p.id });
      return go({ kind: state.projects.length > 1 ? 'project' : 'welcome', id: (state.projects.find((x) => x.id !== p.id) || {}).id });
    case 'integrate': {
      const sess = await call('sessions:integrate', { projectId: p.id });
      state = await api.call('state:get');
      return activateSession(sess.id);
    }
    case 'new-stream': return streamModal(p);
    case 'plan-stream':
      return askManager(`Break the ${p.type === 'repo' ? 'stream' : 'workstream'} "${s.name}" in ${p.name} into small tasks (1–8h each) with checkpoints where I should decide, and save them with plan_tasks. Read its session first if it has one.`);
    case 'stream-session': return openStreamSession(p, s, false);
    case 'new-session': ui.menu = null; return openStreamSession(p, s, true);
    case 'done-stream': ui.menu = null; return call('streams:update', { projectId: p.id, streamId: s.id, patch: { status: 'done' } });
    case 'reopen-stream': ui.menu = null; return call('streams:update', { projectId: p.id, streamId: s.id, patch: { status: 'active' } });
    case 'remove-stream':
      ui.menu = null;
      if (!confirm(`Remove the stream "${s.name}"? Its tasks are removed from Monti. Its folder, branch and sessions are kept.`)) return renderOverview();
      return call('streams:remove', { projectId: p.id, streamId: s.id });
    case 'cycle-task': {
      const next = { todo: 'doing', doing: 'done', done: 'todo', review: 'done' }[task.status];
      return call('tasks:update', { projectId: p.id, streamId: s.id, taskId, patch: { status: next } });
    }
    case 'remove-task': return call('tasks:remove', { projectId: p.id, streamId: s.id, taskId });
    case 'approve': {
      const res = await call('tasks:approve', { projectId: p.id, streamId: s.id, taskId });
      return toast(res.delivered ? `Approved and sent to the ${s.name} session.` : 'Approved. No session is running for this stream; it will see it in its task list.');
    }
    case 'answer': ui.answering = taskId; renderOverview(); return $(`#answer-${taskId}`)?.focus();
    case 'cancel-answer': ui.answering = null; return renderOverview();
    case 'remove-todo': return call('todos:remove', { projectId: p.id, todoId: el.closest('[data-todo]').dataset.todo });
    case 'lib-refresh': return loadLibrary();
    case 'lib-open': return activateSession(el.closest('[data-lib]').dataset.lib);
    case 'lib-resume': {
      const lib = ui.library.items.find((x) => x.id === el.closest('[data-lib]').dataset.lib);
      await call('sessions:adopt', { id: lib.id, cwd: lib.cwd, title: lib.title });
      state = await api.call('state:get');
      return activateSession(lib.id);
    }
    case 'lib-attach': return attachModal(ui.library.items.find((x) => x.id === el.closest('[data-lib]').dataset.lib));
  }
}

async function onSubmitAction(act, form) {
  const p = currentProject();
  const s = selectedStream(p);
  if (act === 'add-task') {
    const title = $('#new-task-title').value.trim();
    if (!title) return;
    await call('tasks:add', { projectId: p.id, streamId: s.id, tasks: [{ title, effort: Number($('#new-task-effort').value), checkpoint: $('#new-task-check').value.trim() || null }] });
    $('#new-task-title').value = '';
    $('#new-task-check').value = '';
    $('#new-task-title').focus();
  } else if (act === 'add-todo') {
    const title = $('#new-todo-title').value.trim();
    if (!title) return;
    await call('todos:add', { projectId: p.id, title, due: $('#new-todo-due').value || null });
    $('#new-todo-title').value = '';
    $('#new-todo-due').value = '';
    $('#new-todo-title').focus();
  } else if (act === 'send-answer') {
    const taskId = form.closest('[data-t]').dataset.t;
    const note = form.querySelector('input').value.trim();
    ui.answering = null;
    const res = await call('tasks:approve', { projectId: p.id, streamId: s.id, taskId, note });
    toast(res.delivered ? `Sent to the ${s.name} session.` : 'Saved. No session is running for this stream right now.');
  }
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) return go(nav.dataset.nav === 'library' ? { kind: 'library' } : { kind: 'project', id: nav.dataset.nav });
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); return closeSession(close.dataset.close); }
  const tab = e.target.closest('[data-tab]');
  if (tab) return activateSession(tab.dataset.tab);
  const sugg = e.target.closest('[data-sugg]');
  if (sugg) return askManager(sugg.dataset.sugg);
  const actEl = e.target.closest('[data-act]');
  if (actEl && actEl.tagName !== 'SELECT' && actEl.type !== 'checkbox') {
    onAction(actEl.dataset.act, actEl, e).catch(() => {});
    return;
  }
  const row = e.target.closest('tr[data-s]');
  if (row) {
    const p = currentProject();
    ui.selected[p.id] = row.dataset.s;
    ui.answering = null;
    const first = state.sessions.find((x) => x.projectId === p.id && x.streamId === row.dataset.s);
    if (first) ui.active[p.id] = first.id;
    saveUi();
    return render();
  }
  if (ui.menu && !e.target.closest('[data-menu]')) { ui.menu = null; renderOverview(); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const p = currentProject();
  if (el.dataset.act === 'effort') {
    const s = selectedStream(p);
    call('tasks:update', { projectId: p.id, streamId: s.id, taskId: el.closest('[data-t]').dataset.t, patch: { effort: Number(el.value) } });
  } else if (el.dataset.act === 'toggle-todo') {
    call('todos:update', { projectId: p.id, todoId: el.closest('[data-todo]').dataset.todo, patch: { done: el.checked } });
  } else if (el.id === 'lib-folder') {
    ui.library.folder = el.value;
    renderOverview();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'lib-q') {
    ui.library.q = e.target.value;
    renderOverview();
  }
});

document.addEventListener('submit', (e) => {
  const act = e.target.dataset.actSubmit;
  if (!act) return;
  e.preventDefault();
  onSubmitAction(act, e.target).catch(() => {});
});

$('#new-project').onclick = () => projectModal('repo', 'existing');
$('#mgr-toggle').onclick = () => openMgr($('#app').classList.contains('mgr-off'));
$('#mgr-close').onclick = () => openMgr(false);
$('#mgr-form').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#mgr-q').value.trim();
  if (!q) return;
  $('#mgr-q').value = '';
  askManager(q);
};
$('#mgr-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#mgr-form').requestSubmit(); }
});
$('#mgr-stop').onclick = () => call('manager:stop');
$('#mgr-reset').onclick = () => { if (confirm('Start a new Manager conversation? The current one stays in Claude Code history.')) call('manager:reset'); };
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  if (e.key === 'Escape' && ui.menu) { ui.menu = null; renderOverview(); }
});

/* dock resizing */
(() => {
  const main = $('#main');
  const saved = store.get('dockH', null);
  if (saved) main.style.setProperty('--dock-h', `${saved}px`);
  let dragging = false;
  $('#resizer').addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'row-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const h = Math.min(Math.max(rect.bottom - e.clientY, 160), rect.height - 140);
    main.style.setProperty('--dock-h', `${h}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    const h = parseInt(getComputedStyle(main).getPropertyValue('--dock-h'), 10);
    if (h) store.set('dockH', h);
    Terminals.refit();
  });
  new ResizeObserver(() => Terminals.refit()).observe($('#stage'));
})();

/* ---------- Claude account ---------- */

function button(label, onClick, primary) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'btn primary' : 'btn';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function startLogin(sso) {
  $('#auth-term').hidden = false;
  if (!loginTerm) {
    loginTerm = makeTerminal($('#auth-term'));
    loginTerm.term.onData((d) => api.write(AUTH_SESSION, d));
  }
  loginTerm.term.clear();
  requestAnimationFrame(() => {
    loginTerm.fit.fit();
    api.call('auth:login', { sso, cols: loginTerm.term.cols, rows: loginTerm.term.rows });
    loginTerm.term.focus();
  });
}

async function switchAccount() {
  $('#auth-title').textContent = 'Signing out…';
  manageOpen = false;
  await api.call('auth:logout');
}

function renderAuth() {
  renderMachine();
  const a = auth.account;
  const show = auth.state !== 'ok' || manageOpen;
  $('#auth').hidden = !show;
  if (!show) return;
  const title = $('#auth-title');
  const text = $('#auth-text');
  const actions = $('#auth-actions');
  actions.innerHTML = '';
  $('#auth-lock-row').hidden = true;
  $('#auth-role').hidden = true;
  $('#auth-account').hidden = !a;
  if (a) {
    $('#auth-account').innerHTML = '<b></b><span></span>';
    $('#auth-account b').textContent = a.email || a.orgName || 'Claude account';
    $('#auth-account span').textContent = `${a.orgName || ''} · ${a.subscriptionType || a.authMethod} plan · on ${state.machine.name || 'this Mac'}`;
  }
  const signIn = (again) => actions.append(
    button(again ? 'Sign in again' : 'Sign in with Claude account', () => startLogin(false), true),
    button('Sign in with SSO (Enterprise)', () => startLogin(true)),
  );
  const refresh = button('Check again', () => api.call('auth:refresh'));

  if (manageOpen && auth.state === 'ok') {
    title.textContent = 'This Mac';
    text.textContent = 'Every session and the Manager use this Claude account.';
    const role = state.machine.role;
    $('#auth-role').hidden = false;
    $('#auth-role').innerHTML = `<div class="field"><span>This Mac is</span><div class="seg"><button type="button" data-role="owner" aria-pressed="${role !== 'pull-only'}">Owner: full access</button><button type="button" data-role="pull-only" aria-pressed="${role === 'pull-only'}">Pull-only: changes stay here</button></div></div>`;
    $$('#auth-role [data-role]').forEach((b) => b.onclick = async () => {
      await api.call('machine:setRole', { role: b.dataset.role });
      state = await api.call('state:get');
      render();
      renderAuth();
    });
    $('#auth-term').hidden = true;
    actions.append(button('Done', () => { manageOpen = false; renderAuth(); }, true), button('Switch account', switchAccount), refresh);
    return;
  }
  switch (auth.state) {
    case 'checking':
      title.textContent = 'Checking your Claude login…';
      text.textContent = '';
      break;
    case 'needs-login':
      title.textContent = 'Sign in to Claude';
      text.textContent = info && !info.claudeFound ? 'Claude Code is not installed or not on your PATH. Install it, then press Check again.' : 'Choose the account this Mac should use. On a work laptop, use SSO with your Enterprise account.';
      signIn(false);
      actions.append(refresh);
      break;
    case 'needs-confirm':
      title.textContent = 'Use this Claude account on this Mac?';
      text.textContent = 'Monti will start every session with this account. You can lock this Mac to its organization so a personal account can never be used here.';
      $('#auth-lock-row').hidden = false;
      $('#auth-term').hidden = true;
      actions.append(button('Continue', () => api.call('auth:confirm', { lockToOrg: $('#auth-lock').checked }), true), button('Use a different account', switchAccount));
      break;
    case 'blocked':
      title.textContent = "This account isn't allowed on this Mac";
      text.textContent = auth.reason;
      actions.append(button('Sign in with a different account', switchAccount, true), refresh);
      break;
    case 'expired':
      title.textContent = 'Your Claude login expired';
      text.textContent = 'Your sessions are paused, not lost. Sign in again and each one continues where it left off.';
      signIn(true);
      actions.append(refresh);
      break;
  }
}

$('#machine').onclick = () => { if (auth.state === 'ok') { manageOpen = true; renderAuth(); } };

/* ---------- events from the main process ---------- */

Terminals.canStart = () => auth.state === 'ok';

api.onState((next) => {
  state = next;
  if (ui.view.kind === 'project' && !state.projects.some((p) => p.id === ui.view.id)) ui.view = { kind: state.projects[0] ? 'project' : 'welcome', id: state.projects[0] && state.projects[0].id };
  render();
  renderChat();
});
api.onManager((m) => { state.manager = m; renderChat(); });
api.onAuth((next) => {
  const wasOk = auth.state === 'ok';
  auth = next;
  if (auth.state !== 'needs-login' && auth.state !== 'expired') $('#auth-term').hidden = true;
  renderAuth();
  if (!wasOk && auth.state === 'ok') Terminals.resumeVisible();
});
api.onData(({ id, data }) => {
  if (id === AUTH_SESSION) { if (loginTerm) loginTerm.term.write(data); return; }
  Terminals.data(id, data);
});
api.onExit(({ id }) => { if (id !== AUTH_SESSION) Terminals.exited(id); });

/* ---------- boot ---------- */

(async function boot() {
  info = await api.call('app:info');
  HOME = info.home;
  const saved = store.get('ui', null);
  if (saved) Object.assign(ui, { view: saved.view || ui.view, selected: saved.selected || {}, active: saved.active || {} });
  const mgrOpen = store.get('mgrOpen', window.innerWidth > 1280);
  openMgr(mgrOpen);
  state = await api.call('state:get');
  if (ui.view.kind === 'project' && !state.projects.some((p) => p.id === ui.view.id)) ui.view = { kind: 'welcome' };
  if (ui.view.kind === 'welcome' && state.projects.length) ui.view = { kind: 'project', id: state.projects[0].id };
  if (ui.view.kind === 'library') loadLibrary();
  auth = await api.call('auth:status');
  renderAuth();
  render();
  renderChat();
})();
