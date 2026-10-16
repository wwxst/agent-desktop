import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareTurnStart } from '@agent-desktop/agent-loop';
import type { ClientConversationMessage, ClientStateSnapshot } from '@agent-desktop/client';
import { SessionPersistenceError, type SessionEvent, type TurnId } from '@agent-desktop/session';
import { readDesktopDocument } from '../src/main/desktop-database.js';
import { DesktopPersistentSession, loadDesktopState, type PersistedDesktopState, type TurnMessageBinding } from '../src/main/session-persistence.js';

const temporaryDirectories: string[] = [];

function clientState(messages: readonly ClientConversationMessage[] = []): ClientStateSnapshot {
  return {
    activeSessionId: 'session',
    conversations: [{ id: 'session', title: '', titleManuallyRenamed: false, messages, prompt: '', attachments: [] }],
  };
}

function persistedState(
  events: readonly SessionEvent[],
  bindings: readonly TurnMessageBinding[] = [],
  snapshot: ClientStateSnapshot = clientState(),
): PersistedDesktopState {
  return {
    activeSessionId: 'session',
    sessions: [{ id: 'session', attachments: [], events,
      ...(bindings.length === 0 ? {} : { turnMessageBindings: bindings }) }],
    clientState: snapshot,
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-atomic-start-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
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

  it('saves the start events, exact message binding and promoted draft in one commit that survives two reloads', async () => {
    const filePath = await databasePath();
    const start = prepareTurnStart('检查视频');
    const binding: TurnMessageBinding = { executionVersion: 1, turnId: start.turnId, userMessageId: 11, assistantMessageId: 12 };
    const draft: ClientStateSnapshot = {
      activeSessionId: 'session', conversations: [],
      drafts: [{ id: 'session', title: '', titleManuallyRenamed: false, messages: [], prompt: '检查视频', attachments: [] }],
    };
    const promoted = clientState([
      { id: 11, role: 'user', text: '检查视频', attachments: [] },
      { id: 12, role: 'assistant', status: 'processing', streamedText: '', activity: [], activityExpanded: true },
    ]);
    let writes = 0;
    const session = new DesktopPersistentSession(filePath, 'session', [], (_id, events, bindings, snapshot) => {
      writes += 1;
      if (snapshot !== undefined) {
        // 构造待提交快照时，执行事件与身份绑定尚未提前进入内存。
        expect(session.events()).toEqual([]);
        expect(session.turnMessageBindings()).toEqual([]);
        expect(snapshot).toBe(promoted);
      }
      return persistedState(events, bindings, snapshot ?? draft);
    }, () => undefined);
    session.persist();
    writes = 0;

    session.commitStart(start, promoted, binding);

    expect(writes).toBe(1);
    expect(session.events()).toEqual(start.events);
    expect(session.turnMessageBindings()).toEqual([binding]);
    expect(readDesktopDocument(filePath, 'session-state')).toEqual(persistedState(start.events, [binding], promoted));
    const firstReload = (await loadDesktopState(filePath))!;
    expect(firstReload.clientState.drafts ?? []).toEqual([]);
    expect(firstReload.clientState.conversations[0]!.messages[1]).toMatchObject({
      id: 12, status: 'processing', streamedText: '', taskState: { latestTurnId: start.turnId, status: 'started' },
    });

    const restored = new DesktopPersistentSession(filePath, 'session', firstReload.sessions[0]!.events,
      (_id, events, bindings, snapshot) => persistedState(events, bindings, snapshot ?? firstReload.clientState),
      () => undefined, firstReload.sessions[0]!.turnMessageBindings);
    restored.persist();
    const secondReload = (await loadDesktopState(filePath))!;
    expect(secondReload).toEqual(firstReload);
    expect(restored.turnMessageBindings()).toEqual([binding]);
  });

  it('keeps repeated prompts and attachments attached to distinct message and turn identities', async () => {
    const filePath = await databasePath();
    const prompt = '查看同一段视频';
    const first = prepareTurnStart(prompt);
    const second = prepareTurnStart(prompt);
    const firstBinding: TurnMessageBinding = { executionVersion: 1, turnId: first.turnId, userMessageId: 11, assistantMessageId: 12 };
    const secondBinding: TurnMessageBinding = { executionVersion: 1, turnId: second.turnId, userMessageId: 21, assistantMessageId: 22 };
    const firstMessages: readonly ClientConversationMessage[] = [
      { id: 11, role: 'user', text: prompt, attachments: ['source.mp4'], attachmentRoles: ['video'] },
      { id: 12, role: 'assistant', status: 'processing', streamedText: '', activity: [], activityExpanded: false },
    ];
    let snapshot = clientState();
    const session = new DesktopPersistentSession(filePath, 'session', [],
      (_id, events, bindings, startSnapshot) => persistedState(events, bindings, startSnapshot ?? snapshot), () => undefined);
    session.commitStart(first, clientState(firstMessages), firstBinding);
    snapshot = clientState([
      firstMessages[0]!,
      { id: 12, role: 'assistant', status: 'completed', result: { responseText: '第一次结果', traceId: 'trace-1' },
        activity: [], activityExpanded: false },
    ]);
    session.append({ type: 'turn.completed', turnId: first.turnId });
    snapshot = clientState([...snapshot.conversations[0]!.messages,
      { id: 21, role: 'user', text: prompt, attachments: ['source.mp4'], attachmentRoles: ['video'] },
      { id: 22, role: 'assistant', status: 'processing', streamedText: '', activity: [], activityExpanded: false },
    ]);
    session.commitStart(second, snapshot, secondBinding);

    const loaded = (await loadDesktopState(filePath))!;
    expect(loaded.sessions[0]!.turnMessageBindings).toEqual([firstBinding, secondBinding]);
    const messages = loaded.clientState.conversations[0]!.messages;
    expect(messages.map(message => message.id)).toEqual([11, 12, 21, 22]);
    expect(messages[0]).toEqual(firstMessages[0]);
    expect(messages[2]).toEqual({ ...firstMessages[0], id: 21 });
    expect(messages[1]).toMatchObject({ status: 'completed', taskState: { latestTurnId: first.turnId, status: 'completed' } });
    expect(messages[3]).toMatchObject({ status: 'processing', taskState: { latestTurnId: second.turnId, status: 'started' } });
  });

  it('retains legacy events without inventing a binding when committing a new recovery start', async () => {
    const filePath = await databasePath();
    const legacy = prepareTurnStart('旧任务');
    const initial: readonly SessionEvent[] = [...legacy.events,
      { type: 'turn.interrupted', turnId: legacy.turnId, reason: 'legacy-unknown' }];
    let snapshot = clientState([
      { id: 1, role: 'user', text: '旧任务', attachments: [] },
      { id: 2, role: 'assistant', status: 'failed', errorMessage: '旧执行记录无法确认', activity: [], activityExpanded: false },
    ]);
    const session = new DesktopPersistentSession(filePath, 'session', initial,
      (_id, events, bindings, startSnapshot) => persistedState(events, bindings, startSnapshot ?? snapshot), () => undefined);
    session.persist();
    expect((await loadDesktopState(filePath))!.sessions[0]!.turnMessageBindings).toBeUndefined();
    const recovery = prepareTurnStart('继续旧任务', { sourceTurnId: legacy.turnId, mode: 'continue' });
    const binding: TurnMessageBinding = { executionVersion: 1, turnId: recovery.turnId, userMessageId: 3, assistantMessageId: 4 };
    snapshot = clientState([...snapshot.conversations[0]!.messages,
      { id: 3, role: 'user', text: '继续旧任务', attachments: [] },
      { id: 4, role: 'assistant', status: 'processing', streamedText: '', activity: [], activityExpanded: true },
    ]);

    session.commitStart(recovery, snapshot, binding);

    const loaded = (await loadDesktopState(filePath))!;
    expect(loaded.sessions[0]!.events).toEqual([...initial, ...recovery.events]);
    expect(loaded.sessions[0]!.turnMessageBindings).toEqual([binding]);
    expect(loaded.clientState.conversations[0]!.messages[1]).toEqual(snapshot.conversations[0]!.messages[1]);
    expect(loaded.clientState.conversations[0]!.messages[3]).toMatchObject({
      taskState: { rootTurnId: legacy.turnId, latestTurnId: recovery.turnId },
    });
  });

  it('rolls back a real SQLite trigger failure and latches the same error without changing events or bindings', async () => {
    const filePath = await databasePath();
    const previous = prepareTurnStart('原任务');
    const initial: readonly SessionEvent[] = [...previous.events, { type: 'turn.cancelled', turnId: previous.turnId, reason: 'user' }];
    const originalBinding: TurnMessageBinding = { executionVersion: 1, turnId: previous.turnId, userMessageId: 1, assistantMessageId: 2 };
    const snapshot = clientState([
      { id: 1, role: 'user', text: '原任务', attachments: [] },
      { id: 2, role: 'assistant', status: 'cancelled', activity: [], activityExpanded: false },
    ]);
    const failures: SessionPersistenceError[] = [];
    const session = new DesktopPersistentSession(filePath, 'session', initial,
      (_id, events, bindings, startSnapshot) => persistedState(events, bindings, startSnapshot ?? snapshot),
      error => failures.push(error), [originalBinding]);
    session.persist();
    const before = readDesktopDocument(filePath, 'session-state');
    const database = new DatabaseSync(filePath);
    try {
      // UPDATE 已进入事务后主动中止，让真实数据库回滚整份起点快照。
      database.exec(`CREATE TRIGGER abort_start AFTER UPDATE ON desktop_documents
        WHEN NEW.name = 'session-state' BEGIN SELECT RAISE(ABORT, 'C1 SQLite write aborted'); END`);
    } finally { database.close(); }
    const start = prepareTurnStart('新任务');
    const binding: TurnMessageBinding = { executionVersion: 1, turnId: start.turnId, userMessageId: 3, assistantMessageId: 4 };
    const nextSnapshot = clientState([...snapshot.conversations[0]!.messages,
      { id: 3, role: 'user', text: '新任务', attachments: [] },
      { id: 4, role: 'assistant', status: 'processing', streamedText: '', activity: [], activityExpanded: false },
    ]);
    let originalError: unknown;
    try { session.commitStart(start, nextSnapshot, binding); } catch (error) { originalError = error; }

    expect(originalError).toBeInstanceOf(SessionPersistenceError);
    expect((originalError as Error).cause).toMatchObject({ message: 'C1 SQLite write aborted' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe(originalError);
    expect(readDesktopDocument(filePath, 'session-state')).toEqual(before);
    expect(session.events()).toEqual(initial);
    expect(session.turnMessageBindings()).toEqual([originalBinding]);
    const recoveredDatabase = new DatabaseSync(filePath);
    try { recoveredDatabase.exec('DROP TRIGGER abort_start'); } finally { recoveredDatabase.close(); }

    // 底层数据库恢复后也不能悄悄继续；所有提交入口仍传播首次失败的同一个对象。
    for (const action of [() => session.commitStart(start, nextSnapshot, binding),
      () => session.append({ type: 'turn.completed', turnId: previous.turnId }), () => session.persist()]) {
      let laterError: unknown;
      try { action(); } catch (error) { laterError = error; }
      expect(laterError).toBe(originalError);
    }
    expect(failures).toHaveLength(1);
    expect(readDesktopDocument(filePath, 'session-state')).toEqual(before);
    expect((await loadDesktopState(filePath))!.sessions[0]!.events).toEqual(initial);
    expect(session.events()).toEqual(initial);
    expect(session.turnMessageBindings()).toEqual([originalBinding]);
  });
});
