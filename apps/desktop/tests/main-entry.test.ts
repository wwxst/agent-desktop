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

  it('replaces the Agent and Session, clears Main state, and rejects reset while running', async () => {
    const selectVideo = mainMocks.handlers.get('desktop:select-video');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const openOutputFile = mainMocks.handlers.get('desktop:open-output-file');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(openOutputFile).toBeTypeOf('function');
    expect(newSession).toBeTypeOf('function');

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
    await newSession!({});

    expect(mainMocks.createVideoAgent).toHaveBeenCalledTimes(2);
    const secondAgent = mainMocks.agents[1]!;
    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.session).not.toBe(firstAgent.session);
    expect(secondAgent.session.events()).toEqual([]);
    expect(() => openOutputFile!({}, 'first-output.mp4')).toThrow('找不到对应的输出文件');

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '当前会话没有这个数字。',
      turnId: 'turn-session-2',
      outputPath: undefined,
    });
    await runAgentTask!({}, '刚才的数字是多少？');
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      secondAgent,
      '刚才的数字是多少？',
      [],
      undefined,
      expect.any(Function),
    );
  });
});
