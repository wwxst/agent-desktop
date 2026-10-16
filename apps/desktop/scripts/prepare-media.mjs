import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// 正式本地媒体资源目前只提供 Windows x64；其他平台继续构建通用客户端和视觉能力。
const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('本平台不准备 Windows x64 本地媒体资源。');
} else if (!process.versions.electron) {
  // 与正式安装共用 Electron 网络栈及系统代理；下载器也必须使用独立配置目录。
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = createRequire(import.meta.url)('electron');
  const result = spawnSync(executable, [fileURLToPath(import.meta.url), `--user-data-dir=${join(root, 'dist', 'media-download-profile')}`], { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const { app, net } = createRequire(import.meta.url)('electron');
  // Electron 主模块必须先加载完成才能进入 ready，不能在顶层 await whenReady。
  void app.whenReady().then(() => prepareBundle(net.fetch)).then(() => app.exit(0), error => {
    console.error(error); app.exit(1);
  });
}

async function prepareBundle(fetchResource) {
  const resources = join(root, 'resources/plugins');
  const bundle = join(root, 'bundled-media');
  const readLock = async path => JSON.parse(await readFile(path, 'utf8'));
  const ffmpeg = await readLock(join(resources, 'ffmpeg/runtime.lock.json'));
  const whisper = await readLock(join(resources, 'whisper/runtime.lock.json'));
  const model = await readLock(join(resources, 'whisper/models.lock.json'));
  // 版本、来源及摘要仍以插件已有锁定文件为唯一来源，大文件不进入 Git。
  const prepared = await Promise.allSettled([
    prepare(ffmpeg, join(bundle, 'archives', `${ffmpeg.sha256}.zip`), fetchResource),
    prepare(whisper, join(bundle, 'archives', `${whisper.sha256}.zip`), fetchResource),
    prepare(model, join(bundle, 'models', model.file), fetchResource),
  ]);
  const failures = prepared.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, '随包媒体资源准备失败。');
  const licenses = join(bundle, 'licenses');
  await mkdir(licenses, { recursive: true });
  for (const [source, target] of [
    ['ffmpeg/NOTICE.md', 'FFmpeg-NOTICE.md'],
    ['whisper/NOTICE.md', 'Whisper-NOTICE.md'],
    ['whisper/LICENSE.whisper.cpp', 'LICENSE.whisper.cpp'],
    ['whisper/LICENSE.model', 'LICENSE.model'],
  ]) await copyFile(join(resources, source), join(licenses, target));
  console.log('随包媒体资源已校验完成。');
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function prepare(lock, destination, fetchResource) {
  await mkdir(dirname(destination), { recursive: true });
  try {
    if ((lock.size === undefined || (await stat(destination)).size === lock.size)
      && await digest(destination) === lock.sha256) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${destination}.partial`;
  try {
    console.log(`准备随包资源：${lock.url}`);
    const response = await fetchResource(lock.url, { signal: AbortSignal.timeout(1_800_000) });
    if (!response.ok || response.body === null) throw new Error(`资源下载失败：HTTP ${response.status} ${lock.url}`);
    let bytes = 0; let lastProgress = 0;
    const progress = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (lock.size !== undefined && bytes > lock.size) { done(new Error('资源下载体积超出锁定清单。')); return; }
      if (Date.now() - lastProgress > 5000) {
        console.log(`${lock.file ?? lock.version}：${Math.round(bytes / 1024 / 1024)} MB`);
        lastProgress = Date.now();
      }
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial));
    if ((lock.size !== undefined && bytes !== lock.size) || await digest(partial) !== lock.sha256) throw new Error(`随包资源完整性校验失败：${lock.url}`);
    await rename(partial, destination);
  } finally { await rm(partial, { force: true }); }
}
