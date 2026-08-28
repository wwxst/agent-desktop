import type { Model } from '@agent-desktop/model';
import type { Session } from '@agent-desktop/session';
import type { SystemPrompt } from '@agent-desktop/system-prompt';
import type { ToolRegistry } from '@agent-desktop/tools';

// 使用品牌类型区分普通字符串和 Agent 标识，避免不同领域 ID 被误传。
export type AgentId = string & { readonly __brand: 'AgentId' };

/**
 * Agent 只保存运行身份和依赖，不承载执行算法。
 * 这样可以让 Agent Loop 独立演进，并保持 INV-003 的职责边界。
 */
export interface Agent {
  readonly id: AgentId;
  readonly model: Model;
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly systemPrompt: SystemPrompt;
}

// 构造参数与 Agent 结构完全一致，别名用于明确表达“创建时所需依赖”。
export type AgentDependencies = Agent;

/** 创建依赖容器但不启动 Turn，执行入口只属于 Agent Loop。 */
export function createAgent(dependencies: AgentDependencies): Agent {
  return dependencies;
}
