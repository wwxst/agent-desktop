import type { CapabilityApproval } from './tool-approval.js';
import { ToolExecutionError } from '@agent-desktop/tools';

export type NetworkPolicy =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'allowed' }
  | { readonly mode: 'approval-required' }
  | { readonly mode: 'allowlist'; readonly domains: readonly string[] };

function isWebUrl(url: URL): boolean { return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }

/** 网络准入使用真实 URL 的域名及端口，不根据工具名或模型自述授予网络访问。 */
export class NetworkAccessPolicy {
  constructor(private readonly policy: () => NetworkPolicy,
    private readonly approve: (target: CapabilityApproval, signal?: AbortSignal) => Promise<boolean>) {}

  async authorize(request: { readonly url: string; readonly method?: string; readonly resourceType?: string }, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const url = new URL(request.url);
    if (!isWebUrl(url)) return false;
    const policy = this.policy();
    if (policy.mode === 'disabled') return false;
    if (policy.mode === 'allowed') return true;
    if (policy.mode === 'allowlist') return policy.domains.includes(url.host);
    return this.approve({ kind: 'tool-action', capability: '网络访问', action: '请求远程资源',
      arguments: JSON.stringify({ url: url.href, method: request.method ?? 'GET', resourceType: request.resourceType ?? 'request' }, null, 2),
      sessionScope: `本会话内访问 ${url.origin}，包括该来源后续请求；不包含其他来源。`,
      sessionScopeKey: `network:${url.origin}` }, signal);
  }

  /** 设置页的明确连接操作本身就是用户授权，不再递归弹出 Agent 工具审批。 */
  async authorizeUserInitiated(request: { readonly url: string; readonly method?: string; readonly resourceType?: string }, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const url = new URL(request.url);
    return isWebUrl(url);
  }

  /**
   * 任意本机进程无法被宿主逐请求拦截；只有明确允许全部网络时才可在无 OS 隔离下启动。
   * allowlist/approval-required 仍需逐目标准入，不能把一次进程启动误当成域名授权。
   */
  allowsUnrestrictedProcess(): boolean {
    return this.policy().mode === 'allowed';
  }

  async require(request: { readonly url: string; readonly method?: string }, signal?: AbortSignal): Promise<void> {
    if (!await this.authorize(request, signal)) throw new ToolExecutionError(`网络策略拒绝访问：${new URL(request.url).origin}`, 'denied');
  }

  /** 用户已配置的模型端点是运行时基础依赖；仍受禁用和域名白名单约束，不重复弹出审批造成审查递归。 */
  async requireProvider(request: { readonly url: string; readonly method?: string }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ToolExecutionError('模型地址无效。', 'denied');
    const policy = this.policy();
    if (policy.mode === 'disabled') throw new ToolExecutionError(`网络策略拒绝访问：${url.origin}`, 'denied');
    if (policy.mode === 'allowlist' && !policy.domains.includes(url.host)) throw new ToolExecutionError(`网络策略拒绝访问：${url.origin}`, 'denied');
  }
}

/** 当前 Windows 宿主没有操作系统级隔离，要求强隔离的执行必须明确拒绝。 */
export class WindowsExecutionBoundary {
  readonly filesystemContainment = 'tool-path-policy' as const;
  readonly processIsolation = false;
  readonly networkIsolation = false;

  /**
   * 进程是否可以在当前网络策略下启动。
   *
   * 任意第三方进程都可以绕过宿主 fetch，因此在没有 OS 级网络隔离时，
   * 受限网络策略只能拒绝启动。受信任的随包本地 helper 不需要这条隔离，
   * 但仍通过同一入口声明它的信任边界。
   */
  assertProcessLaunch(options: { readonly target: string; readonly networkAllowed: boolean; readonly trustedLocal?: boolean }): void {
    if (options.trustedLocal === true || options.networkAllowed) return;
    this.requireProcessIsolation(options.target);
  }

  requireProcessIsolation(target = '外部进程'): never {
    throw new ToolExecutionError(`当前 Windows 运行环境不能建立操作系统进程及网络隔离；已拒绝启动${target}。`, 'denied');
  }
}
