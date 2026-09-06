import type { FormEvent } from 'react';
import type { SelectedVideo } from '../../shared/ipc.js';
import { AttachmentChip } from './AttachmentChip.js';

interface ComposerProps {
  readonly selectedVideos: readonly SelectedVideo[];
  readonly prompt: string;
  readonly isProcessing: boolean;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSelectVideo: () => void;
  readonly onRemoveVideo: (index: number) => void;
  readonly onSend: () => void;
}

/** Composer 集中承载视频附件、自然语言输入和发送动作。 */
export function Composer({
  selectedVideos,
  prompt,
  isProcessing,
  onPromptChange,
  onSelectVideo,
  onRemoveVideo,
  onSend,
}: ComposerProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSend();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {selectedVideos.length > 0 && (
        <div className="composer-attachments" aria-label="已选择的视频">
          {selectedVideos.map((video, index) => (
            <AttachmentChip
              key={`${video.name}-${index}`}
              name={video.name}
              {...isProcessing ? {} : { onRemove: () => onRemoveVideo(index) }}
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
      />

      <div className="composer-toolbar">
        <button
          className="icon-button attachment-button"
          type="button"
          aria-label="选择视频"
          title="选择视频"
          disabled={isProcessing}
          onClick={onSelectVideo}
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
            aria-label="发送"
            title="发送"
            disabled={isProcessing || !prompt.trim()}
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M8.3125.980183c.35517.073166.66797.224837.9502.452147.2245.18064.4678.425457.7168.67481L14.707 6.83468l-1.414 1.414L9 3.95577v11.08593H7V3.95577L2.707 8.24868l-1.414-1.414L6.0205 2.10714c.2492-.24921.4925-.49402.71699-.67481C7.0212 1.20402 7.33399 1.05335 7.6875.980183c.2103-.043177.4161-.025025.625.0Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
}
