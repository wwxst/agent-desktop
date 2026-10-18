import { extname } from 'node:path';
import { executePreparedAction, resolveToolContract, ToolExecutionError, type Tool, type ToolPreparation } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError } from '@agent-desktop/session';
import { validateVisualAnalysis, type AnalyzeImageInput } from '@agent-desktop/vision-openai';
import { authorizeMediaInput, type ProbeFileAccess } from './ffmpeg-tool.js';

export const VISION_TOOLS = new Set(['analyze_images']);
export type { ProbeFileAccess as VisionFileAccess } from './ffmpeg-tool.js';

/** 图片只按宿主目录、附件和已有候选事实授权；同一适配器供语义验收调用。 */
export function adaptVisionTool(tool: Tool, access: ProbeFileAccess | undefined): Tool {
  const canPrepare = tool.prepare !== undefined || resolveToolContract(tool).approvalRequirement === 'none';
  return { name: 'analyze_images', description: tool.description, inputSchema: tool.inputSchema,
    ...(tool.nestedToolNames === undefined ? {} : { nestedToolNames: tool.nestedToolNames }),
    ...(tool.sanitizeInput === undefined ? {} : { sanitizeInput: tool.sanitizeInput }),
    executionBoundary: tool.executionBoundary ?? 'opaque',
    contract: { capability: 'vision', riskLevel: 'external', parallelSafety: 'serial', timeoutMs: 120_000,
      cancellation: 'signal', workspaceScope: 'session', approvalRequirement: 'policy' },
    ...(canPrepare ? { async prepare(input: unknown, context): Promise<ToolPreparation> {
      let invoked = false;
      const failure = (error: unknown): ToolResult => {
        if (error instanceof SessionPersistenceError) throw error;
        context.signal?.throwIfAborted();
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        // 上传后的观察损坏仍然跨过外部边界，不能降级为可安全重放的普通校验错误。
        return { status: 'error', message: error.message,
          failureKind: error instanceof ToolExecutionError ? error.failureKind : invoked ? 'unknown-outcome' : 'permanent' };
      };
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
        const prepared = tool.prepare !== undefined ? await tool.prepare({ images }, context)
          : { requestApproval: async () => true, execute: () => tool.execute({ images }, context) };
        if ('status' in prepared) return prepared;
        return { requestApproval: () => prepared.requestApproval(), async execute() {
          try {
            invoked = true;
            const result = await prepared.execute();
            context.signal?.throwIfAborted();
            const raw = result.output as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
            if (result.status === 'error') return { ...result, message: raw?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n') || result.message };
            const value = raw?.structuredContent ?? JSON.parse(raw?.content?.find(entry => entry.type === 'text')?.text ?? 'null') as unknown;
            return { status: 'success', output: validateVisualAnalysis(value, images) };
          } catch (error) { return failure(error); }
        } };
      } catch (error) { return failure(error); }
    } } : {}),
    async execute(input, context) { return this.prepare === undefined ? { status: 'error', failureKind: 'permanent', message: `工具 ${tool.name} 缺少已准备操作契约。` } : executePreparedAction(await this.prepare(input, context), context); },
  };
}
