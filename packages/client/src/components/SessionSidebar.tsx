import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Archive, AtSign, Box, ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal, Pin, Plus, SquarePen } from 'lucide-react';
import type { AppUpdateApi, ClientConversation, ClientProject, ClientSidebarState, ExtensionClientApi, ExtensionItem } from '../api.js';
import { ExtensionIcon } from './ExtensionsPage.js';
import { AppUpdateButton } from './AppUpdateButton.js';

interface SessionSidebarProps {
  readonly conversations: readonly ClientConversation[];
  readonly sidebar: ClientSidebarState;
  readonly activeSessionId: string;
  readonly activeView: 'conversation' | 'settings' | 'plugins' | 'skills';
  readonly isSessionReady: boolean;
  readonly isProcessing: boolean;
  readonly appUpdates: AppUpdateApi | undefined;
  readonly settingsButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onNewSession: (project?: ClientProject) => Promise<void>;
  readonly onSwitchSession: (sessionId: string) => Promise<void>;
  readonly onRenameSession: (sessionId: string, title: string) => void;
  readonly onRequestDelete: (sessionId: string, trigger: HTMLElement) => void;
  readonly onSidebarChange: (state: ClientSidebarState) => void;
  readonly onAddProject: () => Promise<void>;
  readonly onUpdateProject: (id: string, changes: Partial<Pick<ClientProject, 'name' | 'pinned' | 'collapsed'>>) => void;
  readonly onRemoveProject: (id: string) => void;
  readonly onOpenProjectDirectory: (directory: string) => Promise<void>;
  readonly onMoveSession: (id: string, projectId: string | undefined) => void;
  readonly onPinSession: (id: string) => void;
  readonly onArchiveSessions: (ids: readonly string[], archived: boolean) => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onOpenExtensions: (view: 'plugins' | 'skills') => void;
  readonly onOpenConversation: () => void;
  readonly extensionsApi: ExtensionClientApi;
  readonly onSelectPlugin: (id: string) => void;
}

type SidebarMenu = { readonly kind: 'session' | 'project' | 'section'; readonly id: string };

