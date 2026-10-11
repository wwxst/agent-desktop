import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProbeMediaTool, DecodeVideoTool, DetectBlackSegmentsTool, ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool, ExtractAudioTool, ExtractFullVideoFramesTool, executeFileCommand,
  type CommandExecutor } from '@agent-desktop/video-ffmpeg';

// 服务只适配传输和明确的可执行程序路径；媒体参数、解析和错误契约复用原工具。
const execute: CommandExecutor = async (command, args, signal) => {
  const key = command === 'ffprobe' ? 'FFPROBE_PATH' : 'FFMPEG_PATH';
  const executable = process.env[key];
  if (executable === undefined || !isAbsolute(executable) || /^[\\/]{2}/.test(executable)) throw new Error(`请配置本地绝对路径 ${key}。`);
  if (!(await stat(executable)).isFile()) throw new Error(`${key} 必须指向本地可执行文件。`);
  // 本地容器也可能引用外部协议；限制为普通媒体容器和 file，拒绝播放列表与网络子资源。
  const limits = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,mp3,wav,flac,ogg,mpeg,mpegts,aac'];
  const restricted = command === 'ffprobe' ? [...limits, ...args] : args.flatMap(arg => arg === '-i' ? [...limits, arg] : [arg]);
  return executeFileCommand(executable, restricted, signal);
};
const tools = [new ProbeMediaTool(execute), new DecodeVideoTool(execute), new DetectBlackSegmentsTool(execute),
  new ExtractVideoFramesTool(execute), new ExtractVideoRangeFramesTool(execute), new ExtractAudioTool(execute), new ExtractFullVideoFramesTool(execute)];
const server = new Server({ name: 'ffmpeg-probe', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
  name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
})) }));
server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  const tool = tools.find(tool => tool.name === request.params.name);
  if (tool === undefined) throw new Error('未知的 FFmpeg 工具。');
  const input = request.params.arguments;
  // 服务不会作为任意 URL 或命令入口；宿主已完成授权，这里只接受绝对本地文件。
  const paths = Object.entries(input ?? {}).filter(([key]) => ['inputPath', 'videoPath', 'outputPath', 'outputDir'].includes(key));
  if (paths.some(([, path]) => typeof path !== 'string' || !isAbsolute(path)
    || /^(?:[a-z][a-z0-9+.-]*:)(?![\\/])/i.test(path) || /^[\\/]{2}/.test(path))) {
    return { isError: true, content: [{ type: 'text', text: 'FFmpeg 只接受已授权的本地绝对路径。' }] };
  }
  const result = await tool.execute(input, { signal: context.signal, toolCallId: context.requestId as never, reportProgress: () => {} });
  return result.status === 'error'
    ? { isError: true, content: [{ type: 'text', text: result.message }] }
    : { structuredContent: tool.name === 'probe_media' ? result.output as Record<string, unknown> : { toolResult: result },
      content: [{ type: 'text', text: JSON.stringify(tool.name === 'probe_media' ? result.output : { toolResult: result }) }] };
});
// stdio 关闭或取消均会关闭 SDK 并通知在执行的请求；ffprobe 继续使用原工具的取消信号。
process.stdin.once('end', () => { void server.close(); });
void server.connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 1; });
