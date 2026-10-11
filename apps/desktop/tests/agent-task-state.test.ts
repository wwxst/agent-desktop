import { describe, expect, it } from 'vitest';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
import { projectAgentTaskState, qualifyTaskToolEvidence } from '../src/main/agent-task-state.js';

const turn = 'turn-1' as TurnId;
const step = 'step-1' as StepId;
const call = 'call-1' as ToolCallId;

function eventsFor(name: string, output: unknown): SessionEvent[] {
  return [
    { type: 'turn.started', turnId: turn },
    { type: 'tool.called', turnId: turn, stepId: step, toolCallId: call, name, input: {}, boundary: 'read-only' },
    { type: 'tool.result', turnId: turn, stepId: step, toolCallId: call, result: { status: 'success', output } },
  ];
}

describe('Desktop task state projection', () => {
  it('qualifies local completed operations and rejects terminal acknowledgement as business completion', () => {
    const command = eventsFor('run_command', { exitCode: 0, termination: 'exited' });
    expect(qualifyTaskToolEvidence(command[2] as Extract<SessionEvent, { type: 'tool.result' }>, command)).toEqual({
      eligible: true, label: '命令已退出（退出码 0）',
    });
    const terminal = eventsFor('write_terminal', { status: 'running' });
    expect(qualifyTaskToolEvidence(terminal[2] as Extract<SessionEvent, { type: 'tool.result' }>, terminal).eligible).toBe(false);
  });

  it('requires every delegated child to complete', () => {
    const incomplete = eventsFor('delegate_tasks', { tasks: [{ status: 'completed' }, { status: 'failed' }] });
    expect(qualifyTaskToolEvidence(incomplete[2] as Extract<SessionEvent, { type: 'tool.result' }>, incomplete).eligible).toBe(false);
    const complete = eventsFor('delegate_tasks', { tasks: [{ status: 'completed' }, { status: 'completed' }] });
    expect(qualifyTaskToolEvidence(complete[2] as Extract<SessionEvent, { type: 'tool.result' }>, complete).eligible).toBe(true);
  });

  it('projects a plan from real tool facts and preserves task ancestry', () => {
    const events = eventsFor('read_file', { path: 'notes.txt' });
    events.push(
      { type: 'plan.updated', turnId: turn, revision: 1, explanation: '读取并回复', steps: [{
        id: 'read', description: '读取文件', requestedStatus: 'completed', completionKind: 'tool', evidenceEventIndexes: [2],
      }] },
      { type: 'turn.completed', turnId: turn },
    );
    expect(projectAgentTaskState(events, turn)).toEqual({
      rootTurnId: turn,
      latestTurnId: turn,
      status: 'completed',
      plan: {
        revision: 1,
        explanation: '读取并回复',
        steps: [{ id: 'read', description: '读取文件', status: 'completed', completionKind: 'tool', evidenceLabels: ['文件已读取'] }],
      },
    });
  });

  it('does not claim unknown tools completed', () => {
    const events = eventsFor('mcp_unknown', { ok: true });
    expect(qualifyTaskToolEvidence(events[2] as Extract<SessionEvent, { type: 'tool.result' }>, events)).toEqual({
      eligible: false, label: '工具已返回，业务结果未确认',
    });
  });
});
