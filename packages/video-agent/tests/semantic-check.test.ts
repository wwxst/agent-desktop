import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';
import { ProbeMediaTool, extractFullVideoFrames } from '@agent-desktop/video-ffmpeg';
import { DeclareVideoOutputsTool } from '../src/delivery-tools.js';
import { readVideoDeliveryFacts } from '../src/delivery.js';
import { CheckVideoSemanticsTool } from '../src/semantic-check.js';

vi.mock('@agent-desktop/video-ffmpeg', async (original) => ({ ...await original<typeof import('@agent-desktop/video-ffmpeg')>(), extractFullVideoFrames: vi.fn() }));
const context = { toolCallId: 'check' as never, reportProgress: () => {} };
let directory: string;
let session: InMemorySession;
let input: { outputItemId: string; candidatePath: string };
let requirementId: string;
let model: Model;
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
  vi.mocked(extractFullVideoFrames).mockResolvedValue({ complete: true, frames });
  vi.spyOn(ProbeMediaTool.prototype, 'execute').mockResolvedValue({ status: 'success', output: { audioCodec: null, duration: 0.2 } });
  vi.spyOn(AnalyzeImagesTool.prototype, 'execute').mockResolvedValue({ status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: '红色矩形' })) } });
  model = { complete: vi.fn(async () => ({ toolCalls: [{ id: 'judgment' as never, name: 'report_semantic_checks',
    input: { checks: [{ requirementId, outcome: 'passed', detail: '0 至 0.2 秒为红色矩形' }] } }] })) };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const tool = (vision = true) => new CheckVideoSemanticsTool(() => session.events(), { model, ...(vision ? { vision: new AnalyzeImagesTool({ apiKey: 'fixture' }) } : {}) });

describe('semantic evidence completeness', () => {
  it('preserves all observations and binds the independent verdict to candidate bytes', async () => {
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { outputItemId: input.outputItemId,
      coverage: 'all-frames-and-transcript', frameCount: 2, candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidence: { frames: [{ timestamp: 0 }, { timestamp: 0.1 }], transcript: { hasAudio: false } }, checks: [{ outcome: 'passed' }] } });
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it('blocks missing Vision and an exceeded frame budget without calling the judge', async () => {
    expect(await tool(false).execute(input, context)).toMatchObject({ status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked' }] } });
    vi.mocked(extractFullVideoFrames).mockResolvedValue({ complete: false, reason: '超过 600 帧预算' });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: '超过 600 帧预算' }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('rejects omitted frame observations and audio without transcription capability', async () => {
    vi.mocked(AnalyzeImagesTool.prototype.execute).mockResolvedValueOnce({ status: 'success', output: { frames: [{ timestamp: 0, description: 'red' }] } });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    vi.mocked(ProbeMediaTool.prototype.execute).mockResolvedValueOnce({ status: 'success', output: { audioCodec: 'aac', duration: 0.2 } });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('语音识别') }] } });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('blocks malformed external verdicts and candidate mutation during checking', async () => {
    vi.mocked(model.complete).mockResolvedValueOnce({ toolCalls: [{ id: 'bad' as never, name: 'report_semantic_checks', input: { checks: [null] } }] });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked' }] } });
    vi.mocked(AnalyzeImagesTool.prototype.execute).mockImplementationOnce(async () => {
      await writeFile(input.candidatePath, 'modified while observing');
      return { status: 'success', output: { frames: frames.map((frame) => ({ timestamp: frame.timestamp, description: 'red' })) } };
    });
    expect(await tool().execute(input, context)).toMatchObject({ status: 'success', output: { checks: [{ outcome: 'blocked', detail: expect.stringContaining('改变') }] } });
  });
});
