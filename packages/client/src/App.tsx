import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  AgentActivityItem,
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskOutputFile,
  ClientAssistantMessage,
  ClientAssistantMessageBase,
  ClientConversation,
  ClientConversationMessage,
  ClientStateSnapshot,
} from './api.js';
import { Composer } from './components/Composer.js';
import { ConversationPanel } from './components/ConversationPanel.js';
import { RuntimeSettingsPanel } from './components/RuntimeSettingsPanel.js';
import { SessionSidebar } from './components/SessionSidebar.js';

const INITIAL_RENDERER_SESSION_ID = 'initializing-session';

function createConversation(id: string, number: number): ClientConversation {
  return {
    id,
    title: `会话 ${number}`,
    titleManuallyRenamed: false,
    messages: [],
    prompt: '',
    attachments: [],
  };
}

function conversationTitle(prompt: string): string {
  return prompt.length > 18 ? `${prompt.slice(0, 18)}…` : prompt;
}

/**
 * 把 Assistant 消息投影回不含临时字段的基础结构。
 * 完成、取消和失败分支在类型上都没有 streamedText，这里负责在状态切换时丢弃它。
 */
function dropStreamedText(message: ClientAssistantMessage): ClientAssistantMessageBase {
  return {
    id: message.id,
    role: message.role,
    activity: message.activity,
    activityExpanded: message.activityExpanded,
  };
}

/** 同一个活动 id 只保留一条记录：开始、完成、失败和取消都用新状态覆盖旧状态。 */
function upsertActivity(
  activity: readonly AgentActivityItem[],
  nextItem: AgentActivityItem,
): readonly AgentActivityItem[] {
  const existingIndex = activity.findIndex((item) => item.id === nextItem.id);
  return existingIndex === -1
    ? [...activity, nextItem]
    : activity.map((item, index) => (index === existingIndex ? nextItem : item));
}

interface AppProps {
  readonly api: AgentClientApi;
}

