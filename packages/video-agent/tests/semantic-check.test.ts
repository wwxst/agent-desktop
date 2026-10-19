import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@agent-desktop/model';
import { InMemoryToolRegistry, ToolRouter, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { InMemorySession, projectRecoveryFacts, SessionPersistenceError } from '@agent-desktop/session';
import { ToolExecutionError } from '@agent-desktop/tools';
import { DeclareVideoOutputsTool } from '../src/delivery-tools.js';
import { readVideoDeliveryFacts } from '../src/delivery.js';
import { CheckVideoSemanticsTool } from '../src/semantic-check.js';
import { createVideoAgent } from '../src/index.js';

// 仍执行真实文件操作，只为检查 mkdir 顺序和注入清理失败保留可观察的调用边界。
vi.mock('node:fs/promises', async importOriginal => {
  const fileSystem = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fileSystem, mkdtemp: vi.fn(fileSystem.mkdtemp), rm: vi.fn(fileSystem.rm) };
});

const context: ToolExecutionContext = { toolCallId: 'check' as never, reportProgress: () => {}, checkpoint: () => {} };
let directory: string;
let session: InMemorySession;
let input: { outputItemId: string; candidatePath: string };
let requirementId: string;
let model: Model;
let probe: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let fullFrames: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let segmentFrames: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let audio: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let speech: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
let vision: Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> };
const frames = [{ path: 'frame-1.jpg', timestamp: 0 }, { path: 'frame-2.jpg', timestamp: 0.1 }];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'semantic-contract-'));
  session = new InMemorySession();
  session.append({ type: 'turn.started', turnId: 't' as never, payload: {} });
  const result = await new DeclareVideoOutputsTool(() => session.events()).execute({ items: [{ sourcePaths: [join(directory, 'source.mp4')],
    target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '红色矩形' }] }] }, context);
  session.append({ type: 'tool.called', turnId: 't' as never, payload: { stepId: 's' as never, toolCallId: 'declare' as never, name: 'declare_video_outputs', input: {} } });
  session.append({ type: 'tool.result', turnId: 't' as never, payload: { stepId: 's' as never, toolCallId: 'declare' as never, result } });
  const item = readVideoDeliveryFacts(session.events()).items[0]!;
  input = { outputItemId: item.id, candidatePath: join(item.workingDirectory, 'candidate.mp4') };
  requirementId = item.requirements.find((requirement) => requirement.kind === 'semantic')!.id;
  await writeFile(input.candidatePath, 'actual candidate bytes');
  fullFrames = { name: 'extract_full_video_frames', contract: { approvalRequirement: 'none' }, executionBoundary: 'checkpointed', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { complete: true, frames } })) };
  segmentFrames = { name: 'extract_video_segment_frames', contract: { approvalRequirement: 'none' }, executionBoundary: 'checkpointed', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async input => {
    const value = input as { startFrame: number; maxFrames: number };
    const endFrame = Math.min(1201, value.startFrame + value.maxFrames);
    return { status: 'success', output: { complete: true, totalFrames: 1201, startFrame: value.startFrame, endFrame,
      frames: Array.from({ length: endFrame - value.startFrame }, (_, index) => ({ path: `frame-${value.startFrame + index}.jpg`, timestamp: (value.startFrame + index) / 30 })) } };
  }) };
  audio = { name: 'extract_audio', contract: { approvalRequirement: 'none' }, executionBoundary: 'checkpointed', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'audio' })) };
  probe = { name: 'probe_media', contract: { approvalRequirement: 'none' }, executionBoundary: 'read-only', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { audioCodec: null, duration: 0.2 } })) };
  speech = { name: 'transcribe_audio', contract: { approvalRequirement: 'none' }, executionBoundary: 'read-only', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 0.2 }] } })) };
  vision = { name: 'analyze_images', contract: { approvalRequirement: 'none' }, executionBoundary: 'read-only', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: '红色矩形' })) } })) };
  model = { complete: vi.fn(async () => ({ toolCalls: [{ id: 'judgment' as never, name: 'report_semantic_checks',
    input: { checks: [{ requirementId, outcome: 'passed', detail: '0 至 0.2 秒为红色矩形' }] } }] })) };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const tool = (includeVision = true) => new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, segmentFrames, audio, speech], ...(includeVision ? { vision } : {}) });

