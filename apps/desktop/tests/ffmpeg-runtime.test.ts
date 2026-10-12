import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFFmpegRuntime } from '../src/main/ffmpeg-runtime.js';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), platform: vi.fn(() => 'win32'), arch: vi.fn(() => 'x64') }));
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) } }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: boundary.platform, arch: boundary.arch }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: boundary.execute }) };
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.execute.mockReset(); boundary.platform.mockReturnValue('win32'); boundary.arch.mockReturnValue('x64'); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
