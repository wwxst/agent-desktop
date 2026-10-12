import { rename } from 'node:fs/promises';

/** Windows 扫描器可能短暂持有刚解包的目录；只重试该已实测的发布句柄竞态。 */
export async function renameDirectory(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
