import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';

const DEFAULT_COMMAND = 'whisper-cli';

export interface TranscribeAudioToolOptions {
  readonly modelPath: string;
  readonly command?: string;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandExecutor = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandOutput>;

interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TranscriptionResult {
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
}

/** 真实 Small 模型会给全零 PCM 静音生成文字；只排除能确定没有采样信号的标准 PCM16。 */
async function rejectSilentPcm(path: string, signal?: AbortSignal): Promise<void> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(16);
    if ((await file.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return;
    const size = (await file.stat()).size;
    let pcm16 = false;
    for (let position = 12; position + 8 <= size;) {
      signal?.throwIfAborted();
      if ((await file.read(header, 0, 8, position)).bytesRead !== 8) return;
      const kind = header.toString('ascii', 0, 4); const length = header.readUInt32LE(4);
      position += 8;
      if (position + length > size) return; // 损坏 WAV 交给原进程报告，不能把残片识别为静音。
      if (kind === 'fmt ' && length >= 16) {
        await file.read(header, 0, 16, position);
        pcm16 = header.readUInt16LE(0) === 1 && header.readUInt16LE(14) === 16;
      }
      if (kind === 'data' && pcm16 && length > 0) {
        const samples = Buffer.alloc(64 * 1024);
        for (let offset = 0; offset < length;) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(samples, 0, Math.min(samples.length, length - offset), position + offset);
          if (bytesRead === 0) return;
          if (samples.subarray(0, bytesRead).some(byte => byte !== 0)) return;
          offset += bytesRead;
        }
        throw new Error('Whisper 输入为全零 PCM 静音，没有可转录语音。');
      }
      position += length + length % 2;
    }
  } finally { await file.close(); }
}

