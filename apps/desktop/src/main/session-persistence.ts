import { readFile, rename, writeFile } from 'node:fs/promises';
import type {
  AgentActivityFile,
  AgentActivityItem,
  AgentTaskOutputFile,
  AgentTaskResult,
  ClientConversation,
  ClientConversationMessage,
  ClientStateSnapshot,
  Attachment,
  AttachmentRole,
} from '@agent-desktop/client';
import type { SessionEvent } from '@agent-desktop/session';

export const SESSION_STATE_FILE_NAME = 'session-state.json';

export interface PersistedDesktopSession {
  readonly id: string;
  readonly attachments: readonly PersistedAttachment[];
  /** 会话工作目录；旧快照没有这个字段时按「尚未确认目录」读取。 */
  readonly workingDirectory?: string;
  readonly events: readonly SessionEvent[];
}

/** 持久化的输入附件：路径是身份，角色决定提示词用途。 */
export interface PersistedAttachment {
  readonly path: string;
  readonly role: AttachmentRole;
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

/** 成功结果里的产物路径；字段缺失表示这次调用没有创建交付文件。 */
function readArtifacts(value: unknown, field: string): { readonly artifacts?: readonly string[] } {
  if (value === undefined) return {};
  const artifacts = readStringArray(value, field);
  return artifacts.length === 0 ? {} : { artifacts };
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
        ? {
            status,
            ...(Object.hasOwn(value.result, 'output') ? { output: value.result.output } : invalid(`${field}.result.output`)),
            // 产物事实随成功结果持久化：它是宿主登记产物的唯一权威来源，形状不对时直接失败。
            ...readArtifacts(value.result.artifacts, `${field}.result.artifacts`),
          }
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

function readToolActivity(value: unknown, field: string): AgentActivityItem {
  if (!isRecord(value)) invalid(field);
  const status = readString(value.status, `${field}.status`);
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') invalid(`${field}.status`);
  const durationMs = value.durationMs;
  if (durationMs !== undefined
    && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid(`${field}.durationMs`);
  }
  return {
    id: readString(value.toolCallId, `${field}.toolCallId`),
    kind: 'tool',
    status,
    toolName: readString(value.toolName, `${field}.toolName`),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function readActivityFile(value: unknown, field: string): AgentActivityFile {
  if (!isRecord(value)) invalid(field);
  const role = readString(value.role, `${field}.role`);
  if (role !== 'input' && role !== 'output') invalid(`${field}.role`);
  return {
    path: readString(value.path, `${field}.path`),
    label: readString(value.label, `${field}.label`),
    role,
  };
}

function readActivityItem(value: unknown, field: string): AgentActivityItem {
  if (!isRecord(value)) invalid(field);
  const kind = readString(value.kind, `${field}.kind`);
  if (kind !== 'analysis' && kind !== 'tool') invalid(`${field}.kind`);
  const status = readString(value.status, `${field}.status`);
  if (status !== 'running' && status !== 'completed'
    && status !== 'failed' && status !== 'cancelled') {
    invalid(`${field}.status`);
  }

  const toolName = value.toolName;
  if (toolName !== undefined && typeof toolName !== 'string') invalid(`${field}.toolName`);
  const durationMs = value.durationMs;
  if (durationMs !== undefined
    && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid(`${field}.durationMs`);
  }
  const plannedToolCallCount = value.plannedToolCallCount;
  if (plannedToolCallCount !== undefined
    && (typeof plannedToolCallCount !== 'number'
      || !Number.isInteger(plannedToolCallCount) || plannedToolCallCount < 0)) {
    invalid(`${field}.plannedToolCallCount`);
  }
  const files = value.files;
  if (files !== undefined && !Array.isArray(files)) invalid(`${field}.files`);

  return {
    id: readString(value.id, `${field}.id`),
    kind,
    status,
    ...(toolName === undefined ? {} : { toolName }),
    ...(files === undefined
      ? {}
      : { files: files.map((item, index) => readActivityFile(item, `${field}.files[${index}]`)) }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(plannedToolCallCount === undefined ? {} : { plannedToolCallCount }),
  };
}

/**
 * 活动轨迹在 Commit 31 之前只保存工具活动（toolCallId/toolName/status/durationMs）。
 * 已有本机快照仍然原样恢复为 tool 活动，避免升级后拒绝启动；新快照只写 activity。
 */
function readLegacyActivity(value: unknown, field: string): readonly AgentActivityItem[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readToolActivity(item, `${field}[${index}]`));
}

function readActivity(value: unknown, field: string, legacyValue: unknown, legacyField: string): readonly AgentActivityItem[] {
  if (value === undefined) return readLegacyActivity(legacyValue, legacyField);
  if (!Array.isArray(value)) invalid(field);
  return value.map((item, index) => readActivityItem(item, `${field}[${index}]`));
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function readOutputFile(value: unknown, field: string): AgentTaskOutputFile {
  if (!isRecord(value)) invalid(field);
  return {
    path: readString(value.path, `${field}.path`),
    fileName: readString(value.fileName, `${field}.fileName`),
  };
}

/** 可选产物列表：字段缺失或为空数组时都按「没有产物」表示，读回 undefined。 */
function readOptionalOutputFiles(
  value: unknown,
  field: string,
): readonly AgentTaskOutputFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(field);
  if (value.length === 0) return undefined;
  return value.map((item, index) => readOutputFile(item, `${field}[${index}]`));
}

/**
 * 旧版产物表：按文件名索引的 `Record<fileName, path>`，随会话保存。
 * 它保存了 Commit 35 之前唯一可用的产物关系，读取时要用来还原历史产物卡。
 */
function readLegacyOutputFilePaths(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) invalid(field);
  return Object.fromEntries(Object.entries(value).map(
    ([fileName, outputPath]) => [fileName, readString(outputPath, `${field}.${fileName}`)],
  ));
}

/**
 * 读取一轮任务结果。
 * 新快照直接带 `outputFiles`；旧快照只有 `outputFileName`，路径要从所属会话的产物表里查。
 * 查不到时按「本轮没有产物」处理：宁可少一张卡，也不编造一个不存在的路径。
 */
function readTaskResult(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
): AgentTaskResult {
  if (!isRecord(value)) invalid(field);
  const outputFiles = value.outputFiles;
  if (outputFiles !== undefined && !Array.isArray(outputFiles)) invalid(`${field}.outputFiles`);
  if (outputFiles !== undefined) {
    return {
      responseText: readString(value.responseText, `${field}.responseText`),
      traceId: readString(value.traceId, `${field}.traceId`),
      ...(outputFiles.length === 0 ? {} : {
        outputFiles: outputFiles.map((item, index) => readOutputFile(item, `${field}.outputFiles[${index}]`)),
      }),
    };
  }

  const base = {
    responseText: readString(value.responseText, `${field}.responseText`),
    traceId: readString(value.traceId, `${field}.traceId`),
  };
  const outputFileName = value.outputFileName;
  if (outputFileName === undefined) return base;
  if (typeof outputFileName !== 'string') invalid(`${field}.outputFileName`);

  const path = legacyOutputFilePaths[outputFileName];
  if (path === undefined) return base;
  return { ...base, outputFiles: [{ path, fileName: outputFileName }] };
}

function readClientMessage(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
): ClientConversationMessage {
  if (!isRecord(value)) invalid(field);
  const id = readNonNegativeInteger(value.id, `${field}.id`);
  const role = readString(value.role, `${field}.role`);
  if (role === 'user') {
    const attachments = readStringArray(value.attachments, `${field}.attachments`);
    const attachmentRoles = value.attachmentRoles;
    if (attachmentRoles !== undefined && !Array.isArray(attachmentRoles)) {
      invalid(`${field}.attachmentRoles`);
    }
    const parsedRoles = attachmentRoles?.map((item, index) => (
      readAttachmentRole(item, `${field}.attachmentRoles[${index}]`)
    ));
    if (parsedRoles !== undefined && parsedRoles.length !== attachments.length) {
      invalid(`${field}.attachmentRoles`);
    }
    return {
      id,
      role,
      text: readString(value.text, `${field}.text`),
      attachments,
      ...(parsedRoles === undefined ? {} : { attachmentRoles: parsedRoles }),
    };
  }
  if (role !== 'assistant') invalid(`${field}.role`);
  const base = {
    id,
    role,
    activity: readActivity(value.activity, `${field}.activity`, value.tools, `${field}.tools`),
    activityExpanded: value.activityExpanded === undefined
      ? readBoolean(value.toolsExpanded, `${field}.toolsExpanded`)
      : readBoolean(value.activityExpanded, `${field}.activityExpanded`),
  } as const;
  const status = readString(value.status, `${field}.status`);
  if (status === 'completed') {
    return {
      ...base,
      status,
      result: readTaskResult(value.result, `${field}.result`, legacyOutputFilePaths),
    };
  }
  // 失败与取消分支可以带已成功的产物；字段缺失表示本轮没有产出。
  const outputFiles = readOptionalOutputFiles(value.outputFiles, `${field}.outputFiles`);
  if (status === 'failed') {
    return {
      ...base,
      status,
      errorMessage: readString(value.errorMessage, `${field}.errorMessage`),
      ...(outputFiles === undefined ? {} : { outputFiles }),
    };
  }
  if (status === 'cancelled') {
    return { ...base, status, ...(outputFiles === undefined ? {} : { outputFiles }) };
  }
  return invalid(`${field}.status`);
}

/**
 * 会话的输入附件展示状态。
 * 新格式带 path 与 role；旧快照只有 selectedVideos（那时唯一的附件语义就是视频），
 * 没有可还原的路径，因此用空 path 表示「只有名称可展示」，不编造一个磁盘位置。
 */
function readClientAttachments(value: Record<string, unknown>, field: string): readonly Attachment[] {
  const attachments = value.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) invalid(`${field}.attachments`);
    return attachments.map((item, index) => {
      if (!isRecord(item)) invalid(`${field}.attachments[${index}]`);
      return {
        path: readString(item.path, `${field}.attachments[${index}].path`),
        name: readString(item.name, `${field}.attachments[${index}].name`),
        role: readAttachmentRole(item.role, `${field}.attachments[${index}].role`),
      };
    });
  }

  const legacyVideos = value.selectedVideos;
  if (!Array.isArray(legacyVideos)) return [];
  return legacyVideos.map((item, index) => {
    if (!isRecord(item)) invalid(`${field}.selectedVideos[${index}]`);
    return {
      path: '',
      name: readString(item.name, `${field}.selectedVideos[${index}].name`),
      role: 'video' as const,
    };
  });
}

function readClientConversation(
  value: unknown,
  field: string,
  legacyOutputFilePaths: Readonly<Record<string, string>>,
): ClientConversation {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.messages)) invalid(`${field}.messages`);
  // 界面副本里的工作目录只是展示值；权威事实在会话侧，恢复时按会话事实重建。
  const workingDirectory = value.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
    invalid(`${field}.workingDirectory`);
  }
  return {
    id: readString(value.id, `${field}.id`),
    title: readString(value.title, `${field}.title`),
    titleManuallyRenamed: value.titleManuallyRenamed === undefined
      ? false
      : typeof value.titleManuallyRenamed === 'boolean'
        ? value.titleManuallyRenamed
        : invalid(`${field}.titleManuallyRenamed`),
    messages: value.messages.map((item, index) => (
      readClientMessage(item, `${field}.messages[${index}]`, legacyOutputFilePaths)
    )),
    prompt: readString(value.prompt, `${field}.prompt`),
    attachments: readClientAttachments(value, field),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

/**
 * IPC 与磁盘都属于外部边界，进入应用状态前只校验当前真实使用的字段。
 * 传入按会话查询旧产物表的函数：旧快照的产物路径存在会话侧，客户端消息只记文件名。
 */
export function parseClientState(
  value: unknown,
  legacyOutputFilePathsFor: (sessionId: string) => Readonly<Record<string, string>> = () => ({}),
): ClientStateSnapshot {
  if (!isRecord(value)) invalid('clientState');
  if (!Array.isArray(value.conversations) || value.conversations.length === 0) {
    invalid('clientState.conversations');
  }
  const conversations = value.conversations.map((item, index) => (
    readClientConversation(
      item,
      `clientState.conversations[${index}]`,
      isRecord(item) && typeof item.id === 'string' ? legacyOutputFilePathsFor(item.id) : {},
    )
  ));
  const activeSessionId = readString(value.activeSessionId, 'clientState.activeSessionId');
  if (!conversations.some((conversation) => conversation.id === activeSessionId)) {
    invalid('clientState.activeSessionId');
  }
  return { conversations, activeSessionId };
}

function readAttachmentRole(value: unknown, field: string): AttachmentRole {
  const role = readString(value, field);
  if (role !== 'video' && role !== 'audio') invalid(field);
  return role;
}

/**
 * 会话输入附件。
 * 新格式直接带 role；Commit 37 之前的快照只有 selectedVideoPaths，那时唯一的附件语义就是视频，
 * 因此全部按 video 换算。两者都不存在时按空附件读取。
 */
function readAttachments(value: Record<string, unknown>, field: string): readonly PersistedAttachment[] {
  const attachments = value.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) invalid(`${field}.attachments`);
    return attachments.map((item, index) => {
      if (!isRecord(item)) invalid(`${field}.attachments[${index}]`);
      return {
        path: readString(item.path, `${field}.attachments[${index}].path`),
        role: readAttachmentRole(item.role, `${field}.attachments[${index}].role`),
      };
    });
  }

  const legacyVideoPaths = value.selectedVideoPaths;
  if (legacyVideoPaths === undefined) return [];
  return readStringArray(legacyVideoPaths, `${field}.selectedVideoPaths`)
    .map((path) => ({ path, role: 'video' as const }));
}

