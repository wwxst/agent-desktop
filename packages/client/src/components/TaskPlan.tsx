import type { AgentTaskState } from '../api.js';

interface TaskPlanProps { readonly taskState: AgentTaskState | undefined; }

const statusLabels = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '待确认',
} as const;

/** 计划是当前 Assistant 回复的一部分；状态和证据来自宿主投影，不提供编辑或推进按钮。 */
export function TaskPlan({ taskState }: TaskPlanProps) {
  const plan = taskState?.plan;
  if (plan === undefined || plan.steps.length === 0) return null;
  return (
    <section className="task-plan" aria-label="任务计划">
      <div className="task-plan-header">
        <strong>任务计划</strong>
        <span>第 {plan.revision} 版</span>
      </div>
      {plan.explanation && <p className="task-plan-explanation">{plan.explanation}</p>}
      <ol className="task-plan-steps">
        {plan.steps.map((step) => {
          const responseProof = step.completionKind === 'response' && step.status === 'completed'
            ? ['文本回复已生成'] : [];
          const evidence = [...step.evidenceLabels, ...responseProof];
          return (
            <li key={step.id} className={`task-plan-step is-${step.status}`}>
              <div className="task-plan-step-main">
                <span className="task-plan-step-index" aria-hidden="true">{step.status === 'completed' ? '✓' : '·'}</span>
                <span className="task-plan-step-description">{step.description}</span>
                <span className="task-plan-step-status">{statusLabels[step.status]}</span>
              </div>
              {evidence.length > 0 && <div className="task-plan-evidence">{evidence.map((label) => <span key={label}>{label}</span>)}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
