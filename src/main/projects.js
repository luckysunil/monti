// Projects, streams, tasks and to-dos.
//
// Each project keeps its own data inside its folder so it travels with git:
//   <project>/AGENTS.md            project memory, readable by any AI tool
//   <project>/CLAUDE.md            "@AGENTS.md" so Claude Code loads the memory
//   <project>/.monti/project.json  streams, tasks, to-dos, activity
// The list of projects on this Mac lives in the machine store (projects.json).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EFFORTS = [1, 2, 3, 5, 8];
const TAGS = ['new', 'existing', 'doc', 'deck', 'other'];
const FEED_LIMIT = 200;

const uid = () => crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'stream';

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function memoryTemplate(name, type) {
  const intro = type === 'customer'
    ? 'Customer project. Keep the background, contacts, open commitments and decisions here.'
    : 'Read this first. It is the handoff file for any AI tool or person picking up the project.';
  return `# ${name} — project memory

${intro}

## Background

(What this is, who it's for, and why it exists.)

## Goals

## Key decisions

## Current state

## Next steps

## Gotchas
`;
}

// Splits AGENTS.md into { title, sections: { Heading: body } } on "## " headings.
function parseMemory(text) {
  const sections = {};
  const order = [];
  let current = null;
  let title = '';
  for (const line of String(text || '').split('\n')) {
    const h1 = line.match(/^#\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) {
      current = h2[1].trim();
      sections[current] = '';
      order.push(current);
    } else if (h1 && !title) {
      title = h1[1].trim();
    } else if (current) {
      sections[current] += line + '\n';
    }
  }
  for (const k of order) sections[k] = sections[k].trim();
  return { title, sections, order };
}

