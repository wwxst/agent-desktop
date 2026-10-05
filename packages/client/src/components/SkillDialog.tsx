import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, MessagesSquare, X } from 'lucide-react';
import type { ExtensionClientApi, ExtensionItem, ExtensionSnapshot } from '../api.js';
import { Markdown } from './Markdown.js';

interface SkillDialogProps {
  readonly skill: ExtensionItem;
  readonly api: ExtensionClientApi;
  readonly isProcessing: boolean;
  readonly parentEnabled: boolean;
  readonly icon: ReactNode;
  readonly onSnapshot: (snapshot: ExtensionSnapshot) => void;
  readonly onClose: () => void;
  readonly onTry?: (skill: ExtensionItem) => void;
}

/** 技能预览只读取正文；启停、文件动作和安装仍由现有宿主接口完成。 */
export function SkillDialog({ skill, api, isProcessing, parentEnabled, icon, onSnapshot, onClose, onTry }: SkillDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  useEffect(() => { dialog.current!.showModal(); }, []);
  useEffect(() => {
    let mounted = true;
    void api.readSkill(skill.id).then(text => { if (mounted) setContent(text); }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (mounted) setError(error.message);
    });
    return () => { mounted = false; };
  }, [api, skill.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const perform = async (operation: () => Promise<ExtensionSnapshot>, copied = false) => {
    setBusy(true); setMenuOpen(false); setError(null); setNotice(null);
    try { const next = await operation(); onSnapshot(next); if (copied) setNotice('已复制 Markdown'); return next; }
    catch (error) { if (!(error instanceof Error)) throw error; setError(error.message); }
    finally { setBusy(false); }
  };
  const disabled = busy || isProcessing;
  // 元数据在标题和说明中单独展示，正文保持 Markdown 排版。
  const body = content?.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  return <dialog ref={dialog} className="skill-dialog" aria-label={`${skill.displayName ?? skill.name}技能详情`}
    onCancel={event => { event.preventDefault(); if (menuOpen) setMenuOpen(false); else onClose(); }}>
    <div className="skill-dialog-top"><div className="skill-dialog-icon">{icon}</div><div className="skill-dialog-controls">
      <label className="skill-toggle" title={skill.enabled ? '停用' : '启用'}><input type="checkbox" role="switch" aria-label={`启用 ${skill.name}`} checked={skill.enabled}
        disabled={disabled || !skill.installed || !parentEnabled} onChange={event => void perform(() => api.setEnabled(skill.id, event.target.checked))} /><span aria-hidden="true" /></label>
      <div className="skill-menu-anchor" ref={menu}><button className="icon-button" type="button" aria-label="技能操作" aria-expanded={menuOpen} disabled={busy} onClick={() => setMenuOpen(!menuOpen)}><Ellipsis size={18} /></button>
        {menuOpen && <div className="skill-menu" role="menu">
          <button role="menuitem" type="button" onClick={() => void perform(() => api.manage({ action: 'open-skill', id: skill.id }))}>打开</button>
          <button role="menuitem" type="button" onClick={() => void perform(() => api.manage({ action: 'reveal-skill', id: skill.id }))}>在文件资源管理器中显示</button>
          <button role="menuitem" type="button" disabled={content === null} onClick={() => void perform(() => api.manage({ action: 'copy-skill', id: skill.id }), true)}>复制 Markdown</button>
          {skill.installed && skill.source !== 'project' && skill.pluginId === undefined && <button role="menuitem" type="button" disabled={disabled} onClick={() => { setMenuOpen(false); setConfirmUninstall(true); }}>卸载</button>}
        </div>}
      </div><button className="icon-button" type="button" aria-label="关闭技能详情" onClick={onClose}><X size={16} /></button>
    </div></div>
    <h2>{skill.displayName ?? skill.name} <span>Skill</span></h2>
    <p className="skill-dialog-description">{skill.shortDescription ?? skill.description}</p>
    {error !== null && <p className="extensions-error" role="alert">{error}</p>}{notice !== null && <p className="skill-dialog-notice" role="status">{notice}</p>}
    {confirmUninstall && <div className="extension-uninstall"><p>卸载“{skill.name}”？</p><button type="button" disabled={disabled} onClick={() => setConfirmUninstall(false)}>取消</button><button type="button" disabled={disabled} onClick={() => void perform(() => api.uninstall(skill.id)).then(next => { if (next !== undefined) onClose(); })}>确认卸载</button></div>}
    <div className="skill-dialog-body" tabIndex={0} aria-label="技能正文">{body === undefined ? <p role="status">{error === null ? '正在读取…' : '无法读取技能正文。'}</p> : <Markdown text={body} />}</div>
    {onTry !== undefined && <footer><button className="skill-try" type="button" disabled={disabled || (skill.installed && (!skill.enabled || !parentEnabled))} onClick={() => {
      if (skill.installed) onTry(skill);
      else void perform(() => api.install(skill.pluginId ?? skill.id)).then(next => {
        if (next !== undefined) onTry(next.skills.find(item => item.id === skill.id)!);
      });
    }}><MessagesSquare size={15} />{skill.installed ? '使用' : '安装并使用'}</button></footer>}
  </dialog>;
}
