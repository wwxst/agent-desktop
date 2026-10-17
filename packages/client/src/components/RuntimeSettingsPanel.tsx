import { useEffect, useRef, useState } from 'react';
import { ModelProvidersSettings } from './ModelProvidersSettings.js';
import { ExtensionsPage } from './ExtensionsPage.js';
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog.js';
import { ExtensionToast, type ExtensionNotice } from './ExtensionFeedback.js';
import { Archive, ArchiveRestore, ArrowLeft, ChevronRight, Cpu, Laptop, Monitor, Moon, Puzzle, Settings, Sun, Trash2, UserRound, X } from 'lucide-react';
import type { AgentClientApi, ClientConversation, RuntimeSettings, RuntimeSettingsUpdate } from '../api.js';

interface RuntimeSettingsPanelProps {
  readonly api: AgentClientApi;
  readonly isProcessing: boolean;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onOpenExtensions: (view: 'plugins' | 'skills') => void;
  readonly archivedConversations: readonly ClientConversation[];
  readonly onOpenConversation: (id: string) => Promise<void>;
  readonly onRestoreConversation: (id: string) => Promise<void>;
  readonly onRequestDelete: (id: string, trigger: HTMLElement) => void;
  readonly settings: RuntimeSettings | null;
  readonly settingsError: string;
  readonly onSaveSettings: (update: RuntimeSettingsUpdate) => Promise<RuntimeSettings>;
  readonly onSettings: (settings: RuntimeSettings) => void;
  readonly section: string;
  readonly onSectionChange: (section: string) => void;
}

const sections = [
  { id: 'general', label: '常规', icon: Settings, group: '个人' },
  { id: 'personalization', label: '个性化', icon: UserRound },
  { id: 'appearance', label: '外观', icon: Sun },
  { id: 'models', label: '模型与执行', icon: Cpu, group: '运行' },
  { id: 'extensions', label: '插件与技能', icon: Puzzle, group: '扩展' },
  { id: 'archives', label: '已归档的对话', icon: Archive, group: '已归档' },
] as const;

