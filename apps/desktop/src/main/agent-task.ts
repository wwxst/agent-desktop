import { runTurn, type ExecutionTrace } from '@agent-desktop/agent-loop';
import type { SessionEvent, TurnId } from '@agent-desktop/session';

/** 把 Renderer 的用户意图与 Main 持有的视频路径集合组合成一次 Agent 输入。 */
export function buildAgentPrompt(
  prompt: string,
  inputPaths?: readonly string[],
  outputPath?: string,
): string {
  if (inputPaths === undefined || inputPaths.length === 0 || outputPath === undefined) {
    return [
      prompt,
      '',
      '当前未选择输入视频。请只根据文字需求回答，不要调用需要媒体文件的 Tool，也不要声称生成了视频文件。',
    ].join('\n');
  }

  return [
    prompt,
    '',
    // Agent 会把这些路径复制进 Tool Call JSON；使用 Windows 同样支持的正斜杠，避免反斜杠被模型输出为非法 JSON 转义。
    ...inputPaths.map((inputPath, index) => (
      `输入视频 ${index + 1}：${inputPath.replaceAll('\\', '/')}`
    )),
    `最终输出文件：${outputPath.replaceAll('\\', '/')}`,
  ].join('\n');
}

/** 只返回当前 Turn 最后一次成功输出调用的路径，不把中间文件误报为最终产物。 */
export function findSuccessfulOutputPath(
  events: readonly SessionEvent[],
  turnId: TurnId,
): string | undefined {
  const turnEvents = events.filter((event) => event.turnId === turnId);

  for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
    const event = turnEvents[index];
    if (event?.type !== 'tool.called'
      || typeof event.input !== 'object'
      || event.input === null
      || Array.isArray(event.input)) {
      continue;
    }

    const outputPath = (event.input as Record<string, unknown>).outputPath;
    if (typeof outputPath !== 'string') continue;

    const result = turnEvents.find((candidate) => (
      candidate.type === 'tool.result'
      && candidate.toolCallId === event.toolCallId
    ));
    return result?.type === 'tool.result' && result.result.status === 'success'
      ? outputPath
      : undefined;
  }

  return undefined;
}

/** 在窗口持有的同一个 Agent 上执行一轮任务，让 Session 成为跨轮模型上下文的唯一来源。 */
export async function runDesktopAgentTask(
  agent: Parameters<typeof runTurn>[0],
  prompt: string,
  inputPaths: readonly string[],
  outputPath: string | undefined,
  trace: ExecutionTrace,
) {
  const result = await runTurn(
    agent,
    buildAgentPrompt(prompt, inputPaths, outputPath),
    trace,
  );
  if (result.response.text === undefined) {
    throw new Error('Agent 未返回最终文本回复。');
  }

  return {
    responseText: result.response.text,
    turnId: result.turnId,
    outputPath: findSuccessfulOutputPath(agent.session.events(), result.turnId),
  };
}
