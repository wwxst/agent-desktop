import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { saveMemory } from './memory.js';
import type { MemoryEntry } from '@agent-desktop/client';

export class SaveMemoryTool implements Tool {
  readonly name = 'save_memory';
  readonly description = '保存一条对用户长期有用的偏好、习惯或事实。只保存用户明确表达或任务中稳定可复用的信息，不保存临时任务细节、秘密或文件内容。';
  readonly inputSchema = { type: 'object', properties: { content: { type: 'string', description: '要在未来任务中使用的简短记忆' } }, required: ['content'], additionalProperties: false };

  public constructor(
    private readonly databasePath: string,
    private readonly source: () => MemoryEntry['source'],
    private readonly allowToolChats: boolean,
  ) {}

  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null || typeof (input as { content?: unknown }).content !== 'string') return { status: 'error', message: 'save_memory 需要 content 文本。' };
    const source = this.source();
    if (source === 'tool' && !this.allowToolChats) return { status: 'error', message: '当前设置不允许从使用工具的聊天生成记忆。' };
    const entry = saveMemory(this.databasePath, (input as { content: string }).content, source);
    return { status: 'success', output: { saved: true, id: entry.id } };
  }
}
