import { access, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { TranscribeAudioTool, type CommandExecutor } from '../src/index.js';

function getOutputBase(args: readonly string[]): string {
  const outputFlagIndex = args.indexOf('-of');
  const outputBase = args[outputFlagIndex + 1];
  if (outputFlagIndex === -1 || outputBase === undefined) {
    throw new Error('Missing whisper-cli -of output base');
  }
  return outputBase;
}

async function writeWhisperOutput(args: readonly string[], contents: string): Promise<string> {
  const outputBase = getOutputBase(args);
  await writeFile(`${outputBase}.json`, contents);
  return outputBase;
}

describe('whisper.cpp speech tools', () => {
  it('uses the transcribe_audio WAV contract and required model path', () => {
    const tool = new TranscribeAudioTool({ modelPath: 'models/ggml-small.bin' });

    expect(tool.name).toBe('transcribe_audio');
    expect(tool.description).toContain('WAV');
    expect(tool.inputSchema).toMatchObject({
      properties: { audioPath: { type: 'string' } },
      required: ['audioPath'],
    });
  });

  it('uses official JSON output and returns a segment timeline', async () => {
    let outputBase: string | undefined;
    const executeCommand = vi.fn<CommandExecutor>(async (_command, args) => {
      outputBase = await writeWhisperOutput(args, JSON.stringify({
        transcription: [
          {
            timestamps: { from: '00:00:00,000', to: '00:00:03,000' },
            offsets: { from: 0, to: 3000 },
            text: ' hello ',
          },
          {
            offsets: { from: 3000, to: 7000 },
            text: ' world ',
          },
        ],
      }));
      return { stdout: 'stdout is not the transcript source', stderr: '' };
    });
    const tool = new TranscribeAudioTool({ modelPath: 'models/ggml-small.bin' }, executeCommand);

    await expect(tool.execute({ audioPath: 'speech.wav' })).resolves.toEqual({
      status: 'success',
      output: {
        text: 'hello world',
        segments: [
          { start: 0, end: 3, text: 'hello' },
          { start: 3, end: 7, text: 'world' },
        ],
      },
    });
    expect(executeCommand).toHaveBeenCalledWith('whisper-cli', [
      '-m',
      'models/ggml-small.bin',
      '-f',
      'speech.wav',
      '-l',
      'auto',
      '-np',
      '-oj',
      '-of',
      expect.any(String),
    ]);
    if (outputBase === undefined) throw new Error('Whisper output base was not captured');
    await expect(access(`${outputBase}.json`)).rejects.toThrow();
  });

  it('uses a custom whisper-cli command when configured', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async (_command, args) => {
      await writeWhisperOutput(args, JSON.stringify({
        transcription: [{ offsets: { from: 0, to: 1800 }, text: ' 你好 ' }],
      }));
      return { stdout: '', stderr: '' };
    });
    const tool = new TranscribeAudioTool({
      modelPath: 'C:\\models\\ggml-small.bin',
      command: 'C:\\tools\\whisper-cli.exe',
    }, executeCommand);

    await expect(tool.execute({ audioPath: 'speech.wav' })).resolves.toEqual({
      status: 'success',
      output: {
        text: '你好',
        segments: [{ start: 0, end: 1.8, text: '你好' }],
      },
    });
    expect(executeCommand).toHaveBeenCalledWith('C:\\tools\\whisper-cli.exe', [
      '-m',
      'C:\\models\\ggml-small.bin',
      '-f',
      'speech.wav',
      '-l',
      'auto',
      '-np',
      '-oj',
      '-of',
      expect.any(String),
    ]);
  });

  it('rejects non-WAV input and missing model configuration before starting the process', async () => {
    const executeCommand = vi.fn<CommandExecutor>();

    await expect(new TranscribeAudioTool({ modelPath: 'models/ggml-small.bin' }, executeCommand)
      .execute({ audioPath: 'speech.mp3' })).resolves.toEqual({
        status: 'error',
        message: 'transcribe_audio only supports .wav audioPath',
      });
    expect(() => new TranscribeAudioTool({ modelPath: '  ' }, executeCommand))
      .toThrow('modelPath is required');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', 'not JSON', 'Whisper produced invalid JSON'],
    ['non-object root', '[]', 'Whisper JSON root must be an object'],
    ['missing transcription', '{}', 'Whisper JSON transcription must be an array'],
    [
      'missing segment text',
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 } }] }),
      'Whisper JSON segment 0 text must be a string',
    ],
    [
      'missing offsets',
      JSON.stringify({ transcription: [{ text: 'hello' }] }),
      'Whisper JSON segment 0 offsets must be an object',
    ],
    [
      'non-numeric offsets',
      JSON.stringify({ transcription: [{ text: 'hello', offsets: { from: '0', to: 1000 } }] }),
      'Whisper JSON segment 0 offsets.from and offsets.to must be finite numbers',
    ],
    [
      'invalid offset range',
      JSON.stringify({ transcription: [{ text: 'hello', offsets: { from: 2000, to: 1000 } }] }),
      'Whisper JSON segment 0 offsets must satisfy 0 <= from <= to',
    ],
  ])('rejects %s and cleans the temporary JSON', async (_name, contents, expectedMessage) => {
    let outputBase: string | undefined;
    const executeCommand: CommandExecutor = async (_command, args) => {
      outputBase = await writeWhisperOutput(args, contents);
      return { stdout: '', stderr: '' };
    };

    await expect(new TranscribeAudioTool({ modelPath: 'model.bin' }, executeCommand)
      .execute({ audioPath: 'speech.wav' })).resolves.toEqual({
        status: 'error',
        message: expectedMessage,
      });
    if (outputBase === undefined) throw new Error('Whisper output base was not captured');
    await expect(access(`${outputBase}.json`)).rejects.toThrow();
  });

  it('reports empty transcripts as Tool errors', async () => {
    const executeCommand: CommandExecutor = async (_command, args) => {
      await writeWhisperOutput(args, JSON.stringify({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: '  ' }],
      }));
      return { stdout: '', stderr: '' };
    };

    await expect(new TranscribeAudioTool({ modelPath: 'model.bin' }, executeCommand)
      .execute({ audioPath: 'speech.wav' })).resolves.toEqual({
        status: 'error',
        message: 'Whisper produced an empty transcript',
      });
  });

  it('returns whisper-cli failures as Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('whisper-cli failed: model not found');
    };

    await expect(new TranscribeAudioTool({ modelPath: 'model.bin' }, executeCommand)
      .execute({ audioPath: 'speech.wav' })).resolves.toEqual({
        status: 'error',
        message: 'whisper-cli failed: model not found',
      });
  });
});
