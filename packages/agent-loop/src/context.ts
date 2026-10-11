import { createHash } from 'node:crypto';
import { ModelRequestError, type Model, type ModelMessage, type ModelResponse, type ModelToolDefinition, type ToolResult } from '@agent-desktop/model';
import {
  projectRecoveryAncestry, projectRecoveryFacts, recoverSessionEvents, SessionPersistenceError,
  type AssistantMessageEvent, type ContextCompactedEvent, type Session, type SessionEvent,
  type StepCompletedEvent, type ToolResultEvent, type TurnId,
} from '@agent-desktop/session';

export interface ContextBudget { readonly contextWindow: number; readonly maxOutputTokens: number; }
export interface PrepareModelContextInput {
  readonly model: Model; readonly session: Session; readonly turnId: TurnId;
  readonly systemPrompt: string; readonly tools: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal; readonly budget?: ContextBudget;
}
export class ContextBudgetError extends Error {
  override readonly name = 'ContextBudgetError';
  constructor(message: string, cause?: unknown) { super(message, { cause }); }
}

// 只有摘要模型边界的明确格式错误可回退；程序错误和持久化错误不能混入此类。
class SummaryFormatError extends Error {
  override readonly name = 'SummaryFormatError';
}
interface SummaryPayload { readonly summary: string; readonly sourceEventIndexes: readonly number[]; }
interface IndexedStepSource { readonly sourceEventIndex: number; readonly event: AssistantMessageEvent | ToolResultEvent; }
interface CompleteStep { readonly endEventIndex: number; readonly event: StepCompletedEvent; readonly sources: readonly IndexedStepSource[]; }
export interface ValidatedContextSummary {
  readonly event: ContextCompactedEvent;
  readonly cumulativeCoveredStepEndEventIndexes: readonly number[];
  readonly sourceEventIndexes: readonly number[];
  readonly payload: SummaryPayload;
}

/** JSON 对象按键递归排序，数组保持顺序；不能序列化的真实结果直接暴露程序错误。 */
function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  if (text === undefined) throw new Error('上下文来源必须可序列化为 JSON。');
  return text;
}

/** 用 UTF-8 字节加协议开销作保守估算，不把它宣传成供应商精确 token 用量。 */
export function estimateContextTokens(input: {
  readonly systemPrompt: string; readonly messages: readonly ModelMessage[]; readonly tools: readonly ModelToolDefinition[];
}): number {
  return 256 + Buffer.byteLength(input.systemPrompt, 'utf8') + Buffer.byteLength(canonicalJson(input.tools), 'utf8')
    + input.messages.reduce((total, message) => total + 64 + Buffer.byteLength(canonicalJson(message), 'utf8'), 0);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof SessionPersistenceError || (signal.reason instanceof Error && signal.reason.name === 'AbortError')) throw signal.reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}

function formatToolResult(result: ToolResult): string {
  if (result.status === 'error' && result.output === undefined) return result.message;
  if (result.status === 'success' && typeof result.output === 'string') return result.output;
  // 正常协议保留现有 JSON 输出顺序；来源 digest 的排序不能顺手改变工具消息契约。
  const text = JSON.stringify(result.output);
  if (text === undefined) throw new Error('Tool result output must be JSON-serializable');
  return result.status === 'error' ? `${result.message}\n${text}` : text;
}
const stepKey = (event: { readonly turnId: TurnId; readonly stepId: string }): string => JSON.stringify([event.turnId, event.stepId]);

/** 以完成事件的精确位置选择整个 Step，不把索引区间中的其他轮次一并覆盖。 */
function completeSteps(events: readonly SessionEvent[]): CompleteStep[] {
  const sources = new Map<string, IndexedStepSource[]>();
  const steps: CompleteStep[] = [];
  events.forEach((event, sourceEventIndex) => {
    if (event.type === 'assistant.message' || event.type === 'tool.result') {
      const key = stepKey(event);
      const current = sources.get(key) ?? [];
      current.push({ sourceEventIndex, event }); sources.set(key, current);
    }
    if (event.type === 'step.completed') steps.push({ endEventIndex: sourceEventIndex, event, sources: [...(sources.get(stepKey(event)) ?? [])] });
  });
  return steps;
}

