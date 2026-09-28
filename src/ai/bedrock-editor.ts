import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseResponse } from "@aws-sdk/client-bedrock-runtime";
import { AiEditError } from "./html-editor";
import type { HtmlEditInput, HtmlEditorModel, HtmlEditResult } from "./html-editor";
import { assertInputSize, assertPromptSize, buildEditPrompt, byteLength, parseEditReply, validateEditedHtml } from "./prompt";

export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const MIN_OUTPUT_TOKENS = 8000;
// A full 32k-token reply can take minutes. Must stay below the Lambda timeout (infra/lambda.tf).
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * USD per 1M tokens, matched by substring so regional/inference-profile prefixes still hit.
 * Haiku: AWS price list, global profile (2026-09-25). Luna isn't in the price list yet; this is
 * the post-July-2026 price quoted by third parties. Check the Bedrock pricing page when switching.
 */
const PRICES: { match: string; input: number; output: number }[] = [
  { match: "gpt-5.6-luna", input: 0.22, output: 1.32 },
  { match: "claude-haiku-4-5", input: 1.0, output: 5.0 },
];

/**
 * OpenAI's reasoning models on Bedrock reject a temperature other than the default, so it's
 * sent only to the others (Claude), where 0 keeps edits close to the request.
 */
export function acceptsTemperature(modelId: string): boolean {
  return !modelId.includes("openai.");
}

const BUSY = "The AI service is busy or unavailable right now";
const TOO_SLOW = "The model took too long to finish this edit";
/**
 * Timeouts aren't retried: the model may have produced (and billed) most of a reply, and the
 * same page would most likely time out again.
 */
const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError", "ModelTimeoutException"]);
const UNAVAILABLE = "The AI model isn't available for this account";

const RETRYABLE_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ServiceQuotaExceededException",
]);
const UNAVAILABLE_NAMES = new Set(["AccessDeniedException", "ValidationException", "ResourceNotFoundException"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

export function estimateCostUsd(modelId: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const price = PRICES.find((p) => modelId.includes(p.match));
  if (!price || inputTokens === null || outputTokens === null) return null;
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * The reply budget for one edit: the page back (HTML runs ≈3–4 bytes a token; 3 leaves room)
 * plus a quarter more and some headroom for new content, within [8k, max]. So a small page
 * asked to become "the longest page in the world" stops at a small, cheap reply.
 */
export function outputTokenBudget(pageBytes: number, max = DEFAULT_MAX_OUTPUT_TOKENS): number {
  const pageTokens = Math.ceil(pageBytes / 3);
  return Math.min(max, Math.max(MIN_OUTPUT_TOKENS, Math.ceil(pageTokens * 1.25) + 4000));
}

/** Maps SDK/network failures to user-safe errors; the original error (and its request id) is dropped. */
function toAiEditError(error: unknown): AiEditError {
  if (error instanceof AiEditError) return error;
  const e = (error ?? {}) as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name && TIMEOUT_NAMES.has(e.name)) return new AiEditError(TOO_SLOW, false);
  if (e.name && RETRYABLE_NAMES.has(e.name)) return new AiEditError(BUSY, true);
  if (e.code && NETWORK_CODES.has(e.code)) return new AiEditError(BUSY, true);
  if (e.name && UNAVAILABLE_NAMES.has(e.name)) return new AiEditError(UNAVAILABLE, false);
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined && status >= 500) return new AiEditError(BUSY, true);
  return new AiEditError("The AI edit failed unexpectedly", false);
}

function replyText(response: ConverseResponse): string {
  const blocks = response.output?.message?.content ?? [];
  return blocks.map((block) => block.text ?? "").join("");
}

function checkStopReason(stopReason: string | undefined): void {
  switch (stopReason) {
    case "max_tokens":
      throw new AiEditError("The edit was too long for the model to finish", false);
    case "model_context_window_exceeded":
      throw new AiEditError("This page is too large for an AI edit", false);
    case "content_filtered":
    case "guardrail_intervened":
      throw new AiEditError("The model declined this request", false);
  }
}

/** Edits pages through the Bedrock Converse API, so switching models is only a model id change. */
export class BedrockHtmlEditor implements HtmlEditorModel {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;

  constructor(options: {
    region: string;
    modelId: string;
    client?: BedrockRuntimeClient;
    maxOutputTokens?: number;
    timeoutMs?: number;
  }) {
    // maxAttempts 1: the SDK must not quietly retry a (possibly billed) call. Retries go
    // through the job queue, where the monthly AI budget counts each attempt.
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region, maxAttempts: 1 });
    this.modelId = options.modelId;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async edit(input: HtmlEditInput): Promise<HtmlEditResult> {
    assertInputSize(input.html);
    const { system, user } = buildEditPrompt(input);
    assertPromptSize({ system, user });
    const started = performance.now();

    let response: ConverseResponse;
    try {
      response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user }] }],
          inferenceConfig: {
            maxTokens: outputTokenBudget(byteLength(input.html), this.maxOutputTokens),
            ...(acceptsTemperature(this.modelId) ? { temperature: 0 } : {}),
          },
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      throw toAiEditError(error);
    }
    const latencyMs = Math.round(performance.now() - started);

    checkStopReason(response.stopReason);
    const reply = parseEditReply(replyText(response));
    const html = validateEditedHtml(input.html, reply.html);
    const inputTokens = response.usage?.inputTokens ?? null;
    const outputTokens = response.usage?.outputTokens ?? null;
    return {
      html,
      summary: reply.summary,
      provider: "bedrock",
      model: this.modelId,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCostUsd(this.modelId, inputTokens, outputTokens),
      latencyMs,
    };
  }
}
