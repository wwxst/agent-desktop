import { describe, expect, it } from 'vitest';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
import {
  buildAgentPrompt,
  findSuccessfulOutputPath,
} from '../src/main/agent-task.js';

const turnId = 'turn-current' as TurnId;
const stepId = 'step-current' as StepId;

function outputEvents(
  callId: string,
  outputPath: string,
  status: 'success' | 'error',
): SessionEvent[] {
  const toolCallId = callId as ToolCallId;
  return [
    {
      type: 'tool.called',
      turnId,
      stepId,
      toolCallId,
      name: 'trim_video',
      input: { inputPath: 'input.mp4', outputPath, start: 0, duration: 4 },
    },
    {
      type: 'tool.result',
      turnId,
      stepId,
      toolCallId,
      result: status === 'success'
        ? { status: 'success', output: `Video created: ${outputPath}` }
        : { status: 'error', message: 'FFmpeg failed' },
    },
  ];
}

describe('desktop agent task', () => {
  it('passes Windows video paths with JSON-safe separators to the Agent', () => {
    expect(buildAgentPrompt(
      '删除无关内容，只保留核心部分',
      ['D:\\videos\\sintel-trailer.mp4'],
      'D:\\videos\\sintel-trailer-edited.mp4',
    )).toBe([
      '删除无关内容，只保留核心部分',
      '',
      '输入视频 1：D:/videos/sintel-trailer.mp4',
      '最终输出文件：D:/videos/sintel-trailer-edited.mp4',
    ].join('\n'));
  });

  it('marks a text-only task without inventing media paths', () => {
    expect(buildAgentPrompt('介绍一下这个客户端的能力。')).toBe([
      '介绍一下这个客户端的能力。',
      '',
      '当前未选择输入视频。请只根据文字需求回答，不要调用需要媒体文件的 Tool，也不要声称生成了视频文件。',
    ].join('\n'));
  });

  it('lists every selected video in the Agent prompt', () => {
    expect(buildAgentPrompt(
      '把两个视频拼接起来',
      ['D:\\videos\\intro.mp4', 'D:\\videos\\main.mp4'],
      'D:\\videos\\intro-edited.mp4',
    )).toBe([
      '把两个视频拼接起来',
      '',
      '输入视频 1：D:/videos/intro.mp4',
      '输入视频 2：D:/videos/main.mp4',
      '最终输出文件：D:/videos/intro-edited.mp4',
    ].join('\n'));
  });

  it('returns the last successful output path from the current Turn', () => {
    const events = [
      ...outputEvents('first', 'D:\\videos\\part.mp4', 'success'),
      ...outputEvents('final', 'D:\\videos\\final.mp4', 'success'),
    ];

    expect(findSuccessfulOutputPath(events, turnId)).toBe('D:\\videos\\final.mp4');
  });

  it('does not expose an intermediate file when the final output Tool failed', () => {
    const events = [
      ...outputEvents('first', 'D:\\videos\\part.mp4', 'success'),
      ...outputEvents('final', 'D:\\videos\\final.mp4', 'error'),
    ];

    expect(findSuccessfulOutputPath(events, turnId)).toBeUndefined();
  });
});
