import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ExecutionTraceEvent, ToolResultListener } from '@agent-desktop/agent-loop';
import type { AgentActivityDetail, AgentActivityFile, AgentActivityItem } from '@agent-desktop/client';
import type { SessionEvent } from '@agent-desktop/session';

type ToolResult = Parameters<ToolResultListener>[2];

/**
 * 当前本地工具输入里真实表示文件的字段。
 * 输入与输出分开，避免把中间产物误报成输入文件；字段名以各工具的 inputSchema 为准。
 */
const INPUT_PATH_FIELDS = [
  'videoPath',
  'inputPath',
  'inputPaths',
  'audioPath',
  'subtitlePath',
  'filePath',
] as const;
/** 表示「被设置或读取的目录」的输入字段：它也是真实路径，但按目录展示。 */
const INPUT_DIRECTORY_FIELDS = ['path', 'directory'] as const;
const OUTPUT_PATH_FIELDS = ['outputPath'] as const;
const OUTPUT_DIRECTORY_FIELDS = ['outputDir'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 命令的最终展示详情。
 *
 * 成功与失败分支都携带命令的真实终态，因此失败时同样保留退出码和有界输出；
 * 读不到终态结构时退回通用失败投影，不编造退出码。
 */
function projectCommandDetail(result: ToolResult): AgentActivityDetail | undefined {
  if (!isRecord(result.output)) {
    return result.status === 'error' ? { kind: 'error', message: result.message } : undefined;
  }

  const { command, workingDirectory, exitCode, termination, stdout, stderr, truncated, droppedBytes } = result.output;
  if (typeof command !== 'string'
    || typeof workingDirectory !== 'string'
    || typeof stdout !== 'string'
    || typeof stderr !== 'string'
    || typeof truncated !== 'boolean'
    || typeof droppedBytes !== 'number'
    || (termination !== 'exited' && termination !== 'timed-out')
    || (exitCode !== null && typeof exitCode !== 'number')) {
    return result.status === 'error' ? { kind: 'error', message: result.message } : undefined;
  }

  return {
    kind: 'command',
    command,
    workingDirectory,
    exitCode,
    termination,
    stdout,
    stderr,
    truncated,
    droppedBytes,
    // 失败原因与退出码、输出一起展示；成功的命令没有额外的失败说明。
    ...(result.status === 'error' ? { note: result.message } : {}),
  };
}

/** 只投影当前三个有界本地工具和真实失败消息；其他工具结果仍由模型消费，不进入界面快照。 */
export function projectAgentActivityDetail(
  toolName: string,
  result: ToolResult,
): AgentActivityDetail | undefined {
  // 命令的失败分支同样携带退出码和有界输出，因此先按工具契约投影，再走通用失败投影。
  if (toolName === 'run_command') return projectCommandDetail(result);
  if (result.status === 'error') return { kind: 'error', message: result.message };
  if (!isRecord(result.output)) return undefined;
  const output = result.output;
  if (toolName === 'delegate_tasks' && Array.isArray(output.tasks)) {
    return { kind: 'subagents', tasks: output.tasks as Extract<AgentActivityDetail, { kind: 'subagents' }>['tasks'] };
  }
  if (toolName === 'ask_user' && typeof output.question === 'string') {
    return { kind: 'interaction', question: output.question,
      answer: output.outcome === 'skipped' ? '已跳过' : String(output.answer) };
  }
  const note = typeof output.note === 'string' ? { note: output.note } : {};

  if (toolName === 'read_file'
    && typeof output.filePath === 'string'
    && typeof output.startLine === 'number'
    && typeof output.endLine === 'number'
    && typeof output.totalLines === 'number'
    && isStringArray(output.lines)) {
    return {
      kind: 'file-content',
      filePath: output.filePath,
      startLine: output.startLine,
      endLine: output.endLine,
      totalLines: output.totalLines,
      lines: output.lines,
      ...note,
    };
  }

  if (toolName === 'list_directory'
    && typeof output.directory === 'string'
    && typeof output.total === 'number'
    && Array.isArray(output.entries)) {
    const entries = output.entries.filter((entry): entry is {
      readonly name: string;
      readonly path: string;
      readonly type: 'file' | 'directory';
    } => isRecord(entry)
      && typeof entry.name === 'string'
      && typeof entry.path === 'string'
      && (entry.type === 'file' || entry.type === 'directory'));
    if (entries.length !== output.entries.length) return undefined;
    return { kind: 'directory', directory: output.directory, total: output.total, entries, ...note };
  }

  if (toolName === 'search_text'
    && typeof output.directory === 'string'
    && typeof output.pattern === 'string'
    && typeof output.total === 'number'
    && Array.isArray(output.matches)) {
    const matches = output.matches.filter((match): match is {
      readonly filePath: string;
      readonly lineNumber: number;
      readonly line: string;
    } => isRecord(match)
      && typeof match.filePath === 'string'
      && typeof match.lineNumber === 'number'
      && typeof match.line === 'string');
    if (matches.length !== output.matches.length) return undefined;
    return {
      kind: 'search',
      directory: output.directory,
      pattern: output.pattern,
      total: output.total,
      matches,
      ...note,
    };
  }

  return undefined;
}

/** 只读取当前工具契约里声明的字符串路径；其他形状不产生文件引用。 */
function readPathList(value: Record<string, unknown>, field: string): readonly string[] {
  const raw = value[field];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
}

/** 把工具输入里的真实路径投影成界面文件引用；输入不是当前工具契约的对象时没有文件。 */
export function readActivityFiles(input: unknown): readonly AgentActivityFile[] {
  if (!isRecord(input)) return [];

  const files: AgentActivityFile[] = [];
  for (const field of INPUT_PATH_FIELDS) {
    for (const path of readPathList(input, field)) {
      files.push({ path, label: basename(path), role: 'input' });
    }
  }
  // analyze_images 使用 images[].path；这是当前已注册工具唯一的嵌套文件输入契约。
  if (Array.isArray(input.images)) {
    for (const image of input.images) {
      if (isRecord(image) && typeof image.path === 'string') {
        files.push({ path: image.path, label: basename(image.path), role: 'input' });
      }
    }
  }
  for (const field of OUTPUT_PATH_FIELDS) {
    for (const path of readPathList(input, field)) {
      files.push({ path, label: basename(path), role: 'output' });
    }
  }
  for (const field of INPUT_DIRECTORY_FIELDS) {
    for (const path of readPathList(input, field)) {
      // 输入目录与输出目录一样用结尾斜杠区分于文件，让界面不需要猜测路径类型。
      files.push({ path, label: `${basename(path)}/`, role: 'input' });
    }
  }
  for (const field of OUTPUT_DIRECTORY_FIELDS) {
    for (const path of readPathList(input, field)) {
      // 输出目录用结尾斜杠区分于输出文件，让界面不需要猜测路径类型。
      files.push({ path, label: `${basename(path)}/`, role: 'output' });
    }
  }
  return files;
}

/**
 * 取回本次工具调用真实写入 Session 的输入。
 * Trace 只保存运行元数据、不复制工具内容，因此文件事实必须从 Session 事实里读。
 */
function findToolCallSource(events: readonly SessionEvent[], toolCallId: string,
  location?: { readonly turnId: string; readonly stepId: string }): Extract<SessionEvent, { type: 'tool.called' }> | undefined {
  // 回调查询当前调用；历史 Trace 带有轮次和步骤，必须同时匹配，不能命中复用原始 ID 的后续调用。
  return events.findLast((event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called' && event.payload.toolCallId === toolCallId
    && (location === undefined || (event.turnId === location.turnId && event.payload.stepId === location.stepId)));
}

export function findToolCallInput(events: readonly SessionEvent[], toolCallId: string): unknown {
  return findToolCallSource(events, toolCallId)?.payload.input;
}

/** 实时详情及进度沿用当前已落盘调用的权威身份；缺少来源是宿主调用顺序错误。 */
export function getToolActivityId(events: readonly SessionEvent[], toolCallId: string): string {
  const source = findToolCallSource(events, toolCallId);
  if (source === undefined) throw new Error('工具活动缺少已保存的 tool.called 来源。');
  return source.itemId;
}

/** 模型活动从真实步骤取回身份，不用 Trace 字段重新拼接另一套 ID。 */
function getModelActivityId(events: readonly SessionEvent[], location: { readonly turnId: string; readonly stepId: string }): string {
  const source = events.findLast(event => event.type === 'step.started' && event.turnId === location.turnId
    && event.payload.stepId === location.stepId);
  if (source === undefined) throw new Error('模型活动缺少已保存的 step.started 来源。');
  return source.itemId;
}

/** 命令的完整原文来自 Session 的 tool.called 事实；实时进度只携带输出片段。 */
export function findCommandText(events: readonly SessionEvent[], toolCallId: string): string {
  const input = findToolCallInput(events, toolCallId);
  return isRecord(input) && typeof input.command === 'string' ? input.command : '';
}

/** 成功结果里的 filePath 是工具解析并实际操作的真实路径，优先于模型输入的相对路径。 */
function findSuccessfulToolResultFilePath(
  events: readonly SessionEvent[],
  itemId: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'tool.result' || event.itemId !== itemId) continue;
    if (event.payload.result.status !== 'success' || !isRecord(event.payload.result.output)) return undefined;
    return typeof event.payload.result.output.filePath === 'string' ? event.payload.result.output.filePath : undefined;
  }
  return undefined;
}

