import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@agent-desktop/model';
import { generateConversationTitle } from '../src/main/conversation-title.js';

describe('conversation title', () => {
  it('summarizes the task without tools or changing the conversation context', async () => {
    const requests: ModelRequest[] = [];
    const signal = new AbortController().signal;
    const title = await generateConversationTitle({ complete: async request => {
      requests.push(request);
      return { text: ' 删除片头广告 ', toolCalls: [] };
    } }, '你好，请帮我把这个视频的片头广告删除，只保留后面的讲解。', signal);
    expect(title).toBe('删除片头广告');
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: '你好，请帮我把这个视频的片头广告删除，只保留后面的讲解。' }]);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.signal).toBe(signal);
  });

  it('rejects model explanations instead of saving them as a title', async () => {
    await expect(generateConversationTitle({ complete: async () => ({ text: '标题：删除广告\n我将帮你执行。', toolCalls: [] }) }, '删除广告', new AbortController().signal)).rejects.toThrow('没有返回有效');
  });

  it('keeps a numeric first message as its title without asking the model to invent a task', async () => {
    const title = await generateConversationTitle({ complete: async () => { throw new Error('纯数字不应发起命名请求'); } }, '1', new AbortController().signal);
    expect(title).toBe('1');
  });

  it('rejects the observed naming refusal instead of using it as a chat title', async () => {
    await expect(generateConversationTitle({ complete: async () => ({ text: '未提供任务内容，无法生成标题。', toolCalls: [] }) }, '你好', new AbortController().signal)).rejects.toThrow('没有返回有效');
    expect(await generateConversationTitle({ complete: async () => ({ text: '修复无法生成标题的问题', toolCalls: [] }) }, '修复聊天命名失败', new AbortController().signal)).toBe('修复无法生成标题的问题');
  });
});
