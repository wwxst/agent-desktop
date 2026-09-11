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
    createVideoAgent: vi.fn(() => {
      const events: unknown[] = [];
      const agent = {
        session: {
          append: (event: unknown) => events.push(event),
          events: () => events,
        },
      };
      agents.push(agent);
      return agent;
    }),
    runDesktopAgentTask: vi.fn(),
    showOpenDialog: vi.fn(),
    showItemInFolder: vi.fn(),
    mkdir: vi.fn(async () => undefined),
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

vi.mock('node:fs/promises', () => ({ mkdir: mainMocks.mkdir }));

vi.mock('electron', () => ({
  app: {
    whenReady: () => Promise.resolve(),
    on: mainMocks.appOn,
    getAppPath: () => 'E:\\repo\\apps\\desktop',
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
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    process.env.WHISPER_MODEL_PATH = 'D:\\models\\whisper.bin';
    await import('../src/main/index.js');
    await vi.waitFor(() => expect(mainMocks.createVideoAgent).toHaveBeenCalledOnce());
  });

  afterAll(() => {
    if (previousDeepSeekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekApiKey;
    if (previousWhisperModelPath === undefined) delete process.env.WHISPER_MODEL_PATH;
    else process.env.WHISPER_MODEL_PATH = previousWhisperModelPath;
  });

  it('keeps independent Agent, Session, attachment, and output state for each desktop session', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const openOutputFile = mainMocks.handlers.get('desktop:open-output-file');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const switchSession = mainMocks.handlers.get('desktop:switch-session');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(openOutputFile).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');
    expect(switchSession).toBeTypeOf('function');
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

    expect(() => newSession!({})).toThrow('Agent 正在执行');
    expect(() => switchSession!({}, 'missing-session')).toThrow('Agent 正在执行');
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
    expect(mainMocks.createVideoAgent).toHaveBeenCalledTimes(2);
    const secondAgent = mainMocks.agents[1]!;
    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.session).not.toBe(firstAgent.session);
    expect(secondAgent.session.events()).toEqual([]);
    expect(() => openOutputFile!({}, 'first-output.mp4')).toThrow('找不到对应的输出文件');

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '已记住 952。',
      turnId: 'turn-session-2',
      outputPath: undefined,
    });
    await runAgentTask!({}, '记住数字 952');
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      secondAgent,
      '记住数字 952',
      [],
      undefined,
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
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      firstAgent,
      '我刚才让你记住什么数字？',
      ['D:\\videos\\input.mp4'],
      expect.stringContaining('input-edited-'),
      expect.any(Function),
    );
    openOutputFile!({}, 'first-output.mp4');
    expect(mainMocks.showItemInFolder).toHaveBeenLastCalledWith('D:\\videos\\first-output.mp4');
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
});
