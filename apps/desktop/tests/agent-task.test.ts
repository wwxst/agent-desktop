import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import {
  buildAgentPrompt,
  findLatestTurnId,
  findTurnArtifacts,
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
      [{ path: 'D:\\videos\\sintel-trailer.mp4', role: 'video' }],
      'D:\\videos\\sintel-trailer-edited.mp4',
    )).toBe([
      '删除无关内容，只保留核心部分',
      '',
      '输入视频 1：D:/videos/sintel-trailer.mp4',
      '最终输出文件：D:/videos/sintel-trailer-edited.mp4',
    ].join('\n'));
  });

  it('states the missing attachments as a fact instead of forbidding media tools', () => {
    // 宿主只补充事实：普通问答不会因为「没有附件」被追加任何禁止调用 Tool 的策略。
    expect(buildAgentPrompt('介绍一下这个客户端的能力。')).toBe([
      '介绍一下这个客户端的能力。',
      '',
      '本次没有选择输入附件。',
      '本次没有预设的最终输出路径。',
    ].join('\n'));
  });

  it('keeps a task that already names a real path usable without attachments', () => {
    // 用户在需求里直接给出完整视频路径时，宿主不再追加「不要调用需要媒体文件的 Tool」，
    // 因此模型仍可以对那个路径调用 probe_media 等已注册工具。
    const task = '检查 D:\\videos\\sintel-trailer.mp4 的时长和分辨率。';
    const composed = buildAgentPrompt(task);

    expect(composed).toBe([
      task,
      '',
      '本次没有选择输入附件。',
      '本次没有预设的最终输出路径。',
    ].join('\n'));
    expect(composed).not.toContain('不要调用');
    expect(composed).not.toContain('只根据文字需求回答');
  });

  it('describes an audio track as a companion track, not as a second video', () => {
    // 音轨必须与主视频分开描述：否则模型会把它当成第二个可拼接的视频输入。
    expect(buildAgentPrompt(
      '把这段音乐换成新的',
      [
        { path: 'D:\\videos\\main.mp4', role: 'video' },
        { path: 'D:\\audio\\bgm.mp3', role: 'audio' },
      ],
      'D:\\videos\\main-edited.mp4',
    )).toBe([
      '把这段音乐换成新的',
      '',
      '输入视频 1：D:/videos/main.mp4',
      '',
      '可用音轨（使用 add_audio 配合上面的主视频，不要当作视频输入）：',
      '音轨 1：D:/audio/bgm.mp3',
      '最终输出文件：D:/videos/main-edited.mp4',
    ].join('\n'));
  });

  it('does not treat a lone audio track as a video input', () => {
    // 只有音轨时没有主视频，也就没有最终输出路径：不能把音轨当输入视频，也不能虚构输出。
    // 但同样不追加「不要调用需要主视频的 Tool」——用户可能在文字里给出主视频路径。
    expect(buildAgentPrompt(
      '把这段音频转成文字',
      [{ path: 'D:\\audio\\only.mp3', role: 'audio' }],
      'D:\\videos\\only-edited.mp4',
    )).toBe([
      '把这段音频转成文字',
      '',
      '本次没有选择主视频，只有音轨文件：',
      '音轨 1：D:/audio/only.mp3',
      '不要把这些音轨当作可剪辑的主视频；它们只能作为 add_audio 的声音来源。',
      '本次没有预设的最终输出路径。',
    ].join('\n'));
  });

  it('lists every selected video in the Agent prompt', () => {
    expect(buildAgentPrompt(
      '把两个视频拼接起来',
      [
        { path: 'D:\\videos\\intro.mp4', role: 'video' },
        { path: 'D:\\videos\\main.mp4', role: 'video' },
      ],
      'D:\\videos\\intro-edited.mp4',
    )).toBe([
      '把两个视频拼接起来',
      '',
      '输入视频 1：D:/videos/intro.mp4',
      '输入视频 2：D:/videos/main.mp4',
      '最终输出文件：D:/videos/intro-edited.mp4',
    ].join('\n'));
  });

  it('identifies every successful output of the current Turn by tool call and real path', () => {
    const events = [
      ...outputEvents('first', 'D:\\videos\\part.mp4', 'success'),
      ...outputEvents('final', 'D:\\videos\\final.mp4', 'success'),
    ];

    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: 'first', path: 'D:\\videos\\part.mp4' },
      { toolCallId: 'final', path: 'D:\\videos\\final.mp4' },
    ]);
  });

  it('does not expose extracted speech audio as a completed video artifact', () => {
    const audioCallId = 'speech-audio' as ToolCallId;
    const videoCallId = 'final-video' as ToolCallId;
    const events: SessionEvent[] = [
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: audioCallId,
        name: 'extract_audio',
        input: { videoPath: 'D:\\videos\\input.mp4', outputPath: 'D:\\videos\\speech.wav' },
      },
      {
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId: audioCallId,
        result: { status: 'success', output: 'Audio created: D:\\videos\\speech.wav' },
      },
      ...outputEvents(videoCallId, 'D:\\videos\\final.mp4', 'success'),
    ];

    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: videoCallId, path: 'D:\\videos\\final.mp4' },
    ]);
  });

  it('keeps same-named outputs from different directories apart', () => {
    const events = [
      ...outputEvents('first', 'D:\\videos\\a\\final.mp4', 'success'),
      ...outputEvents('final', 'D:\\videos\\b\\final.mp4', 'success'),
    ];

    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: 'first', path: 'D:\\videos\\a\\final.mp4' },
      { toolCallId: 'final', path: 'D:\\videos\\b\\final.mp4' },
    ]);
  });

  it('registers only the successful output calls and never a failed one', () => {
    const events = [
      ...outputEvents('first', 'D:\\videos\\part.mp4', 'success'),
      ...outputEvents('final', 'D:\\videos\\final.mp4', 'error'),
    ];

    // 失败调用不算产物；此前真实成功的文件仍然是本轮已经产生的产物事实。
    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: 'first', path: 'D:\\videos\\part.mp4' },
    ]);
  });

  it('does not treat a cancelled call or an output directory as an artifact', () => {
    const cancelledCallId = 'cancelled' as ToolCallId;
    const framesCallId = 'frames' as ToolCallId;
    const events: SessionEvent[] = [
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: cancelledCallId,
        name: 'trim_video',
        input: { inputPath: 'input.mp4', outputPath: 'D:\\videos\\half.mp4', start: 0, duration: 4 },
      },
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: framesCallId,
        name: 'extract_video_frames',
        input: { videoPath: 'input.mp4', outputDir: 'D:\\videos\\frames' },
      },
      {
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId: framesCallId,
        result: { status: 'success', output: 'frames' },
      },
    ];

    expect(findTurnArtifacts(events, turnId)).toEqual([]);
  });

  it('finds the latest Turn from Session facts so a failed Turn can still be summarized', () => {
    const earlierTurnId = 'turn-earlier' as TurnId;
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: earlierTurnId },
      { type: 'turn.completed', turnId: earlierTurnId },
      { type: 'turn.started', turnId },
    ];

    expect(findLatestTurnId(events)).toBe(turnId);
  });

  it('keeps the first successful output visible when a later tool in the same Turn fails', () => {
    const firstCallId = 'first' as ToolCallId;
    const secondCallId = 'second' as ToolCallId;
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId },
      { type: 'step.started', turnId, stepId },
      ...outputEvents(firstCallId, 'D:\\videos\\part1.mp4', 'success'),
      ...outputEvents(secondCallId, 'D:\\videos\\part2.mp4', 'error'),
    ];

    // 整轮失败（第二个工具 error）不改变第一份文件已经真实生成的事实。
    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: firstCallId, path: 'D:\\videos\\part1.mp4' },
    ]);
  });

  it('does not list an in-flight tool when the Turn is cancelled before it finishes', () => {
    const doneCallId = 'done' as ToolCallId;
    const runningCallId = 'running' as ToolCallId;
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId },
      { type: 'step.started', turnId, stepId },
      ...outputEvents(doneCallId, 'D:\\videos\\done.mp4', 'success'),
      // 取消发生在这一轮的工具执行中：只有 tool.called，没有 tool.result。
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: runningCallId,
        name: 'trim_video',
        input: { inputPath: 'input.mp4', outputPath: 'D:\\videos\\never-finished.mp4' },
      },
    ];

    expect(findTurnArtifacts(events, turnId)).toEqual([
      { toolCallId: doneCallId, path: 'D:\\videos\\done.mp4' },
    ]);
  });

  it('keeps the successful fact of an earlier Turn out of the cancelled Turn summary', () => {
    const earlierTurnId = 'turn-earlier' as TurnId;
    const earlierCallId = 'earlier' as ToolCallId;
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: earlierTurnId },
      {
        type: 'tool.called',
        turnId: earlierTurnId,
        stepId,
        toolCallId: earlierCallId,
        name: 'trim_video',
        input: { inputPath: 'input.mp4', outputPath: 'D:\\videos\\earlier.mp4' },
      },
      {
        type: 'tool.result',
        turnId: earlierTurnId,
        stepId,
        toolCallId: earlierCallId,
        result: { status: 'success', output: 'Video created: D:\\videos\\earlier.mp4' },
      },
      { type: 'turn.completed', turnId: earlierTurnId },
      { type: 'turn.started', turnId },
      { type: 'step.started', turnId, stepId },
    ];

    const latestTurnId = findLatestTurnId(events);
    expect(latestTurnId).toBe(turnId);
    // 上一轮的文件不属于本轮结果，避免取消后把历史产物算成本轮产出。
    expect(findTurnArtifacts(events, latestTurnId!)).toEqual([]);
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
