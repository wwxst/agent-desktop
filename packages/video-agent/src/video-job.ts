import type { SessionEvent } from '@agent-desktop/session';

/** 语义验收写入 Session 的可恢复长视频检查点。 */
export interface VideoJobFrame {
  readonly path: string;
  readonly timestamp: number;
}

export interface VideoJobObservation {
  readonly timestamp: number;
  readonly description: string;
}

export interface VideoJobTranscript {
  readonly text: string;
  readonly segments: readonly { readonly start: number; readonly end: number }[];
}

export interface VideoJobSegment {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly totalFrames: number;
  readonly frames: readonly VideoJobFrame[];
}

export type VideoJobCheckpoint = {
  readonly kind: 'video-job';
  readonly version: 1;
  readonly jobId: string;
  readonly outputItemId: string;
  readonly candidatePath: string;
  readonly candidateSha256: string;
} & (
  | { readonly phase: 'started' }
  | { readonly phase: 'segment-completed'; readonly segment: VideoJobSegment }
  | { readonly phase: 'observations-completed'; readonly startFrame: number; readonly observations: readonly VideoJobObservation[] }
  | { readonly phase: 'audio-completed'; readonly audioPath: string }
  | { readonly phase: 'transcript-completed'; readonly transcript: VideoJobTranscript }
);

/** 当前候选的恢复视图；它只描述已经写入 Session 的事实，不代表结果已交付。 */
export interface VideoJobState {
  readonly jobId: string;
  readonly outputItemId: string;
  readonly candidatePath: string;
  readonly candidateSha256: string;
  readonly segments: readonly VideoJobSegment[];
  readonly observations: readonly { readonly startFrame: number; readonly observations: readonly VideoJobObservation[] }[];
  readonly audioPath?: string;
  readonly transcript?: VideoJobTranscript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFrame(value: unknown): VideoJobFrame | undefined {
  if (!isRecord(value) || typeof value.path !== 'string'
    || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return undefined;
  return { path: value.path, timestamp: value.timestamp };
}

function readSegment(value: unknown): VideoJobSegment | undefined {
  if (!isRecord(value) || typeof value.startFrame !== 'number' || typeof value.endFrame !== 'number' || typeof value.totalFrames !== 'number'
    || !Number.isSafeInteger(value.startFrame) || value.startFrame < 0
    || !Number.isSafeInteger(value.endFrame) || value.endFrame <= value.startFrame
    || !Number.isSafeInteger(value.totalFrames) || value.totalFrames < value.endFrame
    || !Array.isArray(value.frames) || value.frames.length !== value.endFrame - value.startFrame) return undefined;
  const frames = value.frames.map(readFrame);
  if (frames.some((frame): frame is undefined => frame === undefined)) return undefined;
  return { startFrame: value.startFrame, endFrame: value.endFrame, totalFrames: value.totalFrames,
    frames: frames as VideoJobFrame[] };
}

function readObservations(value: unknown): VideoJobObservation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const observations = value.map(item => {
    if (!isRecord(item) || typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp)
      || typeof item.description !== 'string' || !item.description.trim()) return undefined;
    return { timestamp: item.timestamp, description: item.description };
  });
  return observations.some((item): item is undefined => item === undefined) ? undefined : observations as VideoJobObservation[];
}

function readTranscript(value: unknown): VideoJobTranscript | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.segments)) return undefined;
  const segments = value.segments.map(item => {
    if (!isRecord(item) || typeof item.start !== 'number' || !Number.isFinite(item.start)
      || typeof item.end !== 'number' || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) return undefined;
    return { start: item.start, end: item.end };
  });
  return segments.some((item): item is undefined => item === undefined) ? undefined : { text: value.text, segments: segments as { start: number; end: number }[] };
}