function selectedSources(steps: readonly CompleteStep[], covered: readonly number[]): IndexedStepSource[] {
  const selected = new Set<number>();
  for (const index of covered) {
    if (!Number.isSafeInteger(index) || index < 0 || selected.has(index)) throw new SummaryFormatError('摘要覆盖索引必须是已存在且不重复的模型步骤完成事件。');
    selected.add(index);
    if (!steps.some(step => step.endEventIndex === index)) throw new SummaryFormatError('摘要不能覆盖未完成或不存在的模型步骤。');
  }
  const sources = steps.filter(step => selected.has(step.endEventIndex)).flatMap(step => step.sources).sort((left, right) => left.sourceEventIndex - right.sourceEventIndex);
  if (new Set(sources.map(source => source.sourceEventIndex)).size !== sources.length) throw new SummaryFormatError('摘要不能重复覆盖同一原始事实。');
  return sources;
}

function sourcePayload(previous: ContextCompactedEvent | undefined, sources: readonly IndexedStepSource[]) {
  return { previousSummarySourceDigest: previous?.sourceDigest ?? null, previousSummaryText: previous?.summary ?? null, newStepSources: sources };
}
function sourceDigest(previous: ContextCompactedEvent | undefined, sources: readonly IndexedStepSource[]): string {
  return createHash('sha256').update(canonicalJson(sourcePayload(previous, sources)), 'utf8').digest('hex');
}

function parseSummary(text: string, allowedSources: ReadonlySet<number>): SummaryPayload {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw new SummaryFormatError('摘要不是有效 JSON。', { cause: error }); throw error; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SummaryFormatError('摘要必须包含文本和来源索引。');
  const fields = value as Record<string, unknown>;
  if (typeof fields.summary !== 'string' || !fields.summary.trim() || !Array.isArray(fields.sourceEventIndexes) || fields.sourceEventIndexes.length === 0) throw new SummaryFormatError('摘要文本与事实来源不能为空。');
  const indexes: number[] = [];
  for (const index of fields.sourceEventIndexes) {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || !allowedSources.has(index) || indexes.includes(index)) throw new SummaryFormatError('摘要事实引用超出覆盖来源或重复。');
    indexes.push(index);
  }
  return { summary: fields.summary, sourceEventIndexes: indexes };
}

/** 文件/重启消费者复用同一校验，摘要来源不能由旧缓存或模型自行声称。 */
export function validateContextCompactedEvent(events: readonly SessionEvent[], eventIndex: number): ValidatedContextSummary {
  const chain: { index: number; event: ContextCompactedEvent }[] = [];
  let currentIndex = eventIndex;
  while (true) {
    const event = events[currentIndex];
    if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || event?.type !== 'context.compacted') throw new SummaryFormatError('摘要事件来源不存在。');
    chain.push({ index: currentIndex, event });
    if (event.previousSummaryEventIndex === undefined) break;
    if (event.previousSummaryEventIndex >= currentIndex) throw new SummaryFormatError('摘要不能引用自己或未来摘要。');
    currentIndex = event.previousSummaryEventIndex;
  }
  const steps = completeSteps(events);
  const covered = new Set<number>();
  const allowedSources = new Set<number>();
  let previous: ContextCompactedEvent | undefined;
  let validated: ValidatedContextSummary | undefined;
  for (const { index, event } of chain.reverse()) {
    if (event.coveredStepEndEventIndexes.length === 0 || event.coveredStepEndEventIndexes.some(end => end >= index || covered.has(end))) throw new SummaryFormatError('摘要覆盖不能为空，不能包含未来或重复覆盖的步骤。');
    const sources = selectedSources(steps, event.coveredStepEndEventIndexes);
    if (sources.some(source => allowedSources.has(source.sourceEventIndex))) throw new SummaryFormatError('摘要不能重复覆盖同一原始事实。');
    if (sourceDigest(previous, sources) !== event.sourceDigest) throw new SummaryFormatError('摘要来源摘要与原始事实不一致。');
    for (const source of sources) allowedSources.add(source.sourceEventIndex);
    const payload = parseSummary(event.summary, allowedSources);
    for (const end of event.coveredStepEndEventIndexes) covered.add(end);
    validated = { event, payload, cumulativeCoveredStepEndEventIndexes: [...covered], sourceEventIndexes: [...allowedSources] };
    previous = event;
  }
  return validated!;
}

/** 摘要输入使用的确切数据表示也是 SHA-256 的输入；不哈希不可解释的范围描述。 */
export function createContextSourceDigest(events: readonly SessionEvent[], coveredStepEndEventIndexes: readonly number[], previousSummaryEventIndex?: number): string {
  const previous = previousSummaryEventIndex === undefined ? undefined : validateContextCompactedEvent(events, previousSummaryEventIndex);
  if (coveredStepEndEventIndexes.length === 0 || coveredStepEndEventIndexes.some(index => previous?.cumulativeCoveredStepEndEventIndexes.includes(index))) throw new SummaryFormatError('摘要不能空覆盖或重新覆盖已有步骤。');
  return sourceDigest(previous?.event, selectedSources(completeSteps(events), coveredStepEndEventIndexes));
}

