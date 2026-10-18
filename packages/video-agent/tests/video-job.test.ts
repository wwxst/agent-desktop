import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agent-desktop/session';
import { projectVideoJob, videoJobId } from '../src/video-job.js';

describe('persistent video job projection', () => {
  it('projects completed contiguous segments for the exact candidate digest', () => {
    const jobId = videoJobId('item', 'C:/work/candidate.mp4', 'sha-a');
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: 'turn' as never },
      { type: 'tool.effect.prepared', turnId: 'turn' as never, sourceEventIndex: 1,
        data: { kind: 'video-job', version: 1, jobId, outputItemId: 'item', candidatePath: 'C:/work/candidate.mp4', candidateSha256: 'sha-a', phase: 'started' } },
      { type: 'tool.effect.prepared', turnId: 'turn' as never, sourceEventIndex: 1,
        data: { kind: 'video-job', version: 1, jobId, outputItemId: 'item', candidatePath: 'C:/work/candidate.mp4', candidateSha256: 'sha-a', phase: 'segment-completed',
          segment: { startFrame: 0, endFrame: 2, totalFrames: 4, frames: [{ path: 'frame-0.jpg', timestamp: 0 }, { path: 'frame-1.jpg', timestamp: 0.1 }] } } },
    ];
    expect(projectVideoJob(events, jobId)).toMatchObject({ jobId, candidateSha256: 'sha-a', segments: [{ startFrame: 0, endFrame: 2 }] });
    expect(projectVideoJob(events, videoJobId('item', 'C:/work/candidate.mp4', 'sha-b'))).toBeUndefined();
  });

  it('ignores malformed segment checkpoints instead of inventing recovery facts', () => {
    const jobId = videoJobId('item', 'candidate.mp4', 'sha');
    const events: SessionEvent[] = [{ type: 'tool.effect.prepared', turnId: 'turn' as never, sourceEventIndex: 0,
      data: { kind: 'video-job', version: 1, jobId, outputItemId: 'item', candidatePath: 'candidate.mp4', candidateSha256: 'sha', phase: 'segment-completed',
        segment: { startFrame: 2, endFrame: 1, totalFrames: 3, frames: [] } } }];
    expect(projectVideoJob(events, jobId)).toBeUndefined();
  });

  it('projects visual batches and a validated transcript for resume', () => {
    const jobId = videoJobId('item', 'candidate.mp4', 'sha');
    const events: SessionEvent[] = [
      { type: 'tool.effect.prepared', turnId: 'turn' as never, sourceEventIndex: 0,
        data: { kind: 'video-job', version: 1, jobId, outputItemId: 'item', candidatePath: 'candidate.mp4', candidateSha256: 'sha',
          phase: 'observations-completed', startFrame: 0, observations: [{ timestamp: 0, description: 'red' }] } },
      { type: 'tool.effect.prepared', turnId: 'turn' as never, sourceEventIndex: 0,
        data: { kind: 'video-job', version: 1, jobId, outputItemId: 'item', candidatePath: 'candidate.mp4', candidateSha256: 'sha',
          phase: 'transcript-completed', transcript: { text: 'spoken', segments: [{ start: 0, end: 1 }] } } },
    ];
    expect(projectVideoJob(events, jobId)).toMatchObject({ observations: [{ startFrame: 0, observations: [{ timestamp: 0, description: 'red' }] }],
      transcript: { text: 'spoken', segments: [{ start: 0, end: 1 }] } });
  });
});
