import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_DATABASE_FILE_NAME, readDesktopDocument, writeDesktopDocuments } from '../src/main/desktop-database.js';
import { loadDesktopState } from '../src/main/session-persistence.js';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-sqlite-'));
  directories.push(directory);
  return { directory, databasePath: join(directory, DESKTOP_DATABASE_FILE_NAME) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop SQLite storage', () => {
  it('rolls back settings and encrypted secrets together when the second write fails', async () => {
    const { databasePath } = await fixture();
    writeDesktopDocuments(databasePath, [
      { name: 'runtime-settings', value: { modelId: 'old-model' } },
      { name: 'runtime-secrets', value: { modelApiKey: 'old-ciphertext' } },
    ]);
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER reject_secrets BEFORE INSERT ON desktop_documents WHEN NEW.name = 'runtime-secrets' BEGIN SELECT RAISE(ABORT, 'write blocked'); END");
    database.close();

    expect(() => writeDesktopDocuments(databasePath, [
      { name: 'runtime-settings', value: { modelId: 'new-model' } },
      { name: 'runtime-secrets', value: { modelApiKey: 'new-ciphertext' } },
    ])).toThrow('write blocked');
    expect(readDesktopDocument(databasePath, 'runtime-settings')).toEqual({ modelId: 'old-model' });
    expect(readDesktopDocument(databasePath, 'runtime-secrets')).toEqual({ modelApiKey: 'old-ciphertext' });
  });

  it('does not overwrite a damaged database with a fresh empty state', async () => {
    const { databasePath } = await fixture();
    await writeFile(databasePath, 'damaged SQLite file');
    await expect(loadDesktopState(databasePath)).rejects.toThrow();
    expect(await readFile(databasePath, 'utf8')).toBe('damaged SQLite file');
  });
});