/** 计划原文仅是意图；未知效果和未完整步骤的成功事实以资料文本保留，不伪造 tool 消息。 */
function importantFacts(events: readonly SessionEvent[], turnId: TurnId, steps: readonly CompleteStep[], keepCompletedIdentities: boolean): string[] {
  const ancestry = projectRecoveryAncestry(events, turnId);
  const taskTurns = new Set(ancestry.turnIds);
  const latestPlanIndex = events.findLastIndex(event => event.type === 'plan.updated' && taskTurns.has(event.turnId));
  const sessionPlanIndex = events.findLastIndex(event => event.type === 'plan.updated');
  const facts = projectRecoveryFacts(events);
  const completeKeys = new Set(steps.map(step => stepKey(step.event)));
  const retained = new Set<number>();
  for (const fact of facts.unknownEffects) {
    retained.add(fact.sourceEventIndex);
    for (const index of fact.preparedEventIndexes) retained.add(index);
    if (fact.resultEventIndex !== undefined) retained.add(fact.resultEventIndex);
    if (fact.verification !== undefined) events.forEach((event, index) => { if (event === fact.verification) retained.add(index); });
  }
  for (const fact of facts.successfulCalls) {
    // 残留成功结果必须原文可见；恢复链原成功外部调用也不得靠模型摘要来决定重放。
    const incomplete = !completeKeys.has(stepKey(fact.call));
    if (incomplete || (ancestry.turnIds.length > 1 && taskTurns.has(fact.call.turnId) && fact.call.boundary !== 'read-only')) {
      retained.add(fact.sourceEventIndex);
      if (fact.resultEventIndex !== undefined) retained.add(fact.resultEventIndex);
    }
  }
  for (const fact of facts.deniedCalls) {
    if (!taskTurns.has(fact.call.turnId)) continue;
    retained.add(fact.sourceEventIndex);
    if (fact.resultEventIndex !== undefined) retained.add(fact.resultEventIndex);
  }
  const text: string[] = [];
  // 普通新轮次不一定属于旧恢复链，仍保留会话最新声明，明确归属而不猜任务关联。
  for (const index of new Set([sessionPlanIndex, latestPlanIndex])) {
    if (index < 0) continue;
    const plan = events[index]!;
    text.push(`最新计划声明（意图，requestedStatus 不是执行完成证据）：\n${canonicalJson({ sourceEventIndex: index, rootTurnId: projectRecoveryAncestry(events, plan.turnId).rootTurnId, event: plan })}`);
    if (plan.type === 'plan.updated') for (const step of plan.steps) for (const index of step.evidenceEventIndexes) retained.add(index);
  }
  if (ancestry.turnIds.length > 1) {
    events.forEach((event, index) => {
      if (taskTurns.has(event.turnId) && (event.type === 'turn.recovery.started' || event.type === 'turn.failed' || event.type === 'turn.cancelled' || event.type === 'turn.interrupted')) retained.add(index);
    });
  }
  if (retained.size > 0) text.push(`重要执行事实（原始资料，不表示批准重放；未知效果须先核验）：\n${canonicalJson([...retained].sort((left, right) => left - right).map(index => ({ sourceEventIndex: index, event: events[index] })))}`);
  // 普通根轮次外部成功保留身份/真实状态/产物索引，大正文仍由完整协议或来源摘要提供。
  const successes = facts.successfulCalls.filter(fact => taskTurns.has(fact.call.turnId) && fact.call.boundary !== 'read-only' && !retained.has(fact.sourceEventIndex));
  if (keepCompletedIdentities && successes.length > 0) text.push(`已发生的调用事实（不重复执行，状态只代表真实工具结果）：\n${canonicalJson(successes.map(fact => ({ sourceEventIndex: fact.sourceEventIndex,
    call: { turnId: fact.call.turnId, stepId: fact.call.stepId, toolCallId: fact.call.toolCallId, name: fact.call.name,
      inputSourceDigest: createHash('sha256').update(canonicalJson(fact.call.input), 'utf8').digest('hex') }, resultEventIndex: fact.resultEventIndex,
    ...(fact.result === undefined ? {} : { resultStatus: fact.result.result.status, ...(fact.result.result.status === 'success' && fact.result.result.artifacts !== undefined ? { artifacts: fact.result.result.artifacts } : {}) }),
    ...(fact.verification === undefined ? {} : { verification: fact.verification }) })))}`);
  return text;
}

