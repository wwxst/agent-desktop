import type { AgentRuntimeEvent, DesktopApi } from '../shared/ipc.js';
import { DESKTOP_CHANNELS } from '../shared/ipc.js';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

async function invokeAgentTask(
  ipc: IpcRendererPort,
  prompt: string,
): ReturnType<DesktopApi['runAgentTask']> {
  try {
    return await ipc.invoke(DESKTOP_CHANNELS.runAgentTask, prompt) as Awaited<
      ReturnType<DesktopApi['runAgentTask']>
    >;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Electron 会给 Main 的业务错误增加固定 IPC 前缀；Renderer 只展示原始任务错误。
    const remoteError = /^Error invoking remote method '.+?': (Error|AbortError): (.+)$/.exec(error.message);
    if (remoteError !== null) {
      const [, errorName, message] = remoteError;
      const normalized = new Error(message);
      if (errorName === 'AbortError') normalized.name = 'AbortError';
      throw normalized;
    }
    throw error;
  }
}

/** 只把当前桌面闭环需要的八个操作暴露给 Renderer。 */
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
    getActiveSessionId: () => ipc.invoke(
      DESKTOP_CHANNELS.getActiveSessionId,
    ) as ReturnType<DesktopApi['getActiveSessionId']>,
    selectVideoFile: () => ipc.invoke(DESKTOP_CHANNELS.selectVideo) as ReturnType<DesktopApi['selectVideoFile']>,
    removeSelectedVideo: async (index) => {
      await ipc.invoke(DESKTOP_CHANNELS.removeVideo, index);
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
    openOutputFile: async (fileName) => {
      await ipc.invoke(DESKTOP_CHANNELS.openOutputFile, fileName);
    },
  };
}
