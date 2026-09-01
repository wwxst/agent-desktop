import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@agent-desktop/tools';
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

/** 直接执行 whisper-cli，绕过 shell 并保留可注入的最小进程测试接缝。 */
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

      const stderrLines = stderr.trim().split(/\r?\n/).filter((line) => line.length > 0);
      const detail = stderrLines.slice(-8).join('\n') || error.message;
      reject(new Error(`${command} failed: ${detail}`));
    });
  })
);

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

  async execute(input: unknown): Promise<ToolResult> {
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
        // 普通 JSON 已提供 segment offsets；不使用包含无消费者 token 信息的 -ojf。
        await this.executeCommand(this.command, [
          '-m',
          this.modelPath,
          '-f',
          input.audioPath,
          '-l',
          'auto',
          '-np',
          '-oj',
          '-of',
          outputBase,
        ]);
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
