// Resolves the user's login-shell environment and the `claude` binary.
// Apps launched from Finder get a minimal PATH, so we ask the shell once.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cached = null;

function readLoginEnv() {
  const shell = process.env.SHELL || '/bin/zsh';
  const env = { ...process.env };
  try {
    const out = execFileSync(shell, ['-ilc', "printf '__CONDUCTOR_ENV__'; env -0"], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const body = out.slice(out.indexOf('__CONDUCTOR_ENV__') + '__CONDUCTOR_ENV__'.length);
    for (const entry of body.split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch {
    // Fall back to the process environment.
  }
  // If Conductor itself was launched from inside a Claude Code session, drop the
  // per-session markers so child sessions are independent and save transcripts.
  for (const key of [
    'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  ]) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function findClaude(env) {
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function shellEnv() {
  if (!cached) {
    const env = readLoginEnv();
    cached = { env, claudeBin: findClaude(env) };
  }
  return cached;
}

module.exports = { shellEnv };
