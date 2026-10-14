import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const VISION_MODEL = 'gpt-5.6-luna';

export interface AnalyzeImageInput {
  readonly path: string;
  readonly timestamp: number;
}

export interface AnalyzeImagesToolOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly protocol?: 'chat-completions' | 'responses';
  readonly maxOutputTokens?: number;
}

const VISUAL_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timestamp: { type: 'number' },
          description: { type: 'string' },
          subjects: { type: 'array', items: { type: 'string' } },
          actions: { type: 'array', items: { type: 'string' } },
          scene: { type: 'string' },
          visibleText: { type: 'array', items: { type: 'string' } },
        },
        required: ['timestamp', 'description', 'subjects', 'actions', 'scene', 'visibleText'],
      },
    },
  },
  required: ['summary', 'frames'],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnalyzeImageInput(value: unknown): value is AnalyzeImageInput {
  return isRecord(value)
    && typeof value.path === 'string'
    && Number.isFinite(value.timestamp);
}

/** 模型和 MCP 都是外部边界；完整字段及一一对应时间戳不能靠 json_schema 声明代替校验。 */
export function validateVisualAnalysis(value: unknown, images: readonly AnalyzeImageInput[]): unknown {
  if (!isRecord(value) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.frames)
    || value.frames.length !== images.length) throw new Error('Vision 结果缺少完整 summary 或逐图片 frames。');
  for (const [index, frame] of value.frames.entries()) {
    if (!isRecord(frame) || frame.timestamp !== images[index]!.timestamp || typeof frame.description !== 'string'
      || !frame.description.trim() || typeof frame.scene !== 'string'
      || !['subjects', 'actions', 'visibleText'].every(key => Array.isArray(frame[key]) && frame[key].every((item: unknown) => typeof item === 'string'))) {
      throw new Error('Vision 结果字段不完整或图片时间戳不匹配。');
    }
  }
  return value;
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

/** 视觉模型只观察画面；时间戳用于让返回的 frame 描述继续对应原视频位置。 */
function observationPrompt(images: readonly AnalyzeImageInput[]): string {
  const frameList = images.map((image, index) => (
    `Frame ${index + 1} is sampled at ${image.timestamp} seconds.`
  )).join(' ');
  return [
    'Analyze these sampled video frames only.',
    'Describe the main subjects, scene, visible objects, actions, camera content, and visible text in each frame.',
    'Return the requested structured JSON observation. Do not decide how to edit the video, call FFmpeg, or create an editing plan.',
    frameList,
  ].join(' ');
}

/** Responses API 的原始结果没有 SDK 的 output_text 便捷字段，需要从 message content 中读取。 */
function readOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error('OpenAI Vision API response is missing output_text');
  }
  if (payload.status !== undefined && payload.status !== 'completed') throw new Error(`视觉模型未完成：${String(payload.status)}`);

  const texts: string[] = [];
  for (const outputItem of payload.output) {
    if (!isRecord(outputItem) || outputItem.type !== 'message' || !Array.isArray(outputItem.content)) {
      continue;
    }
    for (const contentItem of outputItem.content) {
      if (isRecord(contentItem)
        && contentItem.type === 'output_text'
        && typeof contentItem.text === 'string') {
        texts.push(contentItem.text);
      }
    }
  }

  if (texts.length === 0) {
    throw new Error('OpenAI Vision API response is missing output_text');
  }
  return texts.join('\n');
}

/** 读取本地 JPG / PNG 并按文件类型生成图片 data URL，不上传到 Files API。 */
async function imageDataUrl(path: string): Promise<{ url: string; size: number }> {
  const extension = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('Vision 只支持 JPG/PNG 图片。');
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw new Error('Vision 单张图片必须为非空文件且不超过 10 MiB。');
  const image = await readFile(path);
  // 检查实际编码及头部尺寸，阻止将其它本地文件改扩展名后上传；不声称代替完整图片解码。
  let width = 0; let height = 0;
  if (extension === '.png') {
    if (image.length < 45 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || image.toString('ascii', 12, 16) !== 'IHDR' || image.readUInt32BE(8) !== 13) throw new Error('Vision PNG 图片损坏或编码无效。');
    width = image.readUInt32BE(16); height = image.readUInt32BE(20);
    let offset = 8; let ended = false;
    while (offset + 12 <= image.length) {
      const length = image.readUInt32BE(offset);
      if (offset + length + 12 > image.length) break;
      if (image.toString('ascii', offset + 4, offset + 8) === 'IEND' && length === 0 && offset + 12 === image.length) ended = true;
      offset += length + 12;
    }
    if (!ended) throw new Error('Vision PNG 图片损坏或编码无效。');
  } else {
    if (image.length < 12 || image.readUInt16BE(0) !== 0xffd8 || image.readUInt16BE(image.length - 2) !== 0xffd9) throw new Error('Vision JPG 图片损坏或编码无效。');
    let offset = 2;
    while (offset + 4 <= image.length && image[offset] === 0xff) {
      const marker = image[offset + 1]!; const length = image.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > image.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = image.readUInt16BE(offset + 5); width = image.readUInt16BE(offset + 7); }
      if (marker === 0xda) break;
      offset += 2 + length;
    }
  }
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('Vision 图片尺寸无效或超过 8192 边长 / 4000 万像素预算。');
  const mime = extension === '.png' ? 'image/png' : 'image/jpeg';
  return { url: `data:${mime};base64,${image.toString('base64')}`, size: image.length };
}

