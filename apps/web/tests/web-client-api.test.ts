import { describe, expect, it } from 'vitest';
import { createWebClientApi } from '../src/webClientApi.js';

describe('Web Dev API', () => {
  it('keeps sessions and emits a simulated tool and artifact result', async () => {
    const api = createWebClientApi();
    const initial = await api.getActiveSessionId();
    const second = await api.newSession();
    await api.switchSession(initial);
    const events: string[] = [];
    api.onAgentEvent((event) => events.push(event.type));
    const result = await api.runAgentTask('测试任务');

    expect(second).not.toBe(initial);
    expect(events).toEqual(['tool.started', 'tool.completed']);
    expect(result.responseText).toContain('测试任务');
    expect(result.outputFileName).toBe('web-dev-artifact.mp4');
  });
});
