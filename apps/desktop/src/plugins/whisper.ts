import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { setInterval } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TranscribeAudioTool } from '@agent-desktop/speech-whisper-cpp';

function localPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /^[\\/]{2}/.test(value)
    || /^(?:[a-z][a-z0-9+.-]*:)(?![\\/])/i.test(value)) throw new Error(`${label} 必须是本地绝对路径。`);
  return value;
}

async function configuredFile(name: 'WHISPER_CLI_PATH' | 'WHISPER_MODEL_PATH'): Promise<string> {
  const path = localPath(process.env[name], name);
  if (!(await stat(path)).isFile()) throw new Error(`${name} 必须指向本地文件。`);
  return path;
}

async function main(): Promise<void> {
  const executable = await configuredFile('WHISPER_CLI_PATH');
  const model = await configuredFile('WHISPER_MODEL_PATH');
  const tool = new TranscribeAudioTool({ modelPath: model, command: executable });
  const server = new Server({ name: 'whisper', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const input = request.params.arguments;
    if (typeof input?.audioPath !== 'string' || !isAbsolute(input.audioPath)
      || /^[\\/]{2}/.test(input.audioPath) || /^(?:[a-z][a-z0-9+.-]*:)(?![\\/])/i.test(input.audioPath)) {
      return { isError: true, content: [{ type: 'text', text: 'transcribe_audio 只接受宿主授权的本地绝对 WAV 路径。' }] };
    }
    const stop = new AbortController();
    const signal = AbortSignal.any([context.signal, stop.signal]);
    const started = Date.now();
    const token = request.params._meta?.progressToken;
    // SDK 默认等待 60 秒；报告实际运行秒数，让长任务保持连接，不伪造完成百分比。
    const progress = (async () => {
      if (token === undefined) return;
      try {
        for await (const _ of setInterval(10_000, undefined, { signal })) {
          await context.sendNotification({ method: 'notifications/progress', params: {
            progressToken: token, progress: (Date.now() - started) / 1000, message: 'Whisper 正在本地识别。',
          } });
        }
      } catch (error) { if (!signal.aborted) throw error; }
    })();
    const executing = tool.execute(input, { signal, toolCallId: context.requestId as never, reportProgress: () => {} });
    try {
      const result = await Promise.race([executing, progress.then(() => executing)]);
      return result.status === 'error'
        ? { isError: true, content: [{ type: 'text', text: result.message }] }
        : { structuredContent: result.output as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(result.output) }] };
    } finally {
      stop.abort();
      // 通知失败或连接关闭也必须等语音进程和工具临时目录收尾。
      await Promise.allSettled([executing, progress]);
    }
  });

  process.stdin.once('end', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
