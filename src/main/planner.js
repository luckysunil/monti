// The planner: reads a repo (read-only) and designs how to split the work into
// workstreams that can run in parallel. It maps modules and their dependencies,
// defines the interfaces between them, and gives each stream its own paths and
// tasks. Runs headless `claude -p` with a JSON schema for the result.
const { spawn } = require('child_process');
const { EFFORTS } = require('./projects');

const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });

const PLAN_SCHEMA = {
  type: 'object',
  required: ['summary', 'architecture', 'modules', 'interfaces', 'streams'],
  properties: {
    summary: str('2–4 sentences: what the code is, and how the work splits so streams can run in parallel'),
    architecture: str('Markdown: the modules, how they connect, data flow, and where the seams are'),
    modules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'paths', 'purpose', 'dependsOn'],
        properties: {
          name: str('Module name'),
          paths: strs('Directories or files that make up the module, relative to the repo root'),
          purpose: str('One line'),
          dependsOn: strs('Names of modules this one imports or calls'),
        },
      },
    },
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'kind', 'provider', 'consumers', 'definition', 'location', 'exists'],
        properties: {
          name: str('Interface name'),
          kind: { type: 'string', enum: ['function', 'type', 'http', 'event', 'file', 'cli', 'other'] },
          provider: str('Stream that implements it'),
          consumers: strs('Streams that use it'),
          definition: str('The contract itself: signatures, types, endpoint shapes or schema. Concrete enough to code against.'),
          location: str('File where it lives or should live'),
          exists: { type: 'boolean', description: 'True if it already exists in the code as described' },
        },
      },
    },
    streams: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description', 'tag', 'workspace', 'ownedPaths', 'dependsOn', 'provides', 'consumes', 'tasks'],
        properties: {
          name: str('Short stream name'),
          description: str('One line: what this stream delivers'),
          tag: { type: 'string', enum: ['new', 'existing', 'doc', 'deck', 'other'] },
          workspace: { type: 'string', enum: ['worktree', 'root', 'folder'], description: 'worktree for code streams, root for the interfaces stream, folder for docs or decks' },
          ownedPaths: strs('Paths only this stream changes. Must not overlap with other streams.'),
          dependsOn: strs('Names of streams that must finish first. Only real dependencies.'),
          provides: strs('Interface names this stream implements'),
          consumes: strs('Interface names this stream uses'),
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title', 'effort'],
              properties: {
                title: str('Concrete task'),
                effort: { type: 'number', enum: EFFORTS, description: 'Hours: 1, 2, 3, 5 or 8' },
                checkpoint: str('Optional: what the owner must decide or review'),
              },
            },
          },
        },
      },
    },
  },
};

function plannerPrompt({ name, goal, existing }) {
  return `You are Monti's planner for the project "${name}". Monti runs several Claude Code sessions in parallel, one per workstream, each in its own git worktree. Your job is to read this repository and design the split so those sessions can work independently.

Goal from the owner: ${goal ? goal : 'none given. Work out the natural next work from the code (README, TODOs, open gaps, tests) and plan that.'}

How to work:
1. Explore with Glob, Grep and Read: manifests (package.json, pyproject, go.mod, etc.), entry points, folder layout, and imports between folders. Build a picture of the modules and which depends on which. If the repo is empty or nearly empty, design the module layout for the goal instead.
2. Find the seams: the points where modules meet. Define each as an explicit interface (function signatures, types, HTTP endpoints, event or file schemas) concrete enough that two people could code against it without talking.
3. Split the work into 3–7 streams along those seams:
   - Each stream owns a disjoint set of paths. No two streams own the same file or folder.
   - Streams depend on interfaces, not on each other's internals. Add a dependsOn only when a stream truly needs another one finished (for example end-to-end integration, or docs describing finished behaviour).
   - If needed interfaces don't exist in the code yet, make the first stream "Interfaces & contracts" (workspace "root", small: about a day). It writes the types, stubs and mocks for every interface and commits them. Code streams depend only on it, so they can all start in parallel as soon as it's done.
   - Prefer more parallelism: most streams should depend on nothing, or only on the interfaces stream.
4. Give each stream 3–8 concrete tasks of 1–8 hours, with a checkpoint wherever the owner should decide or review.
5. Tag each stream: "existing" for changing existing code, "new" for new features, "doc" or "deck" for writing. Use workspace "worktree" for code streams and "folder" for docs or decks.
${existing.length ? `\nThe project already has these streams. Reuse a name when your stream is the same piece of work:\n${existing.map((s) => `- ${s.name}: ${s.description || ''}`).join('\n')}\n` : ''}
Do not edit, create or delete any files. Return the plan in the required structure.`;
}

