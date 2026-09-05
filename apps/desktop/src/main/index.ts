import { mkdir } from 'node:fs/promises';
import { basename, join, parse, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { runTurn, type ExecutionTraceEvent } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '@agent-desktop/execution-trace';
import { createVideoAgent } from '@agent-desktop/video-agent';
import { buildAgentPrompt, findSuccessfulOutputPath } from './agent-task.js';
import { DESKTOP_CHANNELS, type AgentTaskResult, type ToolActivityEvent } from '../shared/ipc.js';

let mainWindow: BrowserWindow | null = null;
let selectedVideoPath: string | undefined;
let outputFilePath: string | undefined;
let agent: ReturnType<typeof createVideoAgent> | undefined;

function requireEnvironment(name: 'DEEPSEEK_API_KEY' | 'WHISPER_MODEL_PATH'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`缺少 ${name} 环境变量。`);
  return value;
}

function currentAgent(): ReturnType<typeof createVideoAgent> {
  if (agent !== undefined) return agent;

  const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL;
  const whisperCliPath = process.env.WHISPER_CLI_PATH;
  const visionBaseUrl = process.env.OPENAI_BASE_URL;
  agent = createVideoAgent({
    deepSeekApiKey: requireEnvironment('DEEPSEEK_API_KEY'),
    whisperModelPath: requireEnvironment('WHISPER_MODEL_PATH'),
    visionApiKey: process.env.OPENAI_API_KEY ?? '',
    ...(deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl }),
    ...(whisperCliPath === undefined ? {} : { whisperCliPath }),
    ...(visionBaseUrl === undefined ? {} : { visionBaseUrl }),
  });
  return agent;
}

function defaultOutputPath(inputPath: string): string {
  const input = parse(inputPath);
  return join(input.dir, `${input.name}-edited${input.ext || '.mp4'}`);
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
  ipcMain.handle(DESKTOP_CHANNELS.selectVideo, async () => {
    if (mainWindow === null) throw new Error('Desktop window is not available');

    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }],
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || filePath === undefined) return null;

    selectedVideoPath = filePath;
    outputFilePath = undefined;
    return { name: basename(filePath) };
  });

  ipcMain.handle(DESKTOP_CHANNELS.runAgentTask, async (_event, prompt: unknown): Promise<AgentTaskResult> => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('请输入剪辑需求。');
    }
    if (selectedVideoPath === undefined) throw new Error('请先选择视频文件。');

    const taskAgent = currentAgent();
    const requestedOutputPath = defaultOutputPath(selectedVideoPath);
    // Desktop 脚本从 app package 目录启动，Trace 仍统一写入仓库根 logs/。
    const logsDirectory = resolve(app.getAppPath(), '..', '..', 'logs');
    await mkdir(logsDirectory, { recursive: true });
    const trace = createJsonlTrace(join(logsDirectory, 'agent-trace.jsonl'));

    const result = await runTurn(
      taskAgent,
      buildAgentPrompt(prompt.trim(), selectedVideoPath, requestedOutputPath),
      async (traceEvent) => {
        await trace.write(traceEvent);
        sendToolActivity(traceEvent);
      },
    );
    if (result.response.text === undefined) {
      throw new Error('Agent 未返回最终文本回复。');
    }

    outputFilePath = findSuccessfulOutputPath(taskAgent.session.events(), result.turnId);
    return outputFilePath === undefined
      ? { responseText: result.response.text, traceId: trace.id }
      : {
          responseText: result.response.text,
          traceId: trace.id,
          outputFileName: basename(outputFilePath),
        };
  });

  ipcMain.handle(DESKTOP_CHANNELS.openOutputFile, () => {
    if (outputFilePath === undefined) throw new Error('当前没有可打开的输出文件。');
    shell.showItemInFolder(outputFilePath);
  });
}

function createWindow(): void {
  selectedVideoPath = undefined;
  outputFilePath = undefined;
  agent = undefined;
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
  void mainWindow.loadFile(join(app.getAppPath(), 'dist/renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
