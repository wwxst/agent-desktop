import type { ToolResult } from '@agent-desktop/model';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';

export interface UserQuestion { readonly question: string; readonly options?: readonly string[]; }
export type UserAnswer = { readonly outcome: 'answered'; readonly answer: string } | { readonly outcome: 'skipped' };
export type AskUserPort = (question: UserQuestion, context: ToolExecutionContext) => Promise<UserAnswer>;

/** 问答是应用层交互；它只等待宿主答复，不启动新轮次或批准副作用。 */
export class AskUserTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly name = 'ask_user';
  readonly description = '任务确实需要用户补充信息时提问；回答后继续当前轮次。回答不是文件或命令授权。';
  readonly inputSchema = { type: 'object', properties: {
    question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
  }, required: ['question'], additionalProperties: false };
  constructor(private readonly ask: AskUserPort) {}
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null) return { status: 'error', message: 'ask_user requires an object' };
    const { question, options } = input as Record<string, unknown>;
    if (typeof question !== 'string' || !question.trim() || question.length > 2000
      || (options !== undefined && (!Array.isArray(options) || options.length < 2 || options.length > 4
        || !options.every((option) => typeof option === 'string' && option.trim() && option.length <= 200)))) {
      return { status: 'error', message: '问题不能为空，最多 2000 字；可选项必须为 2–4 个非空短文本。' };
    }
    const answer = await this.ask({ question, ...(options === undefined ? {} : { options: options as string[] }) }, context);
    return { status: 'success', output: { question, ...answer } };
  }
}
