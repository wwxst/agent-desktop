import { randomUUID } from 'node:crypto';
import type { Agent } from '@agent-desktop/agent';
import type { ModelMessage, ModelResponse, ModelToolDefinition, ToolCall } from '@agent-desktop/model';
import type { SessionEvent, StepId, ToolResult, TurnId } from '@agent-desktop/session';

export interface RunTurnResult {
  readonly turnId: TurnId;
  readonly stepCount: number;
  readonly response: ModelResponse;
}

function createTurnId(): TurnId {
  return randomUUID() as TurnId;
}

function createStepId(): StepId {
  return randomUUID() as StepId;
}

function formatToolResultForModel(result: ToolResult): string {
  if (result.status === 'error') return result.message;
  if (typeof result.output === 'string') return result.output;

  try {
    return JSON.stringify(result.output) ?? String(result.output);
  } catch {
    return String(result.output);
  }
}

function buildModelMessages(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        messages.push({ role: 'user', content: event.content });
        break;
      case 'assistant.message':
        messages.push(event.content === undefined
          ? { role: 'assistant', toolCalls: event.toolCalls }
          : { role: 'assistant', content: event.content, toolCalls: event.toolCalls });
        break;
      case 'tool.result':
        messages.push({
          role: 'tool',
          toolCallId: event.toolCallId,
          content: formatToolResultForModel(event.result),
        });
        break;
      default:
        break;
    }
  }

  return messages;
}

function buildToolDefinitions(agent: Agent): ModelToolDefinition[] {
  return agent.tools.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function formatThrownValue(error: unknown): string {
  if (error instanceof Error) return error.message;

  try {
    return String(error);
  } catch {
    return 'Unknown tool execution error';
  }
}

async function executeToolCall(agent: Agent, turnId: TurnId, stepId: StepId, toolCall: ToolCall): Promise<void> {
  agent.session.append({
    type: 'tool.called',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  });

  const tool = agent.tools.get(toolCall.name);
  let result: ToolResult;

  if (!tool) {
    result = { status: 'error', message: `Tool not found: ${toolCall.name}` };
  } else {
    try {
      result = await tool.execute(toolCall.input);
    } catch (error) {
      result = { status: 'error', message: formatThrownValue(error) };
    }
  }

  agent.session.append({
    type: 'tool.result',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    result,
  });
}

export async function runTurn(agent: Agent, input: string): Promise<RunTurnResult> {
  const turnId = createTurnId();
  let stepCount = 0;

  agent.session.append({ type: 'turn.started', turnId });
  agent.session.append({ type: 'user.message', turnId, content: input });

  while (true) {
    const stepId = createStepId();
    stepCount += 1;
    agent.session.append({ type: 'step.started', turnId, stepId });

    const response = await agent.model.complete({
      systemPrompt: agent.systemPrompt.build(),
      messages: buildModelMessages(agent.session.events()),
      tools: buildToolDefinitions(agent),
    });

    agent.session.append(response.text === undefined
      ? { type: 'assistant.message', turnId, stepId, toolCalls: response.toolCalls }
      : { type: 'assistant.message', turnId, stepId, content: response.text, toolCalls: response.toolCalls });

    for (const toolCall of response.toolCalls) {
      await executeToolCall(agent, turnId, stepId, toolCall);
    }

    agent.session.append({ type: 'step.completed', turnId, stepId });

    if (response.toolCalls.length === 0) {
      agent.session.append({ type: 'turn.completed', turnId });
      return { turnId, stepCount, response };
    }
  }
}
