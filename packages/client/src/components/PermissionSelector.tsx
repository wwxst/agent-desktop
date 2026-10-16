import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Shield, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { PermissionMode } from '../api.js';

const modes = [
  { value: 'ask', label: '请求批准', description: '工作区内编辑文件，目录授权、命令和插件操作前询问', icon: ShieldQuestion },
  { value: 'auto-review', label: '帮我批准', description: '由独立模型审查需要批准的操作', icon: ShieldCheck },
  { value: 'full-access', label: '完全访问权限', description: '允许访问本地文件并自动批准操作', icon: Shield },
] as const;

/** 权限选择只提交会话设置；实际审批和访问范围始终由宿主执行。 */
export function PermissionSelector({ mode, busy, disabled, onSelect }: {
  readonly mode: PermissionMode;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSelect: (mode: PermissionMode) => Promise<PermissionMode>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const restoreSelectionFocus = useRef(false);
  const current = modes.find(option => option.value === mode)!;
  const pending = busy || saving;
  const close = (restoreFocus = true) => {
    menu.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    menu.current!.showPopover({ source: trigger.current! });
    menu.current!.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (open || pending || !restoreSelectionFocus.current) return;
    restoreSelectionFocus.current = false;
    trigger.current?.focus();
  }, [open, pending]);

  const select = async (next: PermissionMode) => {
    setSaving(true);
    setError('');
    try {
      // 显示值由宿主保存后的 props 提供，不提前把一次点击显示成已生效。
      await onSelect(next);
      // 保存期间入口仍禁用；等宿主和本地等待状态提交后再恢复键盘焦点。
      restoreSelectionFocus.current = true;
      close(false);
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };

  return <div className="composer-permission-picker">
    <button ref={trigger} type="button" className="composer-permission-trigger" data-mode={mode}
      aria-label={`选择操作权限：${current.label}`} title={current.label} aria-haspopup="menu" aria-expanded={open}
      disabled={disabled || pending} onClick={() => { setError(''); if (open) close(); else setOpen(true); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <Shield size={14} aria-hidden="true" /><span>{mode === 'full-access' ? '完全访问' : current.label}</span>
    </button>
    <div ref={menu} className="composer-permission-menu" popover="auto" role="menu" aria-label="操作权限列表" aria-busy={pending}
      onToggle={event => { if (event.newState === 'closed') setOpen(false); }}
      onBlur={event => { if (event.relatedTarget instanceof Node && !menu.current!.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(false); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <p className="composer-permission-title">如何批准 Agent 的操作？</p>
      {modes.map(({ value, label, description, icon: Icon }) => <button key={value} type="button" role="menuitemradio"
        data-mode={value} aria-checked={mode === value} disabled={disabled || pending} onClick={() => void select(value)}>
        <Icon size={16} aria-hidden="true" />
        <span className="composer-permission-name">{label}<small>{description}</small></span>
        {mode === value && <Check size={15} aria-label="已选中" />}
      </button>)}
      {error && <p className="composer-permission-error" role="alert">{error}</p>}
      <p className="composer-permission-scope">本机命令和插件以当前用户权限运行。</p>
    </div>
  </div>;
}
