# Monti — project memory

Read this first. It is the handoff file for any AI tool or person picking up the project.

## Background

The owner works with Claude on several projects at once and gets blocked waiting on one session.
Monti is a Mac desktop app that runs many Claude Code sessions side by side, grouped by project and
stream, with one overview of where everything stands and a Manager Claude that sees across all of it.

## Goals

- One window: project overview on top, live Claude Code sessions as tabs below, Manager on the right.
- Project types: repo (new or existing), customer (to-dos + workstreams); email later.
- Streams of work that run in parallel, each with small tasks, effort estimates and human checkpoints.
  Progress is weighted by effort.
- A Session library of every past Claude Code session on the Mac, resumable inside the app.

## Key decisions

- **Electron, Mac only, plain JS (no bundler).** Terminals use xterm.js + node-pty running the real `claude` CLI.
- **Local-first.** Local git only. A GitHub repo comes later, only after the owner verifies the work
  and approves it; the Manager may suggest it but never creates one.
- **No stored credentials.** Terminals and the Manager (headless `claude -p`) use whatever account
  Claude Code is signed into on that Mac.
- **Per-laptop account policy** in `~/.monti/machine.json` (never synced), checked against
  `claude auth status --json` before any session starts. The office laptop must only use Enterprise.
- **Login UX:** ask on first start; re-check every 2 minutes and when a session prints an auth error;
  on expiry show a re-auth screen. Sessions are paused, not lost.
- **Resume:** every session gets its Claude session ID up front (`--session-id`) and reopens with
  `--resume <id>`. Claude only writes a transcript after the first message.
- **Project data travels with the folder:** `AGENTS.md` (memory), `CLAUDE.md` (`@AGENTS.md`),
  `.monti/project.json` (streams, tasks, to-dos, activity), `.monti/handoffs/`.
  Machine-only data lives in `~/.monti/` (machine.json, projects.json, sessions.json, manager.json).
  Customer projects live in `~/Monti/customers/<name>/`. Storage goes through `store.js` / `projects.js`
  so the owner's storage layer can replace it.
- **Code streams get a git worktree** on branch `monti/<stream>` in `<repo>-streams/<stream>/`.
- **Live status comes from Claude Code hooks** injected per session with `--settings` (curl to the local
  server): UserPromptSubmit/PostToolUse = working, Notification about permission = needs you, Stop = idle.
- **Progress/tasks come from a local MCP server** injected with `--mcp-config` (HTTP, bearer token,
  127.0.0.1, random port). Stream sessions get task/memory/to-do tools; the Manager gets read and plan tools
  only (`--tools Read,Glob,Grep`, `--strict-mcp-config`, `--permission-mode dontAsk`).
- **Pull-only Macs** (role in machine.json) see a banner and can't integrate branches.

## Current state

Milestone 2 (2026-11-07): the full mockup is implemented.
- Projects rail (repos, customers, library, email placeholder), welcome screen, new project / stream modals.
- Repo overview: effort-weighted progress, new vs existing, needs-you count, streams table, task list
  with effort editing, approve / answer (typed into the stream's session), checkpoints, activity, memory.
- Customer overview: to-dos with due dates, workstreams with tasks, activity, memory.
- Dock: one tab per session with live status dots; output is buffered for unseen tabs; resizable.
- Session library: search, folder filter, resume, attach to project/stream.
- Manager panel: chat over headless Claude with Monti tools, suggestions, stop, new conversation.
- Integrate branches: opens an integrator session with a merge prompt (no push).
- Desktop notification when a session needs you and the window isn't focused.

Mockup of the target UI: https://claude.ai/artifact/2jd3ZXUf2J25euNv1uyf9J

## Next steps

1. Owner tests and verifies; collect fixes.
2. Email project type.
3. Output preview panel (docs, decks) inside the app.
4. Packaging as a signed .dmg for the other laptops.
5. When verified: Manager asks whether to create a private GitHub repo.

## Gotchas

- node-pty must be rebuilt for Electron (`npm run rebuild`); `spawn-helper` must be executable.
- Apps launched from Finder get a minimal PATH; `shell-env.js` reads the login shell env once.
- Started from inside a Claude Code session, inherited `CLAUDE_CODE_*` markers turn off transcript
  saving in child sessions; `shell-env.js` strips them.
- `--allowedTools` and `--mcp-config` are variadic: the argument right before a positional prompt must be
  a single-value flag (`--settings` / `--append-system-prompt`). The Manager sends its prompt on stdin.
- `--append-system-prompt` is recorded on the first request and reused on resume, so the stream brief is
  only passed for new sessions.
- Dev aids: `MONTI_MACHINE_DIR`, `MONTI_DATA_DIR` (test profiles), `MONTI_SCREENSHOT=<png>`.
