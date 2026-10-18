import type { Agent } from '@agent-desktop/agent';
import {
  projectRecoveryAncestry, projectTurnState, SessionPersistenceError, TurnCancellationError,
  type RecoveryMode, type Session, type SessionEvent, type TurnCancellationReason, type TurnId, type TurnState,
} from '@agent-desktop/session';
import { prepareTurnStart, runStartedTurn, type RunTurnOptions, type RunTurnResult } from './loop.js';

export type PreparedTurnStart = ReturnType<typeof prepareTurnStart>;
export type AgentRuntimePhase = 'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input';
export interface AgentRuntimeState {
  readonly phase: AgentRuntimePhase;
  readonly turnId?: TurnId;
  /** 终态直接从 Session 投影；不保存另一份会与执行事实漂移的状态。 */
  readonly turnState?: TurnState;
}
export type AgentRuntimeEvent =
  | { readonly type: 'runtime.state'; readonly state: AgentRuntimeState }
  | { readonly type: 'session.events'; readonly startIndex: number; readonly events: readonly SessionEvent[] };

/** 宿主准备与收尾共用同一取消信号，只有 run 进入正式的模型/工具循环。 */
export interface RuntimeTurnContext {
  readonly turnId: TurnId;
  readonly signal: AbortSignal;
  run(agent: Agent, options?: Omit<RunTurnOptions, 'signal'>): Promise<RunTurnResult>;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  phase: Exclude<AgentRuntimePhase, 'idle'>;
}

/**
 * 每个实例只控制一个 Session 的活动轮次。
 * 模型/工具算法仍归 Loop，宿主只在 operation 内组装依赖并执行准备和收尾。
 */
export class AgentRuntime {
  private active: ActiveTurn | undefined;
  private latestTurnId: TurnId | undefined;
  private publishedEventCount: number;
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();

  constructor(readonly session: Session) {
    this.publishedEventCount = session.events().length;
    this.latestTurnId = session.events().findLast(event => event.type === 'turn.started')?.turnId;
  }

  events(): readonly SessionEvent[] { return this.session.events(); }

  state(): AgentRuntimeState {
    const turnId = this.active?.turnId ?? this.latestTurnId;
    const turnState = turnId === undefined ? undefined : projectTurnState(this.events(), turnId);
    return { phase: this.active?.phase ?? 'idle', ...(turnId === undefined ? {} : { turnId }),
      ...(turnState === undefined ? {} : { turnState }) };
  }

  /** 关闭窗口等待整个宿主阶段结束，而不是只等待模型循环返回。 */
  get finished(): Promise<void> { return this.active?.finished ?? Promise.resolve(); }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  cancelTurn(reason: TurnCancellationReason | Error = 'user'): boolean {
    if (this.active === undefined) return false;
    this.active.controller.abort(typeof reason === 'string' ? new TurnCancellationError(reason) : reason);
    return true;
  }

  /** 宿主交互端口声明等待原因；等待结束后恢复原准备/执行阶段。 */
  async withWaiting<T>(phase: 'waiting_for_approval' | 'waiting_for_input', operation: () => Promise<T>): Promise<T> {
    const active = this.active;
    if (active === undefined) throw new Error('当前会话没有正在执行的任务。');
    const previous = active.phase;
    active.phase = phase;
    this.publish();
    try { return await operation(); }
    finally {
      active.phase = previous;
      this.publish();
    }
  }

  submitUserMessage(agent: Agent, input: string, options: RunTurnOptions = {}): Promise<RunTurnResult> {
    return this.startPreparedTurn(prepareTurnStart(input), context => context.run(agent, options), undefined, options.signal);
  }

