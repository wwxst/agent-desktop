import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DesktopTaskOptions } from '../src/main/agent-task.js';

type IpcHandler = (...args: unknown[]) => unknown;

const mainMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const agents: Array<{
    readonly session: {
      append(event: unknown): void;
      events(): readonly unknown[];
    };
  }> = [];
  // 组装参数要保留：宿主注入的工作目录端口只有在这里才能验证真实形状。
  const agentOptions: Array<{
    readonly workspace?: {
      confirmedDirectory(): string | undefined;
      requestApproval(target: { kind: 'directory' | 'create-file'; path: string }, signal?: AbortSignal): Promise<boolean>;
      confirmDirectory(directory: string): void;
    };
  }> = [];
  // 窗口级监听器由主进程在创建窗口时注册，测试需要拿到它们验证外链与关闭收尾行为。
  const windowHandlers: {
    open?: (details: { readonly url: string }) => { readonly action: string };
    navigate?: (event: { preventDefault(): void }, url: string) => void;
    webContents: Map<string, (...args: unknown[]) => void>;
    window: Map<string, (event: { preventDefault(): void }) => void>;
  } = { webContents: new Map(), window: new Map() };
  const onceHandlers = new Map<string, (event: unknown, payload: unknown) => void>();

  return {
    handlers,
    agents,
    agentOptions,
    windowHandlers,
    onceHandlers,
    openExternal: vi.fn(),
    openPath: vi.fn(async () => ''),
    setWindowOpenHandler: vi.fn((handler: (details: { readonly url: string }) => { readonly action: string }) => {
      windowHandlers.open = handler;
    }),
    webContentsOn: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      windowHandlers.webContents.set(event, listener);
      if (event === 'will-navigate') {
        windowHandlers.navigate = listener as (event: { preventDefault(): void }, url: string) => void;
      }
    }),
    createVideoAgent: vi.fn((options: {
      session: {
        append(event: unknown): void;
        events(): readonly unknown[];
      };
      workspace?: {
        confirmedDirectory(): string | undefined;
        requestApproval(target: { kind: 'directory' | 'create-file'; path: string }, signal?: AbortSignal): Promise<boolean>;
        confirmDirectory(directory: string): void;
      };
    }) => {
      const agent = {
        session: options.session,
        tools: { list: () => [], register: () => undefined },
        model: { complete: async () => ({ text: '测试任务标题', toolCalls: [] }) },
      };
      agents.push(agent);
      agentOptions.push(options);
      return agent;
    }),
    runDesktopAgentTask: vi.fn(),
    extensionRuntimes: [] as Array<{ runHooks: (event: string, input: Readonly<Record<string, unknown>>) => Promise<void> }>,
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
    showItemInFolder: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    traceWrite: vi.fn(async () => undefined),
    ipcHandle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    ipcOnce: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => void) => {
      onceHandlers.set(channel, handler);
    }),
    windowOn: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      windowHandlers.window.set(event, listener);
    }),
    windowDestroy: vi.fn(),
    appOn: vi.fn(),
    loadFile: vi.fn(async (_path: string) => undefined),
    loadUrl: vi.fn(async (_url: string) => undefined),
    webContentsSend: vi.fn(),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: mainMocks.mkdir,
  readFile: mainMocks.readFile,
  writeFile: mainMocks.writeFile,
}));

vi.mock('../src/main/desktop-database.js', async (importOriginal) => {
  const documents = new Map<string, object>();
  return {
    ...(await importOriginal<typeof import('../src/main/desktop-database.js')>()),
    readDesktopDocument: (_path: string, name: string) => documents.get(name) ?? null,
    writeDesktopDocuments: (_path: string, updates: readonly { name: string; value: object }[]) => {
      for (const update of updates) documents.set(update.name, update.value);
    },
  };
});

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

    readonly webContents = {
      send: mainMocks.webContentsSend,
      setWindowOpenHandler: mainMocks.setWindowOpenHandler,
      on: mainMocks.webContentsOn,
    };

    isDestroyed() { return false; }

    destroy() { return mainMocks.windowDestroy(); }

    loadFile(path: string) { return mainMocks.loadFile(path); }

    loadURL(url: string) { return mainMocks.loadUrl(url); }

    on(event: string, listener: (event: { preventDefault(): void }) => void) {
      return mainMocks.windowOn(event, listener);
    }
  },
  dialog: { showOpenDialog: mainMocks.showOpenDialog, showErrorBox: mainMocks.showErrorBox },
  ipcMain: { handle: mainMocks.ipcHandle, once: mainMocks.ipcOnce },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
  shell: { showItemInFolder: mainMocks.showItemInFolder, openExternal: mainMocks.openExternal, openPath: mainMocks.openPath },
}));

vi.mock('@agent-desktop/video-agent', async (importOriginal) => ({
  // 交付事实的读取与逐项投影是纯函数，直接用真实实现，避免替身与生产规则漂移。
  ...(await importOriginal<typeof import('@agent-desktop/video-agent')>()),
  createVideoAgent: mainMocks.createVideoAgent,
}));

