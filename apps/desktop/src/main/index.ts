import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '@agent-desktop/execution-trace';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import { SessionPersistenceError, TurnCancellationError, projectRecoveryAncestry, projectRecoveryFacts, projectTurnState, type SessionEvent, type TurnId } from '@agent-desktop/session';
import { createVideoAgent } from '@agent-desktop/video-agent';
import { generateConversationTitle } from './conversation-title.js';
import {
  findLatestTurnId,
  findTurnArtifacts,
  buildAgentPrompt,
  projectTurnOutputs,
  runDesktopAgentTask,
  type TurnArtifact,
} from './agent-task.js';
import { prepareTurnStart } from '@agent-desktop/agent-loop';
import {
  assertRevealableFile,
  findCommandText,
  isSessionFilePath,
  projectAgentActivity,
  projectAgentActivityDetail,
} from './agent-activity.js';
import { CommandOutputProjection, createCommandPort } from './command-host.js';
import { FFMPEG_TOOLS, authorizeVideoDeliveryTool } from './ffmpeg-tool.js';
import { WHISPER_TOOLS } from './whisper-tool.js';
import { verifyWhisperRuntime } from './whisper-runtime.js';
import { ToolApprovalGate } from './tool-approval.js';
import { reviewApproval } from './approval-review.js';
import { UserQuestionGate } from './user-question.js';
import { runReadOnlySubagent, type SubagentRecord } from './subagent.js';
import { SessionTerminal, terminalPortFor } from './terminal-host.js';
import {
  DESKTOP_CHANNELS,
  type AgentRuntimeEvent,
  type AgentTaskIpcResult,
} from '../shared/ipc.js';
import {
  loadDesktopState,
  DesktopPersistentSession,
  parseClientState,
  parseDesktopState,
  parsePermissionMode,
  saveDesktopState,
  type PersistedDesktopState,
  type TurnMessageBinding,
} from './session-persistence.js';
import type {
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  AttachmentRole,
  ClientAssistantMessage,
  ClientStateSnapshot,
  PermissionMode,
} from '@agent-desktop/client';
import type { OutputItemResult } from '@agent-desktop/video-agent';
import {
  loadRuntimeConfiguration,
  loadRuntimeSettings,
  parseRuntimeSettingsUpdate,
  saveRuntimeSettings,
  listProviderModels,
  parseProviderQuery,
} from './runtime-settings.js';
import { DESKTOP_DATABASE_FILE_NAME } from './desktop-database.js';
import { deleteMemories, loadMemories } from './memory.js';
import { SaveMemoryTool } from './memory-tool.js';
import { migrateLegacyDesktopFiles } from './legacy-storage-migration.js';
import { DesktopExtensions } from './extensions.js';
import { prepareExtensions } from './extension-runtime.js';
import { ExtensionConnections } from './extension-connections.js';
import { InMemoryToolRegistry, UpdatePlanTool } from '@agent-desktop/tools';
import { projectAgentTaskState, qualifyTaskToolEvidence, taskToolGate } from './agent-task-state.js';
import { DesktopUpdater } from './app-updater.js';
import { VerifyToolOutcomeTool } from './verify-tool.js';

let mainWindow: BrowserWindow | null = null;
let isTaskRunning = false;
let persistenceFailure: SessionPersistenceError | undefined;
let isExtensionChanging = false;
let desktopUpdater: DesktopUpdater | undefined;
let updatePrepared = false;

/** 复制和卸载跨越异步文件操作，期间不能开启使用同一目录的新任务。 */
async function changeExtensions<T>(operation: () => Promise<T>): Promise<T> {
  if (desktopUpdater?.state.status === 'installing') throw new Error('正在安装更新，无法修改扩展。');
  if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
  if (isExtensionChanging) throw new Error('扩展操作正在进行。');
  isExtensionChanging = true;
  try { return await operation(); }
  finally { isExtensionChanging = false; }
}
let activeTask: {
  readonly sessionId: string;
  readonly controller: AbortController;
  /** 关闭收尾必须等这一轮真正结束，才能提交完成或取消后的终态。 */
  readonly finished: Promise<void>;
  terminalTouched: boolean;
} | undefined;
// 正在执行关闭收尾的窗口：同一窗口重复关闭时不重复进入收尾流程。
const closingWindows = new WeakSet<BrowserWindow>();
let clientState: ClientStateSnapshot | null = null;
let isClientCloseReady = false;

interface DesktopSessionState {
  /** 启动事件只在本次宿主创建或恢复会话后消费一次，不随每轮重复执行。 */
  pendingSessionStart?: 'startup' | 'resume';
  terminal?: SessionTerminal;
  terminalHistory?: import('@agent-desktop/client').TerminalSnapshot;
  readonly subagentHistory: SubagentRecord[];
  readonly session: DesktopPersistentSession;
  /** 当前会话的输入附件；角色决定提示词把它当主视频还是音轨。 */
  readonly attachments: SelectedAttachment[];
  /**
   * 当前会话已经用户确认的工作目录；相对路径以它为基准。
   * 它与附件互相独立：选择附件不会改变工作目录，目录也不会被最后一次附件选择覆盖。
   */
  workingDirectory?: string;
  /** 当前聊天的审批策略；未选择时采用请求批准模式。 */
  permissionMode?: PermissionMode;
}

/** 宿主侧的附件：路径是身份，角色决定用途。 */
interface SelectedAttachment {
  readonly path: string;
  readonly role: AttachmentRole;
}

const sessions = new Map<string, DesktopSessionState>();
let activeSessionId = '';

/** 创建独立的 Session、附件和产物状态；Agent 只在用户 Turn 开始时创建。 */
function createDesktopSession(
  id: string = randomUUID(),
  initialEvents?: readonly SessionEvent[],
  initialBindings: readonly TurnMessageBinding[] = [],
): string {
  const sessionId = id;
  const session = {
    session: new DesktopPersistentSession(
      persistenceFilePath(), sessionId, initialEvents ?? [],
      (replacementId, events, bindings, startedClientState) => {
        const snapshot = startedClientState ?? clientState ?? {
          activeSessionId,
          conversations: [...sessions.keys()].map(id => ({ id, title: '', titleManuallyRenamed: false, messages: [], prompt: '', attachments: [] })),
          drafts: [],
        } satisfies ClientStateSnapshot;
        return currentPersistedState(snapshot, { id: replacementId, events, bindings });
      },
      (error) => { if (persistenceFailure === undefined) persistenceFailure = error; },
      initialBindings,
    ),
    pendingSessionStart: initialEvents === undefined ? 'startup' : 'resume',
    attachments: [],
    subagentHistory: [],
  } satisfies DesktopSessionState;
  sessions.set(id, session);
  activeSessionId = id;
  return id;
}

function persistenceFilePath(): string {
  return join(app.getPath('userData'), DESKTOP_DATABASE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 找到重启前终端的 open/input 调用；每个调用都必须单独保留未解决事实。 */
function terminalRestartSourceIndexes(events: readonly SessionEvent[], terminalId: string): readonly number[] {
  const preparedSources: number[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool.effect.prepared' || !isRecord(event.data)
      || event.data.kind !== 'terminal' || event.data.terminalId !== terminalId
      || (event.data.operation !== 'open' && event.data.operation !== 'input')) continue;
    const source = events[event.sourceEventIndex];
    if (source?.type === 'tool.called' && (source.name === 'open_terminal' || source.name === 'write_terminal')) {
      preparedSources.push(event.sourceEventIndex);
    }
  }
  if (preparedSources.length > 0) return [...new Set(preparedSources)];

  // 旧历史没有检查点时，只按工具结果中宿主生成的 terminalId 做机械匹配。
  const legacySources: number[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool.called' || (event.name !== 'open_terminal' && event.name !== 'write_terminal')) continue;
    const result = events.find((candidate) => candidate.type === 'tool.result'
      && candidate.turnId === event.turnId && candidate.stepId === event.stepId && candidate.toolCallId === event.toolCallId);
    if (result?.type !== 'tool.result' || result.result.status !== 'success' || !isRecord(result.result.output)
      || result.result.output.terminalId !== terminalId) continue;
    legacySources.push(index);
  }
  return legacySources;
}

function hasEntireTerminalVerification(events: readonly SessionEvent[], sourceEventIndex: number): boolean {
  return events.some((event) => event.type === 'effect.outcome.verified'
    && event.sourceEventIndex === sourceEventIndex && event.scope === 'entire-call');
}

function terminalRestartFacts(session: DesktopSessionState): readonly SessionEvent[] {
  const history = session.terminalHistory;
  if (history?.status !== 'running') return [];
  const events = session.session.events();
  const allSourceIndexes = terminalRestartSourceIndexes(events, history.terminalId);
  const sourceIndexes = allSourceIndexes.filter((sourceEventIndex) => !hasEntireTerminalVerification(events, sourceEventIndex));
  if (allSourceIndexes.length > 0) {
    return sourceIndexes.map((sourceEventIndex) => {
      const source = events[sourceEventIndex];
      if (source?.type !== 'tool.called') throw new Error('终端恢复来源不是工具调用。');
      return {
        type: 'effect.outcome.verified' as const,
        turnId: source.turnId,
        sourceEventIndex,
        scope: 'entire-call' as const,
        outcome: 'unresolved' as const,
        evidence: { source: 'host' as const, reference: `terminal:${history.terminalId}`, description: '应用重启后失去终端连接，命令效果和进程状态未确认。' },
      };
    });
  }

  // 旧快照没有可关联的调用来源时，使用已有 terminalId 建立一次明确的宿主观察。
  // 不能按命令文字猜测原调用，也不能把观察绑定到另一个工具调用。
  const existingObservation = events.some((event) => {
    if (event.type !== 'effect.outcome.verified' || event.scope !== 'entire-call'
      || event.evidence.source !== 'host' || event.evidence.reference !== `terminal:${history.terminalId}`) return false;
    const source = events[event.sourceEventIndex];
    return source?.type === 'host.operation.started' && source.operation === 'terminal-connection-lost';
  });
  if (existingObservation) return [];
  // 独立观察身份只用于三个宿主事实配对，不伪造旧任务、用户消息或工具归属。
  const turnId = randomUUID() as TurnId;
  const sourceEventIndex = events.length;
  return [
    { type: 'host.operation.started', turnId, operation: 'terminal-connection-lost', description: '应用重启后失去终端连接，命令效果和进程状态未确认。' },
    { type: 'host.operation.result', turnId, sourceEventIndex, status: 'failed', errorName: 'TerminalConnectionLost', errorMessage: '旧终端没有可关联的工具调用来源。' },
    { type: 'effect.outcome.verified', turnId, sourceEventIndex, scope: 'entire-call', outcome: 'unresolved',
      evidence: { source: 'host', reference: `terminal:${history.terminalId}`, description: '应用重启后失去终端连接，命令效果和进程状态未确认。' } },
  ];
}

let desktopExtensions: DesktopExtensions | undefined;
let pluginConnections: ExtensionConnections | undefined;
function connectionStore(): ExtensionConnections { return pluginConnections ??= new ExtensionConnections(persistenceFilePath(), safeStorage, url => shell.openExternal(url)); }
function extensionStore(): DesktopExtensions {
  return desktopExtensions ??= new DesktopExtensions(persistenceFilePath(), join(app.getPath('userData'), 'extensions'), join(app.getAppPath(), 'resources'), connectionStore(), () => mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged));
}

