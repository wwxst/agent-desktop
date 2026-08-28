// 品牌类型让 Tool Call 标识不能与任意字符串或其他 ID 混用。
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };

/** 模型可见的供应商无关工具描述，刻意不包含运行时 execute 方法。 */
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

// 通过 role 作为判别字段建立可辨识联合，使不同消息只能携带各自合法字段。
export type ModelMessage =
  | { readonly role: 'user'; readonly content: string }
  // assistant 文本和工具调用可以同时存在，因此 content 是可选字段而不是互斥分支。
  | { readonly role: 'assistant'; readonly content?: string; readonly toolCalls: readonly ToolCall[] }
  // 工具消息通过 ToolCallId 回连请求，保证结果在模型上下文中可追踪。
  | { readonly role: 'tool'; readonly toolCallId: ToolCallId; readonly content: string };

/**
 * 完整、非流式的模型请求。
 * systemPrompt 保持独立字段，避免再通过 system role 建立第二个系统提示词入口。
 */
export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

/** 完整模型响应；文本和工具调用允许同时出现，Agent Loop 必须完整记录两者。 */
export interface ModelResponse {
  readonly text?: string;
  readonly toolCalls: readonly ToolCall[];
}

/** 模型供应商边界，核心层只依赖 complete 契约，不接触任何厂商 SDK。 */
export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
