import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = (name: string) => readFileSync(`.github/workflows/${name}`, "utf8");

describe("ai-review.yml", () => {
  const yml = workflow("ai-review.yml");

  it("sets concurrency on the job, so a skipped run can't cancel a running review", () => {
    expect(yml).not.toMatch(/^concurrency:/m);
    expect(yml).toMatch(/^ {4}concurrency:\n {6}group: ai-review-\$\{\{ github\.event\.pull_request\.number \}\}\n {6}cancel-in-progress: true$/m);
  });

  it("only runs the job for the ai-review label among label events", () => {
    expect(yml).toContain("github.event.action != 'labeled' || github.event.label.name == 'ai-review'");
  });
});
