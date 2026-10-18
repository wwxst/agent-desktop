import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import { InMemorySession, projectRecoveryFacts, SessionPersistenceError } from '@agent-desktop/session';
import { InMemoryToolRegistry, ToolExecutionError, type Tool } from '@agent-desktop/tools';
import { createVideoAgent, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { adaptProbeMediaTool, adaptFFmpegTool, FFMPEG_READ_TOOLS, type ProbeFileAccess } from '../src/main/ffmpeg-tool.js';
import { prepareExtensions } from '../src/main/extension-runtime.js';
import type { PluginFiles } from '../src/main/extensions.js';
import { taskToolGate } from '../src/main/agent-task-state.js';
import { parseDesktopState } from '../src/main/session-persistence.js';

// 保留真实 ffprobe、FFmpeg 和 MCP 调用；本套不使用 Electron 运行资源下载入口。
vi.mock('electron', () => ({ net: { fetch: () => { throw new Error('Unexpected runtime download in Probe test'); } } }));

let directory: string;
let workspace: string;
let selected: string[];
let session: InMemorySession;
let access: ProbeFileAccess;
const context = { toolCallId: 'probe' as never, reportProgress: () => {} };
const output = (inputPath: string) => ({ inputPath, duration: 1, width: 160, height: 120, videoCodec: 'h264', audioCodec: null });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'probe-host-'));
  workspace = join(directory, 'workspace'); await mkdir(workspace);
  selected = []; session = new InMemorySession();
  access = { workspace: { confirmedDirectory: () => workspace }, attachments: () => selected, events: () => session.events() };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function rawTool(): Tool & { execute: ReturnType<typeof vi.fn<Tool['execute']>> } {
  return { name: 'raw', description: '', inputSchema: {}, executionBoundary: 'checkpointed',
    async prepare(input, context) { return { requestApproval: async () => true, execute: () => this.execute(input, context) }; },
    execute: vi.fn<Tool['execute']>(async input => ({ status: 'success',
    output: { structuredContent: { ...output((input as { inputPath: string }).inputPath), extra: true } } })) };
}

