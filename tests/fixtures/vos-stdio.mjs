// Minimal stdio MCP used only by the disposable VOS image smoke test.
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'vos-validation', version: '1.0.0' },
  };
  if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Validation echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.arguments.text }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
