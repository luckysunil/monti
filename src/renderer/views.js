/* Renders the overview area. Each function returns HTML; clicks are handled
   by delegation in app.js through data-act attributes. */
const EFFORTS = [1, 2, 3, 5, 8];
const TASK_ICON = { done: '✓', doing: '●', review: '⚠', todo: '○' };

function banner(state, p) {
  const out = [];
  if (state.machine.role === 'pull-only') {
    out.push('<div class="banner">This Mac is pull-only. You can work here and start sessions from the project memory, but changes stay on this Mac and are not pushed back.</div>');
  }
  if (p && p.missing) out.push(`<div class="banner">The folder <code>${esc(short(p.root))}</code> can't be found on this Mac. Clone or download it to that path, or remove the project.</div>`);
  return out.join('');
}

function feedPanel(p) {
  const items = p.feed.slice(0, 25);
  return `<div class="panel"><h2>Activity</h2>${items.length
    ? `<ul class="feed">${items.map((f) => `<li><time title="${esc(new Date(f.at).toLocaleString())}">${relTime(f.at)}</time><span>${f.stream ? `<b>${esc(f.stream)}</b> ` : ''}${esc(f.text)}</span></li>`).join('')}</ul>`
    : '<div class="empty">Nothing yet. Sessions post progress here as they work.</div>'}</div>`;
}

function memoryPanel(p) {
  const m = p.memory || { sections: {}, order: [] };
  const show = ['Background', 'Key decisions', 'Current state', 'Next steps'];
  const parts = show
    .filter((k) => m.sections[k] && !/^\(.*\)$/.test(m.sections[k]))
    .map((k) => `<h4>${esc(k)}</h4><div class="body">${esc(m.sections[k])}</div>`)
    .join('');
  return `<div class="panel"><h2>Project memory<span class="r"><button class="btn small" data-act="open-memory">Open AGENTS.md</button></span></h2>
    <div class="memory"><div class="file">AGENTS.md · read by any AI tool that opens this folder</div>${parts || '<div class="body">Empty so far. Sessions fill in Current state and Next steps as they work; add the background yourself.</div>'}</div></div>`;
}

function headActions(state, ui, p) {
  const repo = p.type === 'repo';
  const pullOnly = state.machine.role === 'pull-only';
  const menu = ui.menu === 'project'
    ? `<div class="menu" data-menu>
        <button data-act="general-session">Start a general session</button>
        <button data-act="reveal">Open folder in Finder</button>
        <button data-act="open-memory">Open AGENTS.md</button>
        <button data-act="ask-manager" data-q="Suggest how to split ${esc(p.name)} into streams that can run in parallel, with dependencies. Create them with create_stream after I agree.">Ask the Manager to propose streams</button>
        <button data-act="reload">Reload from disk</button>
        <button data-act="remove-project" class="danger">Remove from Monti…</button>
      </div>`
    : '';
  return `<div class="actions">
    ${repo ? `<button class="btn" data-act="integrate" ${pullOnly ? 'disabled title="Pull-only Mac"' : ''}>Integrate branches</button>` : ''}
    <button class="btn primary" data-act="new-stream">+ New ${repo ? 'stream' : 'workstream'}</button>
    <button class="btn" data-act="toggle-menu" data-menu-id="project" aria-label="More">⋯</button>${menu}</div>`;
}

function streamsPanel(state, ui, p, selected, label) {
  if (!p.streams.length) {
    return `<div class="panel"><h2>${label}</h2><div class="empty">
      <span>${p.type === 'repo' ? 'Split the work into streams that can run in parallel: a feature, a fix, a doc, a deck. Each gets its own Claude session and, for code, its own branch.' : 'Workstreams are pieces of customer work that get their own Claude session: a proposal, a deck, an analysis.'}</span>
      <div class="row"><button class="btn primary" data-act="new-stream">+ New ${label === 'Streams' ? 'stream' : 'workstream'}</button>
      <button class="btn" data-act="ask-manager" data-q="Suggest how to split ${esc(p.name)} into streams that can run in parallel, with dependencies. Create them with create_stream after I agree.">Ask the Manager to propose</button></div></div></div>`;
  }
  const rows = p.streams.map((s) => {
    const st = streamState(state, p, s);
    const pc = pctOf(s);
    const reviews = s.tasks.filter((t) => t.status === 'review').length;
    const blocked = blockers(p, s);
    const ss = sessionsOf(state, p.id, s.id);
    const ws = s.workspace.kind === 'worktree' ? s.workspace.branch : s.workspace.kind === 'folder' ? `${s.workspace.path}/` : 'project folder';
    return `<tr data-s="${s.id}" class="${selected && selected.id === s.id ? 'sel' : ''}">
      <td><div class="sname">${esc(s.name)}</div><div class="ssub">${s.description ? `${esc(s.description)} · ` : ''}<code>${esc(ws)}</code></div></td>
      <td><span class="chip ${s.tag === 'new' ? 'new' : ''}">${TAG_LABEL[s.tag] || 'Other'}</span></td>
      <td class="pcell"><div class="bar-track"><i class="${st === 'done' ? 'done' : ''}" style="width:${pc}%"></i></div>
        <div class="pnum">${pc}% · ${s.tasks.filter((t) => t.status === 'done').length}/${s.tasks.length} tasks${reviews ? ` · <b>${reviews} for you</b>` : ''}</div></td>
      <td><span class="status s-${st}">${STATE_LABEL[st]}</span>
        <div class="ssub">${blocked.length ? `by ${esc(blocked.map((b) => b.name).join(', '))}` : `${ss.length} session${ss.length === 1 ? '' : 's'}`}</div></td></tr>`;
  });
  return `<div class="panel"><h2>${label}<span class="r">Click one to see its tasks and session</span></h2>
    <div class="tablewrap"><table class="streams"><tbody>${rows.join('')}</tbody></table></div></div>`;
}