function parseDesktopSession(
  value: unknown,
  field: string,
): { readonly session: PersistedDesktopSession; readonly legacyOutputFilePaths: Readonly<Record<string, string>> } {
  if (!isRecord(value)) invalid(field);
  if (!Array.isArray(value.events)) invalid(`${field}.events`);
  const workingDirectory = value.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
    invalid(`${field}.workingDirectory`);
  }
  return {
    session: {
      id: readString(value.id, `${field}.id`),
      attachments: readAttachments(value, field),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      events: value.events.map((item, index) => readSessionEvent(item, `${field}.events[${index}]`)),
    },
    // 旧快照带按文件名索引的产物表；新快照没有，用空表表示「没有可还原的旧关联」。
    legacyOutputFilePaths: value.outputFilePaths === undefined
      ? {}
      : readLegacyOutputFilePaths(value.outputFilePaths, `${field}.outputFilePaths`),
  };
}

export function parseDesktopState(value: unknown): PersistedDesktopState {
  if (!isRecord(value)) invalid('root');
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) invalid('sessions');
  const parsedSessions = value.sessions.map((item, index) => parseDesktopSession(item, `sessions[${index}]`));
  const sessions = parsedSessions.map((parsed) => parsed.session);
  const sessionIds = sessions.map((session) => session.id);
  if (new Set(sessionIds).size !== sessionIds.length) invalid('sessions.id');

  const activeSessionId = readString(value.activeSessionId, 'activeSessionId');
  // 会话先于 Client 状态解析：旧快照把产物路径存在会话的产物表里，客户端消息要用它还原历史产物卡。
  const legacyOutputFilePathsBySession = new Map(
    parsedSessions.map((parsed) => [parsed.session.id, parsed.legacyOutputFilePaths]),
  );
  const clientState = parseClientState(
    value.clientState,
    (sessionId) => legacyOutputFilePathsBySession.get(sessionId) ?? {},
  );
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
  // 磁盘历史是 append-only 事实：恢复原样读入全部事件，未完成 Step 只在重建 Model Context 时由 Session 的权威规则排除。
  return parseDesktopState(value);
}

/**
 * 先写同目录临时文件再整体替换。
 * 关闭时进程可能在写入过程中退出，直接写目标文件会把已有历史截断成空文件或半份 JSON。
 */
export async function saveDesktopState(
  filePath: string,
  state: PersistedDesktopState,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}
