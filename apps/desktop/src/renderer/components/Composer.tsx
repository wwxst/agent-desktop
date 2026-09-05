import type { FormEvent } from 'react';
import type { SelectedVideo } from '../../shared/ipc.js';
import { AttachmentChip } from './AttachmentChip.js';

interface ComposerProps {
  readonly selectedVideo: SelectedVideo | null;
  readonly prompt: string;
  readonly isProcessing: boolean;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSelectVideo: () => void;
  readonly onSend: () => void;
}

/** Composer 集中承载视频附件、自然语言输入和发送动作。 */
export function Composer({
  selectedVideo,
  prompt,
  isProcessing,
  onPromptChange,
  onSelectVideo,
  onSend,
}: ComposerProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSend();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {selectedVideo && <AttachmentChip name={selectedVideo.name} />}

      <label className="visually-hidden" htmlFor="agent-prompt">剪辑需求</label>
      <textarea
        id="agent-prompt"
        value={prompt}
        disabled={isProcessing}
        placeholder="告诉 Agent 你想怎么处理这个视频…"
        rows={3}
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
          <span aria-hidden="true">＋</span>
        </button>
        <span className="composer-state">{isProcessing ? '处理中' : '就绪'}</span>
        <button
          className="icon-button send-button"
          type="submit"
          aria-label="发送"
          title="发送"
          disabled={isProcessing || !selectedVideo || !prompt.trim()}
        >
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </form>
  );
}
