import type { Agent } from '@agent-desktop/agent';
import {
  EditTextFileTool,
  ListDirectoryTool,
  ReadFileTool,
  RunCommandTool,
  SearchTextTool,
  SetWorkingDirectoryTool,
  WriteTextFileTool,
  type CommandPort,
  type WorkspacePort,
} from '@agent-desktop/local-tools';
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
  DecodeVideoTool,
  DetectBlackSegmentsTool,
  ExtractAudioTool,
  ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool,
  ProbeMediaTool,
  ResizeVideoTool,
  SetSpeedTool,
  TrimVideoTool,
} from '@agent-desktop/video-ffmpeg';
import { AnalyzeImagesTool } from '@agent-desktop/vision-openai';
import {
  DeclareVideoOutputsTool,
  PublishVideoOutputTool,
  ScopedVideoOutputTool,
  ValidateVideoCandidateTool,
} from './delivery-tools.js';
import { AGENT_SYSTEM_PROMPT } from './system-prompt.js';

// 交付模型与读取投影是桌面与命令行共用的唯一权威实现，必须从包入口暴露。
export {
  latestValidationForCandidate,
  latestValidationForItem,
  projectOutputItemResults,
  readVideoDeliveryFacts,
} from './delivery.js';
export type {
  Candidate,
  CandidateValidation,
  OutputItem,
  OutputItemResult,
  OutputRequirement,
  OutputTarget,
  PublishedOutput,
  RequirementCheck,
  VideoDeliveryFacts,
  VideoOutputFact,
} from './delivery.js';

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
  /**
   * 会话工作目录能力。只有能提供目录状态和目录访问确认的宿主才传入，
   * 没有它时不注册 `set_working_directory`——没有宿主的目录确认就没有合法的消费者。
   */
  readonly workspace?: WorkspacePort;
  /**
   * 本机命令执行能力。它同时需要会话目录范围与逐次审批，因此只有能提供解释器路径和
   * 受限子进程环境的宿主才传入；没有它时不注册 `run_command`。
   */
  readonly command?: CommandPort;
}

/** 组装当前正式能力；不读取环境、不创建 CLI 或桌面层状态。 */
export function createVideoAgent(options: VideoAgentOptions): Agent {
  // Session 先于工具创建：交付工具与写出边界都要从同一份会话事实里读取声明、候选和验收。
  const session = options.session ?? new InMemorySession();
  const readEvents = () => session.events();
  const tools = new InMemoryToolRegistry();
  // 先注册目录基准工具：它决定后续本地文件工具的路径解析基准。
  if (options.workspace !== undefined) {
    tools.register(new SetWorkingDirectoryTool(options.workspace));
    tools.register(new ListDirectoryTool(options.workspace));
    tools.register(new ReadFileTool(options.workspace));
    tools.register(new SearchTextTool(options.workspace));
    tools.register(new WriteTextFileTool(options.workspace));
    tools.register(new EditTextFileTool(options.workspace));
    // 命令工具复用同一份目录范围和审批能力：没有工作目录就没有合法的执行起点，
    // 没有审批就没有合法的命令授权，因此两者缺一都不注册。
    if (options.command !== undefined) {
      tools.register(new RunCommandTool(options.workspace, options.command));
    }
  }
  tools.register(new ProbeMediaTool());
  tools.register(new DecodeVideoTool());
  tools.register(new DetectBlackSegmentsTool());
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
  // 写出型视频工具统一套上候选工作目录边界：写出位置由真实调用边界约束，而不是只写在提示词里。
  tools.register(new ScopedVideoOutputTool(new TrimVideoTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new ConcatVideosTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new AddAudioTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new AddSubtitlesTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new ResizeVideoTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new CropVideoTool(), readEvents));
  tools.register(new ScopedVideoOutputTool(new SetSpeedTool(), readEvents));

  // 交付闭环：声明预期集合、用真实证据验收候选、只把全项通过的候选发布为最终交付文件。
  tools.register(new DeclareVideoOutputsTool(readEvents));
  tools.register(new ValidateVideoCandidateTool(readEvents));
  tools.register(new PublishVideoOutputTool(readEvents));

  const modelOptions = {
    apiKey: options.deepSeekApiKey,
    ...(options.deepSeekBaseUrl === undefined ? {} : { baseUrl: options.deepSeekBaseUrl }),
    ...(options.deepSeekModel === undefined ? {} : { model: options.deepSeekModel }),
  };

  return {
    model: new DeepSeekModel(modelOptions),
    session,
    tools,
    systemPrompt: new StaticSystemPrompt(AGENT_SYSTEM_PROMPT),
  };
}
