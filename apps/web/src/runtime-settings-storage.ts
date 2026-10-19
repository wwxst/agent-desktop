import type { RuntimeSettings } from '@agent-desktop/client';
import { getConversationCapability, getVisionCapability, MODEL_CAPABILITY_LABELS, resolveCatalogModel } from '@agent-desktop/client/model-capabilities';

const KEY = 'agent-desktop:web-runtime-settings';
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** 开发宿主只持久化脱敏配置；真实密钥仍只由 Desktop 安全存储负责。 */
export function loadWebRuntimeSettings(): RuntimeSettings | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !Array.isArray(value.modelProviders)
    || typeof value.memoryEnabled !== 'boolean' || typeof value.memoryFromToolChatsEnabled !== 'boolean' || typeof value.fallbackVisionEnabled !== 'boolean') throw new Error('网页模型配置无效。');
  if (value.theme !== undefined && !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('网页外观配置无效。');
  for (const provider of value.modelProviders) {
    if (!record(provider) || typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.displayName !== 'string' || !provider.displayName.trim() || typeof provider.baseUrl !== 'string'
      || !['chat-completions', 'responses'].includes(String(provider.protocol))
      || !record(provider.apiKey) || typeof provider.apiKey.configured !== 'boolean' || !Array.isArray(provider.models)) throw new Error('网页供应商配置无效。');
    for (const model of provider.models) {
      if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || typeof model.displayName !== 'string' || !model.displayName.trim() || !record(model.capabilities)) throw new Error('网页模型能力配置无效。');
      const capabilities = model.capabilities;
      if (MODEL_CAPABILITY_LABELS.some(([field]) => !['supported', 'unsupported', 'unknown'].includes(String(capabilities[field])))) throw new Error('网页模型能力配置无效。');
      // 本地存储也是外部边界；恢复时必须保留已确认的推理允许值，不能替模型选择强度。
      if (model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts)
        || model.reasoningEfforts.some(effort => typeof effort !== 'string' || !effort.trim())
        || new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length)) throw new Error('网页模型推理强度列表无效。');
      if (model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== 'string' || !model.reasoningEffort.trim()
        || capabilities.reasoning !== 'supported' || !Array.isArray(model.reasoningEfforts)
        || !model.reasoningEfforts.includes(model.reasoningEffort))) throw new Error('网页模型不支持所选推理强度。');
    }
  }
  const isReference = (reference: unknown) => record(reference) && typeof reference.providerId === 'string' && !!reference.providerId.trim() && typeof reference.modelId === 'string' && !!reference.modelId.trim();
  if ((value.conversationModel !== null && !isReference(value.conversationModel)) || (value.fallbackVisionModel !== null && !isReference(value.fallbackVisionModel))) throw new Error('网页模型选择无效。');
  const settings = value as unknown as RuntimeSettings;
  if (settings.conversationModel !== null) {
    const conversation = resolveCatalogModel(settings.modelProviders, settings.conversationModel);
    if (getConversationCapability(conversation.model, conversation.provider.protocol) !== 'supported') throw new Error('网页对话模型的文本或协议能力未确认支持。');
  }
  if (settings.fallbackVisionModel !== null) {
    const fallback = resolveCatalogModel(settings.modelProviders, settings.fallbackVisionModel);
    if (settings.fallbackVisionEnabled && (!fallback.provider.apiKey.configured || getVisionCapability(fallback.model, fallback.provider.protocol) !== 'supported')) throw new Error('网页备用视觉模型能力或密钥配置无效。');
  }
  return settings;
}
export function saveWebRuntimeSettings(settings: RuntimeSettings): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(settings));
}
