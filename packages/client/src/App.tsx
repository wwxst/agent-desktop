import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  AgentActivityItem,
  AgentClientApi,
  AgentRuntimeEvent,
  AgentTaskOutputFile,
  AgentTaskOutputItemResult,
  ApprovalRequest,
  ClientAssistantMessage,
  ClientAssistantMessageBase,
  ClientConversation,
  ClientConversationMessage,
  ClientStateSnapshot,
  ClientProject,
  ClientSidebarState,
  QuestionRequest,
} from './api.js';
import { ApprovalRequest as ApprovalRequestCard } from './components/ApprovalRequest.js';
import { Composer } from './components/Composer.js';
import { ConversationPanel } from './components/ConversationPanel.js';
import { RuntimeSettingsPanel } from './components/RuntimeSettingsPanel.js';
import { ExtensionsPage } from './components/ExtensionsPage.js';
import { SessionSidebar } from './components/SessionSidebar.js';
import { UserQuestion } from './components/UserQuestion.js';
import { X } from 'lucide-react';
import { TerminalView } from './components/TerminalView.js';

const INITIAL_RENDERER_SESSION_ID = 'initializing-session';
const INITIAL_SIDEBAR: ClientSidebarState = { projects: [], projectsCollapsed: false, recentCollapsed: false, grouped: true };

function createConversation(id: string): ClientConversation {
  return {
    id,
    title: '新聊天',
    titleManuallyRenamed: false,
    messages: [],
    prompt: '',
    attachments: [],
    updatedAt: Date.now(),
  };
}

/**
 * 把 Assistant 消息投影回不含临时字段的基础结构。
 * 完成、取消和失败分支在类型上都没有 streamedText，这里负责在状态切换时丢弃它。
 */
function dropStreamedText(message: ClientAssistantMessage): ClientAssistantMessageBase {
  return {
    id: message.id,
    role: message.role,
    activity: message.activity,
    activityExpanded: message.activityExpanded,
    ...(message.taskState === undefined ? {} : { taskState: message.taskState }),
  };
}

/** 同一个活动 id 只保留一条记录：开始、完成、失败和取消都用新状态覆盖旧状态。 */
function upsertActivity(
  activity: readonly AgentActivityItem[],
  nextItem: AgentActivityItem,
): readonly AgentActivityItem[] {
  const existingIndex = activity.findIndex((item) => item.id === nextItem.id);
  return existingIndex === -1
    ? [...activity, nextItem]
    : activity.map((item, index) => (index === existingIndex ? nextItem : item));
}

interface AppProps {
  readonly api: AgentClientApi;
}