function tasksPanel(state, ui, p, s) {
  if (!s) return '';
  const total = s.tasks.reduce((a, t) => a + t.effort, 0);
  const left = s.tasks.filter((t) => t.status !== 'done').reduce((a, t) => a + t.effort, 0);
  const ss = sessionsOf(state, p.id, s.id);
  const done = isDone(s);
  const rows = s.tasks.map((t) => {
    const answering = ui.answering === t.id;
    return `<li class="${t.status}" data-t="${t.id}">
      <button class="ic" data-act="cycle-task" title="Change status (to do → doing → done)">${TASK_ICON[t.status]}</button>
      <div><div class="tt">${esc(t.title)}</div>
        ${t.status === 'review' && t.question && t.question !== t.title ? `<div class="why">${esc(t.question)}</div>` : t.status === 'review' ? '<div class="why">Needs your call</div>' : ''}
        ${t.checkpoint && t.status !== 'done' ? `<div class="gate">Checkpoint: ${esc(t.checkpoint)}</div>` : ''}
        ${t.note && t.status === 'done' ? `<div class="note">${esc(t.note)}</div>` : ''}</div>
      <select data-act="effort" aria-label="Effort for ${esc(t.title)}">${EFFORTS.map((h) => `<option value="${h}" ${h === t.effort ? 'selected' : ''}>${h}h</option>`).join('')}</select>
      <span class="act">${t.status === 'review'
        ? `<button class="btn primary small" data-act="approve">Approve</button><button class="btn small" data-act="answer">Answer…</button>`
        : ''}<button class="x" data-act="remove-task" title="Remove task">×</button></span>
      ${answering ? `<form class="answer" data-act-submit="send-answer"><input id="answer-${t.id}" placeholder="Your answer goes straight to the session" autocomplete="off"><button class="btn primary small">Send</button><button class="btn small" type="button" data-act="cancel-answer">Cancel</button></form>` : ''}
    </li>`;
  });
  return `<div class="panel" data-stream="${s.id}">
    <h2><span class="t">Tasks · ${esc(s.name)}</span><span class="r">${s.tasks.length ? `<span class="eff">${left}h left of ${total}h</span>` : ''}
      <button class="btn small" data-act="plan-stream">Plan with Manager</button>
      <button class="btn small" data-act="stream-session">${ss.length ? 'Open session' : 'Start session'}</button>
      <button class="btn small" data-act="toggle-menu" data-menu-id="stream" aria-label="Stream options">⋯</button></span></h2>
    ${ui.menu === 'stream' ? `<div style="position:relative"><div class="menu" data-menu style="right:12px;top:-4px">
        <button data-act="new-session">Start another session</button>
        <button data-act="${done ? 'reopen-stream' : 'done-stream'}">${done ? 'Reopen stream' : 'Mark stream done'}</button>
        <button data-act="remove-stream" class="danger">Remove stream…</button></div></div>` : ''}
    ${s.tasks.length ? `<ul class="tasks">${rows.join('')}</ul>` : `<div class="empty">No tasks yet. The session plans them when it starts, or ask the Manager to break this stream down.</div>`}
    <form class="inline" data-act-submit="add-task">
      <input id="new-task-title" placeholder="Add a task" autocomplete="off">
      <select id="new-task-effort" aria-label="Effort">${EFFORTS.map((h) => `<option value="${h}" ${h === 2 ? 'selected' : ''}>${h}h</option>`).join('')}</select>
      <input id="new-task-check" placeholder="Checkpoint (optional)" autocomplete="off">
      <button class="btn small">Add</button>
    </form></div>`;
}

