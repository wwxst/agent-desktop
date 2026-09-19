import type {
  AgentActivityItem,
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskResult,
  RuntimeSettings,
  Attachment,
} from '@agent-desktop/client';

/** Web Host 仅用于 UI 开发和自动化测试，不连接真实 Agent Runtime。 */
export function createWebClientApi(): AgentClientApi {
  let activeSessionId = 'web-session-1';
  let nextSession = 2;
  const sessionIds = new Set([activeSessionId]);
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let settings: RuntimeSettings = {
    deepSeek: {
      apiKey: { configured: false },
      baseUrl: '',
      model: '',
    },
    vision: {
      apiKey: { configured: false },
      baseUrl: '',
    },
    whisper: { modelPath: '', cliPath: '' },
  };
  let activeTaskController: AbortController | undefined;

  return {
    loadRuntimeSettings: async () => settings,
    saveRuntimeSettings: async (update) => {
      settings = {
        deepSeek: {
          apiKey: update.deepSeekApiKey === undefined
            ? settings.deepSeek.apiKey
            : update.deepSeekApiKey === null || update.deepSeekApiKey.length === 0
              ? { configured: false }
              : { configured: true, source: 'saved' },
          baseUrl: update.deepSeekBaseUrl === undefined
            ? settings.deepSeek.baseUrl
            : update.deepSeekBaseUrl ?? '',
          model: update.deepSeekModel === undefined
            ? settings.deepSeek.model
            : update.deepSeekModel ?? '',
        },
        vision: {
          apiKey: update.visionApiKey === undefined
            ? settings.vision.apiKey
            : update.visionApiKey === null || update.visionApiKey.length === 0
              ? { configured: false }
              : { configured: true, source: 'saved' },
          baseUrl: update.visionBaseUrl === undefined
            ? settings.vision.baseUrl
            : update.visionBaseUrl ?? '',
        },
        whisper: {
          modelPath: update.whisperModelPath === undefined
            ? settings.whisper.modelPath
            : update.whisperModelPath ?? '',
          cliPath: update.whisperCliPath === undefined
            ? settings.whisper.cliPath
            : update.whisperCliPath ?? '',
        },
      };
      return settings;
    },
    loadClientState: async () => null,
    saveClientState: async () => undefined,
    // Web 开发宿主没有窗口关闭流程，也不保存状态，因此不会请求关闭前提交。
    onPrepareClose: () => () => undefined,
    getActiveSessionId: async () => activeSessionId,
    // Web 开发宿主提供一个固定的主视频附件，供界面与自动化测试使用。
    selectAttachmentFiles: async (): Promise<readonly Attachment[]> => ([
      { path: 'E:/videos/web-test-video.mp4', name: 'web-test-video.mp4', role: 'video' },
    ]),
    removeAttachment: async () => undefined,
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
      if (activeTaskController !== undefined) throw new Error('已有任务正在执行。');
      const controller = new AbortController();
      activeTaskController = controller;
      const emit = (item: AgentActivityItem) => listeners.forEach((listener) => (
        listener({ type: 'activity', item })
      ));
      // Web Host 的模拟活动与真实 Desktop 使用同一份活动契约，形状来自真实视频工具参数。
      emit({ id: 'web-model-1', kind: 'analysis', status: 'running' });
      emit({
        id: 'web-model-1',
        kind: 'analysis',
        status: 'completed',
        durationMs: 320,
        plannedToolCallCount: 2,
      });
      emit({
        id: 'web-tool-1',
        kind: 'tool',
        status: 'running',
        toolName: 'probe_media',
        files: [{ path: 'E:/videos/web-test-video.mp4', label: 'web-test-video.mp4', role: 'input' }],
      });
      // 模拟 Host 的实时文本增量，让共享 Client 的流式展示在浏览器宿主中也可验证。
      listeners.forEach((listener) => listener({ type: 'text.delta', delta: '开发测试宿主正在' }));
      listeners.forEach((listener) => listener({ type: 'text.delta', delta: '生成结果…' }));
      // Web Host 保留短暂执行态，让真实浏览器能够观察完整的活动生命周期。
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 400);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
        });
      } catch (error) {
        if (activeTaskController === controller) activeTaskController = undefined;
        throw error;
      }
      emit({
        id: 'web-tool-1',
        kind: 'tool',
        status: 'completed',
        toolName: 'probe_media',
        durationMs: 12,
        files: [{ path: 'E:/videos/web-test-video.mp4', label: 'web-test-video.mp4', role: 'input' }],
      });
      emit({
        id: 'web-tool-2',
        kind: 'tool',
        status: 'completed',
        toolName: 'trim_video',
        durationMs: 860,
        files: [
          { path: 'E:/videos/web-test-video.mp4', label: 'web-test-video.mp4', role: 'input' },
          { path: 'E:/videos/web-dev-artifact.mp4', label: 'web-dev-artifact.mp4', role: 'output' },
        ],
      });
      const result = {
        responseText: `开发测试宿主已模拟完成：${prompt}`,
        traceId: `web-trace-${Date.now()}`,
        outputFiles: [{ path: 'E:/videos/web-dev-artifact.mp4', fileName: 'web-dev-artifact.mp4' }],
      };
      if (activeTaskController === controller) activeTaskController = undefined;
      return result;
    },
    cancelTask: async () => {
      if (activeTaskController === undefined) throw new Error('当前没有正在执行的任务。');
      activeTaskController.abort();
    },
    /**
     * Web Host 不执行本地操作，也就没有需要确认的目录，因此这里只补齐客户端契约：
     * 没有待决请求时任何决定都是失效的，行为与真实宿主的过期请求一致。
     */
    decideApproval: async () => {
      throw new Error('该审批请求已失效。');
    },
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Web 开发宿主没有系统文件管理器，定位动作只用于验证界面的成功路径。
    revealFile: async () => undefined,
  };
}
