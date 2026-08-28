import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createAgent, type AgentId } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type SessionEvent, type ToolResultEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry, type Tool, type ToolExecutionResult } from '@agent-desktop/tools';

interface EchoInput {
  readonly text: string;
}

/** DeepSeek 产生的 Tool input 仍是 unknown，工具在执行前完成最小结构判断。 */
function isEchoInput(value: unknown): value is EchoInput {
  return typeof value === 'object'
    && value !== null
    && 'text' in value
    && typeof value.text === 'string';
}

/** 当前真实模型示例只提供 Echo Tool，用它验证 Function Calling 的完整闭环。 */
class EchoTool implements Tool {
  readonly name = 'echo';
  readonly description = '返回输入文本';
  readonly inputSchema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };

  async execute(inputValue: unknown): Promise<ToolExecutionResult> {
    if (!isEchoInput(inputValue)) {
      return { status: 'error', message: 'Echo tool requires input.text to be a string' };
    }

    return { status: 'success', output: inputValue.text };
  }
}

function formatToolResult(event: ToolResultEvent): string {
  return event.result.status === 'success'
    ? String(event.result.output)
    : event.result.message;
}

/** 从当前 Turn 新增的 Session 事实中展示真实模型发起的工具调用和执行结果。 */
function printTurnEvents(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (event.type === 'tool.called') {
      output.write(`Tool Call > ${event.name}\n`);
    }

    if (event.type === 'tool.result') {
      output.write(`Tool Result > ${formatToolResult(event)}\n`);
    }
  }
}

/** 只在存在 API Key 时组装真实 DeepSeek Agent，整个 CLI 复用同一个内存 Session。 */
async function runCli(apiKey: string): Promise<void> {
  const tools = new InMemoryToolRegistry();
  tools.register(new EchoTool());

  const agent = createAgent({
    id: 'deepseek-agent' as AgentId,
    model: new DeepSeekModel({ apiKey }),
    session: new InMemorySession(),
    tools,
    systemPrompt: new StaticSystemPrompt(
      'You are the Agent Desktop DeepSeek Agent. Use the echo tool when the user asks you to echo text.',
    ),
  });
  const terminal = createInterface({ input, output });

  output.write('Agent Desktop DeepSeek Agent\n\n');
  output.write('输入内容，输入 /exit 退出。\n\n');
  terminal.setPrompt('你> ');
  terminal.prompt();

  try {
    for await (const userInput of terminal) {
      if (userInput === '/exit') break;

      // runTurn 正式驱动 Model、Tool、Result、Model，不在 CLI 中复制 Runtime 算法。
      const eventStart = agent.session.events().length;
      const result = await runTurn(agent, userInput);
      const turnEvents = agent.session.events().slice(eventStart);

      printTurnEvents(turnEvents);
      if (result.response.text !== undefined) {
        output.write(`Agent > ${result.response.text}\n\n`);
      }

      terminal.prompt();
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 不回显配置内容，只说明必须由运行环境提供 Key。
    output.write('缺少 DEEPSEEK_API_KEY 环境变量。\n');
    process.exitCode = 1;
    return;
  }

  await runCli(apiKey);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`${message}\n`);
  process.exitCode = 1;
});
