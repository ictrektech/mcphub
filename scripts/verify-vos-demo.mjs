import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk-v1/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk-v1/client/stdio.js';

const client = new Client({ name: 'vos-demo-verifier', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['examples/vos-demo.mjs'], stderr: 'inherit' }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add', 'echo']);
  assert.equal((await client.callTool({ name: 'add', arguments: { a: 7, b: 5 } })).content[0].text, '12');
  assert.equal((await client.callTool({ name: 'echo', arguments: { message: 'hello MCP' } })).content[0].text, 'hello MCP');
  assert.equal((await client.listResources()).resources[0].uri, 'demo://status');
  assert.equal(JSON.parse((await client.readResource({ uri: 'demo://status' })).contents[0].text).status, 'ready');
  assert.equal((await client.listPrompts()).prompts[0].name, 'explain-sum');
  assert.match((await client.getPrompt({ name: 'explain-sum', arguments: { a: '7', b: '5' } })).messages[0].content.text, /7 \+ 5/);
  console.log('PASS: bundled MCP demo tools, resource and prompt through the official MCP client');
} finally {
  await client.close();
}
