import { useState } from 'react';

interface ArtifactCardProps {
  readonly fileName: string;
  readonly onOpen: () => Promise<void>;
}

/** 显示一次成功生成的持久产物，并复用宿主提供的文件定位能力。 */
export function ArtifactCard({ fileName, onOpen }: ArtifactCardProps) {
  const [openError, setOpenError] = useState<string | null>(null);

  const open = () => {
    void onOpen().then(
      () => setOpenError(null),
      (error: unknown) => setOpenError(
        error instanceof Error ? error.message : '无法定位该文件。',
      ),
    );
  };

  return (
    <section className="artifact-card" aria-label="结果产物">
      <span className="artifact-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></svg></span>
      <div className="artifact-copy">
        <strong title={fileName}>{fileName}</strong>
        <span>视频 · 已完成</span>
      </div>
      <div className="artifact-actions">
        <button className="artifact-open" type="button" onClick={open}>
          打开文件
        </button>
      </div>
      {openError !== null && <p className="artifact-error" role="status">{openError}</p>}
    </section>
  );
}
