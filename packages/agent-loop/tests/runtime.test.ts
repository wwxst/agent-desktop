import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import type { Model } from '@agent-desktop/model';
import { InMemorySession, SessionPersistenceError, type SessionEvent } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { AgentRuntime, prepareTurnStart, type AgentRuntimeEvent } from '../src/index.js';

function fixture(complete: Model['complete'] = async () => ({ text: '完成', toolCalls: [] })) {
  const session = new InMemorySession();
  const agent: Agent = { session, model: { complete }, tools: new InMemoryToolRegistry(), systemPrompt: { build: () => 'test' } };
  return { session, agent, runtime: new AgentRuntime(session) };
}

describe('AgentRuntime', () => {
  it('commits the host start before preparation and holds exclusivity through host cleanup', async () => {
    const { runtime, agent, session } = fixture();
    const observed: string[] = [];
    const start = prepareTurnStart('工作');
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const task = runtime.startPreparedTurn(start, async context => {
      observed.push('prepare');
      expect(runtime.state()).toMatchObject({ phase: 'starting', turnState: 'started' });
      const result = await context.run(agent);
      observed.push('cleanup');
      await cleanup;
      return result;
    }, prepared => {
      observed.push('commit');
      session.appendMany(prepared.events);
    });
    const finished = vi.fn();
    void runtime.finished.then(finished);
    await vi.waitFor(() => expect(observed).toEqual(['commit', 'prepare', 'cleanup']));
    expect(finished).not.toHaveBeenCalled();
    await expect(runtime.submitUserMessage(agent, '第二轮')).rejects.toThrow('已有任务');
    expect(session.events().filter(event => event.type === 'user.message')).toHaveLength(1);
    releaseCleanup();
    const result = await task;
    await runtime.finished;
    expect(finished).toHaveBeenCalledOnce();
    expect(runtime.state()).toEqual({ phase: 'idle', turnId: result.turnId, turnState: 'completed' });
  });

  it('does not prepare or create a failed fact when the atomic start cannot be persisted', async () => {
    const { runtime, session } = fixture();
    const prepare = vi.fn();
    const failure = new SessionPersistenceError(new Error('disk full'));
    await expect(runtime.startPreparedTurn(prepareTurnStart('工作'), prepare, () => { throw failure; })).rejects.toBe(failure);
    expect(prepare).not.toHaveBeenCalled();
    expect(session.events()).toEqual([]);
    expect(runtime.state().phase).toBe('idle');
  });

  it('owns cancellation during preparation and records its actual reason', async () => {
    const { runtime, session, agent } = fixture();
    const task = runtime.startPreparedTurn(prepareTurnStart('准备'), async context => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
      return context.run(agent);
    });
    expect(runtime.cancelTurn('window-closed')).toBe(true);
    await expect(task).rejects.toMatchObject({ name: 'AbortError', reason: 'window-closed' });
    expect(session.events().at(-1)).toMatchObject({ type: 'turn.cancelled', reason: 'window-closed' });
    expect(runtime.cancelTurn()).toBe(false);
  });

  it('forwards its same cancellation signal to the model and stops the Loop', async () => {
    let receivedSignal: AbortSignal | undefined;
    const complete = vi.fn<Model['complete']>(async request => {
      receivedSignal = request.signal;
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      });
    });
    const { runtime, agent } = fixture(complete);
    const task = runtime.submitUserMessage(agent, '工作');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    runtime.cancelTurn('user');
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(runtime.state()).toMatchObject({ phase: 'idle', turnState: 'cancelled' });
  });

  it('inherits a parent cancellation and removes its listener when the Turn ends', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { runtime, agent } = fixture(async request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
    }));
    const task = runtime.submitUserMessage(agent, '子任务', { signal: controller.signal });
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(runtime.state().turnState).toBe('cancelled');
  });

  it('retains completed Core facts when host cleanup fails', async () => {
    const { runtime, agent, session } = fixture();
    const failure = new Error('close failed');
    await expect(runtime.startPreparedTurn(prepareTurnStart('工作'), async context => {
      await context.run(agent);
      throw failure;
    })).rejects.toBe(failure);
    expect(session.events().at(-1)?.type).toBe('turn.completed');
    expect(runtime.state().turnState).toBe('completed');
  });

  it('publishes original ordered Session facts and explicit host waiting states', async () => {
    const { runtime, agent, session } = fixture();
    const notifications: AgentRuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe(event => notifications.push(event));
    await runtime.startPreparedTurn(prepareTurnStart('审批'), async context => {
      await runtime.withWaiting('waiting_for_approval', async () => {
        expect(runtime.state().phase).toBe('waiting_for_approval');
      });
      expect(runtime.state().phase).toBe('starting');
      await runtime.withWaiting('waiting_for_input', async () => {});
      return context.run(agent);
    });
    const published = notifications.flatMap(event => event.type === 'session.events' ? [...event.events] : []);
    expect(published).toEqual(session.events());
    expect(notifications.filter(event => event.type === 'runtime.state').map(event => event.state.phase))
      .toEqual(expect.arrayContaining(['starting', 'waiting_for_approval', 'waiting_for_input', 'running', 'idle']));
    const count = notifications.length;
    unsubscribe();
    await runtime.submitUserMessage(agent, '后续');
    expect(notifications).toHaveLength(count);
  });

  it('resumes from persisted facts with a new Turn and does not replay the old call', async () => {
    const complete = vi.fn<Model['complete']>()
      .mockRejectedValueOnce(new Error('network disconnected'))
      .mockResolvedValue({ text: '继续完成', toolCalls: [] });
    const { runtime, agent, session } = fixture(complete);
    await expect(runtime.submitUserMessage(agent, '原任务')).rejects.toThrow('network disconnected');
    const sourceTurnId = runtime.state().turnId!;
    const result = await runtime.resumeTurn(agent, '继续', { sourceTurnId, mode: 'continue' });
    expect(result.turnId).not.toBe(sourceTurnId);
    expect(session.events().filter(event => event.type === 'turn.recovery.started')).toEqual([
      { type: 'turn.recovery.started', turnId: result.turnId, sourceTurnId, mode: 'continue' },
    ]);
    await expect(runtime.resumeTurn(agent, '重复继续', { sourceTurnId, mode: 'continue' })).rejects.toThrow('没有后继');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not hide persistence failure behind cancellation or a second terminal event', async () => {
    const { runtime, session } = fixture();
    const failure = new SessionPersistenceError(new Error('checkpoint'));
    const task = runtime.startPreparedTurn(prepareTurnStart('准备'), async context => {
      await Promise.resolve();
      context.signal.throwIfAborted();
      throw new Error('not reached');
    });
    runtime.cancelTurn(failure);
    await expect(task).rejects.toBe(failure);
    expect(session.events().map(event => event.type)).toEqual(['turn.started', 'user.message']);
  });

  it('records preparation failure and rejects agents belonging to another Session', async () => {
    const { runtime, agent, session } = fixture();
    await expect(runtime.startPreparedTurn(prepareTurnStart('准备'), async () => { throw new Error('prepare failed'); }))
      .rejects.toThrow('prepare failed');
    expect(session.events().at(-1)).toMatchObject({ type: 'turn.failed', errorMessage: 'prepare failed' });
    const wrong: Agent = { ...agent, session: new InMemorySession() };
    await expect(runtime.submitUserMessage(wrong, '错误会话')).rejects.toThrow('同一个 Session');
    expect(wrong.session.events()).toEqual([]);
  });

  it('returns the host error projection if preparation already saved a terminal fact', async () => {
    const { runtime, session } = fixture();
    await expect(runtime.startPreparedTurn(prepareTurnStart('准备'), async context => {
      session.append({ type: 'turn.failed', turnId: context.turnId, errorName: 'Error', errorMessage: 'host preparation' });
      return { status: 'error', errorMessage: 'host preparation' };
    })).resolves.toEqual({ status: 'error', errorMessage: 'host preparation' });
    expect(session.events().filter(event => event.type === 'turn.failed')).toHaveLength(1);
  });

  it('rejects a repeated loop execution without changing a completed terminal', async () => {
    const { runtime, agent, session } = fixture();
    await expect(runtime.startPreparedTurn(prepareTurnStart('工作'), async context => {
      await context.run(agent);
      return context.run(agent);
    })).rejects.toThrow('只能执行一次');
    expect(session.events().filter((event: SessionEvent) => event.type === 'turn.completed')).toHaveLength(1);
    expect(runtime.state().turnState).toBe('completed');
  });
});
