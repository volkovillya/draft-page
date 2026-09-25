/** Everything the model gets for one edit. All text fields come from users and are untrusted. */
export type HtmlEditInput = {
  html: string;
  instruction: string;
  excerpt: string | null;
  targetPath: string | null;
};

export type HtmlEditResult = {
  html: string;
  /** One or two plain-text sentences for the reply in the thread. */
  summary: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
};

/** The only seam between the job queue and a model provider. */
export interface HtmlEditorModel {
  edit(input: HtmlEditInput): Promise<HtmlEditResult>;
}

/**
 * An edit that didn't produce a usable page.
 * `retryable` is true for temporary trouble (throttling, timeouts, 5xx) so the queue retries,
 * false for permanent problems (bad output, refusal, page too big) so the job fails now.
 * The message is shown to reviewers: keep it short and never include model output or request ids.
 */
export class AiEditError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiEditError";
  }
}
