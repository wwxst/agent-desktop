import { randomUUID } from 'node:crypto';
import type { Agent } from '@agent-desktop/agent';
import type { ModelMessage, ModelResponse, ModelToolDefinition, ToolCall } from '@agent-desktop/model';
import type { SessionEvent, StepId, ToolResult, TurnId } from '@agent-desktop/session';

/** 一次 Turn 的最小公开结果；不返回可变 Session，调用方通过 Agent 自己读取历史。 */
export interface RunTurnResult {
  readonly turnId: TurnId;
  readonly stepCount: number;
  readonly response: ModelResponse;
}

function createTurnId(): TurnId {
  // Node.js 原生 UUID 已满足唯一性需求，类型断言只负责附加编译期品牌。
  return randomUUID() as TurnId;
}

function createStepId(): StepId {
  // Step 使用独立品牌，防止在需要 StepId 的位置误传 TurnId。
  return randomUUID() as StepId;
}

/** 把 Session 中的未知工具输出稳定投影为模型协议要求的字符串。 */
function formatToolResultForModel(result: ToolResult): string {
  // 错误消息已经是稳定字符串，不再包装或序列化。
  if (result.status === 'error') return result.message;
  // 字符串保持原样，避免 JSON.stringify 额外添加引号。
  if (typeof result.output === 'string') return result.output;

  try {
    // JSON 兼容值使用 JSON 文本；undefined 等无 JSON 结果的值退回 String。
    return JSON.stringify(result.output) ?? String(result.output);
  } catch {
    // 循环引用等值无法 JSON 序列化时，按最小规则使用字符串表示。
    return String(result.output);
  }
}

/**
 * 每次模型调用前都从 Session 事件重建上下文。
 * 不维护隐藏 messages 数组，确保 Session 始终是唯一事实来源。
 */
function buildModelMessages(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const event of events) {
    // 只投影模型需要看到的三类事实，生命周期事件留在 Session 中供审计。
    switch (event.type) {
      case 'user.message':
        messages.push({ role: 'user', content: event.content });
        break;
      case 'assistant.message':
        // exactOptionalPropertyTypes 下，缺少 content 与显式 content: undefined 不等价。
        messages.push(event.content === undefined
          ? { role: 'assistant', toolCalls: event.toolCalls }
          : { role: 'assistant', content: event.content, toolCalls: event.toolCalls });
        break;
      case 'tool.result':
        // ToolCallId 保留调用与结果的关联，格式化只依赖已写入 Session 的结果。
        messages.push({
          role: 'tool',
          toolCallId: event.toolCallId,
          content: formatToolResultForModel(event.result),
        });
        break;
      default:
        // Turn、Step 和 tool.called 是运行事实，不直接进入模型消息。
        break;
    }
  }

  return messages;
}

/** 只向模型暴露工具描述，解构投影会主动排除 execute 运行时方法。 */
function buildToolDefinitions(agent: Agent): ModelToolDefinition[] {
  return agent.tools.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** 把任意 JavaScript 抛出值收敛为可写入 Session 的稳定文本。 */
function formatThrownValue(error: unknown): string {
  // 标准 Error 优先保留其业务消息，不把堆栈等运行时对象写入 Session。
  if (error instanceof Error) return error.message;

  try {
    return String(error);
  } catch {
    return 'Unknown tool execution error';
  }
}

/** 执行单个 Tool Call，并保证调用事件与结果事件使用同一个 ToolCallId。 */
async function executeToolCall(agent: Agent, turnId: TurnId, stepId: StepId, toolCall: ToolCall): Promise<void> {
  // 查找和执行前先记录调用，即使工具不存在或抛错也保留完整起点。
  agent.session.append({
    type: 'tool.called',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  });

  const tool = agent.tools.get(toolCall.name);
  let result: ToolResult;

  if (!tool) {
    // 未知工具转换为模型可见错误，而不是中断整个 Turn。
    result = { status: 'error', message: `Tool not found: ${toolCall.name}` };
  } else {
    try {
      result = await tool.execute(toolCall.input);
    } catch (error) {
      // Tool 运行时异常属于执行结果，必须转换后继续下一 Step。
      result = { status: 'error', message: formatThrownValue(error) };
    }
  }

  // 无论成功或失败都追加结果，维持 tool.called -> tool.result 的可追踪关系。
  agent.session.append({
    type: 'tool.result',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    result,
  });
}

/** 从用户输入开始运行一个完整 Turn，直到模型返回零个 Tool Call。 */
export async function runTurn(agent: Agent, input: string): Promise<RunTurnResult> {
  const turnId = createTurnId();
  let stepCount = 0;

  // Turn 生命周期先于用户消息写入，固定 Session 中的事实顺序。
  agent.session.append({ type: 'turn.started', turnId });
  agent.session.append({ type: 'user.message', turnId, content: input });

  while (true) {
    // 一次 Model.complete 调用严格对应一个新 Step。
    const stepId = createStepId();
    stepCount += 1;
    agent.session.append({ type: 'step.started', turnId, stepId });

    // System Prompt、历史消息和工具描述都从 Agent 的当前依赖即时构建。
    const response = await agent.model.complete({
      systemPrompt: agent.systemPrompt.build(),
      messages: buildModelMessages(agent.session.events()),
      tools: buildToolDefinitions(agent),
    });

    // 先完整记录模型响应；文本与 Tool Calls 可以同时存在。
    agent.session.append(response.text === undefined
      ? { type: 'assistant.message', turnId, stepId, toolCalls: response.toolCalls }
      : { type: 'assistant.message', turnId, stepId, content: response.text, toolCalls: response.toolCalls });

    // 多个工具调用按响应顺序串行执行，保证事件顺序确定且同属当前 Step。
    for (const toolCall of response.toolCalls) {
      await executeToolCall(agent, turnId, stepId, toolCall);
    }

    // 所有工具结果写入后才完成 Step，下一次模型调用才能看到完整结果。
    agent.session.append({ type: 'step.completed', turnId, stepId });

    if (response.toolCalls.length === 0) {
      // 零 Tool Call 是 MVP 的自然终止条件，完成 Turn 后返回最后模型响应。
      agent.session.append({ type: 'turn.completed', turnId });
      return { turnId, stepCount, response };
    }
  }
}
