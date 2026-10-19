import { InMemorySession } from '@agent-desktop/session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, SessionEventInput, StepId, TurnId } from '@agent-desktop/session';
import { createContextSourceDigest } from '@agent-desktop/agent-loop';
import {
  loadDesktopState,
  parseDesktopState,
  saveDesktopState,
} from '../src/main/session-persistence.js';

const rootTurn = 'root-turn' as TurnId;
const verifyTurn = 'verify-turn' as TurnId;
const continueTurn = 'continue-turn' as TurnId;
const firstStep = 'first-step' as StepId;
const secondStep = 'second-step' as StepId;
// 模型调用 ID 可以在不同轮次重复，真正的来源身份是会话事件索引。
const sharedCall = 'same-model-call' as ToolCallId;
const digest = 'a'.repeat(64);
const artifact = (path: string) => ({ id: 'test-artifact', path, mimeType: 'text/plain', size: 1, sha256: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', sourceTool: 'test' });
const temporaryDirectories: string[] = [];

function rawState(events: readonly unknown[]) {
  return {
    activeSessionId: 'session',
    sessions: [{ id: 'session', attachments: [], events }],
    clientState: {
      activeSessionId: 'session',
      conversations: [{
        id: 'session', title: '任务', titleManuallyRenamed: false,
        prompt: '', attachments: [], messages: [],
      }],
    },
  };
}

function parsedEvents(events: readonly unknown[]) {
  // 事件输入在生产中由 Session 统一分配封装；测试输入也走同一追加入口，
  // 并原地更新对象，让后续断言比较到持久化后的完整事件。
  const history: SessionEvent[] = [];
  const normalized = events.map(event => {
    if (isPersistedEvent(event)) { history.push(event); return event; }
    if (!isRecordEventInput(event)) return event;
    const committed = new InMemorySession(history, 'session').append(event);
    if (typeof event === 'object' && event !== null) {
      for (const key of Object.keys(event)) delete (event as Record<string, unknown>)[key];
      Object.assign(event, committed);
    }
    history.push(committed);
    return committed;
  });
  return parseDesktopState(rawState(normalized)).sessions[0]!.events;
}

function isPersistedEvent(value: unknown): value is SessionEvent {
  return typeof value === 'object' && value !== null && 'sessionId' in value && 'itemId' in value && 'sequence' in value && 'timestamp' in value;
}

function isRecordEventInput(value: unknown): value is Extract<Parameters<InMemorySession['append']>[0], { type: string }> {
  return typeof value === 'object' && value !== null && 'type' in value && 'turnId' in value && 'payload' in value;
}

function resequence(events: readonly unknown[]): readonly SessionEvent[] {
  const history: SessionEvent[] = [];
  return events.map(event => {
    if (isPersistedEvent(event)) {
      const resequenced = { ...event, sequence: history.length + 1 };
      history.push(resequenced);
      return resequenced;
    }
    if (!isRecordEventInput(event)) throw new Error('测试事件输入无效。');
    const committed = new InMemorySession(history, 'session').append(event);
    history.push(committed);
    return committed;
  });
}

/** 覆盖新事件的真实保存形状，不通过模型声明来补造完成结果。 */
function recoveryEvents(): readonly SessionEvent[] {
  const events: SessionEvent[] = [...new InMemorySession([], 'session').appendMany([
    { type: 'turn.started', turnId: rootTurn, payload: {} }, // 0
    { type: 'step.started', turnId: rootTurn, payload: { stepId: firstStep } },
    { type: 'assistant.message', turnId: rootTurn, payload: { stepId: firstStep,
      content: '先写文件。', toolCalls: [{ id: sharedCall, name: 'write_text_file', input: { content: '内容' } }] } },
    { type: 'tool.called', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall,
      name: 'write_text_file', input: { content: '内容' }, boundary: 'checkpointed' } }, // 3
    { type: 'tool.effect.prepared', turnId: rootTurn, payload: { sourceEventIndex: 3,
      data: { kind: 'text-file', path: 'D:/任务/结果.txt', beforeSha256: null,
        expectedAfterSha256: digest, expectedBytes: 6 } } },
    { type: 'tool.result', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall,
      result: { status: 'error', message: '写入后连接断开：原始错误', failureKind: 'unknown-outcome',
        output: { errorName: 'ConnectionError', detail: ['原始输出'] } } } },
    { type: 'step.completed', turnId: rootTurn, payload: { stepId: firstStep } }, // 6
    { type: 'context.compacted', turnId: rootTurn, payload: { coveredStepEndEventIndexes: [6],
      sourceDigest: digest, summary: JSON.stringify({ summary: '用户约束保留；文件结果待核验。', sourceEventIndexes: [2, 5] }), estimatorVersion: 1,
      estimatedBefore: 1200, estimatedAfter: 300 } }, // 7
    { type: 'host.operation.started', turnId: rootTurn, payload: { operation: 'stop', description: '调用宿主收尾。' } }, // 8
    { type: 'host.operation.result', turnId: rootTurn, payload: { sourceEventIndex: 8, status: 'failed',
      errorName: 'HookError', errorMessage: '原始宿主错误' } },
    { type: 'turn.failed', turnId: rootTurn, payload: { errorName: 'NetworkError', errorMessage: '原始模型错误' } },
    { type: 'turn.started', turnId: verifyTurn, payload: {} }, // 11
    { type: 'turn.recovery.started', turnId: verifyTurn, payload: { sourceTurnId: rootTurn, mode: 'verify' } },
    { type: 'effect.outcome.verified', turnId: verifyTurn, payload: { sourceEventIndex: 3,
      scope: 'file-effect', outcome: 'completed',
      evidence: { source: 'tool', reference: 'sha256:' + digest, description: '文件摘要相同。' } } },
    { type: 'effect.outcome.verified', turnId: verifyTurn, payload: { sourceEventIndex: 8,
      scope: 'entire-call', outcome: 'unresolved',
      evidence: { source: 'host', reference: 'host:8', description: '宿主效果仍待确认。' } } }, // 14
    { type: 'turn.completed', turnId: verifyTurn, payload: {} },
    { type: 'turn.started', turnId: continueTurn, payload: {} }, // 16
    { type: 'turn.recovery.started', turnId: continueTurn, payload: { sourceTurnId: verifyTurn, mode: 'continue' } },
    { type: 'step.started', turnId: continueTurn, payload: { stepId: secondStep } },
    { type: 'assistant.message', turnId: continueTurn, payload: { stepId: secondStep,
      toolCalls: [{ id: sharedCall, name: 'external_tool', input: { task: '新工作' } }] } },
    { type: 'tool.called', turnId: continueTurn, payload: { stepId: secondStep, toolCallId: sharedCall,
      name: 'external_tool', input: { task: '新工作' }, boundary: 'opaque' } }, // 20
    { type: 'tool.result', turnId: continueTurn, payload: { stepId: secondStep, toolCallId: sharedCall,
      result: { status: 'success', output: { completed: true }, artifacts: [artifact('D:/任务/新结果.txt')] } } }, // 21
    { type: 'step.completed', turnId: continueTurn, payload: { stepId: secondStep } }, // 22
    { type: 'context.compacted', turnId: continueTurn, payload: { coveredStepEndEventIndexes: [22],
      previousSummaryEventIndex: 7, sourceDigest: digest, summary: JSON.stringify({ summary: '新增工作有真实成功结果。', sourceEventIndexes: [2, 5, 19, 21] }),
      estimatorVersion: 1, estimatedBefore: 1500, estimatedAfter: 400 } },
    { type: 'plan.updated', turnId: continueTurn, payload: { revision: 2, explanation: '按照原任务事实重新规划。',
      steps: [
        { id: 'new', description: '新增工作', requestedStatus: 'completed', completionKind: 'tool', evidenceEventIndexes: [21] },
        { id: 'old', description: '原写入', requestedStatus: 'failed', completionKind: 'tool', evidenceEventIndexes: [5] },
        { id: 'host', description: '确认收尾', requestedStatus: 'blocked', completionKind: 'tool', evidenceEventIndexes: [14] },
        { id: 'next', description: '下一步', requestedStatus: 'in_progress', completionKind: 'tool', evidenceEventIndexes: [] },
        { id: 'reply', description: '解释结果', requestedStatus: 'pending', completionKind: 'response', evidenceEventIndexes: [] },
      ] } },
    { type: 'effect.outcome.verified', turnId: continueTurn, payload: { sourceEventIndex: 8,
      scope: 'entire-call', outcome: 'not-applied',
      evidence: { source: 'user', reference: 'manual:8', description: '用户检查后确认未执行。' } } },
    { type: 'turn.cancelled', turnId: continueTurn, payload: { reason: 'user' } },
    { type: 'turn.started', turnId: 'interrupted-turn' as TurnId, payload: {} },
    { type: 'turn.interrupted', turnId: 'interrupted-turn' as TurnId, payload: { reason: 'process-exit' } },
  ])];
  // 与生产代码使用同一确切来源表示，不用伪造哈希绕过重启校验。
  for (const index of [7, 23]) {
    const event = events[index];
    if (event?.type !== 'context.compacted') throw new Error('摘要测试来源缺失。');
    events[index] = { ...event, payload: { ...event.payload, sourceDigest: createContextSourceDigest(events.slice(0, index),
      event.payload.coveredStepEndEventIndexes, event.payload.previousSummaryEventIndex) } };
  }
  return events;
}

