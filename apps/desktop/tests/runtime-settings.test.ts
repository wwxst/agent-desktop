import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
    settings: join(directory, 'runtime-settings.json'),
    secrets: join(directory, 'runtime-secrets.json'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('desktop runtime settings', () => {
  it('uses saved values before environment values and decrypts secrets only for Main', async () => {
    const file = await paths();
    await saveRuntimeSettings(file.settings, file.secrets, {
      deepSeekApiKey: 'saved-deepseek-key',
      deepSeekBaseUrl: 'https://saved.deepseek.test',
      deepSeekModel: 'saved-model',
      visionApiKey: 'saved-vision-key',
      whisperModelPath: 'D:\\saved\\whisper.bin',
    }, storage);

    const environment = {
      DEEPSEEK_API_KEY: 'environment-deepseek-key',
      DEEPSEEK_BASE_URL: 'https://environment.deepseek.test',
      DEEPSEEK_MODEL: 'environment-model',
      OPENAI_API_KEY: 'environment-vision-key',
      WHISPER_MODEL_PATH: 'D:\\environment\\whisper.bin',
    };
    const configuration = await loadRuntimeConfiguration(
      file.settings,
      file.secrets,
      storage,
      environment,
    );
    const rendererSettings = await loadRuntimeSettings(file.settings, file.secrets, storage, environment);

    expect(configuration).toMatchObject({
      deepSeekApiKey: 'saved-deepseek-key',
      deepSeekBaseUrl: 'https://saved.deepseek.test',
      deepSeekModel: 'saved-model',
      visionApiKey: 'saved-vision-key',
      whisperModelPath: 'D:\\saved\\whisper.bin',
    });
    expect(rendererSettings.deepSeek.apiKey).toEqual({ configured: true, source: 'saved' });
    expect(rendererSettings.vision.apiKey).toEqual({ configured: true, source: 'saved' });
    expect(JSON.stringify(rendererSettings)).not.toContain('saved-deepseek-key');
    expect(JSON.stringify(rendererSettings)).not.toContain('saved-vision-key');
  });

  it('falls back to environment variables after clearing saved keys', async () => {
    const file = await paths();
    await saveRuntimeSettings(file.settings, file.secrets, {
      deepSeekApiKey: 'saved-key',
      visionApiKey: 'saved-vision-key',
    }, storage);
    await saveRuntimeSettings(file.settings, file.secrets, {
      deepSeekApiKey: null,
      visionApiKey: null,
    }, storage);

    const environment = {
      DEEPSEEK_API_KEY: 'environment-key',
      OPENAI_API_KEY: 'environment-vision-key',
    };
    await expect(loadRuntimeConfiguration(
      file.settings,
      file.secrets,
      storage,
      environment,
    )).resolves.toMatchObject({
      deepSeekApiKey: 'environment-key',
      visionApiKey: 'environment-vision-key',
    });
    await expect(loadRuntimeSettings(file.settings, file.secrets, storage, environment)).resolves.toMatchObject({
      deepSeek: { apiKey: { configured: true, source: 'environment' } },
      vision: { apiKey: { configured: true, source: 'environment' } },
    });
  });

  it('encrypts API keys and never writes plaintext into either JSON file', async () => {
    const file = await paths();
    await saveRuntimeSettings(file.settings, file.secrets, {
      deepSeekApiKey: 'plain-deepseek-secret',
      visionApiKey: 'plain-vision-secret',
      deepSeekModel: 'test-model',
    }, storage);

    const contents = `${await readFile(file.settings, 'utf8')}\n${await readFile(file.secrets, 'utf8')}`;
    expect(contents).not.toContain('plain-deepseek-secret');
    expect(contents).not.toContain('plain-vision-secret');
    expect(contents).toContain(Buffer.from('protected:plain-deepseek-secret').toString('base64'));
  });

  it('fails explicitly instead of saving plaintext when safeStorage is unavailable', async () => {
    const file = await paths();
    const unavailable = { ...storage, isEncryptionAvailable: () => false };

    await expect(saveRuntimeSettings(file.settings, file.secrets, {
      deepSeekApiKey: 'must-not-be-written',
    }, unavailable)).rejects.toThrow('系统安全存储不可用');
  });
});
