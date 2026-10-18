import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import { SessionPersistenceError, type SessionEvent } from '@agent-desktop/session';
import { ToolExecutionError, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { isInsideDirectory, producedVideoItem, readVideoDeliveryFacts, resolveThroughExistingParent, VIDEO_WRITE_TOOL_NAMES } from '@agent-desktop/video-agent';

/** 宿主固定公开名称映射，只授予随包受控服务，不授予第三方同名工具。 */
export const FFMPEG_READ_TOOLS = new Set(['probe_media', 'decode_video', 'detect_black_segments', 'extract_video_frames',
  'extract_video_range_frames', 'extract_audio', 'extract_full_video_frames', 'extract_video_segment_frames']);
export const FFMPEG_TOOLS = new Set([...FFMPEG_READ_TOOLS, ...VIDEO_WRITE_TOOL_NAMES]);

/** 授权只取宿主文件范围、目录和附件事实；模型声明的目标及 MCP 审批不自行扩大范围。 */
export interface ProbeFileAccess {
  readonly workspace: Pick<WorkspacePort, 'confirmedDirectory' | 'fileAccess'>;
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
  if (access.workspace.fileAccess === 'all') return true;
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

export async function authorizeMediaInput(input: unknown, access: ProbeFileAccess | undefined, derivedAudio = false): Promise<string> {
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
  // Whisper 可以读取同一授权输出项中的中间 WAV，不能据此读取整个附件所在目录。
  if (derivedAudio) for (const output of readVideoDeliveryFacts(access.events()).items) {
    if (!await isInsideDirectory(canonical, output.workingDirectory)) continue;
    for (const source of output.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('语音候选来源未经宿主授权。');
    await authorizeTarget(output.target.kind === 'explicit' ? output.target.path : output.target.preferredPath, output.sourcePaths, access);
    return canonical;
  }
  throw new Error('probe_media 输入超出已授权工作目录及附件范围。');
}

function convert(result: ToolResult, inputPath: string): ToolResult {
  // MCP 是真实外部边界：只读取现有契约，禁止把包装或缺失字段当作成功。
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  if (result.status === 'error') {
    const message = raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
    return { status: 'error', message: message || result.message,
      ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }) };
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
    executionBoundary: 'read-only',
    contract: { capability: 'media', riskLevel: 'read', parallelSafety: 'serial', timeoutMs: 120_000,
      cancellation: 'signal', workspaceScope: 'session', approvalRequirement: 'policy' },
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        context.signal?.throwIfAborted();
        const inputPath = await authorizeMediaInput(input, access);
        // 只读探测不会产生可恢复的外部效果；不要让底层 MCP 检查点污染只读 Session 事实。
        const { checkpoint: _checkpoint, ...readOnlyContext } = context;
        const result = await tool.execute({ inputPath }, readOnlyContext);
        context.signal?.throwIfAborted();
        // 已知探测服务没有写入；其 MCP 错误响应也不能携带通用服务的未知副作用分类。
        return convert(result.status === 'error' ? { ...result, failureKind: result.failureKind === 'denied' ? 'denied' : 'permanent' } : result, inputPath);
      } catch (error) {
        if (error instanceof SessionPersistenceError) throw error;
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        // 探测没有磁盘写入；保留拒绝审批身份，其余失败不能制造未知外部效果。
        return { status: 'error', message: error.message,
          failureKind: error instanceof ToolExecutionError && error.failureKind === 'denied' ? 'denied' : 'permanent' };
      }
    },
  };
}

