import { useEffect, useRef, useState } from 'react';
import type {
  AgentClientApi,
  AgentRuntimeEvent,
  ClientAssistantMessage,
  ClientAssistantMessageBase,
  ClientConversation,
  ClientConversationMessage,
  ClientStateSnapshot,
  ToolActivityEvent,
  ToolActivityItem,
} from './api.js';
import { ArtifactCard } from './components/ArtifactCard.js';
import { AttachmentChip } from './components/AttachmentChip.js';
import { Composer } from './components/Composer.js';
import { ToolActivity } from './components/ToolActivity.js';
import { RuntimeSettingsPanel } from './components/RuntimeSettingsPanel.js';

const INITIAL_RENDERER_SESSION_ID = 'initializing-session';

function createConversation(id: string, number: number): ClientConversation {
  return {
    id,
    title: `会话 ${number}`,
    titleManuallyRenamed: false,
    messages: [],
    prompt: '',
    selectedVideos: [],
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
    tools: message.tools,
    toolsExpanded: message.toolsExpanded,
  };
}

function toActivityItem(event: ToolActivityEvent): ToolActivityItem {
  if (event.type === 'tool.started') {
    return {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'running',
    };
  }

  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.type === 'tool.completed' ? 'completed' : 'failed',
    durationMs: event.durationMs,
  };
}

interface AppProps {
  readonly api: AgentClientApi;
}

