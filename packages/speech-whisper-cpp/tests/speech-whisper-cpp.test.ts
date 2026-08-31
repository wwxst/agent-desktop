import { describe, expect, it, vi } from 'vitest';
import { TranscribeAudioTool, type CommandExecutor } from '../src/index.js';

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

  it('uses whisper-cli defaults and returns trimmed stdout transcript', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({
      stdout: '  Hello from local Whisper.\r\n',
      stderr: 'whisper timing output',
    }));
    const tool = new TranscribeAudioTool({ modelPath: 'models/ggml-small.bin' }, executeCommand);

    await expect(tool.execute({ audioPath: 'speech.wav' })).resolves.toEqual({
      status: 'success',
      output: 'Hello from local Whisper.',
    });
    expect(executeCommand).toHaveBeenCalledWith('whisper-cli', [
      '-m',
      'models/ggml-small.bin',
      '-f',
      'speech.wav',
      '-l',
      'auto',
      '-np',
      '-nt',
    ]);
  });

  it('uses a custom whisper-cli command when configured', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '你好', stderr: '' }));
    const tool = new TranscribeAudioTool({
      modelPath: 'C:\\models\\ggml-small.bin',
      command: 'C:\\tools\\whisper-cli.exe',
    }, executeCommand);

    await expect(tool.execute({ audioPath: 'speech.wav' })).resolves.toEqual({
      status: 'success',
      output: '你好',
    });
    expect(executeCommand).toHaveBeenCalledWith('C:\\tools\\whisper-cli.exe', [
      '-m',
      'C:\\models\\ggml-small.bin',
      '-f',
      'speech.wav',
      '-l',
      'auto',
      '-np',
      '-nt',
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

  it('reports empty transcripts as Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => ({ stdout: ' \n\r\n', stderr: '' });

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
