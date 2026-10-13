import type { ModelCapabilityStatus, RuntimeModelCapabilities, RuntimeModelDefinition, RuntimeModelProvider, RuntimeModelReference, RuntimeSettings } from './api.js';

export const UNKNOWN_MODEL_CAPABILITIES: RuntimeModelCapabilities = { textInput: 'unknown', textOutput: 'unknown', imageInput: 'unknown', imageUnderstanding: 'unknown' };

/** 任一必要能力明确不支持即不可用；未确认不能被当作支持。 */
function combinedCapability(...statuses: readonly ModelCapabilityStatus[]): ModelCapabilityStatus {
  return statuses.includes('unsupported') ? 'unsupported' : statuses.includes('unknown') ? 'unknown' : 'supported';
}
export function getConversationCapability(model: Pick<RuntimeModelDefinition, 'capabilities'>): ModelCapabilityStatus {
  return combinedCapability(model.capabilities.textInput, model.capabilities.textOutput);
}
export function getVisionCapability(model: Pick<RuntimeModelDefinition, 'capabilities'>): ModelCapabilityStatus {
  return combinedCapability(model.capabilities.textInput, model.capabilities.imageInput, model.capabilities.imageUnderstanding, model.capabilities.textOutput);
}
export function resolveCatalogModel(providers: readonly RuntimeModelProvider[], reference: RuntimeModelReference) {
  const provider = providers.find(item => item.id === reference.providerId);
  const model = provider?.models.find(item => item.id === reference.modelId);
  if (provider === undefined || model === undefined) throw new Error('当前使用的模型不在目录中，请先切换模型再删除。');
  return { provider, model };
}
export type VisionModelRoute = { readonly available: true; readonly provider: RuntimeModelProvider; readonly model: RuntimeModelDefinition; readonly source: 'conversation' | 'fallback' } | { readonly available: false; readonly reason: string };

/** 路由只解析能力与显式配置，不接收请求异常，因此超时或鉴权错误不会触发备用。 */
export function resolveVisionModel(settings: Pick<RuntimeSettings, 'modelProviders' | 'conversationModel' | 'fallbackVisionModel' | 'fallbackVisionEnabled'>): VisionModelRoute {
  const main = resolveCatalogModel(settings.modelProviders, settings.conversationModel);
  const capability = getVisionCapability(main.model);
  if (capability === 'supported') return main.provider.apiKey.configured
    ? { available: true, ...main, source: 'conversation' } : { available: false, reason: '当前模型未配置 API 密钥，视觉不可用。' };
  if (capability === 'unknown') return { available: false, reason: '当前模型的视觉能力未知，请在模型设置中确认能力；不会自动调用备用模型。' };
  if (!settings.fallbackVisionEnabled || settings.fallbackVisionModel === null) return { available: false, reason: '当前模型明确不支持视觉理解，且未启用备用视觉模型。' };
  const fallback = resolveCatalogModel(settings.modelProviders, settings.fallbackVisionModel);
  if (!fallback.provider.apiKey.configured || getVisionCapability(fallback.model) !== 'supported') return { available: false, reason: '备用视觉模型的密钥或视觉能力未配置有效。' };
  return { available: true, ...fallback, source: 'fallback' };
}