/** App 只持有会话状态、运行状态和宿主调用；界面由侧栏、对话工作区和输入区三个组件承担。 */
export function App({ api }: AppProps) {
  const [conversations, setConversations] = useState<readonly ClientConversation[]>([]);
  const [drafts, setDrafts] = useState<readonly ClientConversation[]>([createConversation(INITIAL_RENDERER_SESSION_ID)]);
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_RENDERER_SESSION_ID);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sidebar, setSidebar] = useState<ClientSidebarState>(INITIAL_SIDEBAR);
  // 侧栏与设置归档列表共用同一份删除确认，不改变宿主删除接口。
  const [deleteTarget, setDeleteTarget] = useState<ClientConversation | undefined>(undefined);
  const [deleteError, setDeleteError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteCancelButton = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLElement | null>(null);
  // 宿主当前待决的操作审批；一个 Turn 最多只有一个，轮次结束即失效。
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | undefined>(undefined);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | undefined>(undefined);
  const streamedStepId = useRef<string | undefined>(undefined);
  const [activeView, setActiveView] = useState<'conversation' | 'settings' | 'plugins' | 'skills'>('conversation');
  const [extensionSelection, setExtensionSelection] = useState<string | undefined>();
  // 宿主关闭请求序号：即使展示状态没有变化，每次请求也重新触发一次关闭前提交。
  const [closeRequestSequence, setCloseRequestSequence] = useState(0);
  const pendingClose = useRef<((error?: Error) => void) | undefined>(undefined);
  // 常规防抖保存与关闭前强制保存共用一条队列，避免两个 IPC 同时写同一个临时文件。
  const pendingStateSave = useRef<Promise<void>>(Promise.resolve());
  const activeSessionIdRef = useRef(INITIAL_RENDERER_SESSION_ID);
  const nextMessageId = useRef(1);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  // 用户是否仍停留在最新内容处：只有跟随状态才让新内容自动滚动，向上阅读时保留当前位置。
  const followsLatest = useRef(true);

  const activeConversation = [...conversations, ...drafts].find(conversation => conversation.id === activeSessionId)!;

  const queueClientStateSave = (snapshot: ClientStateSnapshot): Promise<void> => {
    const save = pendingStateSave.current.then(() => api.saveClientState(snapshot));
    // 队列本身吸收上一项失败，让关闭时仍能用最新快照重试；调用方仍拿到本次原始结果。
    pendingStateSave.current = save.catch(() => undefined);
    return save;
  };

  const updateConversation = (
    sessionId: string,
    update: (conversation: ClientConversation) => ClientConversation,
  ) => {
    setConversations((currentConversations) => currentConversations.map((conversation) => (
      conversation.id === sessionId ? update(conversation) : conversation
    )));
    setDrafts(current => current.map(conversation => conversation.id === sessionId ? update(conversation) : conversation));
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      // 同时发起宿主活动会话查询，避免加载持久化快照时重新引入初始 Session ID 竞态。
      const activeSessionPromise = api.getActiveSessionId();
      const savedState = await api.loadClientState();
      if (!mounted || activeSessionIdRef.current !== INITIAL_RENDERER_SESSION_ID) return;

      if (savedState !== null) {
        const messageIds = savedState.conversations.flatMap((conversation) => (
          conversation.messages.map((message) => message.id)
        ));
        activeSessionIdRef.current = savedState.activeSessionId;
        nextMessageId.current = Math.max(0, ...messageIds) + 1;
        setConversations(savedState.conversations);
        setDrafts(savedState.drafts ?? []);
        setSidebar(savedState.sidebar ?? INITIAL_SIDEBAR);
        setActiveSessionId(savedState.activeSessionId);
        setIsSessionReady(true);
        return;
      }

      const sessionId = await activeSessionPromise;
      if (!mounted || activeSessionIdRef.current !== INITIAL_RENDERER_SESSION_ID) return;
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      updateConversation(INITIAL_RENDERER_SESSION_ID, conversation => ({ ...conversation, id: sessionId }));
      setIsSessionReady(true);
    })();
    return () => { mounted = false; };
  }, [api]);

  useEffect(() => {
    if (!isSessionReady || isProcessing) return;
    // 关闭收尾正在提交同一份状态：取消尚未触发的防抖保存，避免关闭过程中重复写入。
    if (pendingClose.current !== undefined) return;
    const snapshot: ClientStateSnapshot = { conversations, drafts, activeSessionId, sidebar };
    const timeout = setTimeout(() => {
      void queueClientStateSave(snapshot);
    }, 150);
    return () => clearTimeout(timeout);
  }, [activeSessionId, api, closeRequestSequence, conversations, drafts, sidebar, isProcessing, isSessionReady]);

  useEffect(() => api.onPrepareClose(() => new Promise<void>((resolve, reject) => {
    pendingClose.current = (error) => { if (error === undefined) resolve(); else reject(error); };
    setCloseRequestSequence((sequence) => sequence + 1);
  })), [api]);

  // 关闭前提交：等本轮渲染把终态写入状态后再落盘，结果回告宿主，由宿主决定是否继续关闭。
  useEffect(() => {
    if (closeRequestSequence === 0) return;
    const settle = pendingClose.current;
    if (settle === undefined) return;
    // 初始状态还没加载完成时没有可提交的展示状态，放行关闭，避免用占位会话覆盖磁盘历史。
    if (!isSessionReady) {
      pendingClose.current = undefined;
      settle();
      return;
    }
    if (isProcessing) return;
    pendingClose.current = undefined;
    void (async () => {
      try {
        await queueClientStateSave({ conversations, drafts, activeSessionId, sidebar });
        settle();
      } catch (error) {
        settle(error instanceof Error ? error : new Error('无法保存本地会话。'));
      }
    })();
  }, [activeSessionId, api, closeRequestSequence, conversations, drafts, sidebar, isProcessing, isSessionReady]);

  useEffect(() => api.onAgentEvent((event: AgentRuntimeEvent) => {
    const sessionId = activeSessionIdRef.current;
    if (event.type === 'terminal.updated') {
      updateConversation(event.sessionId, (conversation) => ({ ...conversation, terminalHistory: event.terminal }));
      return;
    }
    if (event.type === 'task.state') {
      // 任务投影按宿主会话归属进入当前回复，完成资格完全由 Session 的权威投影提供。
      updateConversation(event.sessionId, conversation => {
        const activeIndex = conversation.messages.findLastIndex(message => message.role === 'assistant' && message.status === 'processing');
        return { ...conversation, messages: conversation.messages.map((message, index) => index === activeIndex
          ? { ...message, taskState: event.taskState } : message) };
      });
      return;
    }
    if (event.type === 'question.requested') {
      if (event.request.sessionId === sessionId) setPendingQuestion(event.request);
      return;
    }
    if (event.type === 'question.closed') {
      setPendingQuestion((current) => current?.requestId === event.requestId ? undefined : current);
      return;
    }
    // 审批请求不是某一轮的消息内容：它由 App 单独持有并交给 Composer 渲染。
    if (event.type === 'approval.requested') {
      setPendingApproval(event.request);
      return;
    }

    // 工作目录事实由宿主在真正确认之后发布。界面**不**在提交审批决定时提前写入：
    // 审批可能已经失效（轮次取消或窗口关闭），那时目录并没有被确认。
    if (event.type === 'workspace.confirmed') {
      updateConversation(sessionId, (conversation) => ({
        ...conversation,
        workingDirectory: event.workingDirectory,
      }));
      return;
    }

    // 会话切换在执行期间禁用，因此运行期事件只会进入发起当前 Turn 的会话。
    updateConversation(sessionId, (conversation) => {
      const activeIndex = conversation.messages.findLastIndex(
        (message) => message.role === 'assistant' && message.status === 'processing',
      );
      const activeMessage = conversation.messages[activeIndex];
      if (activeMessage?.role !== 'assistant' || activeMessage.status !== 'processing') {
        return conversation;
      }

      // 文本增量只更新当前正在处理的 Assistant 消息，完成时由完整回复覆盖。
      if (event.type === 'text.delta') {
        const preceding = event.stepId === undefined || event.stepId === streamedStepId.current ? activeMessage.streamedText : '';
        streamedStepId.current = event.stepId;
        const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
          index === activeIndex
            ? { ...activeMessage, streamedText: preceding + event.delta }
            : message
        ));
        return { ...conversation, messages };
      }

      if (event.type === 'model.text') {
        const activity = event.purpose === 'commentary' && event.text.trim()
          ? upsertActivity(activeMessage.activity, { id: `commentary:${event.stepId}`, kind: 'commentary', status: 'completed', text: event.text })
          : activeMessage.activity;
        return { ...conversation, messages: conversation.messages.map((message, index) => index === activeIndex
          ? { ...activeMessage, activity, streamedText: event.purpose === 'final' ? event.text : '' } : message) };
      }

      if (event.type === 'activity.detail') {
        const activity = activeMessage.activity.map((item) => (
          item.id === event.activityId ? { ...item, detail: event.detail } : item
        ));
        const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
          index === activeIndex ? { ...activeMessage, activity } : message
        ));
        return { ...conversation, messages };
      }

      const activity = upsertActivity(activeMessage.activity, event.item);
      const messages: readonly ClientConversationMessage[] = conversation.messages.map((message, index) => (
        index === activeIndex ? { ...activeMessage, activity } : message
      ));
      return { ...conversation, messages };
    });
  }), [api]);

  /** 距离底部小于一行时仍视为跟随，避免增量滚动造成的微小偏差把跟随状态误判成已离开底部。 */
  const handleHistoryScroll = () => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer === null) return;
    followsLatest.current = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight <= 24;
  };

  // 切换会话或视图后重新回到最新内容：恢复历史时用户期望看到的是这一轮对话的结尾。
  useEffect(() => {
    followsLatest.current = true;
    const scrollContainer = conversationScroll.current;
    if (scrollContainer !== null) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [activeSessionId, activeView]);

  // 新消息、活动更新和实时增量只在用户仍跟随最新内容时滚动；
  // 待决审批位于 Composer，不改变历史阅读轴的滚动位置。
  useEffect(() => {
    const scrollContainer = conversationScroll.current;
    if (scrollContainer === null || !followsLatest.current) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [activeConversation.messages]);

  const selectAttachments = async () => {
    const attachments = await api.selectAttachmentFiles();
    if (attachments) {
      updateConversation(activeSessionIdRef.current, (conversation) => ({
        ...conversation,
        attachments,
      }));
    }
  };

  const removeAttachment = async (index: number) => {
    await api.removeAttachment(index);
    updateConversation(activeSessionIdRef.current, (conversation) => ({
      ...conversation,
      attachments: conversation.attachments.filter((_, currentIndex) => currentIndex !== index),
    }));
  };

  const startNewSession = async (project?: ClientProject) => {
    if (!isSessionReady || isProcessing) return;
    // 普通入口与各项目各自复用待发送草稿，保留输入、附件和原工作目录。
    // 移除项目只清除归属；重新添加原目录后也能找回尚未发送的项目草稿。
    const existing = drafts.find(draft => draft.workingDirectory === project?.directory
      && (draft.projectId === project?.id || (project !== undefined && draft.projectId === undefined)));
    const sessionId = existing?.id ?? (project === undefined ? await api.newSession() : await api.newSession(project.directory));
    if (existing === undefined) {
      const conversation = { ...createConversation(sessionId),
        ...(project === undefined ? {} : { projectId: project.id, workingDirectory: project.directory }),
      };
      setDrafts(current => [...current, conversation]);
    } else {
      if (sessionId !== activeSessionIdRef.current) await api.switchSession(sessionId);
      if (project !== undefined && existing.projectId !== project.id) {
        updateConversation(sessionId, conversation => ({ ...conversation, projectId: project.id }));
      }
    }
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveView('conversation');
    if (project !== undefined) setSidebar(current => ({ ...current, projectsCollapsed: false,
      projects: current.projects.map(item => item.id === project.id ? { ...item, collapsed: false } : item),
    }));
  };

  const addProject = async (): Promise<ClientProject | undefined> => {
    if (!isSessionReady || isProcessing) return;
    const directory = await api.selectProjectDirectory();
    if (directory === null) return;
    // 同一文件夹只登记一次；添加项目本身不修改当前会话工作目录。
    const key = (path: string) => path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    const existing = sidebar.projects.find(project => key(project.directory) === key(directory));
    if (existing !== undefined) return existing;
    const project: ClientProject = {
      id: crypto.randomUUID(),
      name: directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory,
      directory,
      pinned: false,
      collapsed: false,
    };
    setSidebar(current => ({ ...current, projectsCollapsed: false,
      projects: [...current.projects, project],
    }));
    return project;
  };

  const updateProject = (id: string, changes: Partial<Pick<ClientProject, 'name' | 'pinned' | 'collapsed'>>) => {
    setSidebar(current => ({ ...current, projects: current.projects.map(project => project.id === id ? { ...project, ...changes } : project) }));
  };

  const removeProject = (id: string) => {
    if (isProcessing) return;
    setSidebar(current => ({ ...current, projects: current.projects.filter(project => project.id !== id) }));
    setConversations(current => current.map(conversation => {
      if (conversation.projectId !== id) return conversation;
      const { projectId: _removed, ...rest } = conversation;
      return rest;
    }));
    setDrafts(current => current.map(draft => {
      if (draft.projectId !== id) return draft;
      const { projectId: _removed, ...rest } = draft;
      return rest;
    }));
  };

  const moveSession = (id: string, projectId: string | undefined) => {
    if (isProcessing) return;
    updateConversation(id, conversation => {
      const { projectId: _previous, ...rest } = conversation;
      return { ...rest, ...(projectId === undefined ? {} : { projectId }) };
    });
  };

  const archiveSessions = async (ids: readonly string[], archived: boolean) => {
    if (!isSessionReady || isProcessing) return;
    // 活动聊天归档后转向可用聊天；全部归档时由宿主创建新会话，不丢失历史。
    if (archived && ids.includes(activeSessionIdRef.current)) {
      const next = conversations.find(conversation => !conversation.archived && !ids.includes(conversation.id));
      if (next !== undefined) await switchSession(next.id);
      else await startNewSession();
    }
    setConversations(current => current.map(conversation => ids.includes(conversation.id) ? { ...conversation, archived } : conversation));
  };

  const renameSession = (sessionId: string, title: string) => {
    if (isProcessing) return;
    updateConversation(sessionId, (conversation) => ({
      ...conversation,
      title,
      titleManuallyRenamed: true,
    }));
  };

  const deleteSession = async (sessionId: string) => {
    if (!isSessionReady || isProcessing) return;
    const currentConversation = conversations.find((conversation) => conversation.id === sessionId);
    if (currentConversation === undefined) return;

    const nextActiveSessionId = await api.deleteSession(sessionId);
    const remaining = conversations.filter((conversation) => conversation.id !== sessionId);
    const available = [...remaining, ...drafts];
    let nextId = nextActiveSessionId;
    if (!available.some(conversation => conversation.id === nextId)) {
      // 宿主在运行态为空时返回新的输入 Session；它是草稿，历史仍可全部删除。
      setDrafts(current => [...current, createConversation(nextId)]);
    } else if (available.find(conversation => conversation.id === nextId)!.archived) {
      const next = available.find(conversation => !conversation.archived);
      if (next === undefined) {
        nextId = await api.newSession();
        setDrafts(current => [...current, createConversation(nextId)]);
      } else { nextId = next.id; await api.switchSession(nextId); }
    }
    setConversations(remaining);
    activeSessionIdRef.current = nextId;
    setActiveSessionId(nextId);
  };

  const switchSession = async (sessionId: string) => {
    if (isProcessing) return;
    if (sessionId === activeSessionIdRef.current) {
      setActiveView('conversation');
      return;
    }
    await api.switchSession(sessionId);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveView('conversation');
  };

  const selectProject = async (project?: ClientProject) => {
    if (project === undefined) {
      await startNewSession();
      return;
    }
    const existing = [...conversations, ...drafts].find(conversation => conversation.projectId === project.id && !conversation.archived);
    if (existing === undefined) await startNewSession(project);
    else await switchSession(existing.id);
  };

  const requestDelete = (sessionId: string, trigger: HTMLElement) => {
    deleteTrigger.current = trigger;
    setDeleteError('');
    setDeleteTarget(conversations.find(conversation => conversation.id === sessionId)!);
  };
  useLayoutEffect(() => {
    if (deleteTarget !== undefined) {
      deleteDialog.current!.showModal();
      deleteCancelButton.current!.focus();
    }
  }, [deleteTarget]);
  const closeDeleteDialog = () => {
    // 先解除模态与等待状态，再聚焦原触发位置；删除后回到当前界面的可用入口。
    flushSync(() => { setDeleteTarget(undefined); setDeleteError(''); setIsDeleting(false); });
    if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus();
    else if (activeView === 'settings') document.querySelector<HTMLButtonElement>('.settings-nav button[aria-current]')!.focus();
    else (document.querySelector<HTMLButtonElement>('.sidebar-session[aria-current]') ?? document.querySelector<HTMLButtonElement>('.sidebar-new-session'))!.focus();
  };
  const confirmDelete = async () => {
    setIsDeleting(true);
    setDeleteError('');
    try {
      await deleteSession(deleteTarget!.id);
      closeDeleteDialog();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setDeleteError(error.message);
      setIsDeleting(false);
    }
  };

  const sendTask = async () => {
    const sessionId = activeSessionIdRef.current;
    const conversation = activeConversation;
    if (conversation === undefined) return;
    const taskPrompt = conversation.prompt.trim();
    if (!taskPrompt || isProcessing || conversation.archived) return;

    // 主动发送是明确的“看最新内容”动作，即使此前在向上阅读也回到最新一轮。
    followsLatest.current = true;
    const assistantMessageId = nextMessageId.current + 1;
    const startedConversation: ClientConversation = {
      ...conversation,
      updatedAt: Date.now(),
      title: !conversation.titleManuallyRenamed && conversation.messages.length === 0 ? taskPrompt : conversation.title,
      messages: [
        ...conversation.messages,
        {
          id: nextMessageId.current,
          role: 'user',
          text: taskPrompt,
          attachments: conversation.attachments.map((attachment) => attachment.name),
          ...(conversation.attachments.length === 0 ? {} : {
            attachmentRoles: conversation.attachments.map((attachment) => attachment.role),
          }),
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          status: 'processing',
          streamedText: '',
          activity: [],
          activityExpanded: true,
        },
      ],
    };
    // 首次发送把草稿转成历史；失败或取消仍保留已提交的任务和执行事实。
    setDrafts(current => current.filter(draft => draft.id !== sessionId));
    setConversations(current => current.some(item => item.id === sessionId)
      ? current.map(item => item.id === sessionId ? startedConversation : item)
      : [...current, startedConversation]);
    nextMessageId.current += 2;
    setIsProcessing(true);

    try {
      const taskResult = await api.runAgentTask(taskPrompt);
      // 执行期间禁止切换会话，因此异步结果仍属于当前活动会话；这里也避开初始 ID 查询完成时的占位 ID 变化。
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        ...(!currentConversation.titleManuallyRenamed && taskResult.conversationTitle !== undefined ? { title: taskResult.conversationTitle } : {}),
        prompt: '',
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? {
                ...dropStreamedText(message),
                status: 'completed',
                result: taskResult,
                ...(taskResult.taskState === undefined ? {} : { taskState: taskResult.taskState }),
                activityExpanded: false,
              }
            : message
        )),
      }));
    } catch (error) {
      const cancelled = (error instanceof Error || error instanceof DOMException)
        && (error.name === 'AbortError'
          || error.message === 'This operation was aborted'
          || error.message === 'The operation was aborted');
      // 失败或取消时，此前已成功的工具产出和逐项结果仍是真实事实：宿主把它们挂在错误上，这里原样带到终态。
      const outputFiles = (error as { outputFiles?: readonly AgentTaskOutputFile[] }).outputFiles;
      const outputs = (error as { outputs?: readonly AgentTaskOutputItemResult[] }).outputs;
      const artifacts = {
        ...(outputFiles === undefined || outputFiles.length === 0 ? {} : { outputFiles }),
        ...(outputs === undefined || outputs.length === 0 ? {} : { outputs }),
      };
      updateConversation(activeSessionIdRef.current, (currentConversation) => ({
        ...currentConversation,
        messages: currentConversation.messages.map((message) => (
          message.role === 'assistant' && message.id === assistantMessageId
            ? cancelled
              ? {
                  ...dropStreamedText(message),
                  status: 'cancelled',
                  // 取消只影响仍在执行的活动，已完成的活动保留真实状态和耗时。
                  activity: message.activity.map((item) => (
                    item.status === 'running' ? { ...item, status: 'cancelled' as const } : item
                  )),
                  activityExpanded: false,
                  ...artifacts,
                }
              : {
                  ...dropStreamedText(message),
                  status: 'failed',
                  errorMessage: error instanceof Error ? error.message : '任务执行失败。',
                  activityExpanded: false,
                  ...artifacts,
                }
            : message
        )),
      }));
    } finally {
      updateConversation(sessionId, current => ({ ...current, updatedAt: Date.now() }));
      // 轮次结束（成功、失败或取消）后宿主也会结束等待，界面上不能再留下待决审批。
      setPendingApproval(undefined);
      setPendingQuestion(undefined);
      streamedStepId.current = undefined;
      setIsProcessing(false);
    }
  };

  const decideApproval = async (approved: boolean) => {
    const request = pendingApproval;
    if (request === undefined) return;
    // 先清掉待决状态：宿主只接受当前请求，重复提交会被拒绝。
    setPendingApproval(undefined);
    try {
      // 工作目录不在这里写入：只有宿主真的执行了 confirmDirectory 才会发布目录事实，
      // 这次决定可能因为轮次已经取消而失效。
      await api.decideApproval(request.requestId, approved);
    } catch (error) {
      // 轮次恰好先结束时宿主会拒绝这次迟到的决定；界面已经回到无待决状态。
      if (error instanceof Error && error.message.includes('该审批请求已失效')) return;
      throw error;
    }
  };

  const cancelTask = async () => {
    if (!isProcessing) return;
    try {
      await api.cancelTask();
    } catch (error) {
      // Turn 恰好先完成时，旧 Stop 点击不应影响已经可开始的下一轮。
      if (error instanceof Error && error.message.includes('当前没有正在执行的任务')) return;
      throw error;
    }
  };

  const toggleActivity = (messageId: number) => {
    const sessionId = activeSessionIdRef.current;
    updateConversation(sessionId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => (
        message.role === 'assistant' && message.id === messageId
          ? { ...message, activityExpanded: !message.activityExpanded }
          : message
      )),
    }));
  };

  const { messages, prompt, attachments, workingDirectory } = activeConversation;
  const titleFailure = !activeConversation.titleManuallyRenamed
    ? messages.find(message => message.role === 'assistant' && message.status === 'completed' && message.result.conversationTitleError !== undefined)
    : undefined;
  const hasConversation = messages.length > 0;
  // 状态条只投影当前会话已经产生的真实轮次和最近一轮模型步骤，不推测 token 或缓存数据。
  const latestAssistant = [...messages].reverse().find((message): message is Extract<ClientConversationMessage, { role: 'assistant' }> => message.role === 'assistant');
  const executionStatus = hasConversation ? {
    turnCount: messages.filter(message => message.role === 'user').length,
    stepCount: latestAssistant?.activity.filter(item => item.kind === 'analysis').length ?? 0,
  } : undefined;
  const approval = pendingQuestion !== undefined ? (
    <UserQuestion key={pendingQuestion.requestId} request={pendingQuestion} onAnswer={async (answer) => {
      await api.answerQuestion(pendingQuestion.requestId, answer);
      setPendingQuestion(undefined);
    }} />
  ) : pendingApproval === undefined ? null : (
    <ApprovalRequestCard
      request={pendingApproval}
      onDecide={(approved) => void decideApproval(approved)}
    />
  );
  const composer = (
    <>
    {activeConversation.archived && <div className="conversation-archive-notice">此会话已归档，可查看历史。<button type="button" onClick={() => void archiveSessions([activeSessionId], false)}>恢复会话</button></div>}
    {titleFailure?.role === 'assistant' && titleFailure.status === 'completed' && <p className="conversation-title-notice" role="status">自动命名失败：{titleFailure.result.conversationTitleError}。可在会话菜单中重命名。</p>}
    {activeConversation.terminalHistory !== undefined && <TerminalView snapshot={activeConversation.terminalHistory} api={api} />}
    <Composer
      attachments={attachments}
      prompt={prompt}
      isProcessing={isProcessing}
      isArchived={!!activeConversation.archived}
      approval={approval}
      projects={sidebar.projects}
      {...(activeConversation.projectId === undefined ? {} : { activeProjectId: activeConversation.projectId })}
      onSelectProject={selectProject}
      onCreateProject={async () => { const project = await addProject(); if (project !== undefined) await selectProject(project); }}
      {...(executionStatus === undefined ? {} : { executionStatus })}
      {...(workingDirectory === undefined ? {} : { workingDirectory })}
      onPromptChange={(nextPrompt) => updateConversation(
        activeSessionIdRef.current,
        (conversation) => ({ ...conversation, prompt: nextPrompt }),
      )}
      onSelectFiles={() => void selectAttachments()}
      onRemoveAttachment={(index) => void removeAttachment(index)}
      onSend={() => void sendTask()}
      onCancel={() => void cancelTask()}
    />
    </>
  );
  return (
    <div className={`app-shell${activeView === 'plugins' || activeView === 'skills' ? ' customization-shell' : ''}`}>
      <SessionSidebar
        appUpdates={api.appUpdates}
        sidebar={sidebar}
        onSidebarChange={setSidebar}
        onAddProject={async () => { await addProject(); }}
        onUpdateProject={updateProject}
        onRemoveProject={removeProject}
        onOpenProjectDirectory={directory => api.openProjectDirectory(directory)}
        onMoveSession={moveSession}
        onPinSession={id => updateConversation(id, conversation => ({ ...conversation, pinned: !conversation.pinned }))}
        onArchiveSessions={archiveSessions}
        conversations={conversations}
        activeSessionId={activeSessionId}
        activeView={activeView}
        isSessionReady={isSessionReady}
        isProcessing={isProcessing}
        settingsButtonRef={settingsButton}
        onNewSession={startNewSession}
        onSwitchSession={switchSession}
        onRenameSession={renameSession}
        onRequestDelete={requestDelete}
        onOpenSettings={() => setActiveView('settings')}
        extensionsApi={api.extensions}
        onSelectPlugin={id => { setExtensionSelection(id); setActiveView('plugins'); }}
        onOpenExtensions={view => { setExtensionSelection(undefined); setActiveView(view); }}
        onOpenConversation={() => setActiveView('conversation')}
      />

      <div className={`app-main${activeView === 'settings' ? ' settings-main' : ''}`}>
        {(activeView === 'plugins' || activeView === 'skills') && <ExtensionsPage api={api.extensions} view={activeView} isProcessing={isProcessing} {...(extensionSelection === undefined ? {} : { requestedId: extensionSelection })}
          onTrySkill={(skill, suggestedPrompt) => {
            const invocation = `$${skill.name}`;
            // 试用只准备输入，已有草稿保留；发送仍由用户决定。
            flushSync(() => {
              updateConversation(activeSessionIdRef.current, conversation => ({ ...conversation,
                prompt: conversation.prompt.trim() !== '' ? `${suggestedPrompt ?? invocation}\n${conversation.prompt}`
                  : skill.defaultPrompt === undefined ? invocation : skill.defaultPrompt.includes(invocation) ? skill.defaultPrompt : `${invocation} ${skill.defaultPrompt}`,
              }));
              setActiveView('conversation');
            });
            document.querySelector<HTMLTextAreaElement>('#agent-prompt')!.focus();
          }} />}
          <RuntimeSettingsPanel api={api} isProcessing={isProcessing} isOpen={activeView === 'settings'}
            archivedConversations={conversations.filter(conversation => conversation.archived)}
            onOpenConversation={switchSession} onRestoreConversation={id => archiveSessions([id], false)} onRequestDelete={requestDelete}
            onOpenExtensions={view => { setExtensionSelection(undefined); setActiveView(view); }} onClose={() => {
            // 设置页隐藏后将焦点还给常驻入口，对话节点和草稿始终保留。
            flushSync(() => setActiveView('conversation'));
            settingsButton.current!.focus();
          }} />
        <div className="conversation-view" hidden={activeView !== 'conversation'}>
        <ConversationPanel
          messages={messages}
          hasConversation={hasConversation}
          composer={composer}
          historyRef={conversationScroll}
          onHistoryScroll={handleHistoryScroll}
          onToggleActivity={toggleActivity}
          onRevealFile={(path) => api.revealFile(path)}
        />
        </div>
      </div>
      {deleteTarget !== undefined && <dialog ref={deleteDialog} className="session-delete-dialog" aria-labelledby="session-delete-title" aria-describedby="session-delete-description"
        onCancel={event => { event.preventDefault(); if (!isDeleting) closeDeleteDialog(); }}>
        <button className="session-dialog-close" type="button" aria-label="关闭" title="关闭" disabled={isDeleting} onClick={closeDeleteDialog}><X size={16} /></button>
        <h2 id="session-delete-title">删除 {deleteTarget.title}?</h2>
        <p id="session-delete-description">这只会从应用中删除该会话。你电脑上的文件和已生成的视频不会被删除。</p>
        {deleteError && <p className="sidebar-error" role="alert">{deleteError}</p>}
        <div className="session-delete-actions">
          <button ref={deleteCancelButton} type="button" disabled={isDeleting} onClick={closeDeleteDialog}>取消</button>
          <button className="session-delete-confirm" type="button" disabled={isDeleting || isProcessing || !isSessionReady} onClick={() => void confirmDelete()}>{isDeleting ? '正在删除…' : '删除会话'}</button>
        </div>
      </dialog>}
    </div>
  );
}
