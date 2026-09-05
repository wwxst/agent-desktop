interface AttachmentChipProps {
  readonly name: string;
}

/** 在对话和输入区中用同一产品语义呈现当前视频附件。 */
export function AttachmentChip({ name }: AttachmentChipProps) {
  return (
    <div className="attachment-chip" aria-label={`视频附件：${name}`}>
      <span className="attachment-icon" aria-hidden="true">▶</span>
      <span className="attachment-copy">
        <strong>{name}</strong>
        <small>视频</small>
      </span>
    </div>
  );
}
