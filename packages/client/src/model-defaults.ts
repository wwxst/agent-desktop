import type { RuntimeModelProvider } from './api.js';

/** 只列当前正式运行时已经使用的模型，不凭名称猜测其它模型能力。 */
export const DEFAULT_MODEL_PROVIDERS: readonly RuntimeModelProvider[] = [
  { id: 'deepseek', displayName: 'DeepSeek', builtin: true, baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions',
    apiKey: { configured: false }, models: [{ id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', images: false }] },
  { id: 'openai', displayName: 'OpenAI', builtin: true, baseUrl: 'https://api.openai.com/v1', protocol: 'responses',
    apiKey: { configured: false }, models: [{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', images: true }] },
];
