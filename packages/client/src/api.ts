export interface SelectedVideo {
  readonly name: string;
}

export interface AgentTaskResult {
  readonly responseText: string;
  readonly traceId: string;
  readonly outputFileName?: string;
}

export type ToolActivityStatus = 'running' | 'completed' | 'failed';

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

export type ClientAssistantMessage = ClientAssistantMessageBase & (
  | { readonly status: 'processing' }
  | { readonly status: 'completed'; readonly result: AgentTaskResult }
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

export interface AgentClientApi {
  loadClientState(): Promise<ClientStateSnapshot | null>;
  saveClientState(state: ClientStateSnapshot): Promise<void>;
  getActiveSessionId(): Promise<string>;
  selectVideoFile(): Promise<readonly SelectedVideo[] | null>;
  removeSelectedVideo(index: number): Promise<void>;
  newSession(): Promise<string>;
  switchSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<string>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  onAgentEvent(listener: (event: ToolActivityEvent) => void): () => void;
  openOutputFile(fileName: string): Promise<void>;
}
