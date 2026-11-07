// MCP tools exposed to Claude sessions.
//   streamTools(session)  for a working session: its task list, checkpoints, progress, memory
//   managerTools()        for the Manager: read every project and session, plan tasks
const { readTranscript } = require('./library');
const { EFFORTS } = require('./projects');

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const taskItem = {
  type: 'object',
  properties: {
    title: str('Short, concrete task title'),
    effort: { type: 'number', enum: EFFORTS, description: 'Estimated effort in hours: 1, 2, 3, 5 or 8' },
    checkpoint: str('Optional: what the owner must approve before or after this task'),
  },
  required: ['title', 'effort'],
};

function pctOf(s) {
  const t = s.tasks || [];
  if (!t.length) return s.status === 'done' ? 100 : 0;
  const tot = t.reduce((a, x) => a + x.effort, 0);
  return Math.round((t.filter((x) => x.status === 'done').reduce((a, x) => a + x.effort, 0) / tot) * 100);
}

function taskLines(s) {
  if (!s.tasks || !s.tasks.length) return '  (no tasks yet)';
  return s.tasks
    .map((t) => `  [${t.id}] ${t.status.padEnd(6)} ${t.effort}h  ${t.title}${t.checkpoint ? `  — checkpoint: ${t.checkpoint}` : ''}${t.question ? `  — question: ${t.question}` : ''}`)
    .join('\n');
}

function streamSummary(p, s, statusOf) {
  const deps = (s.dependsOn || []).map((d) => p.data.streams.find((x) => x.id === d)).filter(Boolean);
  const depText = deps.length ? `depends on: ${deps.map((d) => `${d.name} (${pctOf(d)}%)`).join(', ')}` : 'no dependencies';
  return `Stream ${s.name} [${s.id}] · ${s.tag} · ${pctOf(s)}% by effort · ${s.status} · ${depText}${statusOf ? ` · sessions: ${statusOf(p.meta.id, s.id)}` : ''}
  ${s.description || ''}
  workspace: ${s.workspace.kind === 'pending-worktree' ? 'own worktree, created when its session starts' : `${s.workspace.kind} ${s.workspace.path}`}${s.workspace.branch ? ` (branch ${s.workspace.branch})` : ''}${(s.ownedPaths || []).length ? `\n  owns: ${s.ownedPaths.join(', ')}` : ''}
${taskLines(s)}`;
}

