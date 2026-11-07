// Claude account gate. The app never stores credentials: every session uses
// whatever account Claude Code is signed into on this Mac. We only read
// `claude auth status --json` and compare it with this machine's policy.
const { execFile } = require('child_process');
const os = require('os');

const DEFAULT_MACHINE = {
  machineName: os.hostname().replace(/\.local$/, ''),
  role: 'owner', // or 'pull-only'
  firstRunConfirmed: false,
  claudeAccount: {
    // Empty lists mean "no restriction". On an office laptop, lock this to the
    // Enterprise org, e.g. allowedSubscriptions: ["enterprise"], allowedOrgIds: ["..."].
    allowedSubscriptions: [],
    allowedOrgIds: [],
    allowedEmailDomains: [],
  },
};

function readStatus(claudeBin, env) {
  return new Promise((resolve) => {
    if (!claudeBin) return resolve({ loggedIn: false, error: 'Claude Code is not installed or not on PATH.' });
    execFile(claudeBin, ['auth', 'status', '--json'], { env, timeout: 20000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ loggedIn: false, error: err ? err.message : 'Could not read Claude login status.' });
      }
    });
  });
}

function checkPolicy(status, policy) {
  const p = policy || {};
  const subs = p.allowedSubscriptions || [];
  const orgs = p.allowedOrgIds || [];
  const domains = p.allowedEmailDomains || [];
  if (subs.length && !subs.includes(status.subscriptionType)) {
    return `This Mac requires a Claude ${subs.join(' or ')} account. You're signed in with a ${status.subscriptionType || 'different'} account.`;
  }
  if (orgs.length && !orgs.includes(status.orgId)) {
    return `This Mac only allows specific Claude organizations. You're signed in to ${status.orgName || 'a different organization'}.`;
  }
  const domain = (status.email || '').split('@')[1];
  if (domains.length && !domains.includes(domain)) {
    return `This Mac only allows ${domains.map((d) => '@' + d).join(', ')} accounts.`;
  }
  return null;
}

// Returns { state, account, reason } where state is one of:
//   needs-login   not signed in
//   expired       signed in before, but the login has expired
//   needs-confirm first run on this Mac: show who is signed in and ask
//   blocked       signed in with an account this Mac doesn't allow
//   ok
async function evaluate(claudeBin, env, machine) {
  const status = await readStatus(claudeBin, env);
  const account = status.loggedIn
    ? {
        email: status.email,
        orgId: status.orgId,
        orgName: status.orgName,
        subscriptionType: status.subscriptionType,
        authMethod: status.authMethod,
        loginExpiresAt: status.loginExpiresAt,
      }
    : null;
  if (!status.loggedIn) {
    return { state: machine.firstRunConfirmed ? 'expired' : 'needs-login', account, reason: status.error || null };
  }
  if (status.loginExpiresAt && Date.parse(status.loginExpiresAt) <= Date.now()) {
    return { state: 'expired', account, reason: 'Your Claude login has expired.' };
  }
  const violation = checkPolicy(status, machine.claudeAccount);
  if (violation) return { state: 'blocked', account, reason: violation };
  if (!machine.firstRunConfirmed) return { state: 'needs-confirm', account, reason: null };
  return { state: 'ok', account, reason: null };
}

// Output from a running session that suggests the login stopped working.
const AUTH_FAILURE_PATTERN = /(please run \/login|oauth token has expired|invalid api key|authentication_error|not logged in)/i;

module.exports = { DEFAULT_MACHINE, evaluate, AUTH_FAILURE_PATTERN };
