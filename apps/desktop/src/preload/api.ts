import type { DesktopApi, ToolActivityEvent } from '../shared/ipc.js';
import { DESKTOP_CHANNELS } from '../shared/ipc.js';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

/** 只把当前桌面闭环需要的四个操作暴露给 Renderer。 */
export function createDesktopApi(ipc: IpcRendererPort): DesktopApi {
  return {
    selectVideoFile: () => ipc.invoke(DESKTOP_CHANNELS.selectVideo) as ReturnType<DesktopApi['selectVideoFile']>,
    runAgentTask: (prompt) => ipc.invoke(
      DESKTOP_CHANNELS.runAgentTask,
      prompt,
    ) as ReturnType<DesktopApi['runAgentTask']>,
    onAgentEvent: (listener) => {
      const receive: IpcListener = (_event, payload) => listener(payload as ToolActivityEvent);
      ipc.on(DESKTOP_CHANNELS.agentEvent, receive);
      return () => ipc.removeListener(DESKTOP_CHANNELS.agentEvent, receive);
    },
    openOutputFile: async () => {
      await ipc.invoke(DESKTOP_CHANNELS.openOutputFile);
    },
  };
}
