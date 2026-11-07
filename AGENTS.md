# Conductor — project memory

Read this first. It is the handoff file for any AI tool or person picking up the project.

## Background

The owner works with Claude on several projects at once and gets blocked waiting on one session.
Conductor is a Mac desktop app that runs many Claude Code sessions side by side, grouped by project,
with one overview of where everything stands.

## Goals

- One window: project overview on top, live Claude Code sessions as tabs below.
- Projects of different types: GitHub repo (new or existing) first, customer (to-do list) next, email later.
- A Manager Claude that reads every session, answers questions about any thread, and breaks work
  into small tasks with effort estimates and human checkpoints. Progress is weighted by effort.
- A session library that finds all past Claude Code sessions on the Mac and can resume them in the app.

## Key decisions

- **Electron, Mac only.** Embedded terminals use xterm.js + node-pty and run the real `claude` CLI.
- **Local-first.** Development starts with local git only. A GitHub repo is created later, only after
  the initial work is verified and the owner approves it.
- **No stored credentials.** Every session (terminals and, later, the Manager via headless `claude -p`)
  uses whatever account Claude Code is signed into on that Mac.
- **Per-laptop account policy** in `~/.conductor/machine.json` (never synced). The app checks
  `claude auth status --json` against it before any session starts. The office laptop must only use
  the Enterprise Claude account.
- **Login UX:** ask on first start; re-check every 2 minutes and when a session prints an auth error;
  on expiry show a re-auth screen. Sessions are paused, not lost.
- **Resume:** each session gets a Claude session ID up front (`--session-id`). On restart, or after
  Claude exits, it reopens with `--resume <id>`. Claude only writes a transcript after the first message.
- **Storage is pluggable.** All persistence goes through `src/main/store.js`. Today: `~/.conductor/`
  (machine) and `~/Conductor/` (project data). The owner will supply a storage layer later.
- **Pull-only laptops** can open a project and start new sessions from its memory, but changes stay local.
- **Each project carries its own memory** (`AGENTS.md` + `.conductor/`) so it travels with the folder.

## Current state

Milestone 1 done (2026-11-07):
- Electron shell, sessions list, live embedded Claude Code terminal per session.
- Account gate: first-run confirm (with optional "lock this Mac to this org"), sign in (normal or SSO),
  blocked state for disallowed accounts, expiry state.
- Sessions persist in `~/.conductor/sessions.json` and resume with full history after restart.

Mockup of the target UI: https://claude.ai/artifact/2jd3ZXUf2J25euNv1uyf9J

## Next steps

1. Session library: scan `~/.claude/projects/*/*.jsonl`, list by folder, resume or attach to a project.
2. Projects: repo project type, streams, one worktree per code stream.
3. Status hooks: "needs you" / "done" badges from Claude Code hooks.
4. Local MCP server for progress and tasks; overview panel.
5. Manager panel.
6. Customer projects with to-dos.

## Gotchas

- node-pty must be rebuilt for Electron: `npm run rebuild`. `spawn-helper` must be executable.
- Apps launched from Finder get a minimal PATH; `shell-env.js` reads the login shell env once.
- If Conductor is started from inside a Claude Code session, the inherited `CLAUDE_CODE_*` markers
  turn off transcript saving in child sessions. `shell-env.js` strips them.
- Dev aids: `CONDUCTOR_MACHINE_DIR`, `CONDUCTOR_DATA_DIR` (test profiles), `CONDUCTOR_SCREENSHOT=<png>`.
