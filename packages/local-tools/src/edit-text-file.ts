import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type TextSnapshot =
  | { readonly ok: true; readonly bytes: Buffer; readonly text: string; readonly sha256: string }
  | { readonly ok: false; readonly message: string };

/** 编辑必须保留文件的原始字节事实；审批后用同一份快照确认用户批准的仍是当前内容。 */
async function readTextSnapshot(filePath: string): Promise<TextSnapshot> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, message: `无法读取该文件（${code ?? error.message}）：${filePath}` };
  }

  if (bytes.includes(0)) {
    return { ok: false, message: `这是二进制文件，不能用文本方式修改：${filePath}` };
  }
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) {
    return { ok: false, message: `文件不能完整按 UTF-8 解码，不会改写：${filePath}` };
  }
  return {
    ok: true,
    bytes,
    text,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * 经用户批准后，对已有 UTF-8 文本执行一次唯一匹配的精确替换。
 *
 * `expectedSha256` 把调用绑定到先前 `read_file` 读到的完整文件版本；工具在审批前读取完整内容并
 * 计算真正要写入的结果，批准后再次读取并比较原始字节。因此用户看到的变更与实际写入一致，
 * 从读取完成到批准执行期间的外部修改都不会被覆盖。
 */
export class EditTextFileTool implements Tool {
  readonly name = 'edit_text_file';
  readonly description = '先用 read_file 读取已有文本，再在当前工作目录内精确替换唯一匹配内容；写入前需要用户确认';
  readonly inputSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'read_file 返回的文件路径' },
      expectedSha256: { type: 'string', description: 'read_file 返回的 sha256，用于确认文件仍是已读取版本' },
      oldText: { type: 'string', description: '文件中唯一存在的原内容，不能为空' },
      newText: { type: 'string', description: '替换后的新内容，可以为空' },
    },
    required: ['filePath', 'expectedSha256', 'oldText', 'newText'],
    additionalProperties: false,
  };

  public constructor(private readonly workspace: WorkspacePort) {}

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (!isRecord(input)) return errorResult('edit_text_file requires an object input');
    const { filePath, expectedSha256, oldText, newText } = input;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return errorResult('edit_text_file requires filePath to be a non-empty string');
    }
    if (typeof expectedSha256 !== 'string' || expectedSha256.length === 0) {
      return errorResult('edit_text_file requires expectedSha256 from read_file');
    }
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return errorResult('edit_text_file requires oldText to be a non-empty string');
    }
    if (typeof newText !== 'string') {
      return errorResult('edit_text_file requires newText to be a string');
    }

    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), filePath);
    if (!scoped.ok) return errorResult(scoped.message);

    const snapshot = await readTextSnapshot(scoped.path);
    if (!snapshot.ok) return errorResult(snapshot.message);
    if (snapshot.sha256 !== expectedSha256) {
      return errorResult(`文件在读取后发生变化，请重新读取后再修改：${scoped.path}`);
    }

    const match = snapshot.text.indexOf(oldText);
    if (match === -1) {
      return errorResult(`文件中没有找到要替换的原内容，请重新读取后再修改：${scoped.path}`);
    }
    if (snapshot.text.indexOf(oldText, match + 1) !== -1) {
      return errorResult(`文件中有多处匹配，无法确定唯一修改位置：${scoped.path}`);
    }
    const updated = snapshot.text.slice(0, match) + newText + snapshot.text.slice(match + oldText.length);

    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');
    const approved = await this.workspace.requestApproval({
      kind: 'edit-file',
      path: scoped.path,
      before: oldText,
      after: newText,
    }, signal);
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');
    if (!approved) return errorResult(`用户拒绝修改该文件，未做任何写入：${scoped.path}`);

    const current = await readTextSnapshot(scoped.path);
    if (!current.ok || !current.bytes.equals(snapshot.bytes)) {
      return errorResult(`文件在审批期间发生变化，请重新读取后再修改：${scoped.path}`);
    }
    // 二次读盘也可能跨过取消时刻；真正写入前必须最后确认当前 Turn 仍然有效。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');

    try {
      await writeFile(scoped.path, updated, 'utf8');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return errorResult(`无法写入该文件（${code ?? error.message}）：${scoped.path}`);
    }

    return {
      status: 'success',
      output: {
        filePath: scoped.path,
        replacements: 1,
        bytes: Buffer.byteLength(updated, 'utf8'),
      },
    };
  }
}
