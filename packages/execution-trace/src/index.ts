import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { ExecutionTrace, ExecutionTraceEvent } from '@agent-desktop/agent-loop';

/** 将 Agent Loop 的运行事件追加为本地 JSONL，不参与 Agent 推理或 Session 重建。 */
export class JsonlExecutionTrace implements ExecutionTrace {
  readonly id = randomUUID();

  public constructor(private readonly filePath: string) {}

  async write(event: ExecutionTraceEvent): Promise<void> {
    // timestamp 由持久化边界生成，避免 Agent Loop 重复维护 wall-clock 字段。
    await appendFile(this.filePath, `${JSON.stringify({
      traceId: this.id,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  }
}
