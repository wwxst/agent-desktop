import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolCallId, ToolResult } from '@agent-desktop/model';
import {
  DEFAULT_TOOL_OUTPUT_LIMITS, formatModelToolResult, InMemoryToolRegistry, resolveToolContract,
  ToolExecutionError, ToolRouter, type Tool, type ToolExecutionContext,
} from '../src/index.js';

const call: ToolCall = { id: 'call' as ToolCallId, name: 'read', input: { path: 'source.ts' } };
const context: ToolExecutionContext = { toolCallId: call.id, reportProgress: () => {} };
const artifact = (path: string, id = `test-${path}`) => ({ id, path, mimeType: 'text/plain', size: 1, sha256: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', sourceTool: 'write' });
function routerFor(tool: Tool): ToolRouter {
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  return new ToolRouter(registry);
}
const read: Tool = { name: 'read', description: 'read source', inputSchema: { type: 'object' },
  executionBoundary: 'read-only', execute: async () => ({ status: 'success', output: 'source' }),
  contract: { capability: 'code', riskLevel: 'read', parallelSafety: 'safe' } };

describe('ToolRouter', () => {
  it('uses one conservative contract and requires both explicit parallel safety and a read-only boundary', () => {
    const opaque: Tool = { ...read, executionBoundary: 'opaque', contract: { parallelSafety: 'safe' } };
    expect(resolveToolContract(opaque)).toMatchObject({ capability: 'unknown', riskLevel: 'unknown',
      timeoutMs: 120000, approvalRequirement: 'policy', outputSchema: {} });
    expect(routerFor(opaque).canParallel(call)).toBe(false);
    expect(routerFor({ ...read, contract: {} }).canParallel(call)).toBe(false);
    expect(routerFor(read).canParallel(call)).toBe(true);
  });

  it('selects the catalog and enforces that same selected set during execution', async () => {
    const registry = new InMemoryToolRegistry();
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'video' }));
    registry.register(read);
    registry.register({ ...read, name: 'video', contract: { capability: 'video' }, execute });
    const router = new ToolRouter(registry, ['code']);
    expect(router.catalog().map(entry => entry.name)).toEqual(['read']);
    expect(router.definitions()).toEqual([{ name: read.name, description: read.description, inputSchema: read.inputSchema }]);
    await expect(router.execute({ ...call, name: 'video' }, context)).resolves.toMatchObject({ status: 'error', failureKind: 'permanent' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['read-only', 'opaque'] as const)('classifies a real signalled timeout at the %s boundary', async boundary => {
    const router = routerFor({ ...read, executionBoundary: boundary, contract: { timeoutMs: 5 },
      execute: async (_input, inputContext) => new Promise((_resolve, reject) => {
        inputContext.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }) });
    await expect(router.execute(call, context)).rejects.toMatchObject({ name: 'ToolExecutionError',
      failureKind: boundary === 'read-only' ? 'transient' : 'unknown-outcome' });
  });

  it('propagates parent cancellation and does not convert it into a timeout failure', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const router = routerFor({ ...read, execute: async (_input, inputContext) => new Promise((_resolve, reject) => {
      inputContext.signal!.addEventListener('abort', () => reject(inputContext.signal!.reason), { once: true });
      started();
    }) });
    const execution = router.execute(call, { ...context, signal: controller.signal });
    await ready;
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('waits for a tool that cannot stop and preserves its actual final success instead of leaving background work', async () => {
    const router = routerFor({ ...read, executionBoundary: 'opaque', contract: { timeoutMs: 1, cancellation: 'none' },
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { status: 'success', output: 'actual external completion' };
      } });
    await expect(router.execute(call, context)).resolves.toEqual({ status: 'success', output: 'actual external completion' });
  });

  it('retains actual unknown classifications without retrying', async () => {
    const failure = new ToolExecutionError('effect outcome unknown', 'unknown-outcome');
    const execute = vi.fn<Tool['execute']>().mockRejectedValue(failure);
    await expect(routerFor({ ...read, execute }).execute(call, context)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('bounded model tool output', () => {
  it('keeps small tool output intact and explicitly retains artifact identity', () => {
    expect(formatModelToolResult({ status: 'success', output: { lines: ['中文 source'] } })).toBe('{"lines":["中文 source"]}');
    expect(JSON.parse(formatModelToolResult({ status: 'success', output: 'written', artifacts: [artifact('result.txt')] })))
      .toEqual({ status: 'success', output: 'written', artifacts: [artifact('result.txt')] });
  });

  it('bounds bytes and conservative tokens with valid head/tail JSON while the original fact stays complete', () => {
    const result: ToolResult = { status: 'success', output: `START:${'中文\\\"\n'.repeat(6000)}:END`, artifacts: [artifact('final.mp4')] };
    const original = structuredClone(result);
    const text = formatModelToolResult(result);
    const bounded = JSON.parse(text);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(Math.min(DEFAULT_TOOL_OUTPUT_LIMITS.maxBytes, DEFAULT_TOOL_OUTPUT_LIMITS.maxTokens));
    expect(bounded).toMatchObject({ status: 'success', artifacts: [artifact('final.mp4')], truncation: { truncated: true } });
    expect(bounded.head).toContain('START:'); expect(bounded.tail).toContain(':END');
    expect(text).not.toContain('\ufffd');
    expect(result).toEqual(original);
  });

  it('bounds error messages too and preserves unknown effect status', () => {
    const text = formatModelToolResult({ status: 'error', message: 'network result unknown '.repeat(3000), failureKind: 'unknown-outcome' },
      { maxBytes: 700, maxTokens: 500 });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(500);
    expect(JSON.parse(text)).toMatchObject({ status: 'error', failureKind: 'unknown-outcome', truncation: { truncated: true } });
  });

  it('marks a bounded artifact list when metadata alone would exceed the output budget', () => {
    const text = formatModelToolResult({ status: 'success', output: 'large '.repeat(1000),
      artifacts: Array.from({ length: 12 }, (_, index) => artifact(`${index}-${'file'.repeat(30)}.txt`, `${index}-${'artifact'.repeat(30)}`)) }, { maxBytes: 700, maxTokens: 700 });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(700);
    expect(JSON.parse(text)).toMatchObject({ artifactsTruncated: true, artifactCount: 12, truncation: { truncated: true } });
  });
});
