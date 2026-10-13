import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import { DEFAULT_MODEL_PROVIDERS, usesDefaultModelEndpoint } from '@agent-desktop/client/model-defaults';
import { getConversationCapability, getVisionCapability, resolveVisionModel, UNKNOWN_MODEL_CAPABILITIES } from '@agent-desktop/client/model-capabilities';
import type { ModelApiProtocol, RuntimeModelDefinition, RuntimeModelProvider,
  RuntimeModelProviderUpdate, RuntimeModelReference, RuntimeSettings, RuntimeSettingsUpdate } from '@agent-desktop/client';

type ProviderConfig = Omit<RuntimeModelProvider, 'apiKey'>;
interface PersistedRuntimeSettings {
  readonly theme?: 'system' | 'light' | 'dark';
  readonly modelProviders?: readonly ProviderConfig[];
  readonly conversationModel?: RuntimeModelReference;
  readonly fallbackVisionModel?: RuntimeModelReference | null;
  readonly fallbackVisionEnabled?: boolean;
  readonly whisperModelPath?: string;
  readonly whisperCliPath?: string;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}
interface PersistedRuntimeSecrets { readonly providerApiKeys?: Readonly<Record<string, string>> }
export interface RuntimeConfiguration {
  readonly deepSeekApiKey?: string;
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly modelProtocol?: ModelApiProtocol;
  readonly modelMaxOutputTokens?: number;
  readonly useDeepSeekThinking?: boolean;
  readonly visionApiKey?: string;
  readonly visionBaseUrl?: string;
  readonly visionModel?: string;
  readonly visionProtocol?: ModelApiProtocol;
  readonly visionMaxOutputTokens?: number;
  readonly visionUnavailableReason?: string;
  readonly whisperModelPath?: string;
  readonly whisperCliPath?: string;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
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
export function parseModelDefinitions(value: unknown, legacy = false): readonly RuntimeModelDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请至少添加一个模型。');
  const ids = new Set<string>();
  return value.map((model, index) => {
    if (!record(model)) throw new Error(`模型 ${index + 1} 无效。`);
    const id = text(model.id, `模型 ${index + 1}: 模型 ID`);
    if (ids.has(id)) throw new Error(`模型 ID 重复：${id}`);
    ids.add(id);
    const displayName = text(model.displayName, `模型 ${index + 1}: 显示名称`);
    // 旧目录只有文本任务与图片布尔字段；兼容只发生在磁盘读取边界。
    let capabilities: RuntimeModelDefinition['capabilities'];
    if (legacy && model.capabilities === undefined && typeof model.images === 'boolean') {
      capabilities = { textInput: 'supported', textOutput: 'supported', imageInput: model.images ? 'supported' : 'unsupported', imageUnderstanding: model.images ? 'supported' : 'unsupported' };
    } else {
      if (!record(model.capabilities)) throw new Error(`模型 ${id} 的能力配置无效。`);
      const parsed = { ...UNKNOWN_MODEL_CAPABILITIES };
      for (const field of ['textInput', 'textOutput', 'imageInput', 'imageUnderstanding'] as const) {
        const status = model.capabilities[field];
        if (status !== 'supported' && status !== 'unsupported' && status !== 'unknown') throw new Error(`模型 ${id} 的 ${field} 能力无效。`);
        parsed[field] = status;
      }
      capabilities = parsed;
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
  const update: { theme?: 'system' | 'light' | 'dark' | null; whisperModelPath?: string | null; whisperCliPath?: string | null; memoryEnabled?: boolean; memoryFromToolChatsEnabled?: boolean;
    modelProvider?: RuntimeModelProviderUpdate; deleteModelProviderId?: string; conversationModel?: RuntimeModelReference; fallbackVisionModel?: RuntimeModelReference | null; fallbackVisionEnabled?: boolean } = {};
  if (value.theme !== undefined) {
    if (value.theme !== null && !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('外观模式无效。');
    update.theme = value.theme as 'system' | 'light' | 'dark' | null;
  }
  for (const field of ['whisperModelPath', 'whisperCliPath'] as const) {
    if (value[field] !== undefined) update[field] = value[field] === null ? null : optionalString(value[field], field)!;
  }
  if (value.modelProvider !== undefined) update.modelProvider = providerUpdate(value.modelProvider);
  if (value.deleteModelProviderId !== undefined) update.deleteModelProviderId = text(value.deleteModelProviderId, '供应商 ID');
  if (value.conversationModel !== undefined) update.conversationModel = reference(value.conversationModel);
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
/** 旧版固定两家配置只在持久化边界转换，新界面和运行时统一消费供应商目录。 */
export function parseStoredSettings(value: unknown): PersistedRuntimeSettings {
  if (!record(value)) throw new Error('运行时设置结构无效。');
  const common = parseRuntimeSettingsUpdate(value);
  let providers: readonly ProviderConfig[] | undefined;
  if (value.modelProviders !== undefined) {
    if (!Array.isArray(value.modelProviders)) throw new Error('保存的模型供应商目录无效。');
    providers = value.modelProviders.map(item => {
      if (!record(item)) throw new Error('保存的供应商配置无效。');
      const parsed = { ...parseProviderQuery(item), displayName: text(item.displayName, '显示名称'), models: parseModelDefinitions(item.models, true) };
      return { id: parsed.id, displayName: parsed.displayName, baseUrl: parsed.baseUrl, protocol: parsed.protocol,
        models: parsed.models, builtin: DEFAULT_MODEL_PROVIDERS.some(defaultProvider => defaultProvider.id === parsed.id) };
    });
    if (new Set(providers.map(item => item.id)).size !== providers.length) throw new Error('保存的供应商 ID 重复。');
  } else if (['deepSeekBaseUrl', 'deepSeekModel', 'visionBaseUrl'].some(key => value[key] !== undefined)) {
    providers = DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...provider }) => inheritedProviderCapabilities({ ...provider,
      baseUrl: optionalString(value[provider.id === 'deepseek' ? 'deepSeekBaseUrl' : 'visionBaseUrl'], '旧版 API 地址') || provider.baseUrl,
      models: provider.id === 'deepseek' && value.deepSeekModel ? [{ id: text(value.deepSeekModel, '旧版模型名称'), displayName: text(value.deepSeekModel, '旧版模型名称'), capabilities: { ...UNKNOWN_MODEL_CAPABILITIES, textInput: 'supported', textOutput: 'supported' } }] : provider.models }));
  }
  return { ...(common.theme === undefined || common.theme === null ? {} : { theme: common.theme }),
    ...(providers === undefined ? {} : { modelProviders: providers }),
    ...(common.conversationModel === undefined ? {} : { conversationModel: common.conversationModel }),
    // 升级仅迁移备用候选；旧视觉选择从不隐式打开备用调用。
    ...(common.fallbackVisionModel !== undefined ? { fallbackVisionModel: common.fallbackVisionModel }
      : value.visionModel === undefined ? {} : { fallbackVisionModel: value.visionModel === null ? null : reference(value.visionModel) }),
    fallbackVisionEnabled: common.fallbackVisionEnabled ?? false,
    ...(common.whisperModelPath == null ? {} : { whisperModelPath: common.whisperModelPath }),
    ...(common.whisperCliPath == null ? {} : { whisperCliPath: common.whisperCliPath }),
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
/** 旧固定配置和环境变量没有显式能力确认，换地址后仅保留原文本对话契约。 */
function inheritedProviderCapabilities(provider: ProviderConfig): ProviderConfig {
  return usesDefaultModelEndpoint(provider) ? provider : { ...provider, models: provider.models.map(model => ({ ...model,
    capabilities: { ...model.capabilities, imageInput: 'unknown', imageUnderstanding: 'unknown' } })) };
}
function providerConfigs(saved: PersistedRuntimeSettings, environment: RuntimeEnvironment): readonly ProviderConfig[] {
  if (saved.modelProviders !== undefined) return saved.modelProviders;
  return DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...provider }) => inheritedProviderCapabilities({ ...provider,
    baseUrl: envValue(environment, provider.id === 'deepseek' ? 'DEEPSEEK_BASE_URL' : 'OPENAI_BASE_URL') ?? provider.baseUrl,
    models: provider.id === 'deepseek' && envValue(environment, 'DEEPSEEK_MODEL') ? [{ id: environment.DEEPSEEK_MODEL!.trim(), displayName: environment.DEEPSEEK_MODEL!.trim(), capabilities: provider.models.find(model => model.id === environment.DEEPSEEK_MODEL!.trim())?.capabilities ?? { ...UNKNOWN_MODEL_CAPABILITIES, textInput: 'supported', textOutput: 'supported' } }] : provider.models }));
}
function selections(saved: PersistedRuntimeSettings, providers: readonly ProviderConfig[]) {
  return { conversationModel: saved.conversationModel ?? { providerId: 'deepseek', modelId: providers.find(item => item.id === 'deepseek')!.models[0]!.id },
    fallbackVisionModel: saved.fallbackVisionModel ?? null, fallbackVisionEnabled: saved.fallbackVisionEnabled ?? false };
}
function selectedModel(providers: readonly ProviderConfig[], choice: RuntimeModelReference) {
  const provider = providers.find(item => item.id === choice.providerId);
  const model = provider?.models.find(item => item.id === choice.modelId);
  if (provider === undefined || model === undefined) throw new Error('当前使用的模型不在目录中，请先切换模型再删除。');
  return { provider, model };
}
export async function loadRuntimeSettings(path: string, storage: SafeStoragePort, environment: RuntimeEnvironment = process.env): Promise<RuntimeSettings> {
  const saved = savedSettings(path); const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  return { ...(saved.theme === undefined ? {} : { theme: saved.theme }),
    modelProviders: providers.map(provider => {
      const key = decrypt(secrets.providerApiKeys?.[provider.id], storage);
      return { ...provider, apiKey: key !== undefined ? { configured: true, source: 'saved' as const }
        : environmentKey(provider.id, environment) === undefined ? { configured: false } : { configured: true, source: 'environment' as const } };
    }), ...selections(saved, providers), whisper: { modelPath: saved.whisperModelPath ?? '', cliPath: saved.whisperCliPath ?? '' },
    memoryEnabled: saved.memoryEnabled ?? true,
    memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}
export async function loadRuntimeConfiguration(path: string, storage: SafeStoragePort, environment: RuntimeEnvironment = process.env): Promise<RuntimeConfiguration> {
  const saved = savedSettings(path); const secrets = savedSecrets(path); const providers = providerConfigs(saved, environment);
  const choice = selections(saved, providers); const conversation = selectedModel(providers, choice.conversationModel);
  const keyFor = (id: string) => decrypt(secrets.providerApiKeys?.[id], storage) ?? environmentKey(id, environment);
  const conversationKey = keyFor(conversation.provider.id);
  if (getConversationCapability(conversation.model) !== 'supported') throw new Error('当前模型的文本对话能力未确认支持。');
  // 本次调用形成不可变快照，后续保存模型选择不会回写已经创建的 Agent。
  const route = resolveVisionModel({ ...choice, modelProviders: providers.map(provider => ({ ...provider, apiKey: { configured: keyFor(provider.id) !== undefined } })) });
  const vision = route.available ? route : undefined;
  const visionKey = vision === undefined ? undefined : keyFor(vision.provider.id);
  const whisperModelPath = saved.whisperModelPath ?? envValue(environment, 'WHISPER_MODEL_PATH');
  const whisperCliPath = saved.whisperCliPath ?? envValue(environment, 'WHISPER_CLI_PATH');
  return { ...(conversationKey === undefined ? {} : { deepSeekApiKey: conversationKey }),
    deepSeekBaseUrl: conversation.provider.baseUrl, deepSeekModel: conversation.model.id, modelProtocol: conversation.provider.protocol,
    useDeepSeekThinking: new URL(conversation.provider.baseUrl).hostname === 'api.deepseek.com',
    ...(conversation.model.maxOutputTokens === undefined ? {} : { modelMaxOutputTokens: conversation.model.maxOutputTokens }),
    ...(visionKey === undefined || vision === undefined ? {} : { visionApiKey: visionKey, visionBaseUrl: vision.provider.baseUrl,
      visionModel: vision.model.id, visionProtocol: vision.provider.protocol,
      ...(vision.model.maxOutputTokens === undefined ? {} : { visionMaxOutputTokens: vision.model.maxOutputTokens }) }),
    ...(route.available ? {} : { visionUnavailableReason: route.reason }),
    ...(whisperModelPath === undefined ? {} : { whisperModelPath }), ...(whisperCliPath === undefined ? {} : { whisperCliPath }),
    memoryEnabled: saved.memoryEnabled ?? true,
    memoryFromToolChatsEnabled: saved.memoryFromToolChatsEnabled ?? true };
}
export async function saveRuntimeSettings(path: string, update: RuntimeSettingsUpdate, storage: SafeStoragePort): Promise<void> {
  let saved = savedSettings(path); let secrets = savedSecrets(path);
  for (const field of ['theme', 'whisperModelPath', 'whisperCliPath', 'memoryEnabled', 'memoryFromToolChatsEnabled'] as const) {
    if (update[field] === undefined) continue;
    const next = { ...saved };
    if (update[field] === null || update[field] === '') delete next[field]; else Object.assign(next, { [field]: update[field] });
    saved = next;
  }
  if (update.modelProvider !== undefined || update.deleteModelProviderId !== undefined || update.conversationModel !== undefined || update.fallbackVisionModel !== undefined || update.fallbackVisionEnabled !== undefined) {
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
        else {
          if (!storage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API 密钥。');
          keys[item.id] = storage.encryptString(item.apiKey.trim()).toString('base64');
        }
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
    const conversationModel = update.conversationModel ?? choices.conversationModel;
    let fallbackVisionModel = update.fallbackVisionModel === undefined ? choices.fallbackVisionModel : update.fallbackVisionModel;
    const fallbackVisionEnabled = update.fallbackVisionEnabled ?? choices.fallbackVisionEnabled;
    // 关闭时保留候选；只有用户删除其供应商时才清除，显式改选仍按新引用校验。
    if (update.deleteModelProviderId !== undefined && !fallbackVisionEnabled && update.fallbackVisionModel === undefined
      && fallbackVisionModel?.providerId === update.deleteModelProviderId) fallbackVisionModel = null;
    if (getConversationCapability(selectedModel(providers, conversationModel).model) !== 'supported') throw new Error('对话模型必须确认支持文本输入和输出。');
    if (fallbackVisionModel !== null) selectedModel(providers, fallbackVisionModel);
    if (fallbackVisionEnabled) {
      if (fallbackVisionModel === null) throw new Error('请先配置备用视觉模型。');
      const fallback = selectedModel(providers, fallbackVisionModel);
      if (getVisionCapability(fallback.model) !== 'supported') throw new Error('备用视觉模型必须确认支持图片输入与视觉理解。');
      if (!(decrypt(secrets.providerApiKeys?.[fallback.provider.id], storage) ?? environmentKey(fallback.provider.id, process.env))) throw new Error('备用视觉模型未配置 API 密钥。');
    }
    saved = { ...saved, modelProviders: providers, conversationModel, fallbackVisionModel, fallbackVisionEnabled };
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
