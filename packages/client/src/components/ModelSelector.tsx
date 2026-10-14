import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react';
import type { RuntimeModelReference, RuntimeSettings } from '../api.js';
import { getConversationCapability, getVisionCapability } from '../model-capabilities.js';

// Simple Icons（CC0）公开品牌路径，本地随包渲染并跟随主题颜色，不在菜单打开时请求网络。
// DeepSeek: https://github.com/simple-icons/simple-icons/blob/develop/icons/deepseek.svg
// OpenAI: https://github.com/simple-icons/simple-icons/blob/14.15.0/icons/openai.svg
const providerIconPaths: Readonly<Record<string, string>> = {
  deepseek: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
  openai: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
};

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
          <span className={`model-provider-icon${providerIconPaths[provider.id] ? ' model-provider-brand' : ''}`} aria-label={provider.displayName}>
            {providerIconPaths[provider.id] ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={providerIconPaths[provider.id]} /></svg> : provider.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="composer-model-name">{model.displayName}<small>{provider.displayName}{reason ? ` · ${reason}` : getVisionCapability(model) === 'unknown' ? ' · 视觉能力未知' : ''}</small></span>
          {selected && <Check size={15} aria-label="已选中" />}
        </button>;
      })}</div>
      {(error || settingsError) && <p className="composer-model-error" role="alert">{error || settingsError}</p>}
      <button type="button" role="menuitem" className="composer-model-configure" onClick={() => { close(false); onConfigure(); }}><span>配置自定义模型</span><ArrowUpRight size={14} /></button>
    </div>
  </div>;
}
