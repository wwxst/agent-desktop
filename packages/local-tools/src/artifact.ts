import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FileArtifact } from '@agent-desktop/model';
import { ToolExecutionError } from '@agent-desktop/tools';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.srt': 'application/x-subrip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

/** 写出工具在文件落地后登记真实元数据；大文件流式计算，不把整段视频载入内存。 */
export async function createFileArtifact(filePath: string, sourceTool: string, signal?: AbortSignal): Promise<FileArtifact> {
  try {
    signal?.throwIfAborted();
    const path = await realpath(filePath);
    const info = await stat(path);
    if (!info.isFile()) throw new Error('产物路径不是普通文件。');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path, signal === undefined ? {} : { signal })) digest.update(chunk);
    signal?.throwIfAborted();
    return { id: randomUUID(), path, mimeType: MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      size: info.size, sha256: digest.digest('hex'), createdAt: new Date().toISOString(), sourceTool };
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    // 调用者已经写出文件；元数据失败不能把真实写入伪装成没有发生。
    throw new ToolExecutionError(`文件已写出，但无法登记产物元数据：${error.message}`, 'unknown-outcome', { cause: error });
  }
}
