import type { AttachmentRole } from '../api.js';

interface AttachmentChipProps {
  readonly name: string;
  readonly role: AttachmentRole;
  readonly onRemove?: () => void;
}

/** 角色对应的界面文案；视频是主输入，音轨由 add_audio 使用。 */
const ROLE_LABELS: Record<AttachmentRole, string> = {
  video: '视频',
  audio: '音轨',
};

/** 在对话和输入区中用同一产品语义呈现输入附件，并标出它在任务里的角色。 */
export function AttachmentChip({ name, role, onRemove }: AttachmentChipProps) {
  const label = ROLE_LABELS[role];
  return (
    <div className="attachment-chip" aria-label={`${label}附件：${name}`} title={name}>
      <span className="attachment-icon" aria-hidden="true">
        <svg viewBox="0 0 24 28" width="21" height="24" focusable="false">
          <path d="M16.5 0 24 7.5V23a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5h11.5Z" />
          <path className="attachment-icon-fold" d="m16.5 0 7.5 7.5h-4a3.5 3.5 0 0 1-3.5-3.5V0Z" />
          {role === 'video' ? (
            <path className="attachment-icon-play" d="m9.25 10.5 6.5 3.5-6.5 3.5v-7Z" />
          ) : (
            // 音轨用波形而不是播放三角，避免与主视频混淆。
            <path className="attachment-icon-wave" d="M7.5 12v4M10.5 9.5v9M13.5 11.5v5M16.5 10v8" />
          )}
        </svg>
      </span>
      <span className="attachment-copy">
        <strong>{name}</strong>
        <small>{label}</small>
      </span>
      {onRemove && (
        <button
          className="attachment-remove"
          type="button"
          aria-label={`移除${label} ${name}`}
          title={`移除${label}`}
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
