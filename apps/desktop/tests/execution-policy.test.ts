import { describe, expect, it, vi } from 'vitest';
import { NetworkAccessPolicy, WindowsExecutionBoundary } from '../src/main/execution-policy.js';
import { ToolApprovalGate, type CapabilityApproval } from '../src/main/tool-approval.js';
import type { ApprovalRequest } from '@agent-desktop/client';

describe('execution boundary', () => {
  it('enforces disabled and exact domain allowlists before network access', async () => {
    const approve = vi.fn(async () => true);
    const disabled = new NetworkAccessPolicy(() => ({ mode: 'disabled' }), approve);
    expect(await disabled.authorize({ url: 'https://example.com' })).toBe(false);
    const limited = new NetworkAccessPolicy(() => ({ mode: 'allowlist', domains: ['example.com'] }), approve);
    expect(await limited.authorize({ url: 'https://example.com/a' })).toBe(true);
    for (const url of ['https://example.com.evil.test', 'https://example.com:8443', 'file:///C:/secret', 'https://user:secret@example.com']) {
      expect(await limited.authorize({ url })).toBe(false);
    }
    expect(approve).not.toHaveBeenCalled();
    expect(new NetworkAccessPolicy(() => ({ mode: 'allowed' }), approve).allowsUnrestrictedProcess()).toBe(true);
    expect(limited.allowsUnrestrictedProcess()).toBe(false);
    expect(() => new WindowsExecutionBoundary().assertProcessLaunch({ target: 'Shell 命令', networkAllowed: true })).not.toThrow();
    await expect(disabled.require({ url: 'https://example.com' })).rejects.toMatchObject({ failureKind: 'denied' });
    expect(() => new WindowsExecutionBoundary().requireProcessIsolation()).toThrow('不能建立');
    expect(() => new WindowsExecutionBoundary().assertProcessLaunch({ target: '第三方 stdio', networkAllowed: false })).toThrow('不能建立');
  });

  it('accepts a validated target when the user explicitly starts an account connection', async () => {
    const approve = vi.fn(async () => false);
    const policy = new NetworkAccessPolicy(() => ({ mode: 'disabled' }), approve);
    expect(await policy.authorizeUserInitiated({ url: 'https://auth.example.com/token', method: 'POST', resourceType: 'mcp-oauth' })).toBe(true);
    expect(await policy.authorizeUserInitiated({ url: 'file:///secret' })).toBe(false);
    expect(await policy.authorizeUserInitiated({ url: 'https://user:secret@example.com' })).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it('resumes the original request and reuses only explicitly granted session origins', async () => {
    const published: ApprovalRequest[] = [];
    const gate = new ToolApprovalGate(request => published.push(request));
    gate.configure({ sessionId: 'session-a', mode: 'ask', review: async () => { throw new Error('unused'); } });
    const policy = new NetworkAccessPolicy(() => ({ mode: 'approval-required' }), (request, signal) => gate.request(request, signal));
    const first = policy.authorize({ url: 'https://example.com/a' });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'tool-action', sessionScope: expect.stringContaining('https://example.com') });
    gate.decide(published[0]!.requestId, true, 'session');
    expect(await first).toBe(true);
    expect(await policy.authorize({ url: 'https://example.com/b' })).toBe(true);
    expect(published).toHaveLength(1);
    const other = policy.authorize({ url: 'https://other.test' });
    expect(published).toHaveLength(2);
    gate.decide(published[1]!.requestId, false);
    expect(await other).toBe(false);
    gate.configure({ sessionId: 'session-b', mode: 'ask', review: async () => { throw new Error('unused'); } });
    const differentSession = policy.authorize({ url: 'https://example.com' });
    gate.decide(published[2]!.requestId, true);
    expect(await differentSession).toBe(true);
    gate.forgetSession('session-a');
    gate.configure({ sessionId: 'session-a', mode: 'ask', review: async () => { throw new Error('unused'); } });
    const afterForget = policy.authorize({ url: 'https://example.com' });
    gate.decide(published[3]!.requestId, false);
    expect(await afterForget).toBe(false);
  });

  it('serializes concurrent prompts without allowing an earlier decision to approve the next request', async () => {
    const published: ApprovalRequest[] = [];
    const gate = new ToolApprovalGate(request => published.push(request));
    const target: CapabilityApproval = { kind: 'tool-action', capability: '浏览器', action: '点击', arguments: '{"ref":"e1"}' };
    const first = gate.request(target);
    const second = gate.request({ ...target, arguments: '{"ref":"e2"}' });
    expect(published).toHaveLength(1);
    gate.decide(published[0]!.requestId, true);
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(() => gate.decide(published[0]!.requestId, true)).toThrow('已失效');
    expect(() => gate.decide(published[1]!.requestId, true, 'session')).toThrow('没有会话授权范围');
    gate.decide(published[1]!.requestId, false);
    expect(await second).toBe(false);
  });
});
