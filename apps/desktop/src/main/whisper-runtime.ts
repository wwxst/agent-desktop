import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
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
const runtimeFiles = ['whisper-cli.exe', 'ggml.dll', 'ggml-cpu.dll', 'ggml-base.dll', 'whisper.dll'] as const;
interface RuntimeLock {
  platform: string; arch: string; version: string; url: string; sha256: string; archiveRoot: string;
  files: Record<string, { sha256: string; size: number }>;
}

/** 以流计算摘要，模型体积不会决定宿主内存占用。 */
export async function whisperFileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function runtimeLock(root: string): Promise<RuntimeLock> {
  const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')) as RuntimeLock;
  if (typeof lock !== 'object' || lock === null) throw new Error('Whisper 运行资源锁定文件无效。');
  if (lock.platform !== 'win32' || lock.arch !== 'x64' || platform() !== lock.platform || arch() !== lock.arch) throw new Error('Whisper 正式插件目前仅支持 Windows x64 CPU。');
  if (!/^\d+\.\d+\.\d+$/.test(lock.version) || lock.archiveRoot !== 'Release'
    || lock.url !== `https://github.com/ggml-org/whisper.cpp/releases/download/v${lock.version}/whisper-bin-x64.zip`
    || !/^[a-f0-9]{64}$/.test(lock.sha256)
    || runtimeFiles.some(name => !lock.files?.[name] || !/^[a-f0-9]{64}$/.test(lock.files[name]!.sha256)
      || !Number.isSafeInteger(lock.files[name]!.size) || lock.files[name]!.size <= 0)) throw new Error('Whisper 运行资源锁定文件无效。');
  return lock;
}

/** 原子安装之前和每轮启动之前检查程序与全部 CPU 运行库，拒绝损坏或目录链接。 */
export async function verifyWhisperRuntime(root: string): Promise<string> {
  const lock = await runtimeLock(root);
  const directory = await realpath(join(root, 'runtime'));
  if (directory !== join(await realpath(root), 'runtime')) throw new Error('Whisper 运行目录不能指向插件外部。');
  for (const name of runtimeFiles) {
    const path = join(directory, name);
    if (await realpath(path) !== path || !(await stat(path)).isFile()
      || (await stat(path)).size !== lock.files[name]!.size || await whisperFileDigest(path) !== lock.files[name]!.sha256) throw new Error(`Whisper ${name} 完整性校验失败。`);
  }
  const executable = join(directory, 'whisper-cli.exe');
  // 锁定摘要和官方版本 URL 共同确认版本；--help 检查 CPU 及系统运行库能否实际加载。
  const { stdout, stderr } = await execute(executable, ['--help'], { windowsHide: true, timeout: 15_000 });
  if (!(stdout + stderr).includes('--model')) throw new Error('Whisper CPU 程序或系统运行库不可用。');
  return executable;
}

/** 专用于 Whisper 内置插件，沿用已有暂存、归档缓存与版本回滚。 */
export async function installWhisperRuntime(staging: string, archiveDirectory: string): Promise<void> {
  const lock = await runtimeLock(staging);
  let installed = false;
  try { installed = (await stat(join(staging, 'runtime'))).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!installed) {
    await mkdir(archiveDirectory, { recursive: true });
    const archive = join(archiveDirectory, `${lock.sha256}.zip`);
    let cached = false;
    try { cached = await whisperFileDigest(archive) === lock.sha256; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!cached) {
      const partial = `${archive}.partial`;
      try {
        await rm(partial, { force: true });
        const response = await net.fetch(lock.url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || response.body === null) throw new Error(`Whisper 下载失败：HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial, { flags: 'wx' }));
        const actualDigest = await whisperFileDigest(partial);
        if (actualDigest !== lock.sha256) throw new Error(`Whisper 下载的 SHA-256 校验失败（${(await stat(partial)).size} 字节，实际 ${actualDigest}）。`);
        await rename(partial, archive);
      } finally { await rm(partial, { force: true }); }
    }
    if (!process.env.SystemRoot) throw new Error('Windows SystemRoot 不可用。');
    await execute(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', staging], { windowsHide: true });
    await renameDirectory(join(staging, lock.archiveRoot), join(staging, 'runtime'));
  }
  await verifyWhisperRuntime(staging);
}
