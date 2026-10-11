import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('bundled ffmpeg Probe MCP server', () => {
  it('runs a self-contained package with real media and preserves success and failure contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'probe-server-'));
    const client = new Client({ name: 'probe-test', version: '1' });
    try {
      const executable = execFileSync('where.exe', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
      const inputPath = join(directory, '真实 video.mp4');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', inputPath]);
      await build({ entryPoints: [resolve('apps/desktop/src/plugins/probe-media.ts')], outfile: join(directory, 'probe.cjs'),
        bundle: true, platform: 'node', format: 'cjs' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'probe.cjs')],
        cwd: directory, env: { FFPROBE_PATH: executable } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['probe_media']);
      const result = await client.callTool({ name: 'probe_media', arguments: { inputPath } });
      expect(result.structuredContent).toEqual({ inputPath, duration: 1, width: 160, height: 120, videoCodec: 'h264', audioCodec: null });
      const missing = await client.callTool({ name: 'probe_media', arguments: { inputPath: join(directory, 'missing.mp4') } });
      expect(missing.isError).toBe(true);
      const remote = await client.callTool({ name: 'probe_media', arguments: { inputPath: 'https://example.com/video.mp4' } });
      expect(remote.isError).toBe(true);
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
