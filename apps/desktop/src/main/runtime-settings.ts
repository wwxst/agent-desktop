import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import { DEFAULT_MODEL_PROVIDERS, usesDefaultModelEndpoint } from '@agent-desktop/client/model-defaults';
import { findFirstConversationModel, getConversationCapability, getVisionCapability, resolveVisionModel, UNKNOWN_MODEL_CAPABILITIES } from '@agent-desktop/client/model-capabilities';
import { encryptSecret, type SafeStoragePort } from './safe-storage.js';
import type { ModelApiProtocol, RuntimeModelDefinition, RuntimeModelProvider,
  RuntimeModelProviderUpdate, RuntimeModelReference, RuntimeModelCapabilities, RuntimeSettings, RuntimeSettingsUpdate } from '@agent-desktop/client';

type ProviderConfig = Omit<RuntimeModelProvider, 'apiKey'>;
interface PersistedRuntimeSettings {
  readonly theme?: 'system' | 'light' | 'dark';
  readonly modelProviders?: readonly ProviderConfig[];
  readonly conversationModel?: RuntimeModelReference | null;
  readonly fallbackVisionModel?: RuntimeModelReference | null;
  readonly fallbackVisionEnabled?: boolean;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}
interface PersistedRuntimeSecrets { readonly providerApiKeys?: Readonly<Record<string, string>> }
export interface RuntimeConfiguration {
  readonly conversationModel: RuntimeModelReference;
  /** 当前对话模型的显式能力快照，供 Tool Exposure 在本轮固定使用。 */
  readonly modelCapabilities?: RuntimeModelCapabilities;
  readonly modelApiKey?: string;
  readonly modelBaseUrl: string;
  readonly modelId: string;
  readonly modelProtocol: ModelApiProtocol;
  /** 只读取当前所选模型的明确窗口；缺失时不按名称猜测。 */
  readonly modelContextWindow?: number;
  readonly modelMaxOutputTokens?: number;
  readonly modelDisableThinking?: boolean;
  readonly visionApiKey?: string;
  readonly visionBaseUrl?: string;
  readonly visionModel?: string;
  readonly visionProtocol?: ModelApiProtocol;
  readonly visionMaxOutputTokens?: number;
  readonly visionUnavailableReason?: string;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
  return value.trim();
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
  return value;
}
function protocol(value: unknown): ModelApiProtocol {
  if (value !== 'chat-completions' && value !== 'responses') throw new Error('不支持的 API 协议。');
  return value;
}
function baseUrl(value: unknown): string {
  const address = text(value, 'API 地址').replace(/\/+$/, '');
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须是不含密钥或查询参数的 HTTP 地址。');
  return address;
}
export function parseModelDefinitions(value: unknown): readonly RuntimeModelDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请至少添加一个模型。');
  const ids = new Set<string>();
  return value.map((model, index) => {
    if (!record(model)) throw new Error(`模型 ${index + 1} 无效。`);
    const id = text(model.id, `模型 ${index + 1}: 模型 ID`);
    if (ids.has(id)) throw new Error(`模型 ID 重复：${id}`);
    ids.add(id);
    const displayName = text(model.displayName, `模型 ${index + 1}: 显示名称`);
    if (!record(model.capabilities)) throw new Error(`模型 ${id} 的能力配置无效。`);
    const capabilities = { ...UNKNOWN_MODEL_CAPABILITIES };
    for (const field of ['textInput', 'textOutput', 'imageInput', 'imageUnderstanding'] as const) {
      const status = model.capabilities[field];
      if (status !== 'supported' && status !== 'unsupported' && status !== 'unknown') throw new Error(`模型 ${id} 的 ${field} 能力无效。`);
      capabilities[field] = status;
    }
    const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
    for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
      const amount = model[field];
      if (amount === undefined) continue;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw new Error(`模型 ${id} 的 token 数必须是正整数。`);
      limits[field] = amount;
    }
    if (limits.contextWindow !== undefined && limits.maxOutputTokens !== undefined && limits.maxOutputTokens > limits.contextWindow) throw new Error(`模型 ${id} 的输出上限不能超过上下文窗口。`);
    return { id, displayName, capabilities, ...limits };
  });
}
function reference(value: unknown): RuntimeModelReference {
  if (!record(value)) throw new Error('模型选择无效。');
  return { providerId: text(value.providerId, '供应商 ID'), modelId: text(value.modelId, '模型 ID') };
}
export function parseProviderQuery(value: unknown): Pick<RuntimeModelProviderUpdate, 'id' | 'baseUrl' | 'protocol' | 'apiKey'> {
  if (!record(value)) throw new Error('模型供应商配置无效。');
  const apiKey = value.apiKey === null ? null : optionalString(value.apiKey, 'API 密钥');
  return { id: text(value.id, '供应商 ID'), baseUrl: baseUrl(value.baseUrl), protocol: protocol(value.protocol),
    ...(apiKey === undefined ? {} : { apiKey }) };
}
function providerUpdate(value: unknown): RuntimeModelProviderUpdate {
  if (!record(value)) throw new Error('模型供应商配置无效。');
  return { ...parseProviderQuery(value), displayName: text(value.displayName, '显示名称'), models: parseModelDefinitions(value.models) };
}
export function parseRuntimeSettingsUpdate(value: unknown): RuntimeSettingsUpdate {
  if (!record(value)) throw new Error('运行时设置更新无效。');
  const update: { theme?: 'system' | 'light' | 'dark' | null; memoryEnabled?: boolean; memoryFromToolChatsEnabled?: boolean;
    modelProvider?: RuntimeModelProviderUpdate; deleteModelProviderId?: string; conversationModel?: RuntimeModelReference | null; fallbackVisionModel?: RuntimeModelReference | null; fallbackVisionEnabled?: boolean } = {};
  if (value.theme !== undefined) {
    if (value.theme !== null && !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('外观模式无效。');
    update.theme = value.theme as 'system' | 'light' | 'dark' | null;
  }
  if (value.modelProvider !== undefined) update.modelProvider = providerUpdate(value.modelProvider);
  if (value.deleteModelProviderId !== undefined) update.deleteModelProviderId = text(value.deleteModelProviderId, '供应商 ID');
  if (value.conversationModel !== undefined) update.conversationModel = value.conversationModel === null ? null : reference(value.conversationModel);
  if (value.fallbackVisionModel !== undefined) update.fallbackVisionModel = value.fallbackVisionModel === null ? null : reference(value.fallbackVisionModel);
  if (value.fallbackVisionEnabled !== undefined) {
    if (typeof value.fallbackVisionEnabled !== 'boolean') throw new Error('备用视觉开关必须是布尔值。');
    update.fallbackVisionEnabled = value.fallbackVisionEnabled;
  }
  for (const field of ['memoryEnabled', 'memoryFromToolChatsEnabled'] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new Error(`${field}必须是布尔值。`);
      update[field] = value[field];
    }
  }
  return update;
}
/** 持久化配置只解析当前供应商目录契约。 */
export function parseStoredSettings(value: unknown): PersistedRuntimeSettings {
  if (!record(value)) throw new Error('运行时设置结构无效。');
  const common = parseRuntimeSettingsUpdate(value);
  let providers: readonly ProviderConfig[] | undefined;
  if (value.modelProviders !== undefined) {
    if (!Array.isArray(value.modelProviders)) throw new Error('保存的模型供应商目录无效。');
    providers = value.modelProviders.map(item => {
      if (!record(item)) throw new Error('保存的供应商配置无效。');
      const parsed = { ...parseProviderQuery(item), displayName: text(item.displayName, '显示名称'), models: parseModelDefinitions(item.models) };
      return { id: parsed.id, displayName: parsed.displayName, baseUrl: parsed.baseUrl, protocol: parsed.protocol,
        models: parsed.models };
    });
    if (new Set(providers.map(item => item.id)).size !== providers.length) throw new Error('保存的供应商 ID 重复。');
  }
  return { ...(common.theme === undefined || common.theme === null ? {} : { theme: common.theme }),
    ...(providers === undefined ? {} : { modelProviders: providers }),
    ...(common.conversationModel === undefined ? {} : { conversationModel: common.conversationModel }),
    ...(common.fallbackVisionModel === undefined ? {} : { fallbackVisionModel: common.fallbackVisionModel }),
    fallbackVisionEnabled: common.fallbackVisionEnabled ?? false,
    ...(common.memoryEnabled === undefined ? {} : { memoryEnabled: common.memoryEnabled }),
    ...(common.memoryFromToolChatsEnabled === undefined ? {} : { memoryFromToolChatsEnabled: common.memoryFromToolChatsEnabled }) };
}
export function parseStoredSecrets(value: unknown): PersistedRuntimeSecrets {
  if (!record(value)) throw new Error('运行时密钥结构无效。');
  const keys: Record<string, string> = {};
  if (value.providerApiKeys !== undefined) {
    if (!record(value.providerApiKeys)) throw new Error('供应商密钥结构无效。');
    for (const [id, encrypted] of Object.entries(value.providerApiKeys)) keys[id] = text(encrypted, '加密密钥');
  }
  return Object.keys(keys).length ? { providerApiKeys: keys } : {};
}
function savedSettings(path: string): PersistedRuntimeSettings { const raw = readDesktopDocument(path, 'runtime-settings'); return raw === null ? {} : parseStoredSettings(raw); }
function savedSecrets(path: string): PersistedRuntimeSecrets { const raw = readDesktopDocument(path, 'runtime-secrets'); return raw === null ? {} : parseStoredSecrets(raw); }
function envValue(environment: RuntimeEnvironment, name: string): string | undefined { return environment[name]?.trim() || undefined; }
function environmentKey(id: string, environment: RuntimeEnvironment): string | undefined { return id === 'deepseek' ? envValue(environment, 'DEEPSEEK_API_KEY') : id === 'openai' ? envValue(environment, 'OPENAI_API_KEY') : undefined; }
/** 设置页只报告密钥存在性；解密留到实际使用，避免失效密文堵住重新录入入口。 */
function apiKeyStatus(id: string, secrets: PersistedRuntimeSecrets, environment: RuntimeEnvironment): RuntimeModelProvider['apiKey'] {
  return secrets.providerApiKeys?.[id] !== undefined ? { configured: true, source: 'saved' }
    : environmentKey(id, environment) === undefined ? { configured: false } : { configured: true, source: 'environment' };
}
function decrypt(value: string | undefined, storage: SafeStoragePort, providerName: string): string | undefined {
  if (value === undefined) return undefined;
  if (!storage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API 密钥。');
  try { return storage.decryptString(Buffer.from(value, 'base64')); }
  catch (error) {
    // 保留坏密文及底层原因；用户显式保存新密钥后再由现有事务覆盖。
    if (!(error instanceof Error)) throw error;
    throw new Error(`${providerName} 的已保存 API 密钥无法解密。请在设置 → 模型中重新填写 API 密钥并保存。`, { cause: error });
  }
}
/** 官方容量和图片能力仅适用于官方端点；环境变量改为中转地址后不继承这些事实。 */
function inheritedProviderMetadata(provider: ProviderConfig): ProviderConfig {
  return usesDefaultModelEndpoint(provider) ? provider : { ...provider, models: provider.models.map(model => {
    const { contextWindow: _window, maxOutputTokens: _output, ...definition } = model;
    return { ...definition, capabilities: { ...model.capabilities, imageInput: 'unknown', imageUnderstanding: 'unknown' } };
  }) };
}
function providerConfigs(saved: PersistedRuntimeSettings, environment: RuntimeEnvironment): readonly ProviderConfig[] {
  if (saved.modelProviders !== undefined) return saved.modelProviders;
  return DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...provider }) => inheritedProviderMetadata({ ...provider,
    baseUrl: envValue(environment, provider.id === 'deepseek' ? 'DEEPSEEK_BASE_URL' : 'OPENAI_BASE_URL') ?? provider.baseUrl,
    models: provider.id === 'deepseek' && envValue(environment, 'DEEPSEEK_MODEL') ? [provider.models.find(model => model.id === environment.DEEPSEEK_MODEL!.trim())
      ?? { id: environment.DEEPSEEK_MODEL!.trim(), displayName: environment.DEEPSEEK_MODEL!.trim(), capabilities: { ...UNKNOWN_MODEL_CAPABILITIES, textInput: 'supported', textOutput: 'supported' } }] : provider.models }));
}
function selections(saved: PersistedRuntimeSettings, providers: readonly ProviderConfig[]) {
  return { conversationModel: saved.conversationModel === undefined ? findFirstConversationModel(providers) : saved.conversationModel,
    fallbackVisionModel: saved.fallbackVisionModel ?? null, fallbackVisionEnabled: saved.fallbackVisionEnabled ?? false };
}
function selectedModel(providers: readonly ProviderConfig[], choice: RuntimeModelReference) {
  const provider = providers.find(item => item.id === choice.providerId);
  const model = provider?.models.find(item => item.id === choice.modelId);
  if (provider === undefined || model === undefined) throw new Error('当前使用的模型不在目录中，请先切换模型再删除。');
  return { provider, model };
}
export async function loadRuntimeSettings(path: string, environment: RuntimeEnvironment = process.env): Promise<RuntimeSettings> {
  const saved = savedSettings(path); const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  return { ...(saved.theme === undefined ? {} : { theme: saved.theme }),
    modelProviders: providers.map(provider => ({ ...provider, apiKey: apiKeyStatus(provider.id, secrets, environment) })), ...selections(saved, providers),
    memoryEnabled: saved.memoryEnabled ?? true,
    memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}
/** 只保存公开目录与选择；凭据始终按供应商标识从系统加密存储读取。 */
export function snapshotRuntimeSettings(path: string, environment: RuntimeEnvironment = process.env): PersistedRuntimeSettings {
  const saved = savedSettings(path);
  const providers = providerConfigs(saved, environment);
  return { modelProviders: providers, ...selections(saved, providers),
    memoryEnabled: saved.memoryEnabled ?? true, memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}

export async function loadRuntimeConfiguration(path: string, storage: SafeStoragePort, environment: RuntimeEnvironment = process.env,
  snapshot?: unknown): Promise<RuntimeConfiguration> {
  const saved = snapshot === undefined ? savedSettings(path) : parseStoredSettings(snapshot);
  const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  const choice = selections(saved, providers);
  if (choice.conversationModel === null) throw new Error('尚未配置对话模型，请在设置 → 模型中添加供应商并选择模型。');
  const conversation = selectedModel(providers, choice.conversationModel);
  const keyFor = (provider: ProviderConfig) => decrypt(secrets.providerApiKeys?.[provider.id], storage, provider.displayName) ?? environmentKey(provider.id, environment);
  const conversationKey = keyFor(conversation.provider);
  if (getConversationCapability(conversation.model) !== 'supported') throw new Error('当前模型的文本对话能力未确认支持。');
  // 本次调用形成不可变快照，后续保存模型选择不会回写已经创建的 Agent。
  const route = resolveVisionModel({ ...choice, modelProviders: providers.map(provider => ({ ...provider, apiKey: apiKeyStatus(provider.id, secrets, environment) })) });
  const vision = route.available ? route : undefined;
  const visionKey = vision === undefined ? undefined : vision.provider.id === conversation.provider.id ? conversationKey : keyFor(vision.provider);
  return { conversationModel: choice.conversationModel, modelCapabilities: conversation.model.capabilities,
    ...(conversationKey === undefined ? {} : { modelApiKey: conversationKey }),
    modelBaseUrl: conversation.provider.baseUrl, modelId: conversation.model.id, modelProtocol: conversation.provider.protocol,
    // 禁用思考是官方 Chat 入口的有效配置，不把专用参数发送给其它兼容服务。
    ...(conversation.provider.protocol === 'chat-completions' && new URL(conversation.provider.baseUrl).hostname === 'api.deepseek.com'
      ? { modelDisableThinking: true } : {}),
    ...(conversation.model.contextWindow === undefined ? {} : { modelContextWindow: conversation.model.contextWindow }),
    ...(conversation.model.maxOutputTokens === undefined ? {} : { modelMaxOutputTokens: conversation.model.maxOutputTokens }),
    ...(vision === undefined ? {} : { ...(visionKey === undefined ? {} : { visionApiKey: visionKey }), visionBaseUrl: vision.provider.baseUrl,
      visionModel: vision.model.id, visionProtocol: vision.provider.protocol,
      ...(vision.model.maxOutputTokens === undefined ? {} : { visionMaxOutputTokens: vision.model.maxOutputTokens }) }),
    ...(route.available ? {} : { visionUnavailableReason: route.reason }),
    memoryEnabled: saved.memoryEnabled ?? true,
    memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}
export async function saveRuntimeSettings(path: string, update: RuntimeSettingsUpdate, storage: SafeStoragePort): Promise<void> {
  const apiKey = update.modelProvider?.apiKey;
  let encryptedApiKey: string | undefined;
  if (typeof apiKey === 'string' && apiKey.trim()) {
    if (!storage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API 密钥。');
    encryptedApiKey = (await encryptSecret(path, apiKey.trim(), storage)).toString('base64');
  }
  // 等待加密依赖后再读取当前记录，合并到同步事务，保留等待期间已成功保存的外观和记忆设置。
  let saved = savedSettings(path); let secrets = savedSecrets(path);
  for (const field of ['theme', 'memoryEnabled', 'memoryFromToolChatsEnabled'] as const) {
    if (update[field] === undefined) continue;
    const next = { ...saved };
    if (update[field] === null) delete next[field]; else Object.assign(next, { [field]: update[field] });
    saved = next;
  }
  if (update.modelProvider !== undefined || update.deleteModelProviderId !== undefined || update.conversationModel !== undefined || update.fallbackVisionModel !== undefined || update.fallbackVisionEnabled !== undefined) {
    let providers = [...providerConfigs(saved, process.env)]; const choices = selections(saved, providers);
    if (update.modelProvider !== undefined) {
      const item = update.modelProvider;
      const provider: ProviderConfig = { id: item.id, displayName: item.displayName, baseUrl: item.baseUrl, protocol: item.protocol, models: item.models };
      const index = providers.findIndex(provider => provider.id === item.id);
      if (index < 0) providers.push(provider); else providers[index] = provider;
      if (item.apiKey !== undefined) {
        const keys = { ...secrets.providerApiKeys };
        if (item.apiKey === null || !item.apiKey.trim()) delete keys[item.id];
        else keys[item.id] = encryptedApiKey!;
        secrets = { providerApiKeys: keys };
      }
    }
    if (update.deleteModelProviderId !== undefined) {
      const id = update.deleteModelProviderId;
      const found = providers.find(provider => provider.id === id);
      if (found === undefined) throw new Error('找不到模型供应商。');
      providers = providers.filter(provider => provider.id !== id);
      const keys = { ...secrets.providerApiKeys }; delete keys[id]; secrets = { providerApiKeys: keys };
    }
    let conversationModel = update.conversationModel === undefined ? choices.conversationModel : update.conversationModel;
    // 空选择录入有效目录后即可恢复对话；删除当前供应商也在同一保存里调整选择。
    if (update.conversationModel === undefined && ((conversationModel === null && update.modelProvider !== undefined)
      || (update.deleteModelProviderId !== undefined && conversationModel?.providerId === update.deleteModelProviderId))) {
      conversationModel = findFirstConversationModel(providers);
    }
    let fallbackVisionModel = update.fallbackVisionModel === undefined ? choices.fallbackVisionModel : update.fallbackVisionModel;
    let fallbackVisionEnabled = update.fallbackVisionEnabled ?? choices.fallbackVisionEnabled;
    // 删除供应商一并清除其备用引用，避免已启用的备用配置继续阻止删除。
    if (update.deleteModelProviderId !== undefined && fallbackVisionModel?.providerId === update.deleteModelProviderId) {
      fallbackVisionModel = null;
      fallbackVisionEnabled = false;
    }
    if (conversationModel !== null && getConversationCapability(selectedModel(providers, conversationModel).model) !== 'supported') throw new Error('对话模型必须确认支持文本输入和输出。');
    if (fallbackVisionModel !== null) selectedModel(providers, fallbackVisionModel);
    if (fallbackVisionEnabled) {
      if (fallbackVisionModel === null) throw new Error('请先配置备用视觉模型。');
      const fallback = selectedModel(providers, fallbackVisionModel);
      if (getVisionCapability(fallback.model) !== 'supported') throw new Error('备用视觉模型必须确认支持图片输入与视觉理解。');
      if (!apiKeyStatus(fallback.provider.id, secrets, process.env).configured) throw new Error('备用视觉模型未配置 API 密钥。');
    }
    saved = { ...saved, modelProviders: providers, conversationModel, fallbackVisionModel, fallbackVisionEnabled };
  }
  // 目录和加密密钥仍一次提交到同一数据库，不产生明文密钥文件。
  writeDesktopDocuments(path, [{ name: 'runtime-settings', value: saved }, { name: 'runtime-secrets', value: secrets }]);
}
export async function listProviderModels(path: string, query: Pick<RuntimeModelProviderUpdate, 'id' | 'baseUrl' | 'protocol' | 'apiKey'>, storage: SafeStoragePort,
  authorizeNetwork: (request: { readonly url: string; readonly method: string }) => Promise<boolean>): Promise<readonly RuntimeModelDefinition[]> {
  const key = query.apiKey === undefined ? decrypt(savedSecrets(path).providerApiKeys?.[query.id], storage, query.id) ?? environmentKey(query.id, process.env) : query.apiKey;
  if (!key) throw new Error('请先填写 API 密钥。');
  const url = new URL(`${query.baseUrl}/models`);
  if (!await authorizeNetwork({ url: url.href, method: 'GET' })) throw new Error(`网络策略拒绝访问：${url.origin}`);
  // 目录请求不跟随重定向，防止密钥被转发到未授权来源。
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'manual' });
  if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!record(payload) || !Array.isArray(payload.data)) throw new Error('供应商返回的模型目录缺少 data。');
  return payload.data.map(item => {
    if (!record(item)) throw new Error('供应商返回的模型条目无效。');
    const id = text(item.id, '模型 ID');
    // 仅消费接口明确声明的模态；缺字段保持未知，不从供应商或模型名称推断。
    const modality = (field: 'input_modalities' | 'output_modalities', name: string) => {
      if (item[field] === undefined) return 'unknown' as const;
      if (!Array.isArray(item[field]) || !item[field].every(value => typeof value === 'string')) throw new Error('模型目录的模态声明无效。');
      return item[field].includes(name) ? 'supported' as const : 'unsupported' as const;
    };
    const imageInput = modality('input_modalities', 'image');
    const textOutput = modality('output_modalities', 'text');
    return { id, displayName: typeof item.name === 'string' && item.name.trim() ? item.name : id,
      capabilities: { textInput: modality('input_modalities', 'text'), textOutput, imageInput,
        imageUnderstanding: imageInput === 'unsupported' ? 'unsupported' : imageInput === 'supported' && textOutput === 'supported' ? 'supported' : 'unknown' } };
  });
}
