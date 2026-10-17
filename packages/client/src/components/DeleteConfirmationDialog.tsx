import { useLayoutEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** 删除、移除和卸载共用现有会话删除样式，确认前不调用宿主。 */
export function DeleteConfirmationDialog({ title, description, confirmLabel, busy, disabled, onConfirm, onClose, feedback, returnFocus }: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly feedback?: ReactNode;
  readonly returnFocus?: HTMLElement;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    element.showModal();
    cancel.current!.focus();
    return () => {
      element.close();
      // 普通入口恢复原焦点；菜单项已被移除时使用调用方保留的菜单按钮。
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [returnFocus]);

  return <dialog ref={dialog} className="session-delete-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
    <button className="session-dialog-close" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId} className="delete-dialog-description">{description}</p>
    <div className="session-delete-actions">
      <button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="session-delete-confirm" type="button" disabled={busy || disabled} onClick={onConfirm}>{busy ? '正在处理…' : confirmLabel}</button>
    </div>
    {feedback}
  </dialog>;
}
