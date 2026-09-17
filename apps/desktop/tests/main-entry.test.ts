import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type IpcHandler = (...args: unknown[]) => unknown;

const mainMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const agents: Array<{
    readonly session: {
      append(event: unknown): void;
      events(): readonly unknown[];
    };
  }> = [];

  return {
    handlers,
    agents,
    createVideoAgent: vi.fn((options: {
      session: {
        append(event: unknown): void;
        events(): readonly unknown[];
      };
    }) => {
      const agent = {
        session: options.session,
      };
      agents.push(agent);
      return agent;
    }),
    runDesktopAgentTask: vi.fn(),
    showOpenDialog: vi.fn(),
    showItemInFolder: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    writeFile: vi.fn(async () => undefined),
    traceWrite: vi.fn(async () => undefined),
    ipcHandle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    windowOn: vi.fn(),
    appOn: vi.fn(),
    loadFile: vi.fn(async (_path: string) => undefined),
    loadUrl: vi.fn(async (_url: string) => undefined),
    webContentsSend: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: mainMocks.mkdir,
  readFile: mainMocks.readFile,
  writeFile: mainMocks.writeFile,
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => Promise.resolve(),
    on: mainMocks.appOn,
    getAppPath: () => 'E:\\repo\\apps\\desktop',
    getPath: () => 'E:\\user-data',
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows() { return [{}]; }

    readonly webContents = { send: mainMocks.webContentsSend };

    isDestroyed() { return false; }

    loadFile(path: string) { return mainMocks.loadFile(path); }

    loadURL(url: string) { return mainMocks.loadUrl(url); }

    on(event: string, listener: () => void) { return mainMocks.windowOn(event, listener); }
  },
  dialog: { showOpenDialog: mainMocks.showOpenDialog },
  ipcMain: { handle: mainMocks.ipcHandle },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
  shell: { showItemInFolder: mainMocks.showItemInFolder },
}));

vi.mock('@agent-desktop/video-agent', () => ({
  createVideoAgent: mainMocks.createVideoAgent,
}));

vi.mock('@agent-desktop/execution-trace', () => ({
  createJsonlTrace: () => ({ id: 'trace-main', write: mainMocks.traceWrite }),
}));

vi.mock('../src/main/agent-task.js', () => ({
  runDesktopAgentTask: mainMocks.runDesktopAgentTask,
}));

