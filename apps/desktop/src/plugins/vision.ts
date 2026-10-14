import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';

/** 密钥仅由受控宿主注入进程环境，不放入清单、启动参数或协议消息。 */
async function main(): Promise<void> {
  const protocol = process.env.VISION_PROTOCOL;
  if (protocol !== 'responses' && protocol !== 'chat-completions') throw new Error('Vision API 协议无效。');
  const maxOutputTokens = process.env.VISION_MAX_OUTPUT_TOKENS === undefined ? undefined : Number(process.env.VISION_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)) throw new Error('Vision 输出预算无效。');
  const tool = new AnalyzeImagesTool({ apiKey: process.env.VISION_API_KEY ?? '',
    ...(process.env.VISION_BASE_URL === undefined ? {} : { baseUrl: process.env.VISION_BASE_URL }),
    ...(process.env.VISION_MODEL === undefined ? {} : { model: process.env.VISION_MODEL }), protocol,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
  // 降低凭证在环境中的留存；Tool 实例只在当前 MCP 进程生命周期内持有它。
  delete process.env.VISION_API_KEY;
  const server = new Server({ name: 'vision', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: tool.name,
    description: tool.description, inputSchema: tool.inputSchema }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const input = request.params.arguments;
    if (!Array.isArray(input?.images) || !input.images.every(image => typeof image === 'object' && image !== null
      && 'path' in image && typeof image.path === 'string' && isAbsolute(image.path) && !/^[\\/]{2}/.test(image.path))) {
      return { isError: true, content: [{ type: 'text', text: 'Vision 只接受宿主授权的本地绝对图片路径。' }] };
    }
    const result = await tool.execute(input, { signal: context.signal, toolCallId: context.requestId as never, reportProgress: () => {} });
    return result.status === 'error' ? { isError: true, content: [{ type: 'text', text: result.message }] }
      : { structuredContent: result.output as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(result.output) }] };
  });
  process.stdin.once('end', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}

// 不打印 API 响应、图片或配置；启动异常只包含本地配置校验信息。
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Vision 启动失败。'); process.exitCode = 1; });
