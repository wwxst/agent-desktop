/** 系统提示词的唯一构建边界，避免 Agent Loop 在不同分支中自行拼接指令。 */
export interface SystemPrompt { build(): string; }

/** 最小不可变实现；构造后始终返回同一份基础系统指令。 */
export class StaticSystemPrompt implements SystemPrompt {
  public constructor(private readonly text: string) {}
  build(): string { return this.text; }
}
