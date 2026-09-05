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
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [submittedVideoName, setSubmittedVideoName] = useState('');
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
    const video = await window.agentDesktop.selectVideoFile();
    if (video) setSelectedVideo(video);
  };

  const sendTask = async () => {
    const taskPrompt = prompt.trim();
    if (!taskPrompt || !selectedVideo) return;

    setSubmittedPrompt(taskPrompt);
    setSubmittedVideoName(selectedVideo.name);
    setResult(null);
    setErrorMessage('');
    setToolActivity([]);
    setToolsExpanded(true);
    setIsProcessing(true);

    try {
      setResult(await window.agentDesktop.runAgentTask(taskPrompt));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务执行失败。');
    } finally {
      setIsProcessing(false);
      setToolsExpanded(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div className="brand-copy">
            <h1>Agent Desktop</h1>
            <span>视频智能剪辑</span>
          </div>
          <span className="runtime-state"><i aria-hidden="true" />本地运行</span>
        </div>
      </header>

      <main className="conversation-scroll" aria-label="对话工作区">
        <div className="conversation-feed" aria-live="polite">
          {!submittedPrompt && (
            <div className="empty-state">
              <span aria-hidden="true">A</span>
              <p>等待任务</p>
            </div>
          )}

          {submittedPrompt && (
            <article className="message-block user-message">
              <div className="message-heading">
                <span className="message-avatar user-avatar">你</span>
                <strong>你</strong>
              </div>
              <div className="message-content">
                <AttachmentChip name={submittedVideoName} />
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
              <div className="message-heading">
                <span className="message-avatar agent-avatar" aria-hidden="true">A</span>
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
              <div className="message-heading">
                <span className="message-avatar agent-avatar" aria-hidden="true">A</span>
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
              <div className="message-heading">
                <span className="message-avatar error-avatar" aria-hidden="true">!</span>
                <strong>任务失败</strong>
              </div>
              <div className="message-content"><p>{errorMessage}</p></div>
            </article>
          )}
        </div>
      </main>

      <footer className="composer-dock">
        <div className="composer-wrap">
          <Composer
            selectedVideo={selectedVideo}
            prompt={prompt}
            isProcessing={isProcessing}
            onPromptChange={setPrompt}
            onSelectVideo={() => void selectVideo()}
            onSend={() => void sendTask()}
          />
        </div>
      </footer>
    </div>
  );
}