async function watchCurrentSkills(): Promise<void> {
  await extensionStore().watchSkills(activeSession().workingDirectory,
    () => mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged),
    error => dialog.showErrorBox('无法监视技能文件', error.message));
}

function extensionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('扩展标识无效。');
  return value;
}

function currentPersistedState(snapshot: ClientStateSnapshot, replacement?: { readonly id: string; readonly events: readonly SessionEvent[]; readonly bindings: readonly TurnMessageBinding[] }): PersistedDesktopState {
  return {
    activeSessionId,
    sessions: [...sessions].map(([id, session]) => ({
      id,
      attachments: session.attachments,
      ...(session.workingDirectory === undefined ? {} : { workingDirectory: session.workingDirectory }),
      ...(session.permissionMode === undefined ? {} : { permissionMode: session.permissionMode }),
      events: replacement?.id === id ? replacement.events : session.session.events(),
      turnMessageBindings: replacement?.id === id ? replacement.bindings : session.session.turnMessageBindings(),
      ...(session.terminalHistory === undefined ? {} : { terminalHistory: session.terminalHistory }),
      ...(session.subagentHistory.length === 0 ? {} : { subagentHistory: session.subagentHistory }),
    })),
    clientState: snapshot,
  };
}

/** Renderer 可能在收到最终 IPC 前崩溃；用已有 Session 终态补回缺失的 Assistant 结果，不重新执行任务。 */
function reconcileRecoveredClientState(snapshot: ClientStateSnapshot): ClientStateSnapshot {
  const reconcile = (conversation: ClientStateSnapshot['conversations'][number]) => {
    const session = sessions.get(conversation.id);
    if (session === undefined) return conversation;
    // Renderer 只保存展示副本，不能用旧快照改写宿主已确认的权限方式。
    const { permissionMode: _staleMode, ...rest } = conversation;
    conversation = { ...rest, ...(session.permissionMode === undefined ? {} : { permissionMode: session.permissionMode }) };
    const events = session.session.events();
    const bindings = session.session.turnMessageBindings();
    // 旧历史没有明确关联时保持原展示，不按相同文字或消息顺序猜测 Turn。
    if (bindings.length === 0) return conversation;
    const messages = [...conversation.messages];
    let changed = false;
    for (const binding of bindings) {
      const assistantIndex = messages.findIndex(message => message.id === binding.assistantMessageId && message.role === 'assistant');
      if (assistantIndex < 0) throw new Error('已提交任务的助手消息身份缺失。');
      const user = { turnId: binding.turnId };
      const state = projectTurnState(events, binding.turnId);
      if (state !== 'completed' && state !== 'failed' && state !== 'cancelled' && state !== 'interrupted') continue;
      const original = messages[assistantIndex];
      if (original?.role !== 'assistant') throw new Error('任务消息身份不是助手。');
      const taskState = projectAgentTaskState(events, user.turnId);
      const filesFound = toOutputFiles(findTurnArtifacts(events, user.turnId));
      const files = filesFound.length === 0 ? undefined : filesFound;
      const outputFacts = projectTurnOutputs(events, user.turnId).map(toClientOutputResult);
      const outputs = outputFacts.length === 0 ? undefined : outputFacts;
      const final = [...events].reverse().find((event): event is Extract<SessionEvent, { type: 'assistant.message' }> =>
        event.type === 'assistant.message' && event.turnId === user.turnId && event.toolCalls.length === 0 && event.content !== undefined);
      let recovered: ClientAssistantMessage;
      if (state === 'completed' && final !== undefined) {
        // 正常结果的诊断与命名信息没有对应 Session 事件；只补执行事实，不抹掉这些已保存元数据。
        const resultMetadata = original.status === 'completed'
          ? { traceId: original.result.traceId,
            ...(original.result.conversationTitle === undefined ? {} : { conversationTitle: original.result.conversationTitle }),
            ...(original.result.conversationTitleError === undefined ? {} : { conversationTitleError: original.result.conversationTitleError }) }
          : { traceId: `recovered:${user.turnId}` };
        recovered = { id: binding.assistantMessageId, role: 'assistant', status: 'completed', activity: original.activity, activityExpanded: original.activityExpanded,
          taskState, result: { ...resultMetadata, responseText: final.content!, taskState,
            ...(files === undefined ? {} : { outputFiles: files }), ...(outputs === undefined ? {} : { outputs }) } };
      } else if (state === 'cancelled') {
        recovered = { id: binding.assistantMessageId, role: 'assistant', status: 'cancelled', activity: original.activity, activityExpanded: original.activityExpanded, taskState,
          ...(files === undefined ? {} : { outputFiles: files }), ...(outputs === undefined ? {} : { outputs }) };
      } else {
        const failure = [...events].reverse().find(event => event.turnId === user.turnId && event.type === 'turn.failed');
        recovered = { id: binding.assistantMessageId, role: 'assistant', status: 'failed', activity: original.activity, activityExpanded: original.activityExpanded, taskState,
          errorMessage: failure?.type === 'turn.failed' ? failure.errorMessage : '应用退出时任务被中断。',
          ...(files === undefined ? {} : { outputFiles: files }), ...(outputs === undefined ? {} : { outputs }) };
      }
      messages[assistantIndex] = recovered;
      changed = true;
    }
    return changed ? { ...conversation, messages } : conversation;
  };
  return {
    ...snapshot,
    conversations: snapshot.conversations.map(reconcile),
    ...(snapshot.drafts === undefined ? {} : { drafts: snapshot.drafts.map(reconcile) }),
  };
}

/** 启动时只将已原子绑定且没有终态的新版轮次标为异常中断。 */
function interruptRecoveredTurns(session: DesktopSessionState): void {
  const events = session.session.events();
  // 只处理中明确原子保存过的新版本任务；旧未结束历史没有进程退出证据。
  const startedTurns = session.session.turnMessageBindings().map(binding => binding.turnId);
  const interrupted = startedTurns
    .filter(turnId => projectTurnState(events, turnId) === 'started')
    .map(turnId => ({ type: 'turn.interrupted' as const, turnId, reason: 'process-exit' as const }));
  if (interrupted.length > 0) session.session.appendMany(interrupted);
}

async function restoreDesktopState(): Promise<void> {
  const persisted = await loadDesktopState(persistenceFilePath());
  sessions.clear();
  if (persisted === null) {
    createDesktopSession();
    return;
  }

  clientState = persisted.clientState;
  for (const savedSession of persisted.sessions) {
    createDesktopSession(savedSession.id, savedSession.events, savedSession.turnMessageBindings);
    const session = sessions.get(savedSession.id)!;
    session.attachments.push(...savedSession.attachments);
    session.subagentHistory.push(...savedSession.subagentHistory ?? []);
    if (savedSession.permissionMode !== undefined) session.permissionMode = savedSession.permissionMode;
    if (savedSession.terminalHistory !== undefined) session.terminalHistory = savedSession.terminalHistory;
    if (savedSession.workingDirectory !== undefined) {
      session.workingDirectory = savedSession.workingDirectory;
    }
  }
  activeSessionId = persisted.activeSessionId;
  // 先固定异常退出事实，再重建客户端消息和恢复入口；启动不会重放任何终端或工具调用。
  for (const session of sessions.values()) interruptRecoveredTurns(session);

  // 终端原始 running 状态留在持久化事实中；disconnected 只用于没有活句柄的展示。
  for (const session of sessions.values()) {
    const facts = terminalRestartFacts(session);
    if (facts.length > 0) session.session.appendMany(facts);
  }

  // 会话侧附件与工作目录是权威事实（旧快照在这里被换算成带 role 的形状）。
  // 快照里的界面副本可能来自更旧的格式（只有名称、没有真实路径），
  // 因此按会话事实重建一次，避免界面拿着无法定位的空路径或过期目录。
  // `workingDirectory` 必须先摘掉再按会话事实放回：会话里没有目录时，
  // 用条件展开（缺键）会把快照里的旧目录留在副本里，错误状态会跨重启存活。
  const restoreConversation = (conversation: ClientStateSnapshot['conversations'][number]) => {
      const session = sessions.get(conversation.id);
      if (session === undefined) return conversation;
      const { workingDirectory: _staleDirectory, terminalHistory: _staleTerminal, ...rest } = conversation;
      return {
        ...rest,
        attachments: toClientAttachments(session.attachments),
        ...(session.terminalHistory === undefined ? {} : { terminalHistory: session.terminalHistory.status === 'running' ? { ...session.terminalHistory, status: 'disconnected' as const } : session.terminalHistory }),
        ...(session.workingDirectory === undefined
          ? {}
          : { workingDirectory: session.workingDirectory }),
      };
    };
  clientState = {
    ...clientState,
    conversations: clientState.conversations.map(restoreConversation),
    ...(clientState.drafts === undefined ? {} : { drafts: clientState.drafts.map(restoreConversation) }),
  };
  clientState = reconcileRecoveredClientState(clientState);
  // 将异常中断、终端断开事实及重建后的客户端状态一起固定到最终快照。
  for (const session of sessions.values()) {
    if (session.session instanceof DesktopPersistentSession) session.session.persist();
  }
}

