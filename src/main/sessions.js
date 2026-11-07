// Runs real `claude` processes in pseudo-terminals, one per session tab.
//
// Each session gets a Claude session ID that we choose up front
// (`--session-id`). After a restart, or if Claude exits, we reopen the same
// conversation with `--resume <id>`, so every session picks up where it left off.
const crypto = require('crypto');
const fs = require('fs');
const pty = require('node-pty');
const { findTranscript } = require('./library');

class SessionManager {
  constructor({ store, claudeBin, env, projectsDir, buildArgs, onData, onExit, onChange }) {
    this.store = store;
    this.claudeBin = claudeBin;
    this.env = env;
    this.projectsDir = projectsDir;
    this.buildArgs = buildArgs || (() => []);
    this.onData = onData;
    this.onExit = onExit;
    this.onChange = onChange || (() => {});
    this.ptys = new Map();
    this.sessions = store.readJSON('sessions.json', []);
  }

  save() {
    this.store.writeJSON('sessions.json', this.sessions);
    this.onChange();
  }

  get(id) {
    return this.sessions.find((x) => x.id === id) || null;
  }

  isRunning(id) {
    return this.ptys.has(id);
  }

  list() {
    return this.sessions.map((s) => ({ ...s, running: this.ptys.has(s.id) }));
  }

  // `id` is given when adopting an existing Claude session from the library.
  create({ id, name, cwd, projectId = null, streamId = null, kind = 'stream', initialPrompt = null }) {
    if (id && this.get(id)) return this.get(id);
    const session = {
      id: id || crypto.randomUUID(),
      name,
      cwd,
      projectId,
      streamId,
      kind,
      initialPrompt,
      createdAt: new Date().toISOString(),
    };
    this.sessions.push(session);
    this.save();
    return session;
  }

  update(id, patch) {
    const s = this.get(id);
    if (!s) throw new Error('Unknown session');
    Object.assign(s, patch);
    this.save();
    return s;
  }

  remove(id) {
    this.kill(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.save();
  }

  hasTranscript(id) {
    return Boolean(findTranscript(this.projectsDir, id));
  }

  // Starts the session if it isn't running. Returns how it was started.
  start(id, cols, rows) {
    if (this.ptys.has(id)) return 'running';
    const s = this.get(id);
    if (!s) throw new Error('Unknown session');
    if (!fs.existsSync(s.cwd)) throw new Error(`Folder not found: ${s.cwd}`);
    const resume = this.hasTranscript(id);
    const base = resume ? ['--resume', id] : ['--session-id', id, '--name', s.name];
    const args = [...base, ...this.buildArgs(s, { resume })];
    if (!resume && s.initialPrompt) args.push(s.initialPrompt);
    this.spawn(id, this.claudeBin, args, s.cwd, cols, rows);
    s.lastStartedAt = new Date().toISOString();
    if (!resume && s.initialPrompt) s.initialPrompt = null;
    this.save();
    return resume ? 'resumed' : 'new';
  }

  // Generic helper, also used for `claude auth login`.
  spawn(id, file, args, cwd, cols = 100, rows = 30) {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cwd,
      env: this.env,
      cols: Math.max(cols || 100, 20),
      rows: Math.max(rows || 30, 5),
    });
    this.ptys.set(id, proc);
    proc.onData((data) => this.onData(id, data));
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(id) === proc) this.ptys.delete(id);
      this.onExit(id, exitCode);
      this.onChange();
    });
    this.onChange();
    return proc;
  }

  write(id, data) {
    const p = this.ptys.get(id);
    if (p) p.write(data);
    return Boolean(p);
  }

  resize(id, cols, rows) {
    const p = this.ptys.get(id);
    if (p && cols > 0 && rows > 0) {
      try {
        p.resize(cols, rows);
      } catch {}
    }
  }

  kill(id) {
    const p = this.ptys.get(id);
    if (p) {
      this.ptys.delete(id);
      try {
        p.kill();
      } catch {}
    }
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}

module.exports = { SessionManager };
