import { describe, expect, it } from 'vitest';
import { createVideoAgent } from '@agent-desktop/video-agent';

describe('Whisper migration baseline', () => {
  it('records the existing Desktop-facing registration and stable tool contract', () => {
    const agent = createVideoAgent({
      deepSeekApiKey: 'fixture',
      whisperModelPath: 'models/ggml-small.bin',
      whisperCliPath: 'whisper-cli',
    });
    const tool = agent.tools.list().find((entry) => entry.name === 'transcribe_audio');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { audioPath: { type: 'string' } },
      required: ['audioPath'],
      additionalProperties: false,
    });
    expect(tool?.description).toContain('WAV');
  });
});
