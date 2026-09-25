// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { bridgeScript, frameBridge, injectBridge } from "@/frame-bridge/bridge";

describe("injectBridge", () => {
  const script = bridgeScript();

  it("inserts the script right before the last </body>", () => {
    const html = "<html><body><p>a</p><!-- </body> in a comment --></body></html>";
    // The literal "</body>" inside the comment comes first; the real closing tag is last.
    const out = injectBridge(html);
    const at = out.lastIndexOf("</body>");
    expect(out.slice(at - script.length, at)).toBe(script);
    expect(out.replace(script, "")).toBe(html);
  });

  it("matches the closing tag case-insensitively and with whitespace", () => {
    const html = "<HTML><BODY>x</BODY >\n</HTML>";
    const out = injectBridge(html);
    expect(out).toBe(`<HTML><BODY>x${script}</BODY >\n</HTML>`);
  });

  it("appends the script when there is no </body>", () => {
    const html = "<h1>fragment</h1>";
    expect(injectBridge(html)).toBe(html + script);
  });

  it("leaves the original HTML otherwise unchanged", () => {
    const html = "<!doctype html>\n<html><head><title>t</title></head><body>\n  <main>ü ✓</main>\n</body>\n</html>\n";
    const out = injectBridge(html);
    expect(out.length).toBe(html.length + script.length);
    expect(out.replace(script, "")).toBe(html);
  });
});

describe("frameBridge source", () => {
  const source = frameBridge.toString();

  it("is self-contained (no imports, requires or closing script tags)", () => {
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source.toLowerCase()).not.toContain("</script");
    expect(bridgeScript().startsWith("<script>(function")).toBe(true);
  });

  it("runs from its serialized form in a fresh window and announces itself, tagged", () => {
    const dom = new JSDOM("<!doctype html><body><p>hi</p></body>", {
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const win = dom.window;
    const sent: unknown[] = [];
    const fakeParent = { postMessage: (data: unknown) => sent.push(data) };
    Object.defineProperty(win, "parent", { configurable: true, get: () => fakeParent });

    win.eval(`(${source})()`);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ dp: 1, type: "ready" });
    const ready = sent[0] as { docW: unknown; docH: unknown };
    expect(typeof ready.docW).toBe("number");
    expect(typeof ready.docH).toBe("number");
    dom.window.close();
  });
});
