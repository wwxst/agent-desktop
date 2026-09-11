export interface SelectedVideo {
  readonly name: string;
}

export interface AgentTaskResult {
  readonly responseText: string;
  readonly traceId: string;
  readonly outputFileName?: string;
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
  getActiveSessionId(): Promise<string>;
  selectVideoFile(): Promise<readonly SelectedVideo[] | null>;
  removeSelectedVideo(index: number): Promise<void>;
  newSession(): Promise<string>;
  switchSession(sessionId: string): Promise<void>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  onAgentEvent(listener: (event: ToolActivityEvent) => void): () => void;
  openOutputFile(fileName: string): Promise<void>;
}
