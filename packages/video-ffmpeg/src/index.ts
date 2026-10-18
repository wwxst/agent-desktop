import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 命令执行结果只保留 FFmpeg Tool 需要的标准输出和标准错误。 */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 极小的函数类型是单元测试接缝，不是通用 Runner abstraction。
 * 生产环境传入参数数组，避免把模型提供的路径拼进 shell 字符串。
 */
export type CommandExecutor = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandOutput>;

/**
 * 「可执行文件不存在」的稳定消息。
 *
 * 它是本模块自己产生的契约，用来区分两种完全不同的结论：
 * 进程无法启动（工具不可用）与进程正常运行后报告失败（文件本身有问题）。
 */
function missingExecutableMessage(command: string): string {
  return `${command} not found in PATH`;
}

/**
 * execFile 直接接收可执行文件和参数数组，不经过 shell 解析。
 * 这样路径中的空格或控制字符只会作为 FFmpeg 参数，不会变成额外命令。
 */
export const executeFileCommand: CommandExecutor = (command, args, signal) => (
  new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr });
        return;
      }

      if (signal?.aborted === true) {
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        reject(abortError);
        return;
      }
      if (error.code === 'ENOENT') {
        reject(new Error(missingExecutableMessage(command)));
        return;
      }

      // FFmpeg 常把诊断写入 stderr；只保留末尾关键行，避免撑大 Session。
      const stderrLines = stderr.trim().split(/\r?\n/).filter((line) => line.length > 0);
      const detail = stderrLines.slice(-8).join('\n') || error.message;
      reject(new Error(`${command} failed: ${detail}`));
    });
    if (signal !== undefined) {
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', () => child.kill(), { once: true });
    }
  })
);

/** probe_media 返回给模型的稳定结构，不把完整 ffprobe JSON 暴露给 Session。 */
/** 逐帧语义检查使用全片帧时间轴，超过预算受阻而不降为采样。 */
export async function extractFullVideoFrames(inputPath: string, outputDir: string, signal?: AbortSignal, executeCommand: CommandExecutor = executeFileCommand): Promise<
  { readonly complete: false; readonly reason: string; readonly frameCount: number } |
  { readonly complete: true; readonly frames: readonly { readonly path: string; readonly timestamp: number }[] }
> {
  const { stdout } = await executeCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', inputPath], signal);
  const payload: unknown = JSON.parse(stdout);
  if (!isRecord(payload) || !Array.isArray(payload.frames)) throw new Error('ffprobe 未返回帧时间轴。');
  const raw = payload.frames as Array<{ best_effort_timestamp_time?: unknown }>;
  if (raw.length === 0) throw new Error('候选没有视频帧。');
  if (raw.length > 600) return { complete: false, frameCount: raw.length, reason: `候选包含 ${raw.length} 帧，需要分段逐帧语义验收；单段最多 600 帧，没有降为采样检查。` };
  const timestamps = raw.map((frame) => {
    const value = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(value) || value < 0) throw new Error('ffprobe 帧时间戳无效。');
    return value;
  });
  await mkdir(outputDir, { recursive: true });
  await executeCommand('ffmpeg', ['-n', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-map', '0:v:0', '-fps_mode', 'passthrough', '-q:v', '2', join(outputDir, 'frame-%06d.jpg')], signal);
  const files = (await readdir(outputDir)).filter((file) => /^frame-\d{6}\.jpg$/.test(file)).sort();
  if (files.length !== timestamps.length) throw new Error('实际抽帧数量与全片时间轴不一致，不能确认完整覆盖。');
  return { complete: true, frames: files.map((file, index) => ({ path: join(outputDir, file), timestamp: timestamps[index]! })) };
}

/** 把既有全帧算法暴露为工具，使语义验收也经过入口注入的权限、审批和取消。 */
export class ExtractFullVideoFramesTool implements Tool {
  readonly name = 'extract_full_video_frames';
  readonly description = '提取候选全部解码帧与原始时间戳；超过 600 帧明确受阻，不降为采样。';
  readonly inputSchema = { type: 'object', properties: { inputPath: { type: 'string' }, outputDir: { type: 'string' } },
    required: ['inputPath', 'outputDir'], additionalProperties: false };
  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}
  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.inputPath !== 'string' || typeof input.outputDir !== 'string') {
      return { status: 'error', message: 'extract_full_video_frames requires inputPath and outputDir to be strings' };
    }
    try { return { status: 'success', output: await extractFullVideoFrames(input.inputPath, input.outputDir, signal, this.executeCommand) }; }
    catch (error) { return errorResult(error); }
  }
}