function streamTools(ctx, session) {
  const { projects } = ctx;
  const pid = session.projectId;
  const sid = session.streamId;
  const by = session.name;
  const p = () => projects.get(pid);
  const s = () => {
    if (!sid) throw new Error('This session is not attached to a stream, so it has no task list.');
    return projects.stream(pid, sid);
  };

  const tools = [
    {
      name: 'get_context',
      description: 'Call this first. Returns the project, your stream, your task list with IDs, dependencies, and the project memory.',
      inputSchema: obj({}),
      handler: () => {
        const proj = p();
        const mem = projects.readMemory(pid);
        const stream = sid ? streamSummary(proj, s()) : 'This session is not attached to a stream.';
        const others = proj.data.streams.filter((x) => x.id !== sid).map((x) => `- ${x.name}: ${pctOf(x)}%, ${x.status}`).join('\n') || '(none)';
        const todos = proj.data.todos.filter((t) => !t.done).map((t) => `- [${t.id}] ${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('\n');
        const st = sid ? s() : null;
        const ifaces = (proj.data.plan && proj.data.plan.interfaces) || [];
        const mine = st ? ifaces.filter((i) => (st.provides || []).includes(i.name) || (st.consumes || []).includes(i.name)) : [];
        const contract = st && (st.ownedPaths || []).length
          ? `\nYou own: ${st.ownedPaths.join(', ')} (only change files there)\n${mine.map((i) => `${(st.provides || []).includes(i.name) ? 'You implement' : 'You use'} ${i.name} (${i.kind}, ${i.location || 'tbd'}${i.exists ? '' : ', not written yet'}):\n${i.definition}`).join('\n\n')}\n`
          : '';
        return `Project: ${proj.data.name} (${proj.meta.type}) at ${proj.meta.root}

${stream}
${contract}
Other streams working in parallel:
${others}
${todos ? `\nOpen to-dos:\n${todos}\n` : ''}
Project memory (AGENTS.md):
${mem || '(empty)'}`;
      },
    },
    {
      name: 'add_tasks',
      description: 'Add tasks to your stream. Keep each task small (1–8h). Add a checkpoint wherever the owner should decide or review.',
      inputSchema: obj({ tasks: { type: 'array', items: taskItem }, replace: { type: 'boolean', description: 'Replace the whole task list' } }, ['tasks']),
      handler: ({ tasks, replace }) => {
        const made = projects.addTasks(pid, s().id, tasks || [], { replace, by });
        return `Added ${made.length} tasks:\n${made.map((t) => `[${t.id}] ${t.title}`).join('\n')}`;
      },
    },
    {
      name: 'start_task',
      description: 'Mark a task as in progress before you work on it.',
      inputSchema: obj({ task_id: str('Task ID from get_context') }, ['task_id']),
      handler: ({ task_id }) => {
        projects.updateTask(pid, s().id, task_id, { status: 'doing' });
        return 'Started.';
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task done with a one-line note of what changed.',
      inputSchema: obj({ task_id: str('Task ID'), note: str('One line: what was done') }, ['task_id']),
      handler: ({ task_id, note }) => {
        projects.updateTask(pid, s().id, task_id, { status: 'done', note });
        const left = s().tasks.filter((t) => t.status !== 'done');
        return left.length ? `Done. ${left.length} task(s) left. Next: [${left[0].id}] ${left[0].title}` : 'Done. All tasks in this stream are complete.';
      },
    },
    {
      name: 'request_review',
      description: 'Ask the owner to decide or review something. Shows as "needs you" in Monti. After calling it, stop and wait for their answer in this session.',
      inputSchema: obj({ question: str('The decision or review you need, phrased so it can be answered quickly'), task_id: str('Optional: the task this is about') }, ['question']),
      handler: ({ question, task_id }) => {
        if (task_id) projects.updateTask(pid, s().id, task_id, { status: 'review', question });
        else projects.addTasks(pid, s().id, [{ title: question, effort: 1, status: 'review', question }], { by });
        return 'The owner has been asked. Stop here and wait for their reply in this session.';
      },
    },
    {
      name: 'update_task',
      description: 'Change a task: title, effort estimate (hours) or checkpoint.',
      inputSchema: obj({ task_id: str('Task ID'), title: str('New title'), effort: { type: 'number', enum: EFFORTS }, checkpoint: str('Checkpoint text, or empty to remove') }, ['task_id']),
      handler: ({ task_id, ...patch }) => {
        projects.updateTask(pid, s().id, task_id, patch);
        return 'Updated.';
      },
    },
    {
      name: 'report_progress',
      description: 'Post a one-line progress note to the project activity feed.',
      inputSchema: obj({ note: str('What just happened, in one line') }, ['note']),
      handler: ({ note }) => {
        projects.log(pid, by, note);
        projects.save(pid);
        return 'Posted.';
      },
    },
    {
      name: 'update_memory',
      description: 'Update a section of the project memory (AGENTS.md) so any tool can pick up later. Use for "Current state", "Next steps", "Key decisions", "Gotchas". Keep it short.',
      inputSchema: obj({ section: str('Section heading, e.g. "Current state"'), content: str('Markdown content'), mode: { type: 'string', enum: ['replace', 'append'] } }, ['section', 'content']),
      handler: ({ section, content, mode }) => {
        projects.updateMemory(pid, section, content, mode || 'replace', by);
        return `Updated "${section}".`;
      },
    },
    {
      name: 'write_handoff',
      description: 'Write a short handoff note for this stream: what was done, what is next, anything surprising. Do this before stopping for the day or at a milestone.',
      inputSchema: obj({ note: str('Markdown note') }, ['note']),
      handler: ({ note }) => {
        projects.writeHandoff(pid, s().id, note);
        return 'Saved.';
      },
    },
    {
      name: 'list_todos',
      description: "List the project's to-dos (customer follow-ups).",
      inputSchema: obj({}),
      handler: () => p().data.todos.map((t) => `[${t.id}] ${t.done ? 'done' : 'open'} ${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('\n') || '(none)',
    },
    {
      name: 'add_todo',
      description: 'Add a to-do or follow-up for the owner.',
      inputSchema: obj({ title: str('What needs doing'), due: str('Optional due date YYYY-MM-DD') }, ['title']),
      handler: ({ title, due }) => `Added [${projects.addTodo(pid, { title, due, by }).id}].`,
    },
    {
      name: 'complete_todo',
      description: 'Tick off a to-do.',
      inputSchema: obj({ todo_id: str('To-do ID') }, ['todo_id']),
      handler: ({ todo_id }) => {
        projects.updateTodo(pid, todo_id, { done: true }, by);
        return 'Done.';
      },
    },
  ];
  return tools;
}

function managerTools(ctx) {
  const { projects, sessions, projectsDir, statusOf, sessionStatus } = ctx;
  const findProject = (idOrName) => {
    const snap = projects.snapshot();
    const hit = snap.find((x) => x.id === idOrName) || snap.find((x) => x.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!hit) throw new Error(`No project "${idOrName}". Call list_projects.`);
    return projects.get(hit.id);
  };
  const findStream = (p, idOrName) => {
    const s = p.data.streams.find((x) => x.id === idOrName) || p.data.streams.find((x) => x.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!s) throw new Error(`No stream "${idOrName}" in ${p.data.name}.`);
    return s;
  };

  return [
    {
      name: 'list_projects',
      description: 'All projects on this Mac with every stream, progress by effort, status and open questions for the owner.',
      inputSchema: obj({}),
      handler: () => {
        const snap = projects.snapshot();
        if (!snap.length) return 'No projects yet.';
        return snap
          .map((sp) => {
            const p = projects.get(sp.id);
            const streams = p.data.streams.map((s) => streamSummary(p, s, statusOf)).join('\n\n') || '(no streams)';
            const todos = p.data.todos.filter((t) => !t.done).map((t) => `  - ${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('\n');
            return `## ${p.data.name} [${p.meta.id}] · ${p.meta.type} · ${p.meta.root}${sp.git && sp.git.isRepo ? ` · branch ${sp.git.branch}${sp.git.origin ? ` · remote ${sp.git.origin}` : ' · no GitHub remote yet'}` : ''}
${streams}${todos ? `\nOpen to-dos:\n${todos}` : ''}`;
          })
          .join('\n\n');
      },
    },
    {
      name: 'get_project',
      description: 'One project in detail: memory (AGENTS.md), streams with tasks, to-dos and the recent activity feed.',
      inputSchema: obj({ project: str('Project ID or name') }, ['project']),
      handler: ({ project }) => {
        const p = findProject(project);
        const mem = projects.readMemory(p.meta.id);
        const feed = p.data.feed.slice(0, 30).map((f) => `${f.at} ${f.stream ? `${f.stream}: ` : ''}${f.text}`).join('\n');
        return `# ${p.data.name}\n\n## Memory\n${mem || '(empty)'}\n\n## Streams\n${p.data.streams.map((s) => streamSummary(p, s, statusOf)).join('\n\n') || '(none)'}\n\n## To-dos\n${p.data.todos.map((t) => `[${t.id}] ${t.done ? 'done' : 'open'} ${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('\n') || '(none)'}\n\n## Recent activity\n${feed || '(none)'}`;
      },
    },
    {
      name: 'list_sessions',
      description: 'Claude sessions running or saved in Monti, with project, stream, folder and live status (working, needs you, idle, stopped).',
      inputSchema: obj({ project: str('Optional project ID or name') }),
      handler: ({ project }) => {
        const pidFilter = project ? findProject(project).meta.id : null;
        const list = sessions.list().filter((s) => !pidFilter || s.projectId === pidFilter);
        return list.map((s) => `[${s.id}] ${s.name} · ${sessionStatus(s.id)} · ${s.cwd}${s.projectId ? '' : ' · not in a project'}`).join('\n') || '(none)';
      },
    },
    {
      name: 'read_session',
      description: 'Read what happened in a session: what the owner asked, what Claude replied and which tools it used. Returns the most recent part.',
      inputSchema: obj({ session_id: str('Session ID from list_sessions'), max_chars: { type: 'number', description: 'Default 20000' } }, ['session_id']),
      handler: ({ session_id, max_chars }) => readTranscript(projectsDir, session_id, Math.min(Number(max_chars) || 20000, 60000)) || 'No transcript yet (nothing has been said in this session).',
    },
    {
      name: 'git_status',
      description: "Git view of a project or one stream's worktree: status, commits not yet on the main branch, and changed files.",
      inputSchema: obj({ project: str('Project ID or name'), stream: str('Optional stream ID or name') }, ['project']),
      handler: async ({ project, stream }) => {
        const p = findProject(project);
        const s = stream ? findStream(p, stream) : null;
        return projects.diffForStream(p.meta.id, s ? s.id : null);
      },
    },
    {
      name: 'plan_tasks',
      description: 'Break a stream into small tasks (1–8h each) with checkpoints where the owner should judge. Replaces or appends to the task list.',
      inputSchema: obj({ project: str('Project ID or name'), stream: str('Stream ID or name'), tasks: { type: 'array', items: taskItem }, replace: { type: 'boolean' } }, ['project', 'stream', 'tasks']),
      handler: ({ project, stream, tasks, replace }) => {
        const p = findProject(project);
        const s = findStream(p, stream);
        const made = projects.addTasks(p.meta.id, s.id, tasks || [], { replace, by: 'Manager' });
        return `Planned ${made.length} tasks (${made.reduce((a, t) => a + t.effort, 0)}h) for ${s.name}.`;
      },
    },
    {
      name: 'update_task',
      description: 'Change a task: title, effort (hours), checkpoint, or status (todo, doing, review, done).',
      inputSchema: obj({ project: str('Project ID or name'), stream: str('Stream ID or name'), task_id: str('Task ID'), title: str(''), effort: { type: 'number', enum: EFFORTS }, checkpoint: str(''), status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] } }, ['project', 'stream', 'task_id']),
      handler: ({ project, stream, task_id, ...patch }) => {
        const p = findProject(project);
        const s = findStream(p, stream);
        projects.updateTask(p.meta.id, s.id, task_id, patch, 'Manager');
        return 'Updated.';
      },
    },
    {
      name: 'create_stream',
      description: 'Add a new stream to a project. Uses the project folder as its workspace (the owner can create worktrees from the app).',
      inputSchema: obj({ project: str('Project ID or name'), name: str('Stream name'), description: str('One line'), tag: { type: 'string', enum: ['new', 'existing', 'doc', 'deck', 'other'] }, depends_on: { type: 'array', items: { type: 'string' }, description: 'Stream IDs or names' } }, ['project', 'name']),
      handler: async ({ project, name, description, tag, depends_on }) => {
        const p = findProject(project);
        const deps = (depends_on || []).map((d) => findStream(p, d).id);
        const s = await projects.createStream(p.meta.id, { name, description, tag, workspaceMode: 'root', dependsOn: deps });
        return `Created stream ${s.name} [${s.id}].`;
      },
    },
    {
      name: 'replan_project',
      description: "Re-read a repo project's code and regenerate its workstreams, modules, interfaces and dependencies. Existing streams with the same name are updated, not duplicated. Runs in the background; the owner sees progress in the project view.",
      inputSchema: obj({ project: str('Project ID or name'), goal: str('Optional: what the owner wants to build or change next') }, ['project']),
      handler: ({ project, goal }) => {
        const p = findProject(project);
        ctx.plan(p.meta.id, goal || null);
        return 'Planning started. It usually takes a minute or two.';
      },
    },
    {
      name: 'add_todo',
      description: 'Add a to-do to a project (usually a customer follow-up).',
      inputSchema: obj({ project: str('Project ID or name'), title: str('What needs doing'), due: str('Optional YYYY-MM-DD') }, ['project', 'title']),
      handler: ({ project, title, due }) => {
        const p = findProject(project);
        return `Added [${projects.addTodo(p.meta.id, { title, due, by: 'Manager' }).id}].`;
      },
    },
    {
      name: 'update_memory',
      description: "Update a section of a project's memory (AGENTS.md). Only when the owner asks you to.",
      inputSchema: obj({ project: str('Project ID or name'), section: str('Heading'), content: str('Markdown'), mode: { type: 'string', enum: ['replace', 'append'] } }, ['project', 'section', 'content']),
      handler: ({ project, section, content, mode }) => {
        const p = findProject(project);
        projects.updateMemory(p.meta.id, section, content, mode || 'replace', 'Manager');
        return 'Updated.';
      },
    },
  ];
}

module.exports = { streamTools, managerTools, pctOf };
