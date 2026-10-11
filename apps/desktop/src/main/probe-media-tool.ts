import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { SessionEvent } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { isInsideDirectory, producedVideoItem } from '@agent-desktop/video-agent';

/** 授权只取宿主事实；模型声明的目标和 MCP 审批都不能代替目录或附件授权。 */
export interface ProbeFileAccess {
  readonly workspace: Pick<WorkspacePort, 'confirmedDirectory'>;
  readonly attachments: () => readonly string[];
  readonly events: () => readonly SessionEvent[];
}

function requireLocalPath(path: string): void {
  if (/^[\\/]{2}/.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) {
    throw new Error('probe_media 只允许本地文件，不允许网络路径或 URL。');
  }
}

async function authorizedSource(path: string, access: ProbeFileAccess): Promise<boolean> {
  requireLocalPath(path);
  const canonical = await realpath(path);
  requireLocalPath(canonical);
  const directory = access.workspace.confirmedDirectory();
  if (directory !== undefined && await isInsideDirectory(canonical, directory)) return true;
  for (const attachment of access.attachments()) {
    requireLocalPath(attachment);
    if (canonical === await realpath(attachment)) return true;
  }
  return false;
}

async function authorize(input: unknown, access: ProbeFileAccess | undefined): Promise<string> {
  if (typeof input !== 'object' || input === null || !('inputPath' in input)
    || typeof input.inputPath !== 'string' || input.inputPath.trim() === '') throw new Error('probe_media 需要非空 inputPath。');
  requireLocalPath(input.inputPath);
  if (access === undefined) throw new Error('probe_media 缺少宿主文件授权。');
  const directory = access.workspace.confirmedDirectory();
  if (!isAbsolute(input.inputPath) && directory === undefined) throw new Error('相对路径需要先确认工作目录。');
  const path = isAbsolute(input.inputPath) ? resolve(input.inputPath) : resolve(directory!, input.inputPath);
  const canonical = await realpath(path);
  requireLocalPath(canonical);
  if (!(await stat(canonical)).isFile()) throw new Error('probe_media 输入必须是本地文件。');
  if (await authorizedSource(path, access)) return canonical;
  // 附件旁的候选必须有真实成功生产记录、正确来源和真实目录归属；不扩大整个附件目录授权。
  const item = producedVideoItem(access.events(), path);
  if (item !== undefined && await isInsideDirectory(canonical, item.workingDirectory)) {
    for (const source of item.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('候选来源未经宿主授权。');
    return canonical;
  }
  throw new Error('probe_media 输入超出已授权工作目录及附件范围。');
}

function convert(result: ToolResult, inputPath: string): ToolResult {
  // MCP 是真实外部边界：只读取现有契约，禁止把包装或缺失字段当作成功。
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  if (result.status === 'error') {
    const message = raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
    return { status: 'error', message: message || result.message };
  }
  const data = raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
  if (typeof data !== 'object' || data === null) throw new Error('Probe 插件结果不是媒体对象。');
  const value = data as Record<string, unknown>;
  if (value.inputPath !== inputPath
    || !['duration', 'width', 'height'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])))
    || !['videoCodec', 'audioCodec'].every(key => value[key] === null || typeof value[key] === 'string')) {
    throw new Error('Probe 插件结果不符合六字段契约或实际输入路径。');
  }
  return { status: 'success', output: { inputPath, duration: value.duration, width: value.width, height: value.height,
    videoCodec: value.videoCodec, audioCodec: value.audioCodec } };
}

/** 同一个适配器供公开调用及语义验收使用，内部调用仍经过原 MCP 审批与取消。 */
export function adaptProbeMediaTool(tool: Tool, access: ProbeFileAccess | undefined): Tool {
  return { name: 'probe_media', description: tool.description, inputSchema: tool.inputSchema,
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        context.signal?.throwIfAborted();
        const inputPath = await authorize(input, access);
        const result = await tool.execute({ inputPath }, context);
        context.signal?.throwIfAborted();
        return convert(result, inputPath);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return { status: 'error', message: error.message };
      }
    },
  };
}
