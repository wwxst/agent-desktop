import { describe, expect, it } from 'vitest';
import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
import {
  buildAgentPrompt,
  createIsolatedVideoAgent,
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
  it('creates a fresh session for every desktop task', () => {
    const options = {
      deepSeekApiKey: 'test-deepseek-key',
      whisperModelPath: 'test-whisper-model.bin',
      visionApiKey: 'test-openai-key',
    } as const;

    const firstAgent = createIsolatedVideoAgent(options);
    const secondAgent = createIsolatedVideoAgent(options);

    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.session).not.toBe(firstAgent.session);
  });

  it('passes the selected video and deterministic output path to the Agent', () => {
    expect(buildAgentPrompt(
      '删除无关内容，只保留核心部分',
      'D:\\videos\\sintel-trailer.mp4',
      'D:\\videos\\sintel-trailer-edited.mp4',
    )).toBe([
      '删除无关内容，只保留核心部分',
      '',
      '输入视频：D:\\videos\\sintel-trailer.mp4',
      '最终输出文件：D:\\videos\\sintel-trailer-edited.mp4',
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
