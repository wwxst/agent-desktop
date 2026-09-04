import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { ExecutionTrace, ExecutionTraceEvent } from '@agent-desktop/agent-loop';

/** ffmpeg-agent 私有的本地 JSONL 写入器，不参与 Agent Loop 或 Session 语义。 */
export interface JsonlTrace {
  readonly id: string;
  readonly write: ExecutionTrace;
}

export function createJsonlTrace(filePath: string): JsonlTrace {
  const id = randomUUID();
  const write: ExecutionTrace = async (event: ExecutionTraceEvent): Promise<void> => {
    // timestamp 由当前落盘边界生成，避免 Agent Loop 维护第二份时间源。
    await appendFile(filePath, `${JSON.stringify({
      traceId: id,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  };

  return { id, write };
}
