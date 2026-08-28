import { randomUUID } from 'node:crypto';
import { createAgent, type Agent, type AgentId } from '@agent-desktop/agent';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry, type Tool, type ToolExecutionResult } from '@agent-desktop/tools';

interface EchoInput {
  readonly text: string;
}

/** 在没有 Schema Library 的示例中，使用最小类型守卫确认 Echo Tool 的实际输入。 */
function isEchoInput(input: unknown): input is EchoInput {
  return typeof input === 'object'
    && input !== null
    && 'text' in input
    && typeof input.text === 'string';
}

/** Echo Tool 只返回传入文本，用最小行为证明 Tool Registry 和执行链路可工作。 */
export class EchoTool implements Tool {
  readonly name = 'echo';
  readonly description = '返回输入文本';
  readonly inputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  };

  async execute(input: unknown): Promise<ToolExecutionResult> {
    // 工具边界接收 unknown，因此在读取 text 前完成当前示例所需的最小校验。
    if (!isEchoInput(input)) {
      return { status: 'error', message: 'Echo tool requires input.text to be a string' };
    }

    return { status: 'success', output: input.text };
  }
}

/**
 * 确定性 Echo 模拟模型只用于验证 Agent Runtime，不是真实 AI。
 * 它不调用任何模型 API，也不进行大模型推理，而是按最新消息类型返回固定行为。
 */
export class DeterministicEchoModel implements Model {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const latestMessage = request.messages.at(-1);

    if (latestMessage?.role === 'user') {
      // 第一次模型调用把最新用户文本转换为 Echo Tool Call，交给 Agent Loop 执行。
      return {
        toolCalls: [{
          id: randomUUID() as ToolCallId,
          name: 'echo',
          input: { text: latestMessage.content },
        }],
      };
    }

    if (latestMessage?.role === 'tool') {
      // Tool Result 由 Session 重建后重新进入模型；此处据此生成最终回答。
      return {
        text: `Echo result: ${latestMessage.content}`,
        // 第二次响应不再请求工具，Agent Loop 因此自然完成当前 Turn。
        toolCalls: [],
      };
    }

    throw new Error('DeterministicEchoModel requires the latest message to be user or tool');
  }
}

/**
 * 组装第一个可运行 Agent；examples 只消费 Core 公共 API，不属于 Agent Core。
 * 每次调用创建一个内存 Session，CLI 会在整个进程生命周期复用这个 Agent 实例。
 */
export function createEchoAgent(): Agent {
  const tools = new InMemoryToolRegistry();
  tools.register(new EchoTool());

  return createAgent({
    id: 'echo-agent' as AgentId,
    model: new DeterministicEchoModel(),
    session: new InMemorySession(),
    tools,
    systemPrompt: new StaticSystemPrompt(
      'You are the Agent Desktop Echo Agent. Use the echo tool when asked to echo text.',
    ),
  });
}
