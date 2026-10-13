import { getConversationCapability, getVisionCapability, resolveCatalogModel } from '@agent-desktop/client/model-capabilities';
import { loadWebRuntimeSettings, saveWebRuntimeSettings } from './runtime-settings-storage.js';
import { DEFAULT_MODEL_PROVIDERS } from '@agent-desktop/client';
import type {
  AgentActivityItem,
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskResult,
  RuntimeSettings,
  Attachment,
  ExtensionItem,
  ExtensionSnapshot,
} from '@agent-desktop/client';

/** Web Host 仅用于 UI 开发和自动化测试，不连接真实 Agent Runtime。 */
export function createWebClientApi(): AgentClientApi {
  let activeSessionId = 'web-session-1';
  let nextSession = 2;
  const sessionIds = new Set([activeSessionId]);
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const extensionListeners = new Set<() => void>();
  let settings: RuntimeSettings = loadWebRuntimeSettings() ?? {
    modelProviders: structuredClone(DEFAULT_MODEL_PROVIDERS),
    conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    fallbackVisionModel: null, fallbackVisionEnabled: false,
    whisper: { modelPath: '', cliPath: '' },
    memoryEnabled: true,
    memoryFromToolChatsEnabled: true,
  };
  let customInstructions = { path: 'D:/Users/web/AGENTS.md', content: '' };
  let memories: import('@agent-desktop/client').MemoryEntry[] = [];
  let activeTaskController: AbortController | undefined;
  // 浏览器预览使用内存夹具；本地复制、SQLite 和 MCP 的实际实现由 Desktop 宿主提供。
  let plugins: ExtensionItem[] = [{ id: 'plugin:video-editing', kind: 'plugin', name: '语义视频剪辑', description: '按对白与画面选择片段，并逐项验收最终视频。', longDescription: '按对白与画面选择片段，并逐项验收最终视频。', developerName: 'Agent Desktop', category: 'Productivity', capabilities: ['Local', 'Video editing'], source: 'builtin', installed: false, enabled: false, version: '1.1.0', skillNames: ['semantic-editing', 'short-drama-editing'], serverNames: [] }];
  let skills: ExtensionItem[] = [{ id: 'skill:local-file-review', kind: 'skill', name: 'local-file-review', description: '检查本地项目文件、比较配置或分析代码问题时使用。', source: 'builtin', installed: false, enabled: false }];
  const snapshot = (): ExtensionSnapshot => ({ plugins: [...plugins], skills: [...skills] });

  return {
    extensions: {
      manage: async () => { throw new Error('市场与账户管理需要在桌面应用中进行。'); },
      list: async () => snapshot(),
      listSkills: async () => [...skills],
      importLocal: async () => { throw new Error('导入本地目录需要在桌面应用中进行。'); },
      install: async id => {
        plugins = plugins.map(item => item.id === id ? { ...item, installed: true, enabled: true } : item);
        skills = skills.map(item => item.id === id ? { ...item, installed: true, enabled: true } : item);
        if (id === 'plugin:video-editing' && !skills.some(item => item.pluginId === id)) {
          skills.push(
            { id: `${id}/semantic-editing`, kind: 'skill', name: 'semantic-editing', displayName: '语义视频剪辑', shortDescription: '按对白与画面选择片段，并验收最终视频。', description: '按讲解内容、对白或画面要求剪辑视频并验收候选成片时使用。', defaultPrompt: '使用 $semantic-editing 根据我的内容要求剪辑视频并验收。', source: 'plugin', pluginId: id, installed: true, enabled: true },
            { id: `${id}/short-drama-editing`, kind: 'skill', name: 'short-drama-editing', displayName: '短剧剪辑', shortDescription: '按剧情冲突与对白剪辑，逐项验收候选成片。', description: '按剧情节奏、对白和画面整理短剧片段并验收候选成片时使用。', defaultPrompt: '使用 $short-drama-editing 整理短剧素材，先确认画幅、时长与剧情重点。', source: 'plugin', pluginId: id, installed: true, enabled: true },
          );
        }
        return snapshot();
      },
      setEnabled: async (id, enabled) => {
        plugins = plugins.map(item => item.id === id ? { ...item, enabled } : item);
        skills = skills.map(item => item.id === id || item.pluginId === id ? { ...item, enabled } : item);
        return snapshot();
      },
      uninstall: async id => {
        plugins = plugins.map(item => item.id === id ? { ...item, installed: false, enabled: false } : item);
        skills = skills.filter(item => item.pluginId !== id).map(item => item.id === id ? { ...item, installed: false, enabled: false } : item);
        return snapshot();
      },
      readSkill: async id => `---\nname: ${skills.find(item => item.id === id)?.name ?? id}\ndescription: 本地任务技能\n---\n\n浏览器预览技能正文：${id}`,
      reconcile: async () => { extensionListeners.forEach(listener => listener()); return snapshot(); },
      onChanged: listener => { extensionListeners.add(listener); return () => extensionListeners.delete(listener); },
      readDetail: async id => id.startsWith('plugin:video-editing') && !id.includes('/')
        ? JSON.stringify({ name: 'video-editing', version: '1.1.0', skills: './skills' }, null, 2)
        : `---\nname: ${skills.find(item => item.id === id)?.name ?? id}\ndescription: 本地任务技能\n---\n\n浏览器预览仅提供界面夹具；完整技能指令由桌面应用读取。`,
    },
    answerQuestion: async () => { throw new Error('Web 开发宿主没有待回答问题。'); },
    closeTerminal: async () => { throw new Error('Web 开发宿主没有运行中的终端。'); },
    resizeTerminal: async () => undefined,
    loadRuntimeSettings: async () => settings,
    listProviderModels: async () => { throw new Error('获取模型目录需要在桌面应用中进行。'); },
    openModelConfig: async () => { throw new Error('查看配置文件需要在桌面应用中进行。'); },
    saveRuntimeSettings: async update => {
      let providers = [...settings.modelProviders];
      if (update.modelProvider) {
        const { apiKey, ...provider } = update.modelProvider;
        const current = providers.find(item => item.id === provider.id);
        const next = { ...provider, builtin: current?.builtin ?? false, apiKey: apiKey === undefined ? current?.apiKey ?? { configured: false } : apiKey === null ? { configured: false } : { configured: true, source: 'saved' as const } };
        providers = current ? providers.map(item => item.id === provider.id ? next : item) : [...providers, next];
      }
      if (update.deleteModelProviderId) {
        const id = update.deleteModelProviderId;
        if (providers.find(item => item.id === id)?.builtin) throw new Error('不能删除内置供应商。');
        if (settings.conversationModel.providerId === id || settings.fallbackVisionModel?.providerId === id) throw new Error('请先切换正在使用的模型。');
        providers = providers.filter(item => item.id !== id);
      }
      const nextSettings = { ...settings, modelProviders: providers,
        conversationModel: update.conversationModel ?? settings.conversationModel,
        fallbackVisionModel: update.fallbackVisionModel === undefined ? settings.fallbackVisionModel : update.fallbackVisionModel,
        fallbackVisionEnabled: update.fallbackVisionEnabled ?? settings.fallbackVisionEnabled,
        ...(update.theme === undefined ? {} : { theme: update.theme ?? 'system' }),
        whisper: { modelPath: update.whisperModelPath === undefined ? settings.whisper.modelPath : update.whisperModelPath ?? '', cliPath: update.whisperCliPath === undefined ? settings.whisper.cliPath : update.whisperCliPath ?? '' } };
      if (getConversationCapability(resolveCatalogModel(providers, nextSettings.conversationModel).model) !== 'supported') throw new Error('对话模型必须确认支持文本输入和输出。');
      if (nextSettings.fallbackVisionModel !== null) resolveCatalogModel(providers, nextSettings.fallbackVisionModel);
      if (nextSettings.fallbackVisionEnabled) {
        if (nextSettings.fallbackVisionModel === null) throw new Error('请先配置备用视觉模型。');
        const fallback = resolveCatalogModel(providers, nextSettings.fallbackVisionModel);
        if (!fallback.provider.apiKey.configured || getVisionCapability(fallback.model) !== 'supported') throw new Error('备用视觉模型配置无效。');
      }
      if (update.memoryEnabled !== undefined) nextSettings.memoryEnabled = update.memoryEnabled;
      if (update.memoryFromToolChatsEnabled !== undefined) nextSettings.memoryFromToolChatsEnabled = update.memoryFromToolChatsEnabled;
      saveWebRuntimeSettings(nextSettings);
      settings = nextSettings;
      return settings;
    },
    loadMemories: async () => [...memories],
    deleteMemories: async () => { memories = []; },
    loadCustomInstructions: async () => customInstructions,
    saveCustomInstructions: async content => { customInstructions = { ...customInstructions, content }; return customInstructions; },
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
    // 浏览器仅提供明确的界面夹具；真实系统目录选择由桌面宿主负责。
    selectProjectDirectory: async () => 'D:/projects/web-project',
    openProjectDirectory: async () => { throw new Error('请在桌面应用中打开项目文件夹。'); },
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
        plannedToolCallCount: 3,
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
        toolName: 'read_file',
        durationMs: 18,
        files: [{ path: 'E:/videos/cut-plan.txt', label: 'cut-plan.txt', role: 'input' }],
      });
      listeners.forEach((listener) => listener({
        type: 'activity.detail',
        activityId: 'web-tool-2',
        detail: {
          kind: 'file-content',
          filePath: 'E:/videos/cut-plan.txt',
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          lines: ['保留开场人物对白', '删除中间停顿', '结尾保留 2 秒'],
        },
      }));
      emit({
        id: 'web-tool-3',
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
        // 逐项交付结果与真实宿主使用同一份契约：一项已交付，另一项保留未交付原因。
        outputs: [
          {
            outputItemId: 'web-out-1',
            status: 'published' as const,
            path: 'E:/videos/web-dev-artifact.mp4',
            fileName: 'web-dev-artifact.mp4',
          },
          {
            outputItemId: 'web-out-2',
            status: 'blocked' as const,
            reason: '内容要求当前没有可靠的自动判定与覆盖方法，尚不能确认。',
          },
        ],
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
