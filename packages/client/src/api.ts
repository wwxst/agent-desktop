export interface SelectedVideo {
  readonly name: string;
}

export interface AgentTaskResult {
  readonly responseText: string;
  readonly traceId: string;
  readonly outputFileName?: string;
}

export type ToolActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolActivityItem {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: ToolActivityStatus;
  readonly durationMs?: number;
}

export interface ClientUserMessage {
  readonly id: number;
  readonly role: 'user';
  readonly text: string;
  readonly attachments: readonly string[];
}

export interface ClientAssistantMessageBase {
  readonly id: number;
  readonly role: 'assistant';
  readonly tools: readonly ToolActivityItem[];
  readonly toolsExpanded: boolean;
}

/**
 * streamedText（实时文本）只存在于 processing 分支，完成、取消、失败三个分支没有该字段，
 * 终态转换会一并丢弃它。App 在 processing 期间不保存快照，Main 的持久化解析也不接受 processing 状态，
 * 因此临时流式文本不会被写入磁盘。
 */
export type ClientAssistantMessage = ClientAssistantMessageBase & (
  | { readonly status: 'processing'; readonly streamedText: string }
  | { readonly status: 'completed'; readonly result: AgentTaskResult }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly errorMessage: string }
);

export type ClientConversationMessage = ClientUserMessage | ClientAssistantMessage;

export interface ClientConversation {
  readonly id: string;
  readonly title: string;
  /** 手动重命名后锁定自动标题；旧快照缺失时由 Host 解析为 false。 */
  readonly titleManuallyRenamed: boolean;
  readonly messages: readonly ClientConversationMessage[];
  readonly prompt: string;
  readonly selectedVideos: readonly SelectedVideo[];
}

/** Renderer 的可序列化展示状态，不参与 Agent 模型上下文重建。 */
export interface ClientStateSnapshot {
  readonly conversations: readonly ClientConversation[];
  readonly activeSessionId: string;
}

export type RuntimeSecretSource = 'saved' | 'environment';

export interface RuntimeSecretStatus {
  readonly configured: boolean;
  readonly source?: RuntimeSecretSource;
}

/** Renderer 只接收脱敏状态和非敏感配置，不接收 API Key。 */
export interface RuntimeSettings {
  readonly deepSeek: {
    readonly apiKey: RuntimeSecretStatus;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly vision: {
    readonly apiKey: RuntimeSecretStatus;
    readonly baseUrl: string;
  };
  readonly whisper: {
    readonly modelPath: string;
    readonly cliPath: string;
  };
}

/** undefined 表示不修改，null 表示清除本机保存值并回退到环境变量或 Provider 默认值。 */
export interface RuntimeSettingsUpdate {
  readonly deepSeekApiKey?: string | null;
  readonly deepSeekBaseUrl?: string | null;
  readonly deepSeekModel?: string | null;
  readonly visionApiKey?: string | null;
  readonly visionBaseUrl?: string | null;
  readonly whisperModelPath?: string | null;
  readonly whisperCliPath?: string | null;
}

export type ToolActivityEvent =
  | {
      readonly type: 'tool.started';
      readonly turnId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: 'tool.completed';
      readonly turnId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'tool.failed';
      readonly turnId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly durationMs: number;
    };

/** Host 在 Turn 执行期间推送的 assistant 文本增量，只用于实时展示。 */
export interface AgentTextDeltaEvent {
  readonly type: 'text.delta';
  readonly delta: string;
}

/** Host 在 Turn 执行期间推送给 Client 的运行期事件：Tool 活动或实时文本增量。 */
export type AgentRuntimeEvent = ToolActivityEvent | AgentTextDeltaEvent;

export interface AgentClientApi {
  loadRuntimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettings>;
  loadClientState(): Promise<ClientStateSnapshot | null>;
  saveClientState(state: ClientStateSnapshot): Promise<void>;
  getActiveSessionId(): Promise<string>;
  selectVideoFile(): Promise<readonly SelectedVideo[] | null>;
  removeSelectedVideo(index: number): Promise<void>;
  newSession(): Promise<string>;
  switchSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<string>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  cancelTask(): Promise<void>;
  onAgentEvent(listener: (event: AgentRuntimeEvent) => void): () => void;
  openOutputFile(fileName: string): Promise<void>;
}
