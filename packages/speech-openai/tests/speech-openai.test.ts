import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscribeAudioTool } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI speech tools', () => {
  it('defines transcribe_audio as an MP3-only Tool', () => {
    const tool = new TranscribeAudioTool({ apiKey: 'test-openai-key' });

    expect(tool.name).toBe('transcribe_audio');
    expect(tool.description).toContain('MP3');
    expect(tool.inputSchema).toMatchObject({
      properties: { audioPath: { type: 'string' } },
      required: ['audioPath'],
    });
  });

  it('sends an MP3 multipart request and returns the transcript text', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-speech-test-'));
    const audioPath = join(workspace, 'speech.mp3');
    await writeFile(audioPath, 'fake mp3 bytes');

    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ text: 'The speaker explains the main idea.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await new TranscribeAudioTool({
        apiKey: 'test-openai-key',
        baseUrl: 'https://speech.example/v1/',
      }).execute({ audioPath });

      expect(result).toEqual({
        status: 'success',
        output: 'The speaker explains the main idea.',
      });
      expect(requestUrl).toBe('https://speech.example/v1/audio/transcriptions');
      expect(requestInit?.method).toBe('POST');
      expect(requestInit?.headers).toEqual({ Authorization: 'Bearer test-openai-key' });
      expect(requestInit?.body).toBeInstanceOf(FormData);

      const form = requestInit?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-transcribe');
      const file = form.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe('speech.mp3');
      expect(await (file as File).text()).toBe('fake mp3 bytes');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects non-MP3 input before reading or calling the API', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const tool = new TranscribeAudioTool({ apiKey: 'test-openai-key' });

    await expect(tool.execute({ audioPath: 'speech.wav' })).resolves.toEqual({
      status: 'error',
      message: 'transcribe_audio only supports .mp3 audioPath',
    });
    await expect(tool.execute({ audioPath: 42 })).resolves.toEqual({
      status: 'error',
      message: 'transcribe_audio requires audioPath to be a string',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a clear Tool error when the audio file cannot be read', async () => {
    const missingPath = join(tmpdir(), 'agent-desktop-missing-speech.mp3');

    const result = await new TranscribeAudioTool({ apiKey: 'test-openai-key' }).execute({
      audioPath: missingPath,
    });

    expect(result.status).toBe('error');
    expect(result).toMatchObject({ message: expect.stringContaining('ENOENT') });
  });

  it('returns a Tool error for a non-2xx transcription response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => (
      new Response('unauthorized', { status: 401 })
    )));
    const fixture = await createTemporaryAudioFile();

    try {
      await expect(new TranscribeAudioTool({ apiKey: 'test-openai-key' }).execute({
        audioPath: fixture.audioPath,
      })).resolves.toEqual({
        status: 'error',
        message: 'OpenAI transcription request failed: 401',
      });
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it('rejects a successful response that has no string text', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => (
      new Response(JSON.stringify({}), { status: 200 })
    )));
    const fixture = await createTemporaryAudioFile();

    try {
      await expect(new TranscribeAudioTool({ apiKey: 'test-openai-key' }).execute({
        audioPath: fixture.audioPath,
      })).resolves.toEqual({
        status: 'error',
        message: 'OpenAI transcription response is missing text',
      });
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});

async function createTemporaryAudioFile(): Promise<{ workspace: string; audioPath: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-desktop-speech-fixture-'));
  const audioPath = join(workspace, 'speech.mp3');
  await writeFile(audioPath, 'fake mp3 bytes');
  return { workspace, audioPath };
}