class Planner {
  constructor({ claudeBin, env, onChange }) {
    this.claudeBin = claudeBin;
    this.env = env;
    this.onChange = onChange;
    this.runs = new Map(); // projectId -> { running, steps, error, startedAt, finishedAt, summary, child }
  }

  snapshot() {
    const out = {};
    for (const [id, r] of this.runs) {
      out[id] = { running: r.running, steps: r.steps.slice(-12), stepCount: r.steps.length, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, summary: r.summary };
    }
    return out;
  }

  stop(projectId) {
    const r = this.runs.get(projectId);
    if (r && r.child) {
      try {
        r.child.kill();
      } catch {}
    }
  }

  // Resolves with the plan object, or rejects.
  run({ projectId, root, name, goal, existing, onPlan }) {
    const prev = this.runs.get(projectId);
    if (prev && prev.running) throw new Error('Monti is already planning this project.');
    const run = { running: true, steps: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, summary: null, child: null };
    this.runs.set(projectId, run);
    this.onChange();

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(PLAN_SCHEMA),
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
    const child = spawn(this.claudeBin, args, { cwd: root, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    run.child = child;
    child.stdin.end(plannerPrompt({ name, goal, existing }));

    let buf = '';
    let stderr = '';
    let plan = null;
    let resultText = null;
    const label = (b) => {
      const inp = b.input || {};
      const target = inp.file_path || inp.pattern || inp.path || '';
      const short = String(target).replace(root, '').replace(/^\//, '');
      return `${{ Read: 'Read', Glob: 'Listed', Grep: 'Searched' }[b.name] || b.name}${short ? ` ${short.slice(0, 80)}` : ''}`;
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) if (b.type === 'tool_use' && b.name !== 'StructuredOutput') run.steps.push(label(b));
          this.onChange();
        } else if (ev.type === 'result') {
          if (ev.structured_output) plan = ev.structured_output;
          resultText = ev.result;
          if (ev.is_error) run.error = String(ev.result || 'The planner hit an error.');
        }
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    return new Promise((resolve, reject) => {
      child.on('close', async (code) => {
        run.child = null;
        if (!plan && resultText) {
          try {
            const m = String(resultText).match(/\{[\s\S]*\}/);
            if (m) plan = JSON.parse(m[0]);
          } catch {}
        }
        if (!plan || !Array.isArray(plan.streams)) {
          run.error = run.error || (code ? `Planning stopped (${stderr.trim().split('\n').pop() || `exit ${code}`}).` : 'The planner did not return a plan.');
          run.running = false;
          run.finishedAt = new Date().toISOString();
          this.onChange();
          return reject(new Error(run.error));
        }
        try {
          if (onPlan) await onPlan(plan);
          run.summary = plan.summary;
        } catch (e) {
          run.error = e.message;
        }
        run.running = false;
        run.finishedAt = new Date().toISOString();
        this.onChange();
        return run.error ? reject(new Error(run.error)) : resolve(plan);
      });
      child.on('error', (e) => {
        run.running = false;
        run.error = e.message;
        this.onChange();
        reject(e);
      });
    });
  }
}

module.exports = { Planner, PLAN_SCHEMA };
