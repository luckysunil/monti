// Runs real `claude` processes in pseudo-terminals, one per session tab.
//
// Each session gets a Claude session ID that we choose up front
// (`--session-id`). After a restart, or if Claude exits, we reopen the same
// conversation with `--resume <id>`, so every session picks up where it left off.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

class SessionManager {
  constructor({ store, claudeBin, env, projectsDir, onData, onExit }) {
    this.store = store;
    this.claudeBin = claudeBin;
    this.env = env;
    this.projectsDir = projectsDir;
    this.onData = onData;
    this.onExit = onExit;
    this.ptys = new Map();
    this.sessions = store.readJSON('sessions.json', []);
  }

  save() {
    this.store.writeJSON('sessions.json', this.sessions);
  }

  list() {
    return this.sessions.map((s) => ({ ...s, running: this.ptys.has(s.id) }));
  }

  create({ name, cwd }) {
    const session = { id: crypto.randomUUID(), name, cwd, createdAt: new Date().toISOString() };
    this.sessions.push(session);
    this.save();
    return session;
  }

  rename(id, name) {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.name = name;
      this.save();
    }
  }

  remove(id) {
    this.kill(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.save();
  }

  // Claude Code writes each conversation to <projectsDir>/<encoded cwd>/<id>.jsonl.
  hasTranscript(id) {
    if (!this.projectsDir) return false;
    try {
      return fs.readdirSync(this.projectsDir).some((dir) => fs.existsSync(path.join(this.projectsDir, dir, `${id}.jsonl`)));
    } catch {
      return false;
    }
  }

  // Starts the session if it isn't running. Returns how it was started.
  start(id, cols, rows) {
    if (this.ptys.has(id)) return 'running';
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error('Unknown session');
    if (!fs.existsSync(s.cwd)) throw new Error(`Folder not found: ${s.cwd}`);
    const resume = this.hasTranscript(id);
    const args = resume ? ['--resume', id] : ['--session-id', id, '--name', s.name];
    this.spawn(id, this.claudeBin, args, s.cwd, cols, rows);
    s.lastStartedAt = new Date().toISOString();
    this.save();
    return resume ? 'resumed' : 'new';
  }

  // Generic helper, also used for `claude auth login`.
  spawn(id, file, args, cwd, cols = 100, rows = 30) {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cwd,
      env: this.env,
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
    });
    this.ptys.set(id, proc);
    proc.onData((data) => this.onData(id, data));
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(id) === proc) this.ptys.delete(id);
      this.onExit(id, exitCode);
    });
    return proc;
  }

  write(id, data) {
    const p = this.ptys.get(id);
    if (p) p.write(data);
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
