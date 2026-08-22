export type AgentId = string & { readonly __brand: 'AgentId' };
export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };

/** Provider-neutral description of a tool visible to a model. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: unknown;
}

export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content?: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: ToolCallId; readonly content: string };

/** Complete, non-streaming model request contract for the core runtime. */
export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

/** Complete model result; text and tool calls may appear together. */
export interface ModelResponse {
  readonly text?: string;
  readonly toolCalls: readonly ToolCall[];
}

/** Model provider boundary consumed by the future Agent Loop. */
export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
