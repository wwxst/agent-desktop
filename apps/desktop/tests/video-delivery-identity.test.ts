import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ToolCallId } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { createVideoAgent, producedVideoItem, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { DecodeVideoTool, TrimVideoTool, type CommandExecutor } from '@agent-desktop/video-ffmpeg';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'video-delivery-identity-')));
  directories.push(directory);
  const source = join(directory, 'source.mp4');
  await writeFile(source, 'candidate fixture bytes');
  await writeFile(join(directory, 'note.txt'), 'unrelated read');
  const session = new InMemorySession();
  // 仅替换外部媒体进程，Loop、Session、注册表及交付工具保持真实。
  const execute: CommandExecutor = async (command, args) => {
    if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '5' }, streams: [
      { codec_type: 'video', codec_name: 'h264', width: 128, height: 96 },
    ] }), stderr: '' };
    if (args.includes('libx264')) await copyFile(args[args.indexOf('-i') + 1]!, args[args.length - 1]!);
    return { stdout: '', stderr: '' };
  };
  const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session, approveVideoPublish: async () => true,
    workspace: { confirmedDirectory: () => directory, requestApproval: async () => true, confirmDirectory: () => {} },
    mediaTools: [new TrimVideoTool(execute), new DecodeVideoTool(execute)] });
  return { directory, source, session, agent };
}

describe('video delivery call identity', () => {
  it('keeps declaration, checks, and publication paired when the model repeats an ID across steps and turns', async () => {
    const { directory, source, session, agent } = await fixture();
    const target = join(directory, 'delivered.mp4');
    let request = 0;
    const model: Model = { complete: async () => {
      request += 1;
      const facts = readVideoDeliveryFacts(session.events());
      const item = facts.items[0];
      const candidatePath = item === undefined ? '' : join(item.workingDirectory, 'candidate.mp4');
      const call = (name: string, input: unknown) => ({ toolCalls: [{ id: 'reused' as ToolCallId, name, input }] });
      if (request === 1) return call('declare_video_outputs', { items: [{ sourcePaths: [source], target: { kind: 'explicit', path: target } }] });
      if (request === 2) return call('trim_video', { inputPath: source, outputPath: candidatePath, start: 0, duration: 5 });
      if (request === 3) return call('decode_video', { inputPath: candidatePath });
      if (request === 4) return call('validate_video_candidate', { outputItemId: item!.id, candidatePath });
      if (request === 5) return call('publish_video_output', { validationId: facts.validations[0]!.id });
      if (request === 7) return call('read_file', { filePath: 'note.txt' });
      return { text: 'completed', toolCalls: [] };
    } };

    await runTurn({ ...agent, model }, '生成并交付候选');
    await runTurn({ ...agent, model }, '读取另一文件');

    const facts = readVideoDeliveryFacts(session.events());
    expect(facts.items).toHaveLength(1);
    expect(facts.validations[0]!.checks[0]!.outcome).toBe('passed');
    expect(facts.published).toEqual([{ outputItemId: facts.items[0]!.id, validationId: facts.validations[0]!.id, path: target }]);
    expect(await readFile(target, 'utf8')).toBe('candidate fixture bytes');
    expect(producedVideoItem(session.events(), facts.candidates[0]!.path)?.id).toBe(facts.items[0]!.id);
    expect(session.events().findLast(event => event.type === 'tool.result')).toMatchObject({ payload: { result: { status: 'success' } } });
  });

  it('uses new candidate identity and preserves source ancestry when a producer ID repeats in later turns', async () => {
    const { source, session, agent } = await fixture();
    let request = 0;
    const model: Model = { complete: async () => {
      request += 1;
      const item = readVideoDeliveryFacts(session.events()).items[0];
      const path = item === undefined ? '' : join(item.workingDirectory, 'same-path.mp4');
      const downstream = item === undefined ? '' : join(item.workingDirectory, 'downstream.mp4');
      const call = (name: string, input: unknown) => ({ toolCalls: [{ id: 'producer-reused' as ToolCallId, name, input }] });
      if (request === 1) return call('declare_video_outputs', { items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] });
      if (request === 2 || request === 6) return call('trim_video', { inputPath: source, outputPath: path, start: 0, duration: 5 });
      if (request === 3) return call('decode_video', { inputPath: path });
      if (request === 4 || request === 7) return call('validate_video_candidate', { outputItemId: item!.id, candidatePath: path });
      if (request === 9) return call('trim_video', { inputPath: path, outputPath: downstream, start: 0, duration: 5 });
      if (request === 10) return call('validate_video_candidate', { outputItemId: item!.id, candidatePath: downstream });
      return { text: 'completed', toolCalls: [] };
    } };

    await runTurn({ ...agent, model }, '生成并验收第一个候选');
    // 已有写出工具拒绝覆盖；模拟外部移除后再次真实生产同一路径。
    await rm(join(readVideoDeliveryFacts(session.events()).items[0]!.workingDirectory, 'same-path.mp4'));
    await runTurn({ ...agent, model }, '重新生成同一路径');
    await runTurn({ ...agent, model }, '继续加工候选');

    const facts = readVideoDeliveryFacts(session.events());
    expect(facts.validations.map(validation => validation.checks[0]!.outcome)).toEqual(['passed', 'blocked', 'blocked']);
    expect(facts.candidates).toHaveLength(3);
    expect(new Set(facts.candidates.map(candidate => candidate.id)).size).toBe(3);
    expect(producedVideoItem(session.events(), facts.candidates[2]!.path)?.id).toBe(facts.items[0]!.id);
  });
});
