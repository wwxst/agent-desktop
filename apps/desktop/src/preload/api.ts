import type {
  AgentTaskIpcResult,
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
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
      outputs?: readonly AgentTaskOutputItemResult[];
    };
    taskError.name = ipcResult.errorName;
    if (ipcResult.outputFiles !== undefined) taskError.outputFiles = ipcResult.outputFiles;
    if (ipcResult.outputs !== undefined) taskError.outputs = ipcResult.outputs;
    throw taskError;
  } catch (error) {
    throw unwrapRemoteError(error);
  }
}

/**
 * Electron 在 invoke 拒绝时给 Main 的业务错误加上固定前缀
 * （`Error invoking remote method '<channel>': Error: `），调用方只展示宿主真实消息。
 * 只剥离已证实的这一层包装：不匹配的错误和非 Error 抛出值都原样返回，不用默认值或兜底文案掩盖。
 */
function unwrapRemoteError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const remoteError = /^Error invoking remote method '.+?': (Error|AbortError): (.+)$/.exec(error.message);
  if (remoteError === null) return error;
  const [, errorName, message] = remoteError;
  const normalized = new Error(message) as Error & {
    outputFiles?: readonly AgentTaskOutputFile[];
    outputs?: readonly AgentTaskOutputItemResult[];
  };
  if (errorName === 'AbortError') normalized.name = 'AbortError';
  // Electron 自身拒绝任务时仍可能带上此前已成功的产物与逐项结果，必须继续透传。
  const outputFiles = readErrorOutputFiles(error);
  if (outputFiles !== undefined) normalized.outputFiles = outputFiles;
  const outputs = readErrorOutputResults(error);
  if (outputs !== undefined) normalized.outputs = outputs;
  return normalized;
}

/** 从宿主抛出的错误里读取逐项交付结果；形状不符时不附加字段。 */
function readErrorOutputResults(error: Error): readonly AgentTaskOutputItemResult[] | undefined {
  const value = (error as { outputs?: unknown }).outputs;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const results: AgentTaskOutputItemResult[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.outputItemId !== 'string' || typeof record.status !== 'string') return undefined;
    if (record.status === 'published') {
      if (typeof record.path !== 'string' || typeof record.fileName !== 'string') return undefined;
      results.push({
        outputItemId: record.outputItemId,
        status: 'published',
        path: record.path,
        fileName: record.fileName,
      });
      continue;
    }
    if (record.status !== 'failed' && record.status !== 'blocked' && record.status !== 'incomplete') {
      return undefined;
    }
    if (typeof record.reason !== 'string') return undefined;
    results.push({ outputItemId: record.outputItemId, status: record.status, reason: record.reason });
  }
  return results;
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
    decideApproval: async (requestId, approved) => {
      await ipc.invoke(DESKTOP_CHANNELS.decideApproval, requestId, approved);
    },
    onAgentEvent: (listener) => {
      const receive: IpcListener = (_event, payload) => listener(payload as AgentRuntimeEvent);
      ipc.on(DESKTOP_CHANNELS.agentEvent, receive);
      return () => ipc.removeListener(DESKTOP_CHANNELS.agentEvent, receive);
    },
    revealFile: async (path) => {
      try {
        await ipc.invoke(DESKTOP_CHANNELS.revealFile, path);
      } catch (error) {
        // 定位失败要在活动行和产物卡里显示宿主真实原因，不能泄漏 Electron 的 invoke 包装。
        throw unwrapRemoteError(error);
      }
    },
  };
}
