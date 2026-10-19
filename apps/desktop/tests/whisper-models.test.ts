import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhisperModels } from '../src/main/whisper-models.js';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('electron', async () => {
  const { fetchSessionFixture } = await import('./electron-session-fixture.js');
  return { net: { fetch: network.fetch }, session: { fromPartition: () => fetchSessionFixture(network.fetch) } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
const roots: string[] = [];
const bytes = Buffer.from('verified local model fixture');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'whisper-models-')); roots.push(root);
  const directory = join(root, 'models'); const lockPath = join(root, 'models.lock.json');
  const revision = 'a'.repeat(40);
  await writeFile(lockPath, JSON.stringify({ id: 'small', name: 'Whisper Small', file: 'ggml-small.bin', revision,
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/ggml-small.bin`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const changed = vi.fn();
  return { root, directory, lockPath, changed, models: new WhisperModels(directory, lockPath, changed) };
}
afterEach(async () => { vi.restoreAllMocks(); network.fetch.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('managed Whisper model boundary', () => {
  it('denies remote downloads and redirect targets before contacting them while bundled installs stay offline', async () => {
    const { root, directory, lockPath, changed } = await setup();
    const authorize = vi.fn(async () => false);
    const models = new WhisperModels(directory, lockPath, changed, undefined, authorize);
    await expect(models.install()).rejects.toThrow('网络策略拒绝'); expect(network.fetch).not.toHaveBeenCalled();
    authorize.mockResolvedValueOnce(true);
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/model.bin' } }));
    await expect(models.install()).rejects.toThrow('网络策略拒绝');
    expect(network.fetch).toHaveBeenCalledOnce();
    expect(network.fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'follow' });
    expect(authorize).toHaveBeenLastCalledWith({ url: 'https://cdn.example.test/model.bin', method: 'GET', resourceType: 'whisper-model' });
    const bundled = join(root, 'bundled.bin'); await writeFile(bundled, bytes);
    authorize.mockClear();
    await new WhisperModels(directory, lockPath, changed, bundled, authorize).install();
    expect(authorize).not.toHaveBeenCalled(); expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('downloads authorized CDN redirects with the same cancellation signal and rejects nonweb or credential targets', async () => {
    const { directory, lockPath, changed } = await setup(); const authorize = vi.fn(async () => true);
    const models = new WhisperModels(directory, lockPath, changed, undefined, authorize);
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/model.bin' } })).mockResolvedValueOnce(new Response(bytes));
    await models.install(); expect(await models.status()).toMatchObject({ status: 'ready' });
    expect(network.fetch.mock.calls[1]![1].signal).toBe(network.fetch.mock.calls[0]![1].signal);
    await models.delete(); network.fetch.mockClear(); authorize.mockClear();
    for (const target of ['file:///C:/model.bin', 'https://secret:token@cdn.example.test/model.bin']) {
      network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } }));
      await expect(models.install()).rejects.toThrow('下载地址无效');
    }
    expect(network.fetch).toHaveBeenCalledTimes(2); expect(authorize).toHaveBeenCalledTimes(2);
  });
  it('downloads, verifies, reuses and restores the controlled file without exposing a partial model', async () => {
    const { models, directory, lockPath, changed } = await setup();
    network.fetch.mockResolvedValue(new Response(bytes));
    expect(await models.status()).toMatchObject({ status: 'missing', diskBytes: 0 });
    await models.install();
    expect(await models.status()).toMatchObject({ status: 'ready', size: bytes.length, diskBytes: bytes.length });
    expect(await readFile((await models.path())!)).toEqual(bytes);
    expect(changed).toHaveBeenCalled();
    await expect(stat(join(directory, 'ggml-small.bin.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = new WhisperModels(directory, lockPath, changed);
    await restored.install(); expect(network.fetch).toHaveBeenCalledOnce();
    await writeFile(join(directory, 'ggml-small.bin'), Buffer.alloc(bytes.length, 1));
    expect(await restored.status()).toMatchObject({ status: 'error', message: expect.stringContaining('SHA-256') });
    await expect(restored.path()).rejects.toThrow('SHA-256');
    await restored.delete(); expect(await restored.status()).toMatchObject({ status: 'missing' });
  });
  it('cleans failed downloads, never reports ready and permits a verified retry', async () => {
    const { models, directory } = await setup();
    network.fetch.mockResolvedValueOnce(new Response('corrupt')).mockResolvedValueOnce(new Response(bytes));
    await expect(models.install()).rejects.toThrow('校验失败');
    expect(await models.status()).toMatchObject({ status: 'error' });
    expect(await models.path()).toBeUndefined();
    await expect(stat(join(directory, 'ggml-small.bin.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    await models.install(); expect(await models.status()).toMatchObject({ status: 'ready' });
  });
  it('requires disk space before network activity and only imports a matching model', async () => {
    const { root, models } = await setup();
    vi.mocked(filesystem.statfs).mockResolvedValueOnce({ bavail: 0, bsize: 4096 } as Awaited<ReturnType<typeof filesystem.statfs>>);
    await expect(models.install()).rejects.toThrow('磁盘空间不足');
    expect(network.fetch).not.toHaveBeenCalled();
    const source = join(root, 'local.bin'); await writeFile(source, 'invalid');
    await expect(models.install(source)).rejects.toThrow('完整');
    await writeFile(source, bytes); await models.install(source);
    await models.delete(); expect(await readFile(source)).toEqual(bytes);
  });
  it('rejects file and directory links and unverified provenance', async () => {
    const { root, directory, lockPath, models } = await setup();
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'ggml-small.bin'), bytes);
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(models.path()).rejects.toThrow('目录链接');
    await expect(models.install()).rejects.toThrow('目录链接');
    await expect(models.delete()).rejects.toThrow('目录链接');
    expect(await readFile(join(outside, 'ggml-small.bin'))).toEqual(bytes);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    await writeFile(lockPath, JSON.stringify({ ...lock, url: 'https://unverified.test/model.bin' }));
    await expect(models.install()).rejects.toThrow('来源');
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
