import { describe, expect, it, vi } from 'vitest';
import { UserQuestionGate } from '../src/main/user-question.js';

describe('UserQuestionGate', () => {
  it('accepts custom answers and rejects stale or cross-session submissions', async () => {
    const publish = vi.fn();
    const gate = new UserQuestionGate(publish);
    const waiting = gate.request({ question: '比例？', options: ['横屏', '竖屏'] }, 's', 't', undefined, vi.fn());
    const id = publish.mock.calls[0]![0].requestId as string;
    expect(() => gate.answer(id, 'other', 't', { outcome: 'skipped' })).toThrow('失效');
    gate.answer(id, 's', 't', { outcome: 'answered', answer: '正方形' });
    expect(await waiting).toEqual({ outcome: 'answered', answer: '正方形' });
    expect(() => gate.answer(id, 's', 't', { outcome: 'skipped' })).toThrow('失效');
  });
  it('keeps skip explicit and records window-close without inventing an answer', async () => {
    const publish = vi.fn();
    const closed = vi.fn();
    const gate = new UserQuestionGate(publish);
    const skipped = gate.request({ question: 'question' }, 's', 't', undefined, closed);
    gate.answer(publish.mock.calls[0]![0].requestId as string, 's', 't', { outcome: 'skipped' });
    expect(await skipped).toEqual({ outcome: 'skipped' });
    const controller = new AbortController();
    const cancelled = gate.request({ question: 'question' }, 's', 't', controller.signal, closed);
    controller.abort('window-closed');
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toHaveBeenCalledWith(expect.any(String), 'window-closed');
  });
});
