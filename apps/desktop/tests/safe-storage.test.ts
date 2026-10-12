import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as secretStorage from '../src/main/safe-storage.js';
import { readDesktopDocument, writeDesktopDocuments } from '../src/main/desktop-database.js';
import { saveRuntimeSettings } from '../src/main/runtime-settings.js';
import { ExtensionConnections } from '../src/main/extension-connections.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const roots: string[] = [];
const storage: secretStorage.SafeStoragePort = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
async function temp() { const directory = await mkdtemp(join(tmpdir(), 'desktop-safe-storage-')); roots.push(directory); return directory; }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Windows safe storage key persistence', () => {
  it('waits for an actual encrypted key after unrelated events and an incomplete Local State, including atomic replacement', async () => {
    const directory = await temp(); const path = join(directory, 'Local State');
    await writeFile(path, JSON.stringify({ os_crypt: {} }));
    const read = vi.spyOn(files, 'readFile');
    const completed = vi.fn();
    const pending = secretStorage.waitForSafeStorageKey(path).then(completed);
    // 先完成初次真实读取，再替换文件；不让测试自身的写入与未关闭的读取句柄竞争。
    await read.mock.results[0]!.value;
    await writeFile(join(directory, 'unrelated'), 'event');
    expect(completed).not.toHaveBeenCalled();
    const staged = join(directory, 'key-stage');
    await writeFile(staged, JSON.stringify({ os_crypt: { encrypted_key: 'operating-system-protected-key' } }));
    await rename(staged, path);
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it('returns immediately for a persisted key and clears its deadline timer', async () => {
    const directory = await temp(); const path = join(directory, 'Local State');
    await writeFile(path, JSON.stringify({ os_crypt: { encrypted_key: 'persisted-key' } }));
    vi.useFakeTimers();
    await secretStorage.waitForSafeStorageKey(path);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails within the fixed twenty-second budget and clears the timer', async () => {
    const directory = await temp();
    vi.useFakeTimers();
    const pending = expect(secretStorage.waitForSafeStorageKey(join(directory, 'Local State'))).rejects.toThrow('20 秒');
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes malformed Local State and non-missing IO errors rather than waiting or inventing a key', async () => {
    const directory = await temp(); const path = join(directory, 'Local State');
    await writeFile(path, '{broken');
    await expect(secretStorage.waitForSafeStorageKey(path)).rejects.toBeInstanceOf(SyntaxError);
    await rm(path); await mkdir(path);
    await expect(secretStorage.waitForSafeStorageKey(path)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('credential database commits await encryption durability', () => {
  it('preserves appearance and memory saves made while a model credential awaits durability', async () => {
    const database = join(await temp(), 'db.sqlite');
    await saveRuntimeSettings(database, { theme: 'dark', memoryEnabled: true }, storage);
    let release!: (value: Buffer) => void;
    vi.spyOn(secretStorage, 'encryptSecret').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = saveRuntimeSettings(database, { modelProvider: { id: 'custom', displayName: 'Custom', baseUrl: 'https://example.com/v1',
      protocol: 'responses', models: [{ id: 'model', displayName: 'Model', images: true }], apiKey: 'test-secret' } }, storage);
    await saveRuntimeSettings(database, { theme: 'light' }, storage);
    await saveRuntimeSettings(database, { memoryEnabled: false }, storage);
    expect(readDesktopDocument(database, 'runtime-settings')).toMatchObject({ theme: 'light', memoryEnabled: false });
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({});
    release(Buffer.from('ciphertext-fixture')); await pending;
    expect(readDesktopDocument(database, 'runtime-settings')).toMatchObject({ theme: 'light', memoryEnabled: false,
      modelProviders: expect.arrayContaining([expect.objectContaining({ id: 'custom' })]) });
    expect(readDesktopDocument(database, 'runtime-secrets')).toMatchObject({ providerApiKeys: { custom: Buffer.from('ciphertext-fixture').toString('base64') } });
  });

  it('keeps the prior model directory and secret until encryption is durable, and preserves them when waiting fails', async () => {
    const database = join(await temp(), 'db.sqlite');
    const previous = { theme: 'dark' };
    writeDesktopDocuments(database, [{ name: 'runtime-settings', value: previous }, { name: 'runtime-secrets', value: {} }]);
    let release!: (value: Buffer) => void;
    const encrypt = vi.spyOn(secretStorage, 'encryptSecret').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const update = { theme: 'light' as const, modelProvider: { id: 'custom', displayName: 'Custom', baseUrl: 'https://example.com/v1',
      protocol: 'responses' as const, models: [{ id: 'model', displayName: 'Model', images: true }], apiKey: 'test-secret' } };
    const pending = saveRuntimeSettings(database, update, storage);
    expect(readDesktopDocument(database, 'runtime-settings')).toEqual(previous);
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual({});
    release(Buffer.from('ciphertext-fixture')); await pending;
    const saved = readDesktopDocument(database, 'runtime-settings');
    const secrets = readDesktopDocument(database, 'runtime-secrets');
    const failure = new Error('master key persistence failed');
    encrypt.mockRejectedValueOnce(failure);
    await expect(saveRuntimeSettings(database, { ...update, theme: 'dark' }, storage)).rejects.toBe(failure);
    expect(readDesktopDocument(database, 'runtime-settings')).toEqual(saved);
    expect(readDesktopDocument(database, 'runtime-secrets')).toEqual(secrets);
  });

  it.each(['configuration', 'client', 'tokens', 'invalidate', 'disconnect'] as const)('awaits %s encryption before persisting plugin or OAuth credentials', async operation => {
    const database = join(await temp(), 'db.sqlite');
    const connections = new ExtensionConnections(database, storage, async () => undefined);
    const key = operation === 'configuration' ? 'plugin:test/service' : 'plugin:test/service/https://example.com/mcp';
    const previous = { ciphertext: Buffer.from(JSON.stringify({ values: { TOKEN: 'old' }, tokens: { access_token: 'old-token', token_type: 'Bearer' } })).toString('base64') };
    writeDesktopDocuments(database, [{ name: `extension-secret:${key}`, value: previous }]);
    const provider = connections.provider('plugin:test', 'service', 'https://example.com/mcp');
    const save = () => operation === 'configuration' ? connections.configure('plugin:test', 'service', { TOKEN: 'new' })
      : operation === 'client' ? provider.saveClientInformation!({ client_id: 'client' })
        : operation === 'tokens' ? provider.saveTokens({ access_token: 'new-token', token_type: 'Bearer' })
          : operation === 'invalidate' ? provider.invalidateCredentials!('tokens') : connections.disconnect('plugin:test', 'service', 'https://example.com/mcp');
    let release!: (value: Buffer) => void;
    const encrypt = vi.spyOn(secretStorage, 'encryptSecret').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const completed = vi.fn(); const pending = Promise.resolve(save()).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(readDesktopDocument(database, `extension-secret:${key}`)).toEqual(previous);
    release(Buffer.from('{}')); await pending;
    const saved = readDesktopDocument(database, `extension-secret:${key}`);
    const failure = new Error('master key persistence failed'); encrypt.mockRejectedValueOnce(failure);
    await expect(Promise.resolve(save())).rejects.toBe(failure);
    expect(readDesktopDocument(database, `extension-secret:${key}`)).toEqual(saved);
  });
});
