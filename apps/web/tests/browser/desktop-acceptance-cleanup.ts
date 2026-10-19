import { readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 三个媒体用例独占新建证据目录；关闭进程后只保留诊断证据，不遗留模型、会话或媒体副本。 */
export async function cleanupDesktopAcceptance(evidence: string, profile: string, ownsProfile: boolean, temporaryImages: readonly string[] = []): Promise<void> {
  const root = resolve(evidence); const retained: string[] = ownsProfile ? [] : [profile]; const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name); const diff = relative(root, path);
    if (!diff || diff === '..' || diff.startsWith(`..${sep}`) || isAbsolute(diff)) throw new Error('验收清理路径超出本任务证据目录。');
    // 显式提供的配置由调用方管理；即使放在证据目录中也不能猜测其归属。
    if (!ownsProfile && (resolve(profile) === path || resolve(profile).startsWith(`${path}${sep}`))) { retained.push(path); continue; }
    if (entry.isFile() && /\.(json|png|txt)$/i.test(entry.name) && !temporaryImages.includes(path)) { retained.push(path); continue; }
    await rm(path, { recursive: true, force: true }); removed.push(path);
  }
  await writeFile(resolve(root, 'cleanup.json'), JSON.stringify({ removed, retained, externalProfile: ownsProfile ? null : profile }, null, 2));
}
