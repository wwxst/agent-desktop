import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnalyzeImagesTool } from '../src/index.js';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { createServer } from 'node:http';

/** 测试用的最小执行上下文：只提供当前用例真正使用的取消信号。 */
function toolContext(signal?: AbortSignal): ToolExecutionContext {
  return {
    toolCallId: 'test-call' as ToolExecutionContext['toolCallId'],
    reportProgress: () => {},
    ...(signal === undefined ? {} : { signal }),
  };
}

const analysis = {
  summary: 'A person walks through a room.',
  frames: [{
    timestamp: 1.5,
    description: 'A person stands near a table.',
    subjects: ['person'],
    actions: ['walking'],
    scene: 'indoor room',
    visibleText: [],
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AnalyzeImagesTool', () => {
  it.each(['chat-completions', 'responses'] as const)('uses the configured vision model and token limit over real HTTP: %s', async protocol => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-vision-provider-'));
    const imagePath = join(directory, 'frame.png');
    // 真实可解码的小 PNG，文件读取与 data URL 仍走正式实现。
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64'));
    let body!: Record<string, unknown>;
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      body = JSON.parse(raw) as Record<string, unknown>;
      expect(request.url).toBe(`/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(protocol === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }] } : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
    try {
      expect(await new AnalyzeImagesTool({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'chosen-vision', protocol, maxOutputTokens: 2048 }).execute({ images: [{ path: imagePath, timestamp: 1.5 }] }, toolContext())).toEqual({ status: 'success', output: analysis });
      expect(body).toHaveProperty('model', 'chosen-vision');
      expect(body).toHaveProperty(protocol === 'responses' ? 'max_output_tokens' : 'max_tokens', 2048);
      expect(JSON.stringify(body)).toContain('data:image/png;base64,');
      expect(body).toHaveProperty(protocol === 'responses' ? 'text.format.type' : 'response_format.type', 'json_schema');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });
  it('passes the Turn AbortSignal to fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-vision-signal-'));
    try {
      const imagePath = join(directory, 'frame.jpg');
      await writeFile(imagePath, Buffer.from([0xff, 0xd8]));
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }],
      }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();

      await new AnalyzeImagesTool({ apiKey: 'test-key' }).execute({
        images: [{ path: imagePath, timestamp: 1.5 }],
      }, toolContext(controller.signal));

      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('builds a Responses Vision request and parses structured JSON output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-vision-test-'));
    try {
      const firstPath = join(directory, 'frame-001.jpg');
      const secondPath = join(directory, 'frame-002.jpg');
      await writeFile(firstPath, Buffer.from([0xff, 0xd8, 0xff]));
      await writeFile(secondPath, Buffer.from([0xff, 0xd9]));
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(analysis) }],
        }],
      }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(new AnalyzeImagesTool({ apiKey: 'test-key' }).execute({
        images: [
          { path: firstPath, timestamp: 1.5 },
          { path: secondPath, timestamp: 3 },
        ],
      }, toolContext())).resolves.toEqual({ status: 'success', output: analysis });

      const [url, request] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(request?.headers).toEqual({
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      });
      const body = JSON.parse(String(request?.body)) as {
        model: string;
        input: [{ content: Array<Record<string, unknown>> }];
        text: { format: { type: string; name: string; strict: boolean; schema: unknown } };
      };
      expect(body.model).toBe('gpt-5.6-luna');
      const content = body.input[0]?.content ?? [];
      expect(content.filter((item) => item.type === 'input_image')).toEqual([
        {
          type: 'input_image',
          image_url: 'data:image/jpeg;base64,/9j/',
          detail: 'low',
        },
        {
          type: 'input_image',
          image_url: 'data:image/jpeg;base64,/9k=',
          detail: 'low',
        },
      ]);
      const textItems = content.filter((item) => item.type === 'input_text').map((item) => item.text);
      expect(textItems[0]).toEqual(expect.stringContaining('Frame 1 is sampled at 1.5 seconds'));
      expect(textItems.slice(1)).toEqual([
        'Image 1 corresponds to 1.5 seconds.',
        'Image 2 corresponds to 3 seconds.',
      ]);
      expect(body.text.format).toMatchObject({
        type: 'json_schema',
        name: 'visual_media_analysis',
        strict: true,
      });
      expect(body.text.format.schema).toMatchObject({
        required: ['summary', 'frames'],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses a configured OpenAI-compatible base URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-vision-base-url-'));
    const imagePath = join(directory, 'frame.jpg');
    await writeFile(imagePath, Buffer.from([0xff, 0xd8]));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(analysis) }],
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const tool = new AnalyzeImagesTool({
        apiKey: 'relay-key',
        baseUrl: 'http://relay.example/v1/',
      });

      await tool.execute({ images: [{ path: imagePath, timestamp: 1 }] }, toolContext());

      expect(fetchMock).toHaveBeenCalledWith(
        'http://relay.example/v1/responses',
        expect.any(Object),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('validates image count and image entries before reading files', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const tool = new AnalyzeImagesTool({ apiKey: 'test-key' });

    await expect(tool.execute({ images: [] }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'analyze_images requires between 1 and 6 images',
    });
    await expect(tool.execute({ images: Array.from({ length: 7 }, () => ({ path: 'x.jpg', timestamp: 1 })) }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'analyze_images requires between 1 and 6 images',
    });
    await expect(tool.execute({ images: [{ path: 42, timestamp: 1 }] }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'analyze_images requires image path strings and finite timestamps',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns clear errors for HTTP failures, missing output text, and invalid JSON', async () => {
    const tool = new AnalyzeImagesTool({ apiKey: 'test-key' });
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-vision-error-'));
    const imagePath = join(directory, 'frame.jpg');
    await writeFile(imagePath, Buffer.from([0xff, 0xd8]));
    try {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 })));
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] }, toolContext())).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API request failed: 500',
      });

      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ output: [] }), { status: 200 })));
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] }, toolContext())).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API response is missing output_text',
      });

      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{invalid' }] }],
      }), { status: 200 })));
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] }, toolContext())).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API returned invalid JSON',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
