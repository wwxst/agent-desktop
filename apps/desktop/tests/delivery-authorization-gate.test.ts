import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts, type SessionEvent } from '@agent-desktop/session';
import type { Tool } from '@agent-desktop/tools';
import {
  DeclareVideoOutputsTool,
  PublishVideoOutputTool,
  ValidateVideoCandidateTool,
} from '../../../packages/video-agent/src/delivery-tools.js';
import { authorizeVideoDeliveryTool, type ProbeFileAccess } from '../src/main/ffmpeg-tool.js';
import { taskToolGate } from '../src/main/agent-task-state.js';

const roots: string[] = [];
const turnId = 'delivery-auth-turn' as never;
const stepId = 'delivery-auth-step' as never;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(session: InMemorySession, tool: Tool, input: unknown, id: string): Promise<ToolResult> {
  session.append({
    type: 'tool.called', turnId, stepId, toolCallId: id as never, name: tool.name, input,
    ...(tool.executionBoundary === undefined ? {} : { boundary: tool.executionBoundary }),
  });
  const result = await tool.execute(input, { toolCallId: id as never, reportProgress: () => {}, checkpoint: () => {} });
  session.append({ type: 'tool.result', turnId, stepId, toolCallId: id as never, result });
  return result;
}

function gateInput(session: InMemorySession, tool: Tool, name: string, input: unknown, id: string) {
  return taskToolGate(session.events(), {
    turnId, stepId, call: { name, id: id as never, input }, tool,
    sourceEventIndex: session.events().length,
  });
}

function access(directory: () => string, session: InMemorySession, attachments: () => readonly string[] = () => []): ProbeFileAccess {
  return { workspace: { confirmedDirectory: directory }, attachments, events: () => session.events() };
}

describe('video delivery authorization recovery gate', () => {
  it('classifies an unauthorized declaration as permanent and permits the same call after authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-auth-declare-')); roots.push(root);
    const workspace = join(root, 'workspace'); const outside = join(root, 'outside');
    await mkdir(workspace); await mkdir(outside);
    const source = join(outside, 'source.mp4'); await writeFile(source, 'source');
    const session = new InMemorySession(); let confirmed = workspace;
    const declaration = authorizeVideoDeliveryTool(new DeclareVideoOutputsTool(() => session.events()), access(() => confirmed, session));
    const input = { items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] };

    const denied = await invoke(session, declaration, input, 'declare-denied');
    expect(denied).toMatchObject({ status: 'error', failureKind: 'permanent' });
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);

    confirmed = root;
    expect(gateInput(session, declaration, declaration.name, input, 'declare-retry').blocked).toBeUndefined();
    const allowed = await invoke(session, declaration, input, 'declare-retry');
    expect(allowed.status).toBe('success');
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
  });

  it('classifies an unauthorized publish target as permanent and publishes after target authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-auth-publish-')); roots.push(root);
    const workspace = join(root, 'workspace'); const targetDirectory = join(root, 'target');
    await mkdir(workspace); await mkdir(targetDirectory);
    const source = join(workspace, 'source.mp4'); await writeFile(source, 'source');
    const target = join(targetDirectory, 'published.mp4');
    const session = new InMemorySession(); let confirmed = workspace;
    const readEvents = () => session.events();
    const declaration = new DeclareVideoOutputsTool(readEvents);
    const declarationInput = { items: [{ sourcePaths: [source], target: { kind: 'explicit', path: target } }] };
    const declared = await invoke(session, declaration, declarationInput, 'declare');
    expect(declared.status).toBe('success');
    const item = (declared.output as { items: { id: string; workingDirectory: string }[] }).items[0]!;
    const candidate = join(item.workingDirectory, 'candidate.mp4'); await writeFile(candidate, 'candidate');
    session.append({ type: 'tool.called', turnId, stepId, toolCallId: 'produce' as never, name: 'trim_video',
      input: { inputPath: source, outputPath: candidate, start: 0, duration: 1 }, boundary: 'checkpointed' });
    session.append({ type: 'tool.result', turnId, stepId, toolCallId: 'produce' as never,
      result: { status: 'success', output: { outputPath: candidate } } });
    session.append({ type: 'tool.called', turnId, stepId, toolCallId: 'decode' as never, name: 'decode_video',
      input: { inputPath: candidate }, boundary: 'read-only' });
    session.append({ type: 'tool.result', turnId, stepId, toolCallId: 'decode' as never,
      result: { status: 'success', output: { inputPath: candidate, hasVideoStream: true, fullyDecoded: true, videoCodec: 'h264', durationSeconds: 1 } } });
    const validationTool = new ValidateVideoCandidateTool(readEvents);
    const validationInput = { outputItemId: item.id, candidatePath: candidate };
    const validation = await invoke(session, validationTool, validationInput, 'validate');
    expect(validation.status).toBe('success');
    const validationId = ((validation.output as { validation: { id: string } }).validation).id;
    const publish = authorizeVideoDeliveryTool(new PublishVideoOutputTool(readEvents), access(() => confirmed, session));
    const publishInput = { validationId };

    const denied = await invoke(session, publish, publishInput, 'publish-denied');
    expect(denied).toMatchObject({ status: 'error', failureKind: 'permanent' });
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);

    confirmed = root;
    expect(gateInput(session, publish, publish.name, publishInput, 'publish-retry').blocked).toBeUndefined();
    const allowed = await invoke(session, publish, publishInput, 'publish-retry');
    expect(allowed.status).toBe('success');
    expect(await readFile(target, 'utf8')).toBe('candidate');
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
  });
});
