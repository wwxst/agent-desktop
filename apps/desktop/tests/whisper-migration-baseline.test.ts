import { describe, expect, it } from 'vitest';
import { createVideoAgent } from '@agent-desktop/video-agent';

describe('Whisper migration baseline', () => {
  it('does not create a built-in transcription tool without host injection', () => {
    const agent = createVideoAgent({
      model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) },
    });
    const tool = agent.tools.list().find((entry) => entry.name === 'transcribe_audio');

    expect(tool).toBeUndefined();
    const injected = createVideoAgent({
      model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) },
      mediaTools: [{ name: 'transcribe_audio', description: 'WAV', inputSchema: {
        type: 'object', properties: { audioPath: { type: 'string' } }, required: ['audioPath'], additionalProperties: false,
      }, execute: async () => ({ status: 'success' as const, output: { text: '', segments: [] } }) }],
    }).tools.list().find((entry) => entry.name === 'transcribe_audio');
    expect(injected?.inputSchema).toEqual({
      type: 'object',
      properties: { audioPath: { type: 'string' } },
      required: ['audioPath'],
      additionalProperties: false,
    });
    expect(injected?.description).toContain('WAV');
  });
});