function readCheckpoint(value: unknown): VideoJobCheckpoint | undefined {
  if (!isRecord(value) || value.kind !== 'video-job' || value.version !== 1
    || typeof value.jobId !== 'string' || typeof value.outputItemId !== 'string'
    || typeof value.candidatePath !== 'string' || typeof value.candidateSha256 !== 'string') return undefined;
  if (value.phase === 'started') return { kind: 'video-job', version: 1, jobId: value.jobId,
    outputItemId: value.outputItemId, candidatePath: value.candidatePath, candidateSha256: value.candidateSha256,
    phase: 'started' };
  if (value.phase === 'segment-completed') {
    const segment = readSegment(value.segment);
    return segment === undefined ? undefined : { kind: 'video-job', version: 1, jobId: value.jobId,
      outputItemId: value.outputItemId, candidatePath: value.candidatePath, candidateSha256: value.candidateSha256,
      phase: 'segment-completed', segment };
  }
  if (value.phase === 'observations-completed' && typeof value.startFrame === 'number'
    && Number.isSafeInteger(value.startFrame) && value.startFrame >= 0) {
    const observations = readObservations(value.observations);
    return observations === undefined ? undefined : { kind: 'video-job', version: 1, jobId: value.jobId,
      outputItemId: value.outputItemId, candidatePath: value.candidatePath, candidateSha256: value.candidateSha256,
      phase: 'observations-completed', startFrame: value.startFrame, observations };
  }
  if (value.phase === 'audio-completed' && typeof value.audioPath === 'string') {
    return { kind: 'video-job', version: 1, jobId: value.jobId, outputItemId: value.outputItemId,
      candidatePath: value.candidatePath, candidateSha256: value.candidateSha256,
      phase: 'audio-completed', audioPath: value.audioPath };
  }
  if (value.phase === 'transcript-completed') {
    const transcript = readTranscript(value.transcript);
    return transcript === undefined ? undefined : { kind: 'video-job', version: 1, jobId: value.jobId,
      outputItemId: value.outputItemId, candidatePath: value.candidatePath, candidateSha256: value.candidateSha256,
      phase: 'transcript-completed', transcript };
  }
  return undefined;
}

/**
 * 从通用 `tool.effect.prepared` 事件投影视频检查点。
 * 业务字段留在 video-agent，Session 不依赖视频协议；来源索引仍由 Session 解析器负责校验。
 */
export function projectVideoJob(events: readonly SessionEvent[], jobId: string): VideoJobState | undefined {
  let state: VideoJobState | undefined;
  const segments = new Map<number, VideoJobSegment>();
  const observations = new Map<number, readonly VideoJobObservation[]>();
  for (const event of events) {
    if (event.type !== 'tool.effect.prepared') continue;
    const checkpoint = readCheckpoint(event.data);
    if (checkpoint === undefined || checkpoint.jobId !== jobId) continue;
    if (state === undefined) state = { jobId, outputItemId: checkpoint.outputItemId,
      candidatePath: checkpoint.candidatePath, candidateSha256: checkpoint.candidateSha256, segments: [], observations: [] };
    if (state.outputItemId !== checkpoint.outputItemId || state.candidatePath !== checkpoint.candidatePath
      || state.candidateSha256 !== checkpoint.candidateSha256) continue;
    if (checkpoint.phase === 'segment-completed') segments.set(checkpoint.segment.startFrame, checkpoint.segment);
    if (checkpoint.phase === 'observations-completed') observations.set(checkpoint.startFrame, checkpoint.observations);
    if (checkpoint.phase === 'audio-completed') state = { ...state, audioPath: checkpoint.audioPath };
    if (checkpoint.phase === 'transcript-completed') state = { ...state, transcript: checkpoint.transcript };
  }
  if (state === undefined) return undefined;
  return { ...state, segments: [...segments.values()].sort((a, b) => a.startFrame - b.startFrame),
    observations: [...observations.entries()].sort((a, b) => a[0] - b[0]).map(([startFrame, value]) => ({ startFrame, observations: value })) };
}

/** 同一候选内容的稳定身份；路径相同但文件字节变化会生成新的任务。 */
export function videoJobId(outputItemId: string, candidatePath: string, candidateSha256: string): string {
  return `${outputItemId}:${candidatePath}:${candidateSha256}`;
}
