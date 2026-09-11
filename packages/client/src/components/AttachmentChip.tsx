interface AttachmentChipProps {
  readonly name: string;
  readonly onRemove?: () => void;
}

/** 在对话和输入区中用同一产品语义呈现视频附件。 */
export function AttachmentChip({ name, onRemove }: AttachmentChipProps) {
  return (
    <div className="attachment-chip" aria-label={`视频附件：${name}`} title={name}>
      <span className="attachment-icon" aria-hidden="true">
        <svg viewBox="0 0 24 28" width="21" height="24" focusable="false">
          <path d="M16.5 0 24 7.5V23a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5h11.5Z" />
          <path className="attachment-icon-fold" d="m16.5 0 7.5 7.5h-4a3.5 3.5 0 0 1-3.5-3.5V0Z" />
          <path className="attachment-icon-play" d="m9.25 10.5 6.5 3.5-6.5 3.5v-7Z" />
        </svg>
      </span>
      <span className="attachment-copy">
        <strong>{name}</strong>
        <small>视频</small>
      </span>
      {onRemove && (
        <button
          className="attachment-remove"
          type="button"
          aria-label={`移除视频 ${name}`}
          title="移除视频"
          onClick={onRemove}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M3 3 13 13M13 3 3 13" />
          </svg>
        </button>
      )}
    </div>
  );
}
