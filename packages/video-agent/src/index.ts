import type { Agent } from '@agent-desktop/agent';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type Session } from '@agent-desktop/session';
import { TranscribeAudioTool } from '@agent-desktop/speech-whisper-cpp';
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import {
  AddAudioTool,
  AddSubtitlesTool,
  ConcatVideosTool,
  CropVideoTool,
  ExtractAudioTool,
  ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool,
  ProbeMediaTool,
  ResizeVideoTool,
  SetSpeedTool,
  TrimVideoTool,
} from '@agent-desktop/video-ffmpeg';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';
import { VIDEO_AGENT_SYSTEM_PROMPT } from './system-prompt.js';

/** 创建正式视频 Agent 所需的最小外部配置；环境变量解析由调用入口负责。 */
export interface VideoAgentOptions {
  readonly deepSeekApiKey: string;
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly whisperModelPath?: string;
  readonly whisperCliPath?: string;
  readonly visionApiKey?: string;
  readonly visionBaseUrl?: string;
  readonly session?: Session;
}

/** 组装当前正式视频能力；不读取环境、不创建 CLI 或桌面层状态。 */
export function createVideoAgent(options: VideoAgentOptions): Agent {
  const tools = new InMemoryToolRegistry();
  tools.register(new ProbeMediaTool());
  tools.register(new ExtractVideoFramesTool());
  tools.register(new ExtractVideoRangeFramesTool());
  tools.register(new ExtractAudioTool());
  if (options.visionApiKey !== undefined && options.visionApiKey.length > 0) {
    tools.register(new AnalyzeImagesTool(
      options.visionBaseUrl === undefined
        ? { apiKey: options.visionApiKey }
        : { apiKey: options.visionApiKey, baseUrl: options.visionBaseUrl },
    ));
  }
  if (options.whisperModelPath !== undefined) {
    tools.register(new TranscribeAudioTool(
      options.whisperCliPath === undefined
        ? { modelPath: options.whisperModelPath }
        : { modelPath: options.whisperModelPath, command: options.whisperCliPath },
    ));
  }
  tools.register(new TrimVideoTool());
  tools.register(new ConcatVideosTool());
  tools.register(new AddAudioTool());
  tools.register(new AddSubtitlesTool());
  tools.register(new ResizeVideoTool());
  tools.register(new CropVideoTool());
  tools.register(new SetSpeedTool());

  const modelOptions = {
    apiKey: options.deepSeekApiKey,
    ...(options.deepSeekBaseUrl === undefined ? {} : { baseUrl: options.deepSeekBaseUrl }),
    ...(options.deepSeekModel === undefined ? {} : { model: options.deepSeekModel }),
  };

  return {
    model: new DeepSeekModel(modelOptions),
    session: options.session ?? new InMemorySession(),
    tools,
    systemPrompt: new StaticSystemPrompt(VIDEO_AGENT_SYSTEM_PROMPT),
  };
}