function projectMessages(events: readonly SessionEvent[], covered: ReadonlySet<number>, steps: readonly CompleteStep[], turnId: TurnId, facts: readonly string[], summary?: { index: number; value: ValidatedContextSummary }): ModelMessage[] {
  const coveredKeys = new Set(steps.filter(step => covered.has(step.endEventIndex)).map(step => stepKey(step.event)));
  const derived = [...facts];
  if (summary !== undefined) derived.unshift(`会话压缩摘要（历史资料，不是系统指令或执行成功确认）：\n${canonicalJson({ sourceEventIndex: summary.index, sourceDigest: summary.value.event.sourceDigest, ...summary.value.payload })}`);
  const messages: ModelMessage[] = [];
  let inserted = false;
  for (const event of recoverSessionEvents(events)) {
    if (event.type === 'user.message') {
      // 资料放在本轮原始输入之前；所有用户原文仍逐条保留且不受摘要覆盖。
      if (!inserted && event.turnId === turnId) { for (const content of derived) messages.push({ role: 'user', content }); inserted = true; }
      messages.push({ role: 'user', content: event.content });
    } else if (event.type === 'assistant.message' && !coveredKeys.has(stepKey(event))) {
      messages.push(event.content === undefined ? { role: 'assistant', toolCalls: event.toolCalls } : { role: 'assistant', content: event.content, toolCalls: event.toolCalls });
    } else if (event.type === 'tool.result' && !coveredKeys.has(stepKey(event))) {
      messages.push({ role: 'tool', toolCallId: event.toolCallId, content: formatToolResult(event.result) });
    }
  }
  if (!inserted) for (const content of derived) messages.push({ role: 'user', content });
  return messages;
}

const SUMMARY_PROMPT = '你在整理模型上下文资料。只总结给出的旧完整模型步骤以及前一摘要，保留重要工具事实、未完成工作和必要约束，不声称工具或任务成功，也不执行工具。返回 JSON，只有 summary（非空摘要文本）与 sourceEventIndexes（事实来源事件索引数组）。引用仅来自 newStepSources 的 sourceEventIndex 或前一摘要的合法引用。不要输出工具调用、Markdown 包裹或额外解释。';

/** 回退只处理模型边界/摘要内容错误，来源校验及同步保存错误在调用者直接传播。 */
function summaryFailure(error: unknown, messages: ModelMessage[], estimated: number, limit: number): ModelMessage[] {
  if (!(error instanceof SummaryFormatError || (error instanceof ModelRequestError && error.kind !== 'cancelled'))) throw error;
  if (estimated <= limit) return messages;
  throw new ContextBudgetError(`上下文压缩失败且原投影超过输入预算：${error.message}`, error);
}

