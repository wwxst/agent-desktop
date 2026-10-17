import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Folder, Plus, X } from 'lucide-react';
import type { Attachment, ConversationContextUsage, PermissionMode, RuntimeModelReference, RuntimeSettings } from '../api.js';
import type { ClientProject } from '../api.js';
import { AttachmentChip } from './AttachmentChip.js';
import { ModelSelector } from './ModelSelector.js';
import { PermissionSelector } from './PermissionSelector.js';
import { ContextUsage } from './ContextUsage.js';
import { ExtensionToast } from './ExtensionFeedback.js';

function finalDirectoryName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

interface ComposerProps {
  readonly attachments: readonly Attachment[];
  readonly prompt: string;
  readonly isProcessing: boolean;
  readonly isArchived?: boolean;
  /** 当前待决审批；显示在输入框上方，不进入对话历史。 */
  readonly approval: ReactNode;
  /** 当前会话工作目录；未设置时不渲染项目目录项。 */
  readonly workingDirectory?: string;
  /** 当前宿主已登记的项目列表；项目选择器不维护自己的目录清单。 */
  readonly projects: readonly ClientProject[];
  readonly activeProjectId?: string;
  readonly onSelectProject: (project?: ClientProject) => Promise<void>;
  readonly onCreateProject: () => Promise<void>;
  /** 当前会话最近一轮的真实执行摘要；没有历史任务时不渲染状态条。 */
  readonly executionStatus?: {
    readonly turnCount: number;
    readonly stepCount: number;
  };
  readonly onPromptChange: (prompt: string) => void;
  readonly onSelectFiles: () => void;
  readonly onRemoveAttachment: (index: number) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly settings: RuntimeSettings | null;
  readonly contextUsage?: ConversationContextUsage;
  readonly settingsError: string;
  readonly isSavingSettings: boolean;
  readonly onSelectModel: (reference: RuntimeModelReference) => Promise<RuntimeSettings>;
  readonly onConfigureModels: () => void;
  readonly permissionMode: PermissionMode;
  readonly onSelectPermissionMode: (mode: PermissionMode) => Promise<PermissionMode>;
}

