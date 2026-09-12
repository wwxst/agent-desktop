import { readFile, writeFile } from 'node:fs/promises';
import type { RuntimeSettings, RuntimeSettingsUpdate } from '@agent-desktop/client';

export const RUNTIME_SETTINGS_FILE_NAME = 'runtime-settings.json';
export const RUNTIME_SECRETS_FILE_NAME = 'runtime-secrets.json';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
const VISION_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface PersistedRuntimeSettings {
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly visionBaseUrl?: string;
  readonly whisperModelPath?: string;
  readonly whisperCliPath?: string;
}

interface PersistedRuntimeSecrets {
  readonly deepSeekApiKey?: string;
  readonly visionApiKey?: string;
}

export interface RuntimeConfiguration {
  readonly deepSeekApiKey?: string;
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly visionApiKey?: string;
  readonly visionBaseUrl?: string;
  readonly whisperModelPath?: string;
  readonly whisperCliPath?: string;
}

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRuntimeSettingsUpdate(value: unknown): RuntimeSettingsUpdate {
  if (!isRecord(value)) throw new Error('运行时设置更新无效。');
  const fields = [
    'deepSeekApiKey',
    'deepSeekBaseUrl',
    'deepSeekModel',
    'visionApiKey',
    'visionBaseUrl',
    'whisperModelPath',
    'whisperCliPath',
  ] as const;
  const update: Record<string, string | null> = {};
  for (const field of fields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (fieldValue !== null && typeof fieldValue !== 'string') {
      throw new Error(`运行时设置更新无效：${field}`);
    }
    update[field] = fieldValue;
  }
  return update;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`运行时设置结构无效：${field}`);
  return value;
}

function parseSettings(value: unknown): PersistedRuntimeSettings {
  if (!isRecord(value)) throw new Error('运行时设置结构无效：root');
  return {
    ...(readOptionalString(value.deepSeekBaseUrl, 'deepSeekBaseUrl') === undefined
      ? {} : { deepSeekBaseUrl: value.deepSeekBaseUrl as string }),
    ...(readOptionalString(value.deepSeekModel, 'deepSeekModel') === undefined
      ? {} : { deepSeekModel: value.deepSeekModel as string }),
    ...(readOptionalString(value.visionBaseUrl, 'visionBaseUrl') === undefined
      ? {} : { visionBaseUrl: value.visionBaseUrl as string }),
    ...(readOptionalString(value.whisperModelPath, 'whisperModelPath') === undefined
      ? {} : { whisperModelPath: value.whisperModelPath as string }),
    ...(readOptionalString(value.whisperCliPath, 'whisperCliPath') === undefined
      ? {} : { whisperCliPath: value.whisperCliPath as string }),
  };
}

function parseSecrets(value: unknown): PersistedRuntimeSecrets {
  if (!isRecord(value)) throw new Error('运行时密钥结构无效：root');
  const deepSeekApiKey = readOptionalString(value.deepSeekApiKey, 'deepSeekApiKey');
  const visionApiKey = readOptionalString(value.visionApiKey, 'visionApiKey');
  return {
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
    ...(visionApiKey === undefined ? {} : { visionApiKey }),
  };
}

