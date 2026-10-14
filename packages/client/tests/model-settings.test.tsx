// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentClientApi, RuntimeSettings } from '../src/api.js';
import { DEFAULT_MODEL_PROVIDERS } from '../src/model-defaults.js';
import { UNKNOWN_MODEL_CAPABILITIES } from '../src/model-capabilities.js';
import { ModelProvidersSettings } from '../src/components/ModelProvidersSettings.js';

afterEach(cleanup);
const deepseekModel = DEFAULT_MODEL_PROVIDERS.find(provider => provider.id === 'deepseek')!.models[0]!;
const openaiModel = DEFAULT_MODEL_PROVIDERS.find(provider => provider.id === 'openai')!.models[0]!;
// 供应商目录本身由配置测试覆盖；编辑测试只保留每家一个真实目录项。
const initial: RuntimeSettings = { modelProviders: DEFAULT_MODEL_PROVIDERS.map(provider => ({ ...provider, models: [provider.models[0]!] })), conversationModel: { providerId: 'deepseek', modelId: deepseekModel.id }, fallbackVisionModel: { providerId: 'openai', modelId: openaiModel.id }, fallbackVisionEnabled: false, memoryEnabled: true, memoryFromToolChatsEnabled: true };
function setup(save = vi.fn<AgentClientApi['saveRuntimeSettings']>(async () => initial), list = vi.fn<AgentClientApi['listProviderModels']>(async () => []), settings = initial, options = { openEditor: true, isProcessing: false }) {
  // 本组件只消费这三个宿主方法，其余方法由 App 的完整契约测试覆盖。
  const api = { saveRuntimeSettings: save, listProviderModels: list, openModelConfig: async () => {} };
  function View() { const [value, setValue] = useState(settings); return <ModelProvidersSettings api={api} settings={value} onSettings={setValue} isOpen isProcessing={options.isProcessing} />; }
  render(<View />);
  if (options.openEditor) fireEvent.click(within(screen.getByRole('region', { name: 'DeepSeek供应商' })).getByRole('button', { name: '编辑' }));
  return { save, list };
}
function confirmTextCapabilities() {
  fireEvent.change(screen.getByLabelText('模型 1 文本输入'), { target: { value: 'supported' } });
  fireEvent.change(screen.getByLabelText('模型 1 文本输出'), { target: { value: 'supported' } });
}
it('saves a complete provider explicitly, accepts token units and drops the secret after success', async () => {
  const { save } = setup();
  fireEvent.change(screen.getByLabelText('DeepSeek API 密钥'), { target: { value: 'new-secret' } });
  fireEvent.change(screen.getByLabelText('模型 1 ID'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  confirmTextCapabilities();
  fireEvent.change(screen.getByLabelText('模型 1 上下文窗口'), { target: { value: '128K' } });
  fireEvent.change(screen.getByLabelText('模型 1 最大输出 token 数'), { target: { value: '4K' } });
  fireEvent.blur(screen.getByLabelText('DeepSeek API 密钥'));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelProvider: expect.objectContaining({ apiKey: 'new-secret', models: [expect.objectContaining({ id: 'new-model', contextWindow: 128000, maxOutputTokens: 4000 })] }), conversationModel: { providerId: 'deepseek', modelId: 'new-model' } })));
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull());
  expect(screen.queryByDisplayValue('new-secret')).toBeNull();
});
it('cancels invalid edits without saving and retains the draft when the host rejects a save', async () => {
  const { save } = setup(vi.fn<AgentClientApi['saveRuntimeSettings']>().mockRejectedValueOnce(new Error('磁盘写入失败')).mockResolvedValue(initial));
  const model = screen.getByLabelText('模型 1 ID');
  fireEvent.change(model, { target: { value: '' } });
  expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/模型 ID 不能为空/)).toBeTruthy();
  fireEvent.change(model, { target: { value: 'corrected' } });
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  confirmTextCapabilities();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('磁盘写入失败');
  expect(model).toHaveProperty('value', 'corrected');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull());
  fireEvent.click(within(screen.getByRole('region', { name: 'DeepSeek供应商' })).getByRole('button', { name: '编辑' }));
  fireEvent.change(screen.getByLabelText('DeepSeek API 密钥'), { target: { value: 'discarded' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.queryByDisplayValue('discarded')).toBeNull();
});
it('keeps existing model metadata when discovering new models without a privileged restore action', async () => {
  const { list, save } = setup(undefined, vi.fn<AgentClientApi['listProviderModels']>(async () => [{ id: deepseekModel.id, displayName: 'remote', capabilities: UNKNOWN_MODEL_CAPABILITIES }, { id: 'discovered', displayName: '新模型', capabilities: UNKNOWN_MODEL_CAPABILITIES }]));
  fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
  await screen.findByText('已获取 2 个模型，保存后生效。');
  expect(list).toHaveBeenCalledWith({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions' });
  expect(screen.getByLabelText('模型 1 显示名称')).toHaveProperty('value', deepseekModel.displayName);
  expect(screen.getByLabelText('模型 2 ID')).toHaveProperty('value', 'discovered');
  expect(screen.queryByRole('button', { name: '恢复默认模型' })).toBeNull();
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  expect(screen.getByLabelText('模型 1 图片输入')).toHaveProperty('value', deepseekModel.capabilities.imageInput);
  expect(save).not.toHaveBeenCalled();
});
it.each([
  { label: 'API 地址', value: 'https://custom.example/v1' },
  { label: 'API 协议', value: 'responses' },
])('keeps capability confirmation unknown after discovery through a changed $label', async ({ label, value }) => {
  const { save, list } = setup(undefined, vi.fn<AgentClientApi['listProviderModels']>(async () => [{ ...deepseekModel, displayName: 'remote' }, { id: 'discovered', displayName: '新模型', capabilities: UNKNOWN_MODEL_CAPABILITIES }]));
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
  await screen.findByText('已获取 2 个模型，保存后生效。');
  expect(list).toHaveBeenCalledWith({ id: 'deepseek', baseUrl: label === 'API 地址' ? value : initial.modelProviders[0]!.baseUrl, protocol: label === 'API 协议' ? value : initial.modelProviders[0]!.protocol });
  expect(screen.getByLabelText('模型 1 ID')).toHaveProperty('value', deepseekModel.id);
  expect(screen.getByLabelText('模型 1 显示名称')).toHaveProperty('value', deepseekModel.displayName);
  expect(screen.getByLabelText('模型 2 ID')).toHaveProperty('value', 'discovered');
  expect(screen.queryByRole('button', { name: '恢复默认模型' })).toBeNull();
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  for (const capability of ['文本输入', '文本输出', '图片输入', '视觉理解']) expect(screen.getByLabelText(`模型 1 ${capability}`)).toHaveProperty('value', 'unknown');
  expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
  expect(save).not.toHaveBeenCalled();
});
it('requires renewed capability confirmation after changing model ID or protocol', () => {
  setup();
  fireEvent.change(screen.getByLabelText('模型 1 ID'), { target: { value: 'different-model' } });
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  expect(screen.getByLabelText('模型 1 图片输入')).toHaveProperty('value', 'unknown');
  expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
  confirmTextCapabilities();
  fireEvent.change(screen.getByLabelText('模型 1 视觉理解'), { target: { value: 'supported' } });
  fireEvent.change(screen.getByLabelText('API 协议'), { target: { value: 'responses' } });
  expect(screen.getByLabelText('模型 1 视觉理解')).toHaveProperty('value', 'unknown');
});
it('shows a configured key as a mask and replaces it only on explicit save', async () => {
  const settings: RuntimeSettings = { ...initial, modelProviders: initial.modelProviders.map(provider => provider.id === 'deepseek' ? { ...provider, apiKey: { configured: true, source: 'saved' } } : provider) };
  const { save } = setup(undefined, undefined, settings);
  const key = screen.getByLabelText('DeepSeek API 密钥');
  expect(key).toHaveProperty('type', 'password');
  expect(key).toHaveProperty('value', '*'.repeat(64));
  fireEvent.focus(key);
  expect(key).toHaveProperty('value', '');
  fireEvent.blur(key);
  expect(key).toHaveProperty('value', '*'.repeat(64));
  expect(screen.queryByRole('button', { name: '清除本机密钥' })).toBeNull();
  fireEvent.change(key, { target: { value: 'replacement-key' } });
  fireEvent.blur(key);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelProvider: expect.objectContaining({ apiKey: 'replacement-key' }) })));
});
it('keeps the display mask out of model discovery and unrelated provider updates', async () => {
  const settings: RuntimeSettings = { ...initial, modelProviders: initial.modelProviders.map(provider => ({ ...provider, apiKey: { configured: true, source: 'saved' } })) };
  const { save, list } = setup(undefined, undefined, settings);
  fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
  await screen.findByText('已获取 0 个模型，保存后生效。');
  expect(list.mock.calls[0]![0]).not.toHaveProperty('apiKey');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0].modelProvider).not.toHaveProperty('apiKey');
});
it('keeps the fallback closed until a model is selected and preserves its candidate when closed again', async () => {
  let settings: RuntimeSettings = { ...initial, modelProviders: initial.modelProviders.map(provider => ({ ...provider, apiKey: { configured: true, source: 'saved' } })) };
  const save = vi.fn<AgentClientApi['saveRuntimeSettings']>(async update => { settings = { ...settings,
    ...(update.fallbackVisionEnabled === undefined ? {} : { fallbackVisionEnabled: update.fallbackVisionEnabled }),
    ...(update.fallbackVisionModel === undefined ? {} : { fallbackVisionModel: update.fallbackVisionModel }) }; return settings; });
  setup(save, undefined, settings, { openEditor: false, isProcessing: false });
  expect(screen.queryByLabelText('当前视觉模型')).toBeNull();
  expect(screen.queryByLabelText('当前对话模型')).toBeNull();
  expect(screen.queryByLabelText('启用备用视觉模型')).toBeNull();
  expect(screen.getByText('高级设置').parentElement).toHaveProperty('open', false);
  fireEvent.click(screen.getByText('高级设置'));
  const select = screen.getByLabelText('备用视觉模型');
  expect(select).toHaveProperty('value', '');
  expect(within(select).getByRole('option', { name: '关闭' })).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: JSON.stringify(initial.fallbackVisionModel) } });
  await waitFor(() => expect(select).toHaveProperty('value', JSON.stringify(initial.fallbackVisionModel)));
  expect(save).toHaveBeenLastCalledWith({ fallbackVisionModel: initial.fallbackVisionModel, fallbackVisionEnabled: true });
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(select).toHaveProperty('value', ''));
  expect(save).toHaveBeenLastCalledWith({ fallbackVisionEnabled: false });
  expect(settings.fallbackVisionModel).toEqual(initial.fallbackVisionModel);
  expect(settings.conversationModel).toEqual(initial.conversationModel);
  expect(screen.getByText('主模型不支持图片时使用。')).toBeTruthy();
});
it.each([false, true])('keeps committed fallback selection after a failed save with enabled=%s', async enabled => {
  const settings: RuntimeSettings = { ...initial, fallbackVisionEnabled: enabled, modelProviders: initial.modelProviders.map(provider => ({ ...provider, apiKey: { configured: true, source: 'saved' } })) };
  const { save } = setup(vi.fn<AgentClientApi['saveRuntimeSettings']>().mockRejectedValue(new Error('备用配置保存失败')), undefined, settings, { openEditor: false, isProcessing: false });
  fireEvent.click(screen.getByText('高级设置'));
  const select = screen.getByLabelText('备用视觉模型');
  fireEvent.change(select, { target: { value: enabled ? '' : JSON.stringify(initial.fallbackVisionModel) } });
  await screen.findByText('备用配置保存失败');
  expect(select).toHaveProperty('value', enabled ? JSON.stringify(initial.fallbackVisionModel) : '');
  expect(save).toHaveBeenCalledWith(enabled ? { fallbackVisionEnabled: false } : { fallbackVisionModel: initial.fallbackVisionModel, fallbackVisionEnabled: true });
});
it('adds custom models with unknown capabilities and saves only explicit capability choices', async () => {
  const { save } = setup(undefined, undefined, initial, { openEditor: false, isProcessing: false });
  fireEvent.click(screen.getByRole('button', { name: '添加模型提供商' }));
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '自定义服务' } });
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://example.com/v1' } });
  fireEvent.change(screen.getByLabelText('模型 1 ID'), { target: { value: 'custom-model' } });
  fireEvent.change(screen.getByLabelText('模型 1 显示名称'), { target: { value: '自定义模型' } });
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  for (const label of ['文本输入', '文本输出', '图片输入', '视觉理解']) expect(screen.getByLabelText(`模型 1 ${label}`)).toHaveProperty('value', 'unknown');
  fireEvent.change(screen.getByLabelText('模型 1 文本输入'), { target: { value: 'supported' } });
  fireEvent.change(screen.getByLabelText('模型 1 文本输出'), { target: { value: 'supported' } });
  fireEvent.change(screen.getByLabelText('模型 1 图片输入'), { target: { value: 'supported' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelProvider: expect.objectContaining({ models: [expect.objectContaining({ capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'unknown' } })] }) })));
  expect(save.mock.calls[0]![0]).not.toHaveProperty('fallbackVisionEnabled');
});
it('retains a fallback candidate with unknown capability and disables its use in the same provider save', async () => {
  const settings: RuntimeSettings = { ...initial, fallbackVisionModel: initial.conversationModel, fallbackVisionEnabled: true,
    modelProviders: initial.modelProviders.map(provider => provider.id === 'deepseek' ? { ...provider, models: provider.models.map(model => ({ ...model, capabilities: { ...model.capabilities, imageInput: 'supported', imageUnderstanding: 'supported' } })) } : provider) };
  const { save } = setup(undefined, undefined, settings);
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
  fireEvent.change(screen.getByLabelText('模型 1 视觉理解'), { target: { value: 'unknown' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ fallbackVisionEnabled: false })));
  expect(save.mock.calls[0]![0]).not.toHaveProperty('fallbackVisionModel');
});
it('adjusts deleted model references without enabling a disabled fallback candidate', async () => {
  const model = initial.modelProviders[0]!.models[0]!;
  const capabilities = { ...model.capabilities, imageInput: 'supported', imageUnderstanding: 'supported' } as const;
  const settings: RuntimeSettings = { ...initial, fallbackVisionModel: initial.conversationModel,
    modelProviders: initial.modelProviders.map(provider => provider.id === 'deepseek' ? { ...provider, models: [{ ...model, capabilities }, { ...model, id: 'replacement', displayName: '替代模型', capabilities }] } : provider) };
  const { save } = setup(undefined, undefined, settings);
  fireEvent.click(screen.getByLabelText('删除模型 1'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ conversationModel: { providerId: 'deepseek', modelId: 'replacement' }, fallbackVisionModel: { providerId: 'deepseek', modelId: 'replacement' } })));
  expect(save.mock.calls[0]![0]).not.toHaveProperty('fallbackVisionEnabled');
});
it('keeps provider and fallback edits disabled during a turn without a duplicate conversation model field', () => {
  const settings: RuntimeSettings = { ...initial, modelProviders: initial.modelProviders.map(provider => ({ ...provider, apiKey: { configured: true, source: 'saved' } })) };
  const { save } = setup(undefined, undefined, settings, { openEditor: false, isProcessing: true });
  expect(screen.queryByLabelText('当前对话模型')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'DeepSeek供应商' })).getByRole('button', { name: '编辑' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '删除DeepSeek供应商' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '删除OpenAI供应商' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByText('高级设置'));
  expect(screen.queryByLabelText('启用备用视觉模型')).toBeNull();
  expect(screen.getByLabelText('备用视觉模型')).toHaveProperty('disabled', true);
  expect(save).not.toHaveBeenCalled();
});
it('confirms supplier deletion and keeps its card after a failed save', async () => {
  const save = vi.fn<AgentClientApi['saveRuntimeSettings']>().mockRejectedValueOnce(new Error('删除失败')).mockResolvedValue({
    ...initial, modelProviders: initial.modelProviders.filter(provider => provider.id !== 'openai'), fallbackVisionModel: null,
  });
  setup(save, undefined, initial, { openEditor: false, isProcessing: false });
  const remove = screen.getByRole('button', { name: '删除OpenAI供应商' });
  expect(screen.getByRole('button', { name: '删除DeepSeek供应商' })).toBeTruthy();
  fireEvent.click(remove);
  expect(screen.getByText('删除“OpenAI”及其本机密钥？')).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await screen.findByText('删除失败');
  expect(screen.getByRole('region', { name: 'OpenAI供应商' })).toBeTruthy();
  expect(save).toHaveBeenCalledWith({ deleteModelProviderId: 'openai' });
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'OpenAI供应商' })).toBeNull());
  expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
  expect(screen.getByRole('region', { name: 'DeepSeek供应商' })).toBeTruthy();
});
it('keeps an unverified fallback candidate disabled and closed', () => {
  const settings: RuntimeSettings = { ...initial, fallbackVisionEnabled: false, fallbackVisionModel: { providerId: 'openai', modelId: 'unknown' },
    modelProviders: initial.modelProviders.map(provider => provider.id === 'openai' ? { ...provider, apiKey: { configured: true, source: 'saved' }, models: [{ id: 'unknown', displayName: '未知模型', capabilities: UNKNOWN_MODEL_CAPABILITIES }, { id: 'image-only', displayName: '仅图片模型', capabilities: { textInput: 'unsupported', textOutput: 'unsupported', imageInput: 'supported', imageUnderstanding: 'supported' } }] } : provider) };
  setup(undefined, undefined, settings, { openEditor: false, isProcessing: false });
  fireEvent.click(screen.getByText('高级设置'));
  const select = screen.getByLabelText('备用视觉模型');
  expect(select).toHaveProperty('value', '');
  expect(within(select).getByRole('option', { name: /未知模型（视觉能力未知）/ })).toHaveProperty('disabled', true);
  expect(within(select).queryByRole('option', { name: /仅图片模型/ })).toBeNull();
});
