# Monti

Mac desktop app for running parallel Claude Code sessions per project: one overview of every
project and stream, live Claude terminals as tabs, and a Manager that sees across all of them.

## Run

```sh
npm install      # also rebuilds node-pty for Electron
npm start
```

Requires Claude Code (`claude`) on your PATH. On first start Monti asks you to confirm (or sign in
to) the Claude account for this Mac.

## How it fits together

- **Projects**: repo (new or existing folder) or customer (`~/Monti/customers/<name>`).
  Each keeps `AGENTS.md`, `CLAUDE.md` and `.monti/project.json` in its own folder.
- **Streams**: parallel pieces of work. Code streams get a git worktree on `monti/<stream>`.
  Each stream has small tasks with effort (hours) and checkpoints; progress is weighted by effort.
- **Sessions**: real `claude` in embedded terminals. Monti injects hooks (live status) and an MCP
  server (tasks, progress, memory, to-dos) per session. Sessions resume after restarts.
- **Manager**: headless Claude with read and plan tools only. Ask it about any thread, or have it
  break a stream into tasks.
- **Session library**: every saved Claude Code session on the Mac; resume or attach to a project.

## Per-laptop account policy

`~/.monti/machine.json` is created on first run and never synced:

```json
"role": "owner",
"claudeAccount": { "allowedSubscriptions": ["enterprise"], "allowedOrgIds": ["<org id>"] }
```

Tick "Only allow this organization on this Mac" on the first-run screen, or edit the file.
Set the role to `pull-only` from the account panel (click "This Mac" in the sidebar).

See `AGENTS.md` for decisions, current state and gotchas.