function writeMemorySection(text, section, content, mode) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
  if (start === -1) {
    return `${String(text || '').trimEnd()}\n\n## ${section}\n\n${content.trim()}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  const existing = lines.slice(start + 1, end).join('\n').trim();
  const isPlaceholder = /^\(.*\)$/.test(existing);
  const body = mode === 'append' && existing && !isPlaceholder ? `${existing}\n${content.trim()}` : content.trim();
  return [...lines.slice(0, start + 1), '', body, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

class ProjectService {
  constructor({ machineStore, dataRoot, onChange }) {
    this.machineStore = machineStore;
    this.dataRoot = dataRoot;
    this.onChange = onChange || (() => {});
    this.registry = machineStore.readJSON('projects.json', []);
    this.projects = new Map(); // id -> { meta, data, memory, git }
    this.reloadAll();
  }

  /* ---------- persistence ---------- */

  dataFile(root) {
    return path.join(root, '.monti', 'project.json');
  }

  reloadAll() {
    for (const entry of this.registry) this.load(entry);
  }

  load(entry) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.dataFile(entry.root), 'utf8'));
    } catch {}
    const missing = !fs.existsSync(entry.root);
    if (!data) data = { version: 1, id: entry.id, name: path.basename(entry.root), type: entry.type, streams: [], todos: [], feed: [] };
    data.streams = data.streams || [];
    data.todos = data.todos || [];
    data.feed = data.feed || [];
    let memory = '';
    try {
      memory = fs.readFileSync(path.join(entry.root, 'AGENTS.md'), 'utf8');
    } catch {}
    const prev = this.projects.get(entry.id);
    this.projects.set(entry.id, { meta: entry, data, memory, missing, git: prev ? prev.git : null });
  }

  save(id) {
    const p = this.projects.get(id);
    if (!p || p.missing) return;
    fs.mkdirSync(path.dirname(this.dataFile(p.meta.root)), { recursive: true });
    const file = this.dataFile(p.meta.root);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(p.data, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
    this.onChange();
  }

  saveRegistry() {
    this.machineStore.writeJSON('projects.json', this.registry);
  }

  get(id) {
    const p = this.projects.get(id);
    if (!p) throw new Error('Project not found');
    return p;
  }

  stream(projectId, streamId) {
    const s = this.get(projectId).data.streams.find((x) => x.id === streamId);
    if (!s) throw new Error('Stream not found');
    return s;
  }

  task(projectId, streamId, taskId) {
    const t = this.stream(projectId, streamId).tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`Task ${taskId} not found`);
    return t;
  }

  log(projectId, streamName, text) {
    const p = this.get(projectId);
    p.data.feed.unshift({ at: now(), stream: streamName || null, text });
    p.data.feed.length = Math.min(p.data.feed.length, FEED_LIMIT);
  }

  /* ---------- git ---------- */

  async refreshGit(id) {
    const p = this.projects.get(id);
    if (!p || p.meta.type !== 'repo' || p.missing) return;
    const inside = await git(p.meta.root, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      p.git = { isRepo: false };
    } else {
      const [branch, origin, head] = await Promise.all([
        git(p.meta.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(p.meta.root, ['remote', 'get-url', 'origin']),
        git(p.meta.root, ['rev-parse', '--verify', 'HEAD']),
      ]);
      p.git = { isRepo: true, branch: branch.ok ? branch.out : 'main', origin: origin.ok ? origin.out : null, hasCommits: head.ok };
    }
    this.onChange();
  }

  refreshAllGit() {
    for (const id of this.projects.keys()) this.refreshGit(id);
  }

  async diffForStream(projectId, streamId) {
    const p = this.get(projectId);
    const s = streamId ? this.stream(projectId, streamId) : null;
    const cwd = s ? this.workspacePath(p, s) : p.meta.root;
    const base = (p.git && p.git.branch) || 'main';
    const parts = [];
    const status = await git(cwd, ['status', '--short']);
    parts.push(`# git status (${cwd})\n${status.out || '(clean)'}`);
    if (s && s.workspace && s.workspace.branch) {
      const log = await git(cwd, ['log', '--oneline', '-n', '15', `${base}..HEAD`]);
      parts.push(`# commits on ${s.workspace.branch} not on ${base}\n${log.out || '(none)'}`);
      const stat = await git(cwd, ['diff', '--stat', `${base}...HEAD`]);
      parts.push(`# diff --stat ${base}...HEAD\n${stat.out || '(no committed changes)'}`);
    } else {
      const log = await git(cwd, ['log', '--oneline', '-n', '15']);
      parts.push(`# recent commits\n${log.out || '(none)'}`);
    }
    const wip = await git(cwd, ['diff', '--stat']);
    parts.push(`# uncommitted changes\n${wip.out || '(none)'}`);
    return parts.join('\n\n');
  }

  /* ---------- projects ---------- */

  async createRepoProject({ name, mode, folder, parent, addMemory }) {
    let root;
    if (mode === 'new') {
      root = path.join(parent, slugify(name));
      if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} already exists and isn't empty.`);
      fs.mkdirSync(root, { recursive: true });
      const init = await git(root, ['init', '-b', 'main']);
      if (!init.ok) throw new Error(`git init failed: ${init.err}`);
    } else {
      root = folder;
      if (!fs.existsSync(root)) throw new Error('Folder not found.');
      if (this.registry.some((e) => e.root === root)) throw new Error('This folder is already a Monti project.');
      const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
      if (!inside.ok) {
        const init = await git(root, ['init', '-b', 'main']);
        if (!init.ok) throw new Error(`This folder isn't a git repo and git init failed: ${init.err}`);
      }
    }
    const id = this.register({ root, type: 'repo', name, addMemory });
    if (mode === 'new') {
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', `Start ${name} with Monti project memory`]);
    }
    await this.refreshGit(id);
    return id;
  }

  createCustomerProject({ name }) {
    const root = path.join(this.dataRoot, 'customers', slugify(name));
    if (this.registry.some((e) => e.root === root)) throw new Error('A customer with this name already exists.');
    fs.mkdirSync(root, { recursive: true });
    return this.register({ root, type: 'customer', name, addMemory: true });
  }

  register({ root, type, name, addMemory }) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(this.dataFile(root), 'utf8'));
    } catch {}
    const id = (existing && existing.id) || crypto.randomUUID();
    const entry = { id, root, type: (existing && existing.type) || type, addedAt: now() };
    this.registry.push(entry);
    this.saveRegistry();
    if (!existing) {
      fs.mkdirSync(path.join(root, '.monti'), { recursive: true });
      const data = { version: 1, id, name, type, createdAt: now(), streams: [], todos: [], feed: [] };
      fs.writeFileSync(this.dataFile(root), JSON.stringify(data, null, 2) + '\n');
    }
    if (addMemory) this.ensureMemory(root, name, type);
    this.load(entry);
    this.log(id, null, existing ? 'opened on this Mac' : 'project created');
    this.save(id);
    return id;
  }

  ensureMemory(root, name, type) {
    const agents = path.join(root, 'AGENTS.md');
    if (!fs.existsSync(agents)) fs.writeFileSync(agents, memoryTemplate(name, type));
    const claude = path.join(root, 'CLAUDE.md');
    if (!fs.existsSync(claude)) {
      fs.writeFileSync(claude, '@AGENTS.md\n');
    } else {
      const text = fs.readFileSync(claude, 'utf8');
      if (!text.includes('@AGENTS.md')) fs.writeFileSync(claude, `${text.trimEnd()}\n\n@AGENTS.md\n`);
    }
  }

  removeProject(id) {
    // Only forgets the project on this Mac. Files stay where they are.
    this.registry = this.registry.filter((e) => e.id !== id);
    this.projects.delete(id);
    this.saveRegistry();
    this.onChange();
  }

  /* ---------- memory ---------- */

  readMemory(id) {
    const p = this.get(id);
    try {
      p.memory = fs.readFileSync(path.join(p.meta.root, 'AGENTS.md'), 'utf8');
    } catch {
      p.memory = '';
    }
    return p.memory;
  }

  updateMemory(id, section, content, mode, by) {
    const p = this.get(id);
    const file = path.join(p.meta.root, 'AGENTS.md');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : memoryTemplate(p.data.name, p.meta.type);
    fs.writeFileSync(file, writeMemorySection(current, section, content, mode));
    p.memory = fs.readFileSync(file, 'utf8');
    this.log(id, by, `updated project memory: ${section}`);
    this.save(id);
  }

  writeHandoff(id, streamId, note) {
    const p = this.get(id);
    const s = this.stream(id, streamId);
    const dir = path.join(p.meta.root, '.monti', 'handoffs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${slugify(s.name)}.md`), `\n## ${now()}\n\n${note.trim()}\n`);
    this.log(id, s.name, 'wrote a handoff note');
    this.save(id);
  }

  /* ---------- streams ---------- */

  workspacePath(p, s) {
    const rel = (s.workspace && s.workspace.path) || '.';
    return path.resolve(p.meta.root, rel);
  }

  async createStream(projectId, { name, description, tag, workspaceMode, dependsOn }) {
    const p = this.get(projectId);
    if (!name || !name.trim()) throw new Error('Give the stream a name.');
    const slug = slugify(name);
    if (p.data.streams.some((s) => slugify(s.name) === slug)) throw new Error('A stream with this name already exists.');
    let workspace = { kind: 'root', path: '.' };
    if (workspaceMode === 'worktree') {
      if (!p.git || !p.git.isRepo) await this.refreshGit(projectId);
      if (!p.git || !p.git.hasCommits) throw new Error('A worktree needs at least one commit in the repo. Use the project folder instead, or commit first.');
      const branch = `monti/${slug}`;
      const target = path.join(path.dirname(p.meta.root), `${path.basename(p.meta.root)}-streams`, slug);
      const res = await git(p.meta.root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      if (!res.ok) throw new Error(`Couldn't create the worktree: ${res.err}`);
      workspace = { kind: 'worktree', path: path.relative(p.meta.root, target), branch };
    } else if (workspaceMode === 'folder') {
      const sub = tag === 'deck' ? 'decks' : 'docs';
      fs.mkdirSync(path.join(p.meta.root, sub), { recursive: true });
      workspace = { kind: 'folder', path: sub };
    }
    const stream = {
      id: uid(),
      name: name.trim(),
      description: (description || '').trim(),
      tag: TAGS.includes(tag) ? tag : 'other',
      workspace,
      dependsOn: (dependsOn || []).filter((d) => p.data.streams.some((s) => s.id === d)),
      status: 'active',
      tasks: [],
      createdAt: now(),
    };
    p.data.streams.push(stream);
    this.log(projectId, stream.name, 'stream created');
    this.save(projectId);
    return stream;
  }

  updateStream(projectId, streamId, patch) {
    const s = this.stream(projectId, streamId);
    for (const k of ['name', 'description', 'tag', 'status', 'dependsOn']) if (patch[k] !== undefined) s[k] = patch[k];
    if (patch.status === 'done') this.log(projectId, s.name, 'marked done');
    this.save(projectId);
    return s;
  }

  removeStream(projectId, streamId) {
    const p = this.get(projectId);
    const s = this.stream(projectId, streamId);
    p.data.streams = p.data.streams.filter((x) => x.id !== streamId);
    for (const other of p.data.streams) other.dependsOn = (other.dependsOn || []).filter((d) => d !== streamId);
    this.log(projectId, s.name, 'stream removed (its folder and branch were kept)');
    this.save(projectId);
  }

  /* ---------- tasks ---------- */

  addTasks(projectId, streamId, tasks, { replace = false, by } = {}) {
    const s = this.stream(projectId, streamId);
    const made = tasks.map((t) => ({
      id: uid(),
      title: String(t.title || '').trim() || 'Untitled task',
      effort: EFFORTS.includes(Number(t.effort)) ? Number(t.effort) : nearestEffort(t.effort),
      status: ['todo', 'doing', 'review', 'done'].includes(t.status) ? t.status : 'todo',
      checkpoint: t.checkpoint ? String(t.checkpoint) : null,
      question: t.question ? String(t.question) : null,
      note: null,
      updatedAt: now(),
    }));
    s.tasks = replace ? made : [...(s.tasks || []), ...made];
    if (s.status === 'done' && made.some((t) => t.status !== 'done')) s.status = 'active';
    this.log(projectId, s.name, `${replace ? 'planned' : 'added'} ${made.length} task${made.length === 1 ? '' : 's'}${by ? ` (${by})` : ''}`);
    this.save(projectId);
    return made;
  }

  updateTask(projectId, streamId, taskId, patch, by) {
    const s = this.stream(projectId, streamId);
    const t = this.task(projectId, streamId, taskId);
    const before = t.status;
    if (patch.title !== undefined) t.title = String(patch.title);
    if (patch.effort !== undefined) t.effort = nearestEffort(patch.effort);
    if (patch.checkpoint !== undefined) t.checkpoint = patch.checkpoint || null;
    if (patch.question !== undefined) t.question = patch.question || null;
    if (patch.note !== undefined) t.note = patch.note || null;
    if (patch.status !== undefined) t.status = patch.status;
    t.updatedAt = now();
    if (patch.status && patch.status !== before) {
      const verb = { doing: 'started', done: 'finished', review: 'needs your call on', todo: 'reopened' }[patch.status];
      this.log(projectId, s.name, `${verb} “${t.title}”${patch.note ? `: ${patch.note}` : ''}${by ? ` (${by})` : ''}`);
      if (patch.status === 'done') t.question = null;
    }
    this.save(projectId);
    return t;
  }

  removeTask(projectId, streamId, taskId) {
    const s = this.stream(projectId, streamId);
    s.tasks = s.tasks.filter((t) => t.id !== taskId);
    this.save(projectId);
  }

  /* ---------- to-dos (customer projects, but any project may have them) ---------- */

  addTodo(projectId, { title, due, by }) {
    const p = this.get(projectId);
    const todo = { id: uid(), title: String(title).trim(), due: due || null, done: false, createdAt: now() };
    p.data.todos.push(todo);
    this.log(projectId, by || null, `added to-do “${todo.title}”`);
    this.save(projectId);
    return todo;
  }

  updateTodo(projectId, todoId, patch, by) {
    const p = this.get(projectId);
    const t = p.data.todos.find((x) => x.id === todoId);
    if (!t) throw new Error('To-do not found');
    for (const k of ['title', 'due', 'done']) if (patch[k] !== undefined) t[k] = patch[k];
    if (patch.done === true) this.log(projectId, by || null, `completed “${t.title}”`);
    this.save(projectId);
    return t;
  }

  removeTodo(projectId, todoId) {
    const p = this.get(projectId);
    p.data.todos = p.data.todos.filter((x) => x.id !== todoId);
    this.save(projectId);
  }

  /* ---------- snapshot for the UI and the Manager ---------- */

  snapshot() {
    return this.registry
      .map((e) => this.projects.get(e.id))
      .filter(Boolean)
      .map((p) => ({
        id: p.meta.id,
        root: p.meta.root,
        type: p.meta.type,
        name: p.data.name,
        missing: p.missing,
        git: p.git,
        streams: p.data.streams.map((s) => ({ ...s, workspacePath: this.workspacePath(p, s) })),
        todos: p.data.todos,
        feed: p.data.feed.slice(0, 40),
        memory: parseMemory(p.memory),
      }));
  }
}

function nearestEffort(v) {
  const n = Number(v) || 2;
  return EFFORTS.reduce((best, e) => (Math.abs(e - n) < Math.abs(best - n) ? e : best), EFFORTS[0]);
}

module.exports = { ProjectService, parseMemory, slugify, EFFORTS };
