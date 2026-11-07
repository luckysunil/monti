// Reads Claude Code's saved sessions (~/.claude/projects/<folder>/<id>.jsonl).
// Used by the Session library and by the Manager to read what a thread did.
const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 512 * 1024;
const cache = new Map(); // file -> { key, info }

function readSlices(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return [buf.toString('utf8')];
    }
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return [head.toString('utf8'), tail.toString('utf8')];
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Text the person actually typed, without injected context blocks.
function userText(rec) {
  if (!rec || rec.type !== 'user' || !rec.message || rec.isMeta) return null;
  const c = rec.message.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
  const text = parts
    .join('\n')
    .replace(/<([a-z_-]+)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<system-reminder>[\s\S]*/gi, '')
    .trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return null;
  return text;
}

function sessionInfo(file) {
  const stat = fs.statSync(file);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.info;
  let cwd = null;
  let customTitle = null;
  let aiTitle = null;
  let firstPrompt = null;
  let lastPrompt = null;
  let prompts = 0;
  for (const slice of readSlices(file, stat.size)) {
    for (const rec of parseLines(slice)) {
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
      if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
      const t = userText(rec);
      if (t) {
        prompts += 1;
        if (!firstPrompt) firstPrompt = t;
        lastPrompt = t;
      }
    }
  }
  const info = {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: customTitle || aiTitle || (firstPrompt ? firstPrompt.split('\n')[0].slice(0, 90) : 'Untitled session'),
    firstPrompt: firstPrompt ? firstPrompt.slice(0, 300) : null,
    lastPrompt: lastPrompt ? lastPrompt.slice(0, 300) : null,
    prompts,
    sizeKB: Math.round(stat.size / 1024),
    lastAt: new Date(stat.mtimeMs).toISOString(),
  };
  cache.set(file, { key, info });
  return info;
}

function scanLibrary(projectsDir) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const info = sessionInfo(path.join(dir, f));
        if (info.prompts > 0 && info.cwd && info.title !== 'Monti Manager') out.push(info);
      } catch {}
    }
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function findTranscript(projectsDir, id) {
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, d, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

// Condensed, readable transcript: what the person asked, what Claude said,
// and which tools it used. Returns the most recent `maxChars`.
function readTranscript(projectsDir, id, maxChars = 24000) {
  const file = findTranscript(projectsDir, id);
  if (!file) return null;
  const stat = fs.statSync(file);
  const text = stat.size > 8 * 1024 * 1024 ? readSlices(file, stat.size).pop() : fs.readFileSync(file, 'utf8');
  const lines = [];
  for (const rec of parseLines(text)) {
    if (rec.isSidechain) continue;
    const u = userText(rec);
    if (u) {
      lines.push(`\n[person] ${u.slice(0, 1500)}`);
      continue;
    }
    if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b.type === 'text' && b.text.trim()) lines.push(`[claude] ${b.text.trim().slice(0, 2000)}`);
        if (b.type === 'tool_use') {
          const inp = b.input || {};
          const hint = inp.file_path || inp.command || inp.pattern || inp.description || '';
          lines.push(`  · ${b.name}${hint ? `: ${String(hint).slice(0, 160)}` : ''}`);
        }
      }
    }
  }
  const all = lines.join('\n');
  return all.length > maxChars ? `…(earlier part trimmed)\n${all.slice(-maxChars)}` : all;
}

module.exports = { scanLibrary, readTranscript, findTranscript };
