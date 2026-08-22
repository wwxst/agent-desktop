import { describe, expect, it } from 'vitest';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';

describe('StaticSystemPrompt', () => {
  it('returns the configured prompt consistently', () => {
    const prompt = new StaticSystemPrompt('You are a concise assistant.');

    expect(prompt.build()).toBe('You are a concise assistant.');
    expect(prompt.build()).toBe(prompt.build());
  });
});
