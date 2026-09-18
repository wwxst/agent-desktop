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
 * 主视频与音轨分开描述，音轨不会被当成可剪辑的主输入；没有主视频时不提供最终输出路径，
 * 与「未选择输入视频」的既有语义一致，模型不会去调用需要视频的 Tool。
 */
export function buildAgentPrompt(
  prompt: string,
  attachments?: readonly PromptAttachment[],
  outputPath?: string,
): string {
  const videos = attachments?.filter((attachment) => attachment.role === 'video') ?? [];
  const audios = attachments?.filter((attachment) => attachment.role === 'audio') ?? [];

  if (videos.length === 0 || outputPath === undefined) {
    return [
      prompt,
      '',
      audios.length === 0
        ? '当前未选择输入视频。请只根据文字需求回答，不要调用需要媒体文件的 Tool，也不要声称生成了视频文件。'
        // 只有音轨时明确说明它不能当主视频，也不虚构一个输出来源。
        : [
            '当前未选择输入视频，只有音轨文件：',
            ...audios.map((audio, index) => `音轨 ${index + 1}：${toPromptPath(audio.path)}`),
            '请只根据文字需求回答，不要把这些音轨当作可剪辑的主视频，不要调用需要主视频的 Tool，也不要声称生成了视频文件。',
          ].join('\n'),
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
    `最终输出文件：${toPromptPath(outputPath)}`,
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
 * 失败或取消的调用不算产物，磁盘上恰好存在同名文件也不算；工具清理过的私有临时文件不出现在工具输入里，因此不会被列出。
 */
export function findTurnArtifacts(
  events: readonly SessionEvent[],
  turnId: TurnId,
): readonly TurnArtifact[] {
  const resultStatuses = new Map<string, 'success' | 'error'>();
  for (const event of events) {
    if (event.type === 'tool.result' && event.turnId === turnId) {
      resultStatuses.set(event.toolCallId, event.result.status);
    }
  }

  const artifacts: TurnArtifact[] = [];
  for (const event of events) {
    if (event.type !== 'tool.called'
      || event.turnId !== turnId
      // extract_audio 的 WAV 只服务语音理解，不是当前视频产物卡可交付的成品。
      || event.name === 'extract_audio'
      || typeof event.input !== 'object'
      || event.input === null
      || Array.isArray(event.input)) {
      continue;
    }

    // 只有工具输入里明确声明的输出文件才算产物；outputDir 是目录，不冒充视频文件。
    const outputPath = (event.input as Record<string, unknown>).outputPath;
    if (typeof outputPath !== 'string') continue;
    if (resultStatuses.get(event.toolCallId) !== 'success') continue;

    artifacts.push({ toolCallId: event.toolCallId, path: outputPath });
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
