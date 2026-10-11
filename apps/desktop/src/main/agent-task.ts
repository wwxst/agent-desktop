import {
  runTurn,
  type ExecutionTrace,
  type ToolProgressListener,
  type ToolResultListener,
} from '@agent-desktop/agent-loop';
import type { AttachmentRole } from '@agent-desktop/client';
import type { SessionEvent, TurnId } from '@agent-desktop/session';
import {
  projectOutputItemResults,
  readVideoDeliveryFacts,
  type OutputItemResult,
} from '@agent-desktop/video-agent';

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
 *
 * 这里只描述本次真实存在的事实：选了哪些附件。最终交付路径不再由宿主预设——
 * 输出项由模型按用户要求声明，候选写在应用层给出的工作目录里，最终名称在发布时确定。
 * 「没有主视频就一律禁止媒体工具」这类策略同样不在用户消息里追加：它会让用户在需求里
 * 直接给出视频路径时也无法调用探测工具；工具可见性与使用规则统一由系统指令描述。
 */
export function buildAgentPrompt(
  prompt: string,
  attachments?: readonly PromptAttachment[],
): string {
  const videos = attachments?.filter((attachment) => attachment.role === 'video') ?? [];
  const audios = attachments?.filter((attachment) => attachment.role === 'audio') ?? [];

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

/**
 * 一轮任务需要的运行端口。
 * 它们全部属于宿主：诊断追踪、取消信号和三条展示通道都不进入 Agent Core。
 */
export interface DesktopTaskOptions {
  readonly trace: ExecutionTrace;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
  readonly onToolResult?: ToolResultListener;
  readonly onToolProgress?: ToolProgressListener;
  readonly onModelText?: NonNullable<Parameters<typeof runTurn>[2]>['onModelText'];
  readonly contextBudget?: NonNullable<Parameters<typeof runTurn>[2]>['contextBudget'];
  readonly qualifyToolEvidence?: NonNullable<Parameters<typeof runTurn>[2]>['qualifyToolEvidence'];
}

/**
 * 本轮视频交付的逐项结果。
 *
 * 只有本轮真的声明过输出项时才产生结果：普通问答、只读分析和通用文本任务不创建输出项，
 * 它们的视频交付结论是不适用，而不是「零项全部完成」。
 */
export function projectTurnOutputs(
  events: readonly SessionEvent[],
  turnId: TurnId,
): readonly OutputItemResult[] {
  const facts = readVideoDeliveryFacts(events);
  if (facts.declarationTurnId !== turnId) return [];
  return projectOutputItemResults(facts);
}

/** 在窗口持有的同一个 Agent 上执行一轮任务，让 Session 成为跨轮模型上下文的唯一来源。 */
export async function runDesktopAgentTask(
  agent: Parameters<typeof runTurn>[0],
  prompt: string,
  attachments: readonly PromptAttachment[],
  options: DesktopTaskOptions,
) {
  const result = await runTurn(agent, buildAgentPrompt(prompt, attachments), {
    trace: options.trace,
    ...(options.contextBudget === undefined ? {} : { contextBudget: options.contextBudget }),
    ...(options.qualifyToolEvidence === undefined ? {} : { qualifyToolEvidence: options.qualifyToolEvidence }),
    ...(options.onModelText === undefined ? {} : { onModelText: options.onModelText }),
    // exactOptionalPropertyTypes 下，没有值的端口必须省略而不是写入 undefined。
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // 文本增量只用于实时展示，不改变 Session 事实和返回值。
    ...(options.onTextDelta === undefined ? {} : { onTextDelta: options.onTextDelta }),
    // 工具结果内容走独立回调，不写入只承载诊断元数据的 Execution Trace。
    ...(options.onToolResult === undefined ? {} : { onToolResult: options.onToolResult }),
    // 实时进度同样走独立通道，不写入 Session，也不进入模型上下文。
    ...(options.onToolProgress === undefined ? {} : { onToolProgress: options.onToolProgress }),
  });
  if (result.response.text === undefined) {
    throw new Error('Agent 未返回最终文本回复。');
  }

  return {
    responseText: result.response.text,
    turnId: result.turnId,
    artifacts: findTurnArtifacts(agent.session.events(), result.turnId),
  };
}
