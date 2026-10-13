import type { RuntimeSettings } from '@agent-desktop/client';
import { resolveCatalogModel } from '@agent-desktop/client/model-capabilities';

const KEY = 'agent-desktop:web-runtime-settings';
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** 开发宿主只持久化脱敏配置；真实密钥仍只由 Desktop 安全存储负责。 */
export function loadWebRuntimeSettings(): RuntimeSettings | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !Array.isArray(value.modelProviders) || !record(value.whisper)
    || typeof value.whisper.modelPath !== 'string' || typeof value.whisper.cliPath !== 'string'
    || typeof value.memoryEnabled !== 'boolean' || typeof value.memoryFromToolChatsEnabled !== 'boolean' || typeof value.fallbackVisionEnabled !== 'boolean') throw new Error('网页模型配置无效。');
  if (value.theme !== undefined && !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('网页外观配置无效。');
  for (const provider of value.modelProviders) {
    if (!record(provider) || typeof provider.id !== 'string' || typeof provider.displayName !== 'string' || typeof provider.baseUrl !== 'string'
      || !['chat-completions', 'responses'].includes(String(provider.protocol)) || typeof provider.builtin !== 'boolean'
      || !record(provider.apiKey) || typeof provider.apiKey.configured !== 'boolean' || !Array.isArray(provider.models)) throw new Error('网页供应商配置无效。');
    for (const model of provider.models) {
      if (!record(model) || typeof model.id !== 'string' || typeof model.displayName !== 'string' || !record(model.capabilities)) throw new Error('网页模型能力配置无效。');
      const capabilities = model.capabilities;
      if (['textInput', 'textOutput', 'imageInput', 'imageUnderstanding'].some(field => !['supported', 'unsupported', 'unknown'].includes(String(capabilities[field])))) throw new Error('网页模型能力配置无效。');
    }
  }
  const isReference = (reference: unknown) => record(reference) && typeof reference.providerId === 'string' && typeof reference.modelId === 'string';
  if (!isReference(value.conversationModel) || (value.fallbackVisionModel !== null && !isReference(value.fallbackVisionModel))) throw new Error('网页模型选择无效。');
  const settings = value as unknown as RuntimeSettings;
  resolveCatalogModel(settings.modelProviders, settings.conversationModel);
  if (settings.fallbackVisionModel !== null) resolveCatalogModel(settings.modelProviders, settings.fallbackVisionModel);
  return settings;
}
export function saveWebRuntimeSettings(settings: RuntimeSettings): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(settings));
}
