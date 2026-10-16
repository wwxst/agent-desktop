import { randomUUID } from 'node:crypto';
import type { ApprovalRequest } from '@agent-desktop/client';
import type { ApprovalTarget } from '@agent-desktop/local-tools';
import { ToolExecutionError } from '@agent-desktop/tools';
import type { PermissionMode } from '@agent-desktop/client';

export type PluginApproval = Omit<Extract<ApprovalRequest, { kind: 'plugin-start' }>, 'requestId'>
  | Omit<Extract<ApprovalRequest, { kind: 'plugin-tool' }>, 'requestId'>;

export interface AutomaticApprovalResult {
  readonly decision: 'approve' | 'deny';
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly reason: string;
}

/** 一轮开始时固定模式；路径准入继续由真实工具边界负责。 */
interface ApprovalPolicy {
  readonly mode: PermissionMode;
  readonly review: (target: ApprovalTarget | PluginApproval, signal?: AbortSignal) => Promise<AutomaticApprovalResult>;
}

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
  private policy: ApprovalPolicy | undefined;

  /** publish 由宿主注入，用来把待决请求推给客户端；它不参与审批决定。 */
  public constructor(private readonly publish: (request: ApprovalRequest) => void) {}

  configure(policy: ApprovalPolicy): void {
    this.policy = policy;
  }

  /** 审批展示与执行使用同一份确切参数；自动审查也不把操作交给客户端改写。 */
  private requestData(target: ApprovalTarget | PluginApproval, requestId: string): ApprovalRequest {
    if (target.kind === 'plugin-start' || target.kind === 'plugin-tool'
      || target.kind === 'terminal-start' || target.kind === 'terminal-input') return { requestId, ...target };
    if (target.kind === 'edit-file') return { requestId, kind: target.kind, target: target.path, before: target.before, after: target.after };
    if (target.kind === 'command') return { requestId, ...target };
    return { requestId, kind: target.kind, target: target.path };
  }

  /**
   * 按本轮模式批准、独立审查或请求用户确认一次本地操作。
   *
   * 取消、关闭或请求失效都必须结束等待：取消继续走既有 AbortSignal，以 AbortError 结束，
   * 不能伪装成普通工具失败，否则模型会把一次取消当成一次失败的工具调用继续推理。
   */
  async request(target: ApprovalTarget | PluginApproval, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const policy = this.policy;
    if (policy?.mode === 'full-access') return true;
    // 本地文本工具已检查真实路径与写入版本；工作区内常规编辑不需要升级权限。
    if (policy !== undefined && (target.kind === 'create-file' || target.kind === 'edit-file')) {
      return true;
    }
    if (policy?.mode === 'auto-review') {
      const request = this.requestData(target, randomUUID());
      this.publish({ ...request, automaticReview: { status: 'reviewing' } });
      let review: AutomaticApprovalResult;
      try {
        review = await policy.review(target, signal);
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof Error)) throw error;
        this.publish({ ...request, automaticReview: { status: 'failed', reason: error.message } });
        // 解析、网络或超时失败都不能变成批准；原操作尚未跨过副作用边界。
        throw new ToolExecutionError(`自动审批未完成，操作未执行：${error.message}`, 'permanent');
      }
      this.publish({ ...request, automaticReview: { status: review.decision === 'approve' ? 'approved' : 'denied', risk: review.risk, reason: review.reason } });
      if (review.decision === 'deny') {
        // 可选服务和钩子沿用人工拒绝的跳过语义，不能阻止普通任务启动。
        if (target.kind === 'plugin-start') return false;
        throw new ToolExecutionError(`自动审批拒绝了该操作：${review.reason}。不要通过变换命令、间接执行或绕过策略追求相同效果；只能选择实质更安全的方案，否则停止并向用户说明。`, 'denied');
      }
      return true;
    }
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
      // 审批卡只展示宿主算出的确切操作参数；客户端能做的只有批准或拒绝。
      this.publish(this.requestData(target, requestId));
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