vi.mock('@agent-desktop/execution-trace', () => ({
  createJsonlTrace: () => ({ id: 'trace-main', write: mainMocks.traceWrite }),
}));

vi.mock('../src/main/agent-task.js', async (importOriginal) => ({
  // 产物识别与逐项交付投影是纯函数，直接用真实实现，避免替身与生产规则漂移。
  ...(await importOriginal<typeof import('../src/main/agent-task.js')>()),
  runDesktopAgentTask: mainMocks.runDesktopAgentTask,
}));

vi.mock('../src/main/extension-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/main/extension-runtime.js')>();
  return { ...original, prepareExtensions: async (...args: Parameters<typeof original.prepareExtensions>) => {
    // 保留真实运行时，只观察宿主调度事件的次数与来源。
    const runtime = await original.prepareExtensions(...args);
    vi.spyOn(runtime, 'runHooks');
    mainMocks.extensionRuntimes.push(runtime);
    return runtime;
  } };
});

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
      await expect(runAgentTask!({}, '测试任务')).resolves.toEqual({
        status: 'error',
        errorName: 'Error',
        errorMessage: '请先在设置中配置当前对话模型的 API 密钥。',
      });
      expect(mainMocks.createVideoAgent).not.toHaveBeenCalled();
    } finally {
      if (configuredKey !== undefined) process.env.DEEPSEEK_API_KEY = configuredKey;
    }
  });
  it('opens only a secret-free model configuration snapshot through the host', async () => {
    const open = mainMocks.handlers.get('desktop:open-model-config')!;
    await open({});
    const write = mainMocks.writeFile.mock.calls.at(-1) as unknown as [string, string];
    expect(write[0]).toMatch(/agent-desktop-model-config\.json$/);
    const snapshot = JSON.parse(write[1]) as { modelProviders: object[] };
    expect(snapshot.modelProviders).toHaveLength(2);
    expect(snapshot.modelProviders.every(provider => !('apiKey' in provider))).toBe(true);
    expect(write[1]).not.toContain('test-deepseek-key');
    expect(mainMocks.openPath).toHaveBeenCalledWith(write[0]);
    mainMocks.openPath.mockResolvedValueOnce('无法打开文件');
    await expect(open({})).rejects.toThrow('无法打开文件');
  });

  it('keeps independent Agent, Session, attachment, and output state for each desktop session', async () => {
    const artifactDirectory = mkdtempSync(join(tmpdir(), 'agent-desktop-artifact-'));
    const firstOutputPath = join(artifactDirectory, 'first-output.mp4');
    writeFileSync(firstOutputPath, 'artifact');
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const selectVideo = mainMocks.handlers.get('desktop:select-attachment-files');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const revealFile = mainMocks.handlers.get('desktop:reveal-file');
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const switchSession = mainMocks.handlers.get('desktop:switch-session');
    const deleteSession = mainMocks.handlers.get('desktop:delete-session');
    const saveRuntimeSettings = mainMocks.handlers.get('desktop:save-runtime-settings');
    expect(getActiveSessionId).toBeTypeOf('function');
    expect(selectVideo).toBeTypeOf('function');
    expect(runAgentTask).toBeTypeOf('function');
    expect(revealFile).toBeTypeOf('function');
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
      readonly artifacts: readonly { readonly toolCallId: string; readonly path: string }[];
    }) => void) | undefined;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRunningTask = resolve;
    }));
    const runningTask = runAgentTask!({}, '记住数字 731');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask).toHaveBeenCalledOnce());

    await expect(deleteSession!({}, firstSessionId)).rejects.toThrow('Agent 正在执行');

    await expect(newSession!({})).rejects.toThrow('Agent 正在执行');
    expect(() => switchSession!({}, 'missing-session')).toThrow('Agent 正在执行');
    await expect(saveRuntimeSettings!({}, { deepSeekModel: 'next-model' })).rejects.toThrow(
      'Agent 正在执行，无法保存设置。',
    );
    expect(mainMocks.createVideoAgent).toHaveBeenCalledOnce();

    resolveRunningTask?.({
      responseText: '已记住。',
      turnId: 'turn-session-1',
      artifacts: [{ toolCallId: 'call-artifact', path: firstOutputPath }],
    });
    await expect(runningTask).resolves.toMatchObject({
      status: 'success',
      result: {
        outputFiles: [{ path: firstOutputPath, fileName: 'first-output.mp4' }],
      },
    });

    const firstAgent = mainMocks.agents[0]!;
    firstAgent.session.append({ type: 'user.message', content: '记住数字 731' });
    // 产物路径来自模型写入 Session 的工具输入，定位时按会话事实校验。
    firstAgent.session.append({
      type: 'tool.called',
      turnId: 'turn-session-1',
      stepId: 'step-session-1',
      toolCallId: 'call-artifact',
      name: 'trim_video',
      input: { outputPath: firstOutputPath },
    });
    revealFile!({}, firstOutputPath);
    expect(mainMocks.showItemInFolder).toHaveBeenCalledWith(firstOutputPath);

    const secondSessionId = await newSession!({});

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(mainMocks.createVideoAgent).toHaveBeenCalledOnce();
    expect(() => revealFile!({}, firstOutputPath)).toThrow('该文件不属于当前会话');

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '已记住 952。',
      turnId: 'turn-session-2',
      artifacts: [],
    });
    await runAgentTask!({}, '记住数字 952');
    const secondAgent = mainMocks.agents[1]!;
    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.session).not.toBe(firstAgent.session);
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      secondAgent,
      '记住数字 952',
      [],
      expect.objectContaining({
        trace: expect.any(Function),
        signal: expect.any(AbortSignal),
        onModelText: expect.any(Function),
        onToolResult: expect.any(Function),
        onToolProgress: expect.any(Function),
      }),
    );
    secondAgent.session.append({ type: 'user.message', content: '记住数字 952' });

    await switchSession!({}, firstSessionId);
    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '731',
      turnId: 'turn-session-1-follow-up',
      artifacts: [],
    });
    await runAgentTask!({}, '我刚才让你记住什么数字？');
    const followUpAgent = mainMocks.agents[2]!;
    expect(mainMocks.runDesktopAgentTask).toHaveBeenLastCalledWith(
      followUpAgent,
      '我刚才让你记住什么数字？',
      [{ path: 'D:\\videos\\input.mp4', role: 'video' }],
      expect.objectContaining({
        trace: expect.any(Function),
        signal: expect.any(AbortSignal),
        onModelText: expect.any(Function),
        onToolResult: expect.any(Function),
        onToolProgress: expect.any(Function),
      }),
    );
    revealFile!({}, firstOutputPath);
    expect(mainMocks.showItemInFolder).toHaveBeenLastCalledWith(firstOutputPath);
    expect(followUpAgent).not.toBe(firstAgent);
    expect(followUpAgent.session).toBe(firstAgent.session);
    expect(firstAgent.session.events()).not.toContainEqual({ type: 'user.message', content: '记住数字 952' });

    await switchSession!({}, secondSessionId);
    expect(secondAgent.session.events()).toContainEqual({ type: 'user.message', content: '记住数字 952' });
    expect(secondAgent.session.events()).not.toContainEqual({ type: 'user.message', content: '记住数字 731' });
    expect(() => switchSession!({}, 'missing-session')).toThrow('找不到对应的会话');
    rmSync(artifactDirectory, { recursive: true, force: true });
  });

  it('projects per-item delivery results from the session facts of the turn', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    await newSession!({});

    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const agent = mainMocks.agents.at(-1)!;
      const turnId = 'turn-delivery';
      const stepId = 'step-delivery';
      agent.session.append({ type: 'turn.started', turnId });
      agent.session.append({ type: 'step.started', turnId, stepId });
      // 真实链路里这些事实由交付工具产生；这里直接写入同一份结构，验证宿主的读取投影。
      agent.session.append({
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: 'call-declare',
        name: 'declare_video_outputs',
        input: {},
      });
      agent.session.append({
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId: 'call-declare',
        result: {
          status: 'success',
          output: {
            kind: 'video.outputs.declared',
            items: [
              {
                id: 'out-1',
                sourcePaths: ['D:\\videos\\a.mp4'],
                target: { kind: 'explicit', path: 'D:\\videos\\a-result.mp4' },
                workingDirectory: 'D:\\videos\\.agent-output-out-1',
                requirements: [{ id: 'r1', kind: 'decodable-video' }],
              },
              {
                id: 'out-2',
                sourcePaths: ['D:\\videos\\b.mp4'],
                target: { kind: 'explicit', path: 'D:\\videos\\b-result.mp4' },
                workingDirectory: 'D:\\videos\\.agent-output-out-2',
                requirements: [{ id: 'r1', kind: 'decodable-video' }],
              },
            ],
          },
        },
      });
      agent.session.append({
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId: 'call-publish',
        name: 'publish_video_output',
        input: { validationId: 'validation-1' },
      });
      agent.session.append({
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId: 'call-publish',
        result: {
          status: 'success',
          output: {
            kind: 'video.output.published',
            output: { outputItemId: 'out-1', validationId: 'validation-1', path: 'D:\\videos\\a-result.mp4' },
          },
          artifacts: ['D:\\videos\\a-result.mp4'],
        },
      });
      return {
        responseText: '第一项已交付。',
        turnId,
        artifacts: [{ toolCallId: 'call-publish', path: 'D:\\videos\\a-result.mp4' }],
      };
    });

    await expect(runAgentTask!({}, '分别输出两个视频')).resolves.toMatchObject({
      status: 'success',
      result: {
        outputFiles: [{ path: 'D:\\videos\\a-result.mp4', fileName: 'a-result.mp4' }],
        // 总数来自声明列表：一项已交付，另一项保留未完成，不能删掉失败项后变成全部完成。
        outputs: [
          { outputItemId: 'out-1', status: 'published', fileName: 'a-result.mp4' },
          { outputItemId: 'out-2', status: 'incomplete', reason: '尚未进入候选验收。' },
        ],
      },
    });
  });

  it('omits per-item results for tasks that never declared a video output item', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    await newSession!({});
    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '这是一个普通回答。',
      turnId: 'turn-plain',
      artifacts: [],
    });

    const result = await runAgentTask!({}, '介绍一下这个客户端。');
    // 普通问答不创建输出项，视频交付结论是不适用而不是「零项全部完成」。
    expect(result).toMatchObject({ status: 'success', result: { responseText: '这是一个普通回答。' } });
    expect((result as { result: Record<string, unknown> }).result).not.toHaveProperty('outputs');
  });

  it('runs fixed-time video editing without a Whisper model path', async () => {
    const selectVideo = mainMocks.handlers.get('desktop:select-attachment-files');
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
        artifacts: [{ toolCallId: 'call-artifact', path: 'D:\\videos\\fixed-time-edited.mp4' }],
      });
      await selectVideo!({});

      await expect(runAgentTask!({}, '把这个视频开头裁掉 1 秒并输出新视频')).resolves.toMatchObject({
        status: 'success',
        result: {
          responseText: '已裁掉开头 1 秒。',
          outputFiles: [{ path: 'D:\\videos\\fixed-time-edited.mp4', fileName: 'fixed-time-edited.mp4' }],
        },
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
    const replacementId = await deleteSession!({}, onlySessionId);
    expect(replacementId).not.toBe(onlySessionId);
    expect(await getActiveSessionId!({})).toBe(replacementId);
    await expect(deleteSession!({}, onlySessionId)).rejects.toThrow('找不到对应的会话');
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
      artifacts: [],
    });
    await runAgentTask!({}, '只属于被删除会话');
    const secondExtraAgent = mainMocks.agents.at(-1)!;
    secondExtraAgent.session.append({ type: 'user.message', content: '只属于被删除会话' });

    await switchSession!({}, baseSessionId);
    expect(await deleteSession!({}, firstExtraSessionId)).toBe(baseSessionId);
    expect(await deleteSession!({}, secondExtraSessionId)).toBe(baseSessionId);
    expect(secondExtraAgent.session.events()).toContainEqual({
      type: 'user.message',
      content: '只属于被删除会话',
    });

    expect(await getActiveSessionId!({})).toBe(baseSessionId);
  });

  it('keeps artifact files when the last session is deleted', async () => {
    const getActiveSessionId = mainMocks.handlers.get('desktop:get-active-session-id');
    const selectVideo = mainMocks.handlers.get('desktop:select-attachment-files');
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
      const outputPath = join(directory, 'input-edited.mp4');
      await newSession!({});
      mainMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [inputPath] });
      mainMocks.runDesktopAgentTask.mockImplementation(async () => {
        writeFileSync(outputPath, 'artifact');
        return {
          responseText: '剪辑完成。',
          turnId: 'turn-delete-1',
          artifacts: [{ toolCallId: 'call-delete-1', path: outputPath }],
        };
      });

      await selectVideo!({});
      await runAgentTask!({}, '生成第一个视频');
      const deletedSessionId = await getActiveSessionId!({});
      const replacementSessionId = await deleteSession!({}, deletedSessionId);

      expect(replacementSessionId).not.toBe(deletedSessionId);
      // 删除会话不删除已经真实交付的视频文件。
      expect(existsSync(outputPath)).toBe(true);
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
      _attachments: unknown,
      options: DesktopTaskOptions,
    ) => {
      options.onModelText?.('step-delta' as never, '实时', 'delta');
      options.onModelText?.('step-delta' as never, '增量', 'delta');
      return { responseText: '完成', turnId: 'turn-delta', artifacts: [] };
    });

    await expect(runAgentTask!({}, '流式任务')).resolves.toMatchObject({
      status: 'success',
      result: { responseText: '完成' },
    });

    expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:agent-event', {
      type: 'text.delta',
      delta: '实时',
      stepId: 'step-delta',
    });
    expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:agent-event', {
      type: 'text.delta',
      delta: '增量',
      stepId: 'step-delta',
    });
  });

  it('forwards bounded Tool Result details without writing content into Trace events', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    expect(runAgentTask).toBeTypeOf('function');
    await newSession!({});

    mainMocks.webContentsSend.mockClear();
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async (
      _agent: unknown,
      _prompt: unknown,
      _attachments: unknown,
      options: DesktopTaskOptions,
    ) => {
      options.onToolResult?.('read-1' as Parameters<NonNullable<DesktopTaskOptions['onToolResult']>>[0], 'read_file', {
        status: 'success',
        output: {
          filePath: 'D:/work/readme.md', startLine: 1, endLine: 1,
          totalLines: 1, lines: ['hello'],
        },
      });
      return { responseText: '完成', turnId: 'turn-detail', artifacts: [] };
    });

    await runAgentTask!({}, '读取文件');

    expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:agent-event', {
      type: 'activity.detail',
      activityId: 'read-1',
      detail: {
        kind: 'file-content', filePath: 'D:/work/readme.md', startLine: 1,
        endLine: 1, totalLines: 1, lines: ['hello'],
      },
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
      _attachments: unknown,
      options: DesktopTaskOptions,
    ) => new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({
        responseText: '停止', turnId: 'turn-cancelled', artifacts: [],
      }), { once: true });
    }));

    const priorCalls = mainMocks.runDesktopAgentTask.mock.calls.length;
    const running = runAgentTask!({}, '长任务');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask.mock.calls.length).toBe(priorCalls + 1));
    expect(cancelTask!({})).toBeUndefined();
    await expect(running).resolves.toMatchObject({
      status: 'success',
      result: { responseText: '停止' },
    });
    expect(() => cancelTask!({})).toThrow('当前没有正在执行的任务');
    const cancelledAgent = mainMocks.agents.at(-1)!;
    cancelledAgent.session.append({ type: 'user.message', content: '取消前上下文' });

    mainMocks.runDesktopAgentTask.mockResolvedValueOnce({
      responseText: '下一条完成', turnId: 'turn-after-cancel', artifacts: [],
    });
    await expect(runAgentTask!({}, '下一条')).resolves.toMatchObject({
      status: 'success',
      result: { responseText: '下一条完成' },
    });
    expect(mainMocks.agents.at(-1)!.session).toBe(cancelledAgent.session);
    expect(cancelledAgent.session.events()).toContainEqual({
      type: 'user.message', content: '取消前上下文',
    });
  });

  it('allows the window to close before the Renderer registers its close preparation listener', () => {
    mainMocks.webContentsSend.mockClear();
    const closeEvent = { preventDefault: vi.fn() };

    mainMocks.windowHandlers.window.get('close')!(closeEvent);

    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(mainMocks.webContentsSend).not.toHaveBeenCalledWith('desktop:prepare-close');
  });

  it('allows the window to close after the Renderer process exits', () => {
    const closeReady = mainMocks.handlers.get('desktop:close-ready');
    expect(closeReady).toBeTypeOf('function');
    closeReady!({});
    mainMocks.windowHandlers.webContents.get('render-process-gone')!({}, {});
    mainMocks.webContentsSend.mockClear();
    const closeEvent = { preventDefault: vi.fn() };

    mainMocks.windowHandlers.window.get('close')!(closeEvent);

    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(mainMocks.webContentsSend).not.toHaveBeenCalledWith('desktop:prepare-close');
  });

  it('cancels the running turn and submits the client state before closing the window', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const closeReady = mainMocks.handlers.get('desktop:close-ready');
    expect(closeReady).toBeTypeOf('function');
    closeReady!({});
    await newSession!({});

    let aborted = false;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async (
      _agent: unknown,
      _prompt: unknown,
      _videos: unknown,
      options: DesktopTaskOptions,
    ) => new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => {
        aborted = true;
        resolve({ responseText: '已取消', turnId: 'turn-close', artifacts: [] });
      }, { once: true });
    }));

    mainMocks.webContentsSend.mockClear();
    mainMocks.windowDestroy.mockClear();
    const priorCalls = mainMocks.runDesktopAgentTask.mock.calls.length;
    const running = runAgentTask!({}, '长任务');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask.mock.calls.length).toBe(priorCalls + 1));

    const closeEvent = { preventDefault: vi.fn() };
    mainMocks.windowHandlers.window.get('close')!(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();

    // 收尾先取消在跑的轮次，等它结束后才请求 Client 提交状态，最后才真正关闭窗口。
    await vi.waitFor(() => expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:prepare-close'));
    expect(aborted).toBe(true);
    expect(mainMocks.windowDestroy).not.toHaveBeenCalled();

    expect(mainMocks.onceHandlers.has('desktop:close-prepared')).toBe(true);
    mainMocks.onceHandlers.get('desktop:close-prepared')!({}, null);
    await vi.waitFor(() => expect(mainMocks.windowDestroy).toHaveBeenCalledOnce());
    await expect(running).resolves.toMatchObject({
      status: 'success',
      result: { responseText: '已取消' },
    });
  });

  it('keeps blocking repeated close requests while the closing finalization is still running', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const closeReady = mainMocks.handlers.get('desktop:close-ready');
    expect(closeReady).toBeTypeOf('function');
    closeReady!({});
    await newSession!({});

    let aborted = false;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async (
      _agent: unknown,
      _prompt: unknown,
      _videos: unknown,
      options: DesktopTaskOptions,
    ) => new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => {
        aborted = true;
        resolve({ responseText: '已取消', turnId: 'turn-close-repeat', artifacts: [] });
      }, { once: true });
    }));

    mainMocks.webContentsSend.mockClear();
    mainMocks.windowDestroy.mockClear();
    const priorCalls = mainMocks.runDesktopAgentTask.mock.calls.length;
    const running = runAgentTask!({}, '长任务');
    await vi.waitFor(() => expect(mainMocks.runDesktopAgentTask.mock.calls.length).toBe(priorCalls + 1));

    const firstClose = { preventDefault: vi.fn() };
    mainMocks.windowHandlers.window.get('close')!(firstClose);
    expect(firstClose.preventDefault).toHaveBeenCalledOnce();

    // 收尾期间用户再次点关闭：这一次同样必须被阻止，否则窗口会在等待落盘前被销毁。
    const secondClose = { preventDefault: vi.fn() };
    mainMocks.windowHandlers.window.get('close')!(secondClose);
    expect(secondClose.preventDefault).toHaveBeenCalledOnce();
    expect(mainMocks.windowDestroy).not.toHaveBeenCalled();

    // 重复关闭不重复进入收尾流程：只等待第一次收尾完成。
    await vi.waitFor(() => expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:prepare-close'));
    expect(aborted).toBe(true);
    expect(mainMocks.webContentsSend.mock.calls.filter(
      ([channel]) => channel === 'desktop:prepare-close',
    )).toHaveLength(1);
    expect(mainMocks.windowDestroy).not.toHaveBeenCalled();

    mainMocks.onceHandlers.get('desktop:close-prepared')!({}, null);
    await vi.waitFor(() => expect(mainMocks.windowDestroy).toHaveBeenCalledOnce());
    await expect(running).resolves.toMatchObject({
      status: 'success',
      result: { responseText: '已取消' },
    });
  });

  it('reports files that already succeeded when the Turn later fails', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const selectVideo = mainMocks.handlers.get('desktop:select-attachment-files');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    await newSession!({});
    mainMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\videos\\input.mp4'],
    });
    await selectVideo!({});

    // 第一个工具已真实产出文件，随后整轮失败：失败路径必须带上这份产物。
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const agent = mainMocks.agents.at(-1)!;
      agent.session.append({ type: 'turn.started', turnId: 'turn-failed' });
      agent.session.append({ type: 'step.started', turnId: 'turn-failed', stepId: 'step-failed' });
      agent.session.append({
        type: 'tool.called',
        turnId: 'turn-failed',
        stepId: 'step-failed',
        toolCallId: 'call-done',
        name: 'trim_video',
        input: { outputPath: 'D:\\videos\\done.mp4' },
      });
      agent.session.append({
        type: 'tool.result',
        turnId: 'turn-failed',
        stepId: 'step-failed',
        toolCallId: 'call-done',
        result: {
          status: 'success',
          output: 'Video created: D:\\videos\\done.mp4',
          artifacts: ['D:\\videos\\done.mp4'],
        },
      });
      throw new Error('第二个工具执行失败。');
    });

    await expect(runAgentTask!({}, '两步任务')).resolves.toEqual({
      status: 'error',
      errorName: 'Error',
      errorMessage: '第二个工具执行失败。',
      outputFiles: [{ path: 'D:\\videos\\done.mp4', fileName: 'done.mp4' }],
    });
  });

  it('does not report artifacts from an earlier Turn when the next task fails before starting', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    await newSession!({});

    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const agent = mainMocks.agents.at(-1)!;
      agent.session.append({ type: 'turn.started', turnId: 'turn-earlier-success' });
      agent.session.append({ type: 'step.started', turnId: 'turn-earlier-success', stepId: 'step-earlier-success' });
      agent.session.append({
        type: 'tool.called',
        turnId: 'turn-earlier-success',
        stepId: 'step-earlier-success',
        toolCallId: 'call-earlier-success',
        name: 'trim_video',
        input: { outputPath: 'D:\\videos\\earlier.mp4' },
      });
      agent.session.append({
        type: 'tool.result',
        turnId: 'turn-earlier-success',
        stepId: 'step-earlier-success',
        toolCallId: 'call-earlier-success',
        result: {
          status: 'success',
          output: 'Video created: D:\\videos\\earlier.mp4',
          artifacts: ['D:\\videos\\earlier.mp4'],
        },
      });
      return {
        responseText: '上一轮完成。',
        turnId: 'turn-earlier-success',
        artifacts: [{ toolCallId: 'call-earlier-success', path: 'D:\\videos\\earlier.mp4' }],
      };
    });
    await runAgentTask!({}, '上一轮任务');

    const configuredKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await expect(runAgentTask!({}, '下一轮任务')).resolves.toEqual({
        status: 'error',
        errorName: 'Error',
        errorMessage: '请先在设置中配置当前对话模型的 API 密钥。',
      });
    } finally {
      if (configuredKey !== undefined) process.env.DEEPSEEK_API_KEY = configuredKey;
    }
  });

  it('reports files that already succeeded when the user cancels the Turn', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session');
    const selectVideo = mainMocks.handlers.get('desktop:select-attachment-files');
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    await newSession!({});
    mainMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\videos\\input.mp4'],
    });
    await selectVideo!({});

    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const agent = mainMocks.agents.at(-1)!;
      agent.session.append({ type: 'turn.started', turnId: 'turn-cancelled-artifacts' });
      agent.session.append({ type: 'step.started', turnId: 'turn-cancelled-artifacts', stepId: 'step-cancelled' });
      agent.session.append({
        type: 'tool.called',
        turnId: 'turn-cancelled-artifacts',
        stepId: 'step-cancelled',
        toolCallId: 'call-cancelled-done',
        name: 'trim_video',
        input: { outputPath: 'D:\\videos\\cancelled-done.mp4' },
      });
      agent.session.append({
        type: 'tool.result',
        turnId: 'turn-cancelled-artifacts',
        stepId: 'step-cancelled',
        toolCallId: 'call-cancelled-done',
        result: {
          status: 'success',
          output: 'Video created: D:\\videos\\cancelled-done.mp4',
          artifacts: ['D:\\videos\\cancelled-done.mp4'],
        },
      });
      // 取消发生在下一个工具执行中：只有 tool.called，没有结果。
      agent.session.append({
        type: 'tool.called',
        turnId: 'turn-cancelled-artifacts',
        stepId: 'step-cancelled',
        toolCallId: 'call-in-flight',
        name: 'trim_video',
        input: { outputPath: 'D:\\videos\\never-finished.mp4' },
      });
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });

    // 只有真正成功的那个文件被报告，正在执行的未成功文件不登记。
    await expect(runAgentTask!({}, '取消任务')).resolves.toEqual({
      status: 'error',
      errorName: 'AbortError',
      errorMessage: 'The operation was aborted',
      outputFiles: [{ path: 'D:\\videos\\cancelled-done.mp4', fileName: 'cancelled-done.mp4' }],
    });
  });

  it('keeps the window open and reports the failure when the closing save fails', async () => {
    const closeReady = mainMocks.handlers.get('desktop:close-ready');
    expect(closeReady).toBeTypeOf('function');
    closeReady!({});
    mainMocks.webContentsSend.mockClear();
    mainMocks.windowDestroy.mockClear();
    mainMocks.showErrorBox.mockClear();

    // 没有在跑的轮次时立即请求提交，不等待取消。
    const closeEvent = { preventDefault: vi.fn() };
    mainMocks.windowHandlers.window.get('close')!(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:prepare-close'));

    mainMocks.onceHandlers.get('desktop:close-prepared')!({}, '磁盘不可写');
    await vi.waitFor(() => expect(mainMocks.showErrorBox).toHaveBeenCalledWith(
      '无法保存本地会话',
      expect.stringContaining('磁盘不可写'),
    ));
    expect(mainMocks.windowDestroy).not.toHaveBeenCalled();

    // 提交失败后保留窗口，用户可以再次尝试关闭。
    mainMocks.showErrorBox.mockClear();
    const retryEvent = { preventDefault: vi.fn() };
    mainMocks.webContentsSend.mockClear();
    mainMocks.windowHandlers.window.get('close')!(retryEvent);
    expect(retryEvent.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mainMocks.webContentsSend).toHaveBeenCalledWith('desktop:prepare-close'));
    mainMocks.onceHandlers.get('desktop:close-prepared')!({}, null);
    await vi.waitFor(() => expect(mainMocks.windowDestroy).toHaveBeenCalledOnce());
  });

  it('opens Agent reply links in the system browser without navigating or creating a window', () => {
    // 链接来自模型输出：桌面窗口既不导航也不新开窗口，只把明确的 web 协议交给系统浏览器。
    const openWindow = mainMocks.windowHandlers.open!;
    expect(openWindow({ url: 'https://example.com/guide' })).toEqual({ action: 'deny' });
    expect(mainMocks.openExternal).toHaveBeenCalledWith('https://example.com/guide');

    mainMocks.openExternal.mockClear();
    expect(openWindow({ url: 'file:///C:/Users/Administrator/secret.txt' })).toEqual({ action: 'deny' });
    expect(mainMocks.openExternal).not.toHaveBeenCalled();

    const navigate = mainMocks.windowHandlers.navigate!;
    const externalNavigation = { preventDefault: vi.fn() };
    navigate(externalNavigation, 'mailto:support@example.com');
    expect(externalNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(mainMocks.openExternal).toHaveBeenCalledWith('mailto:support@example.com');

    // 应用自身的文件导航不受影响，否则重新加载渲染层会被误拦。
    const internalNavigation = { preventDefault: vi.fn() };
    navigate(internalNavigation, 'file:///E:/repo/apps/desktop/dist/renderer/index.html');
    expect(internalNavigation.preventDefault).not.toHaveBeenCalled();
  });

  /** 宿主推给客户端的待决审批事件；用来读取真实请求标识。 */
  const publishedApprovals = () => mainMocks.webContentsSend.mock.calls
    .map((call) => call[1])
    .filter((payload): payload is {
      readonly type: string;
      readonly request?: { readonly requestId: string; readonly kind: string; readonly target: string };
    } => (
      typeof payload === 'object' && payload !== null
      && (payload as { readonly type?: unknown }).type === 'approval.requested'
    ));

  it('gives each Turn a workspace port that publishes one approval and records the confirmed directory', async () => {
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const decideApproval = mainMocks.handlers.get('desktop:decide-approval');
    expect(decideApproval).toBeTypeOf('function');
    const agentCountBefore = mainMocks.agentOptions.length;
    const approvalsBefore = publishedApprovals().length;

    let observed: {
      readonly initial: string | undefined;
      readonly approved: boolean;
      readonly afterConfirm: string | undefined;
    } | undefined;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const workspace = mainMocks.agentOptions[agentCountBefore]!.workspace!;
      const initial = workspace.confirmedDirectory();
      const approved = await workspace.requestApproval({ kind: 'directory', path: 'D:/videos' });
      workspace.confirmDirectory('D:/videos');
      observed = { initial, approved, afterConfirm: workspace.confirmedDirectory() };
      return { responseText: '目录已就绪。', turnId: 'turn-workspace', artifacts: [] };
    });

    const running = runAgentTask!({}, '把 D:/videos 设为工作目录');
    await vi.waitFor(() => expect(publishedApprovals().length).toBe(approvalsBefore + 1));
    const request = publishedApprovals()[approvalsBefore]!.request!;
    expect(request.kind).toBe('directory');
    expect(request.target).toBe('D:/videos');
    decideApproval!({}, request.requestId, true);
    await expect(running).resolves.toMatchObject({ status: 'success' });

    expect(observed).toEqual({ initial: undefined, approved: true, afterConfirm: 'D:/videos' });
  });

  it('accepts only the current approval request and refuses a forged or late decision', async () => {
    const runAgentTask = mainMocks.handlers.get('desktop:run-agent-task');
    const decideApproval = mainMocks.handlers.get('desktop:decide-approval')!;
    const agentCountBefore = mainMocks.agentOptions.length;
    const approvalsBefore = publishedApprovals().length;

    expect(() => decideApproval({}, 'forged', true)).toThrow('该审批请求已失效。');
    expect(() => decideApproval({}, 7, true)).toThrow('无效的审批决定。');
    expect(() => decideApproval({}, 'anything', 'yes')).toThrow('无效的审批决定。');

    let decision: string | undefined;
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      const workspace = mainMocks.agentOptions[agentCountBefore]!.workspace!;
      const approved = await workspace.requestApproval({ kind: 'directory', path: 'D:/clips' });
      decision = approved ? 'approved' : 'refused';
      return { responseText: '完成。', turnId: 'turn-approval', artifacts: [] };
    });

    const running = runAgentTask!({}, '检查目录');
    await vi.waitFor(() => expect(publishedApprovals().length).toBe(approvalsBefore + 1));
    const requestId = publishedApprovals()[approvalsBefore]!.request!.requestId;

    decideApproval({}, requestId, false);
    await expect(running).resolves.toMatchObject({ status: 'success' });

    expect(decision).toBe('refused');
    expect(() => decideApproval({}, requestId, true)).toThrow('该审批请求已失效。');
  });
  it('uses a project folder only for the explicitly created session and rejects missing folders before creating a runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-desktop-project-'));
    const getActive = mainMocks.handlers.get('desktop:get-active-session-id')!;
    const create = mainMocks.handlers.get('desktop:new-session')!;
    const run = mainMocks.handlers.get('desktop:run-agent-task')!;
    const switchSession = mainMocks.handlers.get('desktop:switch-session')!;
    const previousId = await getActive({});
    try {
      await expect(create({}, join(directory, 'missing'))).rejects.toThrow('ENOENT');
      expect(await getActive({})).toBe(previousId);
      const projectSessionId = await create({}, directory);
      expect(projectSessionId).not.toBe(previousId);
      mainMocks.runDesktopAgentTask.mockResolvedValueOnce({ responseText: '项目任务', turnId: 'project-turn', artifacts: [] });
      await run({}, '查看项目文件');
      expect(mainMocks.agentOptions.at(-1)?.workspace?.confirmedDirectory()).toBe(directory);
      await switchSession({}, previousId);
      expect(await getActive({})).toBe(previousId);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('dispatches session startup once across turns and again for a new session', async () => {
    const newSession = mainMocks.handlers.get('desktop:new-session')!;
    const run = mainMocks.handlers.get('desktop:run-agent-task')!;
    await newSession({});
    const count = mainMocks.extensionRuntimes.length;
    for (let index = 0; index < 2; index += 1) {
      mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
        const turnId = `hook-turn-${index}`;
        mainMocks.agents.at(-1)!.session.append({ type: 'turn.started', turnId });
        mainMocks.agents.at(-1)!.session.append({ type: 'turn.completed', turnId });
        return { responseText: '完成', turnId, artifacts: [] };
      });
      await expect(run({}, '继续任务')).resolves.toMatchObject({ status: 'success' });
    }
    const first = mainMocks.extensionRuntimes[count]!;
    const second = mainMocks.extensionRuntimes[count + 1]!;
    expect(first.runHooks).toHaveBeenCalledWith('SessionStart', expect.objectContaining({ source: 'startup' }));
    expect(second.runHooks).not.toHaveBeenCalledWith('SessionStart', expect.anything());
    expect(second.runHooks).toHaveBeenCalledWith('UserPromptSubmit', expect.objectContaining({ prompt: '继续任务' }));
    await newSession({});
    mainMocks.runDesktopAgentTask.mockImplementationOnce(async () => {
      mainMocks.agents.at(-1)!.session.append({ type: 'turn.started', turnId: 'hook-new-session' });
      mainMocks.agents.at(-1)!.session.append({ type: 'turn.completed', turnId: 'hook-new-session' });
      return { responseText: '完成', turnId: 'hook-new-session', artifacts: [] };
    });
    await expect(run({}, '新会话任务')).resolves.toMatchObject({ status: 'success' });
    expect(mainMocks.extensionRuntimes[count + 2]!.runHooks).toHaveBeenCalledWith('SessionStart', expect.objectContaining({ source: 'startup' }));
    await newSession({});
  });

});
