interface ArtifactCardProps {
  readonly fileName: string;
  readonly onOpen: () => void;
}

/** 显示当前任务唯一的输出视频，并复用 Main 提供的文件打开能力。 */
export function ArtifactCard({ fileName, onOpen }: ArtifactCardProps) {
  return (
    <section className="artifact-card" aria-label="结果产物">
      <span className="artifact-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></svg></span>
      <div className="artifact-copy">
        <strong title={fileName}>{fileName}</strong>
        <span>视频 · 已完成 · 预览待接入</span>
      </div>
      <div className="artifact-actions">
        <button className="artifact-preview" type="button" disabled title="视频预览待接入">预览</button>
        <button className="artifact-open" type="button" onClick={onOpen}>
          打开文件
        </button>
      </div>
    </section>
  );
}