export function RuntimeSettingsPanel({ api, isProcessing, isOpen, onClose, onOpenExtensions, archivedConversations, onOpenConversation, onRestoreConversation, onRequestDelete, settings, settingsError, onSaveSettings, onSettings, section, onSectionChange }: RuntimeSettingsPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLElement>(null);
  const theme = settings?.theme ?? 'system';
  const [notice, setNotice] = useState<ExtensionNotice | null>(null);
  const [dismissedSettingsError, setDismissedSettingsError] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [confirmDeleteMemories, setConfirmDeleteMemories] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [instructions, setInstructions] = useState<{ path: string; content: string } | null>(null);
  const [instructionDraft, setInstructionDraft] = useState('');
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const instructionDialog = useRef<HTMLDialogElement>(null);

  const runArchiveAction = async (action: () => Promise<void>) => {
    setArchiveBusy(true);
    setNotice(null);
    try { await action(); }
    catch (error) { if (!(error instanceof Error)) throw error; setNotice({ variant: 'error', message: error.message }); }
    finally { setArchiveBusy(false); }
  };

  useEffect(() => {
    if (isOpen) closeButton.current!.focus();

  }, [isOpen]);

  // 设置页常驻挂载；离开个性化分区时同时释放原生模态，避免隐藏页面继续阻挡操作。
  useEffect(() => {
    if (isOpen && section === 'personalization') return;
    setConfirmDeleteMemories(false);
    if (instructionDialog.current?.open) instructionDialog.current.close();
    setInstructionsOpen(false);
  }, [isOpen, section]);

  useEffect(() => {
    if (section !== 'personalization' || !isOpen) return;
    let mounted = true;
    void api.loadCustomInstructions().then(next => { if (mounted) { setInstructions(next); setInstructionDraft(next.content); } }).catch(error => {
      if (mounted) setNotice({ variant: 'error', message: error instanceof Error ? error.message : '无法读取 Codex 指令。' });
    });
    return () => { mounted = false; };
  }, [api, isOpen, section]);

  const save = (update: RuntimeSettingsUpdate) => {
    if (isProcessing) return;
    setNotice(null);
    void (async () => {
      try {
        await onSaveSettings(update);
      } catch (error) {
        setNotice({ variant: 'error', message: error instanceof Error ? error.message : '无法自动保存设置。' });
      }
    })();
  };

  const deleteMemories = async () => {
    if (memoryBusy || isProcessing) return;
    setMemoryBusy(true); setNotice(null);
    try {
      await api.deleteMemories();
      setConfirmDeleteMemories(false);
      setNotice({ variant: 'success', message: '已删除全部 Codex 记忆。' });
    } catch (error) {
      setNotice({ variant: 'error', message: error instanceof Error ? error.message : '无法删除记忆。' });
    } finally { setMemoryBusy(false); }
  };
  const toast = notice ?? (settings === null && section !== 'archives' && settingsError !== '' && settingsError !== dismissedSettingsError
    ? { variant: 'error' as const, message: settingsError } : null);
  const toastElement = toast === null ? null : <ExtensionToast notice={toast} onClose={() => {
    setNotice(null);
    if (notice === null) setDismissedSettingsError(settingsError);
  }} />;
  const disabled = isProcessing;
  return (
    <div className="settings-layout" hidden={!isOpen} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || (event.target instanceof HTMLElement && event.target.closest('.model-provider-editor'))) return;
      if (event.target instanceof HTMLInputElement && (event.key === 'Enter' || event.key === 'Escape')) {
        event.target.blur();
        event.preventDefault();
        if (event.key === 'Escape') onClose();
      } else if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    }}>
      <nav className="settings-nav" aria-label="设置分区">
        <h1>设置</h1>
        {sections.map((item) => (
          <div key={item.id}>
            {'group' in item && <p className="settings-group">{item.group}</p>}
            <button type="button" title={item.label} aria-label={item.label} aria-current={section === item.id ? 'page' : undefined}
              onClick={() => { onSectionChange(item.id); page.current!.scrollTop = 0; }}>
              <item.icon size={17} aria-hidden="true" /><span>{item.label}</span>
            </button>
          </div>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-topbar">
          <p>{sections.find(item => item.id === section)!.label}</p>
          {settings !== null && section !== 'archives' && isProcessing && <p className="settings-message" role="status">任务执行中，暂时无法修改设置。</p>}
          <button ref={closeButton} type="button" className="icon-button settings-close" aria-label="关闭设置" title="返回对话" onClick={onClose}>
            <ArrowLeft size={18} />
          </button>
        </div>
        <main ref={page} className="settings-page" aria-label="设置">
          {section === 'archives' ? (
            <div className="settings-content">
              <h1>已归档的对话</h1>
              <p className="settings-readonly">归档的对话保留历史与文件。恢复后可继续原来的对话。</p>
              {archiveBusy && <p role="status">正在处理…</p>}
              <ul className="settings-archive-list" aria-label="已归档对话列表">
                {archivedConversations.map(conversation => <li key={conversation.id}>
                  <button className="settings-archive-title" type="button" title={conversation.title} disabled={isProcessing || archiveBusy}
                    onClick={() => void runArchiveAction(() => onOpenConversation(conversation.id))}>{conversation.title}</button>
                  <button className="icon-button" type="button" title="恢复对话" aria-label={`恢复对话：${conversation.title}`} disabled={isProcessing || archiveBusy}
                    onClick={() => void runArchiveAction(() => onRestoreConversation(conversation.id))}><ArchiveRestore size={16} /></button>
                  <button className="icon-button" type="button" title="删除对话" aria-label={`删除对话：${conversation.title}`} disabled={isProcessing || archiveBusy}
                    onClick={event => onRequestDelete(conversation.id, event.currentTarget)}><Trash2 size={16} /></button>
                </li>)}
              </ul>
              {archivedConversations.length === 0 && <p className="settings-readonly">没有已归档的对话。</p>}
            </div>
          ) : settings === null ? (
            <p role="status">{settingsError ? '设置未加载。' : '正在加载设置…'}</p>
          ) : (
            <div className="settings-content">
              <div hidden={section !== 'general'}>
                <h1>常规</h1>
                <section className="settings-section">
                  <h2>会话</h2>
                  <div className="settings-info-row"><div><strong>历史与设置</strong><p>保存在当前电脑，启动时恢复会话。</p></div><span>本机数据库</span></div>
                  <div className="settings-info-row"><div><strong>发送方式</strong><p>按回车发送，按 Shift + 回车换行。</p></div><span>回车发送</span></div>
                </section>
                <section className="settings-section">
                  <h2>执行权限</h2>
                  <div className="settings-info-row"><div><strong>聊天权限模式</strong><p>每个聊天独立保存权限模式，可在输入框的加号右侧选择。</p></div><span>在输入框设置</span></div>
                </section>
              </div>
              <div hidden={section !== 'appearance'}>
                <h1>外观</h1>
                <section className="settings-section">
                  <h2>模式</h2>
                  <div className="settings-theme-options" role="group" aria-label="外观模式">
                    {([{ value: 'system', label: '跟随系统', icon: Monitor }, { value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }] as const).map(item => (
                      <button key={item.value} type="button" className={`settings-theme-option ${item.value}`} disabled={disabled} aria-pressed={theme === item.value} onClick={() => save({ theme: item.value })}>
                        <item.icon size={22} aria-hidden="true" /><span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
              <div hidden={section !== 'personalization'}>
                <h1>个性化</h1>
                <section className="settings-section personalization-section">
                  <div className="personalization-heading"><div><h2>Codex 记忆</h2><p>配置 Codex 在本地主机上管理记忆的方式。<a href="https://help.openai.com" target="_blank" rel="noreferrer">了解更多</a></p></div><button className="host-selector" type="button" disabled><Laptop size={15} />本地主机<span>⌄</span></button></div>
                  <div className="memory-options">
                    <div className="memory-row"><div><strong>启用 Codex 记忆功能</strong><p>根据本地聊天记录生成记忆，并使用这些记忆为后续聊天提供个性化体验</p></div><label className="memory-switch"><input type="checkbox" role="switch" checked={settings.memoryEnabled} disabled={disabled} onChange={event => save({ memoryEnabled: event.target.checked })} /><span /></label></div>
                    <div className="memory-row"><div><strong>允许从使用工具的聊天中生成记忆</strong><p>从使用过 MCP 或网页预览工具的聊天生成记忆</p></div><label className="memory-switch"><input type="checkbox" role="switch" checked={settings.memoryFromToolChatsEnabled} disabled={disabled || !settings.memoryEnabled} onChange={event => save({ memoryFromToolChatsEnabled: event.target.checked })} /><span /></label></div>
                    <div className="memory-row"><div><strong>删除 Codex 记忆</strong><p>删除本地主机上的全部 Codex 记忆</p></div><button className="memory-delete" type="button" disabled={disabled} onClick={() => { setNotice(null); setConfirmDeleteMemories(true); }}>删除</button></div>
                  </div>
                </section>
                <section className="settings-section personalization-section">
                  <h2>自定义指令</h2>
                  <button className="instructions-entry" type="button" disabled={disabled} onClick={() => { if (instructions !== null) { setNotice(null); instructionDialog.current?.showModal(); setInstructionsOpen(true); } }}><span><strong>Codex 指令</strong><small>Edit the AGENTS.md file on the selected machine. Repository instructions may also apply. <a href="https://help.openai.com" target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>Learn more</a></small></span><ChevronRight size={17} /></button>
                </section>
                <dialog ref={instructionDialog} className="instructions-dialog" onClose={() => setInstructionsOpen(false)} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); instructionDialog.current?.close(); }}>
                  <header><h2>Codex 指令</h2><button className="icon-button" type="button" aria-label="关闭" onClick={() => instructionDialog.current?.close()}><X size={18} /></button></header>
                  <p className="instructions-path">{instructions?.path}</p>
                  <textarea aria-label="AGENTS.md 内容" value={instructionDraft} disabled={disabled} onChange={event => setInstructionDraft(event.target.value)} />
                  <footer><button type="button" className="extension-back" onClick={() => instructionDialog.current?.close()}>取消</button><button type="button" className="extension-add" disabled={disabled} onClick={() => { setNotice(null); void api.saveCustomInstructions(instructionDraft).then(next => { setInstructions(next); instructionDialog.current?.close(); }).catch(error => { setNotice({ variant: 'error', message: error instanceof Error ? error.message : '无法保存 Codex 指令。' }); }); }}>保存</button></footer>
                  {instructionsOpen && toastElement}
                </dialog>
              </div>
              <div hidden={section !== 'models'}>
                <ModelProvidersSettings api={{ ...api, saveRuntimeSettings: onSaveSettings }} settings={settings} isProcessing={isProcessing} isOpen={isOpen} onSettings={onSettings} />
              </div>
              <div hidden={section !== 'extensions'}>
                {section === 'extensions' && <ExtensionsPage api={api.extensions} view="plugins" isProcessing={isProcessing} onBrowse={onOpenExtensions} />}
              </div>
            </div>
          )}
        </main>
      </div>
      {confirmDeleteMemories && <DeleteConfirmationDialog title="删除全部 Codex 记忆？" description="此操作将删除本地主机上的全部 Codex 记忆，无法撤销。" confirmLabel="确认删除" busy={memoryBusy} disabled={disabled}
        onConfirm={() => void deleteMemories()} onClose={() => setConfirmDeleteMemories(false)} feedback={toastElement} />}
      {!confirmDeleteMemories && !instructionsOpen && toastElement}
    </div>
  );
}
