import { useId, useRef } from 'react';
import type { ConversationContextUsage, RuntimeSettings } from '../api.js';

/** 只展示宿主回传的最近一次模型用量；不把多次请求累加为上下文。 */
export function ContextUsage({ usage, settings }: {
  readonly usage?: ConversationContextUsage;
  readonly settings: RuntimeSettings | null;
}) {
  const tooltipId = useId();
  const tooltip = useRef<HTMLSpanElement>(null);
  const reference = settings?.conversationModel;
  const currentUsage = reference && usage?.model.providerId === reference.providerId && usage.model.modelId === reference.modelId ? usage : undefined;
  const contextWindow = settings?.modelProviders.find(provider => provider.id === reference?.providerId)?.models
    .find(model => model.id === reference?.modelId)?.contextWindow;
  const used = currentUsage === undefined ? undefined : currentUsage.inputTokens + currentUsage.outputTokens;
  const percent = used === undefined || contextWindow === undefined ? undefined : used / contextWindow * 100;
  const tokens = (count: number) => `${(count / 1_000).toFixed(1)}K`;
  const summary = settings === null ? '正在加载模型配置'
    : used === undefined ? '发送消息后显示上下文用量'
    : percent === undefined ? `${tokens(used)} 上下文已使用；当前模型未配置上下文上限`
    : `${percent.toFixed(1)}% · ${tokens(used)} / ${tokens(contextWindow!)} 上下文已使用`;

  return <span className="composer-context-usage" tabIndex={0} role="img" aria-label="上下文用量" aria-describedby={tooltipId}
    onMouseEnter={event => tooltip.current!.showPopover({ source: event.currentTarget })}
    onMouseLeave={event => { if (document.activeElement !== event.currentTarget) tooltip.current!.hidePopover(); }}
    onFocus={event => tooltip.current!.showPopover({ source: event.currentTarget })}
    onBlur={event => { if (!event.currentTarget.matches(':hover')) tooltip.current!.hidePopover(); }}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle className="composer-context-track" cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      {percent !== undefined && <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" pathLength="100"
        strokeDasharray={`${Math.min(percent, 100)} 100`} transform="rotate(-90 8 8)" />}
    </svg>
    {/* hint 由浏览器处理 Escape；悬停时焦点仍在输入框也能关闭，并保留已有菜单。 */}
    <span ref={tooltip} id={tooltipId} className="composer-context-tooltip" popover="hint" role="tooltip">
      {summary}
      {used !== undefined && <small>最近一次请求的输入与输出</small>}
    </span>
  </span>;
}
