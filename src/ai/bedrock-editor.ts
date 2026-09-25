import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseResponse } from "@aws-sdk/client-bedrock-runtime";
import { AiEditError } from "./html-editor";
import type { HtmlEditInput, HtmlEditorModel, HtmlEditResult } from "./html-editor";
import { assertInputSize, buildEditPrompt, parseEditReply, validateEditedHtml } from "./prompt";

const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** USD per 1M tokens, matched by substring so regional/inference-profile prefixes still hit. */
const PRICES: { match: string; input: number; output: number }[] = [
  { match: "gpt-5.6-luna", input: 0.2, output: 1.2 },
  { match: "claude-haiku-4-5", input: 1.0, output: 5.0 },
];

const BUSY = "The AI service is busy or unavailable right now";
const UNAVAILABLE = "The AI model isn't available for this account";

const RETRYABLE_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelTimeoutException",
  "ServiceQuotaExceededException",
  "TimeoutError",
  "AbortError",
]);
const UNAVAILABLE_NAMES = new Set(["AccessDeniedException", "ValidationException", "ResourceNotFoundException"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

export function estimateCostUsd(modelId: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const price = PRICES.find((p) => modelId.includes(p.match));
  if (!price || inputTokens === null || outputTokens === null) return null;
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Maps SDK/network failures to user-safe errors; the original error (and its request id) is dropped. */
function toAiEditError(error: unknown): AiEditError {
  if (error instanceof AiEditError) return error;
  const e = (error ?? {}) as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
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
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
    this.modelId = options.modelId;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async edit(input: HtmlEditInput): Promise<HtmlEditResult> {
    assertInputSize(input.html);
    const { system, user } = buildEditPrompt(input);
    const started = performance.now();

    let response: ConverseResponse;
    try {
      response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user }] }],
          inferenceConfig: { maxTokens: this.maxOutputTokens, temperature: 0 },
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
