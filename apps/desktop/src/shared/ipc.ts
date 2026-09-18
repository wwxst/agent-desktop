import type {
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskOutputFile,
  AgentTaskResult,
  Attachment,
  AttachmentRole,
} from '@agent-desktop/client';

export const DESKTOP_CHANNELS = {
  loadRuntimeSettings: 'desktop:load-runtime-settings',
  saveRuntimeSettings: 'desktop:save-runtime-settings',
  getActiveSessionId: 'desktop:get-active-session-id',
  loadClientState: 'desktop:load-client-state',
  saveClientState: 'desktop:save-client-state',
  selectAttachmentFiles: 'desktop:select-attachment-files',
  removeAttachment: 'desktop:remove-attachment',
  newSession: 'desktop:new-session',
  switchSession: 'desktop:switch-session',
  deleteSession: 'desktop:delete-session',
  runAgentTask: 'desktop:run-agent-task',
  cancelTask: 'desktop:cancel-task',
  agentEvent: 'desktop:agent-event',
  closeReady: 'desktop:close-ready',
  prepareClose: 'desktop:prepare-close',
  closePrepared: 'desktop:close-prepared',
  revealFile: 'desktop:reveal-file',
} as const;

/**
 * Electron 不会把 Main 抛出 Error 的自定义字段传给 Preload，因此任务终态使用可结构化克隆的结果。
 * Preload 再把 error 分支还原成 Renderer 既有的 Promise rejection 契约。
 */
export type AgentTaskIpcResult =
  | { readonly status: 'success'; readonly result: AgentTaskResult }
  | {
    readonly status: 'error';
    readonly errorName: string;
    readonly errorMessage: string;
    readonly outputFiles?: readonly AgentTaskOutputFile[];
  };

export type { AgentRuntimeEvent, AgentTaskOutputFile, AgentTaskResult, Attachment, AttachmentRole };
export type DesktopApi = AgentClientApi;
