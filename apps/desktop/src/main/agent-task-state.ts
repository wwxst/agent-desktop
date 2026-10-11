import {
  projectRecoveryAncestry,
  projectTaskPlan,
  projectTaskState,
  type PlanEvidenceSource,
  type QualifyToolEvidence,
  type SessionEvent,
  type TurnId,
} from '@agent-desktop/session';
import {
  latestValidationForCandidate,
  readVideoDeliveryFacts,
} from '@agent-desktop/video-agent';
import type { AgentTaskState } from '@agent-desktop/client';

const DECLARE_VIDEO_OUTPUTS_TOOL = 'declare_video_outputs';
const VALIDATE_VIDEO_CANDIDATE_TOOL = 'validate_video_candidate';
const PUBLISH_VIDEO_OUTPUT_TOOL = 'publish_video_output';

const toolCallKey = (event: { readonly turnId: string; readonly stepId: string; readonly toolCallId: string }) =>
  `${event.turnId}\u0000${event.stepId}\u0000${event.toolCallId}`;

function precedingCall(source: Extract<PlanEvidenceSource, { readonly type: 'tool.result' }>, events: readonly SessionEvent[]) {
  const sourceIndex = events.indexOf(source);
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'tool.called' && toolCallKey(event) === toolCallKey(source)) return event;
  }
  return undefined;
}

function successOutput(source: Extract<PlanEvidenceSource, { readonly type: 'tool.result' }>): unknown {
  return source.result.status === 'success' ? source.result.output : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allDelegateChildrenCompleted(output: unknown): boolean {
  if (!isRecord(output) || !Array.isArray(output.tasks)) return false;
  return output.tasks.length > 0 && output.tasks.every((task) => isRecord(task) && task.status === 'completed');
}

/**
 * Desktop 唯一的业务工具资格回调。Session 只负责引用完整事件，
 * 这里才知道本地工具和视频交付工具返回的字段各自代表什么事实。
 */
export const qualifyTaskToolEvidence: QualifyToolEvidence = (source, events) => {
  if (source.type === 'effect.outcome.verified') {
    return source.scope === 'entire-call' && source.outcome === 'completed'
      ? { eligible: true, label: source.evidence.description }
      : { eligible: false, label: source.evidence.description };
  }
  if (source.result.status !== 'success') return { eligible: false, label: '工具执行失败' };

  const call = precedingCall(source, events);
  if (call === undefined) return { eligible: false, label: '工具调用来源未确认' };
  const output = successOutput(source);
  switch (call.name) {
    case 'update_plan':
      return { eligible: false, label: '计划已更新，未证明业务步骤完成' };
    case 'delegate_tasks':
      return allDelegateChildrenCompleted(output)
        ? { eligible: true, label: '只读子任务均已完成' }
        : { eligible: false, label: '子任务结果未全部完成' };
    case 'set_working_directory': return { eligible: true, label: '工作目录已确认' };
    case 'list_directory': return { eligible: true, label: '目录已读取' };
    case 'read_file': return { eligible: true, label: '文件已读取' };
    case 'search_text': return { eligible: true, label: '内容搜索已完成' };
    case 'write_text_file': return { eligible: true, label: '文本文件已创建' };
    case 'edit_text_file': return { eligible: true, label: '文本文件已修改' };
    case 'run_command': return { eligible: true, label: '命令已退出（退出码 0）' };
    case 'ask_user':
      return isRecord(output) && output.outcome === 'answered'
        ? { eligible: true, label: '用户问题已回答' }
        : { eligible: false, label: '用户未提供回答' };
    case 'open_terminal': return { eligible: false, label: '终端已启动，命令结果未确认' };
    case 'write_terminal': return { eligible: false, label: '输入已发送，命令结果未确认' };
    case 'read_terminal': return { eligible: false, label: '终端输出已读取，命令结果未确认' };
    case 'close_terminal': return { eligible: true, label: '终端已关闭' };
    case DECLARE_VIDEO_OUTPUTS_TOOL: return { eligible: false, label: '视频输出集合已声明，尚未交付' };
    case VALIDATE_VIDEO_CANDIDATE_TOOL: {
      const facts = readVideoDeliveryFacts(events.slice(0, events.indexOf(source) + 1));
      const candidate = facts.candidates.at(-1);
      const validation = candidate === undefined ? undefined : latestValidationForCandidate(facts, candidate.id);
      const passed = validation !== undefined && validation.checks.length > 0
        && validation.checks.every((check) => check.outcome === 'passed');
      return passed
        ? { eligible: true, label: '视频候选已通过全部验收' }
        : { eligible: false, label: '视频候选验收未全部通过' };
    }
    case PUBLISH_VIDEO_OUTPUT_TOOL: return { eligible: true, label: '视频输出已发布' };
    // 候选、中间媒体和观察结果只证明该工具动作完成，不证明用户最终业务目标完成。
    case 'trim_video': case 'concat_videos': case 'add_audio': case 'add_subtitles':
    case 'resize_video': case 'crop_video': case 'set_speed':
      return { eligible: false, label: '视频候选已生成，最终交付未确认' };
    default:
      return { eligible: false, label: '工具已返回，业务结果未确认' };
  }
};

/** 从 Session 原始事件投影给界面；没有 plan 时仍返回普通任务状态。 */
export function projectAgentTaskState(events: readonly SessionEvent[], turnId: TurnId): AgentTaskState {
  const ancestry = projectRecoveryAncestry(events, turnId);
  const planProjection = projectTaskPlan(events, ancestry.rootTurnId, qualifyTaskToolEvidence);
  const state = projectTaskState(events, ancestry.rootTurnId, planProjection) ?? 'started';
  return {
    rootTurnId: ancestry.rootTurnId,
    latestTurnId: ancestry.latestTurnId,
    status: state,
    ...(planProjection === undefined ? {} : {
      plan: {
        revision: planProjection.revision,
        explanation: planProjection.explanation,
        steps: planProjection.steps.map((step) => ({
          id: step.id,
          description: step.description,
          status: step.status,
          completionKind: step.completionKind,
          evidenceLabels: step.evidenceLabels,
        })),
      },
    }),
  };
}
