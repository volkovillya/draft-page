import { describe, expect, it } from "vitest";
import { MAX_INSTRUCTION_LENGTH, parseClaudeRequest } from "@/server/core/claude-trigger";

describe("parseClaudeRequest", () => {
  it("accepts a leading mention and returns the instruction", () => {
    expect(parseClaudeRequest("@Claude make it blue")).toEqual({ requested: true, instruction: "make it blue" });
  });

  it("is case-insensitive", () => {
    expect(parseClaudeRequest("@claude a").requested).toBe(true);
    expect(parseClaudeRequest("@CLAUDE a").requested).toBe(true);
    expect(parseClaudeRequest("@cLaUdE a").requested).toBe(true);
  });

  it("trims surrounding whitespace and separator punctuation", () => {
    expect(parseClaudeRequest("  \n@Claude,  fix the typo  \n")).toEqual({ requested: true, instruction: "fix the typo" });
    expect(parseClaudeRequest("@Claude: fix").instruction).toBe("fix");
    expect(parseClaudeRequest("@Claude - fix").instruction).toBe("fix");
  });

  it("keeps multi-line instructions intact", () => {
    expect(parseClaudeRequest("@Claude line one\nline two").instruction).toBe("line one\nline two");
  });

  it("requires a word boundary after the mention", () => {
    expect(parseClaudeRequest("@Claudette fix")).toEqual({ requested: false, instruction: "" });
    expect(parseClaudeRequest("@Claude_bot fix").requested).toBe(false);
  });

  it("only counts a leading mention", () => {
    expect(parseClaudeRequest("hey @Claude fix").requested).toBe(false);
    expect(parseClaudeRequest("Claude fix").requested).toBe(false);
    expect(parseClaudeRequest("email@claude.ai fix").requested).toBe(false);
  });

  it("needs a 1-4000 character instruction", () => {
    expect(parseClaudeRequest("@Claude")).toEqual({ requested: false, instruction: "" });
    expect(parseClaudeRequest("@Claude   :  ")).toEqual({ requested: false, instruction: "" });
    expect(parseClaudeRequest("@Claude x")).toEqual({ requested: true, instruction: "x" });
    const max = "y".repeat(MAX_INSTRUCTION_LENGTH);
    expect(parseClaudeRequest(`@Claude ${max}`)).toEqual({ requested: true, instruction: max });
    expect(parseClaudeRequest(`@Claude ${max}y`)).toEqual({ requested: false, instruction: "" });
    expect(MAX_INSTRUCTION_LENGTH).toBe(4000);
  });

  it("handles empty input", () => {
    expect(parseClaudeRequest("")).toEqual({ requested: false, instruction: "" });
    expect(parseClaudeRequest("   ")).toEqual({ requested: false, instruction: "" });
  });
});
