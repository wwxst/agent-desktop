import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { AgentClientApi, RuntimeModelDefinition, RuntimeModelProvider, RuntimeModelReference, RuntimeSettings, RuntimeSettingsUpdate } from '../api.js';
import { DEFAULT_MODEL_PROVIDERS } from '../model-defaults.js';

// 固定长度的显示掩码，不读取真实密钥及其长度，也不写入供应商草稿。
const MASKED_API_KEY = '*'.repeat(64);

type ModelDraft = Omit<RuntimeModelDefinition, 'contextWindow' | 'maxOutputTokens'> & { contextWindow: string; maxOutputTokens: string };
interface ProviderDraft {
  id: string; displayName: string; baseUrl: string; protocol: RuntimeModelProvider['protocol']; apiKey?: string; models: ModelDraft[];
}
function modelDraft(model: RuntimeModelDefinition): ModelDraft {
  return { id: model.id, displayName: model.displayName, images: model.images,
    contextWindow: model.contextWindow?.toString() ?? '', maxOutputTokens: model.maxOutputTokens?.toString() ?? '' };
}
function tokenCount(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * (match[2]?.toLowerCase() === 'k' ? 1000 : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
}
function modelsFromDraft(models: readonly ModelDraft[]): RuntimeModelDefinition[] {
  return models.map(model => ({ id: model.id.trim(), displayName: model.displayName.trim(), images: model.images,
    ...(model.contextWindow.trim() ? { contextWindow: tokenCount(model.contextWindow)! } : {}),
    ...(model.maxOutputTokens.trim() ? { maxOutputTokens: tokenCount(model.maxOutputTokens)! } : {}) }));
}
function draftError(draft: ProviderDraft): string | null {
  if (!draft.displayName.trim()) return '显示名称不能为空。';
  try { const url = new URL(draft.baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '请填写有效的 API 地址。'; }
  catch { return '请填写有效的 API 地址。'; }
  if (!draft.models.length) return '请至少添加一个模型。';
  const ids = new Set<string>();
  for (const [index, model] of draft.models.entries()) {
    if (!model.id.trim()) return `模型 ${index + 1}: 模型 ID 不能为空。`;
    if (!model.displayName.trim()) return `模型 ${index + 1}: 显示名称不能为空。`;
    if (ids.has(model.id.trim())) return `模型 ${index + 1}: 模型 ID 重复。`;
    ids.add(model.id.trim());
    const context = tokenCount(model.contextWindow); const output = tokenCount(model.maxOutputTokens);
    if ([context, output].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) return `模型 ${index + 1}: token 数必须是正整数，可使用 K 或 M。`;
    if (context !== undefined && output !== undefined && output > context) return `模型 ${index + 1}: 输出上限不能超过上下文窗口。`;
  }
  return null;
}

/** 供应商编辑只维护草稿；密钥、模型发现和实际任务配置由宿主处理。 */
export function ModelProvidersSettings({ api, settings, isProcessing, isOpen, onSettings }: {
  readonly api: Pick<AgentClientApi, 'saveRuntimeSettings' | 'listProviderModels' | 'openModelConfig'>; readonly settings: RuntimeSettings; readonly isProcessing: boolean; readonly isOpen: boolean;
  readonly onSettings: (settings: RuntimeSettings) => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [expandedModel, setExpandedModel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => { if (!isOpen) { setDraft(null); setExpandedModel(null); setDeleting(null); setError(''); } }, [isOpen]);
  const disabled = busy || isProcessing;
  const openEditor = (provider: RuntimeModelProvider) => {
    setDraft({ id: provider.id, displayName: provider.displayName, baseUrl: provider.baseUrl, protocol: provider.protocol, models: provider.models.map(modelDraft) });
    setExpandedModel(null); setError(''); setMessage(''); setDeleting(null);
  };
  const save = async (update: RuntimeSettingsUpdate, closeEditor = false) => {
    setBusy(true); setError(''); setMessage('');
    try { onSettings(await api.saveRuntimeSettings(update)); if (closeEditor) setDraft(null); setDeleting(null); }
    catch (failure) { if (!(failure instanceof Error)) throw failure; setError(failure.message); }
    finally { setBusy(false); }
  };
  const updateModel = (index: number, update: Partial<ModelDraft>) => setDraft(current => current === null ? null : ({ ...current, models: current.models.map((model, i) => i === index ? { ...model, ...update } : model) }));
  const saveDraft = async () => {
    if (draft === null || draftError(draft) !== null) return;
    const models = modelsFromDraft(draft.models);
    // 用户删除正在使用的目录项时，在同一保存里改用该供应商的首个有效模型。
    const conversationModel = settings.conversationModel.providerId === draft.id && !models.some(model => model.id === settings.conversationModel.modelId)
      ? { providerId: draft.id, modelId: models[0]!.id } : undefined;
    const imageModel = models.find(model => model.images);
    const visionModel = settings.visionModel?.providerId === draft.id && !models.some(model => model.id === settings.visionModel?.modelId && model.images)
      ? imageModel === undefined ? null : { providerId: draft.id, modelId: imageModel.id } : undefined;
    await save({ modelProvider: { id: draft.id, displayName: draft.displayName.trim(), baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), protocol: draft.protocol, models,
      ...(draft.apiKey === undefined || draft.apiKey === '' ? {} : { apiKey: draft.apiKey }) },
      ...(conversationModel === undefined ? {} : { conversationModel }), ...(visionModel === undefined ? {} : { visionModel }) }, true);
  };
  const fetchModels = async () => {
    if (draft === null) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const fetched = await api.listProviderModels({ id: draft.id, baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), protocol: draft.protocol,
        ...(draft.apiKey === undefined || draft.apiKey === '' ? {} : { apiKey: draft.apiKey }) });
      setDraft(current => {
        if (current === null) return null;
        const models = current.models.filter(model => model.id.trim());
        for (const model of fetched) if (!models.some(existing => existing.id === model.id)) models.push(modelDraft(model));
        return { ...current, models };
      });
      setMessage(`已获取 ${fetched.length} 个模型，保存后生效。`);
    } catch (failure) { if (!(failure instanceof Error)) throw failure; setError(failure.message); }
    finally { setBusy(false); }
  };
  const editor = (provider: RuntimeModelProvider | undefined) => draft !== null && <form className="model-provider-editor" aria-label={`${draft.displayName || '新供应商'}编辑`} onSubmit={event => { event.preventDefault(); void saveDraft(); }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && !busy) { event.preventDefault(); event.stopPropagation(); setDraft(null); }
  }}>
    <div className="model-provider-editor-title"><strong>{draft.displayName || '新供应商'}</strong></div>
    <label className="model-provider-field"><span>API 密钥</span><input type="password" autoComplete="off" aria-label={`${draft.displayName || '新供应商'} API 密钥`} placeholder="输入 API 密钥" value={draft.apiKey === undefined && provider?.apiKey.configured ? MASKED_API_KEY : draft.apiKey ?? ''} disabled={disabled}
      onFocus={() => { if (draft.apiKey === undefined && provider?.apiKey.configured) setDraft({ ...draft, apiKey: '' }); }}
      onBlur={() => setDraft(current => {
        if (current?.apiKey !== '') return current;
        // 未输入替换值时恢复已配置掩码；省略字段让宿主沿用原密钥。
        const { apiKey: _key, ...unchanged } = current;
        return unchanged;
      })}
      onChange={event => setDraft({ ...draft, apiKey: event.target.value })} /></label>
    <details className="model-provider-custom" open><summary>自定义设置</summary>
      <label className="model-provider-field"><span>显示名称</span><input value={draft.displayName} disabled={disabled} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <label className="model-provider-field"><span>API 地址</span><input value={draft.baseUrl} placeholder="https://example.com/v1" disabled={disabled} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="model-provider-field"><span>API 协议</span><select aria-label="API 协议" value={draft.protocol} disabled={disabled} onChange={event => setDraft({ ...draft, protocol: event.target.value as ProviderDraft['protocol'] })}><option value="chat-completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option></select></label>
    </details>
    <div className="model-catalog-heading"><div><span>模型目录</span><small>模型 ID 和能力按供应商实际支持填写</small></div><div>
      {provider?.builtin && <button type="button" disabled={disabled} onClick={() => { setDraft({ ...draft, models: DEFAULT_MODEL_PROVIDERS.find(item => item.id === draft.id)!.models.map(modelDraft) }); setExpandedModel(null); }}>恢复默认模型</button>}
      <button type="button" disabled={disabled || !draft.baseUrl.trim()} onClick={() => void fetchModels()}>获取可用模型</button>
    </div></div>
    <div className="model-catalog">{draft.models.map((model, index) => <div className="model-catalog-entry" key={index}>
      <div className="model-catalog-row"><input aria-label={`模型 ${index + 1} ID`} placeholder="模型 ID" value={model.id} disabled={disabled} onChange={event => updateModel(index, { id: event.target.value })} /><input aria-label={`模型 ${index + 1} 显示名称`} placeholder="显示名称" value={model.displayName} disabled={disabled} onChange={event => updateModel(index, { displayName: event.target.value })} />
        <button type="button" className="icon-button" aria-label={`模型 ${index + 1} 参数`} aria-expanded={expandedModel === index} onClick={() => setExpandedModel(expandedModel === index ? null : index)}>{expandedModel === index ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
        <button type="button" className="icon-button" aria-label={`删除模型 ${index + 1}`} disabled={disabled} onClick={() => { setDraft({ ...draft, models: draft.models.filter((_item, i) => i !== index) }); setExpandedModel(null); }}><Trash2 size={15} /></button>
      </div>
      {expandedModel === index && <div className="model-catalog-parameters"><label className="model-provider-field"><span>上下文窗口</span><input aria-label={`模型 ${index + 1} 上下文窗口`} placeholder="256K" value={model.contextWindow} disabled={disabled} onChange={event => updateModel(index, { contextWindow: event.target.value })} /></label><label className="model-provider-field"><span>最大输出 token 数</span><input aria-label={`模型 ${index + 1} 最大输出 token 数`} placeholder="32K" value={model.maxOutputTokens} disabled={disabled} onChange={event => updateModel(index, { maxOutputTokens: event.target.value })} /></label>
        <div className="model-input-types"><span>输入类型</span><div><label><input type="checkbox" checked disabled />文本</label><label><input type="checkbox" checked={model.images} disabled={disabled} onChange={event => updateModel(index, { images: event.target.checked })} />图片</label></div></div>
      </div>}
    </div>)}</div>
    <button type="button" className="model-small-button" disabled={disabled} onClick={() => { setDraft({ ...draft, models: [...draft.models, modelDraft({ id: '', displayName: '', images: false })] }); setExpandedModel(null); }}><Plus size={14} />添加模型</button>
    {draftError(draft) !== null && <p className="model-validation" role="status">{draftError(draft)}</p>}
    <div className="model-provider-footer"><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="model-save" type="submit" disabled={disabled || draftError(draft) !== null}>保存</button></div>
  </form>;
  const modelOptions = settings.modelProviders.flatMap(provider => provider.models.map(model => ({ provider, model, reference: { providerId: provider.id, modelId: model.id } })));
  const choiceValue = (reference: RuntimeModelReference | null) => reference === null ? '' : JSON.stringify(reference);
  return <div className="model-provider-settings">
    <div className="model-settings-heading"><h1>模型</h1><button type="button" className="model-small-button" title="打开不含密钥的只读配置快照" onClick={() => { void api.openModelConfig().catch((failure: unknown) => { if (!(failure instanceof Error)) throw failure; setError(failure.message); }); }}>打开配置文件</button></div>
    <p className="model-settings-description">填入各提供商的 API 密钥即可使用其模型。</p>
    {error && <p className="settings-error" role="alert">{error}</p>}{message && <p className="model-settings-message" role="status">{message}</p>}
    {settings.modelProviders.map(provider => <section className="model-provider-card" key={provider.id} aria-label={`${provider.displayName}供应商`}>
      <div className="model-provider-header"><strong>{provider.displayName}</strong>{!provider.builtin && <span className="model-custom-badge">自定义</span>}<span className={`model-provider-dot${provider.apiKey.configured ? ' configured' : ''}`} aria-label={provider.apiKey.configured ? '密钥已配置' : '密钥未配置'} title={provider.apiKey.configured ? '密钥已配置' : '密钥未配置'} />
        <div className="model-provider-actions"><button type="button" disabled={disabled} onClick={() => draft?.id === provider.id ? setDraft(null) : openEditor(provider)}>编辑</button>{!provider.builtin && <button className="model-delete" type="button" disabled={disabled} onClick={() => { setDeleting(provider.id); setDraft(null); setError(''); }}>删除</button>}</div>
      </div>{draft?.id === provider.id && editor(provider)}
      {deleting === provider.id && <div className="model-delete-confirm"><span>删除“{provider.displayName}”及其本机密钥？</span><button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button type="button" className="model-delete" disabled={disabled} onClick={() => void save({ deleteModelProviderId: provider.id })}>确认删除</button></div>}
    </section>)}
    {draft !== null && !settings.modelProviders.some(provider => provider.id === draft.id) && <section className="model-provider-card">{editor(undefined)}</section>}
    <button className="model-add-provider" type="button" disabled={disabled || draft !== null} onClick={() => { setDraft({ id: `custom-${crypto.randomUUID()}`, displayName: '', baseUrl: '', protocol: 'chat-completions', models: [modelDraft({ id: '', displayName: '', images: false })] }); setError(''); setMessage(''); }}><Plus size={16} />添加模型提供商</button>
    <section className="model-active-selection" aria-label="任务使用的模型"><label className="model-provider-field"><span>当前对话模型</span><select aria-label="当前对话模型" value={choiceValue(settings.conversationModel)} disabled={disabled} onChange={event => void save({ conversationModel: JSON.parse(event.target.value) as RuntimeModelReference })}>{modelOptions.map(({ provider, model, reference }) => <option key={choiceValue(reference)} value={choiceValue(reference)}>{provider.displayName} · {model.displayName}</option>)}</select></label>
      <label className="model-provider-field"><span>当前视觉模型</span><select aria-label="当前视觉模型" value={choiceValue(settings.visionModel)} disabled={disabled} onChange={event => void save({ visionModel: event.target.value ? JSON.parse(event.target.value) as RuntimeModelReference : null })}><option value="">不使用视觉模型</option>{modelOptions.filter(({ model }) => model.images).map(({ provider, model, reference }) => <option key={choiceValue(reference)} value={choiceValue(reference)}>{provider.displayName} · {model.displayName}</option>)}</select></label>
    </section>
  </div>;
}