/** 直接执行 whisper-cli，绕过 shell 并保留可注入的最小进程测试接缝。 */
export const executeFileCommand: CommandExecutor = async (command, args, signal) => {
  const audioIndex = args.indexOf('-f');
  if (args.includes('-m') && audioIndex >= 0) await rejectSilentPcm(args[audioIndex + 1]!, signal);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { child.kill(); };
    const processArgs = [...args];
    const modelIndex = processArgs.indexOf('-m');
    let cwd: string | undefined;
    if (process.platform === 'win32' && modelIndex >= 0) {
      // 官方 Windows 构建在含中文的绝对模型路径上崩溃；相对模型名可正常加载。
      const model = resolvePath(processArgs[modelIndex + 1]!);
      cwd = dirname(model);
      processArgs[modelIndex + 1] = basename(model);
      for (const flag of ['-f', '-of']) {
        const index = processArgs.indexOf(flag);
        if (index >= 0) processArgs[index + 1] = resolvePath(processArgs[index + 1]!);
      }
      if (dirname(command) !== '.') command = resolvePath(command);
    }
    const child = execFile(command, processArgs, { windowsHide: true, ...(cwd === undefined ? {} : { cwd }) }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', stop);
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
        reject(new Error(`${command} not found in PATH`));
        return;
      }

      const stderrLines = stderr.trim().split(/\r?\n/).filter((line) => line.length > 0);
      const detail = stderrLines.slice(-8).join('\n') || error.message;
      reject(new Error(`${command} failed: ${detail}`));
    });
    if (signal !== undefined) {
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只解析当前业务消费的官方 JSON 字段，损坏的外部进程输出直接失败。 */
function parseWhisperJson(contents: string): TranscriptionResult {
  let root: unknown;
  try {
    root = JSON.parse(contents);
  } catch {
    throw new Error('Whisper produced invalid JSON');
  }

  if (!isRecord(root)) throw new Error('Whisper JSON root must be an object');
  if (!Array.isArray(root.transcription)) {
    throw new Error('Whisper JSON transcription must be an array');
  }

  const segments: TranscriptSegment[] = [];
  for (const [index, value] of root.transcription.entries()) {
    if (!isRecord(value)) throw new Error(`Whisper JSON segment ${index} must be an object`);
    if (typeof value.text !== 'string') {
      throw new Error(`Whisper JSON segment ${index} text must be a string`);
    }
    if (!isRecord(value.offsets)) {
      throw new Error(`Whisper JSON segment ${index} offsets must be an object`);
    }

    const from = value.offsets.from;
    const to = value.offsets.to;
    if (typeof from !== 'number' || !Number.isFinite(from)
      || typeof to !== 'number' || !Number.isFinite(to)) {
      throw new Error(`Whisper JSON segment ${index} offsets.from and offsets.to must be finite numbers`);
    }
    if (from < 0 || to < from) {
      throw new Error(`Whisper JSON segment ${index} offsets must satisfy 0 <= from <= to`);
    }

    const text = value.text.trim();
    if (text.length === 0) continue;
    // whisper.cpp offsets 使用毫秒；Tool 在外部边界转换为 Agent 使用的秒。
    segments.push({ start: from / 1000, end: to / 1000, text });
  }

  if (segments.length === 0) throw new Error('Whisper produced an empty transcript');
  return {
    text: segments.map((segment) => segment.text).join(' '),
    segments,
  };
}

function errorResult(error: unknown): ToolResult {
  // whisper-cli 是真实进程边界；标准 Error 转成 Tool 失败，程序错误继续向上暴露。
  if (!(error instanceof Error)) throw error;
  if (error.name === 'AbortError') throw error;
  return { status: 'error', message: error.message };
}

/** 读取 whisper.cpp 官方 JSON，返回完整文字和 segment-level 时间轴。 */
export class TranscribeAudioTool implements Tool {
  readonly name = 'transcribe_audio';
  readonly description = '使用本机 whisper.cpp 将标准 WAV 音频转录为文字和段落时间轴';
  readonly inputSchema = {
    type: 'object',
    properties: { audioPath: { type: 'string' } },
    required: ['audioPath'],
    additionalProperties: false,
  };

  private readonly modelPath: string;
  private readonly command: string;
  private readonly executeCommand: CommandExecutor;

  public constructor(
    options: TranscribeAudioToolOptions,
    executeCommand: CommandExecutor = executeFileCommand,
  ) {
    if (options.modelPath.trim().length === 0) throw new Error('modelPath is required');
    this.modelPath = options.modelPath;
    this.command = options.command ?? DEFAULT_COMMAND;
    this.executeCommand = executeCommand;
  }

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    signal?.throwIfAborted();
    if (!isRecord(input) || typeof input.audioPath !== 'string') {
      return { status: 'error', message: 'transcribe_audio requires audioPath to be a string' };
    }

    if (!input.audioPath.toLowerCase().endsWith('.wav')) {
      return { status: 'error', message: 'transcribe_audio only supports .wav audioPath' };
    }

    try {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-desktop-whisper-'));
      const outputBase = join(temporaryDirectory, 'transcript');
      try {
        let audioPath = input.audioPath;
        // 官方 Windows 程序拒绝超过传统长度的文件名；只暂存这个已授权输入，随本次调用清理。
        if (process.platform === 'win32' && resolvePath(audioPath).length >= 260) {
          audioPath = join(temporaryDirectory, 'input.wav');
          await copyFile(input.audioPath, audioPath);
          signal?.throwIfAborted();
        }
        // 普通 JSON 已提供 segment offsets；不使用包含无消费者 token 信息的 -ojf。
        await this.executeCommand(this.command, [
          '-m',
          this.modelPath,
          '-f',
          audioPath,
          '-l',
          'auto',
          '-np',
          '-oj',
          '-of',
          outputBase,
        ], ...(signal === undefined ? [] : [signal]));
        signal?.throwIfAborted();
        const json = await readFile(`${outputBase}.json`, 'utf8');
        return { status: 'success', output: parseWhisperJson(json) };
      } finally {
        // 只清理本次调用创建的目录，不扫描或管理其他临时资源。
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      return errorResult(error);
    }
  }
}