function repoView(state, ui, p) {
  const s = p.streams;
  const selected = s.find((x) => x.id === ui.selected[p.id]) || s[0];
  const W = s.reduce((a, x) => a + weightOf(x), 0) || 1;
  const nf = s.filter((x) => x.tag === 'new').length;
  const ex = s.filter((x) => x.tag === 'existing').length;
  const need = s.filter((x) => streamState(state, p, x) === 'need').length;
  const done = s.filter(isDone).length;
  const hoursLeft = s.reduce((a, x) => a + x.tasks.filter((t) => t.status !== 'done').reduce((b, t) => b + t.effort, 0), 0);
  const g = p.git || {};
  const remote = g.isRepo ? (g.origin ? `<span title="${esc(g.origin)}">remote: <code>${esc(g.origin.replace(/^https?:\/\/|\.git$/g, ''))}</code></span>` : '<span class="chip">Local only</span>') : '';
  return `${banner(state, p)}
  <div class="head"><div><h1>${esc(p.name)}</h1>
    <div class="meta"><span class="chip">Repo</span><code>${esc(short(p.root))}</code>${g.branch ? `<span>branch <code>${esc(g.branch)}</code></span>` : ''}${remote}</div></div>
    ${headActions(state, ui, p)}</div>
  <div class="summary">
    <div><div class="big">${projectProgress(p)}%</div><div class="lbl">Overall</div></div>
    <div class="bar"><div class="bar-track">${s.map((x) => `<i class="${isDone(x) ? 'done' : ''}" style="width:${(pctOf(x) * weightOf(x)) / W}%"></i>`).join('')}</div>
      <div class="legend"><span class="d">Done</span><span>In progress</span><span class="n" style="margin-left:auto">weighted by effort${hoursLeft ? ` · ${hoursLeft}h left` : ''}</span></div></div>
    <div><div class="big">${nf}<span class="sub"> / ${ex}</span></div><div class="lbl">New / existing features</div></div>
    <div><div class="big" style="${need ? 'color:var(--warn)' : ''}">${need}</div><div class="lbl">Needs you</div></div>
    <div><div class="big">${done}/${s.length}</div><div class="lbl">Streams done</div></div>
  </div>
  <div class="cols"><div class="left">${streamsPanel(state, ui, p, selected, 'Streams')}${tasksPanel(state, ui, p, selected)}</div>
    <div class="side">${feedPanel(p)}${memoryPanel(p)}</div></div>`;
}

