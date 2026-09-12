import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, parse, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '@agent-desktop/execution-trace';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { createVideoAgent } from '@agent-desktop/video-agent';
import { runDesktopAgentTask } from './agent-task.js';
import { DESKTOP_CHANNELS, type AgentTaskResult, type ToolActivityEvent } from '../shared/ipc.js';
import {
  loadDesktopState,
  parseClientState,
  parseDesktopState,
  saveDesktopState,
  SESSION_STATE_FILE_NAME,
  type PersistedDesktopState,
} from './session-persistence.js';
import type { ClientStateSnapshot } from '@agent-desktop/client';

let mainWindow: BrowserWindow | null = null;
let outputSequence = 0;
let isTaskRunning = false;
let clientState: ClientStateSnapshot | null = null;

interface DesktopSessionState {
  readonly agent: ReturnType<typeof createVideoAgent>;
  readonly selectedVideoPaths: string[];
  readonly outputFilePaths: Map<string, string>;
}

const sessions = new Map<string, DesktopSessionState>();
let activeSessionId = '';

function requireEnvironment(name: 'DEEPSEEK_API_KEY' | 'WHISPER_MODEL_PATH'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`缺少 ${name} 环境变量。`);
  return value;
}

/** 创建独立的 Agent、Session、附件和产物状态；恢复时显式注入已有事件。 */
function createDesktopSession(
  id: string = randomUUID(),
  initialEvents: readonly SessionEvent[] = [],
): string {
  const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL;
  const whisperCliPath = process.env.WHISPER_CLI_PATH;
  const whisperModelPath = process.env.WHISPER_MODEL_PATH;
  const visionBaseUrl = process.env.OPENAI_BASE_URL;
  const session = {
    agent: createVideoAgent({
      deepSeekApiKey: requireEnvironment('DEEPSEEK_API_KEY'),
      visionApiKey: process.env.OPENAI_API_KEY ?? '',
      ...(whisperModelPath === undefined ? {} : { whisperModelPath }),
      ...(deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl }),
      ...(whisperCliPath === undefined ? {} : { whisperCliPath }),
      ...(visionBaseUrl === undefined ? {} : { visionBaseUrl }),
      session: new InMemorySession(initialEvents),
    }),
    selectedVideoPaths: [],
    outputFilePaths: new Map<string, string>(),
  } satisfies DesktopSessionState;
  sessions.set(id, session);
  activeSessionId = id;
  return id;
}

function persistenceFilePath(): string {
  return join(app.getPath('userData'), SESSION_STATE_FILE_NAME);
}

function currentPersistedState(snapshot: ClientStateSnapshot): PersistedDesktopState {
  return {
    activeSessionId,
    outputSequence,
    sessions: [...sessions].map(([id, session]) => ({
      id,
      selectedVideoPaths: session.selectedVideoPaths,
      outputFilePaths: Object.fromEntries(session.outputFilePaths),
      events: session.agent.session.events(),
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
    session.selectedVideoPaths.push(...savedSession.selectedVideoPaths);
    for (const [fileName, outputPath] of Object.entries(savedSession.outputFilePaths)) {
      session.outputFilePaths.set(fileName, outputPath);
    }
  }
  activeSessionId = persisted.activeSessionId;
}

function activeSession(): DesktopSessionState {
  return sessions.get(activeSessionId)!;
}

function defaultOutputPath(inputPath: string, sequence: number): string {
  const input = parse(inputPath);
  const suffix = sequence === 1 ? '-edited' : `-edited-${sequence}`;
  return join(input.dir, `${input.name}${suffix}${input.ext || '.mp4'}`);
}

function sendToolActivity(event: ExecutionTraceEvent): void {
  if (event.type !== 'tool.started'
    && event.type !== 'tool.completed'
    && event.type !== 'tool.failed') {
    return;
  }

  if (mainWindow?.isDestroyed() === false) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.agentEvent, event satisfies ToolActivityEvent);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.loadClientState, () => clientState);

  ipcMain.handle(DESKTOP_CHANNELS.saveClientState, async (_event, state: unknown) => {
    if (isTaskRunning) throw new Error('Agent 正在执行，无法保存未完成的会话状态。');
    const snapshot = parseClientState(state);
    const persisted = parseDesktopState(currentPersistedState(snapshot));
    // 复用磁盘读取的同一结构校验，保证 Renderer 会话与 Main 运行态一一对应。
    await saveDesktopState(persistenceFilePath(), persisted);
    clientState = snapshot;
  });

  ipcMain.handle(DESKTOP_CHANNELS.getActiveSessionId, () => activeSessionId);

  ipcMain.handle(DESKTOP_CHANNELS.selectVideo, async () => {
    if (mainWindow === null) throw new Error('Desktop window is not available');
    const session = activeSession();

    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;

    session.selectedVideoPaths.push(...selection.filePaths);
    return session.selectedVideoPaths.map((filePath) => ({ name: basename(filePath) }));
  });

  ipcMain.handle(DESKTOP_CHANNELS.removeVideo, (_event, index: unknown) => {
    const session = activeSession();
    if (typeof index !== 'number' || !Number.isInteger(index)
      || index < 0 || index >= session.selectedVideoPaths.length) {
      throw new Error('无效的视频附件序号。');
    }

    session.selectedVideoPaths.splice(index, 1);
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

  ipcMain.handle(DESKTOP_CHANNELS.runAgentTask, async (_event, prompt: unknown): Promise<AgentTaskResult> => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('请输入剪辑需求。');
    }

    const session = activeSession();
    isTaskRunning = true;
    try {
      const requestedOutputPath = session.selectedVideoPaths.length === 0
        ? undefined
        : defaultOutputPath(session.selectedVideoPaths[0]!, outputSequence + 1);
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
        session.agent,
        prompt.trim(),
        session.selectedVideoPaths,
        requestedOutputPath,
        async (traceEvent) => {
          await trace.write(traceEvent);
          sendToolActivity(traceEvent);
        },
      );
      if (result.outputPath === undefined) {
        return { responseText: result.responseText, traceId: trace.id };
      }

      const outputFileName = basename(result.outputPath);
      session.outputFilePaths.set(outputFileName, result.outputPath);
      return {
        responseText: result.responseText,
        traceId: trace.id,
        outputFileName,
      };
    } finally {
      isTaskRunning = false;
    }
  });

  ipcMain.handle(DESKTOP_CHANNELS.openOutputFile, (_event, fileName: unknown) => {
    if (typeof fileName !== 'string') throw new Error('无效的输出文件名。');
    const outputFilePath = activeSession().outputFilePaths.get(fileName);
    if (outputFilePath === undefined) throw new Error('找不到对应的输出文件。');
    shell.showItemInFolder(outputFilePath);
  });
}

function createWindow(): void {
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
  const rendererUrl = process.env.DESKTOP_RENDERER_URL;
  if (rendererUrl === undefined) {
    void mainWindow.loadFile(join(app.getAppPath(), 'dist/renderer/index.html'));
  } else {
    // 开发模式加载 Vite Dev Server，让 Renderer 的 CSS 和 React 修改即时热更新。
    void mainWindow.loadURL(rendererUrl);
  }
  mainWindow.on('closed', () => {
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