/** App 只持有会话状态、运行状态和宿主调用；界面由侧栏、对话工作区和输入区三个组件承担。 */
export function App({ api }: AppProps) {
  const [conversations, setConversations] = useState<readonly ClientConversation[]>([
    createConversation(INITIAL_RENDERER_SESSION_ID, 1),
  ]);
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_RENDERER_SESSION_ID);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeView, setActiveView] = useState<'conversation' | 'settings'>('conversation');
  // 宿主关闭请求序号：即使展示状态没有变化，每次请求也重新触发一次关闭前提交。
  const [closeRequestSequence, setCloseRequestSequence] = useState(0);
  const pendingClose = useRef<((error?: Error) => void) | undefined>(undefined);
  // 常规防抖保存与关闭前强制保存共用一条队列，避免两个 IPC 同时写同一个临时文件。
  const pendingStateSave = useRef<Promise<void>>(Promise.resolve());
  const activeSessionIdRef = useRef(INITIAL_RENDERER_SESSION_ID);
  const nextSessionNumber = useRef(2);
  const nextMessageId = useRef(1);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  // 用户是否仍停留在最新内容处：只有跟随状态才让新内容自动滚动，向上阅读时保留当前位置。
  const followsLatest = useRef(true);

  const activeConversation = conversations.find((conversation) => (
    conversation.id === activeSessionId
  )) ?? conversations[0]!;

  const queueClientStateSave = (snapshot: ClientStateSnapshot): Promise<void> => {
    const save = pendingStateSave.current.then(() => api.saveClientState(snapshot));
    // 队列本身吸收上一项失败，让关闭时仍能用最新快照重试；调用方仍拿到本次原始结果。
    pendingStateSave.current = save.catch(() => undefined);
    return save;
  };

  const updateConversation = (
    sessionId: string,
    update: (conversation: ClientConversation) => ClientConversation,
  ) => {
    setConversations((currentConversations) => currentConversations.map((conversation) => (
      conversation.id === sessionId ? update(conversation) : conversation
    )));
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      // 同时发起宿主活动会话查询，避免加载持久化快照时重新引入初始 Session ID 竞态。
      const activeSessionPromise = api.getActiveSessionId();
      const savedState = await api.loadClientState();
      if (!mounted || activeSessionIdRef.current !== INITIAL_RENDERER_SESSION_ID) return;

      if (savedState !== null) {
        const messageIds = savedState.conversations.flatMap((conversation) => (
          conversation.messages.map((message) => message.id)
        ));
        activeSessionIdRef.current = savedState.activeSessionId;
        nextSessionNumber.current = savedState.conversations.length + 1;
        nextMessageId.current = Math.max(0, ...messageIds) + 1;
        setConversations(savedState.conversations);
        setActiveSessionId(savedState.activeSessionId);
        setIsSessionReady(true);
        return;
      }

      const sessionId = await activeSessionPromise;
      if (!mounted || activeSessionIdRef.current !== INITIAL_RENDERER_SESSION_ID) return;
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      setConversations((currentConversations) => currentConversations.map((conversation) => (
        conversation.id === INITIAL_RENDERER_SESSION_ID
          ? { ...conversation, id: sessionId }
          : conversation
      )));
      setIsSessionReady(true);
    })();
    return () => { mounted = false; };
  }, [api]);

  useEffect(() => {
    if (!isSessionReady || isProcessing) return;
    // 关闭收尾正在提交同一份状态：取消尚未触发的防抖保存，避免关闭过程中重复写入。
    if (pendingClose.current !== undefined) return;
    const snapshot: ClientStateSnapshot = { conversations, activeSessionId };
    const timeout = setTimeout(() => {
      void queueClientStateSave(snapshot);
    }, 150);
    return () => clearTimeout(timeout);
  }, [activeSessionId, api, closeRequestSequence, conversations, isProcessing, isSessionReady]);

  useEffect(() => api.onPrepareClose(() => new Promise<void>((resolve, reject) => {
    pendingClose.current = (error) => { if (error === undefined) resolve(); else reject(error); };
    setCloseRequestSequence((sequence) => sequence + 1);
  })), [api]);

  // 关闭前提交：等本轮渲染把终态写入状态后再落盘，结果回告宿主，由宿主决定是否继续关闭。
  useEffect(() => {
    if (closeRequestSequence === 0) return;
    const settle = pendingClose.current;
    if (settle === undefined) return;
    // 初始状态还没加载完成时没有可提交的展示状态，放行关闭，避免用占位会话覆盖磁盘历史。
    if (!isSessionReady) {
      pendingClose.current = undefined;
      settle();
      return;
    }
    if (isProcessing) return;
    pendingClose.current = undefined;
    void (async () => {
      try {
        await queueClientStateSave({ conversations, activeSessionId });
        settle();
      } catch (error) {
        settle(error instanceof Error ? error : new Error('无法保存本地会话。'));
      }
    })();
  }, [activeSessionId, api, closeRequestSequence, conversations, isProcessing, isSessionReady]);

  useEffect(() => api.onAgentEvent((event: AgentRuntimeEvent) => {
    const sessionId = activeSessionIdRef.current;
    // 会话切换在执行期间禁用，因此运行期事件只会进入发起当前 Turn 的会话。
    updateConversation(sessionId, (conversation) => {
      const activeIndex = conversation.messages.findLastIndex(
        (message) => message.role === 'assistant' && message.status === 'processing',
      );
      const activeMessage = conversation.messages[activeIndex];
      if (activeMessage?.role !== 'assistant' || activeMessage.status !== 'processing') {
        return conversation;
      }

      // 文本增量只更新当前正在处理的 Assistant 消息，完成时由完整回复覆盖。
      if (event.type === 'text.delta') {
        const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
          index === activeIndex
            ? { ...activeMessage, streamedText: activeMessage.streamedText + event.delta }
            : message
        ));
        return { ...conversation, messages };
      }

      const activity = upsertActivity(activeMessage.activity, event.item);
      const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
        index === activeIndex ? { ...activeMessage, activity } : message
      ));
      return { ...conversation, messages };
    });
  }), [api]);

  /** 距离底部小于一行时仍视为跟随，避免增量滚动造成的微小偏差把跟随状态误判成已离开底部。 */
  const handleHistoryScroll = () => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer === null) return;
    followsLatest.current = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight <= 24;
  };

  // 切换会话或视图后重新回到最新内容：恢复历史时用户期望看到的是这一轮对话的结尾。
  useEffect(() => {
    followsLatest.current = true;
    const scrollContainer = conversationScroll.current;
    if (scrollContainer !== null) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [activeSessionId, activeView]);

  // 新消息、活动更新和实时增量只在用户仍跟随最新内容时滚动；向上阅读时不得强行拉回。
  useEffect(() => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer === null || !followsLatest.current) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [activeConversation.messages]);

  const selectAttachments = async () => {
    const attachments = await api.selectAttachmentFiles();
    if (attachments) {
      updateConversation(activeSessionIdRef.current, (conversation) => ({
        ...conversation,
        attachments,
      }));
    }
  };

  const removeAttachment = async (index: number) => {
    await api.removeAttachment(index);
    updateConversation(activeSessionIdRef.current, (conversation) => ({
      ...conversation,
      attachments: conversation.attachments.filter((_, currentIndex) => currentIndex !== index),
    }));
  };

  const startNewSession = async () => {
    if (!isSessionReady || isProcessing) return;
    const sessionId = await api.newSession();
    const conversation = createConversation(sessionId, nextSessionNumber.current);
    nextSessionNumber.current += 1;
    setConversations((currentConversations) => [...currentConversations, conversation]);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveView('conversation');
  };

  const renameSession = (sessionId: string, title: string) => {
    if (isProcessing) return;
    updateConversation(sessionId, (conversation) => ({
      ...conversation,
      title,
      titleManuallyRenamed: true,
    }));
  };

  const deleteSession = async (sessionId: string) => {
    if (!isSessionReady || isProcessing) return;
    const currentConversation = conversations.find((conversation) => conversation.id === sessionId);
    if (currentConversation === undefined) return;

    const nextActiveSessionId = await api.deleteSession(sessionId);
    const remaining = conversations.filter((conversation) => conversation.id !== sessionId);
    if (remaining.length === 0) {
      remaining.push(createConversation(nextActiveSessionId, nextSessionNumber.current));
      nextSessionNumber.current += 1;
    }
    setConversations(remaining);
    activeSessionIdRef.current = nextActiveSessionId;
    setActiveSessionId(nextActiveSessionId);
  };

  const switchSession = async (sessionId: string) => {
    if (isProcessing) return;
    if (sessionId === activeSessionIdRef.current) {
      setActiveView('conversation');
      return;
    }
    await api.switchSession(sessionId);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveView('conversation');
  };

  const sendTask = async () => {
    const sessionId = activeSessionIdRef.current;
    const conversation = conversations.find((item) => item.id === sessionId);
    if (conversation === undefined) return;
    const taskPrompt = conversation.prompt.trim();
    if (!taskPrompt || isProcessing) return;

    // 主动发送是明确的“看最新内容”动作，即使此前在向上阅读也回到最新一轮。
    followsLatest.current = true;
    const assistantMessageId = nextMessageId.current + 1;
    updateConversation(sessionId, (currentConversation) => ({
      ...currentConversation,
      title: !currentConversation.titleManuallyRenamed && currentConversation.messages.length === 0
        ? conversationTitle(taskPrompt)
        : currentConversation.title,
      messages: [
        ...currentConversation.messages,
        {
          id: nextMessageId.current,
          role: 'user',
          text: taskPrompt,
          attachments: currentConversation.attachments.map((attachment) => attachment.name),
          ...(currentConversation.attachments.length === 0 ? {} : {
            attachmentRoles: currentConversation.attachments.map((attachment) => attachment.role),
          }),
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          status: 'processing',
          streamedText: '',
          activity: [],
          activityExpanded: true,
        },
      ],
    }));
    nextMessageId.current += 2;
    setIsProcessing(true);

    try {
      const taskResult = await api.runAgentTask(taskPrompt);
      // 执行期间禁止切换会话，因此异步结果仍属于当前活动会话；这里也避开初始 ID 查询完成时的占位 ID 变化。
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        prompt: '',
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? {
                ...dropStreamedText(message),
                status: 'completed',
                result: taskResult,
                activityExpanded: false,
              }
            : message
        )),
      }));
    } catch (error) {
      const cancelled = (error instanceof Error || error instanceof DOMException)
        && (error.name === 'AbortError'
          || error.message === 'This operation was aborted'
          || error.message === 'The operation was aborted');
      // 失败或取消时，此前已成功的工具产出仍是真实文件：宿主把它们挂在错误上，这里原样带到终态。
      const outputFiles = (error as { outputFiles?: readonly AgentTaskOutputFile[] }).outputFiles;
      const artifacts = outputFiles === undefined || outputFiles.length === 0
        ? {}
        : { outputFiles };
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? cancelled
              ? {
                  ...dropStreamedText(message),
                  status: 'cancelled',
                  // 取消只影响仍在执行的活动，已完成的活动保留真实状态和耗时。
                  activity: message.activity.map((item) => (
                    item.status === 'running' ? { ...item, status: 'cancelled' as const } : item
                  )),
                  activityExpanded: false,
                  ...artifacts,
                }
              : {
                  ...dropStreamedText(message),
                  status: 'failed',
                  errorMessage: error instanceof Error ? error.message : '任务执行失败。',
                  activityExpanded: false,
                  ...artifacts,
                }
            : message
        )),
      }));
    } finally {
      setIsProcessing(false);
    }
  };

  const cancelTask = async () => {
    if (!isProcessing) return;
    try {
      await api.cancelTask();
    } catch (error) {
      // Turn 恰好先完成时，旧 Stop 点击不应影响已经可开始的下一轮。
      if (error instanceof Error && error.message.includes('当前没有正在执行的任务')) return;
      throw error;
    }
  };

  const toggleActivity = (messageId: number) => {
    const sessionId = activeSessionIdRef.current;
    updateConversation(sessionId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => (
        message.role === 'assistant' && message.id === messageId
          ? { ...message, activityExpanded: !message.activityExpanded }
          : message
      )),
    }));
  };

  const { messages, prompt, attachments } = activeConversation;
  const hasConversation = messages.length > 0;
  const composer = (
    <Composer
      attachments={attachments}
      prompt={prompt}
      isProcessing={isProcessing}
      onPromptChange={(nextPrompt) => updateConversation(
        activeSessionIdRef.current,
        (conversation) => ({ ...conversation, prompt: nextPrompt }),
      )}
      onSelectFiles={() => void selectAttachments()}
      onRemoveAttachment={(index) => void removeAttachment(index)}
      onSend={() => void sendTask()}
      onCancel={() => void cancelTask()}
    />
  );

  return (
    <div className="app-shell">
      <SessionSidebar
        conversations={conversations}
        activeSessionId={activeSessionId}
        activeView={activeView}
        isSessionReady={isSessionReady}
        isProcessing={isProcessing}
        settingsButtonRef={settingsButton}
        onNewSession={() => void startNewSession()}
        onSwitchSession={(sessionId) => void switchSession(sessionId)}
        onRenameSession={renameSession}
        onDeleteSession={(sessionId) => void deleteSession(sessionId)}
        onOpenSettings={() => setActiveView('settings')}
      />

      <div className="app-main">
        {activeView === 'settings' && (
          <RuntimeSettingsPanel api={api} isProcessing={isProcessing} onClose={() => {
            // 卸载模态框后再还原键盘焦点，避免焦点仍被原生模态层圈定。
            flushSync(() => setActiveView('conversation'));
            settingsButton.current!.focus();
          }} />
        )}
        <ConversationPanel
          messages={messages}
          hasConversation={hasConversation}
          composer={composer}
          historyRef={conversationScroll}
          onHistoryScroll={handleHistoryScroll}
          onToggleActivity={toggleActivity}
          onRevealFile={(path) => api.revealFile(path)}
        />
      </div>
    </div>
  );
}
