import type { ApprovalRequest as ApprovalRequestData } from '../api.js';

/** 每种操作对应的问话：界面只展示宿主要执行的确切操作，不替用户推断它是什么。 */
const APPROVAL_QUESTIONS: Readonly<Record<ApprovalRequestData['kind'], string>> = {
  directory: '允许 Agent 使用这个目录吗？',
  'create-file': '允许 Agent 创建这个文件吗？',
  'edit-file': '允许 Agent 修改这个文件吗？',
  command: '允许 Agent 执行这条本机命令吗？',
};

/** 超时按秒展示；用户批准的是生效值，因此这里显示的就是真正会使用的上限。 */
function formatTimeout(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1000)} 秒`;
}

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
      <div className="approval-strip">
        <span className="approval-dot" aria-hidden="true" />
        <span>等待审批</span>
      </div>
      <p className="approval-question">{APPROVAL_QUESTIONS[request.kind]}</p>
      {request.kind === 'command' ? (
        <div className="approval-command" aria-label="命令详情">
          <div className="approval-command-meta">
            <span>解释器</span>
            <code title={request.interpreter}>{request.interpreter}</code>
            <span>执行目录</span>
            <code title={request.workingDirectory}>{request.workingDirectory}</code>
            <span>超时</span>
            <span>{formatTimeout(request.timeoutMs)}</span>
          </div>
          <div className="approval-change-section">
            <span>完整命令</span>
            <pre>{request.command}</pre>
          </div>
          {/* 授权范围必须如实说明：工作目录只是起点，不能声称它是隔离环境。 */}
          <p className="approval-command-scope">
            这是以当前用户权限执行的本机命令授权。工作目录只是执行起点，
            无法限制脚本访问其他目录、网络或调用其他程序；它不是操作系统沙箱。
          </p>
        </div>
      ) : (
        <>
          <p className="approval-directory" title={request.target}>{request.target}</p>
          {request.kind === 'edit-file' ? (
            <div className="approval-change" aria-label="文件变更">
              <div className="approval-change-section">
                <span>原内容</span>
                <pre>{request.before}</pre>
              </div>
              <div className="approval-change-section">
                <span>新内容</span>
                <pre>{request.after}</pre>
              </div>
            </div>
          ) : null}
        </>
      )}
      <div className="approval-actions">
        <button type="button" className="approval-deny" onClick={() => onDecide(false)}>拒绝</button>
        <button type="button" className="approval-allow" onClick={() => onDecide(true)}>允许</button>
      </div>
    </section>
  );
}