function replaceEvent(events: readonly unknown[], index: number, replacement: unknown) {
  return events.map((event, offset) => offset === index ? replacement : event);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('new Session event persistence', () => {
  it('round-trips recovery, plan, summaries and raw execution facts through real SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-event-persistence-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'agent-desktop.sqlite');
    const events = recoveryEvents();
    const state = parseDesktopState(rawState(events));
    expect(state.sessions[0]!.events).toEqual(events);

    await saveDesktopState(filePath, state);
    const restored = await loadDesktopState(filePath);
    expect(restored!.sessions[0]!.events).toEqual(events);
    await saveDesktopState(filePath, restored!);
    expect((await loadDesktopState(filePath))!.sessions[0]!.events).toEqual(events);
  });

  it('keeps old incomplete and unpaired history without inventing boundary or failure kinds', () => {
    const events = [
      { type: 'turn.started', turnId: rootTurn, payload: {} },
      { type: 'tool.result', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall,
        result: { status: 'error', message: '旧错误', output: { detail: '原输出' } } } },
      { type: 'assistant.message', turnId: rootTurn, payload: { stepId: secondStep,
        toolCalls: [{ id: sharedCall, name: 'old_tool', input: {} }] } },
      { type: 'tool.called', turnId: rootTurn, payload: { stepId: secondStep, toolCallId: sharedCall,
        name: 'old_tool', input: {} } },
    ];
    expect(parsedEvents(events)).toEqual(events);
  });

  it.each(['not-executed', 'read-only', 'checkpointed', 'opaque'])('preserves the %s execution boundary', boundary => {
    const event = { type: 'tool.called', turnId: rootTurn, payload: { stepId: firstStep,
      toolCallId: sharedCall, name: 'tool', input: {}, boundary } };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each(['transient', 'permanent', 'denied', 'cancelled', 'unknown-outcome'])('preserves the %s failure kind', failureKind => {
    const event = { type: 'tool.result', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall,
      result: { status: 'error', message: '原始失败', output: { details: [1, '原文'] }, failureKind } } };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each(['completed', 'failed', 'cancelled'])('preserves a %s host result', status => {
    const events = [
      { type: 'host.operation.started', turnId: rootTurn, payload: { operation: 'prepare', description: '准备扩展。' } },
      { type: 'host.operation.result', turnId: rootTurn, payload: { sourceEventIndex: 0, status } },
    ];
    expect(parsedEvents(events)).toEqual(events);
  });

  it.each(['user', 'window-closed', 'external'])('preserves the %s cancellation reason', reason => {
    const event = { type: 'turn.cancelled', turnId: rootTurn, payload: { reason } };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it('preserves the explicit legacy interruption reason', () => {
    const event = { type: 'turn.interrupted', turnId: rootTurn, payload: { reason: 'legacy-unknown' } };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each([-1, 1.5, 4, 5, 999, 0])('rejects a prepared source index of %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 4, {
      ...events[4], payload: { ...(events[4] as Extract<SessionEvent, { type: 'tool.effect.prepared' }>).payload, sourceEventIndex },
    }))).toThrow(/sessions\[0\]\.events\[4\](?:\.payload)?\.sourceEventIndex/);
  });

  it.each(['not-executed', 'read-only'])('rejects a prepared effect for a %s call', boundary => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 3, {
      ...events[3], payload: { ...(events[3] as Extract<SessionEvent, { type: 'tool.called' }>).payload, boundary },
    }))).toThrow('sessions[0].events[4].sourceEventIndex');
  });

  it('does not confuse a repeated model call ID with prepared ownership', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents([...events, {
      type: 'tool.effect.prepared', turnId: continueTurn, payload: { sourceEventIndex: 3, data: {} },
    }])).toThrow('sourceEventIndex');
    const current = { type: 'tool.effect.prepared', turnId: continueTurn, payload: { sourceEventIndex: 20, data: { operation: 'new' } } };
    expect(parsedEvents([...events, current]).at(-1)).toEqual(current);
  });

  it.each([3, 9, 999])('rejects a host result with an invalid source %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 9, { ...events[9], payload: { ...(events[9] as Extract<SessionEvent, { type: 'host.operation.result' }>).payload, sourceEventIndex } })))
      .toThrow('sessions[0].events[9].sourceEventIndex');
  });

  it('rejects a host result owned by another Turn', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 9, { ...events[9], turnId: verifyTurn })))
      .toThrow('sessions[0].events[9].sourceEventIndex');
  });

  it.each([5, 13, 999])('rejects verification source %s instead of a prior execution start', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 13, { ...events[13], payload: { ...(events[13] as Extract<SessionEvent, { type: 'effect.outcome.verified' }>).payload, sourceEventIndex } })))
      .toThrow('sessions[0].events[13].sourceEventIndex');
  });

  it('rejects file verification of a host operation or a never executed call', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 13, { ...events[13], payload: { ...(events[13] as Extract<SessionEvent, { type: 'effect.outcome.verified' }>).payload, sourceEventIndex: 8 } })))
      .toThrow('sessions[0].events[13].sourceEventIndex');
    expect(() => parsedEvents(resequence([
      ...events.slice(0, 3),
      { ...events[3], payload: { ...(events[3] as Extract<SessionEvent, { type: 'tool.called' }>).payload, boundary: 'not-executed' } },
      { ...events[13], payload: { ...(events[13] as Extract<SessionEvent, { type: 'effect.outcome.verified' }>).payload, sourceEventIndex: 3 } },
    ]))).toThrow('sourceEventIndex');
  });

  it.each([
    { scope: 'entire-call', outcome: 'completed' },
    { scope: 'file-effect', outcome: 'unresolved' },
  ])('rejects a host observation claiming $scope/$outcome', fields => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 14, { ...events[14], payload: { ...(events[14] as Extract<SessionEvent, { type: 'effect.outcome.verified' }>).payload, ...fields } })))
      .toThrow('sessions[0].events[14].payload.evidence.source');
  });

  it.each([verifyTurn, continueTurn, 'missing-turn'])('rejects a self, future or nonexistent recovery source %s', sourceTurnId => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 12, { ...events[12], payload: { ...(events[12] as Extract<SessionEvent, { type: 'turn.recovery.started' }>).payload, sourceTurnId } })))
      .toThrow('sessions[0].events[12].sourceTurnId');
  });

  it('requires the new Turn start and a single recovery relation for that Turn', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(resequence(events.filter((_event, index) => index !== 11)))).toThrow('sourceTurnId');
    expect(() => parsedEvents(resequence([...events.slice(0, 13), events[12]!]))).toThrow('sourceTurnId');
  });

  it('requires the source Turn to start earlier, even when both starts precede the relation', () => {
    const events = [
      { type: 'turn.started', turnId: rootTurn, payload: {} },
      { type: 'turn.started', turnId: verifyTurn, payload: {} },
      { type: 'turn.recovery.started', turnId: rootTurn, payload: { sourceTurnId: verifyTurn, mode: 'continue' } },
      { type: 'turn.recovery.started', turnId: verifyTurn, payload: { sourceTurnId: rootTurn, mode: 'continue' } },
    ];
    expect(() => parsedEvents(events)).toThrow('sessions[0].events[2].sourceTurnId');
  });

  it('rejects plan evidence from an unrelated task and cannot use a future relation to fix it', () => {
    const events = [
      { type: 'turn.started', turnId: rootTurn, payload: {} },
      { type: 'tool.result', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall,
        result: { status: 'success', output: '原任务成功' } } },
      { type: 'turn.started', turnId: continueTurn, payload: {} },
      { type: 'plan.updated', turnId: continueTurn, payload: { revision: 1, explanation: '',
        steps: [{ id: 'work', description: '另一项工作', requestedStatus: 'completed',
          completionKind: 'tool', evidenceEventIndexes: [1] }] } },
      { type: 'turn.recovery.started', turnId: continueTurn, payload: { sourceTurnId: rootTurn, mode: 'continue' } },
    ];
    expect(() => parsedEvents(events)).toThrow('sessions[0].events[3].steps[0].evidenceEventIndexes[0]');
  });

  it.each([-1, 1.5, 24, 999, 22])('rejects unsupported plan evidence index %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 24, {
      type: 'plan.updated', turnId: continueTurn, payload: { revision: 1, explanation: '',
      steps: [{ id: 'work', description: '工作', requestedStatus: 'completed',
        completionKind: 'tool', evidenceEventIndexes: [sourceEventIndex] }] },
    }))).toThrow('evidenceEventIndexes[0]');
  });

  it.each([6, 23, 999])('rejects previous summary source %s', previousSummaryEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 23, { ...events[23], payload: { ...(events[23] as Extract<SessionEvent, { type: 'context.compacted' }>).payload, previousSummaryEventIndex } })))
      .toThrow(/摘要事件来源不存在|自己或未来摘要/);
  });

  it.each([
    { indexes: [] }, { indexes: [6, 6] }, { indexes: [0] }, { indexes: [7] }, { indexes: [999] },
  ])('rejects new summary coverage $indexes', ({ indexes: coveredStepEndEventIndexes }) => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 7, { ...events[7], payload: { ...(events[7] as Extract<SessionEvent, { type: 'context.compacted' }>).payload, coveredStepEndEventIndexes } })))
      .toThrow(/摘要覆盖|摘要不能覆盖/);
  });

  it('rejects overlap with all prior summary coverage', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 23, {
      ...events[23], payload: { ...(events[23] as Extract<SessionEvent, { type: 'context.compacted' }>).payload, coveredStepEndEventIndexes: [6, 22] },
    }))).toThrow('重复覆盖');
  });

  it.each([
    { summary: ' ' }, { sourceDigest: 'invalid-digest' }, { estimatorVersion: 2 },
    { estimatedBefore: -1 }, { estimatedAfter: 1.5 },
  ])('rejects an invalid summary disk shape %j', fields => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 7, { ...events[7], payload: { ...(events[7] as Extract<SessionEvent, { type: 'context.compacted' }>).payload, ...fields } })))
      .toThrow('sessions[0].events[7]');
  });

  it('rejects duplicate plan step IDs from disk', () => {
    const step = { id: 'same', description: '工作', requestedStatus: 'pending', completionKind: 'tool', evidenceEventIndexes: [] };
    expect(() => parsedEvents([{ type: 'plan.updated', turnId: rootTurn, payload: { revision: 1, explanation: '', steps: [step, step] } }]))
      .toThrow('steps.id');
  });

  it('validates child event references inside the child Session only', () => {
    const state = rawState(recoveryEvents());
    const childInputs: SessionEventInput[] = [
      { type: 'tool.called', turnId: rootTurn, payload: { stepId: firstStep, toolCallId: sharedCall, name: 'read_file', input: {}, boundary: 'read-only' } },
      { type: 'effect.outcome.verified', turnId: rootTurn, payload: { sourceEventIndex: 0, scope: 'entire-call', outcome: 'completed',
        evidence: { source: 'tool', reference: 'source:3', description: '不能引用父会话。' } } },
    ];
    const childEvents = [...new InMemorySession([], 'child').appendMany(childInputs)];
    const childVerification = childEvents[1] as Extract<SessionEvent, { type: 'effect.outcome.verified' }>;
    childEvents[1] = { ...childVerification, payload: { ...childVerification.payload, sourceEventIndex: 3 } };
    expect(() => parseDesktopState({ ...state, sessions: [{
      ...state.sessions[0],
      subagentHistory: [{ parentToolCallId: sharedCall, events: resequence(childEvents),
        result: { taskId: 'child', title: '只读检查', status: 'completed', summary: '结果', evidence: [] } }],
    }] })).toThrow('subagentHistory.events[1].sourceEventIndex');
  });
});
