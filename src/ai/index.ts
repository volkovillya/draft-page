import { BedrockHtmlEditor } from "./bedrock-editor";
import { FakeHtmlEditor } from "./fake-editor";
import type { HtmlEditorModel } from "./html-editor";

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
