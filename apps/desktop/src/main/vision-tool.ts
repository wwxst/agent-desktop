import { extname } from 'node:path';
import type { Tool } from '@agent-desktop/tools';
import { validateVisualAnalysis, type AnalyzeImageInput } from '@agent-desktop/vision-openai';
import { authorizeMediaInput, type ProbeFileAccess } from './ffmpeg-tool.js';

export const VISION_TOOLS = new Set(['analyze_images']);
export type { ProbeFileAccess as VisionFileAccess } from './ffmpeg-tool.js';

/** 图片只按宿主目录、附件和已有候选事实授权；同一适配器供语义验收调用。 */
export function adaptVisionTool(tool: Tool, access: ProbeFileAccess | undefined): Tool {
  return { name: 'analyze_images', description: tool.description, inputSchema: tool.inputSchema,
    async execute(input, context) {
      try {
        context.signal?.throwIfAborted();
        if (typeof input !== 'object' || input === null || !('images' in input) || !Array.isArray(input.images)
          || input.images.length < 1 || input.images.length > 6) throw new Error('Vision 需要一至六张本地图片。');
        const images: AnalyzeImageInput[] = [];
        for (const image of input.images) {
          if (typeof image !== 'object' || image === null || typeof image.path !== 'string'
            || typeof image.timestamp !== 'number' || !Number.isFinite(image.timestamp)) throw new Error('Vision 图片需要 path 和有限 timestamp。');
          const path = await authorizeMediaInput({ inputPath: image.path }, access, true);
          if (!['.jpg', '.jpeg', '.png'].includes(extname(path).toLowerCase())) throw new Error('Vision 只支持 JPG/PNG 图片。');
          images.push({ path, timestamp: image.timestamp });
        }
        const result = await tool.execute({ images }, context);
        context.signal?.throwIfAborted();
        const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
        if (result.status === 'error') return { status: 'error', message: raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n') || result.message };
        const value = raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
        return { status: 'success', output: validateVisualAnalysis(value, images) };
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return { status: 'error', message: error.message };
      }
    },
  };
}
