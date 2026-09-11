import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';

export const DESKTOP_CHANNELS = {
  getActiveSessionId: 'desktop:get-active-session-id',
  selectVideo: 'desktop:select-video',
  removeVideo: 'desktop:remove-video',
  newSession: 'desktop:new-session',
  switchSession: 'desktop:switch-session',
  runAgentTask: 'desktop:run-agent-task',
  agentEvent: 'desktop:agent-event',
  openOutputFile: 'desktop:open-output-file',
} as const;

export type ToolActivityEvent = Extract<
  ExecutionTraceEvent,
  { type: 'tool.started' | 'tool.completed' | 'tool.failed' }
>;

export interface SelectedVideo {
  readonly name: string;
}

export interface AgentTaskResult {
  readonly responseText: string;
  readonly traceId: string;
  readonly outputFileName?: string;
}

export interface DesktopApi {
  getActiveSessionId(): Promise<string>;
  selectVideoFile(): Promise<readonly SelectedVideo[] | null>;
  removeSelectedVideo(index: number): Promise<void>;
  newSession(): Promise<string>;
  switchSession(sessionId: string): Promise<void>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  onAgentEvent(listener: (event: ToolActivityEvent) => void): () => void;
  openOutputFile(fileName: string): Promise<void>;
}
