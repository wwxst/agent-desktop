import { describe, expect, it } from 'vitest';
import { createAgent, type Agent, type AgentId } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  ResizeVideoTool,
  type CommandExecutor,
} from '@agent-desktop/video-ffmpeg';

class ScriptedModel implements Model {
  private requestCount = 0;

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.responses[this.requestCount];
    this.requestCount += 1;
    if (response === undefined) throw new Error('Scripted model ran out of responses');
    return response;
  }
}

function createVideoAgent(model: Model, session: InMemorySession): Agent {
  const executeCommand: CommandExecutor = async () => ({ stdout: '', stderr: '' });
  const tools = new InMemoryToolRegistry();
  tools.register(new ConcatVideosTool(executeCommand));
  tools.register(new AddAudioTool(executeCommand));
  tools.register(new ResizeVideoTool(executeCommand));
  tools.register(new AddSubtitlesTool(executeCommand));

  return createAgent({
    id: 'ffmpeg-test-agent' as AgentId,
    model,
    session,
    tools,
    systemPrompt: new StaticSystemPrompt('Use the available video tools.'),
  });
}

function toolEvents(session: InMemorySession): Extract<SessionEvent, { type: 'tool.called' }>[] {
  return session.events().filter(
    (event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called',
  );
}

function resultEvents(session: InMemorySession): Extract<SessionEvent, { type: 'tool.result' }>[] {
  return session.events().filter(
    (event): event is Extract<SessionEvent, { type: 'tool.result' }> => event.type === 'tool.result',
  );
}

describe('Multi-step Video Editing Agent', () => {
  it('completes one video editing turn across four sequential tools', async () => {
    const model = new ScriptedModel([
      {
        toolCalls: [{
          id: 'concat-call' as ToolCallId,
          name: 'concat_videos',
          input: { inputPaths: ['A.mp4', 'B.mp4'], outputPath: 'step-1.mp4' },
        }],
      },
      {
        toolCalls: [{
          id: 'audio-call' as ToolCallId,
          name: 'add_audio',
          input: { videoPath: 'step-1.mp4', audioPath: 'voice.mp3', outputPath: 'step-2.mp4' },
        }],
      },
      {
        toolCalls: [{
          id: 'resize-call' as ToolCallId,
          name: 'resize_video',
          input: { inputPath: 'step-2.mp4', outputPath: 'step-3.mp4', width: 320, height: 480 },
        }],
      },
      {
        toolCalls: [{
          id: 'subtitle-call' as ToolCallId,
          name: 'add_subtitles',
          input: { videoPath: 'step-3.mp4', subtitlePath: 'subtitle.srt', outputPath: 'final.mp4' },
        }],
      },
      { text: 'Video editing complete: final.mp4', toolCalls: [] },
    ]);
    const session = new InMemorySession();
    const agent = createVideoAgent(model, session);

    const result = await runTurn(agent, 'Concatenate A and B, add audio, resize, add subtitles, and save final.mp4.');

    expect(result.stepCount).toBe(5);
    expect(result.response).toEqual({ text: 'Video editing complete: final.mp4', toolCalls: [] });
    expect(session.events().filter((event) => event.type === 'turn.started')).toHaveLength(1);
    expect(toolEvents(session).map((event) => event.name)).toEqual([
      'concat_videos',
      'add_audio',
      'resize_video',
      'add_subtitles',
    ]);
    expect(toolEvents(session).map((event) => event.input)).toEqual([
      { inputPaths: ['A.mp4', 'B.mp4'], outputPath: 'step-1.mp4' },
      { videoPath: 'step-1.mp4', audioPath: 'voice.mp3', outputPath: 'step-2.mp4' },
      { inputPath: 'step-2.mp4', outputPath: 'step-3.mp4', width: 320, height: 480 },
      { videoPath: 'step-3.mp4', subtitlePath: 'subtitle.srt', outputPath: 'final.mp4' },
    ]);
    expect(resultEvents(session).map((event) => event.result)).toEqual([
      { status: 'success', output: 'Video created: step-1.mp4' },
      { status: 'success', output: 'Video created: step-2.mp4' },
      { status: 'success', output: 'Video created: step-3.mp4' },
      { status: 'success', output: 'Video created: final.mp4' },
    ]);
    expect(session.events().filter((event) => event.type === 'turn.completed')).toHaveLength(1);
    expect(session.events().filter((event) => event.type === 'step.completed')).toHaveLength(5);
  });
});
