import type { Model } from '@agent-desktop/model';
import type { Session } from '@agent-desktop/session';
import type { SystemPrompt } from '@agent-desktop/system-prompt';
import type { ToolRegistry } from '@agent-desktop/tools';

/**
 * Agent 只保存运行依赖，不承载执行算法。
 * Agent Loop 直接消费这些依赖，避免为原样返回对象增加工厂层。
 */
export interface Agent {
  readonly model: Model;
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly systemPrompt: SystemPrompt;
}
