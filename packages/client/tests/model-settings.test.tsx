// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentClientApi, RuntimeSettings } from '../src/api.js';
import { DEFAULT_MODEL_PROVIDERS } from '../src/model-defaults.js';
import { ModelProvidersSettings } from '../src/components/ModelProvidersSettings.js';

afterEach(cleanup);
const initial: RuntimeSettings = { modelProviders: DEFAULT_MODEL_PROVIDERS, conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, visionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' }, whisper: { modelPath: '', cliPath: '' }, memoryEnabled: true, memoryFromToolChatsEnabled: true };
function setup(save = vi.fn<AgentClientApi['saveRuntimeSettings']>(async () => initial), list = vi.fn<AgentClientApi['listProviderModels']>(async () => []), settings = initial) {
  // 本组件只消费这三个宿主方法，其余方法由 App 的完整契约测试覆盖。
  const api = { saveRuntimeSettings: save, listProviderModels: list, openModelConfig: async () => {} };
  function View() { const [value, setValue] = useState(settings); return <ModelProvidersSettings api={api} settings={value} onSettings={setValue} isOpen isProcessing={false} />; }
  render(<View />);
  fireEvent.click(within(screen.getByRole('region', { name: 'DeepSeek供应商' })).getByRole('button', { name: '编辑' }));
  return { save, list };
}
it('saves a complete provider explicitly, accepts token units and drops the secret after success', async () => {
  const { save } = setup();
  fireEvent.change(screen.getByLabelText('DeepSeek API 密钥'), { target: { value: 'new-secret' } });
  fireEvent.change(screen.getByLabelText('模型 1 ID'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByLabelText('模型 1 参数'));
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
it('keeps existing model metadata when discovering new models and restores only the built-in catalog', async () => {
  const { list, save } = setup(undefined, vi.fn<AgentClientApi['listProviderModels']>(async () => [{ id: 'deepseek-v4-pro', displayName: 'remote', images: false }, { id: 'discovered', displayName: '新模型', images: false }]));
  fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
  await screen.findByText('已获取 2 个模型，保存后生效。');
  expect(list).toHaveBeenCalledWith({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions' });
  expect(screen.getByLabelText('模型 1 显示名称')).toHaveProperty('value', 'DeepSeek V4 Pro');
  expect(screen.getByLabelText('模型 2 ID')).toHaveProperty('value', 'discovered');
  fireEvent.click(screen.getByRole('button', { name: '恢复默认模型' }));
  expect(screen.queryByLabelText('模型 2 ID')).toBeNull();
  expect(save).not.toHaveBeenCalled();
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
