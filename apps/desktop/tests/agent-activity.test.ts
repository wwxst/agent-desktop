import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
import {
  assertRevealableFile,
  findToolCallInput,
  isSessionFilePath,
  projectAgentActivity,
  readActivityFiles,
} from '../src/main/agent-activity.js';

const turnId = 'turn-1' as TurnId;
const stepId = 'step-1' as StepId;
const toolCallId = 'call-1' as ToolCallId;

/** 只保留测试需要的字段，让每个用例只表达它真正关心的事实。 */
function toolCalled(input: unknown): SessionEvent {
  return { type: 'tool.called', turnId, stepId, toolCallId, name: 'trim_video', input };
}

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('readActivityFiles', () => {
  it('separates real input and output paths declared by the video tools', () => {
    expect(readActivityFiles({
      videoPath: 'D:\\videos\\input.mp4',
      outputPath: 'D:\\videos\\edited.mp4',
    })).toEqual([
      { path: 'D:\\videos\\input.mp4', label: 'input.mp4', role: 'input' },
      { path: 'D:\\videos\\edited.mp4', label: 'edited.mp4', role: 'output' },
    ]);
  });

  it('reads every path of a multi-input tool and marks output directories', () => {
    expect(readActivityFiles({
      inputPaths: ['E:/videos/a.mp4', 'E:/videos/b.mp4'],
      outputDir: 'E:/videos/frames',
    })).toEqual([
      { path: 'E:/videos/a.mp4', label: 'a.mp4', role: 'input' },
      { path: 'E:/videos/b.mp4', label: 'b.mp4', role: 'input' },
      { path: 'E:/videos/frames', label: 'frames/', role: 'output' },
    ]);
  });

  it('keeps audio and subtitle inputs visible for the tools that use them', () => {
    expect(readActivityFiles({
      videoPath: 'E:/videos/input.mp4',
      audioPath: 'E:/audio/voice.wav',
      subtitlePath: 'E:/subs/zh.srt',
      outputPath: 'E:/videos/dubbed.mp4',
    }).map((file) => file.role)).toEqual(['input', 'input', 'input', 'output']);
  });

  it('reads the image paths consumed by the registered Vision tool', () => {
    expect(readActivityFiles({
      images: [
        { path: 'E:/videos/frames/frame-001.jpg', timestamp: 1.5 },
        { path: 'E:/videos/frames/frame-002.jpg', timestamp: 3 },
      ],
    })).toEqual([
      { path: 'E:/videos/frames/frame-001.jpg', label: 'frame-001.jpg', role: 'input' },
      { path: 'E:/videos/frames/frame-002.jpg', label: 'frame-002.jpg', role: 'input' },
    ]);
  });

  it('shows the directory a local tool set or read, distinguished from a file', () => {
    expect(readActivityFiles({
      path: 'E:/videos',
      directory: 'E:/videos/素材 目录',
    })).toEqual([
      { path: 'E:/videos', label: 'videos/', role: 'input' },
      { path: 'E:/videos/素材 目录', label: '素材 目录/', role: 'input' },
    ]);
  });

  it('shows the text file a local tool actually read', () => {
    expect(readActivityFiles({ filePath: 'E:/videos/字幕.srt', startLine: 1 })).toEqual([
      { path: 'E:/videos/字幕.srt', label: '字幕.srt', role: 'input' },
    ]);
  });

  it('produces no file reference for tool input outside the current contract', () => {
    expect(readActivityFiles({ start: 0, end: 12 })).toEqual([]);
    expect(readActivityFiles(undefined)).toEqual([]);
    expect(readActivityFiles('E:/videos/input.mp4')).toEqual([]);
  });
});

describe('findToolCallInput', () => {
  it('reads the input that the Session really recorded for this Tool Call', () => {
    const events: readonly SessionEvent[] = [
      toolCalled({ videoPath: 'E:/videos/first.mp4' }),
      { type: 'tool.called', turnId, stepId, toolCallId: 'call-2' as ToolCallId, name: 'trim_video', input: { videoPath: 'E:/videos/second.mp4' } },
    ];

    expect(findToolCallInput(events, 'call-1')).toEqual({ videoPath: 'E:/videos/first.mp4' });
    expect(findToolCallInput(events, 'call-2')).toEqual({ videoPath: 'E:/videos/second.mp4' });
    expect(findToolCallInput(events, 'call-missing')).toBeUndefined();
  });
});

