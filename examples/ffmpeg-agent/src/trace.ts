import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { ExecutionTrace, ExecutionTraceEvent } from '@agent-desktop/agent-loop';

/** 将 Agent Loop 的运行事件追加为本地 JSONL；写入器只属于当前 FFmpeg 示例入口。 */
export function createJsonlTrace(filePath: string) {
  const id = randomUUID();

  const write: ExecutionTrace = async (event: ExecutionTraceEvent) => {
    // timestamp 由持久化边界生成，避免 Agent Loop 重复维护 wall-clock 字段。
    await appendFile(filePath, `${JSON.stringify({
      traceId: id,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  };

  return { id, write };
}
