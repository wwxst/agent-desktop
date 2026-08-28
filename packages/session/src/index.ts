import type { ToolCall, ToolCallId } from '@agent-desktop/model';

// 两种品牌类型都基于 string，但在编译期分别约束 Turn 和 Step 的归属关系。
export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };

// status 是判别字段：成功结果保存未知输出，失败结果只保存可序列化的错误事实。
export type ToolResult =
  | { readonly status: 'success'; readonly output: unknown }
  | { readonly status: 'error'; readonly message: string; readonly code?: string };

/** 记录一次 Turn 已经开始。 */
export interface TurnStartedEvent { readonly type: 'turn.started'; readonly turnId: TurnId; readonly timestamp?: string; }
/** 记录进入 Session 的原始用户输入。 */
export interface UserMessageEvent { readonly type: 'user.message'; readonly turnId: TurnId; readonly content: string; readonly timestamp?: string; }
/** 记录一次模型调用所对应 Step 的开始。 */
export interface StepStartedEvent { readonly type: 'step.started'; readonly turnId: TurnId; readonly stepId: StepId; readonly timestamp?: string; }
/** 完整保存模型文本和工具调用，两者不是互斥关系。 */
export interface AssistantMessageEvent { readonly type: 'assistant.message'; readonly turnId: TurnId; readonly stepId: StepId; readonly content?: string; readonly toolCalls: readonly ToolCall[]; readonly timestamp?: string; }
/** 在执行前记录工具调用，确保后续成功或失败结果都有可追踪的起点。 */
export interface ToolCalledEvent { readonly type: 'tool.called'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly name: string; readonly input: unknown; readonly timestamp?: string; }
/** 保存工具执行事实，并通过 ToolCallId 与调用事件建立关联。 */
export interface ToolResultEvent { readonly type: 'tool.result'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly result: ToolResult; readonly timestamp?: string; }
/** 记录当前 Step 的所有模型输出和工具结果已经处理完成。 */
export interface StepCompletedEvent { readonly type: 'step.completed'; readonly turnId: TurnId; readonly stepId: StepId; readonly timestamp?: string; }
/** 记录 Turn 已经自然结束。 */
export interface TurnCompletedEvent { readonly type: 'turn.completed'; readonly turnId: TurnId; readonly timestamp?: string; }

// type 字段组成可辨识联合，消费方可以通过 switch 获得精确的事件类型收窄。
export type SessionEvent =
  | TurnStartedEvent
  | UserMessageEvent
  | StepStartedEvent
  | AssistantMessageEvent
  | ToolCalledEvent
  | ToolResultEvent
  | StepCompletedEvent
  | TurnCompletedEvent;

/** Session 是 Agent 执行事实的只追加来源，不提供修改或删除历史的接口。 */
export interface Session {
  append(event: SessionEvent): void;
  events(): readonly SessionEvent[];
}

/** MVP 使用的内存 Session；数组只在内部持有，保持 append-only 语义。 */
export class InMemorySession implements Session {
  private readonly history: SessionEvent[] = [];

  // 新事实只追加到末尾，不重写既有事件。
  append(event: SessionEvent): void { this.history.push(event); }

  // 返回副本，防止调用方通过数组方法绕过 append 修改内部历史。
  events(): readonly SessionEvent[] { return [...this.history]; }
}
