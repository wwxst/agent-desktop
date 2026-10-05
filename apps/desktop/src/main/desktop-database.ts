import { DatabaseSync } from 'node:sqlite';

export const DESKTOP_DATABASE_FILE_NAME = 'agent-desktop.sqlite';

// 每类数据由各自的模块解析；数据库只负责持久化及原子提交。
export type DesktopDocumentName = 'session-state' | 'runtime-settings' | 'runtime-secrets' | 'memories' | 'extensions' | 'extension-marketplaces' | `extension-secret:${string}` | `extension-versions:${string}`;

function openDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath);
  try {
    database.exec('CREATE TABLE IF NOT EXISTS desktop_documents (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** 短连接在调用结束时关闭，不把数据库句柄带入会话或智能体。 */
export function readDesktopDocument(filePath: string, name: DesktopDocumentName): unknown | null {
  const database = openDatabase(filePath);
  try {
    const row = database.prepare('SELECT value FROM desktop_documents WHERE name = ?').get(name);
    if (row === undefined) return null;
    const value: unknown = JSON.parse(row.value as string);
    if (value === null) throw new Error(`本地数据库记录无效：${name}`);
    return value;
  } finally {
    database.close();
  }
}

/** 设置与加密密钥必须一起提交，避免两个文件分别写入时留下半份更新。 */
export function writeDesktopDocuments(
  filePath: string,
  documents: readonly { readonly name: DesktopDocumentName; readonly value: object }[],
): void {
  const database = openDatabase(filePath);
  try {
    database.exec('BEGIN');
    try {
      const statement = database.prepare('INSERT INTO desktop_documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      for (const document of documents) statement.run(document.name, JSON.stringify(document.value));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}
