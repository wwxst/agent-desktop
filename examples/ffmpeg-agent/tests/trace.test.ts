import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '../src/trace.js';

type TurnStartedEvent = Extract<ExecutionTraceEvent, { type: 'turn.started' }>;

describe('createJsonlTrace', () => {
  it('writes ordered events as JSONL with one stable traceId and timestamps', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-trace-'));
    const tracePath = join(workspace, 'agent-trace.jsonl');
    const turnId = 'turn-1' as TurnStartedEvent['turnId'];

    try {
      const trace = createJsonlTrace(tracePath);
      expect(trace.id).toMatch(/^[0-9a-f-]{36}$/);

      await trace.write({ type: 'turn.started', turnId });
      await trace.write({ type: 'turn.completed', turnId, durationMs: 42, stepCount: 2 });

      const lines = (await readFile(tracePath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);

      const started = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
      const completed = JSON.parse(lines[1] ?? '') as Record<string, unknown>;
      expect(started).toEqual({
        traceId: trace.id,
        timestamp: expect.any(String),
        type: 'turn.started',
        turnId,
      });
      expect(completed).toEqual({
        traceId: trace.id,
        timestamp: expect.any(String),
        type: 'turn.completed',
        turnId,
        durationMs: 42,
        stepCount: 2,
      });
      expect(Number.isNaN(Date.parse(started.timestamp as string))).toBe(false);
      expect(Number.isNaN(Date.parse(completed.timestamp as string))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
