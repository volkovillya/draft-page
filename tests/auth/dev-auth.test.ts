import { describe, expect, it } from "vitest";
import { hasAccess } from "@/server/auth/access";
import { DEV_USER, devAuthEnabled, safeReturnTo } from "@/server/auth/dev-auth";

describe("devAuthEnabled", () => {
  it("is on only for the dev server with the explicit flag", () => {
    expect(devAuthEnabled({ NODE_ENV: "development", DRAFTPAGE_DEV_AUTH: "on" })).toBe(true);
  });

  it("can never be on in a production build or in tests", () => {
    expect(devAuthEnabled({ NODE_ENV: "production", DRAFTPAGE_DEV_AUTH: "on" })).toBe(false);
    expect(devAuthEnabled({ NODE_ENV: "test", DRAFTPAGE_DEV_AUTH: "on" })).toBe(false);
    expect(devAuthEnabled({ DRAFTPAGE_DEV_AUTH: "on" })).toBe(false);
  });

  it("is off without the flag or with any other value", () => {
    expect(devAuthEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devAuthEnabled({ NODE_ENV: "development", DRAFTPAGE_DEV_AUTH: "true" })).toBe(false);
  });

  it("is off in this test run", () => {
    expect(devAuthEnabled()).toBe(false);
  });
});

describe("dev user and returnTo", () => {
  it("the dev user passes the same access check as a real one", () => {
    expect(hasAccess(DEV_USER)).toBe(true);
  });

  it("only allows same-site relative return paths", () => {
    expect(safeReturnTo("/pages/abc")).toBe("/pages/abc");
    expect(safeReturnTo("//evil.example")).toBe("/pages");
    expect(safeReturnTo("https://evil.example")).toBe("/pages");
    expect(safeReturnTo(null)).toBe("/pages");
  });
});
