import { InMemorySession } from '@agent-desktop/session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectTaskPlan, SessionPersistenceError, type SessionEvent, type StepId, type TaskPlanStep, type TurnId,
} from '@agent-desktop/session';
import { UpdatePlanTool, type ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolCallId } from '@agent-desktop/model';
import { qualifyTaskToolEvidence } from '../src/main/agent-task-state.js';
import { readDesktopDocument } from '../src/main/desktop-database.js';
import { DesktopPersistentSession, loadDesktopState, type PersistedDesktopState } from '../src/main/session-persistence.js';

const temporaryDirectories: string[] = [];
const root = 'root' as TurnId;
const resumed = 'resumed' as TurnId;
const stepId = 'step' as StepId;
const callId = 'read-call' as ToolCallId;
const context: ToolExecutionContext = { toolCallId: 'plan-call' as ToolCallId, reportProgress: () => {} };

function persistedState(events: readonly SessionEvent[]): PersistedDesktopState {
  return { activeSessionId: 'session', sessions: [{ id: 'session', attachments: [], events }],
    clientState: { activeSessionId: 'session', conversations: [
      { id: 'session', title: '', titleManuallyRenamed: false, messages: [], prompt: '', attachments: [] },
    ] } };
}

function planStep(id: string, requestedStatus: TaskPlanStep['requestedStatus'], evidenceEventIndexes: readonly number[]): TaskPlanStep {
  return { id, description: id, requestedStatus, evidenceEventIndexes, completionKind: 'tool' };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-plan-persistence-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('plan evidence SQLite round trip', () => {
  it('rejects a pending start-event reference without changing persisted execution facts', async () => {
    const filePath = await databasePath();
    const initial: SessionEvent[] = [...new InMemorySession([], 'session').appendMany([{ type: 'turn.started', turnId: root, payload: {} }, { type: 'user.message', turnId: root, payload: { content: '原任务' } }])];
    const session = new DesktopPersistentSession(filePath, 'session', initial, (_id, events) => persistedState(events), () => {});
    session.persist();

    const result = await new UpdatePlanTool(session, qualifyTaskToolEvidence).execute({ explanation: '当前任务计划',
      steps: [planStep('work', 'pending', [0])] }, context);

    expect(result).toMatchObject({ status: 'error', failureKind: 'permanent' });
    expect(session.events()).toEqual(initial);
    expect((readDesktopDocument(filePath, 'session-state') as PersistedDesktopState).sessions[0]!.events).toEqual(initial);
    expect((await loadDesktopState(filePath))!.sessions[0]!.events).toEqual(initial);
  });

  it('preserves successful, failed and unknown execution evidence through a recovery plan and two reloads', async () => {
    const filePath = await databasePath();
    const initial: SessionEvent[] = [...new InMemorySession([], 'session').appendMany([
      { type: 'turn.started', turnId: root, payload: {} },
      { type: 'user.message', turnId: root, payload: { content: '读取后写入文件' } },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId: callId, name: 'read_file', input: {}, boundary: 'read-only' } },
      { type: 'tool.result', turnId: root, payload: { stepId, toolCallId: callId, result: { status: 'success', output: '真实文件内容' } } },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId: 'write-call' as ToolCallId,
        name: 'write_text_file', input: {}, boundary: 'checkpointed' } },
      { type: 'tool.effect.prepared', turnId: root, payload: { sourceEventIndex: 4, data: { kind: 'text-file' } } },
      { type: 'tool.result', turnId: root, payload: { stepId, toolCallId: 'write-call' as ToolCallId,
        result: { status: 'error', message: '写入后响应丢失', failureKind: 'unknown-outcome' } } },
      { type: 'turn.failed', turnId: root, payload: { errorName: 'Error', errorMessage: '写入未确认' } },
      { type: 'turn.started', turnId: resumed, payload: {} },
      { type: 'user.message', turnId: resumed, payload: { content: '核验原任务' } },
      { type: 'turn.recovery.started', turnId: resumed, payload: { sourceTurnId: root, mode: 'verify' } },
    ])];
    const session = new DesktopPersistentSession(filePath, 'session', initial, (_id, events) => persistedState(events), () => {});
    const steps = [planStep('read', 'completed', [3]), planStep('write', 'failed', [6]), planStep('verify', 'blocked', [4])];
    expect(await new UpdatePlanTool(session, qualifyTaskToolEvidence).execute({ explanation: '沿原任务事实继续核验', steps }, context))
      .toMatchObject({ status: 'success' });
    const originalProjection = projectTaskPlan(session.events(), root, qualifyTaskToolEvidence);
    expect(originalProjection!.steps.map(step => step.status)).toEqual(['completed', 'blocked', 'blocked']);

    const firstReload = (await loadDesktopState(filePath))!;
    const restored = new DesktopPersistentSession(filePath, 'session', firstReload.sessions[0]!.events,
      (_id, events) => persistedState(events), () => {});
    expect(projectTaskPlan(restored.events(), root, qualifyTaskToolEvidence)).toEqual(originalProjection);
    expect(await new UpdatePlanTool(restored, qualifyTaskToolEvidence).execute({ explanation: '重启后保持原事实', steps }, context))
      .toMatchObject({ status: 'success', output: { revision: 2 } });
    const secondReload = (await loadDesktopState(filePath))!;
    expect(secondReload.sessions[0]!.events).toEqual(restored.events());
    expect(projectTaskPlan(secondReload.sessions[0]!.events, root, qualifyTaskToolEvidence)!.steps)
      .toEqual(originalProjection!.steps);
  });

  it('propagates and latches the original SQLite save error without appending the plan', async () => {
    const validPath = await databasePath();
    const filePath = join(validPath, 'missing', 'state.sqlite');
    const initial: SessionEvent[] = [...new InMemorySession([], 'session').appendMany([{ type: 'turn.started', turnId: root, payload: {} }])];
    const failures: SessionPersistenceError[] = [];
    const session = new DesktopPersistentSession(filePath, 'session', initial,
      (_id, events) => persistedState(events), error => failures.push(error));
    const tool = new UpdatePlanTool(session, qualifyTaskToolEvidence);
    const input = { explanation: '当前任务计划', steps: [planStep('work', 'pending', [])] };

    const originalError = await tool.execute(input, context).catch((error: unknown) => error);
    expect(originalError).toBeInstanceOf(SessionPersistenceError);
    expect(failures).toHaveLength(1);
    expect(originalError).toBe(failures[0]);
    expect(session.events()).toEqual(initial);
    await expect(tool.execute(input, context)).rejects.toBe(failures[0]);
    expect(failures).toHaveLength(1);
    expect(session.events()).toEqual(initial);
  });
});
