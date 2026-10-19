import { describe, expect, it } from 'vitest';
import type { RuntimeSettings } from '../src/api.js';
import { DEFAULT_MODEL_PROVIDERS } from '../src/model-defaults.js';
import { getConversationCapability, resolveVisionModel, UNKNOWN_MODEL_CAPABILITIES } from '../src/model-capabilities.js';

const settings: RuntimeSettings = { modelProviders: DEFAULT_MODEL_PROVIDERS.map(provider => ({ ...provider, apiKey: { configured: true } })),
  conversationModel: { providerId: 'deepseek', modelId: 'deepseek-flash' }, fallbackVisionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' }, fallbackVisionEnabled: true,
  memoryEnabled: true, memoryFromToolChatsEnabled: true };
describe('capability based vision routing', () => {
  it('follows the primary model even when a valid fallback is enabled', () => {
    expect(resolveVisionModel(settings)).toMatchObject({ available: true, source: 'conversation', provider: { id: 'deepseek', protocol: 'chat-completions' }, model: { id: 'deepseek-flash' } });
  });
  it('uses an explicitly enabled backup only for a primary that declares no vision', () => {
    const textOnly = { ...settings, conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } };
    expect(resolveVisionModel({ ...textOnly, fallbackVisionEnabled: false })).toMatchObject({ available: false });
    expect(resolveVisionModel(textOnly)).toMatchObject({ available: true, source: 'fallback', provider: { id: 'openai', protocol: 'responses' } });
    expect(resolveVisionModel({ ...textOnly, fallbackVisionModel: null })).toMatchObject({ available: false });
  });
  it('does not route unknown capability or missing primary credentials to a backup', () => {
    expect(resolveVisionModel({ ...settings, conversationModel: null })).toMatchObject({ available: false, reason: expect.stringContaining('未配置对话模型') });
    const unknown = { ...settings, modelProviders: settings.modelProviders.map(provider => ({ ...provider, models: provider.models.map(model => ({ ...model, capabilities: { ...model.capabilities, imageInput: 'unknown' as const } })) })) };
    expect(resolveVisionModel(unknown)).toMatchObject({ available: false, reason: expect.stringContaining('未知') });
    expect(resolveVisionModel({ ...settings, modelProviders: settings.modelProviders.map(provider => provider.id === 'deepseek' ? { ...provider, apiKey: { configured: false } } : provider) })).toMatchObject({ available: false, reason: expect.stringContaining('密钥') });
  });
  it('blocks an unconfigured or unverified backup and excludes generation-only models from conversations', () => {
    const textOnly = { ...settings, conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } };
    expect(resolveVisionModel({ ...textOnly, modelProviders: settings.modelProviders.map(provider => provider.id === 'openai' ? { ...provider, apiKey: { configured: false } } : provider) })).toMatchObject({ available: false });
    expect(resolveVisionModel({ ...textOnly, fallbackVisionModel: textOnly.conversationModel })).toMatchObject({ available: false });
    expect(getConversationCapability({ capabilities: { ...UNKNOWN_MODEL_CAPABILITIES, textInput: 'supported', textOutput: 'unsupported', imageInput: 'unknown', imageUnderstanding: 'unknown' } })).toBe('unsupported');
  });
  it.each(['unknown', 'unsupported'] as const)('requires the backup to support the textual image instructions: %s', textInput => {
    expect(resolveVisionModel({ ...settings, conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      modelProviders: settings.modelProviders.map(provider => provider.id !== 'openai' ? provider : { ...provider,
        models: provider.models.map(model => ({ ...model, capabilities: { ...model.capabilities, textInput } })) }) })).toMatchObject({ available: false });
  });
});
