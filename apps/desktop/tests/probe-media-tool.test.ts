import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import { InMemorySession } from '@agent-desktop/session';
import { InMemoryToolRegistry, type Tool } from '@agent-desktop/tools';
import { createVideoAgent, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { adaptProbeMediaTool, type ProbeFileAccess } from '../src/main/probe-media-tool.js';
import { prepareExtensions } from '../src/main/extension-runtime.js';
import type { PluginFiles } from '../src/main/extensions.js';

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
  return { name: 'raw', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async input => ({ status: 'success',
    output: { structuredContent: { ...output((input as { inputPath: string }).inputPath), extra: true } } })) };
}

describe('host Probe capability boundary', () => {
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
    const agent = createVideoAgent({ deepSeekApiKey: 'fixture', session });
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
  it('preserves server errors and rejects malformed or mismatched success results', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const raw = rawTool(); const tool = adaptProbeMediaTool(raw, access);
    raw.execute.mockResolvedValueOnce({ status: 'error', message: 'wrapper', output: { content: [{ type: 'text', text: 'ffprobe exited 1' }] } });
    expect(await tool.execute({ inputPath: source }, context)).toEqual({ status: 'error', message: 'ffprobe exited 1' });
    for (const result of [{ structuredContent: { audioCodec: null } }, { structuredContent: output('wrong.mp4') }, { content: [{ type: 'text', text: '{bad json' }] }]) {
      raw.execute.mockResolvedValueOnce({ status: 'success', output: result });
      expect(await tool.execute({ inputPath: source }, context)).toMatchObject({ status: 'error' });
    }
  });
  it('preserves cancellation instead of returning ordinary tool failure', async () => {
    const source = join(workspace, 'video.mp4'); await writeFile(source, 'data');
    const controller = new AbortController(); const raw = rawTool();
    raw.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('MCP connection closed'); });
    await expect(adaptProbeMediaTool(raw, access).execute({ inputPath: source }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses a real bundled server with normalized approval and stable Agent evidence', async () => {
    const inputPath = join(workspace, '真实 video.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', inputPath]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/probe-media.ts')], outfile: join(directory, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    const plugin: PluginFiles = { name: 'video-editing', directory, skills: [], item: { id: 'plugin:video-editing', kind: 'plugin', name: 'video-editing', description: '', source: 'builtin', enabled: true, installed: true },
      servers: [{ name: 'ffmpeg-probe', command: 'node', args: [join(directory, 'probe.cjs')], env: { FFPROBE_PATH: execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]! } }] };
    const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, approve, undefined, undefined, { probeAccess: access });
    try {
      const tools = new InMemoryToolRegistry(); runtime.tools.forEach(tool => tools.register(tool));
      await runTurn({ tools, session, systemPrompt: { build: () => '' }, model: { complete: async request => request.messages.some(message => message.role === 'tool')
        ? { text: 'verified', toolCalls: [] } : { toolCalls: [{ id: 'probe' as never, name: 'probe_media', input: { inputPath: '真实 video.mp4' } }] } } }, 'probe');
      expect(session.events().find(event => event.type === 'tool.called')).toMatchObject({ name: 'probe_media' });
      expect(session.events().find(event => event.type === 'tool.result')).toMatchObject({ result: { status: 'success', output: output(await realpath(inputPath)) } });
      expect(approve.mock.calls.map(([request]) => request.kind)).toEqual(['plugin-start', 'plugin-tool']);
      expect(approve.mock.calls[1]?.[0]).toMatchObject({ arguments: JSON.stringify({ inputPath: await realpath(inputPath) }) });
    } finally { await runtime.close(); }
    const denied = await prepareExtensions({ plugins: [plugin], skills: [] }, async request => request.kind === 'plugin-start', undefined, undefined, { probeAccess: access });
    try { expect(await denied.tools[0]!.execute({ inputPath }, context)).toMatchObject({ status: 'error', message: '用户拒绝了插件工具调用。' }); }
    finally { await denied.close(); }
  }, 20_000);
});
