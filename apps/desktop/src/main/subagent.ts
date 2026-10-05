import { randomUUID } from 'node:crypto';
import { runTurn, StepBudgetError } from '@agent-desktop/agent-loop';
import { ListDirectoryTool, ReadFileTool, SearchTextTool, type WorkspacePort } from '@agent-desktop/local-tools';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type SessionEvent } from '@agent-desktop/session';
import { InMemoryToolRegistry, type ToolExecutionContext } from '@agent-desktop/tools';
import type { ReadOnlyTask, SubagentResult } from '@agent-desktop/video-agent';
import type { RuntimeConfiguration } from './runtime-settings.js';

export interface SubagentRecord {
  readonly parentToolCallId: string; readonly events: readonly SessionEvent[]; readonly result: SubagentResult;
}
export interface SubagentActivity {
  readonly taskId: string; readonly title: string; readonly status: string; readonly toolName?: string;
}

/** 宿主组装独立只读会话，密钥不经过委派工具，也不复制父模型历史。 */
export async function runReadOnlySubagent(task: ReadOnlyTask, context: ToolExecutionContext,
  directory: string | undefined, settings: RuntimeConfiguration,
  publish: (activity: SubagentActivity) => void, save: (record: SubagentRecord) => void): Promise<SubagentResult> {
  const taskId = randomUUID();
  const session = new InMemorySession();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context.signal?.addEventListener('abort', cancel, { once: true });
  if (context.signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  const evidence = new Set<string>();
  let result: SubagentResult;
  try {
    if (directory === undefined) throw new Error('只读子任务需要已经确认的会话工作目录。');
    if (settings.deepSeekApiKey === undefined) throw new Error('对话模型未配置 API 密钥。');
    const workspace: WorkspacePort = {
      confirmedDirectory: () => directory,
      requestApproval: async () => { throw new Error('只读子任务不能请求目录变更或副作用审批。'); },
      confirmDirectory: () => { throw new Error('只读子任务不能改变目录。'); },
    };
    const tools = new InMemoryToolRegistry();
    tools.register(new ListDirectoryTool(workspace));
    tools.register(new ReadFileTool(workspace));
    tools.register(new SearchTextTool(workspace));
    publish({ taskId, title: task.title, status: 'running' });
    const completed = await runTurn({
      session, tools,
      model: new DeepSeekModel({ apiKey: settings.deepSeekApiKey,
        ...(settings.deepSeekBaseUrl === undefined ? {} : { baseUrl: settings.deepSeekBaseUrl }),
        ...(settings.deepSeekModel === undefined ? {} : { model: settings.deepSeekModel }),
        ...(settings.modelProtocol === undefined ? {} : { protocol: settings.modelProtocol }),
        ...(settings.modelMaxOutputTokens === undefined ? {} : { maxOutputTokens: settings.modelMaxOutputTokens }),
        ...(settings.useDeepSeekThinking === undefined ? {} : { disableThinking: settings.useDeepSeekThinking }) }),
      systemPrompt: { build: () => `你是只读文件检查子智能体。只执行明确委派，不修改文件，不执行命令，不继续委派。工作目录：${directory}。返回有依据的简短结论和文件位置，不能把工具失败当作完成。` },
    }, task.instruction, {
      signal: controller.signal, maxSteps: 8,
      trace: (event) => {
        if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
          publish({ taskId, title: task.title, toolName: event.toolName,
            status: 'running' });
        }
      },
      onToolResult: (_id, _name, value) => {
        if (value.status === 'success' && typeof value.output === 'object' && value.output !== null) {
          const output = value.output as { filePath?: unknown; directory?: unknown; matches?: Array<{ filePath?: unknown }> };
          if (typeof output.filePath === 'string') evidence.add(output.filePath);
          if (typeof output.directory === 'string') evidence.add(output.directory);
          for (const match of output.matches ?? []) if (typeof match.filePath === 'string') evidence.add(match.filePath);
        }
      },
    });
    const summary = (completed.response.text ?? '').trim().slice(0, 8000);
    const hasResult = evidence.size > 0 && summary.length > 0;
    result = { taskId, title: task.title, status: hasResult ? 'completed' : 'failed',
      summary: hasResult ? summary : '子任务没有返回有读取依据的结论，未完成检查。', evidence: [...evidence] };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    result = { taskId, title: task.title,
      status: timedOut || error instanceof StepBudgetError ? 'budget-exhausted' : error.name === 'AbortError' ? 'cancelled' : 'failed',
      summary: timedOut ? '子任务超过 120 秒，尚未完成。' : error.message, evidence: [...evidence] };
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener('abort', cancel);
  }
  save({ parentToolCallId: context.toolCallId, events: session.events(), result });
  publish({ taskId, title: task.title, status: result.status });
  return result;
}
