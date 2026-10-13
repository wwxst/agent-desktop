/**
 * 用户为一次任务提供的输入附件。
 * path 是身份与模型实际使用的路径，name 只用于界面展示；role 说明它在任务里的用途，
 * 决定提示词把它当作主视频还是外加音轨，界面不据此决定工具调用顺序。
 */
export interface Attachment {
  readonly path: string;
  readonly name: string;
  readonly role: AttachmentRole;
}

/** 当前真实支持的任务输入角色；新增角色必须有对应的已注册工具消费者。 */
export type AttachmentRole = 'video' | 'audio';

/**
 * 一轮任务真实生成的持久产物。
 * path 是身份（同名文件可以存在于不同目录），fileName 只用于展示。
 */
export interface AgentTaskOutputFile {
  readonly path: string;
  readonly fileName: string;
}

/**
 * 一个视频输出项的逐项交付结果。
 *
 * 它由应用层的读取投影计算：已交付项带真实路径，未交付项带真实原因（失败、受阻或未完成）。
 * 界面只展示这些事实，不自行判断某项是否合格。
 */
export type AgentTaskOutputItemResult =
  | {
    readonly outputItemId: string;
    readonly status: 'published';
    /** 实际发布成功的绝对路径；这是最终路径的权威事实。 */
    readonly path: string;
    readonly fileName: string;
  }
  | {
    readonly outputItemId: string;
    readonly status: 'failed' | 'blocked' | 'incomplete';
    readonly reason: string;
  };

export interface AgentTaskResult {
  readonly responseText: string;
  readonly traceId: string;
  /** 首轮由宿主模型概括任务；命名失败独立说明，不改变已完成任务的结果。 */
  readonly conversationTitle?: string;
  readonly conversationTitleError?: string;
  /** 本轮真实成功生成的持久产物；没有产物时省略。 */
  readonly outputFiles?: readonly AgentTaskOutputFile[];
  /**
   * 本轮按声明集合产生的逐项交付结果；没有声明过视频输出项时省略。
   * 它与产物卡是同一批事实的两种视图：产物卡负责定位文件，逐项结果负责展示缺口。
   */
  readonly outputs?: readonly AgentTaskOutputItemResult[];
}

export type AgentActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 活动轨迹里的真实文件引用。
 * label 只用于展示（通常是文件名），path 是宿主提供的真实路径，用于定位文件。
 */
export interface AgentActivityFile {
  readonly path: string;
  readonly label: string;
  readonly role: 'input' | 'output';
}

export interface AgentActivityDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory';
}

export interface AgentActivitySearchMatch {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly line: string;
}

/**
 * 工具行可展开的真实结果摘要。
 * 这里只承载当前本地工具已经返回且有直接界面消费者的有界数据，不复制任意 Tool 输出。
 */
export type AgentActivityDetail =
  | { readonly kind: 'subagents'; readonly tasks: readonly { readonly taskId: string; readonly title: string; readonly status: string; readonly summary: string }[] }
  | { readonly kind: 'interaction'; readonly question: string; readonly answer: string }
  | {
    readonly kind: 'file-content';
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly totalLines: number;
    readonly lines: readonly string[];
    readonly note?: string;
  }
  | {
    readonly kind: 'directory';
    readonly directory: string;
    readonly total: number;
    readonly entries: readonly AgentActivityDirectoryEntry[];
    readonly note?: string;
  }
  | {
    readonly kind: 'search';
    readonly directory: string;
    readonly pattern: string;
    readonly total: number;
    readonly matches: readonly AgentActivitySearchMatch[];
    readonly note?: string;
  }
  | { readonly kind: 'error'; readonly message: string }
  | {
    /**
     * 命令执行期间的实时输出投影。
     * 宿主按小批次推送它，因此它只表示当前已经收到的有界输出，不是命令终态。
     */
    readonly kind: 'command-output';
    readonly command: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly droppedBytes: number;
  }
  | {
    /** 命令的真实终态：成功与失败都保留退出码和有界输出，失败另外给出原因。 */
    readonly kind: 'command';
    readonly command: string;
    readonly workingDirectory: string;
    readonly exitCode: number | null;
    readonly termination: 'exited' | 'timed-out';
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly droppedBytes: number;
    readonly note?: string;
  };

/**
 * 一条真实执行活动：模型工作（analysis）或一次工具调用（tool）。
 * 字段只承载宿主已知的事实，动作文案由界面根据 kind、toolName 和状态组合。
 */
