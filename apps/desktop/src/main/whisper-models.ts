import { constants, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net } from 'electron';
import type { ExtensionSnapshot } from '@agent-desktop/client';
import { whisperFileDigest } from './whisper-runtime.js';

interface ModelLock { id: string; name: string; file: string; revision: string; url: string; size: number; sha256: string }
type ModelStatus = NonNullable<ExtensionSnapshot['whisperModel']>;

/** 只管理已核实的 Small 多语言模型，不建立通用模型资产平台。 */
export class WhisperModels {
  private operation: ModelStatus | undefined;
  private verified: { signature: string; path: string } | undefined;
  constructor(private readonly directory: string, private readonly lockPath: string, private readonly changed: () => void, private readonly bundledModel?: string) {}

  private async lock(): Promise<ModelLock> {
    const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as ModelLock;
    if (typeof lock !== 'object' || lock === null || lock.id !== 'small' || lock.file !== 'ggml-small.bin' || typeof lock.name !== 'string'
      || !/^[a-f0-9]{40}$/.test(lock.revision) || !/^[a-f0-9]{64}$/.test(lock.sha256)
      || !Number.isSafeInteger(lock.size) || lock.size <= 0
      || lock.url !== `https://huggingface.co/ggerganov/whisper.cpp/resolve/${lock.revision}/${lock.file}`) throw new Error('Whisper 模型来源清单无效。');
    return lock;
  }
  private update(status: ModelStatus): void { this.operation = status; this.changed(); }

  private async checkDirectory(): Promise<boolean> {
    try {
      for (const path of [dirname(this.directory), this.directory]) {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Whisper 模型目录不能使用目录链接。');
      }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async validatedPath(lock: ModelLock): Promise<string | undefined> {
    if (!await this.checkDirectory()) return undefined;
    const path = join(this.directory, lock.file);
    let info;
    try { info = await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const root = await realpath(this.directory);
    const canonical = await realpath(path);
    if (canonical !== join(root, lock.file) || !info.isFile() || info.size !== lock.size) throw new Error('Whisper 模型文件损坏或指向受控目录外部。');
    const signature = `${canonical}/${info.size}/${info.mtimeMs}/${info.ctimeMs}/${lock.sha256}`;
    // 同一已验证文件在进度刷新中无需重复读取数百 MB；变更或重启后重新校验。
    if (this.verified?.signature !== signature) {
      if (await whisperFileDigest(canonical) !== lock.sha256) throw new Error('Whisper 模型 SHA-256 校验失败。');
      this.verified = { signature, path: canonical };
    }
    return canonical;
  }
  async status(): Promise<ModelStatus> {
    if (this.operation !== undefined) return this.operation;
    const lock = await this.lock();
    const base = { name: lock.name, size: lock.size, downloadedBytes: 0, diskBytes: 0 };
    try {
      const path = await this.validatedPath(lock);
      return path === undefined ? { ...base, status: 'missing' } : { ...base, status: 'ready', downloadedBytes: lock.size, diskBytes: lock.size };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const diskBytes = await this.diskBytes(lock);
      return { ...base, diskBytes, status: 'error', message: error.message };
    }
  }
  private async diskBytes(lock: ModelLock): Promise<number> {
    if (!await this.checkDirectory()) return 0;
    return lstat(join(this.directory, lock.file)).then(info => info.size).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; });
  }
  async path(): Promise<string | undefined> {
    const lock = await this.lock();
    return this.validatedPath(lock);
  }
  async install(source?: string): Promise<void> {
    // 正式客户端恢复默认模型时复用随包文件；用户导入仍使用明确选择的来源。
    source ??= this.bundledModel;
    const lock = await this.lock();
    await this.checkDirectory();
    await mkdir(this.directory, { recursive: true });
    await this.checkDirectory();
    // 失败安装可以从头重试，已有合法文件直接复用；不把残片当作模型。
    if ((await this.status()).status === 'ready') return;
    const disk = await statfs(this.directory);
    if (disk.bavail * disk.bsize < lock.size + 64 * 1024 * 1024) throw new Error('磁盘空间不足，无法安装 Whisper 模型。');
    const partial = join(this.directory, `${lock.file}.partial`);
    const base = { name: lock.name, size: lock.size, diskBytes: await this.diskBytes(lock), downloadedBytes: 0 };
    this.update({ ...base, status: source === undefined ? 'downloading' : 'verifying' });
    try {
      // 删除遗留的残片或链接，再独占创建；不能沿残片链接写入外部文件。
      await rm(partial, { force: true });
      if (source !== undefined) {
        // 本地选择只能导入与锁定来源相同的模型，执行路径仍在受控目录。
        const info = await stat(source);
        if (!info.isFile() || info.size !== lock.size || await whisperFileDigest(source) !== lock.sha256) throw new Error('请选择来源匹配且完整的 ggml-small.bin 模型。');
        await copyFile(source, partial, constants.COPYFILE_EXCL);
      } else {
        const response = await net.fetch(lock.url, { signal: AbortSignal.timeout(1_800_000) });
        if (!response.ok || response.body === null) throw new Error(`Whisper 模型下载失败：HTTP ${response.status}`);
        let downloadedBytes = 0; let lastNotice = 0;
        const progress = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > lock.size) { done(new Error('Whisper 模型下载体积超出来源清单。')); return; }
          if (Date.now() - lastNotice > 250 || downloadedBytes === lock.size) {
            lastNotice = Date.now(); this.update({ ...base, status: 'downloading', downloadedBytes, diskBytes: downloadedBytes });
          }
          done(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), progress, createWriteStream(partial, { flags: 'wx' }));
      }
      this.update({ ...base, status: 'verifying', downloadedBytes: lock.size, diskBytes: (await stat(partial)).size });
      if ((await stat(partial)).size !== lock.size || await whisperFileDigest(partial) !== lock.sha256) throw new Error('Whisper 模型体积或 SHA-256 校验失败。');
      await rename(partial, join(this.directory, lock.file));
      this.verified = undefined;
      await this.validatedPath(lock);
      this.operation = undefined; this.changed();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.update({ ...base, diskBytes: await this.diskBytes(lock), status: 'error', message: error.message });
      throw error;
    } finally { await rm(partial, { force: true }); }
  }
  async delete(): Promise<void> {
    const lock = await this.lock();
    await this.checkDirectory();
    await rm(join(this.directory, lock.file), { force: true });
    this.verified = undefined; this.operation = undefined; this.changed();
  }
}