export function App({ api }: AppProps) {
  const [conversations, setConversations] = useState<readonly ClientConversation[]>([
    createConversation(INITIAL_RENDERER_SESSION_ID, 1),
  ]);
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_RENDERER_SESSION_ID);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeView, setActiveView] = useState<'conversation' | 'settings'>('conversation');
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef(INITIAL_RENDERER_SESSION_ID);
  const nextSessionNumber = useRef(2);
  const nextMessageId = useRef(1);
  const conversationScroll = useRef<HTMLElement>(null);

  const activeConversation = conversations.find((conversation) => (
    conversation.id === activeSessionId
  )) ?? conversations[0]!;

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
    const snapshot: ClientStateSnapshot = { conversations, activeSessionId };
    const timeout = setTimeout(() => {
      void api.saveClientState(snapshot);
    }, 150);
    return () => clearTimeout(timeout);
  }, [activeSessionId, api, conversations, isProcessing, isSessionReady]);

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

      const nextItem = toActivityItem(event);
      const existingIndex = activeMessage.tools.findIndex(
        (item) => item.toolCallId === nextItem.toolCallId,
      );
      const tools = existingIndex === -1
        ? [...activeMessage.tools, nextItem]
        : activeMessage.tools.map((item, index) => (
            index === existingIndex ? nextItem : item
          ));
      const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
        index === activeIndex ? { ...activeMessage, tools } : message
      ));
      return { ...conversation, messages };
    });
  }), [api]);

  useEffect(() => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer !== null) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [activeSessionId, activeConversation.messages]);

  const selectVideo = async () => {
    const videos = await api.selectVideoFile();
    if (videos) {
      updateConversation(activeSessionIdRef.current, (conversation) => ({
        ...conversation,
        selectedVideos: videos,
      }));
    }
  };

  const removeVideo = async (index: number) => {
    await api.removeSelectedVideo(index);
    updateConversation(activeSessionIdRef.current, (conversation) => ({
      ...conversation,
      selectedVideos: conversation.selectedVideos.filter((_, currentIndex) => currentIndex !== index),
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

  const beginRename = (conversation: ClientConversation) => {
    if (isProcessing) return;
    setOpenSessionMenuId(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(conversation.id);
    setEditingTitle(conversation.title);
  };

  const finishRename = (sessionId: string, save: boolean) => {
    if (editingSessionId !== sessionId) return;
    const title = editingTitle.trim();
    if (save && title.length > 0) {
      updateConversation(sessionId, (conversation) => ({
        ...conversation,
        title,
        titleManuallyRenamed: true,
      }));
    }
    setEditingSessionId(null);
    setEditingTitle('');
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
    setOpenSessionMenuId(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
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
          attachments: currentConversation.selectedVideos.map((video) => video.name),
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          status: 'processing',
          streamedText: '',
          tools: [],
          toolsExpanded: true,
        },
      ],
    }));
    nextMessageId.current += 2;
    // 进入执行态时关闭已有会话操作，保证重命名和删除在整个 Turn 期间不可触发。
    setOpenSessionMenuId(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
    setEditingTitle('');
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
                toolsExpanded: false,
              }
            : message
        )),
      }));
    } catch (error) {
      const cancelled = (error instanceof Error || error instanceof DOMException)
        && (error.name === 'AbortError'
          || error.message === 'This operation was aborted'
          || error.message === 'The operation was aborted');
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? cancelled
              ? {
                  ...dropStreamedText(message),
                  status: 'cancelled',
                  tools: message.tools.map((tool) => (
                    tool.status === 'running' ? { ...tool, status: 'cancelled' as const } : tool
                  )),
                  toolsExpanded: false,
                }
              : {
                  ...dropStreamedText(message),
                  status: 'failed',
                  errorMessage: error instanceof Error ? error.message : '任务执行失败。',
                  toolsExpanded: false,
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

  const toggleTools = (messageId: number) => {
    const sessionId = activeSessionIdRef.current;
    updateConversation(sessionId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => (
        message.role === 'assistant' && message.id === messageId
          ? { ...message, toolsExpanded: !message.toolsExpanded }
          : message
      )),
    }));
  };

  const { messages, prompt, selectedVideos } = activeConversation;
  const hasConversation = messages.length > 0;
  const composer = (
    <Composer
      selectedVideos={selectedVideos}
      prompt={prompt}
      isProcessing={isProcessing}
      onPromptChange={(nextPrompt) => updateConversation(
        activeSessionIdRef.current,
        (conversation) => ({ ...conversation, prompt: nextPrompt }),
      )}
      onSelectVideo={() => void selectVideo()}
      onRemoveVideo={(index) => void removeVideo(index)}
      onSend={() => void sendTask()}
      onCancel={() => void cancelTask()}
    />
  );

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="工作区导航">
        <div className="sidebar-brand">
          <strong>Agent Desktop</strong>
        </div>
        <div className="sidebar-section-label">工作区</div>
        <div className="sidebar-workspace" aria-label="当前工作区">
          <span className="sidebar-folder" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="16" height="16" focusable="false">
              <path d="M3.5 5.25h4l1.55 1.8h7.45v7.7a1.5 1.5 0 0 1-1.5 1.5h-11.5a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5Z" />
            </svg>
          </span>
          <span>视频剪辑</span>
        </div>
        <button
          className="sidebar-new-session"
          type="button"
          disabled={!isSessionReady || isProcessing}
          onClick={() => void startNewSession()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
          </svg>
          <span>新会话</span>
        </button>
        <div className="sidebar-section-label sidebar-sessions-label">会话</div>
        <nav className="sidebar-session-list" aria-label="会话列表">
          {conversations.map((conversation) => {
            const active = conversation.id === activeSessionId;
            const editing = editingSessionId === conversation.id;
            const menuOpen = openSessionMenuId === conversation.id;
            const confirmingDelete = confirmDeleteSessionId === conversation.id;
            return (
              <div
                key={conversation.id}
                className={`sidebar-session-row${active ? ' active' : ''}`}
              >
                {editing ? (
                  <input
                    className="sidebar-session-title-input"
                    aria-label="会话标题"
                    value={editingTitle}
                    autoFocus
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') finishRename(conversation.id, true);
                      if (event.key === 'Escape') finishRename(conversation.id, false);
                    }}
                    onBlur={() => finishRename(conversation.id, true)}
                  />
                ) : (
                  <button
                    className={`sidebar-session${active ? ' active' : ''}`}
                    type="button"
                    title={conversation.title}
                    disabled={!isSessionReady || isProcessing}
                    {...active ? { 'aria-current': 'page' as const } : {}}
                    onClick={() => void switchSession(conversation.id)}
                  >
                    <span>{conversation.title}</span>
                    {active && isProcessing && <small>进行中</small>}
                  </button>
                )}
                <button
                  className="sidebar-session-menu-button"
                  type="button"
                  aria-label={`会话操作：${conversation.title}`}
                  title="会话操作"
                  disabled={!isSessionReady || isProcessing || editing}
                  onClick={() => {
                    setOpenSessionMenuId(menuOpen ? null : conversation.id);
                    setConfirmDeleteSessionId(null);
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                    <circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" />
                  </svg>
                </button>
                {menuOpen && !confirmingDelete && (
                  <div className="sidebar-session-menu" aria-label={`会话菜单：${conversation.title}`}>
                    <button type="button" onClick={() => beginRename(conversation)}>重命名</button>
                    <button type="button" onClick={() => setConfirmDeleteSessionId(conversation.id)}>删除</button>
                  </div>
                )}
                {confirmingDelete && (
                  <div className="sidebar-session-confirm" aria-label="删除会话确认">
                    <p>删除会话将清除聊天记录和会话上下文，但不会删除已经生成的视频文件。</p>
                    <div>
                      <button type="button" onClick={() => void deleteSession(conversation.id)}>删除会话</button>
                      <button type="button" onClick={() => setConfirmDeleteSessionId(null)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <button
          className={`sidebar-settings${activeView === 'settings' ? ' active' : ''}`}
          type="button"
          aria-current={activeView === 'settings' ? 'page' : undefined}
          onClick={() => setActiveView('settings')}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="2.25" />
            <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06" />
          </svg>
          <span>设置</span>
        </button>
        <div className="sidebar-footer">
          <span className="sidebar-status-dot" aria-hidden="true" />
          <span>本地运行</span>
        </div>
      </aside>

      <div className="app-main">
      {activeView === 'settings' ? (
        <RuntimeSettingsPanel api={api} isProcessing={isProcessing} />
      ) : (
      <main
        ref={conversationScroll}
        className={`conversation-scroll${hasConversation ? '' : ' conversation-scroll-empty'}`}
        aria-label="对话工作区"
      >
        <div className="conversation-feed" aria-live="polite">
          {messages.map((message) => message.role === 'user' ? (
            <article key={message.id} className="message-block user-message" aria-label="你的任务">
              <div className="user-message-content">
                {message.attachments.length > 0 && (
                  <div className="submitted-attachments" aria-label="已提交的视频">
                    {message.attachments.map((name, index) => (
                      <AttachmentChip key={`${name}-${index}`} name={name} />
                    ))}
                  </div>
                )}
                <p>{message.text}</p>
              </div>
            </article>
          ) : (
            <article
              key={message.id}
              className={`message-block agent-message${message.status === 'failed' ? ' error-message' : ''}`}
              aria-label="Agent 回复"
              {...message.status === 'failed' ? { role: 'alert' } : {}}
            >
              {message.tools.length > 0 && (
                <ToolActivity
                  items={message.tools}
                  expanded={message.toolsExpanded}
                  isProcessing={message.status === 'processing'}
                  onToggle={() => toggleTools(message.id)}
                />
              )}

              {message.status === 'cancelled' ? (
                <>
                  <div className="agent-heading">
                    <span className="agent-mark" aria-hidden="true">■</span>
                    <strong>已停止</strong>
                  </div>
                </>
              ) : message.status === 'failed' ? (
                <>
                  <div className="agent-heading error-heading">
                    <span className="agent-mark error-mark" aria-hidden="true">!</span>
                    <strong>任务失败</strong>
                  </div>
                  <div className="message-content"><p>{message.errorMessage}</p></div>
                </>
              ) : (
                <>
                  <div className="agent-heading">
                    <span className="agent-mark" aria-hidden="true">▶</span>
                    <strong>Agent</strong>
                  </div>
                  {message.status === 'processing' ? (
                    message.streamedText.length > 0 ? (
                      <div className="message-content">
                        <p className="agent-response">{message.streamedText}</p>
                      </div>
                    ) : (
                      <div className="message-content processing-line">
                        <i aria-hidden="true" />
                        <p>正在处理视频</p>
                      </div>
                    )
                  ) : (
                    <div className="message-content">
                      <p className="agent-response">{message.result.responseText}</p>
                      {message.result.outputFileName && (
                        <ArtifactCard
                          fileName={message.result.outputFileName}
                          onOpen={() => void api.openOutputFile(
                            message.result.outputFileName!,
                          )}
                        />
                      )}
                      <p className="trace-id">Trace: <code>{message.result.traceId}</code></p>
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
        </div>

        <section
          className={`composer-seat ${hasConversation ? 'composer-dock' : 'composer-hero'}`}
          aria-label={hasConversation ? '任务输入' : '开始视频任务'}
        >
          {!hasConversation && (
            <div className="empty-state">
              <span className="empty-state-mark" aria-hidden="true">▶</span>
              <h2>开始一个视频任务</h2>
              <p>选择视频，或者直接告诉 Agent 你想做什么。</p>
            </div>
          )}
          <div className="composer-wrap">{composer}</div>
        </section>
        </main>
      )}
      </div>
    </div>
  );
}
