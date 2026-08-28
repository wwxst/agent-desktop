import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createAgent, type AgentId } from '@agent-desktop/agent';
import { runTurn } from '@agent-desktop/agent-loop';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type SessionEvent, type ToolResultEvent } from '@agent-desktop/session';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  CropVideoTool,
  ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool,
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
async function runCli(
  apiKey: string,
  visionApiKey: string,
  visionBaseUrl?: string,
): Promise<void> {
  const tools = new InMemoryToolRegistry();
  tools.register(new ProbeMediaTool());
  tools.register(new ExtractVideoFramesTool());
  tools.register(new ExtractVideoRangeFramesTool());
  tools.register(new AnalyzeImagesTool(
    visionBaseUrl === undefined
      ? { apiKey: visionApiKey }
      : { apiKey: visionApiKey, baseUrl: visionBaseUrl },
  ));
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
      '当用户询问视频画面内容，或需要理解画面才能决定下一步时，先使用 extract_video_frames，再把返回的图片路径和时间戳交给 analyze_images。',
      '视觉工具只负责观察并返回描述；根据视觉结果回答用户，或继续执行视频处理 Tool，不要让视觉模型决定剪辑方案。',
      '当用户要求根据画面内容决定保留、删除或重排片段时，先使用 extract_video_frames 和 analyze_images 粗看整段视频。',
      '如果粗看只能确定大致范围但无法判断剪切边界，使用 extract_video_range_frames 检查该范围，再把返回的图片路径和绝对时间戳交给 analyze_images；仍不确定时可以继续缩小范围检查。',
      '抽取的画面只是采样，时间戳只能作为近似时间依据，不能假装内容变化精确发生在某张采样帧；边界影响明显时必须继续缩小范围确认。',
      '每个保留片段都要分别确认内容进入和退出的近似边界，不能因为目标内容靠近视频开头或结尾就默认保留到首尾；范围内出现后续不同内容时必须继续检查退出边界。',
      '剪辑决定由你根据视觉 Tool Result 作出；确定保留范围和顺序后，使用现有 trim_video 生成保留片段，再用 concat_videos 生成最终文件，不要要求视觉模型输出剪辑计划。',
      // 一个自然语言编辑请求对用户是一个 Turn；多项操作由 Agent Loop 中的多个 Step 完成。
      '一次自然语言视频编辑请求就是一个 Turn；如果请求包含多个操作，必须在同一个 Turn 中通过多个连续的 Tool Call 和 Step 完成。',
      '只有前一个 Tool 成功后才能继续下一个操作；Tool 返回 error 时必须让模型看到错误，并且不能声称任务成功。',
      '上一个视频 Tool 产生的 outputPath 必须作为下一个视频 Tool 的 inputPath 或 videoPath。',
      '中间文件放在最终 outputPath 的同一目录，文件名由你根据需要决定；不要自动删除中间文件。',
      'Tool 的选择和顺序由你根据用户请求决定，不要假定或硬编码固定顺序。',
      '不要在执行前输出单独的计划，直接调用完成当前请求所需的 Tool；最后一个 Tool 必须写入用户要求的最终 outputPath。',
      '不要声称已经处理文件，除非最后的 Tool 实际执行成功。',
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

  await runCli(
    apiKey,
    process.env.OPENAI_API_KEY ?? '',
    process.env.OPENAI_BASE_URL,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`${message}\n`);
  process.exitCode = 1;
});
