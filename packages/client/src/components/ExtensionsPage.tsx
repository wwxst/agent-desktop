import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CirclePlus, Download, Ellipsis, FolderClosed, FolderPlus, Globe, MessagesSquare, Paperclip, Plus, Puzzle, RefreshCw, Search, Settings, Trash2, X } from 'lucide-react';
import type { ExtensionClientApi, ExtensionItem, ExtensionSnapshot, McpServerSettings, McpServerUpdate } from '../api.js';
import { SkillDialog } from './SkillDialog.js';
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog.js';
import { ExtensionOperationStatus, ExtensionToast, type ExtensionNotice } from './ExtensionFeedback.js';

const categoryOrder = ['Communication', 'Creativity', 'Data & Analytics', 'Developer Tools', 'Productivity', 'Other'];
interface SecretInput { name: string; value: string; configured: boolean }
interface McpDraft { id?: string; name: string; transport: McpServerUpdate['transport']; command: string; args: string; url: string; environment: SecretInput[]; headers: SecretInput[] }
interface ExtensionFeedback {
  readonly id?: string;
  readonly name: string;
  readonly item?: ExtensionItem;
  readonly loading: string;
  readonly success: string;
  readonly variant?: 'installed' | 'success';
}
interface ExtensionOperation { readonly id?: string; readonly loading: string }
interface DeleteRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly operation: () => Promise<ExtensionSnapshot | null>;
  readonly feedback: ExtensionFeedback;
  readonly onSuccess?: () => void;
  readonly returnFocus?: HTMLElement;
}
type ItemNotice = ExtensionNotice & { readonly item?: ExtensionItem; readonly skillId?: string };

function mcpDraftFor(server?: McpServerSettings): McpDraft {
  return { ...(server === undefined ? {} : { id: server.id }), name: server?.name ?? '', transport: server?.transport ?? 'stdio', command: server?.command ?? '', args: server?.args.join('\n') ?? '', url: server?.url ?? '',
    environment: server?.environmentNames.map(name => ({ name, value: '', configured: true })) ?? [], headers: server?.headerNames.map(name => ({ name, value: '', configured: true })) ?? [] };
}
interface ExtensionsPageProps { readonly api: ExtensionClientApi; readonly view: 'plugins' | 'skills'; readonly isProcessing: boolean; readonly requestedId?: string; readonly onTrySkill?: (skill: ExtensionItem, prompt?: string) => void; readonly onBrowse?: (view: 'plugins' | 'skills') => void }

export function ExtensionIcon({ item }: { readonly item: ExtensionItem }) {
  return <span className={`extension-symbol ${item.kind}`} aria-hidden="true">{item.logo === undefined ? item.kind === 'plugin' ? <Puzzle size={22} /> : <svg width="24" height="24" viewBox="0 0 24 24"><path d="m12 2 8 4.5-8 4.5-8-4.5Z" fill="#ffcc60"/><path d="M4 6.5 12 11v11l-8-4.5Z" fill="#aa65ed"/><path d="m12 11 8-4.5v11L12 22Z" fill="#f79c45"/></svg> : <>
    <img className={item.logoDark === undefined ? '' : 'extension-logo-light'} src={item.logo} alt="" />{item.logoDark !== undefined && <img className="extension-logo-dark" src={item.logoDark} alt="" />}
  </>}</span>;
}

