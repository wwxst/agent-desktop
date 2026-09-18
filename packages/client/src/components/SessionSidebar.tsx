import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { ClientConversation } from '../api.js';

interface SessionSidebarProps {
  readonly conversations: readonly ClientConversation[];
  readonly activeSessionId: string;
  readonly activeView: 'conversation' | 'settings';
  readonly isSessionReady: boolean;
  readonly isProcessing: boolean;
  readonly settingsButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onNewSession: () => void;
  readonly onSwitchSession: (sessionId: string) => void;
  readonly onRenameSession: (sessionId: string, title: string) => void;
  readonly onDeleteSession: (sessionId: string) => void;
  readonly onOpenSettings: () => void;
}

/**
 * 工作区侧栏：产品标识、新会话、运行期会话列表和设置入口。
 * 会话菜单、重命名和删除确认都是侧栏自身的界面状态，只在本组件内维护；
 * 会话数据、当前会话和运行状态仍由 App 持有。
 */
export function SessionSidebar({
  conversations,
  activeSessionId,
  activeView,
  isSessionReady,
  isProcessing,
  settingsButtonRef,
  onNewSession,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onOpenSettings,
}: SessionSidebarProps) {
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);
  const activeSessionButton = useRef<HTMLButtonElement>(null);
  const sessionMenu = useRef<HTMLDivElement>(null);
  const sessionMenuTrigger = useRef<HTMLButtonElement>(null);

  // 进入执行态时关闭已有会话操作，保证重命名和删除在整个 Turn 期间不可触发。
  useEffect(() => {
    if (!isProcessing) return;
    setOpenSessionMenuId(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
    setEditingTitle('');
  }, [isProcessing]);

  // 新建或切换会话后让当前行进入列表可见区域。
  useEffect(() => {
    activeSessionButton.current?.scrollIntoView({ block: 'nearest' });
  }, [activeSessionId]);

  useLayoutEffect(() => {
    if (openSessionMenuId !== null) {
      // 原生浮层进入顶层，避免被会话列表裁切；source 同时提供定位锚点和焦点返回目标。
      sessionMenu.current!.showPopover({ source: sessionMenuTrigger.current! });
    }
  }, [openSessionMenuId]);

  const closeMenu = () => {
    setOpenSessionMenuId(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
  };

  const finishRename = (sessionId: string, save: boolean) => {
    if (editingSessionId !== sessionId) return;
    const title = editingTitle.trim();
    if (save && title.length > 0) onRenameSession(sessionId, title);
    setEditingSessionId(null);
    setEditingTitle('');
    setOpenSessionMenuId(null);
  };

  return (
    <aside className="app-sidebar" aria-label="工作区导航">
      <div className="sidebar-brand">
        <strong>Agent Desktop</strong>
      </div>
      <button
        className="sidebar-new-session"
        type="button"
        aria-label="新会话"
        title="新会话"
        disabled={!isSessionReady || isProcessing}
        onClick={onNewSession}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span>新会话</span>
      </button>
      <div className="sidebar-section-label sidebar-sessions-label">会话</div>
      <nav className="sidebar-session-list" aria-label="会话列表">
        {conversations.map((conversation) => {
          const active = conversation.id === activeSessionId;
          const selected = active && activeView === 'conversation';
          const editing = editingSessionId === conversation.id;
          const menuOpen = openSessionMenuId === conversation.id;
          const confirmingDelete = confirmDeleteSessionId === conversation.id;
          return (
            <div
              key={conversation.id}
              className={`sidebar-session-row${selected ? ' active' : ''}`}
            >
              <button
                ref={active ? activeSessionButton : undefined}
                className="sidebar-session"
                type="button"
                aria-label={conversation.title}
                title={conversation.title}
                disabled={!isSessionReady || isProcessing}
                {...selected ? { 'aria-current': 'page' as const } : {}}
                onClick={() => onSwitchSession(conversation.id)}
              >
                <span>{conversation.title}</span>
                {active && isProcessing && <small>进行中</small>}
              </button>
              <button
                className="sidebar-session-menu-button"
                type="button"
                aria-label={`会话操作：${conversation.title}`}
                title="会话操作"
                aria-expanded={menuOpen}
                disabled={!isSessionReady || isProcessing}
                onClick={(event) => {
                  sessionMenuTrigger.current = event.currentTarget;
                  setOpenSessionMenuId(menuOpen ? null : conversation.id);
                  setConfirmDeleteSessionId(null);
                }}
              >
                {/* 图标按 16px 原始尺寸渲染，避免缩放后三个点落到半像素而发虚。 */}
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <circle cx="3.5" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="12.5" cy="8" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  ref={sessionMenu}
                  popover="auto"
                  className={`sidebar-session-menu${confirmingDelete || editing ? ' sidebar-session-editor' : ''}`}
                  aria-label={confirmingDelete ? '删除会话确认' : `会话菜单：${conversation.title}`}
                  onToggle={(event) => {
                    if (event.newState === 'closed') closeMenu();
                  }}
                >
                  {editing ? (
                    <input
                      className="sidebar-session-title-input"
                      aria-label="会话标题"
                      value={editingTitle}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === 'Escape') {
                          event.preventDefault();
                          // 先卸载编辑框再返回焦点，避免 Escape 又触发旧 onBlur 保存。
                          flushSync(() => finishRename(conversation.id, event.key === 'Enter'));
                          sessionMenuTrigger.current?.focus();
                        }
                      }}
                      onBlur={() => finishRename(conversation.id, true)}
                    />
                  ) : confirmingDelete ? (
                    <>
                      <p>删除会话将清除聊天记录和会话上下文，但不会删除已经生成的视频文件。</p>
                      <div className="sidebar-session-confirm-actions">
                        <button type="button" onClick={() => {
                          // 先关闭整组会话操作，再交给 App 删除会话，避免菜单停留在已删除的行上。
                          closeMenu();
                          onDeleteSession(conversation.id);
                        }}>删除会话</button>
                        <button type="button" onClick={() => setConfirmDeleteSessionId(null)}>取消</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button type="button" autoFocus onClick={() => {
                        if (isProcessing) return;
                        setConfirmDeleteSessionId(null);
                        setEditingSessionId(conversation.id);
                        setEditingTitle(conversation.title);
                      }}>重命名</button>
                      <button type="button" onClick={() => setConfirmDeleteSessionId(conversation.id)}>删除</button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <button
        ref={settingsButtonRef}
        className={`sidebar-settings${activeView === 'settings' ? ' active' : ''}`}
        type="button"
        aria-label="设置"
        title="设置"
        aria-current={activeView === 'settings' ? 'page' : undefined}
        onClick={onOpenSettings}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
          {/* 齿轮轮廓：8 齿，齿顶半径 7.2、齿根半径 5.0，中心为 2.2 半径的轴孔。 */}
          <path d="M15.11 6.87A7.2 7.2 0 0 1 15.11 9.13L12.86 9.17A5 5 0 0 1 12.26 10.61L13.82 12.23A7.2 7.2 0 0 1 12.23 13.82L10.61 12.26A5 5 0 0 1 9.17 12.86L9.13 15.11A7.2 7.2 0 0 1 6.87 15.11L6.83 12.86A5 5 0 0 1 5.39 12.26L3.77 13.82A7.2 7.2 0 0 1 2.18 12.23L3.74 10.61A5 5 0 0 1 3.14 9.17L0.89 9.13A7.2 7.2 0 0 1 0.89 6.87L3.14 6.83A5 5 0 0 1 3.74 5.39L2.18 3.77A7.2 7.2 0 0 1 3.77 2.18L5.39 3.74A5 5 0 0 1 6.83 3.14L6.87 0.89A7.2 7.2 0 0 1 9.13 0.89L9.17 3.14A5 5 0 0 1 10.61 3.74L12.23 2.18A7.2 7.2 0 0 1 13.82 3.77L12.26 5.39A5 5 0 0 1 12.86 6.83Z" />
          <circle cx="8" cy="8" r="2.2" />
        </svg>
        <span>设置</span>
      </button>
    </aside>
  );
}
