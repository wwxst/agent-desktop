import { useEffect, useState } from 'react';
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
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [submittedVideoNames, setSubmittedVideoNames] = useState<readonly string[]>([]);
  const [result, setResult] = useState<AgentTaskResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivityItem[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(true);

  useEffect(() => window.agentDesktop.onAgentEvent((event) => {
    const nextItem = toActivityItem(event);
    // 同一 Tool Call 的后续事件原位更新，保证执行列表顺序稳定。
    setToolActivity((currentItems) => {
      const existingIndex = currentItems.findIndex(
        (item) => item.toolCallId === nextItem.toolCallId,
      );

      if (existingIndex === -1) return [...currentItems, nextItem];
      return currentItems.map((item, index) => (
        index === existingIndex ? nextItem : item
      ));
    });
  }), []);

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

    setSubmittedPrompt(taskPrompt);
    setSubmittedVideoNames(selectedVideos.map((video) => video.name));
    setResult(null);
    setErrorMessage('');
    setToolActivity([]);
    setToolsExpanded(true);
    setIsProcessing(true);

    try {
      const taskResult = await window.agentDesktop.runAgentTask(taskPrompt);
      setResult(taskResult);
      setPrompt('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务执行失败。');
    } finally {
      setIsProcessing(false);
      setToolsExpanded(false);
    }
  };

  const hasConversation = Boolean(
    submittedPrompt || toolActivity.length || isProcessing || result || errorMessage,
  );
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
          <span className="sidebar-brand-chevron" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </span>
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
          <small>{hasConversation ? '进行中' : '新任务'}</small>
        </div>
        <div className="sidebar-footer">
          <span className="sidebar-status-dot" aria-hidden="true" />
          <span>本地运行</span>
        </div>
      </aside>

      <div className="app-main">
      <main
        className={`conversation-scroll${hasConversation ? '' : ' conversation-scroll-empty'}`}
        aria-label="对话工作区"
      >
        <div className="conversation-feed" aria-live="polite">
          {submittedPrompt && (
            <article className="message-block user-message" aria-label="你的任务">
              <div className="user-message-content">
                {submittedVideoNames.length > 0 && (
                  <div className="submitted-attachments" aria-label="已提交的视频">
                    {submittedVideoNames.map((name, index) => (
                      <AttachmentChip key={`${name}-${index}`} name={name} />
                    ))}
                  </div>
                )}
                <p>{submittedPrompt}</p>
              </div>
            </article>
          )}

          {toolActivity.length > 0 && (
            <ToolActivity
              items={toolActivity}
              expanded={toolsExpanded}
              isProcessing={isProcessing}
              onToggle={() => setToolsExpanded((expanded) => !expanded)}
            />
          )}

          {isProcessing && (
            <article className="message-block agent-message">
              <div className="agent-heading">
                <span className="agent-mark" aria-hidden="true">▶</span>
                <strong>Agent</strong>
              </div>
              <div className="message-content processing-line">
                <i aria-hidden="true" />
                <p>正在处理视频</p>
              </div>
            </article>
          )}

          {result && (
            <article className="message-block agent-message">
              <div className="agent-heading">
                <span className="agent-mark" aria-hidden="true">▶</span>
                <strong>Agent</strong>
              </div>
              <div className="message-content">
                <p className="agent-response">{result.responseText}</p>
                {result.outputFileName && (
                  <ArtifactCard
                    fileName={result.outputFileName}
                    onOpen={() => void window.agentDesktop.openOutputFile()}
                  />
                )}
                <p className="trace-id">Trace: <code>{result.traceId}</code></p>
              </div>
            </article>
          )}

          {errorMessage && (
            <article className="message-block error-message" role="alert">
              <div className="agent-heading error-heading">
                <span className="agent-mark error-mark" aria-hidden="true">!</span>
                <strong>任务失败</strong>
              </div>
              <div className="message-content"><p>{errorMessage}</p></div>
            </article>
          )}
        </div>

        <section
          className={`composer-seat ${hasConversation ? 'composer-dock' : 'composer-hero'}`}
          aria-label={hasConversation ? '任务输入' : '开始视频任务'}
        >
          {!hasConversation && (
            <div className="empty-state">
              <span className="empty-state-mark" aria-hidden="true">▶</span>
              <h2>开始一个视频任务</h2>
              <p>可选择多个视频，也可以直接告诉 Agent 你想做什么。</p>
              <ul className="example-list" aria-label="任务示例">
                <li>删除无关内容，只保留核心部分</li>
                <li>找出讲 Japan 的片段</li>
                <li>把开头压缩得更紧凑</li>
              </ul>
            </div>
          )}
          <div className="composer-wrap">{composer}</div>
        </section>
        </main>
      </div>
    </div>
  );
}
