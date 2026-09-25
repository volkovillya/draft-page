import { describe, expect, it } from "vitest";
import { crossSiteWrite } from "@/server/http";

const APP = "https://app.example.com";

function req(method: string, origin: string | null, url = `${APP}/api/pages`) {
  return new Request(url, { method, headers: origin === null ? {} : { origin } });
}

describe("crossSiteWrite (CSRF guard)", () => {
  it("allows writes from the app itself, by its own URL or APP_BASE_URL", () => {
    expect(crossSiteWrite(req("POST", APP), APP)).toBe(false);
    // Behind API Gateway the app sees an internal URL; APP_BASE_URL is the public one.
    expect(crossSiteWrite(req("POST", APP, "http://10.0.0.5:3000/api/pages"), APP)).toBe(false);
  });

  it("refuses writes from any other origin, including sandboxed frames (null)", () => {
    for (const origin of ["https://evil.example", "null", "http://app.example.com", "https://app.example.com:8443"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(crossSiteWrite(req(method, origin), APP)).toBe(true);
    }
  });

  it("leaves reads alone, and requests that didn't come from a web page", () => {
    expect(crossSiteWrite(req("GET", "https://evil.example"), APP)).toBe(false);
    expect(crossSiteWrite(req("POST", null), APP)).toBe(false);
  });
});