export interface AgentActivityItem {
  readonly id: string;
  readonly kind: 'analysis' | 'tool' | 'commentary';
  readonly text?: string;
  readonly retryNote?: string;
  readonly status: AgentActivityStatus;
  readonly toolName?: string;
  readonly files?: readonly AgentActivityFile[];
  readonly durationMs?: number;
  /** analysis 完成后真实产生的工具调用数量；0 表示该步直接生成回复。 */
  readonly plannedToolCallCount?: number;
  /** 工具完成后由宿主从真实 Tool Result 投影出的有界展示详情。 */
  readonly detail?: AgentActivityDetail;
}

export interface ClientUserMessage {
  readonly id: number;
  readonly role: 'user';
  readonly text: string;
  /** 该轮实际使用的输入附件名称；保留角色以便历史里能看出音轨与主视频的区别。 */
  readonly attachments: readonly string[];
  readonly attachmentRoles?: readonly AttachmentRole[];
}

export interface ClientAssistantMessageBase {
  readonly id: number;
  readonly role: 'assistant';
  readonly activity: readonly AgentActivityItem[];
  readonly activityExpanded: boolean;
}

/**
 * streamedText（实时文本）只存在于 processing 分支，完成、取消、失败三个分支没有该字段，
 * 终态转换会一并丢弃它。App 在 processing 期间不保存快照，Main 的持久化解析也不接受 processing 状态，
 * 因此临时流式文本不会被写入磁盘。
 *
 * 取消与失败分支可以带 outputFiles：整轮失败不代表之前已成功的工具没有产出，
 * 这些文件是真实存在的事实，必须继续可见可定位。没有产物时省略该字段。
 */
export type ClientAssistantMessage = ClientAssistantMessageBase & (
  | { readonly status: 'processing'; readonly streamedText: string }
  | { readonly status: 'completed'; readonly result: AgentTaskResult }
  | {
    readonly status: 'cancelled';
    readonly outputFiles?: readonly AgentTaskOutputFile[];
    readonly outputs?: readonly AgentTaskOutputItemResult[];
  }
  | {
    readonly status: 'failed';
    readonly errorMessage: string;
    readonly outputFiles?: readonly AgentTaskOutputFile[];
    readonly outputs?: readonly AgentTaskOutputItemResult[];
  }
);

export type ClientConversationMessage = ClientUserMessage | ClientAssistantMessage;

export interface ClientConversation {
  /** 侧栏组织信息不参与模型上下文，也不授予目录访问权限。 */
  readonly projectId?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly updatedAt?: number;
  readonly terminalHistory?: TerminalSnapshot;
  readonly id: string;
  readonly title: string;
  /** 手动重命名后锁定自动标题；旧快照缺失时由 Host 解析为 false。 */
  readonly titleManuallyRenamed: boolean;
  readonly messages: readonly ClientConversationMessage[];
  readonly prompt: string;
  readonly attachments: readonly Attachment[];
  /**
   * 当前会话工作目录的展示副本。
   * 权威事实由宿主会话持有；重启恢复时按会话事实重建，界面不自己推导目录。
   */
  readonly workingDirectory?: string;
}

/** 终端历史只承载可展示事实，不包含 PID 或可重连句柄。 */
export interface TerminalSnapshot {
  readonly terminalId: string; readonly workingDirectory: string; readonly command: string;
  readonly output: string; readonly status: 'running' | 'exited' | 'disconnected'; readonly exitCode: number | null;
  readonly droppedBytes: number;
}

/** Renderer 的可序列化展示状态，不参与 Agent 模型上下文重建。 */
export interface ClientStateSnapshot {
  readonly conversations: readonly ClientConversation[];
  /** 尚未发送的输入独立保存，不作为历史聊天出现在侧栏。 */
  readonly drafts?: readonly ClientConversation[];
  readonly activeSessionId: string;
  readonly sidebar?: ClientSidebarState;
}

/** 一个本地项目对应一个用户选择的目录；名称和折叠只影响导航。 */
export interface ClientProject {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly pinned: boolean;
  readonly collapsed: boolean;
}

export interface ClientSidebarState {
  readonly projects: readonly ClientProject[];
  readonly projectsCollapsed: boolean;
  readonly recentCollapsed: boolean;
  readonly grouped: boolean;
}

export type RuntimeSecretSource = 'saved' | 'environment';

export interface RuntimeSecretStatus {
  readonly configured: boolean;
  readonly source?: RuntimeSecretSource;
}

