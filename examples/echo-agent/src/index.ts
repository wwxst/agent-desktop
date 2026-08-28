import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runTurn } from '@agent-desktop/agent-loop';
import type { SessionEvent, ToolResultEvent } from '@agent-desktop/session';
import { createEchoAgent } from './echo.ts';

/** Echo Tool 只返回字符串；失败时展示 Session 中已经稳定化的错误消息。 */
function formatToolResult(event: ToolResultEvent): string {
  return event.result.status === 'success'
    ? String(event.result.output)
    : event.result.message;
}

/** 展示当前 Turn 新产生的工具事件，让终端用户可以直接观察 Runtime 闭环。 */
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

// CLI 启动时只创建一次 Agent，因此所有用户输入共享同一个内存 Session。
const agent = createEchoAgent();
const terminal = createInterface({ input, output });

output.write('Agent Desktop Echo Agent\n\n');
output.write('输入内容，输入 /exit 退出。\n\n');
terminal.setPrompt('你> ');
terminal.prompt();

try {
  // 异步行迭代既等待交互输入，也会按顺序保留管道中已经到达的多行文本。
  for await (const userInput of terminal) {
    if (userInput === '/exit') break;

    // 记录执行前长度，只展示本次 Turn 追加的事件，不重复打印历史 Turn。
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
