import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { readDesktopDocument } from '../src/main/desktop-database.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientStateSnapshot } from '@agent-desktop/client';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model, ModelRequest, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import {
  loadDesktopState,
  parseDesktopState,
  saveDesktopState,
  type PersistedDesktopState,
} from '../src/main/session-persistence.js';

const temporaryDirectories: string[] = [];

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-session-'));
  temporaryDirectories.push(directory);
  return join(directory, 'agent-desktop.sqlite');
}

/** 直接写入原始记录，验证磁盘数据解析边界，不绕过真实 SQLite。 */
async function writeStoredJson(filePath: string, source: string): Promise<void> {
  readDesktopDocument(filePath, 'session-state');
  const database = new DatabaseSync(filePath);
  try {
    database.prepare('INSERT INTO desktop_documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run('session-state', source);
  } finally { database.close(); }
}

async function readStoredJson(filePath: string): Promise<string> {
  const database = new DatabaseSync(filePath);
  try {
    return database.prepare('SELECT value FROM desktop_documents WHERE name = ?').get('session-state')!.value as string;
  } finally { database.close(); }
}

function sessionEvents(number: string): readonly SessionEvent[] {
  const turnId = `turn-${number}` as TurnId;
  const stepId = `step-${number}` as StepId;
  return [
    { type: 'turn.started', turnId },
    { type: 'user.message', turnId, content: `请记住数字 ${number}。` },
    { type: 'step.started', turnId, stepId },
    {
      type: 'assistant.message',
      turnId,
      stepId,
      content: '已经记住。',
      toolCalls: [],
    },
    { type: 'step.completed', turnId, stepId },
    { type: 'turn.completed', turnId },
  ];
}

function clientState(): ClientStateSnapshot {
  return {
    activeSessionId: 'session-b',
    conversations: [
      {
        id: 'session-a',
        title: '记住 731',
        titleManuallyRenamed: true,
        prompt: 'Session A 未发送草稿',
        attachments: [{ path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' }],
        workingDirectory: 'D:\\videos',
        permissionMode: 'auto-review',
        contextUsage: { model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, inputTokens: 116000, outputTokens: 100 },
        messages: [
          {
            id: 1,
            role: 'user',
            text: '请记住数字 731。',
            attachments: ['input-a.mp4'],
          },
          {
            id: 2,
            role: 'assistant',
            status: 'completed',
            activityExpanded: false,
            activity: [{
              id: 'call-a',
              kind: 'tool',
              toolName: 'trim_video',
              status: 'completed',
              durationMs: 12,
              detail: {
                kind: 'file-content',
                filePath: 'D:/videos/notes.txt',
                startLine: 1,
                endLine: 2,
                totalLines: 2,
                lines: ['第一行', '第二行'],
              },
            }],
            result: {
              responseText: '已经记住。',
              traceId: 'trace-a',
              outputFiles: [{ path: 'D:/videos/input-a-edited.mp4', fileName: 'input-a-edited.mp4' }],
              // 逐项交付结果与产物卡是同一批事实的两种视图，都必须随快照恢复。
              outputs: [
                {
                  outputItemId: 'out-1',
                  status: 'published',
                  path: 'D:/videos/input-a-edited.mp4',
                  fileName: 'input-a-edited.mp4',
                },
                { outputItemId: 'out-2', status: 'blocked', reason: '内容要求当前没有可靠的自动判定。' },
              ],
            },
          },
        ],
      },
      {
        id: 'session-b',
        title: '记住 952',
        titleManuallyRenamed: false,
        prompt: '',
        attachments: [],
        messages: [{
          id: 3,
          role: 'assistant',
          status: 'failed',
          errorMessage: '测试失败信息',
          activity: [],
          activityExpanded: false,
          // 整轮失败仍可能已有成功的产物，终态必须保留它们。
          outputFiles: [{ path: 'D:/videos/failed-part.mp4', fileName: 'failed-part.mp4' }],
          outputs: [
            { outputItemId: 'out-3', status: 'incomplete', reason: '尚未进入候选验收。' },
          ],
        }, {
          id: 4,
          role: 'assistant',
          status: 'cancelled',
          activity: [{
            id: 'call-cancelled',
            kind: 'tool',
            toolName: 'trim_video',
            status: 'cancelled',
          }],
          activityExpanded: false,
          // 取消前已成功的产物仍然随终态持久化。
          outputFiles: [{ path: 'D:/videos/cancelled-done.mp4', fileName: 'cancelled-done.mp4' }],
        }],
      },
    ],
  };
}

function persistedState(): PersistedDesktopState {
  return {
    activeSessionId: 'session-b',
    sessions: [
      {
        id: 'session-a',
        attachments: [{ path: 'D:\\videos\\input-a.mp4', role: 'video' }],
        workingDirectory: 'D:\\videos',
        permissionMode: 'auto-review',
        events: sessionEvents('731'),
      },
      {
        id: 'session-b',
        attachments: [],
        events: sessionEvents('952'),
      },
    ],
    clientState: clientState(),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('desktop session persistence', () => {
  it('persists an empty chat history with a pending draft and restores its directory and attachment', async () => {
    const source = persistedState();
    const draft = { ...source.clientState.conversations[0]!, title: '新聊天', titleManuallyRenamed: false, messages: [], prompt: '稍后发送', workingDirectory: 'D:/draft-project' };
    const state = parseDesktopState({
      activeSessionId: draft.id,
      sessions: [{ ...source.sessions[0]!, events: [], workingDirectory: 'D:/draft-project' }],
      clientState: { activeSessionId: draft.id, conversations: [], drafts: [draft] },
    });
    const filePath = await temporaryStatePath();
    await saveDesktopState(filePath, state);
    const restored = await loadDesktopState(filePath);
    expect(restored?.clientState.conversations).toEqual([]);
    expect(restored?.clientState.drafts).toEqual([draft]);
    expect(restored?.sessions[0]?.workingDirectory).toBe('D:/draft-project');
    expect(restored?.sessions[0]?.permissionMode).toBe('auto-review');
    expect(restored?.clientState.drafts?.[0]?.permissionMode).toBe('auto-review');
  });

  it('round-trips sidebar projects, archived chats, pins and timestamps without changing runtime directories', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const snapshot: ClientStateSnapshot = { ...state.clientState,
      sidebar: { projects: [{ id: 'project-a', name: '工作项目', directory: 'D:/another-project', pinned: true, collapsed: true }], projectsCollapsed: true, recentCollapsed: false, grouped: true },
      conversations: state.clientState.conversations.map(conversation => ({ ...conversation, projectId: 'project-a', pinned: true, archived: true, updatedAt: 12345 })),
    };
    await saveDesktopState(filePath, { ...state, clientState: snapshot });
    const restored = await loadDesktopState(filePath);
    expect(restored?.clientState).toEqual(snapshot);
    expect(restored?.sessions).toEqual(state.sessions);
    expect(() => parseDesktopState({ ...state, clientState: { ...snapshot, sidebar: { ...snapshot.sidebar, projects: [] } } })).toThrow('projectId');
  });

  it('treats a missing session record as first launch', async () => {
    const filePath = await temporaryStatePath();
    await expect(loadDesktopState(filePath)).resolves.toBeNull();
  });

  it('restores multiple Sessions, active UI history, draft, files, and output sequence', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();

    await saveDesktopState(filePath, state);
    const restored = await loadDesktopState(filePath);

    expect(restored).toEqual(state);
    expect(restored?.activeSessionId).toBe('session-b');
    expect(restored?.sessions[0]?.events).toEqual(sessionEvents('731'));
    expect(restored?.sessions[1]?.events).toEqual(sessionEvents('952'));
    expect(restored?.clientState.conversations[0]).toMatchObject({
      title: '记住 731',
      titleManuallyRenamed: true,
      prompt: 'Session A 未发送草稿',
      attachments: [{ path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' }],
    });
    expect(restored?.clientState.conversations[0]?.messages[1]).toMatchObject({
      activity: [{ status: 'completed' }],
      result: { outputFiles: [{ path: 'D:/videos/input-a-edited.mp4', fileName: 'input-a-edited.mp4' }], traceId: 'trace-a' },
    });
    expect(restored?.sessions[0]?.workingDirectory).toBe('D:\\videos');
    expect(restored?.clientState.conversations[0]?.workingDirectory).toBe('D:\\videos');
  });

  it('reads a session without a working directory as having none', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const legacy = {
      ...state,
      sessions: state.sessions.map(({ workingDirectory: _ignored, ...session }) => session),
      clientState: {
        ...state.clientState,
        conversations: state.clientState.conversations.map(
          ({ workingDirectory: _ignored, ...conversation }) => conversation,
        ),
      },
    };
    await writeStoredJson(filePath, JSON.stringify(legacy));

    const restored = await loadDesktopState(filePath);

    expect(restored?.sessions[0]?.workingDirectory).toBeUndefined();
    expect(restored?.clientState.conversations[0]?.workingDirectory).toBeUndefined();
  });

  it('rejects a working directory that is not a string', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: [{ ...state.sessions[0]!, workingDirectory: 7 }, state.sessions[1]!],
    }));

    await expect(loadDesktopState(filePath)).rejects.toThrowError(/workingDirectory/);
  });

  it('keeps already-succeeded files on failed and cancelled replies across a restart', async () => {
    const filePath = await temporaryStatePath();
    await saveDesktopState(filePath, persistedState());
    const restored = await loadDesktopState(filePath);

    // 失败与取消的回复也要保住产物关联：重启后仍能定位已完成的工作。
    expect(restored?.clientState.conversations[1]?.messages[0]).toMatchObject({
      status: 'failed',
      errorMessage: '测试失败信息',
      outputFiles: [{ path: 'D:/videos/failed-part.mp4', fileName: 'failed-part.mp4' }],
    });
    expect(restored?.clientState.conversations[1]?.messages[1]).toMatchObject({
      status: 'cancelled',
      outputFiles: [{ path: 'D:/videos/cancelled-done.mp4', fileName: 'cancelled-done.mp4' }],
    });
  });

  it('restores command output details and structured failed command results', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const commandOutput = {
      command: 'node test.cjs',
      workingDirectory: 'D:/project',
      exitCode: 2,
      termination: 'exited' as const,
      stdout: 'stdout',
      stderr: 'stderr',
      truncated: true,
      droppedBytes: 128,
      note: '命令以退出码 2 结束',
    };
    const commandActivity = {
      id: 'command-call',
      kind: 'tool' as const,
      toolName: 'run_command',
      status: 'failed' as const,
      durationMs: 42,
      detail: { kind: 'command' as const, ...commandOutput },
    };
    const commandEvent: SessionEvent = {
      type: 'tool.result',
      turnId: 'turn-731' as TurnId,
      stepId: 'step-731' as StepId,
      toolCallId: 'command-call' as SessionEvent extends { type: 'tool.result'; toolCallId: infer Id } ? Id : never,
      result: { status: 'error', message: commandOutput.note, output: commandOutput },
    };
    const modified: PersistedDesktopState = {
      ...state,
      sessions: state.sessions.map((session) => session.id === 'session-a'
        ? { ...session, events: [...session.events, commandEvent] }
        : session),
      clientState: {
        ...state.clientState,
        conversations: state.clientState.conversations.map((conversation) => conversation.id === 'session-a'
          ? {
              ...conversation,
              messages: conversation.messages.map((message) => message.role === 'assistant' && message.id === 2
                ? { ...message, activity: [...message.activity, commandActivity] }
                : message),
            }
          : conversation),
      },
    };

    await saveDesktopState(filePath, modified);

    const restored = await loadDesktopState(filePath);
    expect(restored?.sessions[0]?.events.at(-1)).toEqual(commandEvent);
    expect(restored?.clientState.conversations[0]?.messages[1]).toMatchObject({
      activity: expect.arrayContaining([
        { id: 'command-call', kind: 'tool', status: 'failed', toolName: 'run_command', durationMs: 42,
          detail: { kind: 'command', ...commandOutput } },
      ]),
    });
  });

  it('reads a failed or cancelled reply without artifacts as having none', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const [failedMessage, cancelledMessage] = state.clientState.conversations[1]!.messages;
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      // 旧快照没有 outputFiles：不能凭空造出产物。
      clientState: {
        ...state.clientState,
        conversations: [
          state.clientState.conversations[0],
          {
            ...state.clientState.conversations[1],
            messages: [
              { ...failedMessage, outputFiles: undefined },
              { ...cancelledMessage, outputFiles: undefined },
            ],
          },
        ],
      },
    }));

    const restored = await loadDesktopState(filePath);
    const failed = restored?.clientState.conversations[1]?.messages[0];
    const cancelled = restored?.clientState.conversations[1]?.messages[1];
    expect(failed?.role === 'assistant' && failed.status === 'failed' && failed.outputFiles).toBeUndefined();
    expect(cancelled?.role === 'assistant' && cancelled.status === 'cancelled' && cancelled.outputFiles)
      .toBeUndefined();
  });

  it('keeps cancelled Turn runtime residue on disk and out of the next Turn model context', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const cancelledTurnId = 'turn-cancelled' as TurnId;
    const cancelledStepId = 'step-cancelled' as StepId;
    const cancelledCallId = 'call-cancelled' as ToolCallId;
    // 磁盘上保留被取消 Turn 的未完成 Step：assistant.message 与 dangling Tool Call 都是 append-only 事实。
    const cancelledEvents: readonly SessionEvent[] = [
      { type: 'turn.started', turnId: cancelledTurnId },
      { type: 'user.message', turnId: cancelledTurnId, content: '被取消的剪辑任务' },
      { type: 'step.started', turnId: cancelledTurnId, stepId: cancelledStepId },
      {
        type: 'assistant.message',
        turnId: cancelledTurnId,
        stepId: cancelledStepId,
        content: '正在裁剪。',
        toolCalls: [{ id: cancelledCallId, name: 'trim_video', input: { start: 0 } }],
      },
      {
        type: 'tool.called',
        turnId: cancelledTurnId,
        stepId: cancelledStepId,
        toolCallId: cancelledCallId,
        name: 'trim_video',
        input: { start: 0 },
      },
    ];
    const diskEvents = [...sessionEvents('731'), ...cancelledEvents];
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: [{ ...state.sessions[0]!, events: diskEvents }, state.sessions[1]!],
    }));
    const sourceBeforeLoad = await readStoredJson(filePath);

    const restored = await loadDesktopState(filePath);

    // 磁盘历史是 append-only 事实：load 只还原，不删除未完成 Step。
    expect(restored?.sessions[0]?.events).toEqual(diskEvents);
    expect(restored?.sessions[1]?.events).toEqual(sessionEvents('952'));
    // 读取只读取磁盘事实，不改写已经追加的历史。
    expect(await readStoredJson(filePath)).toBe(sourceBeforeLoad);

    // 模拟 restoreDesktopState：磁盘事件原样注入 InMemorySession。
    const session = new InMemorySession(restored!.sessions[0]!.events);
    // 模拟 currentPersistedState 与 saveClientState：把当前 Session 事件整体写回状态文件。
    await saveDesktopState(filePath, parseDesktopState({
      ...restored!,
      sessions: restored!.sessions.map((savedSession) => (savedSession.id === 'session-a'
        ? { ...savedSession, events: session.events() }
        : savedSession)),
    }));

    // 重启后的首次保存必须完整保留磁盘上已经追加的事件。
    const saved = JSON.parse(await readStoredJson(filePath)) as PersistedDesktopState;
    expect(saved.sessions[0]?.events).toEqual(diskEvents);

    // 在同一个 Session 上发起新 Turn，模型上下文仍然只由 Session 事件重建。
    const requests: ModelRequest[] = [];
    const model: Model = {
      complete: async (request) => {
        requests.push(request);
        return { text: '继续完成。', toolCalls: [] };
      },
    };
    const agent: Parameters<typeof runTurn>[0] = {
      model,
      session,
      tools: { register: () => undefined, get: () => undefined, list: () => [] },
      systemPrompt: { build: () => 'Base instructions.' },
    };
    await runTurn(agent, '继续剪辑');

    // 未完成 Step 的 assistant.message 与 dangling Tool Call 不进入新的 Model Context。
    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: '请记住数字 731。' },
      { role: 'assistant', content: '已经记住。', toolCalls: [] },
      { role: 'user', content: '被取消的剪辑任务' },
      { role: 'user', content: expect.stringContaining('未知效果须先核验') },
      { role: 'user', content: '继续剪辑' },
    ]);
    // 新 Turn 只在完整历史之后追加事实。
    expect(session.events().slice(0, diskEvents.length)).toEqual(diskEvents);
  });

  it('writes a real SQLite database', async () => {
    const filePath = await temporaryStatePath();
    await saveDesktopState(filePath, persistedState());

    expect((await readFile(filePath)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  });

  it('keeps the previous history when the state write fails', async () => {
    const filePath = await temporaryStatePath();
    await saveDesktopState(filePath, persistedState());
    const before = await readStoredJson(filePath);

    // 数据库触发器拒绝本次更新，验证失败时原记录仍完整保留。
    const database = new DatabaseSync(filePath);
    database.exec("CREATE TRIGGER reject_session BEFORE UPDATE ON desktop_documents BEGIN SELECT RAISE(ABORT, 'write blocked'); END");
    database.close();
    await expect(saveDesktopState(filePath, persistedState())).rejects.toThrow();

    // 写入失败不能清空或改写已有历史。
    expect(await readStoredJson(filePath)).toBe(before);
  });

  it('keeps same-named artifacts of one reply apart after a restart', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const artifacts = [
      { path: 'D:/videos/first/final.mp4', fileName: 'final.mp4' },
      { path: 'D:/videos/second/final.mp4', fileName: 'final.mp4' },
    ];
    await saveDesktopState(filePath, {
      ...state,
      clientState: {
        ...state.clientState,
        conversations: state.clientState.conversations.map((conversation) => (
          conversation.id === 'session-a'
            ? {
              ...conversation,
              messages: conversation.messages.map((message) => (
                message.role === 'assistant' && message.status === 'completed'
                  ? { ...message, result: { ...message.result, outputFiles: artifacts } }
                  : message
              )),
            }
            : conversation
        )),
      },
    });

    const restored = await loadDesktopState(filePath);
    const reply = restored?.clientState.conversations[0]?.messages.find(
      (message) => message.role === 'assistant',
    );

    // 产物身份是真实路径：同名文件位于不同目录时恢复后仍能分别定位。
    expect(reply?.role === 'assistant' && reply.status === 'completed'
      ? reply.result.outputFiles
      : undefined).toEqual(artifacts);
  });

  it('loads Commit 24 snapshots without titleManuallyRenamed as false', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const legacyState = {
      ...state,
      clientState: {
        ...state.clientState,
        conversations: state.clientState.conversations.map(({ titleManuallyRenamed: _ignored, ...conversation }) => conversation),
      },
    };

    await writeStoredJson(filePath, JSON.stringify(legacyState));
    const restored = await loadDesktopState(filePath);

    expect(restored?.clientState.conversations[0]?.titleManuallyRenamed).toBe(false);
    expect(restored?.clientState.conversations[1]?.titleManuallyRenamed).toBe(false);
  });

  it('rejects a non-boolean titleManuallyRenamed value', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      clientState: {
        ...state.clientState,
        conversations: [{
          ...state.clientState.conversations[0],
          titleManuallyRenamed: 'yes',
        }, state.clientState.conversations[1]],
      },
    }));

    await expect(loadDesktopState(filePath)).rejects.toThrow(
      'clientState.conversations[0].titleManuallyRenamed',
    );
  });

  it('fails explicitly for corrupt JSON and invalid structure', async () => {
    const corruptPath = await temporaryStatePath();
    await writeStoredJson(corruptPath, '{not json');
    await expect(loadDesktopState(corruptPath)).rejects.toThrow(SyntaxError);

    const invalidPath = await temporaryStatePath();
    await writeStoredJson(invalidPath, JSON.stringify({ sessions: [] }));
    await expect(loadDesktopState(invalidPath)).rejects.toThrow('本地会话结构无效');
  });

  it('rejects an incomplete Renderer turn instead of persisting processing state', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      clientState: {
        ...state.clientState,
        conversations: [{
          ...state.clientState.conversations[0],
          messages: [{
            id: 99,
            role: 'assistant',
            status: 'processing',
            activity: [],
            activityExpanded: true,
          }],
        }, state.clientState.conversations[1]],
      },
    }));

    await expect(loadDesktopState(filePath)).rejects.toThrow('clientState.conversations[0].messages[0].status');
  });

  it('keeps each attachment role and file reference across a restart', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    // Commit 37 的真实形状：同一个会话里既有主视频也有外加音轨，角色必须按附件分别保留。
    const storedSessions = [
      {
        ...state.sessions[0]!,
        attachments: [
          { path: 'D:\\videos\\input-a.mp4', role: 'video' },
          { path: 'D:\\audio\\背景音乐.mp3', role: 'audio' },
        ],
      },
      state.sessions[1]!,
    ];
    const storedConversations = [
      {
        ...state.clientState.conversations[0]!,
        attachments: [
          { path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' },
          { path: 'D:\\audio\\背景音乐.mp3', name: '背景音乐.mp3', role: 'audio' },
        ],
      },
      state.clientState.conversations[1]!,
    ];
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: storedSessions,
      clientState: { ...state.clientState, conversations: storedConversations },
    }));

    const restored = await loadDesktopState(filePath);

    // 角色是提示词用途的唯一依据，重启后必须还是 audio，不能被折回默认的视频。
    expect(restored?.sessions[0]?.attachments).toEqual([
      { path: 'D:\\videos\\input-a.mp4', role: 'video' },
      { path: 'D:\\audio\\背景音乐.mp3', role: 'audio' },
    ]);
    expect(restored?.sessions[1]?.attachments).toEqual([]);
    // Renderer 视图同样保留身份路径与角色：中文与空格路径不能被改写。
    expect(restored?.clientState.conversations[0]?.attachments).toEqual([
      { path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' },
      { path: 'D:\\audio\\背景音乐.mp3', name: '背景音乐.mp3', role: 'audio' },
    ]);
    // 已提交消息里的角色随消息一起恢复，否则历史里的音轨会被重新标成视频。
    expect(restored?.clientState.conversations[0]?.messages[0]).toMatchObject({
      attachments: ['input-a.mp4'],
    });

    // 保存再加载一轮：序列化与解析是幂等的，不会在第二次启动时丢掉角色。
    await saveDesktopState(filePath, restored!);
    const secondStart = await loadDesktopState(filePath);
    expect(secondStart?.sessions[0]?.attachments).toEqual(restored?.sessions[0]?.attachments);
    expect(secondStart?.clientState.conversations[0]?.attachments)
      .toEqual(restored?.clientState.conversations[0]?.attachments);
  });

  it('keeps the attachment roles recorded on a submitted user message', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const conversation = state.clientState.conversations[0]!;
    const [firstMessage, ...remainingMessages] = conversation.messages;
    if (firstMessage?.role !== 'user') throw new Error('测试夹具的第一条消息必须是用户消息。');

    await saveDesktopState(filePath, {
      ...state,
      clientState: {
        ...state.clientState,
        conversations: [{
          ...conversation,
          messages: [{
            ...firstMessage,
            attachments: ['input-a.mp4', '背景音乐.mp3'],
            attachmentRoles: ['video', 'audio'],
          }, ...remainingMessages],
        }, state.clientState.conversations[1]!],
      },
    });

    const restored = await loadDesktopState(filePath);
    expect(restored?.clientState.conversations[0]?.messages[0]).toMatchObject({
      role: 'user',
      attachments: ['input-a.mp4', '背景音乐.mp3'],
      attachmentRoles: ['video', 'audio'],
    });
  });

  it('keeps the remaining attachment role after one attachment is removed', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    // 移除视频后只剩音轨：这是「单独音频附件」的真实磁盘形状，不能被换算成别的角色。
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: [{
        ...state.sessions[0]!,
        attachments: [{ path: 'D:\\audio\\背景音乐.mp3', role: 'audio' }],
      }, state.sessions[1]!],
      clientState: {
        ...state.clientState,
        // 会话列表必须与 clientState 一一对应，activeSessionId 也仍指向 session-b。
        conversations: [{
          ...state.clientState.conversations[0]!,
          attachments: [{ path: 'D:\\audio\\背景音乐.mp3', name: '背景音乐.mp3', role: 'audio' }],
        }, state.clientState.conversations[1]!],
      },
    }));

    const restored = await loadDesktopState(filePath);

    expect(restored?.sessions[0]?.attachments).toEqual([{ path: 'D:\\audio\\背景音乐.mp3', role: 'audio' }]);
    expect(restored?.clientState.conversations[0]?.attachments)
      .toEqual([{ path: 'D:\\audio\\背景音乐.mp3', name: '背景音乐.mp3', role: 'audio' }]);
  });

  it('converts the legacy video-only attachment list to the video role', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    // Commit 37 之前的真实格式：会话只存一组视频路径，没有角色字段；换算后必须是 video。
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: [
        { id: 'session-a', selectedVideoPaths: ['D:\\videos\\input-a.mp4'], events: sessionEvents('731') },
        { id: 'session-b', selectedVideoPaths: [], events: sessionEvents('952') },
      ],
      clientState: {
        ...state.clientState,
        conversations: [{
          ...state.clientState.conversations[0]!,
          selectedVideos: [{ path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4' }],
        }, state.clientState.conversations[1]!],
      },
    }));

    const restored = await loadDesktopState(filePath);

    expect(restored?.sessions[0]?.attachments).toEqual([{ path: 'D:\\videos\\input-a.mp4', role: 'video' }]);
    expect(restored?.clientState.conversations[0]?.attachments)
      .toEqual([{ path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' }]);
  });

  it('keeps the artifacts reported by a successful result across a restart', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const turnId = 'turn-write' as TurnId;
    const stepId = 'step-write' as StepId;
    const toolCallId = 'call-write' as ToolCallId;
    const events: readonly SessionEvent[] = [
      { type: 'turn.started', turnId },
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId,
        name: 'write_text_file',
        input: { filePath: 'D:/videos/剪辑清单.txt', content: '第一段' },
      },
      {
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId,
        // 产物事实随成功结果持久化：重启后仍要能定位到同一个真实路径。
        result: {
          status: 'success',
          output: { filePath: 'D:/videos/剪辑清单.txt', bytes: 9 },
          artifacts: ['D:/videos/剪辑清单.txt'],
        },
      },
      { type: 'turn.completed', turnId },
    ];
    await saveDesktopState(filePath, {
      ...state,
      sessions: [{ ...state.sessions[0]!, events }, state.sessions[1]!],
    });

    const restored = await loadDesktopState(filePath);

    expect(restored?.sessions[0]?.events).toEqual(events);
  });

  it('keeps an approved text edit and its activity across a restart without creating an artifact', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const turnId = 'turn-edit' as TurnId;
    const stepId = 'step-edit' as StepId;
    const toolCallId = 'call-edit' as ToolCallId;
    const editedPath = 'D:/videos/字幕.srt';
    const events: readonly SessionEvent[] = [
      { type: 'turn.started', turnId },
      {
        type: 'tool.called',
        turnId,
        stepId,
        toolCallId,
        name: 'edit_text_file',
        input: {
          filePath: editedPath,
          expectedSha256: 'edit-version',
          oldText: '旧台词',
          newText: '新台词',
        },
      },
      {
        type: 'tool.result',
        turnId,
        stepId,
        toolCallId,
        result: {
          status: 'success',
          output: { filePath: editedPath, replacements: 1, bytes: 9 },
        },
      },
      { type: 'turn.completed', turnId },
    ];
    const originalConversation = state.clientState.conversations[0]!;
    const editActivity = {
      id: toolCallId,
      kind: 'tool' as const,
      toolName: 'edit_text_file',
      status: 'completed' as const,
      files: [{ path: editedPath, label: '字幕.srt', role: 'input' as const }],
      durationMs: 12,
    };
    await saveDesktopState(filePath, {
      ...state,
      sessions: [{ ...state.sessions[0]!, events }, state.sessions[1]!],
      clientState: {
        ...state.clientState,
        conversations: [{
          ...originalConversation,
          messages: [{
            id: 1,
            role: 'assistant',
            status: 'completed',
            activity: [editActivity],
            activityExpanded: false,
            result: { responseText: '已修改', traceId: 'trace-edit' },
          }],
        }, state.clientState.conversations[1]!],
      },
    });

    const restored = await loadDesktopState(filePath);

    expect(restored?.sessions[0]?.events).toEqual(events);
    const restoredMessage = restored?.clientState.conversations[0]?.messages[0];
    expect(restoredMessage).toMatchObject({ activity: [editActivity] });
    expect(restoredMessage).not.toHaveProperty('result.outputFiles');
  });

  it('rejects a success result whose artifacts is not an array of strings', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    const turnId = 'turn-bad' as TurnId;
    await writeStoredJson(filePath, JSON.stringify({
      ...state,
      sessions: [{
        ...state.sessions[0]!,
        events: [
          { type: 'turn.started', turnId },
          {
            type: 'tool.called',
            turnId,
            stepId: 'step-bad',
            toolCallId: 'call-bad',
            name: 'write_text_file',
            input: { filePath: 'D:/videos/a.txt' },
          },
          {
            type: 'tool.result',
            turnId,
            stepId: 'step-bad',
            toolCallId: 'call-bad',
            result: { status: 'success', output: {}, artifacts: [7] },
          },
        ],
      }, state.sessions[1]!],
    }));

    await expect(loadDesktopState(filePath)).rejects.toThrowError(/artifacts/);
  });

  it('restores artifact cards from the legacy per-file name table', async () => {
    const filePath = await temporaryStatePath();
    // Commit 35 之前的真实格式：产物路径存在会话的 outputFilePaths 表里，消息只记 outputFileName。
    const [userMessage, replyMessage] = clientState().conversations[0]!.messages;
    await writeStoredJson(filePath, JSON.stringify({
      activeSessionId: 'session-a',
      outputSequence: 3,
      sessions: [{
        id: 'session-a',
        attachments: [{ path: 'D:\\videos\\input-a.mp4', role: 'video' }],
        outputFilePaths: { 'input-a-edited.mp4': 'D:/videos/input-a-edited.mp4' },
        events: sessionEvents('731'),
      }],
      clientState: {
        activeSessionId: 'session-a',
        conversations: [{
          id: 'session-a',
          title: '记住 731',
          titleManuallyRenamed: true,
          prompt: '',
          attachments: [{ path: 'D:\\videos\\input-a.mp4', name: 'input-a.mp4', role: 'video' }],
          messages: [
            userMessage,
            {
              ...replyMessage,
              result: { responseText: '已经记住。', traceId: 'trace-a', outputFileName: 'input-a-edited.mp4' },
            },
          ],
        }],
      },
    }));

    const restored = await loadDesktopState(filePath);
    expect(restored?.clientState.conversations[0]?.messages[1]).toMatchObject({
      status: 'completed',
      result: {
        responseText: '已经记住。',
        traceId: 'trace-a',
        outputFiles: [{ path: 'D:/videos/input-a-edited.mp4', fileName: 'input-a-edited.mp4' }],
      },
    });
  });

  it('keeps a legacy reply without a matching path as a reply with no artifact', async () => {
    const filePath = await temporaryStatePath();
    const [userMessage, replyMessage] = clientState().conversations[0]!.messages;
    await writeStoredJson(filePath, JSON.stringify({
      activeSessionId: 'session-a',
      outputSequence: 3,
      sessions: [{
        id: 'session-a',
        attachments: [],
        // 产物表里没有这个名字：宁可少一张卡，也不编造路径。
        outputFilePaths: {},
        events: sessionEvents('731'),
      }],
      clientState: {
        activeSessionId: 'session-a',
        conversations: [{
          id: 'session-a',
          title: '记住 731',
          titleManuallyRenamed: false,
          prompt: '',
          attachments: [],
          messages: [
            userMessage,
            {
              ...replyMessage,
              result: { responseText: '已经记住。', traceId: 'trace-a', outputFileName: 'missing.mp4' },
            },
          ],
        }],
      },
    }));

    const restored = await loadDesktopState(filePath);
    const reply = restored?.clientState.conversations[0]?.messages[1];
    expect(reply?.role === 'assistant' && reply.status === 'completed' && reply.result.outputFiles).toBeUndefined();
  });

  it('serializes only explicit session state and never reads API keys from the environment', async () => {
    const filePath = await temporaryStatePath();
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'must-not-be-persisted-secret';
    try {
      await saveDesktopState(filePath, persistedState());
      const source = await readStoredJson(filePath);
      expect(source).not.toContain('must-not-be-persisted-secret');
      expect(source).not.toContain('DEEPSEEK_API_KEY');
      expect(source).toContain('session-a');
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });
});
