import { AiEditError } from "./html-editor";
import type { HtmlEditInput, HtmlEditorModel, HtmlEditResult } from "./html-editor";
import { assertInputSize } from "./prompt";

/** Keeps the instruction from ending the HTML comment early ("--" is not allowed inside one). */
function commentSafe(text: string): string {
  return text.replace(/-{2,}/g, "-").replace(/[<>]/g, " ");
}

/**
 * Deterministic stand-in for a real model: no network, and an invisible edit (an HTML comment
 * at the end of <body>), so the page looks the same while the whole job flow still runs.
 * Used in tests and until the deployed account can call a real model.
 */
export class FakeHtmlEditor implements HtmlEditorModel {
  /** `delayMs` pretends the model takes a while, so the "Claude is working" UI can be seen and tested. */
  constructor(private readonly options: { fail?: "retryable" | "permanent"; delayMs?: number } = {}) {}

  async edit(input: HtmlEditInput): Promise<HtmlEditResult> {
    const started = performance.now();
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    if (this.options.fail === "retryable") throw new AiEditError("The AI service is busy or unavailable right now", true);
    if (this.options.fail === "permanent") throw new AiEditError("The model declined this request", false);
    // Same size limit as the real model, so behaviour doesn't change when the provider does.
    assertInputSize(input.html);

    const note = `<!-- Pretend AI edit (no model was called): ${commentSafe(input.instruction)} -->`;
    // At the end of <body>, where it can't renumber elements that pins point at.
    const close = input.html.toLowerCase().lastIndexOf("</body>");
    const at = close >= 0 ? close : input.html.length;
    return {
      html: input.html.slice(0, at) + note + input.html.slice(at),
      summary: "Pretend AI edit: no real model is connected yet, so the page itself is unchanged.",
      provider: "fake",
      model: "fake-editor",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: 0,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
