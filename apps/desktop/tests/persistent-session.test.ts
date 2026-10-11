import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionPersistenceError, type SessionEvent, type TurnId } from '@agent-desktop/session';
import { readDesktopDocument } from '../src/main/desktop-database.js';
import { DesktopPersistentSession, type PersistedDesktopState } from '../src/main/session-persistence.js';

const temporaryDirectories: string[] = [];

function persistedState(events: readonly SessionEvent[]): PersistedDesktopState {
  return {
    activeSessionId: 'session',
    sessions: [{ id: 'session', attachments: [], events }],
    clientState: {
      activeSessionId: 'session',
      conversations: [{ id: 'session', title: '', titleManuallyRenamed: false, messages: [], prompt: '', attachments: [] }],
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('DesktopPersistentSession', () => {
  it('commits SQLite before exposing appended events to memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-persistent-session-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'state.sqlite');
    const initial: SessionEvent[] = [{ type: 'turn.started', turnId: 'turn-1' as TurnId }];
    const session = new DesktopPersistentSession(filePath, 'session', initial, (_id, events) => persistedState(events), () => undefined);

    session.append({ type: 'turn.completed', turnId: 'turn-1' as TurnId });

    expect(session.events()).toHaveLength(2);
    expect((readDesktopDocument(filePath, 'session-state') as PersistedDesktopState).sessions[0]!.events).toEqual(session.events());
  });

  it('keeps history unchanged and latches the first persistence failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-persistent-session-failure-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'missing', 'state.sqlite');
    const initial: SessionEvent[] = [{ type: 'turn.started', turnId: 'turn-1' as TurnId }];
    const failures: SessionPersistenceError[] = [];
    const session = new DesktopPersistentSession(filePath, 'session', initial, (_id, events) => persistedState(events), error => failures.push(error));
    const event: SessionEvent = { type: 'turn.completed', turnId: 'turn-1' as TurnId };

    expect(() => session.append(event)).toThrow(SessionPersistenceError);
    expect(session.events()).toEqual(initial);
    expect(failures).toHaveLength(1);
    expect(() => session.append(event)).toThrow(failures[0]);
    expect(session.events()).toEqual(initial);
  });
});
