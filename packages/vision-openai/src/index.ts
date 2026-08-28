import { readFile } from 'node:fs/promises';
import type { Tool, ToolExecutionResult } from '@agent-desktop/tools';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const VISION_MODEL = 'gpt-5.6-luna';

export interface AnalyzeImageInput {
  readonly path: string;
  readonly timestamp: number;
}

export interface VisualFrameAnalysis {
  readonly timestamp: number;
  readonly description: string;
  readonly subjects: readonly string[];
  readonly actions: readonly string[];
  readonly scene: string;
  readonly visibleText: readonly string[];
}

export interface VisualAnalysis {
  readonly summary: string;
  readonly frames: readonly VisualFrameAnalysis[];
}

export interface AnalyzeImagesToolOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
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

function errorResult(error: unknown): ToolExecutionResult {
  return {
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
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

/** 读取本地 JPG 并转成 Responses API 可直接接收的 data URL，不上传到 Files API。 */
async function imageDataUrl(path: string): Promise<string> {
  const image = await readFile(path);
  return `data:image/jpeg;base64,${image.toString('base64')}`;
}

export class AnalyzeImagesTool implements Tool {
  readonly name = 'analyze_images';
  readonly description = '使用 OpenAI Vision 分析视频抽取的 JPG 画面并返回结构化描述';
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

  public constructor(options: AnalyzeImagesToolOptions) {
    this.apiKey = options.apiKey;
    // 统一去掉末尾斜线，让官方地址与 OpenAI-compatible 中转站使用同一拼接规则。
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async execute(input: unknown): Promise<ToolExecutionResult> {
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
      const content: Array<Record<string, unknown>> = [
        { type: 'input_text', text: observationPrompt(images) },
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

      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          input: [{ role: 'user', content }],
          text: {
            format: {
              type: 'json_schema',
              name: 'visual_media_analysis',
              strict: true,
              schema: VISUAL_ANALYSIS_SCHEMA,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI Vision API request failed: ${response.status}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(readOutputText(await response.json())) as unknown;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('OpenAI Vision API response is missing')) {
          throw error;
        }
        throw new Error('OpenAI Vision API returned invalid JSON');
      }

      return { status: 'success', output: parsed };
    } catch (error) {
      return errorResult(error);
    }
  }
}
