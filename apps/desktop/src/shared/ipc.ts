import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import type {
  AgentClientApi,
  AgentTaskResult,
  SelectedVideo,
} from '@agent-desktop/client';

export const DESKTOP_CHANNELS = {
  getActiveSessionId: 'desktop:get-active-session-id',
  loadClientState: 'desktop:load-client-state',
  saveClientState: 'desktop:save-client-state',
  selectVideo: 'desktop:select-video',
  removeVideo: 'desktop:remove-video',
  newSession: 'desktop:new-session',
  switchSession: 'desktop:switch-session',
  deleteSession: 'desktop:delete-session',
  runAgentTask: 'desktop:run-agent-task',
  agentEvent: 'desktop:agent-event',
  openOutputFile: 'desktop:open-output-file',
} as const;

export type ToolActivityEvent = Extract<
  ExecutionTraceEvent,
  { type: 'tool.started' | 'tool.completed' | 'tool.failed' }
>;

export type { AgentTaskResult, SelectedVideo };
export type DesktopApi = AgentClientApi;
