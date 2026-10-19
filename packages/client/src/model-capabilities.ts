import type { ModelApiProtocol, ModelCapabilityStatus, RuntimeModelCapabilities, RuntimeModelDefinition, RuntimeModelProvider, RuntimeModelReference, RuntimeSettings } from './api.js';

/** 设置页和配置解析共用字段清单；未知能力不能进入有效执行配置。 */
export const MODEL_CAPABILITY_LABELS = [
  ['textInput', '文本输入'], ['textOutput', '文本输出'], ['imageInput', '图片输入'], ['imageUnderstanding', '视觉理解'],
  ['tools', '工具调用'], ['streaming', '流式输出'], ['reasoning', '推理参数'], ['parallelTools', '并行工具'],
  ['responses', 'Responses 协议'], ['chatCompletions', 'Chat Completions 协议'],
] as const;
export const UNKNOWN_MODEL_CAPABILITIES: RuntimeModelCapabilities = {
  textInput: 'unknown', textOutput: 'unknown', imageInput: 'unknown', imageUnderstanding: 'unknown',
  tools: 'unknown', streaming: 'unknown', reasoning: 'unknown', parallelTools: 'unknown', responses: 'unknown', chatCompletions: 'unknown',
};

/** 任一必要能力明确不支持即不可用；未确认不能被当作支持。 */
function combinedCapability(...statuses: readonly ModelCapabilityStatus[]): ModelCapabilityStatus {
  return statuses.includes('unsupported') ? 'unsupported' : statuses.includes('unknown') ? 'unknown' : 'supported';
}
export function getConversationCapability(model: Pick<RuntimeModelDefinition, 'capabilities'>, protocol?: ModelApiProtocol): ModelCapabilityStatus {
  return combinedCapability(model.capabilities.textInput, model.capabilities.textOutput,
    ...(protocol === undefined ? [] : [model.capabilities[protocol === 'responses' ? 'responses' : 'chatCompletions']]));
}
export function getVisionCapability(model: Pick<RuntimeModelDefinition, 'capabilities'>, protocol?: ModelApiProtocol): ModelCapabilityStatus {
  return combinedCapability(getConversationCapability(model, protocol), model.capabilities.imageInput, model.capabilities.imageUnderstanding);
}
/** 目录按显示顺序选取首个确认支持对话的模型；空目录保持未配置状态。 */
export function findFirstConversationModel(providers: readonly Pick<RuntimeModelProvider, 'id' | 'protocol' | 'models'>[]): RuntimeModelReference | null {
  for (const provider of providers) {
    const model = provider.models.find(model => getConversationCapability(model, provider.protocol) === 'supported');
    if (model !== undefined) return { providerId: provider.id, modelId: model.id };
  }
  return null;
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
  if (settings.conversationModel === null) return { available: false, reason: '未配置对话模型，请先在模型设置中配置。' };
  const main = resolveCatalogModel(settings.modelProviders, settings.conversationModel);
  const capability = getVisionCapability(main.model, main.provider.protocol);
  if (capability === 'supported') return main.provider.apiKey.configured
    ? { available: true, ...main, source: 'conversation' } : { available: false, reason: '当前模型未配置 API 密钥，视觉不可用。' };
  if (capability === 'unknown') return { available: false, reason: '当前模型的视觉能力未知，请在模型设置中确认能力；不会自动调用备用模型。' };
  if (!settings.fallbackVisionEnabled || settings.fallbackVisionModel === null) return { available: false, reason: '当前模型明确不支持视觉理解，且未启用备用视觉模型。' };
  const fallback = resolveCatalogModel(settings.modelProviders, settings.fallbackVisionModel);
  if (!fallback.provider.apiKey.configured || getVisionCapability(fallback.model, fallback.provider.protocol) !== 'supported') return { available: false, reason: '备用视觉模型的密钥或视觉能力未配置有效。' };
  return { available: true, ...fallback, source: 'fallback' };
}
