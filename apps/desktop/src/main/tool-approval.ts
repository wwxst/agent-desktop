import { randomUUID } from 'node:crypto';
import type { ApprovalRequest } from '@agent-desktop/client';
import type { ApprovalTarget } from '@agent-desktop/local-tools';

interface PendingApproval {
  readonly requestId: string;
  settle(approved: boolean): void;
}

/**
 * 宿主持有的单个待决操作审批。
 *
 * 它绑定当前轮次的取消信号和请求标识，并且只保存宿主自己算出的操作参数：
 * 客户端能做的只有批准或拒绝，不能借一次决定改写待执行的操作——待执行的操作由发起请求的
 * 工具自己持有，客户端根本拿不到改写它的通道。
 *
 * 待决请求只属于当前正在执行的那一轮——宿主在任务执行期间禁止切换会话，
 * 因此「当前活动会话」就是发起请求的会话，不需要再复制一份会话标识。
 */
export class ToolApprovalGate {
  private pending: PendingApproval | undefined;

  /** publish 由宿主注入，用来把待决请求推给客户端；它不参与审批决定。 */
  public constructor(private readonly publish: (request: ApprovalRequest) => void) {}

  /**
   * 请求用户确认一次本地操作，并等待答复。
   *
   * 取消、关闭或请求失效都必须结束等待：取消继续走既有 AbortSignal，以 AbortError 结束，
   * 不能伪装成普通工具失败，否则模型会把一次取消当成一次失败的工具调用继续推理。
   */
  request(target: ApprovalTarget, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // 轮次在请求之前就取消了：这里不能登记一个永远等不到答复的待决请求。
      if (signal?.aborted === true) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }

      const requestId = randomUUID();
      const abort = () => {
        this.pending = undefined;
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });

      this.pending = {
        requestId,
        settle: (approved) => {
          signal?.removeEventListener('abort', abort);
          this.pending = undefined;
          resolve(approved);
        },
      };
      this.publish({ requestId, kind: target.kind, target: target.path });
    });
  }

  /**
   * 提交一个审批决定。
   * 只接受当前待决请求的标识：已经失效、重复提交或伪造的标识一律拒绝，
   * 客户端不能用一次迟到的批准重新启动操作。
   */
  decide(requestId: string, approved: boolean): void {
    const pending = this.pending;
    if (pending === undefined || pending.requestId !== requestId) {
      throw new Error('该审批请求已失效。');
    }
    pending.settle(approved);
  }
}
