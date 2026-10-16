import type { RuntimeModelProvider } from './api.js';

/** 首次配置的预填目录；能力以具体官方模型和实际协议为依据，不赋予供应商特殊身份。 */
export const DEFAULT_MODEL_PROVIDERS: readonly RuntimeModelProvider[] = [
  { id: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions',
    // 2026-10-13 官方 /models 元数据：Flash 为图片输入，Pro 仍声明仅文本，不凭临时重定向猜测。
    apiKey: { configured: false }, models: [
      // 2026-10-16 官方 /models 的 context_window；只填展示所需容量，不改变请求输出上限。
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', contextWindow: 1048576, capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } },
      { id: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', contextWindow: 1048576, capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } },
    ] },
  { id: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses',
    apiKey: { configured: false }, models: [{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } }] },
];

/** 官方目录的验证结论只适用于同一地址与协议，自定义入口必须重新确认能力。 */
export function usesDefaultModelEndpoint(provider: Pick<RuntimeModelProvider, 'id' | 'baseUrl' | 'protocol'>): boolean {
  const defaults = DEFAULT_MODEL_PROVIDERS.find(item => item.id === provider.id);
  return defaults !== undefined && provider.baseUrl.trim().replace(/\/+$/, '') === defaults.baseUrl && provider.protocol === defaults.protocol;
}
