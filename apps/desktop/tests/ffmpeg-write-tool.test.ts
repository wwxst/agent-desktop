import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import { InMemorySession } from '@agent-desktop/session';
import { InMemoryToolRegistry, type Tool } from '@agent-desktop/tools';
import { createVideoAgent, projectOutputItemResults, readVideoDeliveryFacts, VIDEO_WRITE_TOOL_NAMES } from '@agent-desktop/video-agent';
import { prepareExtensions } from '../src/main/extension-runtime.js';
import { adaptFFmpegTool, authorizeVideoDeliveryTool, type ProbeFileAccess } from '../src/main/ffmpeg-tool.js';
import type { PluginFiles } from '../src/main/extensions.js';

const context = { toolCallId: 'test' as never, reportProgress: () => {} };
const executable = (name: string) => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
const mediaInfo = (path: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' })) as {
  format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number; codec_name: string }>;
};

describe('FFmpeg plugin write and delivery contracts', () => {
  it('rejects forged delivery metadata and mismatched write successes from the MCP boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ffmpeg-envelope-'));
    try {
      const source = join(directory, 'source.mp4'); await writeFile(source, 'input');
      const session = new InMemorySession(); const agent = createVideoAgent({ deepSeekApiKey: 'fixture', session });
      const result = await agent.tools.list().find(tool => tool.name === 'declare_video_outputs')!.execute({ items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] }, context);
      session.append({ type: 'tool.called', toolCallId: 'declare' as never, turnId: 't' as never, stepId: 's' as never, name: 'declare_video_outputs', input: {} });
      session.append({ type: 'tool.result', toolCallId: 'declare' as never, turnId: 't' as never, stepId: 's' as never, result });
      const outputPath = join(readVideoDeliveryFacts(session.events()).items[0]!.workingDirectory, 'candidate.mp4'); await writeFile(outputPath, 'candidate');
      const access: ProbeFileAccess = { workspace: { confirmedDirectory: () => directory }, attachments: () => [], events: () => session.events() };
      for (const invalid of [
        { status: 'success', output: { outputPath }, artifacts: [{ path: outputPath, kind: 'video' }] },
        { status: 'success', output: { outputPath: source } },
        { status: 'error', message: 'malformed success envelope' },
      ]) {
        const raw: Tool = { name: 'raw', description: '', inputSchema: {}, execute: async () => ({ status: 'success', output: { structuredContent: { toolResult: invalid } } }) };
        expect(await adaptFFmpegTool(raw, access, 'trim_video').execute({ inputPath: source, outputPath, start: 0, duration: 1 }, context)).toMatchObject({ status: 'error' });
      }
      expect(readVideoDeliveryFacts(session.events()).published).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'win32')('cancels a native writer through the Agent without successful producer or published facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ffmpeg-cancel-'));
    const session = new InMemorySession(); const controller = new AbortController();
    let runtime: Awaited<ReturnType<typeof prepareExtensions>> | undefined;
    try {
      const source = join(directory, 'source.mp4'); await writeFile(source, 'fixture input');
      const executable = join(directory, 'writer.exe');
      execFileSync(join(process.env.WINDIR!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', `/out:${executable}`, resolve('apps/desktop/tests/fixtures/probe-process.cs')]);
      await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'ffmpeg.cjs'), bundle: true, platform: 'node', format: 'cjs' });
      const access: ProbeFileAccess = { workspace: { confirmedDirectory: () => directory }, attachments: () => [], events: () => session.events() };
      const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
        servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'ffmpeg.cjs')], env: { FFMPEG_PATH: executable, FFPROBE_PATH: executable } }] };
      runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, controller.signal, undefined, { probeAccess: access });
      const agent = createVideoAgent({ deepSeekApiKey: 'fixture', session, mediaTools: runtime.tools });
      let outputPath = '';
      const running = runTurn({ ...agent, model: { complete: async () => {
        const item = readVideoDeliveryFacts(session.events()).items[0];
        if (item === undefined) return { toolCalls: [{ id: 'declare' as never, name: 'declare_video_outputs', input: { items: [{ sourcePaths: [source], target: { kind: 'automatic' } }] } }] };
        outputPath = join(item.workingDirectory, 'cancelled.mp4');
        return { toolCalls: [{ id: 'cancel-writer' as never, name: 'trim_video', input: { inputPath: source, outputPath, start: 0, duration: 1 } }] };
      } } }, 'cancel native writer', { signal: controller.signal });
      const rejection = expect(running).rejects.toThrow(); let pid = 0;
      await vi.waitFor(async () => { pid = Number(await readFile(`${outputPath}.pid`, 'utf8')); expect(pid).toBeGreaterThan(0); });
      controller.abort(); await rejection;
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      const facts = readVideoDeliveryFacts(session.events());
      expect(facts.candidates).toEqual([]); expect(facts.published).toEqual([]);
      expect(session.events().some(event => event.type === 'tool.result' && event.toolCallId === 'cancel-writer' && event.result.status === 'success')).toBe(false);
    } finally { controller.abort(); await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
  it('produces seven independently validated outputs through real MCP and never publishes a failed eighth item', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ffmpeg-write-中文 '));
    const session = new InMemorySession();
    const access: ProbeFileAccess = { workspace: { confirmedDirectory: () => directory }, attachments: () => [], events: () => session.events() };
    const source = join(directory, '红色视频.mp4'); const second = join(directory, '蓝色视频.mp4');
    const broken = join(directory, '损坏.mp4'); const subtitlePath = join(directory, '字幕 文件.srt');
    const audioPath = join(directory, '提取 音频.wav');
    let runtime: Awaited<ReturnType<typeof prepareExtensions>> | undefined;
    try {
      for (const [path, color] of [[source, 'red'], [second, 'blue']]) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:r=5:d=2`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path!]);
      await writeFile(broken, 'broken media');
      await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:01,500\nHELLO\n');
      await build({ entryPoints: [resolve('apps/desktop/src/plugins/ffmpeg.ts')], outfile: join(directory, 'ffmpeg.cjs'), bundle: true, platform: 'node', format: 'cjs' });
      const plugin: PluginFiles = { name: 'ffmpeg', directory, skills: [], item: { id: 'plugin:ffmpeg', kind: 'plugin', name: 'ffmpeg', description: '', source: 'builtin', enabled: true, installed: true },
        servers: [{ name: 'ffmpeg', command: 'node', args: [join(directory, 'ffmpeg.cjs')], env: { FFPROBE_PATH: executable('ffprobe'), FFMPEG_PATH: executable('ffmpeg') } }] };
      const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
      runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, approve, undefined, undefined, { probeAccess: access });
      const original = createVideoAgent({ deepSeekApiKey: 'fixture', session, mediaTools: runtime.tools });
      const tools = new InMemoryToolRegistry();
      for (const tool of original.tools.list()) tools.register(['declare_video_outputs', 'publish_video_output'].includes(tool.name) ? authorizeVideoDeliveryTool(tool, access) : tool);
      const names = [...VIDEO_WRITE_TOOL_NAMES]; let step = 0;
      const call = (name: string, input: object, id: string) => ({ name, input, id: id as never });
      await runTurn({ ...original, tools, model: { complete: async () => {
        step += 1;
        const facts = readVideoDeliveryFacts(session.events());
        if (step === 1) return { toolCalls: [call('declare_video_outputs', { items: [...names, 'broken'].map(name => ({
          sourcePaths: name === 'concat_videos' ? [source, second] : [name === 'broken' ? broken : source],
          target: { kind: 'explicit', path: join(directory, `${name} 成片.mp4`) }, requirements: [{ kind: 'no-black-segments' }],
        })) }, 'declare'), call('extract_audio', { videoPath: source, outputPath: audioPath }, 'audio')] };
        if (step === 2) return { toolCalls: facts.items.map((item, index) => {
          const name = names[index] ?? 'trim_video'; const outputPath = join(item.workingDirectory, '候选 video.mp4');
          const input = name === 'concat_videos' ? { inputPaths: [source, second], outputPath }
            : name === 'add_audio' ? { videoPath: source, audioPath, outputPath }
            : name === 'add_subtitles' ? { videoPath: source, subtitlePath, outputPath }
            : name === 'resize_video' ? { inputPath: source, width: 80, height: 60, outputPath }
            : name === 'crop_video' ? { inputPath: source, x: 0, y: 0, width: 100, height: 80, outputPath }
            : name === 'set_speed' ? { inputPath: source, speed: 2, outputPath }
            : { inputPath: index === names.length ? broken : source, start: 0, duration: 0.8, outputPath };
          return call(name, input, `write-${index}`);
        }) };
        if (step === 3) return { toolCalls: facts.items.flatMap((item, index) => {
          const inputPath = join(item.workingDirectory, '候选 video.mp4');
          return index === names.length ? [call('validate_video_candidate', { outputItemId: item.id, candidatePath: inputPath }, 'validate-broken')]
            : [call('decode_video', { inputPath }, `decode-${index}`), call('probe_media', { inputPath }, `probe-${index}`),
              call('detect_black_segments', { inputPath }, `black-${index}`), call('validate_video_candidate', { outputItemId: item.id, candidatePath: inputPath }, `validate-${index}`)];
        }) };
        if (step === 4) return { toolCalls: facts.validations.map((validation, index) => call('publish_video_output', { validationId: validation.id }, `publish-${index}`)) };
        return { text: 'seven verified outputs', toolCalls: [] };
      } } }, 'edit independent outputs');
      const facts = readVideoDeliveryFacts(session.events());
      expect(facts.published).toHaveLength(7);
      expect(facts.candidates.every(candidate => candidate.producerToolCallId.startsWith('write-'))).toBe(true);
      expect(facts.validations.every(validation => /^[0-9a-f]{64}$/.test(validation.candidateSha256!) && validation.checks.every(check => check.outcome === 'passed'))).toBe(true);
      expect(projectOutputItemResults(facts).map(result => result.status)).toEqual([...names.map(() => 'published'), 'incomplete']);
      const errors = session.events().filter(event => event.type === 'tool.result' && event.result.status === 'error');
      expect(errors).toHaveLength(2); // 损坏媒体写出失败，无成功生产事实的第八项不能验收。
      for (const name of names) {
        const output = join(directory, `${name} 成片.mp4`); const info = mediaInfo(output);
        expect(info.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264')).toBe(true);
        execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
        const video = info.streams.find(stream => stream.codec_type === 'video')!;
        expect(video).toMatchObject(name === 'resize_video' ? { width: 80, height: 60 } : name === 'crop_video' ? { width: 100, height: 80 } : { width: 160, height: 120 });
        expect(Number(info.format.duration)).toBeGreaterThan(0);
        if (name === 'trim_video') expect(Number(info.format.duration)).toBeCloseTo(0.8, 1);
        if (name === 'concat_videos') expect(Number(info.format.duration)).toBeCloseTo(4, 1);
        if (name === 'set_speed') expect(Number(info.format.duration)).toBeLessThan(2);
        expect(info.streams.some(stream => stream.codec_type === 'audio')).toBe(true);
      }
      const pixels = (name: string, seconds: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', seconds, '-i', join(directory, `${name} 成片.mp4`), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      expect(pixels('concat_videos', '0.5')[0]).toBeGreaterThan(200);
      expect(pixels('concat_videos', '2.5')[2]).toBeGreaterThan(200);
      const caption = pixels('add_subtitles', '0.5'); const plain = pixels('trim_video', '0.5'); let changedPixels = 0;
      // 低分辨率字幕经抗锯齿与编码后未必是纯白；比较实际同色底图上的像素变化。
      for (let index = 0; index < caption.length; index += 3) if (Math.abs(caption[index]! - plain[index]!)
        + Math.abs(caption[index + 1]! - plain[index + 1]!) + Math.abs(caption[index + 2]! - plain[index + 2]!) > 40) changedPixels += 1;
      expect(changedPixels).toBeGreaterThan(10);
      const published = facts.published[0]!; const originalBytes = await readFile(published.path);
      const repeated = await tools.list().find(tool => tool.name === 'publish_video_output')!.execute({ validationId: published.validationId }, context);
      expect(repeated.status).toBe('error'); expect(await readFile(published.path)).toEqual(originalBytes);
    } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it('rejects undeclared output and unauthorized audio/subtitles before calling MCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ffmpeg-write-boundary-'));
    try {
      const source = join(directory, 'source.mp4'); await writeFile(source, 'input');
      const access: ProbeFileAccess = { workspace: { confirmedDirectory: () => directory }, attachments: () => [], events: () => [] };
      for (const name of VIDEO_WRITE_TOOL_NAMES) {
        const raw: Tool = { name: 'raw', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: {} })) };
        const tool = adaptFFmpegTool(raw, access, name);
        const input = name === 'concat_videos' ? { inputPaths: [source], outputPath: join(directory, 'bypass.mp4') }
          : name === 'add_audio' ? { videoPath: source, audioPath: 'https://example.com/audio.wav', outputPath: join(directory, 'bypass.mp4') }
          : name === 'add_subtitles' ? { videoPath: source, subtitlePath: 'file:///etc/secret.srt', outputPath: join(directory, 'bypass.mp4') }
          : { inputPath: source, outputPath: join(directory, 'bypass.mp4') };
        expect(await tool.execute(input, context)).toMatchObject({ status: 'error' });
        expect(raw.execute).not.toHaveBeenCalled();
      }
      const declare: Tool = { name: 'declare_video_outputs', description: '', inputSchema: {}, execute: vi.fn<Tool['execute']>(async () => ({ status: 'success', output: {} })) };
      const unauthorized = await authorizeVideoDeliveryTool(declare, access).execute({ items: [{ sourcePaths: [source], target: { kind: 'explicit', path: join(tmpdir(), 'arbitrary.mp4') } }] }, context);
      expect(unauthorized.status).toBe('error'); expect(declare.execute).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