/** 分段按解码序号选择每一帧，时间戳仍来自原视频；不能用 fps 采样替代完整覆盖。 */
export class ExtractVideoSegmentFramesTool implements Tool {
  readonly name = 'extract_video_segment_frames';
  readonly description = '按从零开始的 startFrame 提取最多 600 个连续解码帧，返回原始时间戳和完整覆盖范围，用于长视频分段验收。';
  readonly inputSchema = { type: 'object', properties: { inputPath: { type: 'string' }, outputDir: { type: 'string' },
    startFrame: { type: 'integer', minimum: 0 }, maxFrames: { type: 'integer', minimum: 1, maximum: 600 } },
  required: ['inputPath', 'outputDir', 'startFrame'], additionalProperties: false };
  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}
  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.inputPath !== 'string' || typeof input.outputDir !== 'string'
      || typeof input.startFrame !== 'number' || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0
      || input.maxFrames !== undefined && (typeof input.maxFrames !== 'number' || !Number.isInteger(input.maxFrames) || input.maxFrames < 1 || input.maxFrames > 600)) {
      return { status: 'error', message: '分段抽帧需要本地路径、非负 startFrame 和 1 至 600 的 maxFrames。' };
    }
    try {
      signal?.throwIfAborted();
      const { stdout } = await this.executeCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
        '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input.inputPath], signal);
      const payload: unknown = JSON.parse(stdout);
      if (!isRecord(payload) || !Array.isArray(payload.frames) || payload.frames.length === 0) throw new Error('ffprobe 未返回有效帧时间轴。');
      const timestamps = payload.frames.map((frame: unknown) => {
        if (!isRecord(frame) || typeof frame.best_effort_timestamp_time !== 'string' && typeof frame.best_effort_timestamp_time !== 'number') throw new Error('ffprobe 帧缺少原始时间戳。');
        const timestamp = Number(frame.best_effort_timestamp_time);
        if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('ffprobe 帧时间戳无效。');
        return timestamp;
      });
      if (input.startFrame >= timestamps.length) throw new Error('startFrame 超出候选实际帧数。');
      const endFrame = Math.min(timestamps.length, input.startFrame + (input.maxFrames as number | undefined ?? 600));
      await mkdir(input.outputDir, { recursive: true });
      // 每个分段使用独立前缀，避免共用目录时把上一段的 frame-000001.jpg 混入当前结果。
      // FFmpeg 的 -n 在部分版本遇到冲突时仍返回 0，所以启动前显式拒绝本段旧文件。
      const framePrefix = `segment-${String(input.startFrame).padStart(12, '0')}-`;
      const framePattern = new RegExp(`^${framePrefix}\\d{6}\\.jpg$`);
      const existingSegmentFiles = (await readdir(input.outputDir)).filter(file => framePattern.test(file));
      if (existingSegmentFiles.length > 0) throw new Error(`分段抽帧输出目录已包含本段文件：${existingSegmentFiles[0]}`);
      await this.executeCommand('ffmpeg', ['-n', '-hide_banner', '-loglevel', 'error', '-i', input.inputPath,
        '-map', '0:v:0', '-vf', `select=between(n\\,${input.startFrame}\\,${endFrame - 1})`, '-fps_mode', 'passthrough',
        '-q:v', '2', join(input.outputDir, `${framePrefix}%06d.jpg`)], signal);
      const files = (await readdir(input.outputDir)).filter(file => framePattern.test(file)).sort();
      if (files.length !== endFrame - input.startFrame) throw new Error('分段实际抽帧数量与解码帧范围不一致。');
      return { status: 'success', output: { complete: true, totalFrames: timestamps.length, startFrame: input.startFrame, endFrame,
        startTime: timestamps[input.startFrame], endTime: timestamps[endFrame] ?? null,
        frames: files.map((file, index) => ({ path: join(input.outputDir as string, file), timestamp: timestamps[input.startFrame as number + index]! })) } };
    } catch (error) { return errorResult(error); }
  }
}

