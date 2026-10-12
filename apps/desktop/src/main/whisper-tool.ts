import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { SessionEvent } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { isInsideDirectory, readVideoDeliveryFacts } from '@agent-desktop/video-agent';

export const WHISPER_TOOLS = new Set(['transcribe_audio']);
export const MEDIA_TOOL_NAMES = new Set(['transcribe_audio']);

export interface WhisperFileAccess {
  readonly workspace: Pick<WorkspacePort, 'confirmedDirectory'>;
  readonly attachments: () => readonly string[];
  readonly events: () => readonly SessionEvent[];
}

function requireLocalPath(path: string): void {
  if (/^[\\/]{2}/.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) {
    throw new Error('transcribe_audio 只允许本地文件，不允许网络路径或 URL。');
  }
  if (process.platform === 'win32' && path.slice(2).includes(':')) throw new Error('transcribe_audio 不接受 Windows 备用数据流路径。');
}

async function authorizedSource(path: string, access: WhisperFileAccess): Promise<boolean> {
  requireLocalPath(path);
  const canonical = await realpath(path);
  const directory = access.workspace.confirmedDirectory();
  if (directory !== undefined && await isInsideDirectory(canonical, directory)) return true;
  for (const attachment of access.attachments()) {
    requireLocalPath(attachment);
    try { if (canonical === await realpath(attachment)) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}

async function authorizeAudio(input: unknown, access: WhisperFileAccess): Promise<string> {
  if (typeof input !== 'object' || input === null || !('audioPath' in input)
    || typeof input.audioPath !== 'string' || input.audioPath.trim() === '') throw new Error('transcribe_audio 需要非空 audioPath。');
  requireLocalPath(input.audioPath);
  const directory = access.workspace.confirmedDirectory();
  if (!isAbsolute(input.audioPath) && directory === undefined) throw new Error('相对路径需要先确认工作目录。');
  const path = isAbsolute(input.audioPath) ? resolve(input.audioPath) : resolve(directory!, input.audioPath);
  const canonical = await realpath(path);
  requireLocalPath(canonical);
  if (!(await stat(canonical)).isFile()) throw new Error('transcribe_audio 输入必须是本地文件。');
  if (await authorizedSource(path, access)) return canonical;
  // 语义验收产生的 WAV 保存在已声明输出项工作目录，允许这一个已授权的派生目录。
  for (const item of readVideoDeliveryFacts(access.events()).items) {
    if (!await isInsideDirectory(canonical, item.workingDirectory)) continue;
    for (const source of item.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('语音候选来源未经宿主授权。');
    return canonical;
  }
  throw new Error(`transcribe_audio 输入超出已授权工作目录及附件范围（${dirname(canonical)}）。`);
}

function convert(result: ToolResult): ToolResult {
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  if (result.status === 'error') {
    const message = raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).filter(Boolean).join('\n');
    return { status: 'error', message: message || result.message };
  }
  const data = raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
  if (typeof data !== 'object' || data === null) throw new Error('Whisper 插件结果不是转录对象。');
  const value = data as Record<string, unknown>;
  if (typeof value.text !== 'string' || !Array.isArray(value.segments)) throw new Error('Whisper 插件结果缺少 text 或 segments。');
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
export function adaptWhisperTool(tool: Tool, access: WhisperFileAccess | undefined): Tool {
  return { name: 'transcribe_audio', description: tool.description, inputSchema: tool.inputSchema,
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        context.signal?.throwIfAborted();
        if (access === undefined) throw new Error('transcribe_audio 缺少宿主文件授权。');
        const audioPath = await authorizeAudio(input, access);
        const result = await tool.execute({ audioPath }, context);
        context.signal?.throwIfAborted();
        return convert(result);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return { status: 'error', message: error.message };
      }
    },
  };
}
