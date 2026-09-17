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

/** DeepSeek Provider 的最小配置，不提前加入采样或重试选项。 */
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

/** 流式 Tool Call 分片；除 index 外所有字段都是可选增量。 */
interface DeepSeekToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

/** choices[0].delta 只包含当前实现需要的文本与 Tool Call 增量。 */
interface DeepSeekStreamDelta {
  readonly content?: string | null;
  readonly tool_calls?: readonly DeepSeekToolCallDelta[];
}

/** 同一个 index 的分片合并结果；id 与 name 是身份，argsJson 是增量拼接。 */
interface StreamedToolCall {
  id: string;
  name: string;
  argsJson: string;
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

/**
 * 找到下一个 SSE 事件边界。
 * SSE 用空行分隔事件，行尾既可能是 LF 也可能是 CRLF，
 * 因此边界是 "\n\n" 或 "\n\r\n"；这里只定位分隔符，不改写事件内容。
 */
function findEventBoundary(buffer: string): { readonly index: number; readonly length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 3 };
}

type SseEvent = { readonly kind: 'done' } | { readonly kind: 'payload'; readonly value: unknown };

/**
 * 从单个 SSE 事件块中取出 data 负载。
 * 当前只有 data 行承载 JSON；event、id 和注释行没有消费者，直接忽略。
 */
function readSseEvent(rawEvent: string): SseEvent | undefined {
  const dataLines: string[] = [];
  for (const rawLine of rawEvent.split('\n')) {
    // CRLF 行尾会在行内容末尾留下 \r；它属于行终止符，不是 data 内容。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) continue;
    // SSE 允许 "data:" 与 "data: " 两种写法，统一去掉可选空格。
    dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return undefined;

  const payload = dataLines.join('\n');
  // [DONE] 是协议规定的流结束标记，不是 JSON 负载。
  if (payload === '[DONE]') return { kind: 'done' };

  try {
    return { kind: 'payload', value: JSON.parse(payload) as unknown };
  } catch {
    throw new Error('DeepSeek API stream returned an invalid SSE data payload');
  }
}

/**
 * choices[0] 中当前实现需要的两个同级字段。
 * delta（增量）与 finish_reason（终止原因）在协议里同级；
 * 终止分片只带 finish_reason，delta 可能为空对象或缺失，因此 delta 允许为 undefined。
 */
interface DeepSeekStreamChoice {
  readonly delta: DeepSeekStreamDelta | undefined;
  readonly finishReason: string | undefined;
}

/**
 * 读取当前实现必需的 choices[0]。
 * finish_reason 必须从 choice 这一层读取：它与 delta 同级，
 * 把它当成 delta 的字段会丢掉真实的终止语义。
 * 没有 choices 或首个 choice 不是对象时返回 undefined，让调用方跳过该事件。
 */
function readStreamChoice(payload: unknown): DeepSeekStreamChoice | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice: unknown = payload.choices[0];
  if (!isRecord(firstChoice)) return undefined;

  const finishReason = firstChoice.finish_reason;
  return {
    // delta 缺失或不是对象时视为没有增量，而不是把损坏的形状当成空增量继续处理。
    delta: isRecord(firstChoice.delta) ? (firstChoice.delta as DeepSeekStreamDelta) : undefined,
    // finish_reason 为 null 表示该分片不是终止分片；空字符串同样不携带终止语义。
    finishReason: typeof finishReason === 'string' && finishReason.length > 0 ? finishReason : undefined,
  };
}

/**
 * 接受一个流式身份字段。
 * id 与 name 是 Tool Call 的身份而不是累积内容，只在该调用的首个分片出现；
 * 续传分片可能把它重发为空串（部分 OpenAI 兼容网关会这样做），
 * 这表示“不更新”，绝不能用它清空已经确定的身份。
 */
function acceptToolCallIdentity(current: string, incoming: unknown): string {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current;
}

/**
 * 读取流式 Tool Call 的必需身份字段。
 * id 或 name 缺失说明模型响应已经损坏；用空串继续会被 Agent Loop 当成“未知工具”，
 * 把真实的协议故障掩盖成一个看起来正常的业务错误。
 */
function requireToolCallField(value: string, field: string): string {
  if (value.length === 0) {
    throw new Error(`DeepSeek API streamed Tool Call is missing ${field}`);
  }
  return value;
}

/** 把同一 index 的分片合并成一个 Tool Call，arguments 按到达顺序拼接。 */
function appendToolCallDelta(
  toolCalls: Map<number, StreamedToolCall>,
  delta: DeepSeekToolCallDelta,
): void {
  // index 决定分片归属与最终 Tool 执行顺序，缺失或非法说明响应已经损坏。
  if (!Number.isInteger(delta.index) || delta.index < 0) {
    throw new Error('DeepSeek API streamed Tool Call is missing a valid index');
  }

  const toolCall = toolCalls.get(delta.index) ?? { id: '', name: '', argsJson: '' };
  toolCall.id = acceptToolCallIdentity(toolCall.id, delta.id);
  toolCall.name = acceptToolCallIdentity(toolCall.name, delta.function?.name);
  // arguments 是真正的增量，只需要按到达顺序拼接。
  if (typeof delta.function?.arguments === 'string') {
    toolCall.argsJson += delta.function.arguments;
  }
  toolCalls.set(delta.index, toolCall);
}