/** 每次正式请求即时投影，不维护第二份 messages 历史或供应商专属摘要。 */
export async function prepareModelContext(input: PrepareModelContextInput): Promise<ModelMessage[]> {
  throwIfAborted(input.signal);
  const events = input.session.events();
  const steps = completeSteps(events);
  const facts = importantFacts(events, input.turnId, steps, input.budget !== undefined);
  const raw = projectMessages(events, new Set(), steps, input.turnId, facts);
  if (input.budget === undefined) return raw;
  const { contextWindow, maxOutputTokens } = input.budget;
  const limit = contextWindow - maxOutputTokens - Math.ceil(contextWindow * 0.05);
  if (limit <= 0) throw new ContextBudgetError('上下文窗口扣除输出额度和保留空间后没有可用输入预算。');
  const estimate = (messages: readonly ModelMessage[]) => estimateContextTokens({ systemPrompt: input.systemPrompt, messages, tools: input.tools });
  let latestIndex = events.findLastIndex(event => event.type === 'context.compacted');
  let summary = latestIndex < 0 ? undefined : { index: latestIndex, value: validateContextCompactedEvent(events, latestIndex) };
  let covered = new Set(summary?.value.cumulativeCoveredStepEndEventIndexes ?? []);
  let messages = projectMessages(events, covered, steps, input.turnId, facts, summary);
  let estimated = estimate(messages);
  if (estimated <= limit * 0.8) return messages;
  // 原用户文本、schema、计划及待核验事实不能被摘要替代，先判断无损保留部分能否装入。
  const mandatory = projectMessages(events, new Set(steps.map(step => step.endEventIndex)), steps, input.turnId, facts);
  if (estimate(mandatory) > limit) throw new ContextBudgetError('必须保留的用户约束、计划、执行事实或工具定义超过输入预算。');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(input.signal);
    const remaining = steps.filter(step => !covered.has(step.endEventIndex) && step.sources.length > 0);
    let keepTail = Math.min(2, remaining.length);
    if (estimated > limit) {
      // 先估算“旧步骤全可压缩”时尾部与必留资料能否装入，避免两次预算浪费在小旧块上。
      // 摘要最多占输出额度加一条消息开销；尾部过大时保留数量可降到 1 或 0。
      while (keepTail > 0) {
        const wouldCover = new Set([...covered, ...remaining.slice(0, remaining.length - keepTail).map(step => step.endEventIndex)]);
        const tailMessages = projectMessages(events, wouldCover, steps, input.turnId, facts);
        if (estimate(tailMessages) + maxOutputTokens + 128 <= limit && remaining.length > keepTail) break;
        keepTail -= 1;
      }
    }
    const candidates = remaining.slice(0, remaining.length - keepTail);
    if (candidates.length === 0) break;
    const chunk: CompleteStep[] = [];
    let chunkSources: IndexedStepSource[] = [];
    let summaryMessages: ModelMessage[] = [];
    for (const step of candidates) {
      const proposed = [...chunkSources, ...step.sources].sort((left, right) => left.sourceEventIndex - right.sourceEventIndex);
      const proposedMessages: ModelMessage[] = [{ role: 'user', content: canonicalJson(sourcePayload(summary?.value.event, proposed)) }];
      if (estimateContextTokens({ systemPrompt: SUMMARY_PROMPT, messages: proposedMessages, tools: [] }) > limit) break;
      chunk.push(step); chunkSources = proposed; summaryMessages = proposedMessages;
    }
    if (chunk.length === 0) throw new ContextBudgetError('单个完整模型步骤及摘要指令超过输入预算，不能拆分工具调用和结果。');
    const newCovered = chunk.map(step => step.endEventIndex);
    const allowedSources = new Set([...(summary?.value.sourceEventIndexes ?? []), ...chunkSources.map(source => source.sourceEventIndex)]);
    let payload: SummaryPayload;
    try {
      // 摘要只请求一次，没有模型重试、工具或 UI 流式回调。
      const response: ModelResponse = await input.model.complete({ systemPrompt: SUMMARY_PROMPT, messages: summaryMessages, tools: [], maxOutputTokens,
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
      throwIfAborted(input.signal);
      if (response.toolCalls.length > 0 || response.text === undefined || !response.text.trim()) throw new SummaryFormatError('摘要响应必须有文本且不能有工具调用。');
      if (Buffer.byteLength(response.text, 'utf8') > maxOutputTokens) throw new SummaryFormatError('摘要输出超过保守输出额度。');
      payload = parseSummary(response.text, allowedSources);
    } catch (error) {
      throwIfAborted(input.signal);
      return summaryFailure(error, messages, estimated, limit);
    }
    const event: ContextCompactedEvent = { type: 'context.compacted', turnId: input.turnId, coveredStepEndEventIndexes: newCovered,
      ...(summary === undefined ? {} : { previousSummaryEventIndex: summary.index }), sourceDigest: sourceDigest(summary?.value.event, chunkSources), summary: canonicalJson(payload),
      estimatorVersion: 1, estimatedBefore: estimated, estimatedAfter: 0 };
    const candidateIndex = input.session.events().length;
    const candidate = validateContextCompactedEvent([...input.session.events(), event], candidateIndex);
    const proposed = projectMessages(events, new Set(candidate.cumulativeCoveredStepEndEventIndexes), steps, input.turnId, facts, { index: candidateIndex, value: candidate });
    const after = estimate(proposed);
    if (after >= estimated) return summaryFailure(new SummaryFormatError('摘要未降低上下文估算。'), messages, estimated, limit);
    // 来源和保存都在格式回退之外；内部错误不能被当作一次普通摘要失败掩盖。
    throwIfAborted(input.signal);
    input.session.append({ ...event, estimatedAfter: after });
    latestIndex = candidateIndex;
    summary = { index: latestIndex, value: { ...candidate, event: { ...event, estimatedAfter: after } } };
    covered = new Set(candidate.cumulativeCoveredStepEndEventIndexes); messages = proposed; estimated = after;
    if (estimated <= limit * 0.8) return messages;
  }
  if (estimated > limit) throw new ContextBudgetError('两次摘要请求后上下文仍超过输入预算。');
  return messages;
}
