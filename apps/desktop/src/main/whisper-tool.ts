import { ToolExecutionError, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { SessionPersistenceError } from '@agent-desktop/session';
import type { ToolResult } from '@agent-desktop/model';
import { authorizeMediaInput, type ProbeFileAccess } from './ffmpeg-tool.js';
export type { ProbeFileAccess as WhisperFileAccess } from './ffmpeg-tool.js';

export const WHISPER_TOOLS = new Set(['transcribe_audio']);

function convert(result: ToolResult): ToolResult {
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  if (result.status === 'error') {
    const message = raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).filter(Boolean).join('\n');
    return { ...result, message: message || result.message };
  }
  const data = raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
  if (typeof data !== 'object' || data === null) throw new Error('Whisper 插件结果不是转录对象。');
  const value = data as Record<string, unknown>;
  if (typeof value.text !== 'string' || !value.text.trim() || !Array.isArray(value.segments) || value.segments.length === 0) throw new Error('Whisper 插件结果缺少非空 text 或 segments。');
  let previousEnd = 0;
  const segments = value.segments.map((segment, index) => {
    if (typeof segment !== 'object' || segment === null) throw new Error(`Whisper 插件段落 ${index} 无效。`);
    const entry = segment as Record<string, unknown>;
    if (typeof entry.start !== 'number' || !Number.isFinite(entry.start) || typeof entry.end !== 'number'
      || !Number.isFinite(entry.end) || entry.start < 0 || entry.end < entry.start || entry.start < previousEnd
      || typeof entry.text !== 'string') throw new Error(`Whisper 插件段落 ${index} 时间轴无效。`);
    previousEnd = entry.end;
    return { start: entry.start, end: entry.end, text: entry.text };
  });
  return { status: 'success', output: { text: value.text, segments } };
}

/** MCP 只能接触宿主先解析并授权的音频路径；语义验收复用这个适配器。 */
export function adaptWhisperTool(tool: Tool, access: ProbeFileAccess | undefined): Tool {
  return { name: 'transcribe_audio', description: tool.description, inputSchema: tool.inputSchema,
    executionBoundary: tool.executionBoundary ?? 'opaque',
    contract: { capability: 'media', riskLevel: 'external', parallelSafety: 'serial', timeoutMs: 120_000,
      cancellation: 'signal', workspaceScope: 'session', approvalRequirement: 'policy' },
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      let invoked = false;
      try {
        context.signal?.throwIfAborted();
        if (access === undefined) throw new Error('transcribe_audio 缺少宿主文件授权。');
        if (typeof input !== 'object' || input === null || !('audioPath' in input) || typeof input.audioPath !== 'string'
          || !input.audioPath.toLowerCase().endsWith('.wav')) throw new Error('transcribe_audio 需要本地 WAV audioPath。');
        const audioPath = await authorizeMediaInput({ inputPath: input.audioPath }, access, true);
        invoked = true;
        const result = await tool.execute({ audioPath }, context);
        context.signal?.throwIfAborted();
        return convert(result);
      } catch (error) {
        if (error instanceof SessionPersistenceError) throw error;
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        // 请求后的转录损坏不能证明服务未执行；审批拒绝等已知分类由原工具保留。
        return { status: 'error', message: error.message,
          failureKind: error instanceof ToolExecutionError ? error.failureKind : invoked ? 'unknown-outcome' : 'permanent' };
      }
    },
  };
}