/** 把 Trace 事件投影成一条界面活动；Turn 生命周期事件不单独成行。 */
export function projectAgentActivity(
  event: ExecutionTraceEvent,
  events: readonly SessionEvent[],
): AgentActivityItem | undefined {
  switch (event.type) {
    case 'model.started':
      return { id: getModelActivityId(events, event), kind: 'analysis', status: 'running' };
    case 'model.retrying':
      return { id: getModelActivityId(events, event), kind: 'analysis', status: 'running',
        retryNote: `服务暂时不可用，${event.waitMs / 1000} 秒后进行第 ${event.attempt} 次尝试。` };
    case 'model.completed':
      return {
        id: getModelActivityId(events, event),
        kind: 'analysis',
        status: 'completed',
        durationMs: event.durationMs,
        plannedToolCallCount: event.toolCallCount,
      };
    case 'model.failed':
      return {
        id: getModelActivityId(events, event),
        kind: 'analysis',
        status: 'failed',
        durationMs: event.durationMs,
      };
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed': {
      const source = findToolCallSource(events, event.toolCallId, event);
      if (source === undefined) throw new Error('工具活动缺少已保存的 tool.called 来源。');
      const resultFilePath = event.type === 'tool.completed' && event.toolName === 'edit_text_file'
        ? findSuccessfulToolResultFilePath(events, source.itemId)
        : undefined;
      const files = resultFilePath === undefined
        ? readActivityFiles(source.payload.input)
        : [{ path: resultFilePath, label: basename(resultFilePath), role: 'input' as const }];
      return {
        id: source.itemId,
        kind: 'tool',
        status: event.type === 'tool.started' ? 'running'
          : event.type === 'tool.completed' ? 'completed' : 'failed',
        toolName: event.toolName,
        // exactOptionalPropertyTypes 下，没有文件或没有耗时时必须省略字段而不是写入 undefined。
        ...(files.length === 0 ? {} : { files }),
        ...(event.type === 'tool.started' ? {} : { durationMs: event.durationMs }),
      };
    }
    case 'turn.cancelled': {
      // 轮次取消没有 Tool Result；用已有 Session 事实结束当前活动，保持核心追踪契约不变。
      const pending = events.findLast(entry => entry.type === 'tool.called' && entry.turnId === event.turnId);
      if (pending?.type !== 'tool.called' || events.some(entry => entry.type === 'tool.result'
        && entry.turnId === pending.turnId && entry.payload.stepId === pending.payload.stepId
        && entry.payload.toolCallId === pending.payload.toolCallId)) return undefined;
      const files = readActivityFiles(pending.payload.input);
      return { id: pending.itemId, kind: 'tool', status: 'cancelled', toolName: pending.payload.name,
        ...(files.length === 0 ? {} : { files }) };
    }
    default:
      return undefined;
  }
}

/**
 * 只有当前会话真实使用过的文件才允许被定位。
 * Renderer 传来的路径属于真实边界，必须对照 Session 事实和会话附件，避免用任意路径打开本机目录。
 */
export function isSessionFilePath(
  events: readonly SessionEvent[],
  sessionPaths: readonly string[],
  filePath: string,
): boolean {
  if (sessionPaths.includes(filePath)) return true;
  return events.some((event) => {
    if (event.type === 'tool.called') {
      return readActivityFiles(event.payload.input).some((file) => file.path === filePath);
    }
    // 成功结果报告的产物或实际文件路径都是这次会话真实操作过的文件。
    // 工具输入可能只有相对路径，因此定位时也要承认工具执行后解析出的绝对路径。
    if (event.type === 'tool.result' && event.payload.result.status === 'success') {
      if ((event.payload.result.artifacts ?? []).some((artifact) => artifact.path === filePath)) return true;
      return isRecord(event.payload.result.output) && event.payload.result.output.filePath === filePath;
    }
    return false;
  });
}

/** 定位前确认文件仍然存在，让界面可以展示真实的打开失败。 */
export function assertRevealableFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`文件不存在或已被移动：${filePath}`);
}
