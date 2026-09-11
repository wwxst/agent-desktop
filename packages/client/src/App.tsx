import { useEffect, useRef, useState } from 'react';
import type {
  AgentClientApi,
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

const INITIAL_RENDERER_SESSION_ID = 'initializing-session';

function createConversation(id: string, number: number): ClientConversation {
  return {
    id,
    title: `会话 ${number}`,
    messages: [],
    prompt: '',
    selectedVideos: [],
  };
}

function conversationTitle(prompt: string): string {
  return prompt.length > 18 ? `${prompt.slice(0, 18)}…` : prompt;
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

  useEffect(() => api.onAgentEvent((event) => {
    const nextItem = toActivityItem(event);
    const sessionId = activeSessionIdRef.current;
    // 会话切换在执行期间禁用，因此 Trace 工具事件只会进入发起当前 Turn 的会话。
    updateConversation(sessionId, (conversation) => {
      const activeIndex = conversation.messages.findLastIndex(
        (message) => message.role === 'assistant' && message.status === 'processing',
      );
      const activeMessage = conversation.messages[activeIndex];
      if (activeMessage?.role !== 'assistant') return conversation;

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
  };

  const switchSession = async (sessionId: string) => {
    if (isProcessing || sessionId === activeSessionIdRef.current) return;
    await api.switchSession(sessionId);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
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
      title: currentConversation.messages.length === 0
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
          tools: [],
          toolsExpanded: true,
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
                ...message,
                status: 'completed',
                result: taskResult,
                toolsExpanded: false,
              }
            : message
        )),
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '任务执行失败。';
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? {
                ...message,
                status: 'failed',
                errorMessage,
                toolsExpanded: false,
              }
            : message
        )),
      }));
    } finally {
      setIsProcessing(false);
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
            return (
              <button
                key={conversation.id}
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
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-status-dot" aria-hidden="true" />
          <span>本地运行</span>
        </div>
      </aside>

      <div className="app-main">
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

              {message.status === 'failed' ? (
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
                    <div className="message-content processing-line">
                      <i aria-hidden="true" />
                      <p>正在处理视频</p>
                    </div>
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
      </div>
    </div>
  );
}
