// Abstract base for per-language Generate pipelines; actionsFor yields the per-row StepActions, postActions runs after a row's sub-actions complete.

export class LanguagePipeline {
  get language(): string {
    throw new Error("LanguagePipeline.language is abstract");
  }

  actionsFor(_stepKey: string, _ctx: unknown): unknown {
    throw new Error("LanguagePipeline.actionsFor is abstract");
  }

  async postActions(_stepKey: string, _ctx: unknown): Promise<void> {}
}