export type ModelApiProtocol = 'chat-completions' | 'responses';
export type ModelCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
/** 只保存当前有消费者的能力；生成图片、编辑图片、视频和音频能力以后各自增加，不复用视觉字段。 */
export interface RuntimeModelCapabilities {
  readonly textInput: ModelCapabilityStatus;
  readonly textOutput: ModelCapabilityStatus;
  readonly imageInput: ModelCapabilityStatus;
  readonly imageUnderstanding: ModelCapabilityStatus;
}
export interface RuntimeModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: RuntimeModelCapabilities;
}
export interface RuntimeModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly builtin: boolean;
  readonly baseUrl: string;
  readonly protocol: ModelApiProtocol;
  readonly apiKey: RuntimeSecretStatus;
  readonly models: readonly RuntimeModelDefinition[];
}
export interface RuntimeModelReference { readonly providerId: string; readonly modelId: string }
export interface RuntimeModelProviderUpdate {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly protocol: ModelApiProtocol;
  readonly models: readonly RuntimeModelDefinition[];
  /** 省略密钥表示沿用；null 清除本机密钥。 */
  readonly apiKey?: string | null;
}

/** Renderer 只接收脱敏状态和非敏感配置，不接收 API Key。 */
export interface RuntimeSettings {
  /** 未保存外观偏好时跟随系统；与模型配置共用本机设置存储。 */
  readonly theme?: 'system' | 'light' | 'dark';
  readonly modelProviders: readonly RuntimeModelProvider[];
  readonly conversationModel: RuntimeModelReference;
  readonly fallbackVisionModel: RuntimeModelReference | null;
  readonly fallbackVisionEnabled: boolean;
  readonly whisper: {
    readonly modelPath: string;
    readonly cliPath: string;
  };
  readonly memoryEnabled: boolean;
  readonly memoryFromToolChatsEnabled: boolean;
}

/** undefined 表示不修改，null 表示清除本机保存值并回退到环境变量或 Provider 默认值。 */
export interface RuntimeSettingsUpdate {
  readonly theme?: 'system' | 'light' | 'dark' | null;
  readonly modelProvider?: RuntimeModelProviderUpdate;
  readonly deleteModelProviderId?: string;
  readonly conversationModel?: RuntimeModelReference;
  readonly fallbackVisionModel?: RuntimeModelReference | null;
  readonly fallbackVisionEnabled?: boolean;
  readonly whisperModelPath?: string | null;
  readonly whisperCliPath?: string | null;
  readonly memoryEnabled?: boolean;
  readonly memoryFromToolChatsEnabled?: boolean;
}

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: 'conversation' | 'tool';
}

export interface CustomInstructions {
  readonly path: string;
  readonly content: string;
}

/** 宿主在 Turn 执行期间推送的一条活动：开始、完成、失败或取消都使用同一个活动 id 覆盖。 */
export interface AgentActivityEvent {
  readonly type: 'activity';
  readonly item: AgentActivityItem;
}

/** Tool Result 写入 Session 后，为对应活动补充真实结果详情。 */
export interface AgentActivityDetailEvent {
  readonly type: 'activity.detail';
  readonly activityId: string;
  readonly detail: AgentActivityDetail;
}

/** Host 在 Turn 执行期间推送的 assistant 文本增量，只用于实时展示。 */
export interface AgentTextDeltaEvent {
  readonly type: 'text.delta';
  readonly delta: string;
  readonly stepId?: string;
}

export interface QuestionRequest {
  readonly requestId: string; readonly sessionId: string; readonly turnId: string;
  readonly question: string; readonly options?: readonly string[];
}
export type QuestionAnswer = { readonly outcome: 'answered'; readonly answer: string } | { readonly outcome: 'skipped' };

/**
 * 宿主在执行本地操作前请求用户批准的一项确切操作。
 * `kind` 说明这是什么操作（界面据此提问），路径操作携带宿主已经解析过的真实路径；
 * 命令操作携带解释器、完整命令、执行起点和生效超时。
 * 界面只展示它并提交允许或拒绝，没有修改待执行操作的入口。
 */
export type ApprovalRequest = { readonly requestId: string } & (
  | { readonly kind: 'plugin-start'; readonly pluginName: string; readonly serverName: string; readonly command: string; readonly workingDirectory: string }
  | { readonly kind: 'plugin-tool'; readonly pluginName: string; readonly serverName: string; readonly toolName: string; readonly arguments: string }
  | { readonly kind: 'terminal-start'; readonly interpreter: string; readonly command: string; readonly workingDirectory: string }
  | { readonly kind: 'terminal-input'; readonly interpreter: string; readonly command: string; readonly workingDirectory: string }
  | { readonly kind: 'directory' | 'create-file'; readonly target: string }
  | { readonly kind: 'edit-file'; readonly target: string; readonly before: string; readonly after: string }
  | {
    readonly kind: 'command';
    /** 宿主解析并固定的命令解释器绝对路径。 */
    readonly interpreter: string;
    /** 将被执行的完整命令原文。 */
    readonly command: string;
    /** 执行起点目录；它只是起点，不是操作系统沙箱。 */
    readonly workingDirectory: string;
    /** 本次命令生效的超时毫秒数。 */
    readonly timeoutMs: number;
  }
);