/** 目录、版本、连接与凭据由宿主维护；页面只收集操作意图和展示返回事实。 */
export function ExtensionsPage({ api, view, isProcessing, requestedId, onTrySkill, onBrowse }: ExtensionsPageProps) {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [managementTab, setManagementTab] = useState<'plugins' | 'mcp' | 'markets'>('plugins');
  const [filter, setFilter] = useState<'public' | 'personal'>('public');
  const [skillSource, setSkillSource] = useState<'project' | 'system'>('project');
  const [selectedId, setSelectedId] = useState<string | null>(requestedId ?? null);
  const [openedSkillId, setOpenedSkillId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<'settings' | 'marketplace' | 'connection' | 'mcp' | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(() => mcpDraftFor());
  const [marketSource, setMarketSource] = useState('');
  const [connection, setConnection] = useState('');
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [authorizing, setAuthorizing] = useState<{ id: string; server: string } | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [operation, setOperation] = useState<ExtensionOperation | null>(null);
  const [notice, setNotice] = useState<ItemNotice | null>(null);
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<string | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const detailMenu = useRef<HTMLDivElement>(null);
  const rowMenu = useRef<HTMLDivElement>(null);
  const isPlugin = view === 'plugins'; const title = isPlugin ? '插件' : '技能';
  const isManagement = onBrowse !== undefined;
  const Container = isManagement ? 'section' : 'main';
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void api.list().then(data => { if (mounted) setSnapshot(data); }).catch((error: unknown) => { if (mounted && error instanceof Error) setError(error.message); }); };
    refresh(); const unsubscribe = api.onChanged(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, [api]);
  useEffect(() => { setSelectedId(requestedId ?? null); setOpenedSkillId(null); setQuery(''); setContent(null); setDeleteRequest(null); setDetailMenuOpen(false); setRowMenuId(null); setAdding(false); setDialog(null); setMcpDraft(mcpDraftFor()); }, [view, requestedId]);
  useEffect(() => {
    if (selectedId === null) return;
    let mounted = true; setContent(null);
    const read = snapshot?.skills.some(item => item.id === selectedId) ? api.readSkill(selectedId) : api.readDetail(selectedId);
    void read.then(value => { if (mounted) setContent(value); }).catch((error: unknown) => { if (mounted && error instanceof Error) setError(error.message); });
    return () => { mounted = false; };
  }, [api, selectedId, snapshot]);
  useEffect(() => { if (dialog !== null) modal.current?.showModal(); }, [dialog]);
  useEffect(() => {
    if (!detailMenuOpen) return;
    const close = (event: PointerEvent) => { if (!detailMenu.current?.contains(event.target as Node)) setDetailMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetailMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [detailMenuOpen]);
  useEffect(() => {
    if (rowMenuId === null) return;
    const close = (event: PointerEvent) => { if (!rowMenu.current?.contains(event.target as Node)) setRowMenuId(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRowMenuId(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [rowMenuId]);
  useEffect(() => {
    if (!adding) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setAdding(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAdding(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [adding]);
  const perform = async (operationCall: () => Promise<ExtensionSnapshot | null>, feedback: ExtensionFeedback = { name: '扩展', loading: '正在处理', success: '操作已完成' }) => {
    if (busy || isProcessing) return;
    setBusy(true); setError(null); setNotice(null); setAdding(false); setRowMenuId(null);
    setOperation({ ...(feedback.id === undefined ? {} : { id: feedback.id }), loading: feedback.loading });
    try {
      const next = await operationCall();
      if (next !== null) setSnapshot(next);
      if (next !== null) {
        // 本地导入由目录选择器决定对象，使用返回快照中的新安装条目显示真实名称与技能。
        const item = feedback.id === undefined && feedback.variant === 'installed'
          ? [...next.plugins, ...next.skills].find(entry => entry.installed && ![...(snapshot?.plugins ?? []), ...(snapshot?.skills ?? [])].some(previous => previous.id === entry.id && previous.installed))
          : next.plugins.find(entry => entry.id === feedback.id) ?? next.skills.find(entry => entry.id === feedback.id) ?? feedback.item;
        const installedId = item?.id ?? feedback.id;
        const skill = feedback.variant === 'installed' ? next.skills.find(entry => (entry.pluginId === installedId || entry.id === installedId) && entry.installed && entry.enabled
          && (entry.pluginId === undefined || next.plugins.some(plugin => plugin.id === entry.pluginId && plugin.enabled))) : undefined;
        const message = feedback.variant === 'installed' && item !== undefined ? `${item.displayName ?? item.name} ${item.kind === 'plugin' ? '插件' : '技能'}已安装` : feedback.success;
        setNotice({ variant: feedback.variant ?? 'success', message, ...(item === undefined ? {} : { item }), ...(skill === undefined ? {} : { skillId: skill.id }) });
      }
      return next;
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setNotice({ variant: 'error', message: `${feedback.name}操作失败：${failure.message}` });
    } finally { setBusy(false); setOperation(null); }
  };
  const items = snapshot === null ? [] : isPlugin ? snapshot.plugins : snapshot.skills;
  const selected = items.find(item => item.id === selectedId);
  const selectedSkills = selected?.kind === 'plugin' ? snapshot?.skills.filter(skill => skill.pluginId === selected.id) ?? [] : [];
  const trialSkillFor = (id: string) => {
    const skills = snapshot?.skills.filter(skill => skill.pluginId === id) ?? [];
    return skills.find(skill => skill.installed && skill.enabled) ?? skills[0];
  };
  const trialSkill = selectedId === null ? undefined : trialSkillFor(selectedId);
  const suggestedSkills = selectedSkills.filter(skill => skill.defaultPrompt !== undefined);
  const openedSkill = snapshot?.skills.find(item => item.id === openedSkillId);
  const matches = (item: ExtensionItem) => `${item.name} ${item.displayName ?? ''} ${item.shortDescription ?? ''} ${item.description} ${(item.keywords ?? []).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const filtered = items.filter(matches); const disabled = busy || isProcessing;
  const snapshotError = snapshot?.errors?.join('\n') || undefined;
  const whisperModel = snapshot?.whisperModel;
  const modelProgress = whisperModel?.status === 'downloading'
    ? `正在下载模型 ${Math.floor(whisperModel.downloadedBytes / whisperModel.size * 100)}% · ${(whisperModel.downloadedBytes / 1048576).toFixed(1)} / ${(whisperModel.size / 1048576).toFixed(1)} MB`
    : whisperModel?.status === 'verifying' ? '正在校验模型' : undefined;
  const toast = (error === null ? notice : { variant: 'error' as const, message: error })
    ?? (snapshotError !== undefined && snapshotError !== dismissedSnapshotError ? { variant: 'error' as const, message: snapshotError } : null)
    ?? (busy && operation !== null && (operation.id === undefined || operation.id === selectedId) ? { variant: 'progress' as const, message: selectedId === 'plugin:whisper' ? modelProgress ?? operation.loading : operation.loading } : null);
  const closeToast = () => { setNotice(null); setError(null); if (notice === null && error === null && snapshotError !== undefined) setDismissedSnapshotError(snapshotError); };
  const noticeSkill = toast !== notice || notice?.skillId === undefined ? undefined : snapshot?.skills.find(skill => skill.id === notice.skillId && skill.installed && skill.enabled
    && (skill.pluginId === undefined || snapshot.plugins.some(plugin => plugin.id === skill.pluginId && plugin.enabled)));
  const toastElement = toast === null ? null : <ExtensionToast notice={toast} onClose={closeToast} tryDisabled={disabled}
    {...(notice?.item === undefined ? {} : { icon: <ExtensionIcon item={notice.item} /> })}
    {...(noticeSkill === undefined || onTrySkill === undefined ? {} : { onTry: () => { closeToast(); onTrySkill(noticeSkill); } })} />;
  const itemFeedback = (item: ExtensionItem, loading: string, success: string, variant?: 'installed'): ExtensionFeedback => ({ id: item.id, name: item.displayName ?? item.name, item, loading, success, ...(variant === undefined ? {} : { variant }) });
  const install = (item: ExtensionItem) => perform(() => api.install(item.pluginId ?? item.id), itemFeedback(item, '正在安装', `${item.displayName ?? item.name} ${item.kind === 'plugin' ? '插件' : '技能'}已安装`, 'installed'));
  const requestDelete = (request: DeleteRequest) => { setError(null); setNotice(null); setDeleteRequest(request); };
  const requestUninstall = (item: ExtensionItem, returnFocus: HTMLElement) => requestDelete({ title: `卸载“${item.displayName ?? item.name}”？`, description: '卸载后将无法使用该插件及其附带技能，现有聊天和生成的文件会保留。', confirmLabel: '确认卸载', returnFocus,
    operation: () => api.uninstall(item.id), feedback: itemFeedback(item, '正在卸载', `${item.displayName ?? item.name} 插件已卸载`), onSuccess: () => setSelectedId(null) });
  const requestRemoveMarket = (market: (NonNullable<ExtensionSnapshot['marketplaces']>)[number]) => requestDelete({ title: `移除“${market.name}”？`, description: '这只会移除该插件市场来源，已经安装的插件会保留。', confirmLabel: '移除市场',
    operation: () => api.manage({ action: 'remove-marketplace', id: market.id }), feedback: { name: market.name, loading: '正在移除市场', success: `${market.name} 市场已移除` } });
  const confirmDelete = async () => {
    const request = deleteRequest!;
    const next = await perform(request.operation, request.feedback);
    // 宿主成功返回后才关闭；失败继续在确认弹窗中展示同一条顶部提示。
    if (next != null) { request.onSuccess?.(); setDeleteRequest(null); }
  };
  const toggle = (item: ExtensionItem, pill = false) => <label className={pill ? 'skill-toggle' : 'extension-switch'} title={item.enabled ? '停用' : '启用'}>
    <input type="checkbox" role="switch" aria-label={`启用 ${item.name}`} checked={item.enabled} disabled={disabled || (item.pluginId !== undefined && snapshot?.plugins.find(plugin => plugin.id === item.pluginId)?.enabled !== true)} onChange={event => { const enabled = event.target.checked; void perform(() => api.setEnabled(item.id, enabled), itemFeedback(item, enabled ? '正在启用' : '正在停用', `${item.displayName ?? item.name} 已${enabled ? '启用' : '停用'}`)); }} /><span aria-hidden="true"><Check size={17} /></span>
  </label>;
  const row = (item: ExtensionItem, pill = false, managed = false) => {
    // 列表试用与详情试用一致，只准备第一个已启用技能的调用，不自动发送。
    const skill = trialSkillFor(item.id);
    const currentOperation = operation?.id === item.id ? operation : undefined;
    return <article className={`extension-row${currentOperation === undefined ? '' : ' extension-row-busy'}`} key={item.id}>
      <button className="extension-open" type="button" onClick={() => { setRowMenuId(null); if (item.kind === 'skill') setOpenedSkillId(item.id); else setSelectedId(item.id); }} aria-label={`查看 ${item.name}`}><ExtensionIcon item={item} /><span className="extension-summary"><strong><span className="extension-entry-name" title={item.displayName ?? item.name}>{item.displayName ?? item.name}</span>{managed ? item.displayName !== undefined && item.displayName !== item.name && <small>{item.name}</small> : item.kind === 'plugin' && <FolderClosed size={13} />}</strong><span title={item.shortDescription ?? item.description}>{item.shortDescription ?? item.description}</span></span></button>
      {currentOperation !== undefined ? <ExtensionOperationStatus loading={currentOperation.loading} /> : managed ? toggle(item, true) : item.installed ? item.kind === 'plugin' ? <div className="extension-row-actions" ref={rowMenuId === item.id ? rowMenu : undefined}>
        <button className="icon-button extension-row-more" type="button" aria-label={`${item.name}操作`} aria-haspopup="menu" aria-expanded={rowMenuId === item.id} disabled={busy} onClick={() => setRowMenuId(rowMenuId === item.id ? null : item.id)}><Ellipsis size={18} /></button>
        {rowMenuId === item.id && <div className="skill-menu extension-row-menu" role="menu" aria-label={`${item.name}操作`}>
          <button type="button" role="menuitem" disabled={disabled || !item.enabled || skill === undefined || !skill.enabled || onTrySkill === undefined} onClick={() => { setRowMenuId(null); if (skill !== undefined) onTrySkill?.(skill); }}><MessagesSquare size={17} />立即试用</button>
          <button type="button" role="menuitem" onClick={() => { setRowMenuId(null); setSelectedId(item.id); }}><Settings size={17} />管理</button>
          <button className="extension-row-uninstall" type="button" role="menuitem" disabled={disabled} onClick={() => { const trigger = rowMenu.current!.querySelector<HTMLButtonElement>('button')!; setRowMenuId(null); requestUninstall(item, trigger); }}><Trash2 size={17} />卸载</button>
        </div>}
      </div> : toggle(item, pill) : <button className="icon-button extension-install" type="button" aria-label={`安装 ${item.name}`} title={`安装 ${item.name}`} disabled={disabled || item.installable === false} onClick={() => void install(item)}><Plus size={20} /></button>}
    </article>;
  };
  const section = (name: string, entries: readonly ExtensionItem[], className = '') => entries.length === 0 ? null : <section className={`extension-section ${className}`} aria-label={name} key={name}><h2>{name}</h2><div className="extension-grid">{entries.map(item => row(item))}</div></section>;
  // 随包提供的插件面向所有用户公开分发，安装后仍留在公开目录。
  const publicItems = filtered.filter(item => item.source === 'builtin' || item.source === 'marketplace');
  const categories = [...new Set(publicItems.map(item => item.category ?? 'Other'))].sort((a, b) => { const l = categoryOrder.indexOf(a); const r = categoryOrder.indexOf(b); return (l < 0 ? 99 : l) - (r < 0 ? 99 : r) || a.localeCompare(b); });
  const pluginGroups = filter === 'public' ? categories.map(category => section(category, publicItems.filter(item => (item.category ?? 'Other') === category), 'extension-market-section')) : [section('已安装', filtered.filter(item => item.installed && item.source !== 'builtin'))];
  const openConnection = (name: string) => { setConnection(name); setConnectionValues({}); setError(null); setDialog('connection'); };
  const service = selected?.connections?.find(item => item.name === connection);
  const connect = async (item: Pick<ExtensionItem, 'id'>, service: Pick<NonNullable<ExtensionItem['connections']>[number], 'name' | 'connected'>) => {
    if (!service.connected) setAuthorizing({ id: item.id, server: service.name });
    try { await perform(() => api.manage({ action: service.connected ? 'disconnect' : 'connect', id: item.id, server: service.name }), { name: service.name, loading: service.connected ? '正在断开' : '正在等待账户授权', success: `${service.name} 已${service.connected ? '断开' : '连接'}` }); }
    finally { setAuthorizing(null); }
  };
  const installedPlugins = snapshot?.plugins.filter(item => item.installed) ?? [];
  const mcpPlugins = installedPlugins.filter(item => item.connections?.some(service => service.transport !== 'app'));
  const mcpCount = mcpPlugins.reduce((count, item) => count + item.connections!.filter(service => service.transport !== 'app').length, 0);
  const markets = snapshot?.marketplaces ?? [];
  const standalone = snapshot?.mcpServers ?? [];
  const editedMcp = standalone.find(server => server.id === mcpDraft.id);
  const openMcp = (server?: McpServerSettings) => { setAdding(false); setError(null); setMcpDraft(mcpDraftFor(server)); setDialog('mcp'); };
  const closeDialog = () => { setDialog(null); setMcpDraft(mcpDraftFor()); };
  const secretFields = (kind: 'environment' | 'headers', label: string) => <fieldset className="mcp-secret-fields"><legend>{label}</legend>{mcpDraft[kind].map((entry, index) => <div className="mcp-secret-row" key={index}>
    <input aria-label={`${label} ${index + 1} 名称`} placeholder="名称" value={entry.name} onChange={event => setMcpDraft({ ...mcpDraft, [kind]: mcpDraft[kind].map((value, at) => at === index ? { ...value, name: event.target.value, configured: false } : value) })} />
    <input aria-label={`${label} ${index + 1} 值`} type="password" autoComplete="off" placeholder={entry.configured ? '••••••••' : '值'} value={entry.value} onChange={event => setMcpDraft({ ...mcpDraft, [kind]: mcpDraft[kind].map((value, at) => at === index ? { ...value, value: event.target.value } : value) })} />
    <button className="icon-button" type="button" aria-label={`移除${label} ${index + 1}`} onClick={() => setMcpDraft({ ...mcpDraft, [kind]: mcpDraft[kind].filter((_value, at) => at !== index) })}><X size={16} /></button>
  </div>)}<button className="extension-add" type="button" onClick={() => setMcpDraft({ ...mcpDraft, [kind]: [...mcpDraft[kind], { name: '', value: '', configured: false }] })}><Plus size={14} />添加{label}</button></fieldset>;
  const filteredStandalone = standalone.filter(server => `${server.name} ${server.command} ${server.url}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const filteredMcp = mcpPlugins.filter(item => matches(item) || item.connections?.some(service => service.transport !== 'app' && service.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const filteredMarkets = markets.filter(market => `${market.name} ${market.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const searchLabel = isManagement ? managementTab === 'mcp' ? '搜索 MCP 服务器' : managementTab === 'markets' ? '搜索市场' : '搜索插件' : `搜索${title}`;
  return <Container className={`extensions-page${isManagement ? ' plugin-settings' : ''}`} aria-label={`${title}管理`} onKeyDown={event => {
    if (!isManagement || event.key !== 'Escape') return;
    // 弹层先处理 Escape，避免同一按键同时把整个设置页关闭。
    if (dialog !== null || openedSkill !== undefined || deleteRequest !== null) { event.stopPropagation(); return; }
    if (adding || detailMenuOpen || rowMenuId !== null) {
      event.preventDefault(); event.stopPropagation(); setAdding(false); setDetailMenuOpen(false); setRowMenuId(null);
    }
  }}><div className="extensions-content">
    {selected === undefined && <header className="extensions-header"><div><h1>{title}</h1><p className="extensions-subtitle">{isManagement ? '管理插件、技能和 MCP' : isPlugin ? '管理已安装插件，或添加本地插件和市场来源' : '通过任务专用技能扩展 Agent Desktop'}</p></div>
      {isManagement ? <div className="extensions-toolbar"><button className="extension-browse" type="button" onClick={() => onBrowse('plugins')}>浏览目录</button>
        <div className="extension-add-menu" ref={menu}><button className="extension-add" type="button" aria-label="添加插件" disabled={disabled} aria-expanded={adding} onClick={() => setAdding(!adding)}>添加<ChevronDown size={13} /></button>{adding && <div className="extension-menu" role="menu"><button type="button" role="menuitem" disabled><CirclePlus size={14} />创建插件</button><button type="button" role="menuitem" onClick={() => { setAdding(false); setMarketSource(''); setDialog('marketplace'); }}><Plus size={16} />添加插件市场</button><button type="button" role="menuitem" onClick={() => openMcp()}><Paperclip size={15} />添加 MCP 服务器</button></div>}</div>
      </div> : <>
      <div className="extensions-toolbar"><label className="extension-search"><Search size={15} aria-hidden="true" /><input aria-label={`搜索${title}`} placeholder={`搜索${title}`} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button className="icon-button" type="button" aria-label={`刷新${title}`} title="刷新" disabled={disabled} onClick={() => void perform(() => api.reconcile(), { name: title, loading: '正在刷新', success: `${title}目录已刷新` })}><RefreshCw size={16} /></button>
        <button className="icon-button" type="button" aria-label={`${title}设置`} title="设置" onClick={() => { setDialog('settings'); setError(null); }}><Settings size={16} /></button>
        <div className="extension-add-menu" ref={menu}><button className="extension-add" type="button" aria-label={`添加${title}`} disabled={disabled} aria-expanded={isPlugin ? adding : undefined} onClick={() => isPlugin ? setAdding(!adding) : void perform(() => api.importLocal('skill'), { name: '技能', loading: '正在安装', success: '技能已安装', variant: 'installed' })}>添加{isPlugin && <ChevronDown size={13} />}</button>{adding && <div className="extension-menu" role="menu"><button type="button" role="menuitem" onClick={() => void perform(() => api.importLocal('plugin'), { name: '插件', loading: '正在安装', success: '插件已安装', variant: 'installed' })}><FolderPlus size={16} />从本地文件夹添加</button><button type="button" role="menuitem" onClick={() => { setAdding(false); setMarketSource(''); setDialog('marketplace'); }}><Plus size={16} />添加插件市场</button></div>}</div>
      </div>
      </>}
    </header>}
    {isProcessing && <p className="extensions-notice" role="status">任务执行中，扩展暂时无法修改。</p>}
    {snapshot === null ? <p role="status">{error === null ? '正在加载…' : '扩展未加载。'}</p> : selected === undefined ? <>
      {isManagement ? <><div className="plugin-settings-controls"><div className="extension-tabs" role="tablist" aria-label="插件管理分类">{([
        ['plugins', '插件', installedPlugins.length], ['mcp', 'MCP', mcpCount + standalone.length], ['markets', '市场', markets.length],
      ] as const).map(([id, label, count]) => <button key={id} type="button" role="tab" aria-selected={managementTab === id} onClick={() => { setManagementTab(id); setQuery(''); }}>{label} <span>{count}</span></button>)}</div><label className="extension-search"><Search size={15} aria-hidden="true" /><input aria-label={searchLabel} placeholder={searchLabel} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
        {managementTab === 'plugins' && <div className="plugin-settings-list">{installedPlugins.filter(matches).map(item => row(item, true, true))}{installedPlugins.filter(matches).length === 0 && <p className="extensions-empty">{query.trim() ? '没有匹配结果' : '暂无已安装的插件'}</p>}</div>}
        {managementTab === 'mcp' && <>
          {standalone.length > 0 && <section className="plugin-settings-mcp" aria-label="独立 MCP 服务器"><h2>服务器</h2>{filteredStandalone.map(server => <div className="plugin-mcp-row" key={server.id}><span className="mcp-server-name">{server.name}</span><button className="icon-button" type="button" aria-label={`配置 ${server.name}`} onClick={() => openMcp(server)}><Settings size={15} /></button><label className="skill-toggle"><input type="checkbox" role="switch" aria-label={`启用 MCP ${server.name}`} checked={server.enabled} disabled={disabled} onChange={event => void perform(() => api.manage({ action: 'set-mcp-enabled', id: server.id, enabled: event.target.checked }))} /><span aria-hidden="true" /></label></div>)}</section>}
          {mcpPlugins.length > 0 && <section className="plugin-settings-mcp" aria-label="来自插件的 MCP"><h2>来自插件</h2>{filteredMcp.map(item => <button className="plugin-mcp-row" type="button" key={item.id} onClick={() => setSelectedId(item.id)}><span>{item.displayName ?? item.name}</span><span className="plugin-mcp-names">{item.connections?.filter(service => service.transport !== 'app').map(service => service.name).join('、')}</span></button>)}</section>}
          {filteredMcp.length + filteredStandalone.length === 0 && <p className="extensions-empty">{query.trim() ? '没有匹配结果' : '暂无 MCP 服务器'}</p>}
        </>}
        {managementTab === 'markets' && <div className="plugin-settings-list">{filteredMarkets.map(market => <article className="plugin-market-row" key={market.id}><span className="extension-symbol plugin" aria-hidden="true"><Globe size={20} /></span><div className="plugin-market-summary"><strong>{market.name}</strong><span>{snapshot.plugins.filter(plugin => plugin.marketplaceId === market.id).length} 个插件</span><span title={market.source}>{market.source}</span></div><button className="plugin-market-update" type="button" disabled={disabled} title="刷新所有市场目录" onClick={() => void perform(() => api.reconcile())}>升级</button><button className="icon-button" type="button" aria-label={`移除 ${market.name}`} disabled={disabled} onClick={() => requestRemoveMarket(market)}><Trash2 size={15} /></button></article>)}{filteredMarkets.length === 0 && <p className="extensions-empty">{query.trim() ? '没有匹配结果' : '暂无插件市场'}</p>}</div>}
      </> : isPlugin ? <><div className="extension-tabs" role="tablist" aria-label="插件筛选"><button type="button" role="tab" aria-selected={filter === 'public'} onClick={() => setFilter('public')}>公开</button><button type="button" role="tab" aria-selected={filter === 'personal'} onClick={() => setFilter('personal')}>个人</button></div>{pluginGroups}</> : <>
        {section('已安装', filtered.filter(item => item.installed), 'extension-installed-section')}
        <div className="extension-tabs extension-source-tabs" role="tablist" aria-label="技能来源"><button type="button" role="tab" aria-selected={skillSource === 'project'} onClick={() => setSkillSource('project')}>当前项目</button><button type="button" role="tab" aria-selected={skillSource === 'system'} onClick={() => setSkillSource('system')}>系统</button></div>
        <div className="extension-grid">{filtered.filter(item => skillSource === 'project' ? item.source === 'project' : item.installed && (item.source === 'builtin' || item.source === 'plugin')).map(item => row(item))}</div>{section('可安装', filtered.filter(item => !item.installed))}
      </>}{!isManagement && (filtered.length === 0 || (isPlugin && pluginGroups.every(group => group === null))) && <p className="extensions-empty">{query.trim() ? '没有匹配结果' : '暂无已安装的扩展'}</p>}
    </> : <section className="extension-detail" aria-label={`${selected.name}详情`}>
      <button className="extension-back" type="button" onClick={() => setSelectedId(null)}><ArrowLeft size={16} />返回{title}</button>
      <div className="extension-detail-heading extension-detail-heading-rich">
        <ExtensionIcon item={selected} />
        <div className="extension-detail-title"><h2>{selected.displayName ?? selected.name}</h2><p>{selected.shortDescription ?? selected.description}</p></div>
        <div className="extension-detail-actions">
          {selected.installed && toggle(selected, true)}
          {selected.installed ? <div className="extension-detail-menu" ref={detailMenu}>
            <button className="icon-button" type="button" aria-label="插件操作" aria-expanded={detailMenuOpen} disabled={busy} onClick={() => setDetailMenuOpen(!detailMenuOpen)}><Ellipsis size={18} /></button>
            {detailMenuOpen && <div className="skill-menu extension-detail-menu-popover" role="menu"><button role="menuitem" type="button" disabled={disabled} onClick={() => { setDetailMenuOpen(false); requestUninstall(selected, detailMenu.current!.querySelector<HTMLButtonElement>('button')!); }}><Trash2 size={15} />卸载</button></div>}
          </div> : <button className="extension-add" type="button" disabled={disabled || selected.installable === false} onClick={() => void install(selected)}>安装</button>}
          {trialSkill !== undefined && onTrySkill !== undefined && <button className="skill-try" type="button" disabled={disabled || !selected.enabled || !trialSkill.enabled} onClick={() => onTrySkill(trialSkill)}><MessagesSquare size={15} />使用</button>}
        </div>
      </div>
      {selected.screenshots?.length ? <div className="extension-screenshots">{selected.screenshots.map(src => <img src={src} alt={`${selected.name}功能预览`} key={src} />)}</div> : suggestedSkills.length > 0 && <section className="extension-prompt-hero" aria-label="建议指令"><div className="extension-prompt-stack">{suggestedSkills.map(skill => <button className="extension-prompt-card" type="button" key={skill.id} disabled={disabled || !selected.enabled || !skill.enabled || onTrySkill === undefined} onClick={() => onTrySkill?.(skill, skill.defaultPrompt)}><span><ExtensionIcon item={skill} /><strong>{skill.displayName ?? skill.name}</strong><ArrowRight size={15} /></span><small>{skill.defaultPrompt}</small></button>)}</div></section>}
      <p className="extension-description extension-detail-lead">{selected.longDescription ?? selected.description}</p>
      {selected.id === 'plugin:whisper' && selected.source === 'builtin' && whisperModel !== undefined && <section className="extension-detail-section whisper-model-section" aria-label="语音识别模型"><h3>语音识别模型</h3>
        <div className="extension-connection"><div><strong>{whisperModel.name}</strong><p>多语言 · CPU · {(whisperModel.size / 1048576).toFixed(1)} MB</p><p>{whisperModel.status === 'ready' ? `已安装 · 磁盘占用 ${(whisperModel.diskBytes / 1048576).toFixed(1)} MB` : modelProgress ?? (whisperModel.status === 'error' ? whisperModel.message : '未安装')}</p></div>
          <div className="whisper-model-actions">{whisperModel.status === 'ready' ? <button className="icon-button" type="button" title="删除模型" aria-label="删除 Whisper 模型" disabled={disabled} onClick={() => requestDelete({ title: `删除 ${whisperModel.name} 模型？`, description: '删除本机语音识别模型后，需要重新安装才能使用语音识别。', confirmLabel: '确认删除模型', operation: () => api.manage({ action: 'delete-whisper-model' }), feedback: itemFeedback(selected, '正在删除模型', `${whisperModel.name} 模型已删除`) })}><Trash2 size={17} /></button> : <>
            <button className="extension-add" type="button" disabled={disabled || !selected.installed} onClick={() => void perform(() => api.manage({ action: 'install-whisper-model' }), itemFeedback(selected, '正在安装模型', `${whisperModel.name} 模型已安装`))}><Download size={16} />安装模型</button>
            <button className="icon-button" type="button" title="选择本地模型" aria-label="选择本地 Whisper 模型" disabled={disabled || !selected.installed} onClick={() => void perform(() => api.manage({ action: 'import-whisper-model' }), itemFeedback(selected, '正在校验模型', `${whisperModel.name} 模型已安装`))}><FolderPlus size={17} /></button>
          </>}</div>
        </div>
        {(whisperModel.status === 'downloading' || whisperModel.status === 'verifying') && <progress aria-label="Whisper 模型安装进度" value={whisperModel.downloadedBytes} max={whisperModel.size} />}
      </section>}
      {selected.defaultPrompt !== undefined || (selected.defaultPrompts?.length ?? 0) > 0 ? <div className="extension-detail-section extension-suggestions"><h3>建议指令</h3>{(selected.defaultPrompts ?? (selected.defaultPrompt === undefined ? [] : [selected.defaultPrompt])).map(prompt => <p className="extension-prompt" key={prompt}>{prompt}</p>)}</div> : null}
      {selected.skillNames?.length ? <section className="plugin-skills" aria-label="附带技能"><h3>技能 <span>{selected.skillNames.length}</span></h3>{selectedSkills.map(skill => row(skill, true))}</section> : null}
      <section className="extension-info" aria-label="信息"><h3>信息</h3><dl>{selected.capabilities?.length ? <><dt>功能</dt><dd>{selected.capabilities.join(', ')}</dd></> : null}{selected.developerName && <><dt>开发者</dt><dd>{selected.developerName}</dd></>}{selected.category && <><dt>类别</dt><dd>{selected.category}</dd></>}{selected.version && <><dt>版本</dt><dd>{selected.version}</dd></>}{selected.websiteUrl && <><dt>网站</dt><dd><a href={selected.websiteUrl} target="_blank" rel="noreferrer" aria-label="网站" title={selected.websiteUrl}><Globe size={14} /></a></dd></>}{selected.privacyPolicyUrl && <><dt>隐私政策</dt><dd><a href={selected.privacyPolicyUrl} target="_blank" rel="noreferrer" aria-label="隐私政策" title={selected.privacyPolicyUrl}><Globe size={14} /></a></dd></>}{selected.termsOfServiceUrl && <><dt>服务条款</dt><dd><a href={selected.termsOfServiceUrl} target="_blank" rel="noreferrer" aria-label="服务条款" title={selected.termsOfServiceUrl}><Globe size={14} /></a></dd></>}</dl></section>
      {selected.dependencies?.length ? <div className="extension-detail-section"><h3>工具依赖</h3><ul>{selected.dependencies.map(dependency => <li key={dependency}>{dependency}</li>)}</ul></div> : null}
      {selected.connections?.length ? <div className="extension-detail-section"><h3>连接</h3>{selected.connections.map(service => <div className="extension-connection" key={service.name}><div><strong>{service.name}</strong><p>{service.transport === 'app' ? '需要账户服务的连接地址' : service.url ?? '本地工具服务'}</p></div>{(service.transport !== 'stdio' || (service.variables?.length ?? 0) > 0) && <button type="button" disabled={disabled} onClick={() => openConnection(service.name)}>配置</button>}{service.url !== undefined && <button type="button" disabled={disabled} onClick={() => void connect(selected, service)}>{service.connected ? '断开' : '连接账户'}</button>}</div>)}</div> : null}
      {selected.installed && (selected.marketplaceId !== undefined || (selected.kind === 'plugin' && selected.source === 'builtin')) && <button className="extension-back" type="button" disabled={disabled} onClick={() => void perform(() => api.manage({ action: 'update', id: selected.id }), itemFeedback(selected, '正在检查更新', `${selected.displayName ?? selected.name} 更新检查完成`))}>{selected.availableVersion === undefined ? '检查更新' : `更新至 ${selected.availableVersion}`}</button>}
      {selected.versions?.length ? <div className="extension-detail-section"><h3>历史版本</h3>{selected.versions.map(version => <div className="extension-connection" key={version.id}><span>{version.version} · {new Date(version.createdAt).toLocaleString()}</span><button type="button" disabled={disabled} onClick={() => void perform(() => api.manage({ action: 'rollback', id: selected.id, versionId: version.id }), itemFeedback(selected, '正在回滚', `${selected.displayName ?? selected.name} 已回滚至 ${version.version}`))}>回滚</button></div>)}</div> : null}
      <details className="extension-detail-section" open={!isPlugin}><summary>{isPlugin ? '插件清单' : '技能指令'}</summary><pre>{content ?? '正在读取…'}</pre>{selected.path !== undefined && <p className="extension-path">{selected.path}</p>}</details>
    </section>}
    {authorizing !== null && <p className="extensions-notice" role="status">正在等待浏览器中的账户授权… <button className="extension-back" type="button" onClick={() => { void api.manage({ action: 'cancel-connect', ...authorizing }).catch((error: unknown) => { if (error instanceof Error) setError(error.message); }); }}>取消连接</button></p>}
  </div>{dialog !== null && <dialog ref={modal} className="extension-dialog" aria-label={dialog === 'settings' ? `${title}设置` : dialog === 'marketplace' ? '添加插件市场' : dialog === 'mcp' ? mcpDraft.id === undefined ? '添加 MCP 服务器' : '配置 MCP 服务器' : '连接配置'} onCancel={event => { event.preventDefault(); if (!busy) closeDialog(); }}>
    <header><h2>{dialog === 'settings' ? `${title}设置` : dialog === 'marketplace' ? '添加插件市场' : dialog === 'mcp' ? mcpDraft.id === undefined ? '添加 MCP 服务器' : '配置 MCP 服务器' : '连接配置'}</h2><button className="icon-button" type="button" aria-label="关闭" disabled={busy} onClick={closeDialog}><X size={18} /></button></header>
    {dialog === 'mcp' ? <form onSubmit={event => {
      event.preventDefault();
      const entries = mcpDraft.transport === 'stdio' ? mcpDraft.environment : mcpDraft.headers;
      const names = entries.map(entry => entry.name.trim());
      if (names.some(name => name === '') || new Set(names).size !== names.length) { setError('变量名称不能为空或重复。'); return; }
      const values = Object.fromEntries(entries.map((entry, index) => [names[index]!, entry.value]));
      void perform(async () => { const next = await api.manage({ action: 'save-mcp-server', server: { ...(mcpDraft.id === undefined ? {} : { id: mcpDraft.id }), name: mcpDraft.name, transport: mcpDraft.transport, command: mcpDraft.command, args: mcpDraft.args === '' ? [] : mcpDraft.args.split('\n'), url: mcpDraft.url, environment: mcpDraft.transport === 'stdio' ? values : {}, headers: mcpDraft.transport === 'stdio' ? {} : values } }); closeDialog(); setManagementTab('mcp'); setQuery(''); return next; });
    }}><fieldset className="mcp-editor-fields" disabled={disabled}>
      <label>服务器名称<input autoFocus required value={mcpDraft.name} onChange={event => setMcpDraft({ ...mcpDraft, name: event.target.value })} /></label>
      <label>传输方式<select value={mcpDraft.transport} onChange={event => setMcpDraft({ ...mcpDraft, transport: event.target.value as McpDraft['transport'] })}><option value="stdio">本地命令（stdio）</option><option value="http">HTTP</option><option value="sse">SSE</option></select></label>
      {mcpDraft.transport === 'stdio' ? <><label>启动命令<input required value={mcpDraft.command} placeholder="npx" onChange={event => setMcpDraft({ ...mcpDraft, command: event.target.value })} /></label><label>启动参数（每行一个）<textarea rows={3} value={mcpDraft.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} onChange={event => setMcpDraft({ ...mcpDraft, args: event.target.value })} /></label>{secretFields('environment', '环境变量')}</> : <><label>服务器地址<input required type="url" value={mcpDraft.url} placeholder="https://…/mcp" onChange={event => setMcpDraft({ ...mcpDraft, url: event.target.value })} /></label>{secretFields('headers', '请求头')}</>}
      <div className="mcp-editor-actions"><button className="extension-add" type="submit">保存</button>{editedMcp !== undefined && <button className="extension-add mcp-delete" type="button" onClick={() => requestDelete({ title: `删除“${editedMcp.name}”？`, description: '删除此 MCP 服务器后，将无法继续调用它提供的工具。', confirmLabel: '确认删除服务器', operation: () => api.manage({ action: 'remove-mcp-server', id: editedMcp.id }), feedback: { name: editedMcp.name, loading: '正在删除服务器', success: `${editedMcp.name} 服务器已删除` }, onSuccess: closeDialog })}>删除服务器</button>}
      {editedMcp !== undefined && editedMcp.transport !== 'stdio' && <button className="extension-add" type="button" onClick={() => void connect({ id: editedMcp.id }, editedMcp)}>{editedMcp.connected ? '断开账户' : '连接账户'}</button>}</div>
    </fieldset>{authorizing !== null && <button className="extension-back" type="button" onClick={() => { void api.manage({ action: 'cancel-connect', ...authorizing }).catch((error: unknown) => { if (error instanceof Error) setError(error.message); }); }}>取消连接</button>}</form> : dialog === 'settings' ? <><h3>插件市场</h3><p>从已添加的来源发现和安装插件。</p>{(snapshot?.marketplaces ?? []).map(market => <div className="extension-connection" key={market.id}><div><strong>{market.name}</strong><p>{market.source}</p></div><button type="button" disabled={disabled} onClick={() => requestRemoveMarket(market)}>移除</button></div>)}<button className="extension-add" type="button" disabled={disabled} onClick={() => { setMarketSource(''); setDialog('marketplace'); }}>添加插件市场</button><button className="extension-back" type="button" disabled={disabled} onClick={() => void perform(() => api.reconcile())}>刷新所有来源</button></> : dialog === 'marketplace' ? <form onSubmit={event => { event.preventDefault(); void perform(async () => { const next = await api.manage({ action: 'add-marketplace', source: marketSource }); setDialog(null); return next; }); }}><p>输入 Git 仓库地址、GitHub 的 owner/repo，或本地市场目录。</p><label>市场来源<input autoFocus value={marketSource} placeholder="https://github.com/openai/plugins.git" onChange={event => setMarketSource(event.target.value)} /></label><button className="extension-add" type="submit" disabled={disabled || !marketSource.trim()}>添加</button></form> : <form onSubmit={event => { event.preventDefault(); if (selected !== undefined) void perform(async () => { const next = await api.manage({ action: 'configure', id: selected.id, server: connection, values: connectionValues }); setDialog(null); setConnectionValues({}); return next; }); }}>
      <p>{connection}</p>{(service?.transport === 'app' || service?.url !== undefined) && <label>连接地址<input type="url" placeholder={service?.url ?? 'https://…/mcp'} value={connectionValues.url ?? ''} onChange={event => setConnectionValues({ ...connectionValues, url: event.target.value })} /></label>}{service?.variables?.map(variable => <label key={variable}>{variable}<input type="password" autoComplete="off" value={connectionValues[variable] ?? ''} onChange={event => setConnectionValues({ ...connectionValues, [variable]: event.target.value })} /></label>)}<p>密钥使用操作系统加密保存。账户授权在系统浏览器中完成。</p><button className="extension-add" type="submit" disabled={disabled || Object.values(connectionValues).every(value => value === '')}>保存</button>
    </form>}{deleteRequest === null && toastElement}
  </dialog>}{dialog === null && openedSkill === undefined && deleteRequest === null && toastElement}{openedSkill !== undefined && <SkillDialog skill={openedSkill} api={api} isProcessing={disabled}
    parentEnabled={openedSkill.pluginId === undefined || snapshot?.plugins.find(plugin => plugin.id === openedSkill.pluginId)?.enabled === true}
    icon={<ExtensionIcon item={openedSkill} />} feedback={toastElement} loading={operation?.id === openedSkill.id ? operation.loading : undefined}
    onPerform={(call, loading, success, installed) => perform(call, itemFeedback(openedSkill, loading, success, installed ? 'installed' : undefined))}
    onError={message => setNotice({ variant: 'error', message })} onClearFeedback={() => { setError(null); setNotice(null); }} onClose={() => setOpenedSkillId(null)}
    {...(onTrySkill === undefined ? {} : { onTry: onTrySkill })} />}{deleteRequest !== null && <DeleteConfirmationDialog title={deleteRequest.title} description={deleteRequest.description} confirmLabel={deleteRequest.confirmLabel} busy={busy} disabled={isProcessing}
      onConfirm={() => void confirmDelete()} onClose={() => setDeleteRequest(null)} feedback={toastElement} {...(deleteRequest.returnFocus === undefined ? {} : { returnFocus: deleteRequest.returnFocus })} />}</Container>;
}
