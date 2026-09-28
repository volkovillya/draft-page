// One Bedrock Converse call for the review. The answer is requested as a forced tool call; if
// the model rejects that request shape, the same prompt is sent once more asking for plain
// JSON. A rejected request isn't billed, so this never pays twice.
import { type BedrockRuntimeClient, ConverseCommand, type ConverseResponse } from "@aws-sdk/client-bedrock-runtime";
import { acceptsTemperature } from "../../src/ai/bedrock-editor.ts";
import { ANSWER_SCHEMA, TOOL_NAME } from "./review.ts";

export const MAX_OUTPUT_TOKENS = 8000;
const TIMEOUT_MS = 180_000;

export type ModelReply = { raw: unknown; inputTokens: number; outputTokens: number; stopReason?: string };

export class ModelUnavailable extends Error {
  readonly inputTokens: number;
  readonly outputTokens: number;
  constructor(message: string, usage = { inputTokens: 0, outputTokens: 0 }) {
    super(message);
    this.inputTokens = usage.inputTokens;
    this.outputTokens = usage.outputTokens;
  }
}

const reasons: Record<string, string> = {
  AccessDeniedException: "Bedrock access denied (role, model access, or the spending kill switch)",
  ThrottlingException: "Bedrock is throttling requests",
  ServiceQuotaExceededException: "the Bedrock quota is used up",
  ModelNotReadyException: "the model isn't ready",
  ResourceNotFoundException: "the model isn't available in this region",
  TimeoutError: "the model took too long",
  AbortError: "the model took too long",
};

function explain(error: unknown): string {
  const name = (error as { name?: string })?.name ?? "";
  return reasons[name] ?? `the Bedrock call failed (${name || "unknown error"})`;
}

type Mode = "tool" | "json";

function command(modelId: string, prompt: { system: string; user: string }, mode: Mode) {
  const user = mode === "json" ? `${prompt.user}\nReply with only the JSON object, no other text.` : prompt.user;
  return new ConverseCommand({
    modelId,
    system: [{ text: prompt.system }],
    messages: [{ role: "user", content: [{ text: user }] }],
    inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, ...(acceptsTemperature(modelId) ? { temperature: 0 } : {}) },
    ...(mode === "tool"
      ? {
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: TOOL_NAME,
                  description: "Report the review result.",
                  inputSchema: { json: ANSWER_SCHEMA as unknown as Record<string, never> },
                },
              },
            ],
            toolChoice: { tool: { name: TOOL_NAME } },
          },
        }
      : {}),
  });
}

function extract(response: ConverseResponse): unknown {
  const blocks = response.output?.message?.content ?? [];
  const tool = blocks.find((b) => b.toolUse?.name === TOOL_NAME)?.toolUse;
  if (tool) return tool.input;
  return blocks.map((b) => b.text ?? "").join("");
}

export async function callReviewModel(
  client: Pick<BedrockRuntimeClient, "send">,
  modelId: string,
  prompt: { system: string; user: string },
): Promise<ModelReply> {
  for (const mode of ["tool", "json"] as const) {
    let response: ConverseResponse;
    try {
      response = await client.send(command(modelId, prompt, mode), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      // The model doesn't take a forced tool call: ask for plain JSON instead.
      if (mode === "tool" && (error as { name?: string })?.name === "ValidationException") continue;
      throw new ModelUnavailable(explain(error));
    }
    const usage = { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0 };
    if (response.stopReason === "max_tokens") throw new ModelUnavailable("the answer hit the output limit", usage);
    if (response.stopReason === "content_filtered" || response.stopReason === "guardrail_intervened") {
      throw new ModelUnavailable("the model declined to answer", usage);
    }
    return { raw: extract(response), ...usage, stopReason: response.stopReason };
  }
  throw new ModelUnavailable("the model rejected both request formats");
}
