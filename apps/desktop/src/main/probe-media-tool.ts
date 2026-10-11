import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { SessionEvent } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { isInsideDirectory, producedVideoItem, readVideoDeliveryFacts, resolveThroughExistingParent } from '@agent-desktop/video-agent';

/** 宿主固定公开名称映射，只授予随包受控服务，不授予第三方同名工具。 */
export const FFMPEG_READ_TOOLS = new Set(['probe_media', 'decode_video', 'detect_black_segments', 'extract_video_frames',
  'extract_video_range_frames', 'extract_audio', 'extract_full_video_frames']);

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
  if (process.platform === 'win32' && path.slice(2).includes(':')) throw new Error('FFmpeg 不接受 Windows 备用数据流路径。');
}

async function authorizedSource(path: string, access: ProbeFileAccess): Promise<boolean> {
  requireLocalPath(path);
  const canonical = await realpath(path);
  requireLocalPath(canonical);
  const directory = access.workspace.confirmedDirectory();
  if (directory !== undefined && await isInsideDirectory(canonical, directory)) return true;
  for (const attachment of access.attachments()) {
    requireLocalPath(attachment);
    try { if (canonical === await realpath(attachment)) return true; }
    catch (error) {
      // 删除过的历史附件不能授权，也不能阻止其它仍存在的选定文件。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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

/** 输出授权复用真实目录判定；声明本身不授权未选定来源或任意输出目录。 */
async function authorizeOutput(path: string, access: ProbeFileAccess): Promise<string> {
  requireLocalPath(path);
  const directory = access.workspace.confirmedDirectory();
  if (!isAbsolute(path) && directory === undefined) throw new Error('相对路径需要先确认工作目录。');
  const canonical = await resolveThroughExistingParent(isAbsolute(path) ? path : resolve(directory!, path));
  requireLocalPath(canonical);
  if (directory !== undefined && (canonical === await realpath(directory) || await isInsideDirectory(canonical, directory))) return canonical;
  for (const item of readVideoDeliveryFacts(access.events()).items) {
    if (!await isInsideDirectory(canonical, item.workingDirectory)) continue;
    for (const source of item.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('输出项来源未经宿主授权。');
    return canonical;
  }
  throw new Error('FFmpeg 输出超出已授权工作目录及视频输出项范围。');
}

function unwrap(result: ToolResult): unknown {
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  return raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
}

/** 所有只读能力共用授权及原 MCP 调用链；审批前解析真实路径，结果回到原 Tool 契约。 */
export function adaptFFmpegReadTool(tool: Tool, access: ProbeFileAccess | undefined, name: string): Tool {
  if (name === 'probe_media') return adaptProbeMediaTool(tool, access);
  return { name, description: tool.description, inputSchema: tool.inputSchema,
    async execute(input, context) {
      try {
        context.signal?.throwIfAborted();
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('FFmpeg 参数必须是对象。');
        if (access === undefined) throw new Error('FFmpeg 缺少宿主文件授权。');
        const normalized = { ...input } as Record<string, unknown>;
        const field = name === 'extract_video_frames' || name === 'extract_video_range_frames' || name === 'extract_audio' ? 'videoPath' : 'inputPath';
        normalized[field] = await authorize({ inputPath: normalized[field] }, access);
        for (const field of ['outputPath', 'outputDir']) if (field in normalized) {
          if (typeof normalized[field] !== 'string') throw new Error(`${field} 必须是本地路径。`);
          normalized[field] = await authorizeOutput(normalized[field], access);
        }
        const response = await tool.execute(normalized, context);
        context.signal?.throwIfAborted();
        if (response.status === 'error') return convert(response, normalized[field] as string);
        const envelope = unwrap(response) as { toolResult?: unknown } | null;
        const result = envelope?.toolResult as { status?: unknown; output?: unknown; artifacts?: unknown } | undefined;
        if (result?.status !== 'success' || result.output === undefined || result.artifacts !== undefined) throw new Error('FFmpeg 插件结果不符合工具契约。');
        const value = result.output as Record<string, unknown>;
        if (name === 'extract_audio') {
          if (result.output !== `Audio created: ${normalized.outputPath as string}`) throw new Error('音频结果与已授权输出路径不一致。');
        } else if (name === 'decode_video') {
          if (value.inputPath !== normalized.inputPath || typeof value.hasVideoStream !== 'boolean' || typeof value.fullyDecoded !== 'boolean'
            || !(value.videoCodec === null || typeof value.videoCodec === 'string')
            || !(value.durationSeconds === null || typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds))) throw new Error('解码结果不符合原工具契约。');
        } else if (name === 'detect_black_segments') {
          if (value.inputPath !== normalized.inputPath || typeof value.hasBlackSegments !== 'boolean' || !Array.isArray(value.segments)
            || !value.segments.every(segment => segment !== null && typeof segment === 'object' && ['start', 'end', 'duration'].every(key => typeof segment[key] === 'number' && Number.isFinite(segment[key])))
            || typeof value.parameters !== 'object' || value.parameters === null) throw new Error('黑段结果不符合原工具契约。');
        } else if (name === 'extract_full_video_frames' && value.complete === false) {
          if (typeof value.reason !== 'string') throw new Error('全帧预算结果缺少受阻原因。');
        } else {
          if (!Array.isArray(value.frames) || (name === 'extract_full_video_frames' && value.complete !== true)) throw new Error('抽帧结果缺少完整帧列表。');
          for (const frame of value.frames as Array<{ path: unknown; timestamp: unknown }>) {
            if (typeof frame?.path !== 'string' || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp)
              || !await isInsideDirectory(frame.path, normalized.outputDir as string)) throw new Error('抽帧结果超出已授权目录或缺少时间戳。');
          }
        }
        return { status: 'success', output: result.output };
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return { status: 'error', message: error.message };
      }
    },
  };
}
