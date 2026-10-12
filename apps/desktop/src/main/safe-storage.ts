import { watch } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** 只检查当前加密依赖的字段；不解密、复制或输出操作系统保护的主密钥。 */
async function hasPersistedKey(path: string): Promise<boolean> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('系统安全存储的 Local State 结构无效。');
  if (!('os_crypt' in value)) return false;
  const crypt = value.os_crypt;
  if (typeof crypt !== 'object' || crypt === null || Array.isArray(crypt)) throw new Error('系统安全存储的 os_crypt 结构无效。');
  if (!('encrypted_key' in crypt)) return false;
  if (typeof crypt.encrypted_key !== 'string') throw new Error('系统安全存储的 encrypted_key 无效。');
  return crypt.encrypted_key.length > 0;
}

/** Windows 首次启动的主密钥由 Chromium 延迟约十秒写入；文件事件只负责唤醒重新读取。 */
export async function waitForSafeStorageKey(path: string): Promise<void> {
  // Windows 短路径别名会触发 libuv 的目录前缀断言；监视真实目录，仍先监视再读密钥内容。
  const watcher = watch(await realpath(dirname(path)), { persistent: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => { void hasPersistedKey(path).then(ready => { if (ready) resolve(); }, reject); };
      watcher.once('error', reject);
      watcher.on('change', (_event, filename) => { if (filename === null || filename === 'Local State') check(); });
      // 二十秒覆盖真实十秒延迟写入；到期明确失败，不能先提交无法恢复的密文。
      timer = setTimeout(() => reject(new Error('系统安全存储的主密钥在 20 秒内未完成持久化，未保存凭据，请重试。')), 20_000);
      check();
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    watcher.close();
  }
}

/** 模型、插件及 OAuth 保存共用同一边界；等待失败时调用方尚未提交 SQLite。 */
export async function encryptSecret(databasePath: string, value: string, storage: SafeStoragePort): Promise<Buffer> {
  const encrypted = storage.encryptString(value);
  // 当前 Desktop 的数据库与 Chromium Local State 均位于现有 userData 目录。
  if (process.platform === 'win32') await waitForSafeStorageKey(join(dirname(databasePath), 'Local State'));
  return encrypted;
}