/** Host 在工具等待审批时推送的待决请求；一个 Turn 最多只有一个。 */
export interface AgentApprovalRequestEvent {
  readonly type: 'approval.requested';
  readonly request: ApprovalRequest;
}

/**
 * Host 真正确认了会话工作目录之后发布的事实。
 *
 * 界面据此更新展示副本，而不是在提交审批决定时提前写入：审批可能已经失效（轮次取消或窗口关闭），
 * 那时 `confirmDirectory` 并没有执行，提前写入会在界面上留下一个并不存在的工作目录。
 */
export interface AgentWorkspaceEvent {
  readonly type: 'workspace.confirmed';
  readonly workingDirectory: string;
}

/** Host 在 Turn 执行期间推送给 Client 的运行期事件：活动轨迹、实时文本增量、待决审批或已确认的工作目录。 */
export type AgentRuntimeEvent =
  | AgentActivityEvent
  | AgentActivityDetailEvent
  | AgentTextDeltaEvent
  | AgentApprovalRequestEvent
  | AgentWorkspaceEvent
  | { readonly type: 'question.requested'; readonly request: QuestionRequest }
  | { readonly type: 'question.closed'; readonly requestId: string }
  | { readonly type: 'model.text'; readonly stepId: string; readonly text: string; readonly purpose: 'commentary' | 'final' }
  | { readonly type: 'terminal.updated'; readonly sessionId: string; readonly terminal: TerminalSnapshot };

/** 插件与技能的展示事实；实际文件、启停和工具注册由宿主维护。 */
export interface ExtensionItem {
  readonly id: string;
  readonly kind: 'plugin' | 'skill';
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'local' | 'project' | 'plugin' | 'marketplace';
  readonly displayName?: string;
  readonly defaultPrompt?: string;
  readonly allowImplicitInvocation?: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly version?: string;
  readonly path?: string;
  readonly pluginId?: string;
  readonly skillNames?: readonly string[];
  readonly serverNames?: readonly string[];
  /** Codex catalog uses an authority and source kind so the id is not a path. */
  readonly authority?: { readonly kind: string; readonly id: string };
  readonly sourceKind?: string;
  readonly shortDescription?: string;
  readonly keywords?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly hasApps?: boolean;
  readonly hasHooks?: boolean;
  readonly extensionNames?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly logo?: string;
  readonly logoDark?: string;
  readonly composerIcon?: string;
  readonly brandColor?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly category?: string;
  readonly websiteUrl?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
  readonly screenshots?: readonly string[];
  readonly defaultPrompts?: readonly string[];
  readonly marketplaceId?: string;
  readonly availableVersion?: string;
  readonly installable?: boolean;
  readonly versions?: readonly { readonly id: string; readonly version: string; readonly createdAt: string }[];
  readonly connections?: readonly { readonly name: string; readonly transport: string; readonly connected: boolean; readonly url?: string; readonly variables?: readonly string[] }[];
}
export interface ExtensionMarketplace { readonly id: string; readonly name: string; readonly source: string; readonly revision?: string }
/** 独立 MCP 的公开配置不包含环境变量和请求头的值。 */
export interface McpServerSettings {
  readonly id: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly enabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly url: string;
  readonly environmentNames: readonly string[];
  readonly headerNames: readonly string[];
  readonly connected: boolean;
}
export interface McpServerUpdate {
  readonly id?: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command: string;
  readonly args: readonly string[];
  readonly url: string;
  /** 编辑时空值保留同名已保存秘密；移除键则删除该配置。 */
  readonly environment: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}
export type ExtensionManagementRequest =
  | { readonly action: 'save-mcp-server'; readonly server: McpServerUpdate }
  | { readonly action: 'set-mcp-enabled'; readonly id: string; readonly enabled: boolean }
  | { readonly action: 'remove-mcp-server'; readonly id: string }
  | { readonly action: 'open-skill' | 'reveal-skill' | 'copy-skill'; readonly id: string }
  | { readonly action: 'add-marketplace'; readonly source: string }
  | { readonly action: 'remove-marketplace'; readonly id: string }
  | { readonly action: 'update'; readonly id: string }
  | { readonly action: 'rollback'; readonly id: string; readonly versionId: string }
  | { readonly action: 'configure'; readonly id: string; readonly server: string; readonly values: Readonly<Record<string, string>> }
  | { readonly action: 'connect' | 'disconnect' | 'cancel-connect'; readonly id: string; readonly server: string };
