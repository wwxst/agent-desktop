import type {
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  AgentTaskResult,
  Attachment,
  AttachmentRole,
} from '@agent-desktop/client';

export const DESKTOP_CHANNELS = {
  getUpdateState: 'desktop:get-update-state',
  updateState: 'desktop:update-state',
  installUpdate: 'desktop:install-update',
  retryUpdate: 'desktop:retry-update',
  listExtensions: 'desktop:list-extensions',
  importExtension: 'desktop:import-extension',
  installExtension: 'desktop:install-extension',
  enableExtension: 'desktop:enable-extension',
  uninstallExtension: 'desktop:uninstall-extension',
  readExtension: 'desktop:read-extension',
  listSkills: 'desktop:list-skills',
  readSkill: 'desktop:read-skill',
  reconcileExtensions: 'desktop:reconcile-extensions',
  extensionsChanged: 'desktop:extensions-changed',
  manageExtensions: 'desktop:manage-extensions',
  loadRuntimeSettings: 'desktop:load-runtime-settings',
  saveRuntimeSettings: 'desktop:save-runtime-settings',
  loadMemories: 'desktop:load-memories',
  deleteMemories: 'desktop:delete-memories',
  loadCustomInstructions: 'desktop:load-custom-instructions',
  saveCustomInstructions: 'desktop:save-custom-instructions',
  listProviderModels: 'desktop:list-provider-models',
  openModelConfig: 'desktop:open-model-config',
  getActiveSessionId: 'desktop:get-active-session-id',
  loadClientState: 'desktop:load-client-state',
  saveClientState: 'desktop:save-client-state',
  selectAttachmentFiles: 'desktop:select-attachment-files',
  removeAttachment: 'desktop:remove-attachment',
  newSession: 'desktop:new-session',
  selectProjectDirectory: 'desktop:select-project-directory',
  openProjectDirectory: 'desktop:open-project-directory',
  switchSession: 'desktop:switch-session',
  deleteSession: 'desktop:delete-session',
  runAgentTask: 'desktop:run-agent-task',
  cancelTask: 'desktop:cancel-task',
  decideApproval: 'desktop:decide-approval',
  answerQuestion: 'desktop:answer-question',
  closeTerminal: 'desktop:close-terminal',
  resizeTerminal: 'desktop:resize-terminal',
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
    /** 取消或失败前已经真实交付的文件与逐项结果仍然可见。 */
    readonly outputFiles?: readonly AgentTaskOutputFile[];
    readonly outputs?: readonly AgentTaskOutputItemResult[];
  };

export type {
  AgentRuntimeEvent,
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  AgentTaskResult,
  Attachment,
  AttachmentRole,
};
export type DesktopApi = AgentClientApi;
