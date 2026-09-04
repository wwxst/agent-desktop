import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { TranscribeAudioTool, type CommandExecutor as WhisperCommandExecutor } from '@agent-desktop/speech-whisper-cpp';
import {
  ConcatVideosTool,
  ExtractAudioTool,
  ExtractVideoRangeFramesTool,
  TrimVideoTool,
  type CommandExecutor as FfmpegCommandExecutor,
} from '@agent-desktop/video-ffmpeg';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';

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

function toolCalls(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'tool.called' }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called',
  );
}

function createSemanticEditingAgent(model: Model, session: InMemorySession): Agent {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const executeFfmpeg: FfmpegCommandExecutor = async (command, args) => {
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({ format: { duration: '30' }, streams: [] }),
        stderr: '',
      };
    }

    const outputPath = args.at(-1);
    if (outputPath === undefined) throw new Error('Missing FFmpeg output path');
    if (outputPath.endsWith('.jpg')) await writeFile(outputPath, jpeg);
    if (outputPath.endsWith('.mp4')) await writeFile(outputPath, 'fake edited video');
    if (outputPath.endsWith('.wav')) await writeFile(outputPath, 'fake audio');
    return { stdout: '', stderr: '' };
  };
  const executeWhisper: WhisperCommandExecutor = async (_command, args) => {
    const outputFlagIndex = args.indexOf('-of');
    const outputBase = args[outputFlagIndex + 1];
    if (outputFlagIndex === -1 || outputBase === undefined) {
      throw new Error('Missing whisper-cli -of output base');
    }
    await writeFile(`${outputBase}.json`, JSON.stringify({
      transcription: [
        { offsets: { from: 5000, to: 11000 }, text: ' France is introduced. ' },
        { offsets: { from: 20000, to: 26000 }, text: ' Japan is introduced. ' },
      ],
    }));
    return { stdout: '', stderr: '' };
  };

  const tools = new InMemoryToolRegistry();
  tools.register(new ExtractAudioTool(executeFfmpeg));
  tools.register(new TranscribeAudioTool({ modelPath: 'ggml-small.bin' }, executeWhisper));
  tools.register(new ExtractVideoRangeFramesTool(executeFfmpeg));
  tools.register(new AnalyzeImagesTool({ apiKey: 'test-openai-key' }));
  tools.register(new TrimVideoTool(executeFfmpeg));
  tools.register(new ConcatVideosTool(executeFfmpeg));

  return {
    model,
    session,
    tools,
    systemPrompt: new StaticSystemPrompt([
      'Use the speech timeline to find semantic ranges before editing.',
      'Use local visual inspection only when a speech boundary needs confirmation.',
      'Trim each disjoint range from the original video, then concatenate in semantic order.',
    ].join('\n')),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Semantic Video Editing Agent', () => {
  it('turns speech timeline ranges into ordered trim and concat calls', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-semantic-editing-'));
    const inputPath = join(workspace, 'input.mp4');
    const audioPath = join(workspace, 'audio.wav');
    const rangeOneDir = join(workspace, 'range-france');
    const rangeTwoDir = join(workspace, 'range-japan');
    const francePath = join(workspace, 'keep-france.mp4');
    const japanPath = join(workspace, 'keep-japan.mp4');
    const finalPath = join(workspace, 'edited.mp4');
    await writeFile(inputPath, 'fake source video');

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({
          summary: 'The requested topic is visible in this range.',
          frames: [],
        }) }],
      }],
    }), { status: 200 })));

    try {
      const model = new ScriptedModel([
        { toolCalls: [{ id: 'extract-audio' as ToolCallId, name: 'extract_audio', input: { videoPath: inputPath, outputPath: audioPath } }] },
        { toolCalls: [{ id: 'transcribe-audio' as ToolCallId, name: 'transcribe_audio', input: { audioPath } }] },
        { toolCalls: [{ id: 'range-france' as ToolCallId, name: 'extract_video_range_frames', input: { videoPath: inputPath, outputDir: rangeOneDir, start: 5, end: 11 } }] },
        { toolCalls: [{ id: 'analyze-france' as ToolCallId, name: 'analyze_images', input: { images: [1, 2, 3, 4, 5, 6].map((index) => ({ path: join(rangeOneDir, `frame-${String(index).padStart(3, '0')}.jpg`), timestamp: 5 + (6 * index) / 7 })) } }] },
        { toolCalls: [{ id: 'range-japan' as ToolCallId, name: 'extract_video_range_frames', input: { videoPath: inputPath, outputDir: rangeTwoDir, start: 20, end: 26 } }] },
        { toolCalls: [{ id: 'analyze-japan' as ToolCallId, name: 'analyze_images', input: { images: [1, 2, 3, 4, 5, 6].map((index) => ({ path: join(rangeTwoDir, `frame-${String(index).padStart(3, '0')}.jpg`), timestamp: 20 + (6 * index) / 7 })) } }] },
        { toolCalls: [{ id: 'trim-france' as ToolCallId, name: 'trim_video', input: { inputPath, outputPath: francePath, start: 5, duration: 6 } }] },
        { toolCalls: [{ id: 'trim-japan' as ToolCallId, name: 'trim_video', input: { inputPath, outputPath: japanPath, start: 20, duration: 6 } }] },
        { toolCalls: [{ id: 'concat' as ToolCallId, name: 'concat_videos', input: { inputPaths: [francePath, japanPath], outputPath: finalPath } }] },
        { text: 'Semantic edit complete.', toolCalls: [] },
      ]);
      const session = new InMemorySession();
      const result = await runTurn(
        createSemanticEditingAgent(model, session),
        '保留视频里讲 France 和 Japan 的内容，删除其他部分并生成 edited.mp4。',
      );
      const calls = toolCalls(session.events());

      expect(result.stepCount).toBe(10);
      expect(calls.map((event) => event.name)).toEqual([
        'extract_audio',
        'transcribe_audio',
        'extract_video_range_frames',
        'analyze_images',
        'extract_video_range_frames',
        'analyze_images',
        'trim_video',
        'trim_video',
        'concat_videos',
      ]);
      expect(calls.slice(6).map((event) => event.input)).toEqual([
        { inputPath, outputPath: francePath, start: 5, duration: 6 },
        { inputPath, outputPath: japanPath, start: 20, duration: 6 },
        { inputPaths: [francePath, japanPath], outputPath: finalPath },
      ]);
      expect(model.requests[2]?.messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'transcribe-audio',
        content: JSON.stringify({
          text: 'France is introduced. Japan is introduced.',
          segments: [
            { start: 5, end: 11, text: 'France is introduced.' },
            { start: 20, end: 26, text: 'Japan is introduced.' },
          ],
        }),
      });
      expect(await readFile(finalPath, 'utf8')).toBe('fake edited video');
      expect(session.events().filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(session.events().filter((event) => event.type === 'turn.completed')).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
