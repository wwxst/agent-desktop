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
  readonly kind: 'analysis' | 'tool';
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

/** Renderer 的可序列化展示状态，不参与 Agent 模型上下文重建。 */
export interface ClientStateSnapshot {
  readonly conversations: readonly ClientConversation[];
  readonly activeSessionId: string;
}

export type RuntimeSecretSource = 'saved' | 'environment';

export interface RuntimeSecretStatus {
  readonly configured: boolean;
  readonly source?: RuntimeSecretSource;
}

/** Renderer 只接收脱敏状态和非敏感配置，不接收 API Key。 */
export interface RuntimeSettings {
  readonly deepSeek: {
    readonly apiKey: RuntimeSecretStatus;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly vision: {
    readonly apiKey: RuntimeSecretStatus;
    readonly baseUrl: string;
  };
  readonly whisper: {
    readonly modelPath: string;
    readonly cliPath: string;
  };
}

/** undefined 表示不修改，null 表示清除本机保存值并回退到环境变量或 Provider 默认值。 */
export interface RuntimeSettingsUpdate {
  readonly deepSeekApiKey?: string | null;
  readonly deepSeekBaseUrl?: string | null;
  readonly deepSeekModel?: string | null;
  readonly visionApiKey?: string | null;
  readonly visionBaseUrl?: string | null;
  readonly whisperModelPath?: string | null;
  readonly whisperCliPath?: string | null;
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
}

/**
 * 宿主在执行本地操作前请求用户批准的一项确切操作。
 * `kind` 说明这是什么操作（界面据此提问），路径操作携带宿主已经解析过的真实路径；
 * 命令操作携带解释器、完整命令、执行起点和生效超时。
 * 界面只展示它并提交允许或拒绝，没有修改待执行操作的入口。
 */
export type ApprovalRequest = { readonly requestId: string } & (
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
  | AgentWorkspaceEvent;

export interface AgentClientApi {
  loadRuntimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettings>;
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
  newSession(): Promise<string>;
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
  /** 在系统文件管理器中定位一个真实文件；宿主负责校验该文件属于当前会话。 */
  revealFile(path: string): Promise<void>;
}
