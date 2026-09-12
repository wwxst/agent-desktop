import type {
  AgentClientApi,
  AgentTaskResult,
  SelectedVideo,
  ToolActivityEvent,
} from '@agent-desktop/client';

/** Web Host 仅用于 UI 开发和自动化测试，不连接真实 Agent Runtime。 */
export function createWebClientApi(): AgentClientApi {
  let activeSessionId = 'web-session-1';
  let nextSession = 2;
  const sessionIds = new Set([activeSessionId]);
  const listeners = new Set<(event: ToolActivityEvent) => void>();

  return {
    loadClientState: async () => null,
    saveClientState: async () => undefined,
    getActiveSessionId: async () => activeSessionId,
    selectVideoFile: async (): Promise<readonly SelectedVideo[]> => ([{ name: 'web-test-video.mp4' }]),
    removeSelectedVideo: async () => undefined,
    newSession: async () => {
      activeSessionId = `web-session-${nextSession}`;
      nextSession += 1;
      sessionIds.add(activeSessionId);
      return activeSessionId;
    },
    switchSession: async (sessionId) => {
      if (!sessionIds.has(sessionId)) throw new Error('找不到对应的会话。');
      activeSessionId = sessionId;
    },
    deleteSession: async (sessionId) => {
      if (!sessionIds.has(sessionId)) throw new Error('找不到对应的会话。');
      sessionIds.delete(sessionId);
      if (sessionIds.size > 0) {
        if (sessionId === activeSessionId) activeSessionId = sessionIds.values().next().value!;
        return activeSessionId;
      }
      activeSessionId = `web-session-${nextSession}`;
      nextSession += 1;
      sessionIds.add(activeSessionId);
      return activeSessionId;
    },
    runAgentTask: async (prompt): Promise<AgentTaskResult> => {
      const base = {
        turnId: `web-turn-${Date.now()}`,
        stepId: 'web-step-1',
        toolCallId: 'web-tool-1',
        toolName: 'trim_video',
      };
      listeners.forEach((listener) => listener({ type: 'tool.started', ...base }));
      // Web Host 保留短暂执行态，让真实浏览器能够观察完整的工具生命周期。
      await new Promise((resolve) => setTimeout(resolve, 200));
      listeners.forEach((listener) => listener({ type: 'tool.completed', ...base, durationMs: 12 }));
      return {
        responseText: `开发测试宿主已模拟完成：${prompt}`,
        traceId: `web-trace-${Date.now()}`,
        outputFileName: 'web-dev-artifact.mp4',
      };
    },
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openOutputFile: async () => undefined,
  };
}