async function executeSemantic(check: Tool, value = input, execution = context, replacements: readonly Tool[] = [], capabilities?: readonly string[]) {
  const dependencies = new Map([probe, fullFrames, segmentFrames, audio, speech, vision, ...replacements].map(dependency => [dependency.name, dependency]));
  const registry = new InMemoryToolRegistry();
  registry.register(check);
  for (const name of check.nestedToolNames ?? []) {
    const dependency = dependencies.get(name);
    if (dependency !== undefined) registry.register(dependency);
  }
  return new ToolRouter(registry, capabilities).execute({ id: execution.toolCallId, name: check.name, input: value }, execution);
}

describe('semantic evidence completeness', () => {
  it('preserves all observations and binds the independent verdict to candidate bytes', async () => {
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { outputItemId: input.outputItemId,
      coverage: 'all-frames-and-transcript', frameCount: 2, candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidence: { frames: [{ timestamp: 0 }, { timestamp: 0.1 }], transcript: { hasAudio: false } }, checks: [{ outcome: 'passed' }] } });
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it('blocks missing Vision and an exceeded frame budget without calling the judge', async () => {
    expect(await executeSemantic(tool(false))).toMatchObject({ status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked' }] } });
    fullFrames.execute.mockResolvedValue({ status: 'success', output: { complete: false, reason: '超过 600 帧预算' } });
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: '超过 600 帧预算' }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('observes every frame in ordered 600-frame segments for a long candidate', async () => {
    fullFrames.execute.mockResolvedValueOnce({ status: 'success', output: { complete: false, frameCount: 1201, reason: '需要逐段检查' } });
    vision.execute.mockImplementation(async value => {
      const images = (value as { images: typeof frames }).images;
      return { status: 'success', output: { frames: images.map(frame => ({ timestamp: frame.timestamp, description: `画面 ${frame.timestamp}` })) } };
    });

    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: {
      coverage: 'all-frames-and-transcript', frameCount: 1201, checks: [{ outcome: 'passed' }],
    } });
    expect(segmentFrames.execute.mock.calls.map(([value]) => (value as { startFrame: number; maxFrames: number })))
      .toEqual([{ inputPath: input.candidatePath, outputDir: expect.stringContaining('segment-0'), startFrame: 0, maxFrames: 600 },
        { inputPath: input.candidatePath, outputDir: expect.stringContaining('segment-600'), startFrame: 600, maxFrames: 600 },
        { inputPath: input.candidatePath, outputDir: expect.stringContaining('segment-1200'), startFrame: 1200, maxFrames: 1 }]);
    expect(vision.execute).toHaveBeenCalledTimes(201);
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it('judges oversized full-frame evidence in bounded batches and aggregates every result', async () => {
    const description = '画面证据'.repeat(15_000);
    vision.execute.mockImplementation(async value => {
      const images = (value as { images: typeof frames }).images;
      return { status: 'success', output: { frames: images.map(frame => ({ timestamp: frame.timestamp, description })) } };
    });
    vi.mocked(model.complete).mockClear();

    const result = await executeSemantic(tool());

    expect(result).toMatchObject({ status: 'success', output: { coverage: 'all-frames-and-transcript', checks: [{ outcome: 'passed' }] } });
    expect(model.complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(model.complete).mock.calls.every(([request]) => {
      const content = request.messages[0]?.content;
      return typeof content === 'string' && Buffer.byteLength(content, 'utf8') < 200_000;
    })).toBe(true);
  });
  it('includes batch metadata in the serialized judgment budget', async () => {
    const requirements = readVideoDeliveryFacts(session.events()).items[0]!.requirements.filter(requirement => requirement.kind === 'semantic');
    const observations = frames.map(frame => ({ timestamp: frame.timestamp, description: 'red' }));
    const evidenceBytes = Buffer.byteLength(JSON.stringify({ requirements, duration: 0.2, frames: observations,
      transcript: { text: '', segments: [], hasAudio: false } }), 'utf8');
    // 证据本身恰好占满预算；加上真实请求的批次元数据后必须拆成两批。
    observations[0]!.description = 'a'.repeat(200_000 - evidenceBytes + 3);
    vision.execute.mockResolvedValueOnce({ status: 'success', output: { frames: observations } });

    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'passed' }] } });
    expect(model.complete).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(model.complete).mock.calls) {
      expect(Buffer.byteLength(request.messages[0]!.content!, 'utf8')).toBeLessThanOrEqual(200_000);
    }
  });
  it('blocks an oversized non-first frame before sending any judgment request', async () => {
    vision.execute.mockResolvedValueOnce({ status: 'success', output: { frames: [
      { timestamp: 0, description: 'red' }, { timestamp: 0.1, description: 'e'.repeat(200_000) },
    ] } });

    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: {
      coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('单批判定的上下文预算') }],
    } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('blocks a complete transcript that exceeds the judgment budget without truncating it', async () => {
    probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    const transcript = { text: 't'.repeat(200_000), segments: [{ start: 0, end: 0.2 }] };
    speech.execute.mockResolvedValueOnce({ status: 'success', output: transcript });
    const checkpoint = vi.fn();

    expect(await executeSemantic(tool(), input, { ...context, checkpoint })).toMatchObject({ status: 'success', output: {
      coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('不能截断证据') }],
    } });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ phase: 'transcript-completed', transcript }));
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('blocks requirements that exceed the judgment budget without sending partial requirements', async () => {
    session.append({ type: 'turn.started', turnId: 'large-requirement' as never, payload: {} });
    const result = await new DeclareVideoOutputsTool(() => session.events()).execute({ items: [{ sourcePaths: [join(directory, 'source.mp4')],
      target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: 'r'.repeat(200_000) }] }] }, context);
    session.append({ type: 'tool.called', turnId: 'large-requirement' as never, payload: { stepId: 's' as never, toolCallId: 'declare-large' as never, name: 'declare_video_outputs', input: {} } });
    session.append({ type: 'tool.result', turnId: 'large-requirement' as never, payload: { stepId: 's' as never, toolCallId: 'declare-large' as never, result } });
    const item = readVideoDeliveryFacts(session.events()).items[0]!;
    input = { outputItemId: item.id, candidatePath: join(item.workingDirectory, 'candidate.mp4') };
    await writeFile(input.candidatePath, 'candidate with large requirements');

    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: {
      coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('完整要求') }],
    } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each([
    ['blocked', 'failed', 'failed'],
    ['failed', 'blocked', 'failed'],
    ['passed', 'blocked', 'blocked'],
    ['blocked', 'passed', 'blocked'],
  ] as const)('aggregates %s and %s batches as %s', async (first, second, expected) => {
    vision.execute.mockResolvedValueOnce({ status: 'success', output: { frames: frames.map(frame => ({
      timestamp: frame.timestamp, description: 'e'.repeat(120_000),
    })) } });
    for (const outcome of [first, second]) vi.mocked(model.complete).mockResolvedValueOnce({ toolCalls: [{
      id: 'judgment' as never, name: 'report_semantic_checks', input: { checks: [{ requirementId, outcome, detail: outcome }] },
    }] });

    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: expected }] } });
    expect(model.complete).toHaveBeenCalledTimes(2);
  });
  it('resumes a persisted segment when the candidate and its frame files are unchanged', async () => {
    fullFrames.execute.mockResolvedValueOnce({ status: 'success', output: { complete: false, frameCount: 2, reason: '需要分段' } });
    segmentFrames.execute.mockResolvedValueOnce({ status: 'success', output: { complete: true, totalFrames: 2, startFrame: 0, endFrame: 2,
      frames: [{ path: input.candidatePath, timestamp: 0 }, { path: input.candidatePath, timestamp: 0.1 }] } });
    const execution = { ...context, checkpoint: (data: unknown) => session.append({ type: 'tool.effect.prepared', turnId: 't' as never, payload: { sourceEventIndex: 0, data } }) };
    expect((await executeSemantic(tool(), input, execution)).status).toBe('success');
    expect(segmentFrames.execute).toHaveBeenCalledOnce();
    fullFrames.execute.mockClear();
    segmentFrames.execute.mockClear();
    vision.execute.mockClear();
    vi.mocked(model.complete).mockClear();
    expect((await executeSemantic(tool(), input, execution)).status).toBe('success');
    expect(fullFrames.execute).not.toHaveBeenCalled();
    expect(segmentFrames.execute).not.toHaveBeenCalled();
    expect(vision.execute).not.toHaveBeenCalled();
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it('rejects omitted frame observations and audio without transcription capability', async () => {
    vision.execute.mockResolvedValueOnce({ status: 'success', output: { frames: [{ timestamp: 0, description: 'red' }] } });
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    const withoutSpeech = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio], vision });
    expect(await executeSemantic(withoutSpeech)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('语音识别') }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('blocks malformed external verdicts and candidate mutation during checking', async () => {
    vi.mocked(model.complete).mockResolvedValueOnce({ toolCalls: [{ id: 'bad' as never, name: 'report_semantic_checks', input: { checks: [null] } }] });
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    vision.execute.mockImplementationOnce(async () => {
      await writeFile(input.candidatePath, 'modified while observing');
      return { status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: 'red' })) } };
    });
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('改变') }] } });
  });
  it('blocks absent and failed Probe before extracting frames or invoking external services', async () => {
    fullFrames.execute.mockClear();
    const missing = new CheckVideoSemanticsTool(() => session.events(), { model });
    expect(await executeSemantic(missing)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('probe_media') }] } });
    probe.execute.mockResolvedValueOnce({ status: 'error', message: '用户拒绝了插件工具调用。' });
    expect(await executeSemantic(tool())).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('用户拒绝') }] } });
    expect(fullFrames.execute).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['read-only', 'opaque'] as const)('rejects an excluded %s nested capability without marking its result unknown', async executionBoundary => {
    const restrictedProbe = { ...probe, executionBoundary, contract: { ...probe.contract, capability: 'disabled' } };
    const check = new CheckVideoSemanticsTool(() => session.events(), {
      model, mediaTools: [restrictedProbe, fullFrames], vision,
    });

    session.append({ type: 'tool.called', turnId: 't' as never, payload: { stepId: 's' as never, toolCallId: context.toolCallId,
      name: check.name, input, boundary: 'opaque' } });
    const result = await executeSemantic(check, input, context, [restrictedProbe], ['unknown']);
    expect(result).toMatchObject({
      status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked' }] },
    });
    session.append({ type: 'tool.result', turnId: 't' as never, payload: { stepId: 's' as never, toolCallId: context.toolCallId, result } });
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    expect(restrictedProbe.execute).not.toHaveBeenCalled();
    expect(fullFrames.execute).not.toHaveBeenCalled();
  });
  it('passes the same context to the injected Probe and propagates cancellation', async () => {
    const execution = { ...context, signal: new AbortController().signal };
    await executeSemantic(tool(), input, execution);
    expect(probe.execute).toHaveBeenCalledWith({ inputPath: input.candidatePath }, expect.objectContaining({
      toolCallId: execution.toolCallId, checkpoint: execution.checkpoint, reportProgress: execution.reportProgress,
    }));
    probe.execute.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(executeSemantic(tool(), input, execution)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses the injected Vision context and preserves approval rejection and cancellation', async () => {
    const agent = createVideoAgent({ model, session, mediaTools: [probe, fullFrames, audio, speech], visionTool: vision });
    const check = agent.tools.get('check_video_semantics')!;
    const execution = { ...context, signal: new AbortController().signal };
    expect(agent.tools.get('analyze_images')).toBe(vision);
    await executeSemantic(check, input, execution);
    expect(vision.execute).toHaveBeenCalledWith({ images: frames }, expect.objectContaining({
      toolCallId: execution.toolCallId, checkpoint: execution.checkpoint, reportProgress: execution.reportProgress,
    }));
    vision.execute.mockResolvedValueOnce({ status: 'error', message: '用户拒绝了插件工具调用。' });
    vi.mocked(model.complete).mockClear();
    expect(await executeSemantic(check, input, execution)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('用户拒绝') }] } });
    expect(model.complete).not.toHaveBeenCalled();
    vision.execute.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(executeSemantic(check, input, execution)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses injected duration to reject a mismatched speech timeline', async () => {
    probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    speech.execute.mockResolvedValueOnce({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 2 }] } });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio, speech], vision });
    expect(await executeSemantic(check)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('时长不一致') }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('uses the same injected Speech instance and context for public and semantic calls', async () => {
    const agent = createVideoAgent({ model, session, mediaTools: [probe, fullFrames, audio, speech], visionTool: vision });
    const check = agent.tools.get('check_video_semantics')!;
    const execution = { ...context, signal: new AbortController().signal };
    probe.execute.mockResolvedValue({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    expect(agent.tools.get('transcribe_audio')).toBe(speech);
    await executeSemantic(check, input, execution);
    expect(speech.execute).toHaveBeenCalledWith({ audioPath: expect.stringContaining('audio.wav') }, expect.objectContaining({
      toolCallId: execution.toolCallId, checkpoint: execution.checkpoint, reportProgress: execution.reportProgress,
    }));
    speech.execute.mockResolvedValueOnce({ status: 'error', failureKind: 'denied', message: '用户拒绝语音服务调用。' });
    vi.mocked(model.complete).mockClear();
    expect(await executeSemantic(check, input, execution)).toMatchObject({ status: 'error', failureKind: 'denied', message: '用户拒绝语音服务调用。' });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['probe', 'frames', 'audio', 'vision', 'speech'] as const)('preserves an unknown nested %s result in recovery facts', async (stage) => {
    const unknown = { status: 'error', failureKind: 'unknown-outcome', message: 'MCP 响应丢失。' } as const;
    const nested = { probe, frames: fullFrames, audio, vision, speech }[stage];
    nested.execute.mockImplementationOnce(async (_input, execution) => {
      execution.checkpoint?.({ kind: 'mcp', toolName: nested.name });
      return unknown;
    });
    if (stage === 'audio' || stage === 'speech') probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames, audio, speech], vision });
    session.append({ type: 'tool.called', turnId: 't' as never, payload: { stepId: 'check-step' as never, toolCallId: 'nested' as never,
      name: check.name, input, boundary: 'opaque' } });
    const sourceEventIndex = session.events().length - 1;
    const result = await executeSemantic(check, input, { ...context, checkpoint: data => session.append({
      type: 'tool.effect.prepared', turnId: 't' as never, payload: { sourceEventIndex, data },
    }) });
    expect(result).toEqual(unknown);
    if (stage !== 'probe') expect(session.events()).toContainEqual({
      sessionId: session.id, itemId: session.events()[sourceEventIndex]!.itemId,
      sequence: sourceEventIndex + 2, timestamp: expect.any(String),
      type: 'tool.effect.prepared', turnId: 't', payload: { sourceEventIndex,
      data: { kind: 'semantic-temporary-directory', outputItemId: input.outputItemId, candidatePath: input.candidatePath,
        directoryPrefix: join(input.candidatePath, '..', '.semantic-') } } });
    session.append({ type: 'tool.result', turnId: 't' as never, payload: { stepId: 'check-step' as never, toolCallId: 'nested' as never, result } });
    expect(projectRecoveryFacts(session.events()).unknownEffects.filter(effect => effect.sourceEventIndex === sourceEventIndex)).toHaveLength(1);
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('stops a nested media request when its checkpoint cannot be persisted', async () => {
    const failure = new SessionPersistenceError(new Error('nested checkpoint disk full'));
    const sent = vi.fn();
    fullFrames.execute.mockImplementationOnce(async (_input, execution) => {
      execution.checkpoint?.({ kind: 'mcp' });
      sent();
      return { status: 'success', output: { complete: true, frames } };
    });
    await expect(executeSemantic(tool(), input, { ...context, checkpoint: data => {
      if ((data as { kind: string }).kind === 'mcp') throw failure;
    } })).rejects.toBe(failure);
    expect(sent).not.toHaveBeenCalled();
    expect(vision.execute).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('persists the outer temporary-directory checkpoint before mkdir or a media write', async () => {
    const failure = new SessionPersistenceError(new Error('disk full'));
    const mkdir = vi.mocked(mkdtemp).mockClear();
    const checkpoint = vi.fn(() => { throw failure; });
    await expect(executeSemantic(tool(), input, { ...context, checkpoint })).rejects.toBe(failure);
    expect(checkpoint).toHaveBeenCalledWith({ kind: 'semantic-temporary-directory', outputItemId: input.outputItemId,
      candidatePath: input.candidatePath, directoryPrefix: join(input.candidatePath, '..', '.semantic-') });
    expect(mkdir).not.toHaveBeenCalled();
    expect(fullFrames.execute).not.toHaveBeenCalled();
    expect(audio.execute).not.toHaveBeenCalled();
    expect(vision.execute).not.toHaveBeenCalled();
    expect(speech.execute).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['probe', 'frames', 'audio', 'vision', 'speech'] as const)('propagates nested %s persistence failure unchanged', async (stage) => {
    const failure = new SessionPersistenceError(new Error('nested disk full'));
    const nested = { probe, frames: fullFrames, audio, vision, speech }[stage];
    nested.execute.mockRejectedValueOnce(failure);
    if (stage === 'audio' || stage === 'speech') probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    await expect(executeSemantic(tool())).rejects.toBe(failure);
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('keeps the original persistence error and preserves the checkpoint directory', async () => {
    const failure = new SessionPersistenceError(new Error('checkpoint write failed'));
    const cleanup = vi.mocked(rm).mockClear();
    fullFrames.execute.mockRejectedValueOnce(failure);
    await expect(executeSemantic(tool())).rejects.toBe(failure);
    expect(cleanup).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['probe', 'frames', 'audio', 'vision', 'speech'] as const)('preserves a classified nested %s transport exception', async (stage) => {
    const nested = { probe, frames: fullFrames, audio, vision, speech }[stage];
    nested.execute.mockRejectedValueOnce(new ToolExecutionError('transport lost', 'unknown-outcome'));
    if (stage === 'audio' || stage === 'speech') probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    expect(await executeSemantic(tool())).toEqual({ status: 'error', failureKind: 'unknown-outcome', message: 'transport lost' });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['probe', 'frames', 'audio', 'vision', 'speech'] as const)('propagates nested %s cancellation instead of a blocked verdict', async (stage) => {
    const nested = { probe, frames: fullFrames, audio, vision, speech }[stage];
    const cancellation = new DOMException('cancelled', 'AbortError');
    nested.execute.mockRejectedValueOnce(cancellation);
    if (stage === 'audio' || stage === 'speech') probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    await expect(executeSemantic(tool())).rejects.toBe(cancellation);
    expect(model.complete).not.toHaveBeenCalled();
  });
  it.each(['probe_media', 'extract_full_video_frames', 'extract_audio', 'analyze_images', 'transcribe_audio'])('keeps a denied %s with opaque hooks unknown', async (name) => {
    const original = [probe, fullFrames, audio, vision, speech].find(entry => entry.name === name)!;
    const nested = { ...original, executionBoundary: 'opaque' as const };
    nested.execute.mockResolvedValueOnce({ status: 'error', failureKind: 'denied', message: 'hook executed before denial' });
    if (name === 'extract_audio' || name === 'transcribe_audio') probe.execute.mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model,
      mediaTools: [probe, fullFrames, audio, speech].map(media => media.name === name ? nested : media), vision: name === 'analyze_images' ? nested : vision });
    expect(await executeSemantic(check, input, context, [nested])).toEqual({ status: 'error', failureKind: 'unknown-outcome', message: 'hook executed before denial' });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('keeps a failed injected Vision without a declared boundary unknown', async () => {
    const { executionBoundary: _boundary, ...unclassifiedVision } = vision;
    unclassifiedVision.execute.mockResolvedValueOnce({ status: 'error', failureKind: 'denied', message: 'undeclared tool rejected' });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model, mediaTools: [probe, fullFrames], vision: unclassifiedVision });
    expect(await executeSemantic(check, input, context, [unclassifiedVision])).toEqual({ status: 'error', failureKind: 'unknown-outcome', message: 'undeclared tool rejected' });
    expect(model.complete).not.toHaveBeenCalled();
  });
});

describe('semantic checkpoint directory ownership', () => {
  function execution(beforeCheckpoint?: (data: Record<string, unknown>) => void): ToolExecutionContext {
    session.append({ type: 'tool.called', turnId: 't' as never, payload: { stepId: 'cleanup' as never,
      toolCallId: context.toolCallId, name: 'check_video_semantics', input, boundary: 'checkpointed' } });
    const sourceEventIndex = session.events().length - 1;
    return { ...context, checkpoint: data => {
      beforeCheckpoint?.(data as Record<string, unknown>);
      session.append({ type: 'tool.effect.prepared', turnId: 't' as never, payload: { sourceEventIndex, data } });
    } };
  }

  function recordedTemporary(): { directory: string; ownershipToken: string } {
    const event = session.events().find(event => event.type === 'tool.effect.prepared'
      && (event.payload.data as { phase?: string }).phase === 'temporary-created');
    return (event!.payload as { data: { temporary: { directory: string; ownershipToken: string } } }).data.temporary;
  }

  function writeRealFrames(): void {
    fullFrames.execute.mockImplementation(async value => {
      const { outputDir } = value as { outputDir: string };
      await mkdir(outputDir);
      const extracted = frames.map((frame, index) => ({ ...frame, path: join(outputDir, `frame-${index}.jpg`) }));
      await Promise.all(extracted.map(frame => writeFile(frame.path, 'frame')));
      return { status: 'success', output: { complete: true, frames: extracted } };
    });
  }

  it('preserves evidence on cancellation and removes recovered directories only after judgment persists', async () => {
    writeRealFrames();
    probe.execute.mockResolvedValue({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    speech.execute.mockResolvedValue({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 0.2, text: 'spoken' }] } });
    vi.mocked(model.complete).mockRejectedValueOnce(new DOMException('cancelled after observations', 'AbortError'));
    await expect(executeSemantic(tool(), input, execution())).rejects.toMatchObject({ name: 'AbortError' });
    const old = recordedTemporary();
    await expect(access(join(old.directory, 'frames', 'frame-0.jpg'))).resolves.toBeUndefined();

    // 新 Session 与工具模拟重启后的检查点读取；不会复用原工具实例的内存。
    session = new InMemorySession(JSON.parse(JSON.stringify(session.events())));
    fullFrames.execute.mockClear();
    vision.execute.mockClear();
    speech.execute.mockClear();
    let persistedJudgment = false;
    const checkpointed = execution(data => {
      if (data.phase === 'judgment-completed') {
        // checkpoint 尚未提交时，旧文件仍是唯一的可恢复媒体，不能提早回收。
        expect(vi.mocked(rm).mock.calls.some(([path]) => path === old.directory)).toBe(false);
        persistedJudgment = true;
      }
    });
    expect(await executeSemantic(tool(), input, checkpointed)).toMatchObject({ status: 'success', output: { coverage: 'all-frames-and-transcript' } });
    expect(persistedJudgment).toBe(true);
    expect(fullFrames.execute).not.toHaveBeenCalled();
    expect(vision.execute).not.toHaveBeenCalled();
    expect(speech.execute).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(model.complete).mock.calls.at(-1)![0].messages[0]!.content!)).toMatchObject({
      transcript: { text: 'spoken', segments: [{ start: 0, end: 0.2, text: 'spoken' }] },
    });
    await expect(access(old.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.events().some(event => event.type === 'effect.outcome.verified')).toBe(false);
  });

  it('retains registered frames when the final judgment checkpoint fails', async () => {
    writeRealFrames();
    const failure = new SessionPersistenceError(new Error('final judgment disk full'));
    await expect(executeSemantic(tool(), input, execution(data => {
      if (data.phase === 'judgment-completed') throw failure;
    }))).rejects.toBe(failure);
    const owned = recordedTemporary();
    await expect(access(join(owned.directory, 'frames', 'frame-0.jpg'))).resolves.toBeUndefined();
    expect(session.events().some(event => event.type === 'tool.effect.prepared'
      && (event.payload.data as { phase?: string }).phase === 'judgment-completed')).toBe(false);
  });

  it('keeps a registered directory whose ownership marker was removed', async () => {
    writeRealFrames();
    vi.mocked(model.complete).mockRejectedValueOnce(new DOMException('cancelled after observations', 'AbortError'));
    await expect(executeSemantic(tool(), input, execution())).rejects.toMatchObject({ name: 'AbortError' });
    const owned = recordedTemporary();
    await rm(join(owned.directory, '.semantic-owner.json'));
    expect(await executeSemantic(tool(), input, execution())).toMatchObject({ status: 'success' });
    await expect(access(join(owned.directory, 'frames', 'frame-0.jpg'))).resolves.toBeUndefined();
  });

  it('does not delete a recovered directory replaced by a junction to user files', async () => {
    writeRealFrames();
    vi.mocked(model.complete).mockRejectedValueOnce(new DOMException('cancelled after observations', 'AbortError'));
    await expect(executeSemantic(tool(), input, execution())).rejects.toMatchObject({ name: 'AbortError' });
    const owned = recordedTemporary();
    const marker = await readFile(join(owned.directory, '.semantic-owner.json'));
    await rm(owned.directory, { recursive: true });
    const userDirectory = join(directory, 'user-owned');
    await mkdir(userDirectory);
    await writeFile(join(userDirectory, '.semantic-owner.json'), marker);
    await writeFile(join(userDirectory, 'keep.txt'), 'user data');
    await symlink(userDirectory, owned.directory, 'junction');
    expect(await executeSemantic(tool(), input, execution())).toMatchObject({ status: 'success' });
    expect(await readFile(join(userDirectory, 'keep.txt'), 'utf8')).toBe('user data');
    expect(vi.mocked(rm).mock.calls.filter(([path]) => path === owned.directory)).toHaveLength(1);
  });
});
