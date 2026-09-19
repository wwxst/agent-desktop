import type { AgentTaskOutputFile, ClientAssistantMessage } from '../api.js';
import { AgentActivity } from './AgentActivity.js';
import { ArtifactCard } from './ArtifactCard.js';
import { Markdown } from './Markdown.js';

interface AssistantMessageProps {
  readonly message: ClientAssistantMessage;
  readonly onToggleActivity: (messageId: number) => void;
  readonly onRevealFile: (path: string) => Promise<void>;
}

/** 已成功的持久产物：无论整轮成功、失败还是取消，都沿用同一张卡。 */
function renderArtifacts(
  files: readonly AgentTaskOutputFile[] | undefined,
  onRevealFile: (path: string) => Promise<void>,
) {
  return (files ?? []).map((file) => (
    <ArtifactCard
      key={file.path}
      fileName={file.fileName}
      onOpen={() => onRevealFile(file.path)}
    />
  ));
}

/**
 * 一轮 Agent 回复：活动轨迹、状态标题、正文和产物都属于同一条消息，
 * 多轮之间不共享这些节点，因此完成新一轮不会覆盖前一轮内容。
 * 成功回复直接从正文开始，只有失败和取消才用状态标题说明终态。
 */
export function AssistantMessage({
  message,
  onToggleActivity,
  onRevealFile,
}: AssistantMessageProps) {
  return (
    <article
      className={`message-block agent-message${message.status === 'failed' ? ' error-message' : ''}`}
      aria-label="Agent 回复"
      {...message.status === 'failed' ? { role: 'alert' } : {}}
    >
      {message.activity.length > 0 && (
        <AgentActivity
          items={message.activity}
          expanded={message.activityExpanded}
          isProcessing={message.status === 'processing'}
          onToggle={() => onToggleActivity(message.id)}
          onRevealFile={onRevealFile}
        />
      )}

      {message.status === 'cancelled' ? (
        <>
          <div className="agent-heading">
            <span className="agent-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" /></svg></span>
            <strong>已停止</strong>
          </div>
          {/* 取消前已完成的工具产出仍然存在，必须继续可见可定位。 */}
          {renderArtifacts(message.outputFiles, onRevealFile)}
        </>
      ) : message.status === 'failed' ? (
        <>
          <div className="agent-heading error-heading">
            <span className="agent-mark error-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.5" /></svg></span>
            <strong>任务失败</strong>
          </div>
          <div className="message-content"><p>{message.errorMessage}</p></div>
          {/* 整轮失败不等于此前没有产出：已成功的文件照常展示。 */}
          {renderArtifacts(message.outputFiles, onRevealFile)}
        </>
      ) : message.status === 'processing' ? (
        message.streamedText.length > 0 ? (
          // 实时文本和最终回复使用同一套正文渲染，增量到达后不再显示处理指示。
          <div className="message-content is-streaming">
            <Markdown text={message.streamedText} />
          </div>
        ) : (
          <div className="message-content processing-line">
            <i aria-hidden="true" />
            <p>正在处理任务</p>
          </div>
        )
      ) : (
        <div className="message-content">
          <Markdown text={message.result.responseText} />
        </div>
      )}
      {message.status === 'completed' && renderArtifacts(message.result.outputFiles, onRevealFile)}
    </article>
  );
}