export interface ExtensionSnapshot {
  readonly plugins: readonly ExtensionItem[];
  readonly skills: readonly ExtensionItem[];
  readonly marketplaces?: readonly ExtensionMarketplace[];
  readonly mcpServers?: readonly McpServerSettings[];
  readonly errors?: readonly string[];
}
export interface ExtensionClientApi {
  list(): Promise<ExtensionSnapshot>;
  /** Codex `skills/list`：只返回技能元数据，正文仍按需读取。 */
  listSkills(forceReload?: boolean): Promise<readonly ExtensionItem[]>;
  /** 打开本地目录选择器；取消不改变现有安装。 */
  importLocal(kind: 'plugin' | 'skill'): Promise<ExtensionSnapshot | null>;
  install(id: string): Promise<ExtensionSnapshot>;
  setEnabled(id: string, enabled: boolean): Promise<ExtensionSnapshot>;
  uninstall(id: string): Promise<ExtensionSnapshot>;
  readDetail(id: string): Promise<string>;
  /** 本项目独立读取单个技能正文的宿主接口；不是 Codex app-server 协议方法。 */
  readSkill(id: string): Promise<string>;
  /** 同步本机内置资源；与 Codex 的远程 plugin/reconcile 职责不同。 */
  reconcile(): Promise<ExtensionSnapshot>;
  /** 对照 Codex `skills/changed` 的失效通知。 */
  onChanged(listener: () => void): () => void;
  manage(request: ExtensionManagementRequest): Promise<ExtensionSnapshot>;
}

/** 更新事实由桌面宿主提供；浏览器开发宿主不具有安装应用的能力。 */
export type AppUpdateState =
  | { readonly status: 'idle' | 'checking' }
  | { readonly status: 'downloading'; readonly percent: number }
  | { readonly status: 'ready' | 'installing' }
  | { readonly status: 'error'; readonly message: string };

export interface AppUpdateApi {
  getState(): Promise<AppUpdateState>;
  onStateChanged(listener: (state: AppUpdateState) => void): () => void;
  install(): Promise<void>;
  retry(): Promise<void>;
}

export interface AgentClientApi {
  readonly appUpdates?: AppUpdateApi;
  readonly extensions: ExtensionClientApi;
  loadRuntimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettings>;
  loadMemories(): Promise<readonly MemoryEntry[]>;
  deleteMemories(): Promise<void>;
  loadCustomInstructions(): Promise<CustomInstructions>;
  saveCustomInstructions(content: string): Promise<CustomInstructions>;
  listProviderModels(provider: Pick<RuntimeModelProviderUpdate, 'id' | 'baseUrl' | 'protocol' | 'apiKey'>): Promise<readonly RuntimeModelDefinition[]>;
  openModelConfig(): Promise<void>;
  loadClientState(): Promise<ClientStateSnapshot | null>;
  saveClientState(state: ClientStateSnapshot): Promise<void>;
  /**
   * 宿主在关闭窗口前请求客户端提交当前展示状态，用于补上防抖保存尚未落盘的最后一次改动。
   * 宿主等待 listener 完成后才继续关闭；listener 抛出时宿主把失败展示给用户并保留窗口。
   */
  onPrepareClose(listener: () => Promise<void>): () => void;
  getActiveSessionId(): Promise<string>;
  /** 打开系统文件对话框选择输入附件；返回该会话当前的完整附件列表，取消时返回 null。 */
  selectAttachmentFiles(): Promise<readonly Attachment[] | null>;
  removeAttachment(index: number): Promise<void>;
  /** 用户主动在项目中创建新会话时，宿主确认该目录为新会话工作目录。 */
  newSession(directory?: string): Promise<string>;
  selectProjectDirectory(): Promise<string | null>;
  openProjectDirectory(directory: string): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<string>;
  runAgentTask(prompt: string): Promise<AgentTaskResult>;
  cancelTask(): Promise<void>;
  onAgentEvent(listener: (event: AgentRuntimeEvent) => void): () => void;
  /**
   * 对当前待决操作提交允许或拒绝。
   * 宿主只接受当前请求的标识：客户端不能用一次迟到的批准重新启动已经失效的操作。
   */
  decideApproval(requestId: string, approved: boolean): Promise<void>;
  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  /** 在系统文件管理器中定位一个真实文件；宿主负责校验该文件属于当前会话。 */
  revealFile(path: string): Promise<void>;
}
