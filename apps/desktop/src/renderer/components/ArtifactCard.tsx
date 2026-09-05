interface ArtifactCardProps {
  readonly fileName: string;
  readonly onOpen: () => void;
}

/** 显示当前任务唯一的输出视频，并复用 Main 提供的文件打开能力。 */
export function ArtifactCard({ fileName, onOpen }: ArtifactCardProps) {
  return (
    <section className="artifact-card" aria-label="结果产物">
      <span className="artifact-icon" aria-hidden="true">▶</span>
      <div className="artifact-copy">
        <strong>{fileName}</strong>
        <span>视频 · 已完成</span>
      </div>
      <button className="artifact-open" type="button" onClick={onOpen}>
        打开文件
      </button>
    </section>
  );
}
