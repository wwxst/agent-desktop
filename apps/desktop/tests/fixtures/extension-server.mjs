import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';

// 真实 stdio 服务同时提供正常响应和可取消的长调用，不替换 SDK 传输层。
const server = new Server({ name: 'extension-test', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Return text and server PID', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'wait', description: 'Wait until cancelled', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'wait') {
    writeFileSync(process.argv[2], 'waiting');
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
  }
  return { content: [{ type: 'text', text: JSON.stringify({ text: request.params.arguments?.text, pid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
