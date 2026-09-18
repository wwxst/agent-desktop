import type { AttachmentRole } from '../api.js';
import { AttachmentChip } from './AttachmentChip.js';

interface UserTaskMessageProps {
  readonly text: string;
  readonly attachments: readonly string[];
  readonly attachmentRoles?: readonly AttachmentRole[];
}

/** 用户任务：已提交附件位于气泡上方并右对齐，使输入文件和任务文字成为同一个用户动作。 */
export function UserTaskMessage({ text, attachments, attachmentRoles }: UserTaskMessageProps) {
  return (
    <article className="message-block user-message" aria-label="你的任务">
      <div className="user-message-content">
        {attachments.length > 0 && (
          <div className="submitted-attachments" aria-label="已提交的输入附件">
            {attachments.map((name, index) => (
              <AttachmentChip
                key={`${name}-${index}`}
                name={name}
                // 旧快照只有名称：按视频展示，与本轮之前唯一的附件语义一致。
                role={attachmentRoles?.[index] ?? 'video'}
              />
            ))}
          </div>
        )}
        <p>{text}</p>
      </div>
    </article>
  );
}