interface MediaInfo {
  readonly duration: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

interface BlackSegment {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

interface BlackSegmentsInfo {
  readonly inputPath: string;
  readonly hasBlackSegments: boolean;
  readonly segments: readonly BlackSegment[];
  /** 实际生效的 blackdetect 参数：历史结论必须能解释成「在这组参数下」的结果。 */
  readonly parameters: {
    readonly minimumDurationSeconds: number;
    readonly pixelThreshold: number;
  };
}

/**
 * blackdetect 的固定参数。结果里报告的就是这两个常量，
 * 因此「没有检出黑段」永远等于「在这组参数下没有检出」，不能被解释成更强的结论。
 */
const BLACK_DETECT_MINIMUM_DURATION_SECONDS = 0.04;
const BLACK_DETECT_PIXEL_THRESHOLD = 0.1;

/** 从 blackdetect 的 stderr 诊断行提取模型可直接使用的黑段区间。 */
function parseBlackSegments(stderr: string): BlackSegment[] {
  const segments: BlackSegment[] = [];
  const blackSegmentPattern = /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/g;

  for (const match of stderr.matchAll(blackSegmentPattern)) {
    segments.push({
      start: Number(match[1]),
      end: Number(match[2]),
      duration: Number(match[3]),
    });
  }

  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorResult(error: unknown): ToolResult {
  // 只把标准 Error 转为 Tool 失败；非 Error 抛出值属于程序错误，继续向上暴露。
  if (!(error instanceof Error)) throw error;
  if (error.name === 'AbortError') throw error;

  return {
    status: 'error',
    message: error.message,
  };
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;

  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 用户可见输出一律拒绝覆盖。
 * -n 让 FFmpeg 在目标已存在时立即失败：既不进入交互式等待，也不改写已有文件内容；
 * 覆盖冲突作为真实 Tool 错误交回模型，由模型决定改用其他输出路径。
 */
const REFUSE_OVERWRITE = '-n';

/** 目标不存在时返回 false；ENOENT 之外的读取失败直接暴露，不当作「可以写入」。 */
async function outputExists(outputPath: string): Promise<boolean> {
  try {
    await stat(outputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 写入用户可见文件的唯一入口：目标已存在时明确失败，交给模型改用其他路径。
 * 本机 FFmpeg 9.0 在 -n 拒绝覆盖时退出码仍为 0，只靠 -n 会被误报成功；
 * -n 仍保留在参数里，作为真正写入边界上不覆盖已有文件的兜底。
 */
async function executeOutputCommand(
  executeCommand: CommandExecutor,
  outputPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (await outputExists(outputPath)) {
    throw new Error(`Output file already exists and will not be overwritten: ${outputPath}`);
  }
  await executeCommand('ffmpeg', args, ...(signal === undefined ? [] : [signal]));
}

/**
 * 写出型视频工具的统一成功结果。
 *
 * 它只报告这次调用真实写出的路径（结构化生产事实），不再直接登记 `artifacts`：
 * 中间片段、待修成片和最终交付在宿主看来必须可区分，视频交付的 `artifacts`
 * 只由应用层的发布工具在真正发布成功后报告。
 */
function videoProduced(outputPath: string): ToolResult {
  return {
    status: 'success',
    output: { outputPath },
  };
}

/** 从视频提取供本地语音识别使用的单声道 16 kHz 16-bit PCM WAV 音频。 */
export class ExtractAudioTool implements Tool {
  readonly name = 'extract_audio';
description = '从视频中提取单声道 16 kHz 16-bit PCM WAV 音频';
  readonly inputSchema = {
    type: 'object',
    properties: {
      videoPath: { type: 'string' },
      outputPath: { type: 'string' },
    },
    required: ['videoPath', 'outputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'extract_audio requires videoPath and outputPath to be strings',
      };
    }

    if (!input.outputPath.toLowerCase().endsWith('.wav')) {
      return { status: 'error', message: 'extract_audio only supports .wav outputPath' };
    }

    try {
      // 只保留本地 Whisper 需要的标准音频：去掉视频、转单声道并统一为 16 kHz 16-bit PCM WAV。
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.videoPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        input.outputPath,
      ], signal);
      return { status: 'success', output: `Audio created: ${input.outputPath}` };
    } catch (error) {
      return errorResult(error);
    }
  }
}

/**
 * subtitles 的 filename 位于 FFmpeg Filtergraph 内部，必须转义 filter 分隔符。
 * execFile 已经绕过 shell，因此这里不是 Shell 转义，也不处理命令拼接。
 */
function subtitleFilter(subtitlePath: string): string {
  const normalizedPath = subtitlePath.replace(/\\/g, '/');
  // 单引号会经过 Filtergraph 和 filename option 两层解析，因此需要关闭引号后保留三层反斜杠。
  const escapedSingleQuote = "'" + '\\'.repeat(3) + "''";
  const escapedPath = normalizedPath
    .replace(/([:,\[\];=])/g, '\\$1')
    .replace(/'/g, escapedSingleQuote);
  return `subtitles=filename='${escapedPath}'`;
}

/** 只读取当前公共输出需要的 format 和首个音视频流字段。 */
function parseMediaInfo(stdout: string): MediaInfo {
  let payload: unknown;

  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }

  if (!isRecord(payload) || !isRecord(payload.format) || !Array.isArray(payload.streams)) {
    throw new Error('ffprobe response is missing format or streams');
  }

  const format = payload.format;
  const streams = payload.streams;
  const videoStream = streams.find((stream) => (
    isRecord(stream) && stream.codec_type === 'video'
  ));
  const audioStream = streams.find((stream) => (
    isRecord(stream) && stream.codec_type === 'audio'
  ));

  return {
    duration: numberOrNull(format.duration),
    width: isRecord(videoStream) ? numberOrNull(videoStream.width) : null,
    height: isRecord(videoStream) ? numberOrNull(videoStream.height) : null,
    videoCodec: isRecord(videoStream) ? stringOrNull(videoStream.codec_name) : null,
    audioCodec: isRecord(audioStream) ? stringOrNull(audioStream.codec_name) : null,
  };
}

/** 抽帧只需要 duration；复用统一的 ffprobe JSON 解析，避免复制协议字段读取逻辑。 */
async function probeDuration(executeCommand: CommandExecutor, inputPath: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await executeCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ], ...(signal === undefined ? [] : [signal]));
  const duration = parseMediaInfo(stdout).duration;
  if (duration === null || duration <= 0) {
    throw new Error('extract_video_frames requires a positive media duration');
  }
  return duration;
}

/**
 * 用一次 ffprobe 判断输入是否带音轨。
 * 需要引用 `0:a:0` 的 Tool 都必须先经过这里：无音轨时引用音频流会让 FFmpeg 直接失败。
 */
async function hasAudioStream(
  executeCommand: CommandExecutor,
  inputPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { stdout } = await executeCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    inputPath,
  ], ...(signal === undefined ? [] : [signal]));

