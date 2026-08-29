import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Tool } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

/** Speech Tool 只接收当前真实调用需要的鉴权和地址配置。 */
export interface TranscribeAudioToolOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorResult(error: unknown): ToolResult {
  // 外部文件和 HTTP 操作的标准 Error 可转成 Tool 失败；程序错误继续向上暴露。
  if (!(error instanceof Error)) throw error;

  return { status: 'error', message: error.message };
}

/**
 * 读取 MP3 后直接构造原生 multipart 请求；transcription 是 Tool，因为它只提供转录能力。
 */
export class TranscribeAudioTool implements Tool {
  readonly name = 'transcribe_audio';
  readonly description = '将 MP3 音频转录为对白、旁白和口播文字';
  readonly inputSchema = {
    type: 'object',
    properties: { audioPath: { type: 'string' } },
    required: ['audioPath'],
    additionalProperties: false,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(options: TranscribeAudioToolOptions) {
    this.apiKey = options.apiKey;
    // 去掉末尾斜线，保证官方地址和兼容中转地址只产生一个 endpoint 拼接结果。
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async execute(input: unknown): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.audioPath !== 'string') {
      return { status: 'error', message: 'transcribe_audio requires audioPath to be a string' };
    }

    if (!input.audioPath.toLowerCase().endsWith('.mp3')) {
      return { status: 'error', message: 'transcribe_audio only supports .mp3 audioPath' };
    }

    if (this.apiKey.trim().length === 0) {
      return { status: 'error', message: 'OPENAI_API_KEY is required' };
    }

    try {
      // readFile 本身就是文件存在性和可读性的权威操作，不重复做 existsSync/stat/access 检查。
      const audio = await readFile(input.audioPath);
      const form = new FormData();
      form.append(
        'file',
        new Blob([audio], { type: 'audio/mpeg' }),
        basename(input.audioPath),
      );
      form.append('model', TRANSCRIPTION_MODEL);

      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        // 不手工设置 multipart Content-Type，让 fetch 根据 FormData 自动生成 boundary。
        body: form,
      });

      if (!response.ok) {
        throw new Error(`OpenAI transcription request failed: ${response.status}`);
      }

      const payload = await response.json() as unknown;
      if (!isRecord(payload) || typeof payload.text !== 'string') {
        throw new Error('OpenAI transcription response is missing text');
      }

      return { status: 'success', output: payload.text };
    } catch (error) {
      return errorResult(error);
    }
  }
}
