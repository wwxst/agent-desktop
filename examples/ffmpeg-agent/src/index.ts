import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createAgent, type AgentId } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type SessionEvent, type ToolResultEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  CropVideoTool,
  ProbeMediaTool,
  ResizeVideoTool,
  SetSpeedTool,
  TrimVideoTool,
} from '@agent-desktop/video-ffmpeg';

function formatToolResult(event: ToolResultEvent): string {
  if (event.result.status === 'error') return event.result.message;
  return typeof event.result.output === 'string'
    ? event.result.output
    : JSON.stringify(event.result.output);
}

/** 从当前 Turn 新增的事实中展示模型调用、FFmpeg 结果和最终回答。 */
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

/** CLI 只负责组装依赖；所有 Model、Tool、Result 控制流继续由 runTurn 驱动。 */
async function runCli(apiKey: string): Promise<void> {
  const tools = new InMemoryToolRegistry();
  tools.register(new ProbeMediaTool());
  tools.register(new TrimVideoTool());
  tools.register(new ConcatVideosTool());
  tools.register(new AddAudioTool());
  tools.register(new AddSubtitlesTool());
  tools.register(new ResizeVideoTool());
  tools.register(new CropVideoTool());
  tools.register(new SetSpeedTool());

  const agent = createAgent({
    id: 'ffmpeg-agent' as AgentId,
    model: new DeepSeekModel({ apiKey }),
    session: new InMemorySession(),
    tools,
    systemPrompt: new StaticSystemPrompt([
      '你是一个视频处理 Agent。',
      '需要读取视频信息、裁剪时间、拼接、替换音频、添加字幕、调整分辨率、裁剪画面或改变播放速度时，使用提供的 FFmpeg tools。',
      '不要声称已经处理文件，除非 Tool 实际执行成功。',
    ].join('\n')),
  });
  const terminal = createInterface({ input, output });

  output.write('Agent Desktop FFmpeg Agent\n\n');
  output.write('输入视频处理需求，输入 /exit 退出。\n\n');
  terminal.setPrompt('你> ');
  terminal.prompt();

  try {
    for await (const userInput of terminal) {
      if (userInput === '/exit') break;

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
