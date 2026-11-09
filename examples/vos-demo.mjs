// Offline MCP example bundled with the VOS image. Run: node /app/examples/vos-demo.mjs
import { McpServer } from '@modelcontextprotocol/sdk-v1/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk-v1/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'vos-demo', version: '1.0.0' });
server.registerTool('add', {
  description: 'Add two numbers locally without network access.',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('echo', {
  description: 'Return the supplied message unchanged.',
  inputSchema: { message: z.string().max(4096) },
}, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
server.registerResource('status', 'demo://status', {
  description: 'Read the demo server status.',
  mimeType: 'application/json',
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
  text: JSON.stringify({ server: 'vos-demo', status: 'ready' }) }] }));
server.registerPrompt('explain-sum', {
  description: 'Create a prompt asking the client model to explain an addition.',
  argsSchema: { a: z.string(), b: z.string() },
}, async ({ a, b }) => ({ messages: [{ role: 'user', content: {
  type: 'text', text: `Use the add tool to calculate ${a} + ${b}, then explain the result.`,
} }] }));
await server.connect(new StdioServerTransport());