  /** 恢复创建有明确来源的后继轮次；不重新调用旧轮次的任何工具。 */
  resumeTurn(agent: Agent, input: string, recovery: { readonly sourceTurnId: TurnId; readonly mode: RecoveryMode },
    options: RunTurnOptions = {}): Promise<RunTurnResult> {
    const sourceState = projectTurnState(this.events(), recovery.sourceTurnId);
    if (sourceState === undefined || sourceState === 'started'
      || projectRecoveryAncestry(this.events(), recovery.sourceTurnId).latestTurnId !== recovery.sourceTurnId) {
      return Promise.reject(new Error('只能恢复本会话中已经结束且没有后继的任务。'));
    }
    return this.startPreparedTurn(prepareTurnStart(input, recovery), context => context.run(agent, options), undefined, options.signal);
  }

  /**
   * 同步占有活动槽位并提交起点后才调用 operation。
   * Desktop 的 commitStart 可在一个 SQLite 事务中同时保存起点、消息绑定和展示快照。
   */
  async startPreparedTurn<T>(start: PreparedTurnStart, operation: (context: RuntimeTurnContext) => Promise<T>,
    commitStart: (start: PreparedTurnStart) => void = prepared => this.session.appendMany(prepared.events),
    parentSignal?: AbortSignal): Promise<T> {
    if (this.active !== undefined) throw new Error('当前会话已有任务正在执行。');
    let markFinished!: () => void;
    const active: ActiveTurn = { turnId: start.turnId, controller: new AbortController(), phase: 'starting',
      finished: new Promise<void>(resolve => { markFinished = resolve; }) };
    this.active = active;
    // 子任务/CLI 的父信号只转发到本轮 controller；收尾时解绑，不保留跨轮监听。
    const abortFromParent = () => { active.controller.abort(parentSignal!.reason); };
    if (parentSignal?.aborted === true) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    let committed = false;
    let loopStarted = false;
    try {
      commitStart(start);
      committed = true;
      this.latestTurnId = start.turnId;
      this.publish();
      const result = await operation({ turnId: start.turnId, signal: active.controller.signal,
        run: async (agent, options = {}) => {
          if (agent.session !== this.session) throw new Error('Agent 必须使用当前 Runtime 的同一个 Session。');
          if (loopStarted) throw new Error('同一个已提交轮次只能执行一次。');
          loopStarted = true;
          active.phase = 'running';
          this.publish();
          return runStartedTurn(agent, start.turnId, { ...options, signal: active.controller.signal,
            trace: async event => {
              this.publish();
              await options.trace?.(event);
            },
            onToolResult: async (...args) => {
              this.publish();
              await options.onToolResult?.(...args);
            },
          });
        },
      });
      if (!loopStarted && projectTurnState(this.events(), start.turnId) === 'started') {
        throw new Error('任务准备结束后没有进入执行循环。');
      }
      return result;
    } catch (error) {
      // 保存失败不能再制造终态；已完成 Loop 的宿主失败也不能改写原完成事实。
      if (active.controller.signal.reason instanceof SessionPersistenceError) throw active.controller.signal.reason;
      if (!(error instanceof SessionPersistenceError) && error instanceof Error && committed
        && projectTurnState(this.events(), start.turnId) === 'started') {
        this.session.append(error.name === 'AbortError'
          ? { type: 'turn.cancelled', turnId: start.turnId,
            reason: active.controller.signal.reason instanceof TurnCancellationError ? active.controller.signal.reason.reason
              : error instanceof TurnCancellationError ? error.reason : 'external' }
          : { type: 'turn.failed', turnId: start.turnId, errorName: error.name, errorMessage: error.message });
      }
      throw error;
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      this.active = undefined;
      markFinished();
      this.publish();
    }
  }

  private publish(): void {
    const events = this.events();
    if (events.length > this.publishedEventCount) {
      const event: AgentRuntimeEvent = { type: 'session.events', startIndex: this.publishedEventCount,
        events: events.slice(this.publishedEventCount) };
      this.publishedEventCount = events.length;
      for (const listener of this.listeners) listener(event);
    }
    const event: AgentRuntimeEvent = { type: 'runtime.state', state: this.state() };
    for (const listener of this.listeners) listener(event);
  }
}
