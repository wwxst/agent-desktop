import { describe, expect, it } from 'vitest';
import type { ToolCall, ToolCallId } from '@agent-desktop/model';
import {
  InMemorySession,
  recoverSessionEvents,
  type SessionEvent,
  type StepId,
  type TurnId,
} from '@agent-desktop/session';

const turnId = 'turn-1' as TurnId;
const stepId = 'step-1' as StepId;
const toolCallId = 'call-1' as ToolCallId;

describe('InMemorySession', () => {
  it('preserves append order and returns the current session history', () => {
    const session = new InMemorySession();
    const started: SessionEvent = { type: 'turn.started', turnId };
    const message: SessionEvent = { type: 'user.message', turnId, content: 'hello' };

    session.append(started);
    session.append(message);
    expect(session.events()).toEqual([started, message]);
  });

  it('restores seed events in order, isolates the input array, and continues appending', () => {
    const started: SessionEvent = { type: 'turn.started', turnId };
    const message: SessionEvent = { type: 'user.message', turnId, content: 'remember 731' };
    const initialEvents: SessionEvent[] = [started, message];
    const session = new InMemorySession(initialEvents);

    initialEvents.pop();
    const completed: SessionEvent = { type: 'turn.completed', turnId };
    session.append(completed);

    expect(session.events()).toEqual([started, message, completed]);
  });

  it('represents successful and failed tool results as distinct unions', () => {
    const success: SessionEvent = {
      type: 'tool.result',
      turnId,
      stepId,
      toolCallId,
      result: { status: 'success', output: 'hello' },
    };
    const failure: SessionEvent = {
      type: 'tool.result',
      turnId,
      stepId,
      toolCallId,
      result: { status: 'error', message: 'failed' },
    };

    expect(success.result.status).toBe('success');
    expect(failure.result.status).toBe('error');
  });

  it('records the model ToolCall contract without redefining it', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'echo', input: 'hello' };
    const event: SessionEvent = {
      type: 'assistant.message',
      turnId,
      stepId,
      toolCalls: [toolCall],
    };

    expect(event.toolCalls).toEqual([toolCall]);
  });
});

describe('recoverSessionEvents', () => {
  const cancelledTurnId = 'turn-cancelled' as TurnId;
  const cancelledStepId = 'step-cancelled' as StepId;

  it('keeps a completed Step Tool Calling chain unchanged', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'trim_video', input: { start: 0 } };
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId },
      { type: 'user.message', turnId, content: '裁掉前 3 秒' },
      { type: 'step.started', turnId, stepId },
      { type: 'assistant.message', turnId, stepId, content: '先裁剪。', toolCalls: [toolCall] },
      { type: 'tool.called', turnId, stepId, toolCallId, name: 'trim_video', input: { start: 0 } },
      {
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId,
        result: { status: 'success', output: 'out.mp4' },
      },
      { type: 'step.completed', turnId, stepId },
      { type: 'turn.completed', turnId },
    ];

    // 已完成 Step 的 Tool Calling 链是完整事实，恢复时必须原样保留。
    expect(recoverSessionEvents(events)).toEqual(events);
  });

  it('drops the residue of an incomplete Step but keeps Turn facts', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'trim_video', input: { start: 0 } };
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId },
      { type: 'user.message', turnId, content: '裁掉前 3 秒' },
      { type: 'step.started', turnId, stepId },
      { type: 'assistant.message', turnId, stepId, content: '裁剪完成。', toolCalls: [] },
      { type: 'step.completed', turnId, stepId },
      { type: 'turn.completed', turnId },
      { type: 'turn.started', turnId: cancelledTurnId },
      { type: 'user.message', turnId: cancelledTurnId, content: '再裁一次' },
      { type: 'step.started', turnId: cancelledTurnId, stepId: cancelledStepId },
      {
        type: 'assistant.message',
        turnId: cancelledTurnId,
        stepId: cancelledStepId,
        content: '正在裁剪。',
        toolCalls: [toolCall],
      },
      {
        type: 'tool.called',
        turnId: cancelledTurnId,
        stepId: cancelledStepId,
        toolCallId,
        name: 'trim_video',
        input: { start: 0 },
      },
    ];

    expect(recoverSessionEvents(events)).toEqual([
      { type: 'turn.started', turnId },
      { type: 'user.message', turnId, content: '裁掉前 3 秒' },
      { type: 'step.started', turnId, stepId },
      { type: 'assistant.message', turnId, stepId, content: '裁剪完成。', toolCalls: [] },
      { type: 'step.completed', turnId, stepId },
      { type: 'turn.completed', turnId },
      // 未完成 Turn 的 Turn 事实与用户输入是真实记录，未完成 Step 的运行时残留被排除。
      { type: 'turn.started', turnId: cancelledTurnId },
      { type: 'user.message', turnId: cancelledTurnId, content: '再裁一次' },
    ]);
  });
});
