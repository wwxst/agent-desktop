/** Boundary that supplies the base system instruction text. */
export interface SystemPrompt { build(): string; }

/** Minimal immutable system prompt implementation. */
export class StaticSystemPrompt implements SystemPrompt {
  public constructor(private readonly text: string) {}
  build(): string { return this.text; }
}
