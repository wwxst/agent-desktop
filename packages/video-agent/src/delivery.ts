import type { ToolCallId } from '@agent-desktop/model';
import type { SessionEvent, TurnId } from '@agent-desktop/session';

/**
 * 视频交付模型：输出项、候选、候选验收与已交付文件。
 *
 * 这里只保存业务事实的类型与读取规则；它不认识 Electron、界面或具体 FFmpeg 参数。
 * 同一份事实由桌面与命令行共用，避免出现第二套「什么算交付成功」的口径。
 */

/** 一个输出项的目标。 */
export type OutputTarget =
  // 用户明确指定的最终路径；冲突时不能擅自改名，也不能覆盖。
  | { readonly kind: 'explicit'; readonly path: string }
  // 应用层给出的默认首选路径；发布时再按真实磁盘占用选择可用名称。
  | { readonly kind: 'automatic'; readonly preferredPath: string };

/**
 * 输出项的一条必要要求。
 *
 * 所有要求都是必要条件；`decodable-video` 由应用层自动加入，模型不能删除。
 */
export type OutputRequirement =
  | { readonly id: string; readonly kind: 'decodable-video' }
  | {
      readonly id: string;
      readonly kind: 'duration-range';
      readonly minSeconds: number;
      readonly maxSeconds: number;
    }
  | { readonly id: string; readonly kind: 'no-black-segments' }
  // 保存用户要求本身；当前没有合格覆盖方法时验收会明确记为受阻。
  | { readonly id: string; readonly kind: 'semantic'; readonly description: string };

/** 用户预期得到的一项视频结果。 */
export interface OutputItem {
  readonly id: string;
  readonly sourcePaths: readonly string[];
  readonly target: OutputTarget;
  /** 本项专用工作目录：候选与中间文件都写在这里，不使用最终交付序号。 */
  readonly workingDirectory: string;
  readonly requirements: readonly OutputRequirement[];
}

/** 由某次成功生产调用真实写出的候选文件。 */
export interface Candidate {
  readonly id: string;
  readonly outputItemId: string;
  readonly path: string;
  readonly producerToolCallId: ToolCallId;
}

/** 单条必要要求的检查结果。 */
export type RequirementCheck = {
  readonly requirementId: string;
  /** 引用真实工具结果；不接受模型自由填写的「证据已通过」。 */
  readonly evidenceToolCallIds: readonly ToolCallId[];
  readonly detail: string;
} & (
  | { readonly outcome: 'passed' | 'failed' }
  | {
      readonly outcome: 'blocked';
      readonly reason: 'capability-unavailable' | 'tool-error' | 'insufficient-evidence';
    }
);

/** 针对一个候选、覆盖所属输出项每条必要要求的一次验收。 */
export interface CandidateValidation {
  readonly id: string;
  readonly candidateId: string;
  readonly checks: readonly RequirementCheck[];
}

/** 必要检查全部通过且成功发布到最终路径的文件。 */
export interface PublishedOutput {
  readonly outputItemId: string;
  /** 经应用层复核的最近一次全项通过验收。 */
  readonly validationId: string;
  readonly path: string;
}

/** 放入 `ToolResult.output` 的视频交付事实；不向核心 Session 事件增加视频分支。 */
export type VideoOutputFact =
  | { readonly kind: 'video.outputs.declared'; readonly items: readonly OutputItem[] }
  | {
      readonly kind: 'video.candidate.validated';
      readonly candidate: Candidate;
      readonly validation: CandidateValidation;
    }
  | { readonly kind: 'video.output.published'; readonly output: PublishedOutput };

/** 轮次收尾时的逐项读取投影，不是又一套需要工具推进的持久状态机。 */
export type OutputItemResult =
  | { readonly outputItemId: string; readonly status: 'published'; readonly output: PublishedOutput }
  | {
      readonly outputItemId: string;
      readonly status: 'failed' | 'blocked' | 'incomplete';
      readonly reason: string;
    };

/** 承载这三类事实的应用工具名称；事实只接受它们返回的结构。 */
export const DECLARE_VIDEO_OUTPUTS_TOOL = 'declare_video_outputs';
export const VALIDATE_VIDEO_CANDIDATE_TOOL = 'validate_video_candidate';
export const PUBLISH_VIDEO_OUTPUT_TOOL = 'publish_video_output';

/** 从会话事实读出的交付状态。 */
export interface VideoDeliveryFacts {
  /** 最近一次完整声明；没有声明时为空数组。 */
  readonly items: readonly OutputItem[];
  /** 最近一次声明所在的轮次；用于判断本轮是否真的声明过输出项。 */
  readonly declarationTurnId: TurnId | undefined;
  readonly candidates: readonly Candidate[];
  readonly validations: readonly CandidateValidation[];
  readonly published: readonly PublishedOutput[];
}

