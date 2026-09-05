import { useEffect, useState } from 'react';
import type {
  AgentTaskResult,
  SelectedVideo,
  ToolActivityEvent,
} from '../shared/ipc.js';
import './styles.css';

type ToolActivityStatus = 'running' | 'completed' | 'failed';

interface ToolActivityItem {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: ToolActivityStatus;
  readonly durationMs?: number;
}

const STATUS_LABELS: Record<ToolActivityStatus, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
};

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
  const [result, setResult] = useState<AgentTaskResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivityItem[]>([]);

  useEffect(() => window.agentDesktop.onAgentEvent((event) => {
    const nextItem = toActivityItem(event);
    // 同一 Tool Call 的后续事件原位更新，保证执行列表顺序稳定。
    setToolActivity((currentItems) => {
      const existingIndex = currentItems.findIndex(
        (item) => item.toolCallId === nextItem.toolCallId,
      );

      if (existingIndex === -1) {
        return [...currentItems, nextItem];
      }

      return currentItems.map((item, index) => (
        index === existingIndex ? nextItem : item
      ));
    });
  }), []);

  const selectVideo = async () => {
    const video = await window.agentDesktop.selectVideoFile();
    if (video) {
      setSelectedVideo(video);
    }
  };

  const sendTask = async () => {
    const taskPrompt = prompt.trim();
    if (!taskPrompt || !selectedVideo) {
      return;
    }

    setSubmittedPrompt(taskPrompt);
    setResult(null);
    setErrorMessage('');
    // 新任务只展示本 Turn 的 Tool Activity，避免与上一次执行混淆。
    setToolActivity([]);
    setIsProcessing(true);

    try {
      setResult(await window.agentDesktop.runAgentTask(taskPrompt));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务执行失败。');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-kicker">视频智能剪辑</p>
          <h1>Agent Desktop</h1>
        </div>
        <span className="runtime-state">本地运行</span>
      </header>

      <main className="workspace">
        <section className="conversation" aria-labelledby="conversation-heading">
          <div className="section-heading">
            <div>
              <p className="section-label">当前任务</p>
              <h2 id="conversation-heading">消息</h2>
            </div>
          </div>

          <div className="message-list" aria-live="polite">
            {!submittedPrompt && (
              <div className="empty-message">
                <strong>等待新任务</strong>
              </div>
            )}

            {submittedPrompt && (
              <article className="message message-user">
                <span className="message-author">你的需求</span>
                <p>{submittedPrompt}</p>
              </article>
            )}

            {isProcessing && (
              <article className="message message-agent">
                <span className="message-author">Agent</span>
                <p>正在处理视频...</p>
              </article>
            )}

            {result && (
              <article className="message message-agent">
                <span className="message-author">Agent</span>
                <p>{result.responseText}</p>
                <div className="result-meta">
                  <span>Trace ID</span>
                  <code>{result.traceId}</code>
                </div>
                {result.outputFileName && (
                  <div className="output-file">
                    <div>
                      <span className="output-label">输出文件</span>
                      <strong>{result.outputFileName}</strong>
                    </div>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => void window.agentDesktop.openOutputFile()}
                    >
                      打开文件
                    </button>
                  </div>
                )}
              </article>
            )}

            {errorMessage && (
              <article className="message message-error" role="alert">
                <span className="message-author">任务失败</span>
                <p>{errorMessage}</p>
              </article>
            )}
          </div>

          <div className="composer">
            <div className="selected-video">
              <div>
                <span className="selected-label">已选视频</span>
                <strong>{selectedVideo?.name ?? '尚未选择视频'}</strong>
              </div>
              <button
                className="button button-secondary"
                type="button"
                disabled={isProcessing}
                onClick={() => void selectVideo()}
              >
                选择视频
              </button>
            </div>

            <label className="prompt-field">
              <span>剪辑需求</span>
              <textarea
                value={prompt}
                disabled={isProcessing}
                placeholder="例如：删除无关内容，只保留核心部分"
                rows={4}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>

            <div className="composer-actions">
              <span>{isProcessing ? '处理中，请稍候' : '就绪'}</span>
              <button
                className="button button-primary"
                type="button"
                disabled={isProcessing || !selectedVideo || !prompt.trim()}
                onClick={() => void sendTask()}
              >
                发送
              </button>
            </div>
          </div>
        </section>

        <aside className="activity-panel" aria-labelledby="activity-heading">
          <div className="section-heading">
            <div>
              <p className="section-label">执行明细</p>
              <h2 id="activity-heading">Tool Activity</h2>
            </div>
            {toolActivity.length > 0 && (
              <span className="activity-count">{toolActivity.length}</span>
            )}
          </div>

          {toolActivity.length === 0 ? (
            <p className="activity-empty">暂无工具活动</p>
          ) : (
            <ol className="activity-list">
              {toolActivity.map((item) => (
                <li key={item.toolCallId} className="activity-item">
                  <div>
                    <strong>{item.toolName}</strong>
                    <span className={`activity-status status-${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>
                  {item.durationMs !== undefined && <span>{item.durationMs} ms</span>}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>
    </div>
  );
}