/** 侧栏只负责导航和菜单展示；持久化、目录确认与会话运行仍由 App 和宿主负责。 */
export function SessionSidebar({ conversations, sidebar, activeSessionId, activeView, isSessionReady, isProcessing, appUpdates,
  settingsButtonRef, onNewSession, onSwitchSession, onRenameSession, onRequestDelete, onSidebarChange,
  onAddProject, onUpdateProject, onRemoveProject, onOpenProjectDirectory, onMoveSession, onPinSession,
  onArchiveSessions, onOpenSettings, onOpenExtensions, onOpenConversation, extensionsApi, onSelectPlugin }: SessionSidebarProps) {
  const [installedPlugins, setInstalledPlugins] = useState<readonly ExtensionItem[]>([]);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const [panel, setPanel] = useState<'main' | 'rename' | 'move' | 'edit-project' | 'remove-project' | 'archive-project'>('main');
  const [editingTitle, setEditingTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessionMenu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement>(null);
  const activeSessionButton = useRef<HTMLButtonElement>(null);
  const disabled = !isSessionReady || isProcessing || busy;
  useEffect(() => {
    if (activeView !== 'plugins' && activeView !== 'skills') return;
    let mounted = true;
    const refresh = () => { void extensionsApi.list().then(snapshot => { if (mounted) setInstalledPlugins(snapshot.plugins.filter(item => item.installed)); }).catch((error: unknown) => { if (mounted && error instanceof Error) setError(error.message); }); };
    refresh(); const unsubscribe = extensionsApi.onChanged(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, [activeView, extensionsApi]);
  const selectedConversation = menu?.kind === 'session' ? conversations.find(item => item.id === menu.id) : undefined;
  const selectedProject = menu?.kind === 'project' ? sidebar.projects.find(item => item.id === menu.id) : undefined;

  useEffect(() => { if (isProcessing) { setMenu(null); setPanel('main'); } }, [isProcessing]);
  useEffect(() => { activeSessionButton.current?.scrollIntoView({ block: 'nearest' }); }, [activeSessionId]);
  useLayoutEffect(() => {
    if (menu !== null) sessionMenu.current!.showPopover({ source: menuTrigger.current! });
  }, [menu]);
  const closeMenu = () => { setMenu(null); setPanel('main'); };
  const openMenu = (target: SidebarMenu, source: HTMLElement) => {
    menuTrigger.current = source;
    setError(''); setPanel('main'); setMenu(target);
  };
  // 异步目录与会话操作失败时显示真实原因，菜单不会假装已成功。
  const run = async (operation: () => void | Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); closeMenu(); }
    catch (failure) { if (!(failure instanceof Error)) throw failure; setError(failure.message); }
    finally { setBusy(false); }
  };
  const finishRename = (save: boolean) => {
    const title = editingTitle.trim();
    if (save && title && selectedConversation !== undefined) onRenameSession(selectedConversation.id, title);
    closeMenu();
  };
  // 更新时间由真实新建和轮次更新写入；切换或草稿编辑不会改变排序。
  const recent = conversations.filter(item => !item.archived).map((item, index) => ({ item, index }))
    .sort((a, b) => Number(!!b.item.pinned) - Number(!!a.item.pinned) || (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0) || b.index - a.index)
    .map(({ item }) => item);
  const projects = [...sidebar.projects].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const processingIn = (items: readonly ClientConversation[]) => isProcessing && items.some(item => item.id === activeSessionId);
  const runningMark = <span className="sidebar-running" role="status" aria-label="进行中" />;

  const renderConversation = (conversation: ClientConversation, section: string) => {
    const selected = conversation.id === activeSessionId && activeView === 'conversation';
    const menuOpen = menu?.kind === 'session' && menu.id === conversation.id;
    return <div key={conversation.id} className={`sidebar-session-row${selected ? ' active' : ''}`} onContextMenu={event => {
      if (disabled) return;
      event.preventDefault(); openMenu({ kind: 'session', id: conversation.id }, event.currentTarget);
    }}>
      <button ref={selected && section === 'recent' ? activeSessionButton : undefined} className="sidebar-session" type="button"
        aria-label={conversation.title} title={conversation.title} disabled={disabled} aria-current={selected ? 'page' : undefined}
        onClick={() => void run(() => onSwitchSession(conversation.id))}>
        {conversation.pinned && <Pin className="sidebar-pinned" size={12} />}<span className="sidebar-session-title">{conversation.title}</span>
        {conversation.id === activeSessionId && isProcessing && runningMark}
      </button>
      <div className="sidebar-session-quick">
        <button type="button" title={conversation.pinned ? '取消置顶' : '置顶'} aria-label={`${conversation.pinned ? '取消置顶' : '置顶'}：${conversation.title}`} disabled={disabled} onClick={() => onPinSession(conversation.id)}><Pin size={14} /></button>
        <button type="button" title="归档会话" aria-label={`归档：${conversation.title}`} disabled={disabled} onClick={() => void run(() => onArchiveSessions([conversation.id], true))}><Archive size={14} /></button>
      </div>
      <button className="sidebar-session-menu-button" type="button" aria-label={`会话操作：${conversation.title}`} title="会话操作" aria-expanded={menuOpen} disabled={disabled}
        onClick={event => { if (menuOpen) closeMenu(); else openMenu({ kind: 'session', id: conversation.id }, event.currentTarget); }}><MoreHorizontal size={16} /></button>
    </div>;
  };

  const renderMenu = () => menu === null ? null : <div ref={sessionMenu} popover="auto"
    className={`sidebar-session-menu${panel !== 'main' ? ' sidebar-session-editor' : ''}`}
    aria-label={selectedConversation ? `会话菜单：${selectedConversation.title}` : selectedProject ? `项目菜单：${selectedProject.name}` : '侧栏选项'}
    onToggle={event => { if (event.newState === 'closed') closeMenu(); }}>
    {selectedConversation !== undefined && (panel === 'rename' ? <input className="sidebar-session-title-input" aria-label="会话标题" value={editingTitle} autoFocus
      onFocus={event => event.currentTarget.select()} onChange={event => setEditingTitle(event.target.value)}
      onKeyDown={event => { if (!event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === 'Escape')) { event.preventDefault(); flushSync(() => finishRename(event.key === 'Enter')); menuTrigger.current?.focus(); } }}
      onBlur={() => finishRename(true)} /> : panel === 'move' ? <>
      <button type="button" onClick={() => setPanel('main')}>‹ 返回</button>
      {projects.map(project => <button key={project.id} type="button" disabled={disabled} aria-pressed={selectedConversation.projectId === project.id} onClick={() => { onMoveSession(selectedConversation.id, project.id); closeMenu(); }}>{project.name}</button>)}
      <button type="button" disabled={disabled} onClick={() => { onMoveSession(selectedConversation.id, undefined); closeMenu(); }}>从项目中移除</button>
    </> : <>
      <button type="button" autoFocus onClick={() => { setEditingTitle(selectedConversation.title); setPanel('rename'); }}>重命名</button>
      <button type="button" onClick={() => { onPinSession(selectedConversation.id); closeMenu(); }}>{selectedConversation.pinned ? '取消置顶' : '置顶'}</button>
      <button type="button" onClick={() => setPanel('move')}>移到项目 <ChevronRight size={14} /></button>
      <hr /><button type="button" disabled={disabled} onClick={() => void run(() => onArchiveSessions([selectedConversation.id], true))}>归档</button>
      <button type="button" onClick={() => { onRequestDelete(selectedConversation.id, menuTrigger.current!); closeMenu(); }}>删除</button>
    </>)}
    {selectedProject !== undefined && (panel === 'edit-project' ? <form onSubmit={event => { event.preventDefault(); if (editingTitle.trim()) { onUpdateProject(selectedProject.id, { name: editingTitle.trim() }); closeMenu(); } }}>
      <label>项目名称<input className="sidebar-session-title-input" aria-label="项目名称" value={editingTitle} autoFocus onChange={event => setEditingTitle(event.target.value)} /></label>
      <p className="sidebar-project-directory" title={selectedProject.directory}>{selectedProject.directory}</p>
      <div className="sidebar-session-confirm-actions"><button type="submit" disabled={!editingTitle.trim()}>保存</button><button type="button" onClick={() => setPanel('main')}>取消</button></div>
    </form> : panel === 'remove-project' || panel === 'archive-project' ? <>
      <p>{panel === 'remove-project' ? '移除项目只取消列表归属，保留会话、文件和原工作目录。' : '归档此项目的所有会话，保留历史和产物，可从设置中的已归档对话恢复。'}</p>
      <div className="sidebar-session-confirm-actions"><button type="button" disabled={disabled} onClick={() => void run(() => panel === 'remove-project' ? onRemoveProject(selectedProject.id) : onArchiveSessions(conversations.filter(item => item.projectId === selectedProject.id && !item.archived).map(item => item.id), true))}>{panel === 'remove-project' ? '移除项目' : '归档全部'}</button><button type="button" onClick={() => setPanel('main')}>取消</button></div>
    </> : <>
      <button type="button" disabled={disabled} onClick={() => void run(() => onNewSession(selectedProject))}>在项目中新建会话</button>
      <button type="button" autoFocus onClick={() => { onUpdateProject(selectedProject.id, { pinned: !selectedProject.pinned }); closeMenu(); }}>{selectedProject.pinned ? '取消置顶' : '置顶'}</button>
      <button type="button" onClick={() => { setEditingTitle(selectedProject.name); setPanel('edit-project'); }}>编辑</button>
      <hr /><button type="button" disabled={disabled} onClick={() => void run(() => onOpenProjectDirectory(selectedProject.directory))}>在资源管理器中打开</button>
      <button type="button" onClick={() => setPanel('archive-project')}>归档聊天</button>
      <hr /><button type="button" onClick={() => setPanel('remove-project')}>移除项目</button>
    </>)}
    {menu.kind === 'section' && <>
      <button type="button" autoFocus aria-pressed={sidebar.grouped} onClick={() => { onSidebarChange({ ...sidebar, grouped: true }); closeMenu(); }}>分项目显示</button>
      <button type="button" aria-pressed={!sidebar.grouped} onClick={() => { onSidebarChange({ ...sidebar, grouped: false }); closeMenu(); }}>合并显示</button>
      <hr /><p className="sidebar-menu-note">排序：置顶优先，其余按最近更新</p>
    </>}
  </div>;
  return (
    <>
    <nav className="app-navigation" aria-label="主导航">
      <button
        className={`navigation-button${activeView === 'conversation' ? ' active' : ''}`}
        type="button"
        aria-label="对话"
        title="对话"
        aria-current={activeView === 'conversation' ? 'page' : undefined}
        disabled={!isSessionReady}
        onClick={onOpenConversation}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="m2 7 6-5 6 5M3.5 6v8h3V9h3v5h3V6" />
        </svg>
      </button>
      <button className={`navigation-button${activeView === 'plugins' || activeView === 'skills' ? ' active' : ''}`} type="button" aria-label="插件和技能" title="插件和技能" disabled={!isSessionReady} aria-current={activeView === 'plugins' || activeView === 'skills' ? 'page' : undefined} onClick={() => onOpenExtensions('plugins')}><AtSign size={18} /></button>
      <div className="navigation-bottom">
      {appUpdates !== undefined && <AppUpdateButton api={appUpdates} isProcessing={isProcessing || !isSessionReady} />}
      <button
        ref={settingsButtonRef}
        className={`navigation-button sidebar-settings${activeView === 'settings' ? ' active' : ''}`}
        type="button"
        aria-label="设置"
        title="设置"
        aria-current={activeView === 'settings' ? 'page' : undefined}
        onClick={onOpenSettings}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" style={{ strokeWidth: 1.75 }} aria-hidden="true" focusable="false">
          <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      </div>
    </nav>
    {activeView === 'plugins' || activeView === 'skills' ? (
      <aside className="app-sidebar extensions-sidebar" aria-label="扩展导航">
        <h2>自定义</h2>
        <nav aria-label="自定义分区">
          <button type="button" aria-label="插件" title="插件" aria-current={activeView === 'plugins' ? 'page' : undefined} onClick={() => onOpenExtensions('plugins')}><AtSign size={16} /><span>插件</span></button>
          <button type="button" aria-label="技能" title="技能" aria-current={activeView === 'skills' ? 'page' : undefined} onClick={() => onOpenExtensions('skills')}><Box size={16} /><span>技能</span></button>
        </nav>
        <div className="extensions-installed-heading">已安装</div>
        <nav aria-label="已安装插件">{installedPlugins.map(item => <button type="button" key={item.id} title={item.name} onClick={() => onSelectPlugin(item.id)}><ExtensionIcon item={item} /><span className="extension-installed-name">{item.name}</span></button>)}</nav>
        {error && <p className="sidebar-error" role="alert">{error}</p>}
      </aside>
    ) : activeView === 'settings' ? null : (
    <aside className="app-sidebar" aria-label="工作区导航">
      <div className="sidebar-brand"><strong>Agent Desktop</strong></div>
      <button className="sidebar-new-session" type="button" aria-label="新会话" title="新会话" disabled={disabled} onClick={() => void run(() => onNewSession())}><SquarePen size={16} /><span>新会话</span></button>
      {error && <p className="sidebar-error" role="alert">{error}</p>}
      <nav className="sidebar-session-list" aria-label="会话列表">
        {sidebar.grouped && <section aria-label="项目">
          <div className="sidebar-section-heading">
            <button type="button" className="sidebar-section-toggle" aria-label={sidebar.projectsCollapsed ? '展开项目' : '折叠项目'} title="项目" aria-expanded={!sidebar.projectsCollapsed} onClick={() => onSidebarChange({ ...sidebar, projectsCollapsed: !sidebar.projectsCollapsed })}><span>项目</span>{sidebar.projectsCollapsed && processingIn(recent.filter(item => item.projectId !== undefined)) ? runningMark : sidebar.projectsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
            <button className="sidebar-heading-action" type="button" aria-label="项目侧栏选项" title="侧栏选项" onClick={event => openMenu({ kind: 'section', id: 'projects' }, event.currentTarget)}><MoreHorizontal size={16} /></button>
            <button className="sidebar-heading-action" type="button" aria-label="添加项目" title="添加项目" disabled={disabled} onClick={() => void run(onAddProject)}><Plus size={16} /></button>
          </div>
          {!sidebar.projectsCollapsed && <>
            {projects.length === 0 && <button className="sidebar-empty-action" type="button" disabled={disabled} onClick={() => void run(onAddProject)}>添加项目文件夹</button>}
            {projects.map(project => {
              const chats = recent.filter(item => item.projectId === project.id);
              return <div key={project.id} className="sidebar-project">
                <div className="sidebar-project-row" onContextMenu={event => { if (disabled) return; event.preventDefault(); openMenu({ kind: 'project', id: project.id }, event.currentTarget); }}>
                  <button className="sidebar-project-toggle" type="button" aria-label={`项目：${project.name}`} title={project.directory} aria-expanded={!project.collapsed} onClick={() => onUpdateProject(project.id, { collapsed: !project.collapsed })}>{project.collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}<span>{project.name}</span>{project.pinned && <Pin size={12} />}{project.collapsed && processingIn(chats) && runningMark}</button>
                  <button className="sidebar-heading-action" type="button" aria-label={`项目操作：${project.name}`} title="项目操作" disabled={disabled} onClick={event => openMenu({ kind: 'project', id: project.id }, event.currentTarget)}><MoreHorizontal size={16} /></button>
                  <button className="sidebar-heading-action" type="button" aria-label={`在 ${project.name} 中新建会话`} title="在项目中新建会话" disabled={disabled} onClick={() => void run(() => onNewSession(project))}><SquarePen size={15} /></button>
                </div>
                {!project.collapsed && <div className="sidebar-project-chats">{chats.length === 0 ? <button className="sidebar-empty-action" type="button" disabled={disabled} onClick={() => void run(() => onNewSession(project))}>新建会话</button> : chats.map(conversation => renderConversation(conversation, project.id))}</div>}
              </div>;
            })}
          </>}
        </section>}
        <section aria-label="最近">
          <div className="sidebar-section-heading">
            <button className="sidebar-section-toggle" type="button" aria-label={sidebar.recentCollapsed ? '展开最近会话' : '折叠最近会话'} title="最近" aria-expanded={!sidebar.recentCollapsed} onClick={() => onSidebarChange({ ...sidebar, recentCollapsed: !sidebar.recentCollapsed })}><span>最近</span>{sidebar.recentCollapsed && processingIn(recent) ? runningMark : sidebar.recentCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
            <button className="sidebar-heading-action" type="button" aria-label="最近侧栏选项" title="侧栏选项" onClick={event => openMenu({ kind: 'section', id: 'recent' }, event.currentTarget)}><MoreHorizontal size={16} /></button>
          </div>
          {!sidebar.recentCollapsed && recent.map(item => renderConversation(item, 'recent'))}
        </section>
      </nav>
      {renderMenu()}
    </aside>
    )}
    </>
  );
}
