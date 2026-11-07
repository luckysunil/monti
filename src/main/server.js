// Local HTTP server (127.0.0.1 only, random port, bearer token) that sessions talk to:
//   POST /hook/<Event>   Claude Code hooks (needs-you / working / finished badges)
//   POST /mcp/<scope>    a minimal MCP server (JSON-RPC over streamable HTTP, JSON responses)
// <scope> is "s-<sessionId>" for a stream session or "manager" for the Manager.
const crypto = require('crypto');
const http = require('http');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function startServer({ onHook, toolsFor }) {
  const token = crypto.randomBytes(24).toString('hex');

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size < 4 * 1024 * 1024) chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  async function handleRpc(scope, msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'monti', version: '0.2.0' },
        instructions: 'Monti tracks this project: streams, tasks with effort, checkpoints for the owner, to-dos and project memory.',
      });
    }
    if (method === 'ping') return reply({});
    const tools = toolsFor(scope);
    if (!tools) return fail(-32001, 'Unknown session. Restart it from Monti.');
    if (method === 'tools/list') {
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === (params && params.name));
      if (!tool) return fail(-32602, `Unknown tool ${params && params.name}`);
      try {
        const out = await tool.handler((params && params.arguments) || {});
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    return fail(-32601, `Method not found: ${method}`);
  }

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` && new URL(req.url, 'http://x').searchParams.get('t') !== token) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'hook' && req.method === 'POST') {
        const body = await readBody(req);
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {}
        onHook(parts[1], payload);
        return json(res, 200, {});
      }
      if (parts[0] === 'mcp') {
        if (req.method === 'GET') return json(res, 405, { error: 'SSE not supported' });
        if (req.method === 'DELETE') return json(res, 200, {});
        const body = await readBody(req);
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const scope = parts[1] || '';
        if (Array.isArray(msg)) {
          const out = (await Promise.all(msg.map((m) => handleRpc(scope, m)))).filter(Boolean);
          return out.length ? json(res, 200, out) : json(res, 202);
        }
        const out = await handleRpc(scope, msg);
        return out ? json(res, 200, out) : json(res, 202);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, token, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

module.exports = { startServer };
