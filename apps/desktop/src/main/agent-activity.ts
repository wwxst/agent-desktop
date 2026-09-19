import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import type { AgentActivityFile, AgentActivityItem } from '@agent-desktop/client';
import type { SessionEvent } from '@agent-desktop/session';

/**
 * 当前工具输入里真实表示文件的字段。
 * 输入与输出分开，避免把中间产物误报成输入文件；字段名以各工具的 inputSchema 为准。
 */
const INPUT_PATH_FIELDS = ['videoPath', 'inputPath', 'inputPaths', 'audioPath', 'subtitlePath'] as const;
/** 表示「被设置或读取的目录」的输入字段：它也是真实路径，但按目录展示。 */
const INPUT_DIRECTORY_FIELDS = ['path', 'directory'] as const;
const OUTPUT_PATH_FIELDS = ['outputPath'] as const;
const OUTPUT_DIRECTORY_FIELDS = ['outputDir'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function findToolCallInput(events: readonly SessionEvent[], toolCallId: string): unknown {
  // 工具调用事件在 trace 回调前刚追加，从末尾反向查找即可命中，不需要遍历整段历史。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'tool.called' && event.toolCallId === toolCallId) return event.input;
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
      return { id: `model:${event.stepId}`, kind: 'analysis', status: 'running' };
    case 'model.completed':
      return {
        id: `model:${event.stepId}`,
        kind: 'analysis',
        status: 'completed',
        durationMs: event.durationMs,
        plannedToolCallCount: event.toolCallCount,
      };
    case 'model.failed':
      return {
        id: `model:${event.stepId}`,
        kind: 'analysis',
        status: 'failed',
        durationMs: event.durationMs,
      };
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed': {
      const files = readActivityFiles(findToolCallInput(events, event.toolCallId));
      return {
        id: event.toolCallId,
        kind: 'tool',
        status: event.type === 'tool.started'
          ? 'running'
          : event.type === 'tool.completed' ? 'completed' : 'failed',
        toolName: event.toolName,
        // exactOptionalPropertyTypes 下，没有文件或没有耗时时必须省略字段而不是写入 undefined。
        ...(files.length === 0 ? {} : { files }),
        ...(event.type === 'tool.started' ? {} : { durationMs: event.durationMs }),
      };
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
  return events.some((event) => event.type === 'tool.called'
    && readActivityFiles(event.input).some((file) => file.path === filePath));
}

/** 定位前确认文件仍然存在，让界面可以展示真实的打开失败。 */
export function assertRevealableFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`文件不存在或已被移动：${filePath}`);
}
