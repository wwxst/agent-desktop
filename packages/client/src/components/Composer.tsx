import type { FormEvent } from 'react';
import type { Attachment } from '../api.js';
import { AttachmentChip } from './AttachmentChip.js';

interface ComposerProps {
  readonly attachments: readonly Attachment[];
  readonly prompt: string;
  readonly isProcessing: boolean;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSelectFiles: () => void;
  readonly onRemoveAttachment: (index: number) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
}

/** Composer 集中承载输入附件、自然语言输入和发送动作。 */
export function Composer({
  attachments,
  prompt,
  isProcessing,
  onPromptChange,
  onSelectFiles,
  onRemoveAttachment,
  onSend,
  onCancel,
}: ComposerProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSend();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="已选择的输入附件">
          {attachments.map((attachment, index) => (
            <AttachmentChip
              key={`${attachment.path}-${index}`}
              name={attachment.name}
              role={attachment.role}
              {...isProcessing ? {} : { onRemove: () => onRemoveAttachment(index) }}
            />
          ))}
        </div>
      )}

      <label className="visually-hidden" htmlFor="agent-prompt">剪辑需求</label>
      <textarea
        id="agent-prompt"
        value={prompt}
        disabled={isProcessing}
        placeholder="告诉 Agent 你想做什么…"
        rows={1}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          // 输入法确认和 Shift+Enter 留给文本框，只有普通 Enter 提交真实任务。
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!isProcessing && prompt.trim()) onSend();
        }}
      />

      <div className="composer-toolbar">
        <button
          className="icon-button attachment-button"
          type="button"
          aria-label="选择输入文件"
          title="选择输入文件"
          disabled={isProcessing}
          onClick={onSelectFiles}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <div className="composer-trailing">
          {isProcessing && <span className="composer-state">处理中</span>}
          <button
            className="icon-button send-button"
            type="submit"
            aria-label={isProcessing ? '停止' : '发送'}
            title={isProcessing ? '停止' : '发送'}
            disabled={!isProcessing && !prompt.trim()}
            onClick={isProcessing ? (event) => { event.preventDefault(); onCancel(); } : undefined}
          >
            {isProcessing ? (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
                <path
                  d="M8.3125.980183c.35517.073166.66797.224837.9502.452147.2245.18064.4678.425457.7168.67481L14.707 6.83468l-1.414 1.414L9 3.95577v11.08593H7V3.95577L2.707 8.24868l-1.414-1.414L6.0205 2.10714c.2492-.24921.4925-.49402.71699-.67481C7.0212 1.20402 7.33399 1.05335 7.6875.980183c.2103-.043177.4161-.025025.625.0Z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
