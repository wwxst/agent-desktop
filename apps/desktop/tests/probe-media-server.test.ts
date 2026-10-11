import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, vi } from 'vitest';

describe('bundled ffmpeg Probe MCP server', () => {
  it.skipIf(process.platform !== 'win32')('preserves process errors and stops active native processes on cancellation and stdin disconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'probe-process-'));
    const executable = join(directory, 'probe-fixture.exe');
    execFileSync(join(process.env.WINDIR!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', `/out:${executable}`, resolve('apps/desktop/tests/fixtures/probe-process.cs')]);
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/probe-media.ts')], outfile: join(directory, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs' });
    try {
      for (const mode of ['cancel', 'disconnect']) {
        const client = new Client({ name: 'probe-test', version: '1' });
        try {
          await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'probe.cjs')], cwd: directory, env: { FFPROBE_PATH: executable } }));
          for (const file of ['malformed.mp4', 'failed.mp4']) {
            expect(await client.callTool({ name: 'probe_media', arguments: { inputPath: join(directory, file) } })).toMatchObject({ isError: true });
          }
          const controller = new AbortController(); const inputPath = join(directory, `${mode}.mp4`);
          const pending = client.callTool({ name: 'probe_media', arguments: { inputPath } }, undefined, { signal: controller.signal });
          const rejection = expect(pending).rejects.toThrow();
          let pid = 0;
          await vi.waitFor(async () => { pid = Number(await readFile(`${inputPath}.pid`, 'utf8')); expect(pid).toBeGreaterThan(0); });
          if (mode === 'cancel') controller.abort(); else await client.close();
          await rejection;
          await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
        } finally { await client.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
  it('runs a self-contained package with real media and preserves success and failure contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'probe-server-'));
    const client = new Client({ name: 'probe-test', version: '1' });
    try {
      const executable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
      const inputPath = join(directory, '真实 video.mp4');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', inputPath]);
      await build({ entryPoints: [resolve('apps/desktop/src/plugins/probe-media.ts')], outfile: join(directory, 'probe.cjs'),
        bundle: true, platform: 'node', format: 'cjs' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'probe.cjs')],
        cwd: directory, env: { FFPROBE_PATH: executable } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['probe_media', 'decode_video', 'detect_black_segments',
        'extract_video_frames', 'extract_video_range_frames', 'extract_audio', 'extract_full_video_frames']);
      const result = await client.callTool({ name: 'probe_media', arguments: { inputPath } });
      expect(result.structuredContent).toEqual({ inputPath, duration: 1, width: 160, height: 120, videoCodec: 'h264', audioCodec: null });
      const missing = await client.callTool({ name: 'probe_media', arguments: { inputPath: join(directory, 'missing.mp4') } });
      expect(missing.isError).toBe(true);
      const remote = await client.callTool({ name: 'probe_media', arguments: { inputPath: 'https://example.com/video.mp4' } });
      expect(remote.isError).toBe(true);
      // 已授权本地播放列表也不能借 demuxer 间接访问网络资源。
      let fetched = false;
      const network = createServer((_request, response) => { fetched = true; response.end(); });
      await new Promise<void>(done => network.listen(0, '127.0.0.1', done));
      try {
        const address = network.address(); if (address === null || typeof address === 'string') throw new Error('网络反例服务未启动。');
        const playlist = join(directory, 'network.m3u8');
        await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/segment.ts\n#EXT-X-ENDLIST\n`);
        expect(await client.callTool({ name: 'probe_media', arguments: { inputPath: playlist } })).toMatchObject({ isError: true });
        expect(fetched).toBe(false);
      } finally { await new Promise<void>((done, reject) => network.close(error => error ? reject(error) : done())); }
    } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it('reports missing explicit FFPROBE_PATH without using the system installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'probe-no-config-'));
    const client = new Client({ name: 'probe-test', version: '1' });
    try {
      await build({ entryPoints: [resolve('apps/desktop/src/plugins/probe-media.ts')], outfile: join(directory, 'probe.cjs'),
        bundle: true, platform: 'node', format: 'cjs' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'probe.cjs')], cwd: directory }));
      const result = await client.callTool({ name: 'probe_media', arguments: { inputPath: join(directory, 'input.mp4') } });
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('FFPROBE_PATH') }] });
    } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
});
