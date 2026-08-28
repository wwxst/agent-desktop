import type { Tool, ToolExecutionResult } from '@agent-desktop/tools';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
) => Promise<CommandOutput>;

/**
 * execFile 直接接收可执行文件和参数数组，不经过 shell 解析。
 * 这样路径中的空格或控制字符只会作为 FFmpeg 参数，不会变成额外命令。
 */
export const executeFileCommand: CommandExecutor = (command, args) => (
  new Promise((resolve, reject) => {
    execFile(command, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr });
        return;
      }

      if (error.code === 'ENOENT') {
        reject(new Error(`${command} not found in PATH`));
        return;
      }

      // FFmpeg 常把诊断写入 stderr；只保留末尾关键行，避免撑大 Session。
      const stderrLines = stderr.trim().split(/\r?\n/).filter((line) => line.length > 0);
      const detail = stderrLines.slice(-8).join('\n') || error.message;
      reject(new Error(`${command} failed: ${detail}`));
    });
  })
);

/** probe_media 返回给模型的稳定结构，不把完整 ffprobe JSON 暴露给 Session。 */
export interface MediaInfo {
  readonly duration: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorResult(error: unknown): ToolExecutionResult {
  return {
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
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

function videoCreated(outputPath: string): ToolExecutionResult {
  return { status: 'success', output: `Video created: ${outputPath}` };
}

/** ffconcat 是文件格式而不是 shell；这里只转义它自己的路径语法。 */
function concatFileLine(inputPath: string): string {
  const normalizedPath = inputPath.replace(/\\/g, '/');
  const escapedPath = normalizedPath.replace(/'/g, "'\\''");
  return `file '${escapedPath}'`;
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

  const format = isRecord(payload) && isRecord(payload.format) ? payload.format : {};
  const streams = isRecord(payload) && Array.isArray(payload.streams) ? payload.streams : [];
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
async function probeDuration(executeCommand: CommandExecutor, inputPath: string): Promise<number> {
  const { stdout } = await executeCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);
  const duration = parseMediaInfo(stdout).duration;
  if (duration === null || duration <= 0) {
    throw new Error('extract_video_frames requires a positive media duration');
  }
  return duration;
}

/** 使用 ffprobe 读取媒体容器和音视频流的基本信息。 */
export class ProbeMediaTool implements Tool {
  readonly name = 'probe_media';
  readonly description = '读取媒体文件的时长、画面尺寸和音视频编码信息';
  readonly inputSchema = {
    type: 'object',
    properties: { inputPath: { type: 'string' } },
    required: ['inputPath'],
    additionalProperties: false,
  };

  constructor(private readonly executeCommand: CommandExecutor = executeFileCommand) {}

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      ]);
      return { status: 'success', output: parseMediaInfo(stdout) };
    } catch (error) {
      return errorResult(error);
    }
  }
}

export interface ExtractedVideoFrame {
  readonly timestamp: number;
  readonly path: string;
}

export interface ExtractVideoFramesOutput {
  readonly duration: number;
  readonly frames: readonly ExtractedVideoFrame[];
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
    if (!isRecord(input)
      || typeof input.videoPath !== 'string'
      || typeof input.outputDir !== 'string') {
      return {
        status: 'error',
        message: 'extract_video_frames requires videoPath and outputDir to be strings',
      };
    }

    try {
      const duration = await probeDuration(this.executeCommand, input.videoPath);
      await mkdir(input.outputDir, { recursive: true });
      const frames: ExtractedVideoFrame[] = [];

      // 使用 1/7 到 6/7 的时间点，避开容易出现黑屏或片尾的首尾帧。
      for (let index = 1; index <= 6; index += 1) {
        const timestamp = (duration * index) / 7;
        const framePath = join(input.outputDir, `frame-${String(index).padStart(3, '0')}.jpg`);
        await this.executeCommand('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(timestamp),
          '-i',
          input.videoPath,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(640,iw)':-2",
          '-q:v',
          '2',
          framePath,
        ]);
        frames.push({ timestamp, path: framePath });
      }

      return { status: 'success', output: { duration, frames } satisfies ExtractVideoFramesOutput };
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      await this.executeCommand('ffmpeg', [
        '-y',
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
      ]);
      return videoCreated(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 使用 FFmpeg concat demuxer 按输入顺序拼接条件一致的视频。 */
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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

    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-desktop-ffmpeg-'));
      const concatListPath = join(temporaryDirectory, 'inputs.ffconcat');
      const inputPaths = input.inputPaths as string[];
      const concatList = [
        'ffconcat version 1.0',
        ...inputPaths.map(concatFileLine),
        '',
      ].join('\n');

      await writeFile(concatListPath, concatList, 'utf8');
      // concat demuxer 保留输入顺序；编码条件不兼容时让 FFmpeg 明确失败。
      await this.executeCommand('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input.outputPath,
      ]);
      return videoCreated(input.outputPath);
    } catch (error) {
      return errorResult(error);
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}

/** 保留视频画面，并用传入音频替换输出文件的声音。 */
export class AddAudioTool implements Tool {
  readonly name = 'add_audio';
  readonly description = '保留视频画面并使用传入音频，输出时长以视频为准';
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      await this.executeCommand('ffmpeg', [
        '-y',
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
      ]);
      return videoCreated(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 使用 FFmpeg subtitles filter 把外部 SRT 字幕永久烧录进视频画面。 */
export class AddSubtitlesTool implements Tool {
  readonly name = 'add_subtitles';
  readonly description = '将外部 SRT 字幕烧录到视频画面中';
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      await this.executeCommand('ffmpeg', [
        '-y',
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
      ]);
      return videoCreated(input.outputPath);
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
  readonly description = '将视频画面直接缩放到指定宽度和高度';
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      await this.executeCommand('ffmpeg', [
        '-y',
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
      ]);
      return videoCreated(input.outputPath);
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      await this.executeCommand('ffmpeg', [
        '-y',
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
      ]);
      return videoCreated(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}

/** 在 0.5～2.0 倍范围内同步调整视频时间戳与音频节奏。 */
export class SetSpeedTool implements Tool {
  readonly name = 'set_speed';
  readonly description = '在 0.5 到 2.0 倍范围内同步调整视频播放速度';
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

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      const audioProbe = await this.executeCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        input.inputPath,
      ]);
      const hasAudio = audioProbe.stdout.trim().length > 0;

      if (hasAudio) {
        // setpts 控制视频帧时间戳，atempo 控制音频节奏；同一倍率保持音视频同步。
        await this.executeCommand('ffmpeg', [
          '-y',
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
        ]);
      } else {
        // 无音轨时只改变视频时间戳，并显式禁止输出音频。
        await this.executeCommand('ffmpeg', [
          '-y',
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
        ]);
      }

      return videoCreated(input.outputPath);
    } catch (error) {
      return errorResult(error);
    }
  }
}
