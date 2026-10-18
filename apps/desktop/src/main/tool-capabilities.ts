import { resolveToolContract, type Tool } from '@agent-desktop/tools';

/**
 * 从本轮最终注册的工具收集模型可见能力；未知合约保持为 `unknown`，避免旧工具消失。
 * 视觉能力同时要求宿主已经注册 Vision 工具并解析出可用的视觉路由。
 */
export function collectToolCapabilities(
  tools: readonly Tool[],
  visionTool: Tool | undefined,
  visionUnavailableReason: string | undefined,
): readonly string[] {
  const capabilities = new Set(tools.map(tool => resolveToolContract(tool).capability));
  if (visionTool === undefined || visionUnavailableReason !== undefined) capabilities.delete('vision');
  return [...capabilities];
}
