import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import { InMemorySession, SessionPersistenceError, type Session } from '@agent-desktop/session';
import type {
  AgentActivityDetail,
  AgentActivityDirectoryEntry,
  AgentActivityFile,
  AgentActivityItem,
  AgentActivitySearchMatch,
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  AgentTaskResult,
  ClientConversation,
  ConversationContextUsage,
  ClientConversationMessage,
  ClientStateSnapshot,
  ClientSidebarState,
  Attachment,
  AttachmentRole,
  TerminalSnapshot,
  PermissionMode,
} from '@agent-desktop/client';
import { isTaskPlanEvidenceEvent, projectRecoveryAncestry, projectTurnState, type SessionEvent, type TaskPlanStep, type TurnId } from '@agent-desktop/session';
import { validateContextCompactedEvent } from '@agent-desktop/agent-loop';
import { projectAgentTaskState } from './agent-task-state.js';
import type { SubagentRecord } from './subagent.js';
import { parseTurnConfiguration } from './turn-configuration.js';
import type { FileArtifact } from '@agent-desktop/model';

export interface PersistedDesktopSession {
  readonly turnMessageBindings?: readonly TurnMessageBinding[];
  readonly terminalHistory?: TerminalSnapshot;
  readonly subagentHistory?: readonly SubagentRecord[];
  readonly id: string;
  readonly attachments: readonly PersistedAttachment[];
  /** 会话工作目录；旧快照没有这个字段时按「尚未确认目录」读取。 */
  readonly workingDirectory?: string;
  readonly permissionMode?: PermissionMode;
  readonly events: readonly SessionEvent[];
}

/** 仅宿主保存界面身份，不把消息 ID 或执行版本泄漏到通用 Session 事件。 */
export interface TurnMessageBinding {
  readonly executionVersion: 1;
  readonly turnId: TurnId;
  readonly userMessageId: number;
  readonly assistantMessageId: number;
}

/** 持久化的输入附件：路径是身份，角色决定提示词用途。 */
export interface PersistedAttachment {
  readonly path: string;
  readonly role: AttachmentRole;
}

/**
 * 桌面持久化状态。
 *
 * 旧快照里的 `outputSequence` 不再参与任何命名：新命名只依赖发布时的真实磁盘占用，
 * 因此读取时直接忽略该字段，不保留第二套「名字起点」事实。
 */
export interface PersistedDesktopState {
  readonly activeSessionId: string;
  readonly sessions: readonly PersistedDesktopSession[];
  readonly clientState: ClientStateSnapshot;
}

/**
 * Desktop 主进程使用的持久 Session。
 * 候选快照先提交 SQLite，成功后才更新内存事件；保存失败固定保留第一次错误，
 * 防止后续取消或默认状态覆盖真正的持久化故障。
 */
export class DesktopPersistentSession implements Session {
  private readonly memory: InMemorySession;
  private persistenceFailure: SessionPersistenceError | undefined;
  private readonly bindings: TurnMessageBinding[];

  constructor(
    private readonly filePath: string,
    private readonly sessionId: string,
    initialEvents: readonly SessionEvent[],
    private readonly stateForEvents: (sessionId: string, events: readonly SessionEvent[], bindings: readonly TurnMessageBinding[], clientState?: ClientStateSnapshot) => PersistedDesktopState,
    private readonly onPersistenceFailure: (error: SessionPersistenceError) => void,
    initialBindings: readonly TurnMessageBinding[] = [],
  ) { this.memory = new InMemorySession(initialEvents); this.bindings = [...initialBindings]; }

  append(event: SessionEvent): void { this.appendMany([event]); }

  appendMany(events: readonly SessionEvent[]): void {
    if (this.persistenceFailure !== undefined) throw this.persistenceFailure;
    const candidateEvents = [...this.memory.events(), ...events];
    try {
      writeDesktopDocuments(this.filePath, [{ name: 'session-state', value: this.stateForEvents(this.sessionId, candidateEvents, this.bindings) }]);
    } catch (cause) {
      const error = new SessionPersistenceError(cause);
      this.persistenceFailure = error;
      this.onPersistenceFailure(error);
      throw error;
    }
    this.memory.appendMany(events);
  }

  events(): readonly SessionEvent[] { return this.memory.events(); }

  turnMessageBindings(): readonly TurnMessageBinding[] { return this.bindings; }

  /** 事件、从草稿迁移后的展示和身份关联同次提交；事务失败不推进任何内存事实。 */
  commitStart(start: { readonly events: readonly SessionEvent[] }, clientState: ClientStateSnapshot, binding: TurnMessageBinding): void {
    if (this.persistenceFailure !== undefined) throw this.persistenceFailure;
    const events = [...this.memory.events(), ...start.events];
    const bindings = [...this.bindings, binding];
    try {
      writeDesktopDocuments(this.filePath, [{ name: 'session-state', value: this.stateForEvents(this.sessionId, events, bindings, clientState) }]);
    } catch (cause) {
      const error = new SessionPersistenceError(cause);
      this.persistenceFailure = error;
      this.onPersistenceFailure(error);
      throw error;
    }
    this.memory.appendMany(start.events);
    this.bindings.push(binding);
  }

  /** 宿主资源状态（终端退出等）变化时复用同一全快照提交入口。 */
  persist(): void {
    if (this.persistenceFailure !== undefined) throw this.persistenceFailure;
    try { writeDesktopDocuments(this.filePath, [{ name: 'session-state', value: this.stateForEvents(this.sessionId, this.memory.events(), this.bindings) }]); }
    catch (cause) {
      const error = new SessionPersistenceError(cause);
      this.persistenceFailure = error;
      this.onPersistenceFailure(error);
      throw error;
    }
  }
}

