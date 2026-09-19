import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, parse, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '@agent-desktop/execution-trace';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { createVideoAgent } from '@agent-desktop/video-agent';
import { findLatestTurnId, findTurnArtifacts, runDesktopAgentTask, type TurnArtifact } from './agent-task.js';
import { assertRevealableFile, isSessionFilePath, projectAgentActivity } from './agent-activity.js';
import { ToolApprovalGate } from './tool-approval.js';
import {
  DESKTOP_CHANNELS,
  type AgentRuntimeEvent,
  type AgentTaskIpcResult,
} from '../shared/ipc.js';
import {
  loadDesktopState,
  parseClientState,
  parseDesktopState,
  saveDesktopState,
  SESSION_STATE_FILE_NAME,
  type PersistedDesktopState,
} from './session-persistence.js';
import type { AgentTaskOutputFile, AttachmentRole, ClientStateSnapshot } from '@agent-desktop/client';
import {
  loadRuntimeConfiguration,
  loadRuntimeSettings,
  parseRuntimeSettingsUpdate,
  RUNTIME_SECRETS_FILE_NAME,
  RUNTIME_SETTINGS_FILE_NAME,
  saveRuntimeSettings,
} from './runtime-settings.js';

let mainWindow: BrowserWindow | null = null;
let outputSequence = 0;
let isTaskRunning = false;
let activeTask: {
  readonly sessionId: string;
  readonly controller: AbortController;
  /** 关闭收尾必须等这一轮真正结束，才能提交完成或取消后的终态。 */
  readonly finished: Promise<void>;
} | undefined;
// 正在执行关闭收尾的窗口：同一窗口重复关闭时不重复进入收尾流程。
const closingWindows = new WeakSet<BrowserWindow>();
let clientState: ClientStateSnapshot | null = null;
let isClientCloseReady = false;

interface DesktopSessionState {
  readonly session: InMemorySession;
  /** 当前会话的输入附件；角色决定提示词把它当主视频还是音轨。 */
  readonly attachments: SelectedAttachment[];
  /**
   * 当前会话已经用户确认的工作目录；相对路径以它为基准。
   * 它与附件互相独立：选择附件不会改变工作目录，目录也不会被最后一次附件选择覆盖。
   */
  workingDirectory?: string;
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
  initialEvents: readonly SessionEvent[] = [],
): string {
  const session = {
    session: new InMemorySession(initialEvents),
    attachments: [],
  } satisfies DesktopSessionState;
  sessions.set(id, session);
  activeSessionId = id;
  return id;
}

function persistenceFilePath(): string {
  return join(app.getPath('userData'), SESSION_STATE_FILE_NAME);
}

function runtimeSettingsFilePath(): string {
  return join(app.getPath('userData'), RUNTIME_SETTINGS_FILE_NAME);
}

function runtimeSecretsFilePath(): string {
  return join(app.getPath('userData'), RUNTIME_SECRETS_FILE_NAME);
}

function currentPersistedState(snapshot: ClientStateSnapshot): PersistedDesktopState {
  return {
    activeSessionId,
    outputSequence,
    sessions: [...sessions].map(([id, session]) => ({
      id,
      attachments: session.attachments,
      ...(session.workingDirectory === undefined ? {} : { workingDirectory: session.workingDirectory }),
      events: session.session.events(),
    })),
    clientState: snapshot,
  };
}

async function restoreDesktopState(): Promise<void> {
  const persisted = await loadDesktopState(persistenceFilePath());
  sessions.clear();
  if (persisted === null) {
    createDesktopSession();
    return;
  }

  outputSequence = persisted.outputSequence;
  clientState = persisted.clientState;
  for (const savedSession of persisted.sessions) {
    createDesktopSession(savedSession.id, savedSession.events);
    const session = sessions.get(savedSession.id)!;
    session.attachments.push(...savedSession.attachments);
    if (savedSession.workingDirectory !== undefined) {
      session.workingDirectory = savedSession.workingDirectory;
    }
  }
  activeSessionId = persisted.activeSessionId;

  // 会话侧附件与工作目录是权威事实（旧快照在这里被换算成带 role 的形状）。
  // 快照里的界面副本可能来自更旧的格式（只有名称、没有真实路径），
  // 因此按会话事实重建一次，避免界面拿着无法定位的空路径或过期目录。
  // `workingDirectory` 必须先摘掉再按会话事实放回：会话里没有目录时，
  // 用条件展开（缺键）会把快照里的旧目录留在副本里，错误状态会跨重启存活。
  clientState = {
    ...clientState,
    conversations: clientState.conversations.map((conversation) => {
      const session = sessions.get(conversation.id);
      if (session === undefined) return conversation;
      const { workingDirectory: _staleDirectory, ...rest } = conversation;
      return {
        ...rest,
        attachments: toClientAttachments(session.attachments),
        ...(session.workingDirectory === undefined
          ? {}
          : { workingDirectory: session.workingDirectory }),
      };
    }),
  };
}