/** Composer 集中承载输入附件、自然语言输入和发送动作。 */
export function Composer({
  attachments,
  prompt,
  isProcessing,
  isArchived = false,
  approval,
  workingDirectory,
  projects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  executionStatus,
  onPromptChange,
  onSelectFiles,
  onRemoveAttachment,
  onSend,
  onCancel,
  settings, contextUsage, settingsError, isSavingSettings, onSelectModel, onConfigureModels,
  permissionMode, onSelectPermissionMode,
}: ComposerProps) {
  const modelMissing = settings?.conversationModel === null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modelMissing) onSend();
  };
  const directoryName = workingDirectory === undefined ? undefined : finalDirectoryName(workingDirectory);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState('');
  const projectMenu = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const activeProject = projects.find(project => project.id === activeProjectId);
  const projectLabel = activeProject?.name ?? directoryName;
  const projectDisabled = isProcessing || isArchived || isSavingSettings;

  useLayoutEffect(() => {
    if (projectMenuOpen) projectMenu.current?.showPopover({ source: projectTrigger.current! });
  }, [projectMenuOpen]);

  const closeProjectMenu = () => {
    projectMenu.current?.hidePopover();
    setProjectMenuOpen(false);
  };

  const runProjectAction = async (action: () => Promise<void>) => {
    setProjectBusy(true);
    setProjectError('');
    try {
      await action();
      closeProjectMenu();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setProjectError(error.message);
    } finally {
      setProjectBusy(false);
    }
  };
  // 打开菜单时由原生顶层浮层承载提示；收起菜单后仍保留在页面顶部。
  const projectFeedback = projectError && <ExtensionToast notice={{ variant: 'error', message: projectError }} onClose={() => setProjectError('')} />;

  return (
    <div className="composer-stack">
      {approval}
      <div className="composer-project-picker">
        <button ref={projectTrigger} className="composer-directory" type="button"
          aria-label={projectLabel === undefined ? '选择项目目录' : `项目目录：${projectLabel}`}
          aria-expanded={projectMenuOpen} disabled={projectDisabled} title={workingDirectory ?? '选择项目目录'}
          onClick={() => setProjectMenuOpen(open => !open)}>
          <Folder className="composer-directory-icon" size={15} />
          <span className="composer-directory-path">{projectLabel ?? '选择项目目录'}</span>
          <ChevronDown className="composer-directory-chevron" size={10} />
        </button>
        <div ref={projectMenu} className="composer-project-menu" popover="auto" aria-label="项目目录选择"
          onToggle={event => { if (event.newState === 'closed') setProjectMenuOpen(false); }}>
          {projects.map(project => (
            <button key={project.id} type="button" disabled={projectBusy} aria-pressed={project.id === activeProjectId}
              onClick={() => void runProjectAction(() => onSelectProject(project))}>
              <Folder size={15} /><span>{project.name}</span>
              {project.id === activeProjectId && <Check className="composer-project-check" size={15} />}
            </button>
          ))}
          {projects.length > 0 && <hr />}
          <button type="button" disabled={projectBusy} onClick={() => void runProjectAction(onCreateProject)}><Plus size={15} /><span>新建项目</span></button>
          <button type="button" disabled={projectBusy} onClick={() => void runProjectAction(() => onSelectProject(undefined))}><X size={15} /><span>不在项目中工作</span></button>
          {projectMenuOpen && projectFeedback}
        </div>
        {!projectMenuOpen && projectFeedback}
      </div>
      <form className="composer" onSubmit={submit}>
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="已选择的输入附件">
          {attachments.map((attachment, index) => (
            <AttachmentChip
              key={`${attachment.path}-${index}`}
              name={attachment.name}
              role={attachment.role}
              {...isProcessing || isArchived ? {} : { onRemove: () => onRemoveAttachment(index) }}
            />
          ))}
        </div>
      )}

      <label className="visually-hidden" htmlFor="agent-prompt">剪辑需求</label>
      <textarea
        id="agent-prompt"
        value={prompt}
        disabled={isProcessing || isArchived}
        placeholder="告诉 Agent 你想做什么…"
        rows={1}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          // 输入法确认和 Shift+Enter 留给文本框，只有普通 Enter 提交真实任务。
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!isProcessing && !isArchived && !isSavingSettings && !modelMissing && prompt.trim()) onSend();
        }}
      />

      <div className="composer-toolbar">
        <div className="composer-leading">
        <button
          className="icon-button attachment-button"
          type="button"
          aria-label="选择输入文件"
          title="选择输入文件"
          disabled={isProcessing || isArchived}
          onClick={onSelectFiles}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
          <PermissionSelector mode={permissionMode} busy={isSavingSettings} disabled={isProcessing || isArchived || settings === null}
            onSelect={onSelectPermissionMode} />
        </div>
        <div className="composer-trailing">
          {isProcessing && <span className="composer-state">处理中</span>}
          <div className="composer-model-group">
            <ContextUsage settings={settings} {...contextUsage === undefined ? {} : { usage: contextUsage }} />
            <ModelSelector settings={settings} settingsError={settingsError} busy={isSavingSettings} disabled={isArchived}
              onSelect={onSelectModel} onConfigure={onConfigureModels} />
          </div>
          <button
            className="icon-button send-button"
            type="submit"
            aria-label={isProcessing ? '停止' : '发送'}
            title={isProcessing ? '停止' : '发送'}
            disabled={isArchived || (!isProcessing && (!prompt.trim() || isSavingSettings || modelMissing))}
            onClick={isProcessing ? (event) => { event.preventDefault(); onCancel(); } : undefined}
          >
            {isProcessing ? (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
                <path
                  d="M8.3125.980183c.35517.073166.66797.224837.9502.452147.2245.18064.4678.425457.7168.67481L14.707 6.83468l-1.414 1.414L9 3.95577v11.08593H7V3.95577L2.707 8.24868l-1.414-1.414L6.0205 2.10714c.2492-.24921.4925-.49402.71699-.67481C7.0212 1.20402 7.33399 1.05335 7.6875.980183c.2103-.043177.4161-.025025.625.0Z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
      </form>
      {modelMissing && !isProcessing && <div className="composer-status" role="status">未配置模型，请先在模型菜单中配置模型。</div>}
      {executionStatus !== undefined && (
        <div className="composer-status" aria-label="执行状态">
          <span className="composer-status-item">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75" />
              <path d="M8 1.25v3.5l2.5 1.5" />
            </svg>
            <span>{executionStatus.turnCount} 轮 {executionStatus.stepCount} 步</span>
          </span>
        </div>
      )}
    </div>
  );
}
