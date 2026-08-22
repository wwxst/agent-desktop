import { describe, expect, it } from 'vitest';
import { createAgent, type AgentId } from '@agent-desktop/agent';
import type { Model } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';

describe('createAgent', () => {
  it('keeps the runtime dependencies and identity together', () => {
    const model: Model = {
      complete: async () => ({ toolCalls: [] }),
    };
    const session = new InMemorySession();
    const tools = new InMemoryToolRegistry();
    const systemPrompt = new StaticSystemPrompt('Base instructions.');
    const agent = createAgent({
      id: 'agent-1' as AgentId,
      model,
      session,
      tools,
      systemPrompt,
    });

    expect(agent).toEqual({ id: 'agent-1', model, session, tools, systemPrompt });
  });
});
