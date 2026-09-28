import { BedrockHtmlEditor, estimateCostUsd, maxOutputTokensFor, maxPageBytesFor } from "./bedrock-editor";
import { FakeHtmlEditor } from "./fake-editor";
import type { HtmlEditorModel } from "./html-editor";
import { MAX_AI_INPUT_BYTES, MAX_PROMPT_BYTES } from "./prompt";

export { AiEditError } from "./html-editor";
export type { HtmlEditInput, HtmlEditResult, HtmlEditorModel } from "./html-editor";

/** Picks the editor from the environment. Defaults to the fake so nothing calls a paid model by accident. */
export function createHtmlEditor(env: Record<string, string | undefined>): HtmlEditorModel {
  const kind = env.DRAFTPAGE_AI_EDITOR || "fake";
  if (kind === "fake") {
    const delayMs = Number(env.DRAFTPAGE_AI_FAKE_DELAY_MS ?? 0);
    return new FakeHtmlEditor({ delayMs: Number.isFinite(delayMs) && delayMs > 0 ? Math.min(delayMs, 60_000) : 0 });
  }
  if (kind === "bedrock") {
    const modelId = env.DRAFTPAGE_AI_MODEL_ID;
    if (!modelId) throw new Error("DRAFTPAGE_AI_MODEL_ID is required when DRAFTPAGE_AI_EDITOR=bedrock");
    const region = env.DRAFTPAGE_AI_REGION || env.AWS_REGION;
    if (!region) throw new Error("DRAFTPAGE_AI_REGION or AWS_REGION is required when DRAFTPAGE_AI_EDITOR=bedrock");
    return new BedrockHtmlEditor({ region, modelId });
  }
  throw new Error(`Unknown DRAFTPAGE_AI_EDITOR "${kind}" (expected "fake" or "bedrock")`);
}

/** An upper bound on one attempt's input tokens: tokens never exceed bytes, and the prompt is capped. */
const WORST_INPUT_TOKENS = MAX_PROMPT_BYTES;

/**
 * The most one edit attempt can cost with the configured editor: the largest prompt in and
 * the reply cap out. The monthly AI budget holds this until an edit's real cost is known.
 * A model without a price is refused, so the budget can never be guessed low.
 */
export function worstCaseEditCostUsd(env: Record<string, string | undefined>): number {
  if ((env.DRAFTPAGE_AI_EDITOR || "fake") === "fake") return 0;
  const modelId = env.DRAFTPAGE_AI_MODEL_ID ?? "";
  const cost = estimateCostUsd(modelId, WORST_INPUT_TOKENS, maxOutputTokensFor(modelId));
  if (cost === null) {
    throw new Error(`No price for AI model "${modelId}": add it to PRICES in src/ai/bedrock-editor.ts before using it`);
  }
  return cost;
}

/** The largest page the configured editor takes: the input cap, or less when the model's reply limit can't hold it. */
export function maxAiPageBytes(env: Record<string, string | undefined>): number {
  if ((env.DRAFTPAGE_AI_EDITOR || "fake") === "fake") return MAX_AI_INPUT_BYTES;
  return Math.min(MAX_AI_INPUT_BYTES, maxPageBytesFor(maxOutputTokensFor(env.DRAFTPAGE_AI_MODEL_ID ?? "")));
}
