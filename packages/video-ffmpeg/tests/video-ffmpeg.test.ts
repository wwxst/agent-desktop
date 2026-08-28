import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  CropVideoTool,
  ExtractVideoFramesTool,
  ProbeMediaTool,
  ResizeVideoTool,
  SetSpeedTool,
  TrimVideoTool,
  executeFileCommand,
  type CommandExecutor,
} from '../src/index.js';

const unusedExecutor: CommandExecutor = vi.fn(async () => ({ stdout: '', stderr: '' }));
const escapedFilterQuote = "'" + '\\'.repeat(3) + "''";

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

  it('exposes the nine model-visible Tool definitions', () => {
    const tools = [
      new ProbeMediaTool(unusedExecutor),
      new ExtractVideoFramesTool(unusedExecutor),
      new TrimVideoTool(unusedExecutor),
      new ConcatVideosTool(unusedExecutor),
      new AddAudioTool(unusedExecutor),
      new AddSubtitlesTool(unusedExecutor),
      new ResizeVideoTool(unusedExecutor),
      new CropVideoTool(unusedExecutor),
      new SetSpeedTool(unusedExecutor),
    ];

    expect(tools.map(({ name }) => name)).toEqual([
      'probe_media',
      'extract_video_frames',
      'trim_video',
      'concat_videos',
      'add_audio',
      'add_subtitles',
      'resize_video',
      'crop_video',
      'set_speed',
    ]);
    expect(tools.every(({ description, inputSchema }) => (
      description.length > 0 && typeof inputSchema === 'object'
    ))).toBe(true);
  });

  it('defines extract_video_frames with only videoPath and outputDir inputs', () => {
    const tool = new ExtractVideoFramesTool(unusedExecutor);

    expect(tool.name).toBe('extract_video_frames');
    expect(tool.inputSchema).toMatchObject({
      required: ['videoPath', 'outputDir'],
      properties: {
        videoPath: { type: 'string' },
        outputDir: { type: 'string' },
      },
    });
  });

  it('extracts six evenly spaced frames without using the first or last timestamp', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-frame-test-'));
    try {
      const executeCommand = vi.fn<CommandExecutor>(async (command) => (
        command === 'ffprobe'
          ? {
            stdout: JSON.stringify({ format: { duration: '42' }, streams: [] }),
            stderr: '',
          }
          : { stdout: '', stderr: '' }
      ));
      const tool = new ExtractVideoFramesTool(executeCommand);

      await expect(tool.execute({ videoPath: 'input.mp4', outputDir })).resolves.toEqual({
        status: 'success',
        output: {
          duration: 42,
          frames: [1, 2, 3, 4, 5, 6].map((index) => ({
            timestamp: (42 * index) / 7,
            path: join(outputDir, `frame-${String(index).padStart(3, '0')}.jpg`),
          })),
        },
      });

      expect(executeCommand).toHaveBeenNthCalledWith(1, 'ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'input.mp4',
      ]);
      for (const [index, timestamp] of [6, 12, 18, 24, 30, 36].entries()) {
        expect(executeCommand).toHaveBeenNthCalledWith(index + 2, 'ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(timestamp),
          '-i',
          'input.mp4',
          '-frames:v',
          '1',
          '-vf',
          "scale='min(640,iw)':-2",
          '-q:v',
          '2',
          join(outputDir, `frame-${String(index + 1).padStart(3, '0')}.jpg`),
        ]);
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('returns extraction errors without hiding the failing command', async () => {
    const executeCommand: CommandExecutor = async (command) => {
      if (command === 'ffprobe') throw new Error('ffprobe failed: broken input');
      throw new Error('ffmpeg failed: cannot write frame');
    };
    const tool = new ExtractVideoFramesTool(executeCommand);

    await expect(tool.execute({ videoPath: 'broken.mp4', outputDir: 'frames' })).resolves.toEqual({
      status: 'error',
      message: 'ffprobe failed: broken input',
    });
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

  it('defines add_subtitles as an SRT burn-in Tool', () => {
    const tool = new AddSubtitlesTool(unusedExecutor);

    expect(tool.name).toBe('add_subtitles');
    expect(tool.description).toContain('SRT');
    expect(tool.inputSchema).toMatchObject({
      properties: {
        videoPath: { type: 'string' },
        subtitlePath: { type: 'string' },
        outputPath: { type: 'string' },
      },
      required: ['videoPath', 'subtitlePath', 'outputPath'],
    });
  });

  it('rejects invalid add_subtitles input and non-SRT subtitles', async () => {
    const executeCommand = vi.fn<CommandExecutor>();
    const tool = new AddSubtitlesTool(executeCommand);

    await expect(tool.execute({
      videoPath: 'input.mp4',
      subtitlePath: 42,
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'add_subtitles requires videoPath, subtitlePath, and outputPath to be strings',
    });
    await expect(tool.execute({
      videoPath: 'input.mp4',
      subtitlePath: 'subtitle.ass',
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'add_subtitles only supports .srt subtitle files',
    });

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    [
      'C:\\videos\\subtitle.srt',
      "subtitles=filename='C\\:/videos/subtitle.srt'",
    ],
    [
      'C:\\my videos\\subtitle file.srt',
      "subtitles=filename='C\\:/my videos/subtitle file.srt'",
    ],
    [
      'C:\\videos\\part,one[final];x=1.srt',
      "subtitles=filename='C\\:/videos/part\\,one\\[final\\]\\;x\\=1.srt'",
    ],
    [
      "C:\\videos\\subtitle's.srt",
      "subtitles=filename='C\\:/videos/subtitle" + escapedFilterQuote + "s.srt'",
    ],
  ])('escapes an SRT path for the subtitles filter: %s', async (subtitlePath, filter) => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new AddSubtitlesTool(executeCommand);

    const result = await tool.execute({
      videoPath: 'input.mp4',
      subtitlePath,
      outputPath: 'output.mp4',
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input.mp4',
      '-vf',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-c:a',
      'copy',
      'output.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: output.mp4' });
  });

  it('reports an unavailable subtitles filter explicitly', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error("ffmpeg failed: No such filter: 'subtitles'");
    };

    await expect(new AddSubtitlesTool(executeCommand).execute({
      videoPath: 'input.mp4',
      subtitlePath: 'subtitle.srt',
      outputPath: 'output.mp4',
    })).resolves.toEqual({
      status: 'error',
      message: 'FFmpeg subtitles filter is not available',
    });
  });

  it('defines resize_video and crop_video with their required inputs', () => {
    const resize = new ResizeVideoTool(unusedExecutor);
    const crop = new CropVideoTool(unusedExecutor);

    expect(resize.name).toBe('resize_video');
    expect(resize.inputSchema).toMatchObject({
      required: ['inputPath', 'outputPath', 'width', 'height'],
    });
    expect(crop.name).toBe('crop_video');
    expect(crop.inputSchema).toMatchObject({
      required: ['inputPath', 'outputPath', 'x', 'y', 'width', 'height'],
    });
  });

  it('validates resize dimensions before starting FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();
    const tool = new ResizeVideoTool(executeCommand);

    await expect(tool.execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      width: 0,
      height: Number.POSITIVE_INFINITY,
    })).resolves.toEqual({
      status: 'error',
      message: 'resize_video requires finite width > 0 and height > 0',
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('builds direct scale arguments for resize_video', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new ResizeVideoTool(executeCommand);

    const result = await tool.execute({
      inputPath: 'input.mp4',
      outputPath: 'portrait.mp4',
      width: 1080,
      height: 1920,
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input.mp4',
      '-vf',
      'scale=1080:1920',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-c:a',
      'copy',
      'portrait.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: portrait.mp4' });
  });

  it('validates crop coordinates and dimensions before starting FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();
    const tool = new CropVideoTool(executeCommand);

    await expect(tool.execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      x: -1,
      y: Number.NaN,
      width: 0,
      height: 360,
    })).resolves.toEqual({
      status: 'error',
      message: 'crop_video requires finite x >= 0, y >= 0, width > 0, and height > 0',
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('builds direct crop arguments for crop_video', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new CropVideoTool(executeCommand);

    const result = await tool.execute({
      inputPath: 'input.mp4',
      outputPath: 'cropped.mp4',
      x: 100,
      y: 50,
      width: 640,
      height: 360,
    });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input.mp4',
      '-vf',
      'crop=640:360:100:50',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-c:a',
      'copy',
      'cropped.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: cropped.mp4' });
  });

  it('defines set_speed with the supported speed range', () => {
    const tool = new SetSpeedTool(unusedExecutor);

    expect(tool.name).toBe('set_speed');
    expect(tool.inputSchema).toMatchObject({
      properties: {
        speed: { type: 'number', minimum: 0.5, maximum: 2 },
      },
      required: ['inputPath', 'outputPath', 'speed'],
    });
  });

  it.each([0.49, 2.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsupported speed %s before probing media',
    async (speed) => {
      const executeCommand = vi.fn<CommandExecutor>();
      const tool = new SetSpeedTool(executeCommand);

      await expect(tool.execute({
        inputPath: 'input.mp4',
        outputPath: 'output.mp4',
        speed,
      })).resolves.toEqual({
        status: 'error',
        message: 'set_speed requires a finite speed between 0.5 and 2.0',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    },
  );

  it('keeps video and audio synchronized when an audio stream exists', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? { stdout: '1\n', stderr: '' }
        : { stdout: '', stderr: '' }
    ));
    const tool = new SetSpeedTool(executeCommand);

    const result = await tool.execute({
      inputPath: 'input.mp4',
      outputPath: 'faster.mp4',
      speed: 1.5,
    });

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      'input.mp4',
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input.mp4',
      '-filter_complex',
      '[0:v:0]setpts=PTS/1.5[video];[0:a:0]atempo=1.5[audio]',
      '-map',
      '[video]',
      '-map',
      '[audio]',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      'faster.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: faster.mp4' });
  });

  it('changes only video timing when no audio stream exists', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? { stdout: '', stderr: '' }
        : { stdout: '', stderr: '' }
    ));
    const tool = new SetSpeedTool(executeCommand);

    const result = await tool.execute({
      inputPath: 'silent.mp4',
      outputPath: 'slower.mp4',
      speed: 0.5,
    });

    expect(executeCommand).toHaveBeenNthCalledWith(2, 'ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'silent.mp4',
      '-vf',
      'setpts=PTS/0.5',
      '-map',
      '0:v:0',
      '-an',
      '-c:v',
      'libx264',
      'slower.mp4',
    ]);
    expect(result).toEqual({ status: 'success', output: 'Video created: slower.mp4' });
  });
});