const DECLARATION_KIND = 'video.outputs.declared';
const VALIDATION_KIND = 'video.candidate.validated';
const PUBLISH_KIND = 'video.output.published';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readOutputRequirement(value: unknown): OutputRequirement | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  switch (value.kind) {
    case 'decodable-video':
      return { id: value.id, kind: 'decodable-video' };
    case 'duration-range':
      return typeof value.minSeconds === 'number' && typeof value.maxSeconds === 'number'
        ? { id: value.id, kind: 'duration-range', minSeconds: value.minSeconds, maxSeconds: value.maxSeconds }
        : null;
    case 'no-black-segments':
      return { id: value.id, kind: 'no-black-segments' };
    case 'semantic':
      return typeof value.description === 'string'
        ? { id: value.id, kind: 'semantic', description: value.description }
        : null;
    default:
      return null;
  }
}

function readOutputItem(value: unknown): OutputItem | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !isStringArray(value.sourcePaths)
    || typeof value.workingDirectory !== 'string'
    || !Array.isArray(value.requirements)) {
    return null;
  }

  const target = value.target;
  const parsedTarget: OutputTarget | null = isRecord(target) && target.kind === 'explicit'
    && typeof target.path === 'string'
    ? { kind: 'explicit', path: target.path }
    : isRecord(target) && target.kind === 'automatic' && typeof target.preferredPath === 'string'
      ? { kind: 'automatic', preferredPath: target.preferredPath }
      : null;
  if (parsedTarget === null) return null;

  const requirements: OutputRequirement[] = [];
  for (const raw of value.requirements) {
    const requirement = readOutputRequirement(raw);
    if (requirement === null) return null;
    requirements.push(requirement);
  }

  return {
    id: value.id,
    sourcePaths: value.sourcePaths,
    target: parsedTarget,
    workingDirectory: value.workingDirectory,
    requirements,
  };
}

function readCandidate(value: unknown): Candidate | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.outputItemId !== 'string'
    || typeof value.path !== 'string'
    || typeof value.producerToolCallId !== 'string') {
    return null;
  }
  return {
    id: value.id,
    outputItemId: value.outputItemId,
    path: value.path,
    producerToolCallId: value.producerToolCallId as ToolCallId,
  };
}

function readRequirementCheck(value: unknown): RequirementCheck | null {
  if (!isRecord(value)
    || typeof value.requirementId !== 'string'
    || !isStringArray(value.evidenceToolCallIds)
    || typeof value.detail !== 'string') {
    return null;
  }

  const evidenceToolCallIds = value.evidenceToolCallIds as readonly ToolCallId[];
  if (value.outcome === 'passed' || value.outcome === 'failed') {
    return { requirementId: value.requirementId, evidenceToolCallIds, detail: value.detail, outcome: value.outcome };
  }
  if (value.outcome === 'blocked'
    && (value.reason === 'capability-unavailable'
      || value.reason === 'tool-error'
      || value.reason === 'insufficient-evidence')) {
    return {
      requirementId: value.requirementId,
      evidenceToolCallIds,
      detail: value.detail,
      outcome: 'blocked',
      reason: value.reason,
    };
  }
  return null;
}

function readValidation(value: unknown): CandidateValidation | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.candidateId !== 'string'
    || !Array.isArray(value.checks)) {
    return null;
  }
  const checks: RequirementCheck[] = [];
  for (const raw of value.checks) {
    const check = readRequirementCheck(raw);
    if (check === null) return null;
    checks.push(check);
  }
  return { id: value.id, candidateId: value.candidateId, checks };
}

function readPublishedOutput(value: unknown): PublishedOutput | null {
  if (!isRecord(value)
    || typeof value.outputItemId !== 'string'
    || typeof value.validationId !== 'string'
    || typeof value.path !== 'string') {
    return null;
  }
  return { outputItemId: value.outputItemId, validationId: value.validationId, path: value.path };
}

/**
 * 解析一条交付事实。
 *
 * 只接受三个已注册应用工具返回的结构：其他工具输出里碰巧同名的 `kind` 不是发布事实。
 * 结构不完整时返回 null，而不是用默认值把它当成合法事实。
 */
