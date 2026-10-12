import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@agent-desktop/model';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import type { Tool } from '@agent-desktop/tools';
import { InMemorySession } from '@agent-desktop/session';
import { DeclareVideoOutputsTool } from '../src/delivery-tools.js';
import { readVideoDeliveryFacts } from '../src/delivery.js';
import { CheckVideoSemanticsTool } from '../src/semantic-check.js';
import { createVideoAgent } from '../src/index.js';

const context = { toolCallId: 'check' as never, reportProgress: () => {} };
let directory: string;
let session: InMemorySession;
let input: { outputItemId: string; candidatePath: string };
let requirementId: string;
let model: Model;
let probe: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let fullFrames: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let audio: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let speech: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let vision: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
const frames = [{ path: 'frame-1.jpg', timestamp: 0 }, { path: 'frame-2.jpg', timestamp: 0.1 }];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'semantic-contract-'));
  session = new InMemorySession([{ type: 'turn.started', turnId: 't' as never }]);
  const result = await new DeclareVideoOutputsTool(() => session.events()).execute({ items: [{ sourcePaths: [join(directory, 'source.mp4')],
    target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '红色矩形' }] }] });
  session.append({ type: 'tool.called', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, name: 'declare_video_outputs', input: {} });
  session.append({ type: 'tool.result', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, result });
  const item = readVideoDeliveryFacts(session.events()).items[0]!;
  input = { outputItemId: item.id, candidatePath: join(item.workingDirectory, 'candidate.mp4') };
  requirementId = item.requirements.find((requirement) => requirement.kind === 'semantic')!.id;
  await writeFile(input.candidatePath, 'actual candidate bytes');
  fullFrames = { name: 'extract_full_video_frames', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { complete: true, frames } })) };
  audio = { name: 'extract_audio', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'audio' })) };
  speech = { name: 'transcribe_audio', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 0.2 }] } })) };
  probe = { name: 'probe_media', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { audioCodec: null, duration: 0.2 } })) };
  vision = { name: 'analyze_images', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: '红色矩形' })) } })) };
  model = { complete: vi.fn(async () => ({ toolCalls: [{ id: 'judgment' as never, name: 'report_semantic_checks',
    input: { checks: [{ requirementId, outcome: 'passed', detail: '0 至 0.2 秒为红色矩形' }] } }] })) };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const tool = (includeVision = true) => new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio, speech], ...(includeVision ? { vision } : {}) });

describe('semantic evidence completeness', () => {
  it('preserves all observations and binds the independent verdict to candidate bytes', async () => {
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { outputItemId: input.outputItemId,
      coverage: 'all-frames-and-transcript', frameCount: 2, candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidence: { frames: [{ timestamp: 0 }, { timestamp: 0.1 }], transcript: { hasAudio: false } }, checks: [{ outcome: 'passed' }] } });
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it('blocks missing Vision and an exceeded frame budget without calling the judge', async () => {
    expect(await tool(false).execute(input, context)).toMatchObject({ status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked' }] } });
    fullFrames.execute.mockResolvedValue({ status: 'success', output: { complete: false, reason: '超过 600 帧预算' } });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: '超过 600 帧预算' }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('rejects omitted frame observations and audio without transcription capability', async () => {
    vision.execute.mockResolvedValueOnce({ status: 'success', output: { frames: [{ timestamp: 0, description: 'red' }] } });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    const withoutSpeech = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio], vision });
    expect(await withoutSpeech.execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('语音识别') }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('blocks malformed external verdicts and candidate mutation during checking', async () => {
    vi.mocked(model.complete).mockResolvedValueOnce({ toolCalls: [{ id: 'bad' as never, name: 'report_semantic_checks', input: { checks: [null] } }] });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    vision.execute.mockImplementationOnce(async () => {
      await writeFile(input.candidatePath, 'modified while observing');
      return { status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: 'red' })) } };
    });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('改变') }] } });
  });
  it('blocks absent and failed Probe before extracting frames or invoking external services', async () => {
    fullFrames.execute.mockClear();
    const missing = new CheckVideoSemanticsTool(() => session.events(), { model });
    expect(await missing.execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('probe_media') }] } });
    probe.execute.mockResolvedValueOnce({ status: 'error', message: '用户拒绝了插件工具调用。' });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('用户拒绝') }] } });
    expect(fullFrames.execute).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('passes the same context to the injected Probe and propagates cancellation', async () => {
    const execution = { ...context, signal: new AbortController().signal };
    await tool().execute(input, execution);
    expect(probe.execute).toHaveBeenCalledWith({ inputPath: input.candidatePath }, execution);
    probe.execute.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(tool().execute(input, execution)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses the injected Vision context and preserves approval rejection and cancellation', async () => {
    vi.spyOn(DeepSeekModel.prototype, 'complete').mockImplementation(model.complete);
    const agent = createVideoAgent({ deepSeekApiKey: 'fixture', session, mediaTools: [probe, fullFrames, audio, speech], visionTool: vision });
    const check = agent.tools.get('check_video_semantics')!;
    const execution = { ...context, signal: new AbortController().signal };
    expect(agent.tools.get('analyze_images')).toBe(vision);
    await check.execute(input, execution);
    expect(vision.execute).toHaveBeenCalledWith({ images: frames }, execution);
    vision.execute.mockResolvedValueOnce({ status: 'error', message: '用户拒绝了插件工具调用。' });
    vi.mocked(model.complete).mockClear();
    expect(await check.execute(input, execution)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('用户拒绝') }] } });
    expect(model.complete).not.toHaveBeenCalled();
    vision.execute.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(check.execute(input, execution)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses injected duration to reject a mismatched speech timeline', async () => {
    probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    speech.execute.mockResolvedValueOnce({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 2 }] } });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio, speech], vision });
    expect(await check.execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('时长不一致') }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
});
