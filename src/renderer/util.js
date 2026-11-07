/* Shared helpers: DOM, formatting, and how progress and status are derived. */
const api = window.monti;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cleanError = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function call(channel, arg) {
  try {
    return await api.call(channel, arg);
  } catch (e) {
    toast(cleanError(e), true);
    throw e;
  }
}

let toastTimer = null;
function toast(text, isError) {
  const el = $('#toast');
  el.textContent = text;
  el.className = isError ? 'toast err' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

function relTime(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dueLabel(due) {
  if (!due) return { text: '', over: false };
  const t = todayISO();
  const d = new Date(`${due}T00:00:00`);
  const nice = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (due < t) return { text: `Overdue · ${nice}`, over: true };
  if (due === t) return { text: 'Today', over: true };
  return { text: nice, over: false };
}

let HOME = '';
const short = (p) => (p && HOME && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p || '');

/* Minimal, safe Markdown for Manager replies. */
function md(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (!list || list.kind !== kind) {
        if (list) out.push(`</${list.kind}>`);
        list = { kind };
        out.push(`<${kind}>`);
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.kind}>`); list = null; }
    if (!line.trim()) continue;
    const hd = line.match(/^#{1,6}\s+(.*)/);
    out.push(hd ? `<p><b>${inline(hd[1])}</b></p>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.kind}>`);
  return out.join('');
}

/* ---------- progress and status ---------- */

const TAG_LABEL = { new: 'New feature', existing: 'Existing feature', doc: 'Doc', deck: 'Deck', other: 'Other' };
const STATE_LABEL = { run: 'Working', need: 'Needs you', done: 'Done', idle: 'Idle', blocked: 'Blocked' };
const SESSION_LABEL = { working: 'working', 'needs-you': 'needs you', idle: 'idle', stopped: 'stopped' };

function isDone(s) {
  return s.status === 'done' || (s.tasks.length > 0 && s.tasks.every((t) => t.status === 'done'));
}
function pctOf(s) {
  if (!s.tasks.length) return s.status === 'done' ? 100 : 0;
  const tot = s.tasks.reduce((a, t) => a + t.effort, 0);
  return Math.round((s.tasks.filter((t) => t.status === 'done').reduce((a, t) => a + t.effort, 0) / tot) * 100);
}
const weightOf = (s) => (s.tasks.length ? s.tasks.reduce((a, t) => a + t.effort, 0) : 4);
function blockers(p, s) {
  return (s.dependsOn || []).map((id) => p.streams.find((x) => x.id === id)).filter((d) => d && !isDone(d));
}
function sessionsOf(state, projectId, streamId) {
  return state.sessions.filter((x) => x.projectId === projectId && (streamId === undefined || x.streamId === streamId));
}
function streamState(state, p, s) {
  if (isDone(s)) return 'done';
  if (blockers(p, s).length) return 'blocked';
  const ss = sessionsOf(state, p.id, s.id);
  if (s.tasks.some((t) => t.status === 'review') || ss.some((x) => x.status === 'needs-you')) return 'need';
  if (ss.some((x) => x.status === 'working')) return 'run';
  return 'idle';
}
function projectNeedsYou(state, p) {
  return p.streams.some((s) => streamState(state, p, s) === 'need') || sessionsOf(state, p.id).some((x) => x.status === 'needs-you');
}
function projectProgress(p) {
  const W = p.streams.reduce((a, s) => a + weightOf(s), 0);
  if (!W) return 0;
  return Math.round(p.streams.reduce((a, s) => a + pctOf(s) * weightOf(s), 0) / W);
}
