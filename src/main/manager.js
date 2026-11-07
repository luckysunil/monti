// The Manager: one Claude conversation that can see across every project and
// session. Each question runs headless `claude -p` (same login as everything
// else) and resumes the same conversation, so it remembers earlier questions.
// It can read and plan, but it has no tools to edit code or run commands.
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findTranscript } = require('./library');

const SYSTEM_PROMPT = `You are the Manager inside Monti, a desktop app where the owner runs several Claude Code sessions in parallel, grouped into projects and streams.

Your job:
- Answer questions about any project, stream or session. Use the monti tools to look things up (list_projects, get_project, list_sessions, read_session, git_status) instead of guessing, and say briefly what you read.
- Break work into small tasks so the owner can judge progress easily: 1–8 hours each, concrete titles, and a checkpoint wherever the owner should decide or review (approach choices, anything costly, irreversible or customer-facing). Use plan_tasks. Effort estimates drive the progress bars, so keep them honest and adjust them when reality changes.
- Point out what needs the owner's judgement and what is blocked.
- Development is local-first. When a repo project's work looks verified and it has no GitHub remote yet, you may suggest creating a private GitHub repo, but never create one yourself: ask the owner.

Rules:
- You plan and explain; you do not edit code or files, and you don't run commands. Working sessions do that.
- Keep answers short and scannable: a sentence or two, then bullets if needed. Use the owner's project and stream names.`;

const TOOL_LABELS = {
  list_projects: 'Looked at all projects',
  get_project: 'Read project details',
  list_sessions: 'Listed sessions',
  read_session: 'Read a session transcript',
  git_status: 'Checked git',
  plan_tasks: 'Planned tasks',
  update_task: 'Updated a task',
  create_stream: 'Created a stream',
  add_todo: 'Added a to-do',
  update_memory: 'Updated project memory',
  Read: 'Read a file',
  Glob: 'Searched files',
  Grep: 'Searched code',
};

class Manager {
  constructor({ store, claudeBin, env, cwd, projectsDir, server, addDirs, onChange }) {
    this.store = store;
    this.claudeBin = claudeBin;
    this.env = env;
    this.cwd = cwd;
    this.projectsDir = projectsDir;
    this.server = server;
    this.addDirs = addDirs;
    this.onChange = onChange;
    const saved = store.readJSON('manager.json', null);
    this.state = saved || { sessionId: crypto.randomUUID(), messages: [] };
    this.child = null;
  }

  save() {
    this.store.writeJSON('manager.json', { sessionId: this.state.sessionId, messages: this.state.messages.slice(-200) });
  }

  snapshot() {
    return { busy: Boolean(this.child), messages: this.state.messages.slice(-100) };
  }

  emit() {
    this.onChange(this.snapshot());
  }

  reset() {
    this.stop();
    this.state = { sessionId: crypto.randomUUID(), messages: [] };
    this.save();
    this.emit();
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }

  ask(text) {
    if (this.child) throw new Error('The Manager is still answering.');
    const question = String(text || '').trim();
    if (!question) return;
    this.state.messages.push({ role: 'user', text: question, at: new Date().toISOString() });
    const reply = { role: 'assistant', parts: [], at: new Date().toISOString(), done: false };
    this.state.messages.push(reply);

    const resume = Boolean(findTranscript(this.projectsDir, this.state.sessionId));
    const mcp = {
      mcpServers: {
        monti: { type: 'http', url: `${this.server.url}/mcp/manager`, headers: { Authorization: `Bearer ${this.server.token}` } },
      },
    };
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...(resume ? ['--resume', this.state.sessionId] : ['--session-id', this.state.sessionId, '--name', 'Monti Manager']),
      '--mcp-config', JSON.stringify(mcp),
      '--strict-mcp-config',
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'mcp__monti,Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', SYSTEM_PROMPT,
    ];
    for (const dir of this.addDirs()) args.push('--add-dir', dir);

    const child = spawn(this.claudeBin, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.end(question);
    this.emit();

    let buf = '';
    let stderr = '';
    let gotResult = false;
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) {
            if (b.type === 'text' && b.text.trim()) reply.parts.push({ kind: 'text', text: b.text.trim() });
            if (b.type === 'tool_use') {
              const short = String(b.name).replace(/^mcp__monti__/, '');
              reply.parts.push({ kind: 'tool', name: short, label: TOOL_LABELS[short] || `Used ${short}` });
            }
          }
          this.emit();
        } else if (ev.type === 'result') {
          gotResult = true;
          if (ev.is_error) reply.error = ev.result || 'The Manager hit an error.';
          if (!reply.parts.some((p) => p.kind === 'text') && ev.result && !ev.is_error) reply.parts.push({ kind: 'text', text: ev.result });
        }
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => {
      if (this.child === child) this.child = null;
      reply.done = true;
      if (!gotResult && code !== 0 && !reply.error) reply.error = stderr.trim().split('\n').slice(-3).join(' ') || `Stopped (exit ${code}).`;
      this.save();
      this.emit();
    });
    child.on('error', (e) => {
      reply.done = true;
      reply.error = e.message;
      this.child = null;
      this.save();
      this.emit();
    });
  }
}

module.exports = { Manager };
