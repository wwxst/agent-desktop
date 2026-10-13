import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const VISION_MODEL = 'gpt-5.6-luna';

interface AnalyzeImageInput {
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
async function imageDataUrl(path: string): Promise<string> {
  const image = await readFile(path);
  const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${image.toString('base64')}`;
}

export class AnalyzeImagesTool implements Tool {
  readonly name = 'analyze_images';
  readonly description = '使用本次配置的视觉模型分析视频抽取的 JPG / PNG 画面并返回结构化描述';
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
    // DeepSeek 官方 Chat 协议尚不接收 json_schema；按已验证协议使用 JSON 模式，不按错误重试其它模型。
    const chat = this.options.protocol === 'chat-completions';
    const deepseekJson = chat && new URL(this.baseUrl).hostname === 'api.deepseek.com';

    try {
      const content: Array<Record<string, unknown>> = [
        { type: 'input_text', text: deepseekJson ? `${observationPrompt(images)} JSON must match this schema: ${JSON.stringify(VISUAL_ANALYSIS_SCHEMA)}` : observationPrompt(images) },
      ];
      for (const [index, image] of images.entries()) {
        // 每张图片紧跟对应的顺序标记，保证模型能把描述映射回 timestamp。
        content.push({ type: 'input_text', text: `Image ${index + 1} corresponds to ${image.timestamp} seconds.` });
        content.push({
          type: 'input_image',
          image_url: await imageDataUrl(image.path),
          detail: 'low',
        });
      }

      const format = { type: 'json_schema', name: 'visual_media_analysis', strict: true, schema: VISUAL_ANALYSIS_SCHEMA };
      const response = await fetch(`${this.baseUrl}/${chat ? 'chat/completions' : 'responses'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chat ? {
          model: this.options.model ?? VISION_MODEL,
          messages: [{ role: 'user', content: content.map(part => part.type === 'input_image'
            ? { type: 'image_url', image_url: { url: part.image_url, detail: part.detail } } : { type: 'text', text: part.text }) }],
          response_format: deepseekJson ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: format.name, strict: format.strict, schema: format.schema } },
          ...(deepseekJson ? { thinking: { type: 'disabled' } } : {}),
          ...(this.options.maxOutputTokens === undefined ? {} : { max_tokens: this.options.maxOutputTokens }),
        } : {
          model: this.options.model ?? VISION_MODEL, input: [{ role: 'user', content }], text: { format },
          ...(this.options.maxOutputTokens === undefined ? {} : { max_output_tokens: this.options.maxOutputTokens }),
        }),
        ...(signal === undefined ? {} : { signal }),
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

      // JSON 模式只保证可解析；观察结构缺失或漏帧必须保留失败语义，不能交付空观察。
      if (!isRecord(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()
        || !Array.isArray(parsed.frames) || parsed.frames.length !== images.length
        || !parsed.frames.every(frame => isRecord(frame) && Number.isFinite(frame.timestamp)
          && typeof frame.description === 'string' && !!frame.description.trim())) {
        throw new Error('Vision API returned incomplete frame observations');
      }

      return { status: 'success', output: parsed };
    } catch (error) {
      return errorResult(error);
    }
  }
}