function activeSession(): DesktopSessionState {
  return sessions.get(activeSessionId)!;
}

function persistSessionResourceState(sessionId: string): void {
  const session = sessions.get(sessionId)?.session;
  if (!(session instanceof DesktopPersistentSession)) return;
  try { session.persist(); }
  catch (error) {
    const failure = error instanceof SessionPersistenceError ? error : new SessionPersistenceError(error);
    persistenceFailure ??= failure;
    if (activeTask?.sessionId === sessionId) activeTask.controller.abort(failure);
  }
}

/** 当前真实支持的主输入格式；与文件对话框过滤器保持同一份来源。 */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
/** 当前唯一有已注册工具消费者（add_audio）的音轨格式。 */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];

/**
 * 按扩展名判定附件角色。
 * 未识别的扩展名按视频处理：文件对话框只允许这两类扩展名，因此不会出现无角色输入；
 * 这里不新增第三种「未知」角色，避免为不存在的消费者预留状态。
 */
function attachmentRole(filePath: string): AttachmentRole {
  const extension = parse(filePath).ext.toLowerCase().replace('.', '');
  return AUDIO_EXTENSIONS.includes(extension) ? 'audio' : 'video';
}

/** 传给 Renderer 的附件视图：附上展示名，路径仍是身份。 */
function toClientAttachments(attachments: readonly SelectedAttachment[]) {
  return attachments.map((attachment) => ({
    path: attachment.path,
    name: basename(attachment.path),
    role: attachment.role,
  }));
}

/** 沿现有 desktop:agent-event 通道把运行期事件推给 Renderer。 */
function sendAgentEvent(event: AgentRuntimeEvent): void {
  if (mainWindow?.isDestroyed() === false) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.agentEvent, event);
  }
}

/** 计划及任务状态只从会话事实生成，模型声明和渲染层副本不决定完成。 */
function sendTaskState(sessionId: string): void {
  const events = sessions.get(sessionId)!.session.events();
  const turnId = findLatestTurnId(events);
  if (turnId === undefined) return;
  const state = projectAgentTaskState(events, turnId);
  if (state !== undefined) sendAgentEvent({ type: 'task.state', sessionId, taskState: state });
}

/** 宿主阶段也进入同一 Session 事实链，失败时保留 started 及真实错误。 */
async function runHostOperation<T>(
  session: DesktopSessionState,
  turnId: TurnId,
  operation: string,
  description: string,
  action: () => Promise<T>,
): Promise<T> {
  const sourceEventIndex = session.session.events().length;
  session.session.append({ type: 'host.operation.started', turnId, operation, description });
  try {
    const result = await action();
    session.session.append({ type: 'host.operation.result', turnId, sourceEventIndex, status: 'completed' });
    return result;
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw error;
    if (!(error instanceof Error)) throw error;
    session.session.append({ type: 'host.operation.result', turnId, sourceEventIndex,
      status: error.name === 'AbortError' ? 'cancelled' : 'failed', errorName: error.name, errorMessage: error.message });
    throw error;
  }
}

/**
 * 窗口持有的唯一待决审批。
 * 待决请求经同一个运行期事件通道推给 Client，答复由 decideApproval 通道回到这里。
 */
const approvalGate = new ToolApprovalGate((request) => {
  sendAgentEvent({ type: 'approval.requested', request });
});
const questionGate = new UserQuestionGate((request) => sendAgentEvent({ type: 'question.requested', request }));

/**
 * 窗口持有的命令实时输出投影。
 * 它把命令输出按约 50 毫秒一批推给 Client；进度只用于实时展示，不写入 Session 和 Trace。
 */
const commandOutput = new CommandOutputProjection((activityId, detail) => {
  sendAgentEvent({ type: 'activity.detail', activityId, detail });
});

/**
 * 会话工作目录端口：目录事实存在会话状态里，工具只通过它读写。
 * 工具自己不做权限判断，也不缓存目录——它每次调用都读同一份会话状态。
 */
function workspacePortFor(sessionId: string): WorkspacePort {
  return {
    ...(sessions.get(sessionId)?.permissionMode === 'full-access' ? { fileAccess: 'all' as const } : {}),
    confirmedDirectory: () => sessions.get(sessionId)?.workingDirectory,
    requestApproval: (target, signal) => approvalGate.request(target, signal),
    confirmDirectory: (directory) => {
      const session = sessions.get(sessionId);
      // 会话在任务执行期间不能被删除，因此这里一定拿得到同一个会话。
      if (session === undefined) throw new Error('会话已不存在，无法记录工作目录。');
      session.workingDirectory = directory;
      // 目录事实在**确认之后**才发布：界面不在提交审批决定时提前写入，
      // 否则一个已经失效的审批会在界面上留下一个从未被确认的目录。
      sendAgentEvent({ type: 'workspace.confirmed', workingDirectory: directory });
    },
  };
}

/**
 * 把一次 Trace 事件投影成界面活动。
 * 耗时、状态和模型步骤来自 Trace，真实文件引用来自 Session 事实；Trace 日志本身不增加工具内容。
 */
function sendActivity(traceEvent: ExecutionTraceEvent, sessionEvents: readonly SessionEvent[]): void {
  const item = projectAgentActivity(traceEvent, sessionEvents);
  if (item === undefined) return;
  sendAgentEvent({ type: 'activity', item });
}

/** 产物身份是真实路径；文件名只是给界面看的标签，因此同名不同目录可以并存。 */
function toOutputFiles(artifacts: readonly TurnArtifact[]): readonly AgentTaskOutputFile[] {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    fileName: basename(artifact.path),
  }));
}

/** 返回本次调用新开始的 Turn 已成功产物；调用前的历史 Turn 不属于本次失败。 */
function succeededOutputFiles(
  events: readonly SessionEvent[],
  firstTaskEventIndex: number,
): readonly AgentTaskOutputFile[] | undefined {
  const turnId = findLatestTurnId(events.slice(firstTaskEventIndex));
  if (turnId === undefined) return undefined;
  const outputFiles = toOutputFiles(findTurnArtifacts(events, turnId));
  return outputFiles.length === 0 ? undefined : outputFiles;
}

/** 本轮新开始 Turn 的逐项交付结果；没有声明过输出项时返回 undefined（不适用）。 */
function turnOutputResults(
  events: readonly SessionEvent[],
  firstTaskEventIndex: number,
): readonly AgentTaskOutputItemResult[] | undefined {
  const turnId = findLatestTurnId(events.slice(firstTaskEventIndex));
  if (turnId === undefined) return undefined;
  const outputs = projectTurnOutputs(events, turnId).map(toClientOutputResult);
  return outputs.length === 0 ? undefined : outputs;
}

/**
 * 把应用层的逐项结果投影成界面可序列化的形状。
 * 界面不重新计算状态；这里只补上展示用的文件名，路径仍是身份。
 */
