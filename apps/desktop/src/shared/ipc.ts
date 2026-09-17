import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import type {
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskResult,
  SelectedVideo,
} from '@agent-desktop/client';

export const DESKTOP_CHANNELS = {
  loadRuntimeSettings: 'desktop:load-runtime-settings',
  saveRuntimeSettings: 'desktop:save-runtime-settings',
  getActiveSessionId: 'desktop:get-active-session-id',
  loadClientState: 'desktop:load-client-state',
  saveClientState: 'desktop:save-client-state',
  selectVideo: 'desktop:select-video',
  removeVideo: 'desktop:remove-video',
  newSession: 'desktop:new-session',
  switchSession: 'desktop:switch-session',
  deleteSession: 'desktop:delete-session',
  runAgentTask: 'desktop:run-agent-task',
  cancelTask: 'desktop:cancel-task',
  agentEvent: 'desktop:agent-event',
  openOutputFile: 'desktop:open-output-file',
} as const;

/** Execution Trace 中属于 Tool Activity 的事件子集，Main 只把这三类投影为工具活动。 */
export type ToolActivityEvent = Extract<
  ExecutionTraceEvent,
  { type: 'tool.started' | 'tool.completed' | 'tool.failed' }
>;

export type { AgentRuntimeEvent, AgentTaskResult, SelectedVideo };
export type DesktopApi = AgentClientApi;
