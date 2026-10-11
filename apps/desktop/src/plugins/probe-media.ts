import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProbeMediaTool, executeFileCommand } from '@agent-desktop/video-ffmpeg';

// 服务只适配传输和明确的可执行程序路径；媒体参数、解析和错误契约复用原工具。
const probe = new ProbeMediaTool(async (_command, args, signal) => {
  const executable = process.env.FFPROBE_PATH;
  if (executable === undefined || !isAbsolute(executable) || /^[\\/]{2}/.test(executable)) throw new Error('请配置本地绝对路径 FFPROBE_PATH。');
  if (!(await stat(executable)).isFile()) throw new Error('FFPROBE_PATH 必须指向本地可执行文件。');
  // 本地容器也可能引用外部协议；限制为普通媒体容器和 file，拒绝播放列表与网络子资源。
  return executeFileCommand(executable, ['-protocol_whitelist', 'file',
    '-format_whitelist', 'mov,matroska,webm,avi,mp3,wav,flac,ogg,mpeg,mpegts,aac', ...args], signal);
});
const server = new Server({ name: 'ffmpeg-probe', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: probe.name, description: probe.description, inputSchema: probe.inputSchema,
}] }));
server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  if (request.params.name !== probe.name) throw new Error('未知的媒体探测工具。');
  const input = request.params.arguments;
  // 服务不会作为任意 URL 或命令入口；宿主已完成授权，这里只接受绝对本地文件。
  if (typeof input?.inputPath !== 'string' || !isAbsolute(input.inputPath)
    || /^(?:[a-z][a-z0-9+.-]*:)(?![\\/])/i.test(input.inputPath) || /^[\\/]{2}/.test(input.inputPath)) {
    return { isError: true, content: [{ type: 'text', text: 'probe_media 只接受已授权的本地绝对路径。' }] };
  }
  const result = await probe.execute(input, { signal: context.signal, toolCallId: context.requestId as never, reportProgress: () => {} });
  return result.status === 'error'
    ? { isError: true, content: [{ type: 'text', text: result.message }] }
    : { structuredContent: result.output as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(result.output) }] };
});
// stdio 关闭或取消均会关闭 SDK 并通知在执行的请求；ffprobe 继续使用原工具的取消信号。
process.stdin.once('end', () => { void server.close(); });
void server.connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 1; });