describe('projectAgentActivity', () => {
  it('projects the model step into one analysis row that keeps its real duration and tool count', () => {
    expect(projectAgentActivity({
      type: 'model.started', turnId, stepId, messageCount: 2, toolDefinitionCount: 13,
    }, [])).toEqual({ id: 'model:step-1', kind: 'analysis', status: 'running' });

    expect(projectAgentActivity({
      type: 'model.completed', turnId, stepId, durationMs: 640, toolCallCount: 2, hasText: false,
    }, [])).toEqual({
      id: 'model:step-1',
      kind: 'analysis',
      status: 'completed',
      durationMs: 640,
      plannedToolCallCount: 2,
    });

    expect(projectAgentActivity({
      type: 'model.failed', turnId, stepId, durationMs: 90, errorName: 'Error', errorMessage: '模型调用失败',
    }, [])).toEqual({
      id: 'model:step-1',
      kind: 'analysis',
      status: 'failed',
      durationMs: 90,
    });
  });

  it('projects Tool lifecycle events into one row that is replaced in place by id', () => {
    const events: readonly SessionEvent[] = [toolCalled({
      videoPath: 'E:/videos/input.mp4',
      outputPath: 'E:/videos/edited.mp4',
    })];
    const files = [
      { path: 'E:/videos/input.mp4', label: 'input.mp4', role: 'input' },
      { path: 'E:/videos/edited.mp4', label: 'edited.mp4', role: 'output' },
    ];

    expect(projectAgentActivity({
      type: 'tool.started', turnId, stepId, toolCallId, toolName: 'trim_video',
    }, events)).toEqual({
      id: 'call-1', kind: 'tool', status: 'running', toolName: 'trim_video', files,
    });

    expect(projectAgentActivity({
      type: 'tool.completed', turnId, stepId, toolCallId, toolName: 'trim_video', durationMs: 860,
    }, events)).toEqual({
      id: 'call-1', kind: 'tool', status: 'completed', toolName: 'trim_video', durationMs: 860, files,
    });

    expect(projectAgentActivity({
      type: 'tool.failed', turnId, stepId, toolCallId, toolName: 'trim_video', durationMs: 120, errorName: 'Error',
    }, events)).toEqual({
      id: 'call-1', kind: 'tool', status: 'failed', toolName: 'trim_video', durationMs: 120, files,
    });
  });

  it('omits the file list when the Tool Call used no file from the current contract', () => {
    const events: readonly SessionEvent[] = [toolCalled({ start: 0, end: 12 })];
    const item = projectAgentActivity({
      type: 'tool.completed', turnId, stepId, toolCallId, toolName: 'trim_video', durationMs: 40,
    }, events);

    expect(item).not.toHaveProperty('files');
  });

  it('does not turn Turn lifecycle events into activity rows', () => {
    const lifecycle: readonly ExecutionTraceEvent[] = [
      { type: 'turn.started', turnId },
      { type: 'turn.completed', turnId, durationMs: 1200, stepCount: 2 },
      { type: 'turn.cancelled', turnId, durationMs: 400, stepCount: 1 },
      { type: 'turn.failed', turnId, durationMs: 300, errorName: 'Error', errorMessage: '失败' },
    ];

    for (const event of lifecycle) {
      expect(projectAgentActivity(event, [])).toBeUndefined();
    }
  });
});

describe('isSessionFilePath', () => {
  it('accepts selected videos and files the Session really used, and rejects anything else', () => {
    const events: readonly SessionEvent[] = [toolCalled({ videoPath: 'E:/videos/input.mp4' })];

    expect(isSessionFilePath(events, ['E:/videos/selected.mp4'], 'E:/videos/selected.mp4')).toBe(true);
    expect(isSessionFilePath(events, [], 'E:/videos/input.mp4')).toBe(true);
    expect(isSessionFilePath(events, [], 'C:/Windows/System32')).toBe(false);
    expect(isSessionFilePath([], [], 'E:/videos/input.mp4')).toBe(false);
  });
});

describe('assertRevealableFile', () => {
  it('reports a readable failure for a path that no longer exists', () => {
    expect(() => assertRevealableFile('E:/videos/definitely-missing-file.mp4'))
      .toThrow('文件不存在或已被移动：E:/videos/definitely-missing-file.mp4');
  });

  it('accepts a file that exists on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-activity-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'artifact.mp4');
    await writeFile(filePath, 'placeholder', 'utf8');

    expect(() => assertRevealableFile(filePath)).not.toThrow();
    // 本测试文件本身也是真实存在的文件，用于覆盖非临时目录的常规路径。
    expect(() => assertRevealableFile(fileURLToPath(import.meta.url))).not.toThrow();
  });
});
