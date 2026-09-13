import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientStateSnapshot } from '@agent-desktop/client';
import type { SessionEvent, StepId, TurnId } from '@agent-desktop/session';
import {
  loadDesktopState,
  saveDesktopState,
  type PersistedDesktopState,
} from '../src/main/session-persistence.js';

const temporaryDirectories: string[] = [];

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-session-'));
  temporaryDirectories.push(directory);
  return join(directory, 'session-state.json');
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
        selectedVideos: [{ name: 'input-a.mp4' }],
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
            toolsExpanded: false,
            tools: [{
              toolCallId: 'call-a',
              toolName: 'trim_video',
              status: 'completed',
              durationMs: 12,
            }],
            result: {
              responseText: '已经记住。',
              traceId: 'trace-a',
              outputFileName: 'input-a-edited.mp4',
            },
          },
        ],
      },
      {
        id: 'session-b',
        title: '记住 952',
        titleManuallyRenamed: false,
        prompt: '',
        selectedVideos: [],
        messages: [{
          id: 3,
          role: 'assistant',
          status: 'failed',
          errorMessage: '测试失败信息',
          tools: [],
          toolsExpanded: false,
        }, {
          id: 4,
          role: 'assistant',
          status: 'cancelled',
          tools: [{
            toolCallId: 'call-cancelled',
            toolName: 'trim_video',
            status: 'cancelled',
          }],
          toolsExpanded: false,
        }],
      },
    ],
  };
}

function persistedState(): PersistedDesktopState {
  return {
    activeSessionId: 'session-b',
    outputSequence: 7,
    sessions: [
      {
        id: 'session-a',
        selectedVideoPaths: ['D:\\videos\\input-a.mp4'],
        outputFilePaths: {
          'input-a-edited.mp4': 'D:\\videos\\input-a-edited.mp4',
        },
        events: sessionEvents('731'),
      },
      {
        id: 'session-b',
        selectedVideoPaths: [],
        outputFilePaths: {},
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
  it('treats only a missing state file as first launch', async () => {
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
    expect(restored?.outputSequence).toBe(7);
    expect(restored?.sessions[0]?.events).toEqual(sessionEvents('731'));
    expect(restored?.sessions[1]?.events).toEqual(sessionEvents('952'));
    expect(restored?.sessions[0]?.outputFilePaths).toEqual({
      'input-a-edited.mp4': 'D:\\videos\\input-a-edited.mp4',
    });
    expect(restored?.clientState.conversations[0]).toMatchObject({
      title: '记住 731',
      titleManuallyRenamed: true,
      prompt: 'Session A 未发送草稿',
      selectedVideos: [{ name: 'input-a.mp4' }],
    });
    expect(restored?.clientState.conversations[0]?.messages[1]).toMatchObject({
      tools: [{ status: 'completed' }],
      result: { outputFileName: 'input-a-edited.mp4', traceId: 'trace-a' },
    });
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

    await writeFile(filePath, JSON.stringify(legacyState), 'utf8');
    const restored = await loadDesktopState(filePath);

    expect(restored?.clientState.conversations[0]?.titleManuallyRenamed).toBe(false);
    expect(restored?.clientState.conversations[1]?.titleManuallyRenamed).toBe(false);
  });

  it('rejects a non-boolean titleManuallyRenamed value', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    await writeFile(filePath, JSON.stringify({
      ...state,
      clientState: {
        ...state.clientState,
        conversations: [{
          ...state.clientState.conversations[0],
          titleManuallyRenamed: 'yes',
        }, state.clientState.conversations[1]],
      },
    }), 'utf8');

    await expect(loadDesktopState(filePath)).rejects.toThrow(
      'clientState.conversations[0].titleManuallyRenamed',
    );
  });

  it('fails explicitly for corrupt JSON and invalid structure', async () => {
    const corruptPath = await temporaryStatePath();
    await writeFile(corruptPath, '{not json', 'utf8');
    await expect(loadDesktopState(corruptPath)).rejects.toThrow('无法解析本地会话');

    const invalidPath = await temporaryStatePath();
    await writeFile(invalidPath, JSON.stringify({ sessions: [] }), 'utf8');
    await expect(loadDesktopState(invalidPath)).rejects.toThrow('本地会话结构无效');
  });

  it('rejects an incomplete Renderer turn instead of persisting processing state', async () => {
    const filePath = await temporaryStatePath();
    const state = persistedState();
    await writeFile(filePath, JSON.stringify({
      ...state,
      clientState: {
        ...state.clientState,
        conversations: [{
          ...state.clientState.conversations[0],
          messages: [{
            id: 99,
            role: 'assistant',
            status: 'processing',
            tools: [],
            toolsExpanded: true,
          }],
        }, state.clientState.conversations[1]],
      },
    }), 'utf8');

    await expect(loadDesktopState(filePath)).rejects.toThrow('clientState.conversations[0].messages[0].status');
  });

  it('serializes only explicit session state and never reads API keys from the environment', async () => {
    const filePath = await temporaryStatePath();
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'must-not-be-persisted-secret';
    try {
      await saveDesktopState(filePath, persistedState());
      const source = await readFile(filePath, 'utf8');
      expect(source).not.toContain('must-not-be-persisted-secret');
      expect(source).not.toContain('DEEPSEEK_API_KEY');
      expect(source).toContain('session-a');
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });
});