describe('desktop main session lifecycle', () => {
  const previousDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
  const previousWhisperModelPath = process.env.WHISPER_MODEL_PATH;

  beforeAll(async () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.WHISPER_MODEL_PATH = 'D:\\models\\whisper.bin';
    await import('../src/main/index.js');
    await vi.waitFor(() => expect(mainMocks.handlers.get('desktop:run-agent-task')).toBeTypeOf('function'));
    expect(mainMocks.createVideoAgent).not.toHaveBeenCalled();
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });

  afterAll(() => {
    if (previousDeepSeekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekApiKey;
    if (previousWhisperModelPath === undefined) delete process.env.WHISPER_MODEL_PATH;
    else process.env.WHISPER_MODEL_PATH = previousWhisperModelPath;
  });

  it('starts without a DeepSeek key and reports the missing key only when a task is sent', async () => {
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    expect(runAgentTask).toBeTypeOf('function');
    const configuredKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await expect(runAgentTask!({}, '测试任务')).rejects.toThrow(
        '请先在设置中配置 DeepSeek API Key。',
      );
      expect(mainMocks.createVideoAgent).not.toHaveBeenCalled();
    } finally {
      if (configuredKey !== undefined) process.env.DEEPSEEK_API_KEY = configuredKey;
    }
  });

  it('keeps independent Agent, Session, attachment, and output state for each desktop session', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const openOutputFile = mainMocks.handlers.get('desktop:open-output-file');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const switchSession = mainMocks.handlers.get('desktop:switch-session');
    const deleteSession = mainMocks.handlers.get('desktop:delete-session');
    const saveRuntimeSettings = mainMocks.handlers.get('desktop:save-runtime-settings');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(openOutputFile).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');
    expect(switchSession).toBeTypeOf('function');
    expect(saveRuntimeSettings).toBeTypeOf('function');
    const firstSessionId = await getActiveSessionId!({});

    mainMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\videos\\input.mp4'],
    });
    await selectVideo!({});

    let resolveRunningTask: ((result: {
      readonly responseText: string;
      readonly turnId: string;
      readonly outputPath: string;
    }) => void) | undefined;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRunningTask = resolve;
    }));
    const runningTask = runAgentTask!({}, '记住数字 731');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask).toHaveBeenCalledOnce());

    expect(() => deleteSession!({}, firstSessionId)).toThrow('Agent 正在执行');

    expect(() => newSession!({})).toThrow('Agent 正在执行');
    expect(() => switchSession!({}, 'missing-session')).toThrow('Agent 正在执行');
    await expect(saveRuntimeSettings!({}, { deepSeekModel: 'next-model' })).rejects.toThrow(
      'Agent 正在执行，无法保存设置。',
    );
    expect(mainMocks.createVideoAgent).toHaveBeenCalledOnce();

    resolveRunningTask?.({
      responseText: '已记住。',
      turnId: 'turn-session-1',
      outputPath: 'D:\\videos\\first-output.mp4',
    });
    await runningTask;
    openOutputFile!({}, 'first-output.mp4');
    expect(mainMocks.showItemInFolder).toHaveBeenCalledWith('D:\\videos\\first-output.mp4');

    const firstAgent = mainMocks.agents[0]!;
    firstAgent.session.append({ type: 'user.message', content: '记住数字 731' });
    const secondSessionId = await newSession!({});

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(mainMocks.createVideoAgent).toHaveBeenCalledOnce();
    expect(() => openOutputFile!({}, 'first-output.mp4')).toThrow('找不到对应的输出文件');

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '已记住 952。',
      turnId: 'turn-session-2',
      outputPath: undefined,
    });
    await runAgentTask!({}, '记住数字 952');
    const secondAgent = mainMocks.agents[1]!;
    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.session).not.toBe(firstAgent.session);
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      secondAgent,
      '记住数字 952',
      [],
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    secondAgent.session.append({ type: 'user.message', content: '记住数字 952' });

    await switchSession!({}, firstSessionId);
    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '731',
      turnId: 'turn-session-1-follow-up',
      outputPath: undefined,
    });
    await runAgentTask!({}, '我刚才让你记住什么数字？');
    const followUpAgent = mainMocks.agents[2]!;
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      followUpAgent,
      '我刚才让你记住什么数字？',
      ['D:\\videos\\input.mp4'],
      expect.stringContaining('input-edited-'),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    openOutputFile!({}, 'first-output.mp4');
    expect(mainMocks.showItemInFolder).toHaveBeenLastCalledWith('D:\\videos\\first-output.mp4');
    expect(followUpAgent).not.toBe(firstAgent);
    expect(followUpAgent.session).toBe(firstAgent.session);
    expect(firstAgent.session.events()).not.toContainEqual({ type: 'user.message', content: '记住数字 952' });

    await switchSession!({}, secondSessionId);
    expect(secondAgent.session.events()).toContainEqual({ type: 'user.message', content: '记住数字 952' });
    expect(secondAgent.session.events()).not.toContainEqual({ type: 'user.message', content: '记住数字 731' });
    expect(() => switchSession!({}, 'missing-session')).toThrow('找不到对应的会话');
  });

  it('keeps default output paths unique across new sessions for the same video', async () => {
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');

    await newSession!({});
    mainMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\videos\\video.mp4'],
    });
    const requestedOutputPaths: Array<string | undefined> = [];
    mainMocks.runDesktopAgentTask.mockImplementation(async (
      _agent: unknown,
      _prompt: unknown,
      _selectedVideoPaths: unknown,
      requestedOutputPath: string | undefined,
    ) => {
      requestedOutputPaths.push(requestedOutputPath);
      return {
        responseText: '剪辑完成。',
        turnId: `turn-output-${requestedOutputPaths.length}`,
        outputPath: requestedOutputPath,
      };
    });

    await selectVideo!({});
    await runAgentTask!({}, '剪辑视频');
    await newSession!({});
    await selectVideo!({});
    await runAgentTask!({}, '再次剪辑视频');

    expect(requestedOutputPaths).toHaveLength(2);
    expect(requestedOutputPaths[1]).not.toBe(requestedOutputPaths[0]);
  });

  it('runs fixed-time video editing without a Whisper model path', async () => {
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');

    const configuredWhisperModelPath = process.env.WHISPER_MODEL_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    try {
      await newSession!({});
      mainMocks.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['D:\\videos\\fixed-time.mp4'],
      });
      mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
        responseText: '已裁掉开头 1 秒。',
        turnId: 'turn-fixed-time',
        outputPath: 'D:\\videos\\fixed-time-edited.mp4',
      });
      await selectVideo!({});

      await expect(runAgentTask!({}, '把这个视频开头裁掉 1 秒并输出新视频')).resolves.toMatchObject({
        responseText: '已裁掉开头 1 秒。',
        outputFileName: 'fixed-time-edited.mp4',
      });
    } finally {
      if (configuredWhisperModelPath === undefined) delete process.env.WHISPER_MODEL_PATH;
      else process.env.WHISPER_MODEL_PATH = configuredWhisperModelPath;
    }
  });

  it('deletes the only runtime session and returns the exact replacement id without deleting files', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const deleteSession = mainMocks.handlers.get('desktop:delete-session');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(deleteSession).toBeTypeOf('function');

    const onlySessionId = await getActiveSessionId!({});
    const replacementId = deleteSession!({}, onlySessionId);
    expect(replacementId).not.toBe(onlySessionId);
    expect(await getActiveSessionId!({})).toBe(replacementId);
    expect(() => deleteSession!({}, onlySessionId)).toThrow('找不到对应的会话');
  });

  it('deletes runtime sessions without deleting artifact files and returns the Host active id', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const switchSession = mainMocks.handlers.get('desktop:switch-session');
    const deleteSession = mainMocks.handlers.get('desktop:delete-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');
    expect(switchSession).toBeTypeOf('function');
    expect(deleteSession).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');

    const baseSessionId = await getActiveSessionId!({});
    const firstExtraSessionId = await newSession!({});
    const secondExtraSessionId = await newSession!({});
    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '已记住。',
      turnId: 'turn-delete-session',
      outputPath: undefined,
    });
    await runAgentTask!({}, '只属于被删除会话');
    const secondExtraAgent = mainMocks.agents.at(-1)!;
    secondExtraAgent.session.append({ type: 'user.message', content: '只属于被删除会话' });

    await switchSession!({}, baseSessionId);
    expect(deleteSession!({}, firstExtraSessionId)).toBe(baseSessionId);
    expect(deleteSession!({}, secondExtraSessionId)).toBe(baseSessionId);
    expect(secondExtraAgent.session.events()).toContainEqual({
      type: 'user.message',
      content: '只属于被删除会话',
    });

    expect(await getActiveSessionId!({})).toBe(baseSessionId);
  });

  it('keeps artifact files and continues output sequence after deleting the last session', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const deleteSession = mainMocks.handlers.get('desktop:delete-session');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(deleteSession).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');

    const directory = mkdtempSync(join(tmpdir(), 'agent-desktop-delete-'));
    try {
      const inputPath = join(directory, 'input.mp4');
      const requestedOutputPaths: string[] = [];
      await newSession!({});
      mainMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [inputPath] });
      mainMocks.runDesktopAgentTask.mockImplementation(async (
        _agent: unknown,
        _prompt: unknown,
        _selectedVideoPaths: unknown,
        requestedOutputPath: string | undefined,
      ) => {
        const outputPath = requestedOutputPath!;
        requestedOutputPaths.push(outputPath);
        writeFileSync(outputPath, 'artifact');
        return {
          responseText: '剪辑完成。',
          turnId: `turn-delete-${requestedOutputPaths.length}`,
          outputPath,
        };
      });

      await selectVideo!({});
      await runAgentTask!({}, '生成第一个视频');
      const deletedSessionId = await getActiveSessionId!({});
      const replacementSessionId = deleteSession!({}, deletedSessionId);

      expect(replacementSessionId).not.toBe(deletedSessionId);
      expect(existsSync(requestedOutputPaths[0]!)).toBe(true);

      await newSession!({});
      await selectVideo!({});
      await runAgentTask!({}, '生成第二个视频');
      const outputSequence = (path: string) => {
        const match = /-edited(?:-(\d+))?\.mp4$/.exec(path);
        return match?.[1] === undefined ? 1 : Number(match[1]);
      };
      expect(outputSequence(requestedOutputPaths[1]!)).toBe(
        outputSequence(requestedOutputPaths[0]!) + 1,
      );
      expect(existsSync(requestedOutputPaths[1]!)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards Model text deltas to the Renderer as agent events', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    expect(runAgentTask).toBeTypeOf('function');
    await newSession!({});

    mainMocks.webContentsSend.mockClear();
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async (
      _agent: unknown,
      _prompt: unknown,
      _selectedVideoPaths: unknown,
      _outputPath: unknown,
      _trace: unknown,
      _signal: unknown,
      onTextDelta: (delta: string) => void,
    ) => {
      onTextDelta('实时');
      onTextDelta('增量');
      return { responseText: '完成', turnId: 'turn-delta', outputPath: undefined };
    });

    await expect(runAgentTask!({}, '流式任务')).resolves.toMatchObject({ responseText: '完成' });

    expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:agent-event', {
      type: 'text.delta',
      delta: '实时',
    });
    expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:agent-event', {
      type: 'text.delta',
      delta: '增量',
    });
  });

  it('cancels only the active task and clears the controller for the next task', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const cancelTask = mainMocks.handlers.get('desktop:cancel-task');
    expect(cancelTask).toBeTypeOf('function');
    await newSession!({});

    mainMocks.runDesktopAgentTask.mockImplementationOnce(async (
      _agent: unknown,
      _prompt: unknown,
      _selectedVideoPaths: unknown,
      _outputPath: unknown,
      _trace: unknown,
      signal: AbortSignal,
    ) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        responseText: '停止', turnId: 'turn-cancelled', outputPath: undefined,
      }), { once: true });
    }));

    const priorCalls = mainMocks.runDesktopAgentTask.mock.calls.length;
    const running = runAgentTask!({}, '长任务');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask.mock.calls.length).toBe(priorCalls + 1));
    expect(cancelTask!({})).toBeUndefined();
    await expect(running).resolves.toMatchObject({ responseText: '停止' });
    expect(() => cancelTask!({})).toThrow('当前没有正在执行的任务');
    const cancelledAgent = mainMocks.agents.at(-1)!;
    cancelledAgent.session.append({ type: 'user.message', content: '取消前上下文' });

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '下一条完成', turnId: 'turn-after-cancel', outputPath: undefined,
    });
    await expect(runAgentTask!({}, '下一条')).resolves.toMatchObject({ responseText: '下一条完成' });
    expect(mainMocks.agents.at(-1)!.session).toBe(cancelledAgent.session);
    expect(cancelledAgent.session.events()).toContainEqual({
      type: 'user.message', content: '取消前上下文',
    });
  });
});
