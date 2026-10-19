import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFFmpegRuntime } from '../src/main/ffmpeg-runtime.js';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), platform: vi.fn(() => 'win32'), arch: vi.fn(() => 'x64'), failRuntimeRename: false, runtimeRenameAttempts: 0 }));
vi.mock('electron', async () => {
  const { fetchSessionFixture } = await import('./electron-session-fixture.js');
  return { net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }, session: { fromPartition: () => fetchSessionFixture((url, init) => fetch(url, init)) } };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (source: string, destination: string) => {
    if (source.endsWith('ffmpeg-fixture')) {
      boundary.runtimeRenameAttempts += 1;
      if (boundary.failRuntimeRename) { boundary.failRuntimeRename = false; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
    }
    return actual.rename(source, destination);
  } };
});
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: boundary.platform, arch: boundary.arch }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: boundary.execute }) };
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.execute.mockReset(); boundary.platform.mockReturnValue('win32'); boundary.arch.mockReturnValue('x64'); boundary.failRuntimeRename = false; boundary.runtimeRenameAttempts = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ffmpeg-install-')); roots.push(root);
  const staging = join(root, '暂存 space'); const cache = join(root, 'cache'); await mkdir(staging);
  const lock = { platform: 'win32', arch: 'x64', version: '8.1.2', url: 'https://www.gyan.dev/ffmpeg/builds/packages/test.zip', sha256: hash('archive'), archiveRoot: 'ffmpeg-fixture', executables: { ffmpeg: hash('ffmpeg'), ffprobe: hash('ffprobe') } };
  await writeFile(join(staging, 'runtime.lock.json'), JSON.stringify(lock));
  vi.stubEnv('SystemRoot', 'C:/Windows');
  const fetcher = vi.fn(async () => new Response('archive')); vi.stubGlobal('fetch', fetcher);
  boundary.execute.mockImplementation(async (command: string) => {
    if (command.endsWith('tar.exe')) {
      const target = join(staging, lock.archiveRoot); await mkdir(join(target, 'bin'), { recursive: true });
      for (const name of ['ffmpeg', 'ffprobe']) await writeFile(join(target, 'bin', `${name}.exe`), name);
      await writeFile(join(target, 'LICENSE'), 'GPLv3'); await writeFile(join(target, 'README.txt'), 'vendor build');
      return { stdout: '', stderr: '' };
    }
    return { stdout: `${command.endsWith('ffprobe.exe') ? 'ffprobe' : 'ffmpeg'} version 8.1.2 --enable-gpl --enable-version3 --enable-libx264 --enable-libass`, stderr: '' };
  });
  return { root, staging, cache, lock, fetcher };
}

describe('controlled FFmpeg runtime installation boundary', () => {
  it('requires network admission before downloading a missing runtime', async () => {
    const { staging, cache, fetcher, lock } = await fixture(); const authorize = vi.fn(async () => false);
    await expect(installFFmpegRuntime(staging, cache, undefined, authorize)).rejects.toThrow('网络策略拒绝');
    expect(authorize).toHaveBeenCalledExactlyOnceWith({ url: lock.url, method: 'GET', resourceType: 'ffmpeg-runtime' });
    expect(fetcher).not.toHaveBeenCalled(); expect(boundary.execute).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')('retries a transient Windows lock on the extracted runtime directory', async () => {
    const { staging, cache } = await fixture(); boundary.failRuntimeRename = true;
    await installFFmpegRuntime(staging, cache);
    expect(boundary.runtimeRenameAttempts).toBe(2);
    expect(await readFile(join(staging, 'runtime/LICENSE'), 'utf8')).toBe('GPLv3');
  });
  it('verifies archive and executables, keeps vendor notices and reuses only a verified cache', async () => {
    const { staging, cache, fetcher } = await fixture();
    await installFFmpegRuntime(staging, cache);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(join(staging, 'runtime/LICENSE'), 'utf8')).toBe('GPLv3');
    await installFFmpegRuntime(staging, cache);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await rm(join(staging, 'runtime'), { recursive: true });
    await installFFmpegRuntime(staging, cache);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await writeFile(join(staging, 'runtime/bin/ffmpeg.exe'), 'corrupt');
    await expect(installFFmpegRuntime(staging, cache)).rejects.toThrow('完整性');
  });
  it('rejects corrupted downloads before extraction and removes partial files', async () => {
    const { staging, cache, fetcher } = await fixture(); fetcher.mockResolvedValue(new Response('corrupt'));
    await expect(installFFmpegRuntime(staging, cache)).rejects.toThrow('SHA-256');
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(await readdir(cache)).toEqual([]);
  });
  it('rejects unsupported platforms and wrong executable versions', async () => {
    const { staging, cache, fetcher } = await fixture(); boundary.arch.mockReturnValue('arm64');
    await expect(installFFmpegRuntime(staging, cache)).rejects.toThrow('Windows x64');
    expect(fetcher).not.toHaveBeenCalled(); boundary.arch.mockReturnValue('x64');
    await installFFmpegRuntime(staging, cache);
    boundary.execute.mockResolvedValue({ stdout: 'ffmpeg version wrong', stderr: '' });
    await expect(installFFmpegRuntime(staging, cache)).rejects.toThrow('版本');
  });
});
