import { createServer } from 'node:http';
import { DEFAULT_MODEL_PROVIDERS, type RuntimeModelProviderUpdate } from '@agent-desktop/client';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readDesktopDocument } from '../src/main/desktop-database.js';
import {
  parseRuntimeSettingsUpdate,
  listProviderModels,
  loadRuntimeConfiguration,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../src/main/runtime-settings.js';
import type { SafeStoragePort } from '../src/main/safe-storage.js';

const temporaryDirectories: string[] = [];
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
};

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-settings-'));
  temporaryDirectories.push(directory);
  // 本文件使用加密替身；真实 Windows 主密钥的延迟落盘由安全存储专项与 Electron 验收覆盖。
  await writeFile(join(directory, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'test-key' } }));
  return {
    database: join(directory, 'agent-desktop.sqlite'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

const provider = (changes: Partial<RuntimeModelProviderUpdate> = {}): RuntimeModelProviderUpdate => ({
  id: 'custom-test', displayName: '测试供应商', baseUrl: 'https://example.com/v1', protocol: 'responses',
  models: [{ id: 'test-model', displayName: '测试模型', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' }, contextWindow: 128000, maxOutputTokens: 4000 }], ...changes,
});
describe('desktop runtime settings', () => {
  it('preserves appearance independently of selected models', async () => {
    const { database } = await paths();
    await saveRuntimeSettings(database, { theme: 'dark' }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ theme: 'dark' });
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('theme');
    await saveRuntimeSettings(database, { theme: null }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).not.toHaveProperty('theme');
  });
  it('persists memory controls with enabled defaults', async () => {
    const { database } = await paths();
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ memoryEnabled: true, memoryFromToolChatsEnabled: true });
    await saveRuntimeSettings(database, { memoryEnabled: false, memoryFromToolChatsEnabled: false }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ memoryEnabled: false, memoryFromToolChatsEnabled: false });
  });
  it('uses environment defaults and reports secret sources without exposing keys', async () => {
    const { database } = await paths();
    const env = { DEEPSEEK_API_KEY: 'environment-key', DEEPSEEK_BASE_URL: 'https://proxy.test/v1', DEEPSEEK_MODEL: 'environment-model', WHISPER_MODEL_PATH: 'a.bin' };
    const settings = await loadRuntimeSettings(database, storage, env);
    expect(settings.modelProviders[0]).toMatchObject({ baseUrl: 'https://proxy.test/v1', apiKey: { configured: true, source: 'environment' }, models: [{ id: 'environment-model' }] });
    expect(JSON.stringify(settings)).not.toContain('environment-key');
    const configuration = await loadRuntimeConfiguration(database, storage, env);
    expect(configuration).toMatchObject({ conversationModel: { providerId: 'deepseek', modelId: 'environment-model' }, deepSeekApiKey: 'environment-key', deepSeekModel: 'environment-model', useDeepSeekThinking: false });
    expect(configuration).not.toHaveProperty('whisperModelPath');
  });
  it('saves encrypted credentials and drives both conversation and vision configuration after reload', async () => {
    const { database } = await paths();
    const choice = { providerId: 'custom-test', modelId: 'test-model' };
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'plain-test-secret' }), conversationModel: choice }, storage);
    const settings = await loadRuntimeSettings(database, storage, {});
    expect(settings.conversationModel).toEqual(choice);
    expect(settings.modelProviders.at(-1)).toMatchObject({ apiKey: { configured: true, source: 'saved' } });
    expect(JSON.stringify(settings)).not.toContain('plain-test-secret');
    expect((await readFile(database)).includes(Buffer.from('plain-test-secret'))).toBe(false);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ conversationModel: choice, deepSeekApiKey: 'plain-test-secret', deepSeekModel: 'test-model', modelProtocol: 'responses', modelContextWindow: 128000, modelMaxOutputTokens: 4000, visionProtocol: 'responses', visionModel: 'test-model', visionMaxOutputTokens: 4000 });
    await saveRuntimeSettings(database, { modelProvider: provider({ displayName: '修改名称' }) }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).toHaveProperty('deepSeekApiKey', 'plain-test-secret');
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: null }), fallbackVisionModel: null, fallbackVisionEnabled: false }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('deepSeekApiKey');
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('visionApiKey');
  });
  it('keeps official capabilities scoped to the verified endpoint for environment settings', async () => {
    const { database } = await paths();
    const official = { DEEPSEEK_API_KEY: 'environment-key', DEEPSEEK_MODEL: 'deepseek-flash' };
    expect(await loadRuntimeConfiguration(database, storage, official)).toMatchObject({ visionModel: 'deepseek-flash', modelContextWindow: 1048576 });
    const relay = { ...official, DEEPSEEK_BASE_URL: 'https://relay.test/v1' };
    expect(await loadRuntimeConfiguration(database, storage, relay)).toMatchObject({ deepSeekModel: 'deepseek-flash', visionUnavailableReason: expect.stringContaining('未知') });
    expect(await loadRuntimeConfiguration(database, storage, relay)).not.toHaveProperty('visionApiKey');
    expect(await loadRuntimeConfiguration(database, storage, relay)).not.toHaveProperty('modelContextWindow');
  });
  it('keeps independently configured window and output limits without inventing the missing value', async () => {
    const { database } = await paths();
    const choice = { providerId: 'custom-test', modelId: 'test-model' };
    const model = { id: 'test-model', displayName: '测试模型', capabilities: { textInput: 'supported' as const, textOutput: 'supported' as const, imageInput: 'unsupported' as const, imageUnderstanding: 'unsupported' as const } };
    await saveRuntimeSettings(database, {
      modelProvider: provider({ models: [{ ...model, contextWindow: 64000 }] }), conversationModel: choice,
    }, storage);
    const windowOnly = await loadRuntimeConfiguration(database, storage, {});
    expect(windowOnly).toHaveProperty('modelContextWindow', 64000);
    expect(windowOnly).not.toHaveProperty('modelMaxOutputTokens');

    await saveRuntimeSettings(database, { modelProvider: provider({ models: [{ ...model, maxOutputTokens: 2048 }] }) }, storage);
    const outputOnly = await loadRuntimeConfiguration(database, storage, {});
    expect(outputOnly).toHaveProperty('modelMaxOutputTokens', 2048);
    expect(outputOnly).not.toHaveProperty('modelContextWindow');

    await saveRuntimeSettings(database, { modelProvider: provider({ models: [model] }) }, storage);
    const unspecified = await loadRuntimeConfiguration(database, storage, {});
    expect(unspecified).not.toHaveProperty('modelContextWindow');
    expect(unspecified).not.toHaveProperty('modelMaxOutputTokens');
  });
  it('reloads both limits from the newly selected model instead of retaining the prior model budget', async () => {
    const { database } = await paths();
    await saveRuntimeSettings(database, {
      modelProvider: provider({ models: [
        { id: 'large', displayName: '大窗口', capabilities: { textInput: 'supported' as const, textOutput: 'supported' as const, imageInput: 'unsupported' as const, imageUnderstanding: 'unsupported' as const }, contextWindow: 128000, maxOutputTokens: 4096 },
        { id: 'small', displayName: '小窗口', capabilities: { textInput: 'supported' as const, textOutput: 'supported' as const, imageInput: 'unsupported' as const, imageUnderstanding: 'unsupported' as const }, contextWindow: 16000, maxOutputTokens: 1024 },
        { id: 'unspecified', displayName: '未配置预算', capabilities: { textInput: 'supported' as const, textOutput: 'supported' as const, imageInput: 'unsupported' as const, imageUnderstanding: 'unsupported' as const } },
      ] }),
      conversationModel: { providerId: 'custom-test', modelId: 'large' },
    }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ modelContextWindow: 128000, modelMaxOutputTokens: 4096 });
    await saveRuntimeSettings(database, { conversationModel: { providerId: 'custom-test', modelId: 'small' } }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ deepSeekModel: 'small', modelContextWindow: 16000, modelMaxOutputTokens: 1024 });
    await saveRuntimeSettings(database, { conversationModel: { providerId: 'custom-test', modelId: 'unspecified' } }, storage);
    const configuration = await loadRuntimeConfiguration(database, storage, {});
    expect(configuration).not.toHaveProperty('modelContextWindow');
    expect(configuration).not.toHaveProperty('modelMaxOutputTokens');
  });
  it('clearing an internal saved key returns to the environment source', async () => {
    const { database } = await paths();
    const { apiKey: _key, ...deepseek } = DEFAULT_MODEL_PROVIDERS[0]!;
    await saveRuntimeSettings(database, { modelProvider: { ...deepseek, apiKey: 'saved-key' } }, storage);
    expect(await loadRuntimeConfiguration(database, storage, { DEEPSEEK_API_KEY: 'env-key' })).toHaveProperty('deepSeekApiKey', 'saved-key');
    await saveRuntimeSettings(database, { modelProvider: { ...deepseek, apiKey: null } }, storage);
    expect((await loadRuntimeSettings(database, storage, { DEEPSEEK_API_KEY: 'env-key' })).modelProviders[0]!.apiKey).toEqual({ configured: true, source: 'environment' });
  });
  it('rejects deletion of a selected supplier, then deletes it and its secret after switching', async () => {
    const { database } = await paths();
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'test-key' }), conversationModel: { providerId: 'custom-test', modelId: 'test-model' } }, storage);
    await expect(saveRuntimeSettings(database, { deleteModelProviderId: 'custom-test' }, storage)).rejects.toThrow('切换模型');
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders).toHaveLength(3);
    await saveRuntimeSettings(database, { deleteModelProviderId: 'custom-test', conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } }, storage);
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders).toHaveLength(2);
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({ providerApiKeys: {} });
    await expect(saveRuntimeSettings(database, { deleteModelProviderId: 'deepseek' }, storage)).rejects.toThrow('切换模型');
  });
  it('deletes unused initially supplied providers and their secrets without restoring them on reload', async () => {
    const { database } = await paths();
    for (const { apiKey: _key, ...item } of DEFAULT_MODEL_PROVIDERS) {
      await saveRuntimeSettings(database, { modelProvider: { ...item, apiKey: `${item.id}-saved-key` } }, storage);
    }
    const fallbackVisionModel = { providerId: 'openai', modelId: DEFAULT_MODEL_PROVIDERS[1]!.models[0]!.id };
    await saveRuntimeSettings(database, { fallbackVisionModel, fallbackVisionEnabled: true }, storage);
    await expect(saveRuntimeSettings(database, { deleteModelProviderId: 'openai' }, storage)).rejects.toThrow('切换模型');
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders).toHaveLength(2);
    await saveRuntimeSettings(database, { deleteModelProviderId: 'openai', fallbackVisionEnabled: false }, storage);
    expect(await loadRuntimeSettings(database, storage, { OPENAI_API_KEY: 'environment-key' })).toMatchObject({
      modelProviders: [{ id: 'deepseek' }], fallbackVisionModel: null, fallbackVisionEnabled: false,
    });
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({ providerApiKeys: { deepseek: expect.any(String) } });
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'custom-key' }), conversationModel: { providerId: 'custom-test', modelId: 'test-model' } }, storage);
    await saveRuntimeSettings(database, { deleteModelProviderId: 'deepseek' }, storage);
    const restored = await loadRuntimeSettings(database, storage, { DEEPSEEK_API_KEY: 'environment-key' });
    expect(restored.modelProviders.map(item => item.id)).toEqual(['custom-test']);
    expect(restored.conversationModel).toEqual({ providerId: 'custom-test', modelId: 'test-model' });
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({ providerApiKeys: { 'custom-test': expect.any(String) } });
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ deepSeekApiKey: 'custom-key', deepSeekModel: 'test-model' });
  });
  it('preserves a disabled visual candidate until its supplier is explicitly deleted', async () => {
    const { database } = await paths();
    const fallbackVisionModel = { providerId: 'custom-test', modelId: 'test-model' };
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'test-key' }), fallbackVisionModel, fallbackVisionEnabled: true }, storage);
    await saveRuntimeSettings(database, { fallbackVisionEnabled: false }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel });
    await saveRuntimeSettings(database, { deleteModelProviderId: 'custom-test' }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: null });
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders).toHaveLength(2);
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({ providerApiKeys: {} });
  });
  it('protects an enabled visual supplier unless the same update selects a valid replacement', async () => {
    const { database } = await paths();
    const fallbackVisionModel = { providerId: 'custom-test', modelId: 'test-model' };
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'test-key' }), fallbackVisionModel, fallbackVisionEnabled: true }, storage);
    await expect(saveRuntimeSettings(database, { deleteModelProviderId: 'custom-test' }, storage)).rejects.toThrow('切换模型');
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ fallbackVisionEnabled: true, fallbackVisionModel });
    const replacement = { providerId: 'replacement', modelId: 'test-model' };
    await saveRuntimeSettings(database, { modelProvider: provider({ id: 'replacement', apiKey: 'next-key' }), deleteModelProviderId: 'custom-test', fallbackVisionModel: replacement }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ fallbackVisionEnabled: true, fallbackVisionModel: replacement });
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders.some(item => item.id === 'custom-test')).toBe(false);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ visionApiKey: 'next-key' });
  });
  it('requires an existing model and image capability for visual selection', async () => {
    const { database } = await paths();
    await expect(saveRuntimeSettings(database, { conversationModel: { providerId: 'deepseek', modelId: 'missing' } }, storage)).rejects.toThrow('不在目录');
    await expect(saveRuntimeSettings(database, { fallbackVisionModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, fallbackVisionEnabled: true }, storage)).rejects.toThrow('图片输入');
  });
  it('does not write a provider when system encryption is unavailable', async () => {
    const { database } = await paths();
    await expect(saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'secret' }) }, { ...storage, isEncryptionAvailable: () => false })).rejects.toThrow('无法保存');
    expect(readDesktopDocument(database, 'runtime-settings')).toBeNull();
  });
  it('keeps an already resolved task snapshot while later selections drive new tasks', async () => {
    const { database } = await paths();
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: 'custom-key' }), conversationModel: { providerId: 'custom-test', modelId: 'test-model' } }, storage);
    const snapshot = await loadRuntimeConfiguration(database, storage, {});
    await saveRuntimeSettings(database, { conversationModel: { providerId: 'deepseek', modelId: 'deepseek-flash' } }, storage);
    const next = await loadRuntimeConfiguration(database, storage, { DEEPSEEK_API_KEY: 'main-key' });
    expect(snapshot).toMatchObject({ deepSeekModel: 'test-model', deepSeekApiKey: 'custom-key', visionModel: 'test-model', visionApiKey: 'custom-key', visionProtocol: 'responses' });
    expect(next).toMatchObject({ deepSeekModel: 'deepseek-flash', deepSeekApiKey: 'main-key', visionModel: 'deepseek-flash', visionApiKey: 'main-key', visionProtocol: 'chat-completions' });
  });
  it.each([
    { modelProvider: provider({ models: [] }) },
    { modelProvider: provider({ baseUrl: 'file:///a' }) },
    { modelProvider: provider({ baseUrl: 'https://user:secret@example.com' }) },
    { modelProvider: provider({ models: [{ id: '', displayName: 'name', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }] }) },
    { modelProvider: provider({ models: [{ id: 'a', displayName: 'a', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' }, maxOutputTokens: -1 }] }) },
    { modelProvider: provider({ models: [{ id: 'a', displayName: 'a', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' }, contextWindow: 10, maxOutputTokens: 20 }] }) },
    { modelProvider: provider({ models: [{ id: 'a', displayName: 'a', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }, { id: 'a', displayName: 'a', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }] }) },
    { theme: 'purple' },
  ])('validates user configuration at IPC boundary: %j', value => {
    expect(() => parseRuntimeSettingsUpdate(value)).toThrow();
  });
  it('discovers models through authenticated HTTP and does not guess image capabilities', async () => {
    const { database } = await paths();
    const server = createServer((request, response) => {
      expect(request.url).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer saved-key');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'discovered-model', name: '供应商模型' },
        { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', input_modalities: ['text', 'image'], output_modalities: ['text'] },
        { id: 'deepseek-v4-pro', input_modalities: ['text'], output_modalities: ['text'] }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server port');
    const query = provider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'saved-key' });
    try {
      await saveRuntimeSettings(database, { modelProvider: query }, storage);
      const { apiKey: _key, ...savedQuery } = query;
      expect(await listProviderModels(database, savedQuery, storage)).toEqual([
        { id: 'discovered-model', displayName: '供应商模型', capabilities: { textInput: 'unknown', textOutput: 'unknown', imageInput: 'unknown', imageUnderstanding: 'unknown' } },
        { id: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } },
        { id: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } },
      ]);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
