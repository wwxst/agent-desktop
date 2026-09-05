import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { ExecutionTrace, ExecutionTraceEvent } from '@agent-desktop/agent-loop';

/** 为当前 Turn 创建本地 JSONL Trace；调用方仍决定文件路径和事件消费者。 */
export function createJsonlTrace(filePath: string) {
  const id = randomUUID();

  const write: ExecutionTrace = async (event: ExecutionTraceEvent) => {
    await appendFile(filePath, `${JSON.stringify({
      traceId: id,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  };

  return { id, write };
}