/** 输出授权复用真实目录判定；声明本身不授权未选定来源或任意输出目录。 */
async function authorizeOutput(path: string, access: ProbeFileAccess, video = false): Promise<string> {
  requireLocalPath(path);
  const directory = access.workspace.confirmedDirectory();
  if (!isAbsolute(path) && directory === undefined) throw new Error('相对路径需要先确认工作目录。');
  const canonical = await resolveThroughExistingParent(isAbsolute(path) ? path : resolve(directory!, path));
  requireLocalPath(canonical);
  // 全文件授权放开中间产物目录；视频写出仍须归属于已声明输出项。
  if (!video && access.workspace.fileAccess === 'all') return canonical;
  if (!video && directory !== undefined && (canonical === await realpath(directory) || await isInsideDirectory(canonical, directory))) return canonical;
  for (const item of readVideoDeliveryFacts(access.events()).items) {
    if (!await isInsideDirectory(canonical, item.workingDirectory)) continue;
    for (const source of item.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('输出项来源未经宿主授权。');
    await authorizeTarget(item.target.kind === 'explicit' ? item.target.path : item.target.preferredPath, item.sourcePaths, access);
    return canonical;
  }
  throw new Error('FFmpeg 输出超出已授权工作目录及视频输出项范围。');
}

function unwrap(result: ToolResult): unknown {
  const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  return raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
}

/** 媒体能力共用授权及原 MCP 调用链；审批前解析真实路径，结果回到原 Tool 契约。 */
export function adaptFFmpegTool(tool: Tool, access: ProbeFileAccess | undefined, name: string): Tool {
  if (name === 'probe_media') return adaptProbeMediaTool(tool, access);
  const readOnly = name === 'decode_video' || name === 'detect_black_segments';
  return { name, description: tool.description, inputSchema: tool.inputSchema,
    // 抽帧和音频提取会写磁盘，保留原 MCP 工具的检查点边界；只有纯检查声明只读。
    executionBoundary: readOnly ? 'read-only' : tool.executionBoundary ?? 'opaque',
    contract: { capability: 'media', riskLevel: readOnly ? 'read' : 'write', parallelSafety: 'serial', timeoutMs: 120_000,
      cancellation: 'signal', workspaceScope: 'session', approvalRequirement: 'policy' },
    async execute(input, context) {
      let invoked = false;
      try {
        context.signal?.throwIfAborted();
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('FFmpeg 参数必须是对象。');
        if (access === undefined) throw new Error('FFmpeg 缺少宿主文件授权。');
        const normalized = { ...input } as Record<string, unknown>;
        const fields = name === 'concat_videos' ? [] : ['extract_video_frames', 'extract_video_range_frames', 'extract_audio', 'add_audio', 'add_subtitles'].includes(name) ? ['videoPath'] : ['inputPath'];
        if (name === 'add_audio') fields.push('audioPath');
        if (name === 'add_subtitles') fields.push('subtitlePath');
        for (const field of fields) normalized[field] = await authorizeMediaInput({ inputPath: normalized[field] }, access);
        if (name === 'concat_videos') {
          if (!Array.isArray(normalized.inputPaths)) throw new Error('concat_videos requires inputPaths to be an array');
          normalized.inputPaths = await Promise.all(normalized.inputPaths.map(inputPath => authorizeMediaInput({ inputPath }, access)));
        }
        for (const field of ['outputPath', 'outputDir']) if (field in normalized) {
          if (typeof normalized[field] !== 'string') throw new Error(`${field} 必须是本地路径。`);
          normalized[field] = await authorizeOutput(normalized[field], access, VIDEO_WRITE_TOOL_NAMES.has(name));
        }
        invoked = true;
        let executionContext = context;
        if (readOnly) {
          const { checkpoint: _checkpoint, ...readOnlyContext } = context;
          executionContext = readOnlyContext;
        }
        const response = await tool.execute(normalized, executionContext);
        context.signal?.throwIfAborted();
        if (response.status === 'error') {
          return convert(readOnly ? { ...response, failureKind: response.failureKind === 'denied' ? 'denied' : 'permanent' } : response, '');
        }
        const envelope = unwrap(response) as { toolResult?: unknown } | null;
        const result = envelope?.toolResult as { status?: unknown; output?: unknown; artifacts?: unknown } | undefined;
        if (result?.status !== 'success' || result.output === undefined || result.artifacts !== undefined) throw new Error('FFmpeg 插件结果不符合工具契约。');
        const value = result.output as Record<string, unknown>;
        if (VIDEO_WRITE_TOOL_NAMES.has(name)) {
          if (value.outputPath !== normalized.outputPath || typeof value.outputPath !== 'string'
            || !(await stat(value.outputPath)).isFile()) throw new Error('写出结果与实际授权候选不一致。');
          // 服务使用真实路径，生产归属仍使用原调用的候选引用，保留现有会话与交付契约。
          return { status: 'success', output: { outputPath: (input as Record<string, unknown>).outputPath } };
        } else if (name === 'extract_audio') {
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
          if (!Array.isArray(value.frames) || (name === 'extract_full_video_frames' && (value.complete !== true || value.frames.length === 0))) throw new Error('抽帧结果缺少完整帧列表。');
          for (const frame of value.frames as Array<{ path: unknown; timestamp: unknown }>) {
            if (typeof frame?.path !== 'string' || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp)
              || !await isInsideDirectory(frame.path, normalized.outputDir as string)) throw new Error('抽帧结果超出已授权目录或缺少时间戳。');
          }
        }
        return { status: 'success', output: result.output };
      } catch (error) {
        if (error instanceof SessionPersistenceError) throw error;
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        // 授权失败尚未进入服务；写入调用后丢失或无法解析结果仍可能已经生成文件。
        const failureKind = !invoked ? 'permanent'
          : error instanceof ToolExecutionError && (!readOnly || error.failureKind === 'denied') ? error.failureKind
            : readOnly ? 'permanent' : 'unknown-outcome';
        return { status: 'error', message: error.message, failureKind };
      }
    },
  };
}

