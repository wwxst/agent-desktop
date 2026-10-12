import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename as renameFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net } from 'electron';
import { renameDirectory } from './rename-directory.js';

const execute = promisify(execFile);
interface RuntimeLock {
  platform: string; arch: string; version: string; url: string; sha256: string; archiveRoot: string;
  executables: { ffmpeg: string; ffprobe: string };
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 只用于受控 FFmpeg 内置资源，复用安装暂存和版本目录，不建立通用资产平台。 */
export async function installFFmpegRuntime(staging: string, archiveDirectory: string): Promise<void> {
  const lock = JSON.parse(await readFile(join(staging, 'runtime.lock.json'), 'utf8')) as RuntimeLock;
  if (lock.platform !== 'win32' || lock.arch !== 'x64' || platform() !== lock.platform || arch() !== lock.arch) throw new Error('FFmpeg 正式插件目前仅支持 Windows x64。');
  if (!/^\d+\.\d+\.\d+$/.test(lock.version) || !/^[a-z0-9._-]+$/i.test(lock.archiveRoot)
    || ![lock.sha256, lock.executables?.ffmpeg, lock.executables?.ffprobe].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || !lock.url.startsWith('https://www.gyan.dev/ffmpeg/builds/packages/')) throw new Error('FFmpeg 运行资源锁定文件无效。');
  const runtime = join(staging, 'runtime');
  let installed = false;
  try { installed = (await stat(runtime)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!installed) {
    await mkdir(archiveDirectory, { recursive: true });
    const archive = join(archiveDirectory, `${lock.sha256}.zip`);
    let cached = false;
    try { cached = await digest(archive) === lock.sha256; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!cached) {
      const partial = `${archive}.partial`;
      try {
        // 使用桌面网络栈，遵守 Windows 系统代理；Node fetch 不读取系统代理。
        const response = await net.fetch(lock.url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || response.body === null) throw new Error(`FFmpeg 下载失败：HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
        if (await digest(partial) !== lock.sha256) throw new Error('FFmpeg 下载的 SHA-256 校验失败。');
        await renameFile(partial, archive);
      } finally { await rm(partial, { force: true }); }
    }
    // Windows 自带 tar 支持 ZIP；参数分开传递，中文和空格路径不经过 shell。
    if (!process.env.SystemRoot) throw new Error('Windows SystemRoot 不可用。');
    await execute(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', staging], { windowsHide: true });
    await renameDirectory(join(staging, lock.archiveRoot), runtime);
  }
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const path = join(runtime, 'bin', `${name}.exe`);
    if (await digest(path) !== lock.executables[name]) throw new Error(`${name} 程序完整性校验失败。`);
    const { stdout } = await execute(path, ['-version'], { windowsHide: true, timeout: 15_000 });
    if (!stdout.startsWith(`${name} version ${lock.version}`) || !['--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libass'].every(option => stdout.includes(option))) throw new Error(`${name} 版本或构建选项不符合锁定资源。`);
  }
  await stat(join(runtime, 'LICENSE'));
  await stat(join(runtime, 'README.txt'));
}
