/* global Terminal, FitAddon */
const api = window.conductor;
const $ = (s) => document.querySelector(s);

const TERM_THEME = {
  background: '#12151d', foreground: '#d6dae4', cursor: '#8fa6ff', selectionBackground: '#33406a',
  black: '#1b1f2a', red: '#ff7a85', green: '#6fd19f', yellow: '#ffbf5c', blue: '#8fa6ff',
  magenta: '#c49bff', cyan: '#6fd3e0', white: '#d6dae4', brightBlack: '#5f6678',
};
const AUTH_SESSION = '__auth__';

let info = null;
let auth = { state: 'checking' };
let sessions = [];
let active = null;
let manageOpen = false;
let loginTerm = null;
const terms = new Map(); // id -> { term, fit, el, status: 'idle' | 'running' | 'exited' }

const cleanError = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const short = (p) => (info && p.startsWith(info.home) ? '~' + p.slice(info.home.length) : p);
const remember = (id) => { try { localStorage.setItem('active', id || ''); } catch {} };
const recall = () => { try { return localStorage.getItem('active'); } catch { return null; } };

function makeTerminal(host) {
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2,
    cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: TERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  return { term, fit };
}

/* ---------- sessions ---------- */

function renderList() {
  $('#list').innerHTML = '';
  for (const s of sessions) {
    const t = terms.get(s.id);
    const li = document.createElement('li');
    li.className = s.id === active ? 'active' : '';
    li.innerHTML = `<span class="dot ${t ? t.status : ''}"></span><div><div class="name"></div><div class="path"></div></div><button class="x" type="button" title="Close session">×</button>`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.path').textContent = short(s.cwd);
    li.onclick = () => activate(s.id);
    li.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeSession(s.id); };
    $('#list').appendChild(li);
  }
  $('#empty').hidden = sessions.length > 0;
}

function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  $('#stage').appendChild(el);
  const { term, fit } = makeTerminal(el);
  const entry = { term, fit, el, status: 'idle' };
  term.onData((d) => {
    if (entry.status === 'running') api.sessions.write(id, d);
    else if (entry.status === 'exited' && d === '\r') startSession(id);
  });
  term.onResize(({ cols, rows }) => api.sessions.resize(id, cols, rows));
  terms.set(id, entry);
  return entry;
}

async function activate(id) {
  active = id;
  remember(id);
  for (const [tid, t] of terms) t.el.hidden = tid !== id;
  const t = ensureTerm(id);
  t.el.hidden = false;
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  renderList();
  if (t.status === 'idle' && auth.state === 'ok') startSession(id);
}

async function startSession(id) {
  const t = ensureTerm(id);
  t.fit.fit();
  try {
    const how = await api.sessions.start(id, t.term.cols, t.term.rows);
    if (how === 'resumed') t.term.write('\x1b[2mResuming where you left off…\x1b[0m\r\n');
    t.status = 'running';
  } catch (e) {
    t.status = 'exited';
    t.term.write(`\r\n\x1b[33m${cleanError(e)}\x1b[0m\r\n`);
  }
  renderList();
}

async function closeSession(id) {
  if (!confirm('Close this session? Its conversation stays in Claude Code history.')) return;
  await api.sessions.remove(id);
  const t = terms.get(id);
  if (t) { t.term.dispose(); t.el.remove(); terms.delete(id); }
  sessions = sessions.filter((s) => s.id !== id);
  if (active === id) {
    active = null;
    if (sessions[0]) activate(sessions[0].id);
  }
  renderList();
}

api.sessions.onData(({ id, data }) => {
  if (id === AUTH_SESSION) { if (loginTerm) loginTerm.term.write(data); return; }
  const t = terms.get(id);
  if (t) t.term.write(data);
});

api.sessions.onExit(({ id }) => {
  if (id === AUTH_SESSION) return;
  const t = terms.get(id);
  if (!t) return;
  t.status = 'exited';
  t.term.write('\r\n\x1b[2mClaude exited. Press Enter to resume this session.\x1b[0m\r\n');
  renderList();
});

new ResizeObserver(() => {
  const t = active && terms.get(active);
  if (t && !t.el.hidden) t.fit.fit();
}).observe($('#stage'));

/* ---------- new session form ---------- */

let newFolder = null;
function openNew() {
  $('#new-form').hidden = false;
  $('#new-name').value = '';
  newFolder = null;
  $('#new-folder').textContent = 'No folder chosen';
  $('#new-name').focus();
}
$('#new-toggle').onclick = openNew;
$('#empty-new').onclick = openNew;
$('#new-cancel').onclick = () => { $('#new-form').hidden = true; };
$('#new-pick').onclick = async () => {
  const folder = await api.pickFolder();
  if (folder) { newFolder = folder; $('#new-folder').textContent = short(folder); }
};
$('#new-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#new-name').value.trim();
  if (!name) return;
  if (!newFolder) { $('#new-folder').textContent = 'Choose a folder first'; return; }
  const s = await api.sessions.create({ name, cwd: newFolder });
  sessions.push(s);
  $('#new-form').hidden = true;
  activate(s.id);
};

