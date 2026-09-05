import type { SessionEvent, TurnId } from '@agent-desktop/session';

/** 把 Renderer 的用户意图与 Main 持有的视频路径组合成一次 Agent 输入。 */
export function buildAgentPrompt(prompt: string, inputPath: string, outputPath: string): string {
  return [
    prompt,
    '',
    `输入视频：${inputPath}`,
    `最终输出文件：${outputPath}`,
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
