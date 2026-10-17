import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react';

export interface ExtensionNotice {
  readonly variant: 'installed' | 'success' | 'error' | 'progress';
  readonly message: string;
}

export function ExtensionOperationStatus({ loading }: { readonly loading: string }) {
  return <span className="extension-operation-status" role="status"><LoaderCircle size={16} aria-hidden="true" />{loading}</span>;
}

/** 列表、详情和弹窗使用同一结果样式；调用方只提供宿主确认后的文案与动作。 */
export function ExtensionToast({ notice, icon, onClose, onTry, tryDisabled }: {
  readonly notice: ExtensionNotice;
  readonly icon?: ReactNode;
  readonly onClose: () => void;
  readonly onTry?: () => void;
  readonly tryDisabled?: boolean;
}) {
  const toast = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = toast.current!;
    const dialog = element.closest('dialog');
    if (dialog === null) return;
    // 窄窗口中提示会换行；按真实高度为原生弹窗留位，避免遮住顶部操作。
    const reserveSpace = () => dialog.style.setProperty('--feedback-height', `${element.getBoundingClientRect().height}px`);
    reserveSpace();
    const observer = new ResizeObserver(reserveSpace);
    observer.observe(element);
    return () => { observer.disconnect(); dialog.style.removeProperty('--feedback-height'); };
  }, []);
  return <div ref={toast} className={`extension-toast extension-toast-${notice.variant}`} role={notice.variant === 'error' ? 'alert' : 'status'}>
    {notice.variant === 'progress' ? <LoaderCircle className="extension-toast-spinner" size={16} aria-hidden="true" />
      : notice.variant === 'error' ? <AlertCircle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
    {notice.variant === 'installed' && icon}
    <span className="extension-toast-message">{notice.message}</span>
    {onTry !== undefined && <button className="extension-toast-action" type="button" disabled={tryDisabled} onClick={onTry}>立即试用</button>}
    {notice.variant !== 'progress' && <button className="extension-toast-close" type="button" aria-label="关闭提示" title="关闭提示" onClick={onClose}><X size={14} /></button>}
  </div>;
}
