import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts, SessionPersistenceError } from '@agent-desktop/session';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { createVideoAgent, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { DecodeVideoTool, ProbeMediaTool, TrimVideoTool, type CommandExecutor } from '@agent-desktop/video-ffmpeg';
import { taskToolGate } from '../src/main/agent-task-state.js';

describe('video validation through the Desktop recovery gate', () => {
  it('allows a blocked publish to be retried after real checks validate the same candidate', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'video-validation-gate-')));
    try {
      const source = join(directory, 'source.mp4');
      const target = join(directory, 'delivered.mp4');
      await writeFile(source, 'candidate fixture bytes');

      const persistenceFailure = new SessionPersistenceError(new Error('checkpoint save failed'));
      const declarationTool = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) } }).tools.get('declare_video_outputs')!;
      let uncreatedWorkingDirectory = '';
      const failingContext: ToolExecutionContext = { toolCallId: 'persistence-failure' as ToolCallId,
        reportProgress: () => {}, checkpoint: () => { throw persistenceFailure; } };
      const failingDeclarationContext: ToolExecutionContext = { ...failingContext, checkpoint: data => {
          uncreatedWorkingDirectory = (data as { paths: string[] }).paths[0]!;
          throw persistenceFailure;
        } };
      await expect(declarationTool.execute({ items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] }, failingDeclarationContext))
        .rejects.toBe(persistenceFailure);
      await expect(stat(uncreatedWorkingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

      const session = new InMemorySession();
      // 外部进程响应固定，正式媒体 Tool 仍产生交付验收读取的 Session 事实。
      const execute: CommandExecutor = async (command, args) => {
        if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '5' }, streams: [
          { codec_type: 'video', codec_name: 'h264', width: 128, height: 96 },
        ] }), stderr: '' };
        if (args.includes('libx264')) await copyFile(args[args.indexOf('-i') + 1]!, args[args.length - 1]!);
        return { stdout: '', stderr: '' };
      };
      const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session, approveVideoPublish: async () => true,
        mediaTools: [new TrimVideoTool(execute), new DecodeVideoTool(execute), new ProbeMediaTool(execute)] });
      let request = 0;
      let outputItemId = '';
      let candidatePath = '';
      let prePublishEvents: ReturnType<InMemorySession['events']> = [];
      let prePublishValidationId = '';
      const model: Model = { complete: async () => {
        request += 1;
        const item = readVideoDeliveryFacts(session.events()).items[0];
        if (item !== undefined) {
          outputItemId = item.id;
          candidatePath = join(item.workingDirectory, 'candidate.mp4');
        }
        const call = (name: string, input: unknown, suffix = '') => ({ id: `${request}${suffix}` as ToolCallId, name, input });
        if (request === 1) return { toolCalls: [call('declare_video_outputs', { items: [{ sourcePaths: [source],
          target: { kind: 'explicit', path: target }, requirements: [{ kind: 'duration-range', minSeconds: 4, maxSeconds: 6 }] }] })] };
        if (request === 2) return { toolCalls: [call('trim_video', { inputPath: source, outputPath: candidatePath, start: 0, duration: 5 })] };
        if (request === 3) return { toolCalls: [call('validate_video_candidate', { outputItemId, candidatePath })] };
        if (request === 4) return { toolCalls: [call('publish_video_output', { validationId: readVideoDeliveryFacts(session.events()).validations.at(-1)!.id })] };
        if (request === 5) return { toolCalls: [call('decode_video', { inputPath: candidatePath }, 'decode'),
          call('probe_media', { inputPath: candidatePath }, 'probe')] };
        if (request === 6) return { toolCalls: [call('validate_video_candidate', { outputItemId, candidatePath })] };
        if (request === 7) {
          prePublishEvents = [...session.events()];
          prePublishValidationId = readVideoDeliveryFacts(prePublishEvents).validations.at(-1)!.id;
          return { toolCalls: [call('publish_video_output', { validationId: prePublishValidationId })] };
        }
        return { text: '候选补齐证据并交付。', toolCalls: [] };
      } };

      await runTurn({ ...agent, model }, '先验收并尝试发布，再补检查证据并重新验收。', {
        beforeToolCall: input => taskToolGate(session.events(), input),
      });

      const facts = readVideoDeliveryFacts(session.events());
      expect(facts.validations).toHaveLength(2);
      expect(facts.validations[0]!.checks.map(check => check.outcome)).toEqual(['blocked', 'blocked']);
      expect(facts.validations[1]!.checks.map(check => check.outcome)).toEqual(['passed', 'passed']);
      expect(facts.candidates[0]!.id).toBe(facts.candidates[1]!.id);
      expect(facts.published).toHaveLength(1);
      expect(facts.published[0]!.path).toBe(target);
      expect(await readFile(target, 'utf8')).toBe('candidate fixture bytes');
      expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);

      // 发布检查点保存失败必须向 Loop 传播，不能被应用 Tool 转成普通失败或创建目标。
      const beforePublish = new InMemorySession(prePublishEvents);
      const publishTool = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session: beforePublish, approveVideoPublish: async () => true }).tools.get('publish_video_output')!;
      await rm(target);
      await expect(publishTool.execute({ validationId: prePublishValidationId }, failingContext)).rejects.toBe(persistenceFailure);
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

      const calls = session.events().filter(event => event.type === 'tool.called');
      expect(calls.find(event => event.type === 'tool.called' && event.name === 'validate_video_candidate'))
        .toMatchObject({ boundary: 'read-only' });
      expect(calls.filter(event => event.type === 'tool.called' && event.name === 'declare_video_outputs'))
        .toMatchObject([{ boundary: 'checkpointed' }]);
      expect(session.events().filter(event => event.type === 'tool.effect.prepared').map(event => event.type === 'tool.effect.prepared'
        ? (event.data as { readonly kind?: unknown }).kind : undefined)).toEqual(['video-output-directory', 'video-publish']);
      const publishResults = session.events().filter(event => event.type === 'tool.result'
        && calls.some(callEvent => callEvent.type === 'tool.called' && callEvent.toolCallId === event.toolCallId
          && callEvent.name === 'publish_video_output'));
      expect(publishResults.map(event => event.type === 'tool.result' ? event.result.status : undefined)).toEqual(['error', 'success']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