function toClientOutputResult(result: OutputItemResult): AgentTaskOutputItemResult {
  if (result.status !== 'published') {
    return { outputItemId: result.outputItemId, status: result.status, reason: result.reason };
  }
  return {
    outputItemId: result.outputItemId,
    status: 'published',
    path: result.output.path,
    fileName: basename(result.output.path),
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.getUpdateState, () => desktopUpdater?.state ?? { status: 'idle' });
  ipcMain.handle(DESKTOP_CHANNELS.retryUpdate, async () => {
    if (desktopUpdater === undefined) throw new Error('开发模式不支持安装更新。');
    await desktopUpdater.check();
  });
  ipcMain.handle(DESKTOP_CHANNELS.installUpdate, async () => {
    if (desktopUpdater === undefined) throw new Error('开发模式不支持安装更新。');
    if (isTaskRunning || isExtensionChanging) throw new Error('请等待当前任务或扩展操作完成后安装更新。');
    const window = mainWindow!;
    if (!isClientCloseReady || closingWindows.has(window)) throw new Error('窗口尚未就绪或正在关闭，无法安装更新。');
    await desktopUpdater.install(async () => {
      updatePrepared = false;
      const failure = await prepareWindowClose(window);
      if (failure !== null) throw new Error(`无法保存本地会话：${failure}`);
      updatePrepared = true;
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.closeTerminal, async (_event, id: unknown) => {
    const terminal = activeSession().terminal;
    if (typeof id !== 'string' || terminal?.terminalId !== id) throw new Error('终端不属于当前会话。');
    await terminal.close();
  });
  ipcMain.handle(DESKTOP_CHANNELS.resizeTerminal, (_event, id: unknown, cols: unknown, rows: unknown) => {
    const terminal = activeSession().terminal;
    if (typeof id !== 'string' || terminal?.terminalId !== id) throw new Error('终端不属于当前会话。');
    if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows)
      || cols < 20 || cols > 300 || rows < 5 || rows > 100) throw new Error('终端尺寸无效。');
    terminal.resize(cols, rows);
  });
  ipcMain.handle(DESKTOP_CHANNELS.answerQuestion, (_event, requestId: unknown, answer: unknown) => {
    if (typeof requestId !== 'string' || activeTask === undefined) throw new Error('该问题已失效。');
    const turnId = findLatestTurnId(activeSession().session.events());
    if (turnId === undefined) throw new Error('该问题已失效。');
    questionGate.answer(requestId, activeTask.sessionId, turnId, answer);
  });
  ipcMain.handle(DESKTOP_CHANNELS.listExtensions, async () => { await watchCurrentSkills(); return extensionStore().list(activeSession().workingDirectory); });
  ipcMain.handle(DESKTOP_CHANNELS.manageExtensions, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('action' in request)) throw new Error('扩展管理请求无效。');
    const value = request as Record<string, unknown>; const store = extensionStore();
    // 技能文件操作不改安装状态；由宿主按技能身份解析实际路径和正文。
    if (value.action === 'open-skill' || value.action === 'reveal-skill' || value.action === 'copy-skill') {
      const id = extensionId(value.id);
      if (value.action === 'copy-skill') await clipboard.writeText(await store.readSkill(id, activeSession().workingDirectory));
      else {
        const path = await store.skillPath(id, activeSession().workingDirectory);
        if (value.action === 'reveal-skill') shell.showItemInFolder(path);
        else { const error = await shell.openPath(path); if (error !== '') throw new Error(error); }
      }
      return store.list(activeSession().workingDirectory);
    }
    // 等待授权本身持有修改门禁；取消必须能越过它，让原操作释放门禁。
    if (value.action === 'cancel-connect') { connectionStore().cancel(extensionId(value.id), extensionId(value.server)); return store.list(activeSession().workingDirectory); }
    return changeExtensions(async () => {
      switch (value.action) {
        case 'install-whisper-model': await store.whisperModels.install(); break;
        case 'delete-whisper-model': await store.whisperModels.delete(); break;
        case 'import-whisper-model': {
          const selected = await dialog.showOpenDialog({ title: '选择 Whisper Small 模型', properties: ['openFile'], filters: [{ name: 'Whisper 模型', extensions: ['bin'] }] });
          if (selected.canceled || selected.filePaths[0] === undefined) return null;
          await store.whisperModels.install(selected.filePaths[0]);
          break;
        }
        case 'save-mcp-server': await store.saveMcpServer(value.server); break;
        case 'set-mcp-enabled': {
          if (typeof value.enabled !== 'boolean') throw new Error('MCP 启用状态无效。');
          await store.setMcpEnabled(extensionId(value.id), value.enabled); break;
        }
        case 'remove-mcp-server': await store.removeMcpServer(extensionId(value.id)); break;
        case 'add-marketplace': await store.addMarketplace(extensionId(value.source)); break;
        case 'remove-marketplace': await store.removeMarketplace(extensionId(value.id)); break;
        case 'update': await store.update(extensionId(value.id)); break;
        case 'rollback': await store.rollback(extensionId(value.id), extensionId(value.versionId)); break;
        case 'configure': {
          if (typeof value.values !== 'object' || value.values === null || Array.isArray(value.values) || Object.values(value.values).some(item => typeof item !== 'string')) throw new Error('连接配置需要文字映射。');
          await store.configure(extensionId(value.id), extensionId(value.server), value.values as Record<string, string>, activeSession().workingDirectory); break;
        }
        case 'connect': case 'disconnect': await store.connect(extensionId(value.id), extensionId(value.server), value.action === 'disconnect', activeSession().workingDirectory); break;
        default: throw new Error('未知扩展管理操作。');
      }
      mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
      return store.list(activeSession().workingDirectory);
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.readExtension, (_event, id: unknown) => extensionStore().readDetail(extensionId(id), activeSession().workingDirectory));
  ipcMain.handle(DESKTOP_CHANNELS.listSkills, async (_event, forceReload: unknown) => { await watchCurrentSkills(); return extensionStore().listSkills(activeSession().workingDirectory, forceReload === true); });
  ipcMain.handle(DESKTOP_CHANNELS.readSkill, (_event, id: unknown) => extensionStore().readSkill(extensionId(id), activeSession().workingDirectory));
  ipcMain.handle(DESKTOP_CHANNELS.reconcileExtensions, async () => changeExtensions(async () => {
    const store = extensionStore();
    const result = await store.reconcile();
    mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
    if (result.failed.length > 0) throw new Error(result.failed.map(item => `${item.id}：${item.message}`).join('\n'));
    return store.list(activeSession().workingDirectory);
  }));
  ipcMain.handle(DESKTOP_CHANNELS.importExtension, async (_event, kind: unknown) => {
    if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
    if (kind !== 'plugin' && kind !== 'skill') throw new Error('扩展类型无效。');
    const selected = await dialog.showOpenDialog(mainWindow!, { title: kind === 'plugin' ? '导入插件目录' : '导入技能目录', properties: ['openDirectory'] });
    if (selected.canceled || selected.filePaths.length === 0) return null;
    if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
    return changeExtensions(async () => {
      const store = extensionStore();
      await store.importDirectory(kind, selected.filePaths[0]!);
      mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
      return store.list(activeSession().workingDirectory);
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.installExtension, async (_event, id: unknown) => {
    if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
    return changeExtensions(async () => {
      const store = extensionStore();
      await store.install(extensionId(id));
      mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
      return store.list(activeSession().workingDirectory);
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.enableExtension, async (_event, id: unknown, enabled: unknown) => {
    if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效。');
    return changeExtensions(async () => {
      const store = extensionStore();
      await store.setEnabled(extensionId(id), enabled, activeSession().workingDirectory);
      mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
      return store.list(activeSession().workingDirectory);
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.uninstallExtension, async (_event, id: unknown) => {
    if (isTaskRunning) throw new Error('任务执行期间无法修改扩展。');
    return changeExtensions(async () => {
      const store = extensionStore();
      await store.uninstall(extensionId(id));
      mainWindow?.webContents.send(DESKTOP_CHANNELS.extensionsChanged);
      return store.list(activeSession().workingDirectory);
    });
  });

  ipcMain.handle(DESKTOP_CHANNELS.loadRuntimeSettings, () => loadRuntimeSettings(
    persistenceFilePath(),
    safeStorage,
  ));
  ipcMain.handle(DESKTOP_CHANNELS.listProviderModels, (_event, query: unknown) => listProviderModels(persistenceFilePath(), parseProviderQuery(query), safeStorage));
  ipcMain.handle(DESKTOP_CHANNELS.openModelConfig, async () => {
    const settings = await loadRuntimeSettings(persistenceFilePath(), safeStorage);
    const path = join(app.getPath('temp'), 'agent-desktop-model-config.json');
    // 提供可阅读的配置快照；权威配置仍由设置页写入数据库，快照从不包含密钥。
    await writeFile(path, JSON.stringify({ modelProviders: settings.modelProviders.map(({ apiKey: _key, ...provider }) => provider),
      conversationModel: settings.conversationModel, fallbackVisionModel: settings.fallbackVisionModel, fallbackVisionEnabled: settings.fallbackVisionEnabled }, null, 2), 'utf8');
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
  });

  ipcMain.handle(DESKTOP_CHANNELS.saveRuntimeSettings, async (_event, update: unknown) => {
    const parsed = parseRuntimeSettingsUpdate(update);
    // 当前轮已经持有启动快照；只有对话模型选择允许为下一轮提前保存。
    if (isTaskRunning && (parsed.conversationModel === undefined || Object.keys(parsed).some(field => field !== 'conversationModel'))) throw new Error('Agent 正在执行，无法保存设置。');
    await saveRuntimeSettings(
      persistenceFilePath(),
      parsed,
      safeStorage,
    );
    return loadRuntimeSettings(persistenceFilePath(), safeStorage);
  });
  ipcMain.handle(DESKTOP_CHANNELS.loadMemories, () => loadMemories(persistenceFilePath()));
  ipcMain.handle(DESKTOP_CHANNELS.deleteMemories, () => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法删除记忆。');
    deleteMemories(persistenceFilePath());
  });
  ipcMain.handle(DESKTOP_CHANNELS.loadCustomInstructions, async () => {
    const path = join(app.getPath('home'), 'AGENTS.md');
    try { return { path, content: await readFile(path, 'utf8') }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, content: '' }; throw error; }
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveCustomInstructions, async (_event, content: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法保存自定义指令。');
    if (typeof content !== 'string') throw new Error('自定义指令必须是文字。');
    const path = join(app.getPath('home'), 'AGENTS.md');
    await writeFile(path, content, 'utf8');
    return { path, content };
  });

  ipcMain.handle(DESKTOP_CHANNELS.loadClientState, () => clientState);

  ipcMain.handle(DESKTOP_CHANNELS.closeReady, () => {
    isClientCloseReady = true;
  });

  ipcMain.handle(DESKTOP_CHANNELS.saveClientState, async (_event, state: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法保存未完成的会话状态。');
    if (persistenceFailure !== undefined) throw persistenceFailure;
    const parsed = parseClientState(state, undefined, sessionId => sessions.get(sessionId)?.session.events() ?? [],
      sessionId => sessions.get(sessionId)?.session.turnMessageBindings() ?? []);
    const snapshot = reconcileRecoveredClientState(parsed);
    const persisted = parseDesktopState(currentPersistedState(snapshot));
    // 复用磁盘读取的同一结构校验，保证 Renderer 会话与 Main 运行态一一对应。
    try { await saveDesktopState(persistenceFilePath(), persisted); }
    catch (cause) {
      const error = cause instanceof SessionPersistenceError ? cause : new SessionPersistenceError(cause);
      persistenceFailure ??= error;
      throw error;
    }
    clientState = snapshot;
  });

  ipcMain.handle(DESKTOP_CHANNELS.getActiveSessionId, () => activeSessionId);

  ipcMain.handle(DESKTOP_CHANNELS.setPermissionMode, async (_event, value: unknown): Promise<PermissionMode> => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法变更权限模式。');
    if (persistenceFailure !== undefined) throw persistenceFailure;
    const mode = parsePermissionMode(value);
    const session = activeSession();
    if (clientState === null) throw new Error('当前聊天尚未保存。');
    const applyMode = (conversation: ClientStateSnapshot['conversations'][number]) => conversation.id === activeSessionId
      ? { ...conversation, permissionMode: mode } : conversation;
    const snapshot = { ...clientState, conversations: clientState.conversations.map(applyMode),
      ...(clientState.drafts === undefined ? {} : { drafts: clientState.drafts.map(applyMode) }) };
    const state = currentPersistedState(snapshot);
    // 先提交候选快照，保存失败时保留旧模式；返回成功后界面才更新选中项。
    await saveDesktopState(persistenceFilePath(), { ...state,
      sessions: state.sessions.map(saved => saved.id === activeSessionId ? { ...saved, permissionMode: mode } : saved) });
    session.permissionMode = mode;
    clientState = snapshot;
    return mode;
  });

  ipcMain.handle(DESKTOP_CHANNELS.selectAttachmentFiles, async () => {
    if (mainWindow === null) throw new Error('Desktop window is not available');
    const session = activeSession();

    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      // 视频与音频共用同一个入口；角色由扩展名判定，不让用户先选角色再选文件。
      filters: [{
        name: '输入文件',
        extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
      }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;

    session.attachments.push(...selection.filePaths.map((filePath) => ({
      path: filePath,
      role: attachmentRole(filePath),
    })));
    return toClientAttachments(session.attachments);
  });

  ipcMain.handle(DESKTOP_CHANNELS.removeAttachment, (_event, index: unknown) => {
    const session = activeSession();
    if (typeof index !== 'number' || !Number.isInteger(index)
      || index < 0 || index >= session.attachments.length) {
      throw new Error('无效的附件序号。');
    }

    session.attachments.splice(index, 1);
  });

  ipcMain.handle(DESKTOP_CHANNELS.selectProjectDirectory, async () => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法添加项目。');
    if (mainWindow === null) throw new Error('Desktop window is not available');
    const selection = await dialog.showOpenDialog(mainWindow, { title: '选择项目文件夹', properties: ['openDirectory'] });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });

  ipcMain.handle(DESKTOP_CHANNELS.openProjectDirectory, async (_event, directory: unknown) => {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('无效的项目目录。');
    if (!(await stat(directory)).isDirectory()) throw new Error('项目路径不是文件夹。');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });

  ipcMain.handle(DESKTOP_CHANNELS.newSession, async (_event, directory: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法新建会话。');
    // 仅显式的项目内新建动作使用目录；移动已有聊天不调用此入口。
    if (directory !== undefined) {
      if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('无效的项目目录。');
      if (!(await stat(directory)).isDirectory()) throw new Error('项目路径不是文件夹。');
    }
    const id = createDesktopSession();
    if (typeof directory === 'string') sessions.get(id)!.workingDirectory = resolve(directory);
    return id;
  });

  ipcMain.handle(DESKTOP_CHANNELS.switchSession, (_event, sessionId: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法切换会话。');
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      throw new Error('找不到对应的会话。');
    }
    activeSessionId = sessionId;
  });

  ipcMain.handle(DESKTOP_CHANNELS.deleteSession, async (_event, sessionId: unknown): Promise<string> => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法删除会话。');
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      throw new Error('找不到对应的会话。');
    }

    const wasActive = sessionId === activeSessionId;
    await sessions.get(sessionId)!.terminal?.close();
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      // 最后一个运行态删除后创建输入草稿；Client 不把它补成历史聊天。
      return createDesktopSession();
    }
    if (wasActive) activeSessionId = sessions.keys().next().value!;
    return activeSessionId;
  });

  const runAgentTaskHandler = async (_event: unknown, request: unknown, recoveryValue?: unknown): Promise<AgentTaskIpcResult> => {
    if (persistenceFailure !== undefined) throw persistenceFailure;
    if (desktopUpdater?.state.status === 'installing') throw new Error('正在安装更新，无法开始任务。');
    if (!isRecord(request) || request.sessionId !== activeSessionId || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new Error('请输入剪辑需求。');
    }
    const prompt = request.prompt.trim();
    if (!Number.isSafeInteger(request.userMessageId) || !Number.isSafeInteger(request.assistantMessageId)
      || (request.userMessageId as number) < 0 || (request.assistantMessageId as number) < 0
      || request.userMessageId === request.assistantMessageId) throw new Error('任务消息身份无效。');
    if (activeTask !== undefined) throw new Error('已有任务正在执行。');
    if (isExtensionChanging) throw new Error('扩展操作正在进行，请完成后再开始任务。');

    let recovery: { readonly sourceTurnId: TurnId; readonly mode: 'continue' | 'verify' } | undefined;
    if (recoveryValue !== undefined) {
      if (typeof recoveryValue !== 'object' || recoveryValue === null) throw new Error('恢复请求无效。');
      const value = recoveryValue as Record<string, unknown>;
      if (value.sessionId !== activeSessionId || typeof value.sourceTurnId !== 'string'
        || (value.mode !== 'continue' && value.mode !== 'verify')) throw new Error('恢复请求不属于当前会话。');
      const events = activeSession().session.events();
      const sourceTurnId = value.sourceTurnId as TurnId;
      const ancestry = projectRecoveryAncestry(events, sourceTurnId);
      const sourceState = projectTurnState(events, sourceTurnId);
      const sourceTaskState = sourceState === undefined ? undefined : projectAgentTaskState(events, sourceTurnId);
      if (sourceState === undefined || (sourceState === 'completed' && sourceTaskState?.status === 'completed') || ancestry.latestTurnId !== sourceTurnId
        || events.some(event => event.type === 'turn.recovery.started' && event.sourceTurnId === sourceTurnId)) {
        throw new Error('该任务不能再次恢复。');
      }
      recovery = { sourceTurnId, mode: value.mode };
    }

    const sessionId = activeSessionId;
    const session = activeSession();
    const start = prepareTurnStart(buildAgentPrompt(prompt, session.attachments), recovery);
    const binding: TurnMessageBinding = { executionVersion: 1, turnId: start.turnId,
      userMessageId: request.userMessageId as number, assistantMessageId: request.assistantMessageId as number };
    // IPC 是真实边界：同时解析新事件、消息绑定和展示快照；旧事件只取宿主权威数据。
    const startedState = parseDesktopState(currentPersistedState(request.clientState as ClientStateSnapshot,
      { id: sessionId, events: [...session.session.events(), ...start.events], bindings: [...session.session.turnMessageBindings(), binding] }));
    const startedConversation = startedState.clientState.conversations.find(item => item.id === sessionId)!;
    const oldConversation = [...clientState?.conversations ?? [], ...clientState?.drafts ?? []].find(item => item.id === sessionId);
    const previousMessages = oldConversation?.messages ?? [];
    const user = startedConversation.messages.at(-2);
    const assistant = startedConversation.messages.at(-1);
    const expectedAttachments = recovery === undefined ? toClientAttachments(session.attachments) : [];
    if (startedState.clientState.activeSessionId !== sessionId || startedConversation.messages.length !== previousMessages.length + 2
      || startedConversation.messages.slice(0, -2).some((message, index) => message.id !== previousMessages[index]?.id || message.role !== previousMessages[index]?.role)
      || user?.role !== 'user' || user.id !== binding.userMessageId || user.text !== prompt
      || assistant?.role !== 'assistant' || assistant.id !== binding.assistantMessageId || assistant.status !== 'processing'
      || user.attachments.length !== expectedAttachments.length
      || user.attachments.some((name, index) => name !== expectedAttachments[index]?.name
        || user.attachmentRoles?.[index] !== undefined && user.attachmentRoles[index] !== expectedAttachments[index]?.role)
      || startedConversation.attachments.length !== session.attachments.length
      || startedConversation.attachments.some((attachment, index) => attachment.path !== session.attachments[index]?.path || attachment.role !== session.attachments[index]?.role)) {
      throw new Error('任务起点与当前会话、消息或附件不一致。');
    }
    const controller = new AbortController();
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    activeTask = { sessionId, controller, finished, terminalTouched: false };
    isTaskRunning = true;
    // 在 try 之外持有会话：失败与取消路径也要按它的事件统计已成功的产物。
    const firstTaskEventIndex = session.session.events().length;
    // 起点批次先落 SQLite，再准备扩展、钩子或外部模型；失败时不会留下可执行但未保存的任务。
    let preparedStart: ReturnType<typeof prepareTurnStart> | undefined;
    let closeExtensions: (() => Promise<void>) | undefined;
    let closeExtensionsSafely: () => Promise<void> = async () => {};
    try {
      // 前轮终态也来自 Session，不能在新起点的整份快照中退回旧 processing 占位。
      const startedClientState = reconcileRecoveredClientState(startedState.clientState);
      session.session.commitStart(start, startedClientState, binding);
      clientState = startedClientState;
      preparedStart = start;
      const settings = await loadRuntimeConfiguration(
        persistenceFilePath(),
        safeStorage,
      );
      // 权限属于当前聊天，本轮固定模式；自动审查使用独立请求和同一个取消信号。
      const permissionMode = session.permissionMode ?? 'ask';
      approvalGate.configure({ mode: permissionMode,
        review: (target, signal) => reviewApproval(target, settings, session.session.events(), signal) });
      if (settings.deepSeekApiKey === undefined) {
        throw new Error('请先在设置中配置当前对话模型的 API 密钥。');
      }
      let terminalRunningPersisted = false;
      const safeRecovery = projectRecoveryFacts(session.session.events()).unknownEffects.length > 0;
      // 先准备插件再组装 Agent；公开 Probe 与语义验收必须持有同一个已授权适配器。
      // 未知外部效果只允许核验，不连接插件或触发其钩子。
      const extensionFiles = safeRecovery ? { plugins: [], skills: [], mcpServers: [] } : await extensionStore().files(session.workingDirectory);
      const whisper = extensionFiles.plugins.find(plugin => plugin.item.id === 'plugin:whisper' && plugin.item.source === 'builtin' && plugin.item.enabled);
      let whisperModelPath: string | undefined;
      let whisperExecutable: string | undefined;
      let whisperUnavailable: string | undefined;
      if (whisper !== undefined) {
        try { whisperModelPath = await extensionStore().whisperModels.path(); }
        catch (error) { if (error instanceof SessionPersistenceError || !(error instanceof Error)) throw error; whisperUnavailable = `Whisper 模型不可用：${error.message}。请重新安装模型。`; }
        if (whisperModelPath === undefined) whisperUnavailable = 'Whisper 模型未安装或完整性校验失败，请在 Whisper 插件详情中安装模型。';
        else if (whisperUnavailable === undefined) {
          try { whisperExecutable = await verifyWhisperRuntime(whisper.directory); }
          catch (error) { if (error instanceof SessionPersistenceError || !(error instanceof Error)) throw error; whisperUnavailable = `Whisper 运行资源不可用：${error.message}。请重新安装插件。`; }
        }
      }
      // 缺少模型或运行资源只移除这个服务，不能阻止普通任务或其它插件。
      const availableExtensions = { ...extensionFiles, plugins: extensionFiles.plugins.filter(plugin => plugin !== whisper || whisperUnavailable === undefined) };
      const mediaAccess = { workspace: workspacePortFor(sessionId), attachments: () => session.attachments.map(attachment => attachment.path),
        events: () => session.session.events() };
      const extensions = await runHostOperation(session, preparedStart.turnId, 'prepare', '准备本轮扩展、技能和工具服务。',
        () => prepareExtensions(availableExtensions, (request, signal) => approvalGate.request(request, signal), controller.signal, prompt.trim(),
          { authProvider: (plugin, server) => connectionStore().provider(plugin.item.id, server.name, server.url!),
            probeAccess: mediaAccess, whisperAccess: mediaAccess, visionAccess: mediaAccess,
            visionConfiguration: {
              ...(settings.visionApiKey === undefined ? {} : { visionApiKey: settings.visionApiKey }),
              ...(settings.visionBaseUrl === undefined ? {} : { visionBaseUrl: settings.visionBaseUrl }),
              ...(settings.visionModel === undefined ? {} : { visionModel: settings.visionModel }),
              ...(settings.visionProtocol === undefined ? {} : { visionProtocol: settings.visionProtocol }),
              ...(settings.visionMaxOutputTokens === undefined ? {} : { visionMaxOutputTokens: settings.visionMaxOutputTokens }),
            },
            ...(whisperModelPath === undefined || whisperExecutable === undefined ? {} : { whisperEnvironment: { WHISPER_MODEL_PATH: whisperModelPath, WHISPER_CLI_PATH: whisperExecutable } }) }));
      closeExtensions = extensions.close;
      closeExtensionsSafely = async (): Promise<void> => {
        const close = closeExtensions;
        closeExtensions = undefined;
        if (close === undefined || preparedStart === undefined) return;
        // 保存已经致命失败时只能释放连接；新的宿主事实也无法落盘，仍传播第一次保存错误。
        if (persistenceFailure !== undefined) {
          try { await close(); } finally { throw persistenceFailure; }
        }
        try {
          await runHostOperation(session, preparedStart.turnId, 'close', '关闭本轮扩展和工具服务。', close);
        } catch (error) {
          // 清理失败不能覆盖已提交的 Turn 结果；宿主失败事实会让最终任务投影进入待处理状态。
          if (error instanceof SessionPersistenceError) throw error;
        }
      };
      const mediaTools = extensions.tools.filter(tool => FFMPEG_TOOLS.has(tool.name) || WHISPER_TOOLS.has(tool.name)).map(extensions.wrapTool);
      const visionTool = extensions.tools.find(tool => tool.name === 'analyze_images');
      // 一个 Turn 只创建一个 Agent，并把已有 InMemorySession 原样注入以保留模型上下文。
      let agent = createVideoAgent({
        deepSeekApiKey: settings.deepSeekApiKey,
        mediaTools,
        ...(settings.deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl: settings.deepSeekBaseUrl }),
        ...(settings.deepSeekModel === undefined ? {} : { deepSeekModel: settings.deepSeekModel }),
        ...(settings.modelProtocol === undefined ? {} : { modelProtocol: settings.modelProtocol }),
        ...(settings.modelMaxOutputTokens === undefined ? {} : { modelMaxOutputTokens: settings.modelMaxOutputTokens }),
        ...(settings.useDeepSeekThinking === undefined ? {} : { useDeepSeekThinking: settings.useDeepSeekThinking }),
        ...(settings.visionUnavailableReason === undefined ? {} : { visionUnavailableReason: settings.visionUnavailableReason }),
        ...(visionTool === undefined ? {} : { visionTool: extensions.wrapTool(visionTool) }),
        session: session.session,
        workspace: workspacePortFor(sessionId),
        // 命令能力由宿主提供解释器绝对路径和受限子进程环境；工具自己不做这些选择。
        command: createCommandPort(),
        terminal: terminalPortFor(session, workspacePortFor(sessionId), (terminal) => {
          sendAgentEvent({ type: 'terminal.updated', sessionId, terminal });
          // 只在宿主终态转换时保存终端事实，逐块输出仍按现有有界内存通知。
          if (terminal.status !== 'running' || !terminalRunningPersisted) {
            persistSessionResourceState(sessionId);
            if (terminal.status === 'running') terminalRunningPersisted = true;
          }
        }, () => { if (activeTask?.controller === controller) activeTask.terminalTouched = true; }),
        askUser: (question, context) => {
          const called = session.session.events().findLast((event) => event.type === 'tool.called' && event.toolCallId === context.toolCallId);
          if (called?.type !== 'tool.called') throw new Error('提问缺少当前工具调用事实。');
          return questionGate.request(question, sessionId, called.turnId, context.signal, (requestId, reason) => {
            session.session.append({ type: 'tool.interaction.closed', turnId: called.turnId, stepId: called.stepId,
              toolCallId: called.toolCallId, requestId, reason });
            sendAgentEvent({ type: 'activity.detail', activityId: called.toolCallId,
              detail: { kind: 'error', message: reason === 'window-closed' ? '问题未回答，窗口已关闭。' : '问题未回答，任务已停止。' } });
            sendAgentEvent({ type: 'question.closed', requestId });
          });
        },
        delegateTasks: (() => {
          const childrenByCall = new Map<string, Map<string, { taskId: string; title: string; status: string; summary: string }>>();
          return (task, context) => {
            let children = childrenByCall.get(context.toolCallId);
            if (children === undefined) { children = new Map(); childrenByCall.set(context.toolCallId, children); }
            const currentChildren = children;
            return runReadOnlySubagent(task, context, session.workingDirectory, settings, (event) => {
              currentChildren.set(event.taskId, { taskId: event.taskId, title: event.title,
                status: event.status, summary: event.toolName ?? currentChildren.get(event.taskId)?.summary ?? '' });
              sendAgentEvent({ type: 'activity.detail', activityId: context.toolCallId, detail: { kind: 'subagents', tasks: [...currentChildren.values()] } });
            }, (record) => {
              session.subagentHistory.push(record);
              // 子任务完成记录与父 Session 同一快照落盘；保存失败会终止当前轮次，不能只留在内存。
              persistSessionResourceState(sessionId);
              currentChildren.set(record.result.taskId, record.result);
            }, workspacePortFor(sessionId).fileAccess);
          };
        })(),
      });
      // 媒体工具已注入且已包装钩子，只追加其他扩展工具。
      for (const tool of extensions.tools) if (!WHISPER_TOOLS.has(tool.name) && !FFMPEG_TOOLS.has(tool.name) && tool !== visionTool) agent.tools.register(tool);
      const authorizedTools = new InMemoryToolRegistry();
      for (const tool of agent.tools.list()) authorizedTools.register(['declare_video_outputs', 'publish_video_output'].includes(tool.name) ? authorizeVideoDeliveryTool(tool, mediaAccess) : tool);
      agent = { ...agent, tools: authorizedTools };
      if (safeRecovery) {
        const safeTools = new InMemoryToolRegistry();
        for (const tool of agent.tools.list()) {
          if (['list_directory', 'read_file', 'search_text', 'read_terminal', 'update_plan', 'verify_tool_outcome'].includes(tool.name)) safeTools.register(tool);
        }
        agent = { ...agent, tools: safeTools };
      }
      if (!safeRecovery && settings.memoryEnabled) {
        const hasToolCall = () => session.session.events().slice(firstTaskEventIndex).some(event => event.type === 'tool.called' && event.name !== 'save_memory');
        agent.tools.register(new SaveMemoryTool(persistenceFilePath(), () => hasToolCall() ? 'tool' : 'conversation', settings.memoryFromToolChatsEnabled ?? true));
      }
      if (extensionFiles.plugins.some(plugin => plugin.item.enabled && (plugin.hooks?.length ?? 0) > 0)) {
        const extensionTools = new InMemoryToolRegistry();
        for (const tool of agent.tools.list()) extensionTools.register(WHISPER_TOOLS.has(tool.name) || FFMPEG_TOOLS.has(tool.name) || tool.name === 'analyze_images' ? tool : extensions.wrapTool(tool));
        agent = { ...agent, tools: extensionTools };
      }
      // 宿主计划工具在扩展包裹后注册，不让插件钩子变成计划事实的一部分。
      agent.tools.register(new UpdatePlanTool(session.session, qualifyTaskToolEvidence));
      agent.tools.register(new VerifyToolOutcomeTool(session.session, workspacePortFor(sessionId)));
      if (recovery === undefined && session.pendingSessionStart !== undefined) {
        const source = session.pendingSessionStart;
        // 在执行前消费；失败或取消后的继续任务不会重放已触发的启动命令。
        delete session.pendingSessionStart;
        if (extensions.hookEvents.has('SessionStart')) await runHostOperation(session, preparedStart.turnId, 'session-start', '运行会话启动钩子。',
          () => extensions.runHooks('SessionStart', { session_id: activeSessionId, source }));
      }
      if (recovery === undefined && extensions.hookEvents.has('UserPromptSubmit')) await runHostOperation(session, preparedStart.turnId, 'prompt-submit', '运行用户提示提交钩子。',
        () => extensions.runHooks('UserPromptSubmit', { prompt: prompt.trim(), session_id: activeSessionId }));
      if (extensions.instructions !== '' || whisperUnavailable !== undefined) {
        const base = agent.systemPrompt.build();
        agent = { ...agent, systemPrompt: { build: () => base + extensions.instructions + (whisperUnavailable === undefined ? '' : `\n${whisperUnavailable}`) } };
      }
      if (recovery === undefined && settings.memoryEnabled) {
        const memories = loadMemories(persistenceFilePath());
        let instructions = '';
        try { instructions = await readFile(join(app.getPath('home'), 'AGENTS.md'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const memoryPrompt = memories.length === 0 ? '' : `\n\n以下是用户允许你使用的长期记忆，只把它们当作背景事实，不要向用户展示这段区块：\n${memories.map(item => `- ${item.content}`).join('\n')}`;
        const instructionPrompt = instructions.trim() === '' ? '' : `\n\n以下是用户的 Codex 指令：\n${instructions.trim()}`;
        if (memoryPrompt !== '' || instructionPrompt !== '') {
          const base = agent.systemPrompt.build();
          agent = { ...agent, systemPrompt: { build: () => base + memoryPrompt + instructionPrompt } };
        }
      }
      const basePrompt = agent.systemPrompt.build();
      const permissionPrompt = permissionMode === 'full-access'
        ? '当前聊天为完全访问：宿主已允许本地文件范围和操作自动批准，无需重复请求授权。相对路径仍需要明确工作目录；操作系统权限、输入校验、任务恢复核验和视频验收规则继续生效。'
        : permissionMode === 'auto-review'
          ? '当前聊天为帮我批准：工作目录内常规文本编辑可直接执行，目录变更、命令、终端和插件操作由独立模型审查。审查拒绝或失败表示操作未执行，不得绕过；目录范围外请先通过 set_working_directory 请求授权。'
          : '当前聊天为请求批准：工作目录内常规文本编辑可直接执行，目录变更、命令、终端和插件操作会请求用户批准。目录范围外请先通过 set_working_directory 请求授权。';
      agent = { ...agent, systemPrompt: { build: () => `${basePrompt}\n${permissionPrompt}` } };
      // Desktop 脚本从 app package 目录启动，Trace 仍统一写入仓库根 logs/。
      const logsDirectory = resolve(app.getAppPath(), '..', '..', 'logs');
      await mkdir(logsDirectory, { recursive: true });
      const trace = createJsonlTrace(join(logsDirectory, 'agent-trace.jsonl'));

      const result = await runDesktopAgentTask(
        agent,
        prompt.trim(),
        session.attachments,
        {
          trace: async (traceEvent) => {
            await trace.write(traceEvent);
            sendActivity(traceEvent, session.session.events());
            sendTaskState(sessionId);
          },
          signal: controller.signal,
          turnId: preparedStart.turnId,
          qualifyToolEvidence: qualifyTaskToolEvidence,
          beforeToolCall: input => taskToolGate(session.session.events(), input),
          ...(recovery === undefined ? {} : { maxSteps: 24, maxToolCalls: 48 }),
          // 动态扩展、用户指令与记忆已组装完；只有真实配置的两项限额齐全才启用预算。
          ...(settings.modelContextWindow === undefined || settings.modelMaxOutputTokens === undefined ? {}
            : { contextBudget: { contextWindow: settings.modelContextWindow, maxOutputTokens: settings.modelMaxOutputTokens } }),
          // 把 Model 文本增量实时推给 Renderer；它不进入 Session，也不影响最终结果。
          onModelText: (stepId, text, purpose) => sendAgentEvent(purpose === 'delta'
            ? { type: 'text.delta', stepId, delta: text }
            : { type: 'model.text', stepId, text, purpose }),
          // 固定本轮实际模型身份，设置中途切换也不会把旧请求用量归给新模型。
          onModelUsage: usage => sendAgentEvent({ type: 'model.usage', sessionId,
            usage: usage === undefined ? null : { model: settings.conversationModel, ...usage } }),
          onToolResult: (toolCallId, toolName, toolResult) => {
            sendTaskState(sessionId);
            // 先结清实时输出再发布最终详情：最终详情是权威结果，不能被迟到的进度覆盖。
            commandOutput.flush();
            const detail = projectAgentActivityDetail(toolName, toolResult);
            if (detail !== undefined) {
              sendAgentEvent({ type: 'activity.detail', activityId: toolCallId, detail });
            }
          },
          onToolProgress: (toolCallId, event) => {
            // 命令原文来自 Session 的 tool.called 事实；进度事件本身只携带输出片段。
            commandOutput.push(toolCallId, findCommandText(session.session.events(), toolCallId), event);
          },
        },
      );
      if (recovery === undefined && extensions.hookEvents.has('Stop')) await runHostOperation(session, result.turnId, 'stop', '运行本轮停止钩子。',
        () => extensions.runHooks('Stop', { session_id: activeSessionId, response: result.responseText }));
      await closeExtensionsSafely();
      // 产物身份是真实路径；文件名只是给界面看的标签，因此同名不同目录可以并存。
      const outputFiles = toOutputFiles(result.artifacts);
      const taskState = projectAgentTaskState(session.session.events(), result.turnId);
      // 逐项结果与失败路径共用同一条读取投影，保证两种终态口径一致。
      const outputs = turnOutputResults(session.session.events(), firstTaskEventIndex);
      let conversationTitle: string | undefined;
      let conversationTitleError: string | undefined;
      if (firstTaskEventIndex === 0) {
        try { conversationTitle = await generateConversationTitle(agent.model, prompt, controller.signal); }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          // 任务已经完成，标题请求的真实失败单独展示，不把成功产物改成失败。
          conversationTitleError = error.message;
        }
      }
      return {
        status: 'success',
        result: {
          responseText: result.responseText,
          traceId: trace.id,
          ...(taskState === undefined ? {} : { taskState }),
          ...(conversationTitle === undefined ? {} : { conversationTitle }),
          ...(conversationTitleError === undefined ? {} : { conversationTitleError }),
          ...(outputFiles.length === 0 ? {} : { outputFiles }),
          ...(outputs === undefined ? {} : { outputs }),
        },
      };
    } catch (error) {
      // 失败终态用普通对象穿过 IPC 与 contextBridge，再由 Renderer 还原错误名称和产物。
      if (!(error instanceof Error)) throw error;
      // 扩展准备或宿主启动在进入 Loop 前失败时，起点仍需留下真实失败终态。
      if (error instanceof SessionPersistenceError) throw error;
      if (preparedStart !== undefined && projectTurnState(session.session.events(), preparedStart.turnId) === 'started') {
        try {
          // 前置宿主阶段收到取消时仍保留取消来源；只有真实业务错误才进入 failed。
          if (error.name === 'AbortError') {
            session.session.append({ type: 'turn.cancelled', turnId: preparedStart.turnId,
              reason: controller.signal.reason instanceof TurnCancellationError ? controller.signal.reason.reason
                : error instanceof TurnCancellationError ? error.reason : 'external' });
          } else {
            session.session.append({ type: 'turn.failed', turnId: preparedStart.turnId, errorName: error.name, errorMessage: error.message });
          }
        } catch (persistenceError) {
          if (persistenceError instanceof SessionPersistenceError) throw persistenceError;
          throw error;
        }
      }
      // 失败或取消不代表本轮此前没有产出：已交付文件和逐项结果都是真实事实。
      const outputs = turnOutputResults(session.session.events(), firstTaskEventIndex);
      const outputFiles = succeededOutputFiles(session.session.events(), firstTaskEventIndex);
      const taskState = preparedStart === undefined ? undefined : projectAgentTaskState(session.session.events(), preparedStart.turnId);
      return {
        status: 'error',
        errorName: error.name,
        errorMessage: error.message,
        ...(outputFiles === undefined ? {} : { outputFiles }),
        ...(outputs === undefined ? {} : { outputs }),
        ...(taskState === undefined ? {} : { taskState }),
      };
    } finally {
      try {
        try {
          await closeExtensionsSafely();
        } finally {
          if (controller.signal.aborted && activeTask?.terminalTouched) {
            try {
              if (preparedStart !== undefined && session.terminal !== undefined) {
                if (persistenceFailure !== undefined) await session.terminal.close();
                else await runHostOperation(session, preparedStart.turnId, 'terminal-close', '关闭取消任务留下的终端进程。', () => session.terminal!.close());
              }
            } catch (error) {
              if (error instanceof SessionPersistenceError) throw error;
            }
          }
        }
      } finally {
        commandOutput.flush();
        sendTaskState(sessionId);
        isTaskRunning = false;
        if (activeTask?.controller === controller) activeTask = undefined;
        markFinished();
      }
    }
  };
  ipcMain.handle(DESKTOP_CHANNELS.runAgentTask, runAgentTaskHandler);
  ipcMain.handle(DESKTOP_CHANNELS.recoverTask, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('恢复请求无效。');
    const value = request as Record<string, unknown>;
    if (typeof value.sessionId !== 'string' || typeof value.sourceTurnId !== 'string'
      || (value.mode !== undefined && value.mode !== 'continue' && value.mode !== 'verify')) throw new Error('恢复请求字段无效。');
    return runAgentTaskHandler(event, value, { ...value, mode: value.mode ?? 'continue' });
  });
  ipcMain.handle(DESKTOP_CHANNELS.verifyTaskEffect, (_event, request: unknown) => {
    if (isTaskRunning) throw new Error('任务执行期间不能修改核验事实。');
    if (typeof request !== 'object' || request === null) throw new Error('核验请求无效。');
    const value = request as Record<string, unknown>;
    if (value.sessionId !== activeSessionId || typeof value.sourceEventIndex !== 'number'
      || !Number.isSafeInteger(value.sourceEventIndex) || value.sourceEventIndex < 0
      || (value.outcome !== 'completed' && value.outcome !== 'not-applied')
      || typeof value.description !== 'string' || value.description.trim() === '' || value.description.length > 512) {
      throw new Error('核验请求字段无效。');
    }
    const session = activeSession();
    const fact = projectRecoveryFacts(session.session.events()).unknownEffects.find(item => item.sourceEventIndex === value.sourceEventIndex);
    if (fact === undefined) throw new Error('该外部效果已经核验或不存在。');
    const taskTurnId = session.session.events().some(event => event.type === 'turn.started' && event.turnId === fact.source.turnId)
      ? fact.source.turnId : findLatestTurnId(session.session.events());
    if (taskTurnId === undefined) throw new Error('当前会话没有可关联任务，请先发起只读核验任务。');
    const description = value.description.trim();
    session.session.append({ type: 'effect.outcome.verified', turnId: fact.source.turnId,
      sourceEventIndex: value.sourceEventIndex, scope: 'entire-call', outcome: value.outcome,
      evidence: { source: 'user', reference: `user:${activeSessionId}:${value.sourceEventIndex}`, description } });
    // 旧终端观察保留独立宿主来源；响应只更新会话里真实存在的最近任务。
    const state = projectAgentTaskState(session.session.events(), taskTurnId);
    sendTaskState(activeSessionId);
    return state;
  });

  ipcMain.handle(DESKTOP_CHANNELS.cancelTask, () => {
    if (activeTask === undefined) throw new Error('当前没有正在执行的任务。');
    activeTask.controller.abort(new TurnCancellationError('user'));
  });

  ipcMain.handle(DESKTOP_CHANNELS.decideApproval, (_event, requestId: unknown, approved: unknown) => {
    // 边界只接受当前请求的标识和一个布尔决定：待执行的操作参数不经过这里，客户端无法改写它。
    if (typeof requestId !== 'string' || typeof approved !== 'boolean') {
      throw new Error('无效的审批决定。');
    }
    approvalGate.decide(requestId, approved);
  });

  ipcMain.handle(DESKTOP_CHANNELS.revealFile, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('无效的文件路径。');
    const session = activeSession();
    // 路径来自模型写入 Session 的工具输入，只允许定位当前会话真实使用过的文件。
    // 附件与产物都属于可定位文件：按路径集合校验，不按文件名。
    if (!isSessionFilePath(
      session.session.events(),
      session.attachments.map((attachment) => attachment.path),
      filePath,
    )) {
      throw new Error('该文件不属于当前会话，无法定位。');
    }
    assertRevealableFile(filePath);
    shell.showItemInFolder(filePath);
  });
}

/** 界面里的链接来自模型输出：只有明确的 web 协议才交给系统浏览器，其余地址一律不处理。 */
function isExternalUrl(url: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(url);
}

/** 请求 Renderer 提交展示状态；返回 null 表示已保存，返回字符串表示失败原因。 */
function requestClientStateFlush(window: BrowserWindow): Promise<string | null> {
  return new Promise((resolve) => {
    ipcMain.once(DESKTOP_CHANNELS.closePrepared, (_event, failure: unknown) => {
      resolve(typeof failure === 'string' ? failure : null);
    });
    window.webContents.send(DESKTOP_CHANNELS.prepareClose);
  });
}

/**
 * 关闭窗口前的收尾：先取消在跑的轮次并等它结束，再让 Client 提交展示状态。
 * 提交失败时保留窗口，避免静默丢失尚未落盘的改动。
 */
async function prepareWindowClose(window: BrowserWindow): Promise<string | null> {
  pluginConnections?.cancelAll();
  const running = activeTask;
  if (running !== undefined) {
    running.controller.abort(new TurnCancellationError('window-closed'));
    await running.finished;
  }

  await Promise.all([...sessions.values()].map((session) => session.terminal?.close()));

  return requestClientStateFlush(window);
}

async function finishAndClose(window: BrowserWindow): Promise<void> {
  const failure = await prepareWindowClose(window);
  if (failure !== null) {
    dialog.showErrorBox('无法保存本地会话', `${failure}\n\n窗口保持打开，请重试关闭。`);
    return;
  }

  // 收尾已完成，直接销毁窗口：不再触发 close 事件，避免重新进入本流程。
  window.destroy();
}

function createWindow(): void {
  isClientCloseReady = false;
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#f4f6f3',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(app.getAppPath(), 'dist/preload/index.cjs'),
    },
  });
  mainWindow.on('closed', () => desktopExtensions?.stopWatching());
  // 正文里的链接由系统浏览器打开：Renderer 既不导航当前窗口，也不创建新的 Electron 窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isExternalUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  // Renderer 已退出时保存监听器也随之消失，后续关闭必须直接放行，不能永久等待回执。
  mainWindow.webContents.on('render-process-gone', () => {
    isClientCloseReady = false;
  });
  const rendererUrl = process.env.DESKTOP_RENDERER_URL;
  if (rendererUrl === undefined) {
    void mainWindow.loadFile(join(app.getAppPath(), 'dist/renderer/index.html'));
  } else {
    // 开发模式加载 Vite Dev Server，让 Renderer 的 CSS 和 React 修改即时热更新。
    void mainWindow.loadURL(rendererUrl);
  }
  // 关闭窗口前先完成收尾：取消在跑的轮次并等待 Client 落盘，收尾通过后才真正关闭。
  mainWindow.on('close', (event) => {
    const window = mainWindow!;
    // 更新已完成同一套保存收尾时让安装器退出应用；保存过程中则阻止另一次关闭握手。
    if (desktopUpdater?.state.status === 'installing') {
      if (!updatePrepared) event.preventDefault();
      return;
    }
    // Renderer 尚未注册保存监听时没有新的界面状态可提交，直接允许窗口关闭。
    if (!isClientCloseReady) return;
    // 必须先阻止这一次关闭再判断收尾状态：收尾期间用户再点关闭时，前一次收尾还没跑完，
    // 若先 return 就会让第二次关闭直接销毁窗口，跳过等待落盘并留下半份状态。
    // 真正的关闭只发生在收尾通过后的 window.destroy()，它不会再次触发 close 事件。
    event.preventDefault();
    if (closingWindows.has(window)) return;
    closingWindows.add(window);
    void finishAndClose(window).finally(() => closingWindows.delete(window));
  });
  mainWindow.on('closed', () => {
    isClientCloseReady = false;
    mainWindow = null;
  });
}

void app.whenReady().then(async () => {
  try {
    await migrateLegacyDesktopFiles(persistenceFilePath());
    await restoreDesktopState();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误。';
    dialog.showErrorBox('无法恢复本地会话', message);
    app.quit();
    return;
  }

  try {
    await extensionStore().initializeDefaults();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    // 基础资源损坏由插件页展示真实错误，普通对话和文件任务仍可进入。
    console.error('基础插件初始化失败：', error);
  }

  // 源码开发窗口没有安装位置，不能使用安装包更新器。
  if (app.isPackaged && process.platform === 'win32') {
    desktopUpdater = new DesktopUpdater(state => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_CHANNELS.updateState, state);
    }, join(app.getPath('logs'), 'app-updater.log'));
  }
  registerIpcHandlers();
  createWindow();
  if (desktopUpdater !== undefined) void desktopUpdater.check();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
