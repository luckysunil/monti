// Storage layer. Everything the app persists goes through a Store, so the
// local-folder implementation can later be swapped for a user-provided one.
//
// Two scopes:
//   machine  ~/.conductor/        per-laptop: account policy, open sessions. Never synced.
//   data     ~/Conductor/         project data (projects/, customers/). Pluggable later.
const fs = require('fs');
const os = require('os');
const path = require('path');

class LocalFolderStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  file(name) {
    return path.join(this.root, name);
  }

  readJSON(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJSON(name, value) {
    const target = this.file(name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, target);
  }
}

function createStores() {
  const home = os.homedir();
  // CONDUCTOR_MACHINE_DIR / CONDUCTOR_DATA_DIR override the locations (used for testing).
  const machine = new LocalFolderStore(process.env.CONDUCTOR_MACHINE_DIR || path.join(home, '.conductor'));
  const data = new LocalFolderStore(process.env.CONDUCTOR_DATA_DIR || path.join(home, 'Conductor'));
  for (const dir of ['projects', 'customers']) fs.mkdirSync(path.join(data.root, dir), { recursive: true });
  return { machine, data };
}

module.exports = { LocalFolderStore, createStores };
