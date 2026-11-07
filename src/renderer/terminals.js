/* global Terminal, FitAddon */
/* Live terminals, one xterm per session. Output that arrives before a tab is
   opened is buffered, so nothing is lost when you switch to it later. */
const TERM_THEME = {
  background: '#12151d', foreground: '#d6dae4', cursor: '#8fa6ff', selectionBackground: '#33406a',
  black: '#1b1f2a', red: '#ff7a85', green: '#6fd19f', yellow: '#ffbf5c', blue: '#8fa6ff',
  magenta: '#c49bff', cyan: '#6fd3e0', white: '#d6dae4', brightBlack: '#5f6678',
};
const BUFFER_LIMIT = 400 * 1024;

function makeTerminal(host) {
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2,
    cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: TERM_THEME, macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  return { term, fit };
}

const Terminals = {
  entries: new Map(), // id -> { term, fit, el, status: 'idle' | 'running' | 'exited' }
  pending: new Map(), // id -> buffered output
  visible: null,
  canStart: () => false,

  ensure(id) {
    if (this.entries.has(id)) return this.entries.get(id);
    const el = document.createElement('div');
    el.className = 'term';
    el.hidden = true;
    $('#stage').appendChild(el);
    const { term, fit } = makeTerminal(el);
    const entry = { term, fit, el, status: 'idle' };
    term.onData((d) => {
      if (entry.status === 'running') api.write(id, d);
      else if (entry.status === 'exited' && d === '\r') this.start(id);
    });
    term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
    const buffered = this.pending.get(id);
    if (buffered) {
      term.write(buffered);
      this.pending.delete(id);
    }
    this.entries.set(id, entry);
    return entry;
  },

  // Shows a session's terminal, starting (or resuming) Claude if needed.
  show(id, session) {
    for (const [tid, t] of this.entries) t.el.hidden = tid !== id;
    this.visible = id;
    $('#dock-empty').hidden = Boolean(id);
    if (!id) return;
    const t = this.ensure(id);
    if (session && session.running) t.status = 'running';
    t.el.hidden = false;
    requestAnimationFrame(() => {
      t.fit.fit();
      t.term.focus();
    });
    if (t.status === 'idle' && this.canStart()) this.start(id);
  },

  async start(id) {
    const t = this.ensure(id);
    t.fit.fit();
    t.status = 'starting';
    try {
      const how = await api.call('sessions:start', { id, cols: t.term.cols, rows: t.term.rows });
      if (how === 'resumed') t.term.write('\x1b[2mResuming where you left off…\x1b[0m\r\n');
      t.status = 'running';
    } catch (e) {
      t.status = 'exited';
      t.term.write(`\r\n\x1b[33m${cleanError(e)}\x1b[0m\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`);
    }
  },

  // After signing in again, restart whatever is on screen.
  resumeVisible() {
    if (!this.visible) return;
    const t = this.entries.get(this.visible);
    if (t && t.status !== 'running' && t.status !== 'starting') this.start(this.visible);
  },

  data(id, data) {
    const t = this.entries.get(id);
    if (t) return t.term.write(data);
    const prev = this.pending.get(id) || '';
    this.pending.set(id, (prev + data).slice(-BUFFER_LIMIT));
  },

  exited(id) {
    const t = this.entries.get(id);
    if (!t) return;
    if (!this.canStart()) {
      // Stopped by signing out: resume automatically after the next sign-in.
      t.status = 'idle';
      t.term.write('\r\n\x1b[2mPaused while signed out. This session resumes where it left off when you sign in.\x1b[0m\r\n');
      return;
    }
    t.status = 'exited';
    t.term.write('\r\n\x1b[2mClaude exited. Press Enter to resume this session.\x1b[0m\r\n');
  },

  dispose(id) {
    const t = this.entries.get(id);
    if (t) {
      t.term.dispose();
      t.el.remove();
      this.entries.delete(id);
    }
    this.pending.delete(id);
    if (this.visible === id) this.visible = null;
  },

  refit() {
    const t = this.visible && this.entries.get(this.visible);
    if (t && !t.el.hidden) t.fit.fit();
  },
};
