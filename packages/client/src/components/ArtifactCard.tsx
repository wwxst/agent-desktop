import { useState } from 'react';
import { ExtensionToast } from './ExtensionFeedback.js';

interface ArtifactCardProps {
  readonly fileName: string;
  readonly onOpen: () => Promise<void>;
}

/**
 * 当前真实存在的产物类型：视频由 FFmpeg 写出型工具登记，字幕和文本由 write_text_file 登记。
 * 类型只用于界面呈现，不改变产物登记事实和打开文件链路。
 */
type ArtifactKind = 'video' | 'subtitle' | 'text' | 'file';

/** 与宿主文件对话框声明的可处理视频格式保持一致，避免已有视频产物被降级成中性文件。 */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];

const KIND_LABELS: Record<ArtifactKind, string> = {
  video: '视频',
  subtitle: '字幕',
  text: '文本',
  file: '文件',
};

/**
 * 从已经持久化的文件名投影产物类型，因此不需要宿主再传一份类型。
 * 未知扩展名保持中性：把非视频文件画成播放图形会让用户以为它可以播放。
 */
function artifactKind(fileName: string): ArtifactKind {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return 'file';
  // Windows 路径大小写不敏感，扩展名统一按小写比较。
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (extension === 'srt') return 'subtitle';
  if (extension === 'txt' || extension === 'md') return 'text';
  return 'file';
}

/** 只有视频使用播放三角；字幕和文本用不暗示可播放的线条，未知文件保持空白页。 */
function ArtifactIcon({ kind }: { readonly kind: ArtifactKind }) {
  if (kind === 'video') {
    return <svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></svg>;
  }
  if (kind === 'subtitle') {
    return <svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 11h3.5M13.5 11h3.5M7 14.5h10" /></svg>;
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20">
      <path d="M6 3h7l5 5v13H6Z" />
      <path d="M13 3v5h5" />
      {kind === 'text' && <path d="M9 13h6M9 16h6" />}
    </svg>
  );
}

/** 显示一次成功生成的持久产物，并复用宿主提供的文件定位能力。 */
export function ArtifactCard({ fileName, onOpen }: ArtifactCardProps) {
  const [openError, setOpenError] = useState<string | null>(null);
  const kind = artifactKind(fileName);

  const open = () => {
    setOpenError(null);
    void onOpen().catch(
      (error: unknown) => setOpenError(
        error instanceof Error ? error.message : '无法定位该文件。',
      ),
    );
  };

  return (
    <section className="artifact-card" aria-label="结果产物">
      <span className="artifact-icon" aria-hidden="true"><ArtifactIcon kind={kind} /></span>
      <div className="artifact-copy">
        <strong title={fileName}>{fileName}</strong>
        <span>{KIND_LABELS[kind]} · 已完成</span>
      </div>
      <div className="artifact-actions">
        <button className="artifact-open" type="button" onClick={open}>
          打开文件
        </button>
      </div>
      {openError !== null && <ExtensionToast notice={{ variant: 'error', message: openError }} onClose={() => setOpenError(null)} />}
    </section>
  );
}
