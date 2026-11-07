# Conductor

Mac desktop app for running parallel Claude Code sessions per project, with one overview.

## Run

```sh
npm install      # also rebuilds node-pty for Electron
npm start
```

Requires Claude Code (`claude`) installed and on your PATH. On first start the app asks you to
confirm (or sign in to) the Claude account for this Mac.

## Per-laptop account policy

`~/.conductor/machine.json` is created on first run and never synced. To restrict an office laptop
to the Enterprise account, set for example:

```json
"claudeAccount": { "allowedSubscriptions": ["enterprise"], "allowedOrgIds": ["<org id>"] }
```

or tick "Only allow this organization on this Mac" on the first-run screen.

See `AGENTS.md` for background, decisions and next steps.
