import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent, type Agent, type AgentId } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import {
  ExtractVideoFramesTool,
  type CommandExecutor,
} from '@agent-desktop/video-ffmpeg';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';

class ScriptedModel implements Model {
  private responseIndex = 0;

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.responses[this.responseIndex];
    this.responseIndex += 1;
    if (response === undefined) throw new Error('Scripted model ran out of responses');
    return response;
  }
}

function createVisualAgent(model: Model, session: InMemorySession, outputDir: string): Agent {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const executeCommand: CommandExecutor = async (command, args) => {
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({ format: { duration: '42' }, streams: [] }),
        stderr: '',
      };
    }
    await writeFile(args.at(-1) ?? join(outputDir, 'missing.jpg'), jpeg);
    return { stdout: '', stderr: '' };
  };
  const tools = new InMemoryToolRegistry();
  tools.register(new ExtractVideoFramesTool(executeCommand));
  tools.register(new AnalyzeImagesTool({ apiKey: 'test-openai-key' }));

  return createAgent({
    id: 'visual-test-agent' as AgentId,
    model,
    session,
    tools,
    systemPrompt: new StaticSystemPrompt('Inspect video frames and report observations.'),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Visual Media Inspection Agent', () => {
  it('uses frame extraction and image analysis in one three-step turn', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-visual-agent-'));
    const framePaths = [1, 2, 3, 4, 5, 6].map((index) => (
      join(outputDir, `frame-${String(index).padStart(3, '0')}.jpg`)
    ));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({ summary: 'A sampled video.', frames: [] }),
        }],
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const model = new ScriptedModel([
        {
          toolCalls: [{
            id: 'extract-call' as ToolCallId,
            name: 'extract_video_frames',
            input: { videoPath: 'input.mp4', outputDir },
          }],
        },
        {
          toolCalls: [{
            id: 'analyze-call' as ToolCallId,
            name: 'analyze_images',
            input: {
              images: framePaths.map((path, index) => ({
                path,
                timestamp: (42 * (index + 1)) / 7,
              })),
            },
          }],
        },
        { text: 'The video shows a sampled scene.', toolCalls: [] },
      ]);
      const session = new InMemorySession();
      const agent = createVisualAgent(model, session, outputDir);

      const result = await runTurn(agent, '分析 input.mp4 里主要是什么内容。');
      const events = session.events();
      const calls = events.filter(
        (event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called',
      );

      expect(result.stepCount).toBe(3);
      expect(result.response).toEqual({ text: 'The video shows a sampled scene.', toolCalls: [] });
      expect(calls.map((event) => event.name)).toEqual([
        'extract_video_frames',
        'analyze_images',
      ]);
      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'step.completed')).toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const extractResult = events.find((event): event is Extract<SessionEvent, { type: 'tool.result' }> => (
        event.type === 'tool.result' && event.toolCallId === ('extract-call' as ToolCallId)
      ));
      expect(extractResult?.result).toMatchObject({ status: 'success' });
      const extractedOutput = (extractResult?.result as { output: { duration: number; frames: readonly { path: string }[] } }).output;
      expect(extractedOutput.duration).toBe(42);
      expect(extractedOutput.frames).toHaveLength(6);
      expect(extractedOutput.frames[0]?.path).toBe(framePaths[0]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
