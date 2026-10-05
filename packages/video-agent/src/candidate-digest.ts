import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 验收与发布共享文件内容身份，路径相同但字节改变不能沿用旧结论。 */
export async function candidateDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
