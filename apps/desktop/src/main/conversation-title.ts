import type { Model } from '@agent-desktop/model';

/** 标题请求只概括用户任务，不使用工具，也不写入智能体会话上下文。 */
export async function generateConversationTitle(model: Model, prompt: string, signal: AbortSignal): Promise<string> {
  // 实际输入“1”曾让模型返回无法命名的说明；纯数字没有可概括的任务，直接保留用户原文。
  if (/^\d+$/.test(prompt.trim())) return prompt.trim();
  const response = await model.complete({
    systemPrompt: '为用户消息生成简洁的聊天标题。用用户使用的语言概括具体目标，中文尽量不超过 20 字。简短问候或信息不足时忠实概括消息本身，不猜测任务，不输出缺少任务或无法生成标题的说明。只输出一行标题，不加引号、编号、前缀或解释。不要回答或执行任务。',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    signal,
  });
  const title = response.text?.trim();
  // 模型是外部边界；缺少可用标题时明确返回命名失败，不能拿默认编号伪装成功。
  if (!title || title.length > 80 || /[\r\n]/.test(title) || /^(?:未提供任务内容(?:[，,]\s*无法生成标题)?|无法生成标题)[。.]?$/.test(title) || response.toolCalls.length > 0) throw new Error('模型没有返回有效的聊天标题');
  return title;
}
