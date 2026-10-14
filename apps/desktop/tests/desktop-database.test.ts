import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_DATABASE_FILE_NAME, readDesktopDocument, writeDesktopDocuments } from '../src/main/desktop-database.js';
import { migrateLegacyDesktopFiles } from '../src/main/legacy-storage-migration.js';
import { loadDesktopState } from '../src/main/session-persistence.js';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-sqlite-'));
  directories.push(directory);
  return { directory, databasePath: join(directory, DESKTOP_DATABASE_FILE_NAME) };
}

const legacyState = {
  activeSessionId: 'saved-session',
  sessions: [{ id: 'saved-session', attachments: [], events: [{ type: 'user.message', turnId: 'saved-turn', content: '保留旧对话' }] }],
  clientState: {
    activeSessionId: 'saved-session',
    conversations: [{ id: 'saved-session', title: '旧会话', titleManuallyRenamed: true, messages: [], prompt: '未发送草稿', attachments: [] }],
  },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop SQLite storage', () => {
  it('rolls back settings and encrypted secrets together when the second write fails', async () => {
    const { databasePath } = await fixture();
    writeDesktopDocuments(databasePath, [
      { name: 'runtime-settings', value: { deepSeekModel: 'old-model' } },
      { name: 'runtime-secrets', value: { deepSeekApiKey: 'old-ciphertext' } },
    ]);
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER reject_secrets BEFORE INSERT ON desktop_documents WHEN NEW.name = 'runtime-secrets' BEGIN SELECT RAISE(ABORT, 'write blocked'); END");
    database.close();

    expect(() => writeDesktopDocuments(databasePath, [
      { name: 'runtime-settings', value: { deepSeekModel: 'new-model' } },
      { name: 'runtime-secrets', value: { deepSeekApiKey: 'new-ciphertext' } },
    ])).toThrow('write blocked');
    expect(readDesktopDocument(databasePath, 'runtime-settings')).toEqual({ deepSeekModel: 'old-model' });
    expect(readDesktopDocument(databasePath, 'runtime-secrets')).toEqual({ deepSeekApiKey: 'old-ciphertext' });
  });

  it('imports legacy files unchanged and keeps SQLite authoritative on the next launch', async () => {
    const { directory, databasePath } = await fixture();
    const documents = {
      'session-state': legacyState,
      'runtime-settings': { theme: 'dark' },
      'runtime-secrets': { providerApiKeys: { deepseek: Buffer.from('encrypted-key').toString('base64') } },
    };
    for (const [name, value] of Object.entries(documents)) {
      await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
    }
    await migrateLegacyDesktopFiles(databasePath);
    expect(await loadDesktopState(databasePath)).toEqual(legacyState);
    for (const [name, value] of Object.entries(documents)) {
      expect(await readFile(join(directory, `${name}.json`), 'utf8')).toBe(JSON.stringify(value));
    }
    expect(readDesktopDocument(databasePath, 'runtime-secrets')).toEqual(documents['runtime-secrets']);

    writeDesktopDocuments(databasePath, [{ name: 'runtime-settings', value: { deepSeekModel: 'sqlite-model' } }]);
    await writeFile(join(directory, 'runtime-settings.json'), JSON.stringify({ deepSeekModel: 'stale-model' }));
    await migrateLegacyDesktopFiles(databasePath);
    expect(readDesktopDocument(databasePath, 'runtime-settings')).toEqual({ deepSeekModel: 'sqlite-model' });
  });

  it('does not commit a partial import when a legacy file is corrupt', async () => {
    const { directory, databasePath } = await fixture();
    await writeFile(join(directory, 'session-state.json'), JSON.stringify(legacyState));
    await writeFile(join(directory, 'runtime-settings.json'), '{not json');
    await expect(migrateLegacyDesktopFiles(databasePath)).rejects.toThrow(SyntaxError);
    expect(readDesktopDocument(databasePath, 'session-state')).toBeNull();
    expect(await readFile(join(directory, 'runtime-settings.json'), 'utf8')).toBe('{not json');

    await writeFile(join(directory, 'runtime-settings.json'), JSON.stringify({ theme: 'light' }));
    await migrateLegacyDesktopFiles(databasePath);
    expect(await loadDesktopState(databasePath)).toEqual(legacyState);
    expect(readDesktopDocument(databasePath, 'runtime-settings')).toEqual({ theme: 'light', fallbackVisionEnabled: false });
  });

  it('does not overwrite a damaged database with a fresh empty state', async () => {
    const { databasePath } = await fixture();
    await writeFile(databasePath, 'damaged SQLite file');
    await expect(loadDesktopState(databasePath)).rejects.toThrow();
    expect(await readFile(databasePath, 'utf8')).toBe('damaged SQLite file');
  });
});
