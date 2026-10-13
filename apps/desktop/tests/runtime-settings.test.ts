import { createServer } from 'node:http';
import { DEFAULT_MODEL_PROVIDERS, type RuntimeModelProviderUpdate } from '@agent-desktop/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readDesktopDocument, writeDesktopDocuments } from '../src/main/desktop-database.js';
import {
  parseRuntimeSettingsUpdate,
  listProviderModels,
  loadRuntimeConfiguration,
  loadRuntimeSettings,
  saveRuntimeSettings,
  type SafeStoragePort,
} from '../src/main/runtime-settings.js';

const temporaryDirectories: string[] = [];
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
};

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-settings-'));
  temporaryDirectories.push(directory);
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
  it('preserves appearance and local paths independently of selected models', async () => {
    const { database } = await paths();
    await saveRuntimeSettings(database, { theme: 'dark', whisperModelPath: 'D:/models/a.bin' }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ theme: 'dark', whisper: { modelPath: 'D:/models/a.bin' } });
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('theme');
    await saveRuntimeSettings(database, { theme: null, whisperModelPath: null }, storage);
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
    expect(await loadRuntimeConfiguration(database, storage, env)).toMatchObject({ deepSeekApiKey: 'environment-key', deepSeekModel: 'environment-model', whisperModelPath: 'a.bin', useDeepSeekThinking: false });
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
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ deepSeekApiKey: 'plain-test-secret', deepSeekModel: 'test-model', modelProtocol: 'responses', modelMaxOutputTokens: 4000, visionProtocol: 'responses', visionModel: 'test-model', visionMaxOutputTokens: 4000 });
    await saveRuntimeSettings(database, { modelProvider: provider({ displayName: '修改名称' }) }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).toHaveProperty('deepSeekApiKey', 'plain-test-secret');
    await saveRuntimeSettings(database, { modelProvider: provider({ apiKey: null }), fallbackVisionModel: null, fallbackVisionEnabled: false }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('deepSeekApiKey');
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('visionApiKey');
  });
  it('keeps official capabilities scoped to the verified endpoint for environment and old fixed settings', async () => {
    const { database } = await paths();
    const official = { DEEPSEEK_API_KEY: 'environment-key', DEEPSEEK_MODEL: 'deepseek-flash' };
    expect(await loadRuntimeConfiguration(database, storage, official)).toHaveProperty('visionModel', 'deepseek-flash');
    const relay = { ...official, DEEPSEEK_BASE_URL: 'https://relay.test/v1' };
    expect(await loadRuntimeConfiguration(database, storage, relay)).toMatchObject({ deepSeekModel: 'deepseek-flash', visionUnavailableReason: expect.stringContaining('未知') });
    expect(await loadRuntimeConfiguration(database, storage, relay)).not.toHaveProperty('visionApiKey');
    writeDesktopDocuments(database, [{ name: 'runtime-settings', value: { visionBaseUrl: 'https://old-relay.test/v1' } }]);
    expect((await loadRuntimeSettings(database, storage, {})).modelProviders[1]!.models[0]!.capabilities.imageInput).toBe('unknown');
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
  it('migrates prior SQLite settings and encrypted credentials without losing their values', async () => {
    const { database } = await paths();
    writeDesktopDocuments(database, [
      { name: 'runtime-settings', value: { deepSeekModel: 'legacy-model', deepSeekBaseUrl: 'https://legacy.test', visionBaseUrl: 'https://vision.test/v1', whisperModelPath: 'legacy.bin' } },
      { name: 'runtime-secrets', value: { deepSeekApiKey: storage.encryptString('legacy-secret').toString('base64') } },
    ]);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ deepSeekApiKey: 'legacy-secret', deepSeekModel: 'legacy-model', deepSeekBaseUrl: 'https://legacy.test', whisperModelPath: 'legacy.bin' });
    await saveRuntimeSettings(database, { theme: 'light' }, storage);
    expect(readDesktopDocument(database, 'runtime-settings')).not.toHaveProperty('deepSeekModel');
    expect(readDesktopDocument(database, 'runtime-secrets')).toHaveProperty('providerApiKeys.deepseek');
  });
  it('drops prior provider identities while migrating visual selection, preserving catalog and secrets across reload', async () => {
    const { database } = await paths();
    writeDesktopDocuments(database, [
      { name: 'runtime-settings', value: { modelProviders: DEFAULT_MODEL_PROVIDERS.map(({ apiKey: _key, ...item }, index) => ({ ...item, builtin: index === 0, models: item.models.map(({ capabilities, ...model }) => ({ ...model, images: capabilities.imageInput === 'supported' })) })),
        conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, visionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' } } },
      { name: 'runtime-secrets', value: { providerApiKeys: { openai: storage.encryptString('legacy-vision-key').toString('base64') } } },
    ]);
    const loaded = await loadRuntimeSettings(database, storage, {});
    expect(loaded).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' } });
    for (const [index, item] of loaded.modelProviders.entries()) {
      expect(item).not.toHaveProperty('builtin');
      const expected = DEFAULT_MODEL_PROVIDERS[index]!;
      expect(item).toMatchObject({ id: expected.id, displayName: expected.displayName, baseUrl: expected.baseUrl, protocol: expected.protocol, models: expected.models });
    }
    expect(await loadRuntimeConfiguration(database, storage, {})).not.toHaveProperty('visionApiKey');
    await saveRuntimeSettings(database, { fallbackVisionEnabled: true }, storage);
    expect(await loadRuntimeConfiguration(database, storage, {})).toMatchObject({ visionModel: 'gpt-5.6-luna', visionApiKey: 'legacy-vision-key', visionProtocol: 'responses' });
    await saveRuntimeSettings(database, { fallbackVisionEnabled: false }, storage);
    expect(await loadRuntimeSettings(database, storage, {})).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' } });
    expect(readDesktopDocument(database, 'runtime-settings')).not.toHaveProperty('visionModel');
    expect(JSON.stringify(readDesktopDocument(database, 'runtime-settings'))).not.toContain('builtin');
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
