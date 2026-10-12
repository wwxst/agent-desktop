import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutionError, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { adaptWhisperTool, type WhisperFileAccess } from '../src/main/whisper-tool.js';
import { InMemorySession, SessionPersistenceError } from '@agent-desktop/session';
import { createVideoAgent, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { prepareExtensions } from '../src/main/extension-runtime.js';
import type { PluginFiles } from '../src/main/extensions.js';

// 保留真实文件和 MCP；本套不使用 Electron 运行资源或模型下载入口。
vi.mock('electron', () => ({ net: { fetch: () => { throw new Error('Unexpected runtime download in Whisper test'); } } }));

const context: ToolExecutionContext = { toolCallId: 'whisper-test' as never, reportProgress: () => {} };
const roots: string[] = [];
const rawTool = (result: Awaited<ReturnType<Tool['execute']>>): Tool => ({
  name: 'p_whisper_whisper_transcribe_audio', description: 'Whisper', inputSchema: {},
  execute: vi.fn(async () => result),
});

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Whisper host adapter', () => {
  it('keeps a progressing Whisper call alive beyond the SDK wait timeout without a total duration cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-progress-')); roots.push(root);
    const script = join(root, 'server.cjs'); const model = join(root, 'model.bin'); const audio = join(root, 'audio.wav');
    await writeFile(model, 'model'); await writeFile(audio, 'WAV');
    // 真实宿主、服务和 SDK；只缩短计时并替换昂贵推理，验证等待超时的协议行为。
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/whisper.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs',
      plugins: [{ name: 'speech-boundary', setup(builder) {
        builder.onResolve({ filter: /^@agent-desktop\/speech-whisper-cpp$/ }, () => ({ path: 'speech', namespace: 'fixture' }));
        builder.onResolve({ filter: /^node:timers\/promises$/ }, () => ({ path: 'timer', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'speech'
          ? `exports.TranscribeAudioTool = class { name = 'transcribe_audio'; description = 'WAV'; inputSchema = {type:'object',properties:{audioPath:{type:'string'}}}; async execute() { await new Promise(done => setTimeout(done, 700)); return {status:'success',output:{text:'spoken',segments:[{start:0,end:1,text:'spoken'}]}}; } };`
          : `exports.setInterval = (_delay, value, options) => process.getBuiltinModule('timers/promises').setInterval(40, value, options);` }));
      } }] });
    const original = Client.prototype.callTool; const updates: unknown[] = [];
    const request = vi.spyOn(Client.prototype, 'callTool').mockImplementation(function (this: Client, ...args) {
      const options = args[2];
      return original.call(this, args[0], args[1], { ...options, timeout: 250,
        onprogress: progress => { updates.push(progress); options?.onprogress?.(progress); } });
    });
    const plugin: PluginFiles = { name: 'whisper', directory: root, skills: [], item: { id: 'plugin:whisper', name: 'Whisper', description: '', kind: 'plugin', source: 'builtin', enabled: true, installed: true }, servers: [{ name: 'whisper', command: 'node', args: [script] }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, undefined, undefined,
      { whisperEnvironment: { WHISPER_CLI_PATH: process.execPath, WHISPER_MODEL_PATH: model }, whisperAccess: { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] } });
    try {
      const saveFailure = new SessionPersistenceError(new Error('Whisper checkpoint failed'));
      expect(runtime.tools[0]!.executionBoundary).toBe('checkpointed');
      await expect(runtime.tools[0]!.execute({ audioPath: audio }, { ...context, checkpoint: () => { throw saveFailure; } })).rejects.toBe(saveFailure);
      expect(request).not.toHaveBeenCalled();
      expect(await runtime.tools[0]!.execute({ audioPath: audio }, context)).toEqual({ status: 'success', output: { text: 'spoken', segments: [{ start: 0, end: 1, text: 'spoken' }] } });
      expect(request.mock.calls[0]?.[2]).toMatchObject({ resetTimeoutOnProgress: true });
      expect(request.mock.calls[0]?.[2]?.maxTotalTimeout).toBeUndefined();
      expect(updates.length).toBeGreaterThan(1);
    } finally { await runtime.close(); }
  });
  it('shares only authorized candidate-derived WAVs and rejects an attachment neighbour or directory junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-derived-')); roots.push(root);
    const outside = join(root, 'attachments'); const workspace = join(root, 'workspace'); await mkdir(outside); await mkdir(workspace);
    const video = join(outside, 'source.mp4'); await writeFile(video, 'source');
    const session = new InMemorySession(); const agent = createVideoAgent({ deepSeekApiKey: 'fixture', session });
    const result = await agent.tools.list().find(tool => tool.name === 'declare_video_outputs')!.execute({ items: [{ sourcePaths: [video], target: { kind: 'automatic' } }] }, context);
    session.append({ type: 'tool.called', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, name: 'declare_video_outputs', input: {} });
    session.append({ type: 'tool.result', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, result });
    const wav = join(readVideoDeliveryFacts(session.events()).items[0]!.workingDirectory, 'audio.wav'); await writeFile(wav, 'audio');
    const raw = rawTool({ status: 'success', output: { structuredContent: { text: 'spoken', segments: [{ start: 0, end: 1, text: 'spoken' }] } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => workspace }, attachments: () => [video], events: () => session.events() };
    expect(await adaptWhisperTool(raw, access).execute({ audioPath: wav, modelPath: 'sensitive-file' }, context)).toMatchObject({ status: 'success' });
    expect(raw.execute).toHaveBeenLastCalledWith({ audioPath: expect.any(String) }, context);
    const neighbour = join(outside, 'neighbour.wav'); await writeFile(neighbour, 'audio');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of [neighbour, join(workspace, 'escape', 'neighbour.wav')]) expect(await adaptWhisperTool(raw, access).execute({ audioPath: path }, context)).toMatchObject({ status: 'error' });
    expect(raw.execute).toHaveBeenCalledOnce();
  });
  it('isolates a failed Whisper MCP connection and preserves other capabilities without any fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-connection-')); roots.push(root);
    const script = join(root, 'closed.cjs'); await writeFile(script, 'process.exit(1)');
    const plugin: PluginFiles = { name: 'whisper', directory: root, skills: [], item: { id: 'plugin:whisper', name: 'Whisper', description: '', kind: 'plugin', source: 'builtin', enabled: true, installed: true }, servers: [{ name: 'whisper', command: 'node', args: [script] }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true);
    try { expect(runtime.tools).toEqual([]); expect(runtime.instructions).toContain('Whisper 连接失败'); }
    finally { await runtime.close(); }
    const refused = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => false);
    try { expect(refused.tools).toEqual([]); } finally { await refused.close(); }
  });

  it('preserves the public transcript contract and canonicalizes an authorized path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-adapter-')); roots.push(root);
    const audio = join(root, '中文 audio.wav'); await writeFile(audio, 'RIFF fixture');
    const raw = rawTool({ status: 'success', output: { structuredContent: {
      text: '你好 world', segments: [{ start: 0, end: 1.2, text: '你好' }, { start: 1.2, end: 2.4, text: 'world' }],
    } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };

    await expect(adaptWhisperTool(raw, access).execute({ audioPath: audio }, context)).resolves.toEqual({
      status: 'success', output: { text: '你好 world', segments: [{ start: 0, end: 1.2, text: '你好' }, { start: 1.2, end: 2.4, text: 'world' }] },
    });
    expect(raw.execute).toHaveBeenCalledWith({ audioPath: await import('node:fs/promises').then(({ realpath }) => realpath(audio)) }, context);
  });

  it('rejects URLs, directory escapes and malformed MCP timelines before exposing success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-boundary-')); roots.push(root);
    const raw = rawTool({ status: 'success', output: { structuredContent: { text: 'ok', segments: [] } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };
    const adapted = adaptWhisperTool(raw, access);

    await expect(adapted.execute({ audioPath: 'https://example.com/a.wav' }, context)).resolves.toMatchObject({ status: 'error', failureKind: 'permanent' });
    await expect(adapted.execute({ audioPath: join(tmpdir(), 'outside.wav') }, context)).resolves.toMatchObject({ status: 'error' });
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'RIFF fixture');
    const malformed = rawTool({ status: 'success', output: { structuredContent: {
      text: 'ok', segments: [{ start: 2, end: 1, text: 'bad' }],
    } } });
    await expect(adaptWhisperTool(malformed, access).execute({ audioPath: audio }, context)).resolves.toMatchObject({ status: 'error', failureKind: 'unknown-outcome' });
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('preserves classified failures, structured output and fatal persistence identity through the authorized adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-classification-')); roots.push(root);
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'RIFF fixture');
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };
    const output = { content: [{ type: 'text', text: 'partial transcription failed' }] };
    const raw = { ...rawTool({ status: 'error', failureKind: 'unknown-outcome', message: 'MCP failed', output }), executionBoundary: 'checkpointed' as const };
    const adapted = adaptWhisperTool(raw, access);
    expect(adapted.executionBoundary).toBe('checkpointed');
    expect(adaptWhisperTool({ ...raw, executionBoundary: 'opaque' }, access).executionBoundary).toBe('opaque');
    expect(await adapted.execute({ audioPath: audio }, context)).toEqual({ status: 'error', failureKind: 'unknown-outcome', message: 'partial transcription failed', output });
    for (const failureKind of ['denied', 'unknown-outcome'] as const) {
      raw.execute = vi.fn(async () => { throw new ToolExecutionError('classified failure', failureKind); });
      expect(await adapted.execute({ audioPath: audio }, context)).toMatchObject({ status: 'error', failureKind });
    }
    const persistence = new SessionPersistenceError(new Error('disk full'));
    raw.execute = vi.fn(async () => { throw persistence; });
    await expect(adapted.execute({ audioPath: audio }, context)).rejects.toBe(persistence);
    const controller = new AbortController();
    raw.execute = vi.fn<Tool['execute']>(async () => { controller.abort(persistence); return { status: 'success', output: {} }; });
    await expect(adapted.execute({ audioPath: audio }, { ...context, signal: controller.signal })).rejects.toBe(persistence);
  });

  it('keeps cancellation as cancellation and does not turn it into a tool error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-cancel-')); roots.push(root);
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'RIFF fixture');
    const controller = new AbortController(); controller.abort();
    const raw = rawTool({ status: 'success', output: { structuredContent: { text: 'ok', segments: [] } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };
    await expect(adaptWhisperTool(raw, access).execute({ audioPath: audio }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(raw.execute).not.toHaveBeenCalled();
  });
});
