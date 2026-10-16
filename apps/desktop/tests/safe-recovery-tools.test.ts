import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareTurnStart, runStartedTurn } from '@agent-desktop/agent-loop';
import { ListDirectoryTool, ReadFileTool, SearchTextTool, type WorkspacePort } from '@agent-desktop/local-tools';
import type { Model, ToolCall } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts, type SessionEvent } from '@agent-desktop/session';
import { InMemoryToolRegistry, UpdatePlanTool } from '@agent-desktop/tools';
import { createVideoAgent, type TerminalPort } from '@agent-desktop/video-agent';
import { qualifyTaskToolEvidence, taskToolGate } from '../src/main/agent-task-state.js';

const call = (id: string, name: string, input: unknown): ToolCall => ({ id: id as never, name, input });

describe('Desktop safe recovery tools', () => {
  it('reads local evidence and updates a plan while an earlier external effect remains unknown', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'safe-recovery-tools-')));
    try {
      await writeFile(join(directory, 'note.txt'), 'actual recovery evidence\n');
      const original = prepareTurnStart('读取本地证据并整理计划');
      const unknownIndex = original.events.length;
      const history: SessionEvent[] = [...original.events,
        { type: 'tool.called', turnId: original.turnId, stepId: 'old-step' as never,
          toolCallId: 'old-call' as never, name: 'external_write', input: {}, boundary: 'opaque' },
        { type: 'turn.interrupted', turnId: original.turnId, reason: 'process-exit' },
      ];
      const session = new InMemorySession(history);
      const recovery = prepareTurnStart('核验原任务', { sourceTurnId: original.turnId, mode: 'verify' });
      session.appendMany(recovery.events);
      const workspace: WorkspacePort = {
        confirmedDirectory: () => directory,
        requestApproval: vi.fn(async () => true),
        confirmDirectory: vi.fn(),
      };
      const tools = new InMemoryToolRegistry();
      [new ListDirectoryTool(workspace), new ReadFileTool(workspace), new SearchTextTool(workspace),
        new UpdatePlanTool(session, qualifyTaskToolEvidence)].forEach(tool => tools.register(tool));
      const videoAgent = createVideoAgent({ deepSeekApiKey: 'test-key', session, terminal: {
          open: async () => ({}), read: async id => ({ terminalId: id, output: 'saved history' }),
          write: async () => ({}), close: async () => ({}),
        } satisfies TerminalPort });
      const readTerminal = videoAgent.tools.get('read_terminal');
      if (readTerminal === undefined) throw new Error('read_terminal tool was not registered');
      tools.register(readTerminal);
      let request = 0;
      const model: Model = { complete: async () => {
        request += 1;
        if (request === 1) return { toolCalls: [
          call('list', 'list_directory', {}),
          call('read', 'read_file', { filePath: 'note.txt' }),
          call('search', 'search_text', { pattern: 'recovery evidence' }),
          call('plan', 'update_plan', { explanation: '已有写入需核验，先整理剩余工作。',
            steps: [{ id: 'verify', description: '核验原外部操作', requestedStatus: 'pending',
              completionKind: 'tool', evidenceEventIndexes: [] }] }),
          call('terminal', 'read_terminal', { terminalId: 'historical' }),
        ] };
        if (request === 2) return { toolCalls: [
          call('missing-read', 'read_file', { filePath: 'missing.txt' }),
          call('invalid-plan', 'update_plan', {}),
        ] };
        return { text: '已读取证据，原外部效果仍需核验。', toolCalls: [] };
      } };

      await runStartedTurn({ session, tools, model, systemPrompt: { build: () => '安全核验' } }, recovery.turnId,
        { beforeToolCall: input => taskToolGate(session.events(), input), qualifyToolEvidence: qualifyTaskToolEvidence });

      const results = session.events().filter(event => event.type === 'tool.result');
      expect(results.map(event => event.result.status)).toEqual(['success', 'success', 'success', 'success', 'success', 'error', 'error']);
      expect(results[1]?.result).toMatchObject({ status: 'success', output: { lines: ['actual recovery evidence'] } });
      expect(results[2]?.result).toMatchObject({ status: 'success', output: { matches: [expect.objectContaining({ line: 'actual recovery evidence' })] } });
      expect(results[4]?.result).toMatchObject({ status: 'success', output: { output: 'saved history' } });
      expect(session.events().some(event => event.type === 'plan.updated' && event.turnId === recovery.turnId)).toBe(true);
      expect(projectRecoveryFacts(session.events()).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([unknownIndex]);
      expect(workspace.requestApproval).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
