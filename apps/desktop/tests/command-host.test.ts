import { describe, expect, it } from 'vitest';
import type { AgentActivityDetail } from '@agent-desktop/client';
import { CommandOutputProjection } from '../src/main/command-host.js';

describe('CommandOutputProjection', () => {
  it('does not carry output from one command into the next command activity', () => {
    const published: Array<{ activityId: string; detail: AgentActivityDetail }> = [];
    const projection = new CommandOutputProjection((activityId, detail) => {
      published.push({ activityId, detail });
    });

    projection.push('first', 'Write-Output first', {
      kind: 'command.output', stream: 'stdout', sequence: 0, text: 'first-output',
    });
    projection.push('second', 'Write-Output second', {
      kind: 'command.output', stream: 'stdout', sequence: 0, text: 'second-output',
    });
    projection.flush();

    expect(published.at(-1)).toEqual({
      activityId: 'second',
      detail: {
        kind: 'command-output',
        command: 'Write-Output second',
        stdout: 'second-output',
        stderr: '',
        truncated: false,
        droppedBytes: 0,
      },
    });
  });
});
