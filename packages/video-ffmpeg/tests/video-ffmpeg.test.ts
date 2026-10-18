import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  CropVideoTool,
  DecodeVideoTool,
  DetectBlackSegmentsTool,
  ExtractAudioTool,
  ExtractVideoSegmentFramesTool,
  ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool,
  ProbeMediaTool,
  ResizeVideoTool,
  SetSpeedTool,
  TrimVideoTool,
  executeFileCommand,
  type CommandExecutor,
} from '../src/index.js';

const unusedExecutor: CommandExecutor = vi.fn(async () => ({ stdout: '', stderr: '' }));
const escapedFilterQuote = "'" + '\\'.repeat(3) + "''";

/** 测试用的最小执行上下文：只提供当前用例真正使用的取消信号。 */
function toolContext(signal?: AbortSignal): ToolExecutionContext {
  return {
    toolCallId: 'test-call' as ToolExecutionContext['toolCallId'],
    reportProgress: () => {},
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * 真实媒体测试需要本机 ffmpeg/ffprobe。
 * 缺少二进制时明确 skip 而不是伪装成通过；本机存在时该测试真实执行。
 */
const realFfmpegAvailable = await executeFileCommand('ffprobe', ['-version'])
  .then(() => true)
  .catch(() => false);

/** 用 lavfi 生成一个无音轨片段，作为 concat 的真实媒体夹具。 */
async function createSilentClip(path: string, color: string): Promise<void> {
  await executeFileCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=64x64:d=1`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    path,
  ]);
}

interface ProbedStream {
  readonly codec_type: string;
}

/** 读取真实输出的容器时长和流列表，用于断言拼接结果的时长与音轨。 */
async function probeRealMedia(path: string): Promise<{
  readonly duration: number;
  readonly streams: readonly ProbedStream[];
}> {
  const { stdout } = await executeFileCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const payload = JSON.parse(stdout) as {
    format: { duration: string };
    streams: ProbedStream[];
  };

  return { duration: Number(payload.format.duration), streams: payload.streams };
}

describe('FFmpeg video tools', () => {
  it('aborts a running child process', async () => {
    const controller = new AbortController();
    const running = executeFileCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

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

  it('exposes the thirteen model-visible Tool definitions', () => {
    const tools = [
      new ProbeMediaTool(unusedExecutor),
      new DecodeVideoTool(unusedExecutor),
      new DetectBlackSegmentsTool(unusedExecutor),
      new ExtractVideoFramesTool(unusedExecutor),
      new ExtractVideoRangeFramesTool(unusedExecutor),
      new TrimVideoTool(unusedExecutor),
      new ConcatVideosTool(unusedExecutor),
      new ExtractAudioTool(unusedExecutor),
      new AddAudioTool(unusedExecutor),
      new AddSubtitlesTool(unusedExecutor),
      new ResizeVideoTool(unusedExecutor),
      new CropVideoTool(unusedExecutor),
      new SetSpeedTool(unusedExecutor),
    ];

    expect(tools.map(({ name }) => name)).toEqual([
      'probe_media',
      'decode_video',
      'detect_black_segments',
      'extract_video_frames',
      'extract_video_range_frames',
      'trim_video',
      'concat_videos',
      'extract_audio',
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

  it('defines extract_audio as a WAV-only Tool', () => {
    const tool = new ExtractAudioTool(unusedExecutor);

    expect(tool.name).toBe('extract_audio');
    expect(tool.description).toContain('WAV');
    expect(tool.inputSchema).toMatchObject({
      properties: {
        videoPath: { type: 'string' },
        outputPath: { type: 'string' },
      },
      required: ['videoPath', 'outputPath'],
    });
  });

  it('rejects non-WAV extract_audio outputs before running FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();
    const tool = new ExtractAudioTool(executeCommand);

    await expect(tool.execute({
      videoPath: 'input.mp4',
      outputPath: 'audio.mp3',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_audio only supports .wav outputPath',
    });
    await expect(tool.execute({
      videoPath: 42,
      outputPath: 'audio.wav',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_audio requires videoPath and outputPath to be strings',
    });

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('builds mono 16 kHz 16-bit WAV extraction arguments', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new ExtractAudioTool(executeCommand);

    await expect(tool.execute({
      videoPath: 'input video.mp4',
      outputPath: 'speech.wav',
    }, toolContext())).resolves.toEqual({ status: 'success', output: 'Audio created: speech.wav' });

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'input video.mp4',
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      'speech.wav',
    ]);
  });

  it('returns extract_audio execution failures as Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('ffmpeg failed: cannot extract audio');
    };

    await expect(new ExtractAudioTool(executeCommand).execute({
      videoPath: 'broken.mp4',
      outputPath: 'speech.wav',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: cannot extract audio',
    });
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

      await expect(tool.execute({ videoPath: 'input.mp4', outputDir }, toolContext())).resolves.toEqual({
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
          '-n',
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

    await expect(tool.execute({ videoPath: 'broken.mp4', outputDir: 'frames' }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffprobe failed: broken input',
    });
  });

  it('extracts bounded segments into a unique output namespace', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-segment-frame-test-'));
    try {
      const executeCommand = vi.fn<CommandExecutor>(async (command, args) => {
        if (command === 'ffprobe') return { stdout: JSON.stringify({ frames: [0, 1, 2, 3, 4].map(timestamp => ({ best_effort_timestamp_time: String(timestamp) })) }), stderr: '' };
        await writeFile(join(outputDir, 'segment-000000000000-000001.jpg'), 'frame 1');
        await writeFile(join(outputDir, 'segment-000000000000-000002.jpg'), 'frame 2');
        return { stdout: '', stderr: '' };
      });
      await writeFile(join(outputDir, 'segment-000000000002-000001.jpg'), 'old segment');
      const result = await new ExtractVideoSegmentFramesTool(executeCommand).execute({ inputPath: 'input.mp4', outputDir, startFrame: 0, maxFrames: 2 }, toolContext());
      expect(result).toEqual({ status: 'success', output: {
        complete: true, totalFrames: 5, startFrame: 0, endFrame: 2, startTime: 0, endTime: 2,
        frames: [0, 1].map((timestamp, index) => ({ timestamp, path: join(outputDir, `segment-000000000000-${String(index + 1).padStart(6, '0')}.jpg`) })),
      } });
      expect(executeCommand).toHaveBeenNthCalledWith(2, 'ffmpeg', [
        '-n', '-hide_banner', '-loglevel', 'error', '-i', 'input.mp4', '-map', '0:v:0',
        '-vf', 'select=between(n\\,0\\,1)', '-fps_mode', 'passthrough', '-q:v', '2',
        join(outputDir, 'segment-000000000000-%06d.jpg'),
      ], undefined);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  it('rejects rerunning a segment into a directory containing its prior frames', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-segment-frame-reuse-test-'));
    try {
      const executeCommand = vi.fn<CommandExecutor>(async (command) => command === 'ffprobe'
        ? { stdout: JSON.stringify({ frames: [0, 1].map(timestamp => ({ best_effort_timestamp_time: String(timestamp) })) }), stderr: '' }
        : { stdout: '', stderr: '' });
      await writeFile(join(outputDir, 'segment-000000000000-000001.jpg'), 'existing');
      await expect(new ExtractVideoSegmentFramesTool(executeCommand).execute({ inputPath: 'input.mp4', outputDir, startFrame: 0 }, toolContext()))
        .resolves.toEqual({ status: 'error', message: expect.stringContaining('输出目录已包含本段文件') });
      expect(executeCommand).toHaveBeenCalledTimes(1);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  it('defines extract_video_range_frames with absolute range inputs', () => {
    const tool = new ExtractVideoRangeFramesTool(unusedExecutor);

    expect(tool.name).toBe('extract_video_range_frames');
    expect(tool.inputSchema).toMatchObject({
      required: ['videoPath', 'outputDir', 'start', 'end'],
      properties: {
        videoPath: { type: 'string' },
        outputDir: { type: 'string' },
        start: { type: 'number', minimum: 0 },
        end: { type: 'number' },
      },
    });
  });

  it('validates range frame inputs before starting FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();
    const tool = new ExtractVideoRangeFramesTool(executeCommand);

    await expect(tool.execute({
      videoPath: 42,
      outputDir: 'frames',
      start: 10,
      end: 20,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_video_range_frames requires videoPath and outputDir to be strings',
    });
    await expect(tool.execute({
      videoPath: 'input.mp4',
      outputDir: 'frames',
      start: -1,
      end: 20,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_video_range_frames requires finite start >= 0 and end > start',
    });
    await expect(tool.execute({
      videoPath: 'input.mp4',
      outputDir: 'frames',
      start: 10,
      end: 10,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_video_range_frames requires finite start >= 0 and end > start',
    });
    await expect(tool.execute({
      videoPath: 'input.mp4',
      outputDir: 'frames',
      start: Number.NaN,
      end: Number.POSITIVE_INFINITY,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'extract_video_range_frames requires finite start >= 0 and end > start',
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('extracts six range frames using absolute video timestamps', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-range-frame-test-'));
    try {
      const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
      const tool = new ExtractVideoRangeFramesTool(executeCommand);
      const timestamps = [12, 14, 16, 18, 20, 22];

      await expect(tool.execute({
        videoPath: 'input.mp4',
        outputDir,
        start: 10,
        end: 24,
      }, toolContext())).resolves.toEqual({
        status: 'success',
        output: {
          start: 10,
          end: 24,
          frames: timestamps.map((timestamp, index) => ({
            timestamp,
            path: join(outputDir, `frame-${String(index + 1).padStart(3, '0')}.jpg`),
          })),
        },
      });

      for (const [index, timestamp] of timestamps.entries()) {
        expect(executeCommand).toHaveBeenNthCalledWith(index + 1, 'ffmpeg', [
          '-n',
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

  it('returns range extraction command errors as Tool results', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('ffmpeg failed: cannot seek range');
    };

    await expect(new ExtractVideoRangeFramesTool(executeCommand).execute({
      videoPath: 'input.mp4',
      outputDir: 'frames',
      start: 10,
      end: 20,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: cannot seek range',
    });
  });

  it('rejects invalid inputs before starting FFmpeg', async () => {
    const executeCommand = vi.fn<CommandExecutor>();

    await expect(new ProbeMediaTool(executeCommand).execute({ inputPath: 42 }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'probe_media requires inputPath to be a string',
    });
    await expect(new DetectBlackSegmentsTool(executeCommand).execute({ inputPath: 42 }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'detect_black_segments requires inputPath to be a string',
    });
    await expect(new TrimVideoTool(executeCommand).execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      start: -1,
      duration: 0,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'trim_video requires start >= 0 and duration > 0',
    });
    await expect(new TrimVideoTool(executeCommand).execute({
      inputPath: 'input.mp4',
      outputPath: 'output.mp4',
      start: Number.NaN,
      duration: Number.POSITIVE_INFINITY,
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'trim_video requires start >= 0 and duration > 0',
    });
    await expect(new ConcatVideosTool(executeCommand).execute({
      inputPaths: [],
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'concat_videos requires a non-empty inputPaths string array and outputPath string',
    });
    await expect(new AddAudioTool(executeCommand).execute({
      videoPath: 'video.mp4',
      audioPath: 42,
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
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

    const result = await tool.execute({ inputPath: 'C:\\videos\\input.mp4' }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      'C:\\videos\\input.mp4',
    ]);
    // 结果保留真实被探测的路径：候选验收要能证明证据属于哪一个文件。
    expect(result).toEqual({
      status: 'success',
      output: {
        inputPath: 'C:\\videos\\input.mp4',
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
    }, toolContext())).resolves.toEqual({
      status: 'success',
      output: {
        inputPath: 'audio-or-empty.bin',
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
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffprobe failed: Invalid data found when processing input',
    });
  });

  it('detects black segments with fixed FFmpeg blackdetect parameters', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({
      stdout: '',
      stderr: [
        '[blackdetect @ 000001] black_start:0 black_end:1.125 black_duration:1.125',
        '[blackdetect @ 000001] black_start:4.666667 black_end:5.5 black_duration:0.833333',
      ].join('\n'),
    }));
    const tool = new DetectBlackSegmentsTool(executeCommand);

    const result = await tool.execute({ inputPath: 'final.mp4' }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-hide_banner',
      '-i',
      'final.mp4',
      '-vf',
      // 过滤器文本与结果里报告的参数来自同一组常量：报告值不可能与实际检测不一致。
      'blackdetect=d=0.04:pix_th=0.1',
      '-an',
      '-f',
      'null',
      '-',
    ]);
    // 结果同时报告真实路径与实际生效的参数：历史结论必须能解释成「在这组参数下」的结果。
    expect(result).toEqual({
      status: 'success',
      output: {
        inputPath: 'final.mp4',
        hasBlackSegments: true,
        segments: [
          { start: 0, end: 1.125, duration: 1.125 },
          { start: 4.666667, end: 5.5, duration: 0.833333 },
        ],
        parameters: { minimumDurationSeconds: 0.04, pixelThreshold: 0.1 },
      },
    });
  });

  it('returns an empty black segment list when blackdetect finds none', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: 'frame=10 fps=0.0' }));

    await expect(new DetectBlackSegmentsTool(executeCommand).execute({ inputPath: 'clean.mp4' }, toolContext())).resolves.toEqual({
      status: 'success',
      output: {
        inputPath: 'clean.mp4',
        hasBlackSegments: false,
        segments: [],
        parameters: { minimumDurationSeconds: 0.04, pixelThreshold: 0.1 },
      },
    });
  });

  it('returns blackdetect execution failures as Tool errors', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error('ffmpeg failed: Invalid data found when processing input');
    };

    await expect(new DetectBlackSegmentsTool(executeCommand).execute({
      inputPath: 'broken.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Invalid data found when processing input',
    });
  });

  it('decodes the whole file and reports the real input path', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? {
          stdout: JSON.stringify({
            format: { duration: '5.04' },
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }],
          }),
          stderr: '',
        }
        : { stdout: '', stderr: '' }
    ));

    const result = await new DecodeVideoTool(executeCommand).execute({
      inputPath: 'candidate.mp4',
    }, toolContext());

    // 全文件解码到 null：只有整段都能读出时才算通过。
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      'candidate.mp4',
      '-f',
      'null',
      '-',
    ]);
    expect(result).toEqual({
      status: 'success',
      output: {
        inputPath: 'candidate.mp4',
        hasVideoStream: true,
        videoCodec: 'h264',
        durationSeconds: 5.04,
        fullyDecoded: true,
      },
    });
  });

  it('reports a file without a video stream as not decodable without running the decoder', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({
      stdout: JSON.stringify({ format: { duration: '3' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }),
      stderr: '',
    }));

    await expect(new DecodeVideoTool(executeCommand).execute({
      inputPath: 'audio-only.m4a',
    }, toolContext())).resolves.toEqual({
      status: 'success',
      output: {
        inputPath: 'audio-only.m4a',
        hasVideoStream: false,
        videoCodec: null,
        durationSeconds: 3,
        fullyDecoded: false,
      },
    });
    // 没有视频流时不需要再解码：结论已经是「不是可用视频」。
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('reports a file the decoder cannot read as not fully decoded instead of a Tool error', async () => {
    const executeCommand: CommandExecutor = async (command) => {
      if (command === 'ffprobe') {
        return {
          stdout: JSON.stringify({
            format: { duration: '5' },
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }],
          }),
          stderr: '',
        };
      }
      throw new Error('ffmpeg failed: Invalid data found when processing input');
    };

    // 进程正常运行后报错说明这段媒体自身不能完整解码，是真实检查结论而不是工具不可用。
    await expect(new DecodeVideoTool(executeCommand).execute({
      inputPath: 'truncated.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'success',
      output: {
        inputPath: 'truncated.mp4',
        hasVideoStream: true,
        videoCodec: 'h264',
        durationSeconds: 5,
        fullyDecoded: false,
      },
    });
  });

  it('propagates cancellation during full-file decoding', async () => {
    const executeCommand: CommandExecutor = async (command) => {
      if (command === 'ffprobe') {
        return {
          stdout: JSON.stringify({
            format: { duration: '5' },
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }],
          }),
          stderr: '',
        };
      }
      throw new DOMException('The operation was aborted', 'AbortError');
    };

    await expect(new DecodeVideoTool(executeCommand).execute({
      inputPath: 'cancelled.mp4',
    }, toolContext())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a missing ffmpeg binary as a Tool error', async () => {
    const executeCommand: CommandExecutor = async (command) => {
      if (command === 'ffprobe') {
        return {
          stdout: JSON.stringify({
            format: { duration: '5' },
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }],
          }),
          stderr: '',
        };
      }
      throw new Error('ffmpeg not found in PATH');
    };

    // 工具不可用和文件不可解码是两件不同的事，不能混为一谈。
    await expect(new DecodeVideoTool(executeCommand).execute({
      inputPath: 'candidate.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg not found in PATH',
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
    }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
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
    // 写出型工具只报告结构化生产事实，不直接登记 artifacts。
    expect(result).toEqual({ status: 'success', output: { outputPath: 'trimmed.mp4' } });
  });

  it('refuses to overwrite an existing user output file before starting FFmpeg', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-overwrite-test-'));
    try {
      const outputPath = join(directory, 'existing.mp4');
      await writeFile(outputPath, 'original bytes', 'utf8');
      const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));

      await expect(new TrimVideoTool(executeCommand).execute({
        inputPath: 'input.mp4',
        outputPath,
        start: 0,
        duration: 1,
      }, toolContext())).resolves.toEqual({
        status: 'error',
        message: `Output file already exists and will not be overwritten: ${outputPath}`,
      });

      // 冲突在启动 FFmpeg 之前判定，已有文件内容保持不变。
      expect(executeCommand).not.toHaveBeenCalled();
      await expect(readFile(outputPath, 'utf8')).resolves.toBe('original bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing extracted frame files', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-desktop-frame-overwrite-test-'));
    try {
      const existingFrame = join(outputDir, 'frame-001.jpg');
      await writeFile(existingFrame, 'existing frame', 'utf8');
      const executeCommand = vi.fn<CommandExecutor>(async (command) => (
        command === 'ffprobe'
          ? { stdout: JSON.stringify({ format: { duration: '42' }, streams: [] }), stderr: '' }
          : { stdout: '', stderr: '' }
      ));

      const result = await new ExtractVideoFramesTool(executeCommand).execute({
        videoPath: 'input.mp4',
        outputDir,
      }, toolContext());

      expect(result.status).toBe('error');
      expect(result.status === 'error' ? result.message : '').toContain(existingFrame);
      // 已有抽帧文件不被改写，后续帧也不再继续抽取。
      await expect(readFile(existingFrame, 'utf8')).resolves.toBe('existing frame');
      expect(executeCommand).toHaveBeenCalledTimes(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('concatenates every input through the concat filter in input order', async () => {
    // 三段都有音轨：探测返回音轨存在，走「视频+音频」一起拼接的路径。
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? { stdout: '1\n', stderr: '' }
        : { stdout: '', stderr: '' }
    ));
    const tool = new ConcatVideosTool(executeCommand);
    const inputPaths = ['C:\\videos\\one.mp4', 'C:\\videos\\two.mp4', 'C:\\videos\\three.mp4'];

    const result = await tool.execute({ inputPaths, outputPath: 'C:\\videos\\joined.mp4' }, toolContext());

    // 每段各自作为 -i 输入并显式贡献视频与音频；参数中不出现 concat demuxer，
    // 该 demuxer 会沿用首段音频参数，把采样率不同的后续片段静默丢弃。
    for (const [index, inputPath] of inputPaths.entries()) {
      expect(executeCommand).toHaveBeenNthCalledWith(index + 1, 'ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        inputPath,
      ]);
    }
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'ffmpeg', [
      '-n',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'C:\\videos\\one.mp4',
      '-i',
      'C:\\videos\\two.mp4',
      '-i',
      'C:\\videos\\three.mp4',
      '-filter_complex',
      '[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0]concat=n=3:v=1:a=1[video][audio]',
      '-map',
      '[video]',
      '-map',
      '[audio]',
      '-c:a',
      'aac',
      '-c:v',
      'libx264',
      'C:\\videos\\joined.mp4',
    ]);
    expect(result).toEqual({
      status: 'success',
      output: { outputPath: 'C:\\videos\\joined.mp4' },
    });
  });

  it('concatenates video only when no input has an audio stream', async () => {
    // 全部无音轨：不能引用 [i:a:0]，只拼接视频流，与旧实现产出的视频-only 结果一致。
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? { stdout: '', stderr: '' }
        : { stdout: '', stderr: '' }
    ));
    const tool = new ConcatVideosTool(executeCommand);

    const result = await tool.execute({
      inputPaths: ['silent-one.mp4', 'silent-two.mp4'],
      outputPath: 'joined.mp4',
    }, toolContext());

    expect(executeCommand).toHaveBeenNthCalledWith(3, 'ffmpeg', [
      '-n',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'silent-one.mp4',
      '-i',
      'silent-two.mp4',
      '-filter_complex',
      '[0:v:0][1:v:0]concat=n=2:v=1:a=0[video]',
      '-map',
      '[video]',
      '-c:v',
      'libx264',
      'joined.mp4',
    ]);
    expect(result).toEqual({
      status: 'success',
      output: { outputPath: 'joined.mp4' },
    });
  });

  it('rejects inputs that mix segments with and without audio', async () => {
    // 混合输入无法只拼视频，也无法为无声片段补出等长音频：必须明确失败，不能产出短音轨后返回成功。
    const executeCommand = vi.fn<CommandExecutor>(async (command, args) => (
      command === 'ffprobe' && args.at(-1) === 'silent.mp4'
        ? { stdout: '', stderr: '' }
        : { stdout: '1\n', stderr: '' }
    ));
    const tool = new ConcatVideosTool(executeCommand);

    await expect(tool.execute({
      inputPaths: ['with-audio.mp4', 'silent.mp4'],
      outputPath: 'joined.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'concat_videos cannot mix inputs with and without audio streams: silent.mp4',
    });

    // 判定发生在启动 FFmpeg 之前，因此不会写出任何输出文件。
    expect(executeCommand.mock.calls.map((call) => call[0])).toEqual(['ffprobe', 'ffprobe']);
  });

  it('passes the same AbortSignal to every concat probe and to FFmpeg', async () => {
    // 拼接现在先逐段探测音轨再启动 FFmpeg，这三个外部命令都必须拿到同一个取消信号；
    // 漏传信号会让长视频拼接期间的取消无法终止子进程，与 Tool 执行的取消契约不一致。
    const controller = new AbortController();
    const executeCommand = vi.fn<CommandExecutor>(async (command) => (
      command === 'ffprobe'
        ? { stdout: '1\n', stderr: '' }
        : { stdout: '', stderr: '' }
    ));

    await expect(new ConcatVideosTool(executeCommand).execute({
      inputPaths: ['one.mp4', 'two.mp4'],
      outputPath: 'joined.mp4',
    }, toolContext(controller.signal))).resolves.toEqual({
      status: 'success',
      output: { outputPath: 'joined.mp4' },
    });

    expect(executeCommand.mock.calls.map((call) => call[2])).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it.skipIf(!realFfmpegAvailable)(
    'joins two video-only segments with real FFmpeg and produces no audio track',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-concat-media-test-'));
      try {
        const firstPath = join(directory, 'silent-one.mp4');
        const secondPath = join(directory, 'silent-two.mp4');
        const outputPath = join(directory, 'joined.mp4');
        await createSilentClip(firstPath, 'black');
        await createSilentClip(secondPath, 'white');

        await expect(new ConcatVideosTool().execute({
          inputPaths: [firstPath, secondPath],
          outputPath,
        }, toolContext())).resolves.toEqual({
          status: 'success',
          output: { outputPath },
        });

        const { duration, streams } = await probeRealMedia(outputPath);
        // 两个 1 秒片段拼成约 2 秒视频，且不产生任何音轨。
        expect(streams.filter((stream) => stream.codec_type === 'audio')).toEqual([]);
        expect(streams.filter((stream) => stream.codec_type === 'video')).toHaveLength(1);
        expect(duration).toBeGreaterThan(1.9);
        expect(duration).toBeLessThan(2.1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('builds add-audio arguments that keep the video duration', async () => {
    const executeCommand = vi.fn<CommandExecutor>(async () => ({ stdout: '', stderr: '' }));
    const tool = new AddAudioTool(executeCommand);

    const result = await tool.execute({
      videoPath: 'video.mp4',
      audioPath: 'music.wav',
      outputPath: 'with-audio.mp4',
    }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'with-audio.mp4' } });
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
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Error opening output file',
    });
    await expect(new AddAudioTool(executeCommand).execute({
      videoPath: 'video.mp4',
      audioPath: 'audio.wav',
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Error opening output file',
    });
    // concat 的音轨探测或拼接命令失败时必须让模型看到失败，不能返回成功。
    await expect(new ConcatVideosTool(executeCommand).execute({
      inputPaths: ['one.mp4', 'two.mp4'],
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffmpeg failed: Error opening output file',
    });
  });

  it('reports malformed ffprobe data as a Tool error', async () => {
    const executeCommand: CommandExecutor = async () => ({ stdout: '{invalid', stderr: '' });

    await expect(new ProbeMediaTool(executeCommand).execute({
      inputPath: 'input.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffprobe returned invalid JSON',
    });

    const missingFields: CommandExecutor = async () => ({ stdout: '{}', stderr: '' });
    await expect(new ProbeMediaTool(missingFields).execute({
      inputPath: 'input.mp4',
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'ffprobe response is missing format or streams',
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
    }, toolContext())).resolves.toEqual({
      status: 'error',
      message: 'add_subtitles requires videoPath, subtitlePath, and outputPath to be strings',
    });
    await expect(tool.execute({
      videoPath: 'input.mp4',
      subtitlePath: 'subtitle.ass',
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
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
    }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'output.mp4' } });
  });

  it('reports an unavailable subtitles filter explicitly', async () => {
    const executeCommand: CommandExecutor = async () => {
      throw new Error("ffmpeg failed: No such filter: 'subtitles'");
    };

    await expect(new AddSubtitlesTool(executeCommand).execute({
      videoPath: 'input.mp4',
      subtitlePath: 'subtitle.srt',
      outputPath: 'output.mp4',
    }, toolContext())).resolves.toEqual({
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
    }, toolContext())).resolves.toEqual({
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
    }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'portrait.mp4' } });
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
    }, toolContext())).resolves.toEqual({
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
    }, toolContext());

    expect(executeCommand).toHaveBeenCalledWith('ffmpeg', [
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'cropped.mp4' } });
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
      }, toolContext())).resolves.toEqual({
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
    }, toolContext());

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
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'faster.mp4' } });
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
    }, toolContext());

    expect(executeCommand).toHaveBeenNthCalledWith(2, 'ffmpeg', [
      '-n',
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
    expect(result).toEqual({ status: 'success', output: { outputPath: 'slower.mp4' } });
  });
});
