import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';

export const DESKTOP_CHANNELS = {
  selectVideo: 'desktop:select-video',
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
  selectVideoFile(): Promise<SelectedVideo | null>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  onAgentEvent(listener: (event: ToolActivityEvent) => void): () => void;
  openOutputFile(): Promise<void>;
}
