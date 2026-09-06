import { useEffect, useRef, useState } from 'react';
import type {
  AgentTaskResult,
  SelectedVideo,
  ToolActivityEvent,
} from '../shared/ipc.js';
import { ArtifactCard } from './components/ArtifactCard.js';
import { AttachmentChip } from './components/AttachmentChip.js';
import { Composer } from './components/Composer.js';
import {
  ToolActivity,
  type ToolActivityItem,
} from './components/ToolActivity.js';
import './styles.css';

interface UserConversationMessage {
  readonly id: number;
  readonly role: 'user';
  readonly text: string;
  readonly attachments: readonly string[];
}

interface AssistantMessageBase {
  readonly id: number;
  readonly role: 'assistant';
  readonly tools: readonly ToolActivityItem[];
  readonly toolsExpanded: boolean;
}

type AssistantConversationMessage = AssistantMessageBase & (
  | { readonly status: 'processing' }
  | { readonly status: 'completed'; readonly result: AgentTaskResult }
  | { readonly status: 'failed'; readonly errorMessage: string }
);

type ConversationMessage = UserConversationMessage | AssistantConversationMessage;

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

export function App() {
  const [selectedVideos, setSelectedVideos] = useState<readonly SelectedVideo[]>([]);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const nextMessageId = useRef(1);
  const conversationScroll = useRef<HTMLElement>(null);

  useEffect(() => window.agentDesktop.onAgentEvent((event) => {
    const nextItem = toActivityItem(event);
    // 发送按钮禁止并发，因此 Trace 工具事件只会属于唯一一个处理中 Agent 消息。
    setMessages((currentMessages) => {
      const activeIndex = currentMessages.findLastIndex(
        (message) => message.role === 'assistant' && message.status === 'processing',
      );
      const activeMessage = currentMessages[activeIndex];
      if (activeMessage?.role !== 'assistant') return currentMessages;

      const existingIndex = activeMessage.tools.findIndex(
        (item) => item.toolCallId === nextItem.toolCallId,
      );
      const tools = existingIndex === -1
        ? [...activeMessage.tools, nextItem]
        : activeMessage.tools.map((item, index) => (
            index === existingIndex ? nextItem : item
          ));

      return currentMessages.map((message, index) => (
        index === activeIndex ? { ...activeMessage, tools } : message
      ));
    });
  }), []);

  useEffect(() => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer !== null) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [messages]);

  const selectVideo = async () => {
    const videos = await window.agentDesktop.selectVideoFile();
    if (videos) setSelectedVideos(videos);
  };

  const removeVideo = async (index: number) => {
    await window.agentDesktop.removeSelectedVideo(index);
    setSelectedVideos((currentVideos) => (
      currentVideos.filter((_video, currentIndex) => currentIndex !== index)
    ));
  };

  const sendTask = async () => {
    const taskPrompt = prompt.trim();
    if (!taskPrompt || isProcessing) return;

    const assistantMessageId = nextMessageId.current + 1;
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: nextMessageId.current,
        role: 'user',
        text: taskPrompt,
        attachments: selectedVideos.map((video) => video.name),
      },
      {
        id: assistantMessageId,
        role: 'assistant',
        status: 'processing',
        tools: [],
        toolsExpanded: true,
      },
    ]);
    nextMessageId.current += 2;
    setIsProcessing(true);

    try {
      const taskResult = await window.agentDesktop.runAgentTask(taskPrompt);
      setMessages((currentMessages) => currentMessages.map((message) => (
        message.role === 'assistant' && message.id === assistantMessageId
          ? {
              ...message,
              status: 'completed',
              result: taskResult,
              toolsExpanded: false,
            }
          : message
      )));
      setPrompt('');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '任务执行失败。';
      setMessages((currentMessages) => currentMessages.map((message) => (
        message.role === 'assistant' && message.id === assistantMessageId
          ? {
              ...message,
              status: 'failed',
              errorMessage,
              toolsExpanded: false,
            }
          : message
      )));
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleTools = (messageId: number) => {
    setMessages((currentMessages) => currentMessages.map((message) => (
      message.role === 'assistant' && message.id === messageId
        ? { ...message, toolsExpanded: !message.toolsExpanded }
        : message
    )));
  };

  const hasConversation = messages.length > 0;
  const composer = (
    <Composer
      selectedVideos={selectedVideos}
      prompt={prompt}
      isProcessing={isProcessing}
      onPromptChange={setPrompt}
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
        <div className="sidebar-session" aria-current="page">
          <span>当前任务</span>
          {isProcessing && <small>进行中</small>}
        </div>
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
                          onOpen={() => void window.agentDesktop.openOutputFile(
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
