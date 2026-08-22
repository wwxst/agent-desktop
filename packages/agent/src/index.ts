import type { AgentId, Model } from '@agent-desktop/model';
import type { Session } from '@agent-desktop/session';
import type { SystemPrompt } from '@agent-desktop/system-prompt';
import type { ToolRegistry } from '@agent-desktop/tools';

export type { AgentId };

/** Runtime identity and dependency container; execution belongs to Agent Loop. */
export interface Agent {
  readonly id: AgentId;
  readonly model: Model;
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly systemPrompt: SystemPrompt;
}

export type AgentDependencies = Agent;

/** Constructs an Agent dependency container without starting execution. */
export function createAgent(dependencies: AgentDependencies): Agent {
  return dependencies;
}