describe('host Probe capability boundary', () => {
  it('handles a long Chinese path, silent MPEG-4 media and rejects indirect network input for decode', async () => {
    const inputPath = join(workspace, `中文 ${'long-name-'.repeat(12)}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=5:d=1', '-c:v', 'mpeg4', inputPath]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'matrix.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    const executable = (name: string) => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
    const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
      servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'matrix.cjs')], env: { FFPROBE_PATH: executable('ffprobe'), FFMPEG_PATH: executable('ffmpeg') } }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, undefined, undefined, { probeAccess: access });
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    try {
      expect(await tool('probe_media').execute({ inputPath }, context)).toMatchObject({ status: 'success', output: { videoCodec: 'mpeg4', audioCodec: null, width: 320, height: 180 } });
      expect(await tool('decode_video').execute({ inputPath }, context)).toMatchObject({ status: 'success', output: { fullyDecoded: true } });
      expect(await tool('extract_audio').execute({ videoPath: inputPath, outputPath: join(workspace, 'silent.wav') }, context)).toMatchObject({ status: 'error' });
      const playlist = join(workspace, 'network.m3u8');
      await writeFile(playlist, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/segment.ts\n#EXT-X-ENDLIST\n');
      expect(await tool('decode_video').execute({ inputPath: playlist }, context)).toMatchObject({ status: 'error' });
    } finally { await runtime.close(); }
  }, 30_000);
  it('rejects unauthorized inputs and output junctions for every read capability before MCP approval', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const outside = join(directory, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'video.mp4'), 'data');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of FFMPEG_READ_TOOLS) {
      const raw = rawTool(); const tool = adaptFFmpegTool(raw, access, name);
      expect(tool.executionBoundary).toBe(['probe_media', 'decode_video', 'detect_black_segments'].includes(name) ? 'read-only' : 'checkpointed');
      const field = ['extract_video_frames', 'extract_video_range_frames', 'extract_audio'].includes(name) ? 'videoPath' : 'inputPath';
      expect(await tool.execute({ [field]: join(outside, 'video.mp4') }, context)).toMatchObject({ status: 'error', failureKind: 'permanent' });
      expect(await tool.execute({ [field]: 'https://example.com/file.mp4' }, context)).toMatchObject({ status: 'error', failureKind: 'permanent' });
      if (name.startsWith('extract_')) {
        expect(await tool.execute({ [field]: source, [name === 'extract_audio' ? 'outputPath' : 'outputDir']: join(workspace, 'escape', 'new.wav') }, context)).toMatchObject({ status: 'error', failureKind: 'permanent' });
      }
      expect(raw.execute).not.toHaveBeenCalled();
    }
  });
  it('runs all read capabilities in one Agent turn through real MCP and verifies generated media', async () => {
    const inputPath = join(workspace, '带音轨 video.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', inputPath]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'read.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    const executable = (name: string) => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
    const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
      servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'read.cjs')], env: { FFPROBE_PATH: executable('ffprobe'), FFMPEG_PATH: executable('ffmpeg') } }] };
    const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, approve, undefined, undefined, { probeAccess: access });
    const outputPath = join(workspace, '声音 16k.wav');
    const calls = [
      { name: 'probe_media', input: { inputPath } }, { name: 'decode_video', input: { inputPath } },
      { name: 'detect_black_segments', input: { inputPath } },
      { name: 'extract_video_frames', input: { videoPath: inputPath, outputDir: join(workspace, '粗看') } },
      { name: 'extract_video_range_frames', input: { videoPath: inputPath, outputDir: join(workspace, '局部'), start: 0, end: 1 } },
      { name: 'extract_full_video_frames', input: { inputPath, outputDir: join(workspace, '全部') } },
      { name: 'extract_audio', input: { videoPath: inputPath, outputPath } },
    ];
    try {
      const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session, mediaTools: runtime.tools });
      await runTurn({ ...agent, model: { complete: async request => request.messages.some(message => message.role === 'tool')
        ? { text: 'verified', toolCalls: [] } : { toolCalls: calls.map((call, index) => ({ ...call, id: `read-${index}` as never })) } } }, 'inspect',
        { beforeToolCall: input => taskToolGate(session.events(), input) });
      const results = session.events().filter(event => event.type === 'tool.result');
      expect(results).toHaveLength(7);
      expect(results.every(event => event.result.status === 'success')).toBe(true);
      expect(results[1]).toMatchObject({ result: { output: { fullyDecoded: true, hasVideoStream: true } } });
      expect(results[2]).toMatchObject({ result: { output: { hasBlackSegments: false, segments: [] } } });
      expect(results[3]).toMatchObject({ result: { output: { frames: expect.any(Array), duration: 2 } } });
      expect(results[5]).toMatchObject({ result: { output: { complete: true, frames: expect.arrayContaining([{ path: expect.any(String), timestamp: 0 }]) } } });
      expect(results[6]).toMatchObject({ result: { output: `Audio created: ${await realpath(outputPath)}` } });
      const audio = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', outputPath], { encoding: 'utf8' })) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
      expect(audio.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 });
      expect(approve.mock.calls.filter(([request]) => request.kind === 'plugin-tool')).toHaveLength(7);
      expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
      const calledEvents = session.events().filter(event => event.type === 'tool.called');
      for (const call of calledEvents.slice(0, 3)) {
        expect(session.events().some(event => event.type === 'tool.effect.prepared' && event.sourceEventIndex === session.events().indexOf(call))).toBe(false);
      }
      // 真实 SDK 与 Loop 生成的事件必须能被重启时的权威解析器恢复；不放松磁盘校验。
      const restored = parseDesktopState(JSON.parse(JSON.stringify({ activeSessionId: 'media-session',
        sessions: [{ id: 'media-session', attachments: [], workingDirectory: workspace, events: session.events() }],
        clientState: { activeSessionId: 'media-session', conversations: [{ id: 'media-session', title: '媒体检查', prompt: '', attachments: [], messages: [] }] },
      })));
      expect(restored.sessions[0]?.events).toEqual(session.events());
    } finally { await runtime.close(); }
    const disabled = await prepareExtensions({ plugins: [{ ...plugin, item: { ...plugin.item, enabled: false } }], skills: [] }, approve);
    try { expect(disabled.tools).toEqual([]); }
    finally { await disabled.close(); }
    const uninstalled = await prepareExtensions({ plugins: [], skills: [] }, approve);
    try { expect(uninstalled.tools).toEqual([]); }
    finally { await uninstalled.close(); }
  }, 30_000);
  it('normalizes a workspace file and authorizes only the selected external attachment', async () => {
    const source = join(workspace, '中文 video.mp4'); await writeFile(source, 'data');
    const attachment = join(directory, 'attachment.mp4'); await writeFile(attachment, 'data'); selected.push(attachment);
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    expect(await tool.execute({ inputPath: '中文 video.mp4' }, context)).toEqual({ status: 'success', output: output(await realpath(source)) });
    expect(await tool.execute({ inputPath: attachment }, context)).toEqual({ status: 'success', output: output(await realpath(attachment)) });
    expect(raw.execute.mock.calls[0]?.[0]).toEqual({ inputPath: await realpath(source) });
    const sibling = join(directory, 'sibling.mp4'); await writeFile(sibling, 'data');
    expect(await tool.execute({ inputPath: sibling }, context)).toMatchObject({ status: 'error' });
    expect(raw.execute).toHaveBeenCalledTimes(2);
  });
  it('rejects traversal, URL, UNC and junction escape before calling MCP', async () => {
    const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'video.mp4'), 'data');
    await symlink(outside, join(workspace, 'link'), 'junction');
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    for (const inputPath of ['../outside/video.mp4', 'link/video.mp4', 'https://example.com/a.mp4', 'file:///C:/video.mp4', '\\\\server\\share\\video.mp4']) {
      expect(await tool.execute({ inputPath }, context)).toMatchObject({ status: 'error' });
    }
    expect(raw.execute).not.toHaveBeenCalled();
  });
  it('keeps a selected attachment usable when another historical attachment was deleted', async () => {
    const source = join(directory, 'selected.mp4'); await writeFile(source, 'data');
    selected.push(join(directory, 'deleted.mp4'), source);
    expect(await adaptProbeMediaTool(rawTool(), access).execute({ inputPath: source }, context)).toMatchObject({ status: 'success' });
  });
  it('requires successful production from authorized sources for candidates outside the session workspace', async () => {
    const source = join(directory, 'attachment.mp4'); await writeFile(source, 'data'); selected.push(source);
    const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session });
    const declared = await agent.tools.list().find(tool => tool.name === 'declare_video_outputs')!.execute({ items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] }, context);
    const append = (name: string, input: unknown, result: Awaited<ReturnType<Tool['execute']>>) => {
      session.append({ type: 'tool.called', toolCallId: name as never, turnId: 't' as never, stepId: 's' as never, name, input });
      session.append({ type: 'tool.result', toolCallId: name as never, turnId: 't' as never, stepId: 's' as never, result });
    };
    append('declare_video_outputs', {}, declared);
    const item = readVideoDeliveryFacts(session.events()).items[0]!;
    const candidate = join(item.workingDirectory, 'candidate.mp4'); await writeFile(candidate, 'candidate');
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    expect(await tool.execute({ inputPath: candidate }, context)).toMatchObject({ status: 'error' });
    append('trim_video', { inputPath: source }, { status: 'success', output: { outputPath: candidate } });
    expect(await tool.execute({ inputPath: candidate }, context)).toMatchObject({ status: 'success' });
    selected.splice(0);
    expect(await tool.execute({ inputPath: candidate }, context)).toMatchObject({ status: 'error' });
    expect(raw.execute).toHaveBeenCalledOnce();
  });
  it('does not authorize an overwritten candidate through an older source-matching producer', async () => {
    const source = join(directory, 'selected.mp4'); await writeFile(source, 'selected media'); selected.push(source);
    const otherSource = join(directory, 'removed-attachment.mp4'); await writeFile(otherSource, 'other media');
    const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session });
    const declared = await agent.tools.get('declare_video_outputs')!.execute({ items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] }, context);
    session.append({ type: 'tool.called', toolCallId: 'declare' as never, turnId: 'first' as never, stepId: 'declare' as never, name: 'declare_video_outputs', input: {} });
    session.append({ type: 'tool.result', toolCallId: 'declare' as never, turnId: 'first' as never, stepId: 'declare' as never, result: declared });
    const candidate = join(readVideoDeliveryFacts(session.events()).items[0]!.workingDirectory, 'candidate.mp4');
    const produce = async (turn: string, inputPath: string) => {
      await writeFile(candidate, `media from ${inputPath}`);
      // 模型跨轮复用调用 ID；最新成功生产必须决定当前磁盘文件的来源。
      session.append({ type: 'tool.called', toolCallId: 'trim' as never, turnId: turn as never, stepId: 'write' as never, name: 'trim_video', input: { inputPath, outputPath: candidate } });
      session.append({ type: 'tool.result', toolCallId: 'trim' as never, turnId: turn as never, stepId: 'write' as never, result: { status: 'success', output: { outputPath: candidate } } });
    };
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    await produce('first', source);
    expect(await tool.execute({ inputPath: candidate }, context)).toMatchObject({ status: 'success' });
    selected.push(otherSource);
    await produce('second', otherSource);
    // 新来源曾是选定附件，但当前已移除；旧生产不能继续为覆盖后的候选授权。
    selected.splice(selected.indexOf(otherSource), 1);
    expect(await tool.execute({ inputPath: candidate }, context)).toMatchObject({ status: 'error', failureKind: 'permanent' });
    expect(raw.execute).toHaveBeenCalledOnce();
  });
  it('preserves server errors and rejects malformed or mismatched success results', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    raw.execute.mockResolvedValueOnce({ status: 'error', message: 'wrapper', output: { content: [{ type: 'text', text: 'ffprobe exited 1' }] } });
    expect(await tool.execute({ inputPath: source }, context)).toEqual({ status: 'error', failureKind: 'permanent', message: 'ffprobe exited 1' });
    for (const result of [{ structuredContent: { audioCodec: null } }, { structuredContent: output('wrong.mp4') }, { content: [{ type: 'text', text: '{bad json' }] }]) {
      raw.execute.mockResolvedValueOnce({ status: 'success', output: result });
      expect(await tool.execute({ inputPath: source }, context)).toMatchObject({ status: 'error' });
    }
  });
  it('rejects an empty full-frame success instead of treating it as complete semantic evidence', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const raw = rawTool();
    raw.execute.mockResolvedValue({ status: 'success', output: { structuredContent: { toolResult: { status: 'success', output: { complete: true, frames: [] } } } } });
    expect(await adaptFFmpegTool(raw, access, 'extract_full_video_frames').execute({ inputPath: source, outputDir: join(workspace, 'frames') }, context)).toMatchObject({ status: 'error', message: expect.stringContaining('帧列表') });
  });
  it('preserves cancellation instead of returning ordinary tool failure', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const controller = new AbortController(); const raw = rawTool();
    raw.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('MCP connection closed'); });
    await expect(adaptProbeMediaTool(raw, access).execute({ inputPath: source }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('keeps pure inspection failures outside recovery effects and permits a subsequent disk-writing tool', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const probe = rawTool(); probe.execute.mockResolvedValue({ status: 'success', output: { content: [{ type: 'text', text: '{bad json' }] } });
    const decode = rawTool(); decode.execute.mockRejectedValue(new ToolExecutionError('response lost', 'unknown-outcome'));
    const black = rawTool(); black.execute.mockResolvedValue({ status: 'success', output: { structuredContent: { toolResult: { status: 'success', output: {} } } } });
    const audioPath = join(workspace, 'audio.wav');
    const audio = rawTool(); audio.execute.mockImplementation(async (input, execution) => {
      execution.checkpoint?.({ kind: 'mcp-call' });
      const path = (input as { outputPath: string }).outputPath;
      await writeFile(path, 'audio bytes');
      return { status: 'success', output: { structuredContent: { toolResult: { status: 'success', output: `Audio created: ${path}` } } } };
    });
    const tools = new InMemoryToolRegistry();
    [adaptProbeMediaTool(probe, access), adaptFFmpegTool(decode, access, 'decode_video'),
      adaptFFmpegTool(black, access, 'detect_black_segments'), adaptFFmpegTool(audio, access, 'extract_audio')].forEach(tool => tools.register(tool));
    let request = 0;
    await runTurn({ tools, session, systemPrompt: { build: () => '' }, model: { complete: async () => ++request === 1 ? { toolCalls: [
      ...['probe_media', 'decode_video', 'detect_black_segments'].map((name, index) => ({ id: `check-${index}` as never, name, input: { inputPath: source } })),
      { id: 'audio' as never, name: 'extract_audio', input: { videoPath: source, outputPath: audioPath } },
    ] } : { text: 'checks failed, audio saved', toolCalls: [] } } }, 'inspect then write',
    { beforeToolCall: input => taskToolGate(session.events(), input) });
    const results = session.events().filter(event => event.type === 'tool.result');
    expect(results.slice(0, 3).map(event => event.result)).toMatchObject([
      { status: 'error', failureKind: 'permanent' }, { status: 'error', failureKind: 'permanent' }, { status: 'error', failureKind: 'permanent' },
    ]);
    expect(results[3]?.result.status).toBe('success');
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    expect(audio.execute).toHaveBeenCalledOnce();
  });
  it('keeps real read-only MCP failures and nested semantic Probe failures outside unknown effects', async () => {
    const source = join(workspace, 'valid video.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'failed-read.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    const executable = (name: string) => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
    const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
      servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'failed-read.cjs')], env: { FFPROBE_PATH: executable('ffprobe'), FFMPEG_PATH: executable('ffmpeg') } }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, undefined, undefined, { probeAccess: access });
    const audioPath = join(workspace, 'after failed checks.wav');
    try {
      const agent = createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session, mediaTools: runtime.tools });
      let request = 0;
      await runTurn({ ...agent, model: { complete: async () => {
        request += 1;
        if (request === 1) return { toolCalls: [{ id: 'declare' as never, name: 'declare_video_outputs', input: { items: [{
          sourcePaths: [source], target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '红色画面' }],
        }] } }] };
        if (request === 2) {
          const item = readVideoDeliveryFacts(session.events()).items[0]!;
          const candidatePath = join(item.workingDirectory, 'damaged candidate.mp4');
          await writeFile(candidatePath, 'damaged media bytes');
          return { toolCalls: [
            ...['probe_media', 'decode_video', 'detect_black_segments'].map((name, index) => ({ id: `failed-${index}` as never, name, input: { inputPath: candidatePath } })),
            { id: 'semantic' as never, name: 'check_video_semantics', input: { outputItemId: item.id, candidatePath } },
            { id: 'after-checks' as never, name: 'extract_audio', input: { videoPath: source, outputPath: audioPath } },
          ] };
        }
        return { text: '检查失败，仍可提取来源音频。', toolCalls: [] };
      } } }, 'inspect damaged candidate', { beforeToolCall: input => taskToolGate(session.events(), input) });
      const results = session.events().filter(event => event.type === 'tool.result');
      expect(results.slice(1, 4).map(event => event.result)).toMatchObject([
        { status: 'error', failureKind: 'permanent' }, { status: 'error', failureKind: 'permanent' }, { status: 'error', failureKind: 'permanent' },
      ]);
      expect(results[4]).toMatchObject({ result: { status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('候选探测失败') }] } } });
      expect(results[5]).toMatchObject({ result: { status: 'success', output: `Audio created: ${await realpath(audioPath)}` } });
      expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    } finally { await runtime.close(); }
  }, 30_000);
  it('propagates a checkpoint save failure through the adapter and Loop before media writes', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const failure = new SessionPersistenceError(new Error('sqlite write failed'));
    const append = session.append.bind(session);
    vi.spyOn(session, 'append').mockImplementation(event => {
      if (event.type === 'tool.effect.prepared') throw failure;
      append(event);
    });
    const wrote = vi.fn(); const raw = rawTool();
    raw.execute.mockImplementation(async (_input, execution) => {
      execution.checkpoint?.({ kind: 'mcp-call' });
      wrote();
      return { status: 'success', output: {} };
    });
    const tools = new InMemoryToolRegistry(); tools.register(adaptFFmpegTool(raw, access, 'extract_audio'));
    await expect(runTurn({ tools, session, systemPrompt: { build: () => '' }, model: { complete: async () => ({ toolCalls: [
      { id: 'audio' as never, name: 'extract_audio', input: { videoPath: source, outputPath: join(workspace, 'audio.wav') } },
    ] }) } }, 'extract audio', { beforeToolCall: input => taskToolGate(session.events(), input) })).rejects.toBe(failure);
    expect(wrote).not.toHaveBeenCalled();
    expect(session.events().some(event => event.type === 'tool.result' && event.toolCallId === 'audio')).toBe(false);
  });
  it('uses a real bundled server with normalized approval and stable Agent evidence', async () => {
    const inputPath = join(workspace, '真实 video.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', inputPath]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
      servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'probe.cjs')], env: { FFPROBE_PATH: execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]! } }] };
    const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, approve, undefined, undefined, { probeAccess: access });
    try {
      const tools = new InMemoryToolRegistry(); runtime.tools.forEach(tool => tools.register(tool));
      await runTurn({ tools, session, systemPrompt: { build: () => '' }, model: { complete: async request => request.messages.some(message => message.role === 'tool')
        ? { text: 'verified', toolCalls: [] } : { toolCalls: [{ id: 'probe' as never, name: 'probe_media', input: { inputPath: '真实 video.mp4' } }] } } }, 'probe');
      expect(session.events().find(event => event.type === 'tool.called')).toMatchObject({ name: 'probe_media' });
      expect(session.events().find(event => event.type === 'tool.result')).toMatchObject({ result: { status: 'success', output: output(await realpath(inputPath)) } });
      expect(approve.mock.calls.map(([request]) => request.kind)).toEqual(['plugin-tool', 'plugin-start']);
      expect(approve.mock.calls[0]?.[0]).toMatchObject({ arguments: JSON.stringify({ inputPath: await realpath(inputPath) }) });
    } finally { await runtime.close(); }
    const denied = await prepareExtensions({ plugins: [plugin], skills: [] }, async request => request.kind === 'plugin-start', undefined, undefined, { probeAccess: access });
    try {
      const deniedSession = new InMemorySession(); const tools = new InMemoryToolRegistry(); denied.tools.forEach(tool => tools.register(tool));
      let request = 0;
      await runTurn({ tools, session: deniedSession, systemPrompt: { build: () => '' }, model: { complete: async () => ++request === 1 ? { toolCalls: [
        { id: 'denied-probe' as never, name: 'probe_media', input: { inputPath } },
        { id: 'repeat-probe' as never, name: 'probe_media', input: { inputPath } },
      ] } : { text: 'denied', toolCalls: [] } } }, 'probe denied', { beforeToolCall: input => taskToolGate(deniedSession.events(), input) });
      expect(deniedSession.events().find(event => event.type === 'tool.result' && event.toolCallId === 'denied-probe'))
        .toMatchObject({ result: { status: 'error', failureKind: 'denied', message: '用户拒绝了该工具操作。' } });
      expect(deniedSession.events().find(event => event.type === 'tool.called' && event.toolCallId === 'repeat-probe')).toMatchObject({ boundary: 'not-executed' });
      expect(projectRecoveryFacts(deniedSession.events()).unknownEffects).toEqual([]);
    }
    finally { await denied.close(); }
  }, 20_000);
});
