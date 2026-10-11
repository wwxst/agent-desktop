import { stdin as input, stdout as output } from 'node:process';
import { stderr } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runTurn } from '@agent-desktop/agent-loop';
import { createJsonlTrace } from '@agent-desktop/execution-trace';
import { ProbeMediaTool, DecodeVideoTool, DetectBlackSegmentsTool, ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool, ExtractAudioTool, ExtractFullVideoFramesTool, TrimVideoTool, ConcatVideosTool,
  AddAudioTool, AddSubtitlesTool, ResizeVideoTool, CropVideoTool, SetSpeedTool } from '@agent-desktop/video-ffmpeg';
import { type SessionEvent, type ToolResultEvent, type TurnId } from '@agent-desktop/session';
import {
  createVideoAgent,
  projectOutputItemResults,
  readVideoDeliveryFacts,
} from '@agent-desktop/video-agent';

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

/**
 * 打印本轮的视频交付结果。
 *
 * 它复用应用层的读取投影，因此命令行与桌面使用同一份「什么算交付」的规则；
 * 没有声明过输出项时（普通问答、只读分析）不打印交付结论。
 */
function printDeliveryResults(events: readonly SessionEvent[], turnId: TurnId): void {
  const facts = readVideoDeliveryFacts(events);
  if (facts.declarationTurnId !== turnId) return;

  const results = projectOutputItemResults(facts);
  if (results.length === 0) return;

  const publishedCount = results.filter((result) => result.status === 'published').length;
  output.write(`Delivery > ${publishedCount}/${results.length} delivered\n`);
  for (const result of results) {
    output.write(result.status === 'published'
      ? `  - published: ${result.output.path}\n`
      : `  - ${result.status}: ${result.reason}\n`);
  }
}

/** CLI 只负责组装依赖；所有 Model、Tool、Result 控制流继续由 runTurn 驱动。 */
async function runCli(
  apiKey: string,
  whisperModelPath: string,
  whisperCommand: string | undefined,
  visionApiKey: string,
  deepSeekBaseUrl: string | undefined,
  visionBaseUrl?: string,
): Promise<void> {
  const agent = createVideoAgent({
    deepSeekApiKey: apiKey,
    mediaTools: [new ProbeMediaTool(), new DecodeVideoTool(), new DetectBlackSegmentsTool(), new ExtractVideoFramesTool(),
      new ExtractVideoRangeFramesTool(), new ExtractAudioTool(), new ExtractFullVideoFramesTool(), new TrimVideoTool(),
      new ConcatVideosTool(), new AddAudioTool(), new AddSubtitlesTool(), new ResizeVideoTool(), new CropVideoTool(), new SetSpeedTool()],
    whisperModelPath,
    visionApiKey,
    ...(deepSeekBaseUrl === undefined ? {} : { deepSeekBaseUrl }),
    ...(whisperCommand === undefined ? {} : { whisperCliPath: whisperCommand }),
    ...(visionBaseUrl === undefined ? {} : { visionBaseUrl }),
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
      await mkdir('logs', { recursive: true });
      const trace = createJsonlTrace(join('logs', 'agent-trace.jsonl'));
      stderr.write(`Trace: ${trace.id}\n`);
      const result = await runTurn(agent, userInput, { trace: trace.write });
      const turnEvents = agent.session.events().slice(eventStart);

      printTurnEvents(turnEvents);
      printDeliveryResults(agent.session.events(), result.turnId);
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

  const whisperModelPath = process.env.WHISPER_MODEL_PATH;
  if (!whisperModelPath) {
    output.write('WHISPER_MODEL_PATH is required\n');
    process.exitCode = 1;
    return;
  }

  await runCli(
    apiKey,
    whisperModelPath,
    process.env.WHISPER_CLI_PATH,
    process.env.OPENAI_API_KEY ?? '',
    process.env.DEEPSEEK_BASE_URL,
    process.env.OPENAI_BASE_URL,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`${message}\n`);
  process.exitCode = 1;
});
