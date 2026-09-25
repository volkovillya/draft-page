import { describe, expect, it } from "vitest";
import { BedrockHtmlEditor } from "@/ai/bedrock-editor";
import { FakeHtmlEditor } from "@/ai/fake-editor";
import { createHtmlEditor } from "@/ai";

describe("createHtmlEditor", () => {
  it("defaults to the fake editor", () => {
    expect(createHtmlEditor({})).toBeInstanceOf(FakeHtmlEditor);
    expect(createHtmlEditor({ DRAFTPAGE_AI_EDITOR: "fake" })).toBeInstanceOf(FakeHtmlEditor);
  });

  it("builds a Bedrock editor from the model id and region", () => {
    const env = { DRAFTPAGE_AI_EDITOR: "bedrock", DRAFTPAGE_AI_MODEL_ID: "m", DRAFTPAGE_AI_REGION: "us-east-1" };
    expect(createHtmlEditor(env)).toBeInstanceOf(BedrockHtmlEditor);
    expect(createHtmlEditor({ DRAFTPAGE_AI_EDITOR: "bedrock", DRAFTPAGE_AI_MODEL_ID: "m", AWS_REGION: "eu-west-1" })).toBeInstanceOf(
      BedrockHtmlEditor,
    );
  });

  it("explains missing Bedrock settings", () => {
    expect(() => createHtmlEditor({ DRAFTPAGE_AI_EDITOR: "bedrock", AWS_REGION: "us-east-1" })).toThrow(/DRAFTPAGE_AI_MODEL_ID/);
    expect(() => createHtmlEditor({ DRAFTPAGE_AI_EDITOR: "bedrock", DRAFTPAGE_AI_MODEL_ID: "m" })).toThrow(/AWS_REGION/);
  });

  it("rejects unknown editors", () => {
    expect(() => createHtmlEditor({ DRAFTPAGE_AI_EDITOR: "openai" })).toThrow(/Unknown DRAFTPAGE_AI_EDITOR/);
  });
});
