import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnalyzeImagesTool } from '../src/index.js';

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
      })).resolves.toEqual({ status: 'success', output: analysis });

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

      await tool.execute({ images: [{ path: imagePath, timestamp: 1 }] });

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

    await expect(tool.execute({ images: [] })).resolves.toEqual({
      status: 'error',
      message: 'analyze_images requires between 1 and 6 images',
    });
    await expect(tool.execute({ images: Array.from({ length: 7 }, () => ({ path: 'x.jpg', timestamp: 1 })) })).resolves.toEqual({
      status: 'error',
      message: 'analyze_images requires between 1 and 6 images',
    });
    await expect(tool.execute({ images: [{ path: 42, timestamp: 1 }] })).resolves.toEqual({
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
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] })).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API request failed: 500',
      });

      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ output: [] }), { status: 200 })));
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] })).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API response is missing output_text',
      });

      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{invalid' }] }],
      }), { status: 200 })));
      await expect(tool.execute({ images: [{ path: imagePath, timestamp: 1 }] })).resolves.toEqual({
        status: 'error',
        message: 'OpenAI Vision API returned invalid JSON',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