export class AnalyzeImagesTool implements Tool {
  readonly name = 'analyze_images';
  readonly description = '使用本次配置的视觉模型分析一至六张 JPG/PNG 图片或视频帧并返回结构化描述';
  readonly inputSchema = {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            timestamp: { type: 'number' },
          },
          required: ['path', 'timestamp'],
          additionalProperties: false,
        },
      },
    },
    required: ['images'],
    additionalProperties: false,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly options: AnalyzeImagesToolOptions;

  public constructor(options: AnalyzeImagesToolOptions) {
    this.options = options;
    this.apiKey = options.apiKey;
    // 统一去掉末尾斜线，让官方地址与 OpenAI-compatible 中转站使用同一拼接规则。
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async execute(input: unknown, { signal }: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)
      || !Array.isArray(input.images)
      || (input.images.length < 1 || input.images.length > 6)) {
      return { status: 'error', message: 'analyze_images requires between 1 and 6 images' };
    }
    if (!input.images.every(isAnalyzeImageInput)) {
      return {
        status: 'error',
        message: 'analyze_images requires image path strings and finite timestamps',
      };
    }
    if (this.apiKey.trim().length === 0) {
      return { status: 'error', message: 'OPENAI_API_KEY is required' };
    }

    const images = input.images as AnalyzeImageInput[];

    try {
      signal?.throwIfAborted();
      const endpoint = new URL(this.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Vision API 地址必须是无凭证、查询参数及片段的 HTTP(S) 地址。');
      // DeepSeek 官方 Chat 协议尚不接收 json_schema；按已验证协议使用 JSON 模式，不按错误重试其它模型。
      const chat = this.options.protocol === 'chat-completions';
      const deepseekJson = chat && endpoint.hostname === 'api.deepseek.com';
      const content: Array<Record<string, unknown>> = [
        { type: 'input_text', text: deepseekJson ? `${observationPrompt(images)} JSON must match this schema: ${JSON.stringify(VISUAL_ANALYSIS_SCHEMA)}` : observationPrompt(images) },
      ];
      let totalSize = 0;
      for (const [index, image] of images.entries()) {
        signal?.throwIfAborted();
        const encoded = await imageDataUrl(image.path);
        totalSize += encoded.size;
        if (totalSize > 20 * 1024 * 1024) throw new Error('Vision 图片总量不能超过 20 MiB。');
        // 每张图片紧跟对应的顺序标记，保证模型能把描述映射回 timestamp。
        content.push({ type: 'input_text', text: `Image ${index + 1} corresponds to ${image.timestamp} seconds.` });
        content.push({
          type: 'input_image',
          image_url: encoded.url,
          detail: 'low',
        });
      }

      const format = { type: 'json_schema', name: 'visual_media_analysis', strict: true, schema: VISUAL_ANALYSIS_SCHEMA };
      const body = JSON.stringify(chat ? {
        model: this.options.model ?? VISION_MODEL,
        messages: [{ role: 'user', content: content.map(part => part.type === 'input_image'
          ? { type: 'image_url', image_url: { url: part.image_url, detail: part.detail } } : { type: 'text', text: part.text }) }],
        response_format: deepseekJson ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: format.name, strict: format.strict, schema: format.schema } },
        ...(deepseekJson ? { thinking: { type: 'disabled' } } : {}),
        ...(this.options.maxOutputTokens === undefined ? {} : { max_tokens: this.options.maxOutputTokens }),
      } : {
        model: this.options.model ?? VISION_MODEL, input: [{ role: 'user', content }], text: { format },
        ...(this.options.maxOutputTokens === undefined ? {} : { max_output_tokens: this.options.maxOutputTokens }),
      });
      if (Buffer.byteLength(body) > 30 * 1024 * 1024) throw new Error('Vision 请求不能超过 30 MiB。');
      const timeout = AbortSignal.timeout(50_000);
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const response = await fetch(`${this.baseUrl}/${chat ? 'chat/completions' : 'responses'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body, signal: requestSignal, redirect: 'error',
      });

      if (!response.ok) {
        throw new Error(`OpenAI Vision API request failed: ${response.status}`);
      }

      let parsed: unknown;
      try {
        const payload: unknown = await response.json();
        if (chat) {
          if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])
            || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== 'string') throw new Error('OpenAI Vision API response is missing message content');
          if (payload.choices[0].finish_reason !== 'stop') throw new Error(`视觉模型未完成：${String(payload.choices[0].finish_reason)}`);
          parsed = JSON.parse(payload.choices[0].message.content) as unknown;
        } else parsed = JSON.parse(readOutputText(payload)) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('OpenAI Vision API returned invalid JSON');
        throw error;
      }

      // JSON 模式只保证可解析；统一验证完整观察和逐帧时间戳，不交付空观察。
      return { status: 'success', output: validateVisualAnalysis(parsed, images) };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'TimeoutError') return { status: 'error', message: 'Vision API 请求超过 50 秒预算。' };
      return errorResult(error);
    }
  }
}
