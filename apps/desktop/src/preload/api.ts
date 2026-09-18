import type {
  AgentTaskIpcResult,
  AgentTaskOutputFile,
  AgentRuntimeEvent,
  DesktopApi,
} from '../shared/ipc.js';
import { DESKTOP_CHANNELS } from '../shared/ipc.js';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

async function invokeAgentTask(
  ipc: IpcRendererPort,
  prompt: string,
): ReturnType<DesktopApi['runAgentTask']> {
  try {
    const ipcResult = await ipc.invoke(DESKTOP_CHANNELS.runAgentTask, prompt) as AgentTaskIpcResult;
    if (ipcResult.status === 'success') return ipcResult.result;

    const taskError = new Error(ipcResult.errorMessage) as Error & {
      outputFiles?: readonly AgentTaskOutputFile[];
    };
    taskError.name = ipcResult.errorName;
    if (ipcResult.outputFiles !== undefined) taskError.outputFiles = ipcResult.outputFiles;
    throw taskError;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Electron 会给 Main 的业务错误增加固定 IPC 前缀；Renderer 只展示原始任务错误。
    const remoteError = /^Error invoking remote method '.+?': (Error|AbortError): (.+)$/.exec(error.message);
    if (remoteError !== null) {
      const [, errorName, message] = remoteError;
      const normalized = new Error(message) as Error & {
        outputFiles?: readonly AgentTaskOutputFile[];
      };
      if (errorName === 'AbortError') normalized.name = 'AbortError';
      // 兼容 Electron 自身拒绝的普通错误；结构化任务失败在上面已经还原完整字段。
      const outputFiles = readErrorOutputFiles(error);
      if (outputFiles !== undefined) normalized.outputFiles = outputFiles;
      throw normalized;
    }
    throw error;
  }
}

/** 从宿主抛出的错误里读取已成功产物；形状不符时不附加字段。 */
function readErrorOutputFiles(error: Error): readonly AgentTaskOutputFile[] | undefined {
  const value = (error as { outputFiles?: unknown }).outputFiles;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const files: AgentTaskOutputFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { path, fileName } = item as { path?: unknown; fileName?: unknown };
    if (typeof path !== 'string' || typeof fileName !== 'string') return undefined;
    files.push({ path, fileName });
  }
  return files;
}

/** 把当前桌面闭环需要的宿主操作暴露给 Renderer。 */
export function createDesktopApi(ipc: IpcRendererPort): DesktopApi {
  return {
    loadRuntimeSettings: () => ipc.invoke(
      DESKTOP_CHANNELS.loadRuntimeSettings,
    ) as ReturnType<DesktopApi['loadRuntimeSettings']>,
    saveRuntimeSettings: (update) => ipc.invoke(
      DESKTOP_CHANNELS.saveRuntimeSettings,
      update,
    ) as ReturnType<DesktopApi['saveRuntimeSettings']>,
    loadClientState: () => ipc.invoke(
      DESKTOP_CHANNELS.loadClientState,
    ) as ReturnType<DesktopApi['loadClientState']>,
    saveClientState: async (state) => {
      await ipc.invoke(DESKTOP_CHANNELS.saveClientState, state);
    },
    onPrepareClose: (listener) => {
      // 关闭前提交由 Client 决定何时可落盘，Preload 只负责把结果回告主进程。
      const receive: IpcListener = () => {
        void (async () => {
          try {
            await listener();
            ipc.send(DESKTOP_CHANNELS.closePrepared, null);
          } catch (error) {
            ipc.send(
              DESKTOP_CHANNELS.closePrepared,
              error instanceof Error ? error.message : '无法保存本地会话。',
            );
          }
        })();
      };
      ipc.on(DESKTOP_CHANNELS.prepareClose, receive);
      // Main 只有在监听器真实注册后才拦截窗口关闭，避免启动阶段的关闭请求无人接收。
      void ipc.invoke(DESKTOP_CHANNELS.closeReady);
      return () => ipc.removeListener(DESKTOP_CHANNELS.prepareClose, receive);
    },
    getActiveSessionId: () => ipc.invoke(
      DESKTOP_CHANNELS.getActiveSessionId,
    ) as ReturnType<DesktopApi['getActiveSessionId']>,
    selectAttachmentFiles: () => ipc.invoke(
      DESKTOP_CHANNELS.selectAttachmentFiles,
    ) as ReturnType<DesktopApi['selectAttachmentFiles']>,
    removeAttachment: async (index) => {
      await ipc.invoke(DESKTOP_CHANNELS.removeAttachment, index);
    },
    newSession: () => ipc.invoke(
      DESKTOP_CHANNELS.newSession,
    ) as ReturnType<DesktopApi['newSession']>,
    switchSession: async (sessionId) => {
      await ipc.invoke(DESKTOP_CHANNELS.switchSession, sessionId);
    },
    deleteSession: (sessionId) => ipc.invoke(
      DESKTOP_CHANNELS.deleteSession,
      sessionId,
    ) as ReturnType<DesktopApi['deleteSession']>,
    runAgentTask: (prompt) => invokeAgentTask(ipc, prompt),
    cancelTask: async () => { await ipc.invoke(DESKTOP_CHANNELS.cancelTask); },
    onAgentEvent: (listener) => {
      const receive: IpcListener = (_event, payload) => listener(payload as AgentRuntimeEvent);
      ipc.on(DESKTOP_CHANNELS.agentEvent, receive);
      return () => ipc.removeListener(DESKTOP_CHANNELS.agentEvent, receive);
    },
    revealFile: async (path) => {
      await ipc.invoke(DESKTOP_CHANNELS.revealFile, path);
    },
  };
}
