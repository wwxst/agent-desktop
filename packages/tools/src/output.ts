import type { ToolResult } from '@agent-desktop/model';

export interface ToolOutputLimits { readonly maxBytes: number; readonly maxTokens: number; }
/** UTF-8 字节按每字节一个 token 保守计费，避免依赖任一供应商的分词器。 */
export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = { maxBytes: 32_768, maxTokens: 8_192 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Slice(bytes: Uint8Array, start: number, end: number): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start += 1;
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(start, end));
}

/** 同一事实在模型协议、恢复资料和摘要资料中使用同一个有界表示。 */
export function formatModelToolResult(result: ToolResult, limits: ToolOutputLimits = DEFAULT_TOOL_OUTPUT_LIMITS): string {
  let text: string;
  if ((result.status === 'success' && result.artifacts !== undefined)
    || (result.status === 'error' && result.failureKind === 'unknown-outcome')) text = JSON.stringify(result);
  else if (result.status === 'error' && result.output === undefined) text = result.message;
  else if (result.status === 'success' && typeof result.output === 'string') text = result.output;
  else {
    const output = JSON.stringify(result.output);
    if (output === undefined) throw new Error('Tool result output must be JSON-serializable');
    text = result.status === 'error' ? `${result.message}\n${output}` : output;
  }
  const bytes = encoder.encode(text);
  const budget = Math.min(limits.maxBytes, limits.maxTokens);
  if (bytes.length <= budget) return text;
  // 完整结果仍保留在 Session；模型明确知道只拿到首尾预览，状态与产物身份独立保留。
  const artifacts = result.status === 'success' ? [...result.artifacts ?? []] : [];
  let artifactsTruncated = false;
  const envelope = (retained: number) => ({
    status: result.status,
    ...(result.status === 'error' && result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(artifactsTruncated ? { artifactsTruncated: true, artifactCount: result.status === 'success' ? result.artifacts!.length : 0 } : {}),
    truncation: { truncated: true, originalBytes: bytes.length, maxBytes: limits.maxBytes, maxTokens: limits.maxTokens },
    head: utf8Slice(bytes, 0, Math.ceil(retained / 2)),
    tail: utf8Slice(bytes, bytes.length - Math.floor(retained / 2), bytes.length),
  });
  // 产物引用本身也可能很大；不能为保留无限条路径而突破上下文限制。
  while (encoder.encode(JSON.stringify(envelope(0))).length > budget && artifacts.length > 0) {
    artifacts.pop(); artifactsTruncated = true;
  }
  if (encoder.encode(JSON.stringify(envelope(0))).length > budget) throw new Error('工具输出预算不足以承载截断标记。');
  let lower = 0; let upper = budget;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (encoder.encode(JSON.stringify(envelope(middle))).length <= budget) lower = middle;
    else upper = middle - 1;
  }
  return JSON.stringify(envelope(lower));
}