type SessionToolCall = Extract<SessionEvent, { type: 'assistant.message' }>['toolCalls'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new Error(`本地会话结构无效：${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid(field);
  return value;
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readString(item, `${field}[${index}]`));
}

/** 新事件的枚举来自磁盘 JSON，不能将未知状态转换为默认成功。 */
function readChoice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(field);
  return value as T;
}

function readEventIndexes(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readNonNegativeInteger(item, `${field}[${index}]`));
}

function readPlanSteps(value: unknown, field: string): readonly TaskPlanStep[] {
  if (!Array.isArray(value)) invalid(field);
  const steps = value.map((item, index): TaskPlanStep => {
    const stepField = `${field}[${index}]`;
    if (!isRecord(item)) invalid(stepField);
    const id = readString(item.id, `${stepField}.id`);
    const description = readString(item.description, `${stepField}.description`);
    if (!id.trim() || !description.trim()) invalid(stepField);
    return {
      id,
      description,
      requestedStatus: readChoice(item.requestedStatus, ['pending', 'in_progress', 'completed', 'failed', 'blocked'], `${stepField}.requestedStatus`),
      completionKind: readChoice(item.completionKind, ['tool', 'response'], `${stepField}.completionKind`),
      evidenceEventIndexes: readEventIndexes(item.evidenceEventIndexes, `${stepField}.evidenceEventIndexes`),
    };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) invalid(`${field}.id`);
  return steps;
}

/** 成功结果里的文件产物事实；字段缺失表示这次调用没有创建交付文件。 */
function readArtifacts(value: unknown, field: string): { readonly artifacts?: readonly FileArtifact[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) invalid(field);
  const artifacts = value.map((item, index): FileArtifact => {
    const itemField = `${field}[${index}]`;
    if (!isRecord(item)) invalid(itemField);
    return {
      id: readString(item.id, `${itemField}.id`),
      path: readString(item.path, `${itemField}.path`),
      mimeType: readString(item.mimeType, `${itemField}.mimeType`),
      size: readNonNegativeInteger(item.size, `${itemField}.size`),
      sha256: readString(item.sha256, `${itemField}.sha256`),
      createdAt: readString(item.createdAt, `${itemField}.createdAt`),
      sourceTool: readString(item.sourceTool, `${itemField}.sourceTool`),
    };
  });
  return artifacts.length === 0 ? {} : { artifacts };
}

function readToolCall(value: unknown, field: string): SessionToolCall {
  if (!isRecord(value)) invalid(field);
  const id = readString(value.id, `${field}.id`);
  const name = readString(value.name, `${field}.name`);
  if (!Object.hasOwn(value, 'input')) invalid(`${field}.input`);
  return { id, name, input: value.input } as SessionToolCall;
}

function readSessionEvent(value: unknown, field: string): SessionEvent {
  if (!isRecord(value)) invalid(field);
  const type = readString(value.type, `${field}.type`);
  const turnId = readString(value.turnId, `${field}.turnId`);

  switch (type) {
    case 'turn.configuration':
      return { type, turnId, data: parseTurnConfiguration(value.data) } as SessionEvent;
    case 'turn.started':
    case 'turn.completed':
      return { type, turnId } as SessionEvent;
    case 'turn.failed':
      return { type, turnId, errorName: readString(value.errorName, `${field}.errorName`),
        errorMessage: readString(value.errorMessage, `${field}.errorMessage`) } as SessionEvent;
    case 'turn.cancelled':
      return { type, turnId,
        reason: readChoice(value.reason, ['user', 'window-closed', 'external'], `${field}.reason`) } as SessionEvent;
    case 'turn.interrupted':
      return { type, turnId,
        reason: readChoice(value.reason, ['process-exit', 'legacy-unknown'], `${field}.reason`) } as SessionEvent;
    case 'turn.recovery.started':
      return { type, turnId, sourceTurnId: readString(value.sourceTurnId, `${field}.sourceTurnId`),
        mode: readChoice(value.mode, ['continue', 'verify'], `${field}.mode`) } as SessionEvent;
    case 'context.compacted': {
      const sourceDigest = readString(value.sourceDigest, `${field}.sourceDigest`);
      if (!/^[a-f0-9]{64}$/.test(sourceDigest)) invalid(`${field}.sourceDigest`);
      const summary = readString(value.summary, `${field}.summary`);
      if (!summary.trim()) invalid(`${field}.summary`);
      if (value.estimatorVersion !== 1) invalid(`${field}.estimatorVersion`);
      return { type, turnId, sourceDigest, summary, estimatorVersion: 1,
        coveredStepEndEventIndexes: readEventIndexes(value.coveredStepEndEventIndexes, `${field}.coveredStepEndEventIndexes`),
        ...(value.previousSummaryEventIndex === undefined ? {} : {
          previousSummaryEventIndex: readNonNegativeInteger(value.previousSummaryEventIndex, `${field}.previousSummaryEventIndex`) }),
        estimatedBefore: readNonNegativeInteger(value.estimatedBefore, `${field}.estimatedBefore`),
        estimatedAfter: readNonNegativeInteger(value.estimatedAfter, `${field}.estimatedAfter`) } as SessionEvent;
    }
    case 'plan.updated':
      return { type, turnId, revision: readNonNegativeInteger(value.revision, `${field}.revision`),
        explanation: readString(value.explanation, `${field}.explanation`),
        steps: readPlanSteps(value.steps, `${field}.steps`) } as SessionEvent;
    case 'tool.effect.prepared':
      if (!Object.hasOwn(value, 'data')) invalid(`${field}.data`);
      return { type, turnId, sourceEventIndex: readNonNegativeInteger(value.sourceEventIndex, `${field}.sourceEventIndex`),
        data: value.data } as SessionEvent;
    case 'host.operation.started':
      return { type, turnId, operation: readString(value.operation, `${field}.operation`),
        description: readString(value.description, `${field}.description`) } as SessionEvent;
    case 'host.operation.result':
      return { type, turnId, sourceEventIndex: readNonNegativeInteger(value.sourceEventIndex, `${field}.sourceEventIndex`),
        status: readChoice(value.status, ['completed', 'failed', 'cancelled'], `${field}.status`),
        ...(value.errorName === undefined ? {} : { errorName: readString(value.errorName, `${field}.errorName`) }),
        ...(value.errorMessage === undefined ? {} : { errorMessage: readString(value.errorMessage, `${field}.errorMessage`) }) } as SessionEvent;
    case 'effect.outcome.verified': {
      if (!isRecord(value.evidence)) invalid(`${field}.evidence`);
      const source = readChoice(value.evidence.source, ['tool', 'user', 'host'], `${field}.evidence.source`);
      const scope = readChoice(value.scope, ['file-effect', 'entire-call'], `${field}.scope`);
      const outcome = readChoice(value.outcome, ['completed', 'not-applied', 'unresolved'], `${field}.outcome`);
      // 宿主观察只报告未确认的整次调用；磁盘不能伪造宿主已证明效果完成。
      if (source === 'host' && (scope !== 'entire-call' || outcome !== 'unresolved')) invalid(`${field}.evidence.source`);
      return { type, turnId, sourceEventIndex: readNonNegativeInteger(value.sourceEventIndex, `${field}.sourceEventIndex`),
        scope, outcome, evidence: { source,
          reference: readString(value.evidence.reference, `${field}.evidence.reference`),
          description: readString(value.evidence.description, `${field}.evidence.description`) } } as SessionEvent;
    }
    case 'user.message':
      return {
        type,
        turnId,
        content: readString(value.content, `${field}.content`),
      } as unknown as SessionEvent;
    case 'step.started':
    case 'step.completed':
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
      } as SessionEvent;
    case 'assistant.message': {
      if (!Array.isArray(value.toolCalls)) invalid(`${field}.toolCalls`);
      const toolCalls = value.toolCalls.map((item, index) => (
        readToolCall(item, `${field}.toolCalls[${index}]`)
      ));
      const content = value.content;
      if (content !== undefined && typeof content !== 'string') invalid(`${field}.content`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        ...(content === undefined ? {} : { content }),
        toolCalls,
      } as unknown as SessionEvent;
    }
    case 'tool.called':
      if (!Object.hasOwn(value, 'input')) invalid(`${field}.input`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
        name: readString(value.name, `${field}.name`),
        input: value.input,
        ...(value.boundary === undefined ? {} : { boundary: readChoice(value.boundary,
          ['not-executed', 'read-only', 'checkpointed', 'opaque'], `${field}.boundary`) }),
      } as SessionEvent;
    case 'tool.interaction.closed': {
      if (value.reason !== 'cancelled' && value.reason !== 'window-closed') invalid(`${field}.reason`);
      return { type, turnId, stepId: readString(value.stepId, `${field}.stepId`),
        toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
        requestId: readString(value.requestId, `${field}.requestId`), reason: value.reason } as SessionEvent;
    }
    case 'tool.result': {
      if (!isRecord(value.result)) invalid(`${field}.result`);
      const status = readString(value.result.status, `${field}.result.status`);
      const result = status === 'success'
        ? {
            status,
            ...(Object.hasOwn(value.result, 'output') ? { output: value.result.output } : invalid(`${field}.result.output`)),
            // 产物事实随成功结果持久化：它是宿主登记产物的唯一权威来源，形状不对时直接失败。
            ...readArtifacts(value.result.artifacts, `${field}.result.artifacts`),
          }
        : status === 'error'
          ? {
              status,
              message: readString(value.result.message, `${field}.result.message`),
              ...(Object.hasOwn(value.result, 'output') ? { output: value.result.output } : {}),
              ...(value.result.failureKind === undefined ? {} : { failureKind: readChoice(value.result.failureKind,
                ['transient', 'permanent', 'denied', 'cancelled', 'unknown-outcome'], `${field}.result.failureKind`) }),
            }
          : invalid(`${field}.result.status`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
        result,
      } as SessionEvent;
    }
    default:
      return invalid(`${field}.type`);
  }
}

/** 索引只引用此前真实事件；未来/自身索引不能作为核验或压缩依据。 */
function priorEvent(events: readonly SessionEvent[], index: number, sourceIndex: number,
  types: readonly SessionEvent['type'][], field: string): SessionEvent {
  const source = events[sourceIndex];
  if (sourceIndex >= index || source === undefined || !types.includes(source.type)) invalid(field);
  return source;
}

/**
 * 磁盘是实际外部边界：新事件引用在解析时一次确认，旧残留事件仍原样保留。
 * 这里只检查来源身份/范围；工具业务资格和执行状态继续由 Session 的纯投影负责。
 */
function readSessionEvents(value: unknown, field: string): readonly SessionEvent[] {
  if (!Array.isArray(value)) invalid(field);
  const events = value.map((event, index) => readSessionEvent(event, `${field}[${index}]`));
  for (const [index, event] of events.entries()) {
    const eventField = `${field}[${index}]`;
    switch (event.type) {
      case 'turn.recovery.started': {
        // 关系只能指向此前已存在的轮次，天然排除自循环及未来恢复源。
        const priorEvents = events.slice(0, index);
        const sourceStartIndex = priorEvents.findIndex(source => source.type === 'turn.started' && source.turnId === event.sourceTurnId);
        const turnStartIndex = priorEvents.findIndex(source => source.type === 'turn.started' && source.turnId === event.turnId);
        if (sourceStartIndex < 0 || turnStartIndex < 0 || sourceStartIndex >= turnStartIndex
          || priorEvents.some(source => source.type === 'turn.recovery.started' && source.turnId === event.turnId)) {
          invalid(`${eventField}.sourceTurnId`);
        }
        break;
      }
      case 'tool.effect.prepared': {
        const source = priorEvent(events, index, event.sourceEventIndex, ['tool.called'], `${eventField}.sourceEventIndex`);
        if (source.turnId !== event.turnId
          || (source.type === 'tool.called' && (source.boundary === 'not-executed' || source.boundary === 'read-only'))) {
          invalid(`${eventField}.sourceEventIndex`);
        }
        break;
      }
      case 'host.operation.result': {
        const source = priorEvent(events, index, event.sourceEventIndex, ['host.operation.started'], `${eventField}.sourceEventIndex`);
        if (source.turnId !== event.turnId) invalid(`${eventField}.sourceEventIndex`);
        break;
      }
      case 'effect.outcome.verified': {
        const source = priorEvent(events, index, event.sourceEventIndex,
          ['tool.called', 'host.operation.started'], `${eventField}.sourceEventIndex`);
        // 核验可跨本会话轮次，但文件部分不能指向宿主阶段或从未执行的调用。
        if ((event.scope === 'file-effect' && source.type !== 'tool.called')
          || (source.type === 'tool.called' && source.boundary === 'not-executed')) invalid(`${eventField}.sourceEventIndex`);
        break;
      }
      case 'context.compacted': {
        // 来源、累计覆盖和摘要 JSON 与模型投影复用同一校验，不再维护第二套摘要算法。
        validateContextCompactedEvent(events.slice(0, index + 1), index);
        break;
      }
      case 'plan.updated': {
        // 后面的恢复关系尚未校验，不能反过来影响当前计划的来源归属。
        const priorEvents = events.slice(0, index);
        const root = projectRecoveryAncestry(priorEvents, event.turnId).rootTurnId;
        for (const [stepIndex, step] of event.steps.entries()) {
          for (const [offset, sourceIndex] of step.evidenceEventIndexes.entries()) {
            const sourceField = `${eventField}.steps[${stepIndex}].evidenceEventIndexes[${offset}]`;
            const source = events[sourceIndex];
            if (sourceIndex >= index || source === undefined || !isTaskPlanEvidenceEvent(source)) invalid(sourceField);
            if (projectRecoveryAncestry(priorEvents, source.turnId).rootTurnId !== root) invalid(sourceField);
          }
        }
        break;
      }
    }
  }
  return events;
}

function readToolActivity(value: unknown, field: string): AgentActivityItem {
  if (!isRecord(value)) invalid(field);
  const status = readString(value.status, `${field}.status`);
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') invalid(`${field}.status`);
  const durationMs = value.durationMs;
  if (durationMs !== undefined
    && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid(`${field}.durationMs`);
  }
  return {
    id: readString(value.toolCallId, `${field}.toolCallId`),
    kind: 'tool',
    status,
    toolName: readString(value.toolName, `${field}.toolName`),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function readActivityFile(value: unknown, field: string): AgentActivityFile {
  if (!isRecord(value)) invalid(field);
  const role = readString(value.role, `${field}.role`);
  if (role !== 'input' && role !== 'output') invalid(`${field}.role`);
  return {
    path: readString(value.path, `${field}.path`),
    label: readString(value.label, `${field}.label`),
    role,
  };
}

function readOptionalString(value: unknown, field: string): { readonly note?: string } {
  if (value === undefined) return {};
  return { note: readString(value, field) };
}

function readActivityDirectoryEntry(value: unknown, field: string): AgentActivityDirectoryEntry {
  if (!isRecord(value)) invalid(field);
  const type = readString(value.type, `${field}.type`);
  if (type !== 'file' && type !== 'directory') invalid(`${field}.type`);
  return {
    name: readString(value.name, `${field}.name`),
    path: readString(value.path, `${field}.path`),
    type,
  };
}

function readActivitySearchMatch(value: unknown, field: string): AgentActivitySearchMatch {
  if (!isRecord(value)) invalid(field);
  return {
    filePath: readString(value.filePath, `${field}.filePath`),
    lineNumber: readNonNegativeInteger(value.lineNumber, `${field}.lineNumber`),
    line: readString(value.line, `${field}.line`),
  };
}

/** 活动详情来自本机快照边界，按可辨识联合逐字段读取，拒绝半截或伪造的历史结果。 */
function readActivityDetail(value: unknown, field: string): AgentActivityDetail {
  if (!isRecord(value)) invalid(field);
  const kind = readString(value.kind, `${field}.kind`);
  switch (kind) {
    case 'subagents': {
      if (!Array.isArray(value.tasks)) invalid(`${field}.tasks`);
      return { kind, tasks: value.tasks.map((task, index) => {
        if (!isRecord(task)) invalid(`${field}.tasks[${index}]`);
        return { taskId: readString(task.taskId, field), title: readString(task.title, field),
          status: readString(task.status, field), summary: readString(task.summary, field) };
      }) };
    }
    case 'interaction':
      return { kind: 'interaction', question: readString(value.question, `${field}.question`), answer: readString(value.answer, `${field}.answer`) };
    case 'error':
      return { kind, message: readString(value.message, `${field}.message`) };
    case 'file-content':
      return {
        kind,
        filePath: readString(value.filePath, `${field}.filePath`),
        startLine: readNonNegativeInteger(value.startLine, `${field}.startLine`),
        endLine: readNonNegativeInteger(value.endLine, `${field}.endLine`),
        totalLines: readNonNegativeInteger(value.totalLines, `${field}.totalLines`),
        lines: readStringArray(value.lines, `${field}.lines`),
        ...readOptionalString(value.note, `${field}.note`),
      };
    case 'directory': {
      if (!Array.isArray(value.entries)) invalid(`${field}.entries`);
      return {
        kind,
        directory: readString(value.directory, `${field}.directory`),
        total: readNonNegativeInteger(value.total, `${field}.total`),
        entries: value.entries.map((entry, index) => (
          readActivityDirectoryEntry(entry, `${field}.entries[${index}]`)
        )),
        ...readOptionalString(value.note, `${field}.note`),
      };
    }
    case 'search': {
      if (!Array.isArray(value.matches)) invalid(`${field}.matches`);
      return {
        kind,
        directory: readString(value.directory, `${field}.directory`),
        pattern: readString(value.pattern, `${field}.pattern`),
        total: readNonNegativeInteger(value.total, `${field}.total`),
        matches: value.matches.map((match, index) => (
          readActivitySearchMatch(match, `${field}.matches[${index}]`)
        )),
        ...readOptionalString(value.note, `${field}.note`),
      };
    }
    case 'command-output':
      return {
        kind,
        command: readString(value.command, `${field}.command`),
        stdout: readString(value.stdout, `${field}.stdout`),
        stderr: readString(value.stderr, `${field}.stderr`),
        truncated: readBoolean(value.truncated, `${field}.truncated`),
        droppedBytes: readNonNegativeInteger(value.droppedBytes, `${field}.droppedBytes`),
      };
    case 'command': {
      const termination = readString(value.termination, `${field}.termination`);
      if (termination !== 'exited' && termination !== 'timed-out') invalid(`${field}.termination`);
      const exitCode = value.exitCode;
      if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
        invalid(`${field}.exitCode`);
      }
      return {
        kind,
        command: readString(value.command, `${field}.command`),
        workingDirectory: readString(value.workingDirectory, `${field}.workingDirectory`),
        exitCode,
        termination,
        stdout: readString(value.stdout, `${field}.stdout`),
        stderr: readString(value.stderr, `${field}.stderr`),
        truncated: readBoolean(value.truncated, `${field}.truncated`),
        droppedBytes: readNonNegativeInteger(value.droppedBytes, `${field}.droppedBytes`),
        ...readOptionalString(value.note, `${field}.note`),
      };
    }
    default:
      return invalid(`${field}.kind`);
  }
}

function readActivityItem(value: unknown, field: string): AgentActivityItem {
  if (!isRecord(value)) invalid(field);
  const kind = readString(value.kind, `${field}.kind`);
  if (kind !== 'analysis' && kind !== 'tool' && kind !== 'commentary') invalid(`${field}.kind`);
  const status = readString(value.status, `${field}.status`);
  if (status !== 'running' && status !== 'completed'
    && status !== 'failed' && status !== 'cancelled') {
    invalid(`${field}.status`);
  }

  const toolName = value.toolName;
  if (toolName !== undefined && typeof toolName !== 'string') invalid(`${field}.toolName`);
  const durationMs = value.durationMs;
  if (durationMs !== undefined
    && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid(`${field}.durationMs`);
  }
  const plannedToolCallCount = value.plannedToolCallCount;
  if (plannedToolCallCount !== undefined
    && (typeof plannedToolCallCount !== 'number'
      || !Number.isInteger(plannedToolCallCount) || plannedToolCallCount < 0)) {
    invalid(`${field}.plannedToolCallCount`);
  }
  const files = value.files;
  if (files !== undefined && !Array.isArray(files)) invalid(`${field}.files`);
  const detail = value.detail;

  return {
    id: readString(value.id, `${field}.id`),
    kind,
    status,
    ...(value.text === undefined ? {} : { text: readString(value.text, `${field}.text`) }),
    ...(value.retryNote === undefined ? {} : { retryNote: readString(value.retryNote, `${field}.retryNote`) }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(files === undefined
      ? {}
      : { files: files.map((item, index) => readActivityFile(item, `${field}.files[${index}]`)) }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(plannedToolCallCount === undefined ? {} : { plannedToolCallCount }),
    ...(detail === undefined ? {} : { detail: readActivityDetail(detail, `${field}.detail`) }),
  };
}

/**
 * 活动轨迹在 Commit 31 之前只保存工具活动（toolCallId/toolName/status/durationMs）。
 * 已有本机快照仍然原样恢复为 tool 活动，避免升级后拒绝启动；新快照只写 activity。
 */
function readLegacyActivity(value: unknown, field: string): readonly AgentActivityItem[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readToolActivity(item, `${field}[${index}]`));
}

function readActivity(value: unknown, field: string, legacyValue: unknown, legacyField: string): readonly AgentActivityItem[] {
  if (value === undefined) return readLegacyActivity(legacyValue, legacyField);
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readActivityItem(item, `${field}[${index}]`));
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function readOutputFile(value: unknown, field: string): AgentTaskOutputFile {
  if (!isRecord(value)) invalid(field);
  return {
    path: readString(value.path, `${field}.path`),
    fileName: readString(value.fileName, `${field}.fileName`),
  };
}

/** 可选产物列表：字段缺失或为空数组时都按「没有产物」表示，读回 undefined。 */
function readOptionalOutputFiles(
  value: unknown,
  field: string,
): readonly AgentTaskOutputFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(field);
  if (value.length === 0) return undefined;
  return value.map((item, index) => readOutputFile(item, `${field}[${index}]`));
}

/** 一个输出项的逐项交付结果；已交付项带真实路径，其余项带真实原因。 */
function readOutputItemResult(value: unknown, field: string): AgentTaskOutputItemResult {
  if (!isRecord(value)) invalid(field);
  const outputItemId = readString(value.outputItemId, `${field}.outputItemId`);
  const status = readString(value.status, `${field}.status`);
  if (status === 'published') {
    return {
      outputItemId,
      status,
      path: readString(value.path, `${field}.path`),
      fileName: readString(value.fileName, `${field}.fileName`),
    };
  }
  if (status !== 'failed' && status !== 'blocked' && status !== 'incomplete') invalid(`${field}.status`);
  return { outputItemId, status, reason: readString(value.reason, `${field}.reason`) };
}

/** 可选逐项结果列表：字段缺失或为空数组时按「视频交付不适用」读取。 */
function readOptionalOutputResults(
  value: unknown,
  field: string,
): readonly AgentTaskOutputItemResult[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(field);
  if (value.length === 0) return undefined;
  return value.map((item, index) => readOutputItemResult(item, `${field}[${index}]`));
}

/**
 * 旧版产物表：按文件名索引的 `Record<fileName, path>`，随会话保存。
 * 它保存了 Commit 35 之前唯一可用的产物关系，读取时要用来还原历史产物卡。
 */
function readLegacyOutputFilePaths(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) invalid(field);
  return Object.fromEntries(Object.entries(value).map(
    ([fileName, outputPath]) => [fileName, readString(outputPath, `${field}.${fileName}`)],
  ));
}

/**
 * 读取一轮任务结果。
 * 新快照直接带 `outputFiles`；旧快照只有 `outputFileName`，路径要从所属会话的产物表里查。
 * 查不到时按「本轮没有产物」处理：宁可少一张卡，也不编造一个不存在的路径。
 */
function readTaskResult(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
): AgentTaskResult {
  if (!isRecord(value)) invalid(field);
  const outputFiles = value.outputFiles;
  if (outputFiles !== undefined && !Array.isArray(outputFiles)) invalid(`${field}.outputFiles`);
  const outputs = readOptionalOutputResults(value.outputs, `${field}.outputs`);
  const titleFields = {
    ...(value.conversationTitle === undefined ? {} : { conversationTitle: readString(value.conversationTitle, `${field}.conversationTitle`) }),
    ...(value.conversationTitleError === undefined ? {} : { conversationTitleError: readString(value.conversationTitleError, `${field}.conversationTitleError`) }),
  };
  if (outputFiles !== undefined) {
    return {
      responseText: readString(value.responseText, `${field}.responseText`),
      traceId: readString(value.traceId, `${field}.traceId`),
      ...titleFields,
      ...(outputFiles.length === 0 ? {} : {
        outputFiles: outputFiles.map((item, index) => readOutputFile(item, `${field}.outputFiles[${index}]`)),
      }),
      ...(outputs === undefined ? {} : { outputs }),
    };
  }

  const base = {
    responseText: readString(value.responseText, `${field}.responseText`),
    traceId: readString(value.traceId, `${field}.traceId`),
    ...titleFields,
    ...(outputs === undefined ? {} : { outputs }),
  };
  const outputFileName = value.outputFileName;
  if (outputFileName === undefined) return base;
  if (typeof outputFileName !== 'string') invalid(`${field}.outputFileName`);

  const path = legacyOutputFilePaths[outputFileName];
  if (path === undefined) return base;
  return { ...base, outputFiles: [{ path, fileName: outputFileName }] };
}

function readClientMessage(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
  events: readonly SessionEvent[],
  bindings: readonly TurnMessageBinding[],
): ClientConversationMessage {
  if (!isRecord(value)) invalid(field);
  const id = readNonNegativeInteger(value.id, `${field}.id`);
  const role = readString(value.role, `${field}.role`);
  if (role === 'user') {
    const attachments = readStringArray(value.attachments, `${field}.attachments`);
    const attachmentRoles = value.attachmentRoles;
    if (attachmentRoles !== undefined && !Array.isArray(attachmentRoles)) {
      invalid(`${field}.attachmentRoles`);
    }
    const parsedRoles = attachmentRoles?.map((item, index) => (
      readAttachmentRole(item, `${field}.attachmentRoles[${index}]`)
    ));
    if (parsedRoles !== undefined && parsedRoles.length !== attachments.length) {
      invalid(`${field}.attachmentRoles`);
    }
    return {
      id,
      role,
      text: readString(value.text, `${field}.text`),
      attachments,
      ...(parsedRoles === undefined ? {} : { attachmentRoles: parsedRoles }),
    };
  }
  if (role !== 'assistant') invalid(`${field}.role`);
  // UI 快照只携带关联提示；显示状态与完成证据必须从 Main 的原始事实重建。
  let taskState;
  const binding = bindings.find(item => item.assistantMessageId === id);
  if (binding !== undefined) {
    taskState = projectAgentTaskState(events, binding.turnId);
  } else if (value.taskState !== undefined) {
    if (!isRecord(value.taskState) || typeof value.taskState.latestTurnId !== 'string') invalid(`${field}.taskState`);
    const turnId = value.taskState.latestTurnId as TurnId;
    if (projectTurnState(events, turnId) === undefined) invalid(`${field}.taskState.latestTurnId`);
    taskState = projectAgentTaskState(events, turnId);
  }
  if (binding === undefined && value.task !== undefined) {
    if (!isRecord(value.task)) invalid(`${field}.task`);
    const turnId = readString(value.task.turnId, `${field}.task.turnId`) as TurnId;
    if (projectTurnState(events, turnId) === undefined) invalid(`${field}.task.turnId`);
    taskState = projectAgentTaskState(events, turnId);
  }
  const base = {
    id,
    role,
    ...(taskState === undefined ? {} : { taskState }),
    activity: readActivity(value.activity, `${field}.activity`, value.tools, `${field}.tools`),
    activityExpanded: value.activityExpanded === undefined
      ? readBoolean(value.toolsExpanded, `${field}.toolsExpanded`)
      : readBoolean(value.activityExpanded, `${field}.activityExpanded`),
  } as const;
  const status = readString(value.status, `${field}.status`);
  if (status === 'processing' && binding !== undefined) {
    // 起点快照保留正在执行的身份；流式增量从不落盘，重启再由宿主终态投影。
    return { ...base, status, streamedText: '' };
  }
  if (status === 'completed') {
    return {
      ...base,
      status,
      result: readTaskResult(value.result, `${field}.result`, legacyOutputFilePaths),
    };
  }
  // 失败与取消分支可以带已成功的产物与逐项交付结果；字段缺失表示本轮没有产出。
  const outputFiles = readOptionalOutputFiles(value.outputFiles, `${field}.outputFiles`);
  const outputs = readOptionalOutputResults(value.outputs, `${field}.outputs`);
  if (status === 'failed') {
    return {
      ...base,
      status,
      errorMessage: readString(value.errorMessage, `${field}.errorMessage`),
      ...(outputFiles === undefined ? {} : { outputFiles }),
      ...(outputs === undefined ? {} : { outputs }),
    };
  }
  if (status === 'cancelled') {
    return {
      ...base,
      status,
      ...(outputFiles === undefined ? {} : { outputFiles }),
      ...(outputs === undefined ? {} : { outputs }),
    };
  }
  return invalid(`${field}.status`);
}

/**
 * 会话的输入附件展示状态。
 * 新格式带 path 与 role；旧快照只有 selectedVideos（那时唯一的附件语义就是视频），
 * 没有可还原的路径，因此用空 path 表示「只有名称可展示」，不编造一个磁盘位置。
 */
function readClientAttachments(value: Record<string, unknown>, field: string): readonly Attachment[] {
  const attachments = value.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) invalid(`${field}.attachments`);
    return attachments.map((item, index) => {
      if (!isRecord(item)) invalid(`${field}.attachments[${index}]`);
      return {
        path: readString(item.path, `${field}.attachments[${index}].path`),
        name: readString(item.name, `${field}.attachments[${index}].name`),
        role: readAttachmentRole(item.role, `${field}.attachments[${index}].role`),
      };
    });
  }

  const legacyVideos = value.selectedVideos;
  if (!Array.isArray(legacyVideos)) return [];
  return legacyVideos.map((item, index) => {
    if (!isRecord(item)) invalid(`${field}.selectedVideos[${index}]`);
    return {
      path: '',
      name: readString(item.name, `${field}.selectedVideos[${index}].name`),
      role: 'video' as const,
    };
  });
}

/** 权限方式来自 IPC 或磁盘，只接受当前三种真实行为。 */
export function parsePermissionMode(value: unknown, field = 'permissionMode'): PermissionMode {
  if (value !== 'ask' && value !== 'auto-review' && value !== 'full-access') invalid(field);
  return value;
}

/** 用量是可恢复的展示副本，只读取模型身份和本次请求的真实计数。 */
function readContextUsage(value: unknown, field: string): ConversationContextUsage {
  if (!isRecord(value) || !isRecord(value.model)) invalid(field);
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) invalid(`${field}.inputTokens`);
  if (typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) invalid(`${field}.outputTokens`);
  return {
    model: { providerId: readString(value.model.providerId, `${field}.model.providerId`),
      modelId: readString(value.model.modelId, `${field}.model.modelId`) },
    inputTokens,
    outputTokens,
  };
}

function readClientConversation(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
  events: readonly SessionEvent[],
  bindings: readonly TurnMessageBinding[] = [],
): ClientConversation {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.messages)) invalid(`${field}.messages`);
  // 界面副本里的工作目录只是展示值；权威事实在会话侧，恢复时按会话事实重建。
  const workingDirectory = value.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
    invalid(`${field}.workingDirectory`);
  }
  return {
    ...(value.projectId === undefined ? {} : { projectId: readString(value.projectId, `${field}.projectId`) }),
    ...(value.pinned === undefined ? {} : { pinned: readBoolean(value.pinned, `${field}.pinned`) }),
    ...(value.archived === undefined ? {} : { archived: readBoolean(value.archived, `${field}.archived`) }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: readNonNegativeInteger(value.updatedAt, `${field}.updatedAt`) }),
    id: readString(value.id, `${field}.id`),
    title: readString(value.title, `${field}.title`),
    titleManuallyRenamed: value.titleManuallyRenamed === undefined
      ? false
      : typeof value.titleManuallyRenamed === 'boolean'
        ? value.titleManuallyRenamed
        : invalid(`${field}.titleManuallyRenamed`),
    messages: value.messages.map((item, index) => (
      readClientMessage(item, `${field}.messages[${index}]`, legacyOutputFilePaths, events, bindings)
    )),
    prompt: readString(value.prompt, `${field}.prompt`),
    attachments: readClientAttachments(value, field),
    ...(value.terminalHistory === undefined ? {} : { terminalHistory: readTerminalHistory(value.terminalHistory, field) }),
    ...(value.contextUsage === undefined ? {} : { contextUsage: readContextUsage(value.contextUsage, `${field}.contextUsage`) }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(value.permissionMode === undefined ? {} : { permissionMode: parsePermissionMode(value.permissionMode, `${field}.permissionMode`) }),
  };
}

/**
 * IPC 与磁盘都属于外部边界，进入应用状态前只校验当前真实使用的字段。
 * 传入按会话查询旧产物表的函数：旧快照的产物路径存在会话侧，客户端消息只记文件名。
 */
/** 只解析实际使用的侧栏字段；项目归属与会话工作目录是独立事实。 */
function readSidebar(value: unknown): ClientSidebarState {
  if (!isRecord(value) || !Array.isArray(value.projects)) invalid('clientState.sidebar');
  const projects = value.projects.map((project, index) => {
    const field = `clientState.sidebar.projects[${index}]`;
    if (!isRecord(project)) invalid(field);
    return {
      id: readString(project.id, `${field}.id`),
      name: readString(project.name, `${field}.name`),
      directory: readString(project.directory, `${field}.directory`),
      pinned: readBoolean(project.pinned, `${field}.pinned`),
      collapsed: readBoolean(project.collapsed, `${field}.collapsed`),
    };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) invalid('clientState.sidebar.projects.id');
  return { projects,
    projectsCollapsed: readBoolean(value.projectsCollapsed, 'clientState.sidebar.projectsCollapsed'),
    recentCollapsed: readBoolean(value.recentCollapsed, 'clientState.sidebar.recentCollapsed'),
    grouped: readBoolean(value.grouped, 'clientState.sidebar.grouped'),
  };
}

export function parseClientState(
  value: unknown,
  legacyOutputFilePathsFor: (sessionId: string) => Readonly<Record<string, string>> = () => ({}),
  eventsFor: (sessionId: string) => readonly SessionEvent[] = () => [],
  bindingsFor: (sessionId: string) => readonly TurnMessageBinding[] = () => [],
): ClientStateSnapshot {
  if (!isRecord(value)) invalid('clientState');
  if (!Array.isArray(value.conversations)) {
    invalid('clientState.conversations');
  }
  const conversations = value.conversations.map((item, index) => (
    readClientConversation(
      item,
      `clientState.conversations[${index}]`,
      isRecord(item) && typeof item.id === 'string' ? legacyOutputFilePathsFor(item.id) : {},
      isRecord(item) && typeof item.id === 'string' ? eventsFor(item.id) : [],
      isRecord(item) && typeof item.id === 'string' ? bindingsFor(item.id) : [],
    )
  ));
  if (value.drafts !== undefined && !Array.isArray(value.drafts)) invalid('clientState.drafts');
  const drafts = value.drafts === undefined ? [] : (value.drafts as unknown[]).map((item, index) => (
    readClientConversation(item, `clientState.drafts[${index}]`, {}, [])
  ));
  if (drafts.some(draft => draft.messages.length > 0 || draft.archived || draft.pinned || draft.titleManuallyRenamed)) invalid('clientState.drafts');
  const allConversations = [...conversations, ...drafts];
  if (new Set(allConversations.map(item => item.id)).size !== allConversations.length) invalid('clientState.conversations.id');
  const activeSessionId = readString(value.activeSessionId, 'clientState.activeSessionId');
  if (!allConversations.some((conversation) => conversation.id === activeSessionId)) {
    invalid('clientState.activeSessionId');
  }
  const sidebar = value.sidebar === undefined ? undefined : readSidebar(value.sidebar);
  if (allConversations.some(conversation => conversation.projectId !== undefined
    && !sidebar?.projects.some(project => project.id === conversation.projectId))) invalid('clientState.conversations.projectId');
  return { conversations, ...(value.drafts === undefined ? {} : { drafts }), activeSessionId, ...(sidebar === undefined ? {} : { sidebar }) };
}

function readAttachmentRole(value: unknown, field: string): AttachmentRole {
  const role = readString(value, field);
  if (role !== 'video' && role !== 'audio') invalid(field);
  return role;
}

/**
 * 会话输入附件。
 * 新格式直接带 role；Commit 37 之前的快照只有 selectedVideoPaths，那时唯一的附件语义就是视频，
 * 因此全部按 video 换算。两者都不存在时按空附件读取。
 */
function readAttachments(value: Record<string, unknown>, field: string): readonly PersistedAttachment[] {
  const attachments = value.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) invalid(`${field}.attachments`);
    return attachments.map((item, index) => {
      if (!isRecord(item)) invalid(`${field}.attachments[${index}]`);
      return {
        path: readString(item.path, `${field}.attachments[${index}].path`),
        role: readAttachmentRole(item.role, `${field}.attachments[${index}].role`),
      };
    });
  }

  const legacyVideoPaths = value.selectedVideoPaths;
  if (legacyVideoPaths === undefined) return [];
  return readStringArray(legacyVideoPaths, `${field}.selectedVideoPaths`)
    .map((path) => ({ path, role: 'video' as const }));
}

function parseDesktopSession(
  value: unknown,
  field: string,
): { readonly session: PersistedDesktopSession; readonly legacyOutputFilePaths: Readonly<Record<string, string>> } {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.events)) invalid(`${field}.events`);
  const workingDirectory = value.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
    invalid(`${field}.workingDirectory`);
  }
  const events = readSessionEvents(value.events, `${field}.events`);
  let turnMessageBindings: readonly TurnMessageBinding[] | undefined;
  if (value.turnMessageBindings !== undefined) {
    if (!Array.isArray(value.turnMessageBindings)) invalid(`${field}.turnMessageBindings`);
    turnMessageBindings = value.turnMessageBindings.map((item, index) => {
      const bindingField = `${field}.turnMessageBindings[${index}]`;
      if (!isRecord(item) || item.executionVersion !== 1) invalid(bindingField);
      const turnId = readString(item.turnId, `${bindingField}.turnId`) as TurnId;
      if (!events.some(event => event.type === 'turn.started' && event.turnId === turnId)
        || !events.some(event => event.type === 'user.message' && event.turnId === turnId)) invalid(`${bindingField}.turnId`);
      return { executionVersion: 1 as const, turnId,
        userMessageId: readNonNegativeInteger(item.userMessageId, `${bindingField}.userMessageId`),
        assistantMessageId: readNonNegativeInteger(item.assistantMessageId, `${bindingField}.assistantMessageId`) };
    });
    const messageIds = turnMessageBindings.flatMap(item => [item.userMessageId, item.assistantMessageId]);
    if (new Set(turnMessageBindings.map(item => item.turnId)).size !== turnMessageBindings.length
      || new Set(messageIds).size !== messageIds.length) invalid(`${field}.turnMessageBindings`);
  }
  return {
    session: {
      id: readString(value.id, `${field}.id`),
      attachments: readAttachments(value, field),
      ...(value.terminalHistory === undefined ? {} : { terminalHistory: readTerminalHistory(value.terminalHistory, field) }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(value.permissionMode === undefined ? {} : { permissionMode: parsePermissionMode(value.permissionMode, `${field}.permissionMode`) }),
      events,
      ...(turnMessageBindings === undefined ? {} : { turnMessageBindings }),
      ...(value.subagentHistory === undefined ? {} : { subagentHistory: readSubagentHistory(value.subagentHistory, `${field}.subagentHistory`) }),
    },
    // 旧快照带按文件名索引的产物表；新快照没有，用空表表示「没有可还原的旧关联」。
    legacyOutputFilePaths: value.outputFilePaths === undefined
      ? {}
      : readLegacyOutputFilePaths(value.outputFilePaths, `${field}.outputFilePaths`),
  };
}

function readSubagentHistory(value: unknown, field: string): readonly SubagentRecord[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((record) => {
    if (!isRecord(record) || !Array.isArray(record.events) || !isRecord(record.result)) invalid(field);
    const result = record.result;
    if (!['completed', 'failed', 'cancelled', 'budget-exhausted'].includes(String(result.status))) invalid(field);
    return { parentToolCallId: readString(record.parentToolCallId, field),
      events: readSessionEvents(record.events, `${field}.events`),
      result: { taskId: readString(result.taskId, field), title: readString(result.title, field),
        status: result.status as SubagentRecord['result']['status'], summary: readString(result.summary, field),
        evidence: readStringArray(result.evidence, field) } };
  });
}

function readTerminalHistory(value: unknown, field: string): TerminalSnapshot {
  if (!isRecord(value) || !['running', 'exited', 'disconnected'].includes(String(value.status))) invalid(`${field}.terminalHistory`);
  if (value.exitCode !== null && (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode))) invalid(`${field}.exitCode`);
  const output = readString(value.output, field);
  if (Buffer.byteLength(output, 'utf8') > 66 * 1024) invalid(`${field}.output`);
  return { terminalId: readString(value.terminalId, field), workingDirectory: readString(value.workingDirectory, field),
    command: readString(value.command, field), output, status: value.status as TerminalSnapshot['status'], exitCode: value.exitCode,
    droppedBytes: readNonNegativeInteger(value.droppedBytes, field) };
}

export function parseDesktopState(value: unknown): PersistedDesktopState {
  if (!isRecord(value)) invalid('root');
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) invalid('sessions');
  const parsedSessions = value.sessions.map((item, index) => parseDesktopSession(item, `sessions[${index}]`));
  const sessions = parsedSessions.map((parsed) => parsed.session);
  const sessionIds = sessions.map((session) => session.id);
  if (new Set(sessionIds).size !== sessionIds.length) invalid('sessions.id');

  const activeSessionId = readString(value.activeSessionId, 'activeSessionId');
  // 会话先于 Client 状态解析：旧快照把产物路径存在会话的产物表里，客户端消息要用它还原历史产物卡。
  const legacyOutputFilePathsBySession = new Map(
    parsedSessions.map((parsed) => [parsed.session.id, parsed.legacyOutputFilePaths]),
  );
  const clientState = parseClientState(
    value.clientState,
    (sessionId) => legacyOutputFilePathsBySession.get(sessionId) ?? {},
    (sessionId) => sessions.find(session => session.id === sessionId)?.events ?? [],
    (sessionId) => sessions.find(session => session.id === sessionId)?.turnMessageBindings ?? [],
  );
  const clientSessionIds = [...clientState.conversations, ...clientState.drafts ?? []].map((conversation) => conversation.id);
  if (!sessionIds.includes(activeSessionId)
    || clientState.activeSessionId !== activeSessionId
    || clientSessionIds.length !== sessionIds.length
    || clientSessionIds.some((id) => !sessionIds.includes(id))) {
    invalid('activeSessionId');
  }

  // 持久化文件中的绑定只接受同一正式会话里的确切消息身份；草稿没有已提交任务。
  for (const session of sessions) {
    const conversation = clientState.conversations.find(item => item.id === session.id);
    for (const binding of session.turnMessageBindings ?? []) {
      const messages = conversation?.messages ?? [];
      const userIndex = messages.findIndex(item => item.id === binding.userMessageId && item.role === 'user');
      const assistant = messages[userIndex + 1];
      if (userIndex < 0 || assistant?.id !== binding.assistantMessageId || assistant.role !== 'assistant'
        || messages.filter(item => item.id === binding.userMessageId || item.id === binding.assistantMessageId).length !== 2) {
        invalid(`sessions.${session.id}.turnMessageBindings`);
      }
    }
  }

  return { activeSessionId, sessions, clientState };
}

export async function loadDesktopState(filePath: string): Promise<PersistedDesktopState | null> {
  const value = readDesktopDocument(filePath, 'session-state');
  if (value === null) return null;
  // 磁盘历史是 append-only 事实：恢复原样读入全部事件，未完成 Step 只在重建 Model Context 时由 Session 的权威规则排除。
  return parseDesktopState(value);
}

/** SQLite 事务替代临时文件覆盖，成功提交后才更新持久化状态。 */
export async function saveDesktopState(
  filePath: string,
  state: PersistedDesktopState,
): Promise<void> {
  writeDesktopDocuments(filePath, [{ name: 'session-state', value: state }]);
}
