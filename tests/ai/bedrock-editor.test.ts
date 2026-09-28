import { describe, expect, it, vi } from "vitest";
import type { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { acceptsTemperature, BedrockHtmlEditor, estimateCostUsd, outputTokenBudget } from "@/ai/bedrock-editor";
import { AiEditError } from "@/ai/html-editor";
import { MAX_AI_INPUT_BYTES } from "@/ai/prompt";

const PAGE = "<html><body><h1>Hello</h1></body></html>";
const EDITED = "<html><body><h1>Hi</h1></body></html>";
const LUNA = "us.openai.gpt-5.6-luna-v1:0";

const input = (html = PAGE) => ({ html, instruction: "say hi", excerpt: "Hello", targetPath: "body > h1" });

function converse(text: string, extra: Record<string, unknown> = {}) {
  return {
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    metrics: { latencyMs: 10 },
    ...extra,
  };
}

function editorWith(send: ReturnType<typeof vi.fn>, modelId = LUNA) {
  return new BedrockHtmlEditor({ region: "us-east-1", modelId, client: { send } as unknown as BedrockRuntimeClient });
}

function awsError(name: string, status = 400) {
  return Object.assign(new Error(`${name}: raw detail req-1234`), { name, $metadata: { httpStatusCode: status, requestId: "req-1234" } });
}

async function caught(promise: Promise<unknown>): Promise<AiEditError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AiEditError);
    return error as AiEditError;
  }
  throw new Error("expected an AiEditError");
}

describe("BedrockHtmlEditor", () => {
  it("sends one Converse request and returns the validated edit with cost", async () => {
    const send = vi.fn().mockResolvedValue(converse(`<summary>Changed the heading.</summary><edited_html>${EDITED}</edited_html>`));
    const result = await editorWith(send).edit(input());

    expect(result).toMatchObject({
      html: EDITED,
      summary: "Changed the heading.",
      provider: "bedrock",
      model: LUNA,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.00088, // 1000 × $0.22 + 500 × $1.32 per 1M
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [command, options] = send.mock.calls[0] as [ConverseCommand, { abortSignal: AbortSignal }];
    expect(command.input.modelId).toBe(LUNA);
    expect(command.input.inferenceConfig).toEqual({ maxTokens: 8000 }); // small page: the floor; no temperature for OpenAI
    expect(command.input.system?.[0]?.text).toContain("UNTRUSTED DATA");
    expect(command.input.messages?.[0]?.content?.[0]?.text).toContain(`<page_html>\n${PAGE}\n</page_html>`);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails permanently when the model hit max_tokens", async () => {
    const send = vi.fn().mockResolvedValue(converse("<summary>x</summary><edited_html><html>", { stopReason: "max_tokens" }));
    const error = await caught(editorWith(send).edit(input()));
    expect(error).toMatchObject({ retryable: false, message: "The edit was too long for the model to finish" });
  });

  it("fails permanently when a content filter stopped the model", async () => {
    const send = vi.fn().mockResolvedValue(converse("", { stopReason: "guardrail_intervened" }));
    expect(await caught(editorWith(send).edit(input()))).toMatchObject({ retryable: false, message: "The model declined this request" });
  });

  it("doesn't retry a timeout, which may already have been billed", async () => {
    for (const name of ["TimeoutError", "AbortError", "ModelTimeoutException"]) {
      const result = await caught(editorWith(vi.fn().mockRejectedValue(awsError(name))).edit(input()));
      expect(result).toMatchObject({ retryable: false, message: "The model took too long to finish this edit" });
    }
  });

  it("refuses a prompt over the cap before calling the model", async () => {
    const send = vi.fn();
    // The page itself is within its limit; the whole prompt isn't.
    const html = `<p>${"a".repeat(MAX_AI_INPUT_BYTES - 10)}</p>`;
    const error = await caught(editorWith(send).edit({ ...input(html), instruction: "b".repeat(70_000) }));
    expect(error).toMatchObject({ retryable: false, message: "This page is too large for an AI edit" });
    expect(send).not.toHaveBeenCalled();
  });

  it("retries throttling and 5xx", async () => {
    for (const error of [awsError("ThrottlingException", 429), awsError("InternalServerException", 500)]) {
      const result = await caught(editorWith(vi.fn().mockRejectedValue(error)).edit(input()));
      expect(result).toMatchObject({ retryable: true, message: "The AI service is busy or unavailable right now" });
    }
    const network = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(await caught(editorWith(vi.fn().mockRejectedValue(network)).edit(input()))).toMatchObject({ retryable: true });
  });

  it("fails permanently on access denied without leaking details", async () => {
    const error = await caught(editorWith(vi.fn().mockRejectedValue(awsError("AccessDeniedException", 403))).edit(input()));
    expect(error).toMatchObject({ retryable: false, message: "The AI model isn't available for this account" });
    expect(error.message).not.toContain("req-1234");
  });

  it("fails permanently when the reply adds a script", async () => {
    const send = vi.fn().mockResolvedValue(converse(`<edited_html>${EDITED.replace("</body>", "<script>x()</script></body>")}</edited_html>`));
    expect(await caught(editorWith(send).edit(input()))).toMatchObject({ retryable: false });
  });

  it("refuses a too-large page without calling the model", async () => {
    const send = vi.fn();
    const error = await caught(editorWith(send).edit(input(`<p>${"a".repeat(MAX_AI_INPUT_BYTES)}</p>`)));
    expect(error).toMatchObject({ retryable: false, message: "This page is too large for an AI edit" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("outputTokenBudget", () => {
  it("gives a small page the 8k floor, so it can't grow into a huge reply", () => {
    expect(outputTokenBudget(0)).toBe(8000);
    expect(outputTokenBudget(5 * 1024)).toBe(8000);
  });

  it("grows with the page: its size back plus a quarter and some headroom", () => {
    expect(outputTokenBudget(30_000)).toBe(16_500); // 10k page tokens × 1.25 + 4k
  });

  it("never passes the maximum, even for the largest allowed page", () => {
    expect(outputTokenBudget(MAX_AI_INPUT_BYTES)).toBe(32_000);
    expect(outputTokenBudget(30_000, 12_000)).toBe(12_000);
  });

  it("is what the editor sends for a mid-size page", async () => {
    const send = vi.fn().mockResolvedValue(converse(`<summary>x</summary><edited_html>${EDITED}</edited_html>`));
    await editorWith(send).edit({ ...input(), html: `<html><body>${"a".repeat(30_000 - 26)}</body></html>` });
    const [command] = send.mock.calls[0] as [ConverseCommand];
    expect(command.input.inferenceConfig?.maxTokens).toBe(16_500);
  });
});

describe("acceptsTemperature", () => {
  it("leaves it out for OpenAI models and sends it to Claude", () => {
    expect(acceptsTemperature("us.openai.gpt-5.6-luna")).toBe(false);
    expect(acceptsTemperature("openai.gpt-oss-120b-1:0")).toBe(false);
    expect(acceptsTemperature("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
  });
});

describe("estimateCostUsd", () => {
  it("prices known models and rounds to 6 decimals", () => {
    expect(estimateCostUsd("us.anthropic.claude-haiku-4-5-20251001-v1:0", 1234, 567)).toBe(0.004069);
    expect(estimateCostUsd(LUNA, 1, 1)).toBe(0.000002); // $0.00000154, rounded to 6 places
  });

  it("returns null for unknown models or missing usage", () => {
    expect(estimateCostUsd("some-other-model", 100, 100)).toBeNull();
    expect(estimateCostUsd(LUNA, null, 100)).toBeNull();
  });
});
