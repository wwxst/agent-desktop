import { describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import {
  AddAudioTool,
  ConcatVideosTool,
  ProbeMediaTool,
  TrimVideoTool,
  executeFileCommand,
  type CommandExecutor,
} from '../src/index.js';

const unusedExecutor: CommandExecutor = vi.fn(async () => ({ stdout: '', stderr: '' }));

describe('FFmpeg video tools', () => {
  it('executes a program with a direct argument array', async () => {
    const output = await executeFileCommand(process.execPath, [
      '-e',
      'process.stdout.write("stdout"); process.stderr.write("stderr")',
    ]);

    expect(output).toEqual({ stdout: 'stdout', stderr: 'stderr' });
  });

  it('reports a missing executable as a PATH error', async () => {
    await expect(executeFileCommand('agent-desktop-command-that-does-not-exist', []))
      .rejects.toThrow('agent-desktop-command-that-does-not-exist not found in PATH');
  });

  it('exposes the four model-visible Tool definitions', () => {
    const tools = [
      new ProbeMediaTool(unusedExecutor),
      new TrimVideoTool(unusedExecutor),
      new ConcatVideosTool(unusedExecutor),
      new AddAudioTool(unusedExecutor),
    ];

    expect(tools.map(({ name }) => name)).toEqual([
      'probe_media',
      'trim_video',
      'concat_videos',
      'add_audio',
    ]);
    expect(tools.every(({ description, inputSchema }) => (
      description.length > 0 && typeof inputSchema === 'object'
    ))).toBe(true);
  });

  it('rejects invalid inputs before starting FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();

    await expect(new ProbeMediaTool(executeCommand).execute({ inputPath: 42 })).resolves.toEqual({
      status: 'error',
      message: 'probe_media requires inputPath to be a string',
    });
    await expect(new TrimVideoTool(executeCommand).execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      start: -1,
      duration: 0,
    })).resolves.toEqual({
      status: 'error',
      message: 'trim_video requires start >= 0 and duration > 0',
    });
    await expect(new TrimVideoTool(executeCommand).execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      start: Number.NaN,
      duration: Number.POSITIVE_INFINITY,
    })).resolves.toEqual({
      status: 'error',
      message: 'trim_video requires start >= 0 and duration > 0',
    });
    await expect(new ConcatVideosTool(executeCommand).execute({
      inputPaths: [],
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'concat_videos requires a non-empty inputPaths string array and outputPath string',
    });
    await expect(new AddAudioTool(executeCommand).execute({
      videoPath: 'video.mp4',
      audioPath: 42,
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'add_audio requires videoPath, audioPath, and outputPath to be strings',
    });

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('maps ffprobe JSON to structured media information', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({
      stdout: JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
      stderr: '',
    }));
    const tool = new ProbeMediaTool(executeCommand);

    const result = await tool.execute({ inputPath: 'C:\\videos\\input.mp4' });

    expect(executeCommand).toHaveBeenCalledWith('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      'C:\\videos\\input.mp4',
    ]);
    expect(result).toEqual({
      status: 'success',
      output: {
        duration: 12.5,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
    });
  });

  it('returns empty media fields when matching streams are absent', async () => {
    const executeCommand: CommandExecutor = async () => ({
      stdout: JSON.stringify({ format: {}, streams: [] }),
      stderr: '',
    });

    await expect(new ProbeMediaTool(executeCommand).execute({
      inputPath: 'audio-or-empty.bin',
    })).resolves.toEqual({
      status: 'success',
      output: {
        duration: null,
        width: null,
        height: null,
        videoCodec: null,
        audioCodec: null,
      },
    });
  });

  it('converts ffprobe execution failures into Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('ffprobe failed: Invalid data found when processing input');
    };

    await expect(new ProbeMediaTool(executeCommand).execute({
      inputPath: 'broken.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'ffprobe failed: Invalid data found when processing input',
    });
  });

  it('builds stable trim arguments without a shell command string', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new TrimVideoTool(executeCommand);

    const result = await tool.execute({
      inputPath: 'input & keep.mp4',
      outputPath: 'trimmed.mp4',
      start: 5,
      duration: 10,
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input & keep.mp4',
      '-ss',
      '5',
      '-t',
      '10',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      'trimmed.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: trimmed.mp4' });
  });

  it('writes an ordered concat list and removes it after execution', async () => {
    let concatListPath = '';
    let concatListContent = '';
    const executeCommand = vi.fn<CommandExecutor>(async (_command, args) => {
      const inputIndex = args.indexOf('-i');
      concatListPath = args[inputIndex + 1] ?? '';
      concatListContent = await readFile(concatListPath, 'utf8');
      return { stdout: '', stderr: '' };
    });
    const tool = new ConcatVideosTool(executeCommand);

    const result = await tool.execute({
      inputPaths: ['C:\\videos\\one.mp4', 'C:\\videos\\two.mp4'],
      outputPath: 'C:\\videos\\joined.mp4',
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      'C:\\videos\\joined.mp4',
    ]);
    expect(concatListContent).toBe(
      "ffconcat version 1.0\nfile 'C:/videos/one.mp4'\nfile 'C:/videos/two.mp4'\n",
    );
    await expect(access(concatListPath)).rejects.toThrow();
    expect(result).toEqual({
      status: 'success',
      output: 'Video created: C:\\videos\\joined.mp4',
    });
  });

  it('builds add-audio arguments that keep the video duration', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new AddAudioTool(executeCommand);

    const result = await tool.execute({
      videoPath: 'video.mp4',
      audioPath: 'music.wav',
      outputPath: 'with-audio.mp4',
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'video.mp4',
      '-i',
      'music.wav',
      '-filter_complex',
      '[1:a:0]apad[audio]',
      '-map',
      '0:v:0',
      '-map',
      '[audio]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      'with-audio.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: with-audio.mp4' });
  });

  it('converts FFmpeg execution failures into concise Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('ffmpeg failed: Error opening output file');
    };

    await expect(new TrimVideoTool(executeCommand).execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      start: 0,
      duration: 1,
    })).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Error opening output file',
    });
    await expect(new AddAudioTool(executeCommand).execute({
      videoPath: 'video.mp4',
      audioPath: 'audio.wav',
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Error opening output file',
    });
  });

  it('reports malformed ffprobe JSON as a Tool error', async () => {
    const executeCommand: CommandExecutor = async () => ({ stdout: '{invalid', stderr: '' });

    await expect(new ProbeMediaTool(executeCommand).execute({
      inputPath: 'input.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'ffprobe returned invalid JSON',
    });
  });
});
