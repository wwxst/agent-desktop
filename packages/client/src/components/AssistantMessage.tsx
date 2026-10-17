import { useState } from 'react';
import type {
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  ClientAssistantMessage,
} from '../api.js';
import { AgentActivity } from './AgentActivity.js';
import { ArtifactCard } from './ArtifactCard.js';
import { Markdown } from './Markdown.js';
import { OutputResults } from './OutputResults.js';
import { TaskPlan } from './TaskPlan.js';

interface AssistantMessageProps {
  readonly message: ClientAssistantMessage;
  readonly onToggleActivity: (messageId: number) => void;
  readonly onRevealFile: (path: string) => Promise<void>;
  readonly onRecover?: (sourceTurnId: string, mode: 'continue' | 'verify') => void;
  readonly onVerifyEffect?: (sourceEventIndex: number, outcome: 'completed' | 'not-applied', description: string) => void;
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

/** 按声明集合展示逐项交付结果；没有声明过输出项时不渲染。 */
function renderOutputResults(results: readonly AgentTaskOutputItemResult[] | undefined) {
  if (results === undefined || results.length === 0) return null;
  return <OutputResults results={results} />;
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
  onRecover,
  onVerifyEffect,
}: AssistantMessageProps) {
  // 人工核验必须带上用户实际检查的事实，不能由按钮代填“已完成”。
  const [verificationDescriptions, setVerificationDescriptions] = useState<Record<number, string>>({});
  const taskState = message.taskState ?? (message.status === 'completed' ? message.result.taskState : undefined);
  const recoverable = onRecover !== undefined && taskState !== undefined && (taskState.status === 'failed' || taskState.status === 'cancelled'
    || taskState.status === 'interrupted' || taskState.status === 'blocked');
  const unknownEffects = taskState?.unknownEffects ?? [];
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
      <TaskPlan taskState={taskState} />

      {message.status !== 'processing' && (unknownEffects.length > 0 || recoverable) && (
        <section className="task-recovery" aria-label="任务恢复">
          {unknownEffects.map((effect) => (
            <div className="task-recovery-effect" key={effect.sourceEventIndex}>
              <p>{effect.description}</p>
              <label className="task-recovery-description">
                核验说明
                <textarea
                  aria-label={`${effect.label}核验说明`}
                  rows={2}
                  value={verificationDescriptions[effect.sourceEventIndex] ?? ''}
                  onChange={event => setVerificationDescriptions(current => ({ ...current, [effect.sourceEventIndex]: event.target.value }))}
                  placeholder={['open_terminal', 'write_terminal', 'close_terminal', 'terminal-connection-lost'].includes(effect.label)
                    ? '请说明旧进程的实际状态和执行结果。'
                    : '请说明实际检查的事实和结果。'}
                />
              </label>
              <div className="task-recovery-actions">
                <button type="button" disabled={!verificationDescriptions[effect.sourceEventIndex]?.trim()}
                  onClick={() => onVerifyEffect?.(effect.sourceEventIndex, 'completed', verificationDescriptions[effect.sourceEventIndex]!.trim())}>确认已完成</button>
                <button type="button" disabled={!verificationDescriptions[effect.sourceEventIndex]?.trim()}
                  onClick={() => onVerifyEffect?.(effect.sourceEventIndex, 'not-applied', verificationDescriptions[effect.sourceEventIndex]!.trim())}>确认未应用</button>
              </div>
            </div>
          ))}
          {recoverable && unknownEffects.length === 0 && (
            <button type="button" onClick={() => onRecover?.(taskState!.latestTurnId, 'continue')}>继续未完成任务</button>
          )}
          {recoverable && unknownEffects.length > 0 && (
            <button type="button" onClick={() => onRecover?.(taskState!.latestTurnId, 'verify')}>先核验未确定效果</button>
          )}
        </section>
      )}

      {message.status === 'cancelled' ? (
        <>
          <div className="agent-heading">
            <span className="agent-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" /></svg></span>
            <strong>已停止</strong>
          </div>
          {/* 取消前已完成的工具产出仍然存在，必须继续可见可定位。 */}
          {renderOutputResults(message.outputs)}
          {renderArtifacts(message.outputFiles, onRevealFile)}
        </>
      ) : message.status === 'failed' ? (
        <>
          <div className="agent-heading error-heading">
            <span className="agent-mark error-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.5" /></svg></span>
            <strong>任务失败</strong>
          </div>
          <div className="message-content"><p>{message.errorMessage}</p></div>
          {/* 整轮失败不等于此前没有产出：已交付项与已成功文件照常展示。 */}
          {renderOutputResults(message.outputs)}
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
      {message.status === 'completed' && renderOutputResults(message.result.outputs)}
      {message.status === 'completed' && renderArtifacts(message.result.outputFiles, onRevealFile)}
    </article>
  );
}
