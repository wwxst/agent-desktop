import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySession, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { VerifyToolOutcomeTool } from '../src/main/verify-tool.js';

const turnId = 'verify-turn' as TurnId;
const stepId = 'verify-step' as StepId;
const context: ToolExecutionContext = { toolCallId: 'verify-call' as never, reportProgress: () => {} };
const workspaceFor = (directory: string): WorkspacePort => ({
  confirmedDirectory: () => directory,
  confirmDirectory: () => {},
  requestApproval: async () => true,
});

const prepare = (path: string, beforeSha256: string | null, expectedAfterSha256: string, expectedBytes: number, boundary: 'checkpointed' | 'opaque' = 'checkpointed') => [...new InMemorySession([], 'session').appendMany([
  { type: 'turn.started', turnId, payload: {} },
  { type: 'user.message', turnId, payload: { content: 'verify' } },
  { type: 'step.started', turnId, payload: { stepId } },
  { type: 'tool.called', turnId, payload: { stepId, toolCallId: 'source-call' as never, name: 'write_text_file', input: {}, boundary } },
  { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { kind: 'text-file', path, beforeSha256, expectedAfterSha256, expectedBytes } } },
])] satisfies SessionEvent[];

describe('VerifyToolOutcomeTool', () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); });

  it('confirms the complete effect for a raw checkpointed file tool', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-desktop-verify-'));
    const path = join(directory, 'created.txt');
    await writeFile(path, 'after', 'utf8');
    const expected = createHash('sha256').update('after', 'utf8').digest('hex');
    const session = new InMemorySession(prepare(path, null, expected, 5));
    const result = await new VerifyToolOutcomeTool(session, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);
    expect(result).toMatchObject({ status: 'success', output: { scope: 'entire-call', outcome: 'completed' } });
  });

  it('distinguishes the unchanged version, missing create target, and partial changes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-desktop-verify-'));
    const unchangedPath = join(directory, 'unchanged.txt');
    await writeFile(unchangedPath, 'before', 'utf8');
    const before = createHash('sha256').update('before', 'utf8').digest('hex');
    const session = new InMemorySession(prepare(unchangedPath, before, 'unused', 0));
    const tool = new VerifyToolOutcomeTool(session, workspaceFor(directory));
    const unchanged = await tool.execute({ sourceEventIndex: 3 }, context);
    expect(unchanged).toMatchObject({ status: 'success', output: { outcome: 'not-applied' } });

    const partialPath = join(directory, 'partial.txt');
    await writeFile(partialPath, 'partial', 'utf8');
    const partialSession = new InMemorySession(prepare(partialPath, before, createHash('sha256').update('after', 'utf8').digest('hex'), 5));
    const partial = await new VerifyToolOutcomeTool(partialSession, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);
    expect(partial).toMatchObject({ status: 'success', output: { outcome: 'unresolved' } });

    const missingPath = join(directory, 'missing.txt');
    const missingSession = new InMemorySession(prepare(missingPath, null, createHash('sha256').update('after', 'utf8').digest('hex'), 5));
    const missing = await new VerifyToolOutcomeTool(missingSession, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);
    expect(missing).toMatchObject({ status: 'success', output: { outcome: 'not-applied' } });
  });

  it('reports persisted VideoJob evidence without claiming the unknown call completed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-desktop-verify-'));
    const candidatePath = join(directory, 'candidate.mp4');
    const frame0 = join(directory, 'frame-0.jpg');
    const frame1 = join(directory, 'frame-1.jpg');
    await writeFile(candidatePath, 'candidate bytes', 'utf8');
    await writeFile(frame0, 'frame 0', 'utf8');
    await writeFile(frame1, 'frame 1', 'utf8');
    const candidateSha256 = createHash('sha256').update('candidate bytes', 'utf8').digest('hex');
    const session = new InMemorySession([], 'session');
    session.appendMany([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: 'inspect' } },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'tool.called', turnId, payload: { stepId, toolCallId: 'source-call' as never, name: 'check_video_semantics', input: {}, boundary: 'checkpointed' } },
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { kind: 'video-job', version: 1, jobId: 'job', outputItemId: 'item', candidatePath, candidateSha256, phase: 'started' } } },
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { kind: 'video-job', version: 1, jobId: 'job', outputItemId: 'item', candidatePath, candidateSha256, phase: 'segment-completed', segment: { startFrame: 0, endFrame: 2, totalFrames: 2, frames: [{ path: frame0, timestamp: 0 }, { path: frame1, timestamp: 0.1 }] } } } },
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { kind: 'video-job', version: 1, jobId: 'job', outputItemId: 'item', candidatePath, candidateSha256, phase: 'observations-completed', startFrame: 0, observations: [{ timestamp: 0, description: 'first' }, { timestamp: 0.1, description: 'second' }] } } },
    ]);

    const result = await new VerifyToolOutcomeTool(session, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);

    expect(result).toMatchObject({ status: 'success', output: {
      kind: 'video-job', status: 'evidence-ready-for-recheck', expectedSha256: candidateSha256, currentSha256: candidateSha256,
      segmentCount: 1, totalFrames: 2, observedFrameCount: 2, missingFrameCount: 0,
    } });
    expect(session.events().filter(event => event.type === 'effect.outcome.verified')).toHaveLength(0);
  });

  it.each([
    { name: 'overlapping batches with the expected total count', status: 'incomplete-observation-coverage', batches: [{ startFrame: 0, count: 6, timestampOffset: 0 }, { startFrame: 4, count: 4, timestampOffset: 0 }] },
    { name: 'a gap between batches with the expected total count', status: 'incomplete-observation-coverage', batches: [{ startFrame: 0, count: 4, timestampOffset: 0 }, { startFrame: 5, count: 6, timestampOffset: 0 }] },
    { name: 'a batch with mismatched frame timestamps', status: 'incomplete-observation-coverage', batches: [{ startFrame: 0, count: 6, timestampOffset: 0 }, { startFrame: 6, count: 4, timestampOffset: 1 }] },
    { name: 'complete batches spanning segment boundaries', status: 'evidence-ready-for-recheck', batches: [{ startFrame: 0, count: 6, timestampOffset: 0 }, { startFrame: 6, count: 4, timestampOffset: 0 }] },
    { name: 'a valid prefix of observed frames', status: 'partial-evidence', batches: [{ startFrame: 0, count: 6, timestampOffset: 0 }] },
  ])('classifies VideoJob evidence with $name', async ({ batches, status }) => {
    directory = await mkdtemp(join(tmpdir(), 'agent-desktop-verify-'));
    const candidatePath = join(directory, 'candidate.mp4');
    // 候选超过一个流读取块，核对分块摘要与原始字节的一致性。
    const candidateBytes = Buffer.alloc(200_000, 'candidate');
    await writeFile(candidatePath, candidateBytes);
    const candidateSha256 = createHash('sha256').update(candidateBytes).digest('hex');
    const frames = Array.from({ length: 10 }, (_, index) => ({ path: join(directory!, `frame-${index}.jpg`), timestamp: index / 10 }));
    await Promise.all(frames.map(frame => writeFile(frame.path, 'frame', 'utf8')));
    const checkpoint = { kind: 'video-job', version: 1, jobId: 'job', outputItemId: 'item', candidatePath, candidateSha256 };
    const session = new InMemorySession([], 'session');
    session.appendMany([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: 'inspect' } },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'tool.called', turnId, payload: { stepId, toolCallId: 'source-call' as never, name: 'check_video_semantics', input: {}, boundary: 'checkpointed' } },
      // 两段真实帧提供权威序号/时间戳，观察批次允许跨越分段边界。
      ...[0, 5].map(startFrame => ({ type: 'tool.effect.prepared' as const, turnId, payload: { sourceEventIndex: 3, data: {
        ...checkpoint, phase: 'segment-completed', segment: { startFrame, endFrame: startFrame + 5, totalFrames: 10, frames: frames.slice(startFrame, startFrame + 5) },
      } } })),
      ...batches.map(batch => ({ type: 'tool.effect.prepared' as const, turnId, payload: { sourceEventIndex: 3, data: {
        ...checkpoint, phase: 'observations-completed', startFrame: batch.startFrame,
        observations: Array.from({ length: batch.count }, (_, index) => ({ timestamp: (batch.startFrame + index + batch.timestampOffset) / 10, description: 'observed frame' })),
      } } })),
    ]);

    const result = await new VerifyToolOutcomeTool(session, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);

    expect(result).toMatchObject({ status: 'success', output: {
      kind: 'video-job', status, segmentCount: 2,
      totalFrames: 10, observedFrameCount: batches.reduce((count, batch) => count + batch.count, 0), missingFrameCount: 0, currentSha256: candidateSha256,
    } });
    expect(session.events().filter(event => event.type === 'effect.outcome.verified')).toHaveLength(0);
  });

  it.each([
    { name: 'complete persisted judgment after frame cleanup', frameCount: 1, hasTranscript: true, observationTimestamp: 0, changedCandidate: false, status: 'judgment-checkpointed' },
    { name: 'mismatched judgment frame count', frameCount: 2, hasTranscript: true, observationTimestamp: 0, changedCandidate: false, status: 'missing-checkpoint-files' },
    { name: 'missing transcript checkpoint', frameCount: 1, hasTranscript: false, observationTimestamp: 0, changedCandidate: false, status: 'missing-checkpoint-files' },
    { name: 'inconsistent persisted observation', frameCount: 1, hasTranscript: true, observationTimestamp: 1, changedCandidate: false, status: 'missing-checkpoint-files' },
    { name: 'changed candidate after a persisted judgment', frameCount: 1, hasTranscript: true, observationTimestamp: 0, changedCandidate: true, status: 'candidate-changed' },
  ])('reports $name without completing the unknown call', async ({ frameCount, hasTranscript, observationTimestamp, changedCandidate, status }) => {
    directory = await mkdtemp(join(tmpdir(), 'agent-desktop-verify-'));
    const candidatePath = join(directory, 'candidate.mp4');
    await writeFile(candidatePath, changedCandidate ? 'changed' : 'candidate', 'utf8');
    const candidateSha256 = createHash('sha256').update('candidate', 'utf8').digest('hex');
    const checkpoint = { kind: 'video-job', version: 1, jobId: 'job', outputItemId: 'item', candidatePath, candidateSha256 };
    const session = new InMemorySession([], 'session');
    session.appendMany([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: 'inspect' } },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'tool.called', turnId, payload: { stepId, toolCallId: 'source-call' as never, name: 'check_video_semantics', input: {}, boundary: 'checkpointed' } },
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { ...checkpoint, phase: 'segment-completed',
        segment: { startFrame: 0, endFrame: 1, totalFrames: 1, frames: [{ path: join(directory, 'removed-frame.jpg'), timestamp: 0 }] } } } },
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { ...checkpoint, phase: 'observations-completed',
        startFrame: 0, observations: [{ timestamp: observationTimestamp, description: 'observed frame' }] } } },
      ...(hasTranscript ? [{ type: 'tool.effect.prepared' as const, turnId, payload: { sourceEventIndex: 3, data: { ...checkpoint,
        phase: 'transcript-completed', transcript: { text: '', segments: [] } } } }] : []),
      { type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 3, data: { ...checkpoint, phase: 'judgment-completed',
        judgment: { frameCount, checks: [{ requirementId: 'semantic', outcome: 'passed', detail: 'checked' }] } } } },
    ]);

    const result = await new VerifyToolOutcomeTool(session, workspaceFor(directory)).execute({ sourceEventIndex: 3 }, context);

    expect(result).toMatchObject({ status: 'success', output: { kind: 'video-job', status, missingFrameCount: 1 } });
    expect(session.events().filter(event => event.type === 'effect.outcome.verified')).toHaveLength(0);
  });
});
