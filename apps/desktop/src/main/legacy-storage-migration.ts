import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readDesktopDocument, writeDesktopDocuments, type DesktopDocumentName } from './desktop-database.js';
import { parseDesktopState } from './session-persistence.js';
import { parseStoredSecrets, parseStoredSettings } from './runtime-settings.js';

/** 升级时只导入尚不存在的记录；数据库已有的数据始终优先，旧文件保留供核对。 */
export async function migrateLegacyDesktopFiles(databasePath: string): Promise<void> {
  const sources = [
    { name: 'session-state', parse: parseDesktopState },
    { name: 'runtime-settings', parse: parseStoredSettings },
    { name: 'runtime-secrets', parse: parseStoredSecrets },
  ] as const;
  const documents: { name: DesktopDocumentName; value: object }[] = [];
  for (const source of sources) {
    if (readDesktopDocument(databasePath, source.name) !== null) continue;
    let text: string;
    try {
      text = await readFile(join(dirname(databasePath), `${source.name}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // 所有存在的旧数据先完成解析，任何一项损坏都不提交部分迁移。
    documents.push({ name: source.name, value: source.parse(JSON.parse(text) as unknown) });
  }
  if (documents.length > 0) writeDesktopDocuments(databasePath, documents);
}
