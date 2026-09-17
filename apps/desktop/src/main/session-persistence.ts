import { readFile, writeFile } from 'node:fs/promises';
import type {
  AgentTaskResult,
  ClientConversation,
  ClientConversationMessage,
  ClientStateSnapshot,
  ToolActivityItem,
} from '@agent-desktop/client';
import { recoverSessionEvents, type SessionEvent } from '@agent-desktop/session';

export const SESSION_STATE_FILE_NAME = 'session-state.json';

export interface PersistedDesktopSession {
  readonly id: string;
  readonly selectedVideoPaths: readonly string[];
  readonly outputFilePaths: Readonly<Record<string, string>>;
  readonly events: readonly SessionEvent[];
}

export interface PersistedDesktopState {
  readonly activeSessionId: string;
  readonly outputSequence: number;
  readonly sessions: readonly PersistedDesktopSession[];
  readonly clientState: ClientStateSnapshot;
}

type SessionToolCall = Extract<SessionEvent, { type: 'assistant.message' }>['toolCalls'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new Error(`本地会话结构无效：${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid(field);
  return value;
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readString(item, `${field}[${index}]`));
}

function readToolCall(value: unknown, field: string): SessionToolCall {
  if (!isRecord(value)) invalid(field);
  const id = readString(value.id, `${field}.id`);
  const name = readString(value.name, `${field}.name`);
  if (!Object.hasOwn(value, 'input')) invalid(`${field}.input`);
  return { id, name, input: value.input } as SessionToolCall;
}

function readSessionEvent(value: unknown, field: string): SessionEvent {
  if (!isRecord(value)) invalid(field);
  const type = readString(value.type, `${field}.type`);
  const turnId = readString(value.turnId, `${field}.turnId`);

  switch (type) {
    case 'turn.started':
    case 'turn.completed':
      return { type, turnId } as SessionEvent;
    case 'user.message':
      return {
        type,
        turnId,
        content: readString(value.content, `${field}.content`),
      } as unknown as SessionEvent;
    case 'step.started':
    case 'step.completed':
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
      } as SessionEvent;
    case 'assistant.message': {
      if (!Array.isArray(value.toolCalls)) invalid(`${field}.toolCalls`);
      const toolCalls = value.toolCalls.map((item, index) => (
        readToolCall(item, `${field}.toolCalls[${index}]`)
      ));
      const content = value.content;
      if (content !== undefined && typeof content !== 'string') invalid(`${field}.content`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        ...(content === undefined ? {} : { content }),
        toolCalls,
      } as unknown as SessionEvent;
    }
    case 'tool.called':
      if (!Object.hasOwn(value, 'input')) invalid(`${field}.input`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
        name: readString(value.name, `${field}.name`),
        input: value.input,
      } as SessionEvent;
    case 'tool.result': {
      if (!isRecord(value.result)) invalid(`${field}.result`);
      const status = readString(value.result.status, `${field}.result.status`);
      const result = status === 'success'
        ? Object.hasOwn(value.result, 'output')
          ? { status, output: value.result.output }
          : invalid(`${field}.result.output`)
        : status === 'error'
          ? { status, message: readString(value.result.message, `${field}.result.message`) }
          : invalid(`${field}.result.status`);
      return {
        type,
        turnId,
        stepId: readString(value.stepId, `${field}.stepId`),
        toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
        result,
      } as SessionEvent;
    }
    default:
      return invalid(`${field}.type`);
  }
}

function readToolActivity(value: unknown, field: string): ToolActivityItem {
  if (!isRecord(value)) invalid(field);
  const status = readString(value.status, `${field}.status`);
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') invalid(`${field}.status`);
  const durationMs = value.durationMs;
  if (durationMs !== undefined
    && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid(`${field}.durationMs`);
  }
  return {
    toolCallId: readString(value.toolCallId, `${field}.toolCallId`),
    toolName: readString(value.toolName, `${field}.toolName`),
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function readTaskResult(value: unknown, field: string): AgentTaskResult {
  if (!isRecord(value)) invalid(field);
  const outputFileName = value.outputFileName;
  if (outputFileName !== undefined && typeof outputFileName !== 'string') {
    invalid(`${field}.outputFileName`);
  }
  return {
    responseText: readString(value.responseText, `${field}.responseText`),
    traceId: readString(value.traceId, `${field}.traceId`),
    ...(outputFileName === undefined ? {} : { outputFileName }),
  };
}

function readClientMessage(value: unknown, field: string): ClientConversationMessage {
  if (!isRecord(value)) invalid(field);
  const id = readNonNegativeInteger(value.id, `${field}.id`);
  const role = readString(value.role, `${field}.role`);
  if (role === 'user') {
    return {
      id,
      role,
      text: readString(value.text, `${field}.text`),
      attachments: readStringArray(value.attachments, `${field}.attachments`),
    };
  }
  if (role !== 'assistant') invalid(`${field}.role`);
  if (!Array.isArray(value.tools)) invalid(`${field}.tools`);
  const base = {
    id,
    role,
    tools: value.tools.map((item, index) => readToolActivity(item, `${field}.tools[${index}]`)),
    toolsExpanded: typeof value.toolsExpanded === 'boolean'
      ? value.toolsExpanded
      : invalid(`${field}.toolsExpanded`),
  } as const;
  const status = readString(value.status, `${field}.status`);
  if (status === 'completed') {
    return { ...base, status, result: readTaskResult(value.result, `${field}.result`) };
  }
  if (status === 'failed') {
    return {
      ...base,
      status,
      errorMessage: readString(value.errorMessage, `${field}.errorMessage`),
    };
  }
  if (status === 'cancelled') return { ...base, status };
  return invalid(`${field}.status`);
}

function readClientConversation(value: unknown, field: string): ClientConversation {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.messages)) invalid(`${field}.messages`);
  if (!Array.isArray(value.selectedVideos)) invalid(`${field}.selectedVideos`);
  return {
    id: readString(value.id, `${field}.id`),
    title: readString(value.title, `${field}.title`),
    titleManuallyRenamed: value.titleManuallyRenamed === undefined
      ? false
      : typeof value.titleManuallyRenamed === 'boolean'
        ? value.titleManuallyRenamed
        : invalid(`${field}.titleManuallyRenamed`),
    messages: value.messages.map((item, index) => readClientMessage(item, `${field}.messages[${index}]`)),
    prompt: readString(value.prompt, `${field}.prompt`),
    selectedVideos: value.selectedVideos.map((item, index) => {
      if (!isRecord(item)) invalid(`${field}.selectedVideos[${index}]`);
      return { name: readString(item.name, `${field}.selectedVideos[${index}].name`) };
    }),
  };
}

/** IPC 与磁盘都属于外部边界，进入应用状态前只校验当前真实使用的字段。 */
export function parseClientState(value: unknown): ClientStateSnapshot {
  if (!isRecord(value)) invalid('clientState');
  if (!Array.isArray(value.conversations) || value.conversations.length === 0) {
    invalid('clientState.conversations');
  }
  const conversations = value.conversations.map((item, index) => (
    readClientConversation(item, `clientState.conversations[${index}]`)
  ));
  const activeSessionId = readString(value.activeSessionId, 'clientState.activeSessionId');
  if (!conversations.some((conversation) => conversation.id === activeSessionId)) {
    invalid('clientState.activeSessionId');
  }
  return { conversations, activeSessionId };
}

function parseDesktopSession(value: unknown, field: string): PersistedDesktopSession {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.events)) invalid(`${field}.events`);
  if (!isRecord(value.outputFilePaths)) invalid(`${field}.outputFilePaths`);
  const outputFilePaths = Object.fromEntries(Object.entries(value.outputFilePaths).map(
    ([fileName, outputPath]) => [fileName, readString(outputPath, `${field}.outputFilePaths.${fileName}`)],
  ));
  return {
    id: readString(value.id, `${field}.id`),
    selectedVideoPaths: readStringArray(value.selectedVideoPaths, `${field}.selectedVideoPaths`),
    outputFilePaths,
    events: value.events.map((item, index) => readSessionEvent(item, `${field}.events[${index}]`)),
  };
}

export function parseDesktopState(value: unknown): PersistedDesktopState {
  if (!isRecord(value)) invalid('root');
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) invalid('sessions');
  const sessions = value.sessions.map((item, index) => parseDesktopSession(item, `sessions[${index}]`));
  const sessionIds = sessions.map((session) => session.id);
  if (new Set(sessionIds).size !== sessionIds.length) invalid('sessions.id');

  const activeSessionId = readString(value.activeSessionId, 'activeSessionId');
  const clientState = parseClientState(value.clientState);
  const clientSessionIds = clientState.conversations.map((conversation) => conversation.id);
  if (!sessionIds.includes(activeSessionId)
    || clientState.activeSessionId !== activeSessionId
    || clientSessionIds.length !== sessionIds.length
    || clientSessionIds.some((id) => !sessionIds.includes(id))) {
    invalid('activeSessionId');
  }

  return {
    activeSessionId,
    outputSequence: readNonNegativeInteger(value.outputSequence, 'outputSequence'),
    sessions,
    clientState,
  };
}

export async function loadDesktopState(filePath: string): Promise<PersistedDesktopState | null> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取本地会话：${filePath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`无法解析本地会话：${filePath}`, { cause: error });
  }
  const parsed = parseDesktopState(value);
  // 磁盘文件是真实外部边界；恢复时只还原完整事实，排除被取消或失败 Turn 的运行时残留。
  // 过滤只作用于读入结果，不改写磁盘上已经追加的历史。
  return {
    ...parsed,
    sessions: parsed.sessions.map((session) => ({
      ...session,
      events: recoverSessionEvents(session.events),
    })),
  };
}

export async function saveDesktopState(
  filePath: string,
  state: PersistedDesktopState,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
