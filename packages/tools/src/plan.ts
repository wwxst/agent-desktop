import type { ToolResult } from '@agent-desktop/model';
import {
  isTaskPlanEvidenceEvent, projectRecoveryAncestry, projectTaskPlan, projectTurnState, TaskPlanUpdateError,
  type SessionEventInput, type QualifyToolEvidence, type Session, type TaskPlanStatus, type TaskPlanStep,
} from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from './contract.js';

// 模型计划 JSON 只在这一边界限制当前使用的字段，避免计划本身无限占用上下文。
const MAX_STEPS = 32;
const MAX_ID_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_EXPLANATION_CHARS = 1024;
const STATUSES: readonly TaskPlanStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'blocked'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function failure(message: string): ToolResult {
  return { status: 'error', failureKind: 'permanent', message: `update_plan: ${message}` };
}

/** 计划只是声明；真正完成、失败及阻塞由同一 Session 投影及宿主资格回调判定。 */
export class UpdatePlanTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  // 只追加内部计划事实，未知外部效果不应阻止安全核验轮次整理计划。
  readonly executionBoundary = 'read-only' as const;
  readonly name = 'update_plan';
  readonly description = '为复杂任务创建或更新完整计划；简单任务无需调用。保留稳定步骤 ID，已完成步骤不能删除或撤销，新工作使用新 ID。tool 完成须引用真实成功或整调用完成核验；response 只表示等待最终文本交付，不证明文件或外部业务成功。';
  readonly inputSchema = {
    type: 'object',
    properties: {
      explanation: { type: 'string', minLength: 1, maxLength: MAX_EXPLANATION_CHARS, description: '创建或重新规划的原因' },
      steps: {
        type: 'array', minItems: 1, maxItems: MAX_STEPS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS, description: '同一工作始终使用同一 ID，新工作使用新 ID' },
            description: { type: 'string', minLength: 1, maxLength: MAX_DESCRIPTION_CHARS },
            requestedStatus: { type: 'string', enum: STATUSES },
            completionKind: { type: 'string', enum: ['tool', 'response'], description: '工具事实或最终文本交付；response 不证明外部写入完成' },
            evidenceEventIndexes: { type: 'array', items: { type: 'integer', minimum: 0 }, uniqueItems: true, description: '仅引用当前任务链中已经发生的 Session 事件索引；计划工具自身结果不是完成证据' },
          },
          required: ['id', 'description', 'requestedStatus', 'completionKind', 'evidenceEventIndexes'],
          additionalProperties: false,
        },
      },
    },
    required: ['explanation', 'steps'],
    additionalProperties: false,
  };

  constructor(private readonly session: Session, private readonly qualifyToolEvidence: QualifyToolEvidence) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    if (!isRecord(input) || !boundedText(input.explanation, MAX_EXPLANATION_CHARS)
      || !Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
      return failure(`需要非空 explanation（最多 ${MAX_EXPLANATION_CHARS} 字符）和 1–${MAX_STEPS} 项完整 steps。`);
    }
    const steps: TaskPlanStep[] = [];
    const ids = new Set<string>();
    for (const value of input.steps) {
      if (!isRecord(value) || !boundedText(value.id, MAX_ID_CHARS) || !boundedText(value.description, MAX_DESCRIPTION_CHARS)
        || !STATUSES.includes(value.requestedStatus as TaskPlanStatus) || (value.completionKind !== 'tool' && value.completionKind !== 'response')
        || !Array.isArray(value.evidenceEventIndexes)) return failure('步骤字段、状态、完成类型或文本预算无效。');
      if (ids.has(value.id)) return failure('步骤 ID 不能重复。');
      ids.add(value.id);
      const indexes: number[] = [];
      for (const index of value.evidenceEventIndexes) {
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || indexes.includes(index)) return failure('事实索引必须为不重复的非负整数。');
        indexes.push(index);
      }
      steps.push({ id: value.id, description: value.description, requestedStatus: value.requestedStatus as TaskPlanStatus,
        completionKind: value.completionKind, evidenceEventIndexes: indexes });
    }
    const events = this.session.events();
    const current = events.findLast(event => event.type === 'turn.started');
    // 当前调用归属来自宿主已保存的起点，模型不能指定 turnId 或伪造 revision。
    if (current === undefined || projectTurnState(events, current.turnId) !== 'started') throw new Error('计划工具必须在已开始且未结束的 Turn 中执行。');
    const ancestry = projectRecoveryAncestry(events, current.turnId);
    const taskTurns = new Set(ancestry.turnIds);
    const previous = projectTaskPlan(events, ancestry.rootTurnId, this.qualifyToolEvidence);
    for (const step of steps) for (const index of step.evidenceEventIndexes) {
      const source = events[index];
      if (source === undefined || !isTaskPlanEvidenceEvent(source) || !taskTurns.has(source.turnId)) {
        return failure('事实索引必须指向当前任务链中已存在的执行、核验或失败事实。');
      }
      if (step.completionKind === 'tool' && step.requestedStatus === 'completed' && source.type === 'tool.result') {
        const call = events.slice(0, index).findLast(event => event.type === 'tool.called' && event.turnId === source.turnId
          && event.payload.stepId === source.payload.stepId && event.payload.toolCallId === source.payload.toolCallId);
        if (call?.type === 'tool.called' && call.payload.name === this.name) return failure('计划工具自身结果不能确认工作完成。');
      }
    }
    const event: Extract<SessionEventInput, { type: 'plan.updated' }> = { type: 'plan.updated', turnId: current.turnId, payload: { revision: (previous?.revision ?? 0) + 1, explanation: input.explanation, steps } };
    let candidate;
    try { candidate = projectTaskPlan(events, ancestry.rootTurnId, this.qualifyToolEvidence, event); }
    catch (error) {
      if (error instanceof TaskPlanUpdateError) return failure(error.message);
      throw error;
    }
    for (const step of candidate!.steps) {
      // response completed 可提前声明意图；只有之后真实 final+turn.completed 才完成。
      if (step.completionKind === 'tool' && step.requestedStatus === 'completed' && !step.completionConfirmed) return failure(`步骤 ${step.id} 尚无真实完成证据。`);
      if (step.requestedStatus === 'failed' && !step.failureConfirmed) return failure(`步骤 ${step.id} 尚无真实错误来源。`);
      if (step.requestedStatus === 'blocked' && step.status !== 'blocked') return failure(`步骤 ${step.id} 尚无未知效果、等待交互或中断来源。`);
    }
    // 只有候选投影通过后才追加；保存或程序错误直接传播，不能返回默认成功。
    context.signal?.throwIfAborted();
    this.session.append(event);
    return { status: 'success', output: { rootTurnId: ancestry.rootTurnId, revision: event.payload.revision,
      steps: candidate!.steps.map(({ id, status }) => ({ id, status })) } };
  }
}
