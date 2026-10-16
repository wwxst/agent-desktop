import { describe, expect, it } from 'vitest';
import { InMemoryToolRegistry, ToolExecutionError, type Tool } from '@agent-desktop/tools';

const echoTool: Tool = {
  name: 'echo',
  description: 'Returns its input.',
  inputSchema: { type: 'string' },
  execute: async (input) => ({ status: 'success', output: input }),
};

describe('InMemoryToolRegistry', () => {
  it('registers, finds, and lists tools', () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    expect(registry.get('echo')).toBe(echoTool);
    expect(registry.list()).toEqual([echoTool]);
  });

  it('rejects duplicate names and returns undefined for unknown tools', () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    expect(() => registry.register(echoTool)).toThrow('Tool already registered: echo');
    expect(registry.get('missing')).toBeUndefined();
  });
});

describe('ToolExecutionError', () => {
  it('retains the original failure and its execution classification', () => {
    const cause = new Error('connection lost after the external request was sent');
    const error = new ToolExecutionError(cause.message, 'unknown-outcome', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolExecutionError');
    expect(error.message).toBe(cause.message);
    expect(error.failureKind).toBe('unknown-outcome');
    expect(error.cause).toBe(cause);
  });
});
