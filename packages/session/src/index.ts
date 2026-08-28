import type { ToolCall, ToolCallId } from '@agent-desktop/model';

export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };

export type ToolResult =
  | { readonly status: 'success'; readonly output: unknown }
  | { readonly status: 'error'; readonly message: string; readonly code?: string };

export interface TurnStartedEvent { readonly type: 'turn.started'; readonly turnId: TurnId; readonly timestamp?: string; }
export interface UserMessageEvent { readonly type: 'user.message'; readonly turnId: TurnId; readonly content: string; readonly timestamp?: string; }
export interface StepStartedEvent { readonly type: 'step.started'; readonly turnId: TurnId; readonly stepId: StepId; readonly timestamp?: string; }
export interface AssistantMessageEvent { readonly type: 'assistant.message'; readonly turnId: TurnId; readonly stepId: StepId; readonly content?: string; readonly toolCalls: readonly ToolCall[]; readonly timestamp?: string; }
export interface ToolCalledEvent { readonly type: 'tool.called'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly name: string; readonly input: unknown; readonly timestamp?: string; }
export interface ToolResultEvent { readonly type: 'tool.result'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly result: ToolResult; readonly timestamp?: string; }
export interface StepCompletedEvent { readonly type: 'step.completed'; readonly turnId: TurnId; readonly stepId: StepId; readonly timestamp?: string; }
export interface TurnCompletedEvent { readonly type: 'turn.completed'; readonly turnId: TurnId; readonly timestamp?: string; }

export type SessionEvent =
  | TurnStartedEvent
  | UserMessageEvent
  | StepStartedEvent
  | AssistantMessageEvent
  | ToolCalledEvent
  | ToolResultEvent
  | StepCompletedEvent
  | TurnCompletedEvent;

/** Append-only source of facts from one Agent execution. */
export interface Session {
  append(event: SessionEvent): void;
  events(): readonly SessionEvent[];
}

/** Minimal in-memory Session implementation used by tests and early runtime work. */
export class InMemorySession implements Session {
  private readonly history: SessionEvent[] = [];
  append(event: SessionEvent): void { this.history.push(event); }
  events(): readonly SessionEvent[] { return [...this.history]; }
}