/* ---------- Claude account ---------- */

function accountLabel(a) {
  if (!a) return 'Not signed in';
  const plan = a.subscriptionType ? a.subscriptionType[0].toUpperCase() + a.subscriptionType.slice(1) : a.authMethod;
  return `${a.email || a.orgName} · ${plan}`;
}

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
    loginTerm.term.onData((d) => api.sessions.write(AUTH_SESSION, d));
  }
  loginTerm.term.clear();
  requestAnimationFrame(() => {
    loginTerm.fit.fit();
    api.auth.login({ sso, cols: loginTerm.term.cols, rows: loginTerm.term.rows });
    loginTerm.term.focus();
  });
}

async function switchAccount() {
  $('#auth-title').textContent = 'Signing out…';
  await api.auth.logout();
}

function renderAuth() {
  const a = auth.account;
  const pill = $('#account');
  pill.textContent = auth.state === 'checking' ? 'Checking Claude login…' : accountLabel(a);
  pill.className = 'account ' + (auth.state === 'ok' ? 'ok' : auth.state === 'checking' ? '' : 'bad');

  const show = auth.state !== 'ok' || manageOpen;
  $('#auth').hidden = !show;
  if (!show) return;

  const title = $('#auth-title');
  const text = $('#auth-text');
  const actions = $('#auth-actions');
  actions.innerHTML = '';
  $('#auth-lock-row').hidden = true;
  $('#auth-account').hidden = !a;
  if (a) $('#auth-account').innerHTML = `<b></b><span></span>`;
  if (a) {
    $('#auth-account b').textContent = a.email || a.orgName || 'Claude account';
    $('#auth-account span').textContent = `${a.orgName || ''} · ${a.subscriptionType || a.authMethod} plan · on ${info ? info.machineName : 'this Mac'}`;
  }
  const signInButtons = (again) => {
    actions.append(
      button(again ? 'Sign in again' : 'Sign in with Claude account', () => startLogin(false), true),
      button('Sign in with SSO (Enterprise)', () => startLogin(true)),
    );
  };
  const refresh = button('Check again', () => api.auth.refresh());

  if (manageOpen && auth.state === 'ok') {
    title.textContent = 'Claude account on this Mac';
    text.textContent = 'Every session in Conductor uses this account.';
    actions.append(button('Done', () => { manageOpen = false; renderAuth(); }, true), button('Switch account', switchAccount), refresh);
    return;
  }

  $('#auth-term').hidden = !loginTerm || $('#auth-term').hidden;
  switch (auth.state) {
    case 'checking':
      title.textContent = 'Checking your Claude login…';
      text.textContent = '';
      break;
    case 'needs-login':
      title.textContent = 'Sign in to Claude';
      text.textContent = auth.reason && !info.claudeFound ? auth.reason : 'Choose the account this Mac should use. On a work laptop, use SSO with your Enterprise account.';
      signInButtons(false);
      actions.append(refresh);
      break;
    case 'needs-confirm':
      title.textContent = 'Use this Claude account on this Mac?';
      text.textContent = 'Conductor will start every session with this account. You can lock this Mac to its organization so a personal account can never be used here.';
      $('#auth-lock-row').hidden = false;
      $('#auth-term').hidden = true;
      actions.append(
        button('Continue', () => api.auth.confirm({ lockToOrg: $('#auth-lock').checked }), true),
        button('Use a different account', switchAccount),
      );
      break;
    case 'blocked':
      title.textContent = "This account isn't allowed on this Mac";
      text.textContent = auth.reason;
      actions.append(button('Sign in with a different account', switchAccount, true), refresh);
      break;
    case 'expired':
      title.textContent = 'Your Claude login expired';
      text.textContent = 'Your sessions are paused, not lost. Sign in again and each one continues where it left off.';
      signInButtons(true);
      actions.append(refresh);
      break;
  }
}

$('#account').onclick = () => { if (auth.state === 'ok') { manageOpen = true; renderAuth(); } };

api.auth.onChange((next) => {
  const wasOk = auth.state === 'ok';
  auth = next;
  if (auth.state !== 'needs-login' && auth.state !== 'expired') $('#auth-term').hidden = true;
  renderAuth();
  if (!wasOk && auth.state === 'ok' && active) {
    const t = terms.get(active);
    if (!t || t.status !== 'running') startSession(active);
  }
});

/* ---------- boot ---------- */

(async function boot() {
  info = await api.info();
  $('#machine').textContent = `${info.machineName} · ${info.role === 'pull-only' ? 'pull-only' : 'owner'}`;
  auth = await api.auth.status();
  renderAuth();
  sessions = await api.sessions.list();
  renderList();
  const last = recall();
  const first = sessions.find((s) => s.id === last) || sessions[0];
  if (first) activate(first.id);
})();
