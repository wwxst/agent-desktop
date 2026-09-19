import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@agent-desktop/client';
import { ToolApprovalGate } from '../src/main/tool-approval.js';

function createGate(): { gate: ToolApprovalGate; published: ApprovalRequest[] } {
  const published: ApprovalRequest[] = [];
  return { gate: new ToolApprovalGate((request) => published.push(request)), published };
}

describe('ToolApprovalGate', () => {
  it('publishes the exact operation and settles with the user decision', async () => {
    const { gate, published } = createGate();

    const pending = gate.request({ kind: 'directory', path: 'D:/videos' });
    expect(published).toHaveLength(1);
    expect(published[0]?.target).toBe('D:/videos');

    gate.decide(published[0]!.requestId, true);
    await expect(pending).resolves.toBe(true);
  });

  it('reports a refusal without any side effect', async () => {
    const { gate, published } = createGate();

    const pending = gate.request({ kind: 'directory', path: 'D:/private' });
    gate.decide(published[0]!.requestId, false);

    await expect(pending).resolves.toBe(false);
  });

  it('rejects a decision for a request that already settled', async () => {
    const { gate, published } = createGate();

    const pending = gate.request({ kind: 'directory', path: 'D:/videos' });
    const requestId = published[0]!.requestId;
    gate.decide(requestId, true);
    await pending;

    // 迟到的批准不能重新启动已经结束的操作。
    expect(() => gate.decide(requestId, true)).toThrowError(/已失效/);
  });

  it('rejects a decision carrying an unknown request id', () => {
    const { gate } = createGate();

    expect(() => gate.decide('forged-request', true)).toThrowError(/已失效/);
  });

  it('keeps a single pending request so a second one cannot be approved by the first decision', async () => {
    const { gate, published } = createGate();

    const first = gate.request({ kind: 'directory', path: 'D:/first' });
    gate.decide(published[0]!.requestId, true);
    await expect(first).resolves.toBe(true);

    // 第一个请求结束后，旧标识不能用来批准第二个请求。
    const second = gate.request({ kind: 'directory', path: 'D:/second' });
    expect(() => gate.decide(published[0]!.requestId, true)).toThrowError(/已失效/);

    gate.decide(published[1]!.requestId, false);
    await expect(second).resolves.toBe(false);
  });

  it('ends the wait with AbortError when the turn is cancelled', async () => {
    const { gate } = createGate();
    const controller = new AbortController();

    const pending = gate.request({ kind: 'directory', path: 'D:/videos' }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('does not publish a request when the turn was already cancelled', async () => {
    const { gate, published } = createGate();
    const controller = new AbortController();
    controller.abort();

    await expect(gate.request({ kind: 'directory', path: 'D:/videos' }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
    expect(published).toEqual([]);
  });

  it('ends the wait when the window closes while an approval is pending', async () => {
    const { gate, published } = createGate();
    const controller = new AbortController();
    // 关闭收尾先取消在跑的轮次，因此等待中的审批必须跟着结束，不能拖住窗口关闭。
    const pending = gate.request({ kind: 'directory', path: 'D:/videos' }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(() => gate.decide(published[0]!.requestId, true)).toThrowError(/已失效/);
  });

  it('accepts a new request after a cancelled one', async () => {
    const { gate, published } = createGate();
    const cancelled = new AbortController();

    const first = gate.request({ kind: 'directory', path: 'D:/first' }, cancelled.signal);
    cancelled.abort();
    await expect(first).rejects.toHaveProperty('name', 'AbortError');

    // 取消只结束这一次等待，不会让下一次审批永久失效。
    const second = gate.request({ kind: 'directory', path: 'D:/second' });
    expect(published[1]?.target).toBe('D:/second');
    gate.decide(published[1]!.requestId, true);
    await expect(second).resolves.toBe(true);
  });
});
