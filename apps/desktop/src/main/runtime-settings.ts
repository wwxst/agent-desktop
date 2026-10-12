import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import { encryptSecret, type SafeStoragePort } from './safe-storage.js';
import { DEFAULT_MODEL_PROVIDERS } from '@agent-desktop/client/model-defaults';
import type { ModelApiProtocol, RuntimeModelDefinition, RuntimeModelProvider,
  RuntimeModelProviderUpdate, RuntimeModelReference, RuntimeSettings, RuntimeSettingsUpdate } from '@agent-desktop/client';

type ProviderConfig = Omit<RuntimeModelProvider, 'apiKey'>;
interface PersistedRuntimeSettings {
  readonly theme?: 'system' | 'light' | 'dark';
  readonly modelProviders?: readonly ProviderConfig[];
  readonly conversationModel?: RuntimeModelReference;
  readonly visionModel?: RuntimeModelReference | null;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}
interface PersistedRuntimeSecrets { readonly providerApiKeys?: Readonly<Record<string, string>> }
export interface RuntimeConfiguration {
  readonly deepSeekApiKey?: string;
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly modelProtocol?: ModelApiProtocol;
  /** 只读取当前所选模型的明确窗口；缺失时不按名称猜测。 */
  readonly modelContextWindow?: number;
  readonly modelMaxOutputTokens?: number;
  readonly useDeepSeekThinking?: boolean;
  readonly visionApiKey?: string;
  readonly visionBaseUrl?: string;
  readonly visionModel?: string;
  readonly visionProtocol?: ModelApiProtocol;
  readonly visionMaxOutputTokens?: number;
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
    if (typeof model.images !== 'boolean') throw new Error(`模型 ${id} 的图片能力无效。`);
    const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
    for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
      const amount = model[field];
      if (amount === undefined) continue;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw new Error(`模型 ${id} 的 token 数必须是正整数。`);
      limits[field] = amount;
    }
    if (limits.contextWindow !== undefined && limits.maxOutputTokens !== undefined && limits.maxOutputTokens > limits.contextWindow) throw new Error(`模型 ${id} 的输出上限不能超过上下文窗口。`);
    return { id, displayName, images: model.images, ...limits };
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
    modelProvider?: RuntimeModelProviderUpdate; deleteModelProviderId?: string; conversationModel?: RuntimeModelReference; visionModel?: RuntimeModelReference | null } = {};
  if (value.theme !== undefined) {
    if (value.theme !== null && !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('外观模式无效。');
    update.theme = value.theme as 'system' | 'light' | 'dark' | null;
  }
  if (value.modelProvider !== undefined) update.modelProvider = providerUpdate(value.modelProvider);
  if (value.deleteModelProviderId !== undefined) update.deleteModelProviderId = text(value.deleteModelProviderId, '供应商 ID');
  if (value.conversationModel !== undefined) update.conversationModel = reference(value.conversationModel);
  if (value.visionModel !== undefined) update.visionModel = value.visionModel === null ? null : reference(value.visionModel);
  for (const field of ['memoryEnabled', 'memoryFromToolChatsEnabled'] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new Error(`${field}必须是布尔值。`);
      update[field] = value[field];
    }
  }
  return update;
}
/** 旧版固定两家配置只在持久化边界转换，新界面和运行时统一消费供应商目录。 */
export function parseStoredSettings(value: unknown): PersistedRuntimeSettings {
  if (!record(value)) throw new Error('运行时设置结构无效。');
  const common = parseRuntimeSettingsUpdate(value);
  let providers: readonly ProviderConfig[] | undefined;
  if (value.modelProviders !== undefined) {
    if (!Array.isArray(value.modelProviders)) throw new Error('保存的模型供应商目录无效。');
    providers = value.modelProviders.map(item => {
      const parsed = providerUpdate(item);
      return { id: parsed.id, displayName: parsed.displayName, baseUrl: parsed.baseUrl, protocol: parsed.protocol,
        models: parsed.models, builtin: DEFAULT_MODEL_PROVIDERS.some(defaultProvider => defaultProvider.id === parsed.id) };
    });
    if (new Set(providers.map(item => item.id)).size !== providers.length) throw new Error('保存的供应商 ID 重复。');
  } else if (['deepSeekBaseUrl', 'deepSeekModel', 'visionBaseUrl'].some(key => value[key] !== undefined)) {
    providers = DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...provider }) => ({ ...provider,
      baseUrl: optionalString(value[provider.id === 'deepseek' ? 'deepSeekBaseUrl' : 'visionBaseUrl'], '旧版 API 地址') || provider.baseUrl,
      models: provider.id === 'deepseek' && value.deepSeekModel ? [{ id: text(value.deepSeekModel, '旧版模型名称'), displayName: text(value.deepSeekModel, '旧版模型名称'), images: false }] : provider.models }));
  }
  return { ...(common.theme === undefined || common.theme === null ? {} : { theme: common.theme }),
    ...(providers === undefined ? {} : { modelProviders: providers }),
    ...(common.conversationModel === undefined ? {} : { conversationModel: common.conversationModel }),
    ...(common.visionModel === undefined ? {} : { visionModel: common.visionModel }),
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
  for (const [field, id] of [['deepSeekApiKey', 'deepseek'], ['visionApiKey', 'openai']] as const) {
    const encrypted = optionalString(value[field], field);
    if (encrypted !== undefined) keys[id] = encrypted;
  }
  return Object.keys(keys).length ? { providerApiKeys: keys } : {};
}
function savedSettings(path: string): PersistedRuntimeSettings { const raw = readDesktopDocument(path, 'runtime-settings'); return raw === null ? {} : parseStoredSettings(raw); }
function savedSecrets(path: string): PersistedRuntimeSecrets { const raw = readDesktopDocument(path, 'runtime-secrets'); return raw === null ? {} : parseStoredSecrets(raw); }
function envValue(environment: RuntimeEnvironment, name: string): string | undefined { return environment[name]?.trim() || undefined; }
function environmentKey(id: string, environment: RuntimeEnvironment): string | undefined { return id === 'deepseek' ? envValue(environment, 'DEEPSEEK_API_KEY') : id === 'openai' ? envValue(environment, 'OPENAI_API_KEY') : undefined; }
function decrypt(value: string | undefined, storage: SafeStoragePort): string | undefined {
  if (value === undefined) return undefined;
  if (!storage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API 密钥。');
  return storage.decryptString(Buffer.from(value, 'base64'));
}
function providerConfigs(saved: PersistedRuntimeSettings, environment: RuntimeEnvironment): readonly ProviderConfig[] {
  if (saved.modelProviders !== undefined) return saved.modelProviders;
  return DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...provider }) => ({ ...provider,
    baseUrl: envValue(environment, provider.id === 'deepseek' ? 'DEEPSEEK_BASE_URL' : 'OPENAI_BASE_URL') ?? provider.baseUrl,
    models: provider.id === 'deepseek' && envValue(environment, 'DEEPSEEK_MODEL') ? [{ id: environment.DEEPSEEK_MODEL!.trim(), displayName: environment.DEEPSEEK_MODEL!.trim(), images: false }] : provider.models }));
}
function selections(saved: PersistedRuntimeSettings, providers: readonly ProviderConfig[]) {
  return { conversationModel: saved.conversationModel ?? { providerId: 'deepseek', modelId: providers.find(item => item.id === 'deepseek')!.models[0]!.id },
    visionModel: saved.visionModel === undefined ? { providerId: 'openai', modelId: providers.find(item => item.id === 'openai')!.models[0]!.id } : saved.visionModel };
}
function selectedModel(providers: readonly ProviderConfig[], choice: RuntimeModelReference, images = false) {
  const provider = providers.find(item => item.id === choice.providerId);
  const model = provider?.models.find(item => item.id === choice.modelId);
  if (provider === undefined || model === undefined) throw new Error('当前使用的模型不在目录中，请先切换模型再删除。');
  if (images && !model.images) throw new Error('视觉模型必须支持图片输入。');
  return { provider, model };
}
export async function loadRuntimeSettings(path: string, storage: SafeStoragePort, environment: RuntimeEnvironment = process.env): Promise<RuntimeSettings> {
  const saved = savedSettings(path); const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  return { ...(saved.theme === undefined ? {} : { theme: saved.theme }),
    modelProviders: providers.map(provider => {
      const key = decrypt(secrets.providerApiKeys?.[provider.id], storage);
      return { ...provider, apiKey: key !== undefined ? { configured: true, source: 'saved' as const }
        : environmentKey(provider.id, environment) === undefined ? { configured: false } : { configured: true, source: 'environment' as const } };
    }), ...selections(saved, providers),
    memoryEnabled: saved.memoryEnabled ?? true,
    memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}
export async function loadRuntimeConfiguration(path: string, storage: SafeStoragePort, environment: RuntimeEnvironment = process.env): Promise<RuntimeConfiguration> {
  const saved = savedSettings(path); const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  const choice = selections(saved, providers); const conversation = selectedModel(providers, choice.conversationModel);
  const keyFor = (id: string) => decrypt(secrets.providerApiKeys?.[id], storage) ?? environmentKey(id, environment);
  const conversationKey = keyFor(conversation.provider.id);
  const vision = choice.visionModel === null ? undefined : selectedModel(providers, choice.visionModel, true);
  const visionKey = vision === undefined ? undefined : keyFor(vision.provider.id);
  return { ...(conversationKey === undefined ? {} : { deepSeekApiKey: conversationKey }),
    deepSeekBaseUrl: conversation.provider.baseUrl, deepSeekModel: conversation.model.id, modelProtocol: conversation.provider.protocol,
    useDeepSeekThinking: new URL(conversation.provider.baseUrl).hostname === 'api.deepseek.com',
    ...(conversation.model.contextWindow === undefined ? {} : { modelContextWindow: conversation.model.contextWindow }),
    ...(conversation.model.maxOutputTokens === undefined ? {} : { modelMaxOutputTokens: conversation.model.maxOutputTokens }),
    ...(vision === undefined ? {} : { ...(visionKey === undefined ? {} : { visionApiKey: visionKey }), visionBaseUrl: vision.provider.baseUrl,
      visionModel: vision.model.id, visionProtocol: vision.provider.protocol,
      ...(vision.model.maxOutputTokens === undefined ? {} : { visionMaxOutputTokens: vision.model.maxOutputTokens }) }),
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
  if (update.modelProvider !== undefined || update.deleteModelProviderId !== undefined || update.conversationModel !== undefined || update.visionModel !== undefined) {
    let providers = [...providerConfigs(saved, process.env)]; const choices = selections(saved, providers);
    if (update.modelProvider !== undefined) {
      const item = update.modelProvider;
      const builtin = DEFAULT_MODEL_PROVIDERS.some(provider => provider.id === item.id);
      const provider: ProviderConfig = { id: item.id, displayName: item.displayName, baseUrl: item.baseUrl, protocol: item.protocol, models: item.models, builtin };
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
      if (found.builtin) throw new Error('内置供应商不能删除。');
      providers = providers.filter(provider => provider.id !== id);
      const keys = { ...secrets.providerApiKeys }; delete keys[id]; secrets = { providerApiKeys: keys };
    }
    const conversationModel = update.conversationModel ?? choices.conversationModel;
    const visionModel = update.visionModel === undefined ? choices.visionModel : update.visionModel;
    selectedModel(providers, conversationModel);
    if (visionModel !== null) selectedModel(providers, visionModel, true);
    saved = { ...saved, modelProviders: providers, conversationModel, visionModel };
  }
  // 目录和加密密钥仍一次提交到同一数据库，不产生明文密钥文件。
  writeDesktopDocuments(path, [{ name: 'runtime-settings', value: saved }, { name: 'runtime-secrets', value: secrets }]);
}
export async function listProviderModels(path: string, query: Pick<RuntimeModelProviderUpdate, 'id' | 'baseUrl' | 'protocol' | 'apiKey'>, storage: SafeStoragePort): Promise<readonly RuntimeModelDefinition[]> {
  const key = query.apiKey === undefined ? decrypt(savedSecrets(path).providerApiKeys?.[query.id], storage) ?? environmentKey(query.id, process.env) : query.apiKey;
  if (!key) throw new Error('请先填写 API 密钥。');
  const response = await fetch(`${query.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!record(payload) || !Array.isArray(payload.data)) throw new Error('供应商返回的模型目录缺少 data。');
  return payload.data.map(item => {
    if (!record(item)) throw new Error('供应商返回的模型条目无效。');
    const id = text(item.id, '模型 ID');
    // 标准模型目录不声明图片能力和 token 上限时留空，用户按供应商资料填写。
    return { id, displayName: typeof item.name === 'string' && item.name.trim() ? item.name : id, images: false };
  });
}