function activeSession(): DesktopSessionState {
  return sessions.get(activeSessionId)!;
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

function defaultOutputPath(inputPath: string, sequence: number): string {
  const input = parse(inputPath);
  const suffix = sequence === 1 ? '-edited' : `-edited-${sequence}`;
  return join(input.dir, `${input.name}${suffix}${input.ext || '.mp4'}`);
}

/** 沿现有 desktop:agent-event 通道把运行期事件推给 Renderer。 */
function sendAgentEvent(event: AgentRuntimeEvent): void {
  if (mainWindow?.isDestroyed() === false) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.agentEvent, event);
  }
}

/**
 * 窗口持有的唯一待决审批。
 * 待决请求经同一个运行期事件通道推给 Client，答复由 decideApproval 通道回到这里。
 */
const approvalGate = new ToolApprovalGate((request) => {
  sendAgentEvent({ type: 'approval.requested', request });
});

/**
 * 会话工作目录端口：目录事实存在会话状态里，工具只通过它读写。
 * 工具自己不做权限判断，也不缓存目录——它每次调用都读同一份会话状态。
 */
function workspacePortFor(sessionId: string): WorkspacePort {
  return {
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

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.loadRuntimeSettings, () => loadRuntimeSettings(
    runtimeSettingsFilePath(),
    runtimeSecretsFilePath(),
    safeStorage,
  ));

  ipcMain.handle(DESKTOP_CHANNELS.saveRuntimeSettings, async (_event, update: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法保存设置。');
    await saveRuntimeSettings(
      runtimeSettingsFilePath(),
      runtimeSecretsFilePath(),
      parseRuntimeSettingsUpdate(update),
      safeStorage,
    );
    return loadRuntimeSettings(runtimeSettingsFilePath(), runtimeSecretsFilePath(), safeStorage);
  });

  ipcMain.handle(DESKTOP_CHANNELS.loadClientState, () => clientState);

  ipcMain.handle(DESKTOP_CHANNELS.closeReady, () => {
    isClientCloseReady = true;
  });

  ipcMain.handle(DESKTOP_CHANNELS.saveClientState, async (_event, state: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法保存未完成的会话状态。');
    const snapshot = parseClientState(state);
    const persisted = parseDesktopState(currentPersistedState(snapshot));
    // 复用磁盘读取的同一结构校验，保证 Renderer 会话与 Main 运行态一一对应。
    await saveDesktopState(persistenceFilePath(), persisted);
    clientState = snapshot;
  });

  ipcMain.handle(DESKTOP_CHANNELS.getActiveSessionId, () => activeSessionId);

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

  ipcMain.handle(DESKTOP_CHANNELS.newSession, () => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法新建会话。');
    return createDesktopSession();
  });

  ipcMain.handle(DESKTOP_CHANNELS.switchSession, (_event, sessionId: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法切换会话。');
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      throw new Error('找不到对应的会话。');
    }
    activeSessionId = sessionId;
  });

  ipcMain.handle(DESKTOP_CHANNELS.deleteSession, (_event, sessionId: unknown): string => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法删除会话。');
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      throw new Error('找不到对应的会话。');
    }

    const wasActive = sessionId === activeSessionId;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      // 最后一个会话由 Host 创建唯一的新 Runtime，并把 exact ID 返回给 Client。
      return createDesktopSession();
    }
    if (wasActive) activeSessionId = sessions.keys().next().value!;
    return activeSessionId;
  });

  ipcMain.handle(DESKTOP_CHANNELS.runAgentTask, async (_event, prompt: unknown): Promise<AgentTaskIpcResult> => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('请输入剪辑需求。');
    }
    if (activeTask !== undefined) throw new Error('已有任务正在执行。');

    const sessionId = activeSessionId;
    const controller = new AbortController();
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    activeTask = { sessionId, controller, finished };
    isTaskRunning = true;
    // 在 try 之外持有会话：失败与取消路径也要按它的事件统计已成功的产物。
    const session = activeSession();
    const firstTaskEventIndex = session.session.events().length;
    try {
      const settings = await loadRuntimeConfiguration(
        runtimeSettingsFilePath(),
        runtimeSecretsFilePath(),
        safeStorage,
      );
      if (settings.deepSeekApiKey === undefined) {
        throw new Error('请先在设置中配置 DeepSeek API Key。');
      }
      // 一个 Turn 只创建一个 Agent，并把已有 InMemorySession 原样注入以保留模型上下文。
      const agent = createVideoAgent({
        deepSeekApiKey: settings.deepSeekApiKey,
        ...(settings.deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl: settings.deepSeekBaseUrl }),
        ...(settings.deepSeekModel === undefined ? {} : { deepSeekModel: settings.deepSeekModel }),
        ...(settings.visionApiKey === undefined ? {} : { visionApiKey: settings.visionApiKey }),
        ...(settings.visionBaseUrl === undefined ? {} : { visionBaseUrl: settings.visionBaseUrl }),
        ...(settings.whisperModelPath === undefined ? {} : { whisperModelPath: settings.whisperModelPath }),
        ...(settings.whisperCliPath === undefined ? {} : { whisperCliPath: settings.whisperCliPath }),
        session: session.session,
        workspace: workspacePortFor(sessionId),
      });
      // 输出命名只跟随主视频；单独添加音轨不应改变输出文件的位置。
      const primaryVideoPath = session.attachments.find((attachment) => attachment.role === 'video')?.path;
      const requestedOutputPath = primaryVideoPath === undefined
        ? undefined
        : defaultOutputPath(primaryVideoPath, outputSequence + 1);
      if (requestedOutputPath !== undefined) {
        outputSequence += 1;
        if (clientState !== null) {
          await saveDesktopState(persistenceFilePath(), currentPersistedState(clientState));
        }
      }
      // Desktop 脚本从 app package 目录启动，Trace 仍统一写入仓库根 logs/。
      const logsDirectory = resolve(app.getAppPath(), '..', '..', 'logs');
      await mkdir(logsDirectory, { recursive: true });
      const trace = createJsonlTrace(join(logsDirectory, 'agent-trace.jsonl'));

      const result = await runDesktopAgentTask(
        agent,
        prompt.trim(),
        session.attachments,
        requestedOutputPath,
        async (traceEvent) => {
          await trace.write(traceEvent);
          sendActivity(traceEvent, session.session.events());
        },
        controller.signal,
        // 把 Model 文本增量实时推给 Renderer；它不进入 Session，也不影响最终结果。
        (delta) => sendAgentEvent({ type: 'text.delta', delta }),
      );
      // 产物身份是真实路径；文件名只是给界面看的标签，因此同名不同目录可以并存。
      const outputFiles = toOutputFiles(result.artifacts);
      return {
        status: 'success',
        result: {
          responseText: result.responseText,
          traceId: trace.id,
          ...(outputFiles.length === 0 ? {} : { outputFiles }),
        },
      };
    } catch (error) {
      // Electron 不传递 Error 自定义字段：失败终态改用普通对象跨 IPC，再由 Preload 还原 Error。
      if (!(error instanceof Error)) throw error;
      const outputFiles = succeededOutputFiles(session.session.events(), firstTaskEventIndex);
      return {
        status: 'error',
        errorName: error.name,
        errorMessage: error.message,
        ...(outputFiles === undefined ? {} : { outputFiles }),
      };
    } finally {
      isTaskRunning = false;
      if (activeTask?.controller === controller) activeTask = undefined;
      markFinished();
    }
  });

  ipcMain.handle(DESKTOP_CHANNELS.cancelTask, () => {
    if (activeTask === undefined) throw new Error('当前没有正在执行的任务。');
    activeTask.controller.abort();
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
async function finishAndClose(window: BrowserWindow): Promise<void> {
  const running = activeTask;
  if (running !== undefined) {
    running.controller.abort();
    await running.finished;
  }

  const failure = await requestClientStateFlush(window);
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
    await restoreDesktopState();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误。';
    dialog.showErrorBox('无法恢复本地会话', message);
    app.quit();
    return;
  }

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
