import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWhisperRuntime, verifyWhisperRuntime } from '../src/main/whisper-runtime.js';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), fetch: vi.fn(), failRuntimeRename: false, runtimeRenameAttempts: 0 }));
vi.mock('electron', async () => {
  const { fetchSessionFixture } = await import('./electron-session-fixture.js');
  return { net: { fetch: boundary.fetch }, session: { fromPartition: () => fetchSessionFixture(boundary.fetch) } };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (source: string, destination: string) => {
    if (source.endsWith('Release')) {
      boundary.runtimeRenameAttempts += 1;
      if (boundary.failRuntimeRename) { boundary.failRuntimeRename = false; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
    }
    return actual.rename(source, destination);
  } };
});
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: () => 'win32', arch: () => 'x64' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: boundary.execute }) };
});
const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const names = ['whisper-cli.exe', 'ggml.dll', 'ggml-cpu.dll', 'ggml-base.dll', 'whisper.dll'];
afterEach(async () => {
  vi.unstubAllEnvs(); boundary.execute.mockReset(); boundary.fetch.mockReset();
  boundary.failRuntimeRename = false; boundary.runtimeRenameAttempts = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'whisper-runtime-')); roots.push(root);
  const staging = join(root, 'staging'); const cache = join(root, 'cache'); await mkdir(staging);
  const lock = { platform: 'win32', arch: 'x64', version: '1.7.6', archiveRoot: 'Release',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip', sha256: digest('archive'),
    files: Object.fromEntries(names.map(name => [name, { sha256: digest(name), size: Buffer.byteLength(name) }])) };
  await writeFile(join(staging, 'runtime.lock.json'), JSON.stringify(lock));
  vi.stubEnv('SystemRoot', 'C:/Windows'); boundary.fetch.mockResolvedValue(new Response('archive'));
  boundary.execute.mockImplementation(async (command: string) => {
    if (command.endsWith('tar.exe')) {
      await mkdir(join(staging, 'Release'));
      for (const name of names) await writeFile(join(staging, 'Release', name), name);
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '--model' };
  });
  return { staging, cache, lock };
}

describe('controlled Whisper runtime installation', () => {
  it('requires network admission before downloading a missing runtime', async () => {
    const { staging, cache, lock } = await fixture(); const authorize = vi.fn(async () => false);
    await expect(installWhisperRuntime(staging, cache, undefined, authorize)).rejects.toThrow('网络策略拒绝');
    expect(authorize).toHaveBeenCalledExactlyOnceWith({ url: lock.url, method: 'GET', resourceType: 'whisper-runtime' });
    expect(boundary.fetch).not.toHaveBeenCalled(); expect(boundary.execute).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')('publishes and verifies the extracted runtime after a transient Windows directory lock', async () => {
    const { staging, cache } = await fixture(); boundary.failRuntimeRename = true;
    await installWhisperRuntime(staging, cache);
    expect(boundary.runtimeRenameAttempts).toBe(2);
    expect(await verifyWhisperRuntime(staging)).toBe(await realpath(join(staging, 'runtime', 'whisper-cli.exe')));
  });
  it('installs all verified CPU libraries and reuses only the verified archive', async () => {
    const { staging, cache } = await fixture();
    await installWhisperRuntime(staging, cache);
    boundary.execute.mockClear();
    expect(await verifyWhisperRuntime(staging)).toBe(await realpath(join(staging, 'runtime', 'whisper-cli.exe')));
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(await readFile(join(staging, 'runtime', 'whisper.dll'), 'utf8')).toBe('whisper.dll');
    await rm(join(staging, 'runtime'), { recursive: true });
    await installWhisperRuntime(staging, cache); expect(boundary.fetch).toHaveBeenCalledOnce();
  });
  it('rejects a corrupted archive before extraction and removes its partial file', async () => {
    const { staging, cache } = await fixture(); boundary.fetch.mockResolvedValue(new Response('corrupt'));
    await expect(installWhisperRuntime(staging, cache)).rejects.toThrow('SHA-256');
    expect(boundary.execute).not.toHaveBeenCalled(); expect(await readdir(cache)).toEqual([]);
  });
  it('rejects changed CPU libraries and propagates missing system runtime failures', async () => {
    const { staging, cache } = await fixture(); await installWhisperRuntime(staging, cache);
    await writeFile(join(staging, 'runtime', 'whisper.dll'), 'corrupt');
    await expect(verifyWhisperRuntime(staging)).rejects.toThrow('完整性');
    await writeFile(join(staging, 'runtime', 'whisper.dll'), 'whisper.dll');
    boundary.execute.mockRejectedValue(new Error('required system DLL unavailable'));
    await expect(installWhisperRuntime(staging, cache)).rejects.toThrow('system DLL');
  });
  it('rejects unverified origins before downloading', async () => {
    const { staging, cache, lock } = await fixture();
    await writeFile(join(staging, 'runtime.lock.json'), JSON.stringify({ ...lock, url: 'https://unverified.test/runtime.zip' }));
    await expect(installWhisperRuntime(staging, cache)).rejects.toThrow('锁定'); expect(boundary.fetch).not.toHaveBeenCalled();
  });
});
