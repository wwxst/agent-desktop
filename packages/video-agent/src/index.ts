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
import { StaticSystemPrompt } from '@agent-desktop/system-prompt';
import { InMemoryToolRegistry, type Tool } from '@agent-desktop/tools';
import {
  DeclareVideoOutputsTool,
  PublishVideoOutputTool,
  ScopedVideoOutputTool,
  ValidateVideoCandidateTool,
  VIDEO_WRITE_TOOL_NAMES,
} from './delivery-tools.js';
import { AGENT_SYSTEM_PROMPT } from './system-prompt.js';
import { AskUserTool, type AskUserPort } from './ask-user.js';
import { DelegateTasksTool, type DelegateTasksPort } from './delegate-tasks.js';
import { TerminalTool, type TerminalPort } from './terminal-tools.js';
import { CheckVideoSemanticsTool } from './semantic-check.js';
export type { TerminalPort } from './terminal-tools.js';
export type { DelegateTasksPort, ReadOnlyTask, SubagentResult } from './delegate-tasks.js';
export type { AskUserPort, UserQuestion, UserAnswer } from './ask-user.js';
export { producedVideoItem, isInsideDirectory, resolveThroughExistingParent, VIDEO_WRITE_TOOL_NAMES } from './delivery-tools.js';

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
  readonly modelProtocol?: 'chat-completions' | 'responses';
  readonly modelMaxOutputTokens?: number;
  readonly useDeepSeekThinking?: boolean;
  /** 入口提供已配置、已授权的视觉工具；公开调用与语义验收复用同一实例。 */
  readonly visionTool?: Tool;
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
  readonly askUser?: AskUserPort;
  readonly delegateTasks?: DelegateTasksPort;
  readonly terminal?: TerminalPort;
  /** 专业媒体工具由入口显式提供；缺失时不回退到本机 FFmpeg。 */
  readonly mediaTools?: readonly Tool[];
}

/** 组装当前正式能力；不读取环境、不创建 CLI 或桌面层状态。 */
export function createVideoAgent(options: VideoAgentOptions): Agent {
  // Session 先于工具创建：交付工具与写出边界都要从同一份会话事实里读取声明、候选和验收。
  const session = options.session ?? new InMemorySession();
  const readEvents = () => session.events();
  const tools = new InMemoryToolRegistry();
  if (options.askUser !== undefined) tools.register(new AskUserTool(options.askUser));
  if (options.delegateTasks !== undefined) tools.register(new DelegateTasksTool(options.delegateTasks, session));
  if (options.terminal !== undefined) {
    for (const name of ['open_terminal', 'read_terminal', 'write_terminal', 'close_terminal'] as const) tools.register(new TerminalTool(name, options.terminal));
  }
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
  const mediaTools = options.mediaTools ?? [];
  for (const tool of mediaTools) tools.register(VIDEO_WRITE_TOOL_NAMES.has(tool.name) ? new ScopedVideoOutputTool(tool, readEvents) : tool);
  if (options.visionTool !== undefined) tools.register(options.visionTool);
  // 交付闭环：声明预期集合、用真实证据验收候选、只把全项通过的候选发布为最终交付文件。
  tools.register(new DeclareVideoOutputsTool(readEvents));
  tools.register(new ValidateVideoCandidateTool(readEvents));
  tools.register(new PublishVideoOutputTool(readEvents));
  tools.register(new CheckVideoSemanticsTool(readEvents, {
    model: new DeepSeekModel(modelOptionsFor(options)),
    mediaTools,
    ...(options.visionTool === undefined ? {} : { vision: options.visionTool }),
  }));

  const modelOptions = modelOptionsFor(options);

  return {
    model: new DeepSeekModel(modelOptions),
    session,
    tools,
    systemPrompt: new StaticSystemPrompt(AGENT_SYSTEM_PROMPT),
  };
}

/** 父模型与独立验收模型使用相同运行配置，模型会话彼此隔离。 */
function modelOptionsFor(options: VideoAgentOptions) {
  return { apiKey: options.deepSeekApiKey,
    ...(options.deepSeekBaseUrl === undefined ? {} : { baseUrl: options.deepSeekBaseUrl }),
    ...(options.deepSeekModel === undefined ? {} : { model: options.deepSeekModel }),
    ...(options.modelProtocol === undefined ? {} : { protocol: options.modelProtocol }),
    ...(options.modelMaxOutputTokens === undefined ? {} : { maxOutputTokens: options.modelMaxOutputTokens }),
    ...(options.useDeepSeekThinking === undefined ? {} : { disableThinking: options.useDeepSeekThinking }) };
}
