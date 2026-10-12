import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopExtensions } from '../src/main/extensions.js';
import { installFFmpegRuntime } from '../src/main/ffmpeg-runtime.js';

// 下载及程序边界在专属用例验证；本用例检查真实暂存、数据库和版本目录的组合行为。
vi.mock('../src/main/ffmpeg-runtime.js', () => ({ installFFmpegRuntime: vi.fn(async (directory: string) => {
  await mkdir(join(directory, 'runtime/bin'), { recursive: true });
  await writeFile(join(directory, 'runtime/bin/ffmpeg.exe'), 'verified fixture');
}) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('keeps FFmpeg independent, preserves a usable version on install/update failure and rolls back complete resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ffmpeg-lifecycle-')); roots.push(root);
  const resources = join(root, 'resources'); await cp(resolve('apps/desktop/resources'), resources, { recursive: true });
  const extensionRoot = join(root, 'extensions'); const database = join(root, 'desktop.sqlite');
  const store = new DesktopExtensions(database, extensionRoot, resources);
  vi.mocked(installFFmpegRuntime).mockRejectedValueOnce(new Error('download checksum failure'));
  await expect(store.install('plugin:ffmpeg')).rejects.toThrow('checksum');
  expect((await store.list()).plugins.find(item => item.id === 'plugin:ffmpeg')?.installed).toBe(false);
  await store.install('plugin:ffmpeg');
  const files = await store.files();
  expect(files.skills).toEqual([]);
  expect(files.plugins[0]?.servers[0]?.env?.FFMPEG_PATH).toBe('${PLUGIN_ROOT}/runtime/bin/ffmpeg.exe');
  await store.setEnabled('plugin:ffmpeg', false);
  const manifest = join(resources, 'plugins/ffmpeg/.codex-plugin/plugin.json');
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), version: '1.1.0' }));
  vi.mocked(installFFmpegRuntime).mockRejectedValueOnce(new Error('extract failure'));
  await expect(store.update('plugin:ffmpeg')).rejects.toThrow('extract failure');
  expect((await store.list()).plugins.find(item => item.id === 'plugin:ffmpeg')).toMatchObject({ version: '1.0.0', enabled: false });
  await store.update('plugin:ffmpeg');
  const old = store.versions('plugin:ffmpeg').find(item => item.version === '1.0.0')!;
  await store.rollback('plugin:ffmpeg', old.id);
  const restored = new DesktopExtensions(database, extensionRoot, resources);
  expect((await restored.list()).plugins.find(item => item.id === 'plugin:ffmpeg')).toMatchObject({ version: '1.0.0', enabled: false });
  expect(await readFile(join(extensionRoot, 'plugins/ffmpeg/runtime/bin/ffmpeg.exe'), 'utf8')).toBe('verified fixture');
  await writeFile(join(root, 'user-video.mp4'), 'keep');
  await restored.uninstall('plugin:ffmpeg');
  expect(await readFile(join(root, 'user-video.mp4'), 'utf8')).toBe('keep');
  expect((await restored.files()).plugins).toEqual([]);
});
