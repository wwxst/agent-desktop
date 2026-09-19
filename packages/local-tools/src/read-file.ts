import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { readFile, stat } from 'node:fs/promises';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

/**
 * 一次最多返回多少行。
 * 超过时明确报告总行数和继续读取的起始行号，不能把整个文件塞进模型上下文。
 */
const DEFAULT_LINE_COUNT = 200;
/** 单行最大字符数：压缩过的 JSON、超长日志行不能让一行撑爆上下文。 */
const MAX_LINE_CHARS = 2000;
/**
 * 一次读取的总字符预算。
 * 调用方可以把 `lineCount` 传得很大，但输出总量由这里兜住：超出就停下并报告继续读取位置。
 */
const MAX_OUTPUT_CHARS = 20_000;
/**
 * 允许整份读入的文件大小上限。
 * 读取需要把文件放进内存并切分成行，超过这个大小的文本文件应当改用 `search_text` 定位片段。
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
}

/** 行号和行数只接受正整数；非法时返回可以直接交回模型的失败结果。 */
function parseCount(
  value: unknown,
  field: string,
): { readonly value?: number } | { readonly failure: ToolResult } {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { failure: errorResult(`read_file requires ${field} to be a positive integer`) };
  }
  return { value };
}

/** 二进制判定：文本文件里不会出现 NUL 字节，出现即按二进制拒绝。 */
function looksBinary(source: Buffer): boolean {
  return source.includes(0);
}

/**
 * 按行读取会话工作目录内的文本文件。
 *
 * 返回的是**行数组**而不是整段字符串：行号是后续精确替换文件要用的定位信息，
 * 让模型自己去数行号迟早会错。行号从 1 开始，与用户在编辑器里看到的一致。
 *
 * 输出有三个上限，缺一不可：文件大小（不把超大文件整份读进内存）、单行长度（一行不能撑爆上下文）、
 * 总字符预算（`lineCount` 传多大都不会让输出无限增长）。超限一律明确报告并给出继续读取位置。
 *
 * 不做编码识别：按 UTF-8 解码，出现替换字符时如实说明文件可能不是 UTF-8；
 * 二进制文件直接拒绝，不用乱码冒充文本。
 */
export class ReadFileTool implements Tool {
  readonly name = 'read_file';
  readonly description = '按行读取当前会话工作目录内的文本文件，可从指定行继续读取；二进制文件不受支持';
  readonly inputSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '相对工作目录的路径或绝对路径' },
      startLine: { type: 'integer', description: '起始行号，从 1 开始；省略时为第 1 行' },
      lineCount: { type: 'integer', description: '最多读取多少行；省略时使用默认上限' },
    },
    required: ['filePath'],
    additionalProperties: false,
  };

  public constructor(
    private readonly workspace: WorkspacePort,
    private readonly defaultLineCount: number = DEFAULT_LINE_COUNT,
  ) {}

  async execute(input: unknown): Promise<ToolResult> {
    if (!isRecord(input)) return errorResult('read_file requires an object input');
    const { filePath, startLine, lineCount } = input;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return errorResult('read_file requires filePath to be a non-empty string');
    }
    const start = parseCount(startLine, 'startLine');
    if ('failure' in start) return start.failure;
    const count = parseCount(lineCount, 'lineCount');
    if ('failure' in count) return count.failure;

    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), filePath);
    if (!scoped.ok) return errorResult(scoped.message);

    // 先看大小再读内容：超大文件不能先整份读进内存才发现太大。
    let size: number;
    try {
      size = (await stat(scoped.path)).size;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return errorResult(`无法读取该文件（${code ?? error.message}）：${scoped.path}`);
    }
    if (size > MAX_FILE_BYTES) {
      return errorResult(
        `文件过大（${size} 字节，上限 ${MAX_FILE_BYTES} 字节），不能整份读入；`
        + `请改用 search_text 定位需要的片段：${scoped.path}`,
      );
    }

    let source: Buffer;
    try {
      source = await readFile(scoped.path);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return errorResult(`无法读取该文件（${code ?? error.message}）：${scoped.path}`);
    }

    if (looksBinary(source)) {
      return errorResult(`这是二进制文件，不能用文本方式读取：${scoped.path}`);
    }

    const text = source.toString('utf8');
    // 统一按 \n 切分并去掉行尾的 \r：Windows 上的 SRT 等文件都是 CRLF，行号不受影响。
    const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // 以换行结尾的文件最后一个元素是空串，它不是一行。
    const totalLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

    const from = (start.value ?? 1) - 1;
    // 空文件是合法文本文件：0 行、0 内容，不是错误。
    if (totalLines === 0) {
      return {
        status: 'success',
        output: { filePath: scoped.path, startLine: 1, endLine: 0, totalLines: 0, lines: [] },
      };
    }
    if (from >= totalLines) {
      return errorResult(`起始行超出文件范围：文件共 ${totalLines} 行，请求从第 ${start.value} 行开始。`);
    }

    const limit = count.value ?? this.defaultLineCount;
    const window: string[] = [];
    let consumed = 0;
    let shortenedLine = false;
    let index = from;
    while (index < totalLines && window.length < limit) {
      const raw = lines[index] ?? '';
      const shortened = raw.length > MAX_LINE_CHARS;
      const line = shortened ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
      // 至少返回一行，避免预算比单行还小时原地打转。
      if (window.length > 0 && consumed + line.length > MAX_OUTPUT_CHARS) break;
      window.push(line);
      consumed += line.length;
      shortenedLine = shortenedLine || shortened;
      index += 1;
    }

    const end = index;
    const truncated = end < totalLines;
    // 一条结果只给一个说明，避免多个提示互相覆盖。
    const notes = [
      ...(truncated
        ? [`文件共 ${totalLines} 行，这里只返回第 ${from + 1}-${end} 行；继续读取请用 startLine=${end + 1}。`]
        : []),
      ...(shortenedLine
        ? [`有行超过 ${MAX_LINE_CHARS} 字符已截断，这些行的剩余内容无法通过 read_file 获取。`]
        : []),
      ...(text.includes('\uFFFD')
        ? ['文件中出现无法按 UTF-8 解码的字节，内容可能不完整；该文件可能不是 UTF-8 文本。']
        : []),
    ];

    return {
      status: 'success',
      output: {
        filePath: scoped.path,
        startLine: from + 1,
        endLine: end,
        totalLines,
        lines: window,
        ...(truncated ? { truncated: true, nextStartLine: end + 1 } : {}),
        ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
      },
    };
  }
}