  return stdout.trim().length > 0;
}

/** 使用 ffprobe 读取媒体容器和音视频流的基本信息。 */
export class ProbeMediaTool implements Tool {
  readonly name = 'probe_media';
description = '读取媒体文件的时长、画面尺寸和音视频编码信息';
  readonly inputSchema = {
    type: 'object',
    properties: { inputPath: { type: 'string' } },
    required: ['inputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.inputPath !== 'string') {
      return { status: 'error', message: 'probe_media requires inputPath to be a string' };
    }

    try {
      // ffprobe 单独负责媒体探测，JSON 输出避免解析面向人的终端文本。
      const { stdout } = await this.executeCommand('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input.inputPath,
      ], ...(signal === undefined ? [] : [signal]));
      // 结果里保留真实被探测的路径：候选验收必须能把证据归属到具体文件，
      // 不能让「另一个文件的探测结果」或模型回复文本冒充本候选的证据。
      return { status: 'success', output: { inputPath: input.inputPath, ...parseMediaInfo(stdout) } };
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 使用 FFmpeg blackdetect 检测黑段；这是只读检查，不登记产物。 */
export class DetectBlackSegmentsTool implements Tool {
  readonly name = 'detect_black_segments';
description = '使用 FFmpeg blackdetect 检测视频中的黑段区间';
  readonly inputSchema = {
    type: 'object',
    properties: { inputPath: { type: 'string' } },
    required: ['inputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.inputPath !== 'string') {
      return { status: 'error', message: 'detect_black_segments requires inputPath to be a string' };
    }

    try {
      // blackdetect 的检测结果写在 stderr；不设置 error 级日志，否则会压掉检测行。
      const { stderr } = await this.executeCommand('ffmpeg', [
        '-hide_banner',
        '-i',
        input.inputPath,
        '-vf',
        `blackdetect=d=${BLACK_DETECT_MINIMUM_DURATION_SECONDS}:pix_th=${BLACK_DETECT_PIXEL_THRESHOLD}`,
        '-an',
        '-f',
        'null',
        '-',
      ], ...(signal === undefined ? [] : [signal]));
      const segments = parseBlackSegments(stderr);

      return {
        status: 'success',
        output: {
          inputPath: input.inputPath,
          hasBlackSegments: segments.length > 0,
          segments,
          parameters: {
            minimumDurationSeconds: BLACK_DETECT_MINIMUM_DURATION_SECONDS,
            pixelThreshold: BLACK_DETECT_PIXEL_THRESHOLD,
          },
        } satisfies BlackSegmentsInfo,
      };
    } catch (error) {
      return errorResult(error);
    }
  }
}

interface DecodeVideoInfo {
  readonly inputPath: string;
  /** 容器里是否存在可用的视频流；它不等同于整段都能解码。 */
  readonly hasVideoStream: boolean;
  readonly videoCodec: string | null;
  readonly durationSeconds: number | null;
  /** 是否完成全文件解码。false 表示这段媒体自身无法完整读出。 */
  readonly fullyDecoded: boolean;
}

/**
 * 对整段视频做真实解码检查。
 *
 * probe_media 只读取容器与流信息，不能证明整段都能解码；本 Tool 用一次完整的
 * 「解码到 null」真正读完所有帧。它只报告检查事实，不决定候选是否合格。
 */
export class DecodeVideoTool implements Tool {
  readonly name = 'decode_video';
  readonly description = '对视频做全文件解码检查，确认存在可用视频流并且整段可以完整解码';
  readonly inputSchema = {
    type: 'object',
    properties: { inputPath: { type: 'string' } },
    required: ['inputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.inputPath !== 'string') {
      return { status: 'error', message: 'decode_video requires inputPath to be a string' };
    }

    try {
      // 先探测容器与流：没有视频流时不必再解码，结论已经是「不是可用视频」。
      const { stdout } = await this.executeCommand('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input.inputPath,
      ], ...(signal === undefined ? [] : [signal]));
      const mediaInfo = parseMediaInfo(stdout);
      const hasVideoStream = mediaInfo.videoCodec !== null;

      if (!hasVideoStream) {
        return {
          status: 'success',
          output: {
            inputPath: input.inputPath,
            hasVideoStream: false,
            videoCodec: null,
            durationSeconds: mediaInfo.duration,
            fullyDecoded: false,
          } satisfies DecodeVideoInfo,
        };
      }

      let fullyDecoded = true;
      try {
        // 解码到 null：只有整段都能读出时 FFmpeg 才正常退出。
        await this.executeCommand('ffmpeg', [
          '-hide_banner',
          '-v',
          'error',
          '-i',
          input.inputPath,
          '-f',
          'null',
          '-',
        ], ...(signal === undefined ? [] : [signal]));
      } catch (error) {
        // 解码进程无法启动属于工具不可用，必须继续向上暴露；
        // 进程正常运行后报错则说明这段媒体自身不能完整解码，是真实的检查结论。
        if (error instanceof Error && error.name === 'AbortError') throw error;
        if (error instanceof Error && error.message === missingExecutableMessage('ffmpeg')) throw error;
        fullyDecoded = false;
      }

      return {
        status: 'success',
        output: {
          inputPath: input.inputPath,
          hasVideoStream: true,
          videoCodec: mediaInfo.videoCodec,
          durationSeconds: mediaInfo.duration,
          fullyDecoded,
        } satisfies DecodeVideoInfo,
      };
    } catch (error) {
      return errorResult(error);
    }
  }
}
interface ExtractedVideoFrame {
  readonly timestamp: number;
  readonly path: string;
}

interface ExtractVideoFramesOutput {
  readonly duration: number;
  readonly frames: readonly ExtractedVideoFrame[];
}

/**
 * 按原视频绝对时间抽取 JPG；整段粗看和局部放大只负责各自计算 timestamp[]。
 * 复用这一小段命令拼装可以保证两种检查能力使用相同的尺寸、质量和文件命名规则。
 */
async function extractFramesAtTimestamps(
  executeCommand: CommandExecutor,
  videoPath: string,
  outputDir: string,
  timestamps: readonly number[],
  signal?: AbortSignal,
): Promise<ExtractedVideoFrame[]> {
  await mkdir(outputDir, { recursive: true });
  const frames: ExtractedVideoFrame[] = [];

  for (const [index, timestamp] of timestamps.entries()) {
    const framePath = join(outputDir, `frame-${String(index + 1).padStart(3, '0')}.jpg`);
    await executeOutputCommand(executeCommand, framePath, [
      REFUSE_OVERWRITE,
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(timestamp),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(640,iw)':-2",
      '-q:v',
      '2',
      framePath,
    ], signal);
    frames.push({ timestamp, path: framePath });
  }

  return frames;
}

/**
 * 从视频中抽取六张代表性 JPG，给视觉 Tool 提供轻量的时间点和图片路径。
 * 图片留在调用方指定的目录，方便后续视觉分析和人工检查；本 Tool 不负责生命周期清理。
 */
export class ExtractVideoFramesTool implements Tool {
  readonly name = 'extract_video_frames';
  readonly description = '从视频中均匀抽取六张代表性画面并返回图片路径与时间戳';
  readonly inputSchema = {
    type: 'object',
    properties: {
      videoPath: { type: 'string' },
      outputDir: { type: 'string' },
    },
    required: ['videoPath', 'outputDir'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.outputDir !== 'string') {
      return {
        status: 'error',
        message: 'extract_video_frames requires videoPath and outputDir to be strings',
      };
    }

    try {
      const duration = await probeDuration(this.executeCommand, input.videoPath, signal);
      // 使用 1/7 到 6/7 的时间点，避开容易出现黑屏或片尾的首尾帧。
      const timestamps = [1, 2, 3, 4, 5, 6].map((index) => (duration * index) / 7);
      const frames = await extractFramesAtTimestamps(
        this.executeCommand,
        input.videoPath,
        input.outputDir,
        timestamps,
        signal,
      );

      return { status: 'success', output: { duration, frames } satisfies ExtractVideoFramesOutput };
    } catch (error) {
      return errorResult(error);
    }
  }
}

interface ExtractVideoRangeFramesOutput {
  readonly start: number;
  readonly end: number;
  readonly frames: readonly ExtractedVideoFrame[];
}

/**
 * 在指定时间范围内部固定抽取六帧，作为整段六帧粗看之后的局部放大检查。
 * timestamp 保持原视频绝对时间，让 DeepSeek 可以直接据此选择 trim_video 的时间参数。
 */
export class ExtractVideoRangeFramesTool implements Tool {
  readonly name = 'extract_video_range_frames';
description = '在指定原视频时间范围内均匀抽取六帧，用于进一步确认内容变化和近似剪切边界';
  readonly inputSchema = {
    type: 'object',
    properties: {
      videoPath: { type: 'string' },
      outputDir: { type: 'string' },
      start: { type: 'number', minimum: 0 },
      end: { type: 'number' },
    },
    required: ['videoPath', 'outputDir', 'start', 'end'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.outputDir !== 'string') {
      return {
        status: 'error',
        message: 'extract_video_range_frames requires videoPath and outputDir to be strings',
      };
    }

    if (typeof input.start !== 'number'
      || !Number.isFinite(input.start)
      || input.start < 0
      || typeof input.end !== 'number'
      || !Number.isFinite(input.end)
      || input.end <= input.start) {
      return {
        status: 'error',
        message: 'extract_video_range_frames requires finite start >= 0 and end > start',
      };
    }

    try {
      // 对象属性进入回调后不会保持类型收窄；局部常量固定已验证的数值边界。
      const start = input.start;
      const end = input.end;
      const rangeDuration = end - start;
      // 仍取六帧并避开范围首尾；加上 start 后得到可直接用于剪辑决策的绝对时间。
      const timestamps = [1, 2, 3, 4, 5, 6].map((index) => (
        start + (rangeDuration * index) / 7
      ));
      const frames = await extractFramesAtTimestamps(
        this.executeCommand,
        input.videoPath,
        input.outputDir,
        timestamps,
        signal,
      );

      return {
        status: 'success',
        output: {
          start,
          end,
          frames,
        } satisfies ExtractVideoRangeFramesOutput,
      };
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 使用 FFmpeg 重新编码指定时间范围，优先保证裁剪结果稳定正确。 */
export class TrimVideoTool implements Tool {
  readonly name = 'trim_video';
  readonly description = '从指定开始时间裁剪固定时长的视频';
  readonly inputSchema = {
    type: 'object',
    properties: {
      inputPath: { type: 'string' },
      outputPath: { type: 'string' },
      start: { type: 'number', minimum: 0 },
      duration: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['inputPath', 'outputPath', 'start', 'duration'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.inputPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'trim_video requires inputPath and outputPath to be strings',
      };
    }

    if (typeof input.start !== 'number'
      || !Number.isFinite(input.start)
      || input.start < 0
      || typeof input.duration !== 'number'
      || !Number.isFinite(input.duration)
      || input.duration <= 0) {
      return {
        status: 'error',
        message: 'trim_video requires start >= 0 and duration > 0',
      };
    }

    try {
      // -ss 放在输入之后进行准确裁剪；重新编码避免 stream copy 的关键帧偏差。
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.inputPath,
        '-ss',
        String(input.start),
        '-t',
        String(input.duration),
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/**
 * 使用 FFmpeg concat filter 按输入顺序解码并重新编码各段。
 * concat demuxer 会沿用首段的流参数，遇到采样率不同的 AAC 时静默丢弃后续音频并仍然返回成功；
 * concat filter 逐段提供视频与音频输入，由 FFmpeg 统一重采样后再拼接，因此不依赖各段音频参数一致。
 * concat filter 必须为每段显式给出音频输入，所以先探测音轨：全部无音轨时只拼接视频，
 * 只有部分片段有音轨时明确失败，不产出比视频短的音轨。
 */
export class ConcatVideosTool implements Tool {
  readonly name = 'concat_videos';
  readonly description = '按顺序拼接多个编码条件一致的视频';
  readonly inputSchema = {
    type: 'object',
    properties: {
      inputPaths: { type: 'array', items: { type: 'string' }, minItems: 1 },
      outputPath: { type: 'string' },
    },
    required: ['inputPaths', 'outputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || !Array.isArray(input.inputPaths)
      || input.inputPaths.length === 0
      || !input.inputPaths.every((path) => typeof path === 'string')
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'concat_videos requires a non-empty inputPaths string array and outputPath string',
      };
    }

    try {
      const inputPaths = input.inputPaths as string[];
      // 逐段探测音轨：无音轨的片段不能提供 [i:a:0] 输入，必须先知道每段的真实情况。
      const audioFlags: boolean[] = [];
      for (const inputPath of inputPaths) {
        audioFlags.push(await hasAudioStream(this.executeCommand, inputPath, signal));
      }
      const audioCount = audioFlags.filter(Boolean).length;

      if (audioCount !== 0 && audioCount !== inputPaths.length) {
        // 混合输入既无法只拼视频，也无法为无声片段补出等长音频；直接失败，不静默丢音。
        const silentPaths = inputPaths.filter((_, index) => !audioFlags[index]);
        return {
          status: 'error',
          message: `concat_videos cannot mix inputs with and without audio streams: ${silentPaths.join(', ')}`,
        };
      }

      const hasAudio = audioCount === inputPaths.length;
      // concat filter 按段依次消费「视频+音频」两个输入，顺序必须逐段交错。
      const segmentInputs = hasAudio
        ? inputPaths.map((_, index) => `[${index}:v:0][${index}:a:0]`).join('')
        : inputPaths.map((_, index) => `[${index}:v:0]`).join('');
      const filterGraph = hasAudio
        ? `${segmentInputs}concat=n=${inputPaths.length}:v=1:a=1[video][audio]`
        : `${segmentInputs}concat=n=${inputPaths.length}:v=1:a=0[video]`;

      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        // -i 的出现顺序就是拼接顺序，与 inputPaths 一一对应。
        ...inputPaths.flatMap((inputPath) => ['-i', inputPath]),
        '-filter_complex',
        filterGraph,
        '-map',
        '[video]',
        ...(hasAudio ? ['-map', '[audio]', '-c:a', 'aac'] : []),
        '-c:v',
        'libx264',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 保留视频画面，并用传入音频替换输出文件的声音。 */
export class AddAudioTool implements Tool {
  readonly name = 'add_audio';
description = '保留视频画面并使用传入音频，输出时长以视频为准';
  readonly inputSchema = {
    type: 'object',
    properties: {
      videoPath: { type: 'string' },
      audioPath: { type: 'string' },
      outputPath: { type: 'string' },
    },
    required: ['videoPath', 'audioPath', 'outputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.audioPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'add_audio requires videoPath, audioPath, and outputPath to be strings',
      };
    }

    try {
      // apad 补齐较短音频，-shortest 再以视频流结束点限制最终时长。
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.videoPath,
        '-i',
        input.audioPath,
        '-filter_complex',
        '[1:a:0]apad[audio]',
        '-map',
        '0:v:0',
        '-map',
        '[audio]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 使用 FFmpeg subtitles filter 把外部 SRT 字幕永久烧录进视频画面。 */
export class AddSubtitlesTool implements Tool {
  readonly name = 'add_subtitles';
description = '将外部 SRT 字幕烧录到视频画面中';
  readonly inputSchema = {
    type: 'object',
    properties: {
      videoPath: { type: 'string' },
      subtitlePath: { type: 'string' },
      outputPath: { type: 'string' },
    },
    required: ['videoPath', 'subtitlePath', 'outputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.subtitlePath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'add_subtitles requires videoPath, subtitlePath, and outputPath to be strings',
      };
    }

    if (!input.subtitlePath.toLowerCase().endsWith('.srt')) {
      return { status: 'error', message: 'add_subtitles only supports .srt subtitle files' };
    }

    try {
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.videoPath,
        '-vf',
        subtitleFilter(input.subtitlePath),
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-c:a',
        'copy',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No such filter:\s*['"]?subtitles/i.test(message)) {
        return { status: 'error', message: 'FFmpeg subtitles filter is not available' };
      }
      return errorResult(error);
    }
  }
}

/** scale filter 将每一帧直接缩放到用户指定宽高，不隐式保持原始比例。 */
export class ResizeVideoTool implements Tool {
  readonly name = 'resize_video';
description = '将视频画面直接缩放到指定宽度和高度';
  readonly inputSchema = {
    type: 'object',
    properties: {
      inputPath: { type: 'string' },
      outputPath: { type: 'string' },
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['inputPath', 'outputPath', 'width', 'height'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.inputPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'resize_video requires inputPath and outputPath to be strings',
      };
    }

    if (typeof input.width !== 'number'
      || !Number.isFinite(input.width)
      || input.width <= 0
      || typeof input.height !== 'number'
      || !Number.isFinite(input.height)
      || input.height <= 0) {
      return {
        status: 'error',
        message: 'resize_video requires finite width > 0 and height > 0',
      };
    }

    try {
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.inputPath,
        '-vf',
        `scale=${input.width}:${input.height}`,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-c:a',
        'copy',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** crop filter 从每一帧的 x、y 起点截取指定宽高矩形。 */
export class CropVideoTool implements Tool {
  readonly name = 'crop_video';
  readonly description = '从视频画面指定坐标裁出固定宽高的矩形区域';
  readonly inputSchema = {
    type: 'object',
    properties: {
      inputPath: { type: 'string' },
      outputPath: { type: 'string' },
      x: { type: 'number', minimum: 0 },
      y: { type: 'number', minimum: 0 },
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['inputPath', 'outputPath', 'x', 'y', 'width', 'height'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.inputPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'crop_video requires inputPath and outputPath to be strings',
      };
    }

    if (typeof input.x !== 'number'
      || !Number.isFinite(input.x)
      || input.x < 0
      || typeof input.y !== 'number'
      || !Number.isFinite(input.y)
      || input.y < 0
      || typeof input.width !== 'number'
      || !Number.isFinite(input.width)
      || input.width <= 0
      || typeof input.height !== 'number'
      || !Number.isFinite(input.height)
      || input.height <= 0) {
      return {
        status: 'error',
        message: 'crop_video requires finite x >= 0, y >= 0, width > 0, and height > 0',
      };
    }

    try {
      await executeOutputCommand(this.executeCommand, input.outputPath, [
        REFUSE_OVERWRITE,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input.inputPath,
        '-vf',
        `crop=${input.width}:${input.height}:${input.x}:${input.y}`,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-c:a',
        'copy',
        input.outputPath,
      ], signal);
      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 在 0.5～2.0 倍范围内同步调整视频时间戳与音频节奏。 */
export class SetSpeedTool implements Tool {
  readonly name = 'set_speed';
description = '在 0.5 到 2.0 倍范围内同步调整视频播放速度';
  readonly inputSchema = {
    type: 'object',
    properties: {
      inputPath: { type: 'string' },
      outputPath: { type: 'string' },
      speed: { type: 'number', minimum: 0.5, maximum: 2 },
    },
    required: ['inputPath', 'outputPath', 'speed'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.inputPath !== 'string'
      || typeof input.outputPath !== 'string') {
      return {
        status: 'error',
        message: 'set_speed requires inputPath and outputPath to be strings',
      };
    }

    if (typeof input.speed !== 'number'
      || !Number.isFinite(input.speed)
      || input.speed < 0.5
      || input.speed > 2) {
      return {
        status: 'error',
        message: 'set_speed requires a finite speed between 0.5 and 2.0',
      };
    }

    try {
      // 先探测首个音轨，避免无音频视频引用 0:a:0 时产生无意义错误。
      const hasAudio = await hasAudioStream(this.executeCommand, input.inputPath, signal);

      if (hasAudio) {
        // setpts 控制视频帧时间戳，atempo 控制音频节奏；同一倍率保持音视频同步。
        await executeOutputCommand(this.executeCommand, input.outputPath, [
          REFUSE_OVERWRITE,
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          input.inputPath,
          '-filter_complex',
          `[0:v:0]setpts=PTS/${input.speed}[video];[0:a:0]atempo=${input.speed}[audio]`,
          '-map',
          '[video]',
          '-map',
          '[audio]',
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          input.outputPath,
        ], signal);
      } else {
        // 无音轨时只改变视频时间戳，并显式禁止输出音频。
        await executeOutputCommand(this.executeCommand, input.outputPath, [
          REFUSE_OVERWRITE,
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          input.inputPath,
          '-vf',
          `setpts=PTS/${input.speed}`,
          '-map',
          '0:v:0',
          '-an',
          '-c:v',
          'libx264',
          input.outputPath,
        ], signal);
      }

      return videoProduced(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}