function todosPanel(p) {
  const list = [...p.todos].sort((a, b) => (a.done - b.done) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
  return `<div class="panel"><h2>To-dos &amp; follow-ups<span class="r">Claude sessions can add and tick these</span></h2>
    ${list.length ? `<ul class="todo">${list.map((t) => {
      const d = t.done ? { text: t.due ? new Date(`${t.due}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '', over: false } : dueLabel(t.due);
      return `<li class="${t.done ? 'done' : ''}" data-todo="${t.id}"><input type="checkbox" data-act="toggle-todo" ${t.done ? 'checked' : ''} aria-label="${esc(t.title)}"><div class="t">${esc(t.title)}</div>
        <span class="due ${d.over && !t.done ? 'over' : ''}">${esc(d.text)}</span><button class="x" data-act="remove-todo" title="Remove">×</button></li>`;
    }).join('')}</ul>` : '<div class="empty">No to-dos yet.</div>'}
    <form class="inline" data-act-submit="add-todo"><input id="new-todo-title" placeholder="Add a follow-up" autocomplete="off"><input id="new-todo-due" type="date" aria-label="Due date"><button class="btn small">Add</button></form></div>`;
}

function customerView(state, ui, p) {
  const open = p.todos.filter((t) => !t.done);
  const due = open.filter((t) => dueLabel(t.due).over).length;
  const active = sessionsOf(state, p.id).filter((x) => x.running).length;
  const selected = p.streams.find((x) => x.id === ui.selected[p.id]) || p.streams[0];
  return `${banner(state, p)}
  <div class="head"><div><h1>${esc(p.name)}</h1><div class="meta"><span class="chip">Customer</span><code>${esc(short(p.root))}</code></div></div>${headActions(state, ui, p)}</div>
  <div class="summary">
    <div><div class="big">${open.length}</div><div class="lbl">Open to-dos</div></div>
    <div><div class="big" style="${due ? 'color:var(--warn)' : ''}">${due}</div><div class="lbl">Due or overdue</div></div>
    <div><div class="big">${active}</div><div class="lbl">Active sessions</div></div>
    <div><div class="big">${p.streams.filter((x) => !isDone(x)).length}</div><div class="lbl">Open workstreams</div></div>
  </div>
  <div class="cols"><div class="left">${todosPanel(p)}${streamsPanel(state, ui, p, selected, 'Workstreams')}${tasksPanel(state, ui, p, selected)}</div>
    <div class="side">${feedPanel(p)}${memoryPanel(p)}</div></div>`;
}

function welcomeView(state) {
  return `${banner(state)}<div class="welcome">
    <h1>Welcome to Monti</h1>
    <p>Split your work into streams, give each its own Claude session, and keep track of all of them from one window. Start with a project, or pick up a session you already have.</p>
    <div class="choices">
      <button class="choice" data-act="new-project" data-type="repo" data-mode="existing"><b>Add an existing repo</b><span>A folder you already work in. Monti adds a project memory file and tracks streams.</span></button>
      <button class="choice" data-act="new-project" data-type="repo" data-mode="new"><b>Start a new repo</b><span>Creates a folder with git, project memory and a first commit. Local only.</span></button>
      <button class="choice" data-act="new-project" data-type="customer"><b>Add a customer</b><span>A to-do list of follow-ups plus workstreams for proposals, decks and analysis.</span></button>
    </div>
    <p>Or open the <a href="#" data-act="go-library">Session library</a> to resume a Claude session you started before.</p>
  </div>`;
}

function libraryView(state, ui) {
  const L = ui.library;
  const folders = [...new Set((L.items || []).map((x) => x.cwd))].sort();
  const q = (L.q || '').toLowerCase();
  const items = (L.items || []).filter((x) => (!L.folder || x.cwd === L.folder) && (!q || `${x.title} ${x.firstPrompt || ''} ${x.lastPrompt || ''} ${x.cwd}`.toLowerCase().includes(q)));
  const projectById = Object.fromEntries(state.projects.map((p) => [p.id, p]));
  const rows = items.slice(0, 300).map((x) => {
    const inMonti = state.sessions.find((s) => s.id === x.id);
    const where = inMonti ? (inMonti.projectId && projectById[inMonti.projectId] ? `<span class="chip ok">In ${esc(projectById[inMonti.projectId].name)}</span>` : '<span class="chip ok">In Monti</span>') : '<span class="chip">Not in Monti</span>';
    return `<tr data-lib="${x.id}"><td><div class="sname">${esc(x.title)}</div><div class="folder">${esc(short(x.cwd))} · ${x.prompts} prompt${x.prompts === 1 ? '' : 's'}</div>
        ${x.lastPrompt ? `<div class="prompt">Last: ${esc(x.lastPrompt)}</div>` : ''}</td>
      <td class="when" title="${esc(new Date(x.lastAt).toLocaleString())}">${relTime(x.lastAt)}</td><td>${where}</td>
      <td class="act"><div>${inMonti ? '<button class="btn small" data-act="lib-open">Open</button>' : '<button class="btn primary small" data-act="lib-resume">Resume</button><button class="btn small" data-act="lib-attach">Attach…</button>'}</div></td></tr>`;
  });
  return `${banner(state)}
  <div class="head"><div><h1>Session library</h1><div class="meta">Every Claude Code session saved on this Mac, read from <code>~/.claude/projects</code></div></div>
    <div class="actions"><button class="btn" data-act="lib-refresh">Refresh</button></div></div>
  <div class="libbar"><input id="lib-q" placeholder="Search titles and prompts…" value="${esc(L.q || '')}" autocomplete="off">
    <select id="lib-folder"><option value="">All folders</option>${folders.map((f) => `<option value="${esc(f)}" ${f === L.folder ? 'selected' : ''}>${esc(short(f))}</option>`).join('')}</select></div>
  <div class="panel tablewrap">${L.loading ? '<div class="empty">Reading sessions…</div>' : rows.length ? `<table class="streams lib"><tbody>${rows.join('')}</tbody></table>` : '<div class="empty">No sessions match.</div>'}</div>
  <p class="hint" style="margin-top:10px">Titles come from Claude's session title or the first prompt. Resume opens it below with full history, in its original folder. Sessions you resume here but don't attach to a project show up in this view's tabs.</p>`;
}

function renderOverviewHTML(state, ui) {
  if (ui.view.kind === 'library') return libraryView(state, ui);
  const p = ui.view.kind === 'project' && state.projects.find((x) => x.id === ui.view.id);
  if (!p) return welcomeView(state);
  return p.type === 'customer' ? customerView(state, ui, p) : repoView(state, ui, p);
}
