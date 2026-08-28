import type { Tool, ToolExecutionResult } from '@agent-desktop/tools';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
