import { describe, expect, it } from "vitest";
import { FakeHtmlEditor } from "@/ai/fake-editor";
import { AiEditError } from "@/ai/html-editor";

const input = (html: string, instruction = "make it blue") => ({ html, instruction, excerpt: null, targetPath: null });

describe("FakeHtmlEditor", () => {
  it("adds only an invisible HTML comment, as the last thing in the body", async () => {
    const result = await new FakeHtmlEditor().edit(input('<html><body class="x"><p>Hi</p></body></html>', "make it blue"));
    expect(result.html).toBe(
      '<html><body class="x"><p>Hi</p><!-- Pretend AI edit (no model was called): make it blue --></body></html>',
    );
    expect(result).toMatchObject({
      summary: "Pretend AI edit: no real model is connected yet, so the page itself is unchanged.",
      provider: "fake",
      model: "fake-editor",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: 0,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("can't be broken out of the comment by the instruction", async () => {
    const result = await new FakeHtmlEditor().edit(input("<body></body>", "x --> <script>alert(1)</script> <!--"));
    expect(result.html).not.toContain("<script");
    expect(result.html.match(/-->/g)).toHaveLength(1); // only the comment's own end
  });

  it("appends the comment when there's no body tag", async () => {
    const result = await new FakeHtmlEditor().edit(input("<p>Hi</p>"));
    expect(result.html).toBe("<p>Hi</p><!-- Pretend AI edit (no model was called): make it blue -->");
  });

  it("can pretend to think for a while", async () => {
    const started = Date.now();
    await new FakeHtmlEditor({ delayMs: 120 }).edit(input("<body>x</body>"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it("is deterministic", async () => {
    const editor = new FakeHtmlEditor();
    expect((await editor.edit(input("<body>x</body>"))).html).toBe((await editor.edit(input("<body>x</body>"))).html);
  });

  it("can fail with a retryable or permanent error", async () => {
    await expect(new FakeHtmlEditor({ fail: "retryable" }).edit(input("<p/>"))).rejects.toMatchObject({ retryable: true });
    await expect(new FakeHtmlEditor({ fail: "permanent" }).edit(input("<p/>"))).rejects.toMatchObject({ retryable: false });
    await expect(new FakeHtmlEditor({ fail: "permanent" }).edit(input("<p/>"))).rejects.toBeInstanceOf(AiEditError);
  });
});