function readVideoOutputFact(toolName: string | undefined, output: unknown): VideoOutputFact | null {
  if (!isRecord(output) || typeof output.kind !== 'string') return null;

  if (toolName === DECLARE_VIDEO_OUTPUTS_TOOL && output.kind === DECLARATION_KIND) {
    if (!Array.isArray(output.items)) return null;
    const items: OutputItem[] = [];
    for (const raw of output.items) {
      const item = readOutputItem(raw);
      if (item === null) return null;
      items.push(item);
    }
    return { kind: DECLARATION_KIND, items };
  }

  if (toolName === VALIDATE_VIDEO_CANDIDATE_TOOL && output.kind === VALIDATION_KIND) {
    const candidate = readCandidate(output.candidate);
    const validation = readValidation(output.validation);
    if (candidate === null || validation === null) return null;
    return { kind: VALIDATION_KIND, candidate, validation };
  }

  if (toolName === PUBLISH_VIDEO_OUTPUT_TOOL && output.kind === PUBLISH_KIND) {
    const published = readPublishedOutput(output.output);
    if (published === null) return null;
    return { kind: PUBLISH_KIND, output: published };
  }

  return null;
}

/**
 * 从会话事实读出当前交付状态。
 *
 * 这是唯一权威实现：它按事件顺序扫描成功工具结果，因此取消发生在成功结果写入之后的产物
 * 仍然被承认；`tool.result` 的 error 分支不产生任何交付事实。
 */
export function readVideoDeliveryFacts(events: readonly SessionEvent[]): VideoDeliveryFacts {
  // Trace 不复制工具内容，工具名必须从 Session 的 tool.called 事实里读。
  const toolNames = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool.called') toolNames.set(event.toolCallId, event.name);
  }

  let items: readonly OutputItem[] = [];
  let declarationTurnId: TurnId | undefined;
  const candidates: Candidate[] = [];
  const validations: CandidateValidation[] = [];
  const published: PublishedOutput[] = [];

  for (const event of events) {
    if (event.type !== 'tool.result' || event.result.status !== 'success') continue;
    const fact = readVideoOutputFact(toolNames.get(event.toolCallId), event.result.output);
    if (fact === null) continue;

    switch (fact.kind) {
      case DECLARATION_KIND:
        // 声明列表代表预期交付集合；后一次声明整体替换前一次。
        items = fact.items;
        declarationTurnId = event.turnId;
        break;
      case VALIDATION_KIND:
        candidates.push(fact.candidate);
        validations.push(fact.validation);
        break;
      case PUBLISH_KIND:
        published.push(fact.output);
        break;
    }
  }

  return { items, declarationTurnId, candidates, validations, published };
}

/** 某个候选所属的输出项；候选身份缺失时返回 undefined。 */
function outputItemIdOfCandidate(
  facts: VideoDeliveryFacts,
  candidateId: string,
): string | undefined {
  return facts.candidates.find((candidate) => candidate.id === candidateId)?.outputItemId;
}

/** 某个输出项当前候选的最近一次验收。 */
export function latestValidationForItem(
  facts: VideoDeliveryFacts,
  outputItemId: string,
): CandidateValidation | undefined {
  let latest: CandidateValidation | undefined;
  for (const validation of facts.validations) {
    if (outputItemIdOfCandidate(facts, validation.candidateId) === outputItemId) latest = validation;
  }
  return latest;
}

/** 某个候选的最近一次验收；发布只接受它。 */
export function latestValidationForCandidate(
  facts: VideoDeliveryFacts,
  candidateId: string,
): CandidateValidation | undefined {
  let latest: CandidateValidation | undefined;
  for (const validation of facts.validations) {
    if (validation.candidateId === candidateId) latest = validation;
  }
  return latest;
}

/** 逐项结果：总数来自声明列表，分类来自真实发布与验收事实。 */
export function projectOutputItemResults(facts: VideoDeliveryFacts): readonly OutputItemResult[] {
  return facts.items.map((item) => {
    const published = facts.published.find((output) => output.outputItemId === item.id);
    if (published !== undefined) {
      return { outputItemId: item.id, status: 'published', output: published };
    }

    const latest = latestValidationForItem(facts, item.id);
    if (latest === undefined) {
      return { outputItemId: item.id, status: 'incomplete', reason: '尚未进入候选验收。' };
    }

    // 展示时保留所有原因：不因存在一个不通过项就隐去其他证据缺口。
    const failed = latest.checks.filter((check) => check.outcome === 'failed');
    if (failed.length > 0) {
      return { outputItemId: item.id, status: 'failed', reason: failed.map((check) => check.detail).join('；') };
    }

    const blocked = latest.checks.filter((check) => check.outcome === 'blocked');
    if (blocked.length > 0) {
      return { outputItemId: item.id, status: 'blocked', reason: blocked.map((check) => check.detail).join('；') };
    }

    // 全部通过但还没有发布事实：交付没有发生，不能当成已交付。
    return { outputItemId: item.id, status: 'incomplete', reason: '候选已通过验收，但尚未发布。' };
  });
}
