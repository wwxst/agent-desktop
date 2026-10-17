import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, MessagesSquare, X } from 'lucide-react';
import type { ExtensionClientApi, ExtensionItem, ExtensionSnapshot } from '../api.js';
import { Markdown } from './Markdown.js';
import { ExtensionOperationStatus } from './ExtensionFeedback.js';
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog.js';

interface SkillDialogProps {
  readonly skill: ExtensionItem;
  readonly api: ExtensionClientApi;
  readonly isProcessing: boolean;
  readonly parentEnabled: boolean;
  readonly icon: ReactNode;
  readonly feedback: ReactNode;
  readonly loading?: string | undefined;
  readonly onPerform: (operation: () => Promise<ExtensionSnapshot | null>, loading: string, success: string, installed?: boolean) => Promise<ExtensionSnapshot | null | undefined>;
  readonly onError: (message: string) => void;
  readonly onClearFeedback: () => void;
  readonly onClose: () => void;
  readonly onTry?: (skill: ExtensionItem) => void;
}

/** 技能预览只读取正文；启停、文件动作和安装仍由现有宿主接口完成。 */
export function SkillDialog({ skill, api, isProcessing, parentEnabled, icon, feedback, loading, onPerform, onError, onClearFeedback, onClose, onTry }: SkillDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  useEffect(() => { dialog.current!.showModal(); }, []);
  useEffect(() => {
    let mounted = true;
    void api.readSkill(skill.id).then(text => { if (mounted) setContent(text); }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (mounted) { setReadFailed(true); onError(error.message); }
    });
    return () => { mounted = false; };
  }, [api, skill.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const perform = (operation: () => Promise<ExtensionSnapshot | null>, pending: string, success: string, installed = false) => {
    setMenuOpen(false);
    return onPerform(operation, pending, success, installed);
  };
  const disabled = isProcessing;
  // 元数据在标题和说明中单独展示，正文保持 Markdown 排版。
  const body = content?.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  return <><dialog ref={dialog} className="skill-dialog" aria-label={`${skill.displayName ?? skill.name}技能详情`}
    onCancel={event => { event.preventDefault(); if (menuOpen) setMenuOpen(false); else onClose(); }}>
    <div className="skill-dialog-top"><div className="skill-dialog-icon">{icon}</div><div className="skill-dialog-controls">
      <label className="skill-toggle" title={skill.enabled ? '停用' : '启用'}><input type="checkbox" role="switch" aria-label={`启用 ${skill.name}`} checked={skill.enabled}
        disabled={disabled || !skill.installed || !parentEnabled} onChange={event => { const enabled = event.target.checked; void perform(() => api.setEnabled(skill.id, enabled), enabled ? '正在启用' : '正在停用', `${skill.displayName ?? skill.name} 已${enabled ? '启用' : '停用'}`); }} /><span aria-hidden="true" /></label>
      <div className="skill-menu-anchor" ref={menu}><button ref={menuButton} className="icon-button" type="button" aria-label="技能操作" aria-expanded={menuOpen} disabled={loading !== undefined} onClick={() => setMenuOpen(!menuOpen)}><Ellipsis size={18} /></button>
        {menuOpen && <div className="skill-menu" role="menu">
          <button role="menuitem" type="button" disabled={disabled} onClick={() => void perform(() => api.manage({ action: 'open-skill', id: skill.id }), '正在打开', '已打开技能文件')}>打开</button>
          <button role="menuitem" type="button" disabled={disabled} onClick={() => void perform(() => api.manage({ action: 'reveal-skill', id: skill.id }), '正在定位', '已在文件资源管理器中显示')}>在文件资源管理器中显示</button>
          <button role="menuitem" type="button" disabled={disabled || content === null} onClick={() => void perform(() => api.manage({ action: 'copy-skill', id: skill.id }), '正在复制', '已复制 Markdown')}>复制 Markdown</button>
          {skill.installed && skill.source !== 'project' && skill.pluginId === undefined && <button role="menuitem" type="button" disabled={disabled} onClick={() => { setMenuOpen(false); onClearFeedback(); setConfirmUninstall(true); }}>卸载</button>}
        </div>}
      </div><button className="icon-button" type="button" aria-label="关闭技能详情" onClick={onClose}><X size={16} /></button>
    </div></div>
    <h2>{skill.displayName ?? skill.name} <span>Skill</span></h2>
    <p className="skill-dialog-description">{skill.shortDescription ?? skill.description}</p>
    {!confirmUninstall && feedback}
    <div className="skill-dialog-body" tabIndex={0} aria-label="技能正文">{body === undefined ? <p role="status">{readFailed ? '无法读取技能正文。' : '正在读取…'}</p> : <Markdown text={body} />}</div>
    {(onTry !== undefined || loading !== undefined) && <footer>{loading !== undefined ? <ExtensionOperationStatus loading={loading} /> : onTry !== undefined && <button className="skill-try" type="button" disabled={disabled || (skill.installed && (!skill.enabled || !parentEnabled))} onClick={() => {
      if (skill.installed) onTry(skill);
      else void perform(() => api.install(skill.pluginId ?? skill.id), '正在安装', `${skill.displayName ?? skill.name} 技能已安装`, true);
    }}><MessagesSquare size={15} />{skill.installed ? '使用' : '安装'}</button>}</footer>}
  </dialog>{confirmUninstall && <DeleteConfirmationDialog title={`卸载“${skill.displayName ?? skill.name}”？`} description="卸载后将无法继续使用该技能，现有聊天和生成的文件会保留。" confirmLabel="确认卸载" busy={loading !== undefined} disabled={disabled}
    onClose={() => setConfirmUninstall(false)} feedback={feedback} returnFocus={menuButton.current!}
    onConfirm={() => void perform(() => api.uninstall(skill.id), '正在卸载', `${skill.displayName ?? skill.name} 技能已卸载`).then(next => { if (next != null) onClose(); })} />}</>;
}
