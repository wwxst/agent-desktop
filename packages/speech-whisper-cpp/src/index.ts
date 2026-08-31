import { execFile } from 'node:child_process';
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
  return typeof value === 'object' && value !== null;
}

function errorResult(error: unknown): ToolResult {
  // whisper-cli 是真实进程边界；标准 Error 转成 Tool 失败，程序错误继续向上暴露。
  if (!(error instanceof Error)) throw error;
  return { status: 'error', message: error.message };
}

/** 通过 stdout 直接取得识别文本，不创建临时 txt 或引入额外生命周期。 */
export class TranscribeAudioTool implements Tool {
  readonly name = 'transcribe_audio';
  readonly description = '使用本机 whisper.cpp 将标准 WAV 音频转录为文字';
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
      // -l auto 保留多语言识别，-np/-nt 让 stdout 只承载当前 MVP 需要的纯文字。
      const { stdout } = await this.executeCommand(this.command, [
        '-m',
        this.modelPath,
        '-f',
        input.audioPath,
        '-l',
        'auto',
        '-np',
        '-nt',
      ]);
      const transcript = stdout.trim();
      if (transcript.length === 0) {
        return { status: 'error', message: 'Whisper produced an empty transcript' };
      }
      return { status: 'success', output: transcript };
    } catch (error) {
      return errorResult(error);
    }
  }
}