/** 最终目标服从宿主文件范围；受限时只能使用确认目录或授权来源附件所在目录。 */
async function authorizeTarget(path: string, sources: readonly string[], access: ProbeFileAccess): Promise<void> {
  requireLocalPath(path);
  if (!isAbsolute(path)) throw new Error('视频交付目标必须使用本地绝对路径。');
  const canonical = await resolveThroughExistingParent(path);
  requireLocalPath(canonical);
  if (access.workspace.fileAccess === 'all') return;
  const directory = access.workspace.confirmedDirectory();
  if (directory !== undefined && await isInsideDirectory(canonical, directory)) return;
  for (const source of sources) {
    if (await authorizedSource(source, access) && await isInsideDirectory(canonical, dirname(await realpath(source)))) return;
  }
  throw new Error('视频交付目标超出已授权目录及来源附件目录。');
}

/** 交付规则保持在应用层，宿主只补充真实目录与附件授权，不改变验收结论。 */
export function authorizeVideoDeliveryTool(tool: Tool, access: ProbeFileAccess): Tool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    ...(tool.executionBoundary === undefined ? {} : { executionBoundary: tool.executionBoundary }),
    async execute(input, context) {
    let invoked = false;
    try {
      context.signal?.throwIfAborted();
      if (typeof input === 'object' && input !== null) {
        const value = input as Record<string, unknown>;
        if (tool.name === 'declare_video_outputs' && Array.isArray(value.items)) {
          for (const item of value.items as Array<{ sourcePaths?: unknown; target?: { kind?: unknown; path?: unknown } }>) {
            if (!Array.isArray(item?.sourcePaths)) continue; // 原工具负责结构错误，宿主仅检查文件边界。
            const sources: string[] = [];
            for (const source of item.sourcePaths) sources.push(await authorizeMediaInput({ inputPath: source }, access));
            if (item.target?.kind === 'explicit' && typeof item.target.path === 'string') await authorizeTarget(item.target.path, sources, access);
          }
        } else if (tool.name === 'publish_video_output') {
          const facts = readVideoDeliveryFacts(access.events());
          const validation = facts.validations.find(entry => entry.id === value.validationId);
          const candidate = facts.candidates.find(entry => entry.id === validation?.candidateId);
          const item = facts.items.find(entry => entry.id === candidate?.outputItemId);
          if (item !== undefined) {
            for (const source of item.sourcePaths) if (!await authorizedSource(source, access)) throw new Error('交付来源未经宿主授权。');
            await authorizeTarget(item.target.kind === 'explicit' ? item.target.path : item.target.preferredPath, item.sourcePaths, access);
          }
        }
      }
      invoked = true;
      return await tool.execute(input, context);
    } catch (error) {
      if (error instanceof SessionPersistenceError) throw error;
      context.signal?.throwIfAborted();
      if (!(error instanceof Error) || error.name === 'AbortError') throw error;
      return { status: 'error', failureKind: invoked ? (error instanceof ToolExecutionError ? error.failureKind : 'unknown-outcome') : 'permanent', message: error.message };
    }
  } };
}