/** 将 DeepSeek 的 JSON arguments 还原为 Core Tool 可以直接接收的 unknown 输入。 */
function mapToolArguments(toolName: string, argsJson: string): unknown {
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    throw new Error(`DeepSeek API returned invalid tool arguments JSON for ${toolName}`);
  }
}

/**
 * 只有这两个 finish_reason 表示模型正常结束。
 * length（达到长度上限）、content_filter（内容过滤）、insufficient_system_resource（系统资源不足）
 * 与 aborted（服务端中断）都说明响应不完整，不能当成成功结果返回。
 */
function isSuccessfulFinishReason(finishReason: string): boolean {
  return finishReason === 'stop' || finishReason === 'tool_calls';
}

/**
 * 读取 SSE 流并拼装完整 Model Response。
 * 文本增量只通过 onTextDelta 实时上报；返回值始终是完整响应，
 * 因此 Session 仍然只记录完整 assistant 事实，不记录任何 token。
 * 只有收到 [DONE] 且终止原因是 stop 或 tool_calls 时，才认为响应完整。
 */
async function readStreamedResponse(
  body: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void,
): Promise<ModelResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const streamedToolCalls = new Map<number, StreamedToolCall>();
  let text = '';
  let receivedChoicesChunk = false;
  let receivedDone = false;
  let receivedFinishReason: string | undefined;
  let buffer = '';

  while (!receivedDone) {
    const { done, value } = await reader.read();
    // 流结束时必须 flush 解码器，取回可能保留的最后一个多字节序列，避免静默丢字节。
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    // SSE 用空行分隔事件；缓冲区末尾可能是不完整事件，必须留给下一段。
    let boundary = findEventBoundary(buffer);
    while (boundary !== undefined) {
      const event = readSseEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary.length);
      boundary = findEventBoundary(buffer);
      if (event === undefined) continue;

      // [DONE] 就是协议终点：立即结束读取，不等服务端关闭 HTTP body，
      // 也不让 DONE 之后到达的帧再影响结果；它本身不是 choices 分片。
      if (event.kind === 'done') {
        receivedDone = true;
        break;
      }

      const choice = readStreamChoice(event.value);
      if (choice === undefined) continue;
      receivedChoicesChunk = true;

      // 终止分片只带 finish_reason，delta 可能为空，因此两者都要读取，不能提前跳过。
      const delta = choice.delta;
      if (delta !== undefined) {
        // 空字符串增量没有展示价值，也不能进入返回值。
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          onTextDelta?.(delta.content);
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          appendToolCallDelta(streamedToolCalls, toolCallDelta);
        }
      }

      // 只有 stop 与 tool_calls 代表完整响应；length、content_filter、insufficient_system_resource、
      // aborted 都意味着文本或 Tool Call 可能被截断，必须立即失败，且不能被后面的分片覆盖。
      if (choice.finishReason !== undefined) {
        if (!isSuccessfulFinishReason(choice.finishReason)) {
          throw new Error(`DeepSeek API stream terminated with finish_reason ${choice.finishReason}`);
        }
        receivedFinishReason = choice.finishReason;
      }
    }

    if (done) break;
  }

  // 协议要求以 data: [DONE] 结束；缺失说明响应被截断，不能把部分结果伪装成成功响应。
  if (!receivedDone) {
    throw new Error('DeepSeek API stream ended before [DONE]');
  }
  // 200 响应里没有任何 choices 分片说明响应不符合协议，不能伪装成空成功结果。
  if (!receivedChoicesChunk) {
    throw new Error('DeepSeek API stream ended without a choices chunk');
  }
  // [DONE] 前没有终止原因，说明服务端没有给出结束语义，无法判断响应是否完整。
  if (receivedFinishReason === undefined) {
    throw new Error('DeepSeek API stream ended without a terminating finish_reason');
  }

  const toolCalls: ToolCall[] = [...streamedToolCalls]
    // index 是协议给出的调用顺序，显式排序后 Agent Loop 才能按同一顺序执行 Tool。
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]): ToolCall => {
      const id = requireToolCallField(toolCall.id, 'id');
      const name = requireToolCallField(toolCall.name, 'name');
      return {
        id: id as ToolCallId,
        name,
        input: mapToolArguments(name, toolCall.argsJson),
      };
    });

  // exactOptionalPropertyTypes 要求无文本时省略 text，而不是写入 text: undefined。
  return text.length === 0 ? { toolCalls } : { text, toolCalls };
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
        // 始终使用 SSE 流式响应，让文本增量能在 Turn 执行期间实时展示。
        stream: true,
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    // HTTP 状态属于 Provider 边界；直接抛出清晰错误并交给现有调用链传播。
    if (!response.ok) {
      throw new Error(`DeepSeek API request failed: ${response.status}`);
    }
    // 200 响应必须带 body；缺失说明响应不符合 HTTP 契约，直接暴露程序错误。
    if (response.body === null) {
      throw new Error('DeepSeek API response is missing a body');
    }

    // 取消时 reader.read() 直接抛出 AbortError；这里不做任何捕获或转换，保持取消语义。
    const streamed = await readStreamedResponse(response.body, request.onTextDelta);

    // [DONE] 之后不再等待 body EOF，因此这里补一次取消检查：
    // Turn 已取消时不能把已经拼好的响应当成成功结果返回。
    if (request.signal?.aborted === true) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    return streamed;
  }
}
