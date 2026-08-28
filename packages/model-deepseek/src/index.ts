import type {
  Model,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
  ToolCall,
  ToolCallId,
} from '@agent-desktop/model';

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek Provider 的最小配置，不提前加入采样、重试或流式选项。 */
export interface DeepSeekModelOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

interface DeepSeekFunctionCall {
  readonly name: string;
  readonly arguments: string;
}

interface DeepSeekToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: DeepSeekFunctionCall;
}

type DeepSeekMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
    readonly role: 'assistant';
    readonly content: string | null;
    readonly tool_calls?: readonly DeepSeekToolCall[];
  }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

interface DeepSeekToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

interface DeepSeekResponseMessage {
  readonly content?: string | null;
  readonly tool_calls?: readonly DeepSeekToolCall[];
}

/** unknown 响应只在 Provider 边界做当前协议所需的最小对象判断。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * System Prompt 在 Core 中保持独立字段；只有具体 Provider 知道 DeepSeek 需要 system role。
 * 这一步是 HTTP 协议转换，不会把供应商消息类型泄漏回 Agent Core。
 */
function mapMessages(request: ModelRequest): DeepSeekMessage[] {
  return [
    { role: 'system', content: request.systemPrompt },
    ...request.messages.map(mapMessage),
  ];
}

function mapMessage(message: ModelMessage): DeepSeekMessage {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      // DeepSeek Function Calling 使用 JSON 字符串传递 arguments，而 Core 保持 unknown 输入。
      const toolCalls = message.toolCalls.map((toolCall): DeepSeekToolCall => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        },
      }));

      return toolCalls.length === 0
        ? { role: 'assistant', content: message.content ?? null }
        : {
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: toolCalls,
        };
    }
    case 'tool':
      // Tool Result 用原 ToolCallId 回传，让 DeepSeek 能关联此前的 function call。
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

/** 把 Core 工具描述投影为 DeepSeek Function Calling 的 tools 协议。 */
function mapToolDefinition(tool: ModelToolDefinition): DeepSeekToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/** 只读取当前实现必需的 choices[0].message，缺失时给出明确 Provider 错误。 */
function readResponseMessage(payload: unknown): DeepSeekResponseMessage {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('DeepSeek API response is missing choices[0].message');
  }

  const firstChoice: unknown = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error('DeepSeek API response is missing choices[0].message');
  }

  return firstChoice.message as DeepSeekResponseMessage;
}

/** 将 DeepSeek 的 JSON arguments 还原为 Core Tool 可以直接接收的 unknown 输入。 */
function mapResponseToolCall(toolCall: DeepSeekToolCall): ToolCall {
  let input: unknown;

  try {
    input = JSON.parse(toolCall.function.arguments) as unknown;
  } catch {
    throw new Error(
      `DeepSeek API returned invalid tool arguments JSON for ${toolCall.function.name}`,
    );
  }

  return {
    id: toolCall.id as ToolCallId,
    name: toolCall.function.name,
    input,
  };
}

/**
 * DeepSeekModel 是 Core Model 接口到 DeepSeek HTTP 协议的适配器。
 * Agent Loop 只调用 Model.complete，因此完全不需要知道 DeepSeek 的存在。
 */
export class DeepSeekModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  public constructor(options: DeepSeekModelOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    // 去掉末尾斜线，确保自定义 baseUrl 与固定 endpoint 拼接结果唯一。
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: mapMessages(request),
        tools: request.tools.map(mapToolDefinition),
        // 第一版关闭 thinking，保持 Tool Call 往返与 MVP 行为一致。
        thinking: { type: 'disabled' },
      }),
    });

    // HTTP 状态属于 Provider 边界；直接抛出清晰错误并交给现有调用链传播。
    if (!response.ok) {
      throw new Error(`DeepSeek API request failed: ${response.status}`);
    }

    const message = readResponseMessage(await response.json());
    const toolCalls = (message.tool_calls ?? []).map(mapResponseToolCall);

    // exactOptionalPropertyTypes 要求无文本时省略 text，而不是写入 text: undefined。
    return typeof message.content === 'string'
      ? { text: message.content, toolCalls }
      : { toolCalls };
  }
}
