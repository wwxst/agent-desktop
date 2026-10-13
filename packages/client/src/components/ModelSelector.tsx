import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react';
import type { RuntimeModelReference, RuntimeSettings } from '../api.js';
import { getConversationCapability, getVisionCapability } from '../model-capabilities.js';

/** 复用项目现有原生顶层浮层；宿主保存成功后才更新显示模型。 */
export function ModelSelector({ settings, settingsError, busy, disabled, onSelect, onConfigure }: {
  readonly settings: RuntimeSettings | null; readonly settingsError: string; readonly busy: boolean; readonly disabled: boolean;
  readonly onSelect: (reference: RuntimeModelReference) => Promise<RuntimeSettings>; readonly onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = settings?.modelProviders.flatMap(provider => provider.models
    .filter(model => getConversationCapability(model) !== 'unsupported')
    .map(model => ({ provider, model, selected: provider.id === settings.conversationModel.providerId && model.id === settings.conversationModel.modelId }))) ?? [];
  const current = options.find(option => option.selected);
  const label = current?.model.displayName ?? (settings === null ? '加载模型…' : settings.conversationModel.modelId);
  const close = (restoreFocus = true) => { menu.current?.hidePopover(); setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    menu.current!.showPopover({ source: trigger.current! });
    const selected = menu.current!.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
    (selected ?? menu.current!.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [open]);
  return <div className="composer-model-picker">
    <button ref={trigger} type="button" className="composer-model-trigger" aria-label={`选择对话模型：${label}`} title={current ? `${current.provider.displayName} · ${label}` : label}
      aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => { setError(''); if (open) close(); else setOpen(true); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <span>{label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    <div ref={menu} className="composer-model-menu" popover="auto" role="menu" aria-label="对话模型列表"
      onToggle={event => { if (event.newState === 'closed') setOpen(false); }}
      onBlur={event => { if (event.relatedTarget instanceof Node && !menu.current!.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(false); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <div className="composer-model-list">{options.map(({ provider, model, selected }) => {
        const reason = !provider.apiKey.configured ? '未配置密钥' : getConversationCapability(model) === 'unknown' ? '对话能力未知' : '';
        return <button key={`${provider.id}/${model.id}`} type="button" role="menuitemradio" aria-checked={selected} disabled={busy || !!reason}
          title={`${provider.displayName} · ${model.displayName}${reason ? ` · ${reason}` : ''}`} onClick={() => { setError(''); void onSelect({ providerId: provider.id, modelId: model.id })
            .then(() => close()).catch((failure: unknown) => { if (!(failure instanceof Error)) throw failure; setError(failure.message); }); }}>
          <span className="model-provider-icon" aria-label={provider.displayName}>{provider.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="composer-model-name">{model.displayName}<small>{provider.displayName}{reason ? ` · ${reason}` : getVisionCapability(model) === 'unknown' ? ' · 视觉能力未知' : ''}</small></span>
          {selected && <Check size={15} aria-label="已选中" />}
        </button>;
      })}</div>
      {(error || settingsError) && <p className="composer-model-error" role="alert">{error || settingsError}</p>}
      <button type="button" role="menuitem" className="composer-model-configure" onClick={() => { close(false); onConfigure(); }}><span>配置自定义模型</span><ArrowUpRight size={14} /></button>
    </div>
  </div>;
}