async function readJsonFile(filePath: string, label: string): Promise<unknown | null> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取${label}：${filePath}`, { cause: error });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`无法解析${label}：${filePath}`, { cause: error });
  }
}

async function loadPersistedSettings(filePath: string): Promise<PersistedRuntimeSettings> {
  const value = await readJsonFile(filePath, '运行时设置');
  return value === null ? {} : parseSettings(value);
}

async function loadPersistedSecrets(filePath: string): Promise<PersistedRuntimeSecrets> {
  const value = await readJsonFile(filePath, '运行时密钥');
  return value === null ? {} : parseSecrets(value);
}

function environmentValue(environment: RuntimeEnvironment, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function decryptSecret(
  encrypted: string | undefined,
  storage: SafeStoragePort,
): string | undefined {
  if (encrypted === undefined) return undefined;
  if (!storage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法读取已保存的 API Key。');
  }
  return storage.decryptString(Buffer.from(encrypted, 'base64'));
}

function secretStatus(saved: string | undefined, environment: string | undefined) {
  if (saved !== undefined) return { configured: true, source: 'saved' as const };
  if (environment !== undefined) return { configured: true, source: 'environment' as const };
  return { configured: false };
}

/** 每个 Turn 都从磁盘重新读取，保证保存后的设置只从下一 Turn 起生效。 */
export async function loadRuntimeConfiguration(
  settingsFilePath: string,
  secretsFilePath: string,
  storage: SafeStoragePort,
  environment: RuntimeEnvironment = process.env,
): Promise<RuntimeConfiguration> {
  const [saved, secrets] = await Promise.all([
    loadPersistedSettings(settingsFilePath),
    loadPersistedSecrets(secretsFilePath),
  ]);
  const savedDeepSeekKey = decryptSecret(secrets.deepSeekApiKey, storage);
  const savedVisionKey = decryptSecret(secrets.visionApiKey, storage);
  const deepSeekApiKey = savedDeepSeekKey ?? environmentValue(environment, 'DEEPSEEK_API_KEY');
  const deepSeekBaseUrl = saved.deepSeekBaseUrl ?? environmentValue(environment, 'DEEPSEEK_BASE_URL');
  const deepSeekModel = saved.deepSeekModel ?? environmentValue(environment, 'DEEPSEEK_MODEL');
  const visionApiKey = savedVisionKey ?? environmentValue(environment, 'OPENAI_API_KEY');
  const visionBaseUrl = saved.visionBaseUrl ?? environmentValue(environment, 'OPENAI_BASE_URL');
  const whisperModelPath = saved.whisperModelPath ?? environmentValue(environment, 'WHISPER_MODEL_PATH');
  const whisperCliPath = saved.whisperCliPath ?? environmentValue(environment, 'WHISPER_CLI_PATH');
  return {
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
    ...(deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl }),
    ...(deepSeekModel === undefined ? {} : { deepSeekModel }),
    ...(visionApiKey === undefined ? {} : { visionApiKey }),
    ...(visionBaseUrl === undefined ? {} : { visionBaseUrl }),
    ...(whisperModelPath === undefined ? {} : { whisperModelPath }),
    ...(whisperCliPath === undefined ? {} : { whisperCliPath }),
  };
}

export async function loadRuntimeSettings(
  settingsFilePath: string,
  secretsFilePath: string,
  storage: SafeStoragePort,
  environment: RuntimeEnvironment = process.env,
): Promise<RuntimeSettings> {
  const [saved, secrets] = await Promise.all([
    loadPersistedSettings(settingsFilePath),
    loadPersistedSecrets(secretsFilePath),
  ]);
  // 即使 Renderer 只需要状态，也必须确认本机密文能由当前系统安全存储解密。
  decryptSecret(secrets.deepSeekApiKey, storage);
  decryptSecret(secrets.visionApiKey, storage);
  const deepSeekEnvironmentKey = environmentValue(environment, 'DEEPSEEK_API_KEY');
  const visionEnvironmentKey = environmentValue(environment, 'OPENAI_API_KEY');
  return {
    deepSeek: {
      apiKey: secretStatus(secrets.deepSeekApiKey, deepSeekEnvironmentKey),
      baseUrl: saved.deepSeekBaseUrl
        ?? environmentValue(environment, 'DEEPSEEK_BASE_URL')
        ?? DEEPSEEK_DEFAULT_BASE_URL,
      model: saved.deepSeekModel
        ?? environmentValue(environment, 'DEEPSEEK_MODEL')
        ?? DEEPSEEK_DEFAULT_MODEL,
    },
    vision: {
      apiKey: secretStatus(secrets.visionApiKey, visionEnvironmentKey),
      baseUrl: saved.visionBaseUrl
        ?? environmentValue(environment, 'OPENAI_BASE_URL')
        ?? VISION_DEFAULT_BASE_URL,
    },
    whisper: {
      modelPath: saved.whisperModelPath ?? environmentValue(environment, 'WHISPER_MODEL_PATH') ?? '',
      cliPath: saved.whisperCliPath ?? environmentValue(environment, 'WHISPER_CLI_PATH') ?? '',
    },
  };
}

function applySetting(
  current: PersistedRuntimeSettings,
  key: keyof PersistedRuntimeSettings,
  value: string | null | undefined,
): PersistedRuntimeSettings {
  if (value === undefined) return current;
  const next = { ...current };
  if (value === null || value.length === 0) delete next[key];
  else Object.assign(next, { [key]: value });
  return next;
}

function applySecret(
  current: PersistedRuntimeSecrets,
  key: keyof PersistedRuntimeSecrets,
  value: string | null | undefined,
  storage: SafeStoragePort,
): PersistedRuntimeSecrets {
  if (value === undefined) return current;
  const next = { ...current };
  if (value === null || value.length === 0) {
    delete next[key];
    return next;
  }
  if (!storage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法保存 API Key。');
  }
  Object.assign(next, { [key]: storage.encryptString(value).toString('base64') });
  return next;
}

export async function saveRuntimeSettings(
  settingsFilePath: string,
  secretsFilePath: string,
  update: RuntimeSettingsUpdate,
  storage: SafeStoragePort,
): Promise<void> {
  let settings = await loadPersistedSettings(settingsFilePath);
  settings = applySetting(settings, 'deepSeekBaseUrl', update.deepSeekBaseUrl);
  settings = applySetting(settings, 'deepSeekModel', update.deepSeekModel);
  settings = applySetting(settings, 'visionBaseUrl', update.visionBaseUrl);
  settings = applySetting(settings, 'whisperModelPath', update.whisperModelPath);
  settings = applySetting(settings, 'whisperCliPath', update.whisperCliPath);

  let secrets = await loadPersistedSecrets(secretsFilePath);
  if ((update.deepSeekApiKey !== undefined || update.visionApiKey !== undefined)
    && !storage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法修改 API Key。');
  }
  secrets = applySecret(secrets, 'deepSeekApiKey', update.deepSeekApiKey, storage);
  secrets = applySecret(secrets, 'visionApiKey', update.visionApiKey, storage);

  await Promise.all([
    writeFile(settingsFilePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8'),
    writeFile(secretsFilePath, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8'),
  ]);
}
