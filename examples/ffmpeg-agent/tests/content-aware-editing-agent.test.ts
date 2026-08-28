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
  ConcatVideosTool,
  ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool,
  TrimVideoTool,
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

function toolCalls(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'tool.called' }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called',
  );
}

function createEditingAgent(model: Model, session: InMemorySession): Agent {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const executeCommand: CommandExecutor = async (command, args) => {
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({ format: { duration: '42' }, streams: [] }),
        stderr: '',
      };
    }

    const outputPath = args.at(-1);
    if (outputPath?.endsWith('.jpg') === true) await writeFile(outputPath, jpeg);
    return { stdout: '', stderr: '' };
  };
  const tools = new InMemoryToolRegistry();
  tools.register(new ExtractVideoFramesTool(executeCommand));
  tools.register(new ExtractVideoRangeFramesTool(executeCommand));
  tools.register(new AnalyzeImagesTool({ apiKey: 'test-openai-key' }));
  tools.register(new TrimVideoTool(executeCommand));
  tools.register(new ConcatVideosTool(executeCommand));

  return createAgent({
    id: 'content-aware-editing-test-agent' as AgentId,
    model,
    session,
    tools,
    // 决策由脚本模型表达；Agent Loop 只承载观察结果和后续 Tool Call，不实现 Planner。
    systemPrompt: new StaticSystemPrompt('Observe video content, refine uncertain ranges, then edit.'),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Content-aware Editing Decision Agent', () => {
  it('observes globally and locally before trimming and concatenating in one turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-content-editing-'));
    const globalDir = join(workspace, 'inspection-global');
    const rangeDir = join(workspace, 'inspection-range');
    const globalFrames = [1, 2, 3, 4, 5, 6].map((index) => ({
      path: join(globalDir, `frame-${String(index).padStart(3, '0')}.jpg`),
      timestamp: 6 * index,
    }));
    const rangeFrames = [1, 2, 3, 4, 5, 6].map((index) => ({
      path: join(rangeDir, `frame-${String(index).padStart(3, '0')}.jpg`),
      timestamp: 20 + (18 * index) / 7,
    }));
    const firstKeep = join(workspace, 'keep-01.mp4');
    const secondKeep = join(workspace, 'keep-02.mp4');
    const finalPath = join(workspace, 'edited-content.mp4');
    const visionResults = [
      { summary: 'Phone operations are followed by dance demonstrations.', frames: [] },
      { summary: 'The phone operation ends before the final dance section.', frames: [] },
    ];
    let visionIndex = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      const result = visionResults[visionIndex];
      visionIndex += 1;
      return new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(result) }],
        }],
      }), { status: 200 });
    }));

    try {
      const model = new ScriptedModel([
        { toolCalls: [{
          id: 'global-extract' as ToolCallId,
          name: 'extract_video_frames',
          input: { videoPath: 'input.mp4', outputDir: globalDir },
        }] },
        { toolCalls: [{
          id: 'global-analyze' as ToolCallId,
          name: 'analyze_images',
          input: { images: globalFrames },
        }] },
        { toolCalls: [{
          id: 'range-extract' as ToolCallId,
          name: 'extract_video_range_frames',
          input: { videoPath: 'input.mp4', outputDir: rangeDir, start: 20, end: 38 },
        }] },
        { toolCalls: [{
          id: 'range-analyze' as ToolCallId,
          name: 'analyze_images',
          input: { images: rangeFrames },
        }] },
        { toolCalls: [{
          id: 'trim-first' as ToolCallId,
          name: 'trim_video',
          input: { inputPath: 'input.mp4', outputPath: firstKeep, start: 8, duration: 14 },
        }] },
        { toolCalls: [{
          id: 'trim-second' as ToolCallId,
          name: 'trim_video',
          input: { inputPath: 'input.mp4', outputPath: secondKeep, start: 28, duration: 6 },
        }] },
        { toolCalls: [{
          id: 'concat-kept' as ToolCallId,
          name: 'concat_videos',
          input: { inputPaths: [firstKeep, secondKeep], outputPath: finalPath },
        }] },
        { text: 'Content-aware edit complete.', toolCalls: [] },
      ]);
      const session = new InMemorySession();
      const result = await runTurn(
        createEditingAgent(model, session),
        'Keep the phone operations, remove dance demonstrations, and create edited-content.mp4.',
      );
      const events = session.events();
      const calls = toolCalls(events);

      expect(result.stepCount).toBe(8);
      expect(calls.map((event) => event.name)).toEqual([
        'extract_video_frames',
        'analyze_images',
        'extract_video_range_frames',
        'analyze_images',
        'trim_video',
        'trim_video',
        'concat_videos',
      ]);
      expect(calls.slice(4).map((event) => event.input)).toEqual([
        { inputPath: 'input.mp4', outputPath: firstKeep, start: 8, duration: 14 },
        { inputPath: 'input.mp4', outputPath: secondKeep, start: 28, duration: 6 },
        { inputPaths: [firstKeep, secondKeep], outputPath: finalPath },
      ]);
      const localVisionResultIndex = events.findIndex((event) => (
        event.type === 'tool.result' && event.toolCallId === ('range-analyze' as ToolCallId)
      ));
      const firstTrimIndex = events.findIndex((event) => (
        event.type === 'tool.called' && event.toolCallId === ('trim-first' as ToolCallId)
      ));
      expect(localVisionResultIndex).toBeGreaterThan(-1);
      expect(firstTrimIndex).toBeGreaterThan(localVisionResultIndex);
      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
