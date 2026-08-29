import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { TranscribeAudioTool } from '@agent-desktop/speech-openai';
import { ExtractAudioTool, type CommandExecutor } from '@agent-desktop/video-ffmpeg';

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private responseIndex = 0;

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.responseIndex];
    this.responseIndex += 1;
    if (response === undefined) throw new Error('Scripted model ran out of responses');
    return response;
  }
}

function createSpeechAgent(model: Model, session: InMemorySession, workspace: string): Agent {
  const executeCommand: CommandExecutor = async (_command, args) => {
    const outputPath = args.at(-1);
    if (outputPath === undefined) throw new Error('Missing FFmpeg output path');
    await readFile(join(workspace, 'input.mp4'));
    await writeFile(outputPath, 'fake mp3 bytes');
    return { stdout: '', stderr: '' };
  };
  const tools = new InMemoryToolRegistry();
  tools.register(new ExtractAudioTool(executeCommand));
  tools.register(new TranscribeAudioTool({ apiKey: 'test-openai-key' }));

  return {
    model,
    session,
    tools,
    systemPrompt: new StaticSystemPrompt('Use extract_audio then transcribe_audio for speech understanding.'),
  };
}

describe('Speech Understanding Agent', () => {
  it('runs audio extraction and transcription through the existing Runtime in one turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-speech-agent-'));
    const inputPath = join(workspace, 'input.mp4');
    const audioPath = join(workspace, 'audio.mp3');
    await writeFile(inputPath, 'fake video bytes');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => (
      new Response(JSON.stringify({ text: 'The speaker explains the video topic.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )));

    try {
      const model = new ScriptedModel([
        {
          toolCalls: [{
            id: 'extract-audio' as ToolCallId,
            name: 'extract_audio',
            input: { videoPath: inputPath, outputPath: audioPath },
          }],
        },
        {
          toolCalls: [{
            id: 'transcribe-audio' as ToolCallId,
            name: 'transcribe_audio',
            input: { audioPath },
          }],
        },
        { text: 'The video is mainly explaining its topic.', toolCalls: [] },
      ]);
      const session = new InMemorySession();
      const result = await runTurn(createSpeechAgent(model, session, workspace), '分析视频里的人主要在说什么。');
      const events = session.events();
      const calls = events.filter(
        (event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called',
      );
      const results = events.filter(
        (event): event is Extract<SessionEvent, { type: 'tool.result' }> => event.type === 'tool.result',
      );

      expect(result.stepCount).toBe(3);
      expect(calls.map((event) => event.name)).toEqual(['extract_audio', 'transcribe_audio']);
      expect(results.map((event) => event.result)).toEqual([
        { status: 'success', output: `Audio created: ${audioPath}` },
        { status: 'success', output: 'The speaker explains the video topic.' },
      ]);
      expect(model.requests[1]?.messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'extract-audio',
        content: `Audio created: ${audioPath}`,
      });
      expect(model.requests[2]?.messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'transcribe-audio',
        content: 'The speaker explains the video topic.',
      });
      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'step.completed')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
