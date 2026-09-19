import { runTurn, type ExecutionTrace } from '@agent-desktop/agent-loop';
import type { AttachmentRole } from '@agent-desktop/client';
import type { SessionEvent, TurnId } from '@agent-desktop/session';

/** 提示词里使用的附件：路径是模型实际调用工具的值，角色决定它被描述成什么。 */
export interface PromptAttachment {
  readonly path: string;
  readonly role: AttachmentRole;
}

/** Agent 会把这些路径复制进 Tool Call JSON；使用 Windows 同样支持的正斜杠，避免反斜杠被模型输出为非法 JSON 转义。 */
function toPromptPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * 把 Renderer 的用户意图与 Main 持有的附件组合成一次 Agent 输入。
 * 这里只描述本次真实存在的事实：选了哪些附件、有没有预设的最终输出路径。
 * 「没有主视频就一律禁止媒体工具」这类策略不在用户消息里追加——它会让用户在需求里
 * 直接给出视频路径时也无法调用探测工具；工具可见性与使用规则统一由系统指令描述。
 */
export function buildAgentPrompt(
  prompt: string,
  attachments?: readonly PromptAttachment[],
  outputPath?: string,
): string {
  const videos = attachments?.filter((attachment) => attachment.role === 'video') ?? [];
  const audios = attachments?.filter((attachment) => attachment.role === 'audio') ?? [];

  // 没有主视频时既没有可剪辑的主输入，也没有合法的输出目标（输出路径由主视频推导），
  // 所以调用方即使传了输出路径也不提供给模型，只如实说明用户给了音轨还是什么都没给。
  if (videos.length === 0) {
    return [
      prompt,
      '',
      ...(audios.length === 0
        ? ['本次没有选择输入附件。']
        : [
            '本次没有选择主视频，只有音轨文件：',
            ...audios.map((audio, index) => `音轨 ${index + 1}：${toPromptPath(audio.path)}`),
            '不要把这些音轨当作可剪辑的主视频；它们只能作为 add_audio 的声音来源。',
          ]),
      '本次没有预设的最终输出路径。',
    ].join('\n');
  }

  return [
    prompt,
    '',
    ...videos.map((video, index) => `输入视频 ${index + 1}：${toPromptPath(video.path)}`),
    // 音轨单独成段：它的用途是配合 add_audio 替换或叠加声音，不是第二个可拼接的视频。
    ...(audios.length === 0 ? [] : [
      '',
      '可用音轨（使用 add_audio 配合上面的主视频，不要当作视频输入）：',
      ...audios.map((audio, index) => `音轨 ${index + 1}：${toPromptPath(audio.path)}`),
    ]),
    outputPath === undefined
      ? '本次没有预设的最终输出路径。'
      : `最终输出文件：${toPromptPath(outputPath)}`,
  ].join('\n');
}

/** 一次成功工具调用真实生成的持久产物；toolCallId 说明它由哪一步产生。 */
export interface TurnArtifact {
  readonly toolCallId: string;
  readonly path: string;
}

/**
 * 最近开始的那一轮 Turn。
 * 轮次失败或取消时 `runTurn` 直接抛错，拿不到它的返回值，但 `turn.started` 已经写进 Session，
 * 因此从事件里反查即可：收尾路径要按同一个 turnId 统计已成功的产物。
 */
export function findLatestTurnId(events: readonly SessionEvent[]): TurnId | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.started') return event.turnId;
  }
  return undefined;
}

/**
 * 只按 Session 的成功工具事实识别当前 Turn 的产物。
 *
 * 权威来源是成功结果自己报告的 `artifacts`：写出型工具在真正写入成功后才报告它，
 * 因此宿主不需要从回复文本、退出码或磁盘扫描推断产物，失败调用也不会产生产物。
 */
export function findTurnArtifacts(
  events: readonly SessionEvent[],
  turnId: TurnId,
): readonly TurnArtifact[] {
  const artifacts: TurnArtifact[] = [];
  for (const event of events) {
    if (event.type !== 'tool.result' || event.turnId !== turnId) continue;
    if (event.result.status !== 'success') continue;

    for (const path of event.result.artifacts ?? []) {
      artifacts.push({ toolCallId: event.toolCallId, path });
    }
  }

  return artifacts;
}

/** 在窗口持有的同一个 Agent 上执行一轮任务，让 Session 成为跨轮模型上下文的唯一来源。 */
export async function runDesktopAgentTask(
  agent: Parameters<typeof runTurn>[0],
  prompt: string,
  attachments: readonly PromptAttachment[],
  outputPath: string | undefined,
  trace: ExecutionTrace,
  signal?: AbortSignal,
  onTextDelta?: (delta: string) => void,
) {
  const result = await runTurn(
    agent,
    buildAgentPrompt(prompt, attachments, outputPath),
    trace,
    signal,
    // 文本增量只用于实时展示，不改变 Session 事实和返回值。
    onTextDelta,
  );
  if (result.response.text === undefined) {
    throw new Error('Agent 未返回最终文本回复。');
  }

  return {
    responseText: result.response.text,
    turnId: result.turnId,
    artifacts: findTurnArtifacts(agent.session.events(), result.turnId),
  };
}
