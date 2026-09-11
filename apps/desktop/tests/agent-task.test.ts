import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import {
  buildAgentPrompt,
  findSuccessfulOutputPath,
  runDesktopAgentTask,
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

  it('uses the same Session as model context across two Desktop turns', async () => {
    const requests: ModelRequest[] = [];
    const session = new InMemorySession();
    const agent = {
      model: {
        complete: async (request: ModelRequest): Promise<ModelResponse> => {
          requests.push(request);
          return {
            text: requests.length === 1 ? '已经记住。' : '你刚才让我记住的数字是 731。',
            toolCalls: [],
          };
        },
      },
      session,
      tools: {
        register: () => undefined,
        get: () => undefined,
        list: () => [],
      },
      systemPrompt: { build: () => '测试 Agent' },
    };
    const trace = () => undefined;

    await runDesktopAgentTask(agent, '请记住数字 731。', [], undefined, trace);
    const second = await runDesktopAgentTask(
      agent,
      '我刚才让你记住的数字是多少？',
      [],
      undefined,
      trace,
    );

    expect(second.responseText).toBe('你刚才让我记住的数字是 731。');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('731') }),
      { role: 'assistant', content: '已经记住。', toolCalls: [] },
    ]));
    expect(session.events().filter((event) => event.type === 'turn.started')).toHaveLength(2);
  });

  it('reconstructs the next model request from restored Session events', async () => {
    const restoredTurnId = 'turn-restored' as TurnId;
    const restoredStepId = 'step-restored' as StepId;
    const session = new InMemorySession([
      { type: 'turn.started', turnId: restoredTurnId },
      {
        type: 'user.message',
        turnId: restoredTurnId,
        content: '请记住数字 731。',
      },
      { type: 'step.started', turnId: restoredTurnId, stepId: restoredStepId },
      {
        type: 'assistant.message',
        turnId: restoredTurnId,
        stepId: restoredStepId,
        content: '已经记住。',
        toolCalls: [],
      },
      { type: 'step.completed', turnId: restoredTurnId, stepId: restoredStepId },
      { type: 'turn.completed', turnId: restoredTurnId },
    ]);
    let request: ModelRequest | undefined;
    const agent = {
      model: {
        complete: async (nextRequest: ModelRequest): Promise<ModelResponse> => {
          request = nextRequest;
          return { text: '你之前让我记住的数字是 731。', toolCalls: [] };
        },
      },
      session,
      tools: {
        register: () => undefined,
        get: () => undefined,
        list: () => [],
      },
      systemPrompt: { build: () => '测试 Agent' },
    };

    const result = await runDesktopAgentTask(
      agent,
      '我之前让你记住的数字是多少？',
      [],
      undefined,
      () => undefined,
    );

    expect(result.responseText).toContain('731');
    expect(request?.messages.slice(0, 2)).toEqual([
      { role: 'user', content: '请记住数字 731。' },
      { role: 'assistant', content: '已经记住。', toolCalls: [] },
    ]);
  });
});
