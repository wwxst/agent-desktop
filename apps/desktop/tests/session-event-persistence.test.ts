import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
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
  return parseDesktopState(rawState(events)).sessions[0]!.events;
}

/** 覆盖新事件的真实保存形状，不通过模型声明来补造完成结果。 */
function recoveryEvents(): readonly SessionEvent[] {
  const events: SessionEvent[] = [
    { type: 'turn.started', turnId: rootTurn }, // 0
    { type: 'step.started', turnId: rootTurn, stepId: firstStep },
    { type: 'assistant.message', turnId: rootTurn, stepId: firstStep,
      content: '先写文件。', toolCalls: [{ id: sharedCall, name: 'write_text_file', input: { content: '内容' } }] },
    { type: 'tool.called', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall,
      name: 'write_text_file', input: { content: '内容' }, boundary: 'checkpointed' }, // 3
    { type: 'tool.effect.prepared', turnId: rootTurn, sourceEventIndex: 3,
      data: { kind: 'text-file', path: 'D:/任务/结果.txt', beforeSha256: null,
        expectedAfterSha256: digest, expectedBytes: 6 } },
    { type: 'tool.result', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall,
      result: { status: 'error', message: '写入后连接断开：原始错误', failureKind: 'unknown-outcome',
        output: { errorName: 'ConnectionError', detail: ['原始输出'] } } },
    { type: 'step.completed', turnId: rootTurn, stepId: firstStep }, // 6
    { type: 'context.compacted', turnId: rootTurn, coveredStepEndEventIndexes: [6],
      sourceDigest: digest, summary: JSON.stringify({ summary: '用户约束保留；文件结果待核验。', sourceEventIndexes: [2, 5] }), estimatorVersion: 1,
      estimatedBefore: 1200, estimatedAfter: 300 }, // 7
    { type: 'host.operation.started', turnId: rootTurn, operation: 'stop', description: '调用宿主收尾。' }, // 8
    { type: 'host.operation.result', turnId: rootTurn, sourceEventIndex: 8, status: 'failed',
      errorName: 'HookError', errorMessage: '原始宿主错误' },
    { type: 'turn.failed', turnId: rootTurn, errorName: 'NetworkError', errorMessage: '原始模型错误' },
    { type: 'turn.started', turnId: verifyTurn }, // 11
    { type: 'turn.recovery.started', turnId: verifyTurn, sourceTurnId: rootTurn, mode: 'verify' },
    { type: 'effect.outcome.verified', turnId: verifyTurn, sourceEventIndex: 3,
      scope: 'file-effect', outcome: 'completed',
      evidence: { source: 'tool', reference: 'sha256:' + digest, description: '文件摘要相同。' } },
    { type: 'effect.outcome.verified', turnId: verifyTurn, sourceEventIndex: 8,
      scope: 'entire-call', outcome: 'unresolved',
      evidence: { source: 'host', reference: 'host:8', description: '宿主效果仍待确认。' } }, // 14
    { type: 'turn.completed', turnId: verifyTurn },
    { type: 'turn.started', turnId: continueTurn }, // 16
    { type: 'turn.recovery.started', turnId: continueTurn, sourceTurnId: verifyTurn, mode: 'continue' },
    { type: 'step.started', turnId: continueTurn, stepId: secondStep },
    { type: 'assistant.message', turnId: continueTurn, stepId: secondStep,
      toolCalls: [{ id: sharedCall, name: 'external_tool', input: { task: '新工作' } }] },
    { type: 'tool.called', turnId: continueTurn, stepId: secondStep, toolCallId: sharedCall,
      name: 'external_tool', input: { task: '新工作' }, boundary: 'opaque' }, // 20
    { type: 'tool.result', turnId: continueTurn, stepId: secondStep, toolCallId: sharedCall,
      result: { status: 'success', output: { completed: true }, artifacts: ['D:/任务/新结果.txt'] } }, // 21
    { type: 'step.completed', turnId: continueTurn, stepId: secondStep }, // 22
    { type: 'context.compacted', turnId: continueTurn, coveredStepEndEventIndexes: [22],
      previousSummaryEventIndex: 7, sourceDigest: digest, summary: JSON.stringify({ summary: '新增工作有真实成功结果。', sourceEventIndexes: [2, 5, 19, 21] }),
      estimatorVersion: 1, estimatedBefore: 1500, estimatedAfter: 400 },
    { type: 'plan.updated', turnId: continueTurn, revision: 2, explanation: '按照原任务事实重新规划。',
      steps: [
        { id: 'new', description: '新增工作', requestedStatus: 'completed', completionKind: 'tool', evidenceEventIndexes: [21] },
        { id: 'old', description: '原写入', requestedStatus: 'failed', completionKind: 'tool', evidenceEventIndexes: [5] },
        { id: 'host', description: '确认收尾', requestedStatus: 'blocked', completionKind: 'tool', evidenceEventIndexes: [14] },
        { id: 'next', description: '下一步', requestedStatus: 'in_progress', completionKind: 'tool', evidenceEventIndexes: [] },
        { id: 'reply', description: '解释结果', requestedStatus: 'pending', completionKind: 'response', evidenceEventIndexes: [] },
      ] },
    { type: 'effect.outcome.verified', turnId: continueTurn, sourceEventIndex: 8,
      scope: 'entire-call', outcome: 'not-applied',
      evidence: { source: 'user', reference: 'manual:8', description: '用户检查后确认未执行。' } },
    { type: 'turn.cancelled', turnId: continueTurn, reason: 'user' },
    { type: 'turn.started', turnId: 'interrupted-turn' as TurnId },
    { type: 'turn.interrupted', turnId: 'interrupted-turn' as TurnId, reason: 'process-exit' },
  ];
  // 与生产代码使用同一确切来源表示，不用伪造哈希绕过重启校验。
  for (const index of [7, 23]) {
    const event = events[index];
    if (event?.type !== 'context.compacted') throw new Error('摘要测试来源缺失。');
    events[index] = { ...event, sourceDigest: createContextSourceDigest(events.slice(0, index),
      event.coveredStepEndEventIndexes, event.previousSummaryEventIndex) };
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
      { type: 'turn.started', turnId: rootTurn },
      { type: 'tool.result', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall,
        result: { status: 'error', message: '旧错误', output: { detail: '原输出' } } },
      { type: 'assistant.message', turnId: rootTurn, stepId: secondStep,
        toolCalls: [{ id: sharedCall, name: 'old_tool', input: {} }] },
      { type: 'tool.called', turnId: rootTurn, stepId: secondStep, toolCallId: sharedCall,
        name: 'old_tool', input: {} },
    ];
    expect(parsedEvents(events)).toEqual(events);
  });

  it.each(['not-executed', 'read-only', 'checkpointed', 'opaque'])('preserves the %s execution boundary', boundary => {
    const event = { type: 'tool.called', turnId: rootTurn, stepId: firstStep,
      toolCallId: sharedCall, name: 'tool', input: {}, boundary };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each(['transient', 'permanent', 'denied', 'cancelled', 'unknown-outcome'])('preserves the %s failure kind', failureKind => {
    const event = { type: 'tool.result', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall,
      result: { status: 'error', message: '原始失败', output: { details: [1, '原文'] }, failureKind } };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each(['completed', 'failed', 'cancelled'])('preserves a %s host result', status => {
    const events = [
      { type: 'host.operation.started', turnId: rootTurn, operation: 'prepare', description: '准备扩展。' },
      { type: 'host.operation.result', turnId: rootTurn, sourceEventIndex: 0, status },
    ];
    expect(parsedEvents(events)).toEqual(events);
  });

  it.each(['user', 'window-closed', 'external'])('preserves the %s cancellation reason', reason => {
    const event = { type: 'turn.cancelled', turnId: rootTurn, reason };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it('preserves the explicit legacy interruption reason', () => {
    const event = { type: 'turn.interrupted', turnId: rootTurn, reason: 'legacy-unknown' };
    expect(parsedEvents([event])).toEqual([event]);
  });

  it.each([-1, 1.5, 4, 5, 999, 0])('rejects a prepared source index of %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 4, {
      ...events[4], sourceEventIndex,
    }))).toThrow('sessions[0].events[4].sourceEventIndex');
  });

  it.each(['not-executed', 'read-only'])('rejects a prepared effect for a %s call', boundary => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 3, {
      ...events[3], boundary,
    }))).toThrow('sessions[0].events[4].sourceEventIndex');
  });

  it('does not confuse a repeated model call ID with prepared ownership', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents([...events, {
      type: 'tool.effect.prepared', turnId: continueTurn, sourceEventIndex: 3, data: {},
    }])).toThrow('sourceEventIndex');
    const current = { type: 'tool.effect.prepared', turnId: continueTurn, sourceEventIndex: 20, data: { operation: 'new' } };
    expect(parsedEvents([...events, current]).at(-1)).toEqual(current);
  });

  it.each([3, 9, 999])('rejects a host result with an invalid source %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 9, { ...events[9], sourceEventIndex })))
      .toThrow('sessions[0].events[9].sourceEventIndex');
  });

  it('rejects a host result owned by another Turn', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 9, { ...events[9], turnId: verifyTurn })))
      .toThrow('sessions[0].events[9].sourceEventIndex');
  });

  it.each([5, 13, 999])('rejects verification source %s instead of a prior execution start', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 13, { ...events[13], sourceEventIndex })))
      .toThrow('sessions[0].events[13].sourceEventIndex');
  });

  it('rejects file verification of a host operation or a never executed call', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 13, { ...events[13], sourceEventIndex: 8 })))
      .toThrow('sessions[0].events[13].sourceEventIndex');
    expect(() => parsedEvents([
      ...events.slice(0, 3),
      { ...events[3], boundary: 'not-executed' },
      { ...events[13], sourceEventIndex: 3 },
    ])).toThrow('sourceEventIndex');
  });

  it.each([
    { scope: 'entire-call', outcome: 'completed' },
    { scope: 'entire-call', outcome: 'not-applied' },
    { scope: 'file-effect', outcome: 'unresolved' },
  ])('rejects a host observation claiming $scope/$outcome', fields => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 14, { ...events[14], ...fields })))
      .toThrow('sessions[0].events[14].evidence.source');
  });

  it.each([verifyTurn, continueTurn, 'missing-turn'])('rejects a self, future or nonexistent recovery source %s', sourceTurnId => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 12, { ...events[12], sourceTurnId })))
      .toThrow('sessions[0].events[12].sourceTurnId');
  });

  it('requires the new Turn start and a single recovery relation for that Turn', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(events.filter((_event, index) => index !== 11))).toThrow('sourceTurnId');
    expect(() => parsedEvents([...events.slice(0, 13), events[12]])).toThrow('sourceTurnId');
  });

  it('requires the source Turn to start earlier, even when both starts precede the relation', () => {
    const events = [
      { type: 'turn.started', turnId: rootTurn },
      { type: 'turn.started', turnId: verifyTurn },
      { type: 'turn.recovery.started', turnId: rootTurn, sourceTurnId: verifyTurn, mode: 'continue' },
      { type: 'turn.recovery.started', turnId: verifyTurn, sourceTurnId: rootTurn, mode: 'continue' },
    ];
    expect(() => parsedEvents(events)).toThrow('sessions[0].events[2].sourceTurnId');
  });

  it('rejects plan evidence from an unrelated task and cannot use a future relation to fix it', () => {
    const events = [
      { type: 'turn.started', turnId: rootTurn },
      { type: 'tool.result', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall,
        result: { status: 'success', output: '原任务成功' } },
      { type: 'turn.started', turnId: continueTurn },
      { type: 'plan.updated', turnId: continueTurn, revision: 1, explanation: '',
        steps: [{ id: 'work', description: '另一项工作', requestedStatus: 'completed',
          completionKind: 'tool', evidenceEventIndexes: [1] }] },
      { type: 'turn.recovery.started', turnId: continueTurn, sourceTurnId: rootTurn, mode: 'continue' },
    ];
    expect(() => parsedEvents(events)).toThrow('sessions[0].events[3].steps[0].evidenceEventIndexes[0]');
  });

  it.each([-1, 1.5, 24, 999, 22])('rejects unsupported plan evidence index %s', sourceEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 24, {
      type: 'plan.updated', turnId: continueTurn, revision: 1, explanation: '',
      steps: [{ id: 'work', description: '工作', requestedStatus: 'completed',
        completionKind: 'tool', evidenceEventIndexes: [sourceEventIndex] }],
    }))).toThrow('evidenceEventIndexes[0]');
  });

  it.each([6, 23, 999])('rejects previous summary source %s', previousSummaryEventIndex => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 23, { ...events[23], previousSummaryEventIndex })))
      .toThrow(/摘要事件来源不存在|自己或未来摘要/);
  });

  it.each([
    { indexes: [] }, { indexes: [6, 6] }, { indexes: [0] }, { indexes: [7] }, { indexes: [999] },
  ])('rejects new summary coverage $indexes', ({ indexes: coveredStepEndEventIndexes }) => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 7, { ...events[7], coveredStepEndEventIndexes })))
      .toThrow(/摘要覆盖|摘要不能覆盖/);
  });

  it('rejects overlap with all prior summary coverage', () => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 23, {
      ...events[23], coveredStepEndEventIndexes: [6, 22],
    }))).toThrow('重复覆盖');
  });

  it.each([
    { summary: ' ' }, { sourceDigest: 'invalid-digest' }, { estimatorVersion: 2 },
    { estimatedBefore: -1 }, { estimatedAfter: 1.5 },
  ])('rejects an invalid summary disk shape %j', fields => {
    const events = recoveryEvents();
    expect(() => parsedEvents(replaceEvent(events, 7, { ...events[7], ...fields })))
      .toThrow('sessions[0].events[7]');
  });

  it('rejects duplicate plan step IDs from disk', () => {
    const step = { id: 'same', description: '工作', requestedStatus: 'pending', completionKind: 'tool', evidenceEventIndexes: [] };
    expect(() => parsedEvents([{ type: 'plan.updated', turnId: rootTurn, revision: 1, explanation: '', steps: [step, step] }]))
      .toThrow('steps.id');
  });

  it('validates child event references inside the child Session only', () => {
    const state = rawState(recoveryEvents());
    const childEvents = [
      { type: 'tool.called', turnId: rootTurn, stepId: firstStep, toolCallId: sharedCall, name: 'read_file', input: {}, boundary: 'read-only' },
      { type: 'effect.outcome.verified', turnId: rootTurn, sourceEventIndex: 3, scope: 'entire-call', outcome: 'completed',
        evidence: { source: 'tool', reference: 'source:3', description: '不能引用父会话。' } },
    ];
    expect(() => parseDesktopState({ ...state, sessions: [{
      ...state.sessions[0],
      subagentHistory: [{ parentToolCallId: sharedCall, events: childEvents,
        result: { taskId: 'child', title: '只读检查', status: 'completed', summary: '结果', evidence: [] } }],
    }] })).toThrow('subagentHistory.events[1].sourceEventIndex');
  });
});
