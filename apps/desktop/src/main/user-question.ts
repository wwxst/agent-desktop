import { randomUUID } from 'node:crypto';
import type { QuestionAnswer, QuestionRequest } from '@agent-desktop/client';
import type { UserQuestion } from '@agent-desktop/video-agent';

/** 单个前台轮次的问答等待；关闭后标识立即失效，旧历史无法再次提交。 */
export class UserQuestionGate {
  private pending: { readonly request: QuestionRequest; settle(answer: QuestionAnswer): void } | undefined;
  constructor(private readonly publish: (request: QuestionRequest) => void) {}
  request(question: UserQuestion, sessionId: string, turnId: string, signal: AbortSignal | undefined,
    onClosed: (requestId: string, reason: 'cancelled' | 'window-closed') => void): Promise<QuestionAnswer> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('The operation was aborted', 'AbortError')); return; }
      const request = { ...question, requestId: randomUUID(), sessionId, turnId };
      const abort = () => {
        this.pending = undefined;
        onClosed(request.requestId, signal?.reason === 'window-closed' ? 'window-closed' : 'cancelled');
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending = { request, settle: (answer) => {
        signal?.removeEventListener('abort', abort);
        this.pending = undefined;
        resolve(answer);
      } };
      this.publish(request);
    });
  }
  answer(requestId: string, sessionId: string, turnId: string, answer: unknown): void {
    const pending = this.pending;
    if (pending === undefined || pending.request.requestId !== requestId
      || pending.request.sessionId !== sessionId || pending.request.turnId !== turnId) throw new Error('该问题已失效。');
    if (typeof answer !== 'object' || answer === null) throw new Error('问题答复无效。');
    const value = answer as Record<string, unknown>;
    if (value.outcome === 'skipped') { pending.settle({ outcome: 'skipped' }); return; }
    if (value.outcome !== 'answered' || typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 4000) {
      throw new Error('答复不能为空，最多 4000 字。');
    }
    pending.settle({ outcome: 'answered', answer: value.answer });
  }
}
