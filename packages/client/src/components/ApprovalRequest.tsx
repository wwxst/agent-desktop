import type { ApprovalRequest as ApprovalRequestData } from '../api.js';

interface ApprovalRequestProps {
  readonly request: ApprovalRequestData;
  readonly onDecide: (approved: boolean) => void;
}

/**
 * 单个待决操作的审批交互。
 *
 * 界面只展示宿主给出的确切操作和目标，并提交允许或拒绝。
 * 这里不提供修改入口：批准的范围必须和宿主真正要执行的操作完全一致，
 * 否则「用户批准的」和「实际执行的」就不再是同一件事。
 */
export function ApprovalRequest({ request, onDecide }: ApprovalRequestProps) {
  return (
    <section className="approval-request" aria-label="操作审批">
      <p className="approval-question">允许 Agent 使用这个目录吗？</p>
      <p className="approval-directory" title={request.target}>{request.target}</p>
      <div className="approval-actions">
        <button type="button" className="approval-allow" onClick={() => onDecide(true)}>允许</button>
        <button type="button" className="approval-deny" onClick={() => onDecide(false)}>拒绝</button>
      </div>
    </section>
  );
}
