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
});
