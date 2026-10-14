import { App as SharedApp, type AgentClientApi } from '@agent-desktop/client';
import type { AgentTaskIpcResult, AgentTaskOutputFile, AgentTaskOutputItemResult, AgentTaskResult } from '../shared/ipc.js';

/** 错误对象在 contextBridge 之后创建，取消身份与已交付产物才不会在跨上下文时丢失。 */
function unwrapTaskResult(ipcResult: AgentTaskIpcResult): AgentTaskResult {
  if (ipcResult.status === 'success') return ipcResult.result;
  const taskError = new Error(ipcResult.errorMessage) as Error & {
    outputFiles?: readonly AgentTaskOutputFile[];
    outputs?: readonly AgentTaskOutputItemResult[];
    taskState?: import('@agent-desktop/client').AgentTaskState;
  };
  taskError.name = ipcResult.errorName;
  if (ipcResult.outputFiles !== undefined) taskError.outputFiles = ipcResult.outputFiles;
  if (ipcResult.outputs !== undefined) taskError.outputs = ipcResult.outputs;
  if (ipcResult.taskState !== undefined) taskError.taskState = ipcResult.taskState;
  throw taskError;
}

/** Desktop 入口把桥接结果还原为共享客户端的任务契约，其余宿主能力直接传递。 */
export function App() {
  const { runAgentTask, recoverTask, ...capabilities } = window.agentDesktop;
  const api: AgentClientApi = {
    ...capabilities,
    runAgentTask: async request => unwrapTaskResult(await runAgentTask(request)),
    ...(recoverTask === undefined ? {} : {
      recoverTask: async (request, sourceTurnId, mode) => unwrapTaskResult(await recoverTask(request, sourceTurnId, mode)),
    }),
  };
  return <SharedApp api={api} />;
}
